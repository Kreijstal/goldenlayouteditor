// --- ERDAS IMAGINE images (an .img that starts "EHFA_HEADER_TAG") ---
// Hierarchical File Architecture, ERDAS IMAGINE's: a tree of entries (a name,
// a type and the data of that type), the types described by a dictionary in
// the file itself ("{1:lwidth,1:lheight,1:e3:thematic,athematic,...,layerType,
// ...}Eimg_Layer,..." - counts, pointers, item types, enums, objects of other
// types). Each Eimg_Layer under the root is a band: its pixel type (u1, u2, u4,
// u8, s8, u16, s16, u32, s32, f32, f64, c64, c128), its tiles (64x64 mostly),
// listed by its RasterDMS with their offsets and sizes, each stored as it is
// (little-endian, 1 to 4-bit pixels packed from the low bit) or compressed by
// ESRI GRID's run lengths (a minimum, then runs or plain values of 0 to 32
// bits), or all of them in a spill file beside it (an .ige, ExternalRasterDMS)
// with a bitmap of the valid ones. A band can say its "no data" value, hold a
// color table (Descriptor_Table's Red, Green, Blue and Opacity columns, a
// thematic layer's classes) and overviews (Eimg_Layer_SubSample), in the file
// or in an .rrd beside it (RRDNamesList), these maybe with spill files (.rde)
// of their own. Map_Info and Projection say where the picture is on the earth,
// ProjectionX maybe as an ESRI PE string. Read here as GDAL's HFA driver reads
// it (frmts/hfa); no browser shows it: a band is drawn to a PNG for the image
// viewer and the preview, three as a color picture, or pages as the others are.
// The workspace file is read with Range requests, so a big image opens at an
// overview no more than 4096 pixels on its long side (the others offered too).
// Bands are windowed with FITS's intervals and stretches (src/fits.js), bytes
// shown as they are and color tables applied by default; nodata is see-through.
// What the file holds (its bands, map info, projection and the whole tree) is
// in a panel that opens.
const { createLogger } = require('./debug');
const { INTERVALS, STRETCHES, fitsLimits, fitsLevels, rgbaToPng } = require('./fits');

const log = createLogger('HFA');
// A disk image's name, VICAR's and GEM's too: ERDAS IMAGINE only if it starts "EHFA_HEADER_TAG"
const HFA_MAYBE_RE = /\.img$/i;
const MAGIC = 'EHFA_HEADER_TAG';
const files = new Map(); // URL -> Promise<file>
const drawn = new Map(); // URL + view -> Promise<{ url, ... }>

function isHfaMaybeName(name) {
    return HFA_MAYBE_RE.test(name || '');
}

function isHfa(bytes) {
    return bytes.length >= 15 && String.fromCharCode(...bytes.subarray(0, 15)) === MAGIC;
}

// Whether the file at url is an ERDAS IMAGINE image (for an .img)
async function isHfaUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isHfa(value);
}

// --- Dictionary ---

// The types GDAL knows when a file's dictionary lacks them (hfadictionary.cpp)
const DEFAULT_DICTIONARY = '{1:lnumrows,}Edsc_Table,'
    + '{1:lnumRows,1:LcolumnDataPtr,1:e4:integer,real,complex,string,dataType,1:lmaxNumChars,}Edsc_Column,'
    + '{1:dwidth,1:dheight,}Eprj_Size,{1:dx,1:dy,}Eprj_Coordinate,'
    + '{0:pcproName,1:*oEprj_Coordinate,upperLeftCenter,1:*oEprj_Coordinate,lowerRightCenter,1:*oEprj_Size,pixelSize,0:pcunits,}Eprj_MapInfo,'
    + '{0:poEmif_String,LayerNames,1:*bExcludedValues,1:oEmif_String,AOIname,1:lSkipFactorX,1:lSkipFactorY,1:*oEdsc_BinFunction,BinFunction,}Eimg_StatisticsParameters830,'
    + '{1:dminimum,1:dmaximum,1:dmean,1:dmedian,1:dmode,1:dstddev,}Esta_Statistics,'
    + '{1:lnumBins,1:e4:direct,linear,logarithmic,explicit,binFunctionType,1:dminLimit,1:dmaxLimit,1:*bbinLimits,}Edsc_BinFunction,'
    + '{1:*bvalueBD,}Eimg_NonInitializedValue,'
    + '{1:x{1:x{0:pcstring,}Emif_String,type,1:x{0:pcstring,}Emif_String,MIFDictionary,0:pCMIFObject,}Emif_MIFObject,projection,1:x{0:pcstring,}Emif_String,title,}Eprj_MapProjection842,'
    + '{1:x{0:pcstring,}Emif_String,type,1:x{0:pcstring,}Emif_String,MIFDictionary,0:pCMIFObject,}Emif_MIFObject,'
    + '{1:e2:EPRJ_INTERNAL,EPRJ_EXTERNAL,proType,1:lproNumber,0:pcproExeName,0:pcproName,1:lproZone,0:pdproParams,1:*oEprj_Spheroid,proSpheroid,}Eprj_ProParameters,'
    + '{0:pcdatumname,1:e3:EPRJ_DATUM_PARAMETRIC,EPRJ_DATUM_GRID,EPRJ_DATUM_REGRESSION,type,0:pdparams,0:pcgridname,}Eprj_Datum,'
    + '{0:pcsphereName,1:da,1:db,1:deSquared,1:dradius,}Eprj_Spheroid,.';
let defaultTypes = null;

const ITEM_TYPES = '124cCesStlLfdmMbox';

// A dictionary's types: name -> { name, fields: [{ name, count, pointer, kind
// (the item type), object (a type's name), enums }] }; an inline type ("x{...}")
// is one more, as the others' first definition is the one that counts
function parseDictionary(text, types = new Map()) {
    let i = 0;
    const until = c => {
        const j = text.indexOf(c, i);
        if (j < 0) throw new Error('the dictionary ends early');
        const s = text.slice(i, j);
        i = j + 1;
        return s;
    };
    const field = () => {
        const count = parseInt(until(':'), 10);
        if (!(count >= 0)) throw new Error('a field of the dictionary has no count');
        let pointer = false;
        if (text[i] === 'p' || text[i] === '*') { pointer = true; i++; }
        let kind = text[i++];
        if (!kind || !ITEM_TYPES.includes(kind)) throw new Error(`the dictionary has an item type '${kind}'`);
        let object = null, enums = null;
        if (kind === 'o') object = until(',');
        else if (kind === 'x' && text[i] === '{') {
            object = type().name;
            kind = 'o';
        }
        if (kind === 'e') {
            const n = parseInt(until(':'), 10);
            enums = [];
            for (let k = 0; k < n; k++) enums.push(until(','));
        }
        return { name: until(','), count, pointer, kind, object, enums };
    };
    // "{" fields "}" name ","
    const type = () => {
        while (i < text.length && text[i] !== '{') i++;
        if (i >= text.length) return null;
        i++;
        const fields = [];
        while (i < text.length && text[i] !== '}') fields.push(field());
        i++;
        const t = { name: until(','), fields };
        if (!types.has(t.name)) types.set(t.name, t);
        return t;
    };
    while (i < text.length && text[i] !== '.' && type());
    return types;
}

