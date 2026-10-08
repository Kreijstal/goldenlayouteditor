// Corel PHOTO-PAINT images (.cpt): PHOTO-PAINT 7 on's ("CPT7FILE", "CPT8FILE",
// "CPT9FILE") and PHOTO-PAINT 6's (a TIFF), read and composited in a worker, for the
// CPT viewer (src/cpt-plugin.js). Written from the files themselves, Ireneusz
// Argasinski's draft notes on the header ("CPT file format specification" 0.01) and
// dexvert's notes on the tile codings, and fitted to what Corel PHOTO-PAINT 8 and 10
// show of the same files (and of files PHOTO-PAINT 8 was made to write: every merge
// mode at two opacities, hidden objects, clip masks, clipping, colour models).
//
// A file is a 256-byte header ("CPT7FILE", the colour model, the palette's size,
// the resolution in dots per metre ×10⁻⁴, the number of blocks, where the block table
// is: after the palette, or at 0x34's offset in a "CPT9FILE"), the palette (768
// bytes, B, G, R) of a paletted image, then the block table (each block's offset, 8
// bytes apiece) and the blocks. A block is a 60-byte header (width, height, tile
// width and height, bits per pixel, its type: 1 the background, 2 a mask or saved
// channel, 4 the transparency of the object before it, 8 an object, 16 the
// thumbnail, 128 the clip mask of the object before it; whether it has a clip mask;
// the size of what follows), its properties (a version 9 file's as tagged records:
// oinf, anam, viac...), the table of its tiles (offset, size), bottom row of tiles
// first, and the tiles: each its rows, bottom first, BGR (or the model's samples),
// padded to 4 bytes; stored as they are or after a 4-byte header: its coding (1
// stored, 2 LZW, 4 one colour, 5 deltas packed in 1 to 8 bits, 16 for 16-bit
// samples) and whether the rows were predicted (3: the first row from the pixel to
// the left, the others from the row below).
//
// An object's properties: its bounds in the picture (left, top, right, bottom, the y
// axis pointing up), its group, whether selected, visible, opacity 0-100, merge mode,
// name, the bounds of what's painted, whether it has a clip mask, the clip mask on,
// clipped to the object below (from PHOTO-PAINT 9: only within the bounds of what
// that one has painted). A clip mask has bounds of its own.
//
// PHOTO-PAINT 6's file is a TIFF: each block a directory with the same properties in
// private tag 40999, rows bottom first.
//   → { id, cmd: 'open', bytes }                     ← { info, layers, thumbs, stored, image }
//   → { id, cmd: 'render', changes, paper }          ← { image }
//   → { id, cmd: 'layer', layerId }                  ← { image } (one layer alone)
//   → { id, cmd: 'thumbnail', url, max }             ← { image, width, height } or null (the stored thumbnail, read
//                                                      with Range requests; without one, the picture shrunk)

const THUMB = 40;

// Merge modes by the number the file keeps (PHOTO-PAINT's scripts number them differently);
// 18 to 21 put the object's sample into one of the pixel's: B, G, R in RGB, C, M, Y, K in CMYK
const MODES = [
    [0, 'normal', 'Normal'], [7, 'add', 'Add'], [8, 'subtract', 'Subtract'], [22, 'difference', 'Difference'],
    [9, 'multiply', 'Multiply'], [10, 'divide', 'Divide'], [11, 'lighter', 'If Lighter'], [12, 'darker', 'If Darker'],
    [13, 'texturize', 'Texturize'], [14, 'color', 'Color'], [15, 'hue', 'Hue'], [16, 'saturation', 'Saturation'],
    [17, 'lightness', 'Lightness'], [6, 'invert', 'Invert'], [1, 'and', 'Logical AND'], [2, 'or', 'Logical OR'],
    [3, 'xor', 'Logical XOR'], [27, 'behind', 'Behind'], [28, 'screen', 'Screen'], [29, 'overlay', 'Overlay'],
    [30, 'softlight', 'Soft Light'], [31, 'hardlight', 'Hard Light'],
    [20, 'channel2', 'Red'], [19, 'channel1', 'Green'], [18, 'channel0', 'Blue'], [21, 'channel3', 'Black'],
];
const CMYK_CHANNELS = { channel0: 'Cyan', channel1: 'Magenta', channel2: 'Yellow', channel3: 'Black' };
const MODE_BY_NUMBER = new Map(MODES.map(([n, k]) => [n, k]));

// Colour models (the header's)
const MODELS = {
    1: { name: 'RGB', bits: 24 }, 3: { name: 'CMYK', bits: 32 }, 5: { name: 'Grayscale', bits: 8 },
    6: { name: 'Black and white', bits: 1 }, 10: { name: 'Paletted', bits: 8 }, 11: { name: 'Lab', bits: 24 },
    12: { name: 'RGB 48-bit', bits: 48 }, 14: { name: 'Grayscale 16-bit', bits: 16 },
};

let doc = null;
let changes = {};
let paper = false;

const latin1 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
function cString(bytes, at, max) {
    let n = 0;
    while (n < max && at + n < bytes.length && bytes[at + n]) n++;
    return new TextDecoder('windows-1252').decode(bytes.subarray(at, at + n));
}

// --- Tile codings ---

// 5: a byte per run (its count less one in the low 5 bits, the bits per value less one
// above; 0: that many zeros) then the values, sign-extended; bits read least significant
// first. 16-bit samples: 4 bits of count and 4 of bits per value, the values 16-bit
function unpackBits(src, out, wide) {
    let pos = 0, bit = 0, o = 0;
    const read = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++) {
            if (pos < src.length) v |= ((src[pos] >> bit) & 1) << i;
            if (++bit === 8) { bit = 0; pos++; }
        }
        return v;
    };
    const countBits = wide ? 4 : 5, n = wide ? out.length >> 1 : out.length;
    const words = wide ? new Uint16Array(out.buffer, out.byteOffset, n) : out;
    while (o < n && pos < src.length) {
        const h = read(8);
        const count = (h & ((1 << countBits) - 1)) + 1, bits = (h >> countBits) + 1;
        if (bits === 1) { o += count; continue; }
        const sign = 1 << (bits - 1), ext = -1 << bits;
        for (let i = 0; i < count && o < n; i++) {
            const v = read(bits);
            words[o++] = v & sign ? v | ext : v;
        }
    }
}

