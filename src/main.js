const { GoldenLayout, Stack } = require('golden-layout'); // Import Stack
const ace = require('ace-builds/src-min-noconflict/ace');

require('ace-builds/src-min-noconflict/mode-html');
require('ace-builds/src-min-noconflict/theme-github');
require('ace-builds/src-min-noconflict/ext-language_tools');
require('ace-builds/src-min-noconflict/mode-css');
require('ace-builds/src-min-noconflict/mode-javascript');

// Import preview handlers
const { generatePreviewContent } = require('./preview-handlers');

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
        }
    ]
};

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
let previewComponentInstance; // To access preview methods
let activeEditorFileId = null; // To track the currently active file in the editor
let activePreviewFileId = 'htmlFile'; // To track which file is being previewed

// Helper to generate unique IDs for files and directories
function generateUniqueId(prefix = 'item') {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// Helper to determine file type for Ace mode
function getFileTypeFromExtension(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    switch (extension) {
        case 'html':
        case 'htm':
            return 'html';
        case 'css':
            return 'css';
        case 'js':
            return 'javascript';
        default:
            return 'text'; // Default to plain text if unknown
    }
}

// --- Service Worker Setup ---
let serviceWorkerRegistration = null;

// Register service worker
if ('serviceWorker' in navigator) {
    // Detect if we're running in a subdirectory (like GitHub Pages)
    const currentPath = window.location.pathname;
    const basePath = currentPath.endsWith('/') ? currentPath : currentPath + '/';
    const workerPath = basePath + 'worker.js';
    
    navigator.serviceWorker.register(workerPath)
        .then(registration => {
            console.log('[ServiceWorker] Registered successfully');
            serviceWorkerRegistration = registration;
        })
        .catch(error => {
            console.error('[ServiceWorker] Registration failed:', error);
        });
}

// --- Preview Rendering ---

function updatePreviewFiles() {
    return new Promise((resolve) => {
        try {
            // Wait for service worker to be ready
            const waitForServiceWorker = () => {
                if (serviceWorkerRegistration && serviceWorkerRegistration.active) {
                    // Get the file to preview
                    const previewFile = projectFiles[activePreviewFileId];
                    if (!previewFile) {
                        console.warn('[RenderPreview] Preview file not found:', activePreviewFileId);
                        resolve(false);
                        return;
                    }

                    // Generate preview content using handlers
                    const previewContent = generatePreviewContent(previewFile.name, previewFile.content, previewFile.type);
                    
                    // Update all files in the service worker (for CSS/JS dependencies)
                    Object.values(projectFiles).forEach(file => {
                        serviceWorkerRegistration.active.postMessage({
                            type: 'updateFile',
                            fileName: file.name,
                            content: file.content
                        });
                    });

                    // Update the preview content specifically
                    serviceWorkerRegistration.active.postMessage({
                        type: 'updateFile',
                        fileName: 'preview.html',
                        content: previewContent.content
                    });
                    
                    if (previewFrame) {
                        // Add a cache-busting parameter to ensure fresh content
                        const timestamp = Date.now();
                        const previewUrl = `./preview/preview.html?t=${timestamp}`;
                        
                        // Reload the preview iframe
                        previewFrame.src = previewUrl;
                        console.log(`[RenderPreview] Preview updated for file: ${previewFile.name}`);
                    }
                    resolve(true);
                } else {
                    // Retry after a short delay
                    setTimeout(waitForServiceWorker, 100);
                }
            };
            
            waitForServiceWorker();
        } catch (error) {
            console.error('[RenderPreview] Failed to update files in service worker:', error);
            resolve(false);
        }
    });
}

// --- Editor Component ---
class EditorComponent {
    constructor(container, state) {
        this.rootElement = container.element;
        this.rootElement.classList.add('editor-container');
        this.fileId = state.fileId;

        if (!this.fileId || !projectFiles[this.fileId]) {
            this.rootElement.innerHTML = `Error: File ID '${this.fileId}' not provided or invalid.`;
            console.error('[EditorComponent] Invalid fileId:', this.fileId, 'Available file IDs:', Object.keys(projectFiles));
            return;
        }

        const fileData = projectFiles[this.fileId];
        console.log('[EditorComponent] Initializing for fileId:', this.fileId, 'Name:', fileData.name);

        this.editor = ace.edit(this.rootElement);
        this.editor.setTheme("ace/theme/github");
        this.editor.session.setMode(`ace/mode/${fileData.type}`);
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

        this.editor.session.on('change', async () => {
            projectFiles[this.fileId].content = this.editor.getValue();
            console.log(`[EditorComponent] Content changed for ${fileData.name}, triggering preview render.`);
            await updatePreviewFiles();
        });

        this.editor.on('changeSelection', () => {
            const cursor = this.editor.getCursorPosition();
            projectFiles[this.fileId].cursor = { row: cursor.row, column: cursor.column };
            // console.log(`[EditorComponent] Cursor updated for ${fileData.name}:`, projectFiles[this.fileId].cursor);
        });

        container.on('resize', () => this.editor.resize());
        container.on('destroy', () => {
            console.log(`[EditorComponent] Destroying editor for ${fileData.name}`);
            this.editor.destroy();
        });
    }
}

// --- Preview Component ---
class PreviewComponent {
    constructor(container) {
        this.rootElement = container.element;
        this.rootElement.style.display = 'flex';
        this.rootElement.style.flexDirection = 'column';
        
        // Create preview controls
        const controlsDiv = document.createElement('div');
        controlsDiv.style.padding = '10px';
        controlsDiv.style.borderBottom = '1px solid #ccc';
        controlsDiv.style.background = '#f5f5f5';
        controlsDiv.style.display = 'flex';
        controlsDiv.style.alignItems = 'center';
        controlsDiv.style.gap = '10px';

        const label = document.createElement('label');
        label.textContent = 'Preview: ';
        label.style.fontWeight = 'bold';

        this.fileSelect = document.createElement('select');
        this.fileSelect.style.padding = '5px';
        this.fileSelect.style.border = '1px solid #ccc';
        this.fileSelect.style.borderRadius = '3px';
        
        this.updateFileOptions();
        
        this.fileSelect.onchange = () => {
            activePreviewFileId = this.fileSelect.value;
            console.log('[PreviewComponent] Preview file changed to:', activePreviewFileId);
            updatePreviewFiles();
        };

        controlsDiv.appendChild(label);
        controlsDiv.appendChild(this.fileSelect);
        this.rootElement.appendChild(controlsDiv);

        // Create iframe container
        const iframeContainer = document.createElement('div');
        iframeContainer.style.flex = '1';
        iframeContainer.style.position = 'relative';
        
        previewFrame = document.createElement('iframe');
        previewFrame.classList.add('preview-iframe');
        previewFrame.style.width = '100%';
        previewFrame.style.height = '100%';
        previewFrame.style.border = 'none';
        
        // Set initial src
        previewFrame.src = './preview/preview.html';
        
        iframeContainer.appendChild(previewFrame);
        this.rootElement.appendChild(iframeContainer);
        
        console.log('[PreviewComponent] Initializing with file selector.');
        previewComponentInstance = this;
        
        // Write files and reload after a short delay to ensure iframe is ready
        setTimeout(async () => {
            console.log('[PreviewComponent] Executing initial updatePreviewFiles.');
            await updatePreviewFiles();
        }, 200);
    }
    
    updateFileOptions() {
        this.fileSelect.innerHTML = '';
        Object.values(projectFiles).forEach(file => {
            const option = document.createElement('option');
            option.value = file.id;
            option.textContent = file.name;
            if (file.id === activePreviewFileId) {
                option.selected = true;
            }
            this.fileSelect.appendChild(option);
        });
    }
}

// --- Project Files Component ---
class ProjectFilesComponent {
    constructor(container) {
        this.rootElement = container.element;
        this.rootElement.style.padding = '10px';
        this.rootElement.style.overflowY = 'auto';
        this.rootElement.classList.add('project-files-container'); // For styling drag-over

        this.ul = document.createElement('ul');
        this.ul.style.listStyleType = 'none';
        this.ul.style.padding = '0';
        this.rootElement.appendChild(this.ul);

        // Add "New File" button
        const newFileButton = document.createElement('button');
        newFileButton.textContent = 'New File';
        newFileButton.style.margin = '10px 0';
        newFileButton.onclick = () => this.createNewFile();
        this.rootElement.insertBefore(newFileButton, this.ul);

        this.updateFileListDisplay(); // Initial display
        console.log('[ProjectFilesComponent] Initialized.');

        // Drag and Drop event listeners
        this.rootElement.addEventListener('dragover', this.handleDragOver.bind(this));
        this.rootElement.addEventListener('dragleave', this.handleDragLeave.bind(this));
        this.rootElement.addEventListener('drop', this.handleDrop.bind(this));
        
        projectFilesComponentInstance = this; // Make instance accessible
    }

    updateFileListDisplay() {
        this.ul.innerHTML = ''; // Clear existing list
        Object.values(projectFiles).forEach(file => {
            const li = document.createElement('li');
            li.style.padding = '5px 0';
            li.style.display = 'flex';
            li.style.alignItems = 'center';
            if (file.id === activeEditorFileId) {
                li.classList.add('active-file');
            }

            const nameSpan = document.createElement('span');
            nameSpan.textContent = file.name;
            nameSpan.style.cursor = 'pointer';
            nameSpan.style.flexGrow = '1'; // Allow span to take available space
            nameSpan.setAttribute('data-file-id', file.id);
            
            nameSpan.onclick = () => { // Click to open/focus editor
                console.log(`[ProjectFilesComponent] Clicked on file: ${file.name} (ID: ${file.id}) to open/focus.`);
                this.openOrFocusEditor(file.id);
            };
            nameSpan.ondblclick = () => { // Double click to rename
                console.log(`[ProjectFilesComponent] Double-clicked on file: ${file.name} (ID: ${file.id}) to rename.`);
                this.enterRenameMode(file.id, nameSpan, li);
            };
            li.appendChild(nameSpan);

            // Add Delete button
            const deleteButton = document.createElement('button');
            deleteButton.textContent = '❌'; // Or use an icon
            deleteButton.style.marginLeft = '10px';
            deleteButton.style.padding = '2px 5px';
            deleteButton.style.border = 'none';
            deleteButton.style.background = 'transparent';
            deleteButton.style.cursor = 'pointer';
            deleteButton.setAttribute('title', `Delete ${file.name}`);
            deleteButton.onclick = (e) => {
                e.stopPropagation(); // Prevent li click event
                this.deleteFile(file.id);
            };
            li.appendChild(deleteButton);

            this.ul.appendChild(li);
        });
        console.log('[ProjectFilesComponent] File list display updated. Active file ID:', activeEditorFileId);
    }

    createNewFile() {
        // Check if input already exists
        if (this.rootElement.querySelector('.new-file-input')) {
            return; // Prevent multiple inputs
        }

        const newFileButton = this.rootElement.querySelector('button');
        
        // Create input element
        const inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.className = 'new-file-input';
        inputElement.placeholder = 'Enter filename (e.g., new.js, style.css)';
        inputElement.style.width = 'calc(100% - 20px)';
        inputElement.style.margin = '5px 0';
        inputElement.style.padding = '5px';
        inputElement.style.border = '1px solid #ccc';
        inputElement.style.borderRadius = '3px';
        inputElement.style.fontFamily = 'sans-serif';

        const commit = () => {
            const fileName = inputElement.value.trim();
            if (!fileName) {
                cancel();
                return;
            }

            // Check if file with the same name already exists
            if (Object.values(projectFiles).some(f => f.name === fileName)) {
                inputElement.style.borderColor = 'red';
                inputElement.title = `File "${fileName}" already exists`;
                return;
            }

            const newFileId = generateUniqueId('file');
            const fileType = getFileTypeFromExtension(fileName);

            projectFiles[newFileId] = {
                id: newFileId,
                name: fileName,
                type: fileType,
                content: `// New file: ${fileName}\n`,
                cursor: { row: 0, column: 0 },
                selection: null
            };

            console.log(`[ProjectFilesComponent] New file "${fileName}" created with ID: ${newFileId}`);
            inputElement.remove();
            this.updateFileListDisplay();
            if (previewComponentInstance) {
                previewComponentInstance.updateFileOptions(); // Update preview file options
            }
            updatePreviewFiles();
            this.openOrFocusEditor(newFileId);
        };

        const cancel = () => {
            inputElement.remove();
            console.log('[ProjectFilesComponent] New file creation cancelled.');
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

        // Insert input after the New File button
        this.rootElement.insertBefore(inputElement, this.ul);
        inputElement.focus();
    }

    deleteFile(fileId) {
        const fileToDelete = projectFiles[fileId];
        if (!fileToDelete) {
            console.error(`[ProjectFilesComponent] File with ID ${fileId} not found for deletion.`);
            return;
        }

        if (!confirm(`Are you sure you want to delete "${fileToDelete.name}"?`)) {
            return;
        }

        console.log(`[ProjectFilesComponent] Deleting file: ${fileToDelete.name} (ID: ${fileId})`);
        delete projectFiles[fileId];

        // Close editor tab if open
        const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
        if (editorStack) {
            const openTab = editorStack.contentItems.find(item => {
                const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                return state && state.fileId === fileId;
            });
            if (openTab) {
                console.log(`[ProjectFilesComponent] Closing editor tab for deleted file: ${fileToDelete.name}`);
                openTab.close(); // GoldenLayout's method to close a tab
            }
        }
        
        if (activeEditorFileId === fileId) {
            activeEditorFileId = null; // Clear active file if it was the one deleted
        }

        this.updateFileListDisplay();
        if (previewComponentInstance) {
            previewComponentInstance.updateFileOptions(); // Update preview file options
        }
        // If the deleted file was being previewed, switch to the first available file
        if (activePreviewFileId === fileId) {
            const remainingFiles = Object.keys(projectFiles);
            if (remainingFiles.length > 0) {
                activePreviewFileId = remainingFiles[0];
                if (previewComponentInstance) {
                    previewComponentInstance.fileSelect.value = activePreviewFileId;
                }
            }
        }
        updatePreviewFiles(); // Update service worker
        console.log(`[ProjectFilesComponent] File "${fileToDelete.name}" deleted.`);
    }

    enterRenameMode(fileId, nameSpanElement, listItemElement) {
        const currentName = projectFiles[fileId].name;
        nameSpanElement.style.display = 'none'; // Hide the span

        const inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.value = currentName;
        inputElement.style.width = 'calc(100% - 10px)'; // Adjust width as needed
        inputElement.style.padding = '2px';
        inputElement.style.border = '1px solid #ccc';
        inputElement.style.fontFamily = 'sans-serif'; // Match font

        const commit = () => {
            this.commitRename(fileId, inputElement.value, nameSpanElement, inputElement);
        };

        const cancel = () => {
            nameSpanElement.style.display = ''; // Show the span again
            inputElement.remove();
            console.log('[ProjectFilesComponent] Rename cancelled.');
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

        // Insert input before the span (or replace, then re-add span on commit/cancel)
        listItemElement.insertBefore(inputElement, nameSpanElement);
        inputElement.focus();
        inputElement.select();
    }

    commitRename(fileId, newName, originalNameSpan, inputElement) {
        originalNameSpan.style.display = ''; // Show the span again
        inputElement.remove();

        const currentFile = projectFiles[fileId];
        if (!currentFile) {
            console.error(`[ProjectFilesComponent] File with ID ${fileId} not found for committing rename.`);
            return;
        }

        const trimmedNewName = newName.trim();
        if (trimmedNewName && trimmedNewName !== currentFile.name) {
            console.log(`[ProjectFilesComponent] Committing rename for file ${currentFile.name} to ${trimmedNewName}`);
            currentFile.name = trimmedNewName;
            const oldType = currentFile.type;
            currentFile.type = getFileTypeFromExtension(currentFile.name);

            this.updateFileListDisplay(); // Refresh the file list
            if (previewComponentInstance) {
                previewComponentInstance.updateFileOptions(); // Update preview file options after rename
            }

            const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
            if (editorStack) {
                const openTab = editorStack.contentItems.find(item => {
                    const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                    return state && state.fileId === fileId;
                });
                if (openTab) {
                    openTab.setTitle(currentFile.name);
                    console.log(`[ProjectFilesComponent] Tab title updated for fileId "${fileId}" to "${currentFile.name}".`);
                    
                    if (oldType !== currentFile.type) {
                        const editorComponent = openTab.container.componentReference; // componentReference should still point to our EditorComponent instance
                        if (editorComponent && editorComponent.editor) {
                            editorComponent.editor.session.setMode(`ace/mode/${currentFile.type}`);
                            console.log(`[ProjectFilesComponent] Editor mode updated for fileId "${fileId}" to ${currentFile.type}.`);
                        } else {
                             console.warn(`[ProjectFilesComponent] Could not directly access editor instance via componentReference to update mode for fileId "${fileId}".`);
                        }
                    }
                }
            }
            updatePreviewFiles();
        } else {
            console.log('[ProjectFilesComponent] Rename not committed (name unchanged or empty).');
            // No need to call updateFileListDisplay if name didn't change, originalNameSpan is already correct.
        }
    }
    
    // Removed old window.prompt based renameFile method

    handleDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        this.rootElement.classList.add('drag-over-active'); // Visual cue
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
            console.log(`[ProjectFilesComponent] Dropped ${files.length} file(s).`);
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
                    console.log(`[ProjectFilesComponent] File "${fileName}" read and added with ID: ${newFileId}`);
                    this.updateFileListDisplay();
                    if (previewComponentInstance) {
                        previewComponentInstance.updateFileOptions(); // Update preview file options
                    }
                    // Optionally open the first dropped file
                    if (Array.from(files).indexOf(file) === 0) {
                        this.openOrFocusEditor(newFileId);
                    }
                };
                reader.onerror = (err) => {
                    console.error(`[ProjectFilesComponent] Error reading file ${file.name}:`, err);
                };
                reader.readAsText(file);
            });
        }
    }

    openOrFocusEditor(fileId) {
        console.log('[ProjectFilesComponent] openOrFocusEditor called with fileId:', fileId);
        if (!goldenLayoutInstance) {
            console.error('[ProjectFilesComponent] goldenLayoutInstance is not available.');
            return;
        }

        // Attempt to find stack using getAllStacks() and filtering by ID
        const allStacks = goldenLayoutInstance.getAllStacks();
        if (!allStacks || allStacks.length === 0) {
            console.error('[ProjectFilesComponent] No stacks found using getAllStacks().');
            return;
        }

        const editorStack = allStacks.find(stack => stack.id === 'editorStack');
        
        if (!editorStack) {
            console.error('[ProjectFilesComponent] Editor stack with ID "editorStack" not found among all stacks.');
            console.log('[ProjectFilesComponent] Available stack IDs:', allStacks.map(s => s.id));
            return;
        }
        
        if (typeof editorStack.setActiveContentItem !== 'function') {
             console.error('[ProjectFilesComponent] Found item with ID "editorStack" is not a valid Stack object (missing setActiveContentItem).', editorStack);
             return;
        }
        console.log('[ProjectFilesComponent] Editor stack retrieved by getAllStacks() and filtering by ID:', editorStack.id);
        
        editorStack.contentItems.forEach((item, index) => {
            const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
            const stateFileId = state && state.fileId ? state.fileId : 'undefined';
            console.log(`[ProjectFilesComponent] Stack item ${index} - Title: ${item.title}, container.getState().fileId: ${stateFileId}, GL item.id: ${item.id || '<none>'}`);
        });

        const existingItem = editorStack.contentItems.find(item => {
            const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
            return state && state.fileId === fileId;
        });

        if (existingItem) {
            console.log(`[ProjectFilesComponent] Activating existing item for fileId "${fileId}", Title: ${existingItem.title}`);
            editorStack.setActiveContentItem(existingItem);
        } else {
            if (!projectFiles[fileId]) {
                console.error(`[ProjectFilesComponent] No file data found for fileId: "${fileId}"`);
                return;
            }
            const newTitle = projectFiles[fileId].name;
            const contentItemId = 'editor-' + fileId;
            console.log(`[ProjectFilesComponent] Adding new component for fileId: "${fileId}", title: "${newTitle}", contentItemId: "${contentItemId}"`);
            // Pass { fileId: fileId } as componentState. EditorComponent constructor will use this.
            // GoldenLayout should make this state retrievable via item.container.getState().
            editorStack.addComponent('editor', { fileId: fileId }, newTitle, contentItemId);
        }
    }
}

