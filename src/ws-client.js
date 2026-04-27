// --- WebSocket Client (optional, for server-enhanced mode) ---
const { createLogger, setWsSender, setEnabled } = require('./debug');
const { renderTree } = require('./tree-renderer');
const logger = createLogger('WS');
const log = logger.log.bind(logger);
const warn = logger.warn.bind(logger);

let ws = null;
let wsReady = null;

function connectWebSocket(url) {
    return new Promise((resolve) => {
        try {
            log('Connecting to', url);
            const socket = new WebSocket(url);
            socket.onopen = () => {
                ws = socket;
                // Wire up WS forwarding for all debug loggers
                setWsSender((msg) => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(msg));
                    }
                });
                log('Connected');
                resolve(socket);
            };
            socket.onclose = (e) => {
                log('Disconnected', e.code, e.reason);
                ws = null;
            };
            socket.onerror = (e) => {
                warn('Connection error', e);
                resolve(null);
            };
        } catch (e) {
            warn('Failed to create WebSocket', e);
            resolve(null);
        }
    });
}

// Auto-detect WS endpoint from URL params or try same-origin
(function initWebSocket() {
    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get('ws');
    let wsUrl;

    if (wsParam) {
        wsUrl = wsParam;
    } else {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${proto}//${window.location.host}/ws`;
    }

    wsReady = connectWebSocket(wsUrl);
})();

// --- Request/response handling ---
let _wsMsgId = 0;
const _wsPendingCallbacks = {};

function wsRequest(msg) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket not connected'));
            return;
        }
        const id = ++_wsMsgId;
        msg.id = id;
        log('Sending', msg.type, 'id=' + id);
        _wsPendingCallbacks[id] = resolve;
        ws.send(JSON.stringify(msg));
    });
}

// Generic message listeners (for terminal, etc.)
const _messageListeners = new Set();

function addMessageListener(fn) { _messageListeners.add(fn); }
function removeMessageListener(fn) { _messageListeners.delete(fn); }

function wsRawSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function base64ToUint8Array(value) {
    const binary = atob(value || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function readFileRange(workspacePath, relativePath, offset, length) {
    const result = await wsRequest({
        type: 'readFileRange',
        workspacePath,
        relativePath,
        offset,
        length,
    });
    if (!result || !result.success) {
        throw new Error((result && result.error) || 'Range read failed');
    }
    return {
        relativePath: result.relativePath,
        offset: result.offset,
        requestedLength: result.requestedLength,
        length: result.length,
        size: result.size,
        mtimeMs: result.mtimeMs,
        eof: !!result.eof,
        bytes: base64ToUint8Array(result.content),
    };
}

async function statFile(workspacePath, relativePath) {
    const result = await wsRequest({
        type: 'statFile',
        workspacePath,
        relativePath,
    });
    if (!result || !result.success) {
        throw new Error((result && result.error) || 'File stat failed');
    }
    return {
        relativePath: result.relativePath,
        isFile: !!result.isFile,
        isDirectory: !!result.isDirectory,
        size: result.size,
        mtimeMs: result.mtimeMs,
    };
}

function _setupWsResponseHandler(socket) {
    socket.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'serverConfig') {
                if (msg.debug) setEnabled(true);
                log('Server config received, debug:', msg.debug);
                return;
            }
            // Don't log noisy terminal data
            if (msg.type !== 'termData') {
                log('Received', msg.type || '(no type)', 'id=' + (msg.id || 'none'));
            }
            if (msg.id && _wsPendingCallbacks[msg.id]) {
                _wsPendingCallbacks[msg.id](msg);
                delete _wsPendingCallbacks[msg.id];
            }
            // Notify generic listeners
            for (const fn of _messageListeners) {
                try { fn(msg); } catch (_) {}
            }
        } catch (e) { /* ignore non-JSON */ }
    });
}

wsReady.then(socket => { if (socket) _setupWsResponseHandler(socket); });

// --- Workspace history (localStorage) ---

const STORAGE_KEY = 'ws-workspaces';

function _loadWorkspaceHistory() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { recent: [], favorites: [] };
    } catch (_) {
        return { recent: [], favorites: [] };
    }
}

function _saveWorkspaceHistory(history) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

function addRecentWorkspace(dirPath) {
    const history = _loadWorkspaceHistory();
    history.recent = history.recent.filter(p => p !== dirPath);
    history.recent.unshift(dirPath);
    if (history.recent.length > 20) history.recent.pop();
    _saveWorkspaceHistory(history);
}

function toggleFavorite(dirPath) {
    const history = _loadWorkspaceHistory();
    const idx = history.favorites.indexOf(dirPath);
    if (idx >= 0) {
        history.favorites.splice(idx, 1);
    } else {
        history.favorites.push(dirPath);
    }
    _saveWorkspaceHistory(history);
    return idx < 0; // returns true if now a favorite
}

