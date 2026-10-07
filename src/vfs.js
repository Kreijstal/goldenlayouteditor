// --- The editor's file tree ---
// One tree for every file the editor can reach:
//   /                  the in-browser shell's namespace (Wanix, src/wanix-plugin.js):
//                      rc.wasm, project/, what the shell makes; gone on reload
//   /server/...        the server's files, when there is a server (/server/home/me/...)
//   /Browser storage   the browser's private storage (OPFS), kept; the shell has it too
//   /<folder>          folders picked from this computer (public/local-fs.js)
// ws-client.js talks to a Router, which stands where the WebSocket used to: it
// takes the server's messages (ws-handler.js), sends those about /server on to
// the server with the prefix taken off (and put back on the replies), and
// answers the rest itself. A path from before /server existed (/home/me/x)
// still reaches the server, unless the shell's namespace has that name.
// File bytes are fetched from /workspace-file?path=... as before: the server
// takes /server paths as they are (virtual-path.js), the service worker answers
// for the browser's folders, and the page's fetch() (install()) and
// resolveFileUrl (archive-fallback.js) for the shell's namespace as well.

const LocalFS = require('../public/local-fs.js');
const { createLogger } = require('./debug');
const log = createLogger('VFS');

const SERVER = 'server';
const { normalize, split, join, dirname, basename } = LocalFS;
// Extensions with a dedicated viewer, never read as text (mirrors SERVED_EXTENSIONS in ws-handler.js)
const SERVED_EXTENSIONS = new Set(('pdf ai djvu djv vsd vsdx swf epub psd xlsx xlsm xlsb xls ods sqlite sqlite3 db glb gltf stl obj gcode gco blend fzz fst ghw wasm fla xfl '
    + 'png apng jxl jpg jpeg gif bmp ico webp avif svg tvg tif tiff jp2 j2k j2c jpc jpf jpx jph jhc heic heif hif pbm pgm ppm pnm pam hdr rgbe xyze pic tga tpic icb vda vst qoi pcx dcx sgi ras sun im1 im8 im24 im32 ilbm lbm ham ham8 fits fit fts jxr mp4 m4v mov mkv webm avi wmv mpg mpeg m2ts 3gp mp3 m4a aac flac wav ogg opus').split(' '));
// Names an SGI image shares with other files (mirrors SGI_MAYBE_RE in ws-handler.js)
const SGI_MAYBE_RE = /\.(rgba?|bw|inta?)$/i;
// ...and a Sun raster (mirrors SUN_MAYBE_RE in ws-handler.js)
const SUN_MAYBE_RE = /\.rs$/i;
// ...and an Amiga picture (mirrors IFF_MAYBE_RE in ws-handler.js)
const IFF_MAYBE_RE = /\.iff$/i;
const IFF_PICTURE_RE = /^FORM[\s\S]{4}(ILBM|PBM |ACBM)/;
// ...and fpack's FITS, with Fritzing's sketch (mirrors FZ_MAYBE_RE in ws-handler.js)
const FZ_MAYBE_RE = /\.fz$/i;
// ...and JPEG XR by HD Photo's names, with WinDev and Dylan projects (mirrors JXR_MAYBE_RE in ws-handler.js)
const JXR_MAYBE_RE = /\.(wdp|hdp)$/i;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_RANGE_READ_SIZE = 8 * 1024 * 1024;
// "New from template" without a server lists the files in here
const LOCAL_TEMPLATES = '/' + LocalFS.OPFS_NAME + '/Templates';

const netFetch = typeof window !== 'undefined' ? window.fetch.bind(window) : null;
let router = null; // the Router, once ws-client.js made it

function fsError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

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

async function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(await data.arrayBuffer()); // Blob, File
}

// /server/home/x <-> /home/x
function toVirtual(real) {
    const n = normalize(real);
    return n === '/' ? '/' + SERVER : '/' + SERVER + n;
}

// ---- the shell's namespace ----
const wanix = () => require('./wanix-plugin'); // late: it loads the terminal and plugins
const wpath = p => split(p).join('/') || '.';

async function wanixRoot() {
    return wanix().wanixRoot();
}

// Whether the namespace has this name at its top (without starting Wanix for it)
async function wanixHas(name) {
    if (!wanix().wanixStarted()) return false;
    try {
        await (await wanixRoot()).stat(name);
        return true;
    } catch (_) {
        return false;
    }
}

function wanixError(err, p) {
    const text = String((err && err.message) || err);
    return /not exist|no such|not found/i.test(text) ? fsError(404, `Not found: ${p}`) : fsError(500, `${p}: ${text}`);
}

