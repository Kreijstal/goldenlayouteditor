// Clip Studio Paint files (.clip), read and composited in a worker, for the Clip
// Studio Paint viewer (src/clip-plugin.js). Written from what the open readers of
// the format have found out (dobrokot's clip_to_psd, LavenderSnek's clipdecode,
// clipfile-rs) and fitted to the composites Clip Studio Paint itself stores.
//
// A .clip is "CSFCHUNK", the file's size and the offset of its first chunk, then
// chunks: "CHNK", a four-letter name, a 64-bit size and the body. CHNKHead holds
// the offset of the database; each CHNKExta is a 40-byte "extrnlid..." id and its
// data; CHNKSQLi is a whole SQLite database; CHNKFoot ends the file. The database
// has the canvas (size, unit, resolution, its root folder), the layers (a tree of
// first-child / next-sibling links, bottom first), their mipmaps (100%, 50%,
// 25%... each an Offscreen) and CanvasPreview, the picture as a PNG. An
// Offscreen's Attribute gives its size, its grid of 256 × 256 blocks and how
// pixels are packed; its BlockData names the CHNKExta that holds the blocks, each
// zlib'd: an alpha plane then B, G, R, x interleaved (colour), an alpha plane and
// a grey one, one 8-bit plane (masks), or 1-bit alpha and value planes
// (monochrome). A missing block, or a missing CHNKExta, is the Offscreen's
// default (empty, or white for a mask). The database is read here directly: its
// B-tree pages, records and overflow pages, no SQLite library.
//
// The layers are composited 256 × 256 pixels at a time, at the mipmap level
// asked for: blending modes, opacity, masks, clipping, folders (isolated or pass
// through), paper and fill layers, and the correction layers.
//   → { id, cmd: 'open', bytes }               ← { info, layers, thumbs, preview, image, level }
//   → { id, cmd: 'render', changes, level }     ← { image, level }
//   → { id, cmd: 'layer', layerId, level }      ← { image, level } (one layer alone)
//   → { id, cmd: 'thumbnail', url }             ← { png } (CanvasPreview, read with Range requests)
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const THUMB = 40;
const TILE = 256;
const TILE_PIXELS = TILE * TILE;
// Decoded blocks kept between renders (bytes)
const CACHE_BYTES = 384 << 20;
// The level shown first: the largest whose picture has at most this many pixels
const DEFAULT_MAX_PIXELS = 4096 * 4096;

// --- SQLite, read straight from its pages ---

class SqliteFile {
    constructor(bytes) {
        if (String.fromCharCode(...bytes.subarray(0, 15)) !== 'SQLite format 3') throw new Error('the database is not SQLite');
        this.b = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ps = this.dv.getUint16(16);
        this.pageSize = ps === 1 ? 65536 : ps;
        this.usable = this.pageSize - bytes[20];
        const enc = this.dv.getUint32(56);
        this.text = new TextDecoder(enc === 2 ? 'utf-16le' : enc === 3 ? 'utf-16be' : 'utf-8');
        this.schema = new Map();
        for (const r of this.rows(1)) {
            const [type, name, , rootpage, sql] = r.values;
            if (type === 'table') this.schema.set(name, { rootpage, columns: parseColumns(sql || '') });
        }
    }

    varint(p) {
        let v = 0;
        for (let i = 0; i < 8; i++) {
            const c = this.b[p + i];
            v = v * 128 + (c & 0x7f);
            if (!(c & 0x80)) return [v, p + i + 1];
        }
        return [v * 256 + this.b[p + 8], p + 9];
    }

    // Every row of a table B-tree: { rowid, values }
    *rows(root) {
        const stack = [root];
        const seen = new Set();
        while (stack.length) {
            const page = stack.pop();
            if (seen.has(page) || page < 1) continue;
            seen.add(page);
            const base = (page - 1) * this.pageSize;
            const h = base + (page === 1 ? 100 : 0);
            const type = this.b[h];
            const cells = this.dv.getUint16(h + 3);
            if (type === 0x05) {
                // interior: children in order, then the right-most; pushed reversed to read them in order
                const kids = [];
                for (let i = 0; i < cells; i++) kids.push(this.dv.getUint32(base + this.dv.getUint16(h + 12 + 2 * i)));
                kids.push(this.dv.getUint32(h + 8));
                for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
            } else if (type === 0x0d) {
                for (let i = 0; i < cells; i++) {
                    let p = base + this.dv.getUint16(h + 8 + 2 * i);
                    let size, rowid;
                    [size, p] = this.varint(p);
                    [rowid, p] = this.varint(p);
                    yield { rowid, values: this.record(this.payload(p, size)) };
                }
            } else throw new Error(`unexpected SQLite page type ${type}`);
        }
    }

    // A cell's payload, its overflow pages put back after the part on the page
    payload(p, size) {
        const U = this.usable, X = U - 35;
        if (size <= X) return this.b.subarray(p, p + size);
        const M = Math.floor((U - 12) * 32 / 255) - 23;
        const K = M + (size - M) % (U - 4);
        const local = K <= X ? K : M;
        const out = new Uint8Array(size);
        out.set(this.b.subarray(p, p + local));
        let at = local, next = this.dv.getUint32(p + local);
        while (at < size && next) {
            const o = (next - 1) * this.pageSize;
            const n = Math.min(U - 4, size - at);
            out.set(this.b.subarray(o + 4, o + 4 + n), at);
            at += n;
            next = this.dv.getUint32(o);
        }
        return out;
    }

    record(b) {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let p = 0, hsize;
        const v = (q) => { let x = 0; for (let i = 0; i < 9; i++) { const c = b[q + i]; if (i === 8) return [x * 256 + c, q + 9]; x = x * 128 + (c & 0x7f); if (!(c & 0x80)) return [x, q + i + 1]; } return [x, q]; };
        [hsize, p] = v(0);
        const types = [];
        while (p < hsize) { let t; [t, p] = v(p); types.push(t); }
        const out = [];
        let d = hsize;
        for (const t of types) {
            if (t === 0) out.push(null);
            else if (t >= 1 && t <= 6) {
                const n = [0, 1, 2, 3, 4, 6, 8][t];
                let x = 0;
                for (let i = 0; i < n; i++) x = x * 256 + b[d + i];
                if (b[d] & 0x80) x -= 2 ** (8 * n);
                out.push(x);
                d += n;
            } else if (t === 7) { out.push(dv.getFloat64(d)); d += 8; }
            else if (t === 8) out.push(0);
            else if (t === 9) out.push(1);
            else if (t >= 12) {
                const n = (t - (t & 1 ? 13 : 12)) / 2;
                out.push(t & 1 ? this.text.decode(b.subarray(d, d + n)) : b.slice(d, d + n));
                d += n;
            } else out.push(null);
        }
        return out;
    }

    // A table's rows as objects; an INTEGER PRIMARY KEY is the rowid
    table(name) {
        const t = this.schema.get(name);
        if (!t) return [];
        const out = [];
        for (const { rowid, values } of this.rows(t.rootpage)) {
            const o = {};
            t.columns.forEach((c, i) => { o[c.name] = c.rowid ? rowid : values[i] !== undefined ? values[i] : null; });
            out.push(o);
        }
        return out;
    }
}

// The columns of a CREATE TABLE, in order
function parseColumns(sql) {
    const open = sql.indexOf('(');
    if (open < 0) return [];
    const body = sql.slice(open + 1, sql.lastIndexOf(')'));
    const cols = [];
    let depth = 0, cur = '';
    for (const ch of body + ',') {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            const def = cur.trim();
            cur = '';
            if (!def || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(def)) continue;
            const m = /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|\[([^\]]+)\]|(\S+))/.exec(def);
            const name = m[1] || m[2] || m[3] || m[4] || m[5];
            cols.push({ name, rowid: /^\S+\s+INTEGER\s+PRIMARY\s+KEY/i.test(def) });
        } else cur += ch;
    }
    return cols;
}

// --- The chunks ---

const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const u64 = (dv, p) => dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4);