function findType(types, name) {
    if (types.has(name)) return types.get(name);
    if (!defaultTypes) defaultTypes = parseDictionary(DEFAULT_DICTIONARY);
    return defaultTypes.get(name) || null;
}

// --- Values ---

// The pixel types (EPT_*): bits, typed array, components (two for complex), range of the integers
const PIXEL_TYPES = [
    { name: 'u1', bits: 1, Array: Uint8Array, comps: 1, range: [0, 1] },
    { name: 'u2', bits: 2, Array: Uint8Array, comps: 1, range: [0, 3] },
    { name: 'u4', bits: 4, Array: Uint8Array, comps: 1, range: [0, 15] },
    { name: 'u8', bits: 8, Array: Uint8Array, comps: 1, range: [0, 255] },
    { name: 's8', bits: 8, Array: Int8Array, comps: 1, range: [-128, 127] },
    { name: 'u16', bits: 16, Array: Uint16Array, comps: 1, range: [0, 65535] },
    { name: 's16', bits: 16, Array: Int16Array, comps: 1, range: [-32768, 32767] },
    { name: 'u32', bits: 32, Array: Uint32Array, comps: 1, range: [0, 4294967295] },
    { name: 's32', bits: 32, Array: Int32Array, comps: 1, range: [-2147483648, 2147483647] },
    { name: 'f32', bits: 32, Array: Float32Array, comps: 1 },
    { name: 'f64', bits: 64, Array: Float64Array, comps: 1 },
    { name: 'c64', bits: 64, Array: Float32Array, comps: 2 },
    { name: 'c128', bits: 128, Array: Float64Array, comps: 2 },
];

// n values of pixel type t from little-endian bytes (1 to 4-bit ones packed from
// the low bit), a typed array of the type's (complex ones as real, imaginary pairs);
// bytes too few: the rest zero
function unpack(t, bytes, n) {
    const T = PIXEL_TYPES[t];
    if (T.bits < 8) {
        const out = new Uint8Array(n);
        const per = 8 / T.bits, mask = (1 << T.bits) - 1;
        for (let i = 0; i < n; i++) {
            const byte = bytes[(i / per) | 0];
            if (byte === undefined) break;
            out[i] = (byte >> ((i % per) * T.bits)) & mask;
        }
        return out;
    }
    const size = T.bits / 8;
    const buf = new Uint8Array(n * size);
    buf.set(bytes.subarray(0, buf.length));
    return new T.Array(buf.buffer);
}

// Sizes of the dictionary's atomic items
const ITEM_SIZES = { 1: 1, 2: 1, 4: 1, c: 1, C: 1, e: 2, s: 2, S: 2, t: 4, l: 4, L: 4, f: 4, d: 8, m: 8, M: 16 };

function latin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
    return s;
}

// A BASEDATA (Egda_BaseData) at `at`: { rows, columns, type, values }, and the
// bytes it takes (as GDAL counts them: a byte a value for 1 to 4-bit ones)
function baseData(d, at, end) {
    if (at + 12 > end) throw new Error('a BASEDATA ends early');
    const rows = d.dv.getInt32(at, true), columns = d.dv.getInt32(at + 4, true), t = d.dv.getInt16(at + 8, true);
    if (!PIXEL_TYPES[t] || rows < 0 || columns < 0) throw new Error(`a BASEDATA of ${rows}×${columns} of type ${t}`);
    const n = rows * columns;
    const size = ((PIXEL_TYPES[t].bits + 7) >> 3) * n;
    if (at + 12 + size > end) throw new Error('a BASEDATA ends early');
    return [{ rows, columns, type: PIXEL_TYPES[t].name, values: Array.from(unpack(t, d.b.subarray(at + 12, at + 12 + size), n * PIXEL_TYPES[t].comps)) }, 12 + size];
}

// Field f at `at`: [value, the bytes it takes]. A pointer field has its count
// (and an offset, its data's own) first; strings are 'c' arrays, bytes 'C' ones;
// one of a kind is a value, more (or a pointer's any number) an array
function decodeField(types, f, d, at, end, depth) {
    let count = f.count, pos = at;
    if (f.pointer) {
        if (pos + 8 > end) throw new Error(`field ${f.name} ends early`);
        count = d.dv.getUint32(pos, true);
        pos += 8;
    }
    if (f.kind === 'b') {
        if (!count) return [null, pos - at];
        const [v, n] = baseData(d, pos, end);
        return [v, pos - at + n];
    }
    if (f.kind === 'o') {
        const t = findType(types, f.object);
        if (!t) throw new Error(`the dictionary has no type ${f.object}`);
        const list = [];
        for (let k = 0; k < count && pos < end; k++) {
            const [v, n] = decodeType(types, t, d, pos, end, depth + 1);
            list.push(v);
            pos += n;
            if (!n) break;
        }
        return [f.count === 1 ? (list.length ? list[0] : null) : list, pos - at];
    }
    if (f.kind === 'x') throw new Error(`field ${f.name}: an inline type without its definition`);
    const size = ITEM_SIZES[f.kind];
    const take = count * size;
    const have = Math.max(0, Math.min(count, Math.floor((end - pos) / size)));
    if (f.kind === 'c') return [latin1(d.b.subarray(pos, pos + have)), pos - at + take];
    if (f.kind === 'C' && (f.pointer || f.count !== 1)) return [d.b.slice(pos, pos + have), pos - at + take];
    const values = [];
    for (let k = 0, o = pos; k < have; k++, o += size) {
        switch (f.kind) {
        case 'e': { const v = d.dv.getUint16(o, true); values.push(f.enums[v] !== undefined ? f.enums[v] : v); break; }
        case 's': values.push(d.dv.getUint16(o, true)); break;
        case 'S': values.push(d.dv.getInt16(o, true)); break;
        case 't': case 'l': values.push(d.dv.getUint32(o, true)); break;
        case 'L': values.push(d.dv.getInt32(o, true)); break;
        case 'f': values.push(d.dv.getFloat32(o, true)); break;
        case 'd': values.push(d.dv.getFloat64(o, true)); break;
        case 'm': values.push([d.dv.getFloat32(o, true), d.dv.getFloat32(o + 4, true)]); break;
        case 'M': values.push([d.dv.getFloat64(o, true), d.dv.getFloat64(o + 8, true)]); break;
        default: values.push(d.b[o]); // 1, 2, 4, C
        }
    }
    return [f.count === 1 && !f.pointer ? values[0] : values, pos - at + take];
}

