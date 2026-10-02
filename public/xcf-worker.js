// GIMP's XCF files, read and composited in a worker, for the XCF viewer
// (src/xcf-plugin.js). Written from GIMP's own sources: app/xcf/xcf-load.c for
// the format, and app/operations/layer-modes (the mode table, blend and
// composite functions) and layer-modes-legacy for how layers combine, so the
// picture matches GIMP's: each mode blends and composites in the colour space
// GIMP uses for it (linear RGB, non-linear RGB or CIE LAB).
//
// Layers are kept as non-premultiplied linear RGBA floats; a render takes the
// viewer's changes (visibility, opacity, mode, mask) and returns 8-bit sRGB.
//   → { id, cmd: 'open', bytes }            ← { info, layers, image }
//   → { id, cmd: 'render', changes }        ← { image }
//   → { id, cmd: 'layer', layerId }         ← { image } (one layer alone, image-sized)
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const PROP = {
    END: 0, COLORMAP: 1, ACTIVE_LAYER: 2, FLOATING_SELECTION: 5, OPACITY: 6, MODE: 7, VISIBLE: 8, LINKED: 9,
    LOCK_ALPHA: 10, APPLY_MASK: 11, EDIT_MASK: 12, SHOW_MASK: 13, OFFSETS: 15, COLOR: 16, COMPRESSION: 17,
    RESOLUTION: 19, TATTOO: 20, PARASITES: 21, UNIT: 22, TEXT_LAYER_FLAGS: 26, LOCK_CONTENT: 28, GROUP_ITEM: 29,
    ITEM_PATH: 30, GROUP_ITEM_FLAGS: 31, LOCK_POSITION: 32, FLOAT_OPACITY: 33, COLOR_TAG: 34, COMPOSITE_MODE: 35,
    COMPOSITE_SPACE: 36, BLEND_SPACE: 37, FLOAT_COLOR: 38, VECTOR_LAYER: 47, LINK_LAYER: 48,
};
const TILE = 64;

// --- Layer modes (GimpLayerMode, app/operations/operations-enums.h) ---
// [name, blend function, blend space, composite space, composite mode]
// spaces: L linear RGB, N non-linear RGB, P perceptual RGB (= N for sRGB), A CIE LAB
// composite: U union, B clip to backdrop, Y clip to layer, I intersection
// Legacy modes (flag legacy) use their own operations: blend then mix with min(alphas)
const MODES = [
    ['Normal (legacy)', 'normal', 'N', 'N', 'U', 'legacy-normal'],
    ['Dissolve', 'normal', 'N', 'N', 'U', 'dissolve'],
    ['Behind (legacy)', 'normal', 'N', 'N', 'U', 'behind'],
    ['Multiply (legacy)', 'multiply', 'N', 'N', 'B', 'legacy'],
    ['Screen (legacy)', 'screen', 'N', 'N', 'B', 'legacy'],
    ['Overlay (old broken)', 'softlight', 'N', 'N', 'B', 'legacy'],
    ['Difference (legacy)', 'difference', 'N', 'N', 'B', 'legacy'],
    ['Addition (legacy)', 'addition', 'N', 'N', 'B', 'legacy'],
    ['Subtract (legacy)', 'subtract', 'N', 'N', 'B', 'legacy'],
    ['Darken only (legacy)', 'darken', 'N', 'N', 'B', 'legacy'],
    ['Lighten only (legacy)', 'lighten', 'N', 'N', 'B', 'legacy'],
    ['HSV Hue (legacy)', 'hsv-hue-legacy', 'N', 'N', 'B', 'legacy'],
    ['HSV Saturation (legacy)', 'hsv-saturation-legacy', 'N', 'N', 'B', 'legacy'],
    ['HSL Color (legacy)', 'hsl-color-legacy', 'N', 'N', 'B', 'legacy'],
    ['HSV Value (legacy)', 'hsv-value-legacy', 'N', 'N', 'B', 'legacy'],
    ['Divide (legacy)', 'divide', 'N', 'N', 'B', 'legacy'],
    ['Dodge (legacy)', 'dodge', 'N', 'N', 'B', 'legacy'],
    ['Burn (legacy)', 'burn', 'N', 'N', 'B', 'legacy'],
    ['Hard light (legacy)', 'hardlight-legacy', 'N', 'N', 'B', 'legacy'],
    ['Soft light (legacy)', 'softlight', 'N', 'N', 'B', 'legacy'],
    ['Grain extract (legacy)', 'grain-extract-legacy', 'N', 'N', 'B', 'legacy'],
    ['Grain merge (legacy)', 'grain-merge-legacy', 'N', 'N', 'B', 'legacy'],
    ['Color erase (legacy)', 'color-erase', 'N', 'N', 'B', 'color-erase'],
    ['Overlay', 'overlay', 'P', 'L', 'B'],
    ['LCh Hue', 'lch-hue', 'A', 'L', 'B'],
    ['LCh Chroma', 'lch-chroma', 'A', 'L', 'B'],
    ['LCh Color', 'lch-color', 'A', 'L', 'B'],
    ['LCh Lightness', 'lch-lightness', 'A', 'L', 'B'],
    ['Normal', 'normal', 'L', 'L', 'U'],
    ['Behind', 'normal', 'L', 'L', 'U', 'behind'],
    ['Multiply', 'multiply', 'L', 'L', 'B'],
    ['Screen', 'screen', 'P', 'L', 'B'],
    ['Difference', 'difference', 'P', 'L', 'B'],
    ['Addition', 'addition', 'L', 'L', 'B'],
    ['Subtract', 'subtract', 'L', 'L', 'B'],
    ['Darken only', 'darken', 'L', 'L', 'B'],
    ['Lighten only', 'lighten', 'L', 'L', 'B'],
    ['HSV Hue', 'hsv-hue', 'N', 'L', 'B'],
    ['HSV Saturation', 'hsv-saturation', 'N', 'L', 'B'],
    ['HSL Color', 'hsl-color', 'N', 'L', 'B'],
    ['HSV Value', 'hsv-value', 'N', 'L', 'B'],
    ['Divide', 'divide-safe', 'L', 'L', 'B'],
    ['Dodge', 'dodge-safe', 'P', 'L', 'B'],
    ['Burn', 'burn-safe', 'P', 'L', 'B'],
    ['Hard light', 'hardlight', 'P', 'L', 'B'],
    ['Soft light', 'softlight', 'P', 'L', 'B'],
    ['Grain extract', 'grain-extract', 'P', 'L', 'B'],
    ['Grain merge', 'grain-merge', 'P', 'L', 'B'],
    ['Vivid light', 'vivid-light', 'P', 'L', 'B'],
    ['Pin light', 'pin-light', 'P', 'L', 'B'],
    ['Linear light', 'linear-light', 'P', 'L', 'B'],
    ['Hard mix', 'hard-mix', 'P', 'L', 'B'],
    ['Exclusion', 'exclusion', 'P', 'L', 'B'],
    ['Linear burn', 'linear-burn', 'P', 'L', 'B'],
    ['Luma darken only', 'luma-darken', 'L', 'L', 'B'],
    ['Luma lighten only', 'luma-lighten', 'L', 'L', 'B'],
    ['Luminance', 'luminance', 'L', 'L', 'B'],
    ['Color erase', 'color-erase', 'L', 'L', 'B', 'color-erase'],
    ['Erase', 'normal', 'L', 'L', 'B', 'erase'],
    ['Merge', 'normal', 'L', 'L', 'U', 'merge'],
    ['Split', 'normal', 'L', 'L', 'B', 'split'],
    ['Pass through', 'normal', 'L', 'L', 'U', 'pass-through'],
    ['Replace', 'normal', 'L', 'L', 'U', 'replace'],
    ['Overwrite', 'normal', 'L', 'L', 'U', 'replace'],
    ['Anti erase', 'normal', 'L', 'L', 'U', 'anti-erase'],
];
const COMPOSITE_CODES = { 1: 'U', 2: 'B', 3: 'Y', 4: 'I' };
const SPACE_CODES = { 1: 'L', 2: 'N', 3: 'A', 4: 'P' };