// 2: LZW, 9 to 12 bits least significant first, 256 clears, 257 ends, the code
// width growing a code early (as TIFF's)
function lzw(src, out) {
    const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), length = new Uint16Array(4096);
    for (let i = 0; i < 256; i++) { suffix[i] = i; length[i] = 1; prefix[i] = -1; }
    let pos = 0, acc = 0, nbits = 0, width = 9, next = 258, prev = -1, o = 0;
    const stack = new Uint8Array(4096);
    while (o < out.length) {
        while (nbits < width && pos < src.length) { acc |= src[pos++] << nbits; nbits += 8; }
        if (nbits < width) break;
        const code = acc & ((1 << width) - 1);
        acc >>>= width; nbits -= width;
        if (code === 256) { width = 9; next = 258; prev = -1; continue; }
        if (code === 257) break;
        let c = code, first;
        if (c < next) {
            // write the string out back to front
            let n = 0;
            for (let k = c; k >= 0; k = prefix[k]) stack[n++] = suffix[k];
            first = stack[n - 1];
            while (n && o < out.length) out[o++] = stack[--n];
        } else if (c === next && prev >= 0) {
            let n = 0;
            for (let k = prev; k >= 0; k = prefix[k]) stack[n++] = suffix[k];
            first = stack[n - 1];
            while (n && o < out.length) out[o++] = stack[--n];
            if (o < out.length) out[o++] = first;
        } else break;
        if (prev >= 0 && next < 4096) {
            prefix[next] = prev; suffix[next] = first; length[next] = length[prev] + 1;
            next++;
            if (next >= (1 << width) - 1 && width < 12) width++;
        }
        prev = c;
    }
}

// A tile's rows: stride bytes each, bottom first
function decodeTile(bytes, at, size, raw, bpp, stride, fill) {
    const out = new Uint8Array(raw);
    if (size <= 0 || at >= bytes.length) return out;
    size = Math.min(size, bytes.length - at);
    const coding = bytes[at] | (bytes[at + 1] << 8), filter = bytes[at + 2] | (bytes[at + 3] << 8);
    // stored without a header: exactly the rows (or a 64 KB page holding them)
    if (size >= raw && !(size === raw + 4 && coding === 1)) {
        out.set(bytes.subarray(at, at + raw));
        return out;
    }
    const body = bytes.subarray(at + 4, at + size);
    if (coding === 1) out.set(body.subarray(0, raw));
    else if (coding === 2) lzw(body, out);
    else if (coding === 5) unpackBits(body, out, bpp === 16 || bpp === 48);
    else if (coding === 4) {
        const px = fill(bytes.subarray(at, at + size));
        const n = px.length;
        if (bpp === 1) out.fill(px[0] ? 0xff : 0);
        else for (let y = 0; y < raw; y += stride) for (let x = 0; x + n <= stride; x += n) out.set(px, y + x);
        return out;
    } else throw new Error(`unknown tile coding ${coding}`);
    if (filter === 3 && (bpp === 16 || bpp === 48)) {
        // the same with 16-bit samples (little endian)
        const w = new Uint16Array(out.buffer, 0, raw >> 1), ws = stride >> 1, step = bpp >> 4;
        for (let x = step; x < ws; x++) w[x] = w[x] + w[x - step];
        for (let y = ws; y < w.length; y++) w[y] = w[y] + w[y - ws];
    } else if (filter === 3) {
        // the first row from the pixel to its left, the others from the row before
        const step = Math.max(1, bpp >> 3);
        for (let x = step; x < stride; x++) out[x] = out[x] + out[x - step];
        for (let y = stride; y < raw; y++) out[y] = out[y] + out[y - stride];
    } else if (filter) throw new Error(`unknown tile filter ${filter}`);
    return out;
}

// --- The file ---

function openCpt(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = latin1(bytes.subarray(0, 8));
    if (isTiffCpt(bytes)) return openCpt6(bytes);
    if (!/^CPT[789]FILE$/.test(magic)) throw new Error('not a Corel PHOTO-PAINT image');
    const version = +magic[3];
    const u32 = (o) => dv.getUint32(o, true), i32 = (o) => dv.getInt32(o, true);
    const model = u32(8), paletteSize = u32(12);
    const count = u32(0x28);
    // 7.01: a "CPT7FILE" PHOTO-PAINT 9 or later wrote, its block table where 0x34 says
    const tableAt = u32(0x34) || 0x13c + paletteSize;
    if (count < 1 || count > 100000 || tableAt + count * 8 > bytes.length) throw new Error('bad block table');
    let palette = null;
    if (paletteSize) {
        palette = new Uint8Array(768);
        palette.set(bytes.subarray(0x13c, 0x13c + Math.min(768, paletteSize)));
    }
    // dots per metre × 10⁴, as PHOTO-PAINT rounds them
    const dpi = (v) => Math.round(v * 25.399986284007403 / 1e6);
    const comment = cString(bytes, 0x3c, 112);
    const blocks = [];
    for (let i = 0; i < count; i++) {
        const at = u32(tableAt + i * 8);
        if (!at || at + 0x3c > bytes.length) continue;
        const b = {
            index: i, at, width: u32(at), height: u32(at + 4), tileW: u32(at + 8), tileH: u32(at + 12),
            bpp: u32(at + 16), type: u32(at + 24), flags: u32(at + 28), propsSize: u32(at + 32),
        };
        b.props = bytes.subarray(at + 0x3c, Math.min(bytes.length, at + 0x3c + b.propsSize));
        b.tilesAt = at + 0x3c + b.propsSize;
        if (!b.width || !b.height || !b.tileW || !b.tileH || b.width > 65535 || b.height > 65535) continue;
        b.cols = Math.ceil(b.width / b.tileW);
        b.rows = Math.ceil(b.height / b.tileH);
        if (b.tilesAt + b.cols * b.rows * 8 > bytes.length) continue;
        blocks.push(b);
    }
    doc = {
        bytes, dv, version, model, palette, blocks, cache: new Map(),
        info: {
            format: version === 7 && u32(0x34) ? 'CPT 7.01' : `CPT ${version}.0`,
            model: (MODELS[model] || { name: `model ${model}` }).name,
            dpi: dpi(u32(0x18)), dpiV: dpi(u32(0x1c)), comment,
        },
    };
    readLayers();
}

// --- PHOTO-PAINT 6's: a TIFF ---
// Each block a TIFF directory, rows bottom first (orientation 4), its properties in
// private tag 40999, as a later file's; strips stored, LZW'd or PackBits'd.

const TIFF_MODELS = { 0: 5, 1: 5, 2: 1, 3: 10, 5: 3, 8: 11 };

function isTiffCpt(bytes) {
    if (bytes.length < 8) return false;
    const le = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0;
    const be = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42;
    return le || be;
}

