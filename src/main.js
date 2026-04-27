const { GoldenLayout, Stack, LayoutConfig } = require('golden-layout');
const ace = require('ace-builds/src-min-noconflict/ace');
const handlerRegistry = require('./handlers');
const { getPlugins } = require('./plugins');
const { renderTree } = require('./tree-renderer');
const { isMobile, MobileLayout, createContainerAdapter } = require('./mobile-layout');
const { createClientApi } = require('./client-api');
const { installClientRpc } = require('./client-rpc');
const debug = require('./debug');
const log = debug.createLogger('App');

// Load plugins (side-effect: they register themselves)
require('./terminal');
require('./typst-plugin');
require('./pandoc-plugin');
require('./hex-editor-plugin');
require('./thumbnails-plugin');
require('./vsdx-plugin');
require('./ruffle-plugin');
require('./epub-plugin');
require('./psd-plugin');
require('./xlsx-plugin');
require('./sqlite-plugin');
require('./model3d-plugin');
require('./wasm-plugin');
require('./converters-plugin');
require('./media-metadata-plugin');

require('ace-builds/src-min-noconflict/mode-html');
require('ace-builds/src-min-noconflict/theme-github');
require('ace-builds/src-min-noconflict/ext-language_tools');
require('ace-builds/src-min-noconflict/ext-searchbox');
require('ace-builds/src-min-noconflict/mode-css');
require('ace-builds/src-min-noconflict/mode-javascript');


// Preview handlers for different file types - now using handler registry
function generatePreviewContent(fileName, fileContent, fileType) {
    return handlerRegistry.generatePreviewContent(fileName, fileContent, fileType);
}

