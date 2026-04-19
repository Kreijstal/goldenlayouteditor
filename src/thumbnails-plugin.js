// --- Thumbnails Plugin ---
// Adds thumbnail renderers for the file browser grid/icon view. Each
// renderer implements { canHandle(file), render(file, container) } and is
// picked up by ProjectFilesComponent when a file card comes into view.
const { registerPlugin } = require('./plugins');

let _ctx = null;
let _pdfLib = null;
let _pdfLibPromise = null;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogg', 'mov']);
const PDF_EXTS = new Set(['pdf']);

function extOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function workspaceUrl(file) {
    if (!_ctx || !_ctx.currentWorkspacePath) return null;
    const rel = _ctx.getRelativePath(file.id);
    if (!rel) return null;
    return '/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel);
}

// Ask the server (over the WebSocket) for a pre-generated thumbnail.
// Returns a data URL on hit, or null if the server has nothing and the
// client should fall back to local rendering. Results are cached per
// absolute path for the session so multiple renderers / re-scrolls don't
// hit the server repeatedly.
const _serverThumbnailProbes = new Map(); // fileAbsPath -> Promise<dataUrl|null>

async function getServerThumbnail(file, size = 96) {
    if (!_ctx || !_ctx.currentWorkspacePath) return null;
    const ws = _ctx.wsClient;
    if (!ws || !ws.isConnected || !ws.isConnected()) return null;
    const rel = _ctx.getRelativePath(file.id);
    if (!rel) return null;
    const abs = _ctx.currentWorkspacePath + '/' + rel;
    if (_serverThumbnailProbes.has(abs)) return _serverThumbnailProbes.get(abs);
    const p = (async () => {
        try {
            const result = await ws.wsRequest({ type: 'getThumbnail', path: abs, size });
            if (!result || !result.success || !result.data) return null;
            const mime = result.mimeType || 'image/png';
            return `data:${mime};base64,${result.data}`;
        } catch (_) {
            return null;
        }
    })();
    _serverThumbnailProbes.set(abs, p);
    return p;
}

function paintImage(container, src) {
    clearContainer(container);
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;';
    container.appendChild(img);
    return img;
}

// Wrap a client-side renderer so it tries the server cache first.
function withServerFallback(clientRenderer) {
    return async function wrapped(file, container) {
        const serverUrl = await getServerThumbnail(file);
        if (serverUrl) {
            const img = paintImage(container, serverUrl);
            img.onerror = () => {
                // Server lied or the image is broken — invalidate its cache
                // entry and fall back to the local renderer
                try {
                    if (_ctx && _ctx.currentWorkspacePath) {
                        const rel = _ctx.getRelativePath(file.id);
                        if (rel) _serverThumbnailProbes.delete(_ctx.currentWorkspacePath + '/' + rel);
                    }
                } catch (_) { /* ignore */ }
                container.textContent = '';
                Promise.resolve(clientRenderer(file, container)).catch(() => {});
            };
            return;
        }
        return clientRenderer(file, container);
    };
}

function clearContainer(container) {
    container.textContent = '';
    container.style.fontSize = '';
}

// Session cache: fileId -> rendered dataURL / blob URL. Keeps scroll snappy.
const _thumbCache = new Map();

function cachedThumb(fileId) {
    return _thumbCache.get(fileId) || null;
}
function setCached(fileId, url) {
    _thumbCache.set(fileId, url);
}

// --- Image renderer ---------------------------------------------------------

function renderImageClient(file, container) {
    const url = workspaceUrl(file);
    if (!url) return;
    const img = paintImage(container, url);
    img.onerror = () => {
        container.textContent = '\uD83D\uDDBC';
    };
}

const imageRenderer = {
    canHandle(file) {
        if (file.type !== 'file') return false;
        return IMAGE_EXTS.has(extOf(file.name));
    },
    render: withServerFallback(renderImageClient),
};

// --- Video renderer ---------------------------------------------------------

function renderVideoThumbnail(file, container) {
    const cached = cachedThumb(file.id);
    if (cached) {
        clearContainer(container);
        const img = document.createElement('img');
        img.src = cached;
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
        container.appendChild(img);
        return;
    }
    const url = workspaceUrl(file);
    if (!url) return;
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';

    let done = false;
    const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        video.src = '';
        container.textContent = '\uD83C\uDFAC';
    }, 8000);

    video.addEventListener('loadedmetadata', () => {
        try {
            video.currentTime = Math.min(1, (video.duration || 2) / 2);
        } catch (_) { /* ignore */ }
    });

    video.addEventListener('seeked', () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        try {
            const w = 96, h = 96;
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            const vw = video.videoWidth || w;
            const vh = video.videoHeight || h;
            const scale = Math.min(w / vw, h / vh);
            const dw = vw * scale, dh = vh * scale;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
            const dataUrl = canvas.toDataURL('image/png');
            setCached(file.id, dataUrl);

            clearContainer(container);
            const img = document.createElement('img');
            img.src = dataUrl;
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
            container.appendChild(img);
        } catch (err) {
            container.textContent = '\uD83C\uDFAC';
        } finally {
            video.src = '';
        }
    });

    video.addEventListener('error', () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        container.textContent = '\uD83C\uDFAC';
    });

    // Kick metadata load
    video.load();
}

const videoRenderer = {
    canHandle(file) {
        if (file.type !== 'file') return false;
        return VIDEO_EXTS.has(extOf(file.name));
    },
    render: withServerFallback(renderVideoThumbnail),
};

// --- PDF renderer -----------------------------------------------------------

async function loadPdfLib() {
    if (_pdfLib) return _pdfLib;
    if (_pdfLibPromise) return _pdfLibPromise;
    _pdfLibPromise = import('https://esm.sh/pdfjs-dist@4.9.155/build/pdf.mjs').then(lib => {
        lib.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.9.155/build/pdf.worker.mjs';
        _pdfLib = lib;
        return lib;
    });
    return _pdfLibPromise;
}

async function renderPdfThumbnail(file, container) {
    const cached = cachedThumb(file.id);
    if (cached) {
        clearContainer(container);
        const img = document.createElement('img');
        img.src = cached;
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
        container.appendChild(img);
        return;
    }
    const url = workspaceUrl(file);
    if (!url) return;
    try {
        const lib = await loadPdfLib();
        const pdf = await lib.getDocument(url).promise;
        const page = await pdf.getPage(1);
        const target = 96;
        const viewport1 = page.getViewport({ scale: 1 });
        const scale = Math.min(target / viewport1.width, target / viewport1.height);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const dataUrl = canvas.toDataURL('image/png');
        setCached(file.id, dataUrl);

        clearContainer(container);
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
        container.appendChild(img);
    } catch (err) {
        container.textContent = '\uD83D\uDCC4';
    }
}

const pdfRenderer = {
    canHandle(file) {
        if (file.type !== 'file') return false;
        return PDF_EXTS.has(extOf(file.name));
    },
    render: withServerFallback(renderPdfThumbnail),
};

registerPlugin({
    id: 'thumbnails',
    name: 'Thumbnails',
    thumbnailRenderers: [imageRenderer, videoRenderer, pdfRenderer],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { _thumbCache };
