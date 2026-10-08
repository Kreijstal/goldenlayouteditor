// MediBang Paint / FireAlpaca files (.mdp), read and composited in a worker, for
// the MDP viewer (src/mdp-plugin.js). Written from the format's description by
// its author (nattou.org's "MDP format" notes, as rsuzaki/mdp_format and
// weeb-poly's krita-plugin-mdp carry them) and fitted to what FireAlpaca 2.13
// exports from the same files.
//
// An .mdp ("mdipack", the MDI and MDIBIN files packed) is "mdipack\0", a version
// (0), the size of the XML part and of the binary part, then both. The XML is
// <Mdiapp width height dpi ...> with <Thumb> and <Layers>: each <Layer> has its
// place and size, blend mode, opacity (alpha, 0-255), visibility, clipping, its
// parent folder (parentId) and "bin", the name of its data in the binary part.
// Layers are listed bottom first, a folder after what's in it. The binary part is
// "PAC " entries: a 132-byte header (chunk size, stored or zlib'd, stream size,
// size unpacked, 48 reserved bytes, a 64-byte name) and the data. The thumbnail
// is BGRA rows; a layer is 128 × 128 tiles: a count, the tile size, then for each
// tile its column, row, compression (0 zlib, 1 Snappy, 2 FastLZ), size and data,
// padded to 4 bytes. A tile is BGRA (32bpp), an 8-bit alpha (8bpp) or 1-bit
// alpha, least significant bit first (1bpp), in the layer's colour.
//
// The picture is composited 128 × 128 pixels at a time, as FireAlpaca does (each
// rule fitted to its exports of files made to test it): its blend modes, opacity,
// folders (isolated or passed through), clipping (onto the base as if it were
// opaque, then the whole as the base), masks and stencils (8-bit layers that take
// alpha off the layer below), grey and monochrome layers in their colour,
// halftone screens and the paper when the checkerboard is off.
//   → { id, cmd: 'open', bytes }             ← { info, layers, thumbs, stored, image }
//   → { id, cmd: 'render', changes, paper }  ← { image }
//   → { id, cmd: 'layer', layerId }          ← { image } (one layer alone)
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const THUMB = 40;
const TILE = 128;
const TILE_PIXELS = TILE * TILE;
// Decoded layer tiles kept between renders (bytes)
const CACHE_BYTES = 384 << 20;

// --- The XML part: tags and attributes are all FireAlpaca writes ---

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m);

function parseXml(text) {
    const root = { name: '', attrs: {}, children: [] };
    const stack = [root];
    const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^]*?\?>|<!--[^]*?-->/g;
    for (let m; (m = tag.exec(text));) {
        if (!m[2]) continue;
        const top = stack[stack.length - 1];
        if (m[1]) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const el = { name: m[2], attrs: {}, children: [] };
        for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]] = unescape(a[2] ?? a[3]);
        top.children.push(el);
        if (!m[4]) stack.push(el);
    }
    return root;
}
const child = (el, name) => el && el.children.find(c => c.name === name);

// --- The binary part: "PAC " entries ---

function readArchives(bytes, start, end) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Map();
    let p = start;
    while (p + 132 <= end) {
        if (bytes[p] !== 0x50 || bytes[p + 1] !== 0x41 || bytes[p + 2] !== 0x43 || bytes[p + 3] !== 0x20) throw new Error(`no "PAC " entry at ${p}`);
        const chunk = dv.getUint32(p + 4, true), type = dv.getUint32(p + 8, true);
        const size = dv.getUint32(p + 12, true), outSize = dv.getUint32(p + 16, true);
        let n = 0;
        while (n < 64 && bytes[p + 68 + n]) n++;
        const name = new TextDecoder().decode(bytes.subarray(p + 68, p + 68 + n));
        out.set(name, { type, at: p + 132, size: Math.min(size, end - p - 132), outSize });
        if (chunk < 132) break;
        p += chunk;
    }
    return out;
}

function archiveData(a) {
    const raw = doc.bytes.subarray(a.at, a.at + a.size);
    if (a.type === 0) return raw;
    if (a.type === 1) return fflate.unzlibSync(raw);
    throw new Error(`unknown PAC compression ${a.type}`);
}

// --- Tile compressions: zlib, Snappy, FastLZ ---

function snappy(src, outSize) {
    let p = 0, len = 0, shift = 0, c;
    do { c = src[p++]; len |= (c & 0x7f) << shift; shift += 7; } while (c & 0x80);
    const out = new Uint8Array(len);
    let o = 0;
    while (p < src.length && o < len) {
        const tag = src[p++];
        let n, off;
        switch (tag & 3) {
            case 0: {
                n = tag >> 2;
                if (n >= 60) { const k = n - 59; n = 0; for (let i = 0; i < k; i++) n |= src[p++] << (8 * i); }
                n++;
                out.set(src.subarray(p, p + n), o);
                p += n; o += n;
                continue;
            }
            case 1: n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; break;
            case 2: n = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; break;
            default: n = (tag >> 2) + 1; off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0; p += 4;
        }
        if (!off || off > o) throw new Error('bad Snappy data');
        for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
    }
    return outSize && out.length !== outSize ? out.subarray(0, outSize) : out;
}

