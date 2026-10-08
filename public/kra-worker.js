// Krita documents (.kra, and .krz, the same without the merged picture), read
// and composited in a worker, for the Krita viewer (src/kra-plugin.js). Written
// from Krita's sources: plugins/impex/libkra (the ZIP's layout and maindoc.xml),
// libs/image/tiles3 (KisTiledDataManager::read, KisTileCompressor2: tiles of
// 64 × 64 pixels, LZF-compressed, each byte of the pixel in its own plane) and
// libs/pigment/compositeops (how a layer's blending mode combines it with what is
// below it).
//
// The picture as saved is mergedimage.png, Krita's own composite; the viewer shows
// it until the layers are changed, then this worker composites them. Layers are
// kept in the image's colour space as Krita has them (RGB, 8 or 16 bits or float,
// linear or not), gray as RGB; CMYK and L*a*b* are turned into sRGB on reading,
// with simple formulas (no ICC profiles), so their composite is an approximation.
//   → { id, cmd: 'open', bytes }        ← { info, layers, thumbs, merged, svgs }
//   → { id, cmd: 'shapes', shapes }     ← { thumbs } (vector layers, drawn by the page)
//   → { id, cmd: 'render', changes }    ← { image }
//   → { id, cmd: 'layer', layerId }     ← { image } (one layer alone, image-sized)
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const TILE = 64;
const THUMB = 40;

// --- maindoc.xml: a small XML reader (workers have no DOMParser) ---

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#'
        ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
        : ENTITIES[e] !== undefined ? ENTITIES[e] : m);
}

// { name, attrs, children, text }
function parseXml(text) {
    const root = { name: '#document', attrs: {}, children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([^\s>/]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) top.text += m[1];
        else if (m[6] !== undefined) top.text += unescapeXml(m[6]);
        else if (m[3]) {
            if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
            const node = { name: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
            const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
            let a;
            while ((a = ar.exec(m[4]))) node.attrs[a[1]] = unescapeXml(a[2] !== undefined ? a[2] : a[3]);
            top.children.push(node);
            if (!m[5]) stack.push(node);
        }
    }
    return root;
}

function child(node, name) {
    const n = name.toLowerCase();
    return node && node.children.find(c => c.name.toLowerCase() === n);
}

// --- Tiles (libs/image/tiles3) ---

// KisLzfCompression's lzff_decompress (liblzf); 0 when the data doesn't fit
function lzf(src, start, end, out) {
    let ip = start, op = 0;
    const ipLimit = end - 1, opLimit = out.length;
    while (ip < ipLimit) {
        let ctrl = src[ip] + 1;
        const ofs = (src[ip] & 31) << 8;
        let len = src[ip++] >> 5;
        if (ctrl < 33) {
            if (op + ctrl > opLimit) return 0;
            while (ctrl--) out[op++] = src[ip++];
        } else {
            len--;
            let ref = op - ofs - 1;
            if (len === 6) len += src[ip++];
            ref -= src[ip++];
            if (op + len + 3 > opLimit || ref < 0) return 0;
            for (let k = len + 3; k > 0; k--) out[op++] = out[ref++];
        }
    }
    return op;
}

function readLine(bytes, pos) {
    let e = pos;
    while (e < bytes.length && bytes[e] !== 10) e++;
    let s = '';
    for (let i = pos; i < e; i++) s += String.fromCharCode(bytes[i]);
    return { line: s.trim(), next: e + 1 };
}

// A paint device's tiles: [{ x, y, data (64 × 64 pixels, pixelSize bytes each) }].
// "VERSION 2" files (Krita 2 on) are KisTileCompressor2's; older ones start with
// the number of tiles, each a "x,y,w,h" line and the raw tile (KisLegacyTileCompressor).
function readTiles(bytes, pixelSize) {
    let { line, next } = readLine(bytes, 0);
    const tiles = [];
    const tileSize = TILE * TILE * pixelSize;
    if (line.startsWith('VERSION')) {
        const version = +line.split(/\s+/)[1];
        if (version !== 2) throw new Error(`tile data version ${version} is not supported`);
        let count = 0;
        for (;;) {
            ({ line, next } = readLine(bytes, next));
            const [key, value] = line.split(/\s+/);
            if (key === 'TILEWIDTH' && +value !== TILE) throw new Error('tiles not 64 pixels wide');
            if (key === 'TILEHEIGHT' && +value !== TILE) throw new Error('tiles not 64 pixels high');
            if (key === 'PIXELSIZE' && +value !== pixelSize) throw new Error(`${value} bytes a pixel where ${pixelSize} were expected`);
            if (key === 'DATA') { count = +value; break; }
            if (next >= bytes.length) throw new Error('no tile data');
        }
        const plane = new Uint8Array(tileSize);
        const n = TILE * TILE;
        for (let t = 0; t < count && next < bytes.length; t++) {
            ({ line, next } = readLine(bytes, next));
            const [x, y, method, size] = line.split(',');
            if (method !== 'LZF') throw new Error(`tile compression ${method} is not supported`);
            const start = next, end = next + +size;
            next = end;
            const data = new Uint8Array(tileSize);
            if (bytes[start] === 1) {
                // compressed: byte k of every pixel together, delinearized here
                if (lzf(bytes, start + 1, end, plane) !== tileSize) throw new Error('a damaged tile');
                for (let p = 0, o = 0; p < n; p++) for (let c = 0; c < pixelSize; c++) data[o++] = plane[c * n + p];
            } else {
                data.set(bytes.subarray(start + 1, start + 1 + tileSize));
            }
            tiles.push({ x: +x, y: +y, data });
        }
    } else {
        const count = parseInt(line, 10);
        for (let t = 0; t < count && next < bytes.length; t++) {
            ({ line, next } = readLine(bytes, next));
            const [x, y] = line.split(',').map(Number);
            tiles.push({ x, y, data: bytes.slice(next, next + tileSize) });
            next += tileSize;
        }
    }
    return tiles;
}

// --- Colour spaces (Krita's ids, as in colorspacename) ---

function half(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
}

const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toSrgb = v => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

// CIE L*a*b* (D50) to sRGB, 0..1
function labToSrgb(L, a, b, out) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const fi = t => t > 6 / 29 ? t * t * t : (116 * t - 16) * 27 / 24389;
    const X = 0.9642 * fi(fx), Y = fi(fy), Z = 0.8249 * fi(fz);
    out[0] = clamp01(toSrgb(3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z));
    out[1] = clamp01(toSrgb(-0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z));
    out[2] = clamp01(toSrgb(0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z));
}

