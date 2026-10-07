// --- Radiance RGBE (.hdr, .rgbe, .xyze; a .pic that says so) ---
// No browser shows Radiance pictures, and they are HDR: a pixel is three
// floats, shared exponent (RGBE) or CIE XYZ (XYZE). The format is a text header
// and the scanlines, flat or run-length encoded (both of Radiance's encodings),
// simple enough to read here. The resolution line's orientation (-Y +X, +Y -X,
// +X -Y ...) is followed, and XYZE goes to RGB by the header's PRIMARIES
// (Radiance's own by default). For an <img> the floats are tone mapped to an
// sRGB PNG: times 2^exposure (in stops, 0 by default: the picture as stored,
// its EXPOSURE= already applied, as Radiance's ximage shows it), then clipped or
// compressed (Reinhard); the image viewer has a slider and a choice for both.
// .pic is also Macintosh PICT, Softimage, PC Paint...: only one that starts
// "#?RADIANCE" or "#?RGBE" is shown as a picture (isRadiance).
const { createLogger } = require('./debug');

const log = createLogger('RGBE');
const RGBE_RE = /\.(hdr|rgbe|xyze)$/i;
const PIC_RE = /\.pic$/i;
const STD_PRIMARIES = [0.640, 0.330, 0.290, 0.600, 0.150, 0.060, 1 / 3, 1 / 3]; // Radiance's

const files = new Map(); // source URL -> Promise<picture>
const toned = new Map(); // source URL + '#' + exposure + tone -> Promise<{ url, pages, label }>

function isRgbeName(name) {
    return RGBE_RE.test(name || '');
}

function isPicName(name) {
    return PIC_RE.test(name || '');
}

// Bytes that start a Radiance picture (what a .pic is shown for)
function isRadiance(bytes) {
    const s = new TextDecoder('latin1').decode(bytes.subarray(0, 10));
    return s.startsWith('#?RADIANCE') || s.startsWith('#?RGBE');
}

// The header's lines up to the blank one, and where the resolution line starts
function readHeader(bytes) {
    const lines = [];
    let pos = 0;
    for (;;) {
        if (pos >= bytes.length) throw new Error('Radiance header has no end');
        let end = pos;
        while (end < bytes.length && bytes[end] !== 10) end++;
        const line = new TextDecoder('latin1').decode(bytes.subarray(pos, end)).replace(/\r$/, '');
        pos = end + 1;
        if (!line) break;
        lines.push(line);
    }
    if (!lines.length || !lines[0].startsWith('#?')) throw new Error('not a Radiance picture');
    return { lines, pos };
}

// 3×3 matrix helpers, row major
function mul3(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return r;
}
function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
}

// CIE XYZ -> RGB of the primaries [xr yr xg yg xb yb xw yw] (white: Y = 1)
function xyzToRgbMatrix(p) {
    const col = (x, y) => [x / y, 1, (1 - x - y) / y];
    const r = col(p[0], p[1]), g = col(p[2], p[3]), b = col(p[4], p[5]), w = col(p[6], p[7]);
    const m = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
    const s = mul3(inv3(m), [w[0], 0, 0, w[1], 0, 0, w[2], 0, 0]);
    return inv3(m.map((v, k) => v * s[(k % 3) * 3]));
}

// One scanline of n pixels at pos into line (n × 4 bytes); returns where the next starts
function readScanline(bytes, pos, n, line) {
    if (n >= 8 && n < 0x8000 && bytes[pos] === 2 && bytes[pos + 1] === 2 && !(bytes[pos + 2] & 0x80)) {
        // run-length encoded, each component on its own
        if (((bytes[pos + 2] << 8) | bytes[pos + 3]) !== n) throw new Error('scanline length mismatch');
        pos += 4;
        for (let c = 0; c < 4; c++) {
            for (let i = 0; i < n;) {
                if (pos >= bytes.length) throw new Error('scanline cut short');
                let count = bytes[pos++];
                if (count > 128) {
                    count -= 128;
                    if (i + count > n) throw new Error('bad run length');
                    const v = bytes[pos++];
                    for (; count > 0; count--) line[(i++) * 4 + c] = v;
                } else {
                    if (!count || i + count > n) throw new Error('bad run length');
                    for (; count > 0; count--) line[(i++) * 4 + c] = bytes[pos++];
                }
            }
        }
        return pos;
    }
    // flat pixels, with the old encoding's runs: 1 1 1 n repeats the pixel
    // before n times (n << 8 for a second such pixel in a row, and so on)
    let shift = 0;
    for (let i = 0; i < n;) {
        if (pos + 4 > bytes.length) throw new Error('scanline cut short');
        const r = bytes[pos], g = bytes[pos + 1], b = bytes[pos + 2], e = bytes[pos + 3];
        pos += 4;
        if (r === 1 && g === 1 && b === 1 && i > 0) {
            let count = e << shift;
            if (i + count > n) count = n - i;
            for (; count > 0; count--, i++) line.copyWithin(i * 4, (i - 1) * 4, i * 4);
            shift += 8;
        } else {
            line[i * 4] = r;
            line[i * 4 + 1] = g;
            line[i * 4 + 2] = b;
            line[i * 4 + 3] = e;
            i++;
            shift = 0;
        }
    }
    return pos;
}

