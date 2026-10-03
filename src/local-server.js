// --- The server, played by the page (no server: GitHub Pages) ---
// When the WebSocket to the server can't be opened, ws-client.js talks to a
// LocalSocket instead: it answers the same messages ws-handler.js does, from
// the folders public/local-fs.js mounts (picked folders and the browser's
// private storage). Viewers fetch file bytes from /workspace-file as usual;
// the service worker (or the page's fetch(), see install()) answers those.
// What needs a real machine (the terminal, the file watcher) is not there.

const LocalFS = require('../public/local-fs.js');

// Extensions with a dedicated viewer, never read as text (mirrors SERVED_EXTENSIONS in ws-handler.js)
const SERVED_EXTENSIONS = new Set(('pdf vsd vsdx swf epub psd xlsx xlsm xlsb xls ods sqlite sqlite3 db glb gltf stl obj gcode gco blend fzz fst ghw wasm fla xfl '
    + 'png apng jxl jpg jpeg gif bmp ico webp avif svg tvg mp4 m4v mov mkv webm avi wmv mpg mpeg m2ts 3gp mp3 m4a aac flac wav ogg opus').split(' '));
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_RANGE_READ_SIZE = 8 * 1024 * 1024;
// "New from template" lists the files in here
const TEMPLATES_DIR = '/' + LocalFS.OPFS_NAME + '/Templates';