// FastLZ levels 1 and 2 (the level is in the first byte's top 3 bits)
function fastlz(src, outSize) {
    const out = new Uint8Array(outSize);
    const level = (src[0] >> 5) + 1;
    let p = 0, o = 0, ctrl = src[p++] & 31;
    for (;;) {
        if (ctrl >= 32) {
            let len = (ctrl >> 5) - 1, ref = o - ((ctrl & 31) << 8) - 1;
            if (level === 1) {
                if (len === 6) len += src[p++];
                ref -= src[p++];
            } else {
                if (len === 6) { let c; do { c = src[p++]; len += c; } while (c === 255); }
                const c = src[p++];
                ref -= c;
                if (c === 255 && (ctrl & 31) === 31) { ref = o - ((src[p] << 8) | src[p + 1]) - 8191 - 1; p += 2; }
            }
            len += 3;
            if (ref < 0 || o + len > outSize) throw new Error('bad FastLZ data');
            for (let i = 0; i < len; i++, o++) out[o] = out[ref + i];
        } else {
            ctrl++;
            if (o + ctrl > outSize) throw new Error('bad FastLZ data');
            out.set(src.subarray(p, p + ctrl), o);
            p += ctrl; o += ctrl;
        }
        if (p >= src.length) break;
        ctrl = src[p++];
    }
    return out;
}

// --- The document ---

let doc = null;
let changes = {};

const BLEND_MODES = [
    ['normal', 'Normal'], ['mul', 'Multiply'], ['add', 'Add'], ['sub', 'Subtract'], ['div', 'Divide'],
    ['overlay', 'Overlay'], ['screen', 'Screen'], ['light', 'Lighten'], ['dark', 'Darken'], ['diff', 'Difference'],
    ['exclusion', 'Exclusion'], ['dodge', 'Color dodge'], ['burn', 'Color burn'], ['ldodge', 'Linear dodge'],
    ['lburn', 'Linear burn'], ['softlight', 'Soft light'], ['hardlight', 'Hard light'], ['hue', 'Hue'],
    ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'], ['hardmix', 'Hard mix'], ['inverse', 'Inverse'],
    ['through', 'Pass through'],
];
const KNOWN_MODES = new Set(BLEND_MODES.map(m => m[0]));

const bool = (v, dflt) => v === undefined ? dflt : v === 'true' || v === '1';
const int = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };

function openMdp(bytes) {
    if (bytes.length < 20 || new TextDecoder().decode(bytes.subarray(0, 7)) !== 'mdipack') throw new Error('not an .mdp file (no "mdipack")');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint32(8, true), mdiSize = dv.getUint32(12, true), binSize = dv.getUint32(16, true);
    if (20 + mdiSize > bytes.length) throw new Error('the file is cut short');
    const xml = parseXml(new TextDecoder().decode(bytes.subarray(20, 20 + mdiSize)));
    const app = child(xml, 'Mdiapp');
    if (!app) throw new Error('no <Mdiapp> in the file');
    const archives = readArchives(bytes, 20 + mdiSize, Math.min(bytes.length, 20 + mdiSize + binSize));
    const width = int(app.attrs.width, 0), height = int(app.attrs.height, 0);
    if (!(width > 0 && height > 0)) throw new Error('no canvas size');
    doc = { bytes, width, height, archives, cache: new Map(), cacheBytes: 0 };

    const els = (child(app, 'Layers') || { children: [] }).children.filter(c => c.name === 'Layer');
    const layers = els.map((e, index) => makeLayer(e, index, archives));
    const byId = new Map(layers.map(l => [l.id, l]));
    // the tree: each folder's children in the order listed (bottom first)
    const top = [];
    for (const l of layers) {
        const parent = l.parent !== -1 && byId.get(l.parent);
        if (parent && parent.folder && parent !== l) parent.children.push(l); else { l.parent = -1; top.push(l); }
    }
    // each mask is the nearest layer's below it in the same folder
    for (const list of [top, ...layers.filter(l => l.folder).map(l => l.children)]) {
        let target = null;
        for (const l of list) {
            if (!l.mask) target = l;
            else if (target) target.masks.push(l);
        }
    }
    // depth for the panel; a folder inside itself (broken files) ends the walk
    const ordered = [];
    const walk = (list, depth, seen) => {
        for (let i = list.length - 1; i >= 0; i--) {
            const l = list[i];
            if (seen.has(l)) continue;
            l.depth = depth;
            ordered.push(l);
            if (l.folder) walk(l.children, depth + 1, new Set([...seen, l]));
        }
    };
    walk(top, 0, new Set());
    doc.top = top;
    doc.byId = byId;
    doc.layers = ordered; // top first, as the panel shows them

    const thumb = child(app, 'Thumb');
    const appInfo = child(app, 'appInfo');
    const created = child(app, 'CreateTime'), updated = child(app, 'UpdateTime');
    const anim = child(app, 'Animation');
    doc.info = {
        width, height, version,
        dpi: int(app.attrs.dpi, 0),
        checker: bool(app.attrs.checkerBG, true),
        background: ['bgColorR', 'bgColorG', 'bgColorB'].map(k => int(app.attrs[k], 255)),
        thumb: thumb ? [int(thumb.attrs.width, 0), int(thumb.attrs.height, 0)] : null,
        app: appInfo ? `${appInfo.attrs.name || ''}${appInfo.attrs.rev ? ` (rev ${appInfo.attrs.rev})` : ''}` : '',
        created: created ? created.attrs.timeString || '' : '',
        updated: updated ? `${updated.attrs.timeString || ''}${updated.attrs.rev ? `, revision ${updated.attrs.rev}` : ''}` : '',
        animation: anim && bool(anim.attrs.enabled, false) ? `${int(anim.attrs.fps, 0)} fps` : '',
        icc: archives.has('icc_rgb') || archives.has('icc_cmyk'),
        modes: BLEND_MODES,
    };
    return doc;
}