const wanixFs = {
    async stat(p) {
        const root = await wanixRoot();
        let st;
        try { st = await root.stat(wpath(p)); } catch (err) { throw wanixError(err, p); }
        return { isFile: !st.IsDir, isDirectory: !!st.IsDir, size: st.Size || 0, mtimeMs: Date.parse(st.ModTime) || 0 };
    },
    async list(p) {
        const root = await wanixRoot();
        let names;
        try { names = (await root.readDir(wpath(p))) || []; } catch (err) { throw wanixError(err, p); }
        return Promise.all(names.map(async (n) => {
            const dir = n.endsWith('/');
            const name = dir ? n.slice(0, -1) : n;
            const item = { name, kind: dir ? 'directory' : 'file', size: 0, mtimeMs: 0 };
            if (!dir) {
                try {
                    const st = await root.stat(wpath(join(p, name)));
                    item.size = st.Size || 0;
                    item.mtimeMs = Date.parse(st.ModTime) || 0;
                } catch (_) { /* gone meanwhile */ }
            }
            return item;
        }));
    },
    async read(p) {
        const root = await wanixRoot();
        try {
            return new Blob([await root.readFile(wpath(p))], { type: LocalFS.mimeOf(p) });
        } catch (err) {
            throw wanixError(err, p);
        }
    },
    async write(p, data, opts = {}) {
        if (opts.exclusive && await exists(p)) throw fsError(409, `${basename(p)} already exists`);
        if (opts.parents) await wanixFs.mkdir(dirname(p), { recursive: true });
        const root = await wanixRoot();
        try { await root.writeFile(wpath(p), await toBytes(data)); } catch (err) { throw wanixError(err, p); }
    },
    async mkdir(p, opts = {}) {
        const root = await wanixRoot();
        const parts = split(p);
        for (let i = 1; i <= parts.length; i++) {
            const at = parts.slice(0, i).join('/');
            const last = i === parts.length;
            let there = true;
            try { await root.stat(at); } catch (_) { there = false; }
            if (there) {
                if (last && opts.exclusive) throw fsError(409, `${parts[i - 1]} already exists`);
                continue;
            }
            if (!last && !opts.recursive) throw fsError(404, `Not found: /${at}`);
            // makeDirAll fails with more than one level to make (see wanix-plugin.js)
            try { await root.makeDir(at); } catch (err) { throw wanixError(err, '/' + at); }
        }
    },
    async remove(p) {
        try { await (await wanixRoot()).removeAll(wpath(p)); } catch (err) { throw wanixError(err, p); }
    },
    async rename(from, to) {
        try { await (await wanixRoot()).rename(wpath(from), wpath(to)); } catch (err) { throw wanixError(err, from); }
    },
};

// ---- the server ----
async function serverCall(msg) {
    if (!router || !router.server) throw fsError(503, 'The server is not connected');
    return router.serverRequest(msg);
}

const serverFs = {
    async stat(real) {
        if (real === '/') return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
        const r = await serverCall({ type: 'statFile', workspacePath: '/', relativePath: real.slice(1) });
        if (!r.success) throw fsError(/ENOENT|no such/i.test(r.error || '') ? 404 : 500, r.error || 'stat failed');
        return { isFile: r.isFile, isDirectory: r.isDirectory, size: r.size, mtimeMs: r.mtimeMs };
    },
    async list(real, showHidden = true) {
        const r = await serverCall({ type: 'browseDir', path: real, showHidden });
        if (r.error) throw fsError(500, r.error);
        return r.items.map(i => ({ ...i, kind: i.type }));
    },
    async read(real) {
        const resp = await netFetch('/workspace-file?path=' + encodeURIComponent(real));
        if (!resp.ok) throw fsError(resp.status, await resp.text() || `HTTP ${resp.status}`);
        return resp.blob();
    },
    async write(real, data, opts = {}) {
        const body = typeof data === 'string' ? data : data instanceof Blob ? data : new Blob([data]);
        const resp = await netFetch(`/upload-file?path=${encodeURIComponent(real)}${opts.exclusive ? '' : '&overwrite=1'}`, { method: 'PUT', body });
        if (resp.status === 409) throw fsError(409, `${basename(real)} already exists`);
        if (!resp.ok) throw fsError(resp.status, ((await resp.json().catch(() => ({}))).error) || `HTTP ${resp.status}`);
    },
    async mkdir(real, opts = {}) {
        const r = opts.exclusive && !opts.recursive
            ? await serverCall({ type: 'makeDir', path: real })
            : await serverCall({ type: 'mkdir', path: real });
        if (!r.success) throw fsError(500, r.error || (r.errors && r.errors[0] && r.errors[0].error) || 'mkdir failed');
    },
    // To the Trash, as the file browser does with server files
    async remove(real) {
        const r = await serverCall({ type: 'trashPaths', paths: [real] });
        if (!r.success) throw fsError(500, (r.errors && r.errors[0] && r.errors[0].error) || 'delete failed');
    },
    async rename(from, to) {
        if (dirname(from) !== dirname(to)) throw fsError(400, 'not here');
        const r = await serverCall({ type: 'renamePath', path: from, name: basename(to) });
        if (!r.success) throw fsError(500, (r.errors && r.errors[0] && r.errors[0].error) || 'rename failed');
    },
};