// An instance of type t at `at`: [{ field: value... }, the bytes it takes]
function decodeType(types, t, d, at, end, depth = 0) {
    if (depth > 32) throw new Error('the types nest too deep');
    const out = {};
    let pos = at;
    for (const f of t.fields) {
        if (pos >= end) break;
        const [v, n] = decodeField(types, f, d, pos, end, depth);
        out[f.name] = v;
        pos += n;
    }
    return [out, pos - at];
}

// Bytes as an instance of the named type
function decodeBytes(types, typeName, bytes) {
    const t = findType(types, typeName);
    if (!t) throw new Error(`the dictionary has no type ${typeName}`);
    return decodeType(types, t, { b: bytes, dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }, 0, bytes.length)[0];
}

// An Emif_MIFObject's object (a ProjectionX's PE string, a bin function's
// bins): its own dictionary and type, its bytes
function mifObject(mif) {
    if (!mif || !mif.MIFDictionary || !mif.type || !(mif.MIFObject instanceof Uint8Array)) return null;
    const types = parseDictionary(mif.MIFDictionary.string || '');
    return decodeBytes(types, mif.type.string, mif.MIFObject);
}

// --- The file ---

// A reader of bytes in memory: read(offset, length) -> Promise<Uint8Array> (shorter at the end)
function bytesReader(bytes) {
    return { read: async (at, n) => bytes.subarray(at, at + n) };
}

const MAX_ENTRIES = 200000;

// The entry at pos and the entries under it, its children read in turn
async function readTree(file, pos, parent, seen) {
    if (seen.has(pos) || seen.size >= MAX_ENTRIES) throw new Error(`the tree loops or is too big (entry at ${pos})`);
    seen.add(pos);
    const h = await file.reader.read(pos, 128);
    if (h.length < 124) throw new Error(`an entry at ${pos} past the end of the file`);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const e = {
        pos, parent, next: dv.getUint32(0, true), child: dv.getUint32(12, true),
        data: dv.getUint32(16, true), dataSize: dv.getUint32(20, true),
        name: latin1(h.subarray(24, 88)), type: latin1(h.subarray(88, 120)), children: [],
    };
    for (let c = e.child; c;) {
        const child = await readTree(file, c, e, seen);
        e.children.push(child);
        c = child.next;
    }
    return e;
}

// Bytes of an entry's data
async function entryBytes(file, e) {
    if (!e.dataSize) return new Uint8Array(0);
    const b = await file.reader.read(e.data, e.dataSize);
    if (b.length < e.dataSize) throw new Error(`${e.name}'s data past the end of the file`);
    return b;
}

// An entry's data as its type's fields (null if none)
async function entryValue(file, e) {
    if (!e.value) {
        e.value = (async () => {
            if (!e.dataSize || !findType(file.types, e.type)) return null;
            return decodeBytes(file.types, e.type, await entryBytes(file, e));
        })();
    }
    return e.value;
}

// The entry at a path of names ("Descriptor_Table.Red") under e
function named(e, path) {
    for (const name of path.split('.')) {
        e = e && e.children.find(c => c.name === name);
    }
    return e || null;
}

// An HFA file read through `reader` ({ read }): { name, version, types, root,
// layers (the bands), sibling (name -> Promise<reader or null>), dependents }.
// opts: name (its file name, for its .rrd's names), sibling
async function openHfa(reader, opts = {}) {
    const head = await reader.read(0, 20);
    if (!isHfa(head)) throw new Error('not an ERDAS IMAGINE file (no EHFA_HEADER_TAG at its start)');
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const hp = dv.getUint32(16, true);
    const h = await reader.read(hp, 18);
    if (h.length < 18) throw new Error('the header is past the end of the file');
    const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const file = {
        reader, name: opts.name || '', sibling: opts.sibling || (async () => null),
        version: hv.getInt32(0, true), rootPos: hv.getUint32(8, true), dictionaryPos: hv.getUint32(14, true),
        dependents: new Map(),
    };
    // the dictionary: text to a NUL (or its last ",.")
    let text = '';
    for (let at = file.dictionaryPos; ; at += 4096) {
        const b = await reader.read(at, 4096);
        const nul = b.indexOf(0);
        text += latin1(nul < 0 ? b : b.subarray(0, nul));
        if (nul >= 0 || b.length < 4096 || text.length > (1 << 24)) break;
    }
    file.dictionary = text;
    file.types = parseDictionary(text);
    file.root = await readTree(file, file.rootPos, null, new Set());
    file.entryCount = 0;
    const count = e => { file.entryCount++; e.children.forEach(count); };
    count(file.root);
    // the bands: the root's Eimg_Layers, all of the first one's size (as GDAL has them)
    file.layers = [];
    for (const e of file.root.children) {
        if (e.type !== 'Eimg_Layer') continue;
        const layer = await layerInfo(file, e);
        if (!(layer.width > 0 && layer.height > 0)) continue;
        if (file.layers.length && (layer.width !== file.layers[0].width || layer.height !== file.layers[0].height)) {
            throw new Error(`layer ${layer.name} is ${layer.width}×${layer.height}, not ${file.layers[0].width}×${file.layers[0].height} as the first`);
        }
        file.layers.push(layer);
    }
    return file;
}

// What an Eimg_Layer (or Eimg_Layer_SubSample) entry says of its band
async function layerInfo(file, e) {
    const v = await entryValue(file, e) || {};
    const t = PIXEL_TYPES.findIndex(p => p.name === v.pixelType);
    const layer = {
        file, entry: e, name: e.name, width: v.width, height: v.height, layerType: v.layerType,
        type: t, bw: v.blockWidth, bh: v.blockHeight, nodata: null,
    };
    // no size: no band (an .rrd's layers, its overviews' parents)
    if (!(layer.width > 0 && layer.height > 0)) return layer;
    if (t < 0) throw new Error(`layer ${e.name}: pixel type ${v.pixelType}`);
    if (!(layer.bw > 0 && layer.bh > 0)) throw new Error(`layer ${e.name}: blocks of ${layer.bw}×${layer.bh}`);
    const nd = named(e, 'Eimg_NonInitializedValue');
    if (nd) {
        const ndv = await entryValue(file, nd);
        if (ndv && ndv.valueBD && ndv.valueBD.values.length) layer.nodata = ndv.valueBD.values[0];
    }
    return layer;
}

// Another file, by name, beside this one (an .rrd, an .ige): its reader, or null
async function siblingReader(file, name) {
    const base = name.split(/[\\/]/).pop();
    return file.sibling(base);
}

