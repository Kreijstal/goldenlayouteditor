// JPEG XR / HD Photo to pixels, for the image viewer (src/jxr.js). jxrlib,
// Microsoft's reference codec (github.com/4creators/jxrlib), as WebAssembly
// (@kreijstal/jxrlib-wasm: the decoder and a small C API, built with
// emscripten) decodes a file to its own pixel format, alpha plane included, as
// JxrDecApp does; that format is turned here into what a canvas takes:
// - 8-bit RGBA for the formats meant for display as they are: black and white
//   (1 bit), 8- and 16-bit gray, RGB, BGR and RGBA (premultiplied too),
//   RGB555, RGB565 and RGB101010, CMYK (with alpha) and n-channel images (the
//   first three channels as RGB). Deeper channels are cut to 8 bits as
//   jxrlib's own converters (JXRGluePFC.c) do; 5- and 6-bit ones are widened
//   to the full range (jxrlib's only shift them: its white is 248).
// - floats, linear (scRGB: 1.0 is SDR white), for the high dynamic range ones:
//   16- and 32-bit fixed point, half and full float, RGBE; src/jxr.js tone
//   maps them (an exposure, clipped or Reinhard), to sRGB as jxrlib does.
// YCC formats and CMYKDIRECT, which jxrlib's glue doesn't decode, are errors.
//   → { id, bytes }   ← { id, result: { width, height, label, rgba | float } } | { id, error }
import createJxrlib from 'https://cdn.jsdelivr.net/npm/@kreijstal/jxrlib-wasm@1.1.0-build.1/jxrlib.mjs';

// jxrlib's enums (windowsmediaphoto.h)
const BD_1 = 0, BD_8 = 1, BD_16 = 2, BD_16S = 3, BD_16F = 4, BD_32S = 6, BD_32F = 7, BD_5 = 8, BD_10 = 9, BD_565 = 10;
const Y_ONLY = 0, CMYK = 4, NCOMPONENT = 6, CF_RGB = 7, CF_RGBE = 8;
const HAS_ALPHA = 0x10, PREMUL = 0x20, BGR = 0x40;
const DEPTH_NAMES = { [BD_1]: '1-bit', [BD_8]: '8-bit', [BD_16]: '16-bit', [BD_16S]: '16-bit fixed point', [BD_16F]: 'half float',
    [BD_32S]: '32-bit fixed point', [BD_32F]: 'float', [BD_5]: '5-bit', [BD_10]: '10-bit', [BD_565]: '5-6-5' };
const ERRORS = { '-1': 'damaged or cut short', '-101': 'out of memory', '-103': 'the file ends early', '-104': 'invalid parameter', '-106': 'not JPEG XR, or a pixel format jxrlib doesn\'t decode',
    '-107': 'unknown codec version' };

let jxrlib = null;

// IEEE half to float
const HALF = (() => {
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
        t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
    }
    return t;
})();

function decode(m, bytes) {
    const inPtr = m._malloc(bytes.length);
    const infoPtr = m._malloc(64);
    try {
        m.HEAPU8.set(bytes, inPtr);
        const px = m._jxr_decode(inPtr, bytes.length, infoPtr);
        const info = Array.from(m.HEAP32.subarray(infoPtr >> 2, (infoPtr >> 2) + 16));
        if (!px) throw new Error(`JPEG XR: ${ERRORS[info[0]] || 'jxrlib error ' + info[0]}`);
        try {
            const [, width, height, stride] = info;
            return convert(m.HEAPU8.slice(px, px + stride * height), info);
        } finally {
            m._free(px);
        }
    } finally {
        m._free(inPtr);
        m._free(infoPtr);
    }
}

