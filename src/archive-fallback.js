// --- Archive browsing without the service worker ---
// Files inside archives (/home/me/a.zip/docs/x.png) are normally answered by the
// service worker (public/zip-sw.js). Browsers only run service workers on https
// and localhost, so when the page comes from a plain-http address (a LAN host
// name) it runs that same code itself: zip-sw.js is loaded as a script and the
// page's fetch() is routed through its handleZipFetch(). What fetch() doesn't
// cover - element src attributes, workers - goes through resolveFileUrl() (a
// blob: URL for files inside archives) or fetch() on the page's behalf.
//
// The page also answers for files that exist only in memory (decrypted
// contents, see gpg-plugin.js): they live under a ".in-memory-<token>" folder
// that is never on disk, and their /workspace-file URLs are answered from
// memory by fetch() and resolveFileUrl(), so their bytes never reach the server.

// Files the server doesn't have (the in-browser shell's, the browser's folders: src/vfs.js)
// are answered by the page too
const vfs = require('./vfs');

const ARCHIVE_URL_RE = /\/(workspace-file|download-file|zip-list)\?/;
const BLOB_URL_LIMIT = 64;

// A path inside an in-memory folder (ws-client.js refuses to send these to the server)
const MEMORY_PATH_RE = /(^|\/)\.in-memory-[0-9a-z]+(\/|$)/;

let pageFallback = null; // Promise, once the page answers archive paths itself
const blobUrls = new Map(); // request URL -> blob: URL (oldest first)

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

const memoryFiles = new Map(); // absolute path -> { blob, url (blob: URL, made when first asked for) }
let memoryFetchInstalled = false;

function isMemoryPath(p) {
    return !!p && MEMORY_PATH_RE.test(p);
}

function memoryPathOf(url) {
    if (!/\/(workspace-file|download-file)\?/.test(url)) return null;
    const p = new URL(url, location.href).searchParams.get('path');
    return isMemoryPath(p) ? p : null;
}

// fetch() of an in-memory file, answered here; null for any other request
function memoryFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const p = memoryPathOf(url);
    if (!p) return null;
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    const entry = method.toUpperCase() === 'GET' && memoryFiles.get(p);
    return Promise.resolve(entry ? new Response(entry.blob, { headers: { 'Content-Type': entry.blob.type || 'application/octet-stream' } })
        : new Response('Not found (in-memory file)', { status: 404 }));
}

// Make bytes readable at path (an absolute path inside an in-memory folder)
function addMemoryFile(path, bytes, type) {
    if (!isMemoryPath(path)) throw new Error('Not an in-memory path: ' + path);
    removeMemoryFile(path);
    memoryFiles.set(path, { blob: new Blob([bytes], { type: type || '' }), url: null });
    if (!memoryFetchInstalled) {
        memoryFetchInstalled = true;
        const net = window.fetch.bind(window);
        window.fetch = function (input, init) {
            return memoryFetch(input, init) || net(input, init);
        };
    }
}

function removeMemoryFile(path) {
    const entry = memoryFiles.get(path);
    if (!entry) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    memoryFiles.delete(path);
}

function installPageFallback() {
    if (!pageFallback) {
        pageFallback = (async () => {
            await loadScript('https://esm.sh/fzstd@0.1.1/umd/index.js?raw');
            await loadScript('zip-sw.js');
            const net = window.fetch.bind(window);
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
                if (method.toUpperCase() === 'GET' && ARCHIVE_URL_RE.test(url)) {
                    // In-memory files first: one decrypted from inside an archive has an archive-looking path
                    const answer = memoryFetch(input, init) || window.handleZipFetch(new Request(input, init));
                    if (answer) return answer;
                }
                return net(input, init);
            };
        })().catch(err => {
            pageFallback = null;
            throw err;
        });
    }
    return pageFallback;
}

// Resolves once files inside archives can be read, by the service worker or,
// where there is none (or it never takes control), by the page itself
async function ensureArchiveAccess() {
    if (pageFallback) return pageFallback;
    if ('serviceWorker' in navigator) {
        if (navigator.serviceWorker.controller) return;
        const controlled = await new Promise((resolve) => {
            const done = (ok) => { clearTimeout(timer); resolve(ok); };
            const timer = setTimeout(() => done(!!navigator.serviceWorker.controller), 4000);
            navigator.serviceWorker.addEventListener('controllerchange', () => done(true), { once: true });
        });
        if (controlled) return;
    }
    return installPageFallback();
}

function isArchiveFileUrl(url) {
    if (!/\/(workspace-file|download-file)\?/.test(url)) return false;
    const p = new URL(url, location.href).searchParams.get('path') || '';
    return p.split('/').slice(0, -1).some(seg => window.archiveKind && window.archiveKind(seg));
}

// A URL for an element's src (or anything else the page's fetch() doesn't
// reach): unchanged, unless the page answers archive paths itself
async function resolveFileUrl(url) {
    // A file the server doesn't have: a blob: URL. The service worker can't answer
    // for the shell's files, nor navigations outside its scope (iframes, on a host
    // that serves the editor from a subfolder)
    if (url && /\/workspace-file\?/.test(url) && !isArchiveFileUrl(url) && !memoryPathOf(url)) {
        const blobUrl = await vfs.blobUrlFor(new URL(url, location.href).searchParams.get('path'));
        if (blobUrl) return blobUrl;
    }
    const memPath = url && memoryPathOf(url);
    if (memPath) {
        const entry = memoryFiles.get(memPath);
        if (!entry) throw new Error('In-memory file is gone: ' + memPath);
        if (!entry.url) entry.url = URL.createObjectURL(entry.blob);
        return entry.url;
    }
    if (!pageFallback || !url || !isArchiveFileUrl(url)) return url;
    await pageFallback;
    if (blobUrls.has(url)) return blobUrls.get(url);
    const resp = await window.fetch(url);
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
    const blobUrl = URL.createObjectURL(await resp.blob());
    blobUrls.set(url, blobUrl);
    if (blobUrls.size > BLOB_URL_LIMIT) {
        const [oldest, oldBlob] = blobUrls.entries().next().value;
        blobUrls.delete(oldest);
        URL.revokeObjectURL(oldBlob);
    }
    return blobUrl;
}

// Download a file; one inside an archive is read by the page when it answers
// archive paths itself (the server can't look inside archives)
async function downloadFile(path) {
    if (isMemoryPath(path)) throw new Error('decrypted contents are not saved');
    const url = '/download-file?path=' + encodeURIComponent(path);
    const serverHasIt = (await vfs.where(path).catch(() => ({}))).kind === 'server';
    if (!serverHasIt && !isArchiveFileUrl(url)) {
        saveBlob(await vfs.read(path), path);
        return;
    }
    if (!serverHasIt) await ensureArchiveAccess(); // no server to send the browser to
    else if (!pageFallback || !isArchiveFileUrl(url)) {
        location.href = url;
        return;
    }
    else await pageFallback;
    const resp = await window.fetch(url);
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
    saveBlob(await resp.blob(), path);
}

function saveBlob(blob, path) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = path.slice(path.lastIndexOf('/') + 1);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Whether workers (which have their own fetch) need the page to read for them
function pageReadsArchives() {
    return !!pageFallback;
}

module.exports = { ensureArchiveAccess, resolveFileUrl, pageReadsArchives, downloadFile, isMemoryPath, addMemoryFile, removeMemoryFile };