function readChunks(bytes) {
    if (latin1(bytes.subarray(0, 8)) !== 'CSFCHUNK') throw new Error('not a Clip Studio Paint file (no CSFCHUNK)');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const exta = new Map(); // id -> the data after its header
    let sqlite = null, p = u64(dv, 16) || 24;
    while (p + 16 <= bytes.length) {
        if (latin1(bytes.subarray(p, p + 4)) !== 'CHNK') throw new Error(`no chunk at ${p}`);
        const name = latin1(bytes.subarray(p + 4, p + 8));
        const size = u64(dv, p + 8);
        const body = bytes.subarray(p + 16, Math.min(bytes.length, p + 16 + size));
        if (name === 'Exta') {
            const n = u64(dv, p + 16);
            exta.set(latin1(body.subarray(8, 8 + n)), body.subarray(8 + n + 8));
        } else if (name === 'SQLi') sqlite = body;
        if (name === 'Foot') break;
        p += 16 + size;
    }
    if (!sqlite) throw new Error('the file has no database (CHNKSQLi)');
    return { exta, sqlite };
}

// --- Offscreens: their attributes and blocks ---

const BEGIN = 'BlockDataBeginChunk';

function utf16At(b, dv, p) {
    const n = dv.getUint32(p);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + 4 + 2 * i));
    return [s, p + 4 + 2 * n];
}

// The Attribute BLOB: a 16-byte header, "Parameter" (size, block grid, packing),
// "InitColor" (the default: 0 empty, 1 white / full) and "BlockSize"
function parseAttribute(a) {
    const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
    let p = dv.getUint32(0);
    let name;
    [name, p] = utf16At(a, dv, p);
    if (name !== 'Parameter') throw new Error('unexpected offscreen attribute');
    const width = dv.getUint32(p), height = dv.getUint32(p + 4), cols = dv.getUint32(p + 8), rows = dv.getUint32(p + 12);
    const packing = [];
    for (let i = 0; i < 16; i++) packing.push(dv.getUint32(p + 16 + 4 * i));
    p += 16 + 64;
    // InitColor: its size, whether blocks start filled, the value (alpha, or a
    // mask's level) and, when the next count is 4, the colour (B, G, R, x)
    let fill = 0, def = [0, 0, 0, 0];
    [name, p] = utf16At(a, dv, p);
    if (name === 'InitColor') {
        fill = dv.getUint32(p + 4);
        const v = (dv.getUint32(p + 8) >>> 24) / 255;
        def = [1, 1, 1, v];
        if (dv.getUint32(p + 12) === 4 && p + 36 <= a.length) def = [2, 1, 0].map(i => (dv.getUint32(p + 20 + 4 * i) >>> 24) / 255).concat(v);
    }
    return { width, height, cols, rows, packing, fill, def: fill ? def : [0, 0, 0, 0] };
}

// The blocks of a CHNKExta: for each, where its zlib data is (or null)
function parseBlocks(body) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const blocks = [];
    let p = 0;
    while (p + 8 <= body.length) {
        const size = dv.getUint32(p);
        const n = dv.getUint32(p + 4);
        if (n > 32 || p + 8 + 2 * n > body.length) break;
        const [tag, q] = utf16At(body, dv, p + 4);
        if (tag === BEGIN) {
            const index = dv.getUint32(q);
            const has = dv.getUint32(q + 16);
            if (has) {
                const n = dv.getUint32(q + 24, true);
                blocks[index] = body.subarray(q + 28, q + 28 + n);
            } else blocks[index] = null;
            p += size;
        } else if (tag === 'BlockStatus' || tag === 'BlockCheckSum') {
            p = q + 12 + 4 * dv.getUint32(q + 4);
        } else break;
    }
    return blocks;
}

// --- The document ---

let doc = null;
let cache = new Map(); // `${offscreen}:${block}` -> decoded block
let cacheBytes = 0;

const BLEND_MODES = [
    [0, 'Normal'], [1, 'Darken'], [2, 'Multiply'], [3, 'Color burn'], [4, 'Linear burn'], [5, 'Subtract'], [6, 'Darker color'],
    [7, 'Lighten'], [8, 'Screen'], [9, 'Color dodge'], [10, 'Glow dodge'], [11, 'Add'], [12, 'Add (Glow)'], [13, 'Lighter color'],
    [14, 'Overlay'], [15, 'Soft light'], [16, 'Hard light'], [17, 'Vivid light'], [18, 'Linear light'], [19, 'Pin light'],
    [20, 'Hard mix'], [21, 'Difference'], [22, 'Exclusion'], [23, 'Hue'], [24, 'Saturation'], [25, 'Color'], [26, 'Brightness'],
    [36, 'Divide'], [30, 'Through'],
];
const UNITS = { 0: 'px', 1: 'cm', 2: 'mm', 3: 'in', 4: 'pt', 5: 'Q' };
const PER_INCH = { 1: 2.54, 2: 25.4, 3: 1, 4: 72, 5: 101.6 };

function openClip(bytes) {
    const { exta, sqlite } = readChunks(bytes);
    const db = new SqliteFile(sqlite);
    const canvas = db.table('Canvas')[0];
    if (!canvas) throw new Error('the database has no canvas');
    const rows = db.table('Layer');
    const mipmaps = new Map(db.table('Mipmap').map(r => [r.MainId, r]));
    const mipInfo = new Map(db.table('MipmapInfo').map(r => [r.MainId, r]));
    const offscreens = new Map(db.table('Offscreen').map(r => [r.MainId, r]));
    const preview = db.table('CanvasPreview')[0];
    const project = db.table('Project')[0];
    const vectorLayers = new Set(db.table('VectorObjectList').map(r => r.LayerId));

    // a mipmap's levels: [{ scale, offscreen }]
    const levelsOf = (mipmapId) => {
        const m = mipmaps.get(mipmapId);
        const out = [];
        let info = m && mipInfo.get(m.BaseMipmapInfo);
        const seen = new Set();
        while (info && !seen.has(info.MainId)) {
            seen.add(info.MainId);
            const o = offscreens.get(info.Offscreen);
            if (o) out.push(offscreenOf(o, info.ThisScale / 100));
            info = info.NextIndex ? mipInfo.get(info.NextIndex) : null;
        }
        return out;
    };
    const offscreenOf = (o, scale) => {
        const attr = parseAttribute(o.Attribute);
        const id = o.BlockData ? latin1(o.BlockData) : '';
        const body = exta.get(id);
        return { key: o.MainId, scale, ...attr, blocks: body ? parseBlocks(body) : [], missing: !body };
    };

    // the size in pixels: the root folder's offscreen, else the canvas' size in its unit
    const byId = new Map(rows.map(r => [r.MainId, r]));
    const rootRow = byId.get(canvas.CanvasRootFolder);
    if (!rootRow) throw new Error('the canvas has no root folder');
    let width = Math.round(canvas.CanvasWidth), height = Math.round(canvas.CanvasHeight);
    const rootLevels = rootRow.LayerRenderMipmap ? levelsOf(rootRow.LayerRenderMipmap) : [];
    if (rootLevels.length) { width = rootLevels[0].width; height = rootLevels[0].height; }
    else if (canvas.CanvasUnit && PER_INCH[canvas.CanvasUnit]) {
        width = Math.ceil(canvas.CanvasWidth * canvas.CanvasResolution / PER_INCH[canvas.CanvasUnit]);
        height = Math.ceil(canvas.CanvasHeight * canvas.CanvasResolution / PER_INCH[canvas.CanvasUnit]);
    }

    const layers = [];
    const walk = (parentRow, depth, parent) => {
        const kids = [];
        const seen = new Set();
        for (let id = parentRow.LayerFirstChildIndex; id && !seen.has(id); id = byId.get(id) && byId.get(id).LayerNextIndex) {
            seen.add(id);
            const r = byId.get(id);
            if (!r) break;
            const l = makeLayer(r, depth, parent, levelsOf, vectorLayers);
            layers.push(l);
            kids.push(l);
            if (l.folder) l.children = walk(r, depth + 1, l);
        }
        return kids;
    };
    const root = { id: rootRow.MainId, folder: true, mode: 'through', children: null };
    root.children = walk(rootRow, 0, null);

    // level choices: 100%, 50%... as far as every layer has them
    let levels = 1;
    for (const l of layers) {
        if (l.render) levels = Math.max(levels, l.render.length);
    }
    const levelSizes = [];
    for (let k = 0; k < Math.max(1, levels); k++) {
        const lw = Math.max(1, Math.floor(width / 2 ** k)), lh = Math.max(1, Math.floor(height / 2 ** k));
        levelSizes.push([lw, lh]);
        if (lw <= 64 || lh <= 64) break;
    }

    doc = { width, height, root, layers, byId: new Map(layers.map(l => [l.id, l])), levelSizes };
    cache = new Map();
    cacheBytes = 0;
    const dpi = canvas.CanvasResolution;
    const info = {
        width, height,
        modes: BLEND_MODES.map(([v, n]) => [String(v), n]),
        levels: levelSizes,
        resolution: dpi,
        size: canvas.CanvasUnit ? `${+canvas.CanvasWidth.toFixed(2)} × ${+canvas.CanvasHeight.toFixed(2)} ${UNITS[canvas.CanvasUnit] || ''}` : '',
        channelBytes: canvas.CanvasChannelBytes,
        preview: preview && preview.ImageWidth ? [preview.ImageWidth, preview.ImageHeight] : null,
        version: project && project.ProjectInternalVersion ? `internal version ${project.ProjectInternalVersion}` : '',
        // the layers that show but aren't drawn here (Clip Studio Paint's story info never shows in its preview)
        missing: layers.filter(l => l.problem && l.kind !== 'story' && shows(l)).length,
    };
    return { info, preview: preview && preview.ImageData ? preview.ImageData : null };
}

