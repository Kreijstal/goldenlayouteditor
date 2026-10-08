// PGF to PNG, for the image viewer (src/pgf.js). pgfjs (@kevcom71/pgfjs, MIT:
// a clean-room decoder of libpgf's format, which matches libpgf 7.21's own
// decode sample for sample) undoes the entropy coding, the wavelet pyramid and
// the color transform; it gives RGBA for black and white, gray, RGB and RGBA,
// and the file's own samples for the rest, which are made 8-bit RGBA here: a
// set bit black (as libpgf's own PGF tool, and Photoshop's bitmap mode, show
// it; pgfjs makes it white), palette indices through the file's color table
// (B, G, R entries), CMYK without a profile (R = (1 - C)(1 - K)...), CIE
// L*a*b* (D50, as Photoshop's modes are) to sRGB, HSL and HSB to RGB, 16- and
// 31-bit samples cut to their top 8 bits, RGB 4:4:4 and 5:6:5 widened. A level
// other than 0 is the image at 1/2^level of its size, decoded from the file's
// first levels alone (a PGF's progressive order: coarsest first), as libpgf's
// Read(level) does.
//   → { id, bytes, level }   (level: 0..levels-1, or 'thumb': the smallest at least THUMB on its long side)
//   ← { id, result: { png, width, height, fullWidth, fullHeight, level, levels, label } } | { id, error }
import { decode, readHeader, levelDimensions } from 'https://cdn.jsdelivr.net/npm/@kevcom71/pgfjs@4.0.0/+esm';

const THUMB = 256;
// Adobe's image modes, which PGF's header uses
const MODES = {
    0: 'black and white', 1: 'gray', 2: 'indexed color', 3: 'RGB', 4: 'CMYK', 5: 'HSL', 6: 'HSB',
    9: 'L*a*b*', 10: '16-bit gray', 11: '48-bit RGB', 12: '48-bit L*a*b*', 13: '64-bit CMYK',
    17: 'RGBA', 18: '32-bit gray', 19: '12-bit RGB (4:4:4)', 20: '16-bit RGB (5:6:5)',
};

function srgbByte(v) {
    v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// CIE L*a*b* (D50) to sRGB (D65, Bradford adapted)
function labToRgb(L, a, b, out, o) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const f = t => t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29);
    const X = 0.96422 * f(fx), Y = f(fy), Z = 0.82521 * f(fz);
    out[o] = srgbByte(3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z);
    out[o + 1] = srgbByte(-0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z);
    out[o + 2] = srgbByte(0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z);
}

// HSL or HSB (all 0..1) to RGB bytes
function hsxToRgb(h, s, x, hsb, out, o) {
    let c, m;
    if (hsb) { c = x * s; m = x - c; } else { c = (1 - Math.abs(2 * x - 1)) * s; m = x - c / 2; }
    const hp = (h * 6) % 6, q = c * (1 - Math.abs(hp % 2 - 1));
    const [r, g, b] = hp < 1 ? [c, q, 0] : hp < 2 ? [q, c, 0] : hp < 3 ? [0, c, q] : hp < 4 ? [0, q, c] : hp < 5 ? [q, 0, c] : [c, 0, q];
    out[o] = Math.round((r + m) * 255);
    out[o + 1] = Math.round((g + m) * 255);
    out[o + 2] = Math.round((b + m) * 255);
}

