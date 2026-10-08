// PaintTool SAI documents (.sai, .sai2), read and composited in a worker, for the
// SAI viewer (src/sai-plugin.js). Written from Wunkolo's libsai and its notes
// ("Cracking PaintTool Sai documents"), photopea's SAI2 notes and Maykowski
// Wadim's SAI2 reader (Mickom.sai2), and fitted to what PaintTool SAI exports from
// the same files (the test files Krita's developers made for libsai).
//
// A .sai is an enciphered file system (public/sai-vfs.js) holding "canvas" (16,
// width, height, then tagged fields: reso, the resolution in 16.16 dots per inch;
// layr, the selected layer...), "thumbnail" (width, height, "BM32", BGRA rows),
// "laytbl" and "subtbl" (a count, then each layer's id and type, bottom first; a
// folder before what's in it) and each layer in layers/ or sublayers/ (masks),
// named by its id in hex. A layer is a header (type, id, its bounds, which start
// 8 to 39 pixels left of and above the canvas so its tiles line up with where it
// was moved to, opacity 0-100, visible, preserve opacity, clipping, blend mode),
// tagged fields (name, pfid the folder it's in, plid the layer a mask is of,
// lmfl a mask's flags, texn / texp the paper texture, peff the watercolour edge),
// then, for a raster layer, a byte per 32 × 32 tile (whether it has pixels) and
// each such tile's channels: premultiplied B, G, R, A and four more, PackBits
// run lengths each after its 16-bit size; a mask's tiles have two, the low and
// high bytes of a 16-bit value (16447 full).
//
// A .sai2 is "SAI-CANVAS-TYPE0", flags (the second byte's low bit: the paper is
// opaque), width, height, resolution, the number of chunks, then the chunk list
// (type, object id, offset) and the chunks: hist, thum (a JPEG thumbnail, its
// entropy-coded rows packed: "jssf"), intg (the picture as SAI composited it),
// layr (id, type: norm, fold, text, liwk..., the first tile's column and row,
// the number of columns and rows, blend mode, opacity 0-100, flags: the depth in
// folders in the low byte, visible 0x10000, clipping 0x1000000; then tagged
// fields: name in UTF-16, lmsk its mask...), lpix (its pixels) and mpix (a mask's).
// Pixels are "dpcm": intg in 256 × 256 tiles, each row of each channel as
// differences from the pixel before and the pixel above; lpix / mpix in rows of
// 32 × 32 tiles, each tile skipped, one colour, or its channels' (premultiplied
// B, G, R, A, 14 bits; a mask's one) differences. The numbers are a bit code: a
// run of zero bits and the bit after say how many bits the value has (or a run
// of zeros).
//
// The picture is composited 256 × 256 pixels at a time: SAI's blend modes,
// opacity, folders (isolated or passed through), clipping, masks; paper textures,
// watercolour edges and vector layers aren't drawn (they're tagged).
//   → { id, cmd: 'open', bytes }                  ← { info, layers, thumbs, stored, image }
//   → { id, cmd: 'render', changes, paper, saved } ← { image }
//   → { id, cmd: 'layer', layerId }               ← { image } (one layer alone)
//   → { id, cmd: 'thumbnail', url, max }          ← { jpeg } or { image, width, height } or null (read with Range requests)
importScripts('sai-vfs.js');

const THUMB = 40;
const TILE = 256; // composited this many pixels at a time
const TILE_PIXELS = TILE * TILE;
const CELL = 32; // a layer's tiles
// Decoded layer tiles kept between renders (bytes)
const CACHE_BYTES = 384 << 20;
const MASK_FULL = 16447; // a .sai mask's full value
const FULL2 = 16384; // a .sai2 value's

let doc = null;
let changes = {};

// A four-letter tag stored little endian (as SAI writes its multi-character constants)
const tagOf = (dv, o) => String.fromCharCode(dv.getUint8(o + 3), dv.getUint8(o + 2), dv.getUint8(o + 1), dv.getUint8(o)).replace(/[ \0]+$/, '');
// ...and one stored in order
const ascii = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]).replace(/[ \0]+$/, '');

// A .sai layer's name: Shift_JIS (SAI is Japanese), or Windows-1252 if it isn't that
function text(bytes) {
    let n = bytes.indexOf(0);
    if (n < 0) n = bytes.length;
    const b = bytes.subarray(0, n);
    try { return new TextDecoder('shift_jis', { fatal: true }).decode(b); } catch (_) { return new TextDecoder('windows-1252').decode(b); }
}

// Tagged fields: a four-letter tag (stored little endian), its size, its data; 0 ends them
function fields(bytes, at) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Map();
    let o = at;
    while (o + 4 <= bytes.length) {
        const t = dv.getUint32(o, true);
        o += 4;
        if (!t) break;
        const n = dv.getUint32(o, true);
        out.set(tagOf(dv, o - 4), bytes.subarray(o + 4, o + 4 + n));
        o += 4 + n;
    }
    return { fields: out, end: o };
}

const fmtDate = (t) => (t > 0 && t < 4e12 ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '');

// --- .sai ---

// PackBits, every stride-th byte from off: n < 128 copies n + 1 bytes, n > 128 repeats one 257 - n times
function unpackBits(src, p, end, dst, off, stride, count) {
    let w = 0;
    while (w < count && p < end) {
        const n = src[p++];
        if (n < 128) for (let k = 0; k <= n && w < count; k++) dst[off + (w++) * stride] = src[p++];
        else if (n > 128) {
            const v = src[p++];
            for (let k = 0; k < 257 - n && w < count; k++) dst[off + (w++) * stride] = v;
        }
    }
}

const SAI_MODES = { norm: 'normal', mul: 'multiply', scrn: 'screen', over: 'overlay', add: 'luminosity', sub: 'shade', adsb: 'lumishade', cbin: 'binary', pass: 'through' };
const SAI_TYPES = { 3: 'layer', 4: 'layer4', 5: 'linework', 6: 'mask', 7: 'layer7', 8: 'folder' };

