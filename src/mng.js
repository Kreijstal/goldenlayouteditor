// --- MNG animations (.mng; a .mng that starts as one) and JNG pictures (.jng) ---
// PNG's family: MNG (Multiple-image Network Graphics) is PNG's animation, a
// stream of chunks (MHDR, then frames of PNG or JNG images with FRAM's timing,
// DEFI's offsets, loops, objects to show again...); JNG (JPEG Network Graphics)
// is a JPEG in PNG's chunks with an alpha channel beside it (PNG- or
// JPEG-compressed). No browser shows either. Here ImageMagick (magick-wasm, the
// copy QuickDraw PICT loads from jsDelivr, src/pict.js) reads them, its MNG
// coder with libpng and libjpeg: an MNG's frames, composed over each other
// (coalesced) with each one's delay, played in the image viewer by the
// animation player (src/iffanim.js); a JNG as a PNG. ImageMagick reads MNG-LC
// and much of MNG-VLC/full MNG but not all (MAGN of nonzero objects, delta-PNG,
// SHOW): such a file fails with ImageMagick's own message. .mng is Ott's too
// (text): a .mng is MNG only if its bytes say so (isMng).
const { createLogger } = require('./debug');
const { magick } = require('./pict');

const log = createLogger('MNG');
const MNG_RE = /\.mng$/i;
const JNG_RE = /\.jng$/i;
const MNG_MAGIC = [0x8a, 0x4d, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // \x8AMNG\r\n\x1A\n
const JNG_MAGIC = [0x8b, 0x4a, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // \x8BJNG\r\n\x1A\n
// the frames' RGBA kept at most, as the other animations'
const MAX_BYTES = 512 * 1024 * 1024;

const decoded = new Map(); // source URL -> Promise<{ width, height, aspect, frames, label }>
const firsts = new Map(); // source URL -> Promise<{ url, aspect, label }>

function isMngName(name) {
    return MNG_RE.test(name || '');
}

function isJngName(name) {
    return JNG_RE.test(name || '');
}

const startsWith = (bytes, magic) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

// Bytes that start an MNG file (not Ott's text)
function isMng(bytes) {
    return startsWith(bytes, MNG_MAGIC);
}

function isJng(bytes) {
    return startsWith(bytes, JNG_MAGIC);
}

// Whether the file at url is an MNG file (for a .mng)
async function isMngUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the signature is in the first chunk
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isMng(value);
}

async function fetchBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

// An MNG's frames, coalesced: { width, height, aspect, frames: [{ rgba, ms }], label }
async function mngDecode(bytes) {
    if (!isMng(bytes)) throw new Error('not an MNG file');
    const { ImageMagick, MagickFormat } = await magick();
    return ImageMagick.readCollection(bytes, MagickFormat.Mng, images => {
        if (!images.length) throw new Error('ImageMagick found no frames');
        images.coalesce();
        const { width, height } = images[0];
        const cap = Math.max(1, Math.floor(MAX_BYTES / (width * height * 4)));
        const frames = [];
        for (let i = 0; i < Math.min(cap, images.length); i++) {
            const image = images[i];
            const rgba = image.getPixels(p => p.toByteArray(0, 0, width, height, 'RGBA'));
            const tps = image.animationTicksPerSecond || 100;
            frames.push({ rgba: new Uint8ClampedArray(rgba), ms: Math.max(1, image.animationDelay * 1000 / tps) });
        }
        const loop = frames.reduce((t, f) => t + f.ms, 0);
        const label = `MNG animation: ${width}×${height}, ${images.length} frame${images.length > 1 ? 's' : ''}, ${(loop / 1000).toFixed(2)} s a loop`
            + (frames.length < images.length ? `, the first ${frames.length} frames shown` : '');
        return { width, height, aspect: 1, frames, label };
    });
}

// The whole animation at url (the player's, src/iffanim.js)
function mngFile(url) {
    let p = decoded.get(url);
    if (!p) {
        p = fetchBytes(url).then(mngDecode);
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('MNG decode failed:', err); });
        // the frames' pixels are big: few files kept
        if (decoded.size > 4) decoded.delete(decoded.keys().next().value);
    }
    return p;
}

// A frame's RGBA as a PNG blob
function framePng(frame, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(frame.rgba, width, height), 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

// The MNG's first frame: { url (a blob: URL of its PNG), aspect, label }
function mngImage(url) {
    let p = firsts.get(url);
    if (!p) {
        p = (async () => {
            const d = await mngFile(url);
            return { url: URL.createObjectURL(await framePng(d.frames[0], d.width, d.height)), aspect: 1, label: d.label };
        })();
        firsts.set(url, p);
        p.catch(err => { firsts.delete(url); log.warn('MNG decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (firsts.size > 64) {
            const [oldUrl, old] = firsts.entries().next().value;
            firsts.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// A JNG as a PNG, its alpha kept: { png: Uint8Array, width, height, label }
async function jngDecode(bytes) {
    if (!isJng(bytes)) throw new Error('not a JNG file');
    const { ImageMagick, MagickFormat } = await magick();
    return ImageMagick.read(bytes, MagickFormat.Jng, image => {
        const { width, height, hasAlpha } = image;
        const png = image.write(MagickFormat.Png, data => data.slice());
        return { png, width, height, label: `JNG (JPEG Network Graphics), ${width}×${height}${hasAlpha ? ', with alpha' : ''}` };
    });
}

// The JNG file at url as a PNG: { url (a blob: URL), width, height, label }
function jngImage(url) {
    let p = firsts.get(url);
    if (!p) {
        p = (async () => {
            const r = await jngDecode(await fetchBytes(url));
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height, label: r.label };
        })();
        firsts.set(url, p);
        p.catch(err => { firsts.delete(url); log.warn('JNG decode failed:', err); });
        if (firsts.size > 64) {
            const [oldUrl, old] = firsts.entries().next().value;
            firsts.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isMngName, isJngName, isMng, isJng, isMngUrl, mngDecode, mngFile, mngImage, jngDecode, jngImage };
