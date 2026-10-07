// --- Sun Raster (.ras, .sun, .im1, .im8, .im24, .im32; a .rs that is one) ---
// No browser shows Sun rasters. The format (SunOS's <rasterfile.h>) is a
// 32-byte big-endian header (magic 0x59a66a95, width, height, depth, length,
// type, map type, map length), the colormap and the pixels, top row first,
// each row padded to 16 bits, so it is read here. Types: old (0, the length
// may be 0) and standard (1) as stored, byte-encoded (2, Sun's run-length
// encoding: 0x80 n v is n + 1 v's, 0x80 0 a lone 0x80) and RGB (3, 24 and
// 32-bit pixels in R G B order rather than B G R). The TIFF (4) and IFF (5)
// conversion types and experimental ones (0xffff) have no published layout and
// say they aren't supported. Depths 1 (bit set = black, the Sun console's
// convention, unless there's a colormap), 8 (gray, or colormapped), 24 and 32
// (a byte before B G R that is padding to Sun but alpha to ImageMagick and
// others: alpha unless it is zero everywhere). Colormaps: equal-RGB (red,
// green and blue tables one after another) colors 1 and 8-bit pixels; 24/32-bit
// ones are their own colors (as FFmpeg reads them; ImageMagick refuses such a
// file); a raw colormap (no defined layout) is skipped. The image becomes a PNG an <img> shows. .rs is Rust
// source far more often: one is only a Sun raster if its magic number is.
const { createLogger } = require('./debug');

const log = createLogger('SunRaster');
const SUN_RE = /\.(ras|sun|rs|im(1|8|24|32))$/i;
// the name a Sun raster shares with other files
const MAYBE_RE = /\.rs$/i;
const MAGIC = 0x59a66a95;
const TYPES = { 0: 'old', 1: 'standard', 2: 'byte-encoded (RLE)', 3: 'RGB', 4: 'TIFF', 5: 'IFF', 0xffff: 'experimental' };
// to keep a hostile header from asking for gigabytes
const MAX_PIXELS = 400000000;

const decoded = new Map(); // source URL -> Promise<{ url, pages }>

// Whether the name is one a Sun raster goes by (a .rs is one only once its
// bytes say so, see isSunMaybeName)
function isSunName(name) {
    return SUN_RE.test(name || '');
}

// A name a Sun raster shares with other files (.rs, Rust's)
function isSunMaybeName(name) {
    return MAYBE_RE.test(name || '');
}

// The 32-byte header, or null if these bytes don't start a Sun raster
function readHeader(bytes) {
    if (bytes.length < 32) return null;
    const u32 = p => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    if (u32(0) !== MAGIC) return null;
    return {
        width: u32(4),
        height: u32(8),
        depth: u32(12),
        length: u32(16),
        type: u32(20),
        mapType: u32(24),
        mapLength: u32(28),
    };
}

// Bytes that are a Sun raster (what a .rs is shown for)
function isSun(bytes) {
    return !!readHeader(bytes);
}

// Sun's byte encoding undone, into a buffer of size bytes (a short stream
// leaves the rest zero)
function unRle(bytes, p, end, size) {
    const out = new Uint8Array(size);
    let o = 0;
    while (p < end && o < size) {
        const b = bytes[p++];
        if (b !== 0x80) { out[o++] = b; continue; }
        if (p >= end) break;
        const n = bytes[p++];
        if (!n) { out[o++] = 0x80; continue; }
        if (p >= end) break;
        const v = bytes[p++];
        for (let i = 0; i <= n && o < size; i++) out[o++] = v;
    }
    return out;
}

