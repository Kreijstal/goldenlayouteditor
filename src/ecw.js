// --- ECW, Enhanced Compression Wavelet (.ecw) ---
// ER Mapper's (now Hexagon's) format for aerial and satellite mosaics, often
// of many gigapixels: a wavelet pyramid in 64x64 or 128x128 blocks, gray, YUV
// (RGB) or multi-band, georeferenced. No browser shows it and the ECW SDK is
// closed, so a worker (public/ecw-worker.js: ecw2tiff, a from-scratch decoder
// as WebAssembly) decodes it to a PNG any <img> shows: versions 2 and 3, gray,
// RGB, the first three bands of a multi-band file (a v3 file's opacity band
// isn't shown). Its scales are the image at 1/2, 1/4... of its size, from the
// file's coarser levels alone; the viewer offers them, opens one no more than
// 4096 pixels on its long side, and thumbnails are decoded from the smallest
// one at least 256 pixels on its long side. The whole file is read into
// memory first (there are no ranged reads), so a mosaic of gigabytes doesn't open.
// ECW's JPEG 2000 files (.jp2) are JPEG 2000's viewer's (src/jp2.js).
const { createLogger } = require('./debug');

const log = createLogger('ECW');
const ECW_RE = /\.ecw$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<Uint8Array>
const decoded = new Map(); // source URL + '#' + scale -> Promise<{ url, width, height, fullWidth, fullHeight, scale, scales, label }>

function isEcwName(name) {
    return ECW_RE.test(name || '');
}

// { png: Uint8Array, width, height, fullWidth, fullHeight, scale, scales, label }
function ecwDecode(bytes, scale = 'fit') {
    if (!worker) {
        worker = new Worker('/ecw-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'ECW decoder failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer, scale }, [copy.buffer]);
    });
}

function fileBytes(url) {
    let p = files.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return new Uint8Array(await resp.arrayBuffer());
        })();
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the few the viewer turns the scales of
        if (files.size > 8) files.delete(files.keys().next().value);
    }
    return p;
}

// The ECW file at url as a PNG, at a scale (1, 2, 4...; 'fit': the largest no
// more than 4096 pixels on its long side; 'thumb': the smallest at least 256):
// { url (a blob: URL), width, height, fullWidth, fullHeight, scale, scales, label }
function ecwImage(url, scale = 'fit') {
    const key = url + '#' + scale;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            const r = await ecwDecode(await fileBytes(url), scale);
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height,
                fullWidth: r.fullWidth, fullHeight: r.fullHeight, scale: r.scale, scales: r.scales, label: r.label };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('ECW decode failed:', err); });
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
// scales: the image at 1/2, 1/4... of its size, from the file's coarser levels alone
function addEcwControls(root, img, url) {
    ecwImage(url).then(first => {
        const title = d => `${d.label}, ${d.width}×${d.height}${d.scale > 1 ? ` (1/${d.scale} of ${d.fullWidth}×${d.fullHeight})` : ''}`;
        img.title = title(first);
        if (first.scales < 2) return;
        const bar = document.createElement('div');
        bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center;z-index:1;'
            + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
        const label = document.createElement('span');
        label.textContent = 'Scale';
        const select = document.createElement('select');
        select.title = 'The image decoded from its coarser levels only, as ECW is read at a lower resolution';
        select.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
        for (let l = 0; l < first.scales; l++) {
            const w = Math.ceil(first.fullWidth / 2 ** l), h = Math.ceil(first.fullHeight / 2 ** l);
            select.add(new Option(`${l ? `1/${2 ** l}` : '1:1'}: ${w}×${h}`, String(2 ** l)));
        }
        select.value = String(first.scale);
        const status = document.createElement('span');
        bar.append(label, select, status);
        let turn = 0;
        select.onchange = async () => {
            const mine = ++turn;
            status.textContent = '';
            try {
                const d = await ecwImage(url, +select.value);
                if (mine !== turn) return;
                img.src = d.url;
                img.title = title(d);
            } catch (err) {
                if (mine === turn) status.textContent = err.message;
            }
        };
        root.appendChild(bar);
    }).catch(() => {});
}

module.exports = { isEcwName, ecwDecode, ecwImage, addEcwControls };