function makeLayer(e, index, archives) {
    const a = e.attrs;
    const type = a.type || '32bpp';
    const color = /^[0-9a-f]{8}$/i.test(a.color || '') ? a.color : 'FF000000';
    const l = {
        id: int(a.id, 100000 + index),
        index,
        name: a.name || '',
        type,
        folder: type === 'folder',
        children: [],
        parent: int(a.parentId, -1),
        x: int(a.ofsx, 0), y: int(a.ofsy, 0),
        width: int(a.width, 0), height: int(a.height, 0),
        mode: a.mode || 'normal',
        opacity: Math.max(0, Math.min(255, int(a.alpha, 255))) / 255,
        visible: bool(a.visible, true),
        clipping: bool(a.clipping, false),
        protectAlpha: bool(a.protectAlpha, false),
        locked: bool(a.locked, false),
        draft: bool(a.draft, false),
        lumi: bool(a.lumi, true),
        // a mask or stencil for the layer below
        mask: bool(a.masking, false) && type !== 'folder',
        stencil: a.maskingType === '1',
        masks: [],
        // ARGB: the colour a grey or monochrome layer is drawn in
        color: [parseInt(color.slice(2, 4), 16), parseInt(color.slice(4, 6), 16), parseInt(color.slice(6, 8), 16), parseInt(color.slice(0, 2), 16)],
        // 8bpp layers drawn as a halftone screen: dots ("circle" or any other name), or lines
        halftone: type === '8bpp' && !bool(a.masking, false) && a.halftoneType && a.halftoneType !== 'none'
            ? (a.halftoneType === 'xline' || a.halftoneType === 'yline' ? a.halftoneType : 'dots') : '',
        halftoneLines: Math.max(1, int(a.halftoneLine, 5)),
        text: type === 'text' ? e.children.filter(c => c.name === 'Line').map(c => c.attrs.text || '').join('\n') : '',
        tiles: null,
        tileSize: TILE,
        problem: '',
    };
    if (!KNOWN_MODES.has(l.mode)) { l.problem = `blend mode "${l.mode}" isn't known: drawn as Normal`; l.mode = 'normal'; }
    if (l.mode === 'through' && !l.folder) l.mode = 'normal';
    if (a.effect && a.effect !== 'none' && a.effect !== '0') l.problem = `effect "${a.effect}" (watercolour edge): not applied`;
    if (type === 'text') {
        // the text as FireAlpaca rasterised it, at the text's place
        l.x += int(a.tofsx, 0);
        l.y += int(a.tofsy, 0);
    }
    if (!l.folder) {
        l.bpp = type === '8bpp' ? 8 : type === '1bpp' ? 1 : 32;
        const ar = archives.get(a.bin);
        if (!/^(32bpp|8bpp|1bpp|text)$/.test(type)) {
            l.problem = `a "${type}" layer: not applied (unknown pixels)`;
            l.tiles = new Map();
        } else if (ar) {
            try { readTiles(l, archiveData(ar)); } catch (err) { l.problem = `its pixels: ${err.message}`; l.tiles = new Map(); }
        } else l.tiles = new Map();
    }
    return l;
}