function openSai(bytes) {
    const count = Math.floor(bytes.length / SaiVfs.PAGE);
    if (!SaiVfs.isSai(bytes)) throw new Error('not a PaintTool SAI document (its first page doesn\'t decipher)');
    const vfs = SaiVfs.openVfs(i => bytes.subarray(i * SaiVfs.PAGE, (i + 1) * SaiVfs.PAGE), count);
    const file = (path) => { const e = vfs.entry(path); return e && !e.folder ? vfs.read(e) : null; };
    const canvas = file('canvas');
    if (!canvas || canvas.length < 12) throw new Error('no canvas in the file');
    const cdv = new DataView(canvas.buffer);
    const width = cdv.getUint32(4, true), height = cdv.getUint32(8, true);
    if (!(width > 0 && height > 0 && width <= 100000 && height <= 100000)) throw new Error(`bad canvas size ${width} × ${height}`);
    const cf = fields(canvas, 12).fields;
    const u32 = (v) => (v && v.length >= 4 ? new DataView(v.buffer, v.byteOffset).getUint32(0, true) : null);
    const dpi = cf.has('reso') ? Math.round(u32(cf.get('reso')) / 65536 * 100) / 100 : 0;
    const root = vfs.root();
    // ".%016x" (or "#01.%016x"): a hash of the computer that saved it
    const machine = root.find(e => /^[.#]/.test(e.name));
    const info = {
        format: 'sai', app: 'PaintTool SAI', width, height, dpi, selected: u32(cf.get('layr')) ?? -1,
        saved: machine ? fmtDate(machine.time) : '', paper: false, paperColor: [255, 255, 255], modes: MODES.filter(([m]) => SAI_MODE_SET.has(m)),
    };
    doc = { width, height, info, file, layers: [], byId: new Map(), top: [], cache: new Map(), cacheBytes: 0 };

    const table = (name, dir) => {
        const t = file(name);
        if (!t || t.length < 4) return [];
        const dv = new DataView(t.buffer);
        const n = Math.min(dv.getUint32(0, true), (t.length - 4) >> 3);
        const out = [];
        for (let i = 0; i < n; i++) {
            const data = file(`${dir}/${dv.getUint32(4 + i * 8, true).toString(16).padStart(8, '0')}`);
            if (data) out.push(saiLayer(data));
        }
        return out;
    };
    const layers = table('laytbl', 'layers');
    const subs = table('subtbl', 'sublayers');
    for (const l of layers) doc.byId.set(l.id, l);
    // a mask is its layer's (plid)
    for (const m of subs) {
        const owner = doc.byId.get(m.owner);
        if (m.kind !== 'mask' || !owner || doc.byId.has(m.id)) continue;
        m.parent = owner.id;
        owner.masks.push(m);
        doc.byId.set(m.id, m);
    }
    // folders: what's in one follows it (pfid), bottom first
    for (const l of layers) {
        const p = l.parent !== -1 ? doc.byId.get(l.parent) : null;
        if (p && p.folder && p !== l) p.children.push(l);
        else { l.parent = -1; doc.top.push(l); }
    }
    listLayers();
}

function saiLayer(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = dv.getUint32(0, true);
    const { fields: f, end } = fields(data, 37);
    const u32 = (k) => { const v = f.get(k); return v && v.length >= 4 ? new DataView(v.buffer, v.byteOffset).getUint32(0, true) : null; };
    const kind = SAI_TYPES[type] || `type ${type}`;
    const blend = tagOf(dv, 33);
    const l = newLayer({
        id: dv.getUint32(4, true), kind,
        // the canvas starts 8 pixels into the layer's bounds
        x: dv.getInt32(8, true) - 8, y: dv.getInt32(12, true) - 8,
        opacity: Math.min(100, data[28]) / 100, visible: !!data[29], protectAlpha: !!data[30], clipping: !!data[31],
        mode: SAI_MODES[blend] || 'normal',
        name: f.has('name') ? text(f.get('name')) : '',
        parent: u32('pfid') ?? -1, owner: u32('plid') ?? -1,
    });
    // a mask's lmfl: 2 on, 1 linked to its layer's moves
    if (kind === 'mask') {
        const flags = u32('lmfl') || 0;
        l.mask = true;
        l.maskOn = !!(flags & 2);
        l.maskLinked = !!(flags & 1);
    }
    if (!SAI_MODES[blend]) l.problem = `blend mode "${blend}" unknown, drawn as Normal`;
    const texn = f.get('texn');
    if (texn && texn[0]) {
        // UTF-16 or bytes, whichever it is
        l.texture = texn[1] === 0 ? new TextDecoder('utf-16le').decode(texn.subarray(0, texn.length & ~1)).replace(/\0[^]*$/, '') : text(texn);
        const tp = f.get('texp');
        if (tp && tp.length >= 3) { l.textureScale = tp[0] | (tp[1] << 8); l.textureStrength = tp[2]; }
    }
    const pe = f.get('peff');
    if (pe && pe.length >= 3 && pe[0]) l.fringe = { opacity: pe[1], width: pe[2] };
    if (kind === 'layer' || kind === 'mask') {
        // a byte per tile, then the tiles' channels
        const w = Math.floor(dv.getUint32(16, true) / CELL), h = Math.floor(dv.getUint32(20, true) / CELL);
        l.tilesX = w;
        l.tilesY = h;
        l.tiles = new Int32Array(w * h).fill(-1);
        l.decode = kind === 'mask' ? saiMaskTile : saiTile;
        const channels = kind === 'mask' ? 2 : 8;
        let o = end + w * h;
        if (o > data.length) l.problem = 'its tiles are missing';
        else for (let i = 0; i < w * h; i++) {
            if (!data[end + i]) continue;
            l.tiles[i] = o;
            for (let k = 0; k < channels && o + 2 <= data.length; k++) o += 2 + (data[o] | (data[o + 1] << 8));
            if (o > data.length) { l.problem = 'its last tiles are cut off'; l.tiles[i] = -1; break; }
        }
        l.data = data;
    } else if (!l.folder) l.problem = kind === 'linework' ? 'linework (vector) layer: not drawn' : `${kind} layer: not drawn`;
    return l;
}

// A tile's premultiplied B, G, R, A (the other four channels aren't needed)
function saiTile(l, i) {
    const d = l.data;
    let o = l.tiles[i];
    const bgra = new Uint8Array(CELL * CELL * 4);
    for (let k = 0; k < 4; k++) {
        const n = d[o] | (d[o + 1] << 8);
        unpackBits(d, o + 2, o + 2 + n, bgra, k, 4, CELL * CELL);
        o += 2 + n;
    }
    const px = new Float32Array(CELL * CELL * 4);
    for (let p = 0; p < bgra.length; p += 4) {
        px[p] = bgra[p + 2] / 255; px[p + 1] = bgra[p + 1] / 255; px[p + 2] = bgra[p] / 255; px[p + 3] = bgra[p + 3] / 255;
    }
    return px;
}

function saiMaskTile(l, i) {
    const d = l.data;
    let o = l.tiles[i];
    const v = new Uint8Array(CELL * CELL * 2);
    for (let k = 0; k < 2; k++) {
        const n = d[o] | (d[o + 1] << 8);
        unpackBits(d, o + 2, o + 2 + n, v, k, 2, CELL * CELL);
        o += 2 + n;
    }
    const px = new Float32Array(CELL * CELL * 4);
    for (let p = 0; p < CELL * CELL; p++) px[p * 4] = px[p * 4 + 1] = px[p * 4 + 2] = px[p * 4 + 3] = Math.min(1, (v[p * 2] | (v[p * 2 + 1] << 8)) / MASK_FULL);
    return px;
}

// --- .sai2 ---

const SAI2_MODES = {
    norm: 'normal', mult: 'multiply', scrn: 'screen', over: 'overlay', add: 'luminosity', sub: 'shade', sbad: 'lumishade',
    burn: 'burn', ddge: 'dodge', bndg: 'burndodge', slit: 'softlight', hlit: 'hardlight', plit: 'pinlight', ilit: 'hardmix',
    dark: 'darken', litn: 'lighten', drkc: 'darkercolor', ltrc: 'lightercolor', cdif: 'difference', excl: 'exclusion',
    fsub: 'subtract', fdiv: 'divide', hue: 'hue', sat: 'saturation', colr: 'color', lum: 'luminance', pass: 'through',
};
const SAI2_KINDS = { norm: 'layer', fold: 'folder', text: 'text', liwk: 'linework', shap: 'shape', symm: 'symmetry ruler', pers: 'perspective ruler', grid: 'grid' };

// A bit reader over 32-bit little-endian words, low bits first, as SAI2 reads its numbers
function bitReader(src, p) {
    return { src, p, lo: 0, hi: 0, n: 0 };
}
// The next number (deltas for one channel): count of them into out[off + k × stride]; false on bad data.
// A run of z zero bits then a 1 and a bit b: code 2z + b. 0: a zero; 1-14: that many bits of value
// and its sign bit; 15: 8 + 7 bits' worth of zeros.
function readNumbers(r, out, off, stride, count) {
    const s = r.src;
    let n = 0;
    while (n < count) {
        // keep 32 bits or more in (lo, hi), a 64-bit window
        if (r.n <= 32) {
            const p = r.p;
            const w = p + 3 < s.length ? (s[p] | (s[p + 1] << 8) | (s[p + 2] << 16) | (s[p + 3] << 24)) >>> 0
                : ((s[p] || 0) | ((s[p + 1] || 0) << 8) | ((s[p + 2] || 0) << 16)) >>> 0;
            if (r.n === 0) { r.lo = w; r.hi = 0; } else if (r.n < 32) { r.lo = (r.lo | (w << r.n)) >>> 0; r.hi = (w >>> (32 - r.n)) >>> 0; } else r.hi = w;
            r.p += 4;
            r.n += 32;
        }
        if (!r.lo && !r.hi) return false;
        let z = 0;
        while (z < 8 && !((r.lo >>> z) & 1)) z++;
        if (z === 8) return false;
        shift(r, z + 1);
        const code = (z << 1) | (r.lo & 1);
        shift(r, 1);
        if (code === 0) out[off + (n++) * stride] = 0;
        else if (code < 15) {
            const j = 1 << code;
            let v = (((r.lo & (j - 1)) | j) - 1);
            if (r.lo & j) v = -v;
            out[off + (n++) * stride] = v;
            shift(r, code + 1);
        } else {
            const zeros = (r.lo & 0x7f) + 8;
            shift(r, 7);
            for (let k = 0; k < zeros && n < count; k++) out[off + (n++) * stride] = 0;
        }
    }
    return true;
}
function shift(r, k) {
    if (k >= 32) { r.lo = r.hi >>> (k - 32); r.hi = 0; } else if (k > 0) { r.lo = ((r.lo >>> k) | (r.hi << (32 - k))) >>> 0; r.hi >>>= k; }
    r.n -= k;
}
// Back to the first byte not wholly read (the next row starts there)
function realign(r) {
    r.p -= r.n >> 3;
    r.lo = r.hi = r.n = 0;
}

function openSai2(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 64 || String.fromCharCode(...bytes.subarray(0, 16)) !== 'SAI-CANVAS-TYPE0') throw new Error('not a PaintTool SAI Ver.2 canvas');
    const width = dv.getUint32(20, true), height = dv.getUint32(24, true), n = dv.getUint32(32, true);
    if (!(width > 0 && height > 0 && width <= 100000 && height <= 100000)) throw new Error(`bad canvas size ${width} × ${height}`);
    if (64 + n * 16 > bytes.length) throw new Error('the chunk list is cut off');
    const chunks = [];
    for (let i = 0; i < n; i++) {
        const o = 64 + i * 16;
        chunks.push({ type: ascii(bytes, o), id: dv.getUint32(o + 4, true), at: Number(dv.getBigUint64(o + 8, true)) });
    }
    chunks.forEach((c, i) => { c.end = Math.min(bytes.length, i + 1 < n ? chunks[i + 1].at : bytes.length); });
    // the paper: transparent (the second flag byte's low bit off), white, or with 0x10
    // too the colour at 56 (black in the files there are; the colour is 0xff808080 in
    // most other files, which are on white)
    const opaque = !!(bytes[17] & 1);
    const bg = dv.getUint32(56, true);
    const paperColor = bytes[17] & 0x10 ? [(bg >>> 16) & 255, (bg >>> 8) & 255, bg & 255] : [255, 255, 255];
    const hist = chunks.find(c => c.type === 'hist');
    const info = {
        format: 'sai2', app: 'PaintTool SAI Ver.2', width, height, dpi: Math.round(dv.getUint32(28, true) / 65536 * 2.54 * 100) / 100,
        selected: dv.getUint32(36, true), paper: opaque, paperColor,
        // hist starts with when it was saved, "YYYYMMDD.hhmmss" in UTF-16
        saved: hist ? new TextDecoder('utf-16le').decode(bytes.subarray(hist.at, Math.min(hist.end, hist.at + 64))).replace(/\0[^]*$/, '')
            .replace(/^(\d{4})(\d\d)(\d\d)\.(\d\d)(\d\d)(\d\d)[^]*/, '$1-$2-$3 $4:$5:$6') : '',
        layerEffect: ascii(bytes, 60), modes: MODES.filter(([m]) => m !== 'binary'),
    };
    doc = { width, height, info, bytes, chunks, layers: [], byId: new Map(), top: [], cache: new Map(), cacheBytes: 0 };
    const pix = new Map(), masks = new Map();
    for (const c of chunks) {
        if (c.type === 'lpix') pix.set(c.id, c);
        if (c.type === 'mpix') masks.set(c.id, c);
    }
    // listed top first, a folder before what's in it, each with its depth
    const stack = [];
    const list = [];
    for (const c of chunks) {
        if (c.type !== 'layr' || c.end - c.at < 56) continue;
        const o = c.at;
        const kindTag = ascii(bytes, o + 16), blend = ascii(bytes, o + 44), flags = dv.getUint32(o + 52, true);
        const kind = SAI2_KINDS[kindTag] || kindTag;
        const f = new Map();
        for (let p = o + 56; p + 8 <= c.end;) {
            if (!dv.getUint32(p, true)) break;
            const len = dv.getUint32(p + 4, true);
            f.set(ascii(bytes, p), bytes.subarray(p + 8, Math.min(c.end, p + 8 + len)));
            p += 8 + ((len + 3) & ~3);
        }
        const nm = f.get('name');
        const l = newLayer({
            id: dv.getUint32(o + 4, true), kind, mode: SAI2_MODES[blend] || 'normal',
            opacity: Math.min(100, dv.getUint32(o + 48, true)) / 100, visible: !!(flags & 0x10000), clipping: !!(flags & 0x1000000),
            protectAlpha: !!(flags & 0x100),
            name: nm && nm.length >= 2 ? new TextDecoder('utf-16le').decode(nm.subarray(2, 2 + Math.min(nm.length - 2, (nm[0] | (nm[1] << 8)) * 2))) : '',
            depth: flags & 0xff,
        });
        if (!SAI2_MODES[blend]) l.problem = `blend mode "${blend}" unknown, drawn as Normal`;
        if (kind === 'layer') {
            const p = pix.get(l.id);
            sai2Tiles(l, p, dv.getInt32(o + 28, true), dv.getInt32(o + 32, true), dv.getUint32(o + 36, true), dv.getUint32(o + 40, true), 4);
        } else if (!l.folder) l.problem = `${kind} layer: not drawn`;
        // lmsk: the mask's id, first column and row, columns, rows, then on and linked
        const lm = f.get('lmsk');
        if (lm && lm.length >= 23) {
            const md = new DataView(lm.buffer, lm.byteOffset, lm.length);
            const m = newLayer({ id: md.getUint32(0, true), kind: 'mask', name: 'Mask', parent: l.id });
            m.mask = true;
            m.maskOn = !!lm[21];
            m.maskLinked = !!lm[22];
            sai2Tiles(m, masks.get(m.id), md.getInt32(4, true), md.getInt32(8, true), md.getUint32(12, true), md.getUint32(16, true), 1);
            l.masks.push(m);
            doc.byId.set(m.id, m);
        }
        const ce = f.get('ceff');
        // ceff "cbin": binary colour, the threshold in percent
        if (ce && ce.length >= 5 && ascii(ce, 0) === 'cbin') l.threshold = ce[4];
        const tx = f.get('ptex');
        if (tx && tx.length >= 8) {
            l.textureScale = tx[0] | (tx[1] << 8);
            l.textureStrength = tx[2] | (tx[3] << 8);
            const len = tx[6] | (tx[7] << 8);
            l.texture = new TextDecoder('utf-16le').decode(tx.subarray(8, 8 + len * 2)).replace(/\0[^]*$/, '');
        }
        const fr = f.get('frng');
        if (fr && fr.length >= 8 && fr[4]) l.fringe = { width: fr[4], opacity: fr[6] | (fr[7] << 8) };
        while (stack.length && stack[stack.length - 1].depth >= l.depth) stack.pop();
        const parent = stack[stack.length - 1];
        l.parent = parent ? parent.id : -1;
        (parent ? parent.children : list).push(l);
        if (l.folder) stack.push(l);
        doc.byId.set(l.id, l);
    }
    // bottom first, as compositing goes
    const flip = (a) => { a.reverse(); for (const l of a) if (l.folder) flip(l.children); return a; };
    doc.top = flip(list);
    listLayers();
    doc.intg = chunks.find(c => c.type === 'intg');
    doc.thum = chunks.find(c => c.type === 'thum');
}

// Where a layer's (or mask's) 32 × 32 tiles are: lpix / mpix is "dpcm", each row's
// size, then the rows; each tile starts with a word: its column (low 4 bits of the
// high byte; the low byte 0xff) and code (the top 4 bits): 0 skips the next word
// + 1 tiles, 5 is one colour (4 words), 10 is its data (the next word: its size)
function sai2Tiles(l, c, col0, row0, cols, rows, channels) {
    l.x = col0 * CELL;
    l.y = row0 * CELL;
    l.tilesX = cols;
    l.tilesY = rows;
    l.tiles = new Int32Array(cols * rows).fill(-1);
    l.channels = channels;
    l.decode = sai2Tile;
    l.data = doc.bytes;
    if (!c || !cols || !rows) return;
    const b = doc.bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (c.end - c.at < 4 + rows * 4 || ascii(b, c.at) !== 'dpcm') { if (cols && rows && c.end - c.at > 4) l.problem = 'pixels in a form not known'; return; }
    let p = c.at + 4 + rows * 4;
    for (let r = 0; r < rows; r++) {
        const size = dv.getUint32(c.at + 4 + r * 4, true), end = Math.min(c.end, p + size);
        let col = 0, q = p;
        while (col < cols && q + 4 <= end) {
            const code = b[q + 1] & 0xf0, next = dv.getUint16(q + 2, true);
            if ((b[q + 1] & 15) !== ((col0 + col) & 15)) { l.problem = 'some of its tiles are damaged'; break; }
            if (code === 0) { col += next + 1; q += 4; continue; }
            if (code === 0x50) { l.tiles[r * cols + col] = q; col++; q += 10; continue; }
            if (code !== 0xa0) { l.problem = 'some of its tiles are damaged'; break; }
            if (next) l.tiles[r * cols + col] = q;
            col++;
            q += 4 + next;
        }
        p += size;
    }
}

// A tile: one colour (14 bits) or each channel's 1024 differences: the first row's
// from the pixel before, the others' from the pixel before plus the one above minus
// the one above that one (between 0 and full)
function sai2Tile(l, i) {
    const b = l.data, at = l.tiles[i];
    const px = new Float32Array(CELL * CELL * 4);
    const ch = l.channels;
    const order = ch === 1 ? [3] : [2, 1, 0, 3]; // B, G, R, A
    if ((b[at + 1] & 0xf0) === 0x50) {
        const v = [];
        for (let k = 0; k < 4; k++) v.push(Math.min(1, (b[at + 2 + k * 2] | (b[at + 3 + k * 2] << 8)) / FULL2));
        for (let p = 0; p < px.length; p += 4) {
            if (ch === 1) px[p] = px[p + 1] = px[p + 2] = px[p + 3] = v[0];
            else { px[p] = v[2]; px[p + 1] = v[1]; px[p + 2] = v[0]; px[p + 3] = v[3]; }
        }
        return px;
    }
    const r = bitReader(b, at + 4);
    const d = new Int32Array(CELL * CELL);
    for (let k = 0; k < ch; k++) {
        d.fill(0);
        if (!readNumbers(r, d, 0, 1, CELL * CELL)) break;
        let s = d[0] & 0xffff;
        d[0] = s;
        for (let x = 1; x < CELL; x++) { s = (s + d[x]) & 0xffff; d[x] = s; }
        for (let y = 1; y < CELL; y++) {
            let j = 0, u = 0;
            for (let x = 0; x < CELL; x++) {
                const up = d[(y - 1) * CELL + x];
                j += up - u;
                j = j < 0 ? 0 : j > FULL2 ? FULL2 : j;
                const v = (d[y * CELL + x] + j) & 0xffff;
                d[y * CELL + x] = v;
                j = v;
                u = up;
            }
        }
        const c = order[k];
        for (let p = 0; p < CELL * CELL; p++) {
            const v = Math.min(1, d[p] / FULL2);
            if (ch === 1) px[p * 4] = px[p * 4 + 1] = px[p * 4 + 2] = px[p * 4 + 3] = v;
            else px[p * 4 + c] = v;
        }
    }
    return px;
}

// intg, the picture as SAI composited it: "dpcm", each 256 × 256 tile's size, the
// tiles (a word: the tile's column in the high byte; then each row's channels, B,
// G, R and A if the paper isn't opaque, 8 bits, differences as in a layer's tiles,
// a row starting at a byte), a word after each row of tiles. RGBA, or null.
function sai2Picture(bytes, c, width, height, opaque) {
    if (!c || c.end - c.at < 4 || ascii(bytes, c.at) !== 'dpcm') return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cols = Math.ceil(width / 256), rows = Math.ceil(height / 256);
    const ch = opaque ? 3 : 4;
    let p = c.at + 4 + cols * rows * 4;
    if (p > c.end) return null;
    const out = new Uint8ClampedArray(width * height * 4);
    const d = new Int32Array(256 * 4);
    let prev = new Uint8Array(256 * 4), line = new Uint8Array(256 * 4);
    for (let ty = 0, t = 0; ty < rows; ty++) {
        const th = Math.min(256, height - ty * 256);
        for (let tx = 0; tx < cols; tx++, t++) {
            const size = dv.getUint32(c.at + 4 + t * 4, true);
            const tw = Math.min(256, width - tx * 256);
            if (p + size > c.end || bytes[p + 1] !== (tx & 255)) return null;
            const r = bitReader(bytes, p + 2);
            prev.fill(0);
            for (let y = 0; y < th; y++) {
                d.fill(0);
                for (let k = 0; k < ch; k++) if (!readNumbers(r, d, k, 4, tw)) return null;
                realign(r);
                for (let k = 0; k < ch; k++) {
                    let j = 0, u = 0;
                    for (let x = 0; x < tw; x++) {
                        const i = x * 4 + k, up = prev[i];
                        j += up - u;
                        j = j < 0 ? 0 : j > 255 ? 255 : j;
                        const v = (d[i] + j) & 255;
                        line[i] = v;
                        j = v;
                        u = up;
                    }
                }
                let o = ((ty * 256 + y) * width + tx * 256) * 4;
                for (let x = 0; x < tw; x++, o += 4) {
                    out[o] = line[x * 4 + 2]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4];
                    out[o + 3] = ch === 4 ? line[x * 4 + 3] : 255;
                }
                const s = prev;
                prev = line;
                line = s;
            }
            p += size;
        }
        p += 2;
    }
    return out;
}