// For each colour space: its model, depth, pixel size and how a pixel becomes RGBA
// (channel values 0..1, or beyond for floats). Krita keeps 8 and 16-bit RGB as
// BGRA (KoBgrU8Traits, KoBgrU16Traits), float RGB as RGBA, gray as gray + alpha,
// CMYK as C, M, Y, K, A (ink, 0 none), L*a*b* as L, a, b, A.
const T = [0, 0, 0];
function colorSpace(id) {
    const u8 = (d, o) => d.getUint8(o) / 255, u16 = (d, o) => d.getUint16(o, true) / 65535;
    const f16 = (d, o) => half(d.getUint16(o, true)), f32 = (d, o) => d.getFloat32(o, true);
    const depths = { U8: [1, u8, '8-bit integer'], U16: [2, u16, '16-bit integer'], F16: [2, f16, '16-bit float'], F32: [4, f32, '32-bit float'] };
    const make = (model, depth, read) => {
        const [n, get, depthName] = depths[depth];
        return { id, model, depth, depthName, float: depth[0] === 'F', pixelSize: n * (model === 'CMYK' ? 5 : model === 'GRAY' ? 2 : 4), read: read(n, get) };
    };
    switch (id) {
        case 'RGBA': return make('RGB', 'U8', (n, g) => (d, o, p) => { p[0] = g(d, o + 2); p[1] = g(d, o + 1); p[2] = g(d, o); p[3] = g(d, o + 3); });
        case 'RGBA16': return make('RGB', 'U16', (n, g) => (d, o, p) => { p[0] = g(d, o + 4); p[1] = g(d, o + 2); p[2] = g(d, o); p[3] = g(d, o + 6); });
        case 'RGBAF16': return make('RGB', 'F16', (n, g) => (d, o, p) => { p[0] = g(d, o); p[1] = g(d, o + 2); p[2] = g(d, o + 4); p[3] = g(d, o + 6); });
        case 'RGBAF32': return make('RGB', 'F32', (n, g) => (d, o, p) => { p[0] = g(d, o); p[1] = g(d, o + 4); p[2] = g(d, o + 8); p[3] = g(d, o + 12); });
        case 'GRAYA': case 'GRAYAU16': case 'GRAYAF16': case 'GRAYAF32':
            return make('GRAY', { GRAYA: 'U8', GRAYAU16: 'U16', GRAYAF16: 'F16', GRAYAF32: 'F32' }[id],
                (n, g) => (d, o, p) => { p[0] = p[1] = p[2] = g(d, o); p[3] = g(d, o + n); });
        case 'CMYK': case 'CMYKA16': case 'CMYKAF32': {
            // CMYK floats run 0..100 for ink in Krita 5 (KoCmykF32Traits), alpha 0..1
            const inkScale = id === 'CMYKAF32' ? 0.01 : 1;
            return make('CMYK', { CMYK: 'U8', CMYKA16: 'U16', CMYKAF32: 'F32' }[id], (n, g) => (d, o, p) => {
                const k = 1 - clamp01(g(d, o + 3 * n) * inkScale);
                p[0] = (1 - clamp01(g(d, o) * inkScale)) * k;
                p[1] = (1 - clamp01(g(d, o + n) * inkScale)) * k;
                p[2] = (1 - clamp01(g(d, o + 2 * n) * inkScale)) * k;
                p[3] = g(d, o + 4 * n);
            });
        }
        case 'LABAU8': case 'LABA': case 'LABAF32': {
            const depth = { LABAU8: 'U8', LABA: 'U16', LABAF32: 'F32' }[id];
            return make('LAB', depth, (n, g) => (d, o, p) => {
                const v = k => g(d, o + k * n);
                // integers: L 0..100 over the range, a and b centred on half of it (lcms' encoding)
                if (depth === 'F32') labToSrgb(v(0), v(1), v(2), T);
                else labToSrgb(v(0) * 100, v(1) * 255 - 128, v(2) * 255 - 128, T);
                p[0] = T[0]; p[1] = T[1]; p[2] = T[2]; p[3] = v(3);
            });
        }
        default: return null;
    }
}

const MODEL_NAMES = { RGB: 'RGB', GRAY: 'Grayscale', CMYK: 'CMYK', LAB: 'L*a*b*' };
const UNSUPPORTED_SPACES = { XYZ: 'XYZ', YCbCr: 'YCbCr' };

// --- Blending modes (KoCompositeOpRegistry ids → libs/pigment/compositeops) ---

const hardLight = (s, d) => s === 0.5 ? d : s > 0.5 ? (2 * s - 1) + d - (2 * s - 1) * d : 2 * s * d;
const burn = (s, d) => d >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / s);
const dodge = (s, d) => s >= 1 ? (d <= 0 ? 0 : 1) : Math.min(1, d / (1 - s));
const gammaDark = (s, d) => d <= 0 ? 0 : d >= 1 ? 1 : s <= 0 ? 0 : d ** (1 / s);
const softLight = (s, d) => s > 0.5 ? d + (2 * s - 1) * (Math.sqrt(d) - d) : d - (1 - 2 * s) * d * (1 - d);
// [id, name, f(src, dst) for each colour channel]
const SEPARABLE = [
    ['normal', 'Normal', s => s],
    ['multiply', 'Multiply', (s, d) => s * d],
    ['screen', 'Screen', (s, d) => s + d - s * d],
    ['overlay', 'Overlay', (s, d) => hardLight(d, s)],
    ['darken', 'Darken', Math.min],
    ['lighten', 'Lighten', Math.max],
    ['burn', 'Color Burn', burn],
    ['dodge', 'Color Dodge', dodge],
    ['linear_burn', 'Linear Burn', (s, d) => s + d - 1],
    ['linear_dodge', 'Linear Dodge', (s, d) => s + d],
    ['add', 'Addition', (s, d) => s + d],
    ['subtract', 'Subtract', (s, d) => d - s],
    ['inverse_subtract', 'Inversed-Subtract', (s, d) => d - (1 - s)],
    ['diff', 'Difference', (s, d) => Math.abs(s - d)],
    ['exclusion', 'Exclusion', (s, d) => d + s - 2 * s * d],
    ['divide', 'Divide', (s, d) => d <= 0 ? 0 : s <= 0 ? 1 : d / s],
    ['hard_light', 'Hard Light', hardLight],
    ['soft_light', 'Soft Light (Photoshop)', softLight],
    ['soft_light_svg', 'Soft Light (SVG)', (s, d) => s > 0.5 ? d + (2 * s - 1) * ((d > 0.25 ? Math.sqrt(d) : ((16 * d - 12) * d + 4) * d) - d) : d - (1 - 2 * s) * d * (1 - d)],
    ['vivid_light', 'Vivid Light', (s, d) => s < 0.5 ? (s <= 0 ? (d >= 1 ? 1 : 0) : 1 - (1 - d) / (2 * s)) : s >= 1 ? (d <= 0 ? 0 : 1) : d / (2 * (1 - s))],
    ['linear light', 'Linear Light', (s, d) => 2 * s + d - 1],
    ['pin_light', 'Pin Light', (s, d) => Math.max(2 * s - 1, Math.min(d, 2 * s))],
    ['hard mix', 'Hard Mix', (s, d) => d > 0.5 ? dodge(s, d) : burn(s, d)],
    ['hard_mix_photoshop', 'Hard Mix (Photoshop)', (s, d) => s + d > 1 ? 1 : 0],
    ['grain_merge', 'Grain Merge', (s, d) => d + s - 0.5],
    ['grain_extract', 'Grain Extract', (s, d) => d - s + 0.5],
    ['allanon', 'Allanon', (s, d) => (s + d) / 2],
    ['geometric_mean', 'Geometric Mean', (s, d) => Math.sqrt(s * d)],
    ['parallel', 'Parallel', (s, d) => s <= 0 || d <= 0 ? 0 : 2 / (1 / s + 1 / d)],
    ['arc_tangent', 'Arcus Tangent', (s, d) => 2 * Math.atan2(s, d) / Math.PI],
    ['equivalence', 'Equivalence', (s, d) => Math.abs(d - s)],
    ['additive_subtractive', 'Additive-Subtractive', (s, d) => Math.abs(Math.sqrt(d) - Math.sqrt(s))],
    ['gamma_dark', 'Gamma Dark', gammaDark],
    ['gamma_light', 'Gamma Light', (s, d) => d <= 0 ? 0 : d >= 1 ? 1 : d ** s],
    ['gamma_illumination', 'Gamma Illumination', (s, d) => 1 - gammaDark(1 - s, 1 - d)],
];