// --- Colour ---
// babl's sRGB → XYZ (D50, Bradford adapted) and its inverse; LAB relative to D50
const M = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
const MI = invert3(M);
const WHITE = [0.9642, 1.0, 0.8249];
const LUM = [M[3], M[4], M[5]];

function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
        B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
        C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const toLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const toNonLinear = v => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
const LIN8 = new Float32Array(256).map((_, i) => toLinear(i / 255));
// Linear → non-linear through a table for [0, 1] (the common case), exactly outside it
const NL_N = 65536;
const NL = new Float32Array(NL_N + 1).map((_, i) => toNonLinear(i / NL_N));
function nl(v) {
    if (v <= 0 || v >= 1) return v <= 0 ? v * 12.92 : toNonLinear(v);
    const x = v * NL_N, i = x | 0, t = x - i;
    return NL[i] + (NL[i + 1] - NL[i]) * t;
}
function lin(v) {
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
const labF = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
const labFi = t => t > 6 / 29 ? t * t * t : (116 * t - 16) * 27 / 24389;
// Linear RGB (3 values at p of a) → LAB into o
function toLab(a, p, o) {
    const r = a[p], g = a[p + 1], b = a[p + 2];
    const x = (M[0] * r + M[1] * g + M[2] * b) / WHITE[0];
    const y = (M[3] * r + M[4] * g + M[5] * b) / WHITE[1];
    const z = (M[6] * r + M[7] * g + M[8] * b) / WHITE[2];
    const fx = labF(x), fy = labF(y), fz = labF(z);
    o[0] = 116 * fy - 16; o[1] = 500 * (fx - fy); o[2] = 200 * (fy - fz);
}
function fromLab(l, a, b, o) {
    const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const x = labFi(fx) * WHITE[0], y = labFi(fy) * WHITE[1], z = labFi(fz) * WHITE[2];
    o[0] = MI[0] * x + MI[1] * y + MI[2] * z;
    o[1] = MI[3] * x + MI[4] * y + MI[5] * z;
    o[2] = MI[6] * x + MI[7] * y + MI[8] * z;
}

// HSV/HSL as GIMP's legacy colour code (gimpcolor-legacy.c), in 0..1
function rgbToHsv(r, g, b, o) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    if (s !== 0) {
        if (r === max) h = (g - b) / d;
        else if (g === max) h = 2 + (b - r) / d;
        else h = 4 + (r - g) / d;
        h /= 6;
        if (h < 0) h += 1;
    }
    o[0] = h; o[1] = s; o[2] = max;
}
function hsvToRgb(h, s, v, o) {
    if (s === 0) { o[0] = o[1] = o[2] = v; return; }
    const hh = (h === 1 ? 0 : h) * 6, i = Math.floor(hh), f = hh - i;
    const w = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    const c = [[v, t, w], [q, v, w], [w, v, t], [w, q, v], [t, w, v], [v, w, q]][i];
    o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
}
function rgbToHsl(r, g, b, o) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
        if (max === r) h = (g - b) / d;
        else if (max === g) h = 2 + (b - r) / d;
        else h = 4 + (r - g) / d;
        h /= 6;
        if (h < 0) h += 1;
    }
    o[0] = h; o[1] = s; o[2] = l;
}
function hslValue(n1, n2, hue) {
    if (hue > 6) hue -= 6; else if (hue < 0) hue += 6;
    if (hue < 1) return n1 + (n2 - n1) * hue;
    if (hue < 3) return n2;
    if (hue < 4) return n1 + (n2 - n1) * (4 - hue);
    return n1;
}
function hslToRgb(h, s, l, o) {
    if (s === 0) { o[0] = o[1] = o[2] = l; return; }
    const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
    o[0] = hslValue(m1, m2, h * 6 + 2);
    o[1] = hslValue(m1, m2, h * 6);
    o[2] = hslValue(m1, m2, h * 6 - 2);
}

