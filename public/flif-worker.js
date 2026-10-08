// FLIF to PNG, for the image viewer (src/flif.js). libflif's decoder (FLIF
// 0.4, the FLIF16 format; github.com/FLIF-hub/FLIF) as WebAssembly
// (@kreijstal/libflif-wasm: built from source, the decoder library only, with
// a small C API of its own) decodes every frame of a file to 8-bit RGBA: it
// undoes FLIF's transforms (YCoCg, palettes, color buckets, an animation's
// frame lookback) and interlacing, gray comes out as R = G = B, and 16-bit
// samples are rounded to 8. A still image becomes a PNG; an animation an APNG
// of its frames (which browsers play in an <img>, and the frame viewer steps
// through), with its frame delays and loop count. What the file is (interlaced
// or not, the bit depth, metadata) is read from its header here.
//   → { id, bytes }   ← { id, result: { png, width, height, frames, loops, label } } | { id, error }
import createLibflif from 'https://cdn.jsdelivr.net/npm/@kreijstal/libflif-wasm@0.4.0-build.1/libflif.mjs';

const CHANNELS = { 1: 'gray', 3: 'RGB', 4: 'RGBA' };
const METADATA = { iCCP: 'ICC profile', eXif: 'Exif', eXmp: 'XMP' };

let libflif = null;

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

function chunks(png) {
    const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const out = [];
    for (let p = 8; p + 12 <= png.length;) {
        const len = v.getUint32(p);
        out.push({ type: String.fromCharCode(...png.subarray(p + 4, p + 8)), data: png.subarray(p + 8, p + 8 + len) });
        p += 12 + len;
    }
    return out;
}

// Whole-canvas frames (each a PNG of the same size and format) as one APNG,
// as public/jxl-worker.js and public/bpg-worker.js make them
function assembleApng(frames, loops) {
    const first = chunks(frames[0].png);
    const header = first.filter(c => c.type !== 'IDAT' && c.type !== 'IEND');
    const ihdr = header.find(c => c.type === 'IHDR').data;
    const hv = new DataView(ihdr.buffer, ihdr.byteOffset, 8);
    const w = hv.getUint32(0), h = hv.getUint32(4);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
    const actl = new Uint8Array(8);
    new DataView(actl.buffer).setUint32(0, frames.length);
    new DataView(actl.buffer).setUint32(4, loops || 0);
    parts.push(chunk('acTL', actl));
    for (const c of header) if (c.type !== 'IHDR') parts.push(chunk(c.type, c.data));
    let seq = 0;
    frames.forEach((f, i) => {
        // FLIF's delays are milliseconds; APNG's are 16-bit fractions of a second
        let num = f.delay, den = 1000;
        while (num > 65535 || den > 65535) { num = Math.round(num / 2); den = Math.max(1, Math.round(den / 2)); }
        const fctl = new Uint8Array(26);
        const fv = new DataView(fctl.buffer);
        fv.setUint32(0, seq++);
        fv.setUint32(4, w);
        fv.setUint32(8, h);
        fv.setUint16(20, num);
        fv.setUint16(22, den);
        fctl[24] = 0; // dispose: none
        fctl[25] = 0; // blend: source (each frame is the whole picture, alpha included)
        parts.push(chunk('fcTL', fctl));
        for (const c of chunks(f.png)) {
            if (c.type !== 'IDAT') continue;
            if (i === 0) { parts.push(chunk('IDAT', c.data)); continue; }
            const d = new Uint8Array(4 + c.data.length);
            new DataView(d.buffer).setUint32(0, seq++);
            d.set(c.data, 4);
            parts.push(chunk('fdAT', d));
        }
    });
    parts.push(chunk('IEND', new Uint8Array(0)));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

// The header: "FLIF", the kind (3 still, 4 interlaced still, 5 animation, 6
// interlaced animation) and channel count, bytes per sample ('1', '2'; '0' per
// channel), the size as varints, then metadata chunks until a byte below 32
function readHeader(bytes) {
    const kind = bytes[4] >> 4, channels = bytes[4] & 15;
    let p = 6;
    const varint = () => {
        let v = 0;
        for (let i = 0; i < 10 && p < bytes.length; i++) {
            const b = bytes[p++];
            if (b < 128) return v + b;
            v = (v + b - 128) * 128;
        }
        return v;
    };
    varint(); varint();
    if (kind >= 5) varint();
    const metadata = [];
    while (p + 4 < bytes.length && bytes[p] >= 32) {
        const name = String.fromCharCode(...bytes.subarray(p, p + 4));
        p += 4;
        const length = varint();
        p += length;
        metadata.push(METADATA[name] || name);
    }
    // FLIF16 data starts with a 0; earlier (2015 to 2016) files have none
    return { interlaced: kind === 4 || kind === 6, channels, metadata, flif16: bytes[p] === 0 };
}

async function toPng(canvas, ctx, rgba, width, height) {
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

async function decode(m, bytes) {
    if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FLIF') throw new Error('FLIF: not a FLIF file');
    const header = readHeader(bytes);
    if (!header.flif16) throw new Error('FLIF: from before the FLIF16 format (2016), which no FLIF decoder reads any more');
    const inPtr = m._malloc(bytes.length);
    const infoPtr = m._malloc(8 * 4);
    let dec = 0, px = 0;
    try {
        m.HEAPU8.set(bytes, inPtr);
        dec = m._flifw_decode(inPtr, bytes.length, infoPtr);
        if (!dec) throw new Error('FLIF: damaged, cut short or not a FLIF file');
        const [width, height, channels, depth, count, loops] = m.HEAP32.slice(infoPtr >> 2, (infoPtr >> 2) + 6);
        let label = `FLIF, ${depth}-bit ${CHANNELS[channels] || channels + ' channels'}${header.interlaced ? ', interlaced' : ''}`;
        px = m._malloc(width * height * 4);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        const frames = [];
        for (let i = 0; i < count; i++) {
            if (m._flifw_frame(dec, i, px) !== 0) break;
            // (the heap may have grown: read it afresh)
            const rgba = new Uint8ClampedArray(m.HEAPU8.slice(px, px + width * height * 4).buffer);
            frames.push({ png: await toPng(canvas, ctx, rgba, width, height), delay: m._flifw_delay(dec, i) });
        }
        if (!frames.length) throw new Error('FLIF: the picture doesn\'t decode');
        if (frames.length > 1) label += `, animation of ${frames.length} frames`;
        if (header.metadata.length) label += `, ${header.metadata.join(', ')}`;
        const png = frames.length > 1 ? assembleApng(frames, loops) : frames[0].png;
        return { png, width, height, frames: frames.length, loops, label };
    } finally {
        if (dec) m._flifw_close(dec);
        if (px) m._free(px);
        m._free(inPtr);
        m._free(infoPtr);
    }
}

self.onmessage = async ({ data }) => {
    const { id, bytes } = data;
    try {
        if (!libflif) libflif = createLibflif();
        const result = await decode(await libflif, new Uint8Array(bytes));
        self.postMessage({ id, result }, [result.png.buffer]);
    } catch (err) {
        self.postMessage({ id, error: err.message || String(err) });
    }
};
