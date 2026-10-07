// --- TIFF (.tif, .tiff) ---
// Only Safari shows TIFF, and only its first page. So .tif files are decoded in
// a worker (public/tiff-worker.js: UTIF.js, and LibTIFF for LogLuv HDR) to a
// PNG a page at a time, which any <img> shows; the image viewer steps through
// the pages of a multi-page TIFF (a fax, a scan).
const { createLogger } = require('./debug');

const log = createLogger('TIFF');
const TIFF_RE = /\.tiff?$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<Uint8Array>
const decoded = new Map(); // source URL + '#' + page -> Promise<{ url, pages, page }>

function isTiffName(name) {
    return TIFF_RE.test(name || '');
}

// { pages: [{ width, height, label }], page, image (PNG or JPEG bytes), type }
function tiffDecode(bytes, page) {
    if (!worker) {
        worker = new Worker('/tiff-worker.js');
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'TIFF decoder failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer, page }, [copy.buffer]);
    });
}

function fileBytes(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return new Uint8Array(await resp.arrayBuffer());
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: a page turn reads the file again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// Page `page` of the TIFF at url: { url (a blob: URL an <img> shows), pages: [{ width, height, label }], page }
function tiffPage(url, page = 0) {
    const key = url + '#' + page;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            const r = await tiffDecode(await fileBytes(url), page);
            return { url: URL.createObjectURL(new Blob([r.image], { type: r.type })), pages: r.pages, page: r.page };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('TIFF decode failed:', err); });
        if (decoded.size > 64) {
            const [oldKey, old] = decoded.entries().next().value;
            decoded.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Page buttons over an image viewer's <img> for a TIFF with more than one page
// (root is the viewer's element, positioned); pageOf(url, page) is how a page
// is decoded, tiffPage's for a TIFF (src/heif.js's for a HEIF collection)
function addTiffPager(root, img, url, pages, pageOf = tiffPage) {
    if (pages.length < 2) return null;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:4px;align-items:center;z-index:1;'
        + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 4px;font:12px sans-serif;';
    const button = (text, title) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText = 'background:none;color:inherit;border:none;font:inherit;font-size:14px;cursor:pointer;padding:2px 6px;';
        bar.appendChild(b);
        return b;
    };
    const prev = button('‹', 'Previous page');
    const info = document.createElement('span');
    bar.appendChild(info);
    const next = button('›', 'Next page');
    let page = 0;
    let turn = 0;
    const show = async n => {
        page = Math.max(0, Math.min(pages.length - 1, n));
        const p = pages[page];
        info.textContent = `${page + 1} / ${pages.length}`;
        info.title = p.label + (p.width ? `, ${p.width}×${p.height}` : '');
        prev.disabled = page === 0;
        next.disabled = page === pages.length - 1;
        const mine = ++turn;
        try {
            const d = await pageOf(url, page);
            if (mine === turn) img.src = d.url;
        } catch (err) {
            if (mine === turn) info.textContent = `${page + 1} / ${pages.length}: ${err.message}`;
        }
    };
    prev.onclick = () => show(page - 1);
    next.onclick = () => show(page + 1);
    root.tabIndex = root.tabIndex >= 0 ? root.tabIndex : 0;
    root.addEventListener('keydown', e => {
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { show(page + 1); e.preventDefault(); }
        else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { show(page - 1); e.preventDefault(); }
    });
    root.appendChild(bar);
    show(0);
    return bar;
}

module.exports = { isTiffName, tiffDecode, tiffPage, addTiffPager };