// The HFA file named `name` that this one depends on (its .rrd), else one by
// this one's name and .rrd (the file renamed)
async function dependent(file, name) {
    const base = name.split(/[\\/]/).pop();
    if (base.toLowerCase() === file.name.toLowerCase()) return file;
    if (!file.dependents.has(base)) {
        file.dependents.set(base, (async () => {
            for (const n of [base, file.name.replace(/\.[^.]*$/, '') + '.rrd']) {
                const reader = await siblingReader(file, n).catch(() => null);
                if (!reader) continue;
                const sib = await openHfa(reader, { name: n, sibling: file.sibling }).catch(err => {
                    log.warn(`${n}: ${err.message}`);
                    return null;
                });
                if (sib) return sib;
            }
            return null;
        })());
    }
    return file.dependents.get(base);
}

// A band's levels: itself, then its overviews, the biggest first. The overviews
// RRDNamesList names ("x.rrd(:Layer_1:_ss_2_)"), else its Eimg_Layer_SubSample children
async function layerLevels(layer) {
    if (!layer.levels) {
        layer.levels = (async () => {
            const { file, entry } = layer;
            const out = [];
            const names = named(entry, 'RRDNamesList');
            if (names) {
                const v = await entryValue(file, names).catch(() => null);
                for (const item of (v && v.nameList) || []) {
                    const m = /^(.*)\(:(.*?)\)?$/.exec((item && item.string) || '');
                    if (!m) continue;
                    const dep = await dependent(file, m[1]);
                    const e = dep && named(dep.root, m[2].replace(/:/g, '.'));
                    if (!e) continue;
                    const ov = await layerInfo(dep, e).catch(err => { log.warn(`overview ${m[2]}: ${err.message}`); return null; });
                    if (ov && ov.width > 0 && ov.height > 0) out.push(ov);
                }
            }
            if (!out.length) {
                for (const e of entry.children) {
                    if (e.type !== 'Eimg_Layer_SubSample') continue;
                    const ov = await layerInfo(file, e).catch(() => null);
                    if (ov && ov.width > 0 && ov.height > 0) out.push(ov);
                }
            }
            out.sort((a, b) => b.width - a.width);
            // an overview's nodata is its band's
            for (const ov of out) if (ov.nodata === null) ov.nodata = layer.nodata;
            return [layer, ...out];
        })();
    }
    return layer.levels;
}

// Where a band's blocks are: [{ offset, size, valid, compressed, reader }],
// from its RasterDMS, or for a spill file (ExternalRasterDMS) computed, the
// valid ones from its bitmap
async function blockList(layer) {
    const { file, entry } = layer;
    const across = Math.ceil(layer.width / layer.bw), down = Math.ceil(layer.height / layer.bh);
    const n = across * down;
    const dms = named(entry, 'RasterDMS');
    if (dms) {
        const v = await entryValue(file, dms);
        const info = (v && v.blockinfo) || [];
        if (info.length < n) throw new Error(`layer ${layer.name}: ${info.length} blocks listed, ${n} wanted`);
        return info.slice(0, n).map(b => ({
            offset: b.offset >>> 0, size: b.size, valid: b.logvalid === 'true' || b.logvalid === 1,
            compressed: b.compressionType !== 'no compression' && b.compressionType !== 0, reader: file.reader,
        }));
    }
    const ext = named(entry, 'ExternalRasterDMS');
    if (!ext) throw new Error(`layer ${layer.name} has no RasterDMS`);
    const v = await entryValue(file, ext);
    const big = a => (Array.isArray(a) ? (a[0] >>> 0) + (a[1] >>> 0) * 2 ** 32 : a >>> 0);
    // the spill file: by its name, else by this file's name and its extension
    const raw = (v.fileName && v.fileName.string) || '';
    let reader = null;
    for (const name of [raw, file.name.replace(/\.[^.]*$/, '') + (/\.[^.\\/]*$/.exec(raw) || ['.ige'])[0]]) {
        reader = name && await siblingReader(file, name).catch(() => null);
        if (reader) break;
    }
    if (!reader) throw new Error(`layer ${layer.name}: its spill file ${raw} isn't there`);
    const tag = await reader.read(0, 25);
    if (latin1(tag) !== 'ERDAS_IMG_EXTERNAL_RASTER') throw new Error(`the spill file ${raw} doesn't start ERDAS_IMG_EXTERNAL_RASTER`);
    const rowBytes = Math.ceil(across / 8);
    const map = await reader.read(big(v.layerStackValidFlagsOffset), rowBytes * down + 20);
    const start = big(v.layerStackDataOffset);
    const size = Math.ceil(layer.bw * layer.bh * PIXEL_TYPES[layer.type].bits / 8);
    const out = [];
    for (let i = 0; i < n; i++) {
        const bit = Math.floor(i / across) * rowBytes * 8 + (i % across) + 20 * 8;
        out.push({
            offset: start + size * i * v.layerStackCount + v.layerStackIndex * size, size,
            valid: !!((map[bit >> 3] >> (bit & 7)) & 1), compressed: false, reader,
        });
    }
    return out;
}

// A block compressed by ESRI GRID's run lengths, its n values of pixel type t:
// the minimum, the number of runs (-1: none, every value stored), where the
// values start and their bits (0 to 32, 8+ big-endian); a run's count in 1 to
// 4 bytes (the top two bits of the first: how many more). Floats are the
// integers' bits (GDAL's bug #1000); f64 and complex ones aren't compressed so
function rleDecode(c, n, t) {
    const T = PIXEL_TYPES[t];
    if (T.bits > 32 || T.comps > 1) throw new Error(`a compressed block of ${T.name} values`);
    if (c.length < 13) throw new Error('a compressed block of under 13 bytes');
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const min = dv.getUint32(0, true), runs = dv.getInt32(4, true), dataAt = dv.getInt32(8, true), bits = c[12];
    if (![0, 1, 2, 4, 8, 16, 32].includes(bits)) throw new Error(`compressed values of ${bits} bits`);
    const ints = T.name === 'f32' ? new Int32Array(n) : null;
    const out = ints ? new Float32Array(ints.buffer) : new T.Array(n);
    const dst = ints || out;
    let vp = 0, bit = 0;
    const value = () => {
        let v = 0;
        if (bits === 0) v = 0;
        else if (bits < 8) {
            v = (c[vp + (bit >> 3)] >> (bit & 7)) & ((1 << bits) - 1);
            bit += bits;
        } else if (bits === 8) v = c[vp++];
        else if (bits === 16) { v = (c[vp] << 8) | c[vp + 1]; vp += 2; }
        else { v = dv.getUint32(vp, false); vp += 4; }
        if (vp > c.length || (vp + (bit >> 3)) > c.length) throw new Error('a compressed block ends early');
        // plus the minimum, as a 32-bit int; 1 to 4-bit values masked
        v = (v + min) | 0;
        return T.bits === 1 ? (v === 1 ? 1 : 0) : T.bits < 8 ? v & ((1 << T.bits) - 1) : v;
    };
    if (runs === -1) {
        vp = 13;
        if (13 + Math.ceil(bits * n / 8) > c.length) throw new Error('a compressed block ends early');
        for (let i = 0; i < n; i++) dst[i] = value();
        return out;
    }
    if (runs < 0 || dataAt < 0 || dataAt + Math.ceil(bits * runs / 8) > c.length) throw new Error(`${runs} runs, values at ${dataAt}`);
    vp = dataAt;
    let cp = 13, o = 0;
    for (let r = 0; r < runs; r++) {
        if (cp >= c.length) throw new Error('a compressed block ends early');
        const more = c[cp] >> 6;
        let count = c[cp++] & 0x3f;
        for (let k = 0; k < more; k++) count = count * 256 + c[cp++];
        const v = value();
        count = Math.min(count, n - o);
        dst.fill(v, o, o + count);
        o += count;
    }
    return out;
}