// The picture: { width, height, rgb (Float32Array, top row first, the header's
// EXPOSURE= and COLORCORR= as stored), xyz, exposure, orientation, label }
function rgbeDecode(bytes) {
    const { lines, pos: resPos } = readHeader(bytes);
    let format = '32-bit_rle_rgbe', exposure = 1, primaries = STD_PRIMARIES, software = '';
    for (const line of lines) {
        const m = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toUpperCase(), value = m[2].trim();
        if (key === 'FORMAT') format = value;
        else if (key === 'EXPOSURE') exposure *= parseFloat(value) || 1;
        else if (key === 'PRIMARIES') {
            const p = value.split(/\s+/).map(Number);
            if (p.length === 8 && p.every(Number.isFinite) && p[1] > 0 && p[3] > 0 && p[5] > 0 && p[7] > 0) primaries = p;
        } else if (key === 'SOFTWARE') software = value;
    }
    const xyz = /xyze/i.test(format);
    if (!xyz && !/rgbe/i.test(format)) throw new Error(`unsupported FORMAT=${format}`);
    // the resolution line: the slow axis, then the fast one, e.g. "-Y 480 +X 640"
    let end = resPos;
    while (end < bytes.length && bytes[end] !== 10) end++;
    const res = new TextDecoder('latin1').decode(bytes.subarray(resPos, end)).trim();
    const m = /^([-+])([XY])\s+(\d+)\s+([-+])([XY])\s+(\d+)$/.exec(res);
    if (!m || m[2] === m[5]) throw new Error(`bad resolution line "${res}"`);
    const slow = { sign: m[1], axis: m[2], size: +m[3] }, fast = { sign: m[4], axis: m[5], size: +m[6] };
    const width = slow.axis === 'X' ? slow.size : fast.size;
    const height = slow.axis === 'Y' ? slow.size : fast.size;
    if (!(width > 0 && height > 0)) throw new Error('empty picture');
    // where scanline s, pixel i lands: +Y runs bottom to top, -X right to left
    const coord = (a, k) => (a.axis === 'Y' ? (a.sign === '-' ? k : height - 1 - k) : (a.sign === '+' ? k : width - 1 - k));
    const fastStep = fast.axis === 'X' ? (fast.sign === '+' ? 1 : -1) : (fast.sign === '-' ? width : -width);

    const rgb = new Float32Array(width * height * 3);
    const line = new Uint8Array(fast.size * 4);
    const toRgb = xyz ? xyzToRgbMatrix(primaries) : null;
    let pos = end + 1;
    let s = 0;
    for (; s < slow.size && pos < bytes.length; s++) {
        try {
            pos = readScanline(bytes, pos, fast.size, line);
        } catch (err) {
            log.warn(`scanline ${s}: ${err.message}`);
            break; // shown as far as it goes
        }
        const c = coord(slow, s);
        let o = slow.axis === 'Y' ? c * width + coord(fast, 0) : coord(fast, 0) * width + c;
        for (let i = 0; i < fast.size; i++, o += fastStep) {
            const e = line[i * 4 + 3];
            let r = 0, g = 0, b = 0;
            if (e) {
                // m × 2^(e - 136), as most readers do (Radiance's own adds a
                // half to m, which greys a channel stored as 0)
                const f = Math.pow(2, e - 136);
                r = line[i * 4] * f;
                g = line[i * 4 + 1] * f;
                b = line[i * 4 + 2] * f;
                if (toRgb) {
                    const x = r, y = g, z = b;
                    r = toRgb[0] * x + toRgb[1] * y + toRgb[2] * z;
                    g = toRgb[3] * x + toRgb[4] * y + toRgb[5] * z;
                    b = toRgb[6] * x + toRgb[7] * y + toRgb[8] * z;
                }
            }
            rgb[o * 3] = r;
            rgb[o * 3 + 1] = g;
            rgb[o * 3 + 2] = b;
        }
    }
    if (!s) throw new Error('no scanlines');
    const label = `Radiance ${xyz ? 'XYZE' : 'RGBE'}, ${slow.sign}${slow.axis} ${fast.sign}${fast.axis}`
        + (exposure !== 1 ? `, EXPOSURE ${+exposure.toPrecision(4)}` : '') + (software ? `, ${software}` : '');
    return { width, height, rgb, xyz, exposure, orientation: `${slow.sign}${slow.axis} ${fast.sign}${fast.axis}`, label };
}