// ---- where a path lives ----
// { kind: 'root' | 'server' | 'local' | 'wanix', path (canonical), real (server) }
async function where(p) {
    p = normalize(p);
    const parts = split(p);
    if (!parts.length) return { kind: 'root', path: '/' };
    if (parts[0] === SERVER) {
        if (!router || !router.server) throw fsError(503, 'The server is not connected');
        return { kind: 'server', path: p, real: '/' + parts.slice(1).join('/') };
    }
    if (await LocalFS.isMountName(parts[0])) return { kind: 'local', path: p };
    // A path from before /server
    if (router && router.server && !(await wanixHas(parts[0]))) return { kind: 'server', path: toVirtual(p), real: p };
    return { kind: 'wanix', path: p };
}

// Whether a path is the server's, at a glance (paths the editor shows are canonical)
function isServerPath(p) {
    return split(p)[0] === SERVER;
}

const fsOf = kind => (kind === 'server' ? serverFs : kind === 'wanix' ? wanixFs : null);
const at = w => (w.kind === 'server' ? w.real : w.path);

async function list(p) {
    const w = await where(p);
    if (w.kind === 'root') {
        const out = [];
        try {
            for (const e of await wanixFs.list('/')) {
                if (e.name !== LocalFS.OPFS_NAME) out.push(e);
            }
        } catch (err) {
            log.warn('The shell namespace is not there:', err);
            out.rootError = 'The in-browser shell (Wanix) did not start: ' + (err.message || err);
        }
        if (router && router.server) out.push({ name: SERVER, kind: 'directory', size: 0, mtimeMs: 0, mount: 'server' });
        for (const m of await LocalFS.mounts()) out.push({ name: m.name, kind: 'directory', size: 0, mtimeMs: 0, mount: m.opfs ? 'storage' : 'folder' });
        return out;
    }
    if (w.kind === 'local') {
        return Promise.all((await LocalFS.list(w.path)).map(async (e) => {
            const item = { name: e.name, kind: e.kind, size: 0, mtimeMs: 0 };
            if (e.kind === 'file') {
                const f = await e.handle.getFile();
                item.size = f.size;
                item.mtimeMs = f.lastModified;
            }
            return item;
        }));
    }
    return fsOf(w.kind).list(at(w));
}

async function read(p) {
    const w = await where(p);
    if (w.kind === 'root') throw fsError(400, 'Not a file: /');
    if (w.kind === 'local') return LocalFS.file(w.path);
    return fsOf(w.kind).read(at(w));
}

async function stat(p) {
    const w = await where(p);
    if (w.kind === 'root') return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
    if (w.kind === 'local') return LocalFS.stat(w.path);
    return fsOf(w.kind).stat(at(w));
}

async function exists(p) {
    try { await stat(p); return true; } catch (err) { if (err.status === 404) return false; throw err; }
}

async function write(p, data, opts = {}) {
    const w = await where(p);
    if (w.kind === 'root') throw fsError(400, 'Not a file: /');
    if (w.kind === 'local') {
        if (opts.exclusive && await LocalFS.exists(w.path)) throw fsError(409, `${basename(p)} already exists`);
        return LocalFS.writeFile(w.path, data, { parents: opts.parents });
    }
    return fsOf(w.kind).write(at(w), data, opts);
}

async function mkdir(p, opts = {}) {
    const w = await where(p);
    if (w.kind === 'root') return;
    if (w.kind === 'local') {
        if (LocalFS.isMountRoot(w.path)) return;
        await LocalFS.mkdir(w.path, opts);
        return;
    }
    return fsOf(w.kind).mkdir(at(w), opts);
}

async function remove(p) {
    const w = await where(p);
    if (w.kind === 'root') throw fsError(400, 'Cannot delete /');
    if (w.kind === 'local') {
        if (LocalFS.isMountRoot(w.path)) {
            const name = basename(w.path);
            if (name === LocalFS.OPFS_NAME) throw fsError(400, 'Browser storage is always there');
            await LocalFS.removeMount(name); // forgotten; its files stay
            mountsChanged();
            return;
        }
        return LocalFS.remove(w.path);
    }
    if (w.kind === 'server' && w.real === '/') throw fsError(400, 'Cannot delete the server');
    return fsOf(w.kind).remove(at(w));
}

