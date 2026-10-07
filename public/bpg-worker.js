// BPG to PNG, for the image viewer (src/bpg.js). libbpg, Fabrice Bellard's
// decoder (bellard.org/bpg, 0.9.8), as WebAssembly (@kreijstal/libbpg-wasm:
// built from source with both of the options Bellard's own JS decoders split
// between them, 8 to 14 bits and animations, and a heap that grows) decodes a
// file's frames to 8-bit RGBA: libbpg converts the color (YCbCr BT.601/709/2020,
// YCgCo, RGB, gray, limited range; 4:2:0 and 4:2:2 chroma upsampled), divides
// out premultiplied alpha and folds a CMYK picture's black (W) plane into its
// color, as bpgdec does. A still image becomes a PNG; an animation an APNG of
// its frames (which browsers play in an <img>, and the frame viewer steps
// through), with its frame durations and loop count.
//   → { id, bytes }   ← { id, result: { png, width, height, frames, loops, label } } | { id, error }
import createLibbpg from 'https://cdn.jsdelivr.net/npm/@kreijstal/libbpg-wasm@0.9.8-build.1/libbpg.mjs';

// libbpg's enums (libbpg.h)
const FORMATS = ['gray', '4:2:0', '4:2:2', '4:4:4', '4:2:0 (video chroma siting)', '4:2:2 (video chroma siting)'];
const COLOR_SPACES = ['YCbCr', 'RGB', 'YCgCo', 'YCbCr BT.709', 'YCbCr BT.2020'];

let libbpg = null;

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
// as public/jxl-worker.js makes them
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
        // BPG's delay is already a fraction; APNG's are 16-bit
        let { num, den } = f;
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

async function toPng(canvas, ctx, rgba, width, height) {
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

async function decode(m, bytes) {
    const inPtr = m._malloc(bytes.length);
    const infoPtr = m._malloc(12 * 4);
    const delayPtr = m._malloc(8);
    let dec = 0, px = 0;
    try {
        m.HEAPU8.set(bytes, inPtr);
        dec = m._bpgw_decode(inPtr, bytes.length, infoPtr);
        if (!dec) throw new Error('BPG: damaged, cut short or not a BPG file');
        const [width, height, format, alpha, colorSpace, bitDepth, premul, wPlane, limited, animation, loops]
            = m.HEAP32.slice(infoPtr >> 2, (infoPtr >> 2) + 11);
        let label = `BPG, ${bitDepth}-bit ${wPlane ? 'CMYK' : format === 0 ? 'gray' : COLOR_SPACES[colorSpace] || 'color space ' + colorSpace}`;
        if (format !== 0) label += ` ${FORMATS[format] || 'format ' + format}`;
        if (limited) label += ', limited range';
        if (alpha) label += premul ? ', premultiplied alpha' : ', alpha';
        px = m._malloc(width * height * 4);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        const frames = [];
        while (m._bpgw_frame(dec, px, delayPtr) === 0) {
            // (the heap may have grown: read it afresh)
            const rgba = new Uint8ClampedArray(m.HEAPU8.slice(px, px + width * height * 4).buffer);
            const [num, den] = m.HEAP32.slice(delayPtr >> 2, (delayPtr >> 2) + 2);
            frames.push({ png: await toPng(canvas, ctx, rgba, width, height), num, den: den || 1 });
            if (!animation) break;
        }
        if (!frames.length) throw new Error('BPG: the picture doesn\'t decode');
        if (frames.length > 1) label += `, animation of ${frames.length} frames`;
        const png = frames.length > 1 ? assembleApng(frames, loops) : frames[0].png;
        return { png, width, height, frames: frames.length, loops, label };
    } finally {
        if (dec) m._bpgw_close(dec);
        if (px) m._free(px);
        m._free(inPtr);
        m._free(infoPtr);
        m._free(delayPtr);
    }
}

self.onmessage = async ({ data }) => {
    const { id, bytes } = data;
    try {
        if (!libbpg) libbpg = createLibbpg();
        const result = await decode(await libbpg, new Uint8Array(bytes));
        self.postMessage({ id, result }, [result.png.buffer]);
    } catch (err) {
        self.postMessage({ id, error: err.message || String(err) });
    }
};
