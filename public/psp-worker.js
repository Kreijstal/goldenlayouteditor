// Paint Shop Pro images (.psp, .pspimage, .tub, .pspframe, ...), read and
// composited in a worker, for the Paint Shop Pro viewer (src/psp-plugin.js).
// Written from the Paint Shop Pro file format specifications (as GIMP's
// file-psp.c carries them) and bitplane/datatypes' PSP codec (MIT), whose blend
// arithmetic was fitted to Paint Shop Pro 8's own composites.
//
// A file is "Paint Shop Pro Image File\n\x1a" padded to 32 bytes, the format's
// version (3.0 is Paint Shop Pro 5, 4.0 is 6, ...), then blocks: "~BK\0", an id
// and a length (3.0 has an initial chunk's length too). The main ones: the
// general image attributes (size, depth, compression), the creator's fields,
// the palette, a composite image bank (since 4.0: a thumbnail and the whole
// picture, as JPEG or as channels), a thumbnail (3.0), a tube's cells, and the
// layer bank: its layers bottom first, each an information chunk (name, kind,
// rectangles, opacity, blend mode, visibility, mask), extension blocks and its
// channels (red, green, blue or one, transparency, the user mask), stored as
// they are, run length coded or zlib'd ("LZ77"). A group layer is followed by
// the layers it holds; a mask layer hides what lies below it in its group.
//
//   → { id, cmd: 'open', bytes }       ← { info, layers, thumbs, image, source }
//   → { id, cmd: 'render', changes }   ← { image, source }
//   → { id, cmd: 'layer', layerId }    ← { image } (one layer alone)
//   → { id, cmd: 'thumb', url }        ← Blob | null (the file's stored thumbnail, read with Range requests)
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const THUMB = 40;
const SIGNATURE = 'Paint Shop Pro Image File\n\x1a';

// Block ids
const B = {
    IMAGE: 0, CREATOR: 1, COLOR: 2, LAYER_BANK: 3, LAYER: 4, CHANNEL: 5, SELECTION: 6, ALPHA_BANK: 7,
    THUMBNAIL: 9, EXTENDED: 10, TUBE: 11, ADJUSTMENT_EXT: 12, VECTOR_EXT: 13, COMP_BANK: 16,
    COMP_ATTR: 17, JPEG: 18, GROUP_EXT: 25, MASK_EXT: 26, BRUSH: 27, COLOR_PROFILE: 32,
};
// A channel's bitmap type
const DIB = { IMAGE: 0, TRANS: 1, USER_MASK: 2, THUMBNAIL: 5, THUMBNAIL_TRANS: 6, COMPOSITE: 8, COMPOSITE_TRANS: 9 };
// Layer kinds (format 4.0 on; 3.0's normal and floating selection layers are both raster)
const L = { UNDEFINED: 0, RASTER: 1, FLOATING: 2, VECTOR: 3, ADJUSTMENT: 4, GROUP: 5, MASK: 6, ART_MEDIA: 7 };
const KIND = ['undefined', 'raster', 'floating selection', 'vector', 'adjustment', 'group', 'mask', 'art media'];
const COMPRESSION = ['none', 'run length', 'LZ77 (zlib)', 'JPEG'];

// Blend modes, in the file's numbering
const MODES = [
    ['0', 'Normal'], ['1', 'Darken'], ['2', 'Lighten'], ['3', 'Legacy Hue'], ['4', 'Legacy Saturation'],
    ['5', 'Legacy Color'], ['6', 'Legacy Luminance'], ['7', 'Multiply'], ['8', 'Screen'], ['9', 'Dissolve'],
    ['10', 'Overlay'], ['11', 'Hard Light'], ['12', 'Soft Light'], ['13', 'Difference'], ['14', 'Dodge'],
    ['15', 'Burn'], ['16', 'Exclusion'], ['17', 'Hue'], ['18', 'Saturation'], ['19', 'Color'], ['20', 'Lightness'],
];

// --- Reading ---