// Whether a layer shows: it and every folder it's in visible
function shows(l) {
    for (let p = l; p; p = p.parent !== null ? doc.byId.get(p.parent) : null) if (!p.visible) return false;
    return true;
}

// Layer kinds, from LayerType and what the row has
function kindOf(r, vectorLayers) {
    if (r.LayerFolder) return 'folder';
    if (r.LayerType === 1584) return 'paper';
    if (r.LayerType === 800) return 'story';
    if (r.FilterLayerInfo) return 'correction';
    if (r.GradationFillInfo) return r.EffectRenderType ? 'tone' : 'fill';
    if (r.TextLayerString) return 'text';
    if (r.ResizableOriginalMipmap) return 'image';
    if (vectorLayers.has(r.MainId)) return 'vector';
    if (r.LayerType & 1) return 'raster';
    return 'other';
}

const colorOf = (r, g, b) => [r, g, b].map(c => (c >>> 0) / 4294967295);

function makeLayer(r, depth, parent, levelsOf, vectorLayers) {
    const kind = kindOf(r, vectorLayers);
    const l = {
        id: r.MainId, name: r.LayerName || '', depth, parent: parent ? parent.id : null, kind,
        folder: !!r.LayerFolder, open: !(r.LayerFolder & 16),
        visible: !!(r.LayerVisibility & 1),
        opacity: Math.max(0, Math.min(256, r.LayerOpacity === null ? 256 : r.LayerOpacity)) / 256,
        mode: String(r.LayerComposite || 0),
        clip: !!r.LayerClip,
        draft: !!r.OutputAttribute,
        rx: (r.LayerOffsetX || 0) + (r.LayerRenderOffscrOffsetX || 0), ry: (r.LayerOffsetY || 0) + (r.LayerRenderOffscrOffsetY || 0),
        mx: (r.LayerOffsetX || 0) + (r.LayerMaskOffsetX || 0) + (r.LayerMaskOffscrOffsetX || 0),
        my: (r.LayerOffsetY || 0) + (r.LayerMaskOffsetY || 0) + (r.LayerMaskOffscrOffsetY || 0),
        render: r.LayerRenderMipmap ? levelsOf(r.LayerRenderMipmap) : null,
        mask: r.LayerLayerMaskMipmap ? levelsOf(r.LayerLayerMaskMipmap) : null,
        maskOn: !!(r.LayerVisibility & 2),
        problem: '',
    };
    if (l.render && !l.render.length) l.render = null;
    if (r.LayerEffectAttached && r.LayerEffectInfo) l.edge = parseEdge(r.LayerEffectInfo);
    if (l.mask && !l.mask.length) l.mask = null;
    l.hasMask = !!l.mask;
    const saved = !!(l.render && !l.render[0].missing);
    // the layer colour (already in the saved pixels)
    if (r.LayerUsePaletteColor && r.LayerPaletteRed !== null && r.LayerPaletteRed !== undefined) {
        l.layerColor = colorOf(r.LayerPaletteRed, r.LayerPaletteGreen, r.LayerPaletteBlue);
    }
    // expression colour: 0 colour, 1 grey, 2 monochrome
    l.colorType = r.LayerColorTypeIndex || 0;
    if (kind === 'paper') {
        l.fill = colorOf(r.DrawColorMainRed, r.DrawColorMainGreen, r.DrawColorMainBlue);
    } else if (kind === 'fill') {
        // stops may take the layer's main and sub colours, when it has them
        const main = r.DrawColorEnable && r.DrawColorMainRed !== null ? colorOf(r.DrawColorMainRed, r.DrawColorMainGreen, r.DrawColorMainBlue) : null;
        const sub = r.DrawColorEnable && r.DrawColorSubRed !== null && r.DrawColorSubRed !== undefined ? colorOf(r.DrawColorSubRed, r.DrawColorSubGreen, r.DrawColorSubBlue) : null;
        const g = parseGradation(r.GradationFillInfo, main, sub);
        if (g && g.flat) l.fill = g.flat;
        else if (g && g.gradient) {
            // its points are relative to the layer's offset
            const d = g.gradient, ox = r.LayerOffsetX || 0, oy = r.LayerOffsetY || 0;
            d.x0 += ox; d.x1 += ox; d.y0 += oy; d.y1 += oy;
            if (!saved) l.gradient = d;
        }
        else if (!saved) l.problem = 'a fill Clip Studio Paint did not save as pixels: not drawn';
    } else if (kind === 'tone') {
        l.problem = 'screentone: not drawn';
    } else if (kind === 'correction') {
        l.filter = parseFilter(r.FilterLayerInfo);
        if (!l.filter.apply) l.problem = `${l.filter.name}: not applied`;
        else if (l.filter.approximate) l.note = `${l.filter.name}: close to Clip Studio Paint's, not the same`;
    } else if (kind === 'folder' && r.ComicFrameLineMipmap) {
        // a comic frame: its mask the inside, its line the border, both drawn by
        // Clip Studio Paint from the frame's shape; saved as pixels or not
        const line = levelsOf(r.ComicFrameLineMipmap);
        if (line.length && !line[0].missing) l.frameLine = line;
        if (!l.frameLine || (l.mask && l.mask[0].missing)) l.problem = 'a frame Clip Studio Paint did not save as pixels: its border and mask not drawn';
    } else if (kind === 'story') {
        l.problem = 'drawn by Clip Studio Paint outside the page: not shown';
    } else if (kind === 'image' && !saved) {
        const original = levelsOf(r.ResizableOriginalMipmap);
        const t = r.ResizableImageInfo && parseResizable(r.ResizableImageInfo);
        if (original.length && !original[0].missing && t) { l.original = original; l.transform = t; }
        else l.problem = 'an image Clip Studio Paint did not save as pixels: not drawn';
    } else if ((kind === 'text' || kind === 'vector' || kind === 'other') && !saved) {
        l.problem = `${kind === 'text' ? 'text' : kind === 'vector' ? 'vector lines' : 'a layer'} Clip Studio Paint did not save as pixels: not drawn`;
    }
    return l;
}

// LayerEffectInfo: a size, a count, then named effects; "EffectEdge" is the
// border: on or off, its width, its colour
function parseEdge(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 8;
    while (p + 4 < b.length) {
        const n = dv.getUint32(p);
        if (!n || n > 64 || p + 4 + 2 * n > b.length) return null;
        let name;
        [name, p] = utf16At(b, dv, p);
        if (name === 'EffectEdge') {
            if (!dv.getUint32(p)) return null;
            const width = dv.getFloat64(p + 4);
            return width > 0 ? { width, color: [0, 1, 2].map(i => (dv.getUint32(p + 12 + 4 * i) >>> 24) / 255) } : null;
        }
        return null; // the edge comes first; the others aren't drawn
    }
    return null;
}

// ResizableImageInfo: 6 ints, then doubles; the last eight are the picture's
// corners on the canvas (top left, top right, bottom left, bottom right)
function parseResizable(b) {
    if (b.length < 24 + 20 * 8) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const d = (i) => dv.getFloat64(24 + 8 * i);
    // the fifth int: 1 when the picture is tiled over the canvas
    return { tl: [d(12), d(13)], tr: [d(14), d(15)], bl: [d(16), d(17)], br: [d(18), d(19)], tiled: dv.getUint32(16) === 1 };
}