function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function workspaceFile(msg, rel) {
    if (!msg.workspacePath || !rel) throw new Error('Missing required fields');
    const root = LocalFS.normalize(msg.workspacePath);
    const p = LocalFS.join(root, rel);
    if (p !== root && !p.startsWith(root + '/')) throw new Error('Path traversal blocked');
    return p;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const dirsFirst = (a, b) => (a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : byName(a, b));

// Apply op to each path; per-path errors, as runPathOp in ws-handler.js
async function pathOp(msg, paths, op) {
    const errors = [];
    for (const p of paths || []) {
        const abs = LocalFS.normalize(p);
        try {
            await op(abs);
        } catch (err) {
            errors.push({ path: abs, error: err.message });
        }
    }
    return { type: msg.type + 'Result', success: errors.length === 0, errors };
}

const handlers = {
    clientLog() {},
    clientAction() {},
    clientEval() {},
    clientActionResult() {},
    clientEvalResult() {},
    termInput() {},
    termResize() {},

    termSpawn(msg) {
        return { type: 'termSpawned', sessionId: msg.sessionId, error: 'The terminal needs the server' };
    },
    termKill(msg) {
        return { type: 'termKilled', sessionId: msg.sessionId };
    },

    // Preview files: the service worker serves them (ws-client.js never sends these here)
    updateFiles() {
        return { type: 'filesUpdated' };
    },

    async listDir(msg) {
        const dirPath = LocalFS.normalize(msg.path || '/');
        try {
            const items = (await LocalFS.list(dirPath))
                .filter(e => !e.name.startsWith('.'))
                .map(e => ({ name: e.name, isDirectory: e.kind === 'directory' }))
                .sort((a, b) => (a.isDirectory !== b.isDirectory ? b.isDirectory - a.isDirectory : a.name.localeCompare(b.name)));
            return { type: 'dirListing', path: dirPath, items };
        } catch (err) {
            return { type: 'dirListing', path: dirPath, items: [], error: err.message };
        }
    },

    async browseDir(msg) {
        const dirPath = LocalFS.normalize(msg.path || '/');
        const reply = { type: 'browseListing', path: dirPath, parent: LocalFS.dirname(dirPath) };
        try {
            const entries = (await LocalFS.list(dirPath)).filter(e => msg.showHidden || !e.name.startsWith('.'));
            reply.items = (await Promise.all(entries.map(async (e) => {
                const item = { name: e.name, type: e.kind, size: 0, mtimeMs: 0 };
                if (e.mount) item.mount = e.mount.opfs ? 'storage' : 'folder';
                if (e.kind === 'directory') return item;
                const f = await e.handle.getFile();
                item.size = f.size;
                item.mtimeMs = f.lastModified;
                const ext = extOf(e.name);
                if (SERVED_EXTENSIONS.has(ext)) item.viewType = ext;
                else if (f.size > MAX_FILE_SIZE) item.viewType = 'binary';
                else item.lazy = true;
                return item;
            }))).sort(dirsFirst);
        } catch (err) {
            reply.items = [];
            reply.error = err.message;
        }
        return reply;
    },

    async openWorkspace(msg) {
        const dirPath = LocalFS.normalize(msg.path);
        async function readDir(dir) {
            const children = [];
            for (const e of await LocalFS.list(dir)) {
                if (e.name.startsWith('.')) continue;
                if (e.kind === 'directory') {
                    children.push({ name: e.name, type: 'directory', children: await readDir(LocalFS.join(dir, e.name)) });
                    continue;
                }
                const ext = extOf(e.name);
                if (SERVED_EXTENSIONS.has(ext)) {
                    children.push({ name: e.name, type: 'file', viewType: ext, content: null });
                    continue;
                }
                const f = await e.handle.getFile();
                if (f.size > MAX_FILE_SIZE) children.push({ name: e.name, type: 'file', viewType: 'binary', content: null, size: f.size });
                else children.push({ name: e.name, type: 'file', content: await f.text() });
            }
            return children.sort((a, b) => (a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name)));
        }
        try {
            if (dirPath === '/') throw new Error('Open a folder, not the top level');
            return { type: 'workspaceLoaded', path: dirPath, children: await readDir(dirPath) };
        } catch (err) {
            return { type: 'workspaceLoaded', path: dirPath, children: [], error: err.message };
        }
    },

    async readFile(msg) {
        try {
            const f = await LocalFS.file(workspaceFile(msg, msg.relativePath));
            return { type: 'fileContent', success: true, content: await f.text(), relativePath: msg.relativePath };
        } catch (err) {
            return { type: 'fileContent', success: false, error: err.message };
        }
    },

    async readFileRange(msg) {
        try {
            const offset = Number(msg.offset || 0);
            const requestedLength = Number(msg.length || 0);
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
            if (!Number.isSafeInteger(requestedLength) || requestedLength <= 0) throw new Error('Invalid length');
            if (requestedLength > MAX_RANGE_READ_SIZE) throw new Error(`Range too large; maximum is ${MAX_RANGE_READ_SIZE} bytes`);
            const f = await LocalFS.file(workspaceFile(msg, msg.relativePath));
            const bytes = new Uint8Array(await f.slice(offset, offset + requestedLength).arrayBuffer());
            return {
                type: 'fileRange', success: true, relativePath: msg.relativePath, offset, requestedLength,
                length: bytes.length, size: f.size, mtimeMs: f.lastModified, eof: offset + bytes.length >= f.size,
                encoding: 'base64', content: bytesToBase64(bytes),
            };
        } catch (err) {
            return { type: 'fileRange', success: false, error: err.message };
        }
    },

    async statFile(msg) {
        try {
            const s = await LocalFS.stat(workspaceFile(msg, msg.relativePath));
            return { type: 'fileStat', success: true, relativePath: msg.relativePath, ...s };
        } catch (err) {
            return { type: 'fileStat', success: false, error: err.message };
        }
    },

    async saveFile(msg) {
        const relativePath = msg.relativePath || msg.fileName;
        try {
            if (msg.content === undefined) throw new Error('Missing required fields');
            const data = msg.encoding === 'base64' ? base64ToBytes(msg.content) : msg.content;
            await LocalFS.writeFile(workspaceFile(msg, relativePath), data, { parents: true });
            return { type: 'fileSaved', success: true, relativePath };
        } catch (err) {
            return { type: 'fileSaved', success: false, error: err.message };
        }
    },

    async renameFile(msg) {
        try {
            const from = workspaceFile(msg, msg.oldRelativePath);
            const to = workspaceFile(msg, msg.newRelativePath);
            if (await LocalFS.exists(to)) throw new Error('Destination exists');
            await LocalFS.mkdir(LocalFS.dirname(to), { recursive: true });
            await LocalFS.move(from, to);
            return { type: 'fileRenamed', success: true, oldRelativePath: msg.oldRelativePath, newRelativePath: msg.newRelativePath };
        } catch (err) {
            return { type: 'fileRenamed', success: false, error: err.message };
        }
    },

    async refreshFile(msg) {
        try {
            const p = workspaceFile(msg, msg.relativePath);
            if (SERVED_EXTENSIONS.has(extOf(p))) return { type: 'fileRefreshed', success: true, relativePath: msg.relativePath, content: null, servedViaHttp: true };
            const f = await LocalFS.file(p);
            if (f.size > MAX_FILE_SIZE) throw new Error('File too large');
            return { type: 'fileRefreshed', success: true, relativePath: msg.relativePath, content: await f.text() };
        } catch (err) {
            return { type: 'fileRefreshed', success: false, error: err.message };
        }
    },

    refreshWatch() {
        return { type: 'watchRefreshed', success: false, error: 'No file watching without the server' };
    },

    getThumbnail() {
        return { type: 'thumbnail', success: false };
    },

    async mkdir(msg) {
        try {
            if (!msg.path) throw new Error('Missing path');
            await LocalFS.mkdir(msg.path, { recursive: true });
            return { type: 'mkdirResult', success: true, path: LocalFS.normalize(msg.path) };
        } catch (err) {
            return { type: 'mkdirResult', success: false, error: err.message };
        }
    },

    // --- File browser actions ---

    // No Trash here: files are deleted. A mounted folder itself is only forgotten
    trashPaths(msg) {
        return pathOp(msg, msg.paths, async (p) => {
            if (LocalFS.isMountRoot(p)) {
                const name = LocalFS.basename(p);
                if (name === LocalFS.OPFS_NAME) throw new Error('Browser storage is always there');
                await LocalFS.removeMount(name);
                return;
            }
            await LocalFS.remove(p);
        });
    },

    copyPaths(msg) {
        return pathOp(msg, msg.paths, async (src) => {
            await LocalFS.copy(src, await LocalFS.freeName(LocalFS.normalize(msg.dest), LocalFS.basename(src)));
        });
    },

    movePaths(msg) {
        return pathOp(msg, msg.paths, async (src) => {
            const destDir = LocalFS.normalize(msg.dest);
            if (destDir === src || destDir.startsWith(src + '/')) throw new Error('Cannot move a folder into itself');
            if (LocalFS.dirname(src) === destDir) return;
            await LocalFS.move(src, await LocalFS.freeName(destDir, LocalFS.basename(src)));
        });
    },

    renamePath(msg) {
        return pathOp(msg, [msg.path], async (src) => {
            const name = String(msg.name || '');
            if (!name || name.includes('/') || name === '.' || name === '..') throw new Error('Invalid name');
            const dest = LocalFS.join(LocalFS.dirname(src), name);
            if (await LocalFS.exists(dest)) throw new Error(`${name} already exists`);
            await LocalFS.move(src, dest);
        });
    },

    createFile(msg) {
        return pathOp(msg, [msg.path], async (dest) => {
            let data;
            if (msg.template) data = await LocalFS.file(LocalFS.join(TEMPLATES_DIR, LocalFS.basename(String(msg.template))));
            else data = msg.encoding === 'base64' ? base64ToBytes(msg.content) : String(msg.content || '');
            await LocalFS.writeFile(dest, data, { exclusive: true });
        });
    },

    async listTemplates() {
        let items = [];
        try {
            items = (await LocalFS.list(TEMPLATES_DIR)).filter(e => e.kind === 'file' && !e.name.startsWith('.')).map(e => e.name)
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        } catch (_) { /* no templates folder */ }
        return { type: 'templates', dir: TEMPLATES_DIR, items };
    },

    makeDir(msg) {
        return pathOp(msg, [msg.path], p => LocalFS.mkdir(p, { exclusive: true }));
    },
};