// --- Blend functions (gimpoperationlayermode-blend.c, and the legacy variants) ---
const SAFE_DIV_MIN = 1e-10, SAFE_DIV_MAX = 1e10, EPS = 1e-6;
const safeDiv = (a, b) => Math.abs(a) > SAFE_DIV_MIN ? Math.min(SAFE_DIV_MAX, Math.max(-SAFE_DIV_MAX, a / b)) : 0;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const T3 = [0, 0, 0], T4 = [0, 0, 0];
const SEPARABLE = {
    normal: (b, l) => l,
    multiply: (b, l) => b * l,
    screen: (b, l) => 1 - (1 - b) * (1 - l),
    difference: (b, l) => Math.abs(b - l),
    addition: (b, l) => b + l,
    subtract: (b, l) => b - l,
    darken: (b, l) => Math.min(b, l),
    lighten: (b, l) => Math.max(b, l),
    divide: (b, l) => { const c = b / l; return Number.isNaN(c) ? 0 : clamp01(c); },            // legacy: SAFE_CLAMP
    dodge: (b, l) => { const c = b / (1 - l); return Number.isNaN(c) ? 0 : clamp01(c); },
    burn: (b, l) => { const c = 1 - (1 - b) / l; return c < 0 ? 0 : c < 1 ? c : 1; },         // NaN → 1
    'divide-safe': (b, l) => safeDiv(b, l),
    'dodge-safe': (b, l) => safeDiv(b, 1 - l),
    'burn-safe': (b, l) => 1 - safeDiv(1 - b, l),
    overlay: (b, l) => b < 0.5 ? 2 * b * l : 1 - 2 * (1 - l) * (1 - b),
    softlight: (b, l) => { const m = b * l, s = 1 - (1 - b) * (1 - l); return (1 - b) * m + b * s; },
    hardlight: (b, l) => l > 0.5 ? Math.min(1 - (1 - b) * (1 - (l - 0.5) * 2), 1) : Math.min(b * l * 2, 1),
    'hardlight-legacy': (b, l) => l > 128 / 255 ? Math.min(1 - (1 - b) * (1 - (l - 128 / 255) * 2), 1) : Math.min(b * l * 2, 1),
    'grain-extract': (b, l) => b - l + 0.5,
    'grain-merge': (b, l) => b + l - 0.5,
    'grain-extract-legacy': (b, l) => clamp01(b - l + 128 / 255),
    'grain-merge-legacy': (b, l) => clamp01(b + l - 128 / 255),
    'vivid-light': (b, l) => l <= 0.5 ? Math.max(1 - safeDiv(1 - b, 2 * l), 0) : Math.min(safeDiv(b, 2 * (1 - l)), 1),
    'pin-light': (b, l) => l > 0.5 ? Math.max(b, 2 * (l - 0.5)) : Math.min(b, 2 * l),
    'linear-light': (b, l) => l <= 0.5 ? b + 2 * l - 1 : b + 2 * (l - 0.5),
    'hard-mix': (b, l) => Math.fround(Math.fround(b) + Math.fround(l)) < 1 ? 0 : 1, // in GIMP's 32-bit floats
    exclusion: (b, l) => 0.5 - 2 * (b - 0.5) * (l - 0.5),
    'linear-burn': (b, l) => b + l - 1,
};
// Legacy blends clamp where their operation did
const LEGACY_CLAMP = new Set(['addition', 'subtract']);

// Non-separable blends: backdrop and layer (3 values each, in the blend space) into out
const NONSEP = {
    'hsv-hue'(i, l, o) {
        const smin = Math.min(l[0], l[1], l[2]), smax = Math.max(l[0], l[1], l[2]), sd = smax - smin;
        if (sd > EPS) {
            const dmin = Math.min(i[0], i[1], i[2]), dmax = Math.max(i[0], i[1], i[2]), dd = dmax - dmin;
            const ds = dmax ? dd / dmax : 0;
            const ratio = ds * dmax / sd, off = dmax - smax * ratio;
            for (let c = 0; c < 3; c++) o[c] = l[c] * ratio + off;
        } else for (let c = 0; c < 3; c++) o[c] = i[c];
    },
    'hsv-saturation'(i, l, o) {
        const dmin = Math.min(i[0], i[1], i[2]), dmax = Math.max(i[0], i[1], i[2]), dd = dmax - dmin;
        if (dd > EPS) {
            const smin = Math.min(l[0], l[1], l[2]), smax = Math.max(l[0], l[1], l[2]);
            const ss = smax ? (smax - smin) / smax : 0;
            const ratio = ss * dmax / dd, off = (1 - ratio) * dmax;
            for (let c = 0; c < 3; c++) o[c] = i[c] * ratio + off;
        } else o[0] = o[1] = o[2] = dmax;
    },
    'hsl-color'(i, l, o) {
        let dl = (Math.min(i[0], i[1], i[2]) + Math.max(i[0], i[1], i[2])) / 2;
        let sl = (Math.min(l[0], l[1], l[2]) + Math.max(l[0], l[1], l[2])) / 2;
        if (Math.abs(sl) > EPS && Math.abs(1 - sl) > EPS) {
            const dh = dl > 0.5, sh = sl > 0.5;
            dl = Math.min(dl, 1 - dl);
            sl = Math.min(sl, 1 - sl);
            const ratio = dl / sl;
            let off = 0;
            if (dh) off += 1 - 2 * dl;
            if (sh) off += 2 * dl - ratio;
            for (let c = 0; c < 3; c++) o[c] = l[c] * ratio + off;
        } else o[0] = o[1] = o[2] = dl;
    },
    'hsv-value'(i, l, o) {
        const dv = Math.max(i[0], i[1], i[2]), sv = Math.max(l[0], l[1], l[2]);
        if (Math.abs(dv) > EPS) { const r = sv / dv; for (let c = 0; c < 3; c++) o[c] = i[c] * r; }
        else o[0] = o[1] = o[2] = sv;
    },
    'hsv-hue-legacy'(i, l, o) {
        const lh = [0, 0, 0], ih = [0, 0, 0];
        rgbToHsv(l[0], l[1], l[2], lh); rgbToHsv(i[0], i[1], i[2], ih);
        if (lh[1]) ih[0] = lh[0];
        hsvToRgb(ih[0], ih[1], ih[2], o);
    },
    'hsv-saturation-legacy'(i, l, o) {
        const lh = [0, 0, 0], ih = [0, 0, 0];
        rgbToHsv(l[0], l[1], l[2], lh); rgbToHsv(i[0], i[1], i[2], ih);
        ih[1] = lh[1];
        hsvToRgb(ih[0], ih[1], ih[2], o);
    },
    'hsv-value-legacy'(i, l, o) {
        const lh = [0, 0, 0], ih = [0, 0, 0];
        rgbToHsv(l[0], l[1], l[2], lh); rgbToHsv(i[0], i[1], i[2], ih);
        ih[2] = lh[2];
        hsvToRgb(ih[0], ih[1], ih[2], o);
    },
    'hsl-color-legacy'(i, l, o) {
        const lh = [0, 0, 0], ih = [0, 0, 0];
        rgbToHsl(l[0], l[1], l[2], lh); rgbToHsl(i[0], i[1], i[2], ih);
        hslToRgb(lh[0], lh[1], ih[2], o);
    },
    // LAB blends (in L, a, b)
    'lch-hue'(i, l, o) {
        const c2 = Math.hypot(l[1], l[2]);
        if (c2 > EPS) { const c1 = Math.hypot(i[1], i[2]); o[0] = i[0]; o[1] = c1 * l[1] / c2; o[2] = c1 * l[2] / c2; }
        else { o[0] = i[0]; o[1] = i[1]; o[2] = i[2]; }
    },
    'lch-chroma'(i, l, o) {
        const c1 = Math.hypot(i[1], i[2]);
        if (c1 > EPS) { const c2 = Math.hypot(l[1], l[2]); o[0] = i[0]; o[1] = c2 * i[1] / c1; o[2] = c2 * i[2] / c1; }
        else { o[0] = i[0]; o[1] = i[1]; o[2] = i[2]; }
    },
    'lch-color'(i, l, o) { o[0] = i[0]; o[1] = l[1]; o[2] = l[2]; },
    'lch-lightness'(i, l, o) { o[0] = l[0]; o[1] = i[1]; o[2] = i[2]; },
    'luma-darken'(i, l, o) {
        const d = i[0] * LUM[0] + i[1] * LUM[1] + i[2] * LUM[2], s = l[0] * LUM[0] + l[1] * LUM[1] + l[2] * LUM[2];
        const src = d <= s ? i : l;
        o[0] = src[0]; o[1] = src[1]; o[2] = src[2];
    },
    'luma-lighten'(i, l, o) {
        const d = i[0] * LUM[0] + i[1] * LUM[1] + i[2] * LUM[2], s = l[0] * LUM[0] + l[1] * LUM[1] + l[2] * LUM[2];
        const src = d >= s ? i : l;
        o[0] = src[0]; o[1] = src[1]; o[2] = src[2];
    },
    luminance(i, l, o) {
        // In linear RGB: Y of each (babl's luminance for the space)
        const iy = i[0] * LUM[0] + i[1] * LUM[1] + i[2] * LUM[2], ly = l[0] * LUM[0] + l[1] * LUM[1] + l[2] * LUM[2];
        const r = safeDiv(ly, iy);
        for (let c = 0; c < 3; c++) o[c] = i[c] * r;
    },
};

