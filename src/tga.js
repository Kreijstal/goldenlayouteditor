// --- Truevision TGA (.tga, .tpic, .icb, .vda, .vst) ---
// No browser shows TGA. The format is an 18-byte header and the pixels, so it
// is read here: color-mapped, truecolor and grayscale (types 1, 2, 3) and their
// run-length encoded forms (9, 10, 11); 8, 15, 16, 24 and 32 bits a pixel;
// color maps of 15, 16, 24 or 32-bit entries, from any first index; every
// origin (bottom-left, the default, top-left, and the right-hand ones) and the
// old interleaved row orders. Alpha is the descriptor's attribute bits, unless
// a TGA 2.0 file's extension area says its attribute type is none (0-2) or
// premultiplied (4), as is a 32-bit color map's; grayscale's second byte is
// alpha. A file whose alpha is zero everywhere and that doesn't say it means it
// is shown opaque, as most writers meant. The
// image becomes a PNG an <img> shows. The Huffman/delta/quadtree types (32,
// 33) say they aren't supported.
const { createLogger } = require('./debug');

const log = createLogger('TGA');
const TGA_RE = /\.(tga|tpic|icb|vda|vst)$/i;
// .icb/.vda/.vst are also the ICB/VDA/Targa boards' names for TGA, but .vst is
// a Visio template too: those are only TGA if their header is one
const RARE_RE = /\.(icb|vda|vst)$/i;
const KINDS = { 1: 'color-mapped', 2: 'truecolor', 3: 'grayscale', 9: 'color-mapped', 10: 'truecolor', 11: 'grayscale' };
const ATTRIBUTES = ['no alpha', 'undefined attribute, ignored', 'undefined attribute, kept', 'alpha', 'premultiplied alpha'];

const decoded = new Map(); // source URL -> Promise<{ url, pages, label }>

function isTgaName(name) {
    return TGA_RE.test(name || '');
}

// The 18-byte header, or null if these bytes can't start a TGA
function readHeader(bytes) {
    if (bytes.length < 18) return null;
    const u16 = p => bytes[p] | (bytes[p + 1] << 8);
    const h = {
        idLength: bytes[0],
        mapType: bytes[1],
        type: bytes[2],
        mapFirst: u16(3),
        mapLength: u16(5),
        mapBits: bytes[7],
        width: u16(12),
        height: u16(14),
        bits: bytes[16],
        descriptor: bytes[17],
    };
    if (h.mapType > 1 || !KINDS[h.type] && h.type !== 32 && h.type !== 33) return null;
    if (h.mapType === 1 && ![15, 16, 24, 32].includes(h.mapBits)) return null;
    if ((h.type & 7) === 1 && (h.mapType !== 1 || (h.bits !== 8 && h.bits !== 16))) return null;
    if ((h.type & 7) === 2 && ![15, 16, 24, 32].includes(h.bits)) return null;
    if ((h.type & 7) === 3 && h.bits !== 8 && h.bits !== 16) return null;
    if (!h.width || !h.height) return null;
    return h;
}

// Bytes that are a TGA (what a .icb/.vda/.vst is shown for): a header that
// makes sense and isn't an OLE file's (a Visio template's) start
function isTga(bytes) {
    if (bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) return false;
    return !!readHeader(bytes);
}

// The TGA 2.0 footer's extension area: { attributeType, software } or null
function readExtension(bytes) {
    const n = bytes.length;
    if (n < 18 + 26) return null;
    const sig = new TextDecoder('latin1').decode(bytes.subarray(n - 18, n - 2));
    if (sig !== 'TRUEVISION-XFILE') return null;
    const off = (bytes[n - 26] | (bytes[n - 25] << 8) | (bytes[n - 24] << 16) | (bytes[n - 23] << 24)) >>> 0;
    if (!off || off + 495 > n - 26) return {};
    const size = bytes[off] | (bytes[off + 1] << 8);
    if (size < 495) return {};
    const text = (p, len) => new TextDecoder('latin1').decode(bytes.subarray(p, p + len)).replace(/\0.*$/s, '').trim();
    return { attributeType: bytes[off + 494], software: text(off + 426, 41) };
}

// A 15/16-bit little-endian A1R5G5B5 value to [r, g, b, a]
function rgb555(v) {
    const r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
    return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), v & 0x8000 ? 255 : 0];
}

