// --- Silicon Graphics Image (.sgi; a .rgb, .rgba, .bw, .int or .inta that is one) ---
// No browser shows SGI images. The format (Paul Haeberli's "The SGI Image File
// Format", version 1.0) is a 512-byte big-endian header and the pixels, plane
// after plane, bottom row first, so it is read here: verbatim and run-length
// encoded, 1 or 2 bytes a channel (16-bit channels are scaled to 8 bits), one
// to four channels (gray, gray and alpha, RGB, RGBA; channels past the fourth
// are left out). The colormap field: normal images as they are; dithered ones
// (one channel of 3-3-2 bit RGB, red in the low bits, as IRIS GL's 8-bit RGB
// mode drew them) as their colors; screen ones (indices into a hardware
// colormap that isn't in the file) as grays, saying so; and a colormap file
// (the colors themselves) as the image it is. PIXMIN/PIXMAX are informative
// only and not applied, as other readers do. The image becomes a PNG an <img>
// shows. .rgb, .rgba, .bw, .int and .inta are raw dumps or other things too:
// those are only SGI if their magic number is.
const { createLogger } = require('./debug');

const log = createLogger('SGI');
const SGI_RE = /\.(sgi|rgba?|bw|inta?)$/i;
// the names an SGI image shares with other files
const MAYBE_RE = /\.(rgba?|bw|inta?)$/i;
const MAGIC = 474;
const KINDS = ['', 'gray', 'gray and alpha', 'RGB', 'RGBA'];
// to keep a hostile header from asking for gigabytes
const MAX_PIXELS = 400000000;

const decoded = new Map(); // source URL -> Promise<{ url, pages }>

// Whether the name is one an SGI image goes by (a .rgb, .bw... is one only
// once its bytes say so, see isSgiMaybeName)
function isSgiName(name) {
    return SGI_RE.test(name || '');
}

// A name an SGI image shares with other files (.rgb, .rgba, .bw, .int, .inta)
function isSgiMaybeName(name) {
    return MAYBE_RE.test(name || '');
}