// --- Dissolve's randomness: GLib's GRand (MT19937, G_RANDOM_VERSION 2.2), as
// gimpoperationdissolve.c uses it: a table of seeds from seed 314159265, and
// for each row a generator seeded from it, advanced to the row's first pixel ---
function mt(seed) {
    const s = new Uint32Array(624);
    s[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
        const p = s[i - 1] ^ (s[i - 1] >>> 30);
        s[i] = (Math.imul(1812433253, p) + i) >>> 0;
    }
    let i = 624;
    return () => {
        if (i >= 624) {
            for (let k = 0; k < 624; k++) {
                const y = (s[k] & 0x80000000) | (s[(k + 1) % 624] & 0x7fffffff);
                s[k] = s[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
            }
            i = 0;
        }
        let y = s[i++];
        y ^= y >>> 11;
        y ^= (y << 7) & 0x9d2c5680;
        y ^= (y << 15) & 0xefc60000;
        y ^= y >>> 18;
        return y >>> 0;
    };
}
const DISSOLVE_SEEDS = (() => { const r = mt(314159265); return Array.from({ length: 4096 }, () => r()); })();
// g_rand_int_range (gr, 0, 255): reject the one value past the last multiple of 255
function randRange255(next) {
    let v;
    do v = next(); while (v > 0xfffffffe);
    return v % 255;
}

// --- Reading ---

class Reader {
    constructor(bytes, version) {
        this.b = bytes;
        this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.p = 0;
        this.wide = version >= 11;
    }
    u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
    i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
    f32() { const x = this.v.getFloat32(this.p); this.p += 4; return x; }
    offset() {
        if (!this.wide) return this.u32();
        const x = Number(this.v.getBigUint64(this.p)); this.p += 8; return x;
    }
    string() {
        const n = this.u32();
        if (!n) return '';
        const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n - 1));
        this.p += n;
        return s;
    }
    props(onProp) {
        for (let guard = 0; guard < 10000; guard++) {
            const type = this.u32(), size = this.u32();
            if (type === PROP.END) return;
            const start = this.p;
            onProp(type, size, this);
            this.p = start + size;
        }
    }
}

// Image precision (GimpPrecision codes; versions 4-6 used other numbers)
function precisionOf(version, p) {
    if (version < 4) return 150;
    if (version === 4) return [150, 250, 300, 500, 600][p] || 150;
    if (version === 5 || version === 6) return { 100: 100, 150: 150, 200: 200, 250: 250, 300: 300, 350: 350, 400: 500, 450: 550, 500: 600, 550: 650 }[p] || 150;
    return p;
}
const PRECISION_NAMES = { 1: '8-bit integer', 2: '16-bit integer', 3: '32-bit integer', 5: '16-bit float', 6: '32-bit float', 7: '64-bit float' };
const TRC_NAMES = { 0: 'linear', 50: 'non-linear', 75: 'perceptual' };

function parseParasites(r, size) {
    const end = r.p + size, out = {};
    while (r.p + 12 <= end) {
        const name = r.string();
        r.u32(); // flags
        const n = r.u32();
        out[name] = r.b.subarray(r.p, r.p + n);
        r.p += n;
    }
    return out;
}

function parseXcf(bytes) {
    const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 14));
    if (!magic.startsWith('gimp xcf ')) throw new Error('not a GIMP XCF file');
    const version = magic.slice(9, 13) === 'file' ? 0 : parseInt(magic.slice(10, 13), 10);
    if (Number.isNaN(version)) throw new Error('unknown XCF version');
    const r = new Reader(bytes, version);
    r.p = 14;
    const img = { version, width: r.u32(), height: r.u32(), baseType: r.u32() };
    img.precision = precisionOf(version, version >= 4 ? r.u32() : 0);
    img.compression = 0;
    img.parasites = {};
    r.props((type, size) => {
        if (type === PROP.COMPRESSION) img.compression = bytes[r.p];
        else if (type === PROP.COLORMAP) {
            const n = r.u32();
            img.colormap = bytes.slice(r.p, r.p + n * 3);
        } else if (type === PROP.RESOLUTION) img.resolution = [r.f32(), r.f32()];
        else if (type === PROP.PARASITES) img.parasites = parseParasites(r, size);
    });
    const layerOffsets = [];
    for (let o; (o = r.offset());) layerOffsets.push(o);
    const channelOffsets = [];
    for (let o; (o = r.offset());) channelOffsets.push(o);
    img.layers = layerOffsets.map((off, i) => {
        try { return parseLayer(r, off, img, i); } catch (err) { return { id: i, name: `(unreadable layer: ${err.message})`, broken: true, width: 0, height: 0, x: 0, y: 0, visible: false, opacity: 1, mode: 28, path: null }; }
    });
    img.channels = channelOffsets.map(off => {
        try { r.p = off; r.u32(); r.u32(); return r.string(); } catch { return '?'; }
    });
    return img;
}