// thum: width, height, "jssf", width, height, channels, the quantization tables,
// then each row of 8 × 8 blocks' entropy-coded data after its size: a baseline
// JPEG with the standard Huffman tables and a restart after each row
function sai2Thumbnail() {
    const c = doc.thum, b = doc.bytes;
    if (!c || c.end - c.at < 18 || ascii(b, c.at + 8) !== 'jssf') return null;
    return { jpeg: jssfToJpeg(b.subarray(c.at + 12, c.end)) };
}

const HUFFMAN = [
    [0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    [0x10, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
        0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
        0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
        0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4,
        0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
    [0x01, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    [0x11, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77, 0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
        0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25,
        0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54,
        0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85,
        0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
        0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3,
        0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
];

// s: from the second width on (width, height, channels, tables, rows)
function jssfToJpeg(s) {
    const w = s[0] | (s[1] << 8), h = s[2] | (s[3] << 8), ch = s[4] | (s[5] << 8);
    if (!(w > 0 && h > 0 && (ch === 1 || ch === 3))) return null;
    const out = [];
    const u16 = (v) => out.push(v >> 8, v & 255);
    let p = 6;
    u16(0xffd8);
    u16(0xffdb); u16(ch > 1 ? 132 : 67);
    out.push(0, ...s.subarray(p, p + 64));
    p += 64;
    if (ch > 1) { out.push(1, ...s.subarray(p, p + 64)); p += 64; }
    const tables = ch > 1 ? HUFFMAN : HUFFMAN.slice(0, 2);
    u16(0xffc4); u16(2 + tables.reduce((n, t) => n + t.length, 0));
    for (const t of tables) out.push(...t);
    u16(0xffc0); u16(8 + ch * 3); out.push(8); u16(h); u16(w); out.push(ch);
    for (let k = 0; k < ch; k++) out.push(k + 1, 0x11, k ? 1 : 0);
    u16(0xffdd); u16(4); u16((w + 7) >> 3);
    u16(0xffda); u16(6 + ch * 2); out.push(ch);
    for (let k = 0; k < ch; k++) out.push(k + 1, k ? 0x11 : 0);
    out.push(0, 63, 0);
    const head = new Uint8Array(out);
    const parts = [head];
    const rows = (h + 7) >> 3;
    for (let r = 0; r < rows; r++) {
        if (p + 2 > s.length) return null;
        const n = s[p] | (s[p + 1] << 8);
        parts.push(s.subarray(p + 2, p + 2 + n));
        p += 2 + n;
        parts.push(new Uint8Array(r < rows - 1 ? [0xff, 0xd0 | (r & 7)] : [0xff, 0xd9]));
    }
    const total = parts.reduce((n, a) => n + a.length, 0);
    const jpeg = new Uint8Array(total);
    let o = 0;
    for (const a of parts) { jpeg.set(a, o); o += a.length; }
    return jpeg;
}

// --- Layers ---

function newLayer(props) {
    const l = {
        id: 0, kind: 'layer', name: '', x: 0, y: 0, tilesX: 0, tilesY: 0, tiles: null, decode: null,
        opacity: 1, visible: true, clipping: false, protectAlpha: false, mode: 'normal', parent: -1, depth: 0,
        children: [], masks: [], problem: '', ...props,
    };
    l.folder = l.kind === 'folder';
    if (l.folder && l.mode !== 'through') l.isolated = true;
    return l;
}

// The panel's order: top first, a folder before what's in it, a layer's mask right below it
function listLayers() {
    const walk = (list, depth) => {
        for (let i = list.length - 1; i >= 0; i--) {
            const l = list[i];
            l.depth = depth;
            doc.layers.push(l);
            for (const m of l.masks) { m.depth = depth + 1; doc.layers.push(m); }
            if (l.folder) walk(l.children, depth + 1);
        }
    };
    walk(doc.top, 0);
    for (const l of doc.layers) {
        if (l.texture) l.problem = (l.problem ? l.problem + '; ' : '') + `paper texture "${l.texture}" not applied`;
        if (l.fringe) l.problem = (l.problem ? l.problem + '; ' : '') + `watercolour edge (width ${l.fringe.width}, ${l.fringe.opacity}%) not applied`;
    }
}

// A tile's pixels, premultiplied RGBA 0..1 (a mask's value in all four)
function tilePixels(l, i) {
    const key = l.id * 1048576 + i;
    let px = doc.cache.get(key);
    if (px) { doc.cache.delete(key); doc.cache.set(key, px); return px; }
    px = l.decode(l, i);
    doc.cache.set(key, px);
    doc.cacheBytes += px.byteLength;
    while (doc.cacheBytes > CACHE_BYTES && doc.cache.size > 1) {
        const [k, old] = doc.cache.entries().next().value;
        doc.cache.delete(k);
        doc.cacheBytes -= old.byteLength;
    }
    return px;
}

// A layer's pixels in the canvas tile at (tx, ty), straight RGBA 0..1 into src;
// returns whether there were any
function layerPixels(l, tx, ty, src) {
    src.fill(0);
    if (!l.tiles) return false;
    let any = false;
    const x0 = tx - l.x, y0 = ty - l.y;
    const c0 = Math.max(0, Math.floor(x0 / CELL)), c1 = Math.min(l.tilesX - 1, Math.floor((x0 + TILE - 1) / CELL));
    const r0 = Math.max(0, Math.floor(y0 / CELL)), r1 = Math.min(l.tilesY - 1, Math.floor((y0 + TILE - 1) / CELL));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const i = r * l.tilesX + c;
            if (l.tiles[i] < 0) continue;
            const px = tilePixels(l, i);
            // the cell's pixels inside this canvas tile
            const cx = c * CELL - x0, cy = r * CELL - y0;
            const sx = Math.max(0, -cx), sy = Math.max(0, -cy), ex = Math.min(CELL, TILE - cx), ey = Math.min(CELL, TILE - cy);
            for (let y = sy; y < ey; y++) {
                let s = (y * CELL + sx) * 4, d = ((cy + y) * TILE + cx + sx) * 4;
                for (let x = sx; x < ex; x++, s += 4, d += 4) {
                    const a = px[s + 3];
                    if (a <= 0) continue;
                    any = true;
                    src[d] = Math.min(1, px[s] / a); src[d + 1] = Math.min(1, px[s + 1] / a); src[d + 2] = Math.min(1, px[s + 2] / a); src[d + 3] = a;
                }
            }
        }
    }
    return any;
}

// --- Blending ---

const MODES = [
    ['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
    ['luminosity', 'Luminosity / Shine'], ['shade', 'Shade'], ['lumishade', 'Lumi & Shade'], ['binary', 'Binary Color'],
    ['burn', 'Burn'], ['dodge', 'Dodge'], ['burndodge', 'Burn & Dodge'], ['softlight', 'Soft Light'], ['hardlight', 'Hard Light'],
    ['pinlight', 'Pin Light'], ['hardmix', 'Hard Mix'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['darkercolor', 'Darker Color'],
    ['lightercolor', 'Lighter Color'], ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'],
    ['divide', 'Divide'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminance', 'Luminosity'],
    ['through', 'Pass Through'],
];
const SAI_MODE_SET = new Set(Object.values(SAI_MODES));

const lumOf = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(c) {
    const l = lumOf(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
    if (n < 0) for (let k = 0; k < 3; k++) c[k] = l + (c[k] - l) * l / (l - n);
    if (x > 1) for (let k = 0; k < 3; k++) c[k] = l + (c[k] - l) * (1 - l) / (x - l);
    return c;
}
function setLum(c, l) { const d = l - lumOf(c[0], c[1], c[2]); return clipColor([c[0] + d, c[1] + d, c[2] + d]); }
const satOf = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c, s) {
    const x = Math.max(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]);
    return c.map(v => x > n ? (v - n) * s / (x - n) : 0);
}
const burn = (b, s) => b >= 1 ? 1 : s <= 0 ? 0 : Math.max(0, 1 - (1 - b) / s);
const dodge = (b, s) => b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));

// Separable blend functions of the backdrop and source colours (straight, 0..1)
const SEPARABLE = {
    multiply: (b, s) => b * s,
    screen: (b, s) => b + s - b * s,
    overlay: (b, s) => b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s),
    burn, dodge,
    burndodge: (b, s) => s < 0.5 ? burn(b, 2 * s) : dodge(b, 2 * s - 1),
    softlight: (b, s) => s <= 0.5 ? 2 * b * s + b * b * (1 - 2 * s) : 2 * b * (1 - s) + Math.sqrt(b) * (2 * s - 1),
    hardlight: (b, s) => s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s),
    pinlight: (b, s) => s < 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
    hardmix: (b, s) => b + s >= 1 ? 1 : 0,
    darken: Math.min, lighten: Math.max,
    difference: (b, s) => Math.abs(b - s),
    exclusion: (b, s) => b + s - 2 * b * s,
    subtract: (b, s) => Math.max(0, b - s),
    divide: (b, s) => s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s),
};
// ...and the others, for one pixel
function blendColor(mode, cb, cs) {
    switch (mode) {
        case 'hue': return setLum(setSat(cs.slice(), satOf(cb)), lumOf(cb[0], cb[1], cb[2]));
        case 'saturation': return setLum(setSat(cb.slice(), satOf(cs)), lumOf(cb[0], cb[1], cb[2]));
        case 'color': return setLum(cs.slice(), lumOf(cb[0], cb[1], cb[2]));
        case 'luminance': return setLum(cb.slice(), lumOf(cs[0], cs[1], cs[2]));
        case 'darkercolor': return lumOf(cs[0], cs[1], cs[2]) < lumOf(cb[0], cb[1], cb[2]) ? cs.slice() : cb.slice();
        case 'lightercolor': return lumOf(cs[0], cs[1], cs[2]) > lumOf(cb[0], cb[1], cb[2]) ? cs.slice() : cb.slice();
    }
    return cs.slice();
}

