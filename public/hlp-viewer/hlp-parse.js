// Windows Help (.hlp) reader, WinHelp 3.0 (HC30), 3.1 (HC31) and 4.0 (HCW),
// magic 0x00035F3F. No DOM: hlp-viewer.js renders what this returns, and it
// runs under node for testing. Written from the format as documented by
// Manfred Winterhoff (helpfile.txt, shipped with helpdeco) and Pete Davis, and
// modelled on Wine's winhlp32 reader (programs/winhlp32/hlpfile.c, LGPL-2.1+);
// no code was copied from helpdeco.
//
// The file is a small file system: a B+ tree directory of internal files
// (|SYSTEM, |TOPIC, |FONT, |CONTEXT, |KWBTREE, |bm0...). |TOPIC is split into
// blocks (LZ77-compressed in 3.1+ files when |SYSTEM says so) holding a linked
// list of TOPICLINKs: topic headers, and text or table records whose strings
// may be phrase-compressed (|Phrases, or Hall compression with |PhrIndex and
// |PhrImage in 4.0) and whose formatting is a stream of commands. Pictures are
// SHG/MRB data (in |bmN files or inline): DIBs/DDBs packed with RLE and/or
// LZ77, metafiles, and hotspot tables.

export const WINHELP_MAGIC = 0x00035F3F;

export class HelpFormatError extends Error {}

const fail = msg => { throw new HelpFormatError(msg); };

// --- byte access, bounds-checked ---
function u8(b, o) { if (o < 0 || o >= b.length) fail(`read past the end of the data (offset ${o})`); return b[o]; }
function u16(b, o) { if (o < 0 || o + 2 > b.length) fail(`read past the end of the data (offset ${o})`); return b[o] | (b[o + 1] << 8); }
function i16(b, o) { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; }
function u32(b, o) { if (o < 0 || o + 4 > b.length) fail(`read past the end of the data (offset ${o})`); return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o) { return u32(b, o) | 0; }
function cstrEnd(b, o, end = b.length) { let e = o; while (e < end && b[e] !== 0) e++; return e; }

// Compressed numbers in topic and picture data (a cursor {p})
function cWord(b, c) { const x = u8(b, c.p); if (x & 1) { const v = u16(b, c.p); c.p += 2; return v >>> 1; } c.p++; return x >>> 1; }
function cShort(b, c) { const x = u8(b, c.p); if (x & 1) { const v = u16(b, c.p); c.p += 2; return (v >>> 1) - 0x4000; } c.p++; return (x >>> 1) - 0x40; }
function cDword(b, c) { const x = u8(b, c.p); if (x & 1) { const v = u32(b, c.p); c.p += 4; return v >>> 1; } const v = u16(b, c.p); c.p += 2; return v >>> 1; }
function cLong(b, c) { const x = u8(b, c.p); if (x & 1) { const v = u32(b, c.p); c.p += 4; return (v >>> 1) - 0x40000000; } const v = u16(b, c.p); c.p += 2; return (v >>> 1) - 0x4000; }

// --- decompression ---
// LZ77 as used by WinHelp: a flag byte, then 8 items, each a literal byte or
// a 16-bit (length-3)<<12 | (distance-1) back reference.
export function lz77(src, start, end, cap = Infinity) {
    end = Math.min(end, src.length);
    let out = new Uint8Array(Math.min(cap, Math.max(256, (end - start) * 3)));
    let o = 0, p = start;
    const ensure = n => {
        if (n <= out.length) return;
        const grown = new Uint8Array(Math.min(cap, Math.max(n, out.length * 2)));
        grown.set(out.subarray(0, o));
        out = grown;
    };
    while (p < end && o < cap) {
        let mask = src[p++];
        for (let bit = 0; bit < 8 && p < end && o < cap; bit++, mask >>= 1) {
            if (mask & 1) {
                if (p + 1 >= end) { p = end; break; }
                const code = src[p] | (src[p + 1] << 8);
                p += 2;
                let len = 3 + (code >> 12);
                const dist = (code & 0xFFF) + 1;
                if (o + len > cap) len = cap - o;
                ensure(o + len);
                for (; len > 0; len--, o++) out[o] = o >= dist ? out[o - dist] : 0;
            } else {
                ensure(o + 1);
                out[o++] = src[p++];
            }
        }
    }
    return out.subarray(0, o);
}

// Run length: n&0x80 → copy n&0x7F literal bytes, else repeat the next byte n times
function unRle(src, start, end, size) {
    const out = new Uint8Array(size);
    let o = 0, p = start;
    end = Math.min(end, src.length);
    while (p < end && o < size) {
        const n = src[p++];
        if (n & 0x80) {
            const k = n & 0x7F;
            for (let i = 0; i < k && p < end; i++, p++) if (o < size) out[o++] = src[p];
        } else {
            const v = p < end ? src[p++] : 0;
            for (let i = 0; i < n && o < size; i++) out[o++] = v;
        }
    }
    return out;
}

function unpack(src, start, csize, size, packing) {
    const end = Math.min(src.length, start + csize);
    switch (packing) {
    case 0: return src.subarray(start, end);
    case 1: return unRle(src, start, end, size);
    case 2: return lz77(src, start, end, size || Infinity);
    case 3: { const t = lz77(src, start, end); return unRle(t, 0, t.length, size); }
    default: fail(`unknown picture packing ${packing}`);
    }
}

// --- character sets ---
const CHARSET_ENCODINGS = {
    0: 'windows-1252', 1: 'windows-1252', 2: 'windows-1252', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 130: 'euc-kr',
    134: 'gbk', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255',
    178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250',
};
// LCIDs of |SYSTEM record 9 that imply a code page (primary language id)
const LANG_ENCODINGS = {
    0x04: 'gbk', 0x11: 'shift_jis', 0x12: 'euc-kr', 0x19: 'windows-1251', 0x22: 'windows-1251', 0x23: 'windows-1251', 0x02: 'windows-1251',
    0x05: 'windows-1250', 0x0E: 'windows-1250', 0x15: 'windows-1250', 0x1B: 'windows-1250', 0x24: 'windows-1250', 0x18: 'windows-1250',
    0x08: 'windows-1253', 0x1F: 'windows-1254', 0x0D: 'windows-1255', 0x01: 'windows-1256', 0x1E: 'windows-874',
    0x25: 'windows-1257', 0x26: 'windows-1257', 0x27: 'windows-1257', 0x2A: 'windows-1258',
};
export const ENCODINGS = ['windows-1252', 'windows-1250', 'windows-1251', 'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256',
    'windows-1257', 'windows-1258', 'windows-874', 'shift_jis', 'gbk', 'big5', 'euc-kr', 'macintosh', 'ibm866', 'iso-8859-1'];