// HSY (luma 0.299, 0.587, 0.114) as KoColorSpaceMaths has it, with its tone mapping
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
// An RGB colour (linear, or sRGB-encoded) as a gray image's gray: its luminance, in the image's tone curve
function grayOf(r, g, b, linear) {
    const f = linear ? (v => v) : toLinear;
    const y = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    return linear ? y : toSrgb(y);
}
function toneMap(c) {
    const l = luma(c[0], c[1], c[2]);
    const n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
    if (n < 0) {
        const s = l - n;
        if (l <= 0 || s < 1e-7) c[0] = c[1] = c[2] = 0;
        else for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * l / s;
    }
    if (x > 1) {
        const s = x - l;
        if (l > 1 || s < 1e-7) c[0] = c[1] = c[2] = 1;
        else for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * (1 - l) / s;
    }
}
function setLuma(c, l) {
    const d = l - luma(c[0], c[1], c[2]);
    c[0] += d; c[1] += d; c[2] += d;
    toneMap(c);
}
const satOf = c => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c, sat) {
    let lo = 0, mid = 1, hi = 2;
    if (c[mid] < c[lo]) [lo, mid] = [mid, lo];
    if (c[hi] < c[mid]) [mid, hi] = [hi, mid];
    if (c[mid] < c[lo]) [lo, mid] = [mid, lo];
    if (c[hi] - c[lo] > 1e-7) {
        c[mid] = (c[mid] - c[lo]) * sat / (c[hi] - c[lo]);
        c[hi] = sat;
        c[lo] = 0;
    } else c[0] = c[1] = c[2] = 0;
}
// [id, name, f(src rgb, dst rgb → result in dst)]
const NONSEPARABLE = [
    ['color', 'Color', (s, d) => { const l = luma(d[0], d[1], d[2]); d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; setLuma(d, l); }],
    ['hue', 'Hue', (s, d) => { const sat = satOf(d), l = luma(d[0], d[1], d[2]); d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; setSat(d, sat); setLuma(d, l); }],
    ['saturation', 'Saturation', (s, d) => { const l = luma(d[0], d[1], d[2]); setSat(d, satOf(s)); setLuma(d, l); }],
    ['luminize', 'Luminosity', (s, d) => setLuma(d, luma(s[0], s[1], s[2]))],
    ['tint', 'Tint', (s, d) => { const l = luma(d[0], d[1], d[2]); for (let i = 0; i < 3; i++) d[i] = l + s[i] * (1 - l); }],
];

// The rest work on alpha (KoCompositeOpErase, ...Behind, ...DestinationIn)
const SPECIAL = [['erase', 'Erase'], ['behind', 'Behind'], ['destination-in', 'Destination In'], ['alphadarken', 'Alpha Darken'], ['copy', 'Copy']];

const MODES = new Map();
for (const [id, name, f] of SEPARABLE) MODES.set(id, { id, name, f });
for (const [id, name, hsl] of NONSEPARABLE) MODES.set(id, { id, name, hsl });
for (const [id, name] of SPECIAL) MODES.set(id, { id, name, special: true });

// --- The document ---

let doc = null;

function entryText(zip, name) {
    const e = zip[name];
    return e ? new TextDecoder().decode(e) : null;
}

// zip entry of a layer's file: "<image name>/layers/<file>" (the image's name as saved, which may differ from maindoc's)
function layerEntry(zip, file) {
    const suffix = '/layers/' + file;
    for (const name of Object.keys(zip)) if (name.endsWith(suffix)) return zip[name];
    return null;
}

// A paint device: pixels over its tiles' extent, in storage units, and the default
// pixel everywhere else. Integers are kept as integers (memory), floats as floats.
function readDevice(bytes, cs, defaultPixel, linear) {
    const tiles = readTiles(bytes, cs.pixelSize);
    const p = [0, 0, 0, 0];
    const def = [0, 0, 0, 0];
    if (defaultPixel && defaultPixel.length >= cs.pixelSize) {
        cs.read(new DataView(defaultPixel.buffer, defaultPixel.byteOffset, defaultPixel.byteLength), 0, def);
        if (linear && (cs.model === 'CMYK' || cs.model === 'LAB')) for (let i = 0; i < 3; i++) def[i] = toLinear(def[i]);
    }
    if (!tiles.length) return { x: 0, y: 0, w: 0, h: 0, data: null, scale: 1, def };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tiles) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x + TILE); y1 = Math.max(y1, t.y + TILE); }
    const w = x1 - x0, h = y1 - y0;
    const derived = cs.model === 'CMYK' || cs.model === 'LAB';
    const Store = cs.float ? Float32Array : cs.depth === 'U16' ? Uint16Array : Uint8Array;
    const scale = cs.float ? 1 : cs.depth === 'U16' ? 65535 : 255;
    const data = new Store(w * h * 4);
    const fill = def.map(v => cs.float ? v : Math.round(clamp01(v) * scale));
    for (let i = 0; i < data.length; i += 4) { data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3]; }
    for (const t of tiles) {
        const dv = new DataView(t.data.buffer, t.data.byteOffset, t.data.byteLength);
        for (let ty = 0; ty < TILE; ty++) {
            let o = ((t.y - y0 + ty) * w + (t.x - x0)) * 4;
            let s = ty * TILE * cs.pixelSize;
            for (let tx = 0; tx < TILE; tx++, o += 4, s += cs.pixelSize) {
                cs.read(dv, s, p);
                if (derived && linear) for (let i = 0; i < 3; i++) p[i] = toLinear(p[i]);
                if (cs.float) { data[o] = p[0]; data[o + 1] = p[1]; data[o + 2] = p[2]; data[o + 3] = p[3]; }
                else { data[o] = Math.round(clamp01(p[0]) * scale); data[o + 1] = Math.round(clamp01(p[1]) * scale); data[o + 2] = Math.round(clamp01(p[2]) * scale); data[o + 3] = Math.round(clamp01(p[3]) * scale); }
            }
        }
    }
    return { x: x0, y: y0, w, h, data, scale: 1 / scale, def };
}

