// --- GEM raster images (.ximg, .timg; an .img that is one) ---
// Digital Research's GEM VDI bit image: GEM Paint's, Ventura Publisher's and
// the Atari ST's. No browser shows it, so it is read here. A big-endian
// header of words: version, header length, planes, pattern length, a pixel's
// width and height in microns, the width and height, maybe more; then each
// row's planes one after another, each coded as solid runs (a byte: the top
// bit black or white, the rest the count of bytes), pattern runs (0, n, then
// n copies of the pattern), bit strings (0x80, n, n bytes as they are) and,
// before a row, a scanline run (0, 0, 0xFF, n: the row n times). Colors and
// depths are what the header says beyond its first eight words:
//   - XIMG ("XIMG" at 16): an RGB palette of 0..1000 per component for 1 to 8
//     planes; 16 (RGB 5:6:5), 24 (R G B) and 32 bits (x R G B) are bytes, not planes
//   - TIMG ("TIMG", NVDI's true color): 15 planes, red the lowest five
//   - STTT ("STTT"): the Atari ST's palette words for 4 planes
//   - Hyperpaint's (25 words, the ST's palette at 18) and 9 + 2^planes words, the same
//   - 9 words: the ninth 0 means the default colors, 1 grays, and 3 a 24-plane
//     picture whose counts are of 3 bytes (as FFmpeg reads it)
//   - none: black and white for 1 plane, the 16 VDI colors (as FFmpeg and the
//     Encyclopedia of Graphics File Formats have them) for 2 to 4, grays for
//     more (8 planes: the bits of the gray reversed, as FFmpeg and deark read
//     it), RGB 5:6:5 and R G B bytes for 16 and 24
// The pixel's size is kept for the viewer (the ST's medium resolution has
// tall ones). A plane's row ends with the code that fills it, the rest of a
// run too long dropped (as deark reads it), but for Snapper's version 3 files
// and the 24 planes counted by 3 bytes, whose codes run on into the next plane
// (as FFmpeg reads every file); with FFmpeg, a scanline run may come anywhere,
// 0, 0, n (n ≠ 0xFF) leaves n + 1 bytes as the row before had them and a bit
// string of 0 bytes is 256. .img is also a disk image's name (and VICAR's):
// one is GEM only if its header holds up and the file's size fits it (isGem).
const { createLogger } = require('./debug');

const log = createLogger('GEM');
const GEM_RE = /\.(ximg|timg)$/i;
// the name a GEM image shares with disk images and VICAR's
const MAYBE_RE = /\.img$/i;
// to keep a hostile header from asking for gigabytes
const MAX_PIXELS = 400000000;

// The 16 VDI colors, white first, black last (FFmpeg's)
const VDI_COLORS = [
    0xFFFFFF, 0xFF0000, 0x00FF00, 0xFFFF00, 0x0000FF, 0xFF00FF, 0x00FFFF, 0xAEAEAE,
    0x555555, 0xAE0000, 0x00AE00, 0xAEAE00, 0x0000AE, 0xAE00AE, 0x00AEAE, 0x000000,
];
// ...and 8 for 3 planes with 9 header words (Image Alchemy's, as deark has them)
const COLORS_3 = [0xFFFFFF, 0x00FFFF, 0xFF00FF, 0xFFFF00, 0x0000FF, 0x00FF00, 0xFF0000, 0x000000];

const decoded = new Map(); // source URL -> Promise<{ url, aspect, width, height, label }>

// Whether the name is one only GEM images go by (an .img is one only once
// its bytes say so, see isGemMaybeName)
function isGemName(name) {
    return GEM_RE.test(name || '');
}

// A name a GEM image shares with other files (.img: disk images, VICAR)
function isGemMaybeName(name) {
    return MAYBE_RE.test(name || '');
}

// The header, or null if these bytes don't start one that holds up: version 0
// to 3, a header of 8 words or more (an XIMG's palette makes 11 + 3·2^planes),
// a depth GEM has, a pattern of 1 to 8 bytes, a size; tag is "XIMG", "TIMG"
// or "STTT" if the header names one
function readHeader(bytes) {
    if (!bytes || bytes.length < 16) return null;
    const w = i => (bytes[2 * i] << 8) | bytes[2 * i + 1];
    const h = {
        version: w(0), words: w(1), planes: w(2), patternLength: w(3),
        pixelWidth: w(4), pixelHeight: w(5), width: w(6), height: w(7), tag: '', ext: -1,
    };
    if (h.version > 3) return null;
    if (h.words < 8 || (h.words > 59 && ![107, 203, 395, 779].includes(h.words))) return null;
    if (!((h.planes >= 1 && h.planes <= 8) || [15, 16, 24, 32].includes(h.planes))) return null;
    if (h.patternLength < 1 || h.patternLength > 8) return null;
    if (!h.width || !h.height) return null;
    if (h.words >= 9 && bytes.length >= 18) h.ext = w(8);
    if (h.words >= 10 && bytes.length >= 20) {
        const tag = String.fromCharCode(...bytes.subarray(16, 20));
        if (tag === 'XIMG' || tag === 'TIMG' || tag === 'STTT') h.tag = tag;
    }
    return h;
}