// The 512-byte header, or null if these bytes don't start an SGI image
function readHeader(bytes) {
    if (bytes.length < 108) return null;
    const u16 = p => (bytes[p] << 8) | bytes[p + 1];
    const i32 = p => (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    if (u16(0) !== MAGIC) return null;
    const h = {
        rle: bytes[2],
        bpc: bytes[3],
        dimension: u16(4),
        width: u16(6),
        height: u16(8),
        channels: u16(10),
        pixmin: i32(12),
        pixmax: i32(16),
        name: new TextDecoder('latin1').decode(bytes.subarray(24, 104)).replace(/\0.*$/s, '').trim(),
        colormap: i32(104),
    };
    if (h.rle > 1 || (h.bpc !== 1 && h.bpc !== 2) || h.dimension < 1 || h.dimension > 3) return null;
    // a one-dimensional image is one row, a two-dimensional one a single channel
    if (h.dimension === 1) h.height = 1;
    if (h.dimension < 3) h.channels = 1;
    return h;
}

// Bytes that are an SGI image (what a .rgb, .bw... is shown for)
function isSgi(bytes) {
    return !!readHeader(bytes);
}

// { width, height, rgba, label }
function sgiDecode(bytes) {
    const h = readHeader(bytes);
    if (!h) throw new Error('Not an SGI image (no 474 magic number, or a header that makes no sense)');
    const { width, height, bpc } = h;
    if (!width || !height || !h.channels) throw new Error(`SGI image is ${width}x${height}x${h.channels}`);
    if (width * height > MAX_PIXELS) throw new Error(`SGI image too large (${width}x${height})`);
    if (h.colormap < 0 || h.colormap > 3) throw new Error(`Unknown SGI colormap value ${h.colormap}`);
    const used = Math.min(h.channels, 4);
    const n = width * height;
    const end = bytes.length;

    // each used channel's samples, rows bottom first, as stored
    const planes = [];
    const get = bpc === 1 ? p => bytes[p] : p => (bytes[p] << 8) | bytes[p + 1];
    if (h.rle) {
        // a table of where each row (channel by channel) starts, then of how long
        const rows = height * h.channels;
        const u32 = p => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
        if (512 + rows * 8 > end) throw new Error('SGI RLE offset tables are cut short');
        for (let z = 0; z < used; z++) {
            const plane = bpc === 1 ? new Uint8Array(n) : new Uint16Array(n);
            for (let y = 0; y < height; y++) {
                const t = z * height + y;
                let p = u32(512 + t * 4);
                const stop = Math.min(end, p + u32(512 + rows * 4 + t * 4));
                let o = y * width;
                const rowEnd = o + width;
                // packets: a count in the low 7 bits; the high bit set, that many
                // samples follow, clear, the next sample repeats; a zero count ends the row
                while (p + bpc <= stop && o < rowEnd) {
                    const c = get(p);
                    p += bpc;
                    const count = c & 0x7f;
                    if (!count) break;
                    if (c & 0x80) {
                        for (let i = 0; i < count && o < rowEnd && p + bpc <= stop; i++, p += bpc) plane[o++] = get(p);
                    } else {
                        if (p + bpc > stop) break;
                        const v = get(p);
                        p += bpc;
                        for (let i = 0; i < count && o < rowEnd; i++) plane[o++] = v;
                    }
                }
            }
            planes.push(plane);
        }
    } else {
        // verbatim: each channel's rows one after another
        for (let z = 0; z < used; z++) {
            const plane = bpc === 1 ? new Uint8Array(n) : new Uint16Array(n);
            const base = 512 + z * n * bpc;
            const avail = Math.max(0, Math.min(n, Math.floor((end - base) / bpc))); // a short file: as far as it goes
            for (let i = 0; i < avail; i++) plane[i] = get(base + i * bpc);
            planes.push(plane);
        }
    }

    // to RGBA, top row first
    const to8 = bpc === 1 ? v => v : v => Math.round(v / 257);
    const dithered = h.colormap === 1 && used === 1 && bpc === 1;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let y = 0; y < height; y++) {
        const from = (height - 1 - y) * width;
        for (let x = 0; x < width; x++) {
            const s = from + x, o = (y * width + x) * 4;
            if (dithered) {
                // RRR in bits 0-2, GGG in 3-5, BB in 6-7
                const v = planes[0][s];
                rgba[o] = (v & 7) * 255 / 7;
                rgba[o + 1] = ((v >> 3) & 7) * 255 / 7;
                rgba[o + 2] = (v >> 6) * 255 / 3;
                rgba[o + 3] = 255;
            } else if (used < 3) {
                rgba[o] = rgba[o + 1] = rgba[o + 2] = to8(planes[0][s]);
                rgba[o + 3] = used === 2 ? to8(planes[1][s]) : 255;
            } else {
                rgba[o] = to8(planes[0][s]);
                rgba[o + 1] = to8(planes[1][s]);
                rgba[o + 2] = to8(planes[2][s]);
                rgba[o + 3] = used === 4 ? to8(planes[3][s]) : 255;
            }
        }
    }

    const label = [
        `SGI ${dithered ? 'dithered RGB (3-3-2)' : KINDS[used]}${h.rle ? ' RLE' : ''}, ${bpc * 8}-bit`,
        h.channels > 4 ? `${h.channels - 4} more channel${h.channels > 5 ? 's' : ''} not shown` : '',
        h.colormap === 2 ? 'screen colormap indices (the colormap isn\'t in the file), shown as gray' : '',
        h.colormap === 3 ? 'a colormap (its colors as an image)' : '',
        h.colormap === 1 && !dithered ? 'marked dithered, shown as stored' : '',
        h.name ? `"${h.name}"` : '',
    ].filter(Boolean).join(', ');
    return { width, height, rgba, label };
}

async function rgbaToPng(rgba, width, height) {
    const data = new ImageData(rgba, width, height);
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').putImageData(data, 0, 0);
        return canvas.convertToBlob({ type: 'image/png' });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(data, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

// The SGI image at url: { url (a blob: URL of its PNG), pages: [{ width, height, label }] }
function sgiImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = sgiDecode(new Uint8Array(await resp.arrayBuffer()));
            const png = await rgbaToPng(r.rgba, r.width, r.height);
            return { url: URL.createObjectURL(png), pages: [{ width: r.width, height: r.height, label: r.label }] };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('SGI decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Whether the file at url starts like an SGI image
async function isSgiUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isSgi(value);
}

module.exports = { isSgiName, isSgiMaybeName, isSgi, isSgiUrl, sgiDecode, sgiImage };