// GradationFillInfo: a size, a count, then named sections: GradationData (the
// stops), GradationSetting (the shape) and GradationSettingAdd0001 (flat colour)
function parseGradation(b, main, sub) {
    try {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let p = 8, stops = null, shape = null, flat = null;
        while (p + 4 < b.length) {
            const n = dv.getUint32(p);
            if (!n || n > 64) break;
            let name;
            [name, p] = utf16At(b, dv, p);
            if (name === 'GradationSettingAdd0001') {
                const size = dv.getUint32(p);
                if (dv.getUint32(p + 4)) flat = [0, 1, 2].map(i => (dv.getUint32(p + 8 + 4 * i) >>> 24) / 255);
                p += 4 + size;
            } else if (name === 'GradationSetting') {
                shape = {
                    repeat: dv.getUint32(p), kind: dv.getUint32(p + 4),
                    second: dv.getFloat64(p + 20),
                    x0: dv.getFloat64(p + 36), y0: dv.getFloat64(p + 44), x1: dv.getFloat64(p + 52), y1: dv.getFloat64(p + 60),
                };
                p += 12 + 7 * 8;
            } else if (name === 'GradationData') {
                const size = dv.getUint32(p);
                stops = readStops(dv, p + 4, main, sub);
                p += 4 + size;
            } else {
                p += 4 + dv.getUint32(p);
            }
        }
        if (flat) return { flat };
        if (stops && stops.length && shape) return { gradient: { stops, ...shape } };
        return null;
    } catch (_) { return null; }
}

// Gradient stops: a header size, a stop size and a count, then each stop's R, G,
// B, alpha (high bytes), whether it takes the main or sub colour, its position
// (of 32768) and its curve's point count (the curves follow the stops)
function readStops(dv, p, main, sub) {
    const head = dv.getUint32(p), each = dv.getUint32(p + 4), count = dv.getUint32(p + 8);
    const stops = [];
    for (let i = 0, q = p + head; i < count; i++, q += each) {
        const c = [0, 1, 2, 3].map(k => (dv.getUint32(q + 4 * k) >>> 24) / 255);
        const which = dv.getUint32(q + 16) & 3;
        stops.push({ rgb: (which === 1 && main) || (which === 2 && sub) || c.slice(0, 3), a: c[3], pos: dv.getUint32(q + 20) / 32768 });
    }
    return stops;
}

// The colour of stops at t (0..1), straight RGBA into out
function stopsAt(s, t, out) {
    let i = 0;
    while (i < s.length - 1 && s[i + 1].pos < t) i++;
    if (t <= s[0].pos || s.length === 1) { const a = s[0]; out[0] = a.rgb[0]; out[1] = a.rgb[1]; out[2] = a.rgb[2]; out[3] = a.a; return; }
    if (i >= s.length - 1) { const a = s[s.length - 1]; out[0] = a.rgb[0]; out[1] = a.rgb[1]; out[2] = a.rgb[2]; out[3] = a.a; return; }
    const a = s[i], c = s[i + 1];
    const f = c.pos > a.pos ? (t - a.pos) / (c.pos - a.pos) : 0;
    for (let k = 0; k < 3; k++) out[k] = a.rgb[k] + (c.rgb[k] - a.rgb[k]) * f;
    out[3] = a.a + (c.a - a.a) * f;
}

// A gradient over a tile: t along it (linear), out from the start (circle) or
// over an ellipse, repeated, mirrored, clamped or empty outside, then its stops
// (looked up in a table of 1024)
const GRADIENT_STEPS = 1024;
function gradientTile(g, tx, ty, scale, src) {
    if (!g.table) {
        g.table = new Float32Array((GRADIENT_STEPS + 1) * 4);
        const c = [0, 0, 0, 0];
        for (let i = 0; i <= GRADIENT_STEPS; i++) { stopsAt(g.stops, i / GRADIENT_STEPS, c); g.table.set(c, i * 4); }
    }
    const T = g.table, { sqrt, floor, round, abs } = Math;
    const kind = g.kind, repeat = g.repeat, x0 = g.x0, y0 = g.y0;
    const dx = g.x1 - g.x0, dy = g.y1 - g.y0;
    const len2 = dx * dx + dy * dy || 1e-9, len = Math.sqrt(len2);
    const b = g.second / 2 || len, b2 = b * b;
    for (let y = 0, i = 0; y < TILE; y++) {
        const py = (ty + y + 0.5) * scale - y0;
        for (let x = 0; x < TILE; x++, i += 4) {
            const px = (tx + x + 0.5) * scale - x0;
            let t;
            if (kind === 0) t = (px * dx + py * dy) / len2;
            else if (kind === 1) t = sqrt((px * px + py * py) / len2);
            else {
                const u = (px * dx + py * dy) / len, v = (py * dx - px * dy) / len;
                t = sqrt(u * u / len2 + v * v / b2);
            }
            if (repeat === 1) t -= floor(t);
            else if (repeat === 2) { t = abs(t) % 2; if (t > 1) t = 2 - t; }
            else if (repeat === 3 && (t < 0 || t > 1)) { src[i] = src[i + 1] = src[i + 2] = src[i + 3] = 0; continue; }
            else t = t < 0 ? 0 : t > 1 ? 1 : t;
            const k = round(t * GRADIENT_STEPS) * 4;
            src[i] = T[k]; src[i + 1] = T[k + 1]; src[i + 2] = T[k + 2]; src[i + 3] = T[k + 3];
        }
    }
}

// --- Correction layers (FilterLayerInfo: the kind, the size, the settings) ---

const FILTER_NAMES = { 1: 'Brightness / Contrast', 2: 'Level correction', 3: 'Tone curve', 4: 'Hue / Saturation / Luminosity', 5: 'Color balance', 6: 'Reverse gradient', 7: 'Posterization', 8: 'Binarization', 9: 'Gradient map' };

function parseFilter(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const type = dv.getUint32(0);
    const f = { type, name: FILTER_NAMES[type] || `correction ${type}`, apply: null };
    const s32 = (p) => dv.getInt32(p);
    const u16 = (p) => dv.getUint16(p);
    try {
        if (type === 1) {
            const brightness = s32(8), contrast = s32(12);
            f.apply = lutFilter(c => brightnessContrast(c, brightness, contrast));
        } else if (type === 2) {
            // entries of input black, middle, input white, output black, output white
            // (16 bits): the whole image, red, green, blue; a channel's first
            const e = [];
            for (let i = 0; i < 4 && 8 + 10 * (i + 1) <= b.length; i++) e.push([0, 1, 2, 3, 4].map(k => u16(8 + 10 * i + 2 * k) / 65535));
            const lv = (x, [lo, mid, hi, olo, ohi]) => {
                let t = hi > lo ? Math.min(1, Math.max(0, (x - lo) / (hi - lo))) : x >= hi ? 1 : 0;
                const m = hi > lo ? (mid - lo) / (hi - lo) : 0.5;
                if (m > 0 && m < 1 && m !== 0.5) t = Math.pow(t, Math.log(0.5) / Math.log(m));
                return olo + t * (ohi - olo);
            };
            f.apply = lutFilter((c, ch) => { let x = e[ch + 1] ? lv(c, e[ch + 1]) : c; if (e[0]) x = lv(x, e[0]); return x; });
        } else if (type === 3) {
            // 32 point lists of 130 bytes: a count, then (x, y) in 16 bits; the whole
            // image, red, green, blue first; a channel's curve first
            const curves = [];
            for (let i = 0; i < 4; i++) {
                const p = 8 + i * 130;
                const n = u16(p);
                const pts = [];
                for (let k = 0; k < n && k < 32; k++) pts.push([u16(p + 2 + 4 * k), u16(p + 4 + 4 * k)]);
                curves.push(curveOf(pts));
            }
            f.apply = lutFilter((c, ch) => curves[0](curves[ch + 1](c)));
        } else if (type === 4) {
            const hue = s32(8), sat = s32(12), lum = s32(16);
            f.apply = (px) => hslFilter(px, hue, sat, lum);
            f.approximate = true;
        } else if (type === 9) {
            // the stops by the pixel's luminance (no main / sub colour here)
            const stops = readStops(dv, 12, null, null);
            const c = [0, 0, 0, 0];
            if (stops.length) f.apply = (px) => {
                stopsAt(stops, Math.min(1, Math.max(0, 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2])), c);
                for (let k = 0; k < 3; k++) px[k] += (c[k] - px[k]) * c[3];
            };
        } else if (type === 6) {
            f.apply = lutFilter(c => 1 - c);
        } else if (type === 7) {
            const n = Math.max(2, s32(8));
            f.apply = lutFilter(c => Math.min(n - 1, Math.floor(c * n)) / (n - 1));
        } else if (type === 8) {
            const t = s32(8);
            f.apply = (px) => { const y = (0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]) * 255; const v = y >= t ? 1 : 0; px[0] = px[1] = px[2] = v; };
        }
    } catch (_) { f.apply = null; }
    return f;
}