// --- GoldenLayout Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('[DOMContentLoaded] Initializing GoldenLayout.');
    const layoutContainer = document.getElementById('layoutContainer');
    if (!layoutContainer) {
        console.error('[DOMContentLoaded] Layout container #layoutContainer not found!');
        return;
    }

    goldenLayoutInstance = new GoldenLayout(layoutContainer);

    goldenLayoutInstance.registerComponentConstructor('editor', EditorComponent);
    goldenLayoutInstance.registerComponentConstructor('preview', PreviewComponent);
    goldenLayoutInstance.registerComponentConstructor('projectFiles', ProjectFilesComponent);

    const layoutConfig = {
        root: {
            type: 'row',
            content: [
                {
                    type: 'column',
                    width: 20, // Adjusted width
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
                    width: 80, // Adjusted width
                    content: [
                        {
                            type: 'stack',
                            id: 'editorStack',
                            content: [
                                {
                                    type: 'component',
                                    id: 'editor-' + projectFiles.htmlFile.id, // Assign an ID to the content item
                                    componentType: 'editor',
                                    title: projectFiles.htmlFile.name, // Initial tab title
                                    componentState: { fileId: projectFiles.htmlFile.id }
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

    goldenLayoutInstance.loadLayout(layoutConfig);
    console.log('[DOMContentLoaded] GoldenLayout loaded.');

    // Set initial active file ID
    if (projectFiles.htmlFile) { // Check if htmlFile exists
        activeEditorFileId = projectFiles.htmlFile.id;
        if (projectFilesComponentInstance) {
            projectFilesComponentInstance.updateFileListDisplay(); // Update highlight
        }
    }
    
    // Listen for active tab changes to update highlight
    const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
    if (editorStack) {
        const initialActiveItem = editorStack.getActiveContentItem();
        if (initialActiveItem) {
            const state = initialActiveItem.container && typeof initialActiveItem.container.getState === 'function' ? initialActiveItem.container.getState() : null;
            if (state && state.fileId) {
                activeEditorFileId = state.fileId;
                console.log('[DOMContentLoaded] Initial active file ID (from container.getState()):', activeEditorFileId);
            } else if (initialActiveItem.isComponent && initialActiveItem.componentState && initialActiveItem.componentState.fileId) {
                 // Fallback for initial item from layout config if getState() isn't populated yet (less likely but safe)
                activeEditorFileId = initialActiveItem.componentState.fileId;
                console.log('[DOMContentLoaded] Initial active file ID (from componentState directly):', activeEditorFileId);
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
                    console.log('[GoldenLayout] Active tab changed. New active file ID (from container.getState()):', activeEditorFileId);
                } else {
                    activeEditorFileId = null;
                    console.warn('[GoldenLayout] Active tab is an editor, but fileId is missing in container.getState().', activeContentItem);
                }
            } else {
                activeEditorFileId = null;
                if (activeContentItem && activeContentItem.isComponent && activeContentItem.componentType === 'editor') {
                     console.warn('[GoldenLayout] Active tab is an editor, but its container or getState is unavailable.', activeContentItem);
                } else {
                    console.log('[GoldenLayout] Active tab changed. Not an editor or container/getState unavailable.');
                }
            }
            if (projectFilesComponentInstance) {
                projectFilesComponentInstance.updateFileListDisplay();
            }
        });
    } else {
        console.warn('[DOMContentLoaded] Could not find editorStack to attach activeContentItemChanged listener.');
    }

    window.addEventListener('resize', () => {
        if (goldenLayoutInstance) {
            goldenLayoutInstance.updateSize();
        }
    });

    // Expose editor state globally for debugging
    const editorDebugInterface = {
        get projectFiles() { return projectFiles; },
        set projectFiles(newProjectFiles) {
            console.log('[Debug] Setting projectFiles. Old:', projectFiles, 'New:', newProjectFiles);
            projectFiles = newProjectFiles;
            if (projectFilesComponentInstance) {
                projectFilesComponentInstance.updateFileListDisplay();
            }
            updatePreviewFiles();
            console.log('[Debug] projectFiles set and UI updated (file list, preview).');
        },

        get goldenLayoutInstance() { return goldenLayoutInstance; },
        // No setter for goldenLayoutInstance as it's foundational

        get activeEditorFileId() { return activeEditorFileId; },
        set activeEditorFileId(newFileId) {
            console.log('[Debug] Setting activeEditorFileId to:', newFileId);
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
                    console.log('[Debug] Focused editor tab for:', newFileId);
                } else {
                    console.log('[Debug] No open editor tab found to focus for:', newFileId);
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
                console.log(`[Debug] Setting content for fileId: ${fileId}`);
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
                            console.log(`[Debug] Updated Ace editor content for fileId: ${fileId}`);
                        }
                    }
                }
                updatePreviewFiles();
            } else {
                console.warn(`[Debug] setProjectFileContent: fileId ${fileId} not found.`);
            }
        },

        getProjectFileContent(fileId) {
            return projectFiles[fileId] ? projectFiles[fileId].content : undefined;
        },

        refreshPreview() {
            console.log('[Debug] Manually refreshing preview.');
            updatePreviewFiles();
        },

        refreshProjectFilesList() {
            if (projectFilesComponentInstance) {
                console.log('[Debug] Manually refreshing project files list.');
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
                    console.log(`[Debug] Attempted to focus editor tab for fileId: ${fileId}`);
                    return true;
                }
            }
            console.warn(`[Debug] Could not focus editor tab for fileId: ${fileId} (not found or stack unavailable).`);
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
    console.log('[DOMContentLoaded] Editor state exposed globally as window.__$goldenviewerEditor with setters and helpers.');
});