// --- OpenEXR (.exr) ---
// No browser shows OpenEXR, ILM's high dynamic range format for film and
// rendering. A file is read in a worker (public/exr-worker.js: @bb-studio/exr
// for scanline parts, three.js's EXRLoader for tiled and deep ones) to float
// planes, a plane per channel (luminance / chroma turned into RGB here), then
// tone mapped as a Radiance picture is (src/rgbe.js): times 2^exposure,
// clipped or Reinhard, to sRGB, an exposure slider and a choice over the image
// viewer. Its parts and layers (channels named layer.R, layer.G...) are what
// there is to show: each layer's RGB(A) in color, every other channel (Y, Z,
// ids, vectors...) in grey, picked from a list. Alpha is premultiplied in
// OpenEXR: the colors are divided by it for the PNG. What is shown is the
// display window, the data window in its place in it (outside it black, or
// clear); colors as stored (a file's chromaticities aren't applied, but for
// turning luminance / chroma into RGB).
const { createLogger } = require('./debug');
const { srgb, rgbaToPng, addRgbeControls } = require('./rgbe');

const log = createLogger('EXR');
const EXR_RE = /\.exr$/i;
const KINDS = { tiledimage: 'tiled', deepscanline: 'deep (flattened)', deeptile: 'deep tiled' };

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<{ views, label }>
const toned = new Map(); // source URL + '#' + view + '#' + exposure + '#' + tone -> Promise<{ url, width, height, label }>

function isExrName(name) {
    return EXR_RE.test(name || '');
}

// { parts: [{ name, width, height, channels, planes, types, reader, kind, compression }], skipped }
function exrDecode(bytes) {
    if (!worker) {
        worker = new Worker('/exr-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'OpenEXR decoder failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
    });
}

// Luminance weights of the primaries (what OpenEXR's RgbaYca calls Yw): the Y
// row of the RGB to XYZ matrix, from the header's chromaticities, else
// Rec. 709's (OpenEXR's default)
function lumaWeights(c) {
    if (!c) return [0.2126, 0.7152, 0.0722];
    // the primaries' xyz as columns, scaled so that RGB 1 1 1 is the white (Y = 1)
    const P = [c.redX, c.greenX, c.blueX, c.redY, c.greenY, c.blueY,
        1 - c.redX - c.redY, 1 - c.greenX - c.greenY, 1 - c.blueX - c.blueY];
    const W = [c.whiteX / c.whiteY, 1, (1 - c.whiteX - c.whiteY) / c.whiteY];
    // solve P s = W (Cramer's rule)
    const det = m => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    const d = det(P);
    if (!d) return [0.2126, 0.7152, 0.0722];
    const s = [0, 1, 2].map(k => det(P.map((v, i) => (i % 3 === k ? W[(i / 3) | 0] : v))) / d);
    const y = [P[3] * s[0], P[4] * s[1], P[5] * s[2]];
    const sum = y[0] + y[1] + y[2];
    return y.map(v => v / sum);
}

// A luminance / chroma image's Y, RY, BY as R, G, B planes, as OpenEXR's
// RgbaYca turns them: R = (RY + 1) Y, B = (BY + 1) Y, G from Y and the weights
// (the chroma as @bb-studio/exr expands it, each sample repeated, not filtered
// as OpenEXR's reconstruction does: colors at sharp edges differ a little)
function ycaToRgb(Y, RY, BY, chromaticities) {
    const [wr, wg, wb] = lumaWeights(chromaticities);
    const n = Y.length;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const y = Y[i];
        R[i] = (RY[i] + 1) * y;
        B[i] = (BY[i] + 1) * y;
        G[i] = (y - R[i] * wr - B[i] * wb) / wg;
    }
    return [R, G, B];
}

// What there is to show of a part: each layer's R, G, B (and A) in color, the
// other channels on their own; { label, width, height (the display window's),
// dataWidth, dataHeight, dx, dy (where the data window is in it), rgb: [planes]
// | grey: plane, alpha }
function partViews(part, multi) {
    const byName = new Map(part.channels.map((c, i) => [c, part.planes[i]]));
    const layers = new Map(); // 'diffuse' -> Set of its channels' last names
    for (const c of part.channels) {
        const dot = c.lastIndexOf('.');
        const layer = dot < 0 ? '' : c.slice(0, dot);
        if (!layers.has(layer)) layers.set(layer, new Set());
        layers.get(layer).add(dot < 0 ? c : c.slice(dot + 1));
    }
    const prefix = multi ? `${part.name || 'part'}: ` : '';
    // the data window's place in the display window (the data window alone if there is none)
    const data = part.dataWindow || { xMin: 0, yMin: 0, xMax: part.width - 1, yMax: part.height - 1 };
    const shown = part.displayWindow || data;
    const frame = {
        dataWidth: part.width, dataHeight: part.height,
        width: shown.xMax - shown.xMin + 1, height: shown.yMax - shown.yMin + 1,
        dx: data.xMin - shown.xMin, dy: data.yMin - shown.yMin,
    };
    const views = [];
    const used = new Set();
    for (const [layer, names] of layers) {
        const full = n => (layer ? `${layer}.${n}` : n);
        if (['Y', 'RY', 'BY'].every(n => names.has(n))) {
            const alpha = names.has('A') ? byName.get(full('A')) : null;
            views.push({
                label: prefix + (layer ? `${layer} (Y RY BY)` : 'RGB (Y RY BY)') + (alpha ? ' + A' : ''),
                ...frame, rgb: ycaToRgb(byName.get(full('Y')), byName.get(full('RY')), byName.get(full('BY')), part.chromaticities), alpha,
            });
            for (const n of ['Y', 'RY', 'BY', 'A']) used.add(full(n));
            continue;
        }
        if (['R', 'G', 'B'].every(n => names.has(n))) {
            const alpha = names.has('A') ? byName.get(full('A')) : null;
            views.push({
                label: prefix + (layer || 'RGB') + (alpha ? (layer ? ' (RGBA)' : 'A') : (layer ? ' (RGB)' : '')),
                ...frame, rgb: ['R', 'G', 'B'].map(n => byName.get(full(n))), alpha,
            });
            for (const n of ['R', 'G', 'B', 'A']) used.add(full(n));
        }
    }
    for (const c of part.channels) {
        if (!used.has(c)) views.push({ label: prefix + c, ...frame, grey: byName.get(c) });
    }
    return views;
}