function parseLayer(r, off, img, id) {
    r.p = off;
    const layer = { id, width: r.u32(), height: r.u32(), type: r.u32(), name: r.string(),
        visible: true, opacity: 1, mode: 0, x: 0, y: 0, applyMask: true, group: false, path: null,
        compositeMode: 0, compositeSpace: 0, blendSpace: 0, text: false, link: false, vector: false, floating: false };
    let floatOpacity = null;
    r.props((type, size) => {
        switch (type) {
            case PROP.OPACITY: layer.opacity = r.u32() / 255; break;
            case PROP.FLOAT_OPACITY: floatOpacity = r.f32(); break;
            case PROP.VISIBLE: layer.visible = !!r.u32(); break;
            case PROP.MODE: layer.mode = r.u32(); break;
            case PROP.OFFSETS: layer.x = r.i32(); layer.y = r.i32(); break;
            case PROP.APPLY_MASK: layer.applyMask = !!r.u32(); break;
            case PROP.GROUP_ITEM: layer.group = true; break;
            case PROP.ITEM_PATH: { const path = []; for (let i = 0; i < size / 4; i++) path.push(r.u32()); layer.path = path; break; }
            case PROP.COMPOSITE_MODE: layer.compositeMode = r.i32(); break;
            case PROP.COMPOSITE_SPACE: layer.compositeSpace = r.i32(); break;
            case PROP.BLEND_SPACE: layer.blendSpace = r.i32(); break;
            case PROP.TEXT_LAYER_FLAGS: layer.text = true; break;
            case PROP.LINK_LAYER: layer.link = true; break;
            case PROP.VECTOR_LAYER: layer.vector = true; break;
            case PROP.FLOATING_SELECTION: layer.floating = true; break;
            case PROP.PARASITES: { const p = parseParasites(r, size); if (p['gimp-text-layer']) layer.text = true; break; }
        }
    });
    if (floatOpacity !== null) layer.opacity = floatOpacity;
    const hierarchy = r.offset(), mask = r.offset();
    let effects = 0;
    if (img.version >= 20) { for (let o = r.offset(); o; o = r.offset()) effects++; }
    layer.effects = effects;
    if (!layer.group && hierarchy) layer.pixels = readDrawable(r, hierarchy, img, layer.type, layer.width, layer.height);
    if (mask) {
        r.p = mask;
        const mw = r.u32(), mh = r.u32();
        r.string();
        let maskVisible = true;
        r.props(type => { if (type === PROP.VISIBLE) maskVisible = !!r.u32(); });
        const mh2 = r.offset();
        layer.mask = { width: mw, height: mh, data: readDrawable(r, mh2, img, 'mask', mw, mh) };
    }
    return layer;
}

// The pixels of a layer or mask: tiles of the first level, as linear RGBA floats
// (a mask: one float per pixel)
function readDrawable(r, hierarchyOff, img, type, width, height) {
    r.p = hierarchyOff;
    const hw = r.u32(), hh = r.u32(), bpp = r.u32();
    const levelOff = r.offset();
    r.p = levelOff;
    const lw = r.u32(), lh = r.u32();
    if (lw !== width || lh !== height || hw !== width || hh !== height) throw new Error('size mismatch');
    const channels = type === 'mask' ? 1 : [3, 4, 1, 2, 1, 2][type];
    const cb = bpp / channels; // bytes per component
    const kind = Math.floor(img.precision / 100);
    const linear = img.precision % 100 === 0;
    const le = img.version < 12; // multi-byte components in machine (little-endian) order before v12
    const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
    const tiles = [];
    for (let o; (o = r.offset());) tiles.push(o);
    const out = new Float32Array(width * height * (type === 'mask' ? 1 : 4));
    const maxLen = TILE * TILE * bpp * 1.5;
    const cmap = img.colormap;
    for (let t = 0; t < tiles.length && t < cols * rows; t++) {
        const tx = (t % cols) * TILE, ty = Math.floor(t / cols) * TILE;
        const tw = Math.min(TILE, width - tx), th = Math.min(TILE, height - ty);
        const n = tw * th;
        const start = tiles[t], end = tiles[t + 1] || Math.min(r.b.length, start + maxLen);
        const raw = r.b.subarray(start, Math.min(end, r.b.length));
        let data;
        if (img.compression === 1) data = rleTile(raw, n, bpp);
        else if (img.compression === 2) data = fflate.inflateSync(raw.subarray(2), { out: new Uint8Array(n * bpp) });
        else data = raw.subarray(0, n * bpp);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const comp = (i) => { // component i (of all in the tile) as 0..1
            const at = i * cb;
            switch (kind) {
                case 1: return data[at] / 255;
                case 2: return dv.getUint16(at, le) / 65535;
                case 3: return dv.getUint32(at, le) / 4294967295;
                case 5: return half(dv.getUint16(at, le));
                case 6: return dv.getFloat32(at, le);
                case 7: return dv.getFloat64(at, le);
                default: return 0;
            }
        };
        const tolin = v => linear ? v : (kind === 1 ? v : lin(v));
        for (let py = 0; py < th; py++) {
            for (let px = 0; px < tw; px++) {
                const i = py * tw + px, o = (ty + py) * width + tx + px;
                const c0 = i * channels;
                if (type === 'mask') { out[o] = comp(c0); continue; }
                let rr, gg, bb, aa = 1;
                if (type === 0 || type === 1) {
                    if (kind === 1 && !linear) { rr = LIN8[data[c0]]; gg = LIN8[data[c0 + 1]]; bb = LIN8[data[c0 + 2]]; }
                    else { rr = tolin(comp(c0)); gg = tolin(comp(c0 + 1)); bb = tolin(comp(c0 + 2)); }
                    if (type === 1) aa = comp(c0 + 3);
                } else if (type === 2 || type === 3) {
                    const y = kind === 1 && !linear ? LIN8[data[c0]] : tolin(comp(c0));
                    rr = gg = bb = y;
                    if (type === 3) aa = comp(c0 + 1);
                } else {
                    const idx = data[c0];
                    rr = cmap ? LIN8[cmap[idx * 3]] : 0; gg = cmap ? LIN8[cmap[idx * 3 + 1]] : 0; bb = cmap ? LIN8[cmap[idx * 3 + 2]] : 0;
                    if (type === 5) aa = data[c0 + 1] / 255;
                }
                out[o * 4] = rr; out[o * 4 + 1] = gg; out[o * 4 + 2] = bb; out[o * 4 + 3] = aa;
            }
        }
    }
    return out;
}

function half(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
}

