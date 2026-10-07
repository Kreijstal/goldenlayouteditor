// --- JPEG 2000 (.jp2, .j2k, .j2c, .jpc, .jpf, .jpx, .jph, .jhc) ---
// No browser shows JPEG 2000 (Safari did, until 17). So these files are
// decoded in a worker (public/jp2-worker.js: OpenJPEG as WebAssembly, the
// build pdf.js uses) to a PNG, which any <img> shows. HTJ2K (.jph, .jhc) too.
const { createLogger } = require('./debug');

const log = createLogger('JP2');
const JP2_RE = /\.(jp2|j2k|j2c|jpc|jpf|jpx|jph|jhc)$/i;

let worker = null;
let nextId = 1;
const pending = new Map();

function isJp2Name(name) {
    return JP2_RE.test(name || '');
}

// { png: Uint8Array, width, height }
function jp2Decode(bytes) {
    if (!worker) {
        worker = new Worker('/jp2-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'JPEG 2000 decoder failed to load'));
            pending.clear();
            worker = null;
            log.warn('JPEG 2000 worker failed:', e.message);
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
    });
}

module.exports = { isJp2Name, jp2Decode };