// Helper to generate unique IDs for files/dirs
function generateUniqueId() {
    return 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// --- Central Application State ---
let projectStructure = {
    id: generateUniqueId(),
    name: "root",
    type: "directory",
    children: [
        {
            id: "htmlFile",
            name: "index.html",
            type: "file",
            content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>My Page</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <h1>Hello, World!</h1>
    <p>Edit this HTML content, and see style.css and script.js in action.</p>
    <script src="script.js" defer></script>
</body>
</html>`,
            cursor: { row: 0, column: 0 },
            selection: null
        },
        {
            id: "cssFile",
            name: "style.css",
            type: "file",
            content: `body {
    font-family: sans-serif;
    background-color: #f0f0f0;
    padding: 20px;
    margin: 0;
}
h1 {
    color: navy;
    text-align: center;
}`,
            cursor: { row: 0, column: 0 },
            selection: null
        },
        {
            id: "jsFile",
            name: "script.js",
            type: "file",
            content: `console.log('Script loaded successfully!');
document.addEventListener('DOMContentLoaded', () => {
    const h1 = document.querySelector('h1');
    if (h1) {
        h1.addEventListener('click', () => {
            alert('H1 clicked! Event from script.js');
        });
    }
});`,
            cursor: { row: 0, column: 0 },
            selection: null
        },
    ]
};

// Add default files from plugins
for (const plugin of getPlugins()) {
    if (plugin.defaultFiles) {
        projectStructure.children.push(...plugin.defaultFiles);
    }
}

// Helper to find files in the project structure
function findFileById(id, node = projectStructure) {
    if (node.id === id && node.type === 'file') {
        return node;
    }
    if (node.children) {
        for (let child of node.children) {
            const found = findFileById(id, child);
            if (found) return found;
        }
    }
    return null;
}

// Helper to get all files from the project structure
function getAllFiles(node = projectStructure, files = []) {
    if (node.type === 'file') {
        files.push(node);
    }
    if (node.children) {
        for (let child of node.children) {
            getAllFiles(child, files);
        }
    }
    return files;
}

// Legacy compatibility - expose files as flat object
let projectFiles = {};
function updateProjectFilesCache() {
    projectFiles = {};
    const allFiles = getAllFiles();
    allFiles.forEach(file => {
        projectFiles[file.id] = file;
    });
}
updateProjectFilesCache();

let previewFrame;
let goldenLayoutInstance;
let projectFilesComponentInstance; // To access its methods
let _pendingExplorerState = null; // Saved explorer state to apply on next construction
let previewComponentInstance; // To access preview methods
let activeEditorFileId = null; // To track the currently active file in the editor
let activePreviewFileId = 'htmlFile'; // To track which file is being previewed
let _editorInstances = new Map(); // fileId -> EditorComponent instance

// Helper to generate unique IDs for files and directories
function generateUniqueId(prefix = 'item') {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// Helper to determine file type for Ace mode - now uses dynamic handler registry
function getFileTypeFromExtension(fileName) {
    return handlerRegistry.getFileType(fileName);
}

// --- Service Worker Setup ---
let serviceWorkerRegistration = null;
// Resolves when we know whether the SW is usable; value is the registration or null
const serviceWorkerReady = new Promise((resolve) => {
    if ('serviceWorker' in navigator) {
        const currentPath = window.location.pathname;
        const basePath = currentPath.endsWith('/') ? currentPath : currentPath + '/';
        const workerPath = basePath + 'worker.js';

        navigator.serviceWorker.register(workerPath)
            .then(registration => {
                log.log('ServiceWorker registered successfully');
                serviceWorkerRegistration = registration;
                if (registration.active) {
                    resolve(registration);
                } else {
                    const sw = registration.installing || registration.waiting;
                    sw.addEventListener('statechange', () => {
                        if (sw.state === 'activated') resolve(registration);
                    });
                }
            })
            .catch(error => {
                log.error('ServiceWorker registration failed:', error);
                resolve(null);
            });
    } else {
        resolve(null);
    }
});

// --- WebSocket Client (optional, for server-enhanced mode) ---
const wsClient = require('./ws-client');

// Current workspace path (null = in-memory only)
let currentWorkspacePath = null;

// --- Persistence Mode ---
let persistenceMode = (typeof localStorage !== 'undefined' && localStorage.getItem('gl-persistence-mode')) || 'draft';
const dirtyFiles = new Set();
const _autoPersistTimers = {};
// Track files we recently saved so the fs watcher ignores our own writes
const _recentlySavedFiles = new Map(); // relativePath -> timestamp

async function saveFileToDisk(fileId) {
    if (!currentWorkspacePath || !wsClient || !wsClient.isConnected()) return false;
    const file = projectFiles[fileId];
    if (!file) return false;
    const relativePath = getRelativePath(fileId);
    if (!relativePath) return false;
    try {
        const result = await wsClient.wsRequest({
            type: 'saveFile',
            workspacePath: currentWorkspacePath,
            relativePath,
            content: file.content || '',
        });
        if (result.success) {
            dirtyFiles.delete(fileId);
            updateDirtyIndicator(fileId);
            // Mark as recently saved so fs watcher ignores our own write
            _recentlySavedFiles.set(relativePath, Date.now());
            setTimeout(() => _recentlySavedFiles.delete(relativePath), 2000);
            return true;
        }
        log.error('Save failed:', result.error);
        return false;
    } catch (err) {
        log.error('Save failed:', err);
        return false;
    }
}

async function syncAllDirtyFiles() {
    const ids = [...dirtyFiles];
    if (ids.length === 0) return;
    log.log(`Syncing ${ids.length} dirty file(s) to disk...`);
    const results = await Promise.allSettled(ids.map(id => saveFileToDisk(id)));
    const failed = results.filter(r => r.status === 'rejected' || r.value === false).length;
    if (failed > 0) {
        log.warn(`${failed} file(s) failed to sync`);
    }
    updateSyncButton();
}

function markDirty(fileId) {
    if (!currentWorkspacePath) return;
    const wasClean = !dirtyFiles.has(fileId);
    dirtyFiles.add(fileId);
    if (wasClean) {
        updateDirtyIndicator(fileId);
        updateSyncButton();
    }

    if (persistenceMode === 'auto') {
        clearTimeout(_autoPersistTimers[fileId]);
        _autoPersistTimers[fileId] = setTimeout(() => {
            saveFileToDisk(fileId).then(() => updateSyncButton());
        }, 1000);
    }
}

// Stub — replaced once ProjectFilesComponent is constructed
let updateSyncButton = () => {};

function updateDirtyIndicator(fileId) {
    // Update file tree dot
    const treeItem = document.querySelector(`[data-tree-file-id="${fileId}"]`);
    if (treeItem) {
        let dot = treeItem.querySelector('.dirty-indicator');
        if (dirtyFiles.has(fileId)) {
            if (!dot) {
                dot = document.createElement('span');
                dot.className = 'dirty-indicator';
                dot.textContent = ' \u25CF';
                dot.style.cssText = 'color:#e8a317;font-size:10px;margin-left:2px;flex-shrink:0;';
                // Insert before hover actions (last child)
                const hoverActions = treeItem.lastElementChild;
                treeItem.insertBefore(dot, hoverActions);
            }
        } else if (dot) {
            dot.remove();
        }
    }
    // Update editor tab title
    if (goldenLayoutInstance) {
        const file = projectFiles[fileId];
        if (file) {
            const title = file.name + (dirtyFiles.has(fileId) ? ' \u25CF' : '');
            const editorStack = goldenLayoutInstance.getAllStacks().find(s => s.id === 'editorStack');
            if (editorStack) {
                const tab = editorStack.contentItems.find(item => {
                    const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                    return state && state.fileId === fileId;
                });
                if (tab) tab.setTitle(title);
            }
        }
    }
}

// --- Session State Persistence ---
const SESSION_KEY = 'gl-editor-session';

function getRelativePath(fileId, node = projectStructure, prefix = '') {
    if (node.children) {
        for (const child of node.children) {
            if (child.id === fileId) return prefix + child.name;
            if (child.type === 'directory') {
                const found = getRelativePath(fileId, child, prefix + child.name + '/');
                if (found) return found;
            }
        }
    }
    return null;
}

function findFileByPath(relativePath, node = projectStructure, prefix = '') {
    if (node.children) {
        for (const child of node.children) {
            const childPath = prefix + child.name;
            if (child.type === 'file' && childPath === relativePath) return child;
            if (child.type === 'directory') {
                const found = findFileByPath(relativePath, child, childPath + '/');
                if (found) return found;
            }
        }
    }
    return null;
}

function saveSessionState() {
    try {
        if (!goldenLayoutInstance) return;
        const layoutConfig = goldenLayoutInstance.saveLayout();

        // Build editor states keyed by relative path
        const editorStates = {};
        const fileIdToPath = {};
        getAllFiles().forEach(file => {
            const relPath = getRelativePath(file.id);
            if (relPath) {
                fileIdToPath[file.id] = relPath;
                editorStates[relPath] = {
                    cursor: file.cursor || { row: 0, column: 0 },
                    selection: file.selection || null
                };
            }
        });

        // Tag layout config editor components with filePath for restore
        function tagFilePaths(item) {
            if ((item.componentType === 'editor' || item.componentType === 'hexEditor')
                && item.componentState && item.componentState.fileId) {
                item.componentState.filePath = fileIdToPath[item.componentState.fileId] || null;
            }
            if (item.content) item.content.forEach(tagFilePaths);
        }
        if (layoutConfig.root) tagFilePaths(layoutConfig.root);

        // Save explorer state
        let explorerState = null;
        if (projectFilesComponentInstance) {
            const pfc = projectFilesComponentInstance;
            // Collect collapsed directory paths
            const collapsedDirs = [];
            function findCollapsed(node, prefix) {
                if (node.children) {
                    for (const child of node.children) {
                        if (child.type === 'directory') {
                            const dirPath = prefix + child.name;
                            if (child.collapsed) collapsedDirs.push(dirPath);
                            findCollapsed(child, dirPath + '/');
                        }
                    }
                }
            }
            findCollapsed(projectStructure, '');
            explorerState = {
                viewMode: pfc.viewMode,
                gridCurrentPath: pfc.gridCurrentPath,
                selectedFileId: pfc._selectedFileId || null,
                collapsedDirs,
            };
        }

        const state = {
            workspacePath: currentWorkspacePath,
            activePreviewFilePath: activePreviewFileId ? getRelativePath(activePreviewFileId) : null,
            activeEditorFilePath: activeEditorFileId ? getRelativePath(activeEditorFileId) : null,
            layoutConfig,
            editorStates,
            explorerState,
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch (e) {
        log.warn('Failed to save session state:', e);
    }
}

function loadSessionState() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function clearSessionState() {
    localStorage.removeItem(SESSION_KEY);
}

function rewriteLayoutConfig(config) {
    function rewrite(item) {
        const isFileComponent = item.componentType === 'editor' || item.componentType === 'hexEditor';
        if (isFileComponent && item.componentState) {
            const filePath = item.componentState.filePath;
            if (!filePath) {
                // hexEditor tabs may not carry filePath — try resolving via fileId lookup
                const fileId = item.componentState.fileId;
                if (!fileId || !projectFiles[fileId]) {
                    item._remove = true;
                }
            } else {
                const file = findFileByPath(filePath);
                if (file) {
                    item.componentState.fileId = file.id;
                    const idPrefix = item.componentType === 'hexEditor' ? 'hex-' : 'editor-';
                    item.id = idPrefix + file.id;
                    if (item.title) {
                        item.title = item.componentType === 'hexEditor' ? `${file.name} [hex]` : file.name;
                    }
                } else {
                    item._remove = true;
                }
            }
        }
        if (item.content) {
            item.content = item.content.filter(child => {
                rewrite(child);
                return !child._remove;
            });
            // Clamp activeItemIndex so stacks don't point past the (now shorter) content array
            if (item.type === 'stack' && typeof item.activeItemIndex === 'number') {
                if (item.content.length === 0) {
                    delete item.activeItemIndex;
                } else if (item.activeItemIndex >= item.content.length) {
                    item.activeItemIndex = item.content.length - 1;
                } else if (item.activeItemIndex < 0) {
                    item.activeItemIndex = 0;
                }
            }
        }
    }
    if (config.root) rewrite(config.root);
    return config;
}

let _saveDebounceTimer = null;
function debouncedSave() {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = setTimeout(saveSessionState, 500);
}

function mapWorkspaceTree(items) {
    return items.map(item => {
        if (item.type === 'directory') {
            return {
                id: generateUniqueId(),
                name: item.name,
                type: 'directory',
                collapsed: true,
                children: mapWorkspaceTree(item.children || [])
            };
        }
        const file = {
            id: generateUniqueId(),
            name: item.name,
            type: 'file',
            content: item.content || '',
            cursor: { row: 0, column: 0 },
            selection: null
        };
        if (item.viewType) file.viewType = item.viewType;
        return file;
    });
}

function handleWorkspaceLoaded(result) {
    if (result.error) {
        alert('Failed to open workspace: ' + result.error);
        return;
    }

    currentWorkspacePath = result.path;

    // Clear dirty state — files are fresh from disk
    dirtyFiles.clear();
    Object.keys(_autoPersistTimers).forEach(id => clearTimeout(_autoPersistTimers[id]));
    updateSyncButton();

    projectStructure.children = mapWorkspaceTree(result.children || []);
    updateProjectFilesCache();

    // Set first file as active preview
    const allFiles = getAllFiles();
    if (allFiles.length > 0) {
        activePreviewFileId = allFiles[0].id;
    }

    if (projectFilesComponentInstance) {
        projectFilesComponentInstance.updateFileListDisplay();
    }
    if (previewComponentInstance) {
        previewComponentInstance.updateFileOptions();
        previewComponentInstance.updatePreviewMode();
    } else {
        updatePreviewFiles();
    }
    log.log(`Workspace opened: ${result.path} (${allFiles.length} files)`);
}

// --- File System Change Handling ---
// Listen for server-side file changes and refresh affected files
wsClient.addMessageListener(async (msg) => {
    if (msg.type !== 'fsChanges' || !currentWorkspacePath) return;

    log.log(`FS changes detected: ${msg.changes.length} change(s)`);
    let treeChanged = false;

    for (const change of msg.changes) {
        const relativePath = change.path.replace(/\\/g, '/');

        // Skip files we recently saved ourselves
        if (_recentlySavedFiles.has(relativePath)) continue;

        const file = findFileByPath(relativePath);

        if (file && file.content !== undefined && file.content !== null) {
            // File exists in our project — check if it was modified externally
            // Skip if the file is dirty (user has unsaved local changes)
            if (dirtyFiles.has(file.id)) continue;

            // Use content from server if provided, otherwise re-read
            let newContent = change.content;
            if (newContent === undefined || newContent === null) {
                try {
                    const result = await wsClient.wsRequest({
                        type: 'readFile',
                        workspacePath: currentWorkspacePath,
                        relativePath,
                    });
                    newContent = result.content;
                } catch (err) {
                    log.warn(`FS: Failed to re-read ${relativePath}:`, err);
                    continue;
                }
            }

            if (newContent !== undefined && newContent !== file.content) {
                file.content = newContent;
                log.log(`FS: Updated content for ${relativePath}`);
                // Refresh editor if this file is open
                const editorComponent = _editorInstances.get(file.id);
                if (editorComponent && editorComponent.editor) {
                    const cursorPos = editorComponent.editor.getCursorPosition();
                    editorComponent._suppressChangeEvents = true;
                    editorComponent.editor.setValue(file.content, -1);
                    editorComponent.editor.moveCursorToPosition(cursorPos);
                    editorComponent._suppressChangeEvents = false;
                    log.log(`FS: Editor refreshed for ${relativePath}`);
                }
                // Refresh preview if this file is being previewed
                if (activePreviewFileId === file.id && previewComponentInstance) {
                    previewComponentInstance.updatePreviewMode();
                }
            }
        } else if (!file) {
            // File doesn't exist — might be new, or a directory change
            treeChanged = true;
        }
    }

    // If new files/dirs were created or deleted, re-read the workspace tree
    if (treeChanged) {
        try {
            const result = await wsClient.wsRequest({ type: 'openWorkspace', path: currentWorkspacePath });
            if (!result.error) {
                const savedCollapsed = {};
                function collectCollapsed(node, prefix) {
                    if (node.children) {
                        for (const child of node.children) {
                            if (child.type === 'directory') {
                                const p = prefix + child.name;
                                if (child.collapsed) savedCollapsed[p] = true;
                                collectCollapsed(child, p + '/');
                            }
                        }
                    }
                }
                collectCollapsed(projectStructure, '');

                projectStructure.children = mapWorkspaceTree(result.children || []);

                // Restore collapsed state
                function applyCollapsed(node, prefix) {
                    if (node.children) {
                        for (const child of node.children) {
                            if (child.type === 'directory') {
                                const p = prefix + child.name;
                                if (p in savedCollapsed) child.collapsed = true;
                                applyCollapsed(child, p + '/');
                            }
                        }
                    }
                }
                applyCollapsed(projectStructure, '');

                updateProjectFilesCache();
                if (projectFilesComponentInstance) projectFilesComponentInstance.updateFileListDisplay();
                if (previewComponentInstance) previewComponentInstance.updateFileOptions();
                log.log('FS: Workspace tree refreshed');
            }
        } catch (err) {
            log.warn('FS: Failed to refresh workspace tree:', err);
        }
    }
});

// --- Preview Rendering ---

async function updatePreviewFiles() {
    try {
        const previewFile = projectFiles[activePreviewFileId];
        if (!previewFile) {
            log.warn('Preview file not found:', activePreviewFileId);
            return false;
        }

        const previewContent = generatePreviewContent(previewFile.name, previewFile.content, previewFile.type);

        // Collect all files
        const allFiles = {};
        Object.values(projectFiles).forEach(file => {
            allFiles[file.name] = file.content;
        });
        allFiles['preview.html'] = previewContent.content;

        // Try WebSocket first, then service worker
        await wsClient.wsReady;
        const reg = await serviceWorkerReady;
        let previewBasePath;

        if (await wsClient.sendPreviewFiles(allFiles)) {
            previewBasePath = './preview-output';
        } else if (reg && reg.active) {
            // Send files to service worker — served from /preview/
            for (const [fileName, content] of Object.entries(allFiles)) {
                reg.active.postMessage({ type: 'updateFile', fileName, content });
            }
            previewBasePath = './preview';
        } else {
            log.error('No preview transport available (no WebSocket, no ServiceWorker)');
            return false;
        }

        if (previewFrame) {
            previewFrame.removeAttribute('srcdoc'); // Clear srcdoc so src takes effect
            const timestamp = Date.now();
            previewFrame.src = `${previewBasePath}/preview.html?t=${timestamp}`;
            log.log(`Preview updated for file: ${previewFile.name}`);
        }
        return true;
    } catch (error) {
        log.error('Failed to update preview:', error);
        return false;
    }
}

// --- Editor Component ---
class EditorComponent {
    constructor(container, state) {
        this.rootElement = container.element;
        this.rootElement.classList.add('editor-container');
        this.fileId = state.fileId;

        if (!this.fileId || !projectFiles[this.fileId]) {
            this.rootElement.innerHTML = `Error: File ID '${this.fileId}' not provided or invalid.`;
            log.error('EditorComponent: Invalid fileId:', this.fileId, 'Available file IDs:', Object.keys(projectFiles));
            return;
        }

        const fileData = projectFiles[this.fileId];
        log.log('Editor init:', this.fileId, fileData.name);

        // For binary/media files, show viewer instead of Ace
        if (fileData.viewType) {
            this._initMediaViewer(fileData);
            container.on('destroy', () => { log.log(`Editor: Destroying viewer for ${fileData.name}`); });
            return;
        }

        this.editor = ace.edit(this.rootElement);
        this.editor.setTheme("ace/theme/github");

        // Set editor mode using the handler registry
        const aceMode = handlerRegistry.getAceModeForFile(fileData.name);
        this.editor.session.setMode(`ace/mode/${aceMode}`);

        // Register this editor instance so WS refresh can find it
        _editorInstances.set(this.fileId, this);

        this.editor.setOptions({
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            enableSnippets: true
        });

        this.editor.setValue(fileData.content, -1);
        if (fileData.cursor) {
            this.editor.moveCursorTo(fileData.cursor.row, fileData.cursor.column);
        }
        this.editor.focus();

        this._suppressChangeEvents = false;

        this.editor.session.on('change', async () => {
            if (this._suppressChangeEvents) return;
            const fileData = projectFiles[this.fileId];
            fileData.content = this.editor.getValue();
            markDirty(this.fileId);
            // Check if this file change should trigger a preview update
            const previewFile = projectFiles[activePreviewFileId];
            
            if (previewFile && handlerRegistry.requiresCustomRender(previewFile.name)) {
                // Debounce custom preview renders to avoid lag while typing
                clearTimeout(this._customRenderTimer);
                this._customRenderTimer = setTimeout(async () => {
                    log.log(`File content changed for ${fileData.name}, triggering custom render for ${previewFile.name}.`);
                    try {
                        if (previewComponentInstance) {
                            await handlerRegistry.renderFile(
                                previewFile.name,
                                activePreviewFileId,
                                previewComponentInstance.outputDiv,
                                previewComponentInstance.diagnosticsDiv,
                                projectFiles,
                                true, // preserveZoom
                                previewComponentInstance
                            );
                        }
                    } catch (error) {
                        log.error('Custom render failed:', error);
                        if (previewComponentInstance) {
                            previewComponentInstance.diagnosticsDiv.textContent = `Error: ${error.message}`;
                        }
                    }
                }, 500);

            } else if (!handlerRegistry.requiresCustomRender(fileData.name) && activePreviewFileId === this.fileId) {
                // Only update web preview if this file is the one being previewed
                log.log(`Web content changed for ${fileData.name}, triggering web preview render.`);
                await updatePreviewFiles();
            }
            // If conditions don't match, don't update the preview
        });

        this.editor.on('changeSelection', () => {
            const cursor = this.editor.getCursorPosition();
            projectFiles[this.fileId].cursor = { row: cursor.row, column: cursor.column };
            debouncedSave();
        });

        container.on('resize', () => this.editor.resize());
        container.on('show', () => this.editor.resize());
        container.on('destroy', () => {
            log.log(`Editor: Destroying editor for ${fileData.name}`);
            _editorInstances.delete(this.fileId);
            this.editor.destroy();
        });
    }

    _initMediaViewer(fileData) {
        if (!currentWorkspacePath) {
            this.rootElement.innerHTML = '<div style="padding:20px;color:#666;">Media viewing requires a server workspace.</div>';
            return;
        }
        const relPath = this._getRelativePath(fileData.id);
        const fullPath = currentWorkspacePath + '/' + relPath;
        const url = '/workspace-file?path=' + encodeURIComponent(fullPath);

        const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'svg']);
        const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg']);
        const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg']);
        const ext = fileData.viewType;

        if (IMAGE_EXTS.has(ext)) {
            const img = document.createElement('img');
            img.src = url;
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
            this.rootElement.style.cssText += 'display:flex;align-items:center;justify-content:center;overflow:auto;';
            this.rootElement.appendChild(img);
        } else if (VIDEO_EXTS.has(ext)) {
            const video = document.createElement('video');
            video.src = url;
            video.controls = true;
            video.style.cssText = 'max-width:100%;max-height:100%;';
            this.rootElement.style.cssText += 'display:flex;align-items:center;justify-content:center;';
            this.rootElement.appendChild(video);
        } else if (AUDIO_EXTS.has(ext)) {
            const audio = document.createElement('audio');
            audio.src = url;
            audio.controls = true;
            this.rootElement.style.cssText += 'display:flex;align-items:center;justify-content:center;';
            this.rootElement.appendChild(audio);
        } else if (ext === 'binary') {
            this._initHexViewer(url);
        } else if (ext === 'pdf') {
            this._initPdfViewer(url);
        } else {
            // Other types: use iframe
            const iframe = document.createElement('iframe');
            iframe.src = url;
            iframe.style.cssText = 'width:100%;height:100%;border:none;';
            this.rootElement.appendChild(iframe);
        }
    }

    async _initPdfViewer(url) {
        this.rootElement.style.cssText += 'overflow:auto;background:#525659;';
        const container = document.createElement('div');
        container.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;';
        this.rootElement.appendChild(container);

        try {
            const pdfjsLib = await import('https://esm.sh/pdfjs-dist@4.9.155/build/pdf.mjs');
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.9.155/build/pdf.worker.mjs';

            const pdf = await pdfjsLib.getDocument(url).promise;
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 1.5 });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                canvas.style.cssText = 'max-width:100%;height:auto;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
                container.appendChild(canvas);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            }
        } catch (err) {
            container.innerHTML = `<div style="color:#f88;padding:20px;">Failed to load PDF: ${err.message}</div>`;
        }
    }

    _initHexViewer(url) {
        const info = this._setupHexViewerStyle();
        info.textContent = 'Loading...';
        fetch(url).then(r => r.arrayBuffer()).then(buffer => {
            this._renderHexBytes(new Uint8Array(buffer), info);
        }).catch(err => {
            info.textContent = `Error loading file: ${err.message}`;
        });
    }

    _setupHexViewerStyle() {
        this.rootElement.style.cssText += 'overflow:auto;font-family:monospace;font-size:13px;padding:8px;background:#1e1e1e;color:#d4d4d4;';
        const info = document.createElement('div');
        info.style.cssText = 'padding:8px;color:#888;';
        this.rootElement.appendChild(info);
        return info;
    }

    _renderHexBytes(bytes, info) {
        info.textContent = `${bytes.length} bytes`;
        const pre = document.createElement('pre');
        pre.style.cssText = 'margin:0;line-height:1.4;';
        const BYTES_PER_LINE = 16;
        const lines = [];
        const len = Math.min(bytes.length, 0x10000); // Show first 64KB
        for (let i = 0; i < len; i += BYTES_PER_LINE) {
            const offset = i.toString(16).padStart(8, '0');
            const hexParts = [];
            let ascii = '';
            for (let j = 0; j < BYTES_PER_LINE; j++) {
                if (i + j < bytes.length) {
                    hexParts.push(bytes[i + j].toString(16).padStart(2, '0'));
                    const c = bytes[i + j];
                    ascii += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : '.';
                } else {
                    hexParts.push('  ');
                    ascii += ' ';
                }
            }
            lines.push(`${offset}  ${hexParts.slice(0, 8).join(' ')}  ${hexParts.slice(8).join(' ')}  |${ascii}|`);
        }
        if (bytes.length > len) {
            lines.push(`... (${bytes.length - len} more bytes)`);
        }
        pre.textContent = lines.join('\n');
        this.rootElement.appendChild(pre);
    }

    _getRelativePath(fileId) {
        return getRelativePath(fileId);
    }
}

// --- Preview Component ---
class PreviewComponent {
    constructor(container) {
        this.rootElement = container.element;
        this.rootElement.style.overflow = 'hidden';
        this.rootElement.style.height = '100%';
        this.rootElement.style.display = 'flex';
        this.rootElement.style.flexDirection = 'column';
        this.zoomLevel = 1;

        // Create collapsible preview controls
        this._controlsExpanded = true;

        this.controlsDiv = document.createElement('div');
        this.controlsDiv.style.padding = '4px 10px';
        this.controlsDiv.style.borderBottom = '1px solid #ccc';
        this.controlsDiv.style.background = '#f5f5f5';
        this.controlsDiv.style.display = 'flex';
        this.controlsDiv.style.alignItems = 'center';
        this.controlsDiv.style.gap = '8px';
        this.controlsDiv.style.flexShrink = '0';

        // Toggle button
        this._toggleBtn = document.createElement('span');
        this._toggleBtn.textContent = '\u25BC';
        this._toggleBtn.title = 'Collapse preview controls';
        this._toggleBtn.style.cssText = 'cursor:pointer;font-size:10px;user-select:none;color:#666;flex-shrink:0;';
        this._toggleBtn.onclick = () => this._toggleControls();

        const label = document.createElement('label');
        label.textContent = 'Preview:';
        label.style.fontWeight = 'bold';
        label.style.fontSize = '12px';

        this.fileSelect = document.createElement('select');
        this.fileSelect.style.cssText = 'padding:3px;border:1px solid #ccc;border-radius:3px;font-size:12px;min-width:0;flex:1;';

        this.updateFileOptions();

        this.fileSelect.onchange = () => {
            activePreviewFileId = this.fileSelect.value;
            log.log('PreviewComponent: Preview file changed to:', activePreviewFileId);
            this.updatePreviewMode();
        };

        // Preview mode indicator
        this.modeIndicator = document.createElement('span');
        this.modeIndicator.style.padding = '2px 6px';
        this.modeIndicator.style.borderRadius = '3px';
        this.modeIndicator.style.fontSize = '11px';
        this.modeIndicator.style.fontWeight = 'bold';

        // Inner content that gets hidden on collapse
        this._controlsContent = document.createElement('div');
        this._controlsContent.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden;';
        this._controlsContent.appendChild(label);
        this._controlsContent.appendChild(this.fileSelect);
        this._controlsContent.appendChild(this.modeIndicator);

        this.controlsDiv.appendChild(this._toggleBtn);
        this.controlsDiv.appendChild(this._controlsContent);

        // Add controls to the root element
        this.rootElement.appendChild(this.controlsDiv);
        
        // Create preview content container
        this.previewContentContainer = document.createElement('div');
        this.previewContentContainer.style.flex = '1';
        this.previewContentContainer.style.minHeight = '0';
        this.previewContentContainer.style.display = 'flex';
        this.previewContentContainer.style.flexDirection = 'column';
        this.rootElement.appendChild(this.previewContentContainer);
        
        // --- UI for Web Preview ---
        this.webPreviewContainer = document.createElement('div');
        this.webPreviewContainer.style.width = '100%';
        this.webPreviewContainer.style.height = '100%';
        this.webPreviewContainer.style.display = 'flex';
        this.webPreviewContainer.style.flexDirection = 'column';

        // Create iframe container
        const iframeContainer = document.createElement('div');
        iframeContainer.style.flex = '1';
        iframeContainer.style.minHeight = '0';
        iframeContainer.style.position = 'relative';

        previewFrame = document.createElement('iframe');
        previewFrame.classList.add('preview-iframe');
        previewFrame.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;';
        
        // Set initial src
        previewFrame.src = './preview/preview.html';
        
        iframeContainer.appendChild(previewFrame);
        this.webPreviewContainer.appendChild(iframeContainer);

        // --- UI for Custom Preview (e.g., Typst) ---
        this.customPreviewContainer = document.createElement('div');
        this.customPreviewContainer.style.display = 'flex';
        this.customPreviewContainer.style.flexDirection = 'column';
        this.customPreviewContainer.style.height = '100%';
        this.customPreviewContainer.style.minHeight = '0';
        
        // Add both preview containers to the content container
        this.previewContentContainer.appendChild(this.webPreviewContainer);
        this.previewContentContainer.appendChild(this.customPreviewContainer);
        
        previewComponentInstance = this;
        
        this.updatePreviewMode();

        // Note: tab change listeners are attached in the main init block
        // (where editorStack is reliably available) and call
        // previewComponentInstance.updateFileOptions() / updatePreviewMode()
        
        // Initial preview update
        setTimeout(() => {
            this.updatePreviewMode();
        }, 200);
    }
    
    async updatePreviewMode() {
        const previewFile = projectFiles[activePreviewFileId];
        
        if (previewFile && handlerRegistry.requiresCustomRender(previewFile.name)) {
            // Show custom preview
            this.webPreviewContainer.style.display = 'none';
            this.customPreviewContainer.style.display = 'flex';
            const preview = handlerRegistry.generatePreviewContent(previewFile.name, '', '');
            this.modeIndicator.textContent = preview.previewLabel || 'Custom';
            this.modeIndicator.style.backgroundColor = preview.previewColor || '#4CAF50';
            this.modeIndicator.style.color = 'white';
            
            // Clear previous custom UI and build new one
            this.customPreviewContainer.innerHTML = '';
            const ui = handlerRegistry.createPreviewUI(previewFile.name, this.customPreviewContainer, this);
            this.outputDiv = ui.outputDiv;
            this.diagnosticsDiv = ui.diagnosticsDiv;
            this.zoomDisplay = ui.zoomDisplay; // The handler provides this now
            
            if (this.diagnosticsDiv) {
                this.diagnosticsDiv.textContent = "Loading custom renderer...";
            }
            
            try {
                await handlerRegistry.renderFile(
                    previewFile.name,
                    activePreviewFileId,
                    this.outputDiv,
                    this.diagnosticsDiv,
                    projectFiles,
                    false, // preserveZoom
                    this
                );
            } catch (error) {
                log.error('Custom render failed:', error);
                if (this.diagnosticsDiv) {
                    this.diagnosticsDiv.textContent = `Error: ${error.message}`;
                }
            }

        } else if (previewFile && previewFile.viewType && currentWorkspacePath) {
            // Show media file preview (image, video, audio, pdf, binary)
            this.webPreviewContainer.style.display = 'flex';
            this.customPreviewContainer.style.display = 'none';
            this.modeIndicator.textContent = previewFile.viewType.toUpperCase();
            this.modeIndicator.style.backgroundColor = '#9C27B0';
            this.modeIndicator.style.color = 'white';

            const relPath = getRelativePath(previewFile.id);
            const fullPath = currentWorkspacePath + '/' + relPath;
            const url = '/workspace-file?path=' + encodeURIComponent(fullPath);

            const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'svg']);
            const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg']);
            const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg']);
            const ext = previewFile.viewType;
            let previewHtml;

            if (IMAGE_EXTS.has(ext)) {
                previewHtml = `<html><head><style>
*{margin:0;padding:0;box-sizing:border-box;}
body{overflow:auto;background:#1e1e1e;width:100vw;height:100vh;}
#container{display:flex;align-items:center;justify-content:center;min-width:100vw;min-height:100vh;}
img{display:block;}
#bar{position:fixed;top:8px;right:8px;display:flex;gap:4px;z-index:1;}
#bar button,#bar span{background:rgba(0,0,0,0.6);color:#fff;border:none;padding:4px 10px;border-radius:4px;font:13px monospace;cursor:pointer;}
#bar button:hover{background:rgba(0,0,0,0.8);}
#bar span{cursor:default;}
</style></head><body>
<div id="container"><img id="img" src="${url}"></div>
<div id="bar"><button id="zout">-</button><span id="info">100%</span><button id="zin">+</button><button id="fit">Fit</button></div>
<script>
var img=document.getElementById('img'),info=document.getElementById('info'),container=document.getElementById('container');
var scale=1,nw,nh;
function apply(){
  img.style.width=Math.round(nw*scale)+'px';
  img.style.height=Math.round(nh*scale)+'px';
  info.textContent=Math.round(scale*100)+'%';
}
function doFit(){scale=Math.min(innerWidth/nw,innerHeight/nh,1);apply();}
img.onload=function(){nw=img.naturalWidth;nh=img.naturalHeight;doFit();};
onresize=function(){if(nw)doFit();};
function zoom(f){if(!nw)return;var cx=innerWidth/2+document.documentElement.scrollLeft,cy=innerHeight/2+document.documentElement.scrollTop;var ns=Math.max(0.05,Math.min(50,scale*f));var r=ns/scale;scale=ns;apply();window.scrollTo(cx*r-innerWidth/2,cy*r-innerHeight/2);}
document.getElementById('zin').onclick=function(){zoom(1.25);};
document.getElementById('zout').onclick=function(){zoom(1/1.25);};
document.getElementById('fit').onclick=function(){if(nw)doFit();};
</script></body></html>`;
            } else if (VIDEO_EXTS.has(ext)) {
                previewHtml = `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#000;"><video src="${url}" controls style="max-width:100%;max-height:100%;"></video></body></html>`;
            } else if (AUDIO_EXTS.has(ext)) {
                previewHtml = `<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;"><audio src="${url}" controls></audio></body></html>`;
            } else if (ext === 'pdf') {
                previewHtml = `<html><head><style>
*{margin:0;padding:0;box-sizing:border-box;}
body{overflow:auto;background:#525659;}
#container{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;}
#error{color:#f88;padding:20px;display:none;}
</style></head><body>
<div id="container"></div>
<div id="error"></div>
<script type="module">
import * as pdfjsLib from 'https://esm.sh/pdfjs-dist@4.9.155/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.9.155/build/pdf.worker.mjs';
try {
  const pdf = await pdfjsLib.getDocument('${url}').promise;
  const container = document.getElementById('container');
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.cssText = 'max-width:100%;height:auto;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
} catch(e) {
  document.getElementById('error').style.display='block';
  document.getElementById('error').textContent='Failed to load PDF: '+e.message;
}
</script></body></html>`;
            } else {
                previewHtml = `<html><body style="margin:20px;font-family:monospace;color:#666;">No preview for .${ext} files</body></html>`;
            }

            if (previewFrame) {
                previewFrame.srcdoc = previewHtml;
            }
        } else {
            // Show web preview
            this.webPreviewContainer.style.display = 'flex';
            this.customPreviewContainer.style.display = 'none';
            this.modeIndicator.textContent = 'HTML';
            this.modeIndicator.style.backgroundColor = '#2196F3';
            this.modeIndicator.style.color = 'white';

            // Trigger a render for the web project
            updatePreviewFiles();
        }
    }
    
    adjustZoom(factor) {
        if (!this.outputDiv) return;
        this.zoomLevel *= factor;
        this.zoomLevel = Math.max(0.1, Math.min(5.0, this.zoomLevel));
        this.updateZoomDisplay();
        this.applyZoom();
    }

    fitToWidth() {
        if (!this.outputDiv) return;
        const typstSvg = this.outputDiv.querySelector('svg.typst-document-svg');
        if (typstSvg) {
            const containerWidth = this.outputDiv.clientWidth - 48;
            const intrinsicWidth = parseFloat(typstSvg.dataset.typstPageWidth) || parseFloat(typstSvg.getAttribute('width')) || typstSvg.getBoundingClientRect().width;
            this.zoomLevel = containerWidth / intrinsicWidth;
            this.zoomLevel = Math.max(0.1, Math.min(5.0, this.zoomLevel));
            this.updateZoomDisplay();
            this.applyZoom();
            return;
        }

        const svg = this.outputDiv.querySelector('svg');
        if (svg) {
            const containerWidth = this.outputDiv.clientWidth - 32;
            // Get the SVG's intrinsic width from its viewBox or attributes
            const viewBox = svg.getAttribute('viewBox');
            let intrinsicWidth;
            if (viewBox) {
                intrinsicWidth = parseFloat(viewBox.split(/[\s,]+/)[2]);
            } else {
                intrinsicWidth = parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width;
            }
            this.zoomLevel = containerWidth / intrinsicWidth;
            this.zoomLevel = Math.max(0.1, Math.min(5.0, this.zoomLevel));
            this.updateZoomDisplay();
            this.applyZoom();
        }
    }

    updateZoomDisplay() {
        if (this.zoomDisplay) {
            this.zoomDisplay.textContent = Math.round(this.zoomLevel * 100) + '%';
        }
    }

    applyZoom() {
        if (!this.outputDiv) return;
        const typstSvg = this.outputDiv.querySelector('svg.typst-document-svg');
        if (typstSvg) {
            const intrinsicWidth = parseFloat(typstSvg.getAttribute('data-width')) || parseFloat(typstSvg.getAttribute('width'));
            const intrinsicHeight = parseFloat(typstSvg.getAttribute('data-height')) || parseFloat(typstSvg.getAttribute('height'));
            if (!intrinsicWidth || !intrinsicHeight) return;

            typstSvg.style.width = (intrinsicWidth * this.zoomLevel) + 'px';
            typstSvg.style.height = (intrinsicHeight * this.zoomLevel) + 'px';
            typstSvg.style.display = 'block';
            typstSvg.style.margin = '0 auto';
            return;
        }

        const svg = this.outputDiv.querySelector('svg');
        if (svg) {
            // Use width-based scaling so the SVG's layout box matches its visual size.
            // This ensures the scroll container works correctly, unlike transform: scale().
            const viewBox = svg.getAttribute('viewBox');
            if (viewBox) {
                const parts = viewBox.split(/[\s,]+/);
                const intrinsicWidth = parseFloat(parts[2]);
                const intrinsicHeight = parseFloat(parts[3]);
                const newWidth = intrinsicWidth * this.zoomLevel;
                const newHeight = intrinsicHeight * this.zoomLevel;
                svg.style.width = newWidth + 'px';
                svg.style.height = newHeight + 'px';
            } else {
                svg.style.width = (this.zoomLevel * 100) + '%';
                svg.style.height = 'auto';
            }
            svg.style.transform = '';
            svg.style.display = 'block';
        }
    }

    _toggleControls() {
        this._controlsExpanded = !this._controlsExpanded;
        if (this._controlsExpanded) {
            this._controlsContent.style.display = 'flex';
            this._toggleBtn.textContent = '\u25BC';
            this._toggleBtn.title = 'Collapse preview controls';
            this.controlsDiv.style.padding = '4px 10px';
        } else {
            this._controlsContent.style.display = 'none';
            this._toggleBtn.textContent = '\u25B6';
            this._toggleBtn.title = 'Expand preview controls';
            this.controlsDiv.style.padding = '2px 10px';
        }
    }

    updateFileOptions() {
        this.fileSelect.innerHTML = '';

        // Get open tab file IDs
        const openFileIds = new Set();
        if (goldenLayoutInstance) {
            const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
            if (editorStack) {
                for (const item of editorStack.contentItems) {
                    const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                    if (state && state.fileId) openFileIds.add(state.fileId);
                }
            }
        }

        // Show open tabs first, then a separator, then remaining files
        const openFiles = [];
        const otherFiles = [];
        Object.values(projectFiles).forEach(file => {
            if (openFileIds.has(file.id)) openFiles.push(file);
            else otherFiles.push(file);
        });

        openFiles.forEach(file => {
            const option = document.createElement('option');
            option.value = file.id;
            option.textContent = file.name;
            if (file.id === activePreviewFileId) option.selected = true;
            this.fileSelect.appendChild(option);
        });

        if (openFiles.length > 0 && otherFiles.length > 0) {
            const sep = document.createElement('option');
            sep.disabled = true;
            sep.textContent = '───────────';
            this.fileSelect.appendChild(sep);
        }

        otherFiles.forEach(file => {
            const option = document.createElement('option');
            option.value = file.id;
            option.textContent = file.name;
            if (file.id === activePreviewFileId) option.selected = true;
            this.fileSelect.appendChild(option);
        });
    }
}

// --- Project Files Component ---
class ProjectFilesComponent {
    constructor(container) {
        this.rootElement = container.element;
        this.rootElement.style.cssText = 'padding:0;overflow:hidden;display:flex;flex-direction:column;height:100%;';
        this.rootElement.classList.add('project-files-container');

        // State
        this.viewMode = 'tree'; // 'tree' or 'grid'
        this.gridCurrentPath = []; // array of directory names for grid navigation
        this.contextMenu = null;
        this._resizeObserver = null;
        this._panelWidth = 300;

        // === Toolbar ===
        this.toolbar = document.createElement('div');
        this.toolbar.style.cssText = 'display:flex;gap:4px;padding:6px 8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #3a3a3a;flex-shrink:0;';

        const newFileBtn = document.createElement('button');
        newFileBtn.textContent = '+ File';
        newFileBtn.title = 'New File';
        newFileBtn.style.cssText = 'padding:2px 8px;font-size:12px;cursor:pointer;';
        newFileBtn.onclick = () => this.createNewFile();
        this.toolbar.appendChild(newFileBtn);

        // Persistence mode toggle
        this.modeToggleBtn = document.createElement('button');
        this.modeToggleBtn.style.cssText = 'padding:2px 8px;font-size:11px;cursor:pointer;display:none;border-radius:3px;';
        this.modeToggleBtn.onclick = () => {
            persistenceMode = persistenceMode === 'draft' ? 'auto' : 'draft';
            localStorage.setItem('gl-persistence-mode', persistenceMode);
            this._updatePersistenceUI();
        };
        this.toolbar.appendChild(this.modeToggleBtn);

        // Sync All button (draft mode)
        this.syncBtn = document.createElement('button');
        this.syncBtn.textContent = 'Sync';
        this.syncBtn.title = 'Write all changes to disk';
        this.syncBtn.style.cssText = 'padding:2px 8px;font-size:11px;cursor:pointer;display:none;background:#4CAF50;color:white;border:none;border-radius:3px;';
        this.syncBtn.onclick = () => syncAllDirtyFiles();
        this.toolbar.appendChild(this.syncBtn);

        // Wire up the global updateSyncButton
        const self = this;
        updateSyncButton = () => self._updatePersistenceUI();

        wsClient.wsReady.then(socket => {
            if (socket) {
                this._updatePersistenceUI();
            }
        });

        // Spacer
        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        this.toolbar.appendChild(spacer);

        // View toggle button
        this.viewToggleBtn = document.createElement('button');
        this.viewToggleBtn.title = 'Toggle tree/grid view';
        this.viewToggleBtn.style.cssText = 'padding:2px 6px;font-size:12px;cursor:pointer;';
        this.viewToggleBtn.textContent = '\u2630'; // hamburger for tree
        this.viewToggleBtn.onclick = () => {
            this.viewMode = this.viewMode === 'tree' ? 'grid' : 'tree';
            this._updateToggleIcon();
            this.updateFileListDisplay();
        };
        this.toolbar.appendChild(this.viewToggleBtn);

        this.rootElement.appendChild(this.toolbar);

        // === Path bar ===
        this.pathBar = document.createElement('div');
        this.pathBar.style.cssText = 'padding:4px 8px;font-size:11px;border-bottom:1px solid #3a3a3a;flex-shrink:0;display:flex;align-items:center;min-height:22px;cursor:pointer;overflow:hidden;';
        this.pathBar.title = 'Click to edit path';
        this.pathBar.onclick = (e) => {
            if (e.target.tagName === 'INPUT') return;
            this._enterPathEditMode();
        };
        this.rootElement.appendChild(this.pathBar);

        // === Content area ===
        this.contentArea = document.createElement('div');
        this.contentArea.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0;';
        this.contentArea.tabIndex = 0;
        this.contentArea.style.outline = 'none';
        this.rootElement.appendChild(this.contentArea);

        // Keyboard navigation state
        this._focusIndex = -1;
        this._searchStr = '';
        this._searchTimer = null;

        this.contentArea.addEventListener('keydown', (e) => this._handleKeyDown(e));
        this.contentArea.addEventListener('click', () => this.contentArea.focus());
        this.contentArea.addEventListener('contextmenu', (e) => {
            // Only trigger if clicking on empty space (not on a file/dir item)
            if (e.target === this.contentArea || e.target === this.ul || e.target === this.gridContainer) {
                e.preventDefault();
                // Determine current directory context
                const currentDir = this.viewMode === 'grid' ? this._getGridCurrentNode() : projectStructure;
                this._showContextMenu(e.clientX, e.clientY, null, null, null, currentDir);
            }
        });

        // Tree container (ul)
        this.ul = document.createElement('ul');
        this.ul.style.cssText = 'list-style:none;padding:0;margin:0;';
        this.contentArea.appendChild(this.ul);

        // Grid container
        this.gridContainer = document.createElement('div');
        this.gridContainer.style.cssText = 'display:none;padding:8px;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;';
        this.contentArea.appendChild(this.gridContainer);

        // Initial display
        this.updateFileListDisplay();
        log.log('ProjectFiles: Initialized.');

        // Drag and Drop
        this.rootElement.addEventListener('dragover', this.handleDragOver.bind(this));
        this.rootElement.addEventListener('dragleave', this.handleDragLeave.bind(this));
        this.rootElement.addEventListener('drop', this.handleDrop.bind(this));

        // Close context menu on click elsewhere
        document.addEventListener('click', () => this._removeContextMenu());

        // Auto-switch based on width
        this._resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                this._panelWidth = entry.contentRect.width;
                if (this._panelWidth < 200 && this.viewMode === 'grid') {
                    this.viewMode = 'tree';
                    this._updateToggleIcon();
                    this.updateFileListDisplay();
                }
            }
        });
        this._resizeObserver.observe(this.rootElement);

        projectFilesComponentInstance = this;

        // Restore explorer state from saved session
        if (_pendingExplorerState) {
            const es = _pendingExplorerState;
            _pendingExplorerState = null;
            if (es.viewMode) this.viewMode = es.viewMode;
            if (es.gridCurrentPath) this.gridCurrentPath = es.gridCurrentPath;
            // Restore collapsed directories
            if (es.collapsedDirs && es.collapsedDirs.length > 0) {
                const collapsedSet = new Set(es.collapsedDirs);
                function applyCollapsed(node, prefix) {
                    if (node.children) {
                        for (const child of node.children) {
                            if (child.type === 'directory') {
                                const dirPath = prefix + child.name;
                                child.collapsed = collapsedSet.has(dirPath);
                                applyCollapsed(child, dirPath + '/');
                            }
                        }
                    }
                }
                applyCollapsed(projectStructure, '');
            }
            this._updateToggleIcon();
            this.updateFileListDisplay();
        }
    }

    // --- Icon helpers ---

    _getFileIcon(name) {
        const ext = (name.lastIndexOf('.') !== -1) ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        const codeExts = ['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'java', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'lua', 'r', 'swift', 'kt', 'scala', 'zig', 'nim', 'toml', 'yaml', 'yml', 'json', 'xml', 'sql', 'graphql', 'wasm', 'vue', 'svelte'];
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff'];
        const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];
        const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv'];
        if (ext === 'pdf') return '\uD83D\uDCCA';
        if (imageExts.includes(ext)) return '\uD83D\uDDBC\uFE0F';
        if (audioExts.includes(ext)) return '\uD83C\uDFB5';
        if (videoExts.includes(ext)) return '\uD83C\uDFAC';
        if (codeExts.includes(ext) || ext === 'css' || ext === 'html' || ext === 'htm' || ext === 'typ') return '\u2699\uFE0F';
        return '\uD83D\uDCC4';
    }

    _updateToggleIcon() {
        this.viewToggleBtn.textContent = this.viewMode === 'tree' ? '\u2630' : '\u25A6';
    }

    _updatePersistenceUI() {
        if (!currentWorkspacePath || !wsClient || !wsClient.isConnected()) {
            this.modeToggleBtn.style.display = 'none';
            this.syncBtn.style.display = 'none';
            return;
        }
        this.modeToggleBtn.style.display = '';
        if (persistenceMode === 'draft') {
            this.modeToggleBtn.textContent = 'Draft';
            this.modeToggleBtn.title = 'Draft mode — changes stay in memory. Click to switch to auto-save.';
            this.modeToggleBtn.style.background = '#555';
            this.modeToggleBtn.style.color = 'white';
            this.modeToggleBtn.style.border = '1px solid #777';
            this.syncBtn.style.display = dirtyFiles.size > 0 ? '' : 'none';
            this.syncBtn.textContent = `Sync (${dirtyFiles.size})`;
        } else {
            this.modeToggleBtn.textContent = 'Auto-save';
            this.modeToggleBtn.title = 'Auto-save mode — changes saved to disk automatically. Click to switch to draft.';
            this.modeToggleBtn.style.background = '#4CAF50';
            this.modeToggleBtn.style.color = 'white';
            this.modeToggleBtn.style.border = '1px solid #4CAF50';
            this.syncBtn.style.display = 'none';
        }
    }

    // --- Path bar ---

    _updatePathBar() {
        this.pathBar.innerHTML = '';
        if (this.viewMode === 'tree') {
            const rootName = currentWorkspacePath ? currentWorkspacePath.split('/').pop() || '/' : 'Project';
            const span = document.createElement('span');
            span.textContent = '\uD83D\uDCC1 ' + rootName;
            span.style.cssText = 'opacity:0.7;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            this.pathBar.appendChild(span);
        } else {
            // Breadcrumb for grid view
            const segments = ['root', ...this.gridCurrentPath];
            segments.forEach((seg, i) => {
                if (i > 0) {
                    const sep = document.createElement('span');
                    sep.textContent = ' / ';
                    sep.style.cssText = 'opacity:0.5;margin:0 2px;';
                    this.pathBar.appendChild(sep);
                }
                const link = document.createElement('span');
                link.textContent = i === 0 ? (currentWorkspacePath ? currentWorkspacePath.split('/').pop() || '/' : 'Project') : seg;
                link.style.cssText = 'cursor:pointer;text-decoration:underline;font-size:11px;white-space:nowrap;';
                if (i < segments.length - 1) {
                    link.style.opacity = '0.7';
                }
                link.onclick = (e) => {
                    e.stopPropagation();
                    // Navigate to this level
                    this.gridCurrentPath = this.gridCurrentPath.slice(0, i);
                    this.updateFileListDisplay();
                };
                this.pathBar.appendChild(link);
            });
        }
    }

    _enterPathEditMode() {
        const currentPath = this.viewMode === 'grid' ? ('/' + this.gridCurrentPath.join('/')) : '/';
        this.pathBar.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentPath;
        input.style.cssText = 'width:100%;border:1px solid #666;padding:1px 4px;font-size:11px;background:inherit;color:inherit;outline:none;';

        const commitPath = () => {
            const val = input.value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
            const parts = val ? val.split('/').filter(Boolean) : [];
            // Validate path exists in structure
            let node = projectStructure;
            const validParts = [];
            for (const part of parts) {
                const child = (node.children || []).find(c => c.type === 'directory' && c.name === part);
                if (!child) break;
                validParts.push(part);
                node = child;
            }
            this.gridCurrentPath = validParts;
            if (validParts.length > 0 && this.viewMode === 'tree') {
                this.viewMode = 'grid';
                this._updateToggleIcon();
            }
            this.updateFileListDisplay();
        };

        input.onblur = commitPath;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitPath(); }
            else if (e.key === 'Escape') { e.preventDefault(); this._updatePathBar(); }
        };

        this.pathBar.appendChild(input);
        input.focus();
        input.select();
    }

    // --- Keyboard navigation ---

    _getVisibleItems() {
        // Returns flat array of {element, item} for all currently visible items
        const results = [];
        if (this.viewMode === 'grid' && this._hasDirectories()) {
            // Grid cards
            for (const card of this.gridContainer.children) {
                results.push(card);
            }
        } else {
            // Tree: collect visible li elements (skip hidden ones inside collapsed dirs)
            this._collectVisibleTreeItems(this.ul, results);
        }
        return results;
    }

    _collectVisibleTreeItems(container, results) {
        for (const child of container.children) {
            if (child.tagName === 'LI') {
                results.push(child);
            } else if (child.tagName === 'UL' && child.style.display !== 'none') {
                this._collectVisibleTreeItems(child, results);
            }
        }
    }

    _setFocusIndex(idx) {
        const items = this._getVisibleItems();
        // Clear old focus
        if (this._focusIndex >= 0 && this._focusIndex < items.length) {
            items[this._focusIndex].style.outline = '';
        }
        this._focusIndex = Math.max(-1, Math.min(idx, items.length - 1));
        if (this._focusIndex >= 0 && this._focusIndex < items.length) {
            const el = items[this._focusIndex];
            el.style.outline = '1px solid #5b9bd5';
            el.scrollIntoView({ block: 'nearest' });
            // Sync selection with focus
            const nameEl = el.querySelector('[data-file-id]');
            if (nameEl) {
                this._selectFile(nameEl.getAttribute('data-file-id'));
            } else {
                // Focused a directory — clear file selection highlight
                activeEditorFileId = null;
                this.contentArea.querySelectorAll('.active-file').forEach(el => {
                    el.classList.remove('active-file');
                    el.style.background = '';
                });
            }
        }
    }

    _getItemName(el) {
        // Get the display name from an item element
        const nameEl = el.querySelector('[data-file-id]') || el.querySelector('[data-grid-name]') || el.querySelector('span:nth-child(2)') || el.querySelector('span');
        return nameEl ? nameEl.textContent.trim() : '';
    }

    _handleKeyDown(e) {
        // Ignore if focus is in an input
        if (e.target.tagName === 'INPUT') return;

        const items = this._getVisibleItems();
        if (items.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this._setFocusIndex(this._focusIndex + 1);
                break;

            case 'ArrowUp':
                e.preventDefault();
                this._setFocusIndex(this._focusIndex - 1);
                break;

            case 'PageDown':
                e.preventDefault();
                this._setFocusIndex(this._focusIndex + 10);
                break;

            case 'PageUp':
                e.preventDefault();
                this._setFocusIndex(this._focusIndex - 10);
                break;

            case 'Home':
                e.preventDefault();
                this._setFocusIndex(0);
                break;

            case 'End':
                e.preventDefault();
                this._setFocusIndex(items.length - 1);
                break;

            case 'Enter':
                e.preventDefault();
                if (this._focusIndex >= 0 && this._focusIndex < items.length) {
                    const el = items[this._focusIndex];
                    const nameEl = el.querySelector('[data-file-id]');
                    if (nameEl) {
                        // File: open in editor
                        this.openOrFocusEditor(nameEl.getAttribute('data-file-id'));
                    } else if (this.viewMode === 'tree') {
                        // Tree directory: expand if collapsed and move to first child
                        const toggle = el.querySelector('span');
                        if (toggle && toggle.textContent === '\u25B6') {
                            toggle.click(); // expand
                        }
                        // After expanding, recalculate and move to next item (first child)
                        const newItems = this._getVisibleItems();
                        const curIdx = newItems.indexOf(el);
                        if (curIdx >= 0 && curIdx + 1 < newItems.length) {
                            this._setFocusIndex(curIdx + 1);
                        }
                    } else {
                        // Grid: click to navigate
                        el.click();
                    }
                }
                break;

            case 'ArrowRight':
                // Expand directory in tree view
                if (this.viewMode === 'tree' && this._focusIndex >= 0) {
                    const el = items[this._focusIndex];
                    const toggle = el.querySelector('span');
                    if (toggle && toggle.textContent === '\u25B6') {
                        toggle.click(); // expand
                    }
                }
                break;

            case 'ArrowLeft':
                e.preventDefault();
                if (this.viewMode === 'tree' && this._focusIndex >= 0) {
                    const el = items[this._focusIndex];
                    const toggle = el.querySelector('span');
                    if (toggle && toggle.textContent === '\u25BC') {
                        // Expanded directory: collapse it
                        toggle.click();
                    } else {
                        // File or collapsed dir: jump to parent directory
                        const parentUl = el.closest('ul');
                        if (parentUl && parentUl !== this.ul) {
                            // Find the li (directory row) before this ul
                            const parentLi = parentUl.previousElementSibling;
                            if (parentLi && parentLi.tagName === 'LI') {
                                const parentIdx = items.indexOf(parentLi);
                                if (parentIdx >= 0) {
                                    this._setFocusIndex(parentIdx);
                                }
                            }
                        }
                    }
                } else if (this.viewMode === 'grid' && this.gridCurrentPath.length > 0) {
                    this.gridCurrentPath.pop();
                    this.updateFileListDisplay();
                    this._setFocusIndex(0);
                }
                break;

            case 'Delete':
            case 'Backspace':
                // Don't handle if typing search
                break;

            case 'F2':
                e.preventDefault();
                if (this._focusIndex >= 0 && this._focusIndex < items.length) {
                    const el = items[this._focusIndex];
                    const nameEl = el.querySelector('[data-file-id]');
                    if (nameEl) {
                        const fileId = nameEl.getAttribute('data-file-id');
                        this.enterRenameMode(fileId, nameEl, el);
                    }
                }
                break;

            default:
                // Type-to-search: single printable character
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    this._searchStr += e.key.toLowerCase();
                    clearTimeout(this._searchTimer);
                    this._searchTimer = setTimeout(() => { this._searchStr = ''; }, 800);

                    // Find first item starting with search string from current position
                    const startIdx = this._searchStr.length === 1 ? this._focusIndex + 1 : this._focusIndex;
                    for (let i = 0; i < items.length; i++) {
                        const idx = (startIdx + i) % items.length;
                        const name = this._getItemName(items[idx]).toLowerCase();
                        if (name.startsWith(this._searchStr)) {
                            this._setFocusIndex(idx);
                            return;
                        }
                    }
                    // If multi-char didn't match, try with just the last character
                    if (this._searchStr.length > 1) {
                        const lastChar = this._searchStr.slice(-1);
                        for (let i = 0; i < items.length; i++) {
                            const idx = (this._focusIndex + 1 + i) % items.length;
                            const name = this._getItemName(items[idx]).toLowerCase();
                            if (name.startsWith(lastChar)) {
                                this._searchStr = lastChar;
                                this._setFocusIndex(idx);
                                return;
                            }
                        }
                    }
                }
                break;
        }
    }

    _syncFocusToElement(el) {
        const items = this._getVisibleItems();
        // Clear old outline
        if (this._focusIndex >= 0 && this._focusIndex < items.length) {
            items[this._focusIndex].style.outline = '';
        }
        this._focusIndex = items.indexOf(el);
        if (this._focusIndex >= 0) {
            el.style.outline = '1px solid #5b9bd5';
        }
        this.contentArea.focus();
    }

    _selectFile(fileId) {
        activeEditorFileId = fileId;
        // Update highlight without full rebuild
        this.contentArea.querySelectorAll('.active-file').forEach(el => {
            el.classList.remove('active-file');
            el.style.background = '';
        });
        this.contentArea.querySelectorAll('[data-file-id]').forEach(el => {
            if (el.getAttribute('data-file-id') === fileId) {
                el.closest('li, div').classList.add('active-file');
            }
        });
    }

    // --- Context menu ---

    _removeContextMenu() {
        if (this.contextMenu) {
            this.contextMenu.remove();
            this.contextMenu = null;
        }
    }

    _showContextMenu(x, y, fileId, nameSpan, li, dirNode) {
        this._removeContextMenu();
        const menu = document.createElement('div');
        menu.style.cssText = 'position:fixed;z-index:10000;background:#2d2d2d;border:1px solid #555;border-radius:4px;padding:4px 0;min-width:140px;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';

        const menuItem = (label, color, handler) => {
            const opt = document.createElement('div');
            opt.textContent = label;
            opt.style.cssText = `padding:4px 12px;cursor:pointer;font-size:12px;color:${color || '#ddd'};`;
            opt.onmouseenter = () => opt.style.background = '#444';
            opt.onmouseleave = () => opt.style.background = 'none';
            opt.onclick = (e) => { e.stopPropagation(); this._removeContextMenu(); handler(); };
            return opt;
        };

        // Determine the parent directory node for "new" operations
        const parentDir = dirNode || this._getParentDirNode(fileId);

        if (parentDir) {
            menu.appendChild(menuItem('New File', '#ddd', () => this._createNewItemInDir(parentDir, 'file')));
            menu.appendChild(menuItem('New Folder', '#ddd', () => this._createNewItemInDir(parentDir, 'directory')));
            // separator
            const sep = document.createElement('div');
            sep.style.cssText = 'border-top:1px solid #555;margin:4px 0;';
            menu.appendChild(sep);
        }

        if (fileId) {
            menu.appendChild(menuItem('Rename', '#ddd', () => this.enterRenameMode(fileId, nameSpan, li)));
            menu.appendChild(menuItem('Delete', '#f88', () => this.deleteFile(fileId)));
            const relPath = getRelativePath(fileId);
            if (relPath && currentWorkspacePath) {
                menu.appendChild(menuItem('Download', '#ddd', () => {
                    const fullPath = currentWorkspacePath + '/' + relPath;
                    const a = document.createElement('a');
                    a.href = '/download-file?path=' + encodeURIComponent(fullPath);
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }));
            }
        }

        if (!fileId && dirNode && currentWorkspacePath) {
            const dirPath = this._getDirPath(dirNode);
            const fullDirPath = currentWorkspacePath + (dirPath ? '/' + dirPath : '');
            menu.appendChild(menuItem('Download as Zip', '#ddd', () => {
                const a = document.createElement('a');
                a.href = '/download-dir?path=' + encodeURIComponent(fullDirPath);
                a.download = '';
                document.body.appendChild(a);
                a.click();
                a.remove();
            }));
        }

        // Plugin context menu items
        if (fileId) {
            const file = projectFiles[fileId];
            const fileName = file ? file.name : '';
            let hasPluginItems = false;
            for (const plugin of getPlugins()) {
                if (plugin.contextMenuItems) {
                    for (const item of plugin.contextMenuItems) {
                        if (!item.canHandle || item.canHandle(fileName)) {
                            if (!hasPluginItems) {
                                const sep2 = document.createElement('div');
                                sep2.style.cssText = 'border-top:1px solid #555;margin:4px 0;';
                                menu.appendChild(sep2);
                                hasPluginItems = true;
                            }
                            menu.appendChild(menuItem(item.label, '#ddd', () => item.action(fileId, projectFiles)));
                        }
                    }
                }
            }
        }

        document.body.appendChild(menu);
        this.contextMenu = menu;

        // Adjust if off-screen
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
        if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
    }

    _getParentDirNode(fileId) {
        function find(node) {
            if (!node.children) return null;
            for (const child of node.children) {
                if (child.id === fileId) return node;
                if (child.type === 'directory') {
                    const found = find(child);
                    if (found) return found;
                }
            }
            return null;
        }
        return find(projectStructure);
    }

    _getDirPath(dirNode) {
        // Walk projectStructure to find the path from root to dirNode
        function find(node, parts) {
            if (node === dirNode) return parts;
            if (!node.children) return null;
            for (const child of node.children) {
                if (child.type === 'directory') {
                    const found = find(child, [...parts, child.name]);
                    if (found) return found;
                }
            }
            return null;
        }
        if (dirNode === projectStructure) return '';
        const parts = find(projectStructure, []);
        return parts ? parts.join('/') : '';
    }

    _createNewItemInline(dirNode, type) {
        // Ensure the directory is expanded so the new entry is visible
        if (dirNode.collapsed) {
            dirNode.collapsed = false;
        }

        // Find the UL container for this directory's children in the DOM
        this.updateFileListDisplay();

        // Find the container <ul> for dirNode's children
        let container;
        if (dirNode === projectStructure) {
            container = this.ul;
        } else {
            container = this.contentArea.querySelector(`ul[data-dir-id="${dirNode.id || dirNode.name}"]`);
        }
        if (!container) { container = this.ul; }
        // Ensure the UL is visible
        container.style.display = 'block';

        // Create a temporary li with an inline input
        const li = document.createElement('li');
        li.style.cssText = 'display:flex;align-items:center;padding:2px 4px;';

        const icon = document.createElement('span');
        icon.textContent = type === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
        icon.style.cssText = 'margin-right:4px;font-size:13px;flex-shrink:0;width:18px;text-align:center;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = type === 'directory' ? 'folder name' : 'filename.ext';
        input.style.cssText = 'flex:1;padding:2px 4px;border:1px solid #666;border-radius:2px;font-size:12px;background:#1e1e1e;color:#ddd;outline:none;min-width:0;';

        li.appendChild(icon);
        li.appendChild(input);
        container.insertBefore(li, container.firstChild);
        input.focus();

        let committed = false;
        const commit = () => {
            if (committed) return;
            const trimmed = input.value.trim();
            if (!trimmed) { cancel(); return; }
            if ((dirNode.children || []).some(c => c.name === trimmed)) {
                input.style.borderColor = '#f88';
                input.title = `"${trimmed}" already exists`;
                return;
            }
            committed = true;
            li.remove();
            this._finishCreateItemInDir(dirNode, type, trimmed);
        };
        const cancel = () => {
            if (committed) return;
            committed = true;
            li.remove();
        };

        input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        };
        input.onblur = () => { if (!committed) cancel(); };
    }

    async _createNewItemInDir(dirNode, type) {
        this._createNewItemInline(dirNode, type);
    }

    async _finishCreateItemInDir(dirNode, type, trimmed) {

        if (type === 'directory') {
            // If we have a workspace, create on disk via WS
            if (currentWorkspacePath && wsClient && wsClient.isConnected()) {
                const relPath = this._getDirPath(dirNode);
                const fullPath = currentWorkspacePath + (relPath ? '/' + relPath : '') + '/' + trimmed;
                try {
                    const result = await wsClient.wsRequest({ type: 'mkdir', path: fullPath });
                    if (!result.success) {
                        alert('Failed to create folder: ' + (result.error || 'Unknown error'));
                        return;
                    }
                } catch (err) {
                    alert('Failed to create folder: ' + err.message);
                    return;
                }
            }
            // Add to tree
            if (!dirNode.children) dirNode.children = [];
            dirNode.children.push({ name: trimmed, type: 'directory', children: [], collapsed: false });
            // Re-sort: directories first, then alphabetical
            dirNode.children.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            this.updateFileListDisplay();
        } else {
            // New file
            const newFileId = generateUniqueId('file');
            const fileType = getFileTypeFromExtension(trimmed);
            if (!dirNode.children) dirNode.children = [];
            dirNode.children.push({
                id: newFileId, name: trimmed, type: 'file',
                fileType, content: '', cursor: { row: 0, column: 0 }, selection: null
            });
            projectFiles[newFileId] = {
                id: newFileId, name: trimmed, type: fileType,
                content: '', cursor: { row: 0, column: 0 }, selection: null
            };
            dirNode.children.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            this.updateFileListDisplay();
            if (previewComponentInstance) previewComponentInstance.updateFileOptions();
            updatePreviewFiles();
            markDirty(newFileId);
            this.openOrFocusEditor(newFileId);
        }
    }

    // --- Grid navigation helpers ---

    _getGridCurrentNode() {
        let node = projectStructure;
        for (const dirName of this.gridCurrentPath) {
            const child = (node.children || []).find(c => c.type === 'directory' && c.name === dirName);
            if (!child) return projectStructure; // fallback to root
            node = child;
        }
        return node;
    }

    _hasDirectories() {
        return (projectStructure.children || []).some(c => c.type === 'directory');
    }

    // --- Display update (public API) ---

    updateFileListDisplay() {
        // Decide effective view mode
        const effectiveMode = this.viewMode;

        if (effectiveMode === 'grid' && this._hasDirectories()) {
            this.ul.style.display = 'none';
            this.gridContainer.style.display = 'grid';
            this._renderGrid();
        } else {
            // Tree view (also fallback for flat projects in grid mode)
            this.ul.style.display = '';
            this.gridContainer.style.display = 'none';
            this.ul.innerHTML = '';
            this._renderTree(projectStructure.children, this.ul, 0);
        }

        this._updatePathBar();
        this.viewToggleBtn.style.display = this._panelWidth < 200 ? 'none' : '';

        // Restore focus index to the active file after rebuild
        this._focusIndex = -1;
        if (activeEditorFileId) {
            const items = this._getVisibleItems();
            for (let i = 0; i < items.length; i++) {
                const nameEl = items[i].querySelector('[data-file-id]');
                if (nameEl && nameEl.getAttribute('data-file-id') === activeEditorFileId) {
                    this._focusIndex = i;
                    items[i].style.outline = '1px solid #5b9bd5';
                    break;
                }
            }
        }
        log.log('ProjectFiles: File list display updated. Active file ID:', activeEditorFileId);
    }

    // --- Tree view rendering ---

    _renderTree(items, container, depth) {
        const self = this;
        renderTree({
            items,
            container,
            depth,
            darkMode: true,
            activeFileId: activeEditorFileId,
            getFileIcon: (name) => self._getFileIcon(name),
            onToggleDir: (item, expanded) => {
                item.collapsed = !expanded;
                self._syncFocusToElement(container);
            },
            onClickDir: (item, li) => {
                // toggle handled by shared renderer
            },
            onContextMenu: (e, item, nameSpan, li) => {
                if (item.type === 'directory') {
                    self._showContextMenu(e.clientX, e.clientY, null, nameSpan, li, item);
                } else {
                    self._showContextMenu(e.clientX, e.clientY, item.id, nameSpan, li);
                }
            },
            onClickFile: (item, li) => {
                log.log(`ProjectFiles: Clicked on file: ${item.name} (ID: ${item.id})`);
                self._selectFile(item.id);
                self._syncFocusToElement(li);
            },
            onDblClickFile: (item, li) => {
                log.log(`ProjectFiles: Double-clicked on file: ${item.name} (ID: ${item.id})`);
                self.openOrFocusEditor(item.id);
            },
            renderFileExtras: (item, li) => {
                // Dirty indicator
                if (dirtyFiles.has(item.id)) {
                    const dot = document.createElement('span');
                    dot.className = 'dirty-indicator';
                    dot.textContent = ' \u25CF';
                    dot.style.cssText = 'color:#e8a317;font-size:10px;margin-left:2px;flex-shrink:0;';
                    li.appendChild(dot);
                }
                // Hover actions
                const hoverActions = document.createElement('span');
                hoverActions.style.cssText = 'display:none;flex-shrink:0;margin-left:4px;';
                const delBtn = document.createElement('span');
                delBtn.textContent = '\uD83D\uDDD1\uFE0F';
                delBtn.title = 'Delete ' + item.name;
                delBtn.style.cssText = 'cursor:pointer;font-size:11px;opacity:0.6;';
                delBtn.onclick = (e) => { e.stopPropagation(); self.deleteFile(item.id); };
                delBtn.onmouseenter = () => delBtn.style.opacity = '1';
                delBtn.onmouseleave = () => delBtn.style.opacity = '0.6';
                hoverActions.appendChild(delBtn);
                li.onmouseenter = () => hoverActions.style.display = '';
                li.onmouseleave = () => hoverActions.style.display = 'none';
                li.appendChild(hoverActions);
            },
        });
    }

    // --- Grid view rendering ---

    _renderGrid() {
        // Disconnect any previous thumbnail observer — cards are about to be destroyed
        if (this._thumbIO) {
            this._thumbIO.disconnect();
        }
        this._thumbTargets = new Map();
        this.gridContainer.innerHTML = '';
        const node = this._getGridCurrentNode();
        const items = node.children || [];

        // ".." to go up (if not at root)
        if (this.gridCurrentPath.length > 0) {
            const upCard = this._createGridCard('\uD83D\uDCC1', '..', true);
            upCard.onclick = () => {
                this.gridCurrentPath.pop();
                this.updateFileListDisplay();
            };
            this.gridContainer.appendChild(upCard);
        }

        items.forEach(item => {
            if (item.type === 'directory') {
                const card = this._createGridCard('\uD83D\uDCC1', item.name, true);
                card.onclick = () => {
                    this.gridCurrentPath.push(item.name);
                    this.updateFileListDisplay();
                };
                card.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._showContextMenu(e.clientX, e.clientY, null, null, card, item);
                };
                this.gridContainer.appendChild(card);
            } else {
                const icon = this._getFileIcon(item.name);
                const card = this._createGridCard(icon, item.name, false, item);
                if (item.id === activeEditorFileId) {
                    card.style.border = '1px solid #5b9bd5';
                    card.style.background = 'rgba(91,155,213,0.15)';
                }
                card.onclick = () => {
                    this._selectFile(item.id);
                    this._syncFocusToElement(card);
                };
                card.ondblclick = () => {
                    this.openOrFocusEditor(item.id);
                };
                card.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const nameEl = card.querySelector('[data-grid-name]');
                    this._showContextMenu(e.clientX, e.clientY, item.id, nameEl || card, card);
                };
                this.gridContainer.appendChild(card);
            }
        });
    }

    _createGridCard(iconText, name, isDir, file = null) {
        const card = document.createElement('div');
        card.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px;border-radius:6px;cursor:pointer;border:1px solid transparent;text-align:center;min-height:88px;transition:background 0.1s;';
        card.onmouseenter = () => { if (!card.style.border.includes('#5b9bd5')) card.style.background = 'rgba(255,255,255,0.06)'; };
        card.onmouseleave = () => { if (!card.style.border.includes('#5b9bd5')) card.style.background = ''; };

        const iconEl = document.createElement('div');
        iconEl.textContent = iconText;
        iconEl.style.cssText = 'font-size:28px;line-height:1;width:56px;height:56px;display:flex;align-items:center;justify-content:center;overflow:hidden;';
        card.appendChild(iconEl);

        const nameEl = document.createElement('div');
        nameEl.textContent = name;
        nameEl.setAttribute('data-grid-name', '');
        nameEl.style.cssText = 'font-size:11px;margin-top:4px;word-break:break-all;max-height:2.6em;overflow:hidden;line-height:1.3;' + (isDir ? 'font-weight:bold;' : '');
        card.appendChild(nameEl);

        if (file && !isDir) {
            const renderer = this._findThumbnailRenderer(file);
            if (renderer) this._observeThumbnail(iconEl, file, renderer);
        }

        return card;
    }

    _findThumbnailRenderer(file) {
        for (const plugin of getPlugins()) {
            if (!plugin.thumbnailRenderers) continue;
            for (const r of plugin.thumbnailRenderers) {
                try {
                    if (r.canHandle(file)) return r;
                } catch (e) {
                    log.warn('Thumbnail canHandle threw:', e);
                }
            }
        }
        return null;
    }

    _observeThumbnail(container, file, renderer) {
        if (!this._thumbIO) {
            this._thumbTargets = this._thumbTargets || new Map();
            this._thumbIO = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const target = entry.target;
                    const data = this._thumbTargets.get(target);
                    if (!data) continue;
                    this._thumbTargets.delete(target);
                    this._thumbIO.unobserve(target);
                    try {
                        const r = data.renderer.render(data.file, target);
                        if (r && typeof r.catch === 'function') r.catch(err => log.warn('Thumbnail render rejected:', err));
                    } catch (err) {
                        log.warn('Thumbnail render threw:', err);
                    }
                }
            }, { root: this.gridContainer, rootMargin: '120px' });
        }
        this._thumbTargets.set(container, { file, renderer });
        this._thumbIO.observe(container);
    }

    // --- Public API methods (unchanged signatures) ---

    createNewFile() {
        const currentDir = this.viewMode === 'grid' ? this._getGridCurrentNode() : projectStructure;
        this._createNewItemInline(currentDir, 'file');
    }

    deleteFile(fileId) {
        const fileToDelete = projectFiles[fileId];
        if (!fileToDelete) {
            log.error(`ProjectFiles: File with ID ${fileId} not found for deletion.`);
            return;
        }

        if (!confirm(`Are you sure you want to delete "${fileToDelete.name}"?`)) {
            return;
        }

        log.log(`ProjectFiles: Deleting file: ${fileToDelete.name} (ID: ${fileId})`);
        delete projectFiles[fileId];

        const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
        if (editorStack) {
            const openTab = editorStack.contentItems.find(item => {
                const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                return state && state.fileId === fileId;
            });
            if (openTab) {
                log.log(`ProjectFiles: Closing editor tab for deleted file: ${fileToDelete.name}`);
                openTab.close();
            }
        }

        if (activeEditorFileId === fileId) {
            activeEditorFileId = null;
        }

        this.updateFileListDisplay();
        if (previewComponentInstance) {
            previewComponentInstance.updateFileOptions();
        }
        if (activePreviewFileId === fileId) {
            const remainingFiles = Object.keys(projectFiles);
            if (remainingFiles.length > 0) {
                activePreviewFileId = remainingFiles[0];
                if (previewComponentInstance) {
                    previewComponentInstance.fileSelect.value = activePreviewFileId;
                }
            }
        }
        updatePreviewFiles();
        log.log(`ProjectFiles: File "${fileToDelete.name}" deleted.`);
    }

    enterRenameMode(fileId, nameSpanElement, listItemElement) {
        const currentName = projectFiles[fileId].name;
        nameSpanElement.style.display = 'none';

        const inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.value = currentName;
        inputElement.style.cssText = 'width:calc(100% - 10px);padding:2px;border:1px solid #666;font-family:sans-serif;font-size:12px;background:inherit;color:inherit;';

        const commit = () => {
            this.commitRename(fileId, inputElement.value, nameSpanElement, inputElement);
        };

        const cancel = () => {
            nameSpanElement.style.display = '';
            inputElement.remove();
            log.log('ProjectFiles: Rename cancelled.');
        };

        inputElement.onblur = commit;
        inputElement.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        };

        listItemElement.insertBefore(inputElement, nameSpanElement);
        inputElement.focus();
        inputElement.select();
    }

    commitRename(fileId, newName, originalNameSpan, inputElement) {
        originalNameSpan.style.display = '';
        inputElement.remove();

        const currentFile = projectFiles[fileId];
        if (!currentFile) {
            log.error(`ProjectFiles: File with ID ${fileId} not found for committing rename.`);
            return;
        }

        const trimmedNewName = newName.trim();
        if (trimmedNewName && trimmedNewName !== currentFile.name) {
            log.log(`ProjectFiles: Committing rename for file ${currentFile.name} to ${trimmedNewName}`);
            currentFile.name = trimmedNewName;
            const oldType = currentFile.type;
            currentFile.type = getFileTypeFromExtension(currentFile.name);

            this.updateFileListDisplay();
            if (previewComponentInstance) {
                previewComponentInstance.updateFileOptions();
            }

            const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
            if (editorStack) {
                const openTab = editorStack.contentItems.find(item => {
                    const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                    return state && state.fileId === fileId;
                });
                if (openTab) {
                    openTab.setTitle(currentFile.name);
                    log.log(`ProjectFiles: Tab title updated for fileId "${fileId}" to "${currentFile.name}".`);

                    if (oldType !== currentFile.type) {
                        const editorComponent = openTab.container.componentReference;
                        if (editorComponent && editorComponent.editor) {
                            const aceMode = handlerRegistry.getAceModeForFile(currentFile.name);
                            editorComponent.editor.session.setMode(`ace/mode/${aceMode}`);
                            log.log(`ProjectFiles: Editor mode updated for fileId "${fileId}" to ${aceMode}.`);
                        } else {
                             log.warn(`ProjectFiles: Could not directly access editor instance via componentReference to update mode for fileId "${fileId}".`);
                        }
                    }
                }
            }
            updatePreviewFiles();
        } else {
            log.log('ProjectFiles: Rename not committed (name unchanged or empty).');
        }
    }

    handleDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        this.rootElement.classList.add('drag-over-active');
        event.dataTransfer.dropEffect = 'copy';
    }

    handleDragLeave(event) {
        event.preventDefault();
        event.stopPropagation();
        this.rootElement.classList.remove('drag-over-active');
    }

    handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        this.rootElement.classList.remove('drag-over-active');

        const files = event.dataTransfer.files;
        if (files.length > 0) {
            log.log(`ProjectFiles: Dropped ${files.length} file(s).`);
            Array.from(files).forEach(file => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const fileContent = e.target.result;
                    const fileName = file.name;
                    const fileType = getFileTypeFromExtension(fileName);
                    const newFileId = generateUniqueId('file');

                    projectFiles[newFileId] = {
                        id: newFileId,
                        name: fileName,
                        type: fileType,
                        content: fileContent,
                        cursor: { row: 0, column: 0 },
                        selection: null
                    };
                    log.log(`ProjectFiles: File "${fileName}" read and added with ID: ${newFileId}`);
                    this.updateFileListDisplay();
                    if (previewComponentInstance) {
                        previewComponentInstance.updateFileOptions();
                    }
                    if (Array.from(files).indexOf(file) === 0) {
                        this.openOrFocusEditor(newFileId);
                    }
                };
                reader.onerror = (err) => {
                    log.error(`ProjectFiles: Error reading file ${file.name}:`, err);
                };
                reader.readAsText(file);
            });
        }
    }

    openOrFocusEditor(fileId) {
        log.log('ProjectFiles: openOrFocusEditor called with fileId:', fileId);
        if (!projectFiles[fileId]) {
            log.error(`ProjectFiles: No file data found for fileId: "${fileId}"`);
            return;
        }
        const title = projectFiles[fileId].name;
        if (/\.(vsd|vsdx)$/i.test(title)) {
            openEditorTab('vsdxViewer', { fileId }, `${title} [vsdx]`, 'vsdx-' + fileId);
            return;
        }
        if (/\.swf$/i.test(title)) {
            openEditorTab('ruffleSwf', { fileId }, `${title} [swf]`, 'swf-' + fileId);
            return;
        }
        if (/\.epub$/i.test(title)) {
            openEditorTab('epubReader', { fileId }, `${title} [epub]`, 'epub-' + fileId);
            return;
        }
        if (/\.psd$/i.test(title)) {
            openEditorTab('psdViewer', { fileId }, `${title} [psd]`, 'psd-' + fileId);
            return;
        }
        if (/\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(title)) {
            openEditorTab('xlsxAst', { fileId }, `${title} [xlsx]`, 'xlsx-' + fileId);
            return;
        }
        if (/\.(sqlite|sqlite3|db)$/i.test(title)) {
            openEditorTab('sqliteInspector', { fileId }, `${title} [sqlite]`, 'sqlite-' + fileId);
            return;
        }
        if (/\.(glb|gltf|stl|obj)$/i.test(title)) {
            openEditorTab('model3dViewer', { fileId }, `${title} [3d]`, 'model3d-' + fileId);
            return;
        }
        if (/\.wasm$/i.test(title)) {
            openEditorTab('wasmInspector', { fileId }, `${title} [wasm]`, 'wasm-' + fileId);
            return;
        }
        if (/\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|ts|m2ts|3gp|mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(title)) {
            openEditorTab('mediaMetadata', { fileId }, `${title} [metadata]`, 'media-meta-' + fileId);
            return;
        }
        const contentItemId = 'editor-' + fileId;
        const state = { fileId, filePath: getRelativePath(fileId) };
        openEditorTab('editor', state, title, contentItemId);
    }
}

