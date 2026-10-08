// --- FLIF, the Free Lossless Image Format (.flif) ---
// Jon Sneyers and Pieter Wuille's format (flif.info, frozen as FLIF16 in
// 2016, since superseded by JPEG XL): MANIAC-coded, interlaced or not, gray,
// RGB or RGBA, 8 or 16 bits, animations. No browser shows it. Here a worker
// (public/flif-worker.js: libflif's decoder as WebAssembly) decodes the file to
// a PNG, or an APNG for an animation, which any <img> shows (and plays, and the
// frame viewer steps through); 16-bit samples are rounded to 8.
const { createLogger } = require('./debug');

const log = createLogger('FLIF');
const FLIF_RE = /\.flif$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const decoded = new Map(); // source URL -> Promise<{ url, width, height, frames, loops, label }>

function isFlifName(name) {
    return FLIF_RE.test(name || '');
}

// Bytes that start a FLIF file: "FLIF"
function isFlif(bytes) {
    return bytes.length >= 6 && bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x49 && bytes[3] === 0x46;
}

// { png: Uint8Array (a PNG, or an APNG for animations), width, height, frames, loops, label }
function flifDecode(bytes) {
    if (!worker) {
        worker = new Worker('/flif-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'FLIF decoder failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
    });
}

// The FLIF file at url as a PNG (APNG if animated):
// { url (a blob: URL), width, height, frames, loops, label }
function flifImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = await flifDecode(new Uint8Array(await resp.arrayBuffer()));
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height,
                frames: r.frames, loops: r.loops, label: r.label };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('FLIF decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isFlifName, isFlif, flifDecode, flifImage };