// Blends src (straight RGBA floats; alpha already times opacity) onto dst (premultiplied)
function blendTile(dst, src, mode) {
    const f = SEPARABLE[mode];
    const cb = [0, 0, 0], cs = [0, 0, 0];
    for (let i = 0; i < TILE_PIXELS * 4; i += 4) {
        const as = src[i + 3];
        if (as <= 0) continue;
        const ab = dst[i + 3];
        const ao = as + ab - as * ab;
        if (mode === 'luminosity' || mode === 'shade' || mode === 'lumishade') {
            // added to (or taken off) the backdrop's colour, the source times its alpha;
            // over nothing, the source as Normal would draw it
            for (let k = 0; k < 3; k++) {
                const b = ab > 0 ? dst[i + k] / ab : 0, s = src[i + k];
                let c;
                if (mode === 'luminosity') c = b + s * as;
                else if (mode === 'shade') c = b - (1 - s) * as;
                else c = b + (2 * s - 1) * as;
                c = Math.max(0, Math.min(1, c));
                const n = (as * s + ab * (1 - as) * b) / ao;
                dst[i + k] = (ab * c + (1 - ab) * n) * ao;
            }
            dst[i + 3] = ao;
            continue;
        }
        if (mode === 'binary') {
            // Binary Color: wherever the layer is, black or white, opaque; white where
            // its colour times its alpha is light (black in both test files PaintTool
            // SAI exported: a dark red, and a light pink at 70%)
            const c = lumOf(src[i], src[i + 1], src[i + 2]) * as >= 0.5 ? 1 : 0;
            dst[i] = dst[i + 1] = dst[i + 2] = c;
            dst[i + 3] = 1;
            continue;
        }
        if (mode === 'normal' || ab <= 0) {
            for (let k = 0; k < 3; k++) dst[i + k] = src[i + k] * as + dst[i + k] * (1 - as);
            dst[i + 3] = ao;
            continue;
        }
        // the mode's colour where both are, mixed by alpha (as Photoshop does)
        for (let k = 0; k < 3; k++) { cb[k] = dst[i + k] / ab; cs[k] = src[i + k]; }
        const m = f ? null : blendColor(mode, cb, cs);
        for (let k = 0; k < 3; k++) {
            const v = f ? f(cb[k], cs[k]) : Math.max(0, Math.min(1, m[k]));
            dst[i + k] = as * (1 - ab) * cs[k] + as * ab * v + (1 - as) * ab * cb[k];
        }
        dst[i + 3] = ao;
    }
}