// The decoded pixels as { width, height, label, rgba } or { ..., float }
function convert(pixels, info) {
    const [, width, height, stride, bpp, channels, cf, bd, grBit, blackWhite, planarAlpha] = info;
    const n = width * height;
    const dv = new DataView(pixels.buffer);
    const alpha = !!(grBit & HAS_ALPHA), premul = !!(grBit & PREMUL), bgr = !!(grBit & BGR);
    const kind = cf === Y_ONLY ? 'gray' : cf === CMYK ? 'CMYK' : cf === CF_RGBE ? 'RGBE' : cf === NCOMPONENT ? `${channels - alpha}-channel`
        : cf === CF_RGB ? (bgr ? 'BGR' : 'RGB') : null;
    if (!kind) throw new Error(`JPEG XR: color format ${cf} isn't shown`);
    const depth = cf === CF_RGBE ? 'shared exponent' : DEPTH_NAMES[bd] || 'bit depth ' + bd;
    let label = `JPEG XR, ${bpp}bpp ${kind}${alpha ? (premul ? ' premultiplied alpha' : ' and alpha') : ''}, ${depth}`;
    if (alpha) label += planarAlpha ? ' (alpha in a plane of its own)' : ' (alpha interleaved)';

    const hdr = bd === BD_16S || bd === BD_16F || bd === BD_32S || bd === BD_32F || cf === CF_RGBE;
    if (hdr) {
        if (cf !== Y_ONLY && cf !== CF_RGB && cf !== CF_RGBE) throw new Error(`JPEG XR: ${label} isn't shown`);
        const out = new Float32Array(n * 4);
        const size = bd === BD_16S || bd === BD_16F ? 2 : bd === BD_32S || bd === BD_32F ? 4 : 1;
        const per = bpp / 8 / size; // elements a pixel (an unused fourth with 64bppRGBHalf, 128bppRGBFloat...)
        const read = bd === BD_16S ? o => dv.getInt16(o, true) / 8192
            : bd === BD_16F ? o => HALF[dv.getUint16(o, true)]
            : bd === BD_32S ? o => dv.getInt32(o, true) / 16777216
            : o => dv.getFloat32(o, true);
        for (let y = 0, i = 0; y < height; y++) {
            for (let x = 0, o = y * stride; x < width; x++, i += 4, o += per * size) {
                if (cf === CF_RGBE) {
                    // as Radiance: mantissas over 256, times 2^(exponent - 128)
                    const e = pixels[o + 3];
                    const f = e ? 2 ** (e - 136) : 0;
                    out[i] = pixels[o] * f; out[i + 1] = pixels[o + 1] * f; out[i + 2] = pixels[o + 2] * f; out[i + 3] = 1;
                    continue;
                }
                if (cf === Y_ONLY) {
                    out[i] = out[i + 1] = out[i + 2] = read(o);
                    out[i + 3] = 1;
                    continue;
                }
                let r = read(o), g = read(o + size), b = read(o + 2 * size);
                const a = alpha ? read(o + 3 * size) : 1;
                if (premul && a > 0) { r /= a; g /= a; b /= a; }
                out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
            }
        }
        return { width, height, label: label + ', linear (scRGB)', float: out };
    }

    const out = new Uint8ClampedArray(n * 4);
    for (let y = 0, i = 0; y < height; y++) {
        const row = y * stride;
        for (let x = 0; x < width; x++, i += 4) {
            let r, g, b, a = 255;
            if (bd === BD_1) {
                // as jxrlib's BlackWhite_Gray8: a set bit is white, unless 0 is white
                const bit = (pixels[row + (x >> 3)] >> (7 - (x & 7))) & 1;
                r = g = b = bit ^ blackWhite ? 255 : 0;
            } else if (bd === BD_5 || bd === BD_565) {
                const v = dv.getUint16(row + x * 2, true);
                if (bd === BD_5) { r = (v >> 10) & 31; g = (v >> 5) & 31; b = v & 31; r = r << 3 | r >> 2; g = g << 3 | g >> 2; b = b << 3 | b >> 2; }
                else { r = (v >> 11) & 31; g = (v >> 5) & 63; b = v & 31; r = r << 3 | r >> 2; g = g << 2 | g >> 4; b = b << 3 | b >> 2; }
            } else if (bd === BD_10) {
                const v = dv.getUint32(row + x * 4, true);
                r = (v >> 22) & 255; g = (v >> 12) & 255; b = (v >> 2) & 255;
            } else {
                const size = bd === BD_16 ? 2 : 1;
                const per = bpp / 8 / size;
                const o = row + x * per * size;
                const at = k => (size === 2 ? dv.getUint16(o + k * 2, true) >> 8 : pixels[o + k]);
                if (cf === Y_ONLY) {
                    r = g = b = at(0);
                } else if (cf === CMYK) {
                    // as ImageMagick shows CMYK: (1 - C)(1 - K)...
                    const k = 255 - at(3);
                    r = (255 - at(0)) * k / 255; g = (255 - at(1)) * k / 255; b = (255 - at(2)) * k / 255;
                    if (alpha) a = at(4);
                } else {
                    r = at(0); g = at(1); b = at(2);
                    if (bgr) [r, b] = [b, r];
                    if (alpha) a = at(per - 1);
                    if (premul && a > 0 && a < 255) { r = r * 255 / a; g = g * 255 / a; b = b * 255 / a; }
                }
            }
            out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
        }
    }
    return { width, height, label, rgba: out };
}

self.onmessage = async ({ data }) => {
    const { id, bytes } = data;
    try {
        if (!jxrlib) jxrlib = createJxrlib();
        const result = decode(await jxrlib, new Uint8Array(bytes));
        self.postMessage({ id, result }, [(result.rgba || result.float).buffer]);
    } catch (err) {
        self.postMessage({ id, error: err.message || String(err) });
    }
};