// XCF RLE (xcf_load_tile_rle): each byte of the pixel in turn, as runs
function rleTile(src, n, bpp) {
    const out = new Uint8Array(n * bpp);
    let p = 0;
    for (let c = 0; c < bpp; c++) {
        let o = c, size = n;
        while (size > 0 && p < src.length) {
            let len = src[p++];
            if (len >= 128) {
                len = 256 - len;
                if (len === 128) { len = (src[p] << 8) | src[p + 1]; p += 2; }
                size -= len;
                while (len-- > 0) { out[o] = src[p++]; o += bpp; }
            } else {
                len += 1;
                if (len === 128) { len = (src[p] << 8) | src[p + 1]; p += 2; }
                size -= len;
                const v = src[p++];
                while (len-- > 0) { out[o] = v; o += bpp; }
            }
        }
    }
    return out;
}

// --- The layer tree ---
// Layers are listed top to bottom; a layer's ITEM_PATH gives its index within
// each enclosing group, so layers after a group with longer paths are its children
function buildTree(layers) {
    const root = { children: [] };
    for (const l of layers) {
        l.children = l.group ? [] : null;
        let parent = root;
        if (l.path && l.path.length > 1) {
            for (const idx of l.path.slice(0, -1)) {
                const next = parent.children[idx];
                if (!next || !next.children) break;
                parent = next;
            }
        }
        parent.children.push(l);
    }
    return root.children;
}

// --- Compositing ---

function effective(layer, changes) {
    const c = changes[layer.id] || {};
    return {
        visible: c.visible !== undefined ? c.visible : layer.visible,
        opacity: c.opacity !== undefined ? c.opacity : layer.opacity,
        mode: c.mode !== undefined ? c.mode : layer.mode,
        applyMask: c.applyMask !== undefined ? c.applyMask : layer.applyMask,
    };
}

function modeInfo(mode, layer) {
    const m = MODES[mode] || MODES[28];
    const pick = (v, table, fallback) => v ? (table[Math.abs(v)] || fallback) : fallback;
    const legacy = m[5] === 'legacy';
    return {
        name: m[0], blend: m[1], special: m[5] || null, legacy,
        blendSpace: legacy ? 'N' : pick(layer.blendSpace, SPACE_CODES, m[2]),
        compositeSpace: legacy ? 'N' : pick(layer.compositeSpace, SPACE_CODES, m[3]),
        composite: legacy ? m[4] : pick(layer.compositeMode, COMPOSITE_CODES, m[4]),
    };
}