// --- GoldenLayout Initialization ---

function findOrCreateEditorStack() {
    if (!goldenLayoutInstance) return null;
    const allStacks = goldenLayoutInstance.getAllStacks();
    let editorStack = allStacks ? allStacks.find(stack => stack.id === 'editorStack') : null;
    if (editorStack) return editorStack;

    log.warn('openEditorTab: Editor stack not found. Creating new one.');
    try {
        const root = goldenLayoutInstance.root;

        function findColumnWithPreview(item) {
            if (item.type === 'column' && item.contentItems) {
                for (const child of item.contentItems) {
                    if (child.isComponent && child.componentType === 'preview') return item;
                    if (child.isStack && child.contentItems) {
                        for (const sc of child.contentItems) {
                            if (sc.isComponent && sc.componentType === 'preview') return item;
                        }
                    }
                }
            }
            if (item.contentItems) {
                for (const child of item.contentItems) {
                    const r = findColumnWithPreview(child);
                    if (r) return r;
                }
            }
            return null;
        }

        let targetColumn = findColumnWithPreview(root);
        if (!targetColumn && root.contentItems && root.contentItems.length > 1 && root.contentItems[1].type === 'column') {
            targetColumn = root.contentItems[1];
        }
        if (!targetColumn) {
            log.error('openEditorTab: Could not find suitable column for editor stack');
            return null;
        }

        targetColumn.addChild({ type: 'stack', id: 'editorStack', content: [] }, 0);
        editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
        if (!editorStack) log.error('openEditorTab: Failed to create editor stack');
        return editorStack;
    } catch (err) {
        log.error('openEditorTab: Error creating editor stack:', err);
        return null;
    }
}