function openCpt6(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = bytes[0] === 0x49;
    const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
    const blocks = [];
    let model = null, palette = null, dpi = 0;
    const seen = new Set();
    for (let at = u32(4), i = 0; at && at + 2 <= bytes.length && !seen.has(at) && i < 4096; i++) {
        seen.add(at);
        const n = u16(at), tags = new Map();
        if (at + 2 + n * 12 + 4 > bytes.length) break;
        for (let k = 0; k < n; k++) {
            const e = at + 2 + k * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
            const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] || 1;
            const vat = size * count > 4 ? u32(e + 8) : e + 8;
            const values = [];
            for (let j = 0; j < count && j < 1 << 20; j++) {
                if (vat + (j + 1) * size > bytes.length) break;
                values.push(size === 1 ? bytes[vat + j] : size === 2 ? u16(vat + j * 2) : size === 4 ? u32(vat + j * 4) : u32(vat + j * 8) / (u32(vat + j * 8 + 4) || 1));
            }
            tags.set(tag, { values, at: vat, count, type });
        }
        at = u32(at + 2 + n * 12);
        const v = (t, d) => (tags.has(t) ? tags.get(t).values[0] : d);
        const props = tags.get(40999);
        if (!props) continue;
        const p = bytes.subarray(props.at, props.at + props.count);
        const b = {
            index: blocks.length, width: v(256, 0), height: v(257, 0), spp: v(277, 1), bps: v(258, 1),
            photometric: v(262, 1), compression: v(259, 1), predictor: v(317, 1), planar: v(284, 1),
            rowsPerStrip: v(278, 0xffffffff), orientation: v(274, 1),
            offsets: tags.has(273) ? tags.get(273).values : [], counts: tags.has(279) ? tags.get(279).values : [],
            props: p, type: p.length >= 8 ? new DataView(p.buffer, p.byteOffset, 8).getUint32(4, true) : 0, flags: 0, tiff: true,
        };
        b.bpp = b.spp * b.bps;
        if (!b.width || !b.height) continue;
        if (b.type === 1 || model === null) {
            if (model === null || b.type === 1) model = TIFF_MODELS[b.photometric] ?? 1;
            if (b.photometric === 1 && b.bps === 1) model = 6;
            if (tags.has(282)) dpi = Math.round(v(282, 0) * (v(296, 2) === 3 ? 2.54 : 1));
            if (b.photometric === 3 && tags.has(320)) {
                const map = tags.get(320).values, n3 = map.length / 3;
                palette = new Uint8Array(768);
                for (let j = 0; j < 256 && j < n3; j++) {
                    palette[j * 3] = map[2 * n3 + j] >> 8; palette[j * 3 + 1] = map[n3 + j] >> 8; palette[j * 3 + 2] = map[j] >> 8;
                }
            }
        }
        blocks.push(b);
    }
    if (!blocks.length) throw new Error('a TIFF, but not a Corel PHOTO-PAINT 6 image (no objects tag)');
    doc = {
        bytes, dv, version: 6, model: model ?? 1, palette, blocks, cache: new Map(),
        info: { format: 'CPT 6.0 (TIFF)', model: (MODELS[model] || { name: `model ${model}` }).name, dpi, dpiV: dpi, comment: '' },
    };
    readLayers();
}

// TIFF LZW: most significant bit first, 9 to 12 bits, the width growing a code early
function tiffLzw(src, out) {
    const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4096);
    for (let i = 0; i < 256; i++) { suffix[i] = i; prefix[i] = -1; }
    let pos = 0, acc = 0, nbits = 0, width = 9, next = 258, prev = -1, o = 0;
    const emit = (c) => {
        let n = 0;
        for (let k = c; k >= 0; k = prefix[k]) stack[n++] = suffix[k];
        const first = stack[n - 1];
        while (n && o < out.length) out[o++] = stack[--n];
        return first;
    };
    while (o < out.length) {
        while (nbits < width && pos < src.length) { acc = ((acc << 8) | src[pos++]) >>> 0; nbits += 8; }
        if (nbits < width) break;
        const code = (acc >>> (nbits - width)) & ((1 << width) - 1);
        nbits -= width;
        if (code === 256) { width = 9; next = 258; prev = -1; continue; }
        if (code === 257) break;
        let first;
        if (code < next && (code < 256 || prev >= 0 || code < 258)) first = emit(code);
        else if (code === next && prev >= 0) { first = emit(prev); if (o < out.length) out[o++] = first; }
        else break;
        if (prev >= 0 && next < 4096) { prefix[next] = prev; suffix[next] = first; next++; }
        if (next + 1 >= 1 << width && width < 12) width++;
        prev = code;
    }
}

// A TIFF block's samples as a later file's: rows top first, RGB as B, G, R
function tiffSamples(b) {
    const { bytes } = doc;
    const rowBytes = Math.ceil(b.width * b.bpp / 8);
    const rows = new Uint8Array(rowBytes * b.height);
    let y = 0;
    for (let k = 0; k < b.offsets.length && y < b.height; k++) {
        const n = Math.min(b.rowsPerStrip, b.height - y);
        const src = bytes.subarray(b.offsets[k], b.offsets[k] + (b.counts[k] || 0));
        const dst = rows.subarray(y * rowBytes, (y + n) * rowBytes);
        if (b.compression === 1) dst.set(src.subarray(0, dst.length));
        else if (b.compression === 5) tiffLzw(src, dst);
        else if (b.compression === 32773) {
            for (let i = 0, o = 0; i < src.length && o < dst.length;) {
                const c = src[i++];
                if (c < 128) { dst.set(src.subarray(i, i + c + 1).subarray(0, dst.length - o), o); o += c + 1; i += c + 1; }
                else if (c > 128) { dst.fill(src[i++], o, Math.min(dst.length, o + 257 - c)); o += 257 - c; }
            }
        } else throw new Error(`TIFF compression ${b.compression} isn't read`);
        if (b.predictor === 2) {
            const step = b.spp;
            for (let r = 0; r < n; r++) for (let x = step; x < rowBytes; x++) dst[r * rowBytes + x] += dst[r * rowBytes + x - step];
        }
        y += n;
    }
    const data = new Uint8Array(rows.length);
    for (let r = 0; r < b.height; r++) {
        // orientation 4: the first row is the bottom one
        const from = b.orientation === 4 ? b.height - 1 - r : r;
        data.set(rows.subarray(from * rowBytes, from * rowBytes + rowBytes), r * rowBytes);
    }
    if (b.photometric === 2 && b.bps === 8 && b.spp >= 3) {
        for (let i = 0; i + 2 < data.length; i += b.spp) { const t = data[i]; data[i] = data[i + 2]; data[i + 2] = t; }
    } else if (b.photometric === 8) for (let i = 0; i < data.length; i += 3) { data[i + 1] ^= 0x80; data[i + 2] ^= 0x80; }
    else if (b.photometric === 0) for (let i = 0; i < data.length; i++) data[i] = 255 - data[i];
    return { bpp: b.bpp, rowBytes, data };
}