function makeDecoder(label) {
    try { return new TextDecoder(label); } catch { return new TextDecoder('windows-1252'); }
}

// --- context string hashes (|CONTEXT keys) ---
const HASH_TABLE = (() => {
    const t = new Int8Array(256);
    const s = [
        0x00, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF,
        0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEE, 0xEF,
        0xF0, 0x0B, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0x0C, 0xFF,
        0x0A, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F,
        0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0D,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F,
        0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F,
        0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F,
        0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F,
        0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F,
        0x80, 0x81, 0x82, 0x83, 0x0B, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x8B, 0x8C, 0x8D, 0x8E, 0x8F,
        0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0x9B, 0x9C, 0x9D, 0x9E, 0x9F,
        0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF,
        0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF,
        0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF,
    ];
    for (let i = 0; i < 256; i++) t[i] = s[i] << 24 >> 24;
    return t;
})();

// Hash of a context string (latin-1 bytes), as stored in |CONTEXT, unsigned
export function contextHash(name) {
    if (!name) return 1;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 43) + HASH_TABLE[name.charCodeAt(i) & 0xFF]) | 0;
    return h >>> 0;
}

// --- the B+ tree every index uses ---
// Calls leaf(bytes, pos) → [entry, nextPos] for every entry, in order.
function btreeEntries(b, start, end, leaf, name) {
    if (u16(b, start) !== 0x293B) fail(`${name}: not a B+ tree (magic 0x${u16(b, start).toString(16)})`);
    const pageSize = u16(b, start + 4);
    const structure = String.fromCharCode(...b.subarray(start + 6, start + 22)).replace(/\0.*$/, '');
    const rootPage = i16(b, start + 26);
    const totalPages = u16(b, start + 30);
    const nLevels = u16(b, start + 32);
    const total = u32(b, start + 34);
    const pages = start + 38;
    if (!pageSize) fail(`${name}: page size 0`);
    const pageAt = n => {
        const p = pages + n * pageSize;
        if (n < 0 || n >= totalPages || p + 8 > Math.min(end, b.length)) fail(`${name}: page ${n} is outside the tree`);
        return p;
    };
    let page = rootPage;
    for (let level = 1; level < nLevels; level++) page = i16(b, pageAt(page) + 4); // leftmost child
    const out = [];
    const seen = new Set();
    while (page !== -1 && page !== 0xFFFF) {
        if (seen.has(page)) fail(`${name}: B+ tree pages form a loop`);
        seen.add(page);
        const p = pageAt(page);
        const n = i16(b, p + 2);
        let q = p + 8;
        for (let i = 0; i < n && out.length <= total + 16; i++) {
            const [entry, next] = leaf(b, q);
            out.push(entry);
            q = next;
        }
        page = i16(b, p + 6);
        if (out.length > total + 16) break;
    }
    return { entries: out, structure, pageSize, levels: nLevels, total };
}

// --- pictures (SHG/MRB) ---
const VGA16 = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];

function hotspotKind(id) {
    switch (id) {
    case 0xC8: case 0xCC: return 'macro';
    case 0xE2: case 0xE6: return 'popup';
    case 0xE3: case 0xE7: return 'jump';
    case 0xEA: case 0xEE: return 'popup';
    case 0xEB: case 0xEF: return 'jump';
    default: return 'unknown';
    }
}

function parseHotspots(b, base, size, decode) {
    if (!size) return [];
    const end = Math.min(b.length, base + size);
    const n = u16(b, base + 1);
    const macroSize = u32(b, base + 3);
    const spots = [];
    let s = base + 7 + 15 * n + macroSize;
    for (let i = 0; i < n && s < end; i++) {
        const r = base + 7 + 15 * i;
        const id = u8(b, r);
        const nameEnd = cstrEnd(b, s, end);
        const name = decode(b.subarray(s, nameEnd));
        s = nameEnd + 1;
        const tgtEnd = cstrEnd(b, s, end);
        const target = decode(b.subarray(s, tgtEnd));
        s = tgtEnd + 1;
        const spot = { kind: hotspotKind(id), visible: !(u8(b, r + 1) & 4) && !(id & 4), x: u16(b, r + 3), y: u16(b, r + 5), w: u16(b, r + 7), h: u16(b, r + 9), name, target };
        if (id >= 0xEA && id <= 0xEF) {
            // ContextName>Window@File
            const m = /^([^>@]*)(?:>([^@]*))?(?:@(.*))?$/.exec(target) || [, target];
            spot.context = m[1];
            spot.window = m[2] || null;
            spot.file = m[3] || null;
        } else if (spot.kind !== 'macro') {
            spot.context = target;
        }
        if (spot.kind === 'macro') spot.macro = target;
        spots.push(spot);
    }
    return spots;
}

// Bitmap pixels to RGBA; DIB rows are 32-bit aligned, DDB rows 16-bit, both stored bottom-up
export function bitmapToRgba(pix, w, h, bpp, palette, ddb, transparent) {
    const stride = ddb ? (((w * bpp + 15) >> 4) << 1) : (((w * bpp + 31) >> 5) << 2);
    const rgba = new Uint8ClampedArray(w * h * 4);
    const pal = palette && palette.length ? palette : (bpp === 1 ? [[0, 0, 0], [255, 255, 255]] : VGA16);
    // Transparent bitmaps (bmct): white shows the background
    const isClear = transparent ? (r, g, b) => r === 255 && g === 255 && b === 255 : null;
    for (let y = 0; y < h; y++) {
        const row = (h - 1 - y) * stride;
        let d = y * w * 4;
        for (let x = 0; x < w; x++, d += 4) {
            let r, g, b;
            if (bpp <= 8) {
                const bitPos = x * bpp;
                const byte = pix[row + (bitPos >> 3)] || 0;
                const idx = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
                const c = pal[idx] || pal[idx % pal.length] || [0, 0, 0];
                r = c[0]; g = c[1]; b = c[2];
            } else if (bpp === 16) {
                const v = (pix[row + x * 2] || 0) | ((pix[row + x * 2 + 1] || 0) << 8);
                r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31;
            } else {
                const k = row + x * (bpp >> 3);
                b = pix[k] || 0; g = pix[k + 1] || 0; r = pix[k + 2] || 0;
            }
            rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b;
            rgba[d + 3] = isClear && isClear(r, g, b) ? 0 : 255;
        }
    }
    return rgba;
}