// Composites src (a layer's pixels or a group's result, w×h at x,y) onto dst (image-sized)
function compositeLayer(dst, W, H, src, w, h, x, y, opacity, mask, mi) {
    const full = mi.composite === 'Y' || mi.composite === 'I' || mi.special === 'replace';
    const x0 = full ? 0 : Math.max(0, x), y0 = full ? 0 : Math.max(0, y);
    const x1 = full ? W : Math.min(W, x + w), y1 = full ? H : Math.min(H, y + h);
    const sep = SEPARABLE[mi.blend];
    const nonsep = NONSEP[mi.blend];
    const iB = [0, 0, 0], lB = [0, 0, 0], cB = [0, 0, 0], tmp = [0, 0, 0];
    const toSpace = (arr, p, space, o) => {
        if (space === 'A') { toLab(arr, p, o); return; }
        if (space === 'L') { o[0] = arr[p]; o[1] = arr[p + 1]; o[2] = arr[p + 2]; return; }
        o[0] = nl(arr[p]); o[1] = nl(arr[p + 1]); o[2] = nl(arr[p + 2]);
    };
    const fromSpace = (v, space, o) => { // blend space → linear
        if (space === 'A') { fromLab(v[0], v[1], v[2], o); return; }
        if (space === 'L') { o[0] = v[0]; o[1] = v[1]; o[2] = v[2]; return; }
        o[0] = lin(v[0]); o[1] = lin(v[1]); o[2] = lin(v[2]);
    };
    const inC = [0, 0, 0], layC = [0, 0, 0], compC = [0, 0, 0], compLin = [0, 0, 0];
    for (let py = y0; py < y1; py++) {
        let rand = null;
        if (mi.special === 'dissolve') {
            rand = mt(DISSOLVE_SEEDS[((py % 4096) + 4096) % 4096]);
            for (let k = 0; k < x0; k++) rand();
        }
        for (let px = x0; px < x1; px++) {
            const d = (py * W + px) * 4;
            const lx = px - x, ly = py - y;
            const inside = lx >= 0 && ly >= 0 && lx < w && ly < h;
            const s = inside ? (ly * w + lx) * 4 : -1;
            const layerA = inside ? src[s + 3] : 0;
            let m = opacity;
            if (mask && inside) m *= mask[ly * w + lx];
            else if (mask && !inside) m = 0;
            const inA = dst[d + 3];

            if (mi.special === 'dissolve') {
                // as GIMP computes it, in 32-bit floats: alpha × opacity × 255 (× mask)
                let v = Math.fround(Math.fround(Math.fround(layerA) * Math.fround(opacity)) * 255);
                if (mask && inside) v = Math.fround(v * mask[ly * w + lx]);
                if (randRange255(rand) < v && inside) {
                    dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2];
                    dst[d + 3] = mi.composite === 'U' || mi.composite === 'Y' ? 1 : inA;
                } else if (mi.composite === 'Y' || mi.composite === 'I') dst[d + 3] = 0;
                continue;
            }
            if (mi.special === 'merge') { // gimpoperationmerge.c, union
                const la = layerA * m, ia = Math.min(inA, 1 - la), na = ia + la;
                if (na) { const ratio = la / na; for (let c = 0; c < 3; c++) dst[d + c] += (src[s + c] - dst[d + c]) * ratio; }
                dst[d + 3] = na;
                continue;
            }
            if (mi.special === 'split') { dst[d + 3] = Math.max(inA - layerA * m, 0); continue; } // gimpoperationsplit.c, clip to backdrop
            if (mi.special === 'erase') { dst[d + 3] = inA * (1 - layerA * m); continue; }
            if (mi.special === 'anti-erase') { dst[d + 3] = inA + (1 - inA) * layerA * m; continue; }
            if (mi.special === 'replace') {
                const a = inside ? m : 0;
                const la = layerA, na = inA + (la - inA) * a;
                if (na > 0) for (let c = 0; c < 3; c++) dst[d + c] = (dst[d + c] * inA * (1 - a) + (inside ? src[s + c] : 0) * la * a) / na;
                dst[d + 3] = na;
                continue;
            }
            if (mi.special === 'behind') {
                const la = layerA * m;
                const na = inA + (1 - inA) * la;
                if (na > 0 && la > 0) for (let c = 0; c < 3; c++) dst[d + c] = (dst[d + c] * inA + src[s + c] * la * (1 - inA)) / na;
                dst[d + 3] = na;
                continue;
            }
            if (!inside && !full) continue;
            if (mi.special === 'color-erase') { // blend (color_erase) and composite (clip_to_backdrop_sub)
                if (!inside) continue;
                const la = layerA * m;
                let ca = 0;
                if (inA !== 0 && layerA !== 0) {
                    toSpace(dst, d, mi.blendSpace, iB);
                    toSpace(src, s, mi.blendSpace, lB);
                    for (let c = 0; c < 3; c++) {
                        const col = clamp01(iB[c]), bg = clamp01(lB[c]);
                        if (Math.abs(col - bg) > EPS) ca = Math.max(ca, col > bg ? (col - bg) / (1 - bg) : (bg - col) / bg);
                    }
                    if (ca > EPS) { const inv = 1 / ca; for (let c = 0; c < 3; c++) cB[c] = (iB[c] - lB[c]) * inv + lB[c]; }
                    else { cB[0] = cB[1] = cB[2] = 0; }
                    fromSpace(cB, mi.blendSpace, compLin);
                }
                const cs = mi.compositeSpace;
                const cav = ca * la, na = 1 - la + cav;
                if (inA !== 0 && cav !== 0) {
                    toSpace(dst, d, cs, inC); toSpace(compLin, 0, cs, compC);
                    const ratio = cav / na;
                    for (let c = 0; c < 3; c++) tmp[c] = compC[c] * ratio + inC[c] * (1 - ratio);
                    fromSpace(tmp, cs, compLin);
                    dst[d] = compLin[0]; dst[d + 1] = compLin[1]; dst[d + 2] = compLin[2];
                }
                dst[d + 3] = na * inA;
                continue;
            }
            // blend in the blend space
            if (inside && layerA > 0 && inA > 0) {
                toSpace(dst, d, mi.blendSpace, iB);
                toSpace(src, s, mi.blendSpace, lB);
                if (sep) for (let c = 0; c < 3; c++) cB[c] = sep(iB[c], lB[c]);
                else if (nonsep) nonsep(iB, lB, cB);
                else for (let c = 0; c < 3; c++) cB[c] = lB[c];
                if (mi.legacy && LEGACY_CLAMP.has(mi.blend)) for (let c = 0; c < 3; c++) cB[c] = clamp01(cB[c]);
                fromSpace(cB, mi.blendSpace, compLin);
            } else if (inside) {
                compLin[0] = src[s]; compLin[1] = src[s + 1]; compLin[2] = src[s + 2];
            }
            // composite in the composite space
            const cs = mi.compositeSpace;
            toSpace(dst, d, cs, inC);
            if (inside) { toSpace(src, s, cs, layC); toSpace(compLin, 0, cs, compC); }
            let outA;
            if (mi.legacy) {
                const ca = Math.min(inA, layerA) * m;
                const na = inA + (1 - inA) * ca;
                if (ca && na) { const ratio = ca / na; for (let c = 0; c < 3; c++) tmp[c] = compC[c] * ratio + inC[c] * (1 - ratio); }
                else { tmp[0] = inC[0]; tmp[1] = inC[1]; tmp[2] = inC[2]; }
                outA = inA;
            } else if (mi.composite === 'U') {
                let la = layerA * m;
                if (mi.special === 'dissolve') la = Math.random() < la ? 1 : 0;
                const na = la + (1 - la) * inA;
                if (la === 0 || na === 0) { tmp[0] = inC[0]; tmp[1] = inC[1]; tmp[2] = inC[2]; }
                else if (inA === 0) { tmp[0] = layC[0]; tmp[1] = layC[1]; tmp[2] = layC[2]; }
                else { const ratio = la / na; for (let c = 0; c < 3; c++) tmp[c] = ratio * (inA * (compC[c] - layC[c]) + layC[c] - inC[c]) + inC[c]; }
                outA = na;
            } else if (mi.composite === 'B') {
                const la = layerA * m; // the blend's alpha is the layer's
                if (inA === 0 || la === 0) { tmp[0] = inC[0]; tmp[1] = inC[1]; tmp[2] = inC[2]; }
                else for (let c = 0; c < 3; c++) tmp[c] = compC[c] * la + inC[c] * (1 - la);
                outA = inA;
            } else if (mi.composite === 'Y') {
                const la = layerA * m;
                if (la === 0) { tmp[0] = inC[0]; tmp[1] = inC[1]; tmp[2] = inC[2]; }
                else if (inA === 0) { tmp[0] = layC[0]; tmp[1] = layC[1]; tmp[2] = layC[2]; }
                else for (let c = 0; c < 3; c++) tmp[c] = compC[c] * inA + layC[c] * (1 - inA);
                outA = la;
            } else { // intersection
                const na = inA * layerA * m;
                if (na === 0) { tmp[0] = inC[0]; tmp[1] = inC[1]; tmp[2] = inC[2]; }
                else { tmp[0] = compC[0]; tmp[1] = compC[1]; tmp[2] = compC[2]; }
                outA = na;
            }
            fromSpace(tmp, cs, compLin);
            dst[d] = compLin[0]; dst[d + 1] = compLin[1]; dst[d + 2] = compLin[2]; dst[d + 3] = outA;
        }
    }
}