// Version 9 properties: records of a size, a four-letter tag (stored backwards) and the data
function records(props) {
    const out = new Map();
    const dv = new DataView(props.buffer, props.byteOffset, props.byteLength);
    let p = 8;
    while (p + 8 <= props.length) {
        const size = dv.getUint32(p, true);
        const tag = String.fromCharCode(props[p + 7], props[p + 6], props[p + 5], props[p + 4]);
        if (p + 8 + size > props.length) break;
        if (!out.has(tag)) out.set(tag, props.subarray(p + 8, p + 8 + size));
        p += 8 + size;
    }
    return out;
}

function readLayers() {
    const { blocks, version } = doc;
    const layers = [];
    const masks = [];
    let background = null;
    let id = 0;
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const pdv = new DataView(b.props.buffer, b.props.byteOffset, b.props.byteLength);
        const pi32 = (o) => (o + 4 <= b.props.length ? pdv.getInt32(o, true) : 0);
        if (b.type === 1 && !background) {
            let name = 'Background', visible = true;
            if (version === 9) {
                const r = records(b.props);
                if (r.has('bnam')) name = cString(r.get('bnam'), 0, 64) || name;
                // viac: whether it's shown (off in an image without a background)
                const v = r.get('viac');
                if (v && v.length >= 4) visible = v[0] !== 0;
            } else {
                // which records follow is in its flags; with 0x200 the last (8: visible, ...) says
                // whether it's shown: off in an image without a background
                const n = b.props.length;
                if (pi32(8) & 0x200 && n >= 24 && pi32(n - 12) === 8) visible = pi32(n - 8) !== 0;
            }
            background = { id: id++, kind: 'background', block: b, name, visible, opacity: 1, mode: 'normal',
                left: 0, top: 0, width: b.width, height: b.height };
            layers.push(background);
        } else if (b.type === 8) {
            const l = { id: id++, kind: 'object', block: b, name: '', visible: true, opacity: 1, mode: 'normal' };
            let f;
            if (version === 9) {
                const oinf = records(b.props).get('oinf');
                if (!oinf || oinf.length < 76) continue;
                const o = new DataView(oinf.buffer, oinf.byteOffset, oinf.byteLength);
                f = (k) => o.getInt32(k * 4, true);
                l.rect = [f(0), f(1), f(2), f(3)];
                l.painted = [f(4), f(5), f(6), f(7)];
                l.group = f(8);
                l.opacity = Math.max(0, Math.min(100, f(9))) / 100;
                l.modeNumber = f(10);
                l.visible = f(13) !== 0;
                l.hasClip = f(15) !== 0;
                l.clipOn = f(16) !== 0;
                l.clipToParent = f(17) !== 0;
                l.name = cString(oinf, 76, oinf.length - 76);
                const rec = records(b.props);
                l.text = f(11) !== 0 || rec.has('otx9');
                // a drop shadow PHOTO-PAINT draws from its settings
                if (rec.has('osdw')) l.problem = 'its drop shadow isn\'t drawn here';
            } else {
                f = (k) => pi32(8 + k * 4);
                l.rect = [f(0), f(1), f(2), f(3)];
                l.group = f(4);
                l.visible = f(6) !== 0;
                l.opacity = Math.max(0, Math.min(100, f(8))) / 100;
                l.modeNumber = f(9);
                l.name = cString(b.props, 48, 44);
                // PHOTO-PAINT 8's: then the bounds of what's painted, the clip mask and clipping
                if (b.props.length === 136) {
                    l.hasClip = pi32(120) !== 0;
                    l.clipOn = pi32(124) !== 0;
                    l.clipToParent = pi32(128) !== 0;
                } else l.text = pi32(96) === 1;
            }
            l.mode = MODE_BY_NUMBER.get(l.modeNumber) || 'normal';
            if (!MODE_BY_NUMBER.has(l.modeNumber)) l.problem = `merge mode ${l.modeNumber} isn't known: drawn as Normal`;
            // the y axis points up, from the picture's bottom row
            l.left = l.rect[0];
            l.width = b.width;
            l.height = b.height;
            l.top = (doc.height || 0) - 1 - l.rect[1];
            // its transparency and clip mask follow it
            if (blocks[i + 1] && blocks[i + 1].type === 4) l.alpha = blocks[++i];
            if (blocks[i + 1] && blocks[i + 1].type === 128) l.clip = blocks[++i];
            if (!l.clip) l.hasClip = false;
            layers.push(l);
        } else if (b.type === 2) {
            let name = '';
            if (version === 9) {
                const r = records(b.props);
                if (r.has('anam')) name = cString(r.get('anam'), 0, 256);
            } else {
                const n = pi32(8);
                if (n > 0 && n < 256) name = cString(b.props, 12, n);
            }
            masks.push({ id: id++, kind: 'mask', block: b, name: name || 'Mask', visible: false, opacity: 1, mode: 'normal',
                left: 0, top: 0, width: b.width, height: b.height });
        } else if (b.type === 16) {
            doc.thumbBlock = b;
        } else if (b.type === 4 || b.type === 128) {
            // a transparency or clip mask without its object: skipped
        }
    }
    if (!background && !layers.length) throw new Error('no picture in the file');
    doc.width = background ? background.width : Math.max(...layers.map(l => l.rect[2] + 1));
    doc.height = background ? background.height : Math.max(...layers.map(l => l.rect[1] + 1));
    for (const l of layers) if (l.kind === 'object') l.top = doc.height - 1 - l.rect[1];
    // a group: neighbours sharing a group number
    for (let i = 1; i < layers.length; i++) {
        const a = layers[i - 1], b = layers[i];
        if (a.kind === 'object' && b.kind === 'object' && a.group === b.group) a.grouped = b.grouped = true;
    }
    doc.layers = layers;
    doc.masks = masks;
    const cmyk = doc.model === 3;
    Object.assign(doc.info, { width: doc.width, height: doc.height,
        modes: MODES.filter(([, k]) => cmyk || k !== 'channel3').map(([, k, label]) => [k, cmyk && CMYK_CHANNELS[k] || label]) });
    // modes act on CMYK's samples there: composited here in RGB
    if (cmyk) for (const l of layers) if (l.mode !== 'normal' && !l.problem) l.problem = 'merged in RGB here, not in CMYK as PHOTO-PAINT does';
}

// --- Pixels ---

// One colour of a tile that is all one: its colour model (5 RGB, 9 grey, 3 CMYK, 18 Lab),
// then the colour as a pixel's samples (B, G, R...)
function fillPixel(tile) {
    return tile.slice(12, 12 + Math.max(1, doc.pixelBits >> 3));
}