// One SHG/MRB picture set at b[base..end): every picture in it, decoded
export function parsePictures(b, base, end, decode = bytes => String.fromCharCode(...bytes)) {
    const magic = u16(b, base);
    if (magic !== 0x506C && magic !== 0x706C) fail(`not a picture (magic 0x${magic.toString(16)})`);
    const n = u16(b, base + 2);
    if (n > 64) fail(`picture claims ${n} resolutions`);
    const pictures = [];
    for (let i = 0; i < n; i++) {
        const at = base + u32(b, base + 4 + 4 * i);
        if (at >= end) { pictures.push({ type: 'error', error: 'picture offset outside the data' }); continue; }
        try {
            pictures.push(parseOnePicture(b, at, end, decode));
        } catch (err) {
            pictures.push({ type: 'error', error: err.message });
        }
    }
    return pictures;
}

function parseOnePicture(b, at, end, decode) {
    const type = u8(b, at), packing = u8(b, at + 1);
    const c = { p: at + 2 };
    if (type === 5 || type === 6) {
        const xdpi = cDword(b, c), ydpi = cDword(b, c);
        const planes = cWord(b, c), bpp = cWord(b, c);
        const width = cDword(b, c), height = cDword(b, c);
        const colorsUsed = cDword(b, c), colorsImportant = cDword(b, c);
        const csize = cDword(b, c), hsSize = cDword(b, c);
        const dataOff = u32(b, c.p), hsOff = u32(b, c.p + 4);
        c.p += 8;
        if (![1, 4, 8, 16, 24, 32].includes(bpp)) fail(`unsupported bit depth ${bpp}`);
        if (!width || !height || width * height > 64e6) fail(`bad bitmap size ${width}×${height}`);
        let palette = null;
        if (type === 6 && bpp <= 8) {
            const nc = colorsUsed || (1 << bpp);
            palette = [];
            for (let k = 0; k < nc; k++) palette.push([u8(b, c.p + 2), u8(b, c.p + 1), u8(b, c.p)]), c.p += 4;
        }
        const stride = type === 5 ? (((width * bpp + 15) >> 4) << 1) : (((width * bpp + 31) >> 5) << 2);
        const pix = unpack(b, at + dataOff, csize, stride * height, packing);
        return {
            type: type === 6 ? 'dib' : 'ddb', width, height, bpp, planes, xdpi, ydpi, packing,
            transparent: colorsImportant === 1,
            rgba: bitmapToRgba(pix, width, height, bpp, palette, type === 5, colorsImportant === 1),
            hotspots: hsOff ? parseHotspots(b, at + hsOff, hsSize, decode) : [],
        };
    }
    if (type === 8) {
        const mapMode = cWord(b, c);
        const width = u16(b, c.p), height = u16(b, c.p + 2);
        c.p += 4;
        const size = cDword(b, c), csize = cDword(b, c), hsSize = cDword(b, c);
        const dataOff = u32(b, c.p), hsOff = u32(b, c.p + 4);
        return {
            type: 'wmf', mapMode, width, height, packing,
            data: unpack(b, at + dataOff, csize, size, packing),
            hotspots: hsOff ? parseHotspots(b, at + hsOff, hsSize, decode) : [],
        };
    }
    fail(`unknown picture type ${type}`);
}

// The picture to show from a set: the bitmap with the most colours, else a metafile
export function bestPicture(pictures) {
    const ok = pictures.filter(p => p.type !== 'error');
    const bmps = ok.filter(p => p.type === 'dib' || p.type === 'ddb');
    if (bmps.length) return bmps.reduce((a, p) => (p.bpp > a.bpp || (p.bpp === a.bpp && p.width > a.width) ? p : a));
    return ok[0] || pictures[0] || null;
}

// --- the help file ---
export class WinHelpFile {
    constructor(bytes, opts = {}) {
        this.bytes = bytes;
        this.warnings = [];
        if (bytes.length < 16) fail(`the file is ${bytes.length} bytes, too short for a help file`);
        if (u32(bytes, 0) !== WINHELP_MAGIC) fail('not a Windows Help file (wrong magic)');
        this.directoryStart = u32(bytes, 4);
        this.declaredSize = u32(bytes, 12);
        if (this.declaredSize > bytes.length) this.warnings.push(`The file is truncated: the header says ${this.declaredSize} bytes, but there are only ${bytes.length}.`);
        if (this.directoryStart + 9 > bytes.length) {
            fail(this.declaredSize > bytes.length
                ? `the file is truncated: it should be ${this.declaredSize} bytes but is ${bytes.length}, and the internal directory (at ${this.directoryStart}) is in the missing part`
                : `the internal directory (at ${this.directoryStart}) lies past the end of the file — the file is damaged`);
        }
        this._readDirectory();
        this._readSystem();
        this.encoding = opts.encoding || this.detectedEncoding;
        this.decoder = makeDecoder(this.encoding);
        this.decode = bytes => this.decoder.decode(bytes);
        if (this.title == null && this._titleBytes) this.title = this.decode(this._titleBytes);
        for (const rec of this.systemRecords) if (rec.bytes && rec.text === undefined) rec.text = this.decode(rec.bytes);
        this._applySystemText();
        this._readPhrases();
        this._readFonts();
        this._readTopicData();
        this._walkTopics();
        this._readContext();
        this._pictureCache = new Map();
    }

    // Internal files: name → { offset, start, end, used, reserved }
    _readDirectory() {
        const b = this.bytes;
        const at = this.directoryStart;
        const used = u32(b, at + 4);
        const start = at + 9;
        const tree = btreeEntries(b, start, Math.min(b.length, start + used), (bb, q) => {
            const e = cstrEnd(bb, q);
            if (e >= bb.length) fail('directory entry runs past the end of the file');
            return [{ name: String.fromCharCode(...bb.subarray(q, e)), offset: u32(bb, e + 1) }, e + 5];
        }, 'directory');
        this.files = new Map();
        this.fileList = [];
        for (const { name, offset } of tree.entries) {
            const info = { name, offset, reserved: 0, used: 0, start: offset + 9, end: offset + 9, ok: false };
            if (offset + 9 <= b.length) {
                info.reserved = u32(b, offset);
                info.used = u32(b, offset + 4);
                info.end = info.start + info.used;
                info.ok = info.end <= b.length;
                if (!info.ok) info.end = b.length;
            }
            this.files.set(name, info);
            this.fileList.push(info);
        }
        if (!this.files.size) fail('the internal directory is empty');
    }

    file(name) {
        let f = this.files.get(name);
        if (!f && name[0] === '|') f = this.files.get(name.slice(1));
        if (!f && name[0] !== '|') f = this.files.get('|' + name);
        if (!f) return null;
        if (!f.ok) {
            const msg = `Internal file ${f.name} runs past the end of the file (truncated).`;
            if (!this.warnings.includes(msg)) this.warnings.push(msg);
        }
        return f;
    }

