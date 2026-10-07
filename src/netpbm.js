// --- Netpbm (.pbm, .pgm, .ppm, .pnm, .pam) ---
// No browser shows Netpbm. The format is simple enough to read here: PBM, PGM
// and PPM, plain (P1-P3, ASCII) and raw (P4-P6), maxval up to 65535, and PAM
// (P7) with any tuple type (BLACKANDWHITE, GRAYSCALE, RGB, their _ALPHA forms,
// CMYK; an unknown one by its depth). A file may hold several images one after
// another (pnmcat's input, a video's frames from ppmtompeg): each is a page,
// turned with the TIFF viewer's page buttons. A page becomes a PNG an <img>
// shows; 16-bit samples are cut to 8.
const { createLogger } = require('./debug');

const log = createLogger('Netpbm');
const NETPBM_RE = /\.(pbm|pgm|ppm|pnm|pam)$/i;
const KINDS = { 1: 'PBM', 2: 'PGM', 3: 'PPM', 4: 'PBM', 5: 'PGM', 6: 'PPM', 7: 'PAM' };

const files = new Map(); // source URL -> Promise<{ bytes, images }>
const decoded = new Map(); // source URL + '#' + page -> Promise<{ url, pages, page }>

function isNetpbmName(name) {
    return NETPBM_RE.test(name || '');
}

const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
const isDigit = c => c >= 48 && c <= 57;

// Reads the bytes from pos on: whitespace and '#' comments skipped
class Reader {
    constructor(bytes, pos = 0) {
        this.bytes = bytes;
        this.pos = pos;
    }
    skip() {
        const b = this.bytes;
        while (this.pos < b.length) {
            const c = b[this.pos];
            if (c === 35) { // '#' to the end of the line
                while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
            } else if (isSpace(c)) this.pos++;
            else break;
        }
    }
    int() {
        this.skip();
        const b = this.bytes;
        if (this.pos >= b.length || !isDigit(b[this.pos])) throw new Error(`number expected at byte ${this.pos}`);
        let n = 0;
        while (this.pos < b.length && isDigit(b[this.pos])) n = n * 10 + b[this.pos++] - 48;
        return n;
    }
    // a PAM header line, without its newline
    line() {
        const b = this.bytes;
        const start = this.pos;
        while (this.pos < b.length && b[this.pos] !== 10) this.pos++;
        const s = new TextDecoder('latin1').decode(b.subarray(start, this.pos));
        this.pos++;
        return s.replace(/\r$/, '');
    }
}

// One image's header at pos: { format (1..7), width, height, depth, maxval,
// tupltype, start (of its samples) }
function readHeader(bytes, pos) {
    if (bytes[pos] !== 80 || bytes[pos + 1] < 49 || bytes[pos + 1] > 55) throw new Error('not a Netpbm image');
    const format = bytes[pos + 1] - 48;
    const r = new Reader(bytes, pos + 2);
    if (format === 7) {
        const h = { format, width: 0, height: 0, depth: 0, maxval: 0, tupltype: '' };
        r.line(); // rest of the "P7" line
        for (;;) {
            if (r.pos >= bytes.length) throw new Error('PAM header has no ENDHDR');
            const line = r.line().trim();
            if (!line || line[0] === '#') continue;
            const [key, ...rest] = line.split(/\s+/);
            const value = rest.join(' ');
            if (key === 'ENDHDR') break;
            if (key === 'WIDTH') h.width = parseInt(value, 10);
            else if (key === 'HEIGHT') h.height = parseInt(value, 10);
            else if (key === 'DEPTH') h.depth = parseInt(value, 10);
            else if (key === 'MAXVAL') h.maxval = parseInt(value, 10);
            else if (key === 'TUPLTYPE') h.tupltype = h.tupltype ? h.tupltype + ' ' + value : value;
        }
        if (!(h.width > 0 && h.height > 0 && h.depth > 0 && h.maxval > 0 && h.maxval <= 65535)) throw new Error('bad PAM header');
        h.start = r.pos;
        return h;
    }
    const width = r.int();
    const height = r.int();
    const pbm = format === 1 || format === 4;
    const maxval = pbm ? 1 : r.int();
    if (!(width > 0 && height > 0 && maxval > 0 && maxval <= 65535)) throw new Error('bad Netpbm header');
    // raw samples start after exactly one whitespace; plain ones are tokens anyway
    const start = format >= 4 ? r.pos + 1 : r.pos;
    const depth = format === 3 || format === 6 ? 3 : 1;
    return { format, width, height, depth, maxval, tupltype: '', start };
}

// Where an image's samples end (the next image may start there)
function sampleEnd(bytes, h) {
    if (h.format === 4) return h.start + Math.ceil(h.width / 8) * h.height;
    if (h.format >= 5) return h.start + h.width * h.height * h.depth * (h.maxval > 255 ? 2 : 1);
    const r = new Reader(bytes, h.start);
    let count = h.width * h.height * h.depth;
    if (h.format === 1) {
        // PBM digits needn't be separated: "0110" is four pixels
        while (count > 0) {
            r.skip();
            if (r.pos >= bytes.length) break;
            r.pos++;
            count--;
        }
        return r.pos;
    }
    while (count-- > 0 && r.pos < bytes.length) {
        r.skip();
        if (r.pos >= bytes.length) break;
        r.int();
    }
    return r.pos;
}