// linear 0..1 -> sRGB 0..255, in 16384 steps
let srgbLut = null;
function srgb(v) {
    if (!srgbLut) {
        srgbLut = new Uint8Array(16385);
        for (let i = 0; i <= 16384; i++) {
            const x = i / 16384;
            srgbLut[i] = Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
        }
    }
    return v <= 0 ? 0 : v >= 1 ? 255 : srgbLut[Math.round(v * 16384)];
}

// The picture as 8-bit sRGBA: times 2^exposure, then 'clip' (to 1) or
// 'reinhard' (by luminance, L / (1 + L))
function rgbeToneMap(pic, exposure = 0, tone = 'clip') {
    const { rgb } = pic;
    const n = pic.width * pic.height;
    const out = new Uint8ClampedArray(n * 4);
    const k = Math.pow(2, exposure);
    for (let i = 0, j = 0, o = 0; i < n; i++, j += 3, o += 4) {
        let r = rgb[j] * k, g = rgb[j + 1] * k, b = rgb[j + 2] * k;
        if (tone === 'reinhard') {
            const s = 1 / (1 + Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b));
            r *= s; g *= s; b *= s;
        }
        out[o] = srgb(r);
        out[o + 1] = srgb(g);
        out[o + 2] = srgb(b);
        out[o + 3] = 255;
    }
    return out;
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

function filePicture(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return rgbeDecode(new Uint8Array(await resp.arrayBuffer()));
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few pictures only: a new exposure tone maps again, it doesn't decode again
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// Whether the file at url is a Radiance picture (for a .pic)
async function isRadianceUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isRadiance(value);
}

// The Radiance picture at url, tone mapped: { url (a blob: URL of its PNG),
// width, height, label }
function rgbeImage(url, exposure = 0, tone = 'clip') {
    const key = `${url}#${exposure}#${tone}`;
    let p = toned.get(key);
    if (!p) {
        p = (async () => {
            const pic = await filePicture(url);
            const png = await rgbaToPng(rgbeToneMap(pic, exposure, tone), pic.width, pic.height);
            return { url: URL.createObjectURL(png), width: pic.width, height: pic.height, label: pic.label };
        })();
        toned.set(key, p);
        p.catch(err => { toned.delete(key); log.warn('Radiance decode failed:', err); });
        if (toned.size > 64) {
            const [oldKey, old] = toned.entries().next().value;
            toned.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// An exposure slider (stops) and the tone curve over an image viewer's <img>
// of the Radiance picture at url (root is the viewer's element, positioned);
// imageOf(url, exposure, tone) is how it is tone mapped, rgbeImage's for a
// Radiance picture (src/jxr.js's for a high dynamic range JPEG XR)
function addRgbeControls(root, img, url, imageOf = rgbeImage) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center;z-index:1;'
        + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const label = document.createElement('span');
    label.textContent = 'Exposure';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-10';
    slider.max = '10';
    slider.step = '0.25';
    slider.value = '0';
    slider.title = 'Exposure, in stops (double-click: 0)';
    slider.style.cssText = 'width:120px;';
    const value = document.createElement('span');
    value.style.cssText = 'min-width:3.5em;font-variant-numeric:tabular-nums;';
    const tone = document.createElement('select');
    tone.title = 'Tone curve';
    tone.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
    for (const [v, t] of [['clip', 'Clip'], ['reinhard', 'Reinhard']]) tone.add(new Option(t, v));
    bar.append(label, slider, value, tone);
    let turn = 0;
    let timer = null;
    const show = () => {
        const ev = +slider.value;
        value.textContent = (ev > 0 ? '+' : '') + ev + ' EV';
        const mine = ++turn;
        clearTimeout(timer);
        // while the slider moves, once it rests for a moment
        timer = setTimeout(async () => {
            try {
                const d = await imageOf(url, ev, tone.value);
                if (mine === turn) img.src = d.url;
            } catch (err) {
                if (mine === turn) value.textContent = err.message;
            }
        }, 60);
    };
    slider.oninput = show;
    slider.ondblclick = () => { slider.value = '0'; show(); };
    tone.onchange = show;
    imageOf(url).then(d => { bar.title = `${d.label}, ${d.width}×${d.height}`; }).catch(() => {});
    root.appendChild(bar);
    value.textContent = '0 EV';
    return bar;
}

module.exports = { isRgbeName, isPicName, isRadiance, isRadianceUrl, rgbeDecode, rgbeToneMap, rgbeImage, addRgbeControls, srgb, rgbaToPng };