// --- Compositing ---

const eff = (l, key) => { const c = changes[l.id]; return c && c[key] !== undefined ? c[key] : l[key]; };

const pool = [];
const take = () => pool.pop() || new Float32Array(TILE_PIXELS * 4);
const give = (b) => pool.push(b);

// Whether a layer is on the way to the one shown alone (it, or a folder it's in)
function onPath(l, only) {
    for (let o = doc.byId.get(only); o; o = o.parent !== -1 ? doc.byId.get(o.parent) : null) if (o === l) return true;
    return false;
}

// Composites a folder's children onto dst (premultiplied), bottom first: a layer
// and the layers clipped to it (those right above, clipping on) as a group
function compositeChildren(list, tx, ty, dst, only, opacityScale) {
    for (let i = 0; i < list.length; i++) {
        const base = list[i];
        let j = i + 1;
        while (j < list.length && list[j].clipping) j++;
        drawGroup(base, list.slice(i + 1, j), tx, ty, dst, only, opacityScale);
        i = j - 1;
    }
}

function drawGroup(base, clipped, tx, ty, dst, only, opacityScale) {
    if (only !== undefined) {
        for (const l of [base, ...clipped]) {
            const m = l.masks.find(k => k.id === only);
            if (m) drawLayer(m, tx, ty, dst, only, 1, 'normal');
            else if (l.id === only || onPath(l, only)) drawLayer(l, tx, ty, dst, only, 1, 'normal');
        }
        return;
    }
    if (!eff(base, 'visible')) return;
    const shown = clipped.filter(c => eff(c, 'visible'));
    const opacity = eff(base, 'opacity') * opacityScale;
    const mode = eff(base, 'mode');
    if (!shown.length) { drawLayer(base, tx, ty, dst, only, opacity, mode); return; }
    // the base alone, the clipped layers on it keeping its alpha, then the whole as the base
    const g = take();
    g.fill(0);
    drawLayer(base, tx, ty, g, only, 1, 'normal');
    const keep = new Float32Array(TILE_PIXELS);
    for (const c of shown) {
        const t = take();
        t.fill(0);
        if (drawLayer(c, tx, ty, t, only, eff(c, 'opacity'), 'normal')) {
            const src = take();
            for (let p = 0; p < TILE_PIXELS * 4; p += 4) {
                const a = t[p + 3];
                src[p + 3] = a;
                if (a > 0) { src[p] = t[p] / a; src[p + 1] = t[p + 1] / a; src[p + 2] = t[p + 2] / a; }
            }
            // blended as if the base were opaque, then at the base's alpha
            for (let p = 0; p < TILE_PIXELS; p++) {
                const a = g[p * 4 + 3];
                keep[p] = a;
                if (a > 0) { g[p * 4] /= a; g[p * 4 + 1] /= a; g[p * 4 + 2] /= a; g[p * 4 + 3] = 1; }
            }
            const m = eff(c, 'mode');
            blendTile(g, src, m === 'through' ? 'normal' : m);
            for (let p = 0; p < TILE_PIXELS; p++) {
                const k = keep[p];
                g[p * 4] *= k; g[p * 4 + 1] *= k; g[p * 4 + 2] *= k; g[p * 4 + 3] = k;
            }
            give(src);
        }
        give(t);
    }
    const src = take();
    for (let p = 0; p < TILE_PIXELS * 4; p += 4) {
        const a = g[p + 3];
        src[p + 3] = a * opacity;
        if (a > 0) { src[p] = g[p] / a; src[p + 1] = g[p + 1] / a; src[p + 2] = g[p + 2] / a; }
    }
    blendTile(dst, src, mode === 'through' ? 'normal' : mode);
    give(src);
    give(g);
}