// A selection (transparency mask, filter layer's area): one byte a pixel, 0..1
function readSelection(bytes, defaultPixel) {
    const tiles = readTiles(bytes, 1);
    const def = defaultPixel && defaultPixel.length ? defaultPixel[0] / 255 : 0;
    if (!tiles.length) return { x: 0, y: 0, w: 0, h: 0, data: null, def };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tiles) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x + TILE); y1 = Math.max(y1, t.y + TILE); }
    const w = x1 - x0, h = y1 - y0;
    const data = new Uint8Array(w * h).fill(Math.round(def * 255));
    for (const t of tiles) for (let ty = 0; ty < TILE; ty++) data.set(t.data.subarray(ty * TILE, ty * TILE + TILE), (t.y - y0 + ty) * w + (t.x - x0));
    return { x: x0, y: y0, w, h, data, def };
}

// The keyframe in effect at the document's current time: { frame (file), x, y }
function activeKeyframe(zip, layerFile, keyframesFile, time) {
    const text = layerEntry(zip, keyframesFile);
    if (!text) return null;
    const root = parseXml(new TextDecoder().decode(text));
    const kf = child(root, 'keyframes');
    const content = kf && kf.children.find(c => c.name === 'channel' && c.attrs.name === 'content');
    if (!content) return null;
    let best = null;
    for (const k of content.children) {
        if (k.name !== 'keyframe') continue;
        const t = +k.attrs.time;
        if (t <= time && (!best || t > best.time)) best = { time: t, node: k };
    }
    if (!best) best = { node: content.children.find(c => c.name === 'keyframe') };
    if (!best.node) return null;
    const off = child(best.node, 'offset');
    return { frame: best.node.attrs.frame || layerFile, x: off ? +off.attrs.x : null, y: off ? +off.attrs.y : null, time: best.time };
}

const NODE_TYPES = {
    paintlayer: 'paint', grouplayer: 'group', shapelayer: 'vector', clonelayer: 'clone', adjustmentlayer: 'filter',
    generatorlayer: 'fill', filelayer: 'file', referenceimageslayer: 'reference',
    transparencymask: 'transparency mask', filtermask: 'filter mask', selectionmask: 'selection mask',
    transformmask: 'transform mask', colorizemask: 'colorize mask',
};

// Filters Krita's filter layers name that are applied here (the rest are listed, not applied)
const FILTERS = {
    invert: (p) => { p[0] = 1 - p[0]; p[1] = 1 - p[1]; p[2] = 1 - p[2]; },
    desaturate: (p) => { const l = luma(p[0], p[1], p[2]); p[0] = p[1] = p[2] = l; },
};

function buildNodes(container, zip, ctx, depth, out) {
    const list = [];
    for (const el of container.children) {
        if (el.name !== 'layer' && el.name !== 'mask') continue;
        const a = el.attrs;
        const type = a.nodetype || a.layertype || (el.name === 'mask' ? 'mask' : 'paintlayer');
        const node = {
            id: ctx.nextId++, name: a.name || '', type, kind: NODE_TYPES[type] || type, depth,
            visible: a.visible !== '0', opacity: a.opacity !== undefined ? +a.opacity / 255 : 1,
            mode: a.compositeop || 'normal', x: +a.x || 0, y: +a.y || 0, file: a.filename || '',
            colorSpace: a.colorspacename || ctx.colorSpace, passthrough: a.passthrough === '1',
            collapsed: a.collapsed === '1', locked: a.locked === '1', uuid: a.uuid || '',
            alphaLocked: false, masks: [], children: null, problem: '', note: '',
        };
        out.push(node);
        // channelflags: one per channel ("" all); alpha off is Krita's "inherit alpha"
        const flags = a.channelflags || '';
        if (flags.length) {
            const cs = colorSpace(node.colorSpace) || colorSpace(ctx.colorSpace);
            const alphaPos = cs && cs.model === 'CMYK' ? 4 : cs && cs.model === 'GRAY' ? 1 : 3;
            if (flags[alphaPos] === '0') node.alphaLocked = true;
            if (flags.replace(/1/g, '').length > (node.alphaLocked ? 1 : 0)) node.note = 'some colour channels are off in Krita; shown with all on';
        }
        if (!MODES.has(node.mode)) node.problem = `blending mode "${node.mode}" is drawn as Normal here`;
        try {
            loadNode(node, el, a, zip, ctx);
        } catch (err) {
            node.problem = err.message;
            node.broken = true;
        }
        const kids = child(el, 'layers');
        if (node.kind === 'group') node.children = kids ? buildNodes(kids, zip, ctx, depth + 1, out) : [];
        const masks = child(el, 'masks');
        if (masks) node.masks = buildNodes(masks, zip, ctx, depth + 1, out);
        // Krita 1.x: a layer's mask in "<file>.mask"
        if (a.hasmask === '1') node.note = (node.note ? node.note + '; ' : '') + 'a Krita 1 mask, not applied';
        list.push(node);
    }
    return list;
}

