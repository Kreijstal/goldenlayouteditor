// --- JPEG-LS (.jls) ---
// No browser shows JPEG-LS (ITU-T T.87, the lossless JPEG that DICOM and some
// cameras and scanners use). So it is decoded in a worker (public/jls-worker.js:
// CharLS as WebAssembly) to its samples, then a PNG any <img> shows: one
// component in gray, three as RGB (a fourth, or more than four, not shown: the
// first three as RGB, the first alone in gray for two), lossless or
// near-lossless, of any bit depth. Samples of more than 8 bits (12-bit
// medical and scanned images) are windowed as an NRRD's or a FITS file's are
// (src/fits.js's intervals): by default the bit depth's range, else the
// min/max, 99.5%, 99%, zscale or a window typed in; 8 bits or fewer as they
// are (fewer scaled to 0-255).
const { createLogger } = require('./debug');
const { INTERVALS, fitsLimits, fitsLevels, rgbaToPng } = require('./fits');

const log = createLogger('JLS');
const JLS_RE = /\.jls$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<picture>
const drawn = new Map(); // source URL + '#' + interval -> Promise<{ url, width, height, label, bits, limits }>

function isJlsName(name) {
    return JLS_RE.test(name || '');
}

// { width, height, bits, components, interleave, near, samples }
function jlsDecode(bytes) {
    if (!worker) {
        worker = new Worker('/jls-worker.js');
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'JPEG-LS decoder failed to load'));
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

// What a picture is: "12-bit gray, near-lossless (NEAR 3)", "8-bit RGB, interleaved by line"...
function jlsLabel(pic) {
    const c = pic.components;
    const color = c === 1 ? 'gray' : c === 3 ? 'RGB' : c === 4 ? '4 components (the first three as RGB)'
        : `${c} components (the first ${c > 4 ? 'three as RGB' : 'in gray'})`;
    const parts = [`JPEG-LS, ${pic.bits}-bit ${color}`];
    if (c > 1) parts.push(pic.interleave === 'none' ? 'not interleaved' : `interleaved by ${pic.interleave}`);
    parts.push(pic.near ? `near-lossless (NEAR ${pic.near})` : 'lossless');
    return parts.join(', ');
}

// [vmin, vmax] of an interval: the bit depth's range ('type'), FITS's
// (zscale, min/max, 99.5%, 99%) over every sample shown, or [min, max] given by hand
function jlsLimits(pic, interval) {
    if (Array.isArray(interval)) return interval;
    if (interval === 'type') return [0, 2 ** pic.bits - 1];
    pic.limits = pic.limits || new Map();
    if (!pic.limits.has(interval)) {
        const shown = pic.components >= 3 ? 3 : 1;
        const n = pic.width * pic.height;
        const values = new Float32Array(n * shown);
        for (let i = 0, o = 0; i < n; i++) {
            for (let c = 0; c < shown; c++) values[o++] = pic.samples[i * pic.components + c];
        }
        pic.limits.set(interval, fitsLimits(values, interval));
    }
    return pic.limits.get(interval);
}

// 8-bit RGBA of a picture, its samples windowed to limits
function jlsRgba(pic, limits) {
    const n = pic.width * pic.height, k = pic.components;
    const rgb = k >= 3;
    const out = new Uint8ClampedArray(n * 4);
    // one sample value to its level, by a table (at most 65536 entries)
    const table = fitsLevels(Float32Array.from({ length: 2 ** pic.bits }, (_, v) => v), limits);
    const s = pic.samples;
    for (let i = 0, p = 0, o = 0; i < n; i++, p += k, o += 4) {
        const r = table[s[p]];
        out[o] = r;
        out[o + 1] = rgb ? table[s[p + 1]] : r;
        out[o + 2] = rgb ? table[s[p + 2]] : r;
        out[o + 3] = 255;
    }
    return out;
}

function filePicture(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const pic = await jlsDecode(new Uint8Array(await resp.arrayBuffer()));
            pic.label = jlsLabel(pic);
            return pic;
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few pictures only: another window draws again, it doesn't decode again
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// The window a picture is first shown with: its bit depth's range
const DEFAULT_INTERVAL = 'type';

// The JPEG-LS file at url as a PNG, windowed to interval (more than 8 bits):
// { url (a blob: URL), width, height, label, bits, limits }
function jlsImage(url, interval = DEFAULT_INTERVAL) {
    const key = `${url}#${interval}`;
    let p = drawn.get(key);
    if (!p) {
        p = (async () => {
            const pic = await filePicture(url);
            const limits = jlsLimits(pic, pic.bits > 8 ? interval : 'type');
            const png = await rgbaToPng(jlsRgba(pic, limits), pic.width, pic.height);
            return { url: URL.createObjectURL(png), width: pic.width, height: pic.height, label: pic.label, bits: pic.bits, limits };
        })();
        drawn.set(key, p);
        p.catch(err => { drawn.delete(key); log.warn('JPEG-LS decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (drawn.size > 64) {
            const [oldKey, old] = drawn.entries().next().value;
            drawn.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the JPEG-LS file at url (root is the
// viewer's element): what it is in the title; more than 8 bits, the window
// (an interval, or values typed in)
function addJlsControls(root, img, url) {
    jlsImage(url).then(first => {
        img.title = `${first.label}, ${first.width}×${first.height}`;
        if (first.bits <= 8) return;
        root.style.position = 'relative';
        const bar = document.createElement('div');
        bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;z-index:1;'
            + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;max-width:calc(100% - 16px);';
        const interval = document.createElement('select');
        interval.title = 'Interval: the values shown black to white';
        interval.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
        for (const [v, t] of [['type', `${first.bits}-bit range`], ...INTERVALS, ['custom', 'window']]) interval.add(new Option(t, v));
        interval.value = DEFAULT_INTERVAL;
        const number = title => {
            const i = document.createElement('input');
            i.type = 'number';
            i.step = 'any';
            i.title = title;
            i.style.cssText = 'width:6em;background:#333;color:#fff;border:none;font:inherit;';
            return i;
        };
        const lo = number('Shown black (and below)');
        const hi = number('Shown white (and above)');
        const info = document.createElement('span');
        bar.append(interval, lo, hi, info);
        root.append(bar);
        let turn = 0;
        const show = async () => {
            const mine = ++turn;
            try {
                const d = await jlsImage(url, interval.value === 'custom' ? [Number(lo.value), Number(hi.value)] : interval.value);
                if (mine !== turn) return;
                img.src = d.url;
                info.textContent = '';
                if (interval.value !== 'custom') {
                    lo.value = Number(d.limits[0].toPrecision(6));
                    hi.value = Number(d.limits[1].toPrecision(6));
                }
            } catch (err) {
                if (mine === turn) info.textContent = err.message;
            }
        };
        interval.onchange = show;
        lo.onchange = hi.onchange = () => { interval.value = 'custom'; show(); };
        lo.value = first.limits[0];
        hi.value = first.limits[1];
    }).catch(() => {});
}

module.exports = { isJlsName, jlsDecode, jlsLabel, jlsImage, addJlsControls };
