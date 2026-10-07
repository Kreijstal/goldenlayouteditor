// --- Amiga IFF pictures (.ilbm, .lbm, .ham, .ham8; an .iff that is one) ---
// No browser shows them. An IFF FORM (big-endian chunks, each padded to an
// even length) of type ILBM (bitplanes, each row's planes one after another),
// PBM (DeluxePaint for the PC: one byte per pixel) or ACBM (Amiga BASIC: the
// planes whole, one after another, in an ABIT chunk), read here. BMHD gives the
// size, the number of planes, the masking (a mask plane after each row's
// planes, or a transparent color) and the compression (none, or ByteRun1: n
// 0..127 copies n + 1 bytes, -1..-127 repeats the next byte 1 - n times, -128
// is nothing); CMAP the palette (one whose low nibbles are all zero holds the
// Amiga's 4-bit colors shifted left, scaled to 8 bits here, as the 0xF the
// hardware showed as full brightness); CAMG the viewport mode: Extra Half-Brite
// (6 planes: colors 32..63 are 0..31 at half brightness, each 4-bit OCS
// component halved) and Hold-And-Modify (5 to 8 planes: the top two bits hold
// the last pixel's color and change its red, green or blue, or take a palette
// color; each row starts from color 0, the background, as on the screen).
// HAM6 sets a 4-bit component, so v becomes v * 17 (the 12-bit OCS color it
// is, as FFmpeg has it; netpbm/ImageMagick keep the old low nibble, a shade
// off); HAM8 sets the top six bits of the component and keeps the low two, as
// AGA does (as netpbm has it; FFmpeg repeats the top bits). Palettes that
// change on the way down the screen: sliced HAM (SHAM) and Dynamic HiRes (CTBL),
// colors 0..15 every line (every other one in an interlaced SHAM), and PCHG
// (changes to any colors on the lines it names, 12 or 24-bit, Huffman coded or
// not). 24 and 32-plane ILBMs are 8 planes
// each of red, green, blue (and alpha), least significant first. The pixel
// aspect (xAspect:yAspect) is kept for the viewer. The picture becomes a PNG an
// <img> shows. .iff is IFF's name for anything (8SVX sound, ANIM...): one is
// only shown here if its FORM is ILBM, PBM or ACBM.
const { createLogger } = require('./debug');

const log = createLogger('ILBM');
const ILBM_RE = /\.(ilbm|lbm|ham8?|iff)$/i;
// the name an ILBM shares with every other IFF file
const MAYBE_RE = /\.iff$/i;
const FORM_TYPES = ['ILBM', 'PBM ', 'ACBM'];
const CAMG_EHB = 0x80, CAMG_HAM = 0x800, CAMG_LACE = 0x4;
// to keep a hostile header from asking for gigabytes
const MAX_PIXELS = 400000000;

const decoded = new Map(); // source URL -> Promise<{ url, pages, aspect }>

// Whether the name is one an ILBM goes by (an .iff is one only once its bytes
// say so, see isIlbmMaybeName)
function isIlbmName(name) {
    return ILBM_RE.test(name || '');
}

// A name an ILBM shares with other IFF files (.iff)
function isIlbmMaybeName(name) {
    return MAYBE_RE.test(name || '');
}