function lutFilter(fn) {
    const luts = [0, 1, 2].map(ch => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) t[i] = Math.min(1, Math.max(0, fn(i / 255, ch))); return t; });
    return (px) => {
        for (let ch = 0; ch < 3; ch++) {
            const x = Math.min(255, Math.max(0, px[ch] * 255));
            const i = Math.floor(x), f = x - i;
            const t = luts[ch];
            px[ch] = i >= 255 ? t[255] : t[i] + (t[i + 1] - t[i]) * f;
        }
    };
}

// Contrast about the middle (a slope of 1 + contrast / 100, or 1 / (1 - contrast / 100)
// above 0) and brightness added (in 1/255ths; times the slope when it's steeper)
function brightnessContrast(c, b, k) {
    const f = k >= 0 ? (k >= 100 ? 1e6 : 1 / (1 - k / 100)) : 1 + k / 100;
    return (c - 0.5) * f + 0.5 + b / 255 * Math.max(1, f);
}

// A tone curve through 16-bit points: straight with two points, else quadratic
// Béziers from midpoint to midpoint, each point their control (as dobrokot's
// clip_to_psd found Clip Studio Paint's curves to be)
function curveOf(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    if (!pts.length || pts[0][0] !== 0) pts.unshift([0, 0]);
    if (pts[pts.length - 1][0] !== 65535) pts.push([65535, 65535]);
    if (pts.length === 2) return (x) => (pts[0][1] + x * (pts[1][1] - pts[0][1])) / 65535;
    const ends = [pts[0]];
    for (let i = 1; i < pts.length - 2; i++) ends.push([(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]);
    ends.push(pts[pts.length - 1]);
    return (x01) => {
        const x = x01 * 65535;
        let i = 0;
        while (i < ends.length - 2 && x >= ends[i + 1][0]) i++;
        const p0 = ends[i], p1 = pts[i + 1], p2 = ends[i + 1];
        if (x <= p0[0]) return p0[1] / 65535;
        if (x >= p2[0]) return p2[1] / 65535;
        const a = p0[0] - 2 * p1[0] + p2[0], bb = p1[0] - p0[0], c = p0[0];
        const disc = bb * bb - a * (c - x);
        const t = (c - x) / (-bb - Math.sqrt(Math.max(0, disc)));
        return ((1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) / 65535;
    };
}

// Hue turned and saturation raised in HLS, then lightness: towards black or white
// (close to Clip Studio Paint's, which isn't quite this)
function hslFilter(px, hue, sat, lum) {
    const [r, g, b] = px;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h /= 6;
    }
    h = ((h + hue / 360) % 1 + 1) % 1;
    s = sat >= 0 ? s + (1 - s) * sat / 100 : s * (1 + sat / 100);
    s = Math.max(0, Math.min(1, s));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const h2r = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    const out = [h2r(h + 1 / 3), h2r(h), h2r(h - 1 / 3)];
    for (let c = 0; c < 3; c++) px[c] = lum >= 0 ? out[c] + (1 - out[c]) * lum / 100 : out[c] * (1 + lum / 100);
}

// --- Pixels: one block of an offscreen ---

// A layer block: straight RGBA bytes; a mask block: one byte per pixel
function decodeBlock(o, index, asMask) {
    const key = `${o.key}:${index}`;
    let hit = cache.get(key);
    if (hit !== undefined) { cache.delete(key); cache.set(key, hit); return hit; }
    const z = o.blocks[index];
    let out = null;
    if (z) {
        const raw = fflate.unzlibSync(z);
        if (asMask) {
            out = new Uint8Array(TILE_PIXELS);
            if (raw.length >= TILE_PIXELS) out.set(raw.subarray(0, TILE_PIXELS));
            else if (raw.length >= TILE_PIXELS / 8) for (let i = 0; i < TILE_PIXELS; i++) out[i] = raw[i >> 3] & (128 >> (i & 7)) ? 255 : 0;
        } else {
            out = new Uint8Array(TILE_PIXELS * 4);
            if (raw.length >= 5 * TILE_PIXELS) {
                for (let i = 0, j = TILE_PIXELS; i < TILE_PIXELS; i++, j += 4) {
                    const o4 = i * 4;
                    out[o4] = raw[j + 2]; out[o4 + 1] = raw[j + 1]; out[o4 + 2] = raw[j]; out[o4 + 3] = raw[i];
                }
            } else if (raw.length >= 2 * TILE_PIXELS) {
                for (let i = 0; i < TILE_PIXELS; i++) {
                    const v = raw[TILE_PIXELS + i], o4 = i * 4;
                    out[o4] = out[o4 + 1] = out[o4 + 2] = v; out[o4 + 3] = raw[i];
                }
            } else if (raw.length >= TILE_PIXELS) {
                for (let i = 0; i < TILE_PIXELS; i++) out[i * 4 + 3] = raw[i];
            } else if (raw.length >= TILE_PIXELS / 4) {
                // 1-bit: an alpha plane, then a value plane (0 black, 1 white)
                const half = TILE_PIXELS / 8;
                for (let i = 0; i < TILE_PIXELS; i++) {
                    const bit = 128 >> (i & 7), o4 = i * 4;
                    const v = raw[half + (i >> 3)] & bit ? 255 : 0;
                    out[o4] = out[o4 + 1] = out[o4 + 2] = v;
                    out[o4 + 3] = raw[i >> 3] & bit ? 255 : 0;
                }
            }
        }
    }
    cache.set(key, out);
    cacheBytes += out ? out.length : 16;
    while (cacheBytes > CACHE_BYTES && cache.size > 1) {
        const [k, v] = cache.entries().next().value;
        cache.delete(k);
        cacheBytes -= v ? v.length : 16;
    }
    return out;
}

// The level of a mipmap chain for the picture's level (the nearest finer one, scaled down if it's missing)
function levelOf(levels, k) {
    if (!levels || !levels.length) return null;
    return levels[Math.min(k, levels.length - 1)];
}

// Copies the part of an offscreen at (ox, oy) that falls in the tile at (tx, ty)
// (w × h, a tile unless asked) into buf: straight RGBA floats, or one float per
// pixel for a mask. step is the size of an offscreen pixel in the picture's
// pixels. Returns false if the offscreen has nothing there.
function sampleLayer(o, ox, oy, tx, ty, buf, isMask, step, w = TILE, h = TILE) {
    const def = o.def; // a missing block: empty, or the offscreen's initial colour
    buf.fill(isMask ? def[3] : 0);
    const lx0 = Math.max(tx, ox), ly0 = Math.max(ty, oy);
    const lx1 = Math.min(tx + w, Math.ceil(ox + o.width * step)), ly1 = Math.min(ty + h, Math.ceil(oy + o.height * step));
    if (lx0 >= lx1 || ly0 >= ly1) return false;
    const inv = 1 / 255, f = 1 / step;
    let any = false;
    for (let y = ly0; y < ly1; y++) {
        const sy = Math.floor((y - oy) * f);
        const by = Math.floor(sy / TILE), py = sy - by * TILE;
        const d = (y - ty) * w - tx;
        let x = lx0;
        while (x < lx1) {
            const bx = Math.floor(Math.floor((x - ox) * f) / TILE);
            const runEnd = Math.min(lx1, Math.ceil(ox + (bx + 1) * TILE * step));
            const bi = by * o.cols + bx;
            const block = o.missing || !o.blocks[bi] ? null : decodeBlock(o, bi, isMask);
            if (!block) {
                if (def[3]) {
                    any = true;
                    if (isMask) buf.fill(def[3], d + x, d + runEnd);
                    else for (let q = (d + x) * 4; q < (d + runEnd) * 4; q += 4) { buf[q] = def[0]; buf[q + 1] = def[1]; buf[q + 2] = def[2]; buf[q + 3] = def[3]; }
                }
                x = runEnd;
                continue;
            }
            any = true;
            const row = py * TILE - bx * TILE;
            for (; x < runEnd; x++) {
                const s = row + Math.floor((x - ox) * f);
                if (isMask) buf[d + x] = block[s] * inv;
                else {
                    const q = (d + x) * 4, s4 = s * 4;
                    buf[q] = block[s4] * inv; buf[q + 1] = block[s4 + 1] * inv; buf[q + 2] = block[s4 + 2] * inv; buf[q + 3] = block[s4 + 3] * inv;
                }
            }
        }
    }
    return any;
}

// --- Blending ---

const lumOf = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c) {
    const l = lumOf(c[0], c[1], c[2]);
    const n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
    if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * l / (l - n);
    if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * (1 - l) / (x - l);
    return c;
}
function setLum(c, l) { const d = l - lumOf(c[0], c[1], c[2]); return clipColor([c[0] + d, c[1] + d, c[2] + d]); }
const satOf = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c, s) {
    const out = [0, 0, 0];
    const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
    const [mn, md, mx] = idx;
    if (c[mx] > c[mn]) { out[md] = (c[md] - c[mn]) * s / (c[mx] - c[mn]); out[mx] = s; }
    out[mn] = 0;
    return out;
}