    _readSystem() {
        const f = this.file('|SYSTEM');
        if (!f) fail('no |SYSTEM internal file — not a usable help file');
        const b = this.bytes;
        const magic = u16(b, f.start);
        if (magic !== 0x036C) fail(`|SYSTEM has the wrong magic (0x${magic.toString(16)})`);
        this.minor = u16(b, f.start + 2);
        this.major = u16(b, f.start + 4);
        this.genDate = u32(b, f.start + 6);
        this.flags = this.minor > 16 ? u16(b, f.start + 10) : 0;
        this.systemRecords = [];
        this.windows = [];
        this.configMacros = [];
        this.contentsOffset = null;
        this.charset = null;
        this.lcid = null;
        if (this.minor <= 16) {
            const s = f.start + 12;
            this._titleBytes = b.subarray(s, cstrEnd(b, s, f.end));
            this.title = null;
        } else {
            for (let p = f.start + 12, guard = 0; p + 4 <= f.end && guard < 10000; guard++) {
                const type = u16(b, p), size = u16(b, p + 2);
                const data = b.subarray(p + 4, Math.min(f.end, p + 4 + size));
                const rec = { type, size };
                switch (type) {
                case 1: case 2: case 4: case 8: case 10: case 14:
                    rec.bytes = data.subarray(0, cstrEnd(data, 0));
                    break;
                case 3: if (data.length >= 4) this.contentsOffset = u32(data, 0); break;
                case 6: rec.window = this._parseWindow(data); this.windows.push(rec.window); break;
                case 9: if (data.length >= 2) this.lcid = u16(data, 0); break;
                case 11: if (data.length >= 1) this.charset = data[0]; break;
                case 12: if (data.length > 2) rec.font = { size: data[0], charset: data[1], nameBytes: data.subarray(2, cstrEnd(data, 2)) }; break;
                }
                this.systemRecords.push(rec);
                p += 4 + size;
            }
            this.title = null;
        }
        const titleRec = this.systemRecords.find(r => r.type === 1);
        if (titleRec) this._titleBytes = titleRec.bytes;
        this.version = this.minor <= 16 ? '3.0' : this.minor <= 21 ? '3.1' : this.minor === 27 ? 'MediaView' : this.minor >= 33 ? '4.0' : `1.${this.minor}`;
        // Topic block layout
        this.hc30 = this.minor <= 16;
        this.compressed = !this.hc30 && (this.flags & 0x0C) !== 0;
        this.topicBlockSize = this.hc30 ? 0x800 : (this.flags & 8) ? 0x800 : 0x1000;
        this.decompressSize = this.hc30 ? 0x800 : 0x4000;
        let enc = this.charset != null ? CHARSET_ENCODINGS[this.charset] : null;
        if (!enc && this.lcid != null) enc = LANG_ENCODINGS[this.lcid & 0x3FF];
        const defFont = this.systemRecords.find(r => r.type === 12 && r.font);
        if (!enc && defFont) enc = CHARSET_ENCODINGS[defFont.font.charset];
        this.detectedEncoding = enc || 'windows-1252';
    }

    _parseWindow(d) {
        const flags = d.length >= 2 ? u16(d, 0) : 0;
        const str = (o, n) => d.subarray(o, cstrEnd(d, o, Math.min(d.length, o + n)));
        const w = {
            typeBytes: flags & 1 ? str(2, 10) : null, nameBytes: flags & 2 ? str(12, 9) : null, captionBytes: flags & 4 ? str(21, 51) : null,
            x: flags & 8 && d.length >= 74 ? i16(d, 72) : null, y: flags & 0x10 && d.length >= 76 ? i16(d, 74) : null,
            width: flags & 0x20 && d.length >= 78 ? i16(d, 76) : null, height: flags & 0x40 && d.length >= 80 ? i16(d, 78) : null,
            maximize: flags & 0x80 && d.length >= 82 ? u16(d, 80) : null,
            rgb: flags & 0x100 && d.length >= 86 ? [d[82], d[83], d[84]] : null,
            rgbNsr: flags & 0x200 && d.length >= 90 ? [d[86], d[87], d[88]] : null,
            onTop: !!(flags & 0x400), autoSize: !!(flags & 0x800),
        };
        return w;
    }

    _applySystemText() {
        const t = this.systemRecords;
        const pick = type => { const r = t.find(x => x.type === type); return r ? r.text : null; };
        this.copyright = pick(2);
        this.citation = pick(8);
        this.cntFile = pick(10);
        this.configMacros = t.filter(r => r.type === 4).map(r => r.text);
        for (const w of this.windows) {
            w.type = w.typeBytes ? this.decode(w.typeBytes) : '';
            w.name = w.nameBytes ? this.decode(w.nameBytes) : '';
            w.caption = w.captionBytes ? this.decode(w.captionBytes) : '';
        }
        const defFont = t.find(r => r.type === 12 && r.font);
        this.defaultFont = defFont ? { size: defFont.font.size, name: this.decode(defFont.font.nameBytes) } : null;
        this.mainWindow = this.windows.find(w => /^main$/i.test(w.name)) || this.windows.find(w => /^main$/i.test(w.type)) || null;
    }

    // --- phrase tables ---
    _readPhrases() {
        const b = this.bytes;
        this.phraseMode = null;
        const ph = this.file('|Phrases');
        if (ph) {
            const p = ph.start;
            let num = u16(b, p), offsBase, decSize;
            const hasSize = !this.hc30;
            if (num === 0x0800 && u16(b, p + 4) === 0x0100) {
                // MediaView layout: 0x0800, count, 0x0100, size, 30 unused bytes
                num = u16(b, p + 2);
                decSize = u32(b, p + 6);
                offsBase = p + 40;
            } else {
                offsBase = p + 4 + (hasSize ? 4 : 0);
                decSize = hasSize ? u32(b, p + 4) : 0;
            }
            const offs = new Array(num + 1);
            for (let i = 0; i <= num; i++) offs[i] = u16(b, offsBase + 2 * i) - 2 * (num + 1);
            const dataStart = offsBase + 2 * (num + 1);
            const data = hasSize ? lz77(b, dataStart, ph.end, decSize || Infinity) : b.subarray(dataStart, ph.end);
            this.phrases = { offsets: offs, data, count: num };
            this.phraseMode = 'old';
            return;
        }
        const idx = this.file('|PhrIndex'), img = this.file('|PhrImage');
        if (idx && img) {
            const num = u32(b, idx.start + 4);
            const imgSize = u32(b, idx.start + 12), imgCsize = u32(b, idx.start + 16);
            const bc = u16(b, idx.start + 24) & 0x0F;
            if (num > 1e6) fail('|PhrIndex claims too many phrases');
            const offs = new Array(num + 1);
            offs[0] = 0;
            let wp = idx.start + 28, word = 0, mask = 0;
            const bit = () => {
                if (!mask) { word = u32(b, wp); wp += 4; mask = 1; }
                const r = (word & mask) !== 0;
                mask = (mask << 1) >>> 0;
                return r;
            };
            for (let i = 0; i < num; i++) {
                let n = 1;
                while (bit()) n += 1 << bc;
                if (bit()) n += 1;
                if (bc > 1 && bit()) n += 2;
                if (bc > 2 && bit()) n += 4;
                if (bc > 3 && bit()) n += 8;
                if (bc > 4 && bit()) n += 16;
                offs[i + 1] = offs[i] + n;
            }
            const data = imgSize === imgCsize ? b.subarray(img.start, img.end) : lz77(b, img.start, img.end, imgSize || Infinity);
            this.phrases = { offsets: offs, data, count: num };
            this.phraseMode = 'hall';
        }
    }