// A block's samples, top row first: { bpp, stride, data }
function blockSamples(b) {
    if (b.tiff) return tiffSamples(b);
    const { bytes, dv } = doc;
    const stride = Math.ceil(b.tileW * b.bpp / 32) * 4;
    const raw = stride * b.tileH;
    const rowBytes = Math.ceil(b.width * b.bpp / 8);
    const data = new Uint8Array(rowBytes * b.height);
    doc.pixelBits = b.bpp;
    for (let ty = 0; ty < b.rows; ty++) {
        for (let tx = 0; tx < b.cols; tx++) {
            const e = b.tilesAt + (ty * b.cols + tx) * 8;
            const at = dv.getUint32(e, true), size = dv.getUint32(e + 4, true);
            const tile = decodeTile(bytes, at, size, raw, b.bpp, stride, fillPixel);
            const x0 = tx * b.tileW, w = Math.min(b.tileW, b.width - x0);
            const xb = x0 * b.bpp / 8, n = Math.ceil(w * b.bpp / 8);
            const h = Math.min(b.tileH, b.height - ty * b.tileH);
            for (let r = 0; r < h; r++) {
                // rows bottom first
                const y = b.height - 1 - (ty * b.tileH + r);
                if (b.bpp % 8 === 0) data.set(tile.subarray(r * stride, r * stride + n), y * rowBytes + xb);
                else for (let k = 0; k < w; k++) {
                    const bit = (tile[r * stride + (k >> 3)] >> (7 - (k & 7))) & 1;
                    const X = x0 + k;
                    if (bit) data[y * rowBytes + (X >> 3)] |= 0x80 >> (X & 7);
                }
            }
        }
    }
    return { bpp: b.bpp, rowBytes, data };
}

// Lab (L 0-255, a and b 128 centred) to sRGB
function labToRgb(L, A, B, out, o) {
    const l = L * 100 / 255, a = A - 128, bb = B - 128;
    let fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    const f = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
    const X = 0.96422 * f(fx), Y = f(fy), Z = 0.82521 * f(fz);
    // D50 to sRGB (Bradford adapted)
    const r = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
    const g = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
    const bl = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
    const gam = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    out[o] = gam(r); out[o + 1] = gam(g); out[o + 2] = gam(bl);
}