// Separable blend functions of the backdrop and source (straight, 0..1)
const SEPARABLE = {
    0: (b, s) => s,
    1: (b, s) => Math.min(b, s),
    2: (b, s) => b * s,
    3: (b, s) => b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s),
    4: (b, s) => Math.max(0, b + s - 1),
    5: (b, s) => Math.max(0, b - s),
    7: (b, s) => Math.max(b, s),
    8: (b, s) => b + s - b * s,
    9: (b, s) => b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)),
    10: (b, s) => b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)),
    11: (b, s) => Math.min(1, b + s),
    12: (b, s) => Math.min(1, b + s),
    14: (b, s) => b <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b),
    15: (b, s) => s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b),
    16: (b, s) => s <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b),
    17: (b, s) => s <= 0.5 ? (s <= 0 ? (b >= 1 ? 1 : 0) : Math.max(0, 1 - (1 - b) / (2 * s))) : (s >= 1 ? (b <= 0 ? 0 : 1) : Math.min(1, b / (2 * (1 - s)))),
    18: (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
    19: (b, s) => s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
    20: (b, s) => b + s >= 1 ? 1 : 0,
    21: (b, s) => Math.abs(b - s),
    22: (b, s) => b + s - 2 * b * s,
    36: (b, s) => s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s),
};

// The colour a mode gives (straight), for one pixel
function blendColor(mode, cb, cs, out) {
    const f = SEPARABLE[mode];
    if (f) { out[0] = f(cb[0], cs[0]); out[1] = f(cb[1], cs[1]); out[2] = f(cb[2], cs[2]); return; }
    let r;
    switch (mode) {
        case 6: r = lumOf(cs[0], cs[1], cs[2]) < lumOf(cb[0], cb[1], cb[2]) ? cs : cb; break;
        case 13: r = lumOf(cs[0], cs[1], cs[2]) > lumOf(cb[0], cb[1], cb[2]) ? cs : cb; break;
        case 23: r = setLum(setSat(cs, satOf(cb)), lumOf(cb[0], cb[1], cb[2])); break;
        case 24: r = setLum(setSat(cb, satOf(cs)), lumOf(cb[0], cb[1], cb[2])); break;
        case 25: r = setLum(cs, lumOf(cb[0], cb[1], cb[2])); break;
        case 26: r = setLum(cb, lumOf(cs[0], cs[1], cs[2])); break;
        default: r = cs;
    }
    out[0] = r[0]; out[1] = r[1]; out[2] = r[2];
}

// Blends src (straight RGBA floats; alpha already times opacity and mask) onto dst (premultiplied)
function blendTile(dst, src, mode) {
    const cb = [0, 0, 0], cs = [0, 0, 0], bl = [0, 0, 0];
    const glow = mode === 10 || mode === 12;
    for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
        const as = src[i + 3];
        if (as <= 0) continue;
        const ab = dst[i + 3];
        if (mode === 0 || ab <= 0) {
            if (glow && ab > 0) { /* fall through below */ } else {
                dst[i] = src[i] * as + dst[i] * (1 - as);
                dst[i + 1] = src[i + 1] * as + dst[i + 1] * (1 - as);
                dst[i + 2] = src[i + 2] * as + dst[i + 2] * (1 - as);
                dst[i + 3] = as + ab * (1 - as);
                continue;
            }
        }
        cb[0] = dst[i] / ab; cb[1] = dst[i + 1] / ab; cb[2] = dst[i + 2] / ab;
        cs[0] = src[i]; cs[1] = src[i + 1]; cs[2] = src[i + 2];
        if (glow) {
            // the source's colour, times its alpha, onto the backdrop
            for (let c = 0; c < 3; c++) { cs[c] *= as; }
            blendColor(mode, cb, cs, bl);
            const ao = as + ab * (1 - as);
            for (let c = 0; c < 3; c++) dst[i + c] = (bl[c] * ab + src[i + c] * as * (1 - ab));
            dst[i + 3] = ao;
            continue;
        }
        blendColor(mode, cb, cs, bl);
        const ao = as + ab * (1 - as);
        for (let c = 0; c < 3; c++) {
            const mixed = (1 - ab) * cs[c] + ab * bl[c];
            dst[i + c] = as * mixed + (1 - as) * dst[i + c];
        }
        dst[i + 3] = ao;
    }
}

// --- Compositing ---

let level = 0; // the mipmap level composited
let changes = {};
const eff = (l, key) => { const c = changes[l.id]; return c && c[key] !== undefined ? c[key] : l[key]; };

// The layer's pixels in the tile (straight floats in src); false if none. The
// pixels Clip Studio Paint saves are as it shows them: the layer colour and the
// expression colour (grey, monochrome) are already in them.
function layerPixels(l, tx, ty, src) {
    const scale = 2 ** level;
    if (l.fill) {
        for (let i = 0; i < TILE_PIXELS * 4; i += 4) { src[i] = l.fill[0]; src[i + 1] = l.fill[1]; src[i + 2] = l.fill[2]; src[i + 3] = 1; }
    } else if (l.gradient) {
        gradientTile(l.gradient, tx, ty, scale, src);
    } else if (l.original) {
        if (!sampleTransformed(l, tx, ty, src)) return false;
    } else {
        const o = levelOf(l.render, level);
        if (!o || o.missing && !o.fill) return false;
        const f = 2 ** level * o.scale; // 1 when the level exists
        const ox = Math.round(l.rx / scale), oy = Math.round(l.ry / scale);
        if (l.edge) return edgePixels(l, o, ox, oy, tx, ty, src, 1 / f);
        if (!sampleLayer(o, ox, oy, tx, ty, src, false, 1 / f)) return false;
    }
    return true;
}

// The border effect: the layer over its outline, the shape grown by the
// border's width (in pixels at 100%) in the border's colour
function edgePixels(l, o, ox, oy, tx, ty, src, step) {
    const r = l.edge.width / 2 ** level;
    const R = Math.ceil(r + 1), W = TILE + 2 * R;
    const big = new Float32Array(W * W * 4);
    if (!sampleLayer(o, ox, oy, tx - R, ty - R, big, false, step, W, W)) return false;
    const offsets = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const cover = Math.min(1, r + 0.5 - Math.sqrt(dx * dx + dy * dy));
        if (cover > 0) offsets.push(dy * W + dx, cover);
    }
    const [er, eg, eb] = l.edge.color;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const c = (y + R) * W + x + R, i = (y * TILE + x) * 4;
        let e = 0;
        for (let k = 0; k < offsets.length && e < 1; k += 2) {
            const v = big[(c + offsets[k]) * 4 + 3] > 0 ? offsets[k + 1] : 0;
            if (v > e) e = v;
        }
        const a = big[c * 4 + 3], ao = a + e * (1 - a);
        if (ao <= 0) { src[i] = src[i + 1] = src[i + 2] = src[i + 3] = 0; continue; }
        src[i] = (big[c * 4] * a + er * e * (1 - a)) / ao;
        src[i + 1] = (big[c * 4 + 1] * a + eg * e * (1 - a)) / ao;
        src[i + 2] = (big[c * 4 + 2] * a + eb * e * (1 - a)) / ao;
        src[i + 3] = ao;
    }
    return true;
}