// A colour fill's colour (its generator's "color" parameter): KoColor's XML, as
// KisPropertiesConfiguration::getColor reads it; else a QColor name ("#rrggbb"),
// else black, as Krita draws it then
function fillColor(config, ctx) {
    const root = parseXml(config);
    const params = child(root, 'params');
    const param = params && params.children.find(c => c.name === 'param' && c.attrs.name === 'color');
    if (!param) return null;
    const text = param.text.trim();
    let rgba = [0, 0, 0, 1], srgb = true;
    if (text.startsWith('<')) {
        const color = child(parseXml(text), 'color');
        const e = color && color.children[0];
        if (e && (e.name === 'RGB' || e.name === 'Gray')) {
            rgba = e.name === 'RGB' ? [+e.attrs.r, +e.attrs.g, +e.attrs.b, 1] : [+e.attrs.g, +e.attrs.g, +e.attrs.g, 1];
            srgb = !/g10|linear|scrgb/i.test(e.attrs.space || '');
        }
    } else {
        const m = /^#([0-9a-f]{6})$/i.exec(text);
        if (m) rgba = [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16) / 255).concat(1);
    }
    if (rgba.some(x => !Number.isFinite(x))) return null;
    if (ctx.linear && srgb) for (let i = 0; i < 3; i++) rgba[i] = toLinear(rgba[i]);
    else if (!ctx.linear && !srgb) for (let i = 0; i < 3; i++) rgba[i] = toSrgb(clamp01(rgba[i]));
    const cs = colorSpace(ctx.colorSpace);
    if (cs && cs.model === 'GRAY') rgba[0] = rgba[1] = rgba[2] = grayOf(rgba[0], rgba[1], rgba[2], ctx.linear);
    return rgba;
}

function loadNode(node, el, a, zip, ctx) {
    const def = name => layerEntry(zip, name + '.defaultpixel');
    switch (node.kind) {
        case 'paint': {
            const cs = colorSpace(node.colorSpace);
            if (!cs) throw new Error(`colour space ${node.colorSpace} is not supported`);
            node.depthName = cs.depthName;
            let file = node.file;
            if (a.keyframes) {
                const k = activeKeyframe(zip, node.file, a.keyframes, ctx.time);
                if (k) {
                    file = k.frame;
                    if (k.x !== null) { node.x = k.x; node.y = k.y; }
                    node.note = `animated: the frame at ${k.time !== undefined ? k.time : 0}`;
                }
            }
            const bytes = layerEntry(zip, file);
            if (!bytes) throw new Error('its pixels are missing from the file');
            node.device = readDevice(bytes, cs, def(file), ctx.linear);
            break;
        }
        case 'vector': {
            const svg = layerEntry(zip, node.file + '.shapelayer/content.svg');
            if (svg) ctx.svgs[node.id] = new TextDecoder().decode(svg);
            else node.problem = 'its shapes are not in SVG (an older Krita file); not drawn';
            break;
        }
        case 'clone':
            node.cloneFrom = a.clonefromuuid || '';
            node.cloneFromName = a.clonefrom || '';
            break;
        case 'filter': {
            node.filter = a.filtername || '';
            if (!FILTERS[node.filter]) node.problem = `filter "${node.filter}" is not applied here`;
            const sel = layerEntry(zip, node.file + '.pixelselection') ? node.file + '.pixelselection' : node.file + '.selection';
            const bytes = layerEntry(zip, sel);
            node.selection = bytes ? readSelection(bytes, def(sel)) : null;
            break;
        }
        case 'transparency mask': {
            const sel = node.file + '.pixelselection';
            const bytes = layerEntry(zip, sel);
            if (!bytes) throw new Error('its pixels are missing from the file');
            node.selection = readSelection(bytes, def(sel));
            break;
        }
        case 'fill': {
            node.generator = a.generatorname || '';
            const config = layerEntry(zip, node.file + '.filterconfig');
            node.color = node.generator === 'color' && config ? fillColor(new TextDecoder().decode(config), ctx) : null;
            if (!node.color) node.problem = `fill layer ("${node.generator || '?'}") is not drawn here`;
            const sel = node.file + '.pixelselection';
            const bytes = layerEntry(zip, sel);
            node.selection = bytes ? readSelection(bytes, def(sel)) : null;
            break;
        }
        case 'file': node.problem = `file layer (${a.source || '?'}) is not loaded here`; break;
        case 'group': break;
        case 'selection mask': break;
        default:
            if (node.kind.endsWith('mask')) node.problem = `${node.kind} is not applied here`;
            else node.problem = `${node.kind} layers are not drawn here`;
    }
}

function openKra(bytes) {
    const zip = fflate.unzipSync(bytes, { filter: f => !/(^|\/)annotations\/|\.icc$/.test(f.name) });
    const mime = entryText(zip, 'mimetype');
    const main = entryText(zip, 'maindoc.xml');
    if (!main) throw new Error(mime && !/krita/.test(mime) ? `not a Krita document (${mime.trim()})` : 'not a Krita document (no maindoc.xml)');
    const xml = parseXml(main);
    const docEl = child(xml, 'DOC');
    const img = child(docEl, 'IMAGE');
    if (!img) throw new Error('maindoc.xml has no image');
    const a = img.attrs;
    const width = +a.width, height = +a.height;
    const csId = a.colorspacename || 'RGBA';
    const cs = colorSpace(csId);
    const profile = a.profile || '';
    // linear RGB profiles (Krita's own "...-g10.icc", scRGB) are composited linear, as Krita does
    const rgb = !!cs && (cs.model === 'RGB' || cs.model === 'GRAY');
    const linear = rgb && /g10|linear|scrgb/i.test(profile);
    // ...and Rec. 2100 PQ ones in PQ; shown as sRGB, the wide gamut clipped
    const pq = rgb && /\bPQ\b|2084|perceptual quantizer/i.test(profile);
    const display = {
        transfer: pq ? 'pq' : linear ? 'linear' : 'srgb',
        gamut: cs && cs.model === 'RGB' && (pq || linear) && /2020|2100/.test(profile) ? REC2020_TO_709 : null,
    };
    const anim = child(img, 'animation');
    const time = anim && child(anim, 'currentTime') ? +child(anim, 'currentTime').attrs.value || 0 : 0;
    const ctx = { nextId: 1, colorSpace: csId, linear, time, svgs: {} };
    const all = [];
    const layersEl = child(img, 'layers');
    const tree = layersEl ? buildNodes(layersEl, zip, ctx, 0, all) : [];
    const byUuid = new Map(all.filter(n => n.uuid).map(n => [n.uuid, n]));
    for (const n of all) {
        if (n.kind !== 'clone') continue;
        n.source = byUuid.get(n.cloneFrom) || all.find(m => m.name === n.cloneFromName && m.kind !== 'clone');
        if (!n.source) n.problem = 'the layer it clones is missing';
        else if (n.source.kind === 'group') n.problem = 'clones of groups are not drawn here';
    }

    const info = {
        width, height, colorSpace: csId,
        model: cs ? MODEL_NAMES[cs.model] : (Object.keys(UNSUPPORTED_SPACES).find(k => csId.startsWith(k)) || csId),
        depth: cs ? cs.depthName : '', profile, linear,
        resolution: a['x-res'] ? [+a['x-res'], +a['y-res']] : null,
        name: a.name || '', description: a.description || '',
        kritaVersion: docEl.attrs.kritaVersion || '', syntaxVersion: docEl.attrs.syntaxVersion || '',
        approximate: !!cs && (cs.model === 'CMYK' || cs.model === 'LAB' || pq),
        modes: [...MODES.values()].map(m => [m.id, m.name]),
    };
    if (anim) {
        const range = child(anim, 'range'), rate = child(anim, 'framerate');
        if (range) info.animation = `frames ${range.attrs.from}–${range.attrs.to}${rate ? ` at ${rate.attrs.value} fps` : ''}, shown at ${time}`;
    }
    const docInfo = entryText(zip, 'documentinfo.xml');
    if (docInfo) {
        const di = parseXml(docInfo);
        const root = di.children.find(c => /document-info/i.test(c.name));
        const about = root && child(root, 'about'), author = root && child(root, 'author');
        const text = (node, name) => { const c = child(node, name); return c ? c.text.trim() : ''; };
        if (about) { info.title = text(about, 'title'); info.created = text(about, 'creation-date'); info.edited = text(about, 'date'); info.abstract = text(about, 'abstract'); }
        if (author) info.author = text(author, 'full-name') || text(author, 'creator');
    }
    // the image's background colour (Image > Properties), under all its layers
    let background = null;
    const bg = child(img, 'ProjectionBackgroundColor');
    if (cs && bg && bg.attrs.ColorData) {
        const raw = Uint8Array.from(atob(bg.attrs.ColorData), ch => ch.charCodeAt(0));
        if (raw.length >= cs.pixelSize) {
            background = [0, 0, 0, 0];
            cs.read(new DataView(raw.buffer), 0, background);
            if (!(background[3] > 0)) background = null;
            else info.background = `rgba(${background.slice(0, 3).map(v => Math.round(clamp01(v) * 255)).join(', ')}, ${+background[3].toFixed(2)})`;
        }
    }
    doc = { width, height, linear, display, background, tree, all, byId: new Map(all.map(n => [n.id, n])), cs, zip };
    const merged = zip['mergedimage.png'] || null;
    if (!merged && !cs) throw new Error(`colour space ${csId} is not supported, and the file has no merged image`);
    return { info, merged, svgs: ctx.svgs };
}