async function freeName(dir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = join(dir, name);
    for (let i = 2; await exists(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`);
    return candidate;
}

// Copies src to dest (free), across mounts too
async function copy(src, dest) {
    const s = await stat(src);
    if (!s.isDirectory) {
        await write(dest, await read(src), { exclusive: true });
        return;
    }
    await mkdir(dest, { exclusive: true });
    for (const e of await list(src)) await copy(join(src, e.name), join(dest, e.name));
}

// Moves src to dest (free): renamed in place where both are on the same mount
async function move(src, dest) {
    const s = await where(src), d = await where(dest);
    if (d.path === s.path || d.path.startsWith(s.path + '/')) throw fsError(400, 'Cannot move a folder into itself');
    if (s.kind === 'root' || (s.kind === 'local' && LocalFS.isMountRoot(s.path)) || (s.kind === 'server' && s.real === '/')) {
        throw fsError(400, 'Cannot move a mounted folder');
    }
    const sameMount = s.kind === d.kind && (s.kind !== 'local' || split(s.path)[0] === split(d.path)[0]);
    if (sameMount) {
        if (s.kind === 'local') return LocalFS.move(s.path, d.path);
        if (s.kind === 'wanix') return wanixFs.rename(s.path, d.path);
        if (dirname(s.real) === dirname(d.real)) return serverFs.rename(s.real, d.real);
    }
    await copy(src, dest);
    await remove(src);
}

// ---- folders from this computer ----
function mountsChanged() {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'localFsChanged' });
    }
}

async function addFolder() {
    const p = await LocalFS.addFolder();
    mountsChanged();
    return p;
}

// ---- HTTP: /workspace-file and the rest for the shell's namespace and the browser's folders ----
const URL_RE = /\/(workspace-file|download-file|upload-file)$/;

// The bytes of a file the server doesn't have, as an HTTP response
async function respond(request, p) {
    const w = await where(p);
    if (w.kind === 'server' || w.kind === 'root') return null; // the server answers
    if (w.kind === 'local') return LocalFS.respond(request, LocalFS.pathOf(request));
    try {
        if (request.method === 'PUT') {
            const url = new URL(request.url);
            if (!url.searchParams.get('overwrite') && await exists(p)) {
                return new Response(JSON.stringify({ error: 'already exists' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
            }
            const body = await request.blob();
            await write(p, body, { parents: true });
            return new Response(JSON.stringify({ success: true, size: body.size }), { headers: { 'Content-Type': 'application/json' } });
        }
        const blob = await read(p);
        const headers = { 'Content-Type': LocalFS.mimeOf(p), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
        if (/download-file$/.test(new URL(request.url).pathname)) {
            headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(p))}`;
        }
        const m = (request.headers.get('Range') || '').match(/^bytes=(\d*)-(\d*)$/);
        if (m && (m[1] || m[2])) {
            const size = blob.size;
            const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
            const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
            if (start >= size || start > end) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
            headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            return new Response(blob.slice(start, end + 1), { status: 206, headers });
        }
        return new Response(blob, { headers });
    } catch (err) {
        return new Response(err.message, { status: err.status || 500, headers: { 'Content-Type': 'text/plain' } });
    }
}

// fetch() of a URL the page answers itself, or null for the network
function pageFetch(input, init) {
    let request;
    try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const u = new URL(url, location.href);
        if (u.origin !== location.origin || !URL_RE.test(u.pathname)) return null;
        const p = u.searchParams.get('path');
        if (!p || isServerPath(p)) return null;
        request = new Request(input, init);
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'PUT') return null;
        // A path through a file (inside an archive): zip-sw.js reads it
        return respond(request, p).catch((err) => {
            if (err.throughFile || err.status === 404) return null;
            throw err;
        });
    } catch (_) {
        return null;
    }
}

let installed = false;
function install() {
    if (installed) return;
    installed = true;
    window.fetch = function (input, init) {
        const answer = pageFetch(input, init);
        return answer ? answer.then(r => r || netFetch(input, init)) : netFetch(input, init);
    };
}

// A URL an element can load (src): a blob: URL for a file the server doesn't
// have (the service worker can't answer for the shell's namespace, nor for
// navigations outside its scope), else null
const blobUrls = new Map(); // path -> { url, size, mtimeMs }
async function blobUrlFor(p) {
    if (isServerPath(p)) return null;
    const w = await where(p).catch(() => null);
    if (!w || w.kind === 'server' || w.kind === 'root') return null;
    let s;
    try { s = await stat(p); } catch (err) { if (err.throughFile) return null; throw err; }
    const known = blobUrls.get(p);
    if (known && known.size === s.size && known.mtimeMs === s.mtimeMs) return known.url;
    if (known) URL.revokeObjectURL(known.url);
    let blob = await read(p);
    if (!blob.type) blob = new Blob([blob], { type: LocalFS.mimeOf(p) });
    const entry = { url: URL.createObjectURL(blob), size: s.size, mtimeMs: s.mtimeMs };
    blobUrls.delete(p);
    blobUrls.set(p, entry);
    if (blobUrls.size > 64) {
        const [oldest, old] = blobUrls.entries().next().value;
        blobUrls.delete(oldest);
        URL.revokeObjectURL(old.url);
    }
    return entry.url;
}