// pgfjs's result as 8-bit RGBA
function toRgba(img) {
    const { width, height, data, colorModel } = img;
    const n = width * height;
    // a set bit is black, as libpgf's own tool (and Photoshop's bitmap mode) has it; pgfjs makes it white
    if (colorModel === 'bitmap') {
        for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 255 - data[i];
        return data;
    }
    if (data.length === n * 4 && data instanceof Uint8ClampedArray) return data;
    const out = new Uint8ClampedArray(n * 4);
    const ch = img.channels;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        const s = i * ch;
        out[o + 3] = 255;
        switch (colorModel) {
        case 'indexed': {
            const p = img.palette, k = data[i] * 4;
            if (p) { out[o] = p[k + 2]; out[o + 1] = p[k + 1]; out[o + 2] = p[k]; } else out[o] = out[o + 1] = out[o + 2] = data[i];
            break;
        }
        case 'cmyk': case 'cmyk64': {
            const d = colorModel === 'cmyk' ? 1 : 257;
            const k = 255 - data[s + 3] / d;
            for (let c = 0; c < 3; c++) out[o + c] = (255 - data[s + c] / d) * k / 255;
            break;
        }
        case 'lab': labToRgb(data[s] * 100 / 255, data[s + 1] - 128, data[s + 2] - 128, out, o); break;
        case 'lab48': labToRgb(data[s] * 100 / 65535, data[s + 1] / 256 - 128, data[s + 2] / 256 - 128, out, o); break;
        case 'gray16': out[o] = out[o + 1] = out[o + 2] = data[i] >> 8; break;
        case 'gray31': out[o] = out[o + 1] = out[o + 2] = data[i] >>> 23; break;
        case 'rgb48': for (let c = 0; c < 3; c++) out[o + c] = data[s + c] >> 8; break;
        case 'rgb12': for (let c = 0; c < 3; c++) out[o + c] = data[s + c] * 17; break;
        case 'rgb16':
            out[o] = data[s] * 255 / 31;
            out[o + 1] = data[s + 1] * 255 / 63;
            out[o + 2] = data[s + 2] * 255 / 31;
            break;
        case 'untransformed5': case 'untransformed6':
            if (ch < 3) out[o] = out[o + 1] = out[o + 2] = data[s];
            else hsxToRgb(data[s] / 255, data[s + 1] / 255, data[s + 2] / 255, colorModel === 'untransformed6', out, o);
            break;
        default: throw new Error(`PGF: no way to show ${colorModel}`);
        }
    }
    return out;
}

async function toPng(rgba, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

async function decodePgf(bytes, level) {
    const { preHeader, header } = readHeader(bytes);
    const levels = Math.max(1, header.nLevels);
    if (level === 'thumb') {
        level = 0;
        while (level + 1 < levels) {
            const d = levelDimensions(header.width, header.height, level + 1);
            if (Math.max(d.width, d.height) < THUMB) break;
            level++;
        }
    }
    level = Math.max(0, Math.min(levels - 1, level | 0));
    // pgfjs counts the levels it reads, coarsest first
    const img = decode(bytes, level && header.nLevels ? { maxLevel: header.nLevels - 1 - level } : {});
    const rgba = toRgba(img);
    let label = `PGF, ${MODES[header.mode] || 'mode ' + header.mode}`;
    if (header.mode === 2 && !img.palette) label += ' (no color table: indices as gray)';
    if ([5, 6].includes(header.mode)) label += ` (${img.channels} channel${img.channels > 1 ? 's' : ''})`;
    if (header.mode === 10 || header.mode === 11 || header.mode === 12 || header.mode === 13 || header.mode === 18) {
        if (header.usedBitsPerChannel && header.usedBitsPerChannel !== header.bpp / header.channels) label += `, ${header.usedBitsPerChannel} bits used`;
    }
    label += header.quality ? `, quality ${header.quality} (lossy)` : ', lossless';
    label += `, ${header.nLevels} level${header.nLevels === 1 ? '' : 's'}`;
    if (preHeader.version & 8) label += ', regions of interest';
    return {
        png: await toPng(rgba, img.width, img.height), width: img.width, height: img.height,
        fullWidth: header.width, fullHeight: header.height, level, levels, label,
    };
}

self.onmessage = async ({ data }) => {
    const { id, bytes, level } = data;
    try {
        const result = await decodePgf(new Uint8Array(bytes), level);
        self.postMessage({ id, result }, [result.png.buffer]);
    } catch (err) {
        // pgfjs's errors say why at length: their first clause (a lossy black and white or
        // indexed picture is refused, its bits and indices don't survive quantizing)
        const why = err.code ? 'PGF: ' + err.message.split(/: |\. /)[0] : err.message || String(err);
        self.postMessage({ id, error: why });
    }
};
