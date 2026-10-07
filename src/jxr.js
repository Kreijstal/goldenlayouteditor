// --- JPEG XR / HD Photo (.jxr; a .wdp or .hdp that is one) ---
// Only Internet Explorer and the old Edge showed JPEG XR. So these files are
// decoded in a worker (public/jxr-worker.js: jxrlib, Microsoft's codec, as
// WebAssembly) to pixels, then a PNG any <img> shows: every pixel format
// jxrlib's glue reads (black and white to 32-bit float, RGB555 to CMYK and
// n-channel), alpha too, interleaved or in a plane of its own. The high
// dynamic range formats (fixed point, half and full float, RGBE: linear
// scRGB, as HDR screenshots of Windows and NVIDIA are) are tone mapped as a
// Radiance picture is (src/rgbe.js): times 2^exposure, clipped or Reinhard, to
// sRGB; by default as stored, clipped, as jxrlib's own converters show them.
// .wdp and .hdp are also WinDev and Dylan projects...: only one that starts as
// JPEG XR does ("II", 0xBC) is shown as a picture (isJxr).
const { createLogger } = require('./debug');
const { srgb, rgbaToPng } = require('./rgbe');

const log = createLogger('JXR');
const JXR_RE = /\.(jxr|wdp|hdp)$/i;
// the names HD Photo used, which other files have too
const MAYBE_RE = /\.(wdp|hdp)$/i;

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<picture>
const toned = new Map(); // source URL + '#' + exposure + tone -> Promise<{ url, width, height, label, hdr }>

// Whether the name is one a JPEG XR file goes by (a .wdp or .hdp is one only
// once its bytes say so, see isJxrMaybeName)
function isJxrName(name) {
    return JXR_RE.test(name || '');
}

// A name HD Photo shares with other files (.wdp, .hdp)
function isJxrMaybeName(name) {
    return MAYBE_RE.test(name || '');
}

// Bytes that start a JPEG XR file: a TIFF-like header, "II" and 0xBC
function isJxr(bytes) {
    return bytes.length >= 4 && bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0xbc && bytes[3] <= 1;
}

// Whether the file at url is JPEG XR (for a .wdp or .hdp)
async function isJxrUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isJxr(value);
}

// { width, height, label, rgba (8-bit RGBA) | float (linear RGBA) }
function jxrDecode(bytes) {
    if (!worker) {
        worker = new Worker('/jxr-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'JPEG XR decoder failed to load'));
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

// A high dynamic range picture as 8-bit sRGBA: times 2^exposure, then 'clip'
// (to 1) or 'reinhard' (by luminance, L / (1 + L)); alpha as it is
function jxrToneMap(pic, exposure = 0, tone = 'clip') {
    const f = pic.float;
    const out = new Uint8ClampedArray(f.length);
    const k = Math.pow(2, exposure);
    for (let i = 0; i < f.length; i += 4) {
        let r = f[i] * k, g = f[i + 1] * k, b = f[i + 2] * k;
        if (tone === 'reinhard') {
            const s = 1 / (1 + Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b));
            r *= s; g *= s; b *= s;
        }
        // NaN as 0
        out[i] = srgb(r || 0);
        out[i + 1] = srgb(g || 0);
        out[i + 2] = srgb(b || 0);
        out[i + 3] = Math.round(255 * (f[i + 3] || 0));
    }
    return out;
}

function filePicture(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return jxrDecode(new Uint8Array(await resp.arrayBuffer()));
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few pictures only: a new exposure tone maps again, it doesn't decode again
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// The JPEG XR file at url as a PNG (tone mapped, if high dynamic range):
// { url (a blob: URL), width, height, label, hdr }
function jxrImage(url, exposure = 0, tone = 'clip') {
    const key = `${url}#${exposure}#${tone}`;
    let p = toned.get(key);
    if (!p) {
        p = (async () => {
            const pic = await filePicture(url);
            const hdr = !!pic.float;
            const png = await rgbaToPng(hdr ? jxrToneMap(pic, exposure, tone) : pic.rgba, pic.width, pic.height);
            return { url: URL.createObjectURL(png), width: pic.width, height: pic.height, label: pic.label, hdr };
        })();
        toned.set(key, p);
        p.catch(err => { toned.delete(key); log.warn('JPEG XR decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (toned.size > 64) {
            const [oldKey, old] = toned.entries().next().value;
            toned.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isJxrName, isJxrMaybeName, isJxr, isJxrUrl, jxrDecode, jxrToneMap, jxrImage };
