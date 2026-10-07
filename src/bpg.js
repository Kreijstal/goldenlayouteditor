// --- BPG, Better Portable Graphics (.bpg) ---
// Fabrice Bellard's format (bellard.org/bpg): an HEVC intra frame (and inter
// frames for an animation) in a small header. No browser shows it; Bellard's
// answer was a JS decoder that swaps <img> tags for canvases. Here a worker
// (public/bpg-worker.js: libbpg as WebAssembly) decodes the file to a PNG, or
// an APNG for an animation, which any <img> shows (and plays, and the frame
// viewer steps through): 8 to 14 bits, gray, YCbCr/YCgCo/RGB, alpha
// (premultiplied too) and CMYK, as bpgdec shows them.
const { createLogger } = require('./debug');

const log = createLogger('BPG');
const BPG_RE = /\.bpg$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const decoded = new Map(); // source URL -> Promise<{ url, width, height, frames, loops, label }>

function isBpgName(name) {
    return BPG_RE.test(name || '');
}

// Bytes that start a BPG file: "BPG", 0xFB
function isBpg(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x42 && bytes[1] === 0x50 && bytes[2] === 0x47 && bytes[3] === 0xfb;
}

// { png: Uint8Array (a PNG, or an APNG for animations), width, height, frames, loops, label }
function bpgDecode(bytes) {
    if (!worker) {
        worker = new Worker('/bpg-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'BPG decoder failed to load'));
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

// The BPG file at url as a PNG (APNG if animated):
// { url (a blob: URL), width, height, frames, loops, label }
function bpgImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = await bpgDecode(new Uint8Array(await resp.arrayBuffer()));
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height,
                frames: r.frames, loops: r.loops, label: r.label };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('BPG decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isBpgName, isBpg, bpgDecode, bpgImage };