// The value of a block no one wrote: nodata, else 0
function nullValue(layer) {
    if (layer.nodata === null) return 0;
    const T = PIXEL_TYPES[layer.type];
    if (T.range) return Math.max(T.range[0], Math.min(T.range[1], Math.trunc(layer.nodata)));
    return layer.nodata;
}

// A band (or overview) read whole: { values (its type's typed array, complex
// ones as pairs), width, height }
async function readLayer(layer) {
    const T = PIXEL_TYPES[layer.type];
    const { width, height, bw, bh } = layer;
    const across = Math.ceil(width / bw);
    const blocks = await blockList(layer);
    const comps = T.comps;
    const out = new T.Array(width * height * comps);
    const fill = nullValue(layer);
    // (a complex one's real part)
    if (fill) for (let i = 0; i < out.length; i += comps) out[i] = fill;
    const one = async (blk, i) => {
        if (!blk.valid) return;
        const bytes = await blk.reader.read(blk.offset, blk.size);
        const vals = blk.compressed ? rleDecode(bytes, bw * bh, layer.type) : unpack(layer.type, bytes, bw * bh * comps);
        const x0 = (i % across) * bw, y0 = Math.floor(i / across) * bh;
        const w = Math.min(bw, width - x0), h = Math.min(bh, height - y0);
        for (let y = 0; y < h; y++) {
            const src = y * bw * comps;
            out.set(vals.subarray(src, src + w * comps), ((y0 + y) * width + x0) * comps);
        }
    };
    // a few hundred blocks at a time (a reader's chunks are shared)
    for (let i = 0; i < blocks.length; i += 256) {
        await Promise.all(blocks.slice(i, i + 256).map((b, k) => one(b, i + k)));
    }
    return { values: out, width, height };
}

// A band's color table: { r, g, b, a } (0..255, as GDAL scales them: v·256 clamped),
// looked up by value (its bins' values, a BFUnique bin function's), or null
async function colorTable(layer) {
    const { file, entry } = layer;
    const red = named(entry, 'Descriptor_Table.Red');
    if (!red) return null;
    const n = ((await entryValue(file, red)) || {}).numRows;
    if (!(n > 0 && n <= 65536)) return null;
    const cols = [];
    for (const name of ['Red', 'Green', 'Blue', 'Opacity']) {
        const e = named(entry, `Descriptor_Table.${name}`);
        const col = new Uint8Array(n).fill(255);
        if (e) {
            const v = await entryValue(file, e);
            const b = await file.reader.read(v.columnDataPtr >>> 0, n * 8);
            const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
            for (let i = 0; i < n && 8 * i + 8 <= b.length; i++) col[i] = Math.max(0, Math.min(255, Math.trunc(dv.getFloat64(8 * i, true) * 256)));
        }
        cols.push(col);
    }
    let bins = null;
    const bf = named(entry, 'Descriptor_Table.#Bin_Function840#');
    if (bf) {
        // a BFUnique bin function's MIF object: a BASEDATA of doubles (the values) at 24
        const v = await entryValue(file, bf).catch(() => null);
        const f = v && v.binFunction;
        const mif = f && f.MIFObject;
        if (f && f.type && f.type.string === 'BFUnique' && mif && mif.length >= 24 + 8 * n && mif[20] === 10 && mif[21] === 0) {
            const dv = new DataView(mif.buffer, mif.byteOffset, mif.byteLength);
            bins = [];
            for (let i = 0; i < n; i++) bins.push(dv.getFloat64(24 + 8 * i, true));
        }
    }
    const [r, g, b, a] = cols;
    const table = new Map();
    for (let i = 0; i < n; i++) {
        const key = bins ? bins[i] : i;
        if (bins && !(key >= 0 && key <= 65535)) break;
        table.set(Math.trunc(key), [r[i], g[i], b[i], a[i]]);
    }
    return { size: n, binned: !!bins, lookup: table };
}

// Where the picture is: { mapInfo, projection, datum, pe (the ProjectionX's PE string) }
async function geoInfo(layer) {
    const { file, entry } = layer;
    const out = {};
    const mi = named(entry, 'Map_Info') || entry.children.find(c => c.type === 'Eprj_MapInfo');
    if (mi) out.mapInfo = await entryValue(file, mi).catch(() => null);
    const pro = named(entry, 'Projection');
    if (pro) out.projection = await entryValue(file, pro).catch(() => null);
    const datum = named(entry, 'Projection.Datum');
    if (datum) out.datum = await entryValue(file, datum).catch(() => null);
    const px = named(entry, 'ProjectionX');
    if (px) {
        const v = await entryValue(file, px).catch(() => null);
        try {
            const o = v && mifObject(v.projection);
            // PE_COORDSYS: an Emif_String
            const str = o && Object.values(o).find(x => x && typeof x.string === 'string');
            if (str) out.pe = str.string;
        } catch (err) {
            log.warn('ProjectionX:', err.message);
        }
    }
    return out;
}

// --- What it holds, in words ---

// A value of the tree, short: numbers, strings, arrays (the first few), objects
function valueText(v, depth = 0) {
    if (v === null || v === undefined) return '-';
    if (typeof v === 'number') return String(Number.isInteger(v) ? v : Number(v.toPrecision(10)));
    if (typeof v === 'string') return JSON.stringify(v);
    if (v instanceof Uint8Array) return `<${v.length} bytes>`;
    if (Array.isArray(v)) {
        const shown = v.slice(0, 8).map(x => valueText(x, depth + 1)).join(', ');
        return `[${shown}${v.length > 8 ? `, … (${v.length})` : ''}]`;
    }
    if (typeof v === 'object') {
        if (depth > 4) return '{…}';
        if ('values' in v && 'rows' in v) return `${v.type} ${v.rows}×${v.columns} ${valueText(v.values, depth + 1)}`;
        const keys = Object.keys(v);
        if (keys.length === 1 && keys[0] === 'string') return valueText(v.string);
        return `{${keys.map(k => `${k}: ${valueText(v[k], depth + 1)}`).join(', ')}}`;
    }
    return String(v);
}