// --- Compositing ---
// A region is a grid of image positions (xs × ys): the image's rows a band at a
// time, or a thumbnail's samples. Buffers hold RGBA floats, not premultiplied.

function sampleDevice(dev, ox, oy, xs, ys, buf) {
    const n = xs.length;
    const d = dev.data, s = dev.scale, def = dev.def;
    for (let j = 0; j < ys.length; j++) {
        const ly = ys[j] - oy - dev.y;
        const inRow = d && ly >= 0 && ly < dev.h;
        let o = j * n * 4;
        for (let i = 0; i < n; i++, o += 4) {
            const lx = xs[i] - ox - dev.x;
            if (inRow && lx >= 0 && lx < dev.w) {
                const k = (ly * dev.w + lx) * 4;
                buf[o] = d[k] * s; buf[o + 1] = d[k + 1] * s; buf[o + 2] = d[k + 2] * s; buf[o + 3] = d[k + 3] * s;
            } else {
                buf[o] = def[0]; buf[o + 1] = def[1]; buf[o + 2] = def[2]; buf[o + 3] = def[3];
            }
        }
    }
}

function sampleSelection(sel, ox, oy, xs, ys, buf) {
    const n = xs.length;
    for (let j = 0; j < ys.length; j++) {
        const ly = ys[j] - oy - sel.y;
        const inRow = sel.data && ly >= 0 && ly < sel.h;
        for (let i = 0; i < n; i++) {
            const lx = xs[i] - ox - sel.x;
            buf[j * n + i] = inRow && lx >= 0 && lx < sel.w ? sel.data[ly * sel.w + lx] / 255 : sel.def;
        }
    }
}

function effective(node, changes) {
    const c = changes[node.id] || {};
    return {
        visible: c.visible !== undefined ? c.visible : node.visible,
        opacity: c.opacity !== undefined ? c.opacity : node.opacity,
        mode: c.mode !== undefined ? c.mode : node.mode,
    };
}

// What a node puts down (its own pixels, before opacity and blending), or null
function nodePixels(node, region, dst, changes) {
    const { xs, ys } = region;
    const n = xs.length * ys.length;
    switch (node.kind) {
        case 'paint':
        case 'vector': {
            if (!node.device) return null;
            const buf = new Float32Array(n * 4);
            sampleDevice(node.device, node.x, node.y, xs, ys, buf);
            return buf;
        }
        case 'clone': {
            const src = node.source;
            if (!src || !src.device) return null;
            const buf = new Float32Array(n * 4);
            // the clone shows its source with the source's masks, moved by its own offset
            sampleDevice(src.device, src.x + node.x, src.y + node.y, xs, ys, buf);
            applyMasks(src, buf, { xs: xs.map(x => x - node.x), ys: ys.map(y => y - node.y) }, changes);
            return buf;
        }
        case 'group': {
            const buf = new Float32Array(n * 4);
            compose(node.children, buf, region, changes);
            return buf;
        }
        case 'filter': {
            const f = FILTERS[node.filter];
            if (!f) return null;
            // the filter applied to what is below it, in the layer's area
            const buf = dst.slice();
            const p = [0, 0, 0, 0];
            for (let i = 0; i < n * 4; i += 4) {
                p[0] = buf[i]; p[1] = buf[i + 1]; p[2] = buf[i + 2];
                f(p);
                buf[i] = p[0]; buf[i + 1] = p[1]; buf[i + 2] = p[2];
            }
            // its area is a mask over how much of it is put down (filter layers are "copy" in Krita)
            if (node.selection) {
                buf.mask = new Float32Array(n);
                sampleSelection(node.selection, node.x, node.y, xs, ys, buf.mask);
            }
            return buf;
        }
        case 'fill': {
            if (!node.color) return null;
            // the colour, in the layer's area
            const buf = new Float32Array(n * 4);
            const sel = new Float32Array(n);
            if (node.selection) sampleSelection(node.selection, node.x, node.y, xs, ys, sel); else sel.fill(1);
            const c = node.color;
            for (let i = 0; i < n; i++) { buf[i * 4] = c[0]; buf[i * 4 + 1] = c[1]; buf[i * 4 + 2] = c[2]; buf[i * 4 + 3] = c[3] * sel[i]; }
            return buf;
        }
        default: return null;
    }
}

function applyMasks(node, buf, region, changes) {
    for (const m of node.masks) {
        if (m.kind !== 'transparency mask' || !m.selection || !effective(m, changes).visible) continue;
        const n = region.xs.length * region.ys.length;
        const sel = new Float32Array(n);
        sampleSelection(m.selection, m.x, m.y, region.xs, region.ys, sel);
        for (let i = 0; i < n; i++) buf[i * 4 + 3] *= sel[i];
    }
}

