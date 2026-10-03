// --- Local folders, for when there is no server (GitHub Pages) ---
// The browser's own file system stands in for the server's: folders the user
// picks (File System Access API, showDirectoryPicker) and the origin's private
// storage (OPFS, every browser has it), mounted side by side under a virtual
// root, so /Browser storage/notes/a.txt or /photos/2024/x.jpg. src/local-server.js
// answers the server's WebSocket messages from here; the URLs viewers fetch
// (/workspace-file, /download-file, /upload-file) are answered by the service
// worker (worker.js imports this file) and by the page's own fetch().
//
// Picked folders are kept in IndexedDB, so they come back after a reload; the
// browser may then ask again for permission, which only the page can do, on a click.
// Loaded by the page through require() and by the service worker with importScripts().
(function (root) {
    const DB_NAME = 'gle-local-fs';
    const STORE = 'kv';
    const OPFS_NAME = 'Browser storage';
    const URL_RE = /\/(workspace-file|download-file|upload-file)$/;

    const MIME = {
        png: 'image/png', apng: 'image/apng', jxl: 'image/jxl', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
        webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
        mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
        mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg',
        html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
        txt: 'text/plain', md: 'text/plain', xml: 'text/xml', wasm: 'application/wasm', zip: 'application/zip',
    };

    function mimeOf(name) {
        const i = name.lastIndexOf('.');
        return (i >= 0 && MIME[name.slice(i + 1).toLowerCase()]) || 'application/octet-stream';
    }

    function fsError(status, message) {
        const err = new Error(message);
        err.status = status;
        return err;
    }

    // --- IndexedDB: the picked folders and whether this origin runs without a server ---
    let dbPromise = null;
    function db() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            dbPromise.catch(() => { dbPromise = null; });
        }
        return dbPromise;
    }
    async function kv(mode, fn) {
        const d = await db();
        return new Promise((resolve, reject) => {
            const tx = d.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req && req.result);
            tx.onerror = () => reject(tx.error);
        });
    }
    const kvGet = key => kv('readonly', s => s.get(key));
    const kvSet = (key, value) => kv('readwrite', s => s.put(value, key));

    // Whether /workspace-file and the rest are answered here (an origin without a
    // server). Kept in IndexedDB for the service worker, which may restart at any time
    let enabled = null;
    async function isEnabled() {
        if (enabled === null) {
            try { enabled = !!(await kvGet('enabled')); } catch (_) { enabled = false; }
        }
        return enabled;
    }
    // The flag if known already (null before the first isEnabled())
    function knownEnabled() {
        return enabled;
    }
    // Forget the cached flag (the page changed it)
    function reloadEnabled() {
        enabled = null;
    }
    async function setEnabled(on) {
        on = !!on;
        if (await isEnabled() === on) return;
        enabled = on;
        await kvSet('enabled', on);
    }

    // --- Mounts ---
    function supported() {
        return !!(root.navigator && root.navigator.storage && root.navigator.storage.getDirectory) || canPickFolders();
    }
    function canPickFolders() {
        return typeof root.showDirectoryPicker === 'function';
    }

    // [{ name, handle, opfs? }], the private storage first
    async function mounts() {
        const list = [];
        if (root.navigator && root.navigator.storage && root.navigator.storage.getDirectory) {
            try { list.push({ name: OPFS_NAME, handle: await root.navigator.storage.getDirectory(), opfs: true }); } catch (_) { /* private window, say */ }
        }
        for (const m of (await kvGet('mounts').catch(() => null)) || []) list.push(m);
        return list;
    }

    // Asks for a folder (on a click: the browser requires one) and mounts it; returns its path
    async function addFolder() {
        if (!canPickFolders()) throw new Error('This browser cannot open folders from disk; use Browser storage and Upload');
        const handle = await root.showDirectoryPicker({ mode: 'readwrite', id: 'gle-local-fs' });
        const saved = (await kvGet('mounts')) || [];
        for (const m of saved) {
            if (await m.handle.isSameEntry(handle)) return '/' + m.name;
        }
        const taken = new Set([OPFS_NAME, ...saved.map(m => m.name)]);
        let name = handle.name || 'folder';
        for (let i = 2; taken.has(name); i++) name = `${handle.name} (${i})`;
        saved.push({ name, handle });
        await kvSet('mounts', saved);
        return '/' + name;
    }

    // Forgets a picked folder; its files stay where they are
    async function removeMount(name) {
        const saved = (await kvGet('mounts')) || [];
        await kvSet('mounts', saved.filter(m => m.name !== name));
    }

    // Permission for a picked folder: granted, or asked for (page only, after a click)
    async function ensurePermission(mount, write) {
        if (mount.opfs || !mount.handle.queryPermission) return;
        const opts = { mode: write ? 'readwrite' : 'read' };
        if (await mount.handle.queryPermission(opts) === 'granted') return;
        if (typeof mount.handle.requestPermission === 'function') {
            try {
                if (await mount.handle.requestPermission(opts) === 'granted') return;
            } catch (_) { /* no user activation */ }
        }
        throw fsError(403, `No permission for "${mount.name}": open it in the file browser and allow access`);
    }

    // --- Paths ---
    function normalize(p) {
        const out = [];
        for (const seg of String(p || '').split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') out.pop();
            else out.push(seg);
        }
        return '/' + out.join('/');
    }
    function split(p) {
        const n = normalize(p);
        return n === '/' ? [] : n.slice(1).split('/');
    }
    function dirname(p) {
        const n = normalize(p);
        return n.slice(0, n.lastIndexOf('/')) || '/';
    }
    function basename(p) {
        const n = normalize(p);
        return n.slice(n.lastIndexOf('/') + 1);
    }
    function join(a, b) {
        return normalize(a + '/' + b);
    }

    async function mountOf(name) {
        const m = (await mounts()).find(x => x.name === name);
        if (!m) throw fsError(404, `Not found: /${name}`);
        return m;
    }

    // { kind: 'root' } | { kind: 'directory'|'file', handle, mount, parent (directory handle or null for a mount) }
    async function lookup(p, opts = {}) {
        const parts = split(p);
        if (!parts.length) return { kind: 'root' };
        const mount = await mountOf(parts[0]);
        await ensurePermission(mount, !!opts.write);
        let dir = mount.handle;
        let parent = null;
        for (let i = 1; i < parts.length; i++) {
            const name = parts[i];
            const last = i === parts.length - 1;
            parent = dir;
            try {
                dir = await dir.getDirectoryHandle(name);
            } catch (err) {
                if (last && err.name === 'TypeMismatchError') {
                    return { kind: 'file', handle: await dir.getFileHandle(name), mount, parent };
                }
                if (err.name === 'TypeMismatchError') {
                    // A file with more path after it: inside an archive (zip-sw.js reads those)
                    const e2 = fsError(404, `Not a folder: ${parts.slice(0, i + 1).join('/')}`);
                    e2.throughFile = true;
                    throw e2;
                }
                if (err.name === 'NotFoundError') throw fsError(404, `Not found: ${normalize(p)}`);
                throw err;
            }
        }
        return { kind: 'directory', handle: dir, mount, parent };
    }

    async function dirHandle(p, opts = {}) {
        const e = await lookup(p, opts);
        if (e.kind !== 'directory') throw fsError(400, `Not a folder: ${normalize(p)}`);
        return e.handle;
    }

    // Entries of a folder: [{ name, kind, handle }]; the root lists the mounts
    async function list(p) {
        const e = await lookup(p);
        if (e.kind === 'root') return (await mounts()).map(m => ({ name: m.name, kind: 'directory', handle: m.handle, mount: m }));
        if (e.kind !== 'directory') throw fsError(400, `Not a folder: ${normalize(p)}`);
        const out = [];
        for await (const [name, handle] of e.handle.entries()) out.push({ name, kind: handle.kind, handle });
        return out;
    }

    async function file(p) {
        const e = await lookup(p);
        if (e.kind !== 'file') throw fsError(400, `Not a file: ${normalize(p)}`);
        return e.handle.getFile();
    }

    async function stat(p) {
        const e = await lookup(p);
        if (e.kind === 'file') {
            const f = await e.handle.getFile();
            return { isFile: true, isDirectory: false, size: f.size, mtimeMs: f.lastModified };
        }
        return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
    }

    async function exists(p) {
        try { await lookup(p); return true; } catch (err) { if (err.status === 404) return false; throw err; }
    }

    // Writes data (string, Blob, BufferSource) to p; exclusive: fail if it exists
    async function writeFile(p, data, opts = {}) {
        const parts = split(p);
        if (parts.length < 2) throw fsError(400, 'Files go inside a folder');
        const dir = opts.parents ? await mkdir(dirname(p), { recursive: true }) : await dirHandle(dirname(p), { write: true });
        const name = parts[parts.length - 1];
        if (opts.exclusive && await exists(p)) throw fsError(409, `${name} already exists`);
        const handle = await dir.getFileHandle(name, { create: true });
        const w = await handle.createWritable();
        try {
            await w.write(data);
            await w.close();
        } catch (err) {
            await w.abort().catch(() => {});
            throw err;
        }
    }

    // Creates folder p; returns its handle
    async function mkdir(p, opts = {}) {
        const parts = split(p);
        // A mounted folder itself already exists
        if (parts.length === 1 && opts.recursive) {
            const m = await mountOf(parts[0]);
            await ensurePermission(m, true);
            return m.handle;
        }
        if (parts.length < 2) throw fsError(400, 'Cannot create a folder at the top; add one with "Add folder"');
        const mount = await mountOf(parts[0]);
        await ensurePermission(mount, true);
        let dir = mount.handle;
        for (let i = 1; i < parts.length; i++) {
            const last = i === parts.length - 1;
            if (last && opts.exclusive && await exists(p)) throw fsError(409, `${parts[i]} already exists`);
            if (!last && !opts.recursive) dir = await dir.getDirectoryHandle(parts[i]);
            else dir = await dir.getDirectoryHandle(parts[i], { create: true });
        }
        return dir;
    }

    function isMountRoot(p) {
        return split(p).length === 1;
    }

    async function remove(p) {
        if (isMountRoot(p)) throw fsError(400, 'Cannot delete a whole mounted folder');
        const parent = await dirHandle(dirname(p), { write: true });
        await parent.removeEntry(basename(p), { recursive: true });
    }

    // "name.ext" -> first of "name.ext", "name (2).ext", ... free in dir
    async function freeName(dir, name) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let candidate = join(dir, name);
        for (let i = 2; await exists(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`);
        return candidate;
    }

    async function copy(src, dest) {
        const e = await lookup(src);
        if (e.kind === 'file') {
            await writeFile(dest, await e.handle.getFile(), { exclusive: true });
            return;
        }
        if (e.kind !== 'directory') throw fsError(400, 'Cannot copy the top level');
        await mkdir(dest, { exclusive: true });
        for await (const [name] of e.handle.entries()) await copy(join(src, name), join(dest, name));
    }

    // Moves src to dest (a free path); handle.move() where the browser has it, else copy and delete
    async function move(src, dest) {
        if (isMountRoot(src)) throw fsError(400, 'Cannot move a whole mounted folder');
        const s = normalize(src), d = normalize(dest);
        if (d === s || d.startsWith(s + '/')) throw fsError(400, 'Cannot move a folder into itself');
        const e = await lookup(s, { write: true });
        const sameMount = split(s)[0] === split(d)[0];
        if (sameMount && typeof e.handle.move === 'function') {
            try {
                const destDir = await dirHandle(dirname(d), { write: true });
                await e.handle.move(destDir, basename(d));
                return;
            } catch (err) {
                if (err.name !== 'NotSupportedError' && err.name !== 'InvalidModificationError') throw err;
            }
        }
        await copy(s, d);
        await remove(s);
    }

    // --- HTTP: the URLs viewers fetch, as the server answers them ---
    function pathOf(request) {
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'PUT') return null;
        const url = new URL(request.url);
        if (url.origin !== root.location.origin || !URL_RE.test(url.pathname)) return null;
        const p = url.searchParams.get('path');
        return p ? { path: p, kind: url.pathname.match(URL_RE)[1], url } : null;
    }

    function textResponse(status, text) {
        return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
    }

    // A Response, or null for a path through a file (inside an archive), which is left to zip-sw.js
    async function respond(request, target) {
        try {
            if (target.kind === 'upload-file') {
                if (request.method !== 'PUT') return textResponse(405, 'PUT only');
                const overwrite = !!target.url.searchParams.get('overwrite');
                if (!overwrite && await exists(target.path)) {
                    return new Response(JSON.stringify({ error: 'already exists' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
                }
                const body = await request.blob();
                await writeFile(target.path, body, { parents: true });
                return new Response(JSON.stringify({ success: true, size: body.size }), { headers: { 'Content-Type': 'application/json' } });
            }
            const f = await file(target.path);
            const name = basename(target.path);
            const headers = { 'Content-Type': mimeOf(name), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Last-Modified': new Date(f.lastModified).toUTCString() };
            if (target.kind === 'download-file') headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
            const range = request.headers.get('Range');
            const m = range && range.match(/^bytes=(\d*)-(\d*)$/);
            if (m && (m[1] || m[2])) {
                let start, end;
                if (!m[1]) { start = Math.max(0, f.size - Number(m[2])); end = f.size - 1; }
                else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), f.size - 1) : f.size - 1; }
                if (start >= f.size || start > end) {
                    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${f.size}` } });
                }
                headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
                headers['Content-Length'] = String(end - start + 1);
                return new Response(request.method === 'HEAD' ? null : f.slice(start, end + 1), { status: 206, headers });
            }
            headers['Content-Length'] = String(f.size);
            return new Response(request.method === 'HEAD' ? null : f, { headers });
        } catch (err) {
            if (err.throughFile) return null;
            return textResponse(err.status || 500, err.message);
        }
    }

    // fetch() that answers for local files when this origin has no server; net is the real fetch
    function localFetch(input, init, net) {
        let request;
        try {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!URL_RE.test(new URL(url, root.location.href).pathname)) return net(input, init);
            request = new Request(input, init);
        } catch (_) {
            return net(input, init);
        }
        const target = pathOf(request);
        if (!target) return net(input, init);
        return isEnabled().then(on => (on ? respond(request, target) : null)).then(r => r || net(input, init));
    }

    const api = {
        OPFS_NAME, supported, canPickFolders, isEnabled, knownEnabled, setEnabled, reloadEnabled,
        mounts, addFolder, removeMount, ensurePermission, mountOf,
        normalize, split, dirname, basename, join,
        lookup, list, file, stat, exists, writeFile, mkdir, remove, copy, move, freeName, isMountRoot,
        pathOf, respond, localFetch, mimeOf,
        active: false, // set by the page while it runs without a server
    };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LocalFS = api;
})(typeof self !== 'undefined' ? self : this);