// The tree, an entry a line: its name, type and fields
async function treeText(file) {
    const lines = [];
    const walk = async (e, indent) => {
        let v = null;
        if (e.dataSize && e.dataSize < (1 << 20)) v = await entryValue(file, e).catch(err => `(${err.message})`);
        const fields = typeof v === 'string' ? v : v ? Object.keys(v).map(k => `${k}=${valueText(v[k])}`).join('  ') : '';
        lines.push(`${indent}${e.name || '(root)'} : ${e.type}${fields ? '  ' + fields : ''}`);
        for (const c of e.children) await walk(c, indent + '  ');
    };
    await walk(file.root, '');
    return lines.join('\n');
}

const fmt = x => (typeof x === 'number' ? String(Number(x.toPrecision(12))) : String(x));

// The header panel's text: the bands, their overviews, map info and projection, the tree
async function headerText(file) {
    const lines = [`ERDAS IMAGINE (HFA) version ${file.version}, ${file.entryCount} entries`, ''];
    for (const layer of file.layers) {
        const levels = await layerLevels(layer).catch(() => [layer]);
        const blocks = await blockList(layer).catch(() => null);
        const comp = blocks ? blocks.filter(b => b.valid && b.compressed).length : 0;
        const ct = await colorTable(layer).catch(() => null);
        lines.push(`${layer.name}: ${PIXEL_TYPES[layer.type].name}, ${layer.width}×${layer.height}, ${layer.layerType}, `
            + `blocks of ${layer.bw}×${layer.bh}${blocks ? `, ${blocks.filter(b => b.valid).length} of ${blocks.length} written` : ''}`
            + `${comp ? `, ${comp} run-length compressed` : ''}${named(layer.entry, 'ExternalRasterDMS') ? ', in a spill file' : ''}`
            + `${layer.nodata !== null ? `, nodata ${fmt(layer.nodata)}` : ''}${ct ? `, a color table of ${ct.size}${ct.binned ? ' (binned)' : ''}` : ''}`);
        for (const ov of levels.slice(1)) {
            lines.push(`  overview ${ov.width}×${ov.height}${ov.file !== file ? ` in ${ov.file.name}` : ''} (${ov.entry.name})`);
        }
    }
    if (file.layers.length) {
        const g = await geoInfo(file.layers[0]);
        const mi = g.mapInfo;
        if (mi) {
            lines.push('', `Map info: ${mi.proName || ''}${mi.units ? `, ${mi.units}` : ''}`);
            if (mi.upperLeftCenter) lines.push(`  upper left pixel's center ${fmt(mi.upperLeftCenter.x)}, ${fmt(mi.upperLeftCenter.y)}`);
            if (mi.lowerRightCenter) lines.push(`  lower right pixel's center ${fmt(mi.lowerRightCenter.x)}, ${fmt(mi.lowerRightCenter.y)}`);
            if (mi.pixelSize) lines.push(`  pixel size ${fmt(mi.pixelSize.width)} × ${fmt(mi.pixelSize.height)}`);
        }
        const p = g.projection;
        if (p) {
            lines.push('', `Projection: ${p.proName || ''} (${p.proType}, number ${p.proNumber}${p.proZone ? `, zone ${p.proZone}` : ''})`);
            if (p.proParams && p.proParams.length) lines.push(`  parameters ${p.proParams.map(fmt).join(', ')}`);
            const s = p.proSpheroid;
            if (s) lines.push(`  spheroid ${s.sphereName} (a ${fmt(s.a)}, b ${fmt(s.b)})`);
        }
        if (g.datum) lines.push(`  datum ${g.datum.datumname} (${g.datum.type})${g.datum.params && g.datum.params.length ? ` ${g.datum.params.map(fmt).join(', ')}` : ''}`);
        if (g.pe) lines.push('', 'PE string:', g.pe);
    }
    lines.push('', '--- tree ---', await treeText(file));
    return lines.join('\n');
}

// What the file is, in a few words
function summary(file) {
    const l = file.layers[0];
    if (!l) return 'no bands';
    const types = [...new Set(file.layers.map(x => PIXEL_TYPES[x.type].name))].join('/');
    return `${types}, ${l.width}×${l.height}, ${file.layers.length} band${file.layers.length > 1 ? 's' : ''}, ${l.layerType}`;
}

// --- Pictures of it ---

// The parts of a complex value one can look at
const PARTS = [['magnitude', 'magnitude'], ['real', 'real part'], ['imaginary', 'imaginary part'], ['phase', 'phase']];

// Band b's values at level `level` (0 itself, then its overviews), cached a few at a time
async function levelValues(file, b, level) {
    const key = `${b}#${level}`;
    file.values = file.values || new Map();
    let p = file.values.get(key);
    if (!p) {
        p = (async () => {
            const levels = await layerLevels(file.layers[b]);
            const at = Math.max(0, Math.min(levels.length - 1, level));
            return { ...(await readLayer(levels[at])), layer: levels[at] };
        })();
        file.values.set(key, p);
        p.catch(() => file.values.delete(key));
        if (file.values.size > 6) file.values.delete(file.values.keys().next().value);
    }
    return p;
}

// Values of a band (its part, of complex values), nodata as NaN
function shownValues(v, part, nodata) {
    const T = PIXEL_TYPES[v.layer.type];
    const src = v.values;
    const out = new Float64Array(v.width * v.height);
    if (T.comps === 1) {
        for (let i = 0; i < out.length; i++) out[i] = src[i] === nodata ? NaN : src[i];
        return out;
    }
    for (let i = 0; i < out.length; i++) {
        const re = src[2 * i], im = src[2 * i + 1];
        out[i] = re === nodata && im === 0 ? NaN
            : part === 'real' ? re : part === 'imaginary' ? im : part === 'phase' ? Math.atan2(im, re) : Math.hypot(re, im);
    }
    return out;
}

// The level a file opens at: the biggest no more than 4096 pixels on its long side
async function fitLevel(file) {
    const levels = await layerLevels(file.layers[0]);
    const i = levels.findIndex(l => Math.max(l.width, l.height) <= 4096);
    return i < 0 ? levels.length - 1 : i;
}

// The interval a band is first shown with: its type's range for 1 to 8-bit
// unsigned values, else 99.5% of the values
function defaultInterval(file) {
    return PIXEL_TYPES[file.layers[0].type].bits <= 8 && file.layers[0].type !== 4 ? 'type' : '99.5';
}