class Psp {
    constructor(bytes) {
        this.b = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 36 || String.fromCharCode(...bytes.subarray(0, 27)) !== SIGNATURE) {
            throw new Error('not a Paint Shop Pro image (no "Paint Shop Pro Image File" at its start)');
        }
        this.major = this.u16(32);
        this.minor = this.u16(34);
        if (this.major < 3) throw new Error(`file format ${this.major}.${this.minor}: too old (Paint Shop Pro 5 wrote 3.0)`);
    }

    u16(p) { return this.dv.getUint16(p, true); }
    u32(p) { return this.dv.getUint32(p, true); }
    i32(p) { return this.dv.getInt32(p, true); }

    // The block at offset, inside end
    block(offset, end) {
        const header = this.major < 4 ? 14 : 10;
        if (offset + header > end) throw new Error(end < this.b.length ? 'a block runs over its bank' : 'the file is cut short');
        if (this.u32(offset) !== 0x004b427e) throw new Error(`no block at byte ${offset}: the file is damaged`);
        const id = this.u16(offset + 4);
        const init = this.major < 4 ? this.u32(offset + 6) : 0;
        const length = this.u32(offset + (this.major < 4 ? 10 : 6));
        const body = offset + header;
        if (body + length > end) throw new Error(end < this.b.length ? 'a block runs over its bank' : 'the file is cut short');
        return { id, init, body, length, end: body + length };
    }

    // The blocks from offset to end; with loose, a chunk that isn't a block (a
    // layer's bitmap count) is stepped over by its length
    *blocks(offset, end, loose) {
        while (offset < end) {
            if (loose && this.major >= 4 && !(offset + 4 <= end && this.u32(offset) === 0x004b427e)) {
                const n = offset + 4 <= end ? this.u32(offset) : 0;
                if (n < 4 || n > end - offset) throw new Error('a layer is damaged');
                offset += n;
                continue;
            }
            const b = this.block(offset, end);
            yield b;
            offset = b.end;
        }
    }

    // A block's own chunk (format 4.0 on starts it with its length), past which its sub-blocks lie
    chunk(b, min) {
        if (this.major < 4) return b.init;
        const n = b.length >= 4 ? this.u32(b.body) : 0;
        if (n < (min || 4) || n > b.length) throw new Error('a block is damaged');
        return n;
    }

    attributes(b) {
        let p = b.body;
        if (this.major >= 4) p += 4;
        if (p + 38 > b.end) throw new Error('the image attributes are cut short');
        const a = {
            width: this.u32(p), height: this.u32(p + 4), resolution: this.dv.getFloat64(p + 8, true), metric: this.b[p + 16],
            compression: this.u16(p + 17), depth: this.u16(p + 19), grey: this.b[p + 27] !== 0,
            activeLayer: this.u32(p + 32), layerCount: this.u16(p + 36),
            contents: this.major >= 4 && p + 42 <= b.end ? this.u32(p + 38) : 0,
        };
        if (!a.width || !a.height) throw new Error('the image has no size');
        if (a.width * a.height > 1 << 28) throw new Error(`${a.width} × ${a.height}: too big to show here`);
        if (a.compression > 2) throw new Error(`unknown compression ${a.compression}`);
        if (![1, 4, 8, 16, 24, 48].includes(a.depth) || (a.depth === 16 && !a.grey)) throw new Error(`${a.depth} bits a pixel: not a depth Paint Shop Pro writes`);
        if (a.depth < 8 || a.depth > 16) a.grey = false;
        return a;
    }

    // A palette, stored blue first
    palette(b) {
        let start = 4, count;
        if (this.major >= 4) {
            start = this.chunk(b, 8);
            count = this.u32(b.body + 4);
        } else count = this.u32(b.body);
        if (count > 256 || start + count * 4 > b.length) throw new Error('the palette is damaged');
        const pal = new Uint8Array(count * 3);
        for (let i = 0; i < count; i++) {
            const e = b.body + start + i * 4;
            pal[i * 3] = this.b[e + 2]; pal[i * 3 + 1] = this.b[e + 1]; pal[i * 3 + 2] = this.b[e];
        }
        return pal;
    }

    // A channel sub-block: its bitmap and channel types and its compressed data
    channel(b) {
        let p = b.body, start;
        if (this.major >= 4) {
            start = this.chunk(b, 16);
            p += 4;
        } else {
            start = b.init;
            if (start < 12) throw new Error('a channel is damaged');
        }
        const compressed = this.u32(p);
        if (compressed > b.length - start) throw new Error('a channel is cut short');
        return { bitmap: this.u16(p + 8), type: this.u16(p + 10), data: this.b.subarray(b.body + start, b.body + start + compressed) };
    }

    // The creator's fields: "~FL\0", a field id and its length
    creator(b) {
        const out = {};
        const latin1 = new TextDecoder('latin1');
        for (let p = b.body; p + 10 <= b.end && this.u32(p) === 0x004c467e;) {
            const key = this.u16(p + 4), n = this.u32(p + 6), d = p + 10;
            if (d + n > b.end) break;
            if ([0, 3, 4, 5].includes(key)) out[['title', , , 'artist', 'copyright', 'description'][key]] = latin1.decode(this.b.subarray(d, d + n)).replace(/\0+$/, '');
            else if (n === 4) out[['', 'created', 'modified', , , , 'app', 'version'][key] || 'f' + key] = this.u32(d);
            p = d + n;
        }
        return out;
    }

    tube(b) {
        let p = b.body;
        if (this.major >= 4) p += 6; else p += 2 + 513;
        if (p + 24 > b.end) return null;
        return { step: this.u32(p), cols: this.u32(p + 4), rows: this.u32(p + 8), cells: this.u32(p + 12), placement: this.u32(p + 16), selection: this.u32(p + 20) };
    }
}

// --- Channels ---

// PSP's run lengths: a count over 128 repeats the next byte count − 128 times,
// else that many bytes follow as they are
function unrle(src, size) {
    const out = new Uint8Array(size);
    let i = 0, o = 0;
    while (i < src.length && o < size) {
        let n = src[i++];
        if (n > 128) {
            n = Math.min(n - 128, size - o);
            if (i >= src.length) break;
            out.fill(src[i++], o, o + n);
        } else {
            n = Math.min(n, src.length - i, size - o);
            out.set(src.subarray(i, i + n), o);
            i += n;
        }
        o += n;
    }
    return o < size ? out.subarray(0, o) : out;
}