// Composite src over dst with the node's mode and opacity (KoCompositeOpGeneric and the alpha ops)
function blend(src, dst, count, opacity, modeId, alphaLocked, clampHigh, mask) {
    const mode = MODES.get(modeId) || MODES.get('normal');
    const f = mode.f, hsl = mode.hsl;
    const sc = [0, 0, 0], dc = [0, 0, 0];
    const lim = v => v < 0 ? 0 : v > 1 && clampHigh ? 1 : v;
    for (let i = 0; i < count * 4; i += 4) {
        const m = mask ? opacity * mask[i >> 2] : opacity;
        if (modeId === 'copy') {
            // KoCompositeOpCopy2: towards the source, alpha included, by opacity
            const sa = src[i + 3], da = dst[i + 3];
            const na = da + (sa - da) * m;
            if (na > 0) for (let c = 0; c < 3; c++) dst[i + c] = (dst[i + c] * da + (src[i + c] * sa - dst[i + c] * da) * m) / na;
            dst[i + 3] = na;
            continue;
        }
        const sa = src[i + 3] * m;
        if (!(sa > 0)) continue;
        const da = dst[i + 3];
        if (mode.special) {
            if (modeId === 'erase') { dst[i + 3] = da * (1 - sa); continue; }
            if (modeId === 'destination-in') { dst[i + 3] = da * sa; continue; }
            if (modeId === 'behind') {
                if (da >= 1) continue;
                const na = da + sa - da * sa;
                if (da > 0) for (let c = 0; c < 3; c++) dst[i + c] = (src[i + c] * sa * (1 - da) + dst[i + c] * da) / na;
                else for (let c = 0; c < 3; c++) dst[i + c] = src[i + c];
                dst[i + 3] = na;
                continue;
            }
            // alphadarken: as a layer's mode, the colour over, the alpha the larger
            if (alphaLocked) { if (da > 0) for (let c = 0; c < 3; c++) dst[i + c] += (src[i + c] - dst[i + c]) * sa; continue; }
            const na = Math.max(da, sa);
            const k = da > 0 ? sa : 1;
            for (let c = 0; c < 3; c++) dst[i + c] += (src[i + c] - dst[i + c]) * k;
            dst[i + 3] = na;
            continue;
        }
        // the blend result B(src, dst) for each colour channel
        if (hsl) {
            for (let c = 0; c < 3; c++) { sc[c] = clamp01(src[i + c]); dc[c] = clamp01(dst[i + c]); }
            hsl(sc, dc);
        } else if (f === MODES.get('normal').f) {
            dc[0] = src[i]; dc[1] = src[i + 1]; dc[2] = src[i + 2];
        } else {
            for (let c = 0; c < 3; c++) dc[c] = lim(f(lim(src[i + c]), lim(dst[i + c])));
        }
        if (alphaLocked) {
            // "inherit alpha": only where something is below, which keeps its alpha
            if (da > 0) for (let c = 0; c < 3; c++) dst[i + c] += (dc[c] - dst[i + c]) * sa;
            continue;
        }
        if (!(da > 0)) {
            dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = sa;
            continue;
        }
        const na = sa + da - sa * da;
        for (let c = 0; c < 3; c++) dst[i + c] = (sa * (1 - da) * src[i + c] + da * (1 - sa) * dst[i + c] + sa * da * dc[c]) / na;
        dst[i + 3] = na;
    }
}

// Krita has the HSY modes (hue, color...) for RGB images only: in the others they are Normal
function modeIn(id) {
    const m = MODES.get(id);
    return m && m.hsl && doc.cs && doc.cs.model !== 'RGB' ? 'normal' : id;
}

// Composite a list of sibling nodes (top first, as maindoc.xml has them) onto dst
function compose(list, dst, region, changes) {
    const count = region.xs.length * region.ys.length;
    for (let k = list.length - 1; k >= 0; k--) {
        const node = list[k];
        const e = effective(node, changes);
        if (!e.visible || node.kind.endsWith('mask')) continue;
        // a pass-through group's layers go straight onto what is below it
        if (node.kind === 'group' && node.passthrough && !changes[node.id]) {
            compose(node.children, dst, region, changes);
            continue;
        }
        const src = nodePixels(node, region, dst, changes);
        if (!src) continue;
        if (node.kind !== 'clone') applyMasks(node, src, region, changes);
        blend(src, dst, count, e.opacity, modeIn(e.mode), node.alphaLocked, !doc.cs || !doc.cs.float, src.mask);
    }
}

function bands(fn) {
    const W = doc.width, H = doc.height;
    const xs = Array.from({ length: W }, (_, i) => i);
    const rows = Math.max(1, Math.floor((1 << 20) / W));
    for (let y0 = 0; y0 < H; y0 += rows) {
        const ys = Array.from({ length: Math.min(rows, H - y0) }, (_, j) => y0 + j);
        fn({ xs, ys }, y0);
    }
}

// SMPTE ST 2084 (PQ) to linear light, 1 = 80 nits (scRGB's white, as Krita has it)
const PQ = { m1: 2610 / 16384, m2: 2523 / 4096 * 128, c1: 3424 / 4096, c2: 2413 / 4096 * 32, c3: 2392 / 4096 * 32 };
function fromPq(v) {
    const e = Math.max(0, v) ** (1 / PQ.m2);
    return (Math.max(e - PQ.c1, 0) / (PQ.c2 - PQ.c3 * e)) ** (1 / PQ.m1) * 10000 / 80;
}
// Linear Rec. 2020 to linear Rec. 709 (sRGB) primaries
const REC2020_TO_709 = [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187];

// The composite (in the image's colour space) as 8-bit sRGB to show
function toRgba8(buf, out, offset) {
    const { transfer, gamut } = doc.display;
    const c = [0, 0, 0];
    for (let i = 0; i < buf.length; i += 4) {
        const o = offset + i;
        if (transfer === 'srgb') {
            out[o] = Math.round(clamp01(buf[i]) * 255); out[o + 1] = Math.round(clamp01(buf[i + 1]) * 255); out[o + 2] = Math.round(clamp01(buf[i + 2]) * 255);
        } else {
            for (let k = 0; k < 3; k++) c[k] = transfer === 'pq' ? fromPq(buf[i + k]) : buf[i + k];
            if (gamut) {
                const r = c[0], g = c[1], b = c[2];
                for (let k = 0; k < 3; k++) c[k] = gamut[k * 3] * r + gamut[k * 3 + 1] * g + gamut[k * 3 + 2] * b;
            }
            for (let k = 0; k < 3; k++) out[o + k] = Math.round(toSrgb(clamp01(c[k])) * 255);
        }
        out[o + 3] = Math.round(clamp01(buf[i + 3]) * 255);
    }
}