    _expandOld(src, size) {
        const { offsets, data, count } = this.phrases;
        const out = new Uint8Array(size);
        let o = 0;
        for (let p = 0; p < src.length && o < size;) {
            const ch = src[p];
            if (ch === 0 || ch >= 0x10) { out[o++] = ch; p++; continue; }
            if (p + 1 >= src.length) break;
            const code = 0x100 * ch + src[p + 1];
            const idx = (code - 0x100) >> 1;
            p += 2;
            if (idx < count) {
                for (let k = offsets[idx]; k < offsets[idx + 1] && o < size; k++) out[o++] = data[k];
            }
            if ((code & 1) && o < size) out[o++] = 0x20;
        }
        return out.subarray(0, o);
    }

    _expandHall(src, size) {
        const { offsets, data, count } = this.phrases;
        const out = new Uint8Array(size);
        let o = 0;
        const phrase = idx => { if (idx < count) for (let k = offsets[idx]; k < offsets[idx + 1] && o < size; k++) out[o++] = data[k]; };
        for (let p = 0; p < src.length && o < size; p++) {
            const ch = src[p];
            if ((ch & 1) === 0) phrase(ch >> 1);
            else if ((ch & 3) === 1) { phrase(((ch >> 2) << 8) + (src[++p] || 0) + 128); }
            else if ((ch & 7) === 3) {
                const n = (ch >> 3) + 1;
                for (let k = 0; k < n && o < size; k++) out[o++] = src[++p] || 0;
            } else {
                const n = (ch >> 4) + 1;
                const v = (ch & 0x0F) === 0x07 ? 0x20 : 0;
                for (let k = 0; k < n && o < size; k++) out[o++] = v;
            }
        }
        return out.subarray(0, o);
    }

    // --- fonts ---
    _readFonts() {
        const f = this.file('|FONT');
        this.fonts = [];
        this.fontUnit = 0.5; // points per unit: half-points in classic help files
        if (!f) return;
        const b = this.bytes;
        const s = f.start;
        const numFaces = u16(b, s), numDescs = u16(b, s + 2), faceOff = u16(b, s + 4), descOff = u16(b, s + 6);
        const faceLen = numFaces ? Math.floor((descOff - faceOff) / numFaces) : 0;
        const faces = [];
        for (let i = 0; i < numFaces; i++) {
            const a = s + faceOff + i * faceLen;
            faces.push(this.decode(b.subarray(a, cstrEnd(b, a, Math.min(f.end, a + faceLen)))));
        }
        const FAMILIES = { 1: 'modern', 2: 'roman', 3: 'swiss', 4: 'script', 5: 'decorative' };
        if (faceOff >= 12) {
            // MediaView fonts (newfont, mvbfont): metrics in twips
            this.fontUnit = 0.05;
            const mvb = faceOff >= 16;
            const size = 42;
            for (let i = 0; i < numDescs; i++) {
                const d = s + descOff + i * size;
                if (d + size > f.end) break;
                const face = mvb ? i16(b, d) : i16(b, d + 1);
                const fg = mvb ? d + 6 : d + 3;
                const h = Math.abs(i32(b, mvb ? d + 12 : d + 14));
                const w = mvb ? d + 28 : d + 30;
                const weight = i16(b, w);
                const pf = u8(b, w + 11);
                this.fonts.push({
                    face: faces[face] || '', size: h / 20, bold: weight > 500, italic: !!u8(b, w + 4), underline: !!u8(b, w + 5),
                    strike: !!u8(b, w + 6), doubleUnderline: !!u8(b, w + 7), smallCaps: !!u8(b, w + 8),
                    family: { 0x10: 'roman', 0x20: 'swiss', 0x30: 'modern', 0x40: 'script', 0x50: 'decorative' }[pf & 0xF0] || 'swiss',
                    color: [u8(b, fg), u8(b, fg + 1), u8(b, fg + 2)],
                });
            }
            return;
        }
        for (let i = 0; i < numDescs; i++) {
            const d = s + descOff + i * 11;
            if (d + 11 > f.end) break;
            const attr = u8(b, d);
            this.fonts.push({
                face: faces[u16(b, d + 3)] || '', size: u8(b, d + 1) / 2, family: FAMILIES[u8(b, d + 2)] || 'swiss',
                bold: !!(attr & 1), italic: !!(attr & 2), underline: !!(attr & 4), strike: !!(attr & 8), doubleUnderline: !!(attr & 16), smallCaps: !!(attr & 32),
                color: [u8(b, d + 5), u8(b, d + 6), u8(b, d + 7)],
            });
        }
    }

    // --- |TOPIC: blocks decompressed into one buffer ---
    _readTopicData() {
        const f = this.file('|TOPIC');
        if (!f) fail('no |TOPIC internal file — not a usable help file');
        const b = this.bytes;
        const tbs = this.topicBlockSize;
        const nBlocks = Math.max(1, Math.ceil((f.end - f.start) / tbs));
        const parts = [];
        let total = 0;
        for (let i = 0; i < nBlocks; i++) {
            const bs = f.start + i * tbs;
            if (bs + 12 > f.end) break;
            const be = Math.min(f.end, bs + tbs);
            const part = this.compressed ? lz77(b, bs + 12, be, this.decompressSize) : b.subarray(bs + 12, be);
            parts.push(part);
            total += part.length;
        }
        this.topicBuf = new Uint8Array(total);
        this.blockStart = [];
        let o = 0;
        for (const part of parts) { this.blockStart.push(o); this.topicBuf.set(part, o); o += part.length; }
        this.blockStart.push(o);
        this.topicFile = f;
    }