// Composites a list of layers (top first) onto dst. stack.empty: nothing is
// below yet (the image, or an isolated group, before its first visible layer)
// - then, as GIMP does for its "last node", the layer is drawn as is (with its
// opacity and mask) whatever its mode, except for modes that change the layer
// itself (dissolve, anti-erase), which composite as UNION
function compositeList(list, dst, W, H, changes, stack) {
    for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i];
        const e = effective(l, changes);
        if (!e.visible || l.broken || l.floating) continue;
        let mi = modeInfo(e.mode, l);
        if (stack.empty && !(l.children && mi.special === 'pass-through')) {
            mi = mi.special === 'dissolve' || mi.special === 'anti-erase' ? { ...mi, composite: 'U' } : modeInfo(28, {});
        }
        const mask = l.mask && e.applyMask ? l.mask.data : null;
        if (l.children) {
            if (mi.special === 'pass-through') {
                // Children straight onto the backdrop, then mixed back by opacity (and mask)
                // (its children see this stack's backdrop, so they share its state)
                if (e.opacity >= 1 && !mask) { compositeList(l.children, dst, W, H, changes, stack); continue; }
                const copy = dst.slice();
                const wasEmpty = stack.empty;
                compositeList(l.children, copy, W, H, changes, stack);
                for (let p = 0, n = W * H; p < n; p++) {
                    let a = e.opacity;
                    if (mask) {
                        const lx = (p % W) - l.x, ly = Math.floor(p / W) - l.y;
                        a *= lx >= 0 && ly >= 0 && lx < l.width && ly < l.height ? mask[ly * l.width + lx] : 0;
                    }
                    const d = p * 4;
                    const ia = dst[d + 3], ca = copy[d + 3], na = ia + (ca - ia) * a;
                    if (na > 0) for (let c = 0; c < 3; c++) dst[d + c] = (dst[d + c] * ia * (1 - a) + copy[d + c] * ca * a) / na;
                    dst[d + 3] = na;
                }
                if (wasEmpty) stack.empty = false;
                continue;
            }
            const buf = new Float32Array(W * H * 4);
            compositeList(l.children, buf, W, H, changes, { empty: true });
            compositeLayer(dst, W, H, buf, W, H, 0, 0, e.opacity, groupMask(l, mask, W, H), mi);
            stack.empty = false;
        } else if (l.pixels) {
            compositeLayer(dst, W, H, l.pixels, l.width, l.height, l.x, l.y, e.opacity, mask, mi);
            stack.empty = false;
        }
    }
}

// A group's mask, which is in the group's own extent, spread over the image
function groupMask(l, mask, W, H) {
    if (!mask) return null;
    const out = new Float32Array(W * H);
    for (let y = 0; y < l.height; y++) {
        const iy = y + l.y;
        if (iy < 0 || iy >= H) continue;
        for (let x = 0; x < l.width; x++) {
            const ix = x + l.x;
            if (ix >= 0 && ix < W) out[iy * W + ix] = mask[y * l.width + x];
        }
    }
    return out;
}

function toRgba8(buf, W, H) {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H * 4; i += 4) {
        const a = buf[i + 3];
        out[i] = Math.round(clamp01(nl(buf[i])) * 255);
        out[i + 1] = Math.round(clamp01(nl(buf[i + 1])) * 255);
        out[i + 2] = Math.round(clamp01(nl(buf[i + 2])) * 255);
        out[i + 3] = Math.round(clamp01(a) * 255);
    }
    return out;
}

// A small preview of a layer (or group, composited alone)
function thumbnail(l, img, changes) {
    const T = 40;
    const W = img.width, H = img.height;
    let src, w, h;
    if (l.children) {
        const buf = new Float32Array(W * H * 4);
        compositeList(l.children, buf, W, H, changes, { empty: true });
        src = buf; w = W; h = H;
    } else if (l.pixels) { src = l.pixels; w = l.width; h = l.height; }
    else return null;
    const scale = Math.min(T / w, T / h, 1);
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const sx = Math.min(w - 1, Math.floor((x + 0.5) / scale)), sy = Math.min(h - 1, Math.floor((y + 0.5) / scale));
        const s = (sy * w + sx) * 4, o = (y * tw + x) * 4;
        out[o] = clamp01(nl(src[s])) * 255; out[o + 1] = clamp01(nl(src[s + 1])) * 255; out[o + 2] = clamp01(nl(src[s + 2])) * 255; out[o + 3] = clamp01(src[s + 3]) * 255;
    }
    return { width: tw, height: th, data: out };
}

let image = null;
let tree = null;

function describe(l, depth) {
    const mi = modeInfo(l.mode, l);
    return {
        id: l.id, name: l.name, depth, group: !!l.children, visible: l.visible, opacity: l.opacity, mode: l.mode,
        modeName: mi.name, x: l.x, y: l.y, width: l.width, height: l.height, hasMask: !!l.mask, applyMask: l.applyMask,
        text: l.text, link: l.link, vector: l.vector, floating: l.floating, broken: !!l.broken, effects: l.effects || 0,
        composite: mi.composite, blendSpace: mi.blendSpace, compositeSpace: mi.compositeSpace,
        approximate: false,
    };
}

function flatten(list, depth, out) {
    for (const l of list) {
        out.push(describe(l, depth));
        if (l.children) flatten(l.children, depth + 1, out);
    }
    return out;
}

function render(changes) {
    const W = image.width, H = image.height;
    const buf = new Float32Array(W * H * 4);
    compositeList(tree, buf, W, H, changes, { empty: true });
    return toRgba8(buf, W, H);
}

self.onmessage = ({ data }) => {
    const { id, cmd } = data;
    try {
        if (cmd === 'open') {
            image = parseXcf(new Uint8Array(data.bytes));
            tree = buildTree(image.layers);
            const layers = flatten(tree, 0, []);
            const thumbs = {};
            for (const l of image.layers) { try { const t = thumbnail(l, image, {}); if (t) thumbs[l.id] = t; } catch { /* no preview */ } }
            const kind = Math.floor(image.precision / 100), trc = image.precision % 100;
            const comment = image.parasites['gimp-comment'];
            const info = {
                version: image.version, width: image.width, height: image.height,
                mode: ['RGB', 'Grayscale', 'Indexed'][image.baseType] || '?',
                precision: `${PRECISION_NAMES[kind] || '?'}, ${TRC_NAMES[trc] || '?'}`,
                compression: ['none', 'RLE', 'zlib', 'fractal'][image.compression] || image.compression,
                resolution: image.resolution, channels: image.channels, colors: image.colormap ? image.colormap.length / 3 : 0,
                comment: comment ? new TextDecoder().decode(comment).replace(/\0+$/, '') : '',
                modes: MODES.map(m => m[0]),
            };
            const pixels = render({});
            self.postMessage({ id, result: { info, layers, thumbs, image: pixels } }, [pixels.buffer]);
        } else if (cmd === 'render') {
            const pixels = render(data.changes || {});
            self.postMessage({ id, result: { image: pixels } }, [pixels.buffer]);
        } else if (cmd === 'layer') {
            const l = image.layers.find(x => x.id === data.layerId);
            const W = image.width, H = image.height;
            const buf = new Float32Array(W * H * 4);
            // The layer alone, at full opacity and in normal mode, with its mask
            const solo = { ...l, visible: true, opacity: 1, mode: 28, blendSpace: 0, compositeSpace: 0, compositeMode: 0 };
            compositeList([solo], buf, W, H, { [l.id]: { visible: true, opacity: 1, mode: 28 } }, { empty: true });
            const pixels = toRgba8(buf, W, H);
            self.postMessage({ id, result: { image: pixels } }, [pixels.buffer]);
        }
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