// An image material: its original pixels, placed by its corners (an affine map
// from top left, top right and bottom left), sampled bilinearly
function sampleTransformed(l, tx, ty, src) {
    const scale = 2 ** level;
    const { tl, tr, bl } = l.transform;
    const o = l.original[0];
    const ox = l.rx, oy = l.ry;
    // canvas = tl + u * (tr - tl) / w + v * (bl - tl) / h
    const ax = (tr[0] - tl[0]) / o.width, ay = (tr[1] - tl[1]) / o.width;
    const bx = (bl[0] - tl[0]) / o.height, by = (bl[1] - tl[1]) / o.height;
    const det = ax * by - bx * ay;
    if (!det) return false;
    src.fill(0);
    let any = false;
    const px = [0, 0, 0, 0];
    const tiled = l.transform.tiled;
    const fetch = (u, v) => {
        if (tiled) { u = ((u % o.width) + o.width) % o.width; v = ((v % o.height) + o.height) % o.height; }
        if (u < 0 || v < 0 || u >= o.width || v >= o.height) { px[0] = px[1] = px[2] = px[3] = 0; return; }
        const bi = (v >> 8) * o.cols + (u >> 8);
        const block = o.blocks[bi] ? decodeBlock(o, bi, false) : null;
        if (!block) { for (let c = 0; c < 4; c++) px[c] = o.def[c] * 255; return; }
        const q = (((v & 255) << 8) + (u & 255)) * 4;
        px[0] = block[q]; px[1] = block[q + 1]; px[2] = block[q + 2]; px[3] = block[q + 3];
    };
    for (let y = 0, i = 0; y < TILE; y++) for (let x = 0; x < TILE; x++, i += 4) {
        const cx = (tx + x + 0.5) * scale - ox - tl[0], cy = (ty + y + 0.5) * scale - oy - tl[1];
        const u = (cx * by - cy * bx) / det - 0.5, v = (ax * cy - ay * cx) / det - 0.5;
        if (!tiled && (u < -1 || v < -1 || u > o.width || v > o.height)) continue;
        const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < 4; k++) {
            const du = k & 1, dv = k >> 1;
            const w = (du ? fu : 1 - fu) * (dv ? fv : 1 - fv);
            if (w <= 0) continue;
            fetch(u0 + du, v0 + dv);
            const pa = px[3] * w;
            r += px[0] * pa; g += px[1] * pa; b += px[2] * pa; a += pa;
        }
        if (a <= 0) continue;
        any = true;
        src[i] = r / a / 255; src[i + 1] = g / a / 255; src[i + 2] = b / a / 255; src[i + 3] = a / 255;
    }
    return any;
}

// A comic frame's border, over what's inside it (straight pixels in buf)
function frameLine(l, tx, ty, buf) {
    const scale = 2 ** level;
    const o = levelOf(l.frameLine, level);
    const line = take();
    if (sampleLayer(o, Math.round(l.rx / scale), Math.round(l.ry / scale), tx, ty, line, false, 1 / (2 ** level * o.scale))) {
        for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
            const a = line[i + 3];
            if (a <= 0) continue;
            const b = buf[i + 3], ao = a + b * (1 - a);
            for (let c = 0; c < 3; c++) buf[i + c] = (line[i + c] * a + buf[i + c] * b * (1 - a)) / ao;
            buf[i + 3] = ao;
        }
    }
    give(line);
}

// Multiplies the alpha (or mask array) by the layer's mask in the tile
function applyMask(l, tx, ty, alphaOf, maskBuf) {
    if (!l.mask || !eff(l, 'maskOn')) return;
    const scale = 2 ** level;
    const o = levelOf(l.mask, level);
    const f = 2 ** level * o.scale;
    sampleLayer(o, Math.round(l.mx / scale), Math.round(l.my / scale), tx, ty, maskBuf, true, 1 / f);
    alphaOf(maskBuf);
}

const pool = [];
const take = () => pool.pop() || new Float32Array(TILE_PIXELS * 4);
const give = (b) => pool.push(b);
const maskPool = [];
const takeMask = () => maskPool.pop() || new Float32Array(TILE_PIXELS);

// Composites a folder's children onto dst (premultiplied), bottom first
function compositeChildren(children, tx, ty, dst, only) {
    for (let n = 0; n < children.length; n++) {
        const l = children[n];
        const visible = only !== undefined ? isOnlyPath(l, only) : eff(l, 'visible');
        // the layers clipped to this one
        let end = n + 1;
        while (end < children.length && children[end].clip) end++;
        if (!visible) {
            // clipped layers above a hidden layer are hidden too
            if (!l.clip && only === undefined) n = end - 1;
            continue;
        }
        const opacity = only !== undefined && l.id === only ? 1 : eff(l, 'opacity');
        const mode = +eff(l, 'mode');
        if (l.clip || end === n + 1 || only !== undefined) {
            drawLayer(l, tx, ty, dst, opacity, mode, only, false);
            continue;
        }
        // a clipping group: the base alone, the clipped layers onto it (its
        // transparency kept), then the whole onto the backdrop as the base is
        const work = take();
        work.fill(0);
        const base = drawLayer(l, tx, ty, work, 1, 0, only, true);
        for (let m = n + 1; m < end; m++) {
            const c = children[m];
            if (eff(c, 'visible')) drawLayer(c, tx, ty, work, eff(c, 'opacity'), +eff(c, 'mode'), only, false, base);
        }
        for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
            const a = work[i + 3];
            if (a > 0) { work[i] /= a; work[i + 1] /= a; work[i + 2] /= a; work[i + 3] *= opacity; }
        }
        blendTile(dst, work, mode === 30 ? 0 : mode);
        maskPool.push(base);
        give(work);
        n = end - 1;
    }
}

function isOnlyPath(l, only) {
    if (l.id === only) return true;
    if (!l.folder) return false;
    for (let p = doc.byId.get(only); p; p = p.parent !== null ? doc.byId.get(p.parent) : null) if (p.id === l.id) return true;
    return false;
}

// Draws one layer onto dst; returns its alpha (with its mask) when asked, for layers clipped to it
function drawLayer(l, tx, ty, dst, opacity, mode, only, wantAlpha, lockAlpha) {
    const maskBuf = takeMask();
    let alphaOut = null;
    const keepAlpha = (src) => {
        if (!wantAlpha) return;
        alphaOut = takeMask();
        for (let i = 0; i < TILE_PIXELS; i++) alphaOut[i] = src[i * 4 + 3];
    };
    const limit = (src) => {
        applyMask(l, tx, ty, (m) => { for (let i = 0; i < TILE_PIXELS; i++) src[i * 4 + 3] *= m[i]; }, maskBuf);
    };
    if (l.folder) {
        if (mode === 30 && only === undefined) {
            // pass through: the children onto the backdrop, then mixed with it by opacity and mask
            const work = take();
            work.set(dst);
            compositeChildren(l.children, tx, ty, work, only);
            const k = takeMask();
            k.fill(opacity);
            applyMask(l, tx, ty, (m) => { for (let i = 0; i < TILE_PIXELS; i++) k[i] *= m[i]; }, maskBuf);
            for (let i = 0, j = 0; i < TILE_PIXELS; i++, j += 4) {
                const t = k[i];
                if (t >= 1) { dst[j] = work[j]; dst[j + 1] = work[j + 1]; dst[j + 2] = work[j + 2]; dst[j + 3] = work[j + 3]; }
                else if (t > 0) for (let c = 0; c < 4; c++) dst[j + c] += (work[j + c] - dst[j + c]) * t;
            }
            if (wantAlpha) { alphaOut = takeMask(); for (let i = 0; i < TILE_PIXELS; i++) alphaOut[i] = work[i * 4 + 3]; }
            maskPool.push(k);
            give(work);
        } else {
            const work = take();
            work.fill(0);
            compositeChildren(l.children, tx, ty, work, only);
            // premultiplied → straight
            for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
                const a = work[i + 3];
                if (a > 0) { work[i] /= a; work[i + 1] /= a; work[i + 2] /= a; }
            }
            limit(work);
            if (l.frameLine) frameLine(l, tx, ty, work);
            keepAlpha(work);
            for (let i = 3; i < TILE_PIXELS * 4; i += 4) work[i] *= opacity;
            blendTile(dst, work, mode === 30 ? 0 : mode);
            give(work);
        }
    } else if (l.kind === 'correction') {
        if (l.filter && l.filter.apply) {
            // the backdrop, corrected, mixed back by opacity and mask
            const src = take();
            for (let i = 0; i < TILE_PIXELS * 4; i += 4) src[i + 3] = 1;
            limit(src);
            const px = [0, 0, 0];
            for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
                const ab = dst[i + 3];
                const t = src[i + 3] * opacity;
                if (ab <= 0 || t <= 0) continue;
                px[0] = dst[i] / ab; px[1] = dst[i + 1] / ab; px[2] = dst[i + 2] / ab;
                l.filter.apply(px);
                for (let c = 0; c < 3; c++) dst[i + c] += (Math.min(1, Math.max(0, px[c])) * ab - dst[i + c]) * t;
            }
            if (wantAlpha) { alphaOut = takeMask(); alphaOut.fill(1); }
            give(src);
        }
    } else if (l.kind !== 'story') {
        const src = take();
        if (layerPixels(l, tx, ty, src)) {
            limit(src);
            keepAlpha(src);
            for (let i = 3; i < TILE_PIXELS * 4; i += 4) src[i] *= opacity;
            blendTile(dst, src, mode === 30 ? 0 : mode);
        } else if (wantAlpha) { alphaOut = takeMask(); alphaOut.fill(0); }
        give(src);
    }
    maskPool.push(maskBuf);
    if (lockAlpha) {
        // a layer clipped to a base: the colour it gives, the base's transparency
        for (let i = 0, j = 0; i < TILE_PIXELS; i++, j += 4) {
            const a = dst[j + 3], k = lockAlpha[i];
            if (a > 0) { const f = k / a; dst[j] *= f; dst[j + 1] *= f; dst[j + 2] *= f; }
            dst[j + 3] = k;
        }
    }
    if (wantAlpha && !alphaOut) { alphaOut = takeMask(); alphaOut.fill(0); }
    return alphaOut;
}