// A layer's tiles: where each one's compressed data is
function readTiles(l, data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    l.tiles = new Map();
    l.data = data;
    if (data.length < 4) return;
    const count = dv.getUint32(0, true);
    if (!count) return;
    const size = dv.getUint32(4, true);
    if (!(size > 0 && size <= 4096)) throw new Error(`tile size ${size}`);
    l.tileSize = size;
    let p = 8;
    for (let i = 0; i < count && p + 16 <= data.length; i++) {
        const col = dv.getUint32(p, true), row = dv.getUint32(p + 4, true);
        const comp = dv.getUint32(p + 8, true), n = dv.getUint32(p + 12, true);
        p += 16;
        if (p + n > data.length) throw new Error('a tile is cut short');
        l.tiles.set(row * 65536 + col, { comp, at: p, n, col, row });
        p += n + ((4 - n % 4) % 4);
    }
}

// One tile's pixels: straight RGBA bytes, size × size (cached)
function tilePixels(l, key) {
    const ck = l.index * 4294967296 + key;
    let px = doc.cache.get(ck);
    if (px) { doc.cache.delete(ck); doc.cache.set(ck, px); return px; }
    const t = l.tiles.get(key);
    const S = l.tileSize, n = S * S;
    const raw = l.data.subarray(t.at, t.at + t.n);
    const outSize = l.bpp === 32 ? n * 4 : l.bpp === 8 ? n : n / 8;
    let d;
    if (t.comp === 0) d = fflate.unzlibSync(raw);
    else if (t.comp === 1) d = snappy(raw, outSize);
    else if (t.comp === 2) d = fastlz(raw, outSize);
    else throw new Error(`tile compression ${t.comp}`);
    px = new Uint8Array(n * 4);
    if (l.bpp === 32) {
        for (let i = 0; i < n * 4 && i + 3 < d.length; i += 4) {
            px[i] = d[i + 2]; px[i + 1] = d[i + 1]; px[i + 2] = d[i]; px[i + 3] = d[i + 3];
        }
    } else {
        // the colour's own alpha scales the layer's
        const [r, g, b, ca] = l.color;
        const screen = l.halftone ? halftoneScreen(l, t.col * S, t.row * S) : null;
        for (let i = 0; i < n; i++) {
            let a = l.bpp === 8 ? d[i] : (d[i >> 3] >> (i & 7)) & 1 ? 255 : 0;
            if (screen) a = a >= screen(i % S, (i / S) | 0) ? 255 : 0;
            px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = Math.round(a * ca / 255);
        }
    }
    doc.cache.set(ck, px);
    doc.cacheBytes += px.length;
    for (const [k, v] of doc.cache) {
        if (doc.cacheBytes <= CACHE_BYTES) break;
        doc.cache.delete(k);
        doc.cacheBytes -= v.length;
    }
    return px;
}

// --- Halftone screens, as fitted to FireAlpaca's: fixed to the canvas, at the
// file's resolution and the layer's lines per inch (5 if it doesn't say) ---

// Dots: a checkerboard of c × c cells (c = dpi / lines / √2), dots in one colour
// of square, holes in the other. A dot cell's pixels turn on from its centre out
// (by distance, then left to right, top to bottom) at values 1 to 128, a hole
// cell's from its corners in at 129 to 255; on where the value reaches it.
const screens = new Map();
function dotScreen(c) {
    let m = screens.get(c);
    if (m) return m;
    const n = c * c, P = 2 * c;
    const d2 = new Int32Array(n);
    for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) d2[y * c + x] = (2 * x + 1 - c) ** 2 + (2 * y + 1 - c) ** 2;
    const idx = Array.from({ length: n }, (_, i) => i);
    const dotRank = new Int32Array(n), holeRank = new Int32Array(n);
    idx.slice().sort((i, j) => d2[i] - d2[j] || i - j).forEach((i, r) => { dotRank[i] = r; });
    idx.slice().sort((i, j) => d2[j] - d2[i] || i - j).forEach((i, r) => { holeRank[i] = r; });
    m = new Uint8Array(P * P);
    for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
            const i = (y % c) * c + (x % c);
            m[y * P + x] = ((x / c | 0) + (y / c | 0)) % 2 === 0
                ? Math.ceil((dotRank[i] + 1) * 128 / n) : 128 + Math.ceil((holeRank[i] + 1) * 127 / n);
        }
    }
    screens.set(c, m);
    return m;
}

// The threshold of each pixel of a tile whose top left is at (ox, oy) in the layer.
// Lines: rows (xline) or columns (yline) dpi / lines apart, each growing from its
// top (or left) edge.
function halftoneScreen(l, ox, oy) {
    const dpi = doc.info.dpi || 350;
    const x0 = l.x + ox, y0 = l.y + oy;
    const mod = (v, m) => ((v % m) + m) % m;
    if (l.halftone === 'dots') {
        const c = Math.max(1, Math.round(dpi / l.halftoneLines / Math.SQRT2)), P = 2 * c, m = dotScreen(c);
        return (x, y) => m[mod(y0 + y, P) * P + mod(x0 + x, P)];
    }
    const p = Math.max(1, Math.round(dpi / l.halftoneLines));
    return l.halftone === 'xline'
        ? (x, y) => Math.round(mod(y0 + y, p) * 255 / p) + 1
        : (x) => Math.round(mod(x0 + x, p) * 255 / p) + 1;
}