// A block as RGBA (its transparency, if any, applied later)
function blockRgba(b) {
    const key = 'rgba' + b.index;
    if (doc.cache.has(key)) return doc.cache.get(key);
    const s = blockSamples(b);
    const n = b.width * b.height;
    const out = new Uint8ClampedArray(n * 4);
    const d = s.data, model = b.type === 2 || b.type === 4 || b.type === 128 ? 5 : doc.model;
    for (let y = 0; y < b.height; y++) {
        const row = y * s.rowBytes;
        for (let x = 0; x < b.width; x++) {
            const o = (y * b.width + x) * 4;
            out[o + 3] = 255;
            if (s.bpp === 24 && model === 11) labToRgb(d[row + x * 3], d[row + x * 3 + 1], d[row + x * 3 + 2], out, o);
            else if (s.bpp === 24) { out[o] = d[row + x * 3 + 2]; out[o + 1] = d[row + x * 3 + 1]; out[o + 2] = d[row + x * 3]; }
            else if (s.bpp === 32) {
                // C, M, Y, K
                const c = d[row + x * 4], m = d[row + x * 4 + 1], yy = d[row + x * 4 + 2], k = d[row + x * 4 + 3];
                out[o] = 255 - Math.min(255, c + k); out[o + 1] = 255 - Math.min(255, m + k); out[o + 2] = 255 - Math.min(255, yy + k);
            } else if (s.bpp === 48) {
                out[o] = d[row + x * 6 + 5]; out[o + 1] = d[row + x * 6 + 3]; out[o + 2] = d[row + x * 6 + 1];
            } else if (s.bpp === 16) out[o] = out[o + 1] = out[o + 2] = d[row + x * 2 + 1];
            else if (s.bpp === 8 && model === 10 && doc.palette) {
                const p = d[row + x] * 3;
                out[o] = doc.palette[p + 2]; out[o + 1] = doc.palette[p + 1]; out[o + 2] = doc.palette[p];
            } else if (s.bpp === 8) out[o] = out[o + 1] = out[o + 2] = d[row + x];
            else if (s.bpp === 1) out[o] = out[o + 1] = out[o + 2] = (d[row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        }
    }
    doc.cache.set(key, out);
    return out;
}

// An 8-bit block (transparency, clip mask, mask) as one byte per pixel, top row first
function blockAlpha(b) {
    const key = 'a' + b.index;
    if (doc.cache.has(key)) return doc.cache.get(key);
    const s = blockSamples(b);
    let out = s.data;
    if (s.bpp !== 8) {
        out = new Uint8Array(b.width * b.height);
        for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
            out[y * b.width + x] = s.bpp === 1 ? ((s.data[y * s.rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) * 255 : s.data[y * s.rowBytes + x * (s.bpp >> 3)];
        }
    } else if (s.rowBytes !== b.width) {
        out = new Uint8Array(b.width * b.height);
        for (let y = 0; y < b.height; y++) out.set(s.data.subarray(y * s.rowBytes, y * s.rowBytes + b.width), y * b.width);
    }
    doc.cache.set(key, out);
    return out;
}

// A layer's own pixels as RGBA, its transparency and clip mask applied
function layerPixels(l) {
    const key = 'layer' + l.id;
    if (doc.cache.has(key)) return doc.cache.get(key);
    let px;
    if (l.kind === 'mask') {
        const a = blockAlpha(l.block);
        px = new Uint8ClampedArray(a.length * 4);
        for (let i = 0; i < a.length; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 0; px[i * 4 + 3] = a[i]; }
    } else {
        px = blockRgba(l.block);
        if (l.alpha || l.clip) {
            px = new Uint8ClampedArray(px);
            const a = l.alpha && l.alpha.width === l.width && l.alpha.height === l.height ? blockAlpha(l.alpha) : null;
            for (let i = 0; i < l.width * l.height; i++) px[i * 4 + 3] = a ? a[i] : 255;
        }
    }
    doc.cache.set(key, px);
    return px;
}

// An object's clip mask lined up with the object: the mask has bounds of its own (left, top,
// right, bottom, the y axis up: after its name, or in a version 9 file's aext record); outside it, hidden
function clipPixels(l) {
    if (!l.clip) return null;
    const key = 'clip' + l.id;
    if (doc.cache.has(key)) return doc.cache.get(key);
    const c = l.clip, a = blockAlpha(c);
    const cdv = new DataView(c.props.buffer, c.props.byteOffset, c.props.byteLength);
    const at = (o) => (o + 4 <= c.props.length ? cdv.getInt32(o, true) : null);
    let left = null, top = null;
    if (doc.version === 9) {
        const e = records(c.props).get('aext');
        if (e && e.length >= 20) { const ev = new DataView(e.buffer, e.byteOffset, e.byteLength); left = ev.getInt32(4, true); top = ev.getInt32(8, true); }
    } else {
        let n = 12;
        while (n < c.props.length && c.props[n]) n++;
        left = at(n + 1); top = at(n + 5);
    }
    if (left === null || top === null) { left = l.rect[0]; top = l.rect[1]; }
    const dx = left - l.rect[0], dy = (doc.height - 1 - top) - l.top;
    const out = new Uint8Array(l.width * l.height);
    for (let y = Math.max(0, dy); y < Math.min(l.height, dy + c.height); y++) {
        for (let x = Math.max(0, dx); x < Math.min(l.width, dx + c.width); x++) out[y * l.width + x] = a[(y - dy) * c.width + (x - dx)];
    }
    doc.cache.set(key, out);
    return out;
}

// --- Merge modes ---
// Each fitted to what PHOTO-PAINT 8 makes of an object in that mode at 100% and 60%
// opacity: w is the object's weight there (its transparency × opacity), b the
// backdrop, s the object. Most mix b with the mode's colour by w; Add, Subtract and
// Divide mix before they clip, Difference takes w of s, the HSV modes move each
// component by w, Behind shows the object by 1 - opacity.

// PHOTO-PAINT's HSV: hue in degrees (red's from -60 to 60, blue checked first), saturation and value 0-255
function hsv(r, g, b, out) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    out[0] = !d ? 0 : max === b ? 240 + (r - g) / d * 60 : max === g ? 120 + (b - r) / d * 60 : (g - b) / d * 60;
    out[1] = max ? Math.floor(d * 255 / max) : 0;
    out[2] = max;
}

function fromHsv(h, s, v, out, o) {
    h = ((h % 360) + 360) % 360;
    const c = v * s / 255, hp = h / 60, x = c * (1 - Math.abs(hp % 2 - 1)), m = v - c;
    const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    out[o] = Math.round(r + m); out[o + 1] = Math.round(g + m); out[o + 2] = Math.round(b + m);
}

const B = [0, 0, 0], S = [0, 0, 0];
// The result of the mode for the backdrop at dst[d] and the object's colour (sr, sg, sb) at weight w,
// into out[0..2]; the channel modes replace the pixel's k-th sample (B, G, R; C, M, Y, K)
function blend(mode, dst, d, sr, sg, sb, w, opacity, out) {
    const br = dst[d], bg = dst[d + 1], bb = dst[d + 2];
    const mix = (r, g, b) => { out[0] = br + (r - br) * w; out[1] = bg + (g - bg) * w; out[2] = bb + (b - bb) * w; };
    switch (mode) {
        case 'add': out[0] = br + sr * w; out[1] = bg + sg * w; out[2] = bb + sb * w; return;
        case 'subtract': out[0] = br + (sr - 255) * w; out[1] = bg + (sg - 255) * w; out[2] = bb + (sb - 255) * w; return;
        case 'difference': out[0] = Math.abs(br - sr * w); out[1] = Math.abs(bg - sg * w); out[2] = Math.abs(bb - sb * w); return;
        case 'multiply': return mix(Math.floor(br * sr / 255), Math.floor(bg * sg / 255), Math.floor(bb * sb / 255));
        case 'divide': return mix(sr ? br * 255 / sr : 255, sg ? bg * 255 / sg : 255, sb ? bb * 255 / sb : 255);
        case 'lighter': case 'darker': {
            // the object (mixed in by w) where it's lighter (darker), by the largest of its samples
            const r = Math.floor(br + (sr - br) * w), g = Math.floor(bg + (sg - bg) * w), b = Math.floor(bb + (sb - bb) * w);
            const a = Math.max(r, g, b), c = Math.max(br, bg, bb);
            const take = mode === 'lighter' ? a > c : a <= c;
            out[0] = take ? r : br; out[1] = take ? g : bg; out[2] = take ? b : bb;
            return;
        }
        case 'texturize': {
            const l = Math.floor((Math.max(sr, sg, sb) + Math.min(sr, sg, sb)) / 2);
            return mix(Math.floor(br * l / 255), Math.floor(bg * l / 255), Math.floor(bb * l / 255));
        }
        case 'color': case 'hue': case 'saturation': case 'lightness':
            hsv(br, bg, bb, B); hsv(sr, sg, sb, S);
            if (mode === 'color') fromHsv(S[0], B[1] + (S[1] - B[1]) * w, B[2], out, 0);
            else if (mode === 'hue') {
                // between hues 0 to 360
                const hb = B[0] < 0 ? B[0] + 360 : B[0], hs = S[0] < 0 ? S[0] + 360 : S[0];
                fromHsv(hb + (hs - hb) * w, B[1], B[2], out, 0);
            }
            else if (mode === 'saturation') fromHsv(B[0], B[1] + (S[1] - B[1]) * w, B[2], out, 0);
            else fromHsv(B[0], B[1], B[2] + (S[2] - B[2]) * w, out, 0);
            return;
        case 'invert': return mix(255 - sr, 255 - sg, 255 - sb);
        case 'and': return mix(br & sr, bg & sg, bb & sb);
        case 'or': return mix(br | sr, bg | sg, bb | sb);
        case 'xor': return mix(br ^ sr, bg ^ sg, bb ^ sb);
        case 'behind': {
            const k = w / Math.max(opacity, 1e-9) * (1 - opacity);
            out[0] = br + (sr - br) * k; out[1] = bg + (sg - bg) * k; out[2] = bb + (sb - bb) * k;
            return;
        }
        case 'screen': return mix(255 - (255 - br) * (255 - sr) / 255, 255 - (255 - bg) * (255 - sg) / 255, 255 - (255 - bb) * (255 - sb) / 255);
        case 'overlay': return mix(overlay(br, sr), overlay(bg, sg), overlay(bb, sb));
        case 'hardlight': return mix(overlay(sr, br), overlay(sg, bg), overlay(sb, bb));
        case 'softlight': return mix(softLight(br, sr), softLight(bg, sg), softLight(bb, sb));
        case 'channel0': case 'channel1': case 'channel2': {
            // the sample in memory order: B, G, R
            const k = +mode[7];
            return mix(k === 2 ? sr : br, k === 1 ? sg : bg, k === 0 ? sb : bb);
        }
        case 'channel3': out[0] = br; out[1] = bg; out[2] = bb; return;
        default: mix(sr, sg, sb);
    }
}
const overlay = (b, s) => (b < 128 ? 2 * b * s / 255 : 255 - 2 * (255 - b) * (255 - s) / 255);
const softLight = (b, s) => (s < 128 ? 2 * b * s / 255 + b * b / 255 * (255 - 2 * s) / 255
    : 2 * b * (255 - s) / 255 + Math.sqrt(b / 255) * (2 * s - 255));

// --- Compositing ---

const get = (l, key) => {
    const c = changes[l.id];
    return c && c[key] !== undefined ? c[key] : l[key];
};

const tmp = [0, 0, 0];
function drawLayer(l, dst, opacity, mode) {
    const W = doc.width, H = doc.height;
    const px = layerPixels(l);
    const clip = l.hasClip && get(l, 'clipOn') ? clipPixels(l) : null;
    const x0 = Math.max(0, l.left), x1 = Math.min(W, l.left + l.width);
    const y0 = Math.max(0, l.top), y1 = Math.min(H, l.top + l.height);
    for (let y = y0; y < y1; y++) {
        const sy = y - l.top;
        for (let x = x0; x < x1; x++) {
            const s = (sy * l.width + (x - l.left)) * 4;
            let a = px[s + 3];
            if (clip) a = a * clip[sy * l.width + (x - l.left)] / 255;
            if (l.clipBase) a = a * l.clipBase[y * W + x] / 255;
            if (a <= 0) continue;
            const d = (y * W + x) * 4;
            const da = dst[d + 3];
            const w = a / 255 * opacity;
            if (mode === 'normal' || da < 255) {
                // over a backdrop that isn't opaque: the object over it (in its mode where it's opaque)
                let r = px[s], g = px[s + 1], b = px[s + 2];
                if (mode !== 'normal' && da) {
                    blend(mode, dst, d, r, g, b, 1, 1, tmp);
                    const k = da / 255;
                    r = tmp[0] * k + r * (1 - k); g = tmp[1] * k + g * (1 - k); b = tmp[2] * k + b * (1 - k);
                }
                const oa = w + da / 255 * (1 - w);
                if (oa <= 0) continue;
                const f = w / oa;
                dst[d] = r * f + dst[d] * (1 - f);
                dst[d + 1] = g * f + dst[d + 1] * (1 - f);
                dst[d + 2] = b * f + dst[d + 2] * (1 - f);
                dst[d + 3] = oa * 255;
            } else {
                blend(mode, dst, d, px[s], px[s + 1], px[s + 2], w, opacity, tmp);
                dst[d] = tmp[0]; dst[d + 1] = tmp[1]; dst[d + 2] = tmp[2];
            }
        }
    }
}

// What an object clipped to the one below may show: the coverage of the object it's clipped to
function coverage(l, own) {
    const W = doc.width, H = doc.height;
    const out = new Uint8Array(W * H);
    if (l.kind !== 'object') { out.fill(255); return out; }
    const px = layerPixels(l);
    const clip = l.hasClip && get(l, 'clipOn') ? clipPixels(l) : null;
    if (l.painted) {
        // PHOTO-PAINT 9 on: outside the bounds of what the object below has painted, nothing's clipped
        out.fill(255);
        const [x0, yt, x1, yb] = l.painted;
        for (let y = Math.max(0, H - 1 - yt); y <= Math.min(H - 1, H - 1 - yb); y++) out.fill(0, y * W + Math.max(0, x0), y * W + Math.min(W, x1 + 1));
    }
    for (let y = Math.max(0, l.top); y < Math.min(H, l.top + l.height); y++) {
        for (let x = Math.max(0, l.left); x < Math.min(W, l.left + l.width); x++) {
            const i = (y - l.top) * l.width + (x - l.left);
            if (out[y * W + x]) continue;
            let a = px[i * 4 + 3];
            if (clip) a = a * clip[i] / 255;
            if (own) a = a * own[y * W + x] / 255;
            out[y * W + x] = a;
        }
    }
    return out;
}

function render(newChanges, only, newPaper) {
    if (newChanges) changes = newChanges;
    if (newPaper !== undefined) paper = newPaper;
    const W = doc.width, H = doc.height;
    const dst = new Uint8ClampedArray(W * H * 4);
    if (only === undefined && paper) for (let i = 0; i < dst.length; i += 4) dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 255;
    let base = null;
    for (const l of doc.layers.concat(doc.masks)) {
        if (only !== undefined ? l.id !== only : !get(l, 'visible')) {
            if (l.kind === 'object') base = null;
            continue;
        }
        if (l.kind === 'mask') {
            if (only === undefined) {
                // a mask shown cuts the picture to it
                const a = blockAlpha(l.block);
                for (let i = 0; i < W * H; i++) dst[i * 4 + 3] = dst[i * 4 + 3] * (a[i] ?? 255) / 255;
            } else drawLayer(l, dst, 1, 'normal');
            continue;
        }
        if (l.kind === 'background') {
            const px = layerPixels(l);
            if (only !== undefined || !paper) dst.set(px);
            else drawLayer(l, dst, 1, 'normal');
            base = null;
            continue;
        }
        // clipped to the object below: only where that one is
        l.clipBase = only === undefined && get(l, 'clipToParent') && base ? base : null;
        drawLayer(l, dst, only !== undefined ? 1 : get(l, 'opacity'), only !== undefined ? 'normal' : get(l, 'mode'));
        if (!l.clipBase) base = coverage(l, null);
        l.clipBase = null;
    }
    return dst;
}

// --- Thumbnails ---

function thumbnail(l) {
    const W = l.kind === 'object' ? l.width : doc.width, H = l.kind === 'object' ? l.height : doc.height;
    const s = Math.min(1, THUMB / Math.max(W, H));
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    const px = layerPixels(l);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(W - 1, Math.floor(x / s)), sy = Math.min(H - 1, Math.floor(y / s));
        out.set(px.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * w + x) * 4);
    }
    return { width: w, height: h, data: out };
}