function render(newChanges, newLevel, only) {
    changes = newChanges || {};
    level = Math.max(0, Math.min(doc.levelSizes.length - 1, newLevel | 0));
    const [w, h] = doc.levelSizes[level];
    const out = new Uint8ClampedArray(w * h * 4);
    const dst = take();
    for (let ty = 0; ty < h; ty += TILE) {
        for (let tx = 0; tx < w; tx += TILE) {
            dst.fill(0);
            compositeChildren(doc.root.children, tx, ty, dst, only);
            const rows = Math.min(TILE, h - ty), cols = Math.min(TILE, w - tx);
            for (let y = 0; y < rows; y++) {
                let s = y * TILE * 4, d = ((ty + y) * w + tx) * 4;
                for (let x = 0; x < cols; x++, s += 4, d += 4) {
                    const a = dst[s + 3];
                    if (a <= 0) continue;
                    out[d] = dst[s] / a * 255; out[d + 1] = dst[s + 1] / a * 255; out[d + 2] = dst[s + 2] / a * 255;
                    out[d + 3] = a * 255;
                }
            }
        }
    }
    give(dst);
    return { image: out, level, width: w, height: h };
}

// The level shown first
function defaultLevel() {
    let k = 0;
    while (k + 1 < doc.levelSizes.length && doc.levelSizes[k][0] * doc.levelSizes[k][1] > DEFAULT_MAX_PIXELS) k++;
    return k;
}

// A small picture of each layer, from its smallest level that is still big enough
function thumbnail(l) {
    if (l.folder || l.kind === 'correction') return null;
    const s = Math.min(1, THUMB / Math.max(doc.width, doc.height));
    const tw = Math.max(1, Math.round(doc.width * s)), th = Math.max(1, Math.round(doc.height * s));
    const data = new Uint8ClampedArray(tw * th * 4);
    if (l.fill) {
        for (let i = 0; i < data.length; i += 4) { data[i] = l.fill[0] * 255; data[i + 1] = l.fill[1] * 255; data[i + 2] = l.fill[2] * 255; data[i + 3] = 255; }
        return { width: tw, height: th, data };
    }
    if (!l.render || !l.render.length) return null;
    let o = l.render[0];
    for (const c of l.render) if (!c.missing && c.width >= tw && c.height >= th) o = c;
    if (o.missing && !o.fill) return { width: tw, height: th, data };
    const f = o.scale; // offscreen pixels per canvas pixel
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const cx = (x + 0.5) / s - l.rx, cy = (y + 0.5) / s - l.ry;
        const ox = Math.floor(cx * f), oy = Math.floor(cy * f);
        if (ox < 0 || oy < 0 || ox >= o.width || oy >= o.height) continue;
        const bi = Math.floor(oy / TILE) * o.cols + Math.floor(ox / TILE);
        const block = o.blocks[bi] ? decodeBlock(o, bi, false) : null;
        const q = (y * tw + x) * 4;
        if (!block) { for (let c = 0; c < 4; c++) data[q + c] = o.def[c] * 255; continue; }
        const p = ((oy % TILE) * TILE + ox % TILE) * 4;
        data[q] = block[p]; data[q + 1] = block[p + 1]; data[q + 2] = block[p + 2]; data[q + 3] = block[p + 3];
    }
    return { width: tw, height: th, data };
}

// --- The file browser's thumbnail: CanvasPreview, reading only the database ---

async function fetchRange(url, start, end) {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return resp.status === 206 ? bytes : bytes.subarray(start, end + 1);
}

// CHNKHead's body: its size, then the offset of CHNKSQLi
async function previewFromUrl(url) {
    const head = await fetchRange(url, 0, 63);
    if (latin1(head.subarray(0, 8)) !== 'CSFCHUNK') return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const first = u64(dv, 16) || 24;
    let p = first;
    let chunk = head.length >= p + 40 ? head.subarray(p) : await fetchRange(url, p, p + 63);
    if (latin1(chunk.subarray(0, 8)) !== 'CHNKHead') return null;
    let cdv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const sqlAt = u64(cdv, 24);
    const sh = await fetchRange(url, sqlAt, sqlAt + 15);
    if (latin1(sh.subarray(0, 8)) !== 'CHNKSQLi') return null;
    const size = u64(new DataView(sh.buffer, sh.byteOffset, sh.byteLength), 8);
    const body = await fetchRange(url, sqlAt + 16, sqlAt + 16 + size - 1);
    const db = new SqliteFile(body);
    const row = db.table('CanvasPreview')[0];
    return row && row.ImageData ? row.ImageData : null;
}

self.onmessage = async ({ data }) => {
    const { id, cmd } = data;
    try {
        if (cmd === 'open') {
            const { info, preview } = openClip(new Uint8Array(data.bytes));
            // listed top first, as Clip Studio Paint's Layer palette has them
            const list = [];
            const add = (kids) => { for (let i = kids.length - 1; i >= 0; i--) { const l = kids[i]; list.push(l); if (l.folder) add(l.children); } };
            add(doc.root.children);
            const layers = list.map(l => ({
                id: l.id, name: l.name, depth: l.depth, parent: l.parent, kind: l.kind, folder: l.folder, visible: l.visible, opacity: l.opacity,
                mode: l.mode, clip: l.clip, hasMask: l.hasMask, maskOn: l.maskOn, draft: l.draft, problem: l.problem, note: l.note || '',
                filter: l.filter ? l.filter.name : '', colorType: l.colorType, layerColor: l.layerColor || null,
            }));
            const thumbs = {};
            for (const l of doc.layers) { const t = thumbnail(l); if (t) thumbs[l.id] = t; }
            const r = render({}, data.level !== undefined ? data.level : defaultLevel());
            self.postMessage({ id, result: { info, layers, thumbs, preview, ...r } }, [r.image.buffer]);
        } else if (cmd === 'render') {
            const r = render(data.changes || {}, data.level);
            self.postMessage({ id, result: r }, [r.image.buffer]);
        } else if (cmd === 'layer') {
            const r = render({}, data.level, data.layerId);
            self.postMessage({ id, result: r }, [r.image.buffer]);
        } else if (cmd === 'thumbnail') {
            const png = await previewFromUrl(data.url);
            self.postMessage({ id, result: { png } });
        }
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err), stack: err && err.stack });
    }
};