const fourcc = (bytes, p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
const u16 = (bytes, p) => (bytes[p] << 8) | bytes[p + 1];
const u32 = (bytes, p) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;

// Bytes that are an IFF picture: a FORM of type ILBM, PBM or ACBM
function isIlbm(bytes) {
    return bytes.length >= 12 && fourcc(bytes, 0) === 'FORM' && FORM_TYPES.includes(fourcc(bytes, 8));
}

// The FORM's chunks: { id: [{ start, size }] }, in file order within each id
function readChunks(bytes) {
    const end = Math.min(bytes.length, 8 + u32(bytes, 4));
    const chunks = {};
    for (let p = 12; p + 8 <= end;) {
        const id = fourcc(bytes, p), size = u32(bytes, p + 4);
        (chunks[id] = chunks[id] || []).push({ start: p + 8, size: Math.min(size, end - p - 8) });
        p += 8 + size + (size & 1);
    }
    return chunks;
}

// ByteRun1 undone, into a buffer of size bytes (a short stream leaves the rest zero)
function unByteRun1(bytes, p, end, size) {
    const out = new Uint8Array(size);
    let o = 0;
    while (p < end && o < size) {
        const n = (bytes[p++] << 24) >> 24;
        if (n >= 0) {
            const len = Math.min(n + 1, end - p, size - o);
            out.set(bytes.subarray(p, p + len), o);
            o += len;
            p += n + 1;
        } else if (n !== -128) {
            if (p >= end) break;
            out.fill(bytes[p++], o, Math.min(size, o + 1 - n));
            o += 1 - n;
        }
    }
    return out;
}

// SHAM/CTBL: 16 12-bit colors (0x0RGB words) per line from skip on, as the
// changes [register, r, g, b] each row starts with (a line's colors for two
// rows of an interlaced picture whose SHAM has half as many lines)
function slicedChanges(bytes, chunk, skip, height, lace) {
    const lines = Math.floor((chunk.size - skip) / 32);
    if (!lines) return null;
    const rows = [];
    for (let y = 0; y < height; y++) {
        const l = Math.min(lines - 1, lace && lines < height ? y >> 1 : y);
        const changes = [];
        for (let i = 0; i < 16; i++) {
            const c = u16(bytes, chunk.start + skip + l * 32 + i * 2);
            changes.push([i, ((c >> 8) & 15) * 17, ((c >> 4) & 15) * 17, (c & 15) * 17]);
        }
        rows.push(changes);
    }
    return { rows, before: [] };
}

// PCHG's Huffman coding undone: tree is 16-bit words, the root last; a set bit
// follows a negative word's (byte) offset or ends at a non-negative one, a
// clear bit steps to the word before, which ends there if it has 0x100 set
function unHuffman(bytes, p, end, tree, size) {
    const out = new Uint8Array(size);
    const root = tree.length - 1;
    let n = root, o = 0;
    for (; p < end && o < size; p++) {
        for (let bit = 7; bit >= 0 && o < size; bit--) {
            if ((bytes[p] >> bit) & 1) {
                if (tree[n] >= 0) { out[o++] = tree[n] & 255; n = root; }
                else n += tree[n] / 2;
            } else {
                n--;
                if (tree[n] > 0 && (tree[n] & 0x100)) { out[o++] = tree[n] & 255; n = root; }
            }
            if (n < 0 || n > root) return out;
        }
    }
    return out;
}

// PCHG (palette changes): a 20-byte header (compression, flags, first line,
// line count, changed lines, ..., total changes), a bit per line saying if it
// changes colors, then each changed line's changes, 12-bit (two counts, for
// registers 0..15 and 16..31, then 0xRRGB words: register, red, green, blue)
// or 24-bit (a count, then register words and alpha, red, blue, green bytes).
// Changes stay until changed again; lines before the first row change the start.
function pchgChanges(bytes, chunk, height) {
    if (chunk.size < 20) return null;
    const s = chunk.start, end = s + chunk.size;
    const compression = u16(bytes, s), flags = u16(bytes, s + 2);
    const startLine = (u16(bytes, s + 4) << 16) >> 16, lineCount = u16(bytes, s + 6);
    let data = bytes.subarray(s + 20, end);
    if (compression === 1) {
        if (chunk.size < 28) return null;
        const treeSize = u32(bytes, s + 20), origSize = u32(bytes, s + 24);
        const tree = new Int16Array(treeSize >> 1);
        for (let i = 0; i < tree.length; i++) tree[i] = u16(bytes, s + 28 + i * 2);
        data = unHuffman(bytes, s + 28 + treeSize, end, tree, Math.min(origSize, 16 << 20));
    } else if (compression) return null;
    const small = !!(flags & 1), big = !!(flags & 2);
    if (!small && !big) return null;
    const maskLen = ((lineCount + 31) >> 5) * 4;
    const rows = Array.from({ length: height }, () => []), before = [];
    let p = maskLen;
    for (let l = 0; l < lineCount; l++) {
        if (!((data[l >> 3] >> (7 - (l & 7))) & 1)) continue;
        const y = startLine + l;
        const changes = y < 0 ? before : y < height ? rows[y] : [];
        if (small) {
            const n16 = data[p], n32 = data[p + 1];
            p += 2;
            for (let i = 0; i < n16 + n32 && p + 2 <= data.length; i++, p += 2) {
                const c = (data[p] << 8) | data[p + 1];
                changes.push([(c >> 12) + (i >= n16 ? 16 : 0), ((c >> 8) & 15) * 17, ((c >> 4) & 15) * 17, (c & 15) * 17]);
            }
        } else {
            const n = (data[p] << 8) | data[p + 1];
            p += 2;
            // yes, red, blue, green
            for (let i = 0; i < n && p + 6 <= data.length; i++, p += 6) changes.push([(data[p] << 8) | data[p + 1], data[p + 3], data[p + 5], data[p + 4]]);
        }
        if (p > data.length) break;
    }
    return { rows, before };
}

// { width, height, rgba, aspect, label }
function ilbmDecode(bytes) {
    if (!isIlbm(bytes)) throw new Error('Not an IFF picture (no FORM of type ILBM, PBM or ACBM)');
    const type = fourcc(bytes, 8).trim();
    const chunks = readChunks(bytes);
    const bmhd = chunks.BMHD && chunks.BMHD[0];
    if (!bmhd || bmhd.size < 20) throw new Error(`IFF ${type} has no BMHD (bitmap header)`);
    const b = bmhd.start;
    const width = u16(bytes, b), height = u16(bytes, b + 2);
    const planes = bytes[b + 8], masking = bytes[b + 9], compression = bytes[b + 10];
    const transparent = u16(bytes, b + 12);
    const xAspect = bytes[b + 14] || 1, yAspect = bytes[b + 15] || 1;
    if (!width || !height) throw new Error(`IFF ${type} is ${width}x${height}`);
    if (width * height > MAX_PIXELS) throw new Error(`IFF ${type} too large (${width}x${height})`);
    if (compression > 1) throw new Error(`IFF ${type} compression ${compression} isn't supported (only none and ByteRun1 are)`);
    if (!planes || (planes > 8 && planes !== 24 && planes !== 32)) throw new Error(`IFF ${type} with ${planes} planes isn't supported (1 to 8, 24 and 32 are)`);
    if (type === 'PBM' && planes > 8) throw new Error(`IFF PBM with ${planes} planes isn't supported (1 to 8 are)`);
    const camg = chunks.CAMG && chunks.CAMG[0].size >= 4 ? u32(bytes, chunks.CAMG[0].start) : 0;
    const ham = !!(camg & CAMG_HAM) && planes >= 5 && planes <= 8;
    const ehb = !ham && !!(camg & CAMG_EHB) && planes === 6;
    const deep = planes > 8;

    // the palette: 4-bit colors (low nibbles all zero) scaled; none at all is a gray ramp
    const count = 1 << Math.min(planes, 8);
    const pal = new Uint8Array(256 * 3);
    let cmapColors = 0, fourBit = false;
    const cmap = chunks.CMAP && chunks.CMAP[0];
    if (cmap && !deep) {
        cmapColors = Math.min(256, Math.floor(cmap.size / 3));
        const raw = bytes.subarray(cmap.start, cmap.start + cmapColors * 3);
        fourBit = raw.length > 0 && raw.every(c => !(c & 15));
        for (let i = 0; i < raw.length; i++) pal[i] = fourBit ? raw[i] | (raw[i] >> 4) : raw[i];
        // Extra Half-Brite: the second 32 colors are the first 32 at half brightness
        // (4-bit colors, scaled or 0xNN, halved as the hardware's 4 bits)
        const nibbles = fourBit || pal.subarray(0, 96).every(c => (c >> 4) === (c & 15));
        if (ehb) for (let i = 0; i < 96; i++) pal[96 + i] = nibbles ? (pal[i] >> 5) * 17 : pal[i] >> 1;
    } else if (!deep) {
        for (let i = 0; i < count; i++) pal[i * 3] = pal[i * 3 + 1] = pal[i * 3 + 2] = Math.round(i * 255 / (count - 1 || 1));
    }
    // colors that change from line to line (SHAM's start with a version word)
    const lace = !!(camg & CAMG_LACE);
    let lines = null, linesKind = '';
    if (deep) { /* no palette to change */ }
    else if (chunks.PCHG && (lines = pchgChanges(bytes, chunks.PCHG[0], height))) linesKind = 'palette changes (PCHG)';
    else if (chunks.SHAM && (lines = slicedChanges(bytes, chunks.SHAM[0], 2, height, lace))) linesKind = 'sliced HAM';
    else if (chunks.CTBL && (lines = slicedChanges(bytes, chunks.CTBL[0], 0, height, lace))) linesKind = 'a palette per line (CTBL)';
    const change = list => { for (const [reg, r, g, b] of list) if (reg < 256) { pal[reg * 3] = r; pal[reg * 3 + 1] = g; pal[reg * 3 + 2] = b; } };
    if (lines) change(lines.before);

    // the pixels, as plane-interleaved rows (ILBM), whole planes (ACBM) or bytes (PBM)
    const body = type === 'ACBM' ? chunks.ABIT && chunks.ABIT[0] : chunks.BODY && chunks.BODY[0];
    if (!body) throw new Error(`IFF ${type} has no ${type === 'ACBM' ? 'ABIT' : 'BODY'} (no pixels)`);
    const rowBytes = ((width + 15) >> 4) * 2;
    const hasMask = masking === 1 && type === 'ILBM';
    const lineBytes = type === 'PBM' ? width + (width & 1) : rowBytes * (planes + (hasMask ? 1 : 0));
    const size = lineBytes * height;
    let data;
    if (compression === 1 && type !== 'ACBM') data = unByteRun1(bytes, body.start, body.start + body.size, size);
    else {
        data = bytes.subarray(body.start, body.start + Math.min(body.size, size));
        // a short file: as far as it goes
        if (data.length < size) {
            const full = new Uint8Array(size);
            full.set(data);
            data = full;
        }
    }

    const rgba = new Uint8ClampedArray(width * height * 4);
    const values = new Uint32Array(width);
    const hamBits = planes > 6 ? 6 : 4, hamMask = (1 << hamBits) - 1;
    let badIndex = false;
    for (let y = 0; y < height; y++) {
        // this row's pixel values, from its planes
        values.fill(0);
        if (type === 'PBM') {
            const row = y * lineBytes;
            for (let x = 0; x < width; x++) values[x] = data[row + x];
        } else {
            for (let pl = 0; pl < planes; pl++) {
                const row = type === 'ACBM' ? (pl * height + y) * rowBytes : y * lineBytes + pl * rowBytes;
                const bit = 2 ** pl;
                for (let x = 0; x < width; x++) {
                    if ((data[row + (x >> 3)] >> (7 - (x & 7))) & 1) values[x] += bit;
                }
            }
        }
        if (lines) change(lines.rows[y]);
        const color = i => pal.subarray(i * 3, i * 3 + 3);
        const maskRow = hasMask ? y * lineBytes + planes * rowBytes : -1;
        let r = 0, g = 0, bl = 0;
        if (ham) [r, g, bl] = color(0);
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4, v = values[x];
            if (deep) {
                rgba[o] = v & 255;
                rgba[o + 1] = (v >>> 8) & 255;
                rgba[o + 2] = (v >>> 16) & 255;
                rgba[o + 3] = planes === 32 ? v >>> 24 : 255;
            } else if (ham) {
                const n = v & hamMask, ctrl = v >> hamBits;
                // HAM6 sets 4 bits (v * 17, the OCS color), HAM8 the top 6 (the low 2 stay)
                const c = hamBits === 4 ? n * 17 : (n << 2);
                if (ctrl === 0) [r, g, bl] = color(n);
                else if (ctrl === 1) bl = hamBits === 4 ? c : c | (bl & 3);
                else if (ctrl === 2) r = hamBits === 4 ? c : c | (r & 3);
                else g = hamBits === 4 ? c : c | (g & 3);
                rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl;
                rgba[o + 3] = 255;
            } else {
                if (cmap && !lines && v >= (ehb ? 64 : cmapColors)) badIndex = true;
                const c = color(v);
                rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
                rgba[o + 3] = masking === 2 && v === transparent ? 0 : 255;
            }
            if (hasMask && !((data[maskRow + (x >> 3)] >> (7 - (x & 7))) & 1)) rgba[o + 3] = 0;
        }
    }

    const kind = deep ? `${planes}-bit ${planes === 32 ? 'RGBA' : 'RGB'}`
        : ham ? `HAM${hamBits + 2}${planes !== hamBits + 2 ? ` (${planes} planes)` : ''}`
            : ehb ? 'Extra Half-Brite (64 colors)'
                : type === 'PBM' ? `${planes}-bit chunky, ${count} colors` : `${planes} plane${planes > 1 ? 's' : ''}, ${count} colors`;
    const label = [
        `IFF ${type}, ${kind}`,
        compression ? 'ByteRun1' : '',
        lines ? linesKind : '',
        hasMask ? 'mask plane' : masking === 2 ? `color ${transparent} transparent` : '',
        fourBit ? '4-bit palette' : '',
        !cmap && !deep ? 'no palette (gray)' : '',
        xAspect !== yAspect ? `pixels ${xAspect}:${yAspect}` : '',
        badIndex ? 'pixels past the palette\'s end shown black' : '',
    ].filter(Boolean).join(', ');
    return { width, height, rgba, aspect: xAspect / yAspect, label };
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

// The IFF picture at url: { url (a blob: URL of its PNG), aspect (a pixel's
// width over its height), pages: [{ width, height, label }] }
function ilbmImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = ilbmDecode(new Uint8Array(await resp.arrayBuffer()));
            const png = await rgbaToPng(r.rgba, r.width, r.height);
            return { url: URL.createObjectURL(png), aspect: r.aspect, pages: [{ width: r.width, height: r.height, label: r.label }] };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('IFF picture decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Whether the file at url starts like an IFF picture
async function isIlbmUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isIlbm(value);
}

// Show non-square pixels as such: the <img> narrowed (or flattened) by their
// aspect, never grown past the room it has
function applyPixelAspect(img, aspect) {
    if (!aspect || Math.abs(aspect - 1) < 0.02) return;
    img.style.transform = aspect < 1 ? `scaleX(${aspect})` : `scaleY(${1 / aspect})`;
}

module.exports = { isIlbmName, isIlbmMaybeName, isIlbm, isIlbmUrl, ilbmDecode, ilbmImage, applyPixelAspect };
