// --- X Window dumps (.xwd) to PNG ---
// What xwd(1) writes of a window or the whole screen: a header (its size,
// version 7, the pixmap's format, depth, size, byte and bit order, the visual's
// class and masks, the window's name), the colormap, then the pixels as the X
// server held them: 1 to 32 bits, PseudoColor through a colormap, TrueColor /
// DirectColor by masks, StaticGray. No browser shows it, and magick-wasm is
// built without X11 (no XWD coder); here FFmpeg reads it (its xwd_pipe demuxer
// and xwd decoder, ffmpeg.wasm's core in the worker Amiga animations use,
// src/iffanim.js), known by its header whatever the name: shown as a PNG in the
// image viewer, thumbnails. X has no alpha: a 32-bit pixel's spare byte (what
// FFmpeg gives as alpha) is whatever the server left there, and is dropped.
// Not read: XYPixmap and XYBitmap dumps (xwd -xy), FFmpeg's "Invalid data" given.
// FFmpeg's own: a colormap's 16-bit entries taken by their high byte (1 off from
// ImageMagick's in places), and netpbm's 1-bit StaticGray dumps (pnmtoxwd's) read awry.
const { createLogger } = require('./debug');
const { ffmpegFrames, framePng } = require('./iffanim');

const log = createLogger('XWD');
const XWD_RE = /\.xwd$/i;

const converted = new Map(); // source URL -> Promise<{ url, width, height, label }>

function isXwdName(name) {
    return XWD_RE.test(name || '');
}

// The X Window dump at url as a PNG: { url (a blob: URL), width, height, label }
function xwdImage(url) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const d = await ffmpegFrames(new Uint8Array(await resp.arrayBuffer()), 1);
            if (!/^xwd\b/.test(d.stream)) throw new Error(`not an X Window dump (FFmpeg read it as ${d.stream.split(',')[0] || 'something else'})`);
            const frame = d.frames[0];
            for (let i = 3; i < frame.rgba.length; i += 4) frame.rgba[i] = 255;
            // FFmpeg's pixel format: pal8 (PseudoColor), monow (1 bit), rgb565le, bgra...
            const format = d.stream.split(',')[1] || '';
            const label = `X Window dump, ${d.width}×${d.height}${format ? `, ${format.trim()}` : ''}`;
            return { url: URL.createObjectURL(await framePng(frame, d.width, d.height)), width: d.width, height: d.height, label };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('XWD decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isXwdName, xwdImage };