function openEditorTab(componentType, state, title, contentItemId) {
    const editorStack = findOrCreateEditorStack();
    if (!editorStack) return null;

    const existingItem = editorStack.contentItems.find(item => {
        if (!item.id) return false;
        if (Array.isArray(item.id)) return item.id.includes(contentItemId);
        return item.id === contentItemId;
    });

    if (existingItem) {
        editorStack.setActiveContentItem(existingItem);
        return existingItem;
    }
    editorStack.addComponent(componentType, state, title, contentItemId);
    return editorStack.contentItems.find(item => {
        if (!item.id) return false;
        if (Array.isArray(item.id)) return item.id.includes(contentItemId);
        return item.id === contentItemId;
    });
}

function openSearchDialog(mode) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:80px;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#2a2a2a;color:#ddd;border:1px solid #555;border-radius:6px;width:640px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 8px 24px rgba(0,0,0,0.5);font-family:sans-serif;font-size:13px;';

    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 12px;border-bottom:1px solid #444;font-weight:bold;';
    header.textContent = mode === 'grep' ? 'Grep file contents' : 'Search files by name';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = mode === 'grep' ? 'Content pattern…' : 'File name…';
    input.style.cssText = 'margin:8px 12px;padding:6px 8px;background:#1e1e1e;color:#ddd;border:1px solid #555;border-radius:3px;font-size:13px;outline:none;';

    const status = document.createElement('div');
    status.style.cssText = 'padding:0 12px 6px;color:#888;font-size:11px;';

    const results = document.createElement('div');
    results.style.cssText = 'flex:1;overflow-y:auto;border-top:1px solid #333;';

    dialog.appendChild(header);
    dialog.appendChild(input);
    dialog.appendChild(status);
    dialog.appendChild(results);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function close() {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
    }
    function escHandler(e) {
        if (e.key === 'Escape') close();
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', escHandler);

    let selectedIndex = -1;
    let currentRows = [];

    function setSelection(idx) {
        if (currentRows[selectedIndex]) currentRows[selectedIndex].style.background = 'none';
        selectedIndex = idx;
        if (currentRows[selectedIndex]) {
            currentRows[selectedIndex].style.background = '#3a4a6a';
            currentRows[selectedIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    function openItem(item) {
        close();
        const fileData = projectFiles[item.file.id];
        if (!fileData) return;
        if (item.line) fileData.cursor = { row: item.line - 1, column: 0 };
        if (projectFilesComponentInstance) {
            projectFilesComponentInstance.openOrFocusEditor(item.file.id);
        }
        if (item.line) {
            const inst = _editorInstances.get(item.file.id);
            if (inst && inst.editor) {
                inst.editor.gotoLine(item.line, 0, true);
                inst.editor.focus();
            }
        }
    }

    function render(query) {
        results.innerHTML = '';
        currentRows = [];
        selectedIndex = -1;
        if (!query) {
            status.textContent = '';
            return;
        }

        const allFiles = getAllFiles();
        const items = [];
        const q = query.toLowerCase();

        if (mode === 'name') {
            for (const f of allFiles) {
                const path = getRelativePath(f.id) || f.name;
                if (path.toLowerCase().includes(q)) {
                    items.push({ file: f, path });
                }
            }
        } else {
            for (const f of allFiles) {
                if (f.viewType) continue; // skip binary
                const content = f.content || '';
                if (!content.toLowerCase().includes(q)) continue;
                const path = getRelativePath(f.id) || f.name;
                const lines = content.split('\n');
                lines.forEach((line, idx) => {
                    if (line.toLowerCase().includes(q)) {
                        items.push({ file: f, path, line: idx + 1, lineText: line });
                    }
                });
            }
        }

        const MAX = 200;
        const shown = items.slice(0, MAX);
        status.textContent = items.length > MAX
            ? `${shown.length} of ${items.length} matches (refine query for more)`
            : `${items.length} match${items.length === 1 ? '' : 'es'}`;

        for (const item of shown) {
            const row = document.createElement('div');
            row.style.cssText = 'padding:6px 12px;cursor:pointer;border-bottom:1px solid #333;';
            if (mode === 'grep') {
                const fileLabel = document.createElement('div');
                fileLabel.style.cssText = 'color:#88aaff;font-size:11px;';
                fileLabel.textContent = `${item.path}:${item.line}`;
                const lineLabel = document.createElement('div');
                lineLabel.style.cssText = 'font-family:monospace;font-size:12px;white-space:pre;overflow:hidden;text-overflow:ellipsis;';
                lineLabel.textContent = item.lineText.length > 200 ? item.lineText.slice(0, 200) + '…' : item.lineText;
                row.appendChild(fileLabel);
                row.appendChild(lineLabel);
            } else {
                row.textContent = item.path;
            }
            row.addEventListener('mouseenter', () => setSelection(currentRows.indexOf(row)));
            row.addEventListener('click', () => openItem(item));
            results.appendChild(row);
            currentRows.push(row);
        }

        if (currentRows.length > 0) setSelection(0);
    }

    let renderTimer = null;
    input.addEventListener('input', () => {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => render(input.value.trim()), 80);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (currentRows.length) setSelection((selectedIndex + 1) % currentRows.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (currentRows.length) setSelection((selectedIndex - 1 + currentRows.length) % currentRows.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (selectedIndex >= 0 && currentRows[selectedIndex]) currentRows[selectedIndex].click();
        }
    });

    input.focus();
}

function createTopToolbar() {
    const toolbarEl = document.getElementById('topToolbar');
    if (!toolbarEl) return;
    toolbarEl.innerHTML = '';

    function makeMenu(label) {
        const item = document.createElement('div');
        item.className = 'menu-item';
        item.textContent = label;
        const dropdown = document.createElement('div');
        dropdown.className = 'menu-dropdown';
        item.appendChild(dropdown);
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = item.classList.contains('open');
            toolbarEl.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
            if (!wasOpen) item.classList.add('open');
        });
        item.addEventListener('mouseenter', () => {
            if (toolbarEl.querySelector('.menu-item.open')) {
                toolbarEl.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
                item.classList.add('open');
            }
        });
        toolbarEl.appendChild(item);
        return dropdown;
    }

    function makeEntry(dropdown, label, onClick, opts = {}) {
        const entry = document.createElement('div');
        entry.className = 'menu-entry';
        entry.textContent = label;
        if (opts.disabled) entry.classList.add('disabled');
        entry.addEventListener('click', (e) => {
            e.stopPropagation();
            toolbarEl.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
            onClick();
        });
        dropdown.appendChild(entry);
        return entry;
    }

    // File menu
    const fileMenu = makeMenu('File');
    const openEntry = makeEntry(fileMenu, 'Open Workspace…', () => {
        wsClient.showWorkspaceSelector(handleWorkspaceLoaded);
    }, { disabled: true });
    wsClient.wsReady.then(socket => {
        if (socket) openEntry.classList.remove('disabled');
    });
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #444;margin:4px 0;';
    fileMenu.appendChild(sep);
    makeEntry(fileMenu, 'Search Files…', () => openSearchDialog('name'));
    makeEntry(fileMenu, 'Grep Contents…', () => openSearchDialog('grep'));

    // Plugins menu
    const pluginEntries = [];
    for (const plugin of getPlugins()) {
        if (!plugin.toolbarButtons) continue;
        for (const btnDef of plugin.toolbarButtons) {
            pluginEntries.push({ plugin, btnDef });
        }
    }
    if (pluginEntries.length > 0) {
        const pluginMenu = makeMenu('Plugins');
        for (const { plugin, btnDef } of pluginEntries) {
            const label = btnDef.menuLabel || `${plugin.name} — ${btnDef.title || btnDef.label}`;
            makeEntry(pluginMenu, label, () => {
                if (btnDef.onclick) {
                    btnDef.onclick();
                } else {
                    const compType = plugin.components ? Object.keys(plugin.components)[0] : null;
                    if (compType) openPluginPanel(compType, plugin.name);
                }
            });
        }
    }

    // Dismiss menus on outside click
    document.addEventListener('click', () => {
        toolbarEl.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
    });
}

function openPluginPanel(componentType, title, state) {
    if (!goldenLayoutInstance) return;

    const root = goldenLayoutInstance.root;
    let targetColumn = null;

    function findMainColumn(item) {
        if (item.type === 'column' && item.contentItems) {
            for (const child of item.contentItems) {
                if ((child.isComponent && child.componentType === 'preview') ||
                    (child.isStack && child.id === 'editorStack')) {
                    return item;
                }
                if (child.contentItems) {
                    for (const sub of child.contentItems) {
                        if (sub.isComponent && sub.componentType === 'preview') return item;
                    }
                }
            }
        }
        if (item.contentItems) {
            for (const child of item.contentItems) {
                const found = findMainColumn(child);
                if (found) return found;
            }
        }
        return null;
    }

    targetColumn = findMainColumn(root);
    if (!targetColumn) {
        targetColumn = root.contentItems[0] || root;
    }

    targetColumn.addComponent(componentType, state || {}, title || componentType);
    log.log('Plugin panel opened:', componentType);
}

function getDefaultLayoutConfig() {
    return {
        root: {
            type: 'row',
            content: [
                {
                    type: 'column',
                    width: 20,
                    content: [
                        {
                            type: 'component',
                            componentType: 'projectFiles',
                            title: 'Project Files'
                        }
                    ]
                },
                {
                    type: 'column',
                    width: 80,
                    content: [
                        {
                            type: 'stack',
                            id: 'editorStack',
                            content: [
                                {
                                    type: 'component',
                                    id: 'editor-' + projectFiles["htmlFile"].id,
                                    componentType: 'editor',
                                    title: projectFiles["htmlFile"].name,
                                    componentState: { fileId: projectFiles["htmlFile"].id }
                                }
                            ]
                        },
                        {
                            type: 'component',
                            componentType: 'preview',
                            title: 'Preview'
                        }
                    ]
                }
            ]
        },
        settings: {
            showPopoutIcon: false,
            showMaximiseIcon: true,
            showCloseIcon: true,
        },
        dimensions: {
            borderWidth: 5,
            minItemHeight: 10,
            minItemWidth: 10,
            headerHeight: 25,
        }
    };
}

function setupPostLayout() {
    handlerRegistry.initializeAllAceModes();

    // Set initial active file from current editor stack
    const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
    if (editorStack) {
        const initialActiveItem = editorStack.getActiveContentItem();
        if (initialActiveItem) {
            const state = initialActiveItem.container && typeof initialActiveItem.container.getState === 'function' ? initialActiveItem.container.getState() : null;
            if (state && state.fileId) {
                activeEditorFileId = state.fileId;
            } else if (initialActiveItem.isComponent && initialActiveItem.componentState && initialActiveItem.componentState.fileId) {
                activeEditorFileId = initialActiveItem.componentState.fileId;
            }
            if (activeEditorFileId && projectFilesComponentInstance) {
                projectFilesComponentInstance.updateFileListDisplay();
            }
        }

        editorStack.on('activeContentItemChanged', (activeContentItem) => {
            if (activeContentItem && activeContentItem.container && typeof activeContentItem.container.getState === 'function') {
                const state = activeContentItem.container.getState();
                if (state && state.fileId) {
                    activeEditorFileId = state.fileId;
                } else {
                    activeEditorFileId = null;
                }
            } else {
                activeEditorFileId = null;
            }
            if (projectFilesComponentInstance) {
                projectFilesComponentInstance.updateFileListDisplay();
            }
            if (previewComponentInstance) {
                previewComponentInstance.updateFileOptions();
                previewComponentInstance.updatePreviewMode();
            }
            debouncedSave();
        });
    }

    // Auto-save on layout changes
    goldenLayoutInstance.on('stateChanged', debouncedSave);
    window.addEventListener('beforeunload', saveSessionState);
}

function showRestorePrompt(savedState) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff;border-radius:8px;padding:24px;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,0.3);text-align:center;';
        dialog.innerHTML = `<h3 style="margin:0 0 8px;">Restore previous session?</h3>
            <p style="margin:0 0 16px;color:#666;font-size:14px;">${savedState.workspacePath || 'In-memory project'}</p>
            <div style="display:flex;gap:8px;justify-content:center;">
                <button id="restore-btn" style="padding:8px 20px;border:none;border-radius:4px;background:#0066cc;color:#fff;font-weight:bold;cursor:pointer;">Restore</button>
                <button id="fresh-btn" style="padding:8px 20px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;">Start Fresh</button>
            </div>`;
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        dialog.querySelector('#restore-btn').onclick = () => { overlay.remove(); resolve(true); };
        dialog.querySelector('#fresh-btn').onclick = () => { overlay.remove(); clearSessionState(); resolve(false); };
    });
}

