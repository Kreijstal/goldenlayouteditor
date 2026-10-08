// --- PGF, the Progressive Graphics File (a .pgf that starts "PGF") ---
// Christoph Stamm's wavelet format (libpgf, xeraina.ch; digiKam keeps its
// thumbnails in it): a 5/3 wavelet pyramid, coarsest level first, lossless or
// lossy. No browser shows it. Here a worker (public/pgf-worker.js: pgfjs, a
// JavaScript decoder that agrees with libpgf sample for sample) decodes it to a
// PNG any <img> shows: black and white, gray (8, 16, 31 bits), indexed color,
// RGB (4:4:4, 5:6:5, 8 and 16 bits), RGBA, CMYK (8 and 16), L*a*b* (8 and 16),
// HSL and HSB, regions of interest too. Its levels are the image at 1/2, 1/4...
// of its size from the first part of the file alone; the viewer offers them,
// and thumbnails are decoded from the smallest one big enough.
// .pgf is far more often PGF/TikZ's (TeX, text): only a file that starts
// "PGF" and a version byte is a picture (isPgf); any other stays text.
const { createLogger } = require('./debug');

const log = createLogger('PGF');
const PGF_RE = /\.pgf$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<Uint8Array>
const decoded = new Map(); // source URL + '#' + level -> Promise<{ url, width, height, fullWidth, fullHeight, level, levels, label }>

// Whether the name is one a PGF picture goes by (it is one only once its bytes
// say so, see isPgf: PGF/TikZ pictures have the name too)
function isPgfName(name) {
    return PGF_RE.test(name || '');
}

// Bytes that start a PGF file: "PGF" and a version (the flags of libpgf's
// PGFtypes.h: 2 is set since version 2, 0x80 never)
function isPgf(bytes) {
    return bytes.length >= 8 && bytes[0] === 0x50 && bytes[1] === 0x47 && bytes[2] === 0x46
        && (bytes[3] & 0x02) !== 0 && bytes[3] < 0x80;
}

// Whether the file at url is a PGF picture (not PGF/TikZ's TeX)
async function isPgfUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isPgf(value);
}

// { png: Uint8Array, width, height, fullWidth, fullHeight, level, levels, label }
function pgfDecode(bytes, level = 0) {
    if (!worker) {
        worker = new Worker('/pgf-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'PGF decoder failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer, level }, [copy.buffer]);
    });
}

function fileBytes(url) {
    let p = files.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (!isPgf(bytes)) throw new Error('not a PGF picture');
            return bytes;
        })();
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the few the viewer turns the levels of
        if (files.size > 8) files.delete(files.keys().next().value);
    }
    return p;
}

// The PGF file at url as a PNG, at a level (0: full size; 'thumb': the
// smallest at least 256 pixels on its long side):
// { url (a blob: URL), width, height, fullWidth, fullHeight, level, levels, label }
function pgfImage(url, level = 0) {
    const key = url + '#' + level;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            const r = await pgfDecode(await fileBytes(url), level);
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height,
                fullWidth: r.fullWidth, fullHeight: r.fullHeight, level: r.level, levels: r.levels, label: r.label };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('PGF decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (decoded.size > 64) {
            const [oldKey, old] = decoded.entries().next().value;
            decoded.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// What the picture is (the tooltip) and, for one of several levels, a choice of
// them: the image at 1/2^level of its size, from the file's first levels alone
function addPgfControls(root, img, url) {
    pgfImage(url).then(first => {
        img.title = `${first.label}, ${first.width}×${first.height}`;
        if (first.levels < 2) return;
        const bar = document.createElement('div');
        bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center;z-index:1;'
            + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
        const label = document.createElement('span');
        label.textContent = 'Level';
        const select = document.createElement('select');
        select.title = 'The image decoded from its coarsest levels only, as PGF is read progressively';
        select.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
        for (let l = 0; l < first.levels; l++) {
            const w = Math.ceil(first.fullWidth / 2 ** l), h = Math.ceil(first.fullHeight / 2 ** l);
            select.add(new Option(`${l}: ${w}×${h}${l ? ` (1/${2 ** l})` : ''}`, String(l)));
        }
        const status = document.createElement('span');
        bar.append(label, select, status);
        let turn = 0;
        select.onchange = async () => {
            const mine = ++turn;
            status.textContent = '';
            try {
                const d = await pgfImage(url, +select.value);
                if (mine !== turn) return;
                img.src = d.url;
                img.title = `${d.label}, ${d.width}×${d.height}${d.level ? ` (level ${d.level} of ${d.fullWidth}×${d.fullHeight})` : ''}`;
            } catch (err) {
                if (mine === turn) status.textContent = err.message;
            }
        };
        root.appendChild(bar);
    }).catch(() => {});
}

module.exports = { isPgfName, isPgf, isPgfUrl, pgfDecode, pgfImage, addPgfControls };