// Whether a file is first shown as a color picture: three bands
function defaultRgb(file) {
    return file.layers.length === 3;
}

// RGBA of band `page` (gray, or its color table's colors), or of three bands as
// red, green and blue, at a level; nodata see-through. view: rgb, bands, level,
// interval (or [min, max]), stretch, part, table
async function hfaRgba(file, view) {
    const bands = view.rgb ? view.bands : [view.page];
    const vals = await Promise.all(bands.map(b => levelValues(file, b, view.level)));
    const { width, height } = vals[0];
    for (const v of vals) {
        if (v.width !== width || v.height !== height) throw new Error(`the bands' overviews differ in size (${v.width}×${v.height}, ${width}×${height})`);
    }
    const n = width * height;
    const out = new Uint8ClampedArray(n * 4);
    const nodatas = bands.map(b => file.layers[b].nodata);
    // a color table: the colors of the values
    if (!view.rgb && view.table) {
        const ct = await colorTable(file.layers[view.page]);
        if (ct) {
            const src = vals[0].values, nodata = nodatas[0];
            for (let i = 0, o = 0; i < n; i++, o += 4) {
                const c = src[i] === nodata ? null : ct.lookup.get(src[i]);
                if (!c) continue;
                out[o] = c[0];
                out[o + 1] = c[1];
                out[o + 2] = c[2];
                out[o + 3] = c[3];
            }
            return { rgba: out, width, height, limits: null };
        }
    }
    const shown = vals.map((v, k) => shownValues(v, view.part, nodatas[k]));
    let limits = view.interval;
    if (!Array.isArray(limits)) {
        const T = PIXEL_TYPES[file.layers[bands[0]].type];
        if (limits === 'type' && T.range) limits = T.range;
        else {
            // over the bands shown, a million values at most
            const step = Math.max(1, Math.floor(n * shown.length / 1e6));
            const sample = [];
            for (const s of shown) for (let i = 0; i < n; i += step) sample.push(s[i]);
            limits = fitsLimits(Float64Array.from(sample), limits === 'type' ? 'minmax' : limits);
        }
    }
    const levels = shown.map(s => fitsLevels(s, limits, view.stretch));
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        const r = levels[0][i], g = levels[view.rgb ? 1 : 0][i], b = levels[view.rgb ? 2 : 0][i];
        out[o] = Math.max(r, 0);
        out[o + 1] = Math.max(g, 0);
        out[o + 2] = Math.max(b, 0);
        // nodata (or NaN) in all: see-through
        out[o + 3] = r < 0 && g < 0 && b < 0 ? 0 : 255;
    }
    return { rgba: out, width, height, limits };
}

// --- In the browser ---

const CHUNK = 1 << 20;

// The file at url, read in chunks of a megabyte with Range requests (a few dozen
// kept); a server that answers with the whole file gets read once, into memory
function urlReader(url) {
    let whole = null;
    const chunks = new Map();
    const chunk = i => {
        let p = chunks.get(i);
        if (p) {
            chunks.delete(i);
            chunks.set(i, p);
            return p;
        }
        p = (async () => {
            if (whole) return (await whole).subarray(i * CHUNK, (i + 1) * CHUNK);
            const resp = await fetch(url, { headers: { Range: `bytes=${i * CHUNK}-${(i + 1) * CHUNK - 1}` } });
            if (resp.status === 416) return new Uint8Array(0);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            if (resp.status === 206) return new Uint8Array(await resp.arrayBuffer());
            whole = resp.arrayBuffer().then(b => new Uint8Array(b));
            return (await whole).subarray(i * CHUNK, (i + 1) * CHUNK);
        })();
        chunks.set(i, p);
        p.catch(() => chunks.delete(i));
        if (chunks.size > 48) chunks.delete(chunks.keys().next().value);
        return p;
    };
    return {
        async read(at, n) {
            if (n <= 0) return new Uint8Array(0);
            const first = Math.floor(at / CHUNK), last = Math.floor((at + n - 1) / CHUNK);
            if (first === last) {
                const c = await chunk(first);
                return c.subarray(at - first * CHUNK, at - first * CHUNK + n);
            }
            const parts = [];
            for (let i = first; i <= last; i++) parts.push(chunk(i));
            const out = new Uint8Array(n);
            let o = 0;
            for (const [k, p] of parts.entries()) {
                const c = await p;
                const piece = c.subarray(k ? 0 : at - first * CHUNK).subarray(0, n - o);
                out.set(piece, o);
                o += piece.length;
                if (c.length < CHUNK) break;
            }
            return out.subarray(0, o);
        },
    };
}

// The URL of a file beside the one at url (a /workspace-file URL)
function siblingUrl(url, name) {
    const u = new URL(url, location.href);
    const path = /\/workspace-file$/.test(u.pathname) && u.searchParams.get('path');
    if (!path) return null;
    return '/workspace-file?path=' + encodeURIComponent(path.replace(/[^/]*$/, '') + name);
}

