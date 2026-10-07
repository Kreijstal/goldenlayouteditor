// --- Quite OK Image Format (.qoi) ---
// No browser shows QOI. The format (qoiformat.org/qoi-specification.pdf) is a
// 14-byte header, a stream of byte-aligned chunks and an 8-byte end marker, so
// it is read here: QOI_OP_RGB, QOI_OP_RGBA, QOI_OP_INDEX (a 64-entry table of
// recently seen pixels), QOI_OP_DIFF, QOI_OP_LUMA and QOI_OP_RUN. RGB files are
// shown opaque, RGBA with their alpha. The colorspace byte (sRGB with linear
// alpha, or all channels linear) is informative only, as the spec says: the
// pixels are shown as stored and the label says which one the file claims.
// The image becomes a PNG an <img> shows.
const { createLogger } = require('./debug');

const log = createLogger('QOI');
const QOI_RE = /\.qoi$/i;
const MAGIC = [0x71, 0x6f, 0x69, 0x66]; // "qoif"
const OP_INDEX = 0x00; // 00xxxxxx
const OP_DIFF = 0x40; // 01xxxxxx
const OP_LUMA = 0x80; // 10xxxxxx
const OP_RUN = 0xc0; // 11xxxxxx
const OP_RGB = 0xfe;
const OP_RGBA = 0xff;
const MASK_2 = 0xc0;
// the spec's limit, to keep a hostile header from asking for gigabytes
const MAX_PIXELS = 400000000;
const COLORSPACES = ['sRGB, linear alpha', 'linear'];

const decoded = new Map(); // source URL -> Promise<{ url, pages }>

function isQoiName(name) {
    return QOI_RE.test(name || '');
}

// { width, height, channels, colorspace }, or null if these bytes don't start a QOI
function readHeader(bytes) {
    if (bytes.length < 14 || MAGIC.some((b, i) => bytes[i] !== b)) return null;
    const u32 = p => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    return { width: u32(4), height: u32(8), channels: bytes[12], colorspace: bytes[13] };
}

function qoiDecode(bytes) {
    const h = readHeader(bytes);
    if (!h) throw new Error('Not a QOI image (no "qoif" magic)');
    const { width, height, channels, colorspace } = h;
    if (!width || !height) throw new Error(`QOI image is ${width}x${height}`);
    if (channels !== 3 && channels !== 4) throw new Error(`QOI channels must be 3 or 4, not ${channels}`);
    if (colorspace > 1) throw new Error(`Unknown QOI colorspace ${colorspace}`);
    if (width * height > MAX_PIXELS) throw new Error(`QOI image too large (${width}x${height})`);

    const n = width * height;
    const rgba = new Uint8ClampedArray(n * 4);
    const index = new Uint8Array(64 * 4);
    // the chunks end where the 8-byte end marker starts
    const end = bytes.length - 8;
    let r = 0, g = 0, b = 0, a = 255;
    let p = 14;
    let run = 0;
    for (let px = 0; px < n * 4; px += 4) {
        if (run > 0) {
            run--;
        } else if (p < end) {
            const b1 = bytes[p++];
            if (b1 === OP_RGB) {
                r = bytes[p++]; g = bytes[p++]; b = bytes[p++];
            } else if (b1 === OP_RGBA) {
                r = bytes[p++]; g = bytes[p++]; b = bytes[p++]; a = bytes[p++];
            } else if ((b1 & MASK_2) === OP_INDEX) {
                const i = b1 * 4;
                r = index[i]; g = index[i + 1]; b = index[i + 2]; a = index[i + 3];
            } else if ((b1 & MASK_2) === OP_DIFF) {
                r = (r + ((b1 >> 4) & 3) - 2) & 255;
                g = (g + ((b1 >> 2) & 3) - 2) & 255;
                b = (b + (b1 & 3) - 2) & 255;
            } else if ((b1 & MASK_2) === OP_LUMA) {
                const b2 = bytes[p++];
                const dg = (b1 & 0x3f) - 32;
                r = (r + dg - 8 + ((b2 >> 4) & 0x0f)) & 255;
                g = (g + dg) & 255;
                b = (b + dg - 8 + (b2 & 0x0f)) & 255;
            } else if ((b1 & MASK_2) === OP_RUN) {
                run = b1 & 0x3f;
            }
            const i = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
            index[i] = r; index[i + 1] = g; index[i + 2] = b; index[i + 3] = a;
        } else if (px === 0) {
            throw new Error('QOI image has no pixel data');
        }
        // a truncated file: its last pixel fills the rest, as the reference decoder does
        rgba[px] = r; rgba[px + 1] = g; rgba[px + 2] = b;
        rgba[px + 3] = channels === 4 ? a : 255;
    }

    const label = `QOI ${channels === 4 ? 'RGBA' : 'RGB'}, ${COLORSPACES[colorspace]}`;
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

// The QOI at url: { url (a blob: URL of its PNG), pages: [{ width, height, label }] }
function qoiImage(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = qoiDecode(new Uint8Array(await resp.arrayBuffer()));
            const png = await rgbaToPng(r.rgba, r.width, r.height);
            return { url: URL.createObjectURL(png), pages: [{ width: r.width, height: r.height, label: r.label }] };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('QOI decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isQoiName, qoiDecode, qoiImage };