// The thumbnail the file keeps (24-bit in the image's model, or 8-bit with its palette, B, G, R, after the
// block's properties, 1-bit, CMYK)
function storedThumbnail() {
    const b = doc.thumbBlock;
    if (!b) return null;
    const s = blockSamples(b);
    const pal = b.props.length >= 8 + 768 ? b.props.subarray(8, 8 + 768) : null;
    const out = new Uint8ClampedArray(b.width * b.height * 4);
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const o = (y * b.width + x) * 4, r = y * s.rowBytes;
        out[o + 3] = 255;
        if (s.bpp === 24 && doc.model === 11) labToRgb(s.data[r + x * 3], s.data[r + x * 3 + 1], s.data[r + x * 3 + 2], out, o);
        else if (s.bpp === 24) { out[o] = s.data[r + x * 3 + 2]; out[o + 1] = s.data[r + x * 3 + 1]; out[o + 2] = s.data[r + x * 3]; }
        else if (s.bpp === 32) {
            const c = s.data[r + x * 4], m = s.data[r + x * 4 + 1], yy = s.data[r + x * 4 + 2], k = s.data[r + x * 4 + 3];
            out[o] = 255 - Math.min(255, c + k); out[o + 1] = 255 - Math.min(255, m + k); out[o + 2] = 255 - Math.min(255, yy + k);
        } else if (s.bpp === 8) {
            const v = s.data[r + x];
            if (pal) { out[o] = pal[v * 3 + 2]; out[o + 1] = pal[v * 3 + 1]; out[o + 2] = pal[v * 3]; } else out[o] = out[o + 1] = out[o + 2] = v;
        } else if (s.bpp === 16) out[o] = out[o + 1] = out[o + 2] = s.data[r + x * 2 + 1];
        else if (s.bpp === 1) out[o] = out[o + 1] = out[o + 2] = (s.data[r + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
    return { width: b.width, height: b.height, data: out };
}

// The thumbnail from the file itself, fetching the header, the block table and the thumbnail's block
async function fetchRange(url, start, end) {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return resp.status === 206 ? bytes : bytes.subarray(start, end + 1);
}

// Without one: the picture itself, shrunk, if the file isn't big
async function pictureThumbnail(url, max) {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const total = +((resp.headers.get('Content-Range') || '').split('/')[1] || resp.headers.get('Content-Length'));
    await resp.arrayBuffer();
    if (!(total > 0) || total > 16 << 20) return null;
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const saved = doc, savedChanges = changes, savedPaper = paper;
    try {
        openCpt(bytes);
        const W = doc.width, H = doc.height, img = render({}, undefined, true);
        const s = Math.min(1, max / Math.max(W, H));
        const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const sx = Math.min(W - 1, Math.floor(x / s)), sy = Math.min(H - 1, Math.floor(y / s));
            out.set(img.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * w + x) * 4);
        }
        return { image: out, width: w, height: h };
    } finally { doc = saved; changes = savedChanges; paper = savedPaper; }
}