// Copies the layer's pixels that fall in the canvas tile at (tx, ty) into src
// (straight RGBA floats, 0..1); false if it has none there
function layerPixels(l, tx, ty, src) {
    if (!l.tiles || !l.tiles.size) return false;
    const S = l.tileSize;
    // the layer's tiles that touch this canvas tile
    const x0 = tx - l.x, y0 = ty - l.y;
    const c0 = Math.max(0, Math.floor(x0 / S)), c1 = Math.floor((x0 + TILE - 1) / S);
    const r0 = Math.max(0, Math.floor(y0 / S)), r1 = Math.floor((y0 + TILE - 1) / S);
    let any = false;
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const key = r * 65536 + c;
            if (!l.tiles.has(key)) continue;
            if (!any) { src.fill(0); any = true; }
            const px = tilePixels(l, key);
            // the overlap, in canvas tile coordinates
            const ax = Math.max(0, c * S - x0), bx = Math.min(TILE, (c + 1) * S - x0);
            const ay = Math.max(0, r * S - y0), by = Math.min(TILE, (r + 1) * S - y0);
            for (let y = ay; y < by; y++) {
                let s = ((y + y0 - r * S) * S + (ax + x0 - c * S)) * 4, d = (y * TILE + ax) * 4;
                for (let x = ax; x < bx; x++, s += 4, d += 4) {
                    src[d] = px[s] / 255; src[d + 1] = px[s + 1] / 255; src[d + 2] = px[s + 2] / 255; src[d + 3] = px[s + 3] / 255;
                }
            }
        }
    }
    return any;
}

// --- Blending ---

const lumOf = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c) {
    const l = lumOf(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
    if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * l / (l - n);
    if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * (1 - l) / (x - l);
    return c;
}
function setLum(c, l) { const d = l - lumOf(c[0], c[1], c[2]); return clipColor([c[0] + d, c[1] + d, c[2] + d]); }
const satOf = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c, s) {
    const x = Math.max(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]);
    return c.map(v => x > n ? (v - n) * s / (x - n) : 0);
}

// Separable blend functions of the backdrop and source (straight, 0..1). Divide,
// colour dodge and colour burn as FireAlpaca computes them, in 8-bit steps
// (b × 256 / (s + 1)...); soft light is Photoshop's.
const q = (v) => Math.round(v * 255);
const SEPARABLE = {
    mul: (b, s) => b * s,
    add: (b, s) => Math.min(1, b + s),
    ldodge: (b, s) => Math.min(1, b + s),
    sub: (b, s) => Math.max(0, b - s),
    div: (b, s) => Math.min(255, Math.floor(q(b) * 256 / (q(s) + 1))) / 255,
    screen: (b, s) => b + s - b * s,
    overlay: (b, s) => b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s),
    hardlight: (b, s) => s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s),
    softlight: (b, s) => s <= 0.5 ? 2 * b * s + b * b * (1 - 2 * s) : 2 * b * (1 - s) + Math.sqrt(b) * (2 * s - 1),
    light: (b, s) => Math.max(b, s),
    dark: (b, s) => Math.min(b, s),
    diff: (b, s) => Math.abs(b - s),
    exclusion: (b, s) => b + s - 2 * b * s,
    inverse: (b, s) => 1 - b - s + 2 * b * s,
    dodge: (b, s) => q(b) === 0 ? 0 : Math.min(255, Math.floor(q(b) * 256 / (256 - q(s)))) / 255,
    burn: (b, s) => q(b) === 255 ? 1 : Math.max(0, 255 - Math.floor((255 - q(b)) * 256 / (q(s) + 1))) / 255,
    lburn: (b, s) => Math.max(0, b + s - 1),
    hardmix: (b, s) => b + s >= 1 ? 1 : 0,
};
// ...looked up in a table of 256 × 256 backdrop and source values, made when first
// used (the source is a layer's 8-bit pixel; between two backdrop values, linearly)
const tables = {};
function lookup(t, b, s) {
    const x = b * 255, i = Math.min(254, x | 0), f = x - i, k = (i << 8) | q(s);
    return t[k] + (t[k + 256] - t[k]) * f;
}
function tableOf(mode) {
    let t = tables[mode];
    if (!t) {
        const f = SEPARABLE[mode];
        t = tables[mode] = new Float32Array(65536);
        for (let b = 0; b < 256; b++) for (let s = 0; s < 256; s++) t[(b << 8) | s] = Math.max(0, Math.min(1, f(b / 255, s / 255)));
    }
    return t;
}