    // TOPICPOS → offset in topicBuf
    _posToBuf(pos) {
        if (pos < 12) return -1;
        const block = Math.floor((pos - 12) / this.decompressSize);
        const off = (pos - 12) % this.decompressSize;
        if (block >= this.blockStart.length - 1) return -1;
        return this.blockStart[block] + off;
    }

    // One TOPICLINK at TOPICPOS pos: header fields, LinkData1, expanded LinkData2
    _readLink(pos) {
        const t = this.topicBuf;
        const at = this._posToBuf(pos);
        if (at < 0 || at + 21 > t.length) return null;
        const blockSize = u32(t, at), dataLen2 = u32(t, at + 4);
        const prev = u32(t, at + 8), next = u32(t, at + 12), dataLen1 = u32(t, at + 16);
        const type = t[at + 20];
        if (blockSize < 21 || dataLen1 < 21 || dataLen1 > blockSize || at + blockSize > t.length + 16) {
            return { pos, type, blockSize, next, prev, bad: true };
        }
        const end = Math.min(t.length, at + blockSize);
        const d1 = t.subarray(at + 21, Math.min(end, at + dataLen1));
        const raw = t.subarray(Math.min(end, at + dataLen1), end);
        let d2;
        if (dataLen2 > raw.length && this.phrases) d2 = this.phraseMode === 'hall' ? this._expandHall(raw, dataLen2) : this._expandOld(raw, dataLen2);
        else d2 = raw.subarray(0, Math.min(raw.length, dataLen2));
        return { pos, type, blockSize, dataLen1, dataLen2, prev, next, d1, d2, bufAt: at };
    }

    // Walk every TOPICLINK, collecting topics and the records each holds
    _walkTopics() {
        this.topics = [];
        let pos = 12, offset = 0, topic = null, count = 0;
        const seen = new Set();
        const maxLinks = 2e6;
        while (count++ < maxLinks) {
            if (seen.has(pos)) { this.warnings.push('The topic list loops back on itself; stopped reading there.'); break; }
            seen.add(pos);
            const link = this._readLink(pos);
            if (!link) { this.warnings.push(`The topic chain points outside |TOPIC (position ${pos}); the topics after it are missing.`); break; }
            if (link.bad) { this.warnings.push(`Damaged topic record at position ${pos}; stopped reading there.`); break; }
            const block = Math.floor((pos - 12) / this.decompressSize);
            // The last TOPICLINK (no successor) holds no usable data
            let next;
            if (this.hc30) {
                next = pos + link.next;
                if (!link.next || next >= this.topicFile.used) break;
            } else {
                next = link.next;
                if (next === 0xFFFFFFFF || next === 0) break;
            }
            if (link.type === 2) {
                const d = link.d1;
                const titleEnd = cstrEnd(link.d2, 0);
                const macros = [];
                for (let p = titleEnd + 1; p < link.d2.length;) {
                    const e = cstrEnd(link.d2, p);
                    if (e > p) macros.push(this.decode(link.d2.subarray(p, e)));
                    p = e + 1;
                }
                topic = {
                    index: this.topics.length, pos, offset: this.hc30 ? pos : offset,
                    title: this.decode(link.d2.subarray(0, titleEnd)), macros, records: [],
                };
                if (this.hc30) {
                    topic.browsePrev = d.length >= 8 ? i32(d, 4) : -1;
                    topic.browseNext = d.length >= 12 ? i32(d, 8) : -1;
                } else if (d.length >= 28) {
                    topic.browsePrev = i32(d, 4);
                    topic.browseNext = i32(d, 8);
                    topic.number = u32(d, 12);
                    topic.nonScroll = i32(d, 16);
                    topic.scroll = i32(d, 20);
                }
                this.topics.push(topic);
            } else if (link.type === 1 || link.type === 0x20 || link.type === 0x23) {
                let length = 0;
                if (link.type !== 1) {
                    try { const c = { p: 0 }; cLong(link.d1, c); length = cWord(link.d1, c); } catch { length = 0; }
                }
                if (topic) topic.records.push({ pos, type: link.type, offset: this.hc30 ? pos : offset });
                offset += length;
            }
            if (!this.hc30) {
                const nb = Math.floor((next - 12) / this.decompressSize);
                if (nb !== block) offset = nb * 0x8000;
            }
            if (next <= pos && this.hc30) { this.warnings.push('A topic record points backwards; stopped reading there.'); break; }
            pos = next;
        }
        // The compilers end |TOPIC with an empty topic header
        const last = this.topics[this.topics.length - 1];
        if (this.topics.length > 1 && last && !last.title && !last.macros.length && !this.topicText(last).trim()) this.topics.pop();
        if (!this.topics.length) fail('the help file holds no topics');
    }

    _readContext() {
        const b = this.bytes;
        this.contextMap = new Map();
        const ctx = this.file('|CONTEXT');
        if (ctx) {
            try {
                const tree = btreeEntries(b, ctx.start, ctx.end, (bb, q) => [[u32(bb, q), u32(bb, q + 4)], q + 8], '|CONTEXT');
                for (const [hash, off] of tree.entries) this.contextMap.set(hash, off);
            } catch (err) { this.warnings.push('Could not read the context index: ' + err.message); }
        }
        this.toMap = null;
        const tm = this.file('|TOMAP');
        if (tm) {
            this.toMap = [];
            for (let p = tm.start; p + 4 <= tm.end; p += 4) this.toMap.push(i32(b, p));
        }
        this.ctxoMap = new Map();
        const cm = this.file('|CTXOMAP');
        if (cm) {
            const n = u16(b, cm.start);
            for (let i = 0; i < n && cm.start + 2 + i * 8 + 8 <= cm.end; i++) this.ctxoMap.set(i32(b, cm.start + 2 + i * 8), u32(b, cm.start + 6 + i * 8));
        }
        // Context names, when the compiler kept them (|TopicId, HCRTF /a)
        this.topicIds = new Map();
        const tid = this.file('|TopicId');
        if (tid) {
            try {
                const tree = btreeEntries(b, tid.start, tid.end, (bb, q) => { const e = cstrEnd(bb, q + 4); return [[u32(bb, q), this.decode(bb.subarray(q + 4, e))], e + 1]; }, '|TopicId');
                for (const [off, name] of tree.entries) if (!this.topicIds.has(off)) this.topicIds.set(off, name);
            } catch (err) { this.warnings.push('Could not read |TopicId: ' + err.message); }
        }
    }

    // --- lookups ---
    // The topic holding TOPICOFFSET off (3.1+) or TOPICPOS (3.0)
    topicByOffset(off) {
        if (off == null || off === -1 || off === 0xFFFFFFFF) return null;
        off >>>= 0;
        let found = null;
        for (const t of this.topics) if (t.offset >>> 0 <= off && (!found || t.offset >>> 0 >= found.offset >>> 0)) found = t;
        return found;
    }