// { width, height, rgba, label }
function tgaDecode(bytes) {
    const h = readHeader(bytes);
    if (!h) throw new Error('not a TGA image');
    if (h.type === 32 || h.type === 33) throw new Error('Huffman/delta/quadtree compressed TGA (type ' + h.type + ') isn\'t supported');
    const { width, height, bits } = h;
    const kind = h.type & 7;
    const rle = h.type >= 9;
    let pos = 18 + h.idLength;

    // the color map, as RGBA (index - mapFirst)
    let map = null;
    if (h.mapType === 1) {
        const entryBytes = Math.ceil(h.mapBits / 8);
        map = new Uint8Array(h.mapLength * 4);
        for (let i = 0; i < h.mapLength; i++, pos += entryBytes) {
            const o = i * 4;
            if (h.mapBits <= 16) {
                const c = rgb555(bytes[pos] | (bytes[pos + 1] << 8));
                map[o] = c[0]; map[o + 1] = c[1]; map[o + 2] = c[2];
                map[o + 3] = h.mapBits === 16 ? c[3] : 255;
            } else {
                map[o] = bytes[pos + 2]; map[o + 1] = bytes[pos + 1]; map[o + 2] = bytes[pos];
                map[o + 3] = h.mapBits === 32 ? bytes[pos + 3] : 255;
            }
        }
    }

    // the pixels as stored, one after another (an RLE packet may run past the
    // end of a row, which TGA 1.0 allowed)
    const pixelBytes = Math.ceil(bits / 8);
    const n = width * height;
    let raw = new Uint8Array(n * pixelBytes);
    if (rle) {
        let o = 0;
        while (o < raw.length && pos < bytes.length) {
            const packet = bytes[pos++];
            const count = (packet & 0x7F) + 1;
            if (packet & 0x80) {
                const px = bytes.subarray(pos, pos + pixelBytes);
                pos += pixelBytes;
                for (let i = 0; i < count && o < raw.length; i++, o += pixelBytes) raw.set(px, o);
            } else {
                const len = Math.min(count * pixelBytes, raw.length - o);
                raw.set(bytes.subarray(pos, pos + len), o);
                pos += count * pixelBytes;
                o += len;
            }
        }
    } else {
        raw = bytes.subarray(pos, pos + raw.length);
    }

    // to RGBA, in stored order
    const alphaBits = h.descriptor & 15;
    const stored = new Uint8ClampedArray(n * 4);
    let alphaSeen = false;
    for (let i = 0, p = 0, o = 0; i < n; i++, p += pixelBytes, o += 4) {
        if (p + pixelBytes > raw.length) { stored[o + 3] = 255; continue; } // truncated: shown as far as it goes
        if (kind === 1) {
            const index = (bits === 16 ? raw[p] | (raw[p + 1] << 8) : raw[p]) - h.mapFirst;
            if (index >= 0 && index < h.mapLength) stored.set(map.subarray(index * 4, index * 4 + 4), o);
            else stored[o + 3] = 255;
        } else if (kind === 3) {
            stored[o] = stored[o + 1] = stored[o + 2] = raw[p];
            stored[o + 3] = bits === 16 ? raw[p + 1] : 255;
        } else if (bits <= 16) {
            const c = rgb555(raw[p] | (raw[p + 1] << 8));
            stored[o] = c[0]; stored[o + 1] = c[1]; stored[o + 2] = c[2];
            stored[o + 3] = bits === 16 ? c[3] : 255;
        } else {
            stored[o] = raw[p + 2]; stored[o + 1] = raw[p + 1]; stored[o + 2] = raw[p];
            stored[o + 3] = bits === 32 ? raw[p + 3] : 255;
        }
        if (stored[o + 3]) alphaSeen = true;
    }

    // what the alpha means: the extension area says, else the descriptor's bits
    // (a 16 or 32-bit pixel with none declared is opaque; one declared but
    // zero everywhere is a writer that didn't mean it)
    const ext = readExtension(bytes);
    const attr = ext && ext.attributeType !== undefined ? ext.attributeType : null;
    const hasAlphaChannel = (kind === 2 && (bits === 16 || bits === 32)) || (kind === 3 && bits === 16)
        || (kind === 1 && (h.mapBits === 16 || h.mapBits === 32));
    // (a 32-bit color map's alpha counts without them, as GIMP reads it)
    let alpha = hasAlphaChannel && (kind === 3 || alphaBits > 0 || (kind === 1 && h.mapBits === 32));
    if (attr !== null && attr <= 2) alpha = false;
    else if (attr === null && !alphaSeen) alpha = false;
    else if (attr === 3 || attr === 4) alpha = hasAlphaChannel;
    const premultiplied = alpha && attr === 4;

    // to top-left first rows, left to right, the old interleaved row orders undone
    const rightToLeft = (h.descriptor & 0x10) !== 0;
    const topDown = (h.descriptor & 0x20) !== 0;
    const interleave = (h.descriptor >> 6) & 3; // 0: none, 1: two-way, 2: four-way
    const ways = interleave === 1 ? 2 : interleave === 2 ? 4 : 1;
    const rowOrder = new Array(height);
    for (let s = 0, w = 0; w < ways; w++) for (let r = w; r < height; r += ways) rowOrder[s++] = r;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let s = 0; s < height; s++) {
        const line = rowOrder[s];
        const y = topDown ? line : height - 1 - line;
        for (let x = 0; x < width; x++) {
            const from = (s * width + x) * 4;
            const to = (y * width + (rightToLeft ? width - 1 - x : x)) * 4;
            const a = alpha ? stored[from + 3] : 255;
            if (premultiplied && a > 0 && a < 255) {
                rgba[to] = stored[from] * 255 / a;
                rgba[to + 1] = stored[from + 1] * 255 / a;
                rgba[to + 2] = stored[from + 2] * 255 / a;
            } else {
                rgba[to] = stored[from]; rgba[to + 1] = stored[from + 1]; rgba[to + 2] = stored[from + 2];
            }
            rgba[to + 3] = a;
        }
    }

    const label = [
        `TGA ${KINDS[h.type]}${rle ? ' RLE' : ''}, ${bits}-bit`,
        map ? `${h.mapLength} colors (${h.mapBits}-bit)` : '',
        alpha ? (premultiplied ? 'premultiplied alpha' : 'alpha') : '',
        attr !== null && attr <= 2 && hasAlphaChannel ? ATTRIBUTES[attr] : '',
        ext && ext.software ? ext.software : '',
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

// The TGA at url: { url (a blob: URL of its PNG), pages: [{ width, height, label }] }
function tgaImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = tgaDecode(new Uint8Array(await resp.arrayBuffer()));
            const png = await rgbaToPng(r.rgba, r.width, r.height);
            return { url: URL.createObjectURL(png), pages: [{ width: r.width, height: r.height, label: r.label }] };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('TGA decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Whether the .icb/.vda/.vst at url is a TGA (any other name: by its name)
async function isTgaUrl(url, name) {
    if (!RARE_RE.test(name || '')) return isTgaName(name);
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isTga(value);
}

module.exports = { isTgaName, isTga, isTgaUrl, tgaDecode, tgaImage };