// How the rows are laid out: { planar (bit planes, else bytes), planes (or 1
// for bytes), rowBytes (a plane's), scale (bytes a count counts), pixel
// (how a pixel is made of them), palette }
function layout(bytes, h) {
    const { planes, width, words, tag, ext } = h;
    const planeBytes = Math.ceil(width / 8);
    const bits = (pixel, n = planes) => ({ planar: true, planes: n, rowBytes: planeBytes, scale: 1, pixel });
    const chunky = (pixel, rowBytes) => ({ planar: false, planes: 1, rowBytes, scale: 1, pixel });
    const u16 = p => (bytes[p] << 8) | bytes[p + 1];
    // the Atari ST's palette words (3 bits a component, the STE's 4 if their extra bits are used)
    const atari = (p, n) => {
        const words = [];
        for (let i = 0; i < n && p + 2 * i + 1 < bytes.length; i++) words.push(u16(p + 2 * i));
        const ste = words.some(v => v & 0x0888) && !words.some(v => v & 0xF000);
        const c = n4 => (ste ? (((n4 & 7) << 1) | ((n4 >> 3) & 1)) * 17 : Math.round((n4 & 7) * 255 / 7));
        return words.map(v => (c(v >> 8) << 16) | (c(v >> 4) << 8) | c(v));
    };
    const grays = n => Array.from({ length: n }, (_, i) => 0x10101 * (255 - Math.round(i * 255 / (n - 1))));
    // 8 planes of gray: the index's bits reversed, white at 0
    const reversedGrays = () => Array.from({ length: 256 }, (_, i) => {
        let v = 255 - i, r = 0;
        for (let b = 0; b < 8; b++) { r = (r << 1) | (v & 1); v >>= 1; }
        return 0x10101 * r;
    });

    if (tag === 'XIMG') {
        if (planes <= 8) {
            // RGB in 0..1000, as many entries as the header holds
            const n = Math.min(1 << planes, Math.floor((words * 2 - 22) / 6));
            const s = v => Math.round(Math.min(1000, v) * 255 / 1000);
            const palette = [];
            for (let i = 0; i < n; i++) palette.push((s(u16(22 + 6 * i)) << 16) | (s(u16(24 + 6 * i)) << 8) | s(u16(26 + 6 * i)));
            if (!n) return { ...bits('index'), palette: planes === 1 ? [0xFFFFFF, 0] : planes === 8 ? reversedGrays() : VDI_COLORS, kind: 'XIMG, no palette' };
            if (u16(20)) log.warn(`XIMG color model ${u16(20)} read as RGB`);
            return { ...bits('index'), palette, kind: 'XIMG' };
        }
        if (planes === 16) return { ...chunky('rgb565', Math.ceil(width / 8) * 8 * 2), kind: 'XIMG' };
        if (planes === 24) return { ...chunky('rgb', Math.ceil(width / 16) * 16 * 3), kind: 'XIMG' };
        if (planes === 32) return { ...chunky('xrgb', width * 4), kind: 'XIMG' };
        throw new Error(`An XIMG of ${planes} planes isn't supported (1 to 8, 16, 24 and 32 are)`);
    }
    if (tag === 'TIMG' || planes === 15) {
        if (planes !== 15) throw new Error(`A TIMG of ${planes} planes isn't supported (15 is)`);
        return { ...bits('rgb555'), kind: tag || 'true color' };
    }
    if (tag === 'STTT') {
        if (planes > 8) throw new Error(`An STTT image of ${planes} planes isn't supported`);
        return { ...bits('index'), palette: atari(22, 1 << planes), kind: 'STTT' };
    }
    if (words === 9 && ext === 3) {
        // B G R bytes, counts of 3 bytes (a pixel's)
        return { ...chunky('bgr', width * 3), scale: 3, kind: 'counts of pixels' };
    }
    if (planes === 16) return { ...chunky('rgb565', width * 2), kind: '' };
    if (planes === 24) return { ...chunky('rgb', width * 3), kind: '' };
    if (planes === 32) return { ...chunky('xrgb', width * 4), kind: '' };
    if (planes > 1 && planes <= 4 && (words === 9 + (1 << planes) || (words === 25 && ext === 0x80))) {
        return { ...bits('index'), palette: atari(18, 1 << planes), kind: words === 25 ? 'Hyperpaint' : 'Atari palette' };
    }
    if (planes === 1 && words === 25 && ext === 0x80) {
        // Hyperpaint's two colors, unless they're the same (no palette, then)
        const palette = atari(18, 2);
        return { ...bits('index'), palette: palette[0] === palette[1] ? [0xFFFFFF, 0] : palette, kind: 'Hyperpaint' };
    }
    if (planes === 1) return { ...bits('index'), palette: [0xFFFFFF, 0], kind: '' };
    if (words === 9 && ext === 0 && planes === 3) return { ...bits('index'), palette: COLORS_3, kind: 'default colors' };
    if (words === 9 && ext !== 0) return { ...bits('index'), palette: planes === 8 ? reversedGrays() : grays(1 << planes), kind: 'gray' };
    if (planes <= 4) return { ...bits('index'), palette: VDI_COLORS, kind: 'VDI colors' };
    if (planes === 8) return { ...bits('index'), palette: reversedGrays(), kind: 'gray' };
    return { ...bits('index'), palette: grays(1 << planes), kind: 'gray' };
}