// The non-separable modes' colour (straight), for one pixel
function blendColor(mode, cb, cs, out) {
    let c;
    if (mode === 'hue') c = setLum(setSat(cs.slice(0, 3), satOf(cb)), lumOf(cb[0], cb[1], cb[2]));
    else if (mode === 'saturation') c = setLum(setSat(cb.slice(0, 3), satOf(cs)), lumOf(cb[0], cb[1], cb[2]));
    else if (mode === 'color') c = setLum(cs.slice(0, 3), lumOf(cb[0], cb[1], cb[2]));
    else c = setLum(cb.slice(0, 3), lumOf(cs[0], cs[1], cs[2])); // luminosity
    out[0] = Math.max(0, Math.min(1, c[0])); out[1] = Math.max(0, Math.min(1, c[1])); out[2] = Math.max(0, Math.min(1, c[2]));
    return out;
}

// Blends src (straight RGBA floats; alpha already times opacity) onto dst
// (premultiplied). Normal is source over. The other modes, as fitted to
// FireAlpaca's composites: O, the colour on an opaque backdrop (the mode's colour
// mixed in by the source's alpha; Add adds the source times its alpha), and N,
// what Normal would give, are mixed by the backdrop's alpha times the result's:
// on an opaque backdrop that is O, over nothing it is the source.
function blendTile(dst, src, mode) {
    const cb = [0, 0, 0], cs = [0, 0, 0], mix = [0, 0, 0];
    const normal = mode === 'normal';
    const table = SEPARABLE[mode] ? tableOf(mode) : null;
    const add = mode === 'add';
    for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
        const as = src[i + 3];
        if (as <= 0) continue;
        const ab = dst[i + 3];
        const ao = as + ab - as * ab;
        if (normal || ab <= 0) {
            dst[i] = src[i] * as + dst[i] * (1 - as);
            dst[i + 1] = src[i + 1] * as + dst[i + 1] * (1 - as);
            dst[i + 2] = src[i + 2] * as + dst[i + 2] * (1 - as);
            dst[i + 3] = ao;
            continue;
        }
        cb[0] = dst[i] / ab; cb[1] = dst[i + 1] / ab; cb[2] = dst[i + 2] / ab;
        cs[0] = src[i]; cs[1] = src[i + 1]; cs[2] = src[i + 2];
        if (table) {
            if (add) for (let k = 0; k < 3; k++) mix[k] = Math.min(1, cb[k] + as * cs[k]);
            else for (let k = 0; k < 3; k++) mix[k] = (1 - as) * cb[k] + as * lookup(table, cb[k], cs[k]);
        } else {
            blendColor(mode, cb, cs, mix);
            for (let k = 0; k < 3; k++) mix[k] = (1 - as) * cb[k] + as * mix[k];
        }
        const w = ab * ao;
        for (let k = 0; k < 3; k++) {
            const n = (as * cs[k] + ab * (1 - as) * cb[k]) / ao;
            dst[i + k] = ((1 - w) * n + w * mix[k]) * ao;
        }
        dst[i + 3] = ao;
    }
}

// Blends src onto dst (premultiplied) keeping dst's alpha: what is clipped to a
// layer is mixed in as if that layer were opaque
function lockTile(dst, src, mode) {
    const cb = [0, 0, 0], cs = [0, 0, 0], mix = [0, 0, 0];
    const table = SEPARABLE[mode] ? tableOf(mode) : null;
    for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
        const as = src[i + 3], ab = dst[i + 3];
        if (as <= 0 || ab <= 0) continue;
        cb[0] = dst[i] / ab; cb[1] = dst[i + 1] / ab; cb[2] = dst[i + 2] / ab;
        cs[0] = src[i]; cs[1] = src[i + 1]; cs[2] = src[i + 2];
        if (mode === 'normal') for (let k = 0; k < 3; k++) mix[k] = (1 - as) * cb[k] + as * cs[k];
        else if (mode === 'add') for (let k = 0; k < 3; k++) mix[k] = Math.min(1, cb[k] + as * cs[k]);
        else if (table) for (let k = 0; k < 3; k++) mix[k] = (1 - as) * cb[k] + as * lookup(table, cb[k], cs[k]);
        else {
            blendColor(mode, cb, cs, mix);
            for (let k = 0; k < 3; k++) mix[k] = (1 - as) * cb[k] + as * mix[k];
        }
        dst[i] = mix[0] * ab; dst[i + 1] = mix[1] * ab; dst[i + 2] = mix[2] * ab;
    }
}

// --- Compositing ---

const eff = (l, key) => { const c = changes[l.id]; return c && c[key] !== undefined ? c[key] : l[key]; };
// Add with lumi="false" adds the colours as Linear dodge does; without it (or true),
// the source times its alpha is added
const modeOf = (l) => { const m = eff(l, 'mode'); return m === 'add' && !l.lumi ? 'ldodge' : m; };

const pool = [];
const take = () => pool.pop() || new Float32Array(TILE_PIXELS * 4);
const give = (b) => pool.push(b);