// ---- the server's messages, answered here ----
// Every path a message names, as full paths
function pathsOf(msg) {
    const ws = rel => join(msg.workspacePath || '/', rel || '');
    switch (msg.type) {
        case 'browseDir': case 'listDir': case 'openWorkspace': case 'mkdir': case 'makeDir':
        case 'createFile': case 'renamePath': case 'getThumbnail':
            return [msg.path];
        case 'trashPaths': return msg.paths || [];
        case 'copyPaths': case 'movePaths': return [...(msg.paths || []), msg.dest];
        case 'saveFile': return [ws(msg.relativePath || msg.fileName)];
        case 'readFile': case 'readFileRange': case 'statFile': case 'refreshFile': return [ws(msg.relativePath)];
        case 'renameFile': return [ws(msg.oldRelativePath), ws(msg.newRelativePath)];
        case 'refreshWatch': return [msg.workspacePath];
        default: return [];
    }
}

const prefixed = p => (typeof p === 'string' && p.startsWith('/') ? toVirtual(p) : p);

// msg for the server (real paths) and how to put its reply back, or null when
// the message is not the server's alone
async function forServer(msg) {
    const out = { ...msg };
    const fix = [];
    const real = async (p) => {
        const w = await where(p);
        if (w.kind !== 'server') throw fsError(0, 'not the server');
        return w.real;
    };
    try {
        switch (msg.type) {
            case 'browseDir': case 'listDir':
                // '' is the server's home
                if (msg.path) out.path = await real(msg.path);
                break;
            case 'openWorkspace': case 'mkdir': case 'makeDir': case 'createFile': case 'renamePath': case 'getThumbnail':
                out.path = await real(msg.path);
                break;
            case 'trashPaths':
                out.paths = await Promise.all((msg.paths || []).map(real));
                break;
            case 'copyPaths': case 'movePaths':
                out.paths = await Promise.all((msg.paths || []).map(real));
                out.dest = await real(msg.dest);
                break;
            case 'saveFile': case 'readFile': case 'readFileRange': case 'statFile': case 'refreshFile': case 'renameFile': {
                const relKeys = msg.type === 'renameFile' ? ['oldRelativePath', 'newRelativePath'] : msg.type === 'saveFile' && !msg.relativePath ? ['fileName'] : ['relativePath'];
                const wsWhere = msg.workspacePath && await where(msg.workspacePath).catch(() => null);
                if (wsWhere && wsWhere.kind === 'server') {
                    out.workspacePath = wsWhere.real;
                } else {
                    // The workspace is above /server (/): its paths are made the server's own
                    out.workspacePath = '/';
                    for (const k of relKeys) out[k] = (await real(join(msg.workspacePath || '/', msg[k]))).slice(1);
                    for (const k of relKeys) fix.push(r => { if (k in r) r[k] = msg[k]; });
                }
                for (const k of relKeys) await real(join(msg.workspacePath || '/', msg[k])); // all on the server
                fix.push(r => { if ('relativePath' in r && msg.relativePath !== undefined) r.relativePath = msg.relativePath; });
                break;
            }
            case 'refreshWatch':
                out.workspacePath = await real(msg.workspacePath);
                break;
            case 'termSpawn':
                if (msg.cwd) {
                    try { out.cwd = await real(msg.cwd); } catch (_) { delete out.cwd; }
                }
                break;
            default:
                break;
        }
    } catch (err) {
        if (err.status === 0) return null;
        throw err;
    }
    return { out, fix: r => { for (const f of fix) f(r); return fromServer(r); } };
}

// A message from the server with its paths made the editor's
function fromServer(r) {
    switch (r.type) {
        case 'browseListing':
            if (r.path) {
                r.parent = r.path === '/' ? '/' : prefixed(r.parent);
                r.path = prefixed(r.path);
            }
            break;
        case 'dirListing': case 'workspaceLoaded': case 'mkdirResult':
            if (r.path) r.path = prefixed(r.path);
            break;
        case 'templates':
            if (r.dir) r.dir = prefixed(r.dir);
            break;
        case 'fsChanges':
            if (r.workspacePath) r.workspacePath = prefixed(r.workspacePath);
            break;
        default:
            break;
    }
    if (Array.isArray(r.errors)) r.errors = r.errors.map(e => ({ ...e, path: prefixed(e.path) }));
    return r;
}

