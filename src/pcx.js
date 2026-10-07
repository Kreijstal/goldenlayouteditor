// --- ZSoft PCX (.pcx) and multi-page DCX (.dcx) ---
// No browser shows PCX. The format is a 128-byte header and run-length encoded
// scanlines, each holding its color planes one after another, so it is read
// here: 1, 2, 4 and 8 bits a plane, packed (one plane) or planar (EGA's four
// 1-bit planes, or two, three...), and 8-bit RGB (three planes) and RGBA (four).
// Colors come from:
//   - 1 bit in one plane: black and white, as PC Paintbrush and ImageMagick
//     show it (the header palette is junk in most such files);
//   - up to 16 colors: the header's 16-entry palette, or the standard EGA one
//     for version 0 and 3 files (which have none) and all-zero palettes;
//   - CGA 4-color files (2 bits in one plane whose header holds only the CGA
//     settings): the background color and palette/intensity bits, the old
//     way (PaletteInfo 0: bits of byte 19) or PC Paintbrush IV's (green vs.
//     blue of the second entry), as moddingwiki.shikadi.net's PCX page says;
//   - 256 colors: the VGA palette after the pixels (a 0x0C byte and 768 bytes),
//     grays if there is none.
// A DCX (a fax program's multi-page PCX) is a magic number and a table of up to
// 1023 offsets to PCX images: each is a page, turned with the TIFF viewer's
// page buttons. A page becomes a PNG an <img> shows.
const { createLogger } = require('./debug');

const log = createLogger('PCX');
const PCX_RE = /\.(pcx|dcx)$/i;
const DCX_MAGIC = 987654321; // b1 68 de 3a
// as in src/qoi.js, to keep a hostile header from asking for gigabytes
const MAX_PIXELS = 400000000;
const VERSIONS = { 0: 'v2.5', 2: 'v2.8', 3: 'v2.8, no palette', 4: 'Paintbrush for Windows', 5: 'v3.0+' };

