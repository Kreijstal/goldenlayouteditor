// --- Client API ---
// Programmatic surface exposed at window.app. Wraps file, tab, workspace,
// and layout operations so external scripts (or the DevTools console) can
// drive the editor without reaching into internal state.
//
// See docs/client-api.md for the public contract.

function createClientApi(ctx) {
    const {
        wsClient,
        log,
    } = ctx;

    // --- Helpers ---

    function resolveFile(fileIdOrPath) {
        if (typeof fileIdOrPath !== 'string' || !fileIdOrPath) return null;
        const pf = ctx.projectFiles;
        if (pf[fileIdOrPath]) return pf[fileIdOrPath];
        return ctx.findFileByPath(fileIdOrPath) || null;
    }

    function fileInfo(f) {
        if (!f) return null;
        return {
            id: f.id,
            name: f.name,
            path: ctx.getRelativePath(f.id) || null,
            type: f.type,
            viewType: f.viewType || null,
            dirty: ctx.dirtyFiles.has(f.id),
        };
    }

    function walkLayout(item, cb) {
        if (!item) return;
        cb(item);
        if (item.contentItems) {
            for (const child of item.contentItems) walkLayout(child, cb);
        }
    }

    function matchesContentItemId(item, idOrTabId) {
        if (!item || !item.id) return false;
        if (Array.isArray(item.id)) return item.id.includes(idOrTabId);
        return item.id === idOrTabId;
    }

    function findTabItem(fileIdOrTabId) {
        const gl = ctx.goldenLayoutInstance;
        if (!gl || !gl.root) return null;
        let found = null;
        walkLayout(gl.root, (item) => {
            if (found || !item.isComponent) return;
            if (matchesContentItemId(item, fileIdOrTabId)) {
                found = item;
                return;
            }
            const state = item.container && typeof item.container.getState === 'function'
                ? item.container.getState() : null;
            if (state && state.fileId === fileIdOrTabId) found = item;
        });
        return found;
    }

    function tabInfo(item) {
        if (!item) return null;
        const state = item.container && typeof item.container.getState === 'function'
            ? item.container.getState() : null;
        let tabId = null;
        if (item.id) tabId = Array.isArray(item.id) ? item.id[0] : item.id;
        const active = !!(item.parent && typeof item.parent.getActiveContentItem === 'function'
            && item.parent.getActiveContentItem() === item);
        return {
            tabId,
            componentType: item.componentType,
            title: typeof item.title === 'string' ? item.title : (item.title && item.title.toString ? item.title.toString() : ''),
            fileId: (state && state.fileId) || null,
            stackId: (item.parent && item.parent.id) || null,
            active,
        };
    }

    function findDirNodeByPath(relPath) {
        if (!relPath || relPath === '/' || relPath === '.') return ctx.projectStructure;
        const parts = relPath.split('/').filter(Boolean);
        let node = ctx.projectStructure;
        for (const part of parts) {
            if (!node.children) return null;
            const next = node.children.find(c => c.type === 'directory' && c.name === part);
            if (!next) return null;
            node = next;
        }
        return node;
    }

    function findParentOfFile(fileId, node = ctx.projectStructure) {
        if (!node.children) return null;
        for (const child of node.children) {
            if (child.id === fileId) return node;
            if (child.type === 'directory') {
                const r = findParentOfFile(fileId, child);
                if (r) return r;
            }
        }
        return null;
    }

    function refreshUI() {
        if (ctx.projectFilesComponentInstance) {
            ctx.projectFilesComponentInstance.updateFileListDisplay();
        }
        if (ctx.previewComponentInstance && ctx.previewComponentInstance.updateFileOptions) {
            ctx.previewComponentInstance.updateFileOptions();
        }
    }

    // --- Files ---

    const files = {
        list() {
            return ctx.getAllFiles().map(fileInfo);
        },

        get(fileIdOrPath) {
            return fileInfo(resolveFile(fileIdOrPath));
        },

        getContent(fileIdOrPath) {
            const f = resolveFile(fileIdOrPath);
            return f ? (f.content || '') : null;
        },

        setContent(fileIdOrPath, content) {
            const f = resolveFile(fileIdOrPath);
            if (!f) return false;
            f.content = content;
            ctx.markDirty(f.id);

            const inst = ctx._editorInstances.get(f.id);
            if (inst && inst.editor && inst.editor.getValue() !== content) {
                const cursor = inst.editor.getCursorPosition();
                inst._suppressChangeEvents = true;
                try {
                    inst.editor.setValue(content, -1);
                    inst.editor.moveCursorTo(cursor.row, cursor.column);
                } finally {
                    inst._suppressChangeEvents = false;
                }
            }
            ctx.updatePreviewFiles();
            return true;
        },

        create(name, content = '', parentPath = null) {
            if (!name) return null;
            const parent = parentPath ? findDirNodeByPath(parentPath) : ctx.projectStructure;
            if (!parent) return null;

            // Guard against name collision in the same directory
            const siblings = parent.children || [];
            if (siblings.some(c => c.name === name)) return null;

            const id = ctx.generateUniqueId('file');
            const type = ctx.getFileTypeFromExtension(name);
            const fileObj = {
                id,
                name,
                type: 'file',
                fileType: type,
                content: content || '',
                cursor: { row: 0, column: 0 },
                selection: null,
            };
            parent.children = siblings;
            parent.children.push(fileObj);
            ctx.projectFiles[id] = fileObj;
            ctx.markDirty(id);
            refreshUI();
            return id;
        },

        async rename(fileIdOrPath, newName) {
            const f = resolveFile(fileIdOrPath);
            if (!f || !newName || newName === f.name) return false;

            const parent = findParentOfFile(f.id);
            if (parent && parent.children && parent.children.some(c => c !== f && c.name === newName)) {
                return false;
            }

            const oldRelPath = ctx.getRelativePath(f.id);

            if (ctx.currentWorkspacePath && oldRelPath && wsClient && wsClient.isConnected()) {
                const parts = oldRelPath.split('/');
                parts[parts.length - 1] = newName;
                const newRelPath = parts.join('/');
                try {
                    const result = await wsClient.wsRequest({
                        type: 'renameFile',
                        workspacePath: ctx.currentWorkspacePath,
                        oldRelativePath: oldRelPath,
                        newRelativePath: newRelPath,
                    });
                    if (!result || !result.success) {
                        log.warn('app.files.rename: server rejected rename:', result && result.error);
                        return false;
                    }
                } catch (err) {
                    log.warn('app.files.rename: server error:', err.message);
                    return false;
                }
            }

            f.name = newName;
            // Update any open tab title
            if (ctx.goldenLayoutInstance && ctx.goldenLayoutInstance.root) {
                walkLayout(ctx.goldenLayoutInstance.root, (item) => {
                    if (!item.isComponent) return;
                    const state = item.container && typeof item.container.getState === 'function'
                        ? item.container.getState() : null;
                    if (state && state.fileId === f.id && item.setTitle) {
                        const suffix = item.componentType === 'hexEditor' ? ' [hex]' : '';
                        item.setTitle(newName + suffix);
                    }
                });
            }
            refreshUI();
            return true;
        },

        delete(fileIdOrPath) {
            const f = resolveFile(fileIdOrPath);
            if (!f) return false;

            // Close any open tabs for this file
            if (ctx.goldenLayoutInstance && ctx.goldenLayoutInstance.root) {
                const toClose = [];
                walkLayout(ctx.goldenLayoutInstance.root, (item) => {
                    if (!item.isComponent) return;
                    const state = item.container && typeof item.container.getState === 'function'
                        ? item.container.getState() : null;
                    if (state && state.fileId === f.id) toClose.push(item);
                });
                for (const item of toClose) {
                    try { item.close(); } catch (_) { /* ignore */ }
                }
            }

            // Remove from tree
            const parent = findParentOfFile(f.id);
            if (parent && parent.children) {
                parent.children = parent.children.filter(c => c.id !== f.id);
            }
            delete ctx.projectFiles[f.id];
            ctx.dirtyFiles.delete(f.id);

            refreshUI();
            return true;
        },

        save(fileIdOrPath) {
            const f = resolveFile(fileIdOrPath);
            if (!f) return Promise.resolve(false);
            return ctx.saveFileToDisk(f.id);
        },

        saveAll() {
            return ctx.syncAllDirtyFiles();
        },

        async stat(fileIdOrPath) {
            const f = resolveFile(fileIdOrPath);
            if (!f) throw new Error('File not found');
            const relPath = ctx.getRelativePath(f.id);
            if (!ctx.currentWorkspacePath || !relPath || !wsClient || !wsClient.isConnected()) {
                throw new Error('Workspace WebSocket is required');
            }
            return wsClient.statFile(ctx.currentWorkspacePath, relPath);
        },

        async readRange(fileIdOrPath, offset, length) {
            const f = resolveFile(fileIdOrPath);
            if (!f) throw new Error('File not found');
            const relPath = ctx.getRelativePath(f.id);
            if (!ctx.currentWorkspacePath || !relPath || !wsClient || !wsClient.isConnected()) {
                throw new Error('Workspace WebSocket is required');
            }
            return wsClient.readFileRange(ctx.currentWorkspacePath, relPath, offset, length);
        },
    };

    // --- Tabs ---

    const tabs = {
        open(fileIdOrPath, opts = {}) {
            const f = resolveFile(fileIdOrPath);
            if (!f) return null;
            const mode = opts.mode || 'editor';
            if (mode === 'hex') {
                const item = ctx.openEditorTab(
                    'hexEditor',
                    { fileId: f.id },
                    `${f.name} [hex]`,
                    'hex-' + f.id
                );
                return tabInfo(item);
            }
            const item = ctx.openEditorTab(
                'editor',
                { fileId: f.id, filePath: ctx.getRelativePath(f.id) },
                f.name,
                'editor-' + f.id
            );
            return tabInfo(item);
        },

        close(fileIdOrTabId) {
            const item = findTabItem(fileIdOrTabId);
            if (!item) return false;
            try { item.close(); } catch (_) { return false; }
            return true;
        },

        focus(fileIdOrTabId) {
            const item = findTabItem(fileIdOrTabId);
            if (!item || !item.parent || typeof item.parent.setActiveContentItem !== 'function') return false;
            item.parent.setActiveContentItem(item);
            return true;
        },

        list() {
            const gl = ctx.goldenLayoutInstance;
            if (!gl || !gl.root) return [];
            const out = [];
            walkLayout(gl.root, (item) => {
                if (item.isComponent) out.push(tabInfo(item));
            });
            return out;
        },

        getActive() {
            const gl = ctx.goldenLayoutInstance;
            if (!gl || !gl.root) return null;
            const stacks = gl.getAllStacks ? gl.getAllStacks() : [];
            for (const s of stacks) {
                if (typeof s.getActiveContentItem !== 'function') continue;
                const active = s.getActiveContentItem();
                if (active && active.isComponent) return tabInfo(active);
            }
            return null;
        },

        move(fileIdOrTabId, target = {}) {
            const item = findTabItem(fileIdOrTabId);
            if (!item || !item.parent) return false;
            const gl = ctx.goldenLayoutInstance;
            if (!gl) return false;

            let destStack = null;
            if (target.stackId) {
                destStack = (gl.getAllStacks() || []).find(s => s.id === target.stackId) || null;
            }
            if (!destStack) destStack = ctx.findOrCreateEditorStack();
            if (!destStack) return false;

            const componentType = item.componentType;
            const state = (item.container && typeof item.container.getState === 'function')
                ? item.container.getState() : {};
            const title = typeof item.title === 'string' ? item.title : '';
            const contentItemId = Array.isArray(item.id) ? item.id[0] : item.id;

            if (item.parent === destStack && typeof target.index !== 'number') {
                return true; // already there, no index specified
            }

            try {
                item.close();
            } catch (_) { return false; }

            destStack.addComponent(componentType, state, title, contentItemId);

            if (typeof target.index === 'number' && destStack.contentItems.length > 1) {
                // GL v2 has no direct reorder API. The item was added at the end — best-effort
                // reorder by removing and re-adding at the requested index is unreliable, so
                // we leave placement to the end and expose the limitation in the docs.
            }
            return true;
        },

        maximize(fileIdOrTabId) {
            let stack = null;
            if (fileIdOrTabId) {
                const item = findTabItem(fileIdOrTabId);
                stack = item && item.parent ? item.parent : null;
            } else {
                stack = tabs._activeStack();
            }
            if (!stack || typeof stack.toggleMaximise !== 'function') return false;
            if (!stack.isMaximised) stack.toggleMaximise();
            return true;
        },

        unmaximize() {
            const gl = ctx.goldenLayoutInstance;
            if (!gl) return false;
            const stacks = gl.getAllStacks() || [];
            for (const s of stacks) {
                if (s.isMaximised && typeof s.toggleMaximise === 'function') {
                    s.toggleMaximise();
                    return true;
                }
            }
            return false;
        },

        _activeStack() {
            const gl = ctx.goldenLayoutInstance;
            if (!gl) return null;
            const stacks = gl.getAllStacks() || [];
            for (const s of stacks) {
                if (s.getActiveContentItem && s.getActiveContentItem()) return s;
            }
            return stacks[0] || null;
        },
    };

    // --- Workspace ---

    const workspace = {
        get path() { return ctx.currentWorkspacePath; },

        async open(path) {
            if (!path) throw new Error('workspace.open: path required');
            if (!wsClient || !wsClient.isConnected()) throw new Error('workspace.open: not connected');
            const result = await wsClient.wsRequest({ type: 'openWorkspace', path });
            if (result.error) throw new Error(result.error);
            ctx.handleWorkspaceLoaded(result);
            return true;
        },
    };

    // --- Layout ---

    const layout = {
        save() {
            return ctx.goldenLayoutInstance ? ctx.goldenLayoutInstance.saveLayout() : null;
        },

        load(config) {
            if (!ctx.goldenLayoutInstance || !config) return false;
            ctx.goldenLayoutInstance.loadLayout(config);
            return true;
        },

        reset() {
            if (!ctx.goldenLayoutInstance) return false;
            ctx.goldenLayoutInstance.loadLayout(ctx.getDefaultLayoutConfig());
            return true;
        },

        stacks() {
            const gl = ctx.goldenLayoutInstance;
            if (!gl || !gl.getAllStacks) return [];
            return gl.getAllStacks().map(s => ({
                id: s.id || null,
                itemCount: s.contentItems ? s.contentItems.length : 0,
                maximized: !!s.isMaximised,
            }));
        },

        addPanel(componentType, state = {}, title = null, contentItemId = null) {
            if (!ctx.goldenLayoutInstance) return null;
            const id = contentItemId || (componentType + '-' + Date.now());
            const item = ctx.openEditorTab(componentType, state, title || componentType, id);
            return tabInfo(item);
        },
    };

    return {
        version: '1.0',
        files,
        tabs,
        workspace,
        layout,
    };
}

module.exports = { createClientApi };