async function restoreSession(savedState) {
    if (savedState.workspacePath) {
        // Re-open the workspace from server
        try {
            await wsClient.wsReady;
            if (!wsClient.isConnected()) throw new Error('No WebSocket');
            const result = await wsClient.wsRequest({ type: 'openWorkspace', path: savedState.workspacePath });
            if (result.error) throw new Error(result.error);

            currentWorkspacePath = result.path;
            projectStructure.children = mapWorkspaceTree(result.children || []);
            updateProjectFilesCache();

            // Apply saved cursor/selection states
            if (savedState.editorStates) {
                for (const [relPath, state] of Object.entries(savedState.editorStates)) {
                    const file = findFileByPath(relPath);
                    if (file) {
                        if (state.cursor) file.cursor = state.cursor;
                        if (state.selection) file.selection = state.selection;
                    }
                }
            }

            // Convert resolved config back to input format, then rewrite file IDs
            let layoutConfig = JSON.parse(JSON.stringify(savedState.layoutConfig));
            if (layoutConfig.resolved) {
                layoutConfig = LayoutConfig.fromResolved(layoutConfig);
            }
            rewriteLayoutConfig(layoutConfig);

            // Resolve active file IDs from paths
            if (savedState.activePreviewFilePath) {
                const f = findFileByPath(savedState.activePreviewFilePath);
                if (f) activePreviewFileId = f.id;
            }
            if (savedState.activeEditorFilePath) {
                const f = findFileByPath(savedState.activeEditorFilePath);
                if (f) activeEditorFileId = f.id;
            }

            // Queue explorer state for restore when ProjectFilesComponent constructs
            if (savedState.explorerState) {
                _pendingExplorerState = savedState.explorerState;
            }

            goldenLayoutInstance.loadLayout(layoutConfig);
            log.log('Init: Session restored from saved state.');
            return true;
        } catch (err) {
            log.warn('Init: Failed to restore session:', err);
            return false;
        }
    }
    return false;
}

