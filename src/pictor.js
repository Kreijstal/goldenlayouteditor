// --- PICtor / PC Paint pictures (a .pic that starts as one) to PNG ---
// Mouse Systems' PC Paint (1984) and its PICtor format, which Grasp and other
// DOS programs used too: a header (the magic number 0x1234, little-endian, the
// size, the screen's offset, the planes and bits a pixel, a video mode and its
// palette: CGA, EGA or VGA), then the pixels in run-length packed blocks, by
// planes. No browser shows it, and magick-wasm has no coder for it; here FFmpeg
// reads it (its pictor_pipe demuxer and pictor decoder, ffmpeg.wasm's core in
// the worker Amiga animations use, src/iffanim.js), known by its magic number
// (a .pic is Radiance's or QuickDraw PICT's first): shown as a PNG in the image
// viewer, thumbnails. Its pixels shown square: FFmpeg gives no pixel aspect
// (a 320×200 CGA or EGA screen's were taller than wide).
const { createLogger } = require('./debug');
const { ffmpegFrames, framePng } = require('./iffanim');

const log = createLogger('PICtor');

const converted = new Map(); // source URL -> Promise<{ url, width, height, label }>

// Bytes that start a PICtor picture: the magic number and a size
function isPictor(bytes) {
    return bytes.length >= 11 && bytes[0] === 0x34 && bytes[1] === 0x12
        && (bytes[2] | bytes[3] << 8) > 0 && (bytes[4] | bytes[5] << 8) > 0;
}

// Whether the file at url is a PICtor picture (for a .pic)
async function isPictorUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isPictor(value);
}

// The PICtor picture at url as a PNG: { url (a blob: URL), width, height, label }
function pictorImage(url) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (!isPictor(bytes)) throw new Error('not a PICtor picture');
            const d = await ffmpegFrames(bytes, 1);
            if (!/^pictor\b/.test(d.stream)) throw new Error(`not a PICtor picture (FFmpeg read it as ${d.stream.split(',')[0] || 'something else'})`);
            const frame = d.frames[0];
            // planes and bits a pixel (the header's byte 10: bits in the low nibble, planes less one above)
            const planes = (bytes[10] >> 4) + 1, bits = bytes[10] & 15;
            const label = `PICtor (PC Paint) picture, ${d.width}×${d.height}, ${planes > 1 ? `${planes} planes of ${bits} bit${bits > 1 ? 's' : ''}` : `${bits} bit${bits > 1 ? 's' : ''} a pixel`}`;
            return { url: URL.createObjectURL(await framePng(frame, d.width, d.height)), width: d.width, height: d.height, label };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('PICtor decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isPictor, isPictorUrl, pictorImage };
