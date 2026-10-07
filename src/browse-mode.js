// --- File Browser Mode ---
// Activated with ?browse (optionally ?browse=/some/dir). Unlike project mode,
// nothing is loaded up front: the server lists one directory at a time and
// file contents are fetched only when a file is opened. Viewers are the same
// components project mode uses (EditorComponent's media viewers, plugins),
// mounted one at a time in a full-screen panel. Browse mode never touches the
// project session in localStorage.

const { getPlugins } = require('./plugins');
const { createLogger } = require('./debug');
const { ENCODINGS, decodeBytes, detectEncoding } = require('./text-encoding');
const { ensureArchiveAccess, downloadFile, isMemoryPath } = require('./archive-fallback');

const log = createLogger('Browse');

// Extensions EditorComponent can play/show directly; these default to it
// instead of the inspector plugins project mode prefers.
const PLAYABLE = /\.(a?png|jxl|jpe?g|gif|bmp|ico|webp|avif|svg|tiff?|jp2|j2[kc]|jpc|jp[fx]|jph|jhc|hei[cf]|hif|p[bgpn]m|pam|hdr|rgbe|xyze|tga|tpic|icb|vda|vst|qoi|[pd]cx|mp4|m4v|mov|mkv|webm|mp3|m4a|aac|flac|wav|ogg|opus|pdf|ai|fla)$/i;

// Zip-format archives the browser opens as read-only folders. Listing and file
// reads are answered by the service worker (public/zip-sw.js; without one, the
// page runs it itself, see archive-fallback.js), keep in sync.
const ZIP_EXTENSIONS = new Set(['zip', 'jar', 'war', 'ear', 'aar', 'apk', 'xapk', 'ipa', 'whl', 'nupkg', 'cbz', 'xpi', 'vsix', 'crx', 'kmz', '3mf']);
// Extensions with a dedicated viewer (mirrors SERVED_EXTENSIONS in ws-handler.js)
const SERVED_EXTENSIONS = new Set(('pdf ai djvu djv vsd vsdx swf epub psd xlsx xlsm xlsb xls ods sqlite sqlite3 db glb gltf stl obj gcode gco blend fzz fst ghw wasm fla xfl '
    + 'png apng jxl jpg jpeg gif bmp ico webp avif svg tvg tif tiff jp2 j2k j2c jpc jpf jpx jph jhc heic heif hif pbm pgm ppm pnm pam hdr rgbe xyze pic tga tpic icb vda vst qoi pcx dcx mp4 m4v mov mkv webm avi wmv mpg mpeg m2ts 3gp mp3 m4a aac flac wav ogg opus').split(' '));
const MAX_TEXT_SIZE = 5 * 1024 * 1024;

// Tar archives the service worker can open (mirrors TAR_RE in public/zip-sw.js)
const TAR_RE = /\.(tar|tgz|tar\.gz|tzst|tar\.zst)$/i;
// A lone .gz/.zst opens as a folder holding the decompressed file (SINGLE_RE there)
const SINGLE_RE = /\.(gz|zst)$/i;
// Disc and disk images (ISO_RE and DISK_RE there)
const ISO_RE = /\.iso$/i;
const DISK_RE = /\.(img|ima|vfd|flp|qcow2?)$/i;

function isArchiveName(name) {
    return ZIP_EXTENSIONS.has(extOf(name)) || TAR_RE.test(name) || SINGLE_RE.test(name) || ISO_RE.test(name) || DISK_RE.test(name);
}

// .flp is a floppy image or an FL Studio project; only floppies have a floppy's size
const FLOPPY_SIZES = new Set([163840, 184320, 327680, 368640, 737280, 1228800, 1474560, 1720320, 1763328, 2949120]);
function isFlStudioProject(f) {
    return /\.flp$/i.test(f.name) && !FLOPPY_SIZES.has(f.size);
}

function isArchivePath(p) {
    return p.split('/').some(isArchiveName);
}

// Whether a file lies inside an archive (read-only there); in-memory files (decrypted contents) are read-only too
function insideArchive(p) {
    return isMemoryPath(p) || p.split('/').slice(0, -1).some(isArchiveName);
}