// Stands in for the WebSocket: send() a message, get the reply as a 'message' event
class LocalSocket {
    constructor() {
        this.readyState = 1; // WebSocket.OPEN
        this.local = true;
        this._listeners = new Set();
    }

    addEventListener(type, fn) {
        if (type === 'message') this._listeners.add(fn);
    }

    removeEventListener(type, fn) {
        this._listeners.delete(fn);
    }

    send(data) {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        const handler = handlers[msg.type];
        Promise.resolve()
            .then(() => (handler ? handler(msg) : { type: 'error', error: `${msg.type} needs the server` }))
            .catch(err => ({ type: 'error', error: err.message }))
            .then((reply) => {
                if (!reply || !msg.id) return;
                reply.id = msg.id;
                const event = { data: JSON.stringify(reply) };
                for (const fn of this._listeners) fn(event);
            });
    }

    close() {}
}

let installed = false;

// Switches this page (and the service worker) to answering from local folders;
// the LocalSocket, or null where the browser has no file system to offer
async function start() {
    if (!LocalFS.supported()) return null;
    if (!installed) {
        installed = true;
        LocalFS.active = true;
        await LocalFS.setEnabled(true).catch(() => {});
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'localFsChanged' });
        }
        // The page's own fetch() answers too, so nothing waits for the service worker
        const net = window.fetch.bind(window);
        window.fetch = (input, init) => LocalFS.localFetch(input, init, net);
    }
    return new LocalSocket();
}

// With a server: make sure the service worker no longer answers for it
function stop() {
    LocalFS.setEnabled(false).then(() => {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'localFsChanged' });
        }
    }).catch(() => {});
}

module.exports = { start, stop, LocalFS };