// Composites a folder's children onto dst (premultiplied), bottom first: a layer
// and the layers clipped to it (those right above, clipping on) as a group
function compositeChildren(all, tx, ty, dst, only, opacityScale) {
    // masks are their layer's (see applyMasks); one shown alone is drawn as it is
    if (only !== undefined) for (const l of all) if (l.mask && l.id === only) drawLayer(l, tx, ty, dst, only, 1, 'normal');
    const list = all.filter(l => !l.mask);
    for (let i = 0; i < list.length; i++) {
        const base = list[i];
        let j = i + 1;
        while (j < list.length && list[j].clipping) j++;
        const clipped = list.slice(i + 1, j);
        // clipped layers at the bottom of a folder have nothing to clip to: not shown
        if (!base.clipping) drawGroup(base, clipped, tx, ty, dst, only, opacityScale);
        i = j - 1;
    }
}

// Whether a layer is on the way to the one shown alone (it, or a folder it's in)
function onPath(l, only) {
    for (let o = doc.byId.get(only); o; o = o.parent !== -1 ? doc.byId.get(o.parent) : null) if (o === l) return true;
    return false;
}

function drawGroup(base, clipped, tx, ty, dst, only, opacityScale) {
    if (only !== undefined) {
        if (base.id === only || (base.folder && onPath(base, only))) drawLayer(base, tx, ty, dst, only, 1, 'normal');
        else for (const c of clipped) if (c.id === only) drawLayer(c, tx, ty, dst, only, 1, 'normal');
        return;
    }
    if (!eff(base, 'visible')) return;
    const shown = clipped.filter(c => eff(c, 'visible'));
    const opacity = eff(base, 'opacity') * opacityScale;
    const mode = modeOf(base);
    if (!shown.length) { drawLayer(base, tx, ty, dst, only, opacity, mode); return; }
    // the base alone, the clipped layers on it as if it were opaque (its alpha kept),
    // then the whole as the base
    const g = take();
    g.fill(0);
    drawLayer(base, tx, ty, g, only, 1, 'normal');
    const src = take();
    for (const c of shown) {
        const t = take();
        t.fill(0);
        if (drawLayer(c, tx, ty, t, only, 1, 'normal')) {
            const op = eff(c, 'opacity');
            for (let p = 0; p < TILE_PIXELS * 4; p += 4) {
                const a = t[p + 3];
                src[p + 3] = a * op;
                if (a > 0) { src[p] = t[p] / a; src[p + 1] = t[p + 1] / a; src[p + 2] = t[p + 2] / a; }
            }
            const m = modeOf(c);
            lockTile(g, src, m === 'through' ? 'normal' : m);
        }
        give(t);
    }
    // back to straight, at the base's opacity
    for (let p = 0; p < TILE_PIXELS * 4; p += 4) {
        const a = g[p + 3];
        src[p + 3] = a * opacity;
        if (a > 0) { src[p] = g[p] / a; src[p + 1] = g[p + 1] / a; src[p + 2] = g[p + 2] / a; }
    }
    blendTile(dst, src, mode === 'through' ? 'normal' : mode);
    give(src);
    give(g);
}

// A layer's masks (8-bit layers right above it, masking on): a mask takes its
// value (times its opacity) off the layer's alpha, a stencil (maskingType 1) takes
// off what it lacks of full
function applyMasks(l, tx, ty, src) {
    if (!l.masks.length) return;
    const m = take();
    for (const k of l.masks) {
        if (!eff(k, 'visible')) continue;
        const op = eff(k, 'opacity');
        const has = layerPixels(k, tx, ty, m);
        if (!has && !k.stencil) continue;
        for (let p = 3; p < TILE_PIXELS * 4; p += 4) {
            const v = has ? m[p] : 0;
            src[p] = Math.max(0, src[p] - (k.stencil ? (1 - v) : v) * op);
        }
    }
    give(m);
}

// Draws one layer (or folder) onto dst; returns whether it had pixels there
function drawLayer(l, tx, ty, dst, only, opacity, mode) {
    if (l.folder) {
        if (mode === 'through' && only === undefined) {
            compositeChildren(l.children, tx, ty, dst, only, opacity);
            return true;
        }
        const g = take();
        g.fill(0);
        compositeChildren(l.children, tx, ty, g, only, 1);
        const src = take();
        let any = false;
        for (let p = 0; p < TILE_PIXELS * 4; p += 4) {
            const a = g[p + 3];
            src[p + 3] = a;
            if (a > 0) { any = true; src[p] = g[p] / a; src[p + 1] = g[p + 1] / a; src[p + 2] = g[p + 2] / a; }
        }
        applyMasks(l, tx, ty, src);
        if (opacity < 1) for (let p = 3; p < TILE_PIXELS * 4; p += 4) src[p] *= opacity;
        if (any) blendTile(dst, src, mode === 'through' ? 'normal' : mode);
        give(src);
        give(g);
        return any;
    }
    const src = take();
    const any = layerPixels(l, tx, ty, src);
    if (any) {
        applyMasks(l, tx, ty, src);
        if (opacity < 1) for (let p = 3; p < TILE_PIXELS * 4; p += 4) src[p] *= opacity;
        blendTile(dst, src, mode);
    }
    give(src);
    return any;
}