// --- Mobile Layout Initialization ---
function initMobileLayout(layoutContainer) {
    const mobile = new MobileLayout(layoutContainer);

    // -- File Tree Panel --
    const fileTreePanel = mobile.panels.fileTree;
    const fileTreeEl = fileTreePanel.element;
    fileTreeEl.style.cssText += 'flex-direction:column;background:#1e1e1e;color:#ddd;';
    fileTreeEl._displayStyle = 'flex';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;gap:4px;padding:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #333;flex-shrink:0;';

    const newFileBtn = document.createElement('button');
    newFileBtn.textContent = '+ File';
    newFileBtn.style.cssText = 'padding:6px 12px;font-size:13px;cursor:pointer;border:1px solid #555;background:#2a2a2a;color:#ddd;border-radius:4px;';
    newFileBtn.onclick = () => {
        const name = prompt('File name:');
        if (!name) return;
        const id = generateUniqueId('file');
        const type = getFileTypeFromExtension(name);
        const fileObj = { id, name, type, content: '', cursor: { row: 0, column: 0 }, selection: null };
        projectFiles[id] = fileObj;
        projectStructure.children.push(fileObj);
        renderMobileFileTree();
    };
    toolbar.appendChild(newFileBtn);

    // Open workspace button (shown when WS connected)
    const openWsBtn = document.createElement('button');
    openWsBtn.textContent = '\uD83D\uDCC2 Open';
    openWsBtn.style.cssText = 'padding:6px 12px;font-size:13px;cursor:pointer;border:1px solid #555;background:#2a2a2a;color:#ddd;border-radius:4px;display:none;';
    openWsBtn.onclick = () => wsClient.showWorkspaceSelector(handleWorkspaceLoaded);
    toolbar.appendChild(openWsBtn);

    wsClient.wsReady.then(socket => {
        if (socket) openWsBtn.style.display = '';
    });

    fileTreeEl.appendChild(toolbar);

    // File list
    const fileListEl = document.createElement('div');
    fileListEl.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0;-webkit-overflow-scrolling:touch;';
    fileTreeEl.appendChild(fileListEl);

    function renderMobileFileTree() {
        fileListEl.innerHTML = '';
        const ul = document.createElement('ul');
        ul.style.cssText = 'list-style:none;padding:0;margin:0;';

        renderTree({
            items: projectStructure.children,
            container: ul,
            depth: 0,
            darkMode: true,
            activeFileId: activeEditorFileId,
            onClickFile: (item) => {
                activeEditorFileId = item.id;
                mobile.openFile(item.id, item.name);
            },
            onToggleDir: () => {},
            getFileIcon: (name) => {
                const ext = name.split('.').pop().toLowerCase();
                const icons = { html: '\uD83C\uDF10', css: '\uD83C\uDFA8', js: '\u26A1', typ: '\uD83D\uDCDD', md: '\uD83D\uDCDD', json: '{}' };
                return icons[ext] || '\uD83D\uDCC4';
            },
        });

        fileListEl.appendChild(ul);
    }

    // -- Editor Panel --
    const editorPanel = mobile.panels.editor;
    const editorEl = editorPanel.element;
    let mobileEditor = null;
    let mobileEditorFileId = null;

    function setupMobileEditor(fileId) {
        const file = projectFiles[fileId];
        if (!file) return;

        // Save previous file content
        if (mobileEditor && mobileEditorFileId && projectFiles[mobileEditorFileId]) {
            projectFiles[mobileEditorFileId].content = mobileEditor.getValue();
            const cursor = mobileEditor.getCursorPosition();
            projectFiles[mobileEditorFileId].cursor = { row: cursor.row, column: cursor.column };
        }

        mobileEditorFileId = fileId;

        if (!mobileEditor) {
            mobileEditor = ace.edit(editorEl);
            mobileEditor.setTheme("ace/theme/github");
            mobileEditor.setOptions({
                enableBasicAutocompletion: true,
                enableLiveAutocompletion: true,
                enableSnippets: true,
                fontSize: '14px',
            });

            mobileEditor.session.on('change', () => {
                if (mobileEditorFileId && projectFiles[mobileEditorFileId]) {
                    projectFiles[mobileEditorFileId].content = mobileEditor.getValue();
                    markDirty(mobileEditorFileId);
                }
            });
        }

        const aceMode = handlerRegistry.getAceModeForFile(file.name);
        mobileEditor.session.setMode(`ace/mode/${aceMode}`);
        mobileEditor.setValue(file.content, -1);
        if (file.cursor) {
            mobileEditor.moveCursorTo(file.cursor.row, file.cursor.column);
        }
        mobileEditor.resize();
        mobileEditor.focus();
    }

    mobile._onOpenFile = (fileId) => {
        setupMobileEditor(fileId);
    };

    // Resize editor when panel becomes visible
    editorPanel.container.on('resize', () => {
        if (mobileEditor) {
            setTimeout(() => mobileEditor.resize(), 50);
        }
    });

    // -- Preview Panel --
    const previewPanel = mobile.panels.preview;
    const previewEl = previewPanel.element;
    previewEl.style.cssText += 'background:white;';

    // Use a dedicated iframe for mobile preview, and wire it into the global previewFrame
    const mobilePreviewFrame = document.createElement('iframe');
    mobilePreviewFrame.classList.add('preview-iframe');
    mobilePreviewFrame.style.cssText = 'width:100%;height:100%;border:none;';
    mobilePreviewFrame.src = './preview/preview.html';
    previewEl.appendChild(mobilePreviewFrame);
    previewFrame = mobilePreviewFrame; // Wire into global so updatePreviewFiles() works

    // Preview button handler — renders current project into iframe
    const originalShowPreview = mobile.showPreview.bind(mobile);
    mobile.showPreview = () => {
        // Save current editor content before preview
        if (mobileEditor && mobileEditorFileId && projectFiles[mobileEditorFileId]) {
            projectFiles[mobileEditorFileId].content = mobileEditor.getValue();
        }

        // Set activePreviewFileId to current editor file if not set
        if (!activePreviewFileId && mobileEditorFileId) {
            activePreviewFileId = mobileEditorFileId;
        }

        const previewFileId = activePreviewFileId || mobileEditorFileId;
        const previewFile = projectFiles[previewFileId];
        if (previewFile && handlerRegistry.requiresCustomRender(previewFile.name)) {
            // Custom render (Typst, etc.) — use a simple output container
            previewEl.innerHTML = '';
            const outputDiv = document.createElement('div');
            outputDiv.style.cssText = 'flex:1;overflow:auto;background:white;min-height:0;';
            const diagDiv = document.createElement('div');
            diagDiv.style.cssText = 'height:60px;background:#212529;color:#f8f9fa;font-family:monospace;font-size:11px;padding:6px;overflow-y:auto;flex-shrink:0;';
            previewEl.style.display = 'flex';
            previewEl.style.flexDirection = 'column';
            previewEl.appendChild(outputDiv);
            previewEl.appendChild(diagDiv);

            handlerRegistry.renderFile(
                previewFile.name,
                previewFileId,
                outputDiv, diagDiv,
                projectFiles, false, null
            ).catch(err => {
                diagDiv.textContent = `Error: ${err.message}`;
            });
        } else {
            // Web preview — reuse existing updatePreviewFiles() which handles SW and WS
            previewEl.innerHTML = '';
            previewEl.appendChild(mobilePreviewFrame);
            previewFrame = mobilePreviewFrame;
            updatePreviewFiles();
        }

        originalShowPreview();
    };

    // Initial render
    renderMobileFileTree();
    handlerRegistry.initializeAllAceModes();

    // Handle orientation changes
    window.addEventListener('resize', () => mobile.updateSize());
    window.addEventListener('orientationchange', () => {
        setTimeout(() => mobile.updateSize(), 100);
    });

    log.log('Init: Mobile layout ready.');
}