// Bytes (and the file's size, if more than them) that are a GEM image: a
// header that holds up (readHeader) and a file no longer than its pixels
// could be coded in (a bit string's 2 bytes for 255, a scanline run's 4 a
// row), give or take a little at the end
function isGem(bytes, size = bytes ? bytes.length : 0) {
    const h = readHeader(bytes);
    if (!h || size <= h.words * 2) return false;
    if (h.width * h.height > MAX_PIXELS) return false;
    let lay;
    try { lay = layout(bytes, h); } catch (_) { return true; } // a variant not read, still GEM's
    const raw = lay.rowBytes * lay.planes * h.height;
    return size <= h.words * 2 + Math.ceil(raw * 257 / 255) + 4 * h.height * (lay.planes + 1) + 4096;
}

// Whether the file at url is a GEM image (for an .img)
async function isGemUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    const size = Number(resp.headers.get('Content-Length')) || 0;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isGem(value, Math.max(size, value.length));
}

// { width, height, rgba, aspect (a pixel's width over its height), label }
function gemDecode(bytes) {
    const h = readHeader(bytes);
    if (!h) throw new Error('Not a GEM image (no header that holds up)');
    const { width, height } = h;
    if (width * height > MAX_PIXELS) throw new Error(`GEM image too large (${width}x${height})`);
    const lay = layout(bytes, h);
    const { planes, rowBytes, scale } = lay;
    const patternLength = h.patternLength;

    // the rows, each its planes one after another
    const lineBytes = rowBytes * planes;
    const data = new Uint8Array(lineBytes * height);
    // the row being read (what a skip leaves is the row before's)
    const row = new Uint8Array(lineBytes);
    let y = 0, plane = 0, x = 0, repeat = 1, done = false;
    const end = () => {
        x = 0;
        if (++plane < planes) return;
        for (let i = 0; i < repeat && y + i < height; i++) data.set(row, (y + i) * lineBytes);
        y += repeat;
        plane = 0;
        repeat = 1;
        if (y >= height) done = true;
    };
    // a plane's row ends with the code that fills it, and what a code puts past
    // its end is dropped (as deark has it: some writers' last run is too long);
    // version 3 (Snapper's screenshots) codes the rows as one stream, a run going
    // on into the next plane or row (as FFmpeg reads every file), and so do the
    // 24 planes whose counts are of 3 bytes
    const stream = h.version === 3 || scale > 1;
    const put = v => {
        if (x < rowBytes) row[plane * rowBytes + x] = v;
        if (++x >= rowBytes && stream) end();
    };
    const skip = () => { if (++x >= rowBytes && stream) end(); };
    let p = h.words * 2;
    const n = bytes.length;
    let shortData = false;
    while (p < n && !done) {
        if (x >= rowBytes) { end(); if (done) break; }
        const op = bytes[p++];
        if (op === 0x80) {
            // a bit string
            if (p >= n) break;
            const count = (bytes[p++] || 256) * scale;
            for (let i = 0; i < count; i++) {
                if (p >= n) { shortData = true; break; }
                put(bytes[p++]);
            }
        } else if (op) {
            // a solid run
            const count = (op & 0x7F) * scale, v = op & 0x80 ? 0xFF : 0;
            for (let i = 0; i < count; i++) put(v);
        } else {
            if (p >= n) break;
            const count = bytes[p++];
            if (count) {
                // a pattern run
                if (p + patternLength > n) break;
                for (let i = 0; i < count * scale; i++) {
                    for (let k = 0; k < patternLength; k++) put(bytes[p + k]);
                }
                p += patternLength;
            } else {
                if (p >= n) break;
                const flag = bytes[p++];
                if (flag === 0xFF) {
                    // a scanline run: the row that follows, n times
                    if (p >= n) break;
                    repeat = bytes[p++] || 256;
                } else {
                    // bytes left as they were
                    for (let i = 0; i <= flag; i++) skip();
                }
            }
        }
    }
    if (!done && x >= rowBytes) end();
    if (y < height) shortData = true;

    const rgba = new Uint8ClampedArray(width * height * 4);
    const { pixel, palette } = lay;
    for (let yy = 0; yy < height; yy++) {
        const line = yy * lineBytes;
        for (let xx = 0, o = yy * width * 4; xx < width; xx++, o += 4) {
            let r, g, b;
            if (lay.planar) {
                const byte = line + (xx >> 3), bit = 7 - (xx & 7);
                let v = 0;
                for (let pl = 0; pl < planes; pl++) v |= ((data[byte + pl * rowBytes] >> bit) & 1) << pl;
                if (pixel === 'index') {
                    const c = palette[v] !== undefined ? palette[v] : 0;
                    r = c >> 16; g = (c >> 8) & 0xFF; b = c & 0xFF;
                } else {
                    // 'rgb555': red the lowest five planes
                    r = v & 31; g = (v >> 5) & 31; b = (v >> 10) & 31;
                    r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2);
                }
            } else if (pixel === 'rgb565') {
                const v = (data[line + 2 * xx] << 8) | data[line + 2 * xx + 1];
                r = v >> 11; g = (v >> 5) & 63; b = v & 31;
                r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2);
            } else if (pixel === 'rgb') {
                r = data[line + 3 * xx]; g = data[line + 3 * xx + 1]; b = data[line + 3 * xx + 2];
            } else if (pixel === 'bgr') {
                b = data[line + 3 * xx]; g = data[line + 3 * xx + 1]; r = data[line + 3 * xx + 2];
            } else {
                r = data[line + 4 * xx + 1]; g = data[line + 4 * xx + 2]; b = data[line + 4 * xx + 3];
            }
            rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
        }
    }

    // a pixel's size, if it's one (some write 0, or 1 by 1)
    const { pixelWidth: pw, pixelHeight: ph } = h;
    const aspect = pw > 1 && ph > 1 && pw / ph < 4 && ph / pw < 4 ? pw / ph : 1;
    const depth = lay.pixel === 'index' ? `${h.planes} plane${h.planes > 1 ? 's' : ''}`
        : lay.pixel === 'bgr' ? '24-bit BGR' : lay.pixel === 'rgb555' ? '15 planes (RGB 5:5:5)'
            : lay.pixel === 'rgb565' ? '16-bit RGB 5:6:5' : lay.pixel === 'rgb' ? '24-bit RGB' : '32-bit RGB';
    const label = [
        `GEM raster image, version ${h.version}${lay.kind ? `, ${lay.kind}` : ''}`, depth,
        lay.palette && lay.pixel === 'index' && h.planes > 1 ? `${Math.min(lay.palette.length, 1 << h.planes)} colors` : '',
        Math.abs(aspect - 1) > 0.02 ? `pixels ${pw}×${ph} µm` : '',
        shortData ? `cut short at row ${Math.min(y, height)} of ${height}` : '',
    ].filter(Boolean).join(', ');
    return { width, height, rgba, aspect, label };
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

// The GEM image at url: { url (a blob: URL of its PNG), aspect, width, height, label }
function gemImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = gemDecode(new Uint8Array(await resp.arrayBuffer()));
            const png = await rgbaToPng(r.rgba, r.width, r.height);
            return { url: URL.createObjectURL(png), aspect: r.aspect, width: r.width, height: r.height, label: r.label };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('GEM image decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isGemName, isGemMaybeName, isGem, isGemUrl, readHeader, gemDecode, gemImage };