// paper: on the canvas colour (FireAlpaca's picture when its checkerboard is off), else transparent
let paper = false;
function render(newChanges, only, newPaper) {
    if (newChanges) changes = newChanges;
    if (newPaper !== undefined) paper = newPaper;
    const { width, height } = doc;
    const bg = doc.info.background.map(c => c / 255);
    const out = new Uint8ClampedArray(width * height * 4);
    const dst = new Float32Array(TILE_PIXELS * 4);
    for (let ty = 0; ty < height; ty += TILE) {
        for (let tx = 0; tx < width; tx += TILE) {
            if (paper && only === undefined) for (let p = 0; p < TILE_PIXELS * 4; p += 4) { dst[p] = bg[0]; dst[p + 1] = bg[1]; dst[p + 2] = bg[2]; dst[p + 3] = 1; }
            else dst.fill(0);
            compositeChildren(doc.top, tx, ty, dst, only, 1);
            const w = Math.min(TILE, width - tx), h = Math.min(TILE, height - ty);
            for (let y = 0; y < h; y++) {
                let s = y * TILE * 4, d = ((ty + y) * width + tx) * 4;
                for (let x = 0; x < w; x++, s += 4, d += 4) {
                    const a = dst[s + 3];
                    if (a <= 0) continue;
                    out[d] = dst[s] / a * 255;
                    out[d + 1] = dst[s + 1] / a * 255;
                    out[d + 2] = dst[s + 2] / a * 255;
                    out[d + 3] = a * 255;
                }
            }
        }
    }
    return out;
}

// A small picture of a layer: its tiles, scaled down to fit THUMB × THUMB
function thumbnail(l) {
    const { width, height } = doc;
    const scale = Math.min(THUMB / width, THUMB / height, 1);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const data = new Uint8ClampedArray(w * h * 4);
    if (l.folder || !l.tiles || !l.tiles.size) return { width: w, height: h, data };
    const S = l.tileSize;
    // nearest pixel of each thumbnail pixel, tile by tile
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const cx = Math.floor((x + 0.5) / scale) - l.x, cy = Math.floor((y + 0.5) / scale) - l.y;
            if (cx < 0 || cy < 0) continue;
            const key = Math.floor(cy / S) * 65536 + Math.floor(cx / S);
            if (!l.tiles.has(key)) continue;
            const px = tilePixels(l, key);
            const s = ((cy % S) * S + (cx % S)) * 4, d = (y * w + x) * 4;
            data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = px[s + 3];
        }
    }
    return { width: w, height: h, data };
}

// The thumbnail the file keeps: BGRA rows (null if there's none)
function storedThumb() {
    const a = doc.archives.get('thumb');
    const t = doc.info.thumb;
    if (!a || !t || !(t[0] > 0 && t[1] > 0)) return null;
    const d = archiveData(a);
    if (d.length < t[0] * t[1] * 4) return null;
    const px = new Uint8ClampedArray(t[0] * t[1] * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = d[i + 2]; px[i + 1] = d[i + 1]; px[i + 2] = d[i]; px[i + 3] = d[i + 3]; }
    return { width: t[0], height: t[1], data: px };
}

const layerInfo = (l) => ({
    id: l.id, name: l.name, type: l.type, folder: l.folder, depth: l.depth, parent: l.parent,
    mode: l.mode, opacity: l.opacity, visible: l.visible, clipping: l.clipping, protectAlpha: l.protectAlpha,
    locked: l.locked, draft: l.draft, mask: l.mask ? (l.stencil ? 'stencil' : 'mask') : '', x: l.x, y: l.y, width: l.width, height: l.height, text: l.text,
    color: l.bpp === 8 || l.bpp === 1 ? l.color : null, halftone: l.halftone, halftoneLines: l.halftone ? l.halftoneLines : 0,
    problem: l.problem,
});

self.onmessage = ({ data }) => {
    const { id } = data;
    try {
        if (data.cmd === 'open') {
            changes = {};
            openMdp(new Uint8Array(data.bytes));
            const image = render({}, undefined, !doc.info.checker);
            const thumbs = {};
            for (const l of doc.layers) thumbs[l.id] = thumbnail(l);
            const layers = doc.layers.map(layerInfo);
            const stored = storedThumb();
            self.postMessage({ id, result: { info: doc.info, layers, thumbs, stored, image } }, [image.buffer]);
        } else if (data.cmd === 'render') {
            const image = render(data.changes, undefined, data.paper);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else if (data.cmd === 'layer') {
            const image = render(null, data.layerId);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else throw new Error(`unknown command ${data.cmd}`);
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