// Every image in the file, in order
function netpbmImages(bytes) {
    const images = [];
    let pos = 0;
    for (;;) {
        while (pos < bytes.length && isSpace(bytes[pos])) pos++;
        if (pos >= bytes.length - 1 || bytes[pos] !== 80) break;
        let h;
        try {
            h = readHeader(bytes, pos);
        } catch (err) {
            if (!images.length) throw err;
            break; // trailing junk after the last image
        }
        h.end = sampleEnd(bytes, h);
        images.push(h);
        if (h.end > bytes.length) break; // truncated: shown as far as it goes
        pos = h.end;
    }
    if (!images.length) throw new Error('not a Netpbm image');
    return images;
}

// What the tuples are: 'gray' (PAM's BLACKANDWHITE too: its 1 is white), 'rgb'
// or 'cmyk', with or without alpha
function layout(h) {
    if (h.format !== 7) return { color: h.depth === 3 ? 'rgb' : 'gray', alpha: false };
    const t = h.tupltype.toUpperCase();
    if (t === 'CMYK' && h.depth >= 4) return { color: 'cmyk', alpha: h.depth >= 5 };
    if (t.startsWith('RGB') && h.depth >= 3) return { color: 'rgb', alpha: t === 'RGB_ALPHA' && h.depth >= 4 };
    if ((t.startsWith('GRAYSCALE') || t.startsWith('BLACKANDWHITE')) && h.depth >= 1)
        return { color: 'gray', alpha: t.endsWith('_ALPHA') && h.depth >= 2 };
    // an unknown tuple type, by its depth
    if (h.depth >= 3) return { color: 'rgb', alpha: h.depth >= 4 };
    return { color: 'gray', alpha: h.depth === 2 };
}

// The image's samples, scaled to 0..255, as RGBA
function netpbmRgba(bytes, h) {
    const { width, height, depth, maxval, format } = h;
    const n = width * height;
    const out = new Uint8ClampedArray(n * 4);
    // samples, row by row, depth per pixel, as numbers 0..maxval
    const samples = new (maxval > 255 ? Uint16Array : Uint8Array)(n * depth);
    if (format === 4) {
        const rowBytes = Math.ceil(width / 8);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const byte = bytes[h.start + y * rowBytes + (x >> 3)] || 0;
                samples[y * width + x] = (byte >> (7 - (x & 7))) & 1;
            }
        }
    } else if (format >= 5) {
        const total = Math.min(n * depth, Math.floor((bytes.length - h.start) / (maxval > 255 ? 2 : 1)));
        if (maxval > 255) {
            for (let i = 0, p = h.start; i < total; i++, p += 2) samples[i] = (bytes[p] << 8) | bytes[p + 1];
        } else {
            samples.set(bytes.subarray(h.start, h.start + total));
        }
    } else {
        const r = new Reader(bytes, h.start);
        const total = n * depth;
        for (let i = 0; i < total; i++) {
            r.skip();
            if (r.pos >= bytes.length) break;
            if (format === 1) samples[i] = bytes[r.pos++] === 49 ? 1 : 0;
            else samples[i] = Math.min(r.int(), 65535);
        }
    }
    // PBM's 1 is black; everywhere else 0 is black
    const pbm = format === 1 || format === 4;
    const lut = new Uint8Array(maxval + 1);
    for (let v = 0; v <= maxval; v++) lut[v] = pbm ? (v ? 0 : 255) : Math.round(v * 255 / maxval);
    const scale = v => (v > maxval ? 255 : lut[v]);
    const { color, alpha } = layout(h);
    for (let i = 0, s = 0, o = 0; i < n; i++, s += depth, o += 4) {
        if (color === 'rgb') {
            out[o] = scale(samples[s]);
            out[o + 1] = scale(samples[s + 1]);
            out[o + 2] = scale(samples[s + 2]);
            out[o + 3] = alpha ? scale(samples[s + 3]) : 255;
        } else if (color === 'cmyk') {
            const k = 255 - scale(samples[s + 3]);
            out[o] = (255 - scale(samples[s])) * k / 255;
            out[o + 1] = (255 - scale(samples[s + 1])) * k / 255;
            out[o + 2] = (255 - scale(samples[s + 2])) * k / 255;
            out[o + 3] = alpha ? scale(samples[s + 4]) : 255;
        } else {
            out[o] = out[o + 1] = out[o + 2] = scale(samples[s]);
            out[o + 3] = alpha ? scale(samples[s + 1]) : 255;
        }
    }
    return out;
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

function fileImages(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            return { bytes, images: netpbmImages(bytes) };
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: a page turn reads the file again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

function pageLabel(h) {
    const kind = KINDS[h.format] + (h.format === 7 ? (h.tupltype ? ' ' + h.tupltype : ` depth ${h.depth}`) : h.format <= 3 ? ' (plain)' : '');
    return kind + (h.format === 1 || h.format === 4 ? '' : `, maxval ${h.maxval}`);
}

// Image `page` of the Netpbm file at url: { url (a blob: URL of its PNG),
// pages: [{ width, height, label }], page }
function netpbmPage(url, page = 0) {
    const key = url + '#' + page;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            const { bytes, images } = await fileImages(url);
            const n = Math.max(0, Math.min(images.length - 1, page));
            const h = images[n];
            const png = await rgbaToPng(netpbmRgba(bytes, h), h.width, h.height);
            const pages = images.map(i => ({ width: i.width, height: i.height, label: pageLabel(i) }));
            return { url: URL.createObjectURL(png), pages, page: n };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('Netpbm decode failed:', err); });
        if (decoded.size > 64) {
            const [oldKey, old] = decoded.entries().next().value;
            decoded.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isNetpbmName, netpbmImages, netpbmRgba, netpbmPage };