// A layer's masks, if on: its alpha times the mask's value (none painted: hidden)
function applyMasks(l, tx, ty, src) {
    if (!l.masks.length) return;
    const m = take();
    for (const k of l.masks) {
        if (!eff(k, 'maskOn') || !eff(k, 'visible')) continue;
        layerPixels(k, tx, ty, m);
        for (let p = 3; p < TILE_PIXELS * 4; p += 4) src[p] *= m[p];
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
            src[p + 3] = a * opacity;
            if (a > 0) { any = true; src[p] = g[p] / a; src[p + 1] = g[p + 1] / a; src[p + 2] = g[p + 2] / a; }
        }
        if (any) blendTile(dst, src, mode === 'through' ? 'normal' : mode);
        give(src);
        give(g);
        return any;
    }
    if (!l.tiles) return false;
    const src = take();
    const any = layerPixels(l, tx, ty, src);
    if (any) {
        // binary colour: each channel and the alpha full or nothing, by the threshold
        if (l.threshold !== undefined) {
            const t = l.threshold / 100;
            for (let p = 0; p < TILE_PIXELS * 4; p++) src[p] = src[p] >= t ? 1 : 0;
        }
        if (only === undefined) applyMasks(l, tx, ty, src);
        if (opacity < 1) for (let p = 3; p < TILE_PIXELS * 4; p += 4) src[p] *= opacity;
        blendTile(dst, src, mode);
    }
    give(src);
    return any;
}