    topicByHash(hash) {
        const off = this.contextMap.get(hash >>> 0);
        return off == null ? null : { topic: this.topicByOffset(off), offset: off };
    }

    // HC30 jumps and browse links name topic numbers, mapped through |TOMAP
    topicByNumber(n) {
        if (!this.toMap || n < 0 || n >= this.toMap.length) return null;
        const pos = this.toMap[n];
        return this.topics.find(t => t.pos === pos) || this.topicByOffset(pos);
    }

    topicByContext(name) {
        const r = this.topicByHash(contextHash(name));
        return r && r.topic;
    }

    contentsTopic() {
        if (this.hc30 && this.toMap && this.toMap.length) {
            const t = this.topicByNumber(0);
            if (t) return t;
        }
        if (this.contentsOffset != null) {
            const t = this.topicByOffset(this.contentsOffset);
            if (t) return t;
        }
        return this.topics[0];
    }

    browse(topic, dir) {
        const v = dir < 0 ? topic.browsePrev : topic.browseNext;
        if (v == null || v === -1 || (this.hc30 && (v & 0xFFFF) === 0xFFFF)) return null;
        return this.hc30 ? this.topicByNumber(v) : this.topicByOffset(v);
    }

    // --- keywords: |KWBTREE + |KWDATA (and the other |xWBTREE indexes) ---
    keywordIndexes() {
        return [...this.files.keys()].filter(n => /^\|.WBTREE$/.test(n)).map(n => n[1]);
    }

    keywords(letter = 'K') {
        const tree = this.file(`|${letter}WBTREE`), data = this.file(`|${letter}WDATA`);
        if (!tree || !data) return [];
        const b = this.bytes;
        const { entries } = btreeEntries(b, tree.start, tree.end, (bb, q) => {
            const e = cstrEnd(bb, q);
            return [{ bytes: bb.subarray(q, e), count: u16(bb, e + 1), at: u32(bb, e + 3) }, e + 7];
        }, `|${letter}WBTREE`);
        return entries.map(k => {
            const offsets = [];
            for (let i = 0; i < k.count && i < 10000; i++) {
                const p = data.start + k.at + i * 4;
                if (p + 4 > data.end) break;
                offsets.push(u32(b, p));
            }
            return { keyword: this.decode(k.bytes), offsets };
        });
    }

    // |TTLBTREE: titles by topic offset (used for the debug view)
    titleTree() {
        const f = this.file('|TTLBTREE');
        if (!f) return [];
        return btreeEntries(this.bytes, f.start, f.end, (bb, q) => { const e = cstrEnd(bb, q + 4); return [{ offset: u32(bb, q), title: this.decode(bb.subarray(q + 4, e)) }, e + 1]; }, '|TTLBTREE').entries;
    }

    // --- pictures ---
    bitmapFile(n) {
        if (this._pictureCache.has(n)) return this._pictureCache.get(n);
        let result;
        const f = this.file(`|bm${n}`);
        if (!f) result = { error: `bitmap ${n} is missing (no |bm${n})` };
        else {
            try { result = { pictures: parsePictures(this.bytes, f.start, f.end, this.decode) }; } catch (err) { result = { error: err.message }; }
        }
        this._pictureCache.set(n, result);
        return result;
    }

    // --- topic content ---
    // Records of a topic as paragraphs and tables of inline items.
    topicContent(topic) {
        const out = [];
        for (const rec of topic.records) {
            const link = this._readLink(rec.pos);
            if (!link || link.bad) continue;
            let block;
            try {
                block = this._parseRecord(link);
            } catch (err) {
                block = { kind: 'error', error: err.message };
            }
            block.offset = rec.offset;
            block.pos = rec.pos;
            block.nonScroll = !this.hc30 && topic.nonScroll != null && topic.nonScroll !== -1 && rec.pos < (topic.scroll >>> 0);
            out.push(block);
        }
        return out;
    }

