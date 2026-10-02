// JPEG XL to PNG, for browsers that can't show JPEG XL (src/jxl.js): jxl-oxide
// (github.com/tirr-c/jxl-oxide), a JPEG XL decoder in Rust, as WebAssembly.
// A still image becomes a PNG; an animation an APNG of its frames (which
// browsers play in an <img>, and the frame viewer steps through).
//   → { id, bytes }   ← { id, result: { png, width, height, frames, loops } } | { id, error }
import init, { JxlImage } from 'https://cdn.jsdelivr.net/npm/jxl-oxide-wasm@0.12.6/jxl_oxide_wasm.js';

const ready = init({ module_or_path: 'https://cdn.jsdelivr.net/npm/jxl-oxide-wasm@0.12.6/jxl_oxide_wasm_bg.wasm' });

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

// Whole-canvas frames (each a PNG of the same size and format) as one APNG
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
        // Delay as a fraction of 16-bit numbers: milliseconds, or centiseconds when long
        let num = Math.round(f.seconds * 1000), den = 1000;
        if (num > 65535) { num = Math.min(65535, Math.round(f.seconds * 100)); den = 100; }
        const fctl = new Uint8Array(26);
        const fv = new DataView(fctl.buffer);
        fv.setUint32(0, seq++);
        fv.setUint32(4, w);
        fv.setUint32(8, h);
        fv.setUint16(20, num);
        fv.setUint16(22, den);
        fctl[24] = 0; // dispose: none
        fctl[25] = 0; // blend: source (each frame is the whole picture)
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

// The codestream: the file itself, or the jxlc / jxlp boxes of the container
function codestream(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0x0a) return bytes;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts = [];
    for (let p = 0; p + 8 <= bytes.length;) {
        let size = v.getUint32(p), head = 8;
        const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
        if (size === 1) { size = Number(v.getBigUint64(p + 8)); head = 16; }
        if (size === 0) size = bytes.length - p;
        if (type === 'jxlc') return bytes.subarray(p + head, p + size);
        if (type === 'jxlp') parts.push(bytes.subarray(p + head + 4, p + size));
        if (size < head) break;
        p += size;
    }
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of parts) { out.set(x, at); at += x.length; }
    return out;
}

// Ticks per second of an animation, from the image header (ISO/IEC 18181-1:
// SizeHeader, then ImageMetadata up to its AnimationHeader). Bits are read
// least significant first; U32 fields pick one of four encodings with 2 bits.
function ticksPerSecond(bytes) {
    const cs = codestream(bytes);
    let pos = 16; // after the FF 0A signature
    const bit = () => (cs[pos >> 3] >> (pos++ & 7)) & 1;
    const bits = n => { let v = 0; for (let i = 0; i < n; i++) v += bit() * 2 ** i; return v; };
    const u32 = dists => { const d = dists[bits(2)]; return typeof d === 'number' ? d : bits(d[0]) + d[1]; };
    const size = [[9, 1], [13, 1], [18, 1], [30, 1]];
    const sizeHeader = () => {
        if (bit()) { bits(5); if (bits(3) === 0) bits(5); }
        else { u32(size); if (bits(3) === 0) u32(size); }
    };
    sizeHeader();
    if (bit()) return null;      // all_default: no animation
    if (!bit()) return null;     // no extra fields: no animation
    bits(3);                     // orientation
    if (bit()) sizeHeader();     // intrinsic size
    if (bit()) {                 // preview
        const div8 = bit();
        const dist = div8 ? [16, 32, [5, 1], [9, 33]] : [[6, 1], [8, 65], [10, 321], [12, 1345]];
        u32(dist);
        if (bits(3) === 0) u32(dist);
    }
    if (!bit()) return null;     // no animation
    const num = u32([100, 1000, [10, 1], [30, 1]]);
    const den = u32([1, 1001, [8, 1], [10, 1]]);
    return { num, den };
}

self.onmessage = async ({ data: { id, bytes } }) => {
    let image = null;
    try {
        await ready;
        image = new JxlImage();
        image.feedBytes(new Uint8Array(bytes));
        if (!image.tryInit()) throw new Error('not a complete JPEG XL image');
        const count = Math.max(1, image.numLoadedKeyframes);
        const frames = [];
        // jxl-oxide-wasm 0.12 gives a frame's time as ticks × tps_num / tps_den;
        // it is ticks × tps_den / tps_num seconds, so the ratio is needed twice over
        let tps = null;
        try { tps = image.animated ? ticksPerSecond(new Uint8Array(bytes)) : null; } catch { /* keep jxl-oxide's figure */ }
        for (let k = 0; k < count; k++) {
            const r = image.render(k);
            // Its duration first: encodeToPng() consumes the result
            const raw = r.durationDenominator ? r.durationNumerator / r.durationDenominator : 0;
            const seconds = tps ? raw * (tps.den / tps.num) ** 2 : raw;
            frames.push({ png: r.encodeToPng(), seconds });
        }
        const animated = !!image.animated && frames.length > 1;
        const png = animated ? assembleApng(frames, image.numLoops) : frames[0].png;
        self.postMessage({ id, result: { png, width: image.width, height: image.height, frames: frames.length, loops: image.numLoops || 0, animated } }, [png.buffer]);
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    } finally {
        if (image) image.free();
    }
};