// A channel's samples (1, 4, 8 or 16 bits), one byte each: indexes for 1 and 4
// bits, 16-bit ones rounded to 8. The spec pads rows to 4 bytes, but 8-bit
// channels are stored unpadded; the decoded length says which.
function decodePlane(channel, compression, width, height, bits) {
    if (!channel) throw new Error('a channel is missing');
    const row = Math.ceil(width * bits / 8), padded = (row + 3) & ~3, size = padded * height;
    let src = channel.data;
    if (compression === 1) src = unrle(src, size);
    else if (compression === 2) src = fflate.unzlibSync(src);
    let stride;
    if (padded !== row && src.length >= size) stride = padded;
    else if (src.length >= row * height) stride = row;
    else throw new Error('a channel is cut short');
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        const s = y * stride, o = y * width;
        if (bits === 8) out.set(src.subarray(s, s + width), o);
        else if (bits === 1) for (let x = 0; x < width; x++) out[o + x] = (src[s + (x >> 3)] >> (7 - (x & 7))) & 1;
        else if (bits === 4) for (let x = 0; x < width; x++) out[o + x] = (src[s + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15;
        else for (let x = 0; x < width; x++) out[o + x] = Math.floor(((src[s + 2 * x] | (src[s + 2 * x + 1] << 8)) * 255 + 32767) / 65535);
    }
    return out;
}

// A colour bitmap (channels by type: 0 grey or palette indexes, 1 to 3 red,
// green, blue) and its transparency, as RGBA
function decodeBitmap(depth, grey, palette, compression, colour, trans, width, height) {
    const n = width * height, rgba = new Uint8Array(n * 4);
    if (depth >= 24) {
        for (let c = 0; c < 3; c++) {
            const plane = decodePlane(colour[c + 1], compression, width, height, depth / 3);
            for (let i = 0; i < n; i++) rgba[i * 4 + c] = plane[i];
        }
    } else {
        const plane = decodePlane(colour[0], compression, width, height, depth);
        const colours = palette ? palette.length / 3 : 0;
        for (let i = 0; i < n; i++) {
            const v = plane[i], o = i * 4;
            if (grey) rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
            else if (v < colours) { rgba[o] = palette[v * 3]; rgba[o + 1] = palette[v * 3 + 1]; rgba[o + 2] = palette[v * 3 + 2]; }
        }
    }
    if (trans) {
        const plane = decodePlane(trans, compression, width, height, 8);
        for (let i = 0; i < n; i++) rgba[i * 4 + 3] = plane[i];
    } else for (let i = 0; i < n; i++) rgba[i * 4 + 3] = 255;
    return rgba;
}

// --- Stored pictures: the composite image bank (format 4.0 on), the thumbnail block (3.0) ---

// Each picture in a composite image bank: { width, height, depth, compression,
// type (0 the composite, 1 the thumbnail), jpeg | (palette, colour, trans) }
function compositeBank(f, bank) {
    const attrs = [], images = [];
    for (const b of f.blocks(bank.body + f.chunk(bank), bank.end)) {
        if (b.id === B.COMP_ATTR) {
            const p = b.body;
            if (b.length < 24) throw new Error('a composite image is damaged');
            attrs.push({ width: f.u32(p + 4), height: f.u32(p + 8), depth: f.u16(p + 12), compression: f.u16(p + 14), type: f.u16(p + 22) });
        } else if (b.id === B.JPEG || b.id === B.THUMBNAIL) {
            // pictures follow their attributes in the same order
            const a = attrs[images.length];
            if (!a) throw new Error('a composite image has no attributes');
            const image = { ...a };
            const start = f.chunk(b);
            if (b.id === B.JPEG) {
                const size = Math.min(f.u32(b.body + 4), b.length - start);
                image.jpeg = f.b.subarray(b.body + start, b.body + start + size);
            } else {
                image.colour = [];
                for (const s of f.blocks(b.body + start, b.end)) {
                    if (s.id === B.COLOR) image.palette = f.palette(s);
                    else if (s.id === B.CHANNEL) {
                        const c = f.channel(s);
                        if ((c.bitmap === DIB.COMPOSITE || c.bitmap === DIB.THUMBNAIL) && c.type < 4) image.colour[c.type] = c;
                        else if (c.bitmap === DIB.COMPOSITE_TRANS || c.bitmap === DIB.THUMBNAIL_TRANS) image.trans = c;
                    }
                }
            }
            images.push(image);
        }
    }
    return images;
}

// Format 3.0's thumbnail block: its attributes, a palette, its channels
function thumbnailBlock(f, b) {
    const p = b.body;
    const image = { width: f.u32(p), height: f.u32(p + 4), depth: f.u16(p + 8), compression: f.u16(p + 10), type: 1, colour: [] };
    for (const s of f.blocks(b.body + b.init, b.end)) {
        if (s.id === B.COLOR) image.palette = f.palette(s);
        else if (s.id === B.CHANNEL) {
            const c = f.channel(s);
            if (c.bitmap === DIB.THUMBNAIL && c.type < 4) image.colour[c.type] = c;
            else if (c.bitmap === DIB.THUMBNAIL_TRANS) image.trans = c;
        }
    }
    return image;
}

// A stored picture as RGBA (a JPEG decoded by the browser)
async function storedPixels(image, grey) {
    if (image.jpeg) {
        const bitmap = await createImageBitmap(new Blob([image.jpeg], { type: 'image/jpeg' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return { width: canvas.width, height: canvas.height, rgba: new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer) };
    }
    if (image.compression > 2 || ![1, 4, 8, 24, 48].includes(image.depth)) throw new Error('a stored picture of a kind not known');
    const isGrey = image.depth === 8 && !image.palette && grey;
    if (image.depth <= 8 && !image.palette && !isGrey) throw new Error('a stored picture has no palette');
    return {
        width: image.width, height: image.height,
        rgba: decodeBitmap(image.depth, isGrey, image.palette, image.compression, image.colour, image.trans, image.width, image.height),
    };
}

// --- Layers ---

// The canvas position and size of a saved rectangle (left, top, right, bottom),
// which lies within the outer one and is relative to its corner
function rects(f, outer, saved) {
    const left = f.i32(saved), top = f.i32(saved + 4), right = f.i32(saved + 8), bottom = f.i32(saved + 12);
    if (right < left || bottom < top) throw new Error('a layer\'s rectangle is inside out');
    return { x: f.i32(outer) + left, y: f.i32(outer + 4) + top, width: right - left, height: bottom - top };
}

function readLayer(f, b, id) {
    const latin1 = new TextDecoder('latin1');
    let info, q, name;
    const l = { id, colour: [], trans: null, mask: null, children: 0, extensions: [] };
    if (f.major >= 4) {
        info = f.u32(b.body);
        const n = f.u16(b.body + 4);
        if (info > b.length || info < 6 + n + 72) throw new Error('a layer is damaged');
        name = latin1.decode(f.b.subarray(b.body + 6, b.body + 6 + n));
        q = b.body + 6 + n;
        l.type = f.b[q];
        l.visible = (f.b[q + 35] & 1) === 1;
        l.maskInvert = info >= 6 + n + 73 ? f.b[q + 72] !== 0 : false;
    } else {
        info = b.init;
        if (info < 331) throw new Error('a layer is damaged');
        name = latin1.decode(f.b.subarray(b.body, b.body + 256)).replace(/\0.*$/s, '');
        q = b.body + 256;
        l.type = L.RASTER;
        l.visible = f.b[q + 35] !== 0;
        l.maskInvert = f.b[q + 72] !== 0;
    }
    l.name = name;
    l.opacity = f.b[q + 33];
    l.blend = f.b[q + 34];
    l.protected = f.b[q + 36] !== 0;
    l.maskDisabled = f.b[q + 71] !== 0;
    Object.assign(l, rects(f, q + 1, q + 17));
    const m = rects(f, q + 38, q + 54);
    l.maskX = m.x; l.maskY = m.y; l.maskWidth = m.width; l.maskHeight = m.height;
    // the extensions and channels after the information chunk (and, from 4.0, the bitmap count chunk)
    for (const s of f.blocks(b.body + info, b.end, true)) {
        if (s.id === B.CHANNEL) {
            const c = f.channel(s);
            if (c.bitmap === DIB.IMAGE && c.type < 4) l.colour[c.type] = c;
            else if (c.bitmap === DIB.TRANS) l.trans = c;
            else if (c.bitmap === DIB.USER_MASK) l.mask = c;
        } else if (s.id === B.GROUP_EXT) {
            if (s.length < 8) throw new Error('a group layer is damaged');
            l.children = f.u32(s.body + 4);
        } else l.extensions.push(s.id);
    }
    if (l.type === L.UNDEFINED && (l.colour[0] || l.colour[1])) l.type = L.RASTER;
    return l;
}

// --- Blending: Paint Shop Pro's arithmetic, as its own composites show it ---
// (bitplane/datatypes' fit to Paint Shop Pro 8 over every mode, opacity and pair
// of alphas). s is the layer's colour, a its alpha (transparency and masks), o its
// opacity; d the colour below, da its alpha. With ao = a·o the result's alpha is
// always ao + da·(1 − ao).

const mul255 = (a, b) => Math.floor((a * b + 127) / 255);
const round = v => Math.floor(v + 0.5);
const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;

// The separable modes, on 0..255
function separable(mode, s, d) {
    switch (mode) {
        case 1: return Math.min(s, d);
        case 2: return Math.max(s, d);
        case 7: return round(s * d / 255);
        case 8: return 255 - round((255 - s) * (255 - d) / 255);
        case 10: return d < 128 ? round(2 * s * d / 255) : 255 - round(2 * (255 - s) * (255 - d) / 255);
        case 11: return s < 128 ? round(2 * s * d / 255) : 255 - round(2 * (255 - s) * (255 - d) / 255);
        case 12: {
            const sf = s / 255, df = d / 255;
            return sf <= 0.5 ? round((2 * sf * df + df * df * (1 - 2 * sf)) * 255) : round((2 * df * (1 - sf) + Math.sqrt(df) * (2 * sf - 1)) * 255);
        }
        case 13: return Math.abs(s - d);
        case 16: return s + d - round(2 * s * d / 255);
        default: return s;
    }
}

// The legacy hue, saturation, colour and luminance modes keep luminosity (0.3, 0.59, 0.11)
const lumOf = c => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
function setLum(c, l) {
    const d = l - lumOf(c);
    for (let i = 0; i < 3; i++) c[i] += d;
    l = lumOf(c);
    const n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) {
        if (n < 0 && l - n > 0) c[i] = l + (c[i] - l) * l / (l - n);
        if (x > 1 && x - l > 0) c[i] = l + (c[i] - l) * (1 - l) / (x - l);
    }
}
function setSat(c, s) {
    let max = 0, min = 0;
    for (let i = 1; i < 3; i++) { if (c[i] > c[max]) max = i; if (c[i] < c[min]) min = i; }
    if (c[max] <= c[min]) { c[0] = c[1] = c[2] = 0; return; }
    const mid = 3 - max - min;
    c[mid] = (c[mid] - c[min]) * s / (c[max] - c[min]);
    c[max] = s;
    c[min] = 0;
}
const satOf = c => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function luminosityBlend(kind, s8, d8, out) {
    const s = s8.map(v => v / 255), d = d8.map(v => v / 255);
    let t;
    if (kind === 3) { t = s.slice(); setSat(t, satOf(d)); setLum(t, lumOf(d)); }
    else if (kind === 4) { t = d.slice(); setSat(t, satOf(s)); setLum(t, lumOf(d)); }
    else if (kind === 5) { t = s.slice(); setLum(t, lumOf(d)); }
    else { t = d.slice(); setLum(t, lumOf(s)); }
    for (let i = 0; i < 3; i++) out[i] = round(clamp255(t[i] * 255));
}

// Paint Shop Pro 8's hue, saturation, colour and lightness modes swap HSL components
function toHsl(c) {
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    if (d <= 0) return [0, 0, l];
    const s = d / (l < 0.5 ? mx + mn : 2 - mx - mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}
function huePart(p, q, t) {
    t -= Math.trunc(t);
    if (t < 0) t += 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
}
function fromHsl(h, s, l, out) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    out[0] = round(huePart(p, q, h + 1 / 3) * 255);
    out[1] = round(huePart(p, q, h) * 255);
    out[2] = round(huePart(p, q, h - 1 / 3) * 255);
}
function hslBlend(mode, s, d, out) {
    const [sh, ss, sl] = toHsl(s), [dh, ds, dl] = toHsl(d);
    if (mode === 17) fromHsl(ss > 0 ? sh : dh, ds, dl, out);
    else if (mode === 18) fromHsl(dh, ss, dl, out);
    else if (mode === 19) fromHsl(sh, ss, dl, out);
    else fromHsl(dh, ds, sl, out);
}

function blendColour(mode, s, d, out) {
    if (mode >= 3 && mode <= 6) luminosityBlend(mode, s, d, out);
    else if (mode >= 17) hslBlend(mode, s, d, out);
    else for (let i = 0; i < 3; i++) out[i] = separable(mode, s[i], d[i]);
}

// A stable threshold a pixel for dissolve (Paint Shop Pro's own noise isn't known)
function dissolveNoise(x, y) {
    let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y + 0x7f4a7c15, 0x85ebca77)) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
    return (h >>> 0) % 255;
}