// paper: on the paper's colour, else transparent
let paper = false;
function render(newChanges, only, newPaper) {
    if (newChanges) changes = newChanges;
    if (newPaper !== undefined) paper = newPaper;
    const { width, height } = doc;
    const out = new Uint8ClampedArray(width * height * 4);
    const dst = new Float32Array(TILE_PIXELS * 4);
    const bg = doc.info.paperColor.map(c => c / 255);
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
                    // SAI's exports truncate
                    out[d] = Math.floor(dst[s] / a * 255 + 1e-4);
                    out[d + 1] = Math.floor(dst[s + 1] / a * 255 + 1e-4);
                    out[d + 2] = Math.floor(dst[s + 2] / a * 255 + 1e-4);
                    out[d + 3] = a * 255;
                }
            }
        }
    }
    return out;
}

// A small picture of a layer: its pixels, scaled down to fit THUMB × THUMB
function thumbnail(l) {
    const { width, height } = doc;
    const scale = Math.min(THUMB / width, THUMB / height, 1);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const data = new Uint8ClampedArray(w * h * 4);
    if (!l.tiles) return { width: w, height: h, data };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const cx = Math.floor((x + 0.5) / scale) - l.x, cy = Math.floor((y + 0.5) / scale) - l.y;
            if (cx < 0 || cy < 0 || cx >= l.tilesX * CELL || cy >= l.tilesY * CELL) continue;
            const i = Math.floor(cy / CELL) * l.tilesX + Math.floor(cx / CELL);
            if (l.tiles[i] < 0) continue;
            const px = tilePixels(l, i);
            const s = ((cy % CELL) * CELL + (cx % CELL)) * 4, d = (y * w + x) * 4, a = px[s + 3];
            if (a <= 0) continue;
            data[d] = px[s] / a * 255; data[d + 1] = px[s + 1] / a * 255; data[d + 2] = px[s + 2] / a * 255; data[d + 3] = a * 255;
        }
    }
    return { width: w, height: h, data };
}