    _parseRecord(link) {
        const d = link.d1, s = link.d2;
        const c = { p: 0 };
        const strs = { p: 0 };
        const nextString = () => {
            if (strs.p >= s.length) return '';
            const e = cstrEnd(s, strs.p);
            const str = this.decode(s.subarray(strs.p, e));
            strs.p = e + 1;
            return str;
        };
        cLong(d, c); // topic size
        let block;
        if (link.type === 0x20 || link.type === 0x23) cWord(d, c); // topic length
        if (link.type === 0x23) {
            const ncols = u8(d, c.p), tableType = u8(d, c.p + 1);
            c.p += 2;
            let minWidth = null;
            if (tableType === 0 || tableType === 2) { minWidth = i16(d, c.p); c.p += 2; }
            const cols = [];
            for (let i = 0; i < ncols; i++) { cols.push({ width: i16(d, c.p), gap: i16(d, c.p + 2) }); c.p += 4; }
            block = { kind: 'table', tableType, minWidth, relative: tableType === 0 || tableType === 2, cols, cells: [] };
        } else {
            block = { kind: 'text', paras: [] };
        }
        let cell = null;
        for (let guard = 0; guard < 4096 && c.p < d.length; guard++) {
            if (link.type === 0x23) {
                const col = i16(d, c.p);
                if (col === -1) break;
                c.p += 5;
                if (!cell || cell.col !== col) { cell = { col, paras: [] }; block.cells.push(cell); }
            }
            c.p += 4;
            const fmt = this._parseParaInfo(d, c);
            const paras = link.type === 0x23 ? cell.paras : block.paras;
            let para = { fmt, items: [] };
            paras.push(para);
            let ended = false;
            for (let g2 = 0; g2 < 100000; g2++) {
                const str = nextString();
                if (str) para.items.push({ t: 'text', s: str });
                if (c.p >= d.length) { ended = true; break; }
                const cmd = d[c.p];
                if (cmd === 0xFF) { c.p++; break; }
                switch (cmd) {
                case 0x20: c.p += 5; break;
                case 0x21: c.p += 3; break;
                case 0x80: para.items.push({ t: 'font', n: i16(d, c.p + 1) }); c.p += 3; break;
                case 0x81: para.items.push({ t: 'br' }); c.p++; break;
                case 0x82:
                    c.p++;
                    if (link.type === 0x23 && d[c.p] === 0xFF) break; // the cell or paragraph format ends with the next 0xFF
                    para = { fmt, items: [], cont: true };
                    paras.push(para);
                    break;
                case 0x83: para.items.push({ t: 'tab' }); c.p++; break;
                case 0x86: case 0x87: case 0x88: {
                    const align = cmd === 0x86 ? 'char' : cmd === 0x87 ? 'left' : 'right';
                    const ptype = u8(d, c.p + 1);
                    c.p += 2;
                    const size = cLong(d, c);
                    if (ptype === 0x22) cWord(d, c);
                    const u = c.p;
                    if (ptype === 0x03 || ptype === 0x22) {
                        const embedded = i16(d, u);
                        if (embedded === 0) para.items.push({ t: 'img', align, bitmap: u16(d, u + 2) });
                        else if (embedded === 1) {
                            let pics;
                            try { pics = { pictures: parsePictures(d, u + 2, Math.min(d.length, u + size), this.decode) }; } catch (err) { pics = { error: err.message }; }
                            para.items.push({ t: 'img', align, inline: pics });
                        }
                    } else if (ptype === 0x05) {
                        const e = cstrEnd(d, u + 6, Math.min(d.length, u + size));
                        para.items.push({ t: 'embed', align, text: this.decode(d.subarray(u + 6, e)) });
                    }
                    c.p = u + size;
                    break;
                }
                case 0x89: para.items.push({ t: 'endlink' }); c.p++; break;
                case 0x8B: para.items.push({ t: 'text', s: ' ' }); c.p++; break;
                case 0x8C: para.items.push({ t: 'text', s: '‑' }); c.p++; break;
                case 0xC8: case 0xCC: {
                    const len = i16(d, c.p + 1);
                    const e = cstrEnd(d, c.p + 3, Math.min(d.length, c.p + 3 + len));
                    para.items.push({ t: 'link', kind: 'macro', macro: this.decode(d.subarray(c.p + 3, e)), plain: cmd === 0xCC });
                    c.p += 3 + Math.max(0, len);
                    break;
                }
                case 0xE0: case 0xE1:
                    para.items.push({ t: 'link', kind: cmd & 1 ? 'jump' : 'popup', topicNumber: i32(d, c.p + 1) });
                    c.p += 5;
                    break;
                case 0xE2: case 0xE3: case 0xE6: case 0xE7:
                    para.items.push({ t: 'link', kind: cmd & 1 ? 'jump' : 'popup', hash: u32(d, c.p + 1), plain: !!(cmd & 4) });
                    c.p += 5;
                    break;
                case 0xEA: case 0xEB: case 0xEE: case 0xEF: {
                    const len = i16(d, c.p + 1);
                    const ltype = u8(d, c.p + 3);
                    const item = { t: 'link', kind: cmd & 1 ? 'jump' : 'popup', hash: u32(d, c.p + 4), plain: !!(cmd & 4) };
                    const lim = Math.min(d.length, c.p + 3 + len);
                    if (ltype === 1) item.windowNumber = u8(d, c.p + 8);
                    if (ltype === 4 || ltype === 6) {
                        const e = cstrEnd(d, c.p + 8, lim);
                        const first = this.decode(d.subarray(c.p + 8, e));
                        if (ltype === 4) item.file = first;
                        else {
                            item.window = first;
                            const e2 = cstrEnd(d, e + 1, lim);
                            item.file = this.decode(d.subarray(e + 1, e2));
                        }
                    }
                    para.items.push(item);
                    c.p += 3 + Math.max(0, len);
                    break;
                }
                default: c.p++;
                }
            }
            if (link.type !== 0x23 || ended) break;
        }
        // The paragraph end that closes a record does not start another paragraph
        const last = block.paras && block.paras[block.paras.length - 1];
        if (last && last.cont && !last.items.length && block.paras.length > 1) block.paras.pop();
        return block;
    }

    _parseParaInfo(d, c) {
        const bits = u16(d, c.p);
        c.p += 2;
        const u = this.fontUnit;
        const fmt = { align: bits & 0x0800 ? 'center' : bits & 0x0400 ? 'right' : 'left', keep: !!(bits & 0x1000) };
        if (bits & 0x0001) cLong(d, c);
        if (bits & 0x0002) fmt.spaceBefore = cShort(d, c) * u;
        if (bits & 0x0004) fmt.spaceAfter = cShort(d, c) * u;
        if (bits & 0x0008) fmt.lineSpacing = cShort(d, c) * u;
        if (bits & 0x0010) fmt.leftIndent = cShort(d, c) * u;
        if (bits & 0x0020) fmt.rightIndent = cShort(d, c) * u;
        if (bits & 0x0040) fmt.firstIndent = cShort(d, c) * u;
        if (bits & 0x0100) {
            const bd = u8(d, c.p);
            fmt.border = { box: !!(bd & 1), top: !!(bd & 2), left: !!(bd & 4), bottom: !!(bd & 8), right: !!(bd & 16), thick: !!(bd & 32), double: !!(bd & 64), width: i16(d, c.p + 1) * u };
            c.p += 3;
        }
        if (bits & 0x0200) {
            const n = cShort(d, c);
            fmt.tabs = [];
            for (let i = 0; i < n && i < 64; i++) {
                const tab = cWord(d, c);
                const type = tab & 0x4000 ? cWord(d, c) : 0;
                fmt.tabs.push({ pos: (tab & 0x3FFF) * u, type: type === 1 ? 'right' : type === 2 ? 'center' : 'left' });
            }
        }
        return fmt;
    }

    // Plain text of a topic (for search and tests)
    topicText(topic) {
        const parts = [];
        const para = p => {
            let line = '';
            for (const it of p.items) {
                if (it.t === 'text') line += it.s;
                else if (it.t === 'tab') line += '\t';
                else if (it.t === 'br') line += '\n';
            }
            parts.push(line);
        };
        for (const blk of this.topicContent(topic)) {
            if (blk.kind === 'text') blk.paras.forEach(para);
            else if (blk.kind === 'table') for (const cell of blk.cells) cell.paras.forEach(para);
        }
        return parts.join('\n');
    }
}

// --- format detection ---
export function detectHelpFormat(bytes) {
    if (bytes.length >= 4 && u32(bytes, 0) === WINHELP_MAGIC) return 'winhelp';
    if (bytes.length >= 3 && bytes[0] === 0x48 && bytes[1] === 0x53 && bytes[2] === 0x50) return 'ipf';
    if (bytes.length >= 2 && bytes[0] === 0x4C && bytes[1] === 0x4E) return 'quickhelp';
    const head = bytes.subarray(0, 4096);
    let ctrl = 0;
    for (const x of head) if (x === 0 || (x < 9) || (x > 13 && x < 32 && x !== 26 && x !== 27)) ctrl++;
    if (head.length && ctrl / head.length < 0.02) return 'text';
    return 'unknown';
}