async function pathOp(msg, paths, op) {
    const errors = [];
    for (const p of paths || []) {
        const abs = normalize(p);
        try {
            await op(abs);
        } catch (err) {
            errors.push({ path: abs, error: err.message });
        }
    }
    return { type: msg.type + 'Result', success: errors.length === 0, errors };
}

function workspaceFile(msg, rel) {
    if (!msg.workspacePath || !rel) throw new Error('Missing required fields');
    const root = normalize(msg.workspacePath);
    const p = join(root, rel);
    if (p !== root && !p.startsWith(root === '/' ? '/' : root + '/')) throw new Error('Path traversal blocked');
    return p;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const dirsFirst = (a, b) => (a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : byName(a, b));

// What the page answers itself (the shell's namespace, the browser's folders, and
// operations across mounts); ws-handler.js answers the same for the server
const handlers = {
    clientLog() {},
    termInput() {},
    termResize() {},

    termSpawn(msg) {
        return { type: 'termSpawned', sessionId: msg.sessionId, error: 'The terminal needs the server' };
    },
    termKill(msg) {
        return { type: 'termKilled', sessionId: msg.sessionId };
    },
    updateFiles() {
        return { type: 'filesUpdated' };
    },

    async listDir(msg) {
        const dirPath = normalize(msg.path || '/');
        try {
            const w = await where(dirPath);
            const items = (await list(dirPath))
                .filter(e => !e.name.startsWith('.'))
                .map(e => ({ name: e.name, isDirectory: e.kind === 'directory' }))
                .sort((a, b) => (a.isDirectory !== b.isDirectory ? b.isDirectory - a.isDirectory : a.name.localeCompare(b.name)));
            return { type: 'dirListing', path: w.path, items };
        } catch (err) {
            return { type: 'dirListing', path: dirPath, items: [], error: err.message };
        }
    },

    async browseDir(msg) {
        let dirPath = normalize(msg.path || '/');
        const reply = { type: 'browseListing', path: dirPath, parent: dirname(dirPath) };
        try {
            dirPath = (await where(dirPath)).path;
            Object.assign(reply, { path: dirPath, parent: dirname(dirPath) });
            const entries = await list(dirPath);
            if (entries.rootError) reply.error = entries.rootError;
            reply.items = entries.filter(e => msg.showHidden || !e.name.startsWith('.')).map((e) => {
                const item = { name: e.name, type: e.kind, size: e.size || 0, mtimeMs: e.mtimeMs || 0 };
                if (e.mount) item.mount = e.mount;
                if (e.kind === 'directory') return item;
                const ext = extOf(e.name);
                if (SERVED_EXTENSIONS.has(ext)) item.viewType = ext;
                else if (item.size > MAX_FILE_SIZE) item.viewType = 'binary';
                else item.lazy = true;
                return item;
            }).sort(dirsFirst);
        } catch (err) {
            reply.items = [];
            reply.error = err.message;
        }
        return reply;
    },

    async openWorkspace(msg) {
        let dirPath = normalize(msg.path);
        async function readDir(dir) {
            const children = [];
            for (const e of await list(dir)) {
                if (e.name.startsWith('.')) continue;
                if (e.kind === 'directory') {
                    children.push({ name: e.name, type: 'directory', children: await readDir(join(dir, e.name)) });
                    continue;
                }
                const ext = extOf(e.name);
                if (SERVED_EXTENSIONS.has(ext)) children.push({ name: e.name, type: 'file', viewType: ext, content: null });
                else if (e.size > MAX_FILE_SIZE) children.push({ name: e.name, type: 'file', viewType: 'binary', content: null, size: e.size });
                else {
                    const blob = await read(join(dir, e.name));
                    // an SGI image by another name (.rgb, .bw...), a Sun raster by Rust's (.rs), an
                    // Amiga picture by IFF's (.iff), FITS by Fritzing's (.fz) or JPEG XR by HD Photo's
                    // (.wdp, .hdp): binary, its viewer tells by the magic number
                    const sgi = SGI_MAYBE_RE.test(e.name), sun = SUN_MAYBE_RE.test(e.name), iff = IFF_MAYBE_RE.test(e.name), fz = FZ_MAYBE_RE.test(e.name);
                    const jxr = JXR_MAYBE_RE.test(e.name);
                    const head = sgi || sun || iff || fz || jxr ? new Uint8Array(await blob.slice(0, 12).arrayBuffer()) : null;
                    if (head && ((sgi && head[0] === 0x01 && head[1] === 0xDA)
                        || (sun && head[0] === 0x59 && head[1] === 0xA6 && head[2] === 0x6A && head[3] === 0x95)
                        || (iff && IFF_PICTURE_RE.test(String.fromCharCode(...head)))
                        || (fz && String.fromCharCode(...head).startsWith('SIMPLE  ='))
                        || (jxr && head[0] === 0x49 && head[1] === 0x49 && head[2] === 0xBC && head[3] <= 1))) children.push({ name: e.name, type: 'file', viewType: 'binary', content: null, size: e.size });
                    else children.push({ name: e.name, type: 'file', content: await blob.text() });
                }
            }
            return children.sort((a, b) => (a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name)));
        }
        try {
            dirPath = (await where(dirPath)).path;
            if (dirPath === '/') throw new Error('Open a folder, not the top level');
            return { type: 'workspaceLoaded', path: dirPath, children: await readDir(dirPath) };
        } catch (err) {
            return { type: 'workspaceLoaded', path: dirPath, children: [], error: err.message };
        }
    },

    async readFile(msg) {
        try {
            const blob = await read(workspaceFile(msg, msg.relativePath));
            return { type: 'fileContent', success: true, content: await blob.text(), relativePath: msg.relativePath };
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
            const p = workspaceFile(msg, msg.relativePath);
            const blob = await read(p);
            const s = await stat(p);
            const bytes = new Uint8Array(await blob.slice(offset, offset + requestedLength).arrayBuffer());
            return {
                type: 'fileRange', success: true, relativePath: msg.relativePath, offset, requestedLength,
                length: bytes.length, size: blob.size, mtimeMs: s.mtimeMs, eof: offset + bytes.length >= blob.size,
                encoding: 'base64', content: bytesToBase64(bytes),
            };
        } catch (err) {
            return { type: 'fileRange', success: false, error: err.message };
        }
    },

    async statFile(msg) {
        try {
            return { type: 'fileStat', success: true, relativePath: msg.relativePath, ...await stat(workspaceFile(msg, msg.relativePath)) };
        } catch (err) {
            return { type: 'fileStat', success: false, error: err.message };
        }
    },

    async saveFile(msg) {
        const relativePath = msg.relativePath || msg.fileName;
        try {
            if (msg.content === undefined) throw new Error('Missing required fields');
            const data = msg.encoding === 'base64' ? base64ToBytes(msg.content) : msg.content;
            await write(workspaceFile(msg, relativePath), data, { parents: true });
            return { type: 'fileSaved', success: true, relativePath };
        } catch (err) {
            return { type: 'fileSaved', success: false, error: err.message };
        }
    },

    async renameFile(msg) {
        try {
            const from = workspaceFile(msg, msg.oldRelativePath);
            const to = workspaceFile(msg, msg.newRelativePath);
            if (await exists(to)) throw new Error('Destination exists');
            await mkdir(dirname(to), { recursive: true });
            await move(from, to);
            return { type: 'fileRenamed', success: true, oldRelativePath: msg.oldRelativePath, newRelativePath: msg.newRelativePath };
        } catch (err) {
            return { type: 'fileRenamed', success: false, error: err.message };
        }
    },

    async refreshFile(msg) {
        try {
            const p = workspaceFile(msg, msg.relativePath);
            if (SERVED_EXTENSIONS.has(extOf(p))) return { type: 'fileRefreshed', success: true, relativePath: msg.relativePath, content: null, servedViaHttp: true };
            const blob = await read(p);
            if (blob.size > MAX_FILE_SIZE) throw new Error('File too large');
            return { type: 'fileRefreshed', success: true, relativePath: msg.relativePath, content: await blob.text() };
        } catch (err) {
            return { type: 'fileRefreshed', success: false, error: err.message };
        }
    },

    refreshWatch() {
        return { type: 'watchRefreshed', success: false, error: 'No file watching here' };
    },

    getThumbnail() {
        return { type: 'thumbnail', success: false };
    },

    async mkdir(msg) {
        try {
            if (!msg.path) throw new Error('Missing path');
            await mkdir(msg.path, { recursive: true });
            return { type: 'mkdirResult', success: true, path: (await where(msg.path)).path };
        } catch (err) {
            return { type: 'mkdirResult', success: false, error: err.message };
        }
    },

    // Files on the server go to its Trash; the others are deleted. A picked folder itself is only forgotten
    trashPaths(msg) {
        return pathOp(msg, msg.paths, remove);
    },

    copyPaths(msg) {
        return pathOp(msg, msg.paths, async (src) => copy(src, await freeName(normalize(msg.dest), basename(src))));
    },

    movePaths(msg) {
        return pathOp(msg, msg.paths, async (src) => {
            const destDir = normalize(msg.dest);
            if (destDir === src || destDir.startsWith(src + '/')) throw new Error('Cannot move a folder into itself');
            if (dirname(src) === destDir) return;
            await move(src, await freeName(destDir, basename(src)));
        });
    },

    renamePath(msg) {
        return pathOp(msg, [msg.path], async (src) => {
            const name = String(msg.name || '');
            if (!name || name.includes('/') || name === '.' || name === '..') throw new Error('Invalid name');
            const dest = join(dirname(src), name);
            if (await exists(dest)) throw new Error(`${name} already exists`);
            await move(src, dest);
        });
    },

    createFile(msg) {
        return pathOp(msg, [msg.path], async (dest) => {
            let data;
            if (msg.template) {
                const templates = await handlers.listTemplates();
                data = await read(join(templates.dir, basename(String(msg.template))));
            } else {
                data = msg.encoding === 'base64' ? base64ToBytes(msg.content) : String(msg.content || '');
            }
            await write(dest, data, { exclusive: true });
        });
    },

    // The server's templates folder when there is a server, else Browser storage/Templates
    async listTemplates() {
        if (router && router.server) return fromServer(await router.serverRequest({ type: 'listTemplates' }));
        let items = [];
        try {
            items = (await list(LOCAL_TEMPLATES)).filter(e => e.kind === 'file' && !e.name.startsWith('.')).map(e => e.name)
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        } catch (_) { /* no templates folder */ }
        return { type: 'templates', dir: LOCAL_TEMPLATES, items };
    },

    makeDir(msg) {
        return pathOp(msg, [msg.path], p => mkdir(p, { exclusive: true }));
    },
};