// Normal mode in integers: plain "over"
function putNormal(src, si, a, dst, di) {
    if (a === 0) return;
    const da = dst[di + 3], oa = a * 255 + da * (255 - a);
    for (let i = 0; i < 3; i++) dst[di + i] = Math.floor((a * 255 * src[si + i] + (255 - a) * da * dst[di + i] + Math.floor(oa / 2)) / oa);
    dst[di + 3] = Math.floor((oa + 127) / 255);
}

const S = [0, 0, 0], D = [0, 0, 0], BL = [0, 0, 0], COL = [0, 0, 0], N3 = [0, 0, 0], Y3 = [0, 0, 0];

// One pixel of colour src[si], alpha a8 and opacity o8 (0..255) over dst[di]
function putPixel(mode, src, si, a8, o8, dst, di, x, y) {
    if (mode === 0 || mode === 9) {
        let k = mul255(a8, o8);
        if (mode === 9) k = dissolveNoise(x, y) < k ? 255 : 0;
        putNormal(src, si, k, dst, di);
        return;
    }
    if (a8 === 0 || o8 === 0) return;
    const a = a8 / 255, o = o8 / 255, da = dst[di + 3] / 255, ao = a * o, oa = ao + da * (1 - ao);
    for (let i = 0; i < 3; i++) { S[i] = src[si + i]; D[i] = dst[di + i]; }
    if (mode === 14 || mode === 15) {
        // dodge, and burn as dodge in inverted colours, against the premultiplied
        // colour below; opacity and alpha move the layer's toward the neutral one
        for (let i = 0; i < 3; i++) {
            const sv = mode === 15 ? 255 - S[i] : S[i], dv = mode === 15 ? 255 - D[i] : D[i];
            const sn = sv * ao, dn = dv * da;
            let v = sn >= 255 ? (dn > 0 ? 255 : 0) : Math.min(255, round(dn * 255 / (255 - sn)));
            v = Math.min(255, v / oa);
            COL[i] = mode === 15 ? 255 - v : v;
        }
    } else if (mode === 13) {
        // difference: opacity moves the layer's colour toward black
        const w = 1 - (1 - a) * (1 - ao);
        for (let i = 0; i < 3; i++) {
            const sn = round(S[i] * o), bv = Math.abs(sn - D[i]);
            COL[i] = (ao * (1 - da) * S[i] + w * da * bv + (1 - w) * da * D[i]) / oa;
        }
    } else if (mode === 12) {
        // soft light, against the colour below faded toward grey where it's transparent
        for (let i = 0; i < 3; i++) {
            const dg = round(128 + (D[i] - 128) * da);
            COL[i] = (ao * separable(12, S[i], dg) + (1 - ao) * da * D[i]) / oa;
        }
    } else if (mode === 6) {
        // legacy luminance: the normal composite's luminance, given to the colours mixed at the lower pixel's full alpha
        const k = ao * (1 - da) + da;
        for (let i = 0; i < 3; i++) {
            N3[i] = round((ao * S[i] + (1 - ao) * da * D[i]) / oa);
            Y3[i] = round((ao * (1 - da) * S[i] + da * D[i]) / k);
        }
        luminosityBlend(6, N3, Y3, COL);
    } else {
        // the other modes count the layer's transparency twice
        blendColour(mode, S, D, BL);
        const w = ao * (1 + o * (1 - a));
        for (let i = 0; i < 3; i++) COL[i] = (ao * (1 - da) * S[i] + w * da * BL[i] + (1 - w) * da * D[i]) / oa;
    }
    for (let i = 0; i < 3; i++) dst[di + i] = round(clamp255(COL[i]));
    dst[di + 3] = round(clamp255(oa * 255));
}