function hfaFile(url) {
    let p = files.get(url);
    if (!p) {
        p = (async () => {
            const { resolveFileUrl } = require('./archive-fallback');
            const name = decodeURIComponent((/[?&]path=([^&]*)/.exec(url) || [, ''])[1]).split('/').pop();
            // a file beside it (its .rrd, .ige): there if its first bytes are
            const sibling = async n => {
                const sib = siblingUrl(url, n);
                if (!sib) return null;
                const reader = urlReader(await resolveFileUrl(sib));
                return (await reader.read(0, 1).catch(() => [])).length ? reader : null;
            };
            return openHfa(urlReader(url), { name, sibling });
        })();
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: another band or window reads the values again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// Band `page` of the ERDAS IMAGINE file at url (or three bands in color), drawn:
// { url (a blob: URL of its PNG), page, pages, rgb, level, levels, label, width, height, limits }.
// opts: rgb (default: for three bands), bands (the three, default 1, 2, 3), level
// (default: one that fits), interval (or [min, max]), stretch, part (of complex values), table
function hfaPage(url, page = 0, opts = {}) {
    const key = `${url}#${page}#${opts.rgb}#${opts.bands}#${opts.level}#${opts.interval}#${opts.stretch}#${opts.part}#${opts.table}`;
    let p = drawn.get(key);
    if (!p) {
        p = (async () => {
            const file = await hfaFile(url);
            const nb = file.layers.length;
            if (!nb) throw new Error('no bands (Eimg_Layer) in this file');
            const rgb = nb >= 3 && (opts.rgb === undefined ? defaultRgb(file) : opts.rgb);
            const n = Math.max(0, Math.min(nb - 1, page));
            const levels = await layerLevels(file.layers[0]);
            const level = opts.level === undefined ? await fitLevel(file) : Math.max(0, Math.min(levels.length - 1, opts.level));
            const view = {
                rgb, page: n, bands: opts.bands || [0, 1, 2], level, interval: opts.interval || defaultInterval(file),
                stretch: opts.stretch || 'linear', part: opts.part || 'magnitude', table: opts.table !== false,
            };
            const d = await hfaRgba(file, view);
            const png = await rgbaToPng(d.rgba, d.width, d.height);
            return {
                url: URL.createObjectURL(png), page: n, pages: nb, rgb, level, levels: levels.map(l => [l.width, l.height]),
                width: d.width, height: d.height, limits: d.limits,
                label: rgb ? `bands ${view.bands.map(b => b + 1).join(', ')} as red, green, blue` : `band ${n + 1} of ${nb} (${file.layers[n].name})`,
            };
        })();
        drawn.set(key, p);
        p.catch(err => { drawn.delete(key); log.warn('ERDAS IMAGINE decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (drawn.size > 64) {
            const [oldKey, old] = drawn.entries().next().value;
            drawn.delete(oldKey);
            old.then(r => URL.revokeObjectURL(r.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the ERDAS IMAGINE file at url (root is the
// viewer's element, positioned): band buttons, color or one band, the scale
// (the band or an overview), the color table or the values, the part of
// complex values, the interval (or a window typed in) and the stretch; what
// the file holds in a panel that opens
function addHfaControls(root, img, url) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;z-index:1;'
        + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;max-width:calc(100% - 120px);';
    const button = (text, title) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText = 'background:none;color:inherit;border:none;font:inherit;font-size:14px;cursor:pointer;padding:2px 6px;';
        return b;
    };
    const select = (options, title) => {
        const s = document.createElement('select');
        s.title = title;
        s.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
        for (const [v, t] of options) s.add(new Option(t, v));
        return s;
    };
    const number = title => {
        const i = document.createElement('input');
        i.type = 'number';
        i.step = 'any';
        i.title = title;
        i.style.cssText = 'width:6em;background:#333;color:#fff;border:none;font:inherit;';
        return i;
    };
    const prev = button('‹', 'Previous band');
    const info = document.createElement('span');
    const next = button('›', 'Next band');
    const color = select([['rgb', 'color (bands 1-3)'], ['band', 'one band']], 'Bands 1, 2 and 3 as red, green and blue, or a band at a time');
    const scale = select([], 'The band at its own size, or one of its overviews');
    const look = select([['table', 'color table'], ['values', 'values']], "The band's color table, or its values windowed");
    const part = select(PARTS, 'The part of the complex values shown');
    const interval = select([['type', "type's range"], ...INTERVALS, ['custom', 'window']], 'Interval: the values shown black to white (over the bands shown)');
    const lo = number('Shown black (and below)');
    const hi = number('Shown white (and above)');
    const stretch = select(STRETCHES, 'Stretch');
    bar.append(prev, info, next, color, scale, look, part, interval, lo, hi, stretch);

    const header = document.createElement('details');
    header.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1;max-width:calc(100% - 16px);'
        + 'background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const sum = document.createElement('summary');
    sum.textContent = 'Header';
    sum.style.cssText = 'cursor:pointer;';
    const text = document.createElement('div');
    text.style.cssText = 'max-height:60vh;overflow:auto;margin-top:4px;font:12px monospace;white-space:pre;user-select:text;';
    header.append(sum, text);

    let page = 0, pages = 0, turn = 0, tables = [];
    const opts = () => ({
        rgb: color.value === 'rgb',
        level: Number(scale.value),
        table: look.value === 'table',
        interval: interval.value === 'custom' ? [Number(lo.value), Number(hi.value)] : interval.value,
        stretch: stretch.value,
        part: part.value,
    });
    const show = async n => {
        const mine = ++turn;
        try {
            const d = await hfaPage(url, n, opts());
            if (mine !== turn) return;
            img.src = d.url;
            page = d.page;
            pages = d.pages;
            info.textContent = d.rgb ? 'RGB' : `${page + 1} / ${pages}`;
            info.title = `${d.label}, ${d.width}×${d.height}`;
            img.title = info.title;
            info.hidden = pages < 2;
            prev.hidden = next.hidden = pages < 2 || d.rgb;
            prev.disabled = page === 0;
            next.disabled = page === pages - 1;
            const tabled = !d.rgb && tables[page];
            look.hidden = !tabled;
            interval.hidden = lo.hidden = hi.hidden = stretch.hidden = !!(tabled && look.value === 'table');
            if (d.limits && interval.value !== 'custom') {
                const round = x => Number(x.toPrecision(6));
                lo.value = round(d.limits[0]);
                hi.value = round(d.limits[1]);
            }
        } catch (err) {
            if (mine === turn) info.textContent = err.message;
        }
    };
    prev.onclick = () => show(page - 1);
    next.onclick = () => show(page + 1);
    color.onchange = () => show(page);
    scale.onchange = () => show(page);
    look.onchange = () => show(page);
    part.onchange = () => show(page);
    interval.onchange = () => show(page);
    lo.onchange = hi.onchange = () => { interval.value = 'custom'; show(page); };
    stretch.onchange = () => show(page);
    root.tabIndex = root.tabIndex >= 0 ? root.tabIndex : 0;
    root.addEventListener('keydown', e => {
        if (e.target.closest && e.target.closest('select, input, details')) return;
        if (color.value === 'rgb' && !color.hidden) return;
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { show(page + 1); e.preventDefault(); }
        else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { show(page - 1); e.preventDefault(); }
    });
    hfaFile(url).then(async file => {
        if (!file.layers.length) throw new Error('no bands (Eimg_Layer) in this file');
        const T = PIXEL_TYPES[file.layers[0].type];
        color.hidden = file.layers.length < 3;
        color.value = defaultRgb(file) ? 'rgb' : 'band';
        const levels = await layerLevels(file.layers[0]);
        for (const [i, l] of levels.entries()) scale.add(new Option(i ? `overview ${l.width}×${l.height}` : `${l.width}×${l.height}`, i));
        scale.value = await fitLevel(file);
        scale.hidden = levels.length < 2;
        tables = await Promise.all(file.layers.map(l => colorTable(l).then(Boolean).catch(() => false)));
        part.hidden = T.comps === 1;
        if (!T.range) interval.remove(0);
        interval.value = defaultInterval(file);
        sum.textContent = `Header (${summary(file)})`;
        show(0);
        text.textContent = await headerText(file);
    }).catch(err => { info.textContent = err.message; });
    root.append(bar, header);
    return bar;
}

module.exports = {
    isHfaMaybeName, isHfa, isHfaUrl, parseDictionary, decodeBytes, mifObject, bytesReader, openHfa, layerLevels,
    blockList, rleDecode, readLayer, colorTable, geoInfo, headerText, hfaRgba, hfaFile, hfaPage, addHfaControls,
};