function exrFile(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const { parts, skipped } = await exrDecode(new Uint8Array(await resp.arrayBuffer()));
            const multi = parts.length + skipped.length > 1;
            const views = parts.flatMap(part => partViews(part, multi));
            if (!views.length) throw new Error('no channels');
            // what the parts are: tiled, deep..., compressed how, of which types
            const kinds = [...new Set(parts.map(x => KINDS[x.kind] || ''))].filter(Boolean);
            const compressions = [...new Set(parts.map(x => x.compression))].filter(Boolean);
            const types = [...new Set(parts.flatMap(x => Object.values(x.types)))];
            const label = ['OpenEXR', multi && `${parts.length + skipped.length} parts`, ...kinds, ...compressions, types.join(' / ')].filter(Boolean).join(', ')
                + `, read by ${[...new Set(parts.map(x => x.reader))].join(' and ')}`
                + (skipped.length ? `; not shown: ${skipped.join('; ')}` : '');
            return { views, label };
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: a new exposure tone maps again, it doesn't decode again
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// A view as 8-bit sRGBA, its display window: times 2^exposure, then 'clip' (to
// 1) or 'reinhard' (by luminance, L / (1 + L)); colors divided by alpha
// (premultiplied in OpenEXR); outside the data window zero (black, or clear)
function exrToneMap(view, exposure = 0, tone = 'clip') {
    const { width, height, dataWidth, dataHeight, dx, dy } = view;
    const out = new Uint8ClampedArray(width * height * 4);
    const k = Math.pow(2, exposure);
    const [R, G, B] = view.rgb || [view.grey, view.grey, view.grey];
    const A = view.alpha;
    for (let y = 0; y < height; y++) {
        const sy = y - dy;
        for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
            const sx = x - dx;
            if (sy < 0 || sy >= dataHeight || sx < 0 || sx >= dataWidth) {
                out[o + 3] = A ? 0 : 255;
                continue;
            }
            const i = sy * dataWidth + sx;
            let r = R[i] * k, g = G[i] * k, b = B[i] * k;
            let a = 1;
            if (A) {
                a = A[i];
                if (a > 0 && a < 1) { r /= a; g /= a; b /= a; }
            }
            if (tone === 'reinhard') {
                const s = 1 / (1 + Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b));
                r *= s; g *= s; b *= s;
            }
            // NaN as 0
            out[o] = srgb(r || 0);
            out[o + 1] = srgb(g || 0);
            out[o + 2] = srgb(b || 0);
            out[o + 3] = A ? Math.round(255 * Math.min(1, Math.max(0, a || 0))) : 255;
        }
    }
    return out;
}

// View `view` of the file at url, tone mapped: { url (a blob: URL of its PNG),
// width, height, label, views: [labels], view }
function exrImage(url, exposure = 0, tone = 'clip', view = 0) {
    const key = `${url}#${view}#${exposure}#${tone}`;
    let p = toned.get(key);
    if (!p) {
        p = (async () => {
            const d = await exrFile(url);
            const n = Math.max(0, Math.min(d.views.length - 1, view));
            const v = d.views[n];
            const png = await rgbaToPng(exrToneMap(v, exposure, tone), v.width, v.height);
            return { url: URL.createObjectURL(png), width: v.width, height: v.height, label: d.label, views: d.views.map(x => x.label), view: n };
        })();
        toned.set(key, p);
        p.catch(err => { toned.delete(key); log.warn('OpenEXR decode failed:', err); });
        if (toned.size > 64) {
            const [oldKey, old] = toned.entries().next().value;
            toned.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// The viewer's <img> for an OpenEXR file: the exposure slider and tone curve
// (as for Radiance pictures), and with more than one layer, channel or part,
// a list to pick what is shown
function addExrControls(root, img, url) {
    root.style.position = 'relative';
    let view = 0;
    const bar = addRgbeControls(root, img, url, (u, ev = 0, tone = 'clip') => exrImage(u, ev, tone, view));
    exrImage(url).then(d => {
        img.title = `${d.label}, ${d.width}×${d.height}`;
        if (d.views.length < 2) return;
        const tone = bar.querySelector('select');
        const pick = document.createElement('select');
        pick.title = 'Layer, channel or part';
        pick.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;max-width:14em;';
        d.views.forEach((label, i) => pick.add(new Option(label, String(i))));
        pick.onchange = () => {
            view = +pick.value;
            // the exposure and tone as they are, for this view
            tone.onchange();
        };
        bar.insertBefore(pick, bar.firstChild);
    }).catch(err => { img.title = `Could not read the OpenEXR file: ${err.message}`; });
    return bar;
}

module.exports = { isExrName, exrImage, exrToneMap, addExrControls };