// --- The document ---

let doc = null;

function openPsp(bytes) {
    const f = new Psp(bytes);
    let attrs = null, palette = null, creator = {}, tube = null, bank = null, thumb3 = null, layerBank = null;
    const other = new Set();
    for (const b of f.blocks(36, bytes.length)) {
        if (!attrs) {
            if (b.id !== B.IMAGE) throw new Error('the file doesn\'t start with its image attributes');
            attrs = f.attributes(b);
        } else if (b.id === B.COLOR) palette = f.palette(b);
        else if (b.id === B.CREATOR) creator = f.creator(b);
        else if (b.id === B.TUBE) tube = f.tube(b);
        else if (b.id === B.COMP_BANK && f.major >= 4 && !bank) bank = b;
        else if (b.id === B.THUMBNAIL && f.major < 4) thumb3 = b;
        else if (b.id === B.LAYER_BANK && !layerBank) layerBank = b;
        else other.add(b.id);
    }
    if (!attrs) throw new Error('the file has no image attributes');
    if (!layerBank) throw new Error('the file has no layers: it is cut short');
    if (attrs.depth <= 8 && !attrs.grey && !palette) throw new Error('a paletted image without its palette');

    const layers = [];
    for (const b of f.blocks(layerBank.body, layerBank.end)) {
        if (b.id !== B.LAYER) throw new Error('the layer bank holds something not a layer');
        layers.push(readLayer(f, b, layers.length));
    }
    // the layers as a tree, as the groups nest them (bottom first)
    let index = 0;
    const tree = (count, depth, parent) => {
        const level = [];
        for (let k = 0; k < count && index < layers.length; k++) {
            const l = layers[index++];
            l.depth = depth;
            l.parent = parent;
            level.push(l);
            if (l.type === L.GROUP) l.kids = depth < 64 ? tree(l.children, depth + 1, l) : [];
        }
        return level;
    };
    const roots = [];
    while (index < layers.length) roots.push(...tree(layers.length - index, 0, null));

    const stored = [];
    let storedProblem = '';
    try {
        if (bank) stored.push(...compositeBank(f, bank));
        if (thumb3) stored.push(thumbnailBlock(f, thumb3));
    } catch (err) { storedProblem = err.message; }
    doc = { f, attrs, palette, layers, roots, stored, cache: new Map(), original: null };
    for (const l of layers) {
        if ([L.RASTER, L.FLOATING].includes(l.type) && l.blend > 20) l.problem = `blend mode ${l.blend}: not known`;
        else if (l.type === L.VECTOR) l.problem = 'a vector layer: not drawn here';
        else if (l.type === L.ADJUSTMENT) l.problem = 'an adjustment layer: not applied here';
        else if (l.type === L.ART_MEDIA) l.problem = 'an art media layer: not drawn here';
        else if (l.type > L.ART_MEDIA) l.problem = `layer kind ${l.type}: not known`;
    }
    return {
        width: attrs.width, height: attrs.height, version: `${f.major}.${f.minor}`, depth: attrs.depth, grey: attrs.grey,
        compression: COMPRESSION[attrs.compression], resolution: attrs.resolution, metric: attrs.metric,
        colours: palette ? palette.length / 3 : 0, creator, tube, modes: MODES, storedProblem,
        stored: stored.map(s => ({ type: s.type, width: s.width, height: s.height, jpeg: !!s.jpeg, alpha: !!s.trans })),
        profile: other.has(B.COLOR_PROFILE), selection: other.has(B.SELECTION), alphaChannels: other.has(B.ALPHA_BANK),
    };
}

