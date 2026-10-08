// --- Apple Icon Image (.icns) ---
// An .icns file is a list of entries, one per size and kind: PNG or JPEG 2000
// images (Mac OS X 10.5 and later), older 24-bit RGB images each compressed
// with Apple's PackBits variant and given its alpha by a separate 8-bit mask
// entry, ARGB images compressed the same way, and the oldest 1-, 4- and 8-bit
// palette icons. No browser shows one. Its entries are read by @fiahfy/icns
// and the compressed ones expanded by @fiahfy/packbits (its "icns" format),
// both loaded from jsDelivr when one is first shown (esm.sh's build of
// @fiahfy/icns fails on pngjs, which it needs only to write icons); a JPEG 2000
// entry is decoded by the JPEG 2000 worker (src/jp2.js). Each image becomes a PNG any
// <img> shows, largest first; the image viewer turns its sizes. Not shown: the
// 1-, 4- and 8-bit palette icons (no library reads them), counted in the label.
const { Buffer } = require('buffer');
const { createLogger } = require('./debug');
const { jp2Decode } = require('./jp2');

const log = createLogger('ICNS');
const ICNS_LIB = 'https://cdn.jsdelivr.net/npm/@fiahfy/icns@0.0.7/+esm';
const PACKBITS = 'https://cdn.jsdelivr.net/npm/@fiahfy/packbits@0.0.6/+esm';
const ICNS_RE = /\.icns$/i;
// 24-bit RGB entries and the 8-bit mask that gives each its alpha
const MASK_OF = { is32: 's8mk', il32: 'l8mk', ih32: 'h8mk', it32: 't8mk' };
// the 1-, 4- and 8-bit palette icons and their 1-bit masks
const PALETTE_TYPES = new Set(['ICON', 'ICN#', 'icm#', 'icm4', 'icm8', 'ics#', 'ics4', 'ics8', 'icl4', 'icl8', 'ich#', 'ich4', 'ich8']);

let libPromise = null;
const decoded = new Map(); // source URL -> Promise<{ images, label }>

function isIcnsName(name) {
    return ICNS_RE.test(name || '');
}

function icnsLib() {
    if (!libPromise) {
        libPromise = Promise.all([import(ICNS_LIB), import(PACKBITS)])
            .then(([icns, packbits]) => ({ Icns: icns.Icns || icns.default.Icns, decode: packbits.decode || packbits.default.decode }));
        libPromise.catch(() => { libPromise = null; });
    }
    return libPromise;
}

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
const JP2_SIG = [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20]; // a JP2 file's signature box
const J2K_SIG = [0xff, 0x4f, 0xff, 0x51]; // a bare codestream

async function rgbaUrl(rgba, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed')), 'image/png'));
    return URL.createObjectURL(blob);
}

// planes (one after another, w×h bytes each, as packbits expands them) to RGBA;
// three planes take their alpha from `mask` (opaque without one)
function planesToRgba(planes, n, count, mask) {
    const rgba = new Uint8ClampedArray(n * 4);
    // ARGB: alpha first
    const [a, r, g, b] = count === 4 ? [0, 1, 2, 3] : [-1, 0, 1, 2];
    for (let i = 0; i < n; i++) {
        rgba[i * 4] = planes[r * n + i];
        rgba[i * 4 + 1] = planes[g * n + i];
        rgba[i * 4 + 2] = planes[b * n + i];
        rgba[i * 4 + 3] = a >= 0 ? planes[a * n + i] : mask ? mask[i] : 255;
    }
    return rgba;
}

// One entry as { url, width, height, kind, osType }, null for one that isn't an image
async function entryImage(entry, byType, lib, sizes) {
    const type = entry.osType;
    const data = new Uint8Array(entry.image.buffer, entry.image.byteOffset, entry.image.length);
    if (startsWith(data, PNG_SIG)) {
        const blob = new Blob([data], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        bitmap.close();
        return { url: URL.createObjectURL(blob), width, height, kind: 'PNG', osType: type };
    }
    if (startsWith(data, JP2_SIG) || startsWith(data, J2K_SIG)) {
        const { png, width, height } = await jp2Decode(data);
        return { url: URL.createObjectURL(new Blob([png], { type: 'image/png' })), width, height, kind: 'JPEG 2000', osType: type };
    }
    const size = sizes[type];
    const argb = String.fromCharCode(...data.subarray(0, 4)) === 'ARGB';
    if (!size || !(MASK_OF[type] || argb)) return null;
    const n = size * size;
    const count = argb ? 4 : 3;
    // after "ARGB", or (it32) four zero bytes, the channels compressed one after another
    const skip = argb || type === 'it32' ? 4 : 0;
    const planes = lib.decode(Buffer.from(data.subarray(skip)), { format: 'icns' });
    if (planes.length < n * count) throw new Error(`${type}: ${planes.length} bytes expanded, ${n * count} wanted`);
    const maskEntry = byType.get(MASK_OF[type]);
    const mask = maskEntry && maskEntry.image.length >= n ? maskEntry.image : null;
    const url = await rgbaUrl(planesToRgba(planes, n, count, mask), size, size);
    return { url, width: size, height: size, kind: argb ? 'ARGB' : mask ? 'RGB + mask' : 'RGB', osType: type };
}

const sizeText = e => `${e.width}×${e.height} ${e.kind} (${e.osType})`;

// The file's images, largest first, and what it holds
async function icnsFile(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'icns') throw new Error('Not an Apple icon image (no "icns" signature)');
            const lib = await icnsLib();
            const entries = lib.Icns.from(Buffer.from(bytes)).images;
            const byType = new Map(entries.map(e => [e.osType, e]));
            const sizes = Object.fromEntries(lib.Icns.supportedIconTypes.map(t => [t.osType, t.size]));
            const images = [];
            const failed = [];
            for (const entry of entries) {
                try {
                    const img = await entryImage(entry, byType, lib, sizes);
                    if (img) images.push(img);
                } catch (err) {
                    failed.push(`${entry.osType}: ${err.message}`);
                    log.warn('ICNS entry failed:', entry.osType, err);
                }
            }
            if (!images.length) throw new Error(failed[0] || 'The file holds no image this viewer can show');
            images.sort((a, b) => b.width * b.height - a.width * a.height);
            const palette = entries.filter(e => PALETTE_TYPES.has(e.osType)).map(e => e.osType);
            const label = `Apple icon: ${images.length} image${images.length > 1 ? 's' : ''} (${images.map(sizeText).join(', ')})`
                + (palette.length ? `; not shown: ${palette.length} palette icon${palette.length > 1 ? 's' : ''} (${palette.join(', ')})` : '')
                + (failed.length ? `; unreadable: ${failed.join('; ')}` : '');
            return { images, label };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('ICNS decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => d.images.forEach(e => URL.revokeObjectURL(e.url))).catch(() => {});
        }
    }
    return p;
}

// { url (the largest image, as a blob URL), label }
async function icnsImage(url) {
    const d = await icnsFile(url);
    return { url: d.images[0].url, label: d.label };
}

// Image `page` (largest first) as { url, pages: [{ width, height, label }], page }, for addTiffPager
async function icnsPage(url, page = 0) {
    const d = await icnsFile(url);
    const pages = d.images.map(e => ({ width: e.width, height: e.height, label: sizeText(e) }));
    const n = Math.max(0, Math.min(d.images.length - 1, page));
    return { url: d.images[n].url, pages, page: n };
}

module.exports = { isIcnsName, icnsFile, icnsImage, icnsPage };