async function thumbnailFromUrl(url, max) {
    const head = await fetchRange(url, 0, 0x13c + 768 + 8 * 64 - 1);
    if (isTiffCpt(head)) return pictureThumbnail(url, max);
    if (!/^CPT[789]FILE$/.test(latin1(head.subarray(0, 8)))) return null;
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const count = hv.getUint32(0x28, true), tableAt = hv.getUint32(0x34, true) || 0x13c + hv.getUint32(12, true);
    if (count < 1 || count > 100000) return null;
    const table = await fetchRange(url, tableAt, tableAt + count * 8 - 1);
    const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    // the thumbnail is the last block
    for (let i = count - 1; i >= Math.max(0, count - 4); i--) {
        const at = tv.getUint32(i * 8, true);
        let h = await fetchRange(url, at, at + 0x3c + 1024 - 1);
        const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
        if (v.getUint32(24, true) !== 16) continue;
        const w = v.getUint32(0, true), ht = v.getUint32(4, true), tw = v.getUint32(8, true), th = v.getUint32(12, true);
        const props = v.getUint32(32, true);
        const tiles = Math.ceil(w / tw) * Math.ceil(ht / th);
        if (tiles > 64) return null;
        const need = 0x3c + props + tiles * 8;
        if (h.length < need) h = await fetchRange(url, at, at + need - 1);
        const hv2 = new DataView(h.buffer, h.byteOffset, h.byteLength);
        // the tiles: fetch from the first to the end of the last
        let lo = Infinity, hi = 0;
        for (let k = 0; k < tiles; k++) {
            const o = hv2.getUint32(0x3c + props + k * 8, true), n = hv2.getUint32(0x3c + props + k * 8 + 4, true);
            lo = Math.min(lo, o); hi = Math.max(hi, o + n);
        }
        if (!(hi > lo) || hi - lo > 16 << 20) return null;
        const data = await fetchRange(url, lo, hi - 1);
        // a small file of its own: the header, this block (table rebased) and the tiles
        const size = 0x13c + 8 + need + (hi - lo);
        const f = new Uint8Array(size);
        f.set(head.subarray(0, 0x3c));
        const fv = new DataView(f.buffer);
        fv.setUint32(0x28, 1, true); fv.setUint32(0x34, 0x13c, true); fv.setUint32(12, 0, true);
        fv.setUint32(0x13c, 0x13c + 8, true);
        const bat = 0x13c + 8;
        f.set(h.subarray(0, need), bat);
        for (let k = 0; k < tiles; k++) {
            const e = bat + 0x3c + props + k * 8;
            fv.setUint32(e, fv.getUint32(e, true) - lo + bat + need, true);
        }
        f.set(data, bat + need);
        const saved = doc;
        try {
            const model = hv.getUint32(8, true);
            doc = { bytes: f, dv: fv, model, palette: null, blocks: [], cache: new Map() };
            const b = { index: 0, at: bat, width: w, height: ht, tileW: tw, tileH: th, bpp: fv.getUint32(bat + 16, true), type: 16,
                props: f.subarray(bat + 0x3c, bat + 0x3c + props), tilesAt: bat + 0x3c + props, cols: Math.ceil(w / tw), rows: Math.ceil(ht / th) };
            doc.thumbBlock = b;
            const t = storedThumbnail();
            return t && { image: t.data, width: t.width, height: t.height };
        } finally { doc = saved; }
    }
    return pictureThumbnail(url, max);
}

function layerInfo(l) {
    const o = {
        id: l.id, kind: l.kind, name: l.name, visible: l.visible, opacity: l.opacity, mode: l.mode,
        left: l.left, top: l.top, width: l.width, height: l.height,
    };
    for (const k of ['hasClip', 'clipOn', 'clipToParent', 'grouped', 'text', 'problem']) if (l[k]) o[k] = l[k];
    if (l.kind === 'object') o.clipOn = !!l.clipOn;
    return o;
}

self.onmessage = ({ data }) => {
    const { id } = data;
    try {
        if (data.cmd === 'open') {
            changes = {};
            openCpt(new Uint8Array(data.bytes));
            paper = false;
            const image = render({}, undefined, false);
            const thumbs = {};
            for (const l of doc.layers.concat(doc.masks)) thumbs[l.id] = thumbnail(l);
            const stored = storedThumbnail();
            const layers = doc.layers.concat(doc.masks).map(layerInfo);
            self.postMessage({ id, result: { info: doc.info, layers, thumbs, stored, image } }, [image.buffer]);
        } else if (data.cmd === 'render') {
            const image = render(data.changes, undefined, data.paper);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else if (data.cmd === 'layer') {
            const image = render(null, data.layerId);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else if (data.cmd === 'thumbnail') {
            thumbnailFromUrl(data.url, data.max || 256).then(
                result => self.postMessage({ id, result }, result ? [result.image.buffer] : []),
                err => self.postMessage({ id, error: (err && err.message) || String(err) }));
        } else throw new Error(`unknown command ${data.cmd}`);
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