function withBackground(buf) {
    const b = doc.background;
    if (b) for (let i = 0; i < buf.length; i += 4) { buf[i] = b[0]; buf[i + 1] = b[1]; buf[i + 2] = b[2]; buf[i + 3] = b[3]; }
    return buf;
}

function renderList(list, changes, background) {
    const out = new Uint8ClampedArray(doc.width * doc.height * 4);
    bands((region, y0) => {
        const buf = new Float32Array(region.xs.length * region.ys.length * 4);
        if (background) withBackground(buf);
        compose(list, buf, region, changes);
        toRgba8(buf, out, y0 * doc.width * 4);
    });
    return out;
}

// Samples of the whole image, size pixels on its long side at most
function sampleGrid(size) {
    const W = doc.width, H = doc.height;
    const scale = Math.min(size / W, size / H, 1);
    const tw = Math.max(1, Math.round(W * scale)), th = Math.max(1, Math.round(H * scale));
    const xs = Array.from({ length: tw }, (_, i) => Math.min(W - 1, Math.floor((i + 0.5) / scale)));
    const ys = Array.from({ length: th }, (_, j) => Math.min(H - 1, Math.floor((j + 0.5) / scale)));
    return { xs, ys, tw, th };
}

// The layers composited, small: to tell whether the merged image saved with them is any good
function preview() {
    const { xs, ys, tw, th } = sampleGrid(64);
    const buf = withBackground(new Float32Array(tw * th * 4));
    compose(doc.tree, buf, { xs, ys }, {});
    const data = new Uint8ClampedArray(tw * th * 4);
    toRgba8(buf, data, 0);
    return { width: tw, height: th, data };
}

// A small preview of a node alone, the whole image's area; a mask's or filter
// layer's: its selection, white where it is
function thumbnail(node) {
    const { xs, ys, tw, th } = sampleGrid(THUMB);
    const region = { xs, ys };
    const data = new Uint8ClampedArray(tw * th * 4);
    if (node.selection && node.kind !== 'fill') {
        const sel = new Float32Array(tw * th);
        sampleSelection(node.selection, node.x, node.y, xs, ys, sel);
        for (let i = 0; i < sel.length; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = sel[i] * 255; data[i * 4 + 3] = 255; }
        return { width: tw, height: th, data };
    }
    if (node.kind.endsWith('mask')) return null;
    const src = nodePixels(node, region, new Float32Array(tw * th * 4), {});
    if (!src) return null;
    if (node.kind !== 'clone') applyMasks(node, src, region, {});
    toRgba8(src, data, 0);
    return { width: tw, height: th, data };
}

function thumbnails(nodes) {
    const thumbs = {};
    for (const n of nodes) { try { const t = thumbnail(n); if (t) thumbs[n.id] = t; } catch { /* no preview */ } }
    return thumbs;
}

function describe(n) {
    return {
        id: n.id, name: n.name, kind: n.kind, depth: n.depth, group: n.kind === 'group', visible: n.visible,
        opacity: n.opacity, mode: n.mode, x: n.x, y: n.y, passthrough: n.passthrough, collapsed: n.collapsed,
        alphaLocked: n.alphaLocked, locked: n.locked, problem: n.problem, note: n.note, broken: !!n.broken,
        colorSpace: n.kind === 'paint' ? n.colorSpace : '', depthName: n.depthName || '',
        filter: n.filter || '', mask: n.kind.endsWith('mask'), hasChildren: !!(n.children && n.children.length) || n.masks.length > 0,
        extent: n.device && n.device.data ? [n.device.x + n.x, n.device.y + n.y, n.device.w, n.device.h] : null,
        source: n.source ? n.source.name : '',
    };
}

// Masks follow their layer, as Krita's Layers docker shows them
function ordered(list, out) {
    for (const n of list) {
        out.push(n);
        for (const m of n.masks) out.push(m);
        if (n.children) ordered(n.children, out);
    }
    return out;
}

// A vector layer drawn by the page: image-sized 8-bit sRGB RGBA, kept over its drawn extent
function storeShape(node, rgba) {
    const W = doc.width, H = doc.height;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (rgba[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const def = [0, 0, 0, 0];
    if (x1 < 0) { node.device = { x: 0, y: 0, w: 0, h: 0, data: null, scale: 1, def }; return; }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const lin = doc.linear;
    const data = lin ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    const gray = doc.cs && doc.cs.model === 'GRAY';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = ((y + y0) * W + x + x0) * 4, o = (y * w + x) * 4;
        if (gray) {
            const v = grayOf(rgba[s] / 255, rgba[s + 1] / 255, rgba[s + 2] / 255, false);
            data[o] = data[o + 1] = data[o + 2] = lin ? toLinear(v) : Math.round(v * 255);
        } else for (let c = 0; c < 3; c++) data[o + c] = lin ? toLinear(rgba[s + c] / 255) : rgba[s + c];
        data[o + 3] = lin ? rgba[s + 3] / 255 : rgba[s + 3];
    }
    // the page drew it at the layer's offset already
    node.device = { x: x0 - node.x, y: y0 - node.y, w, h, data, scale: lin ? 1 : 1 / 255, def };
}

self.onmessage = ({ data }) => {
    const { id, cmd } = data;
    try {
        if (cmd === 'open') {
            const { info, merged, svgs } = openKra(new Uint8Array(data.bytes));
            const nodes = ordered(doc.tree, []);
            const layers = nodes.map(describe);
            const thumbs = thumbnails(nodes.filter(n => !svgs[n.id] && !(n.kind === 'clone' && n.source && svgs[n.source.id])));
            const result = { info, layers, thumbs, svgs, merged: merged ? merged.slice() : null, preview: merged ? preview() : null };
            self.postMessage({ id, result }, result.merged ? [result.merged.buffer] : []);
        } else if (cmd === 'shapes') {
            const changed = [];
            for (const [layerId, rgba] of Object.entries(data.shapes)) {
                const n = doc.byId.get(+layerId);
                if (n) { storeShape(n, new Uint8ClampedArray(rgba)); changed.push(n); }
            }
            for (const n of doc.all) if (n.kind === 'clone' && n.source && changed.includes(n.source)) changed.push(n);
            self.postMessage({ id, result: { thumbs: thumbnails(changed) } });
        } else if (cmd === 'render') {
            const pixels = renderList(doc.tree, data.changes || {}, true);
            self.postMessage({ id, result: { image: pixels } }, [pixels.buffer]);
        } else if (cmd === 'layer') {
            const n = doc.byId.get(data.layerId);
            // the layer alone, at full opacity, in normal mode, with its masks
            const solo = { ...n, visible: true, opacity: 1, mode: 'normal', alphaLocked: false, passthrough: false };
            const pixels = renderList([solo], {});
            self.postMessage({ id, result: { image: pixels } }, [pixels.buffer]);
        }
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