function layerPixels(l) {
    let p = doc.cache.get(l.id);
    if (!p) {
        const a = doc.attrs;
        p = {};
        if (l.type !== L.MASK && l.width && l.height && (l.colour[0] || l.colour[1])) {
            p.rgba = decodeBitmap(a.depth, a.grey, doc.palette, a.compression, l.colour, l.trans, l.width, l.height);
        }
        if (l.mask && l.maskWidth && l.maskHeight) {
            p.mask = decodePlane(l.mask, a.compression, l.maskWidth, l.maskHeight, 8);
            if (l.maskInvert) for (let i = 0; i < p.mask.length; i++) p.mask[i] = 255 - p.mask[i];
        }
        doc.cache.set(l.id, p);
    }
    return p;
}

// The mask value at canvas x, y: 0 outside its rectangle
function maskAt(l, mask, x, y) {
    x -= l.maskX; y -= l.maskY;
    return x < 0 || y < 0 || x >= l.maskWidth || y >= l.maskHeight ? 0 : mask[y * l.maskWidth + x];
}

function drawRaster(l, mode, opacity, useMask, canvas) {
    const { width, height } = doc.attrs;
    const p = layerPixels(l);
    if (!p.rgba) return;
    // Paint Shop Pro gives a layer with no transparency channel, as it writes the
    // background, no opacity in normal mode
    if (mode === 0 && !l.trans) opacity = 255;
    if (!opacity) return;
    const mask = useMask && p.mask && !l.maskDisabled ? p.mask : null;
    const x0 = Math.max(0, l.x), y0 = Math.max(0, l.y), x1 = Math.min(width, l.x + l.width), y1 = Math.min(height, l.y + l.height);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const si = ((y - l.y) * l.width + (x - l.x)) * 4;
            let a = p.rgba[si + 3];
            if (mask) a = mul255(a, maskAt(l, mask, x, y));
            putPixel(mode, p.rgba, si, a, opacity, canvas, (y * width + x) * 4, x, y);
        }
    }
}