// { width, height, rgba, label }
function sunDecode(bytes) {
    const h = readHeader(bytes);
    if (!h) throw new Error('Not a Sun raster (no 0x59a66a95 magic number)');
    const { width, height, depth, type } = h;
    if (!width || !height) throw new Error(`Sun raster is ${width}x${height}`);
    if (width * height > MAX_PIXELS) throw new Error(`Sun raster too large (${width}x${height})`);
    if (type > 3) throw new Error(`Sun raster type ${TYPES[type] || type} isn't supported (only old, standard, byte-encoded and RGB are)`);
    if (![1, 8, 24, 32].includes(depth)) throw new Error(`Sun raster depth ${depth} isn't supported (1, 8, 24 and 32 are)`);
    if (h.mapType > 2) throw new Error(`Unknown Sun raster colormap type ${h.mapType}`);

    // the colormap: equal-RGB is the red table, then the green, then the blue
    const mapStart = 32, dataStart = mapStart + h.mapLength;
    if (dataStart > bytes.length) throw new Error('Sun raster colormap is cut short');
    let map = null;
    if (h.mapType === 1 && h.mapLength >= 3) {
        const n = Math.floor(h.mapLength / 3);
        map = { n, r: bytes.subarray(mapStart, mapStart + n), g: bytes.subarray(mapStart + n, mapStart + 2 * n), b: bytes.subarray(mapStart + 2 * n, mapStart + 3 * n) };
    }

    // rows padded to 16 bits
    const stride = Math.ceil(width * depth / 16) * 2;
    const size = stride * height;
    let data;
    if (type === 2) {
        data = unRle(bytes, dataStart, bytes.length, size);
    } else {
        data = bytes.subarray(dataStart, dataStart + size);
        // a short file: as far as it goes
        if (data.length < size) {
            const full = new Uint8Array(size);
            full.set(data);
            data = full;
        }
    }

    const rgba = new Uint8ClampedArray(width * height * 4);
    let badIndex = false, alpha = false;
    // a colormap color (black, noted, for an index past its end)
    const color = (v, o) => {
        if (v < map.n) { rgba[o] = map.r[v]; rgba[o + 1] = map.g[v]; rgba[o + 2] = map.b[v]; }
        else badIndex = true;
        rgba[o + 3] = 255;
    };
    if (depth === 1 || depth === 8) {
        for (let y = 0; y < height; y++) {
            const row = y * stride;
            for (let x = 0; x < width; x++) {
                const o = (y * width + x) * 4;
                const v = depth === 8 ? data[row + x] : (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
                if (map) color(v, o);
                else {
                    rgba[o] = rgba[o + 1] = rgba[o + 2] = depth === 8 ? v : (v ? 0 : 255);
                    rgba[o + 3] = 255;
                }
            }
        }
    } else {
        // 24-bit B G R (R G B for the RGB type), 32-bit with a byte before
        const bpp = depth >> 3, rgb = type === 3, x0 = bpp - 3;
        if (bpp === 4) {
            for (let y = 0; y < height && !alpha; y++) {
                for (let x = 0, p = y * stride; x < width; x++, p += 4) if (data[p]) { alpha = true; break; }
            }
        }
        for (let y = 0; y < height; y++) {
            for (let x = 0, p = y * stride; x < width; x++, p += bpp) {
                const o = (y * width + x) * 4;
                const c0 = data[p + x0], c1 = data[p + x0 + 1], c2 = data[p + x0 + 2];
                rgba[o] = rgb ? c0 : c2;
                rgba[o + 1] = c1;
                rgba[o + 2] = rgb ? c2 : c0;
                rgba[o + 3] = alpha ? data[p] : 255;
            }
        }
    }

    const kind = depth === 1 ? (map ? '1-bit colormapped' : '1-bit monochrome')
        : depth === 8 ? (map ? '8-bit colormapped' : '8-bit gray')
            : `${depth}-bit ${type === 3 ? 'RGB' : 'BGR'}${depth === 32 ? (alpha ? ' with alpha' : ' (pad byte)') : ''}`;
    const label = [
        `Sun raster, ${TYPES[type]}, ${kind}`,
        map && depth > 8 ? `a ${map.n}-entry colormap, not used by ${depth}-bit pixels` : map ? `${map.n} colors` : '',
        h.mapType === 2 && h.mapLength ? `a raw colormap (${h.mapLength} bytes, no defined layout), not applied` : '',
        badIndex ? 'pixels past the colormap\'s end shown black' : '',
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

// The Sun raster at url: { url (a blob: URL of its PNG), pages: [{ width, height, label }] }
function sunImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = sunDecode(new Uint8Array(await resp.arrayBuffer()));
            const png = await rgbaToPng(r.rgba, r.width, r.height);
            return { url: URL.createObjectURL(png), pages: [{ width: r.width, height: r.height, label: r.label }] };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('Sun raster decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Whether the file at url starts like a Sun raster
async function isSunUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isSun(value);
}

module.exports = { isSunName, isSunMaybeName, isSun, isSunUrl, sunDecode, sunImage };
