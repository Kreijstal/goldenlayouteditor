// --- HEIF / HEIC (.heic, .heif, .hif) ---
// Only Safari shows HEIC (an iPhone's photos, a Canon/Fujifilm .hif), and only
// its primary image. So these files are decoded in a worker
// (public/heif-worker.js: libheif and libde265 as WebAssembly) to a PNG an
// image at a time, which any <img> shows; the image viewer steps through the
// images of a collection (a burst, a Live Photo's still) with the TIFF pager.
// AVIF is HEIF too, but every browser shows it, so .avif isn't decoded here.
const { createLogger } = require('./debug');

const log = createLogger('HEIF');
const HEIF_RE = /\.(heic|heif|hif)$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<Uint8Array>
const decoded = new Map(); // source URL + '#' + page -> Promise<{ url, pages, page }>

function isHeifName(name) {
    return HEIF_RE.test(name || '');
}

// { pages: [{ width, height, label }], page, image (PNG bytes), type }
function heifDecode(bytes, page) {
    if (!worker) {
        worker = new Worker('/heif-worker.js');
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'HEIF decoder failed to load'));
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

// Image `page` of the HEIF at url (0 is the primary image): { url (a blob: URL
// an <img> shows), pages: [{ width, height, label }], page }
function heifPage(url, page = 0) {
    const key = url + '#' + page;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            const r = await heifDecode(await fileBytes(url), page);
            return { url: URL.createObjectURL(new Blob([r.image], { type: r.type })), pages: r.pages, page: r.page };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('HEIF decode failed:', err); });
        if (decoded.size > 32) {
            const [oldKey, old] = decoded.entries().next().value;
            decoded.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isHeifName, heifDecode, heifPage };