// A mask layer hides what lies below it in its group
function drawMask(l, opacity, canvas) {
    const p = layerPixels(l);
    if (!p.mask || l.maskDisabled) return;
    const { width, height } = doc.attrs;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4 + 3;
        canvas[i] = mul255(canvas[i], 255 - mul255(255 - maskAt(l, p.mask, x, y), opacity));
    }
}

function setting(l, changes, key) {
    const c = changes[l.id];
    if (c && c[key] !== undefined) return key === 'mode' ? +c[key] : key === 'opacity' ? Math.round(c[key] * 255) : c[key];
    return key === 'mode' ? l.blend : l[key];
}

// Draw a level of the tree (bottom first) onto canvas; whether any visible layer couldn't be drawn
function drawLevel(level, changes, canvas) {
    let missing = false;
    for (const l of level) {
        if (!setting(l, changes, 'visible')) continue;
        const mode = setting(l, changes, 'mode'), opacity = setting(l, changes, 'opacity');
        if (l.type === L.GROUP) {
            const group = new Uint8Array(canvas.length);
            missing = drawLevel(l.kids, changes, group) || missing;
            if (mode > 20) { missing = true; continue; }
            const width = doc.attrs.width;
            for (let i = 0, n = canvas.length / 4; i < n; i++) {
                putPixel(mode, group, i * 4, group[i * 4 + 3], opacity, canvas, i * 4, i % width, Math.floor(i / width));
            }
        } else if (l.type === L.RASTER || l.type === L.FLOATING || l.type === L.MASK) {
            if (mode > 20 || l.problem) { missing = true; continue; }
            try {
                if (l.type === L.MASK) drawMask(l, opacity, canvas); else drawRaster(l, mode, opacity, true, canvas);
            } catch (err) {
                l.problem = err.message;
                missing = true;
            }
        }
        else if (l.type !== L.UNDEFINED) missing = true;
    }
    return missing;
}

function composite(changes) {
    const canvas = new Uint8Array(doc.attrs.width * doc.attrs.height * 4);
    const missing = drawLevel(doc.roots, changes, canvas);
    return { canvas, missing };
}

// The picture as saved: the layers composited here, or Paint Shop Pro's own
// composite when the layers hold what isn't drawn here (vector, adjustment and
// art media layers) or when it is lossless and keeps the transparency (it is
// flattened over white without its mask)
async function original() {
    const { canvas, missing } = composite({});
    const { width, height } = doc.attrs;
    let opaque = true;
    for (let i = 3; i < canvas.length; i += 4) if (canvas[i] !== 255) { opaque = false; break; }
    const full = doc.stored.filter(s => s.type === 0 && s.width === width && s.height === height);
    const lossless = full.find(s => !s.jpeg);
    const pick = missing ? lossless || full[0] : lossless && (lossless.trans || opaque) ? lossless : null;
    if (pick) {
        try {
            const s = await storedPixels(pick, doc.attrs.grey);
            if (s.width === width && s.height === height) {
                return { image: s.rgba, source: pick.jpeg ? 'stored-jpeg' : 'stored', missing };
            }
        } catch (err) { /* the layers, then */ }
    }
    return { image: canvas, source: 'composited', missing };
}

// One layer alone at full opacity, its mask applied
function layerAlone(id) {
    const l = doc.layers[id];
    const canvas = new Uint8Array(doc.attrs.width * doc.attrs.height * 4);
    if (l.type === L.GROUP) drawLevel(l.kids, {}, canvas);
    else if (l.type === L.MASK) {
        const p = layerPixels(l);
        for (let y = 0; y < doc.attrs.height; y++) for (let x = 0; x < doc.attrs.width; x++) {
            const v = p.mask ? maskAt(l, p.mask, x, y) : 0, i = (y * doc.attrs.width + x) * 4;
            canvas[i] = canvas[i + 1] = canvas[i + 2] = v; canvas[i + 3] = 255;
        }
    } else drawRaster(l, 0, 255, true, canvas);
    return canvas;
}