// The thumbnail a .sai keeps: width, height, "BM32", BGRA rows (null if there's none)
function saiThumbnail() {
    const t = doc.file('thumbnail');
    if (!t || t.length < 12 || String.fromCharCode(t[8], t[9], t[10], t[11]) !== 'BM32') return null;
    const dv = new DataView(t.buffer);
    const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
    if (!(w > 0 && h > 0) || t.length < 12 + w * h * 4) return null;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, s = 12; i < px.length; i += 4, s += 4) { px[i] = t[s + 2]; px[i + 1] = t[s + 1]; px[i + 2] = t[s]; px[i + 3] = t[s + 3]; }
    return { width: w, height: h, data: px };
}

// A picture shrunk to fit max × max (nearest pixel)
function shrink(px, width, height, max) {
    const scale = Math.min(1, max / width, max / height);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (w === width && h === height) return { image: px, width, height };
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        const sy = Math.min(height - 1, Math.floor((y + 0.5) / scale));
        for (let x = 0; x < w; x++) {
            const s = (sy * width + Math.min(width - 1, Math.floor((x + 0.5) / scale))) * 4, d = (y * w + x) * 4;
            out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
        }
    }
    return { image: out, width: w, height: h };
}

// --- The file browser's thumbnail, reading only what it needs ---

async function fetchRange(url, start, end) {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // a server that ignores Range sends the whole file
    return resp.status === 206 ? bytes : bytes.subarray(start, end + 1);
}

// A .sai's "thumbnail" (its pages fetched as the file system asks for them), a
// .sai2's thum (a JPEG) or else its picture, shrunk
async function thumbnailFromUrl(url, max) {
    const head = await fetchRange(url, 0, SaiVfs.PAGE - 1);
    if (head.length >= 64 && String.fromCharCode(...head.subarray(0, 16)) === 'SAI-CANVAS-TYPE0') {
        const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
        const n = dv.getUint32(32, true);
        const list = head.length >= 64 + n * 16 ? head : await fetchRange(url, 0, 64 + n * 16 - 1);
        const ldv = new DataView(list.buffer, list.byteOffset, list.byteLength);
        const chunks = [];
        for (let i = 0; i < n && 64 + i * 16 + 16 <= list.length; i++) chunks.push({ type: ascii(list, 64 + i * 16), at: Number(ldv.getBigUint64(64 + i * 16 + 8, true)) });
        const find = (t) => { const i = chunks.findIndex(c => c.type === t); return i < 0 ? null : { at: chunks[i].at, end: i + 1 < chunks.length ? chunks[i + 1].at : Infinity }; };
        const thum = find('thum');
        if (thum && thum.end < Infinity && thum.end - thum.at < 16 << 20) {
            const b = await fetchRange(url, thum.at, thum.end - 1);
            if (ascii(b, 8) === 'jssf') { const jpeg = jssfToJpeg(b.subarray(12)); if (jpeg) return { jpeg }; }
        }
        const intg = find('intg');
        if (!intg || intg.end === Infinity || intg.end - intg.at > 64 << 20) return null;
        const b = await fetchRange(url, intg.at, intg.end - 1);
        const w = dv.getUint32(20, true), h = dv.getUint32(24, true);
        const px = sai2Picture(b, { at: 0, end: b.length }, w, h, !!(head[17] & 1));
        return px ? shrink(px, w, h, max) : null;
    }
    if (!SaiVfs.isSai(head)) return null;
    const pages = new Map([[0, head]]);
    const pageAt = (i) => { const p = pages.get(i); if (!p) throw { need: i }; return p; };
    for (let tries = 0; tries < 64; tries++) {
        try {
            const vfs = SaiVfs.openVfs(pageAt, Infinity);
            const e = vfs.entry('thumbnail');
            if (!e) return null;
            const t = vfs.read(e);
            if (t.length < 12 || String.fromCharCode(t[8], t[9], t[10], t[11]) !== 'BM32') return null;
            const tdv = new DataView(t.buffer, t.byteOffset, t.byteLength);
            const w = tdv.getUint32(0, true), h = tdv.getUint32(4, true);
            if (!(w > 0 && h > 0) || t.length < 12 + w * h * 4) return null;
            const image = new Uint8ClampedArray(w * h * 4);
            for (let i = 0, s = 12; i < image.length; i += 4, s += 4) { image[i] = t[s + 2]; image[i + 1] = t[s + 1]; image[i + 2] = t[s]; image[i + 3] = t[s + 3]; }
            return { image, width: w, height: h };
        } catch (err) {
            if (!err || err.need === undefined) throw err;
            // the page asked for and the next ones (a file's pages mostly follow each other)
            const from = err.need, count = 32;
            const b = await fetchRange(url, from * SaiVfs.PAGE, (from + count) * SaiVfs.PAGE - 1);
            if (b.length < SaiVfs.PAGE) throw new Error('the file ends early');
            for (let k = 0; (k + 1) * SaiVfs.PAGE <= b.length; k++) pages.set(from + k, b.subarray(k * SaiVfs.PAGE, (k + 1) * SaiVfs.PAGE));
        }
    }
    return null;
}

const layerInfo = (l) => ({
    id: l.id, name: l.name, type: l.kind, folder: l.folder, depth: l.depth, parent: l.parent,
    mode: l.mode, opacity: l.opacity, visible: l.visible, clipping: l.clipping, protectAlpha: l.protectAlpha,
    mask: !!l.mask, maskOn: !!l.maskOn, maskLinked: !!l.maskLinked, x: l.x, y: l.y,
    texture: l.texture || '', fringe: l.fringe || null, threshold: l.threshold, problem: l.problem,
});

self.onmessage = ({ data }) => {
    const { id } = data;
    try {
        if (data.cmd === 'open') {
            changes = {};
            const bytes = new Uint8Array(data.bytes);
            const sai2 = bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 16)) === 'SAI-CANVAS-TYPE0';
            if (sai2) openSai2(bytes); else openSai(bytes);
            paper = doc.info.paper;
            // a .sai2 keeps the picture as SAI composited it
            let image = sai2 ? sai2Picture(bytes, doc.intg, doc.width, doc.height, doc.info.paper) : null;
            doc.info.savedPicture = !!image;
            if (!image) image = render({}, undefined, paper);
            const thumbs = {};
            for (const l of doc.layers) thumbs[l.id] = thumbnail(l);
            const layers = doc.layers.map(layerInfo);
            const stored = sai2 ? sai2Thumbnail() : saiThumbnail();
            self.postMessage({ id, result: { info: doc.info, layers, thumbs, stored, image } }, [image.buffer]);
        } else if (data.cmd === 'render') {
            let image = data.saved && doc.intg ? sai2Picture(doc.bytes, doc.intg, doc.width, doc.height, doc.info.paper) : null;
            if (image) changes = data.changes || {}; else image = render(data.changes, undefined, data.paper);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else if (data.cmd === 'layer') {
            const image = render(null, data.layerId);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else if (data.cmd === 'thumbnail') {
            thumbnailFromUrl(data.url, data.max || 256).then(
                result => self.postMessage({ id, result }, result && result.image ? [result.image.buffer] : []),
                err => self.postMessage({ id, error: (err && err.message) || String(err) }));
        } else throw new Error(`unknown command ${data.cmd}`);
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