document.addEventListener('DOMContentLoaded', async () => {
    const layoutContainer = document.getElementById('layoutContainer');
    if (!layoutContainer) {
        log.error('Init: Layout container #layoutContainer not found!');
        return;
    }

    // --- Mobile Layout Path ---
    if (isMobile()) {
        log.log('Init: Mobile device detected, using mobile layout.');
        initMobileLayout(layoutContainer);
        return;
    }

    // --- Desktop Layout Path (GoldenLayout) ---
    log.log('Init: Initializing GoldenLayout.');
    goldenLayoutInstance = new GoldenLayout(layoutContainer);

    // Fix: GoldenLayout sets pointer-events:none on iframes during drag but
    // only clears it on the first iframe (querySelector). Ensure all iframes
    // are restored after any drag/resize operation ends.
    document.addEventListener('pointerup', () => {
        requestAnimationFrame(() => {
            if (!document.body.classList.contains('lm_dragging')) {
                document.querySelectorAll('iframe[style*="pointer-events"]').forEach(iframe => {
                    iframe.style.removeProperty('pointer-events');
                });
            }
        });
    });

    goldenLayoutInstance.registerComponentConstructor('editor', EditorComponent);
    goldenLayoutInstance.registerComponentConstructor('preview', PreviewComponent);
    goldenLayoutInstance.registerComponentConstructor('projectFiles', ProjectFilesComponent);

    // Register plugin components
    function pluginCreateFile(name, content) {
        const id = generateUniqueId('file');
        const type = getFileTypeFromExtension(name);
        const fileObj = { id, name, type, content: content || '', cursor: { row: 0, column: 0 }, selection: null };
        projectFiles[id] = fileObj;
        projectStructure.children.push({ id, name, type: 'file', fileType: type, content: content || '', cursor: { row: 0, column: 0 }, selection: null });
        markDirty(id);
        if (projectFilesComponentInstance) projectFilesComponentInstance.updateFileListDisplay();
        if (previewComponentInstance) previewComponentInstance.updateFileOptions();
        return id;
    }
    const pluginCtx = {
        wsClient,
        goldenLayoutInstance,
        get projectFiles() { return projectFiles; },
        get currentWorkspacePath() { return currentWorkspacePath; },
        getRelativePath,
        markDirty,
        clearDirty(fileId) {
            dirtyFiles.delete(fileId);
            updateDirtyIndicator(fileId);
            updateSyncButton();
        },
        log,
        openPluginPanel,
        openEditorTab,
        createFile: pluginCreateFile,
    };
    for (const plugin of getPlugins()) {
        if (plugin.init) plugin.init(pluginCtx);
        if (plugin.components) {
            for (const [type, Comp] of Object.entries(plugin.components)) {
                goldenLayoutInstance.registerComponentConstructor(type, Comp);
                log.log('Plugin component registered:', type, 'from', plugin.id);
            }
        }
    }

    createTopToolbar();

    // Check for saved session
    const savedState = loadSessionState();
    let restored = false;

    if (savedState && savedState.workspacePath) {
        const shouldRestore = await showRestorePrompt(savedState);
        if (shouldRestore) {
            restored = await restoreSession(savedState);
        }
    }

    if (!restored) {
        goldenLayoutInstance.loadLayout(getDefaultLayoutConfig());
        if (projectFiles.htmlFile) {
            activeEditorFileId = projectFiles.htmlFile.id;
        }
    }

    log.log('Init: GoldenLayout loaded.');
    setupPostLayout();

    window.addEventListener('resize', () => {
        if (goldenLayoutInstance) {
            goldenLayoutInstance.updateSize();
        }
    });

    new ResizeObserver(() => {
        if (goldenLayoutInstance) {
            goldenLayoutInstance.updateSize();
        }
    }).observe(document.getElementById('layoutContainer'));

    // --- Public client API (window.app) ---
    window.app = createClientApi({
        get goldenLayoutInstance() { return goldenLayoutInstance; },
        get projectFiles() { return projectFiles; },
        get projectStructure() { return projectStructure; },
        get currentWorkspacePath() { return currentWorkspacePath; },
        get projectFilesComponentInstance() { return projectFilesComponentInstance; },
        get previewComponentInstance() { return previewComponentInstance; },
        wsClient,
        dirtyFiles,
        _editorInstances,
        getAllFiles,
        getRelativePath,
        findFileByPath,
        generateUniqueId,
        getFileTypeFromExtension,
        markDirty,
        updatePreviewFiles,
        saveFileToDisk,
        syncAllDirtyFiles,
        handleWorkspaceLoaded,
        openEditorTab,
        findOrCreateEditorStack,
        getDefaultLayoutConfig,
        log,
    });
    log.log('Init: Client API exposed at window.app (v' + window.app.version + ').');

    // Expose the ws client on window so you can send clientAction/clientEval
    // from the DevTools console (e.g. across tabs). Prefer window.app for
    // regular use; this is the raw transport.
    window.wsClient = wsClient;

    // Wire up the RPC relay so agents can drive the editor over WebSocket
    installClientRpc(wsClient, log);

    // Expose editor state globally for debugging (legacy alias)
    const editorDebugInterface = {
        get projectFiles() { return projectFiles; },
        set projectFiles(newProjectFiles) {
            log.log('Debug: Setting projectFiles. Old:', projectFiles, 'New:', newProjectFiles);
            projectFiles = newProjectFiles;
            if (projectFilesComponentInstance) {
                projectFilesComponentInstance.updateFileListDisplay();
            }
            updatePreviewFiles();
            log.log('Debug: projectFiles set and UI updated (file list, preview).');
        },

        get goldenLayoutInstance() { return goldenLayoutInstance; },
        // No setter for goldenLayoutInstance as it's foundational

        get activeEditorFileId() { return activeEditorFileId; },
        set activeEditorFileId(newFileId) {
            log.log('Debug: Setting activeEditorFileId to:', newFileId);
            activeEditorFileId = newFileId;
            if (projectFilesComponentInstance) {
                projectFilesComponentInstance.updateFileListDisplay(); // Update highlight
            }
            // Attempt to focus the editor tab
            if (this.editorStack && projectFiles[newFileId]) {
                const itemToFocus = this.editorStack.contentItems.find(item => {
                    const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                    return state && state.fileId === newFileId;
                });
                if (itemToFocus) {
                    this.editorStack.setActiveContentItem(itemToFocus);
                    log.log('Debug: Focused editor tab for:', newFileId);
                } else {
                    log.log('Debug: No open editor tab found to focus for:', newFileId);
                }
            }
        },

        get projectFilesComponentInstance() { return projectFilesComponentInstance; },
        // No setter for projectFilesComponentInstance

        get editorStack() {
            return goldenLayoutInstance ? goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack') : null;
        },

        // --- Helper functions for more granular control ---
        setProjectFileContent(fileId, content) {
            if (projectFiles[fileId]) {
                log.log(`Debug: Setting content for fileId: ${fileId}`);
                projectFiles[fileId].content = content;

                // Update Ace editor if open
                const editorStack = this.editorStack;
                if (editorStack) {
                    const openTab = editorStack.contentItems.find(item => {
                        const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                        return state && state.fileId === fileId;
                    });
                    if (openTab && openTab.container && openTab.container.componentReference && openTab.container.componentReference.editor) {
                        const editor = openTab.container.componentReference.editor;
                        if (editor.getValue() !== content) {
                            editor.setValue(content, -1); // -1 moves cursor to beginning
                            log.log(`Debug: Updated Ace editor content for fileId: ${fileId}`);
                        }
                    }
                }
                updatePreviewFiles();
            } else {
                log.warn(`Debug: setProjectFileContent: fileId ${fileId} not found.`);
            }
        },

        getProjectFileContent(fileId) {
            return projectFiles[fileId] ? projectFiles[fileId].content : undefined;
        },

        refreshPreview() {
            log.log('Debug: Manually refreshing preview.');
            updatePreviewFiles();
        },

        refreshProjectFilesList() {
            if (projectFilesComponentInstance) {
                log.log('Debug: Manually refreshing project files list.');
                projectFilesComponentInstance.updateFileListDisplay();
            }
        },
        
        focusEditorTabByFileId(fileId) {
            if (this.editorStack && projectFiles[fileId]) {
                const itemToFocus = this.editorStack.contentItems.find(item => {
                    const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                    return state && state.fileId === fileId;
                });
                if (itemToFocus) {
                    this.editorStack.setActiveContentItem(itemToFocus);
                    log.log(`Debug: Attempted to focus editor tab for fileId: ${fileId}`);
                    return true;
                }
            }
            log.warn(`Debug: Could not focus editor tab for fileId: ${fileId} (not found or stack unavailable).`);
            return false;
        },

        getAllEditorInstances() {
            const es = this.editorStack;
            if (es && es.contentItems) {
                return es.contentItems
                    .map(item => item.container && item.container.componentReference && item.container.componentReference.editor)
                    .filter(editor => !!editor);
            }
            return [];
        },

        getActiveEditorInstance() {
            const es = this.editorStack;
            const activeItem = es ? es.getActiveContentItem() : null;
            return activeItem && activeItem.container && activeItem.container.componentReference ? activeItem.container.componentReference.editor : null;
        }
    };
    window.__$goldenviewerEditor = editorDebugInterface;
    log.log('Init: Editor state exposed globally as window.__$goldenviewerEditor with setters and helpers.');
});