// A small preview of a layer over the whole canvas, RGBA (a mask layer's mask in grey)
function thumbnail(l) {
    const p = layerPixels(l);
    if (!p.rgba && !(l.type === L.MASK && p.mask)) return null;
    const { width, height } = doc.attrs;
    const s = Math.min(1, THUMB / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * s)), th = Math.max(1, Math.round(height * s));
    const data = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const cx = Math.min(width - 1, Math.floor((x + 0.5) / s)), cy = Math.min(height - 1, Math.floor((y + 0.5) / s));
        const o = (y * tw + x) * 4;
        if (p.rgba) {
            const lx = cx - l.x, ly = cy - l.y;
            if (lx < 0 || ly < 0 || lx >= l.width || ly >= l.height) continue;
            const i = (ly * l.width + lx) * 4;
            data[o] = p.rgba[i]; data[o + 1] = p.rgba[i + 1]; data[o + 2] = p.rgba[i + 2]; data[o + 3] = p.rgba[i + 3];
        } else {
            data[o] = data[o + 1] = data[o + 2] = maskAt(l, p.mask, cx, cy); data[o + 3] = 255;
        }
    }
    return { width: tw, height: th, data };
}

// --- The file browser's thumbnail: the stored thumbnail, read with Range requests ---

async function fetchRange(url, start, end) {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // a server that ignores Range sends the whole file
    return { bytes: resp.status === 206 ? bytes : bytes.subarray(start, end + 1), whole: resp.status !== 206 ? bytes : null };
}

async function storedThumbnail(url) {
    let { bytes: head, whole } = await fetchRange(url, 0, 65535);
    if (head.length < 36 || String.fromCharCode(...head.subarray(0, 27)) !== SIGNATURE) return null;
    const major = head[32] | (head[33] << 8);
    const headerSize = major < 4 ? 14 : 10;
    // the bytes from offset to end, fetched as needed
    const take = async (offset, end) => {
        if (whole) return whole.subarray(offset, end);
        if (end <= head.length) return head.subarray(offset, end);
        return (await fetchRange(url, offset, end - 1)).bytes;
    };
    let grey = false;
    for (let offset = 36; ;) {
        const h = await take(offset, offset + headerSize);
        if (h.length < headerSize || h[0] !== 0x7e || h[1] !== 0x42 || h[2] !== 0x4b) return null;
        const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
        const id = dv.getUint16(4, true), length = dv.getUint32(major < 4 ? 10 : 6, true);
        const body = offset + headerSize;
        if (id === B.IMAGE) {
            const b = await take(body, body + Math.min(length, 64));
            grey = b[(major >= 4 ? 4 : 0) + 27] !== 0 && (b[(major >= 4 ? 4 : 0) + 19] === 8);
        } else if ((id === B.COMP_BANK && major >= 4) || (id === B.THUMBNAIL && major < 4)) {
            // the block alone, as a file of its own to read it with
            const block = await take(offset, body + length);
            const bytes = new Uint8Array(36 + block.length);
            bytes.set(head.subarray(0, 36));
            bytes.set(block, 36);
            const f = new Psp(bytes);
            const b = f.block(36, bytes.length);
            const images = id === B.COMP_BANK ? compositeBank(f, b) : [thumbnailBlock(f, b)];
            const pick = images.find(i => i.type === 1) || images.find(i => i.type === 0);
            if (!pick) return null;
            if (pick.jpeg) return new Blob([pick.jpeg], { type: 'image/jpeg' });
            const s = await storedPixels(pick, grey);
            const canvas = new OffscreenCanvas(s.width, s.height);
            canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(s.rgba.buffer), s.width, s.height), 0, 0);
            return canvas.convertToBlob({ type: 'image/png' });
        } else if (id === B.LAYER_BANK) return null; // no stored picture before the layers
        offset = body + length;
    }
}

self.onmessage = async ({ data }) => {
    const { id, cmd } = data;
    try {
        if (cmd === 'open') {
            const info = openPsp(new Uint8Array(data.bytes));
            const thumbs = {};
            for (const l of doc.layers) {
                try { const t = thumbnail(l); if (t) thumbs[l.id] = t; } catch (err) { l.problem = err.message; }
            }
            doc.original = await original();
            // listed top first, a group above what it holds, as Paint Shop Pro's Layers palette has them
            const listed = [];
            const list = level => {
                for (const l of level.slice().reverse()) {
                    listed.push({
                        id: l.id, name: l.name, kind: KIND[l.type] || `kind ${l.type}`, type: l.type, depth: l.depth,
                        visible: l.visible, opacity: l.opacity / 255, mode: String(l.blend), problem: l.problem || '',
                        hasMask: !!l.mask, maskDisabled: l.maskDisabled, protected: l.protected,
                    });
                    if (l.kids) list(l.kids);
                }
            };
            list(doc.roots);
            const image = doc.original.image.slice();
            info.source = doc.original.source;
            info.missing = doc.original.missing;
            self.postMessage({ id, result: { info, layers: listed, thumbs, image, source: doc.original.source } }, [image.buffer]);
        } else if (cmd === 'render') {
            const changes = data.changes || {};
            const r = Object.keys(changes).length ? { image: composite(changes).canvas, source: 'composited' }
                : { image: doc.original.image.slice(), source: doc.original.source };
            self.postMessage({ id, result: r }, [r.image.buffer]);
        } else if (cmd === 'layer') {
            const image = layerAlone(data.layerId);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else if (cmd === 'thumb') {
            self.postMessage({ id, result: await storedThumbnail(data.url) });
        }
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