// --- Workspace selector UI ---

function showWorkspaceSelector(onOpen) {
    const existing = document.getElementById('ws-dir-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ws-dir-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;border-radius:8px;width:500px;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,0.3);';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #ddd;display:flex;align-items:center;gap:8px;';

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.style.cssText = 'flex:1;padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-family:monospace;font-size:13px;';

    const goBtn = document.createElement('button');
    goBtn.textContent = 'Go';
    goBtn.style.cssText = 'padding:6px 12px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#f0f0f0;';

    header.appendChild(pathInput);
    header.appendChild(goBtn);
    modal.appendChild(header);

    // File list
    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:8px 0;';
    modal.appendChild(listContainer);

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:12px 16px;border-top:1px solid #ddd;display:flex;justify-content:flex-end;gap:8px;';

    const favBtn = document.createElement('button');
    favBtn.textContent = '\u2606 Favorite';
    favBtn.style.cssText = 'padding:6px 12px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#fff;margin-right:auto;';

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open This Directory';
    openBtn.style.cssText = 'padding:6px 16px;border:none;border-radius:4px;cursor:pointer;background:#0066cc;color:#fff;font-weight:bold;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#fff;';

    footer.appendChild(favBtn);
    footer.appendChild(cancelBtn);
    footer.appendChild(openBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let currentDir = '';
    let browsing = false; // false = showing history, true = browsing dirs

    function updateFavBtn() {
        const history = _loadWorkspaceHistory();
        const isFav = history.favorites.includes(currentDir);
        favBtn.textContent = (isFav ? '\u2605' : '\u2606') + ' Favorite';
        favBtn.style.display = browsing ? '' : 'none';
    }

    function showHistory() {
        browsing = false;
        pathInput.value = '';
        listContainer.innerHTML = '';
        updateFavBtn();

        const history = _loadWorkspaceHistory();

        if (history.favorites.length > 0) {
            const favHeader = document.createElement('div');
            favHeader.textContent = 'Favorites';
            favHeader.style.cssText = 'padding:6px 16px;font-size:12px;font-weight:bold;color:#999;text-transform:uppercase;';
            listContainer.appendChild(favHeader);

            history.favorites.forEach(p => {
                listContainer.appendChild(_makeHistoryRow(p, true));
            });
        }

        if (history.recent.length > 0) {
            const recHeader = document.createElement('div');
            recHeader.textContent = 'Recent';
            recHeader.style.cssText = 'padding:6px 16px;font-size:12px;font-weight:bold;color:#999;text-transform:uppercase;margin-top:8px;';
            listContainer.appendChild(recHeader);

            history.recent.forEach(p => {
                listContainer.appendChild(_makeHistoryRow(p, false));
            });
        }

        if (history.favorites.length === 0 && history.recent.length === 0) {
            listContainer.innerHTML = '<div style="padding:16px;color:#999;text-align:center;">No recent workspaces. Browse to a directory above.</div>';
        }
    }

    function _makeHistoryRow(dirPath, isFav) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 16px;cursor:pointer;font-family:monospace;font-size:13px;display:flex;align-items:center;gap:8px;';
        row.onmouseenter = () => row.style.background = '#f0f0f0';
        row.onmouseleave = () => row.style.background = '';

        const star = document.createElement('span');
        star.textContent = isFav ? '\u2605' : '';
        star.style.cssText = 'width:14px;color:#e8a317;font-size:14px;';

        const pathSpan = document.createElement('span');
        pathSpan.textContent = dirPath;
        pathSpan.style.flex = '1';

        const removeBtn = document.createElement('span');
        removeBtn.textContent = '\u00D7';
        removeBtn.style.cssText = 'color:#999;font-size:16px;padding:0 4px;';
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            const history = _loadWorkspaceHistory();
            if (isFav) {
                history.favorites = history.favorites.filter(p => p !== dirPath);
            } else {
                history.recent = history.recent.filter(p => p !== dirPath);
            }
            _saveWorkspaceHistory(history);
            showHistory();
        };

        row.onclick = () => navigateTo(dirPath);

        row.appendChild(star);
        row.appendChild(pathSpan);
        row.appendChild(removeBtn);
        return row;
    }

    async function loadDirItems(dirPath) {
        const result = await wsRequest({ type: 'listDir', path: dirPath });
        if (result.error) return [];
        // Convert listDir items to tree-renderer format (dirs only, files as count)
        const dirs = result.items.filter(i => i.isDirectory).map(i => ({
            name: i.name,
            type: 'directory',
            collapsed: true,
            children: [], // lazy-loaded
            _fullPath: result.path + '/' + i.name,
        }));
        const fileCount = result.items.filter(i => !i.isDirectory).length;
        return { dirs, fileCount, resolvedPath: result.path };
    }

    function renderDirLevel(parentUl, items, fileCount, depth) {
        renderTree({
            items,
            container: parentUl,
            depth,
            darkMode: false,
            onToggleDir: (item, expanded, childUl) => {
                if (expanded && !item._loaded) {
                    item._loaded = true;
                    childUl.innerHTML = '<li style="list-style:none;padding:4px 16px;color:#999;font-size:12px;">Loading...</li>';
                    loadDirItems(item._fullPath).then(result => {
                        childUl.innerHTML = '';
                        if (result.dirs) {
                            renderDirLevel(childUl, result.dirs, result.fileCount, depth + 1);
                        }
                    });
                }
            },
            onClickDir: (item, li) => {
                currentDir = item._fullPath;
                pathInput.value = item._fullPath;
                updateFavBtn();
                // Highlight
                listContainer.querySelectorAll('.selected-dir').forEach(el => {
                    el.classList.remove('selected-dir');
                    el.style.background = '';
                });
                li.classList.add('selected-dir');
                li.style.background = '#e0e7ff';
            },
        });
        // Show file count hint
        if (fileCount > 0) {
            const hint = document.createElement('li');
            hint.style.cssText = `list-style:none;padding:2px 4px;padding-left:${depth * 16 + 32}px;color:#999;font-size:11px;font-family:monospace;`;
            hint.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
            parentUl.appendChild(hint);
        }
    }

    async function navigateTo(dirPath) {
        browsing = true;
        listContainer.innerHTML = '<div style="padding:16px;color:#999;">Loading...</div>';
        try {
            const data = await loadDirItems(dirPath);
            if (!data.resolvedPath) {
                listContainer.innerHTML = '<div style="padding:16px;color:red;">Failed to load directory</div>';
                return;
            }
            currentDir = data.resolvedPath;
            pathInput.value = data.resolvedPath;
            updateFavBtn();

            listContainer.innerHTML = '';

            // Parent directory entry
            const parentItem = document.createElement('div');
            parentItem.textContent = '\u2190 ..';
            parentItem.style.cssText = 'padding:6px 16px;cursor:pointer;font-family:monospace;font-size:13px;color:#666;';
            parentItem.onmouseenter = () => parentItem.style.background = '#f0f0f0';
            parentItem.onmouseleave = () => parentItem.style.background = '';
            parentItem.onclick = () => navigateTo(currentDir + '/..');
            listContainer.appendChild(parentItem);

            // Render as expandable tree
            const treeUl = document.createElement('ul');
            treeUl.style.cssText = 'list-style:none;padding:0;margin:0;';
            listContainer.appendChild(treeUl);
            renderDirLevel(treeUl, data.dirs, data.fileCount, 0);
        } catch (err) {
            listContainer.innerHTML = `<div style="padding:16px;color:red;">${err.message}</div>`;
        }
    }

    goBtn.onclick = () => {
        const val = pathInput.value.trim();
        if (val) navigateTo(val);
        else showHistory();
    };
    pathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = pathInput.value.trim();
            if (val) navigateTo(val);
            else showHistory();
        }
    });
    cancelBtn.onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    favBtn.onclick = () => {
        if (currentDir) {
            toggleFavorite(currentDir);
            updateFavBtn();
        }
    };
    openBtn.onclick = async () => {
        if (!browsing || !currentDir) return;
        log('Opening workspace:', currentDir);
        openBtn.disabled = true;
        openBtn.textContent = 'Loading...';
        try {
            const result = await wsRequest({ type: 'openWorkspace', path: currentDir });
            log('Workspace loaded:', result.path, result.children ? result.children.length + ' entries' : 'error: ' + result.error);
            addRecentWorkspace(currentDir);
            overlay.remove();
            onOpen(result);
        } catch (err) {
            warn('openWorkspace failed:', err);
            openBtn.disabled = false;
            openBtn.textContent = 'Open This Directory';
            listContainer.innerHTML = `<div style="padding:16px;color:red;">Failed: ${err.message}</div>`;
        }
    };

    // Start with history view
    showHistory();
}

// --- Send preview files via WS ---

async function sendPreviewFiles(files) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    log('Sending preview files:', Object.keys(files).length, 'files');
    await wsRequest({ type: 'updateFiles', files });
    return true;
}

function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
}

module.exports = {
    get wsReady() { return wsReady; },
    wsRequest,
    wsRawSend,
    readFileRange,
    statFile,
    showWorkspaceSelector,
    sendPreviewFiles,
    isConnected,
    addMessageListener,
    removeMessageListener,
};