// The 16 CGA/EGA text colors, the default EGA palette
const EGA = [
    [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170], [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
    [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255], [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
];
// CGA 320x200 foreground colors 1-3 (EGA indices) for palettes 0, 1 and 2
// (2: color burst off), dim; intensity adds 8
const CGA = [[2, 4, 6], [3, 5, 7], [3, 4, 7]];

const files = new Map(); // source URL -> Promise<{ bytes, pages }>
const decoded = new Map(); // source URL + '#' + page -> Promise<{ url, pages, page }>

function isPcxName(name) {
    return PCX_RE.test(name || '');
}

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

// The 128-byte header at pos, or null if it isn't a PCX's
function readHeader(bytes, pos) {
    if (pos + 128 > bytes.length || bytes[pos] !== 0x0A || bytes[pos + 2] > 1) return null;
    const h = {
        version: bytes[pos + 1],
        encoding: bytes[pos + 2],
        bits: bytes[pos + 3],
        width: u16(bytes, pos + 8) - u16(bytes, pos + 4) + 1,
        height: u16(bytes, pos + 10) - u16(bytes, pos + 6) + 1,
        palette: bytes.subarray(pos + 16, pos + 64),
        planes: bytes[pos + 65],
        bytesPerLine: u16(bytes, pos + 66),
        paletteInfo: u16(bytes, pos + 68),
    };
    if (![1, 2, 4, 8].includes(h.bits) || h.planes < 1 || h.planes > 4) return null;
    if (h.width < 1 || h.height < 1) return null;
    // the header's count wins (rows may be padded), unless it is too small to hold a row
    const minLine = Math.ceil(h.width * h.bits / 8);
    if (h.bytesPerLine < minLine) h.bytesPerLine = minLine + (minLine & 1);
    return h;
}

// The PCX images in the file: [{ start, end }], one for a PCX, a DCX's pages
function pcxPages(bytes) {
    if (bytes.length >= 8 && u32(bytes, 0) === DCX_MAGIC) {
        const offsets = [];
        for (let p = 4; p + 4 <= bytes.length && offsets.length < 1023; p += 4) {
            const off = u32(bytes, p);
            if (!off) break;
            if (readHeader(bytes, off)) offsets.push(off);
        }
        if (!offsets.length) throw new Error('DCX file has no PCX pages');
        // a page ends where the next one (by position) starts: its VGA palette is just before
        const sorted = [...new Set(offsets)].sort((a, b) => a - b);
        return offsets.map(start => ({ start, end: sorted.find(o => o > start) || bytes.length }));
    }
    if (!readHeader(bytes, 0)) throw new Error('Not a PCX image (bad header)');
    return [{ start: 0, end: bytes.length }];
}

// The scanlines, decompressed: { data (height * planes * bytesPerLine bytes,
// zero where the file was cut short), pos (where the pixels ended) }
function decompress(bytes, h, start, end) {
    const lineBytes = h.bytesPerLine * h.planes;
    const data = new Uint8Array(lineBytes * h.height);
    let p = start;
    if (!h.encoding) {
        const n = Math.min(data.length, end - p);
        data.set(bytes.subarray(p, p + n));
        return { data, pos: p + n };
    }
    // one stream for the whole image: runs should stop at each row's end, but
    // some writers let them go on into the next, which this reads too
    let o = 0;
    while (o < data.length && p < end) {
        const c = bytes[p++];
        if ((c & 0xC0) === 0xC0) {
            const count = c & 0x3F; // 0xC0, a run of none, skips its byte
            if (p >= end) break;
            const v = bytes[p++];
            const n = Math.min(count, data.length - o);
            data.fill(v, o, o + n);
            o += n;
        } else {
            data[o++] = c;
        }
    }
    return { data, pos: p };
}

// A palette of n [r, g, b] entries from bytes
function rgbList(bytes, n) {
    const list = [];
    for (let i = 0; i < n; i++) list.push([bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]]);
    return list;
}

// A CGA 4-color file's palette, or null if the header holds a real one: the
// CGA settings fill just the first two entries, the rest is zero
function cgaPalette(h) {
    const pal = h.palette;
    if (pal.subarray(6, 12).some(v => v)) return null;
    let which, bright;
    if (!h.paletteInfo) {
        // before PC Paintbrush IV: color burst, palette and intensity bits
        const bits = pal[3];
        which = bits & 0x80 ? 2 : (bits & 0x40 ? 1 : 0);
        bright = !!(bits & 0x20);
    } else {
        // PC Paintbrush IV and later: from the green and blue of entry 1
        which = pal[4] > pal[5] ? 0 : 1;
        bright = Math.max(pal[4], pal[5]) > 200;
    }
    const colors = [EGA[pal[0] >> 4]];
    for (const i of CGA[which]) colors.push(EGA[i + (bright ? 8 : 0)]);
    const label = `CGA palette ${which}${bright ? ', bright' : ''}, background ${pal[0] >> 4}`;
    return { colors, label };
}

// The VGA palette after the pixels: at the end of the page, or right where the
// pixels end; null if there is none
function vgaPalette(bytes, start, end, pos) {
    if (end - 769 >= start + 128 && bytes[end - 769] === 0x0C) return rgbList(bytes.subarray(end - 768, end), 256);
    if (pos + 769 <= end && bytes[pos] === 0x0C) return rgbList(bytes.subarray(pos + 1, pos + 769), 256);
    return null;
}

// The PCX image at bytes[start..end): { width, height, rgba, label }
function pcxDecode(bytes, start = 0, end = bytes.length) {
    const h = readHeader(bytes, start);
    if (!h) throw new Error('Not a PCX image (bad header)');
    const { width, height, bits, planes, bytesPerLine } = h;
    if (width * height > MAX_PIXELS) throw new Error(`PCX image too large (${width}x${height})`);
    const depth = bits * planes;
    if (bits === 8 && planes === 2) throw new Error('PCX with two 8-bit planes is not supported');
    // a 256-color image's palette ends the page: the pixels stop before it,
    // even in a file cut short in its pixels and its palette added after
    const rgb = bits === 8 && planes >= 3;
    const paletteEnd = !rgb && depth > 4 && end - 769 >= start + 128 && bytes[end - 769] === 0x0C;
    const { data, pos } = decompress(bytes, h, start + 128, paletteEnd ? end - 769 : end);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const lineBytes = bytesPerLine * planes;
    let kind;

    if (rgb) {
        // RGB(A): a row of red, one of green, one of blue (one of alpha)
        let opaque = planes === 3;
        if (!opaque) {
            // alpha that is zero everywhere was never meant: shown opaque
            opaque = true;
            for (let y = 0; y < height && opaque; y++) {
                const row = y * lineBytes + 3 * bytesPerLine;
                for (let x = 0; x < width; x++) if (data[row + x]) { opaque = false; break; }
            }
        }
        for (let y = 0, o = 0; y < height; y++) {
            const row = y * lineBytes;
            for (let x = 0; x < width; x++, o += 4) {
                rgba[o] = data[row + x];
                rgba[o + 1] = data[row + bytesPerLine + x];
                rgba[o + 2] = data[row + 2 * bytesPerLine + x];
                rgba[o + 3] = opaque ? 255 : data[row + 3 * bytesPerLine + x];
            }
        }
        kind = planes === 3 ? '24-bit RGB' : '32-bit RGBA';
    } else {
        // indexed: each plane gives `bits` bits of the index, plane 0 the lowest
        let colors;
        if (depth === 1) {
            colors = [[0, 0, 0], [255, 255, 255]];
            kind = 'monochrome';
        } else if (depth <= 4) {
            const cga = bits === 2 && planes === 1 ? cgaPalette(h) : null;
            if (cga) {
                colors = cga.colors;
                kind = cga.label;
            } else if (h.version === 0 || h.version === 3 || !h.palette.some(v => v)) {
                colors = EGA;
                kind = `${1 << depth} colors, EGA palette`;
            } else {
                colors = rgbList(h.palette, 16);
                kind = `${1 << depth} colors`;
            }
        } else {
            colors = vgaPalette(bytes, start, end, pos);
            if (colors) kind = `${1 << depth} colors, VGA palette`;
            else {
                // no palette: grays
                colors = [];
                const max = (1 << depth) - 1;
                for (let i = 0; i <= max; i++) { const v = Math.round(i * 255 / max); colors.push([v, v, v]); }
                kind = 'grayscale';
            }
        }
        const mask = (1 << bits) - 1;
        for (let y = 0, o = 0; y < height; y++) {
            const row = y * lineBytes;
            for (let x = 0; x < width; x++, o += 4) {
                let index = 0;
                if (bits === 8) index = data[row + x];
                else {
                    const bit = x * bits;
                    const shift = 8 - bits - (bit & 7);
                    for (let p = 0; p < planes; p++) index |= ((data[row + p * bytesPerLine + (bit >> 3)] >> shift) & mask) << (p * bits);
                }
                const c = colors[index] || EGA[0];
                rgba[o] = c[0];
                rgba[o + 1] = c[1];
                rgba[o + 2] = c[2];
                rgba[o + 3] = 255;
            }
        }
        kind += planes > 1 ? `, ${planes} planes of ${bits} bit${bits > 1 ? 's' : ''}` : `, ${bits} bit${bits > 1 ? 's' : ''} a pixel`;
    }
    const label = `PCX ${VERSIONS[h.version] || 'version ' + h.version}, ${kind}${h.encoding ? '' : ', uncompressed'}`;
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

function filePages(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            return { bytes, pages: pcxPages(bytes) };
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: a page turn reads the file again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// Page `page` of the PCX/DCX file at url: { url (a blob: URL of its PNG),
// pages: [{ width, height, label }], page }
function pcxPage(url, page = 0) {
    const key = url + '#' + page;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            const { bytes, pages } = await filePages(url);
            const n = Math.max(0, Math.min(pages.length - 1, page));
            const r = pcxDecode(bytes, pages[n].start, pages[n].end);
            const png = await rgbaToPng(r.rgba, r.width, r.height);
            const list = pages.map(({ start }, i) => {
                if (i === n) return { width: r.width, height: r.height, label: r.label };
                const h = readHeader(bytes, start);
                return { width: h.width, height: h.height, label: `PCX, ${h.bits * h.planes}-bit` };
            });
            return { url: URL.createObjectURL(png), pages: list, page: n };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('PCX decode failed:', err); });
        if (decoded.size > 64) {
            const [oldKey, old] = decoded.entries().next().value;
            decoded.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isPcxName, pcxPages, pcxDecode, pcxPage };