const ICONS = {
    image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕',
    archive: '📦', code: '📜', text: '📄', dir: '📁',
};
const ICON_BY_EXT = {};
for (const e of ['png', 'apng', 'jxl', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'svg', 'tvg', 'tif', 'tiff', 'jp2', 'j2k', 'j2c', 'jpc', 'jpf', 'jpx', 'jph', 'jhc', 'heic', 'heif', 'hif', 'pbm', 'pgm', 'ppm', 'pnm', 'pam', 'hdr', 'rgbe', 'xyze', 'tga', 'tpic', 'icb', 'vda', 'vst', 'qoi', 'pcx', 'dcx', 'fxg', 'psd', 'xcf', 'jbf', 'dcm', 'dicom']) ICON_BY_EXT[e] = ICONS.image;
for (const e of ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', '3gp', 'vcut']) ICON_BY_EXT[e] = ICONS.video;
for (const e of ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus']) ICON_BY_EXT[e] = ICONS.audio;
for (const e of ['zip', 'tar', 'gz', 'xz', 'bz2', '7z', 'rar', 'zst', 'iso']) ICON_BY_EXT[e] = ICONS.archive;
for (const e of ['js', 'ts', 'py', 'c', 'h', 'cpp', 'rs', 'go', 'java', 'sh', 'html', 'css', 'json']) ICON_BY_EXT[e] = ICONS.code;
ICON_BY_EXT.pdf = ICON_BY_EXT.ai = ICONS.pdf;
ICON_BY_EXT.chm = '📘';
ICON_BY_EXT.hwp = ICON_BY_EXT.hwpx = '📝';
ICON_BY_EXT.vrm = '🧍';
ICON_BY_EXT.mht = ICON_BY_EXT.mhtml = '🌐';
ICON_BY_EXT.kdbx = ICON_BY_EXT.kdb = '🔐';
for (const e of ['mscz', 'mscx', 'musicxml', 'mxl', 'gp', 'gp3', 'gp4', 'gp5', 'gtp', 'mid', 'midi']) ICON_BY_EXT[e] = '🎼';

const CSS = `
#topToolbar{display:none!important}
#layoutContainer{position:fixed;inset:0;display:flex;flex-direction:column;background:#1e1e1e;color:#ddd;font-family:system-ui,sans-serif;font-size:14px}
.bm-bar{display:flex;align-items:center;gap:4px;padding:3px 6px;background:#252526;border-bottom:1px solid #333;flex-shrink:0;min-height:38px;box-sizing:border-box}
.bm-btn{background:#333;color:#ddd;border:1px solid #444;border-radius:5px;min-width:34px;min-height:32px;padding:0 8px;font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
.bm-btn[hidden]{display:none}
.bm-btn.on{background:#0e639c;border-color:#1177bb;color:#fff}
.bm-crumbs{flex:1;display:flex;overflow-x:auto;white-space:nowrap;scrollbar-width:none;align-items:center}
.bm-crumbs::-webkit-scrollbar{display:none}
.bm-crumb{background:none;border:none;color:#9cdcfe;font-size:14px;padding:4px 3px;cursor:pointer;flex-shrink:0}
.bm-crumb:last-child{color:#fff;font-weight:600}
.bm-sep{opacity:.4;flex-shrink:0}
.bm-tools{display:flex;gap:4px;padding:3px 6px;border-bottom:1px solid #333;flex-shrink:0}
.bm-filter{flex:1;min-width:0;background:#2d2d2d;color:#ddd;border:1px solid #444;border-radius:5px;padding:0 8px;font-size:14px;min-height:30px}
.bm-select{background:#333;color:#ddd;border:1px solid #444;border-radius:5px;min-height:30px;font-size:13px;padding:0 4px}
.bm-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;min-height:0}
.bm-row{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;display:flex;align-items:center;gap:8px;padding:0 8px;min-height:34px;box-sizing:border-box;border-bottom:1px solid #2a2a2a;cursor:pointer;-webkit-tap-highlight-color:rgba(255,255,255,.08)}
.bm-row:active,.bm-row:hover{background:#2a2d2e}
.bm-ico{width:26px;height:26px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px;overflow:hidden;border-radius:4px}
.bm-ico img,.bm-ico canvas{max-width:100%;max-height:100%;object-fit:cover}
.bm-txt{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px}
.bm-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bm-meta{font-size:11px;opacity:.55;white-space:nowrap;flex-shrink:0;font-variant-numeric:tabular-nums}
.bm-grid{display:grid;align-content:start;grid-auto-rows:max-content;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:2px;padding:4px}
.bm-grid .bm-row{flex-direction:column;border:none;border-radius:5px;padding:4px 2px;gap:2px;text-align:center}
.bm-grid .bm-ico{width:64px;height:64px;font-size:34px}
.bm-grid .bm-txt{width:100%;display:block;flex:none}
.bm-grid .bm-name{font-size:12px;white-space:normal;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bm-grid .bm-meta{display:none}
.bm-check{width:20px;height:20px;flex-shrink:0;margin:0;accent-color:#0e639c;pointer-events:none}
.bm-row.sel{background:#04395e}
.bm-grid .bm-check{position:absolute;top:4px;left:4px}
.bm-grid .bm-row{position:relative}
.bm-actions{display:flex;align-items:center;gap:4px;padding:4px 6px;padding-bottom:calc(4px + env(safe-area-inset-bottom,0px));background:#252526;border-top:1px solid #333;flex-shrink:0;overflow-x:auto}
.bm-actions .bm-count{flex:1;min-width:60px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
.bm-btn.danger{background:#5a1d1d;border-color:#8b2c2c}
.bm-btn:disabled{opacity:.35}
.bm-empty{padding:24px;opacity:.6;text-align:center}
.bm-list.bm-dropping{outline:2px dashed #3794ff;outline-offset:-6px;background:rgba(55,148,255,.08)}
.bm-upload{display:flex;align-items:center;gap:8px;padding:4px 8px;background:#252526;border-top:1px solid #333;font-size:13px;flex-shrink:0}
.bm-upload[hidden]{display:none}
.bm-upload .bm-upload-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bm-upload progress{width:120px;flex-shrink:0}
.bm-menu{position:fixed;z-index:20;min-width:220px;max-width:calc(100vw - 16px);max-height:70vh;overflow-y:auto;background:#252526;border:1px solid #454545;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.5);padding:4px 0;color:#ddd;font-family:system-ui,sans-serif;font-size:14px}
.bm-menu-item{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;color:#ddd;font-size:14px;text-align:left;padding:0 12px;min-height:36px;cursor:pointer}
.bm-menu-item:hover{background:#04395e}
.bm-menu-item .bm-meta{margin-left:auto}
.bm-menu-head{font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.5;padding:8px 12px 2px}
.bm-menu-note{font-size:12px;opacity:.5;padding:4px 12px 8px}
.bm-viewer{position:fixed;inset:0;display:flex;flex-direction:column;background:#1e1e1e;color:#ddd;font-family:system-ui,sans-serif;font-size:14px;z-index:10}
.bm-viewer-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.bm-path{flex:1;min-width:0;background:transparent;color:#ddd;border:1px solid transparent;border-radius:5px;padding:0 6px;font:inherit;font-size:14px;min-height:30px;text-overflow:ellipsis}
.bm-path:focus{background:#2d2d2d;border-color:#1177bb;outline:none}
.bm-textbar{overflow-x:auto;scrollbar-width:none}
.bm-textbar .bm-enc{flex:1;min-width:0;max-width:280px}
.bm-viewer-body{flex:1;min-height:0;position:relative;overflow:auto;background:#fff;color:#000}
`;

function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
        + (sameYear ? ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function loadPref(key, fallback) {
    try { return localStorage.getItem('gl-browse-' + key) || fallback; } catch (_) { return fallback; }
}
function savePref(key, value) {
    try { localStorage.setItem('gl-browse-' + key, value); } catch (_) { /* ignore */ }
}

/**
 * @param {HTMLElement} root  #layoutContainer
 * @param {object} deps       from main.js:
 *   wsClient, EditorComponent, viewersForFile(fileId), setWorkspace(path, files),
 *   getProjectFiles(), pluginCtx (plugin init context), log
 */
async function initBrowseMode(root, deps) {
    const { wsClient, EditorComponent, viewersForFile, setWorkspace, getProjectFiles, pluginCtx } = deps;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    document.title = 'Files';
    root.innerHTML = '';

    // Components that can be mounted in the viewer panel
    const components = { editor: EditorComponent };
    for (const plugin of getPlugins()) {
        if (plugin.init) {
            try { plugin.init(pluginCtx); } catch (err) { log.warn('Plugin init failed:', plugin.id, err); }
        }
        if (plugin.components) Object.assign(components, plugin.components);
    }
    pluginCtx.openEditorTab = (componentType, state, title) => openViewer({ componentType, state, title });
    pluginCtx.openPluginPanel = (componentType, title, state) => openViewer({ componentType, state: state || {}, title });
    pluginCtx.getComponent = (type) => components[type];

    // --- State ---
    let cwd = null;
    let parent = null;
    let files = [];            // current listing, mapped to project file objects
    let showHidden = loadPref('hidden', '0') === '1';
    let view = loadPref('view', 'list');
    let sort = loadPref('sort', 'name');
    let filter = '';
    let nextId = 1;
    let viewer = null;         // { container, el, file }
    let selectMode = false;
    const selected = new Set(); // names in cwd
    let clipboard = null;       // { mode: 'copy'|'move', paths: [abs] }
    let readOnly = false;       // inside an archive
    let thumbIO = null;

    // --- Header ---
    const bar = el('div', 'bm-bar');
    const upBtn = el('button', 'bm-btn', '↑');
    upBtn.title = 'Parent directory';
    upBtn.onclick = () => { if (parent && parent !== cwd) navigate(parent); };
    const crumbs = el('div', 'bm-crumbs');
    const hiddenBtn = el('button', 'bm-btn', '.*');
    hiddenBtn.title = 'Show hidden files';
    hiddenBtn.onclick = () => {
        showHidden = !showHidden;
        savePref('hidden', showHidden ? '1' : '0');
        navigate(cwd, { replace: true });
    };
    const viewBtn = el('button', 'bm-btn');
    viewBtn.title = 'List / grid';
    viewBtn.onclick = () => {
        view = view === 'list' ? 'grid' : 'list';
        savePref('view', view);
        render();
    };
    const projectBtn = el('a', 'bm-btn', 'Project');
    projectBtn.title = 'Switch to project mode';
    projectBtn.href = location.pathname + '?project';
    // A shell in the folder shown: the server's for its folders, the in-browser one (Wanix) for the rest
    const termBtn = el('button', 'bm-btn', '>_');
    termBtn.title = 'Open a terminal here';
    termBtn.style.fontFamily = 'monospace';
    termBtn.onclick = async () => {
        // Not inside an archive: the folder holding it
        const parts = (cwd || '/').split('/');
        const a = parts.findIndex(isArchiveName);
        const here = a < 0 ? (cwd || '/') : parts.slice(0, a).join('/') || '/';
        let kind = 'wanix';
        try { kind = (await wsClient.vfs.where(here)).kind; } catch (_) { /* the shell's own top */ }
        // Browser storage is in the shell's namespace too; a folder that is not starts it in the project
        if (kind === 'server') openViewer({ componentType: 'terminal', state: { cwd: here }, title: 'Terminal: ' + here });
        else openViewer({ componentType: 'wanixTerminal', state: { dir: here }, title: 'Shell: ' + here });
    };
    bar.append(upBtn, crumbs, hiddenBtn, viewBtn, termBtn, projectBtn);

    const tools = el('div', 'bm-tools');
    const filterInput = el('input', 'bm-filter');
    filterInput.type = 'search';
    filterInput.placeholder = 'Filter';
    filterInput.oninput = () => { filter = filterInput.value.toLowerCase(); render(); };
    const sortSelect = el('select', 'bm-select');
    for (const [v, label] of [['name', 'Name'], ['date', 'Newest'], ['size', 'Largest']]) {
        const o = el('option', null, label);
        o.value = v;
        sortSelect.appendChild(o);
    }
    sortSelect.value = sort;
    sortSelect.onchange = () => { sort = sortSelect.value; savePref('sort', sort); render(); };
    const selectBtn = el('button', 'bm-btn', '\u2611');
    selectBtn.title = 'Select files';
    selectBtn.onclick = () => setSelectMode(!selectMode);
    const mkdirBtn = el('button', 'bm-btn', '+\uD83D\uDCC1');
    mkdirBtn.title = 'New folder';
    mkdirBtn.onclick = async () => {
        if (readOnly) return;
        const name = prompt('New folder name:');
        if (name) await runOp({ type: 'makeDir', path: absPath(name) });
    };
    const newBtn = el('button', 'bm-btn', '+\uD83D\uDCC4');
    newBtn.title = 'New file';
    newBtn.onclick = () => { if (!readOnly) showNewMenu(newBtn); };
    const uploadBtn = el('button', 'bm-btn', '\u2B06');
    uploadBtn.title = 'Upload files (or drop them on the list)';
    const uploadInput = el('input');
    uploadInput.type = 'file';
    uploadInput.multiple = true;
    uploadInput.hidden = true;
    uploadBtn.onclick = () => { if (!readOnly) uploadInput.click(); };
    uploadInput.onchange = () => {
        const picked = Array.from(uploadInput.files, file => ({ file, rel: file.name }));
        uploadInput.value = '';
        uploadFiles(picked);
    };
    // Without a server: folders from this computer are added at the top level
    const addFolderBtn = el('button', 'bm-btn', '+ Add folder');
    addFolderBtn.title = 'Open a folder from this computer';
    addFolderBtn.hidden = true;
    addFolderBtn.onclick = async () => {
        try {
            await navigate(await wsClient.vfs.addFolder());
        } catch (err) {
            if (err.name !== 'AbortError') alert('Could not open the folder: ' + err.message);
        }
    };
    tools.append(filterInput, sortSelect, selectBtn, newBtn, mkdirBtn, uploadBtn, uploadInput, addFolderBtn);

    const list = el('div', 'bm-list');
    const actions = el('div', 'bm-actions');
    actions.hidden = true;
    const uploadBar = el('div', 'bm-upload');
    uploadBar.hidden = true;
    const uploadText = el('span', 'bm-upload-text');
    const uploadProgress = el('progress');
    uploadBar.append(uploadText, uploadProgress);
    root.append(bar, tools, list, uploadBar, actions);

    // --- Upload ---
    // Files from the picker or dropped on the list (folders too) go into the folder
    // shown, streamed to the server one at a time
    let uploading = false;

    function putFile(file, path, overwrite, onProgress) {
        if (!wsClient.vfs.isServerPath(path)) return putLocalFile(file, path, overwrite, onProgress);
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', `upload-file?path=${encodeURIComponent(path)}${overwrite ? '&overwrite=1' : ''}`);
            xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
            xhr.onload = () => {
                let body = {};
                try { body = JSON.parse(xhr.responseText); } catch (_) { /* not JSON */ }
                if (xhr.status === 409) resolve('exists');
                else if (xhr.status >= 200 && xhr.status < 300) resolve('ok');
                else reject(new Error(body.error || `HTTP ${xhr.status}`));
            };
            xhr.onerror = () => reject(new Error('network error'));
            xhr.send(file);
        });
    }

    // Not to the server: written straight into the browser's folder or the shell's namespace
    async function putLocalFile(file, path, overwrite, onProgress) {
        const fs = wsClient.vfs;
        if (!overwrite && await fs.exists(path)) return 'exists';
        await fs.write(path, file, { parents: true });
        onProgress(file.size);
        return 'ok';
    }

    async function uploadFiles(items) {
        if (!items.length || readOnly) return;
        if (uploading) { alert('An upload is already running'); return; }
        uploading = true;
        const dir = cwd;
        const total = items.reduce((n, it) => n + it.file.size, 0) || 1;
        let done = 0;
        const failed = [];
        let replaceAll = null; // answer for every further existing file
        uploadBar.hidden = false;
        uploadProgress.max = total;
        try {
            for (let i = 0; i < items.length; i++) {
                const { file, rel } = items[i];
                const path = dir.replace(/\/$/, '') + '/' + rel;
                uploadText.textContent = `Uploading ${rel}` + (items.length > 1 ? ` (${i + 1} of ${items.length})` : '');
                const progress = loaded => { uploadProgress.value = done + loaded; };
                try {
                    let result = await putFile(file, path, false, progress);
                    if (result === 'exists') {
                        let replace = replaceAll;
                        if (replace === null) {
                            replace = confirm(`${rel} already exists. Replace it?` + (items.length > 1 ? '\n(OK/Cancel applies to the other existing files too)' : ''));
                            if (items.length > 1) replaceAll = replace;
                        }
                        if (replace) result = await putFile(file, path, true, progress);
                    }
                } catch (err) {
                    failed.push(`${rel}: ${err.message}`);
                }
                done += file.size;
                uploadProgress.value = done;
            }
        } finally {
            uploading = false;
            uploadBar.hidden = true;
        }
        if (failed.length) alert('Could not upload:\n' + failed.join('\n'));
        if (cwd === dir) await navigate(cwd, { replace: true });
    }

    // Dropped items, folders walked, as { file, rel } with rel the path below the drop
    async function droppedFiles(dataTransfer) {
        const out = [];
        const readAll = reader => new Promise((resolve, reject) => {
            const all = [];
            const next = () => reader.readEntries(batch => {
                if (!batch.length) resolve(all);
                else { all.push(...batch); next(); }
            }, reject);
            next();
        });
        async function walk(entry, prefix) {
            if (entry.isFile) {
                const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                out.push({ file, rel: prefix + entry.name });
            } else if (entry.isDirectory) {
                for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + '/');
            }
        }
        const entries = Array.from(dataTransfer.items || [])
            .filter(it => it.kind === 'file')
            .map(it => it.webkitGetAsEntry && it.webkitGetAsEntry());
        if (entries.length && entries.every(Boolean)) {
            for (const entry of entries) await walk(entry, '');
        } else {
            for (const file of Array.from(dataTransfer.files || [])) out.push({ file, rel: file.name });
        }
        return out;
    }

    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    list.addEventListener('dragover', e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = readOnly ? 'none' : 'copy';
        list.classList.toggle('bm-dropping', !readOnly);
    });
    list.addEventListener('dragleave', e => {
        if (!list.contains(e.relatedTarget)) list.classList.remove('bm-dropping');
    });
    list.addEventListener('drop', async e => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        list.classList.remove('bm-dropping');
        if (readOnly) return;
        let items;
        try {
            items = await droppedFiles(e.dataTransfer);
        } catch (err) {
            alert('Could not read the dropped files: ' + err.message);
            return;
        }
        uploadFiles(items);
    });

    // --- New file ---
    // Kinds come from plugins (newFileTypes) and from the user's templates folder
    // (XDG_TEMPLATES_DIR, e.g. ~/Templates), so any program's files can be started here.
    let menu = null;
    function closeMenu() {
        if (!menu) return;
        menu.remove();
        menu = null;
        document.removeEventListener('pointerdown', onOutside, true);
    }
    function onOutside(e) {
        if (menu && !menu.contains(e.target)) closeMenu();
    }

    async function showNewMenu(anchor) {
        if (menu) { closeMenu(); return; }
        menu = el('div', 'bm-menu');
        const item = (label, meta, onClick) => {
            const b = el('button', 'bm-menu-item', label);
            if (meta) b.appendChild(el('span', 'bm-meta', meta));
            b.onclick = () => { closeMenu(); onClick(); };
            menu.appendChild(b);
        };
        item('Empty file\u2026', null, () => newFile({ label: 'file', ext: '', content: () => '' }));
        for (const plugin of getPlugins()) {
            for (const type of plugin.newFileTypes || []) item(type.label, '.' + type.ext, () => newFile(type));
        }
        const r = anchor.getBoundingClientRect();
        menu.style.top = (r.bottom + 4) + 'px';
        menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        document.body.appendChild(menu);
        document.addEventListener('pointerdown', onOutside, true);
        const thisMenu = menu;
        let templates = { dir: '~/Templates', items: [] };
        try { templates = await wsClient.wsRequest({ type: 'listTemplates' }); } catch (_) { /* server gone */ }
        if (menu !== thisMenu) return;
        menu.appendChild(el('div', 'bm-menu-head', 'Templates'));
        for (const name of templates.items) item(name, null, () => newFromTemplate(name));
        menu.appendChild(el('div', 'bm-menu-note', `${templates.items.length ? 'More' : 'Files'} in ${templates.dir.replace(/^\/home\/[^/]+/, '~')} are listed here.`));
    }

    function askName(suggested, ext) {
        let name = prompt('New file name:', suggested);
        if (name == null) return null;
        name = name.trim();
        if (!name) return null;
        if (name.includes('/') || name === '.' || name === '..') { alert('Invalid name'); return null; }
        if (ext && !name.toLowerCase().endsWith('.' + ext.toLowerCase())) name += '.' + ext;
        if (files.some(f => f.name === name)) { alert(`${name} already exists`); return null; }
        return name;
    }

    async function newFile(type) {
        const name = askName(type.ext ? 'Untitled.' + type.ext : '', type.ext);
        if (!name) return;
        const stem = type.ext ? name.slice(0, -(type.ext.length + 1)) : name;
        let content;
        try {
            content = await type.content(stem);
        } catch (err) {
            alert(`Could not create ${name}: ${err.message}`);
            return;
        }
        const msg = { type: 'createFile', path: absPath(name) };
        if (content instanceof Uint8Array) {
            let binary = '';
            for (let i = 0; i < content.length; i += 0x8000) binary += String.fromCharCode.apply(null, content.subarray(i, i + 0x8000));
            Object.assign(msg, { content: btoa(binary), encoding: 'base64' });
        } else {
            msg.content = content;
        }
        await createAndOpen(msg, name);
    }

    async function newFromTemplate(template) {
        const dot = template.lastIndexOf('.');
        const name = askName(template, dot > 0 ? template.slice(dot + 1) : '');
        if (name) await createAndOpen({ type: 'createFile', path: absPath(name), template }, name);
    }

    async function createAndOpen(msg, name) {
        if (!await runOp(msg)) return;
        const file = files.find(f => f.name === name);
        if (file) openFile(file);
    }

    // --- Selection & actions ---
    function absPath(name) {
        return cwd.replace(/\/$/, '') + '/' + name;
    }

    function setSelectMode(on) {
        selectMode = on;
        if (!on) selected.clear();
        render();
    }

    function toggleSelected(name) {
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        render();
    }

    async function runOp(msg) {
        let result;
        try {
            result = await wsClient.wsRequest(msg);
        } catch (err) {
            alert('Failed: ' + err.message);
            return false;
        }
        if (result.errors && result.errors.length) {
            alert(result.errors.map(e => `${e.path.split('/').pop()}: ${e.error}`).join('\n'));
        }
        selectMode = false;
        selected.clear();
        await navigate(cwd, { replace: true });
        return result.success;
    }

    function actionButton(label, title, onClick, opts = {}) {
        const b = el('button', 'bm-btn' + (opts.danger ? ' danger' : ''), label);
        b.title = title;
        b.disabled = !!opts.disabled;
        b.onclick = onClick;
        actions.appendChild(b);
        return b;
    }

    function renderActions() {
        actions.innerHTML = '';
        selectBtn.classList.toggle('on', selectMode);
        if (selectMode) {
            const names = [...selected];
            const one = names.length === 1 ? files.find(f => f.name === names[0]) : null;
            actions.appendChild(el('span', 'bm-count', names.length + ' selected'));
            actionButton('All', 'Select all', () => {
                const shown = files.filter(f => !filter || f.name.toLowerCase().includes(filter));
                const all = shown.every(f => selected.has(f.name));
                shown.forEach(f => all ? selected.delete(f.name) : selected.add(f.name));
                render();
            });
            actionButton('\u2B07', 'Download', () => {
                if (one.type === 'directory' && !wsClient.vfs.isServerPath(absPath(one.name))) alert('Only folders on the server can be downloaded (as a zip)');
                else if (one.type === 'directory') location.href = '/download-dir?path=' + encodeURIComponent(absPath(one.name));
                else downloadFile(absPath(one.name)).catch(err => alert(`Could not download ${one.name}: ${err.message}`));
            }, { disabled: !one || (readOnly && one.type === 'directory') });
            if (readOnly) {
                actionButton('\u2715', 'Done', () => setSelectMode(false));
                actions.hidden = false;
                return;
            }
            actionButton('\u270E', 'Rename', async () => {
                const name = prompt('Rename to:', one.name);
                if (name && name !== one.name) await runOp({ type: 'renamePath', path: absPath(one.name), name });
            }, { disabled: !one });
            actionButton('Copy', 'Copy to another folder', () => {
                clipboard = { mode: 'copy', paths: names.map(absPath) };
                setSelectMode(false);
            }, { disabled: !names.length });
            actionButton('Move', 'Move to another folder', () => {
                clipboard = { mode: 'move', paths: names.map(absPath) };
                setSelectMode(false);
            }, { disabled: !names.length });
            actionButton('\uD83D\uDDD1', 'Move to Trash', async () => {
                const what = names.length === 1 ? names[0] : names.length + ' items';
                const toTrash = names.every(n => wsClient.vfs.isServerPath(absPath(n)));
                if (toTrash ? !confirm(`Move ${what} to Trash?`)
                    : !confirm(`Delete ${what}? Only the server has a Trash: files elsewhere cannot be brought back. (A folder added with "Add folder" is only removed from the list.)`)) return;
                await runOp({ type: 'trashPaths', paths: names.map(absPath) });
            }, { disabled: !names.length, danger: true });
            actionButton('\u2715', 'Done', () => setSelectMode(false));
        } else if (clipboard) {
            const n = clipboard.paths.length;
            actions.appendChild(el('span', 'bm-count', `${clipboard.mode === 'copy' ? 'Copy' : 'Move'} ${n === 1 ? clipboard.paths[0].split('/').pop() : n + ' items'}`));
            if (readOnly) actions.appendChild(el('span', 'bm-count', '(archive is read-only)'));
            else actionButton('Paste here', 'Paste into this folder', async () => {
                const op = clipboard;
                clipboard = null;
                await runOp({ type: op.mode === 'copy' ? 'copyPaths' : 'movePaths', paths: op.paths, dest: cwd });
            });
            actionButton('\u2715', 'Cancel', () => { clipboard = null; render(); });
        }
        actions.hidden = !selectMode && !clipboard;
    }

    // --- Typed paths ---
    // A text box holding a path: Enter goes there (a folder is listed, a file opened),
    // Escape or leaving it puts the path back
    function pathBox(path, onDone) {
        const box = el('input', 'bm-path');
        box.type = 'text';
        box.value = path;
        box.spellcheck = false;
        box.autocapitalize = 'off';
        box.setAttribute('autocorrect', 'off');
        box.title = 'Type a path and press Enter';
        const done = () => { if (onDone) onDone(); };
        box.onkeydown = async (e) => {
            if (e.key === 'Escape') { box.value = path; box.blur(); done(); }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const target = box.value.trim();
            if (!target || target === path) { box.blur(); done(); return; }
            box.disabled = true;
            const ok = await goToPath(target);
            box.disabled = false;
            if (ok) done(); else box.focus();
        };
        box.onblur = () => { if (!box.disabled) { box.value = path; done(); } };
        return box;
    }

    // The folder path bar as a box, until Enter, Escape or a click elsewhere
    function editPath() {
        const box = pathBox(cwd || '/', () => { if (box.isConnected) renderCrumbs(); });
        crumbs.replaceChildren(box);
        box.focus();
        box.select();
    }
    crumbs.onclick = (e) => { if (e.target === crumbs) editPath(); };

    // Where a typed path leads: a folder (or archive) to list, a file to open. A path
    // the browser doesn't know may be the server's under its own name (/home/me → /server/home/me)
    async function goToPath(raw) {
        let p = '/' + raw.split('/').filter(s => s && s !== '.').reduce((acc, s) => {
            if (s === '..') acc.pop(); else acc.push(s);
            return acc;
        }, []).join('/');
        const kindOf = async (path) => {
            if (path === '/') return 'directory';
            const dir = path.slice(0, path.lastIndexOf('/')) || '/';
            const name = path.slice(path.lastIndexOf('/') + 1);
            try {
                const r = (isArchivePath(dir) && await listArchive(dir))
                    || await wsClient.wsRequest({ type: 'browseDir', path: dir, showHidden: true });
                if (r.error) return null;
                const f = (r.items || []).find(x => x.name === name);
                return f ? f.type : null;
            } catch (_) { return null; }
        };
        let kind = await kindOf(p);
        if (!kind && !p.startsWith('/server/')) {
            const k = await kindOf('/server' + p);
            if (k) { p = '/server' + p; kind = k; }
        }
        if (!kind) {
            alert('No such file or folder: ' + raw);
            return false;
        }
        const name = p.slice(p.lastIndexOf('/') + 1);
        if (kind === 'directory' || (isArchiveName(name) && !viewer)) {
            closeViewer();
            await navigate(p);
            return true;
        }
        const dir = p.slice(0, p.lastIndexOf('/')) || '/';
        if (name.startsWith('.') && !showHidden) {
            showHidden = true;
            savePref('hidden', '1');
        }
        await navigate(dir);
        const f = files.find(x => x.name === name);
        if (!f) {
            alert('No such file: ' + raw);
            return false;
        }
        await openFile(f);
        return true;
    }

    // --- Listing ---
    function renderCrumbs() {
        crumbs.innerHTML = '';
        const parts = cwd.split('/').filter(Boolean);
        const rootBtn = el('button', 'bm-crumb', '/');
        rootBtn.onclick = () => navigate('/');
        crumbs.appendChild(rootBtn);
        parts.forEach((part, i) => {
            if (i > 0) crumbs.appendChild(el('span', 'bm-sep', '/'));
            const b = el('button', 'bm-crumb', part);
            const target = '/' + parts.slice(0, i + 1).join('/');
            b.onclick = i === parts.length - 1 ? editPath : () => navigate(target);
            crumbs.appendChild(b);
        });
        if (!parts.length) rootBtn.onclick = editPath;
        crumbs.scrollLeft = crumbs.scrollWidth;
    }

    function sorted(items) {
        const dirs = items.filter(f => f.type === 'directory');
        const rest = items.filter(f => f.type !== 'directory');
        const cmp = sort === 'date' ? (a, b) => b.mtimeMs - a.mtimeMs
            : sort === 'size' ? (a, b) => b.size - a.size
            : () => 0; // server already sorts by name
        return [...dirs.sort(sort === 'size' ? () => 0 : cmp), ...rest.sort(cmp)];
    }

    function thumbnailRendererFor(file) {
        for (const plugin of getPlugins()) {
            for (const r of plugin.thumbnailRenderers || []) {
                try { if (r.canHandle(file)) return r; } catch (_) { /* ignore */ }
            }
        }
        return null;
    }

    // The top level: the in-browser shell's namespace, with the mounts
    function isRoot() {
        return cwd === '/';
    }

    function render() {
        hiddenBtn.classList.toggle('on', showHidden);
        mkdirBtn.hidden = newBtn.hidden = uploadBtn.hidden = readOnly;
        viewBtn.textContent = view === 'list' ? '▦' : '☰';
        upBtn.disabled = !parent || parent === cwd;
        renderActions();
        list.innerHTML = '';
        list.classList.toggle('bm-grid', view === 'grid');
        if (isRoot()) {
            const note = el('div', 'bm-empty', 'The in-browser shell\'s files (gone on reload), with '
                + (wsClient.isLocal() ? '' : 'the server\'s in server, ')
                + 'Browser storage (kept in this browser)'
                + (wsClient.vfs.canPickFolders() ? ' and folders from this computer ("+ Add folder").' : '. This browser cannot open folders from the computer.'));
            note.style.gridColumn = '1 / -1';
            list.appendChild(note);
        }
        if (thumbIO) thumbIO.disconnect();
        thumbIO = view === 'grid' ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                thumbIO.unobserve(entry.target);
                const { file, renderer } = entry.target._thumb;
                Promise.resolve(renderer.render(file, entry.target)).catch(() => {});
            }
        }, { root: list, rootMargin: '200px' }) : null;

        const shown = sorted(files).filter(f => !filter || f.name.toLowerCase().includes(filter));
        if (shown.length === 0) {
            list.appendChild(el('div', 'bm-empty', files.length ? 'No matches' : 'Empty directory'));
            return;
        }
        for (const f of shown) {
            const row = el('div', 'bm-row');
            const isDir = f.type === 'directory' || (isArchiveName(f.name) && f.type === 'file' && !f.encrypted && !isFlStudioProject(f));
            const ico = el('div', 'bm-ico', f.mount ? (f.mount === 'storage' ? '\uD83D\uDCBE' : f.mount === 'server' ? '\uD83D\uDDA5\uFE0F' : '\uD83D\uDDC2\uFE0F') : f.type === 'directory' ? ICONS.dir : (ICON_BY_EXT[extOf(f.name)] || ICONS.text));
            const txt = el('div', 'bm-txt');
            txt.appendChild(el('div', 'bm-name', f.name + (f.symlink ? ' →' : '')));
            txt.appendChild(el('div', 'bm-meta', (f.type === 'directory' ? '' : fmtSize(f.size) + ' · ') + fmtDate(f.mtimeMs)));
            if (selectMode) {
                const check = el('input', 'bm-check');
                check.type = 'checkbox';
                check.checked = selected.has(f.name);
                row.classList.toggle('sel', check.checked);
                row.appendChild(check);
            }
            row.append(ico, txt);
            row.onclick = () => {
                if (selectMode) toggleSelected(f.name);
                else if (isDir) navigate(absPath(f.name));
                else openFile(f);
            };
            // Long-press (Android fires contextmenu) or right-click starts selecting
            row.oncontextmenu = (e) => {
                e.preventDefault();
                selectMode = true;
                selected.add(f.name);
                if (navigator.vibrate) navigator.vibrate(20);
                render();
            };
            if (thumbIO && !isDir) {
                const renderer = thumbnailRendererFor(f);
                if (renderer) {
                    ico._thumb = { file: f, renderer };
                    thumbIO.observe(ico);
                }
            }
            list.appendChild(row);
        }
    }

    // List a folder inside a zip via the service worker (or the page, see archive-fallback.js). Returns null when the path
    // is not really an archive (e.g. a directory named "x.zip"), so the server lists it.
    async function listArchive(dir) {
        try {
            await ensureArchiveAccess();
        } catch (err) {
            return { path: dir, parent: dir.replace(/\/[^/]*$/, '') || '/', items: [], readOnly: true,
                error: 'Could not start archive browsing: ' + err.message };
        }
        const resp = await fetch('/zip-list?path=' + encodeURIComponent(dir));
        if (resp.status === 404 && /Cannot read/.test(await resp.clone().text())) return null;
        if (!resp.ok) {
            return { path: dir, parent: dir.replace(/\/[^/]*$/, '') || '/', items: [], readOnly: true, error: await resp.text() };
        }
        const result = await resp.json();
        result.readOnly = true;
        result.items = result.items.filter(item => showHidden || !item.name.startsWith('.'));
        for (const item of result.items) {
            if (item.type !== 'file') continue;
            const ext = extOf(item.name);
            if (item.encrypted) item.viewType = 'special';
            else if (SERVED_EXTENSIONS.has(ext)) item.viewType = ext;
            else if (item.size > MAX_TEXT_SIZE) item.viewType = 'binary';
            else item.lazy = true;
        }
        result.items.sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1)
            : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        return result;
    }

    async function navigate(dir, opts = {}) {
        let result = null;
        try {
            if (isArchivePath(dir)) result = await listArchive(dir);
            if (!result) result = await wsClient.wsRequest({ type: 'browseDir', path: dir, showHidden });
        } catch (err) {
            list.innerHTML = '';
            list.appendChild(el('div', 'bm-empty', 'Server not connected: ' + err.message));
            return;
        }
        const changedDir = result.path !== cwd;
        listedSig = listingSig(result);
        readOnly = !!result.readOnly;
        if (readOnly && selectMode && changedDir) selectMode = false;
        cwd = result.path;
        parent = result.parent;
        files = result.items.map(item => ({
            ...item,
            id: 'bf' + (nextId++),
            content: '',
            cursor: { row: 0, column: 0 },
            selection: null,
        }));
        setWorkspace(cwd, files);
        if (changedDir) {
            selected.clear();
            filter = '';
            filterInput.value = '';
        }
        addFolderBtn.hidden = !isRoot() || !wsClient.vfs.canPickFolders();
        renderCrumbs();
        render();
        if (changedDir) list.scrollTop = 0;
        if (result.error) {
            const box = el('div', 'bm-empty', result.error);
            // An archive-looking name that isn't one (a .img that is no disk image, say): open the file itself
            const name = cwd.split('/').pop();
            if (isArchiveName(name)) {
                const open = el('button', 'bm-btn', 'Open the file itself');
                open.style.marginLeft = '8px';
                open.onclick = async () => {
                    await navigate(parent);
                    const f = files.find(x => x.name === name);
                    if (f) openFile(f);
                };
                box.appendChild(open);
            }
            list.prepend(box);
        }

        const url = location.pathname + '?browse=' + encodeURIComponent(cwd);
        if (opts.fromHistory) return;
        if (opts.replace || !history.state) history.replaceState({ dir: cwd }, '', url);
        else if (changedDir) history.pushState({ dir: cwd }, '', url);
    }

    // Shown again when what it lists changes: the shell's files when Wanix says so
    // (CHANGE_EVENT in src/wanix-plugin.js), browser storage and picked folders when
    // the window comes back (other tabs and programs change those)
    let listedSig = '';
    let relisting = false; // a listing under way, and whether a change came meanwhile
    let changedMeanwhile = false;
    function listingSig(result) {
        return JSON.stringify([result.path, result.error || '', (result.items || []).map(i => [i.name, i.type, i.size, i.mtimeMs])]);
    }
    async function relist() {
        if (cwd === null || document.hidden || viewer || isArchivePath(cwd) || wsClient.vfs.isServerPath(cwd)) return;
        if (relisting) { changedMeanwhile = true; return; }
        relisting = true;
        do {
            changedMeanwhile = false;
            try {
                const dir = cwd;
                const result = await wsClient.wsRequest({ type: 'browseDir', path: dir, showHidden });
                if (dir === cwd && listingSig(result) !== listedSig) await navigate(cwd, { replace: true });
            } catch (_) { /* shown at the next navigation */ }
        } while (changedMeanwhile);
        relisting = false;
    }
    window.addEventListener('gle-wanix-change', (e) => {
        const here = cwd && (cwd.split('/').filter(Boolean).join('/') || '.');
        if (here && e.detail.dirs.includes(here)) relist();
    });
    window.addEventListener('focus', relist);
    document.addEventListener('visibilitychange', relist);

    // --- Viewer ---
    function closeViewer() {
        if (!viewer) return;
        try { viewer.container.emit('destroy'); } catch (err) { log.warn('Viewer destroy failed:', err); }
        viewer.resizeObserver.disconnect();
        viewer.panel.remove();
        viewer = null;
        relist(); // what changed while it was open (the shell's files, from a terminal)
    }

    async function ensureLoaded(file) {
        if (!file.lazy) return;
        // Raw bytes over HTTP (the service worker answers for files inside archives),
        // decoded here so the viewer can switch encodings
        const resp = await fetch('/workspace-file?path=' + encodeURIComponent(absPath(file.name)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const detected = await detectEncoding(bytes);
        // The first bytes, for viewers chosen by magic number (DICOM's DICM at 128)
        file.head = bytes.slice(0, 512);
        if (detected.binary) {
            file.viewType = 'binary';
        } else {
            file.bytes = bytes;
            file.encoding = file.detectedEncoding = detected.encoding;
            file.content = decodeBytes(bytes, detected.encoding);
        }
        delete file.lazy;
    }

    function candidateViewers(file) {
        const viewers = viewersForFile(file.id).filter(v => components[v.componentType]);
        if (PLAYABLE.test(file.name)) {
            const i = viewers.findIndex(v => v.componentType === 'editor');
            if (i > 0) viewers.unshift(...viewers.splice(i, 1));
        }
        return viewers;
    }

    async function openFile(file, opts = {}) {
        if (file.viewType === 'special') {
            alert(`${file.name} is not a regular file.`);
            return;
        }
        try {
            await ensureLoaded(file);
        } catch (err) {
            alert(`Could not read ${file.name}: ${err.message}`);
            return;
        }
        const viewers = candidateViewers(file);
        openViewer(viewers[opts.viewerIndex || 0], { file, viewers, viewerIndex: opts.viewerIndex || 0 });
        if (!opts.fromHistory) history.pushState({ dir: cwd, file: file.name }, '', location.href);
    }

    function openViewer(v, info = {}) {
        closeViewer();
        const panel = el('div', 'bm-viewer');
        const vbar = el('div', 'bm-bar');
        const back = el('button', 'bm-btn', '←');
        back.onclick = () => history.state && history.state.file ? history.back() : closeViewer();
        // A file's whole path, in a box to select, copy or type another path into
        const title = info.file ? pathBox(cwd.replace(/\/$/, '') + '/' + info.file.name)
            : el('div', 'bm-viewer-title', v.title);
        vbar.append(back, title);

        if (info.viewers && info.viewers.length > 1) {
            const pick = el('select', 'bm-select');
            info.viewers.forEach((cand, i) => {
                const o = el('option', null, cand.componentType === 'editor' ? 'View' : (cand.title.match(/\[(.+)\]$/) || [, cand.componentType])[1]);
                o.value = String(i);
                pick.appendChild(o);
            });
            pick.value = String(info.viewerIndex);
            pick.onchange = () => openViewer(info.viewers[+pick.value], { ...info, viewerIndex: +pick.value });
            vbar.appendChild(pick);
        }
        if (info.file) {
            const dl = el('a', 'bm-btn', '⬇');
            dl.title = 'Download';
            const dlPath = cwd.replace(/\/$/, '') + '/' + info.file.name;
            dl.href = '/download-file?path=' + encodeURIComponent(dlPath);
            dl.onclick = (e) => {
                if (!readOnly && wsClient.vfs.isServerPath(dlPath)) return; // a file on the server: the link itself
                e.preventDefault();
                downloadFile(dlPath).catch(err => alert(`Could not download ${info.file.name}: ${err.message}`));
            };
            vbar.appendChild(dl);
        }

        const body = el('div', 'bm-viewer-body');
        panel.append(vbar, body);
        document.body.appendChild(panel);
        if (info.file) title.scrollLeft = title.scrollWidth;

        const listeners = {};
        const container = {
            element: body,
            on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
            emit(event, ...args) { (listeners[event] || []).forEach(cb => cb(...args)); },
            getState() { return v.state; },
            setTitle(t) { title.textContent = t; },
        };
        const Comp = components[v.componentType];
        try {
            const instance = new Comp(container, v.state);
            container.componentReference = instance;
            if (instance && instance.editor) {
                // Text in browse mode is read-only; don't pop the phone keyboard
                instance.editor.setReadOnly(true);
                instance.editor.blur();
                // Text controls get their own row: the header is too narrow on a phone
                const textbar = el('div', 'bm-bar bm-textbar');
                panel.insertBefore(textbar, body);
                addTextControls(instance.editor, textbar, body);
                if (info.file && info.file.bytes) addEncodingSelect(instance, info.file, textbar);
            }
        } catch (err) {
            body.textContent = 'Failed to open viewer: ' + err.message;
            log.error('Viewer failed:', err);
        }
        const resizeObserver = new ResizeObserver(() => container.emit('resize'));
        resizeObserver.observe(body);
        viewer = { panel, container, resizeObserver, file: info.file };
        requestAnimationFrame(() => container.emit('show'));
    }

    // Text size: A−/A+ buttons and two-finger pinch (Ace swallows the browser's own pinch zoom)
    // Encoding picker: re-decode the file's bytes in place
    function addEncodingSelect(instance, file, bar) {
        const pick = el('select', 'bm-select bm-enc');
        pick.title = 'Text encoding';
        for (const [label, desc] of ENCODINGS) {
            const o = el('option', null, label === file.detectedEncoding ? `${desc} (detected)` : desc);
            o.value = label;
            pick.appendChild(o);
        }
        if (!ENCODINGS.some(([label]) => label === file.encoding)) {
            const o = el('option', null, file.encoding + ' (detected)');
            o.value = file.encoding;
            pick.prepend(o);
        }
        pick.value = file.encoding;
        pick.onchange = () => {
            file.encoding = pick.value;
            file.content = decodeBytes(file.bytes, file.encoding);
            // Suppress the editor's change handler: it would mark the file dirty and
            // could autosave the re-decoded text over the original bytes
            instance._suppressChangeEvents = true;
            try { instance.editor.setValue(file.content, -1); } finally { instance._suppressChangeEvents = false; }
        };
        bar.insertBefore(pick, viewerButtonAnchor(bar));
    }

    // Text viewer toggles: line wrap and hidden characters (tabs, spaces, line ends)
    function addTextControls(editor, bar, body) {
        const toggle = (label, title, key, def, applyFn) => {
            const btn = el('button', 'bm-btn', label);
            btn.title = title;
            let on = loadPref(key, def) === '1';
            const set = (v) => { on = v; applyFn(v); btn.classList.toggle('on', v); savePref(key, v ? '1' : '0'); };
            btn.onclick = () => set(!on);
            set(on);
            bar.insertBefore(btn, viewerButtonAnchor(bar));
        };
        addFontControls(editor, bar, body);
        toggle('↩', 'Wrap long lines', 'wrap', '1', v => editor.setOption('wrap', v));
        toggle('¶', 'Show hidden characters', 'invisibles', '0', v => editor.setShowInvisibles(v));
    }

    function addFontControls(editor, bar, body) {
        let size = +loadPref('font', '14') || 14;
        const apply = (px) => {
            size = Math.max(8, Math.min(40, Math.round(px)));
            editor.setFontSize(size + 'px');
            savePref('font', String(size));
        };
        apply(size);
        const minus = el('button', 'bm-btn', 'A−');
        const plus = el('button', 'bm-btn', 'A+');
        minus.title = 'Smaller text';
        plus.title = 'Larger text';
        minus.onclick = () => apply(size - 1);
        plus.onclick = () => apply(size + 1);
        bar.insertBefore(plus, viewerButtonAnchor(bar));
        bar.insertBefore(minus, plus);

        let start = null;
        const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        body.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) start = { d: dist(e.touches), size };
        }, { capture: true, passive: true });
        body.addEventListener('touchmove', (e) => {
            if (!start || e.touches.length !== 2) return;
            e.preventDefault();
            e.stopPropagation();
            apply(start.size * dist(e.touches) / start.d);
        }, { capture: true, passive: false });
        body.addEventListener('touchend', (e) => { if (e.touches.length < 2) start = null; }, { capture: true, passive: true });
    }
    // Insert point for extra viewer buttons: before the "Open with" select / download button
    function viewerButtonAnchor(bar) {
        return bar.querySelector('.bm-select') || bar.querySelector('a.bm-btn') || null;
    }

    window.addEventListener('popstate', async (e) => {
        const state = e.state || {};
        if (!state.file) closeViewer();
        if (state.dir && state.dir !== cwd) await navigate(state.dir, { fromHistory: true });
        if (state.file && (!viewer || !viewer.file || viewer.file.name !== state.file)) {
            const f = files.find(x => x.name === state.file);
            if (f) openFile(f, { fromHistory: true });
        }
    });

    // --- Start ---
    const socket = await wsClient.wsReady;
    if (!socket) {
        list.appendChild(el('div', 'bm-empty', 'File browser needs the server (WebSocket not connected), or a browser that can open local folders.'));
        return;
    }
    const start = new URLSearchParams(location.search).get('browse');
    await navigate(start || '', { replace: true });
    log.log('Browse mode ready at', cwd, '(' + Object.keys(getProjectFiles()).length + ' entries)');
}

module.exports = { initBrowseMode, insideArchive, SERVED_EXTENSIONS, MAX_TEXT_SIZE };
