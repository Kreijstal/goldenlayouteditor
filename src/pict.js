// --- Apple QuickDraw PICT (.pict, .pct; a .pic that is one) to PNG ---
// The Mac's picture format: QuickDraw's drawing commands, recorded (lines,
// shapes, text, and pixel maps, packed or QuickTime-compressed). No browser
// shows it; here ImageMagick, compiled to WebAssembly (@imagemagick/magick-wasm,
// Dirk Lemstra, loaded from jsDelivr, some 15 MB, when one is first shown),
// reads it and writes a PNG, which any <img> shows. Its limits are this
// viewer's: ImageMagick draws a picture's pixel maps (and the JPEGs QuickTime
// put in one), not its lines, shapes or text, and reads only files with the
// 512-byte header a PICT file starts with (not a bare picture, as a resource
// or the clipboard holds one). .pic is also Radiance's, Softimage's, PC
// Paint's...: a .pic is PICT only if its bytes say so (isPict).
const { createLogger } = require('./debug');

const log = createLogger('PICT');
const MAGICK = 'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.44/dist/index.js';
const MAGICK_WASM = 'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.44/dist/x86/magick.wasm';
const PICT_RE = /\.(pict|pct)$/i;
const HEADER = 512; // the file's header, before the picture (an application's, zeros mostly)

let magickPromise = null;
const converted = new Map(); // source URL -> Promise<{ url, width, height, label }>

function isPictName(name) {
    return PICT_RE.test(name || '');
}

// The picture's version, by the opcode that follows its size and frame (after
// the header): 1 (0x11 0x01), 2 (0x0011 0x02FF) or 0, none (not a PICT file)
function pictVersion(bytes) {
    const at = HEADER + 10;
    if (bytes.length < at + 4) return 0;
    if (bytes[at] === 0x11 && bytes[at + 1] === 0x01) return 1;
    if (bytes[at] === 0x00 && bytes[at + 1] === 0x11 && bytes[at + 2] === 0x02 && bytes[at + 3] === 0xff) return 2;
    return 0;
}

// Bytes that start a PICT file
function isPict(bytes) {
    return pictVersion(bytes) > 0;
}

// Whether the file at url is a PICT file (for a .pic)
async function isPictUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the header and the picture's start: read until there are enough
    const reader = resp.body.getReader();
    const parts = [];
    let size = 0;
    while (size < HEADER + 14) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    return isPict(bytes);
}

// ImageMagick, loaded once (DPX and Cineon's too, src/dpx.js)
function magick() {
    if (!magickPromise) {
        magickPromise = (async () => {
            const m = await import(MAGICK);
            await m.initializeImageMagick(new URL(MAGICK_WASM));
            return m;
        })();
        magickPromise.catch(err => { magickPromise = null; log.warn('ImageMagick failed to load:', err); });
    }
    return magickPromise;
}

// { png: Uint8Array, width, height, label }
async function pictDecode(bytes) {
    const version = pictVersion(bytes);
    if (!version) throw new Error('not a PICT file');
    const { ImageMagick, MagickFormat } = await magick();
    return ImageMagick.read(bytes, MagickFormat.Pict, image => {
        const { width, height } = image;
        const png = image.write(MagickFormat.Png, data => data.slice());
        return { png, width, height, label: `QuickDraw PICT, version ${version}, ${width}×${height}` };
    });
}

// The PICT file at url as a PNG: { url (a blob: URL), width, height, label }
function pictImage(url) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = await pictDecode(new Uint8Array(await resp.arrayBuffer()));
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height, label: r.label };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('PICT decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isPictName, isPict, isPictUrl, pictDecode, pictImage, magick };