// Stands where the WebSocket was: send() a message, get the reply as a 'message' event
class Router {
    constructor() {
        this.readyState = 1; // WebSocket.OPEN
        this.server = null;
        this._listeners = new Set();
        this._pending = new Map(); // id -> fix(reply)
        this._own = new Map();     // id -> resolve, for the router's own requests
        this._ownId = 0;
    }

    // Without a server: the shell's namespace and the browser's folders only
    get local() {
        return !this.server;
    }

    attachServer(socket) {
        this.server = socket;
        socket.addEventListener('message', (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_) { return; }
            if (msg.id && this._own.has(msg.id)) {
                const resolve = this._own.get(msg.id);
                this._own.delete(msg.id);
                resolve(msg);
                return;
            }
            const fix = msg.id && this._pending.get(msg.id);
            if (fix) this._pending.delete(msg.id);
            this._emit(fix ? fix(msg) : fromServer(msg));
        });
        socket.addEventListener('close', () => {
            if (this.server === socket) this.server = null;
        });
    }

    addEventListener(type, fn) {
        if (type === 'message') this._listeners.add(fn);
    }

    removeEventListener(type, fn) {
        this._listeners.delete(fn);
    }

    _emit(obj) {
        const event = { data: JSON.stringify(obj) };
        for (const fn of this._listeners) {
            try { fn(event); } catch (_) { /* a listener's own problem */ }
        }
    }

    // A message to the server with real paths, answered to the caller only
    serverRequest(msg) {
        return new Promise((resolve, reject) => {
            if (!this.server || this.server.readyState !== 1) return reject(fsError(503, 'The server is not connected'));
            const id = 'vfs-' + (++this._ownId);
            this._own.set(id, resolve);
            this.server.send(JSON.stringify({ ...msg, id }));
        });
    }

    send(data) {
        let msg;
        try { msg = JSON.parse(data); } catch (_) { return; }
        this._route(msg).catch((err) => {
            if (msg.id) this._emit({ type: 'error', error: err.message, id: msg.id });
        });
    }

    async _route(msg) {
        if (this.server && this.server.readyState === 1) {
            // All its paths on the server (or none, as for the terminal's): the server's
            const route = await forServer(msg);
            if (route) {
                if (msg.id) this._pending.set(msg.id, route.fix);
                this.server.send(JSON.stringify(route.out));
                return;
            }
        }
        const handler = handlers[msg.type];
        const reply = handler ? await handler(msg) : (msg.id ? { type: 'error', error: `${msg.type} needs the server` } : null);
        if (reply && msg.id) {
            reply.id = msg.id;
            this._emit(reply);
        }
    }

    close() {}
}

// The Router for ws-client.js: with the server's socket, or alone (null where
// the browser has nothing to offer without a server either)
function createRouter(socket) {
    if (!socket && !LocalFS.supported()) return null;
    router = new Router();
    if (socket) router.attachServer(socket);
    install();
    return router;
}

module.exports = {
    createRouter, SERVER, LocalFS,
    where, isServerPath, list, read, stat, exists, write, mkdir, remove, copy, move, freeName,
    addFolder, canPickFolders: () => LocalFS.canPickFolders(), blobUrlFor, toVirtual,
    hasServer: () => !!(router && router.server),
};
