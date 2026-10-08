// Paint.NET images (.pdn), read and composited in a worker, for the Paint.NET
// viewer (src/pdn-plugin.js). Written from Paint.NET 3.36's sources (OpenPDN:
// Data/PdnFileType.cs, Data/Document.cs, Core/MemoryBlock.cs and the blend ops of
// Data/UserBlendOps.Generated.H.cs) and MS-NRBF, the format of .NET's
// BinaryFormatter, which every Paint.NET from 3.0 to 5.x writes the document with.
//
// A .pdn is "PDN3", a 24-bit header length, an XML header (size, layer count,
// version and a PNG thumbnail), 00 01, the BinaryFormatter stream of a
// PaintDotNet.Document (its layers: name, visibility, opacity, blend mode, and a
// Surface whose MemoryBlock holds the pixels), then each MemoryBlock's pixels in
// the order the blocks are in the stream: a format byte (0 gzip, 1 raw), the chunk
// size, then numbered chunks (in any order), BGRA with straight alpha.
//
// Layers are composited as Paint.NET does, in 8-bit integers with its rounding.
//   → { id, cmd: 'open', bytes }        ← { info, layers, thumbs, image }
//   → { id, cmd: 'render', changes }    ← { image }
//   → { id, cmd: 'layer', layerId }     ← { image } (one layer alone)
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const THUMB = 40;

// --- MS-NRBF, the BinaryFormatter stream ---

const PRIM = {
    BOOLEAN: 1, BYTE: 2, CHAR: 3, DECIMAL: 5, DOUBLE: 6, INT16: 7, INT32: 8, INT64: 9, SBYTE: 10, SINGLE: 11,
    TIMESPAN: 12, DATETIME: 13, UINT16: 14, UINT32: 15, UINT64: 16, NULL: 17, STRING: 18,
};
// BinaryTypeEnumeration
const BT = { PRIMITIVE: 0, STRING: 1, OBJECT: 2, SYSTEM_CLASS: 3, CLASS: 4, OBJECT_ARRAY: 5, STRING_ARRAY: 6, PRIMITIVE_ARRAY: 7 };

class NrbfReader {
    constructor(bytes, pos) {
        this.b = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.p = pos;
        this.objects = new Map(); // id -> object, array or string
        this.classes = new Map(); // object id of a class record -> { name, members, types, infos }
        this.memoryBlocks = []; // in stream order: the order of their pixel data after the stream
        this.utf8 = new TextDecoder();
    }

    need(n) { if (this.p + n > this.b.length) throw new Error('the file is cut short'); }
    u8() { this.need(1); return this.b[this.p++]; }
    i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }

    string() {
        // length: 7 bits a byte, low first
        let len = 0, shift = 0, byte;
        do { byte = this.u8(); len |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80 && shift < 35);
        this.need(len);
        const s = this.utf8.decode(this.b.subarray(this.p, this.p + len));
        this.p += len;
        return s;
    }

    primitive(type) {
        const dv = this.dv;
        const take = n => { this.need(n); const at = this.p; this.p += n; return at; };
        switch (type) {
            case PRIM.BOOLEAN: return this.u8() !== 0;
            case PRIM.BYTE: return this.u8();
            case PRIM.SBYTE: return dv.getInt8(take(1));
            case PRIM.CHAR: {
                // one UTF-8 character
                const first = this.b[this.p];
                const n = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
                return this.utf8.decode(this.b.subarray(take(n), this.p));
            }
            case PRIM.DECIMAL: return this.string();
            case PRIM.DOUBLE: return dv.getFloat64(take(8), true);
            case PRIM.SINGLE: return dv.getFloat32(take(4), true);
            case PRIM.INT16: return dv.getInt16(take(2), true);
            case PRIM.UINT16: return dv.getUint16(take(2), true);
            case PRIM.INT32: return dv.getInt32(take(4), true);
            case PRIM.UINT32: return dv.getUint32(take(4), true);
            case PRIM.INT64: case PRIM.TIMESPAN: case PRIM.DATETIME: return Number(dv.getBigInt64(take(8), true));
            case PRIM.UINT64: return Number(dv.getBigUint64(take(8), true));
            case PRIM.NULL: return null;
            case PRIM.STRING: return this.string();
            default: throw new Error(`unknown primitive type ${type}`);
        }
    }

    primitiveArray(type, length) {
        if (type === PRIM.BYTE) {
            this.need(length);
            const a = this.b.slice(this.p, this.p + length);
            this.p += length;
            return a;
        }
        const a = new Array(length);
        for (let i = 0; i < length; i++) a[i] = this.primitive(type);
        return a;
    }

    classInfo() {
        const id = this.i32();
        const name = this.string();
        const count = this.i32();
        const members = [];
        for (let i = 0; i < count; i++) members.push(this.string());
        return { id, name, members };
    }

    // MemberTypeInfo: a binary type for each member, then what each needs
    typeInfo(count) {
        const types = [];
        for (let i = 0; i < count; i++) types.push(this.u8());
        const infos = types.map(t => {
            if (t === BT.PRIMITIVE || t === BT.PRIMITIVE_ARRAY) return this.u8();
            if (t === BT.SYSTEM_CLASS) return this.string();
            if (t === BT.CLASS) { const name = this.string(); this.i32(); return name; }
            return null;
        });
        return { types, infos };
    }

    // A class record's members, after its metadata
    classValues(id, cls) {
        const obj = { cls: cls.name, f: {} };
        if (id) this.objects.set(id, obj);
        cls.members.forEach((m, i) => {
            obj.f[m] = cls.types && cls.types[i] === BT.PRIMITIVE ? this.primitive(cls.infos[i]) : this.record(true);
        });
        if (/\.MemoryBlock$/.test(cls.name)) this.memoryBlocks.push(obj);
        return obj;
    }

    // Values of an array of records (nulls may come several at a time)
    recordArray(length) {
        const a = new Array(length).fill(null);
        for (let i = 0; i < length;) {
            const v = this.record(true);
            if (v && v.nulls) i += v.nulls; else a[i++] = v;
        }
        return a;
    }

    // One record; a reference to an object as { ref: id }, resolved later
    record(inner) {
        const kind = this.u8();
        switch (kind) {
            case 0: { // SerializedStreamHeader
                this.rootId = this.i32();
                this.i32(); this.i32(); this.i32();
                return undefined;
            }
            case 1: { // ClassWithId: an object of a class already described
                const id = this.i32();
                const meta = this.classes.get(this.i32());
                if (!meta) throw new Error('a class record refers to an unknown class');
                return this.classValues(id, meta);
            }
            case 2: case 3: { // SystemClassWithMembers, ClassWithMembers: members are records
                const info = this.classInfo();
                if (kind === 3) this.i32();
                const cls = { name: info.name, members: info.members, types: null, infos: null };
                this.classes.set(info.id, cls);
                return this.classValues(info.id, cls);
            }
            case 4: case 5: { // SystemClassWithMembersAndTypes, ClassWithMembersAndTypes
                const info = this.classInfo();
                const t = this.typeInfo(info.members.length);
                if (kind === 5) this.i32();
                const cls = { name: info.name, members: info.members, types: t.types, infos: t.infos };
                this.classes.set(info.id, cls);
                return this.classValues(info.id, cls);
            }
            case 6: { // BinaryObjectString
                const id = this.i32();
                const s = this.string();
                this.objects.set(id, s);
                return s;
            }
            case 7: { // BinaryArray
                const id = this.i32();
                const arrayType = this.u8();
                const rank = this.i32();
                let length = 1;
                for (let i = 0; i < rank; i++) length *= this.i32();
                if (arrayType >= 3) for (let i = 0; i < rank; i++) this.i32(); // lower bounds
                const type = this.u8();
                let info = null;
                if (type === BT.PRIMITIVE || type === BT.PRIMITIVE_ARRAY) info = this.u8();
                else if (type === BT.SYSTEM_CLASS) this.string();
                else if (type === BT.CLASS) { this.string(); this.i32(); }
                const a = type === BT.PRIMITIVE ? this.primitiveArray(info, length) : this.recordArray(length);
                this.objects.set(id, a);
                return a;
            }
            case 8: return this.primitive(this.u8()); // MemberPrimitiveTyped
            case 9: return { ref: this.i32() }; // MemberReference
            case 10: return inner ? null : undefined; // ObjectNull
            case 11: this.ended = true; return undefined; // MessageEnd
            case 12: this.i32(); this.string(); return inner ? this.record(true) : undefined; // BinaryLibrary
            case 13: return { nulls: this.u8() }; // ObjectNullMultiple256
            case 14: return { nulls: this.i32() }; // ObjectNullMultiple
            case 15: { // ArraySinglePrimitive
                const id = this.i32();
                const length = this.i32();
                const a = this.primitiveArray(this.u8(), length);
                this.objects.set(id, a);
                return a;
            }
            case 16: case 17: { // ArraySingleObject, ArraySingleString
                const id = this.i32();
                const a = this.recordArray(this.i32());
                this.objects.set(id, a);
                return a;
            }
            default:
                throw new Error(`unknown BinaryFormatter record ${kind} at byte ${this.p - 1}`);
        }
    }

    readAll() {
        while (!this.ended) this.record(false);
        if (this.rootId === undefined) throw new Error('no BinaryFormatter header');
        return this.get({ ref: this.rootId });
    }

    get(v) {
        return v && v.ref !== undefined ? this.objects.get(v.ref) : v;
    }
}

// A field by its name, or the name it has as a member of a base class ("Layer+properties")
function field(obj, name) {
    if (!obj || !obj.f) return undefined;
    if (name in obj.f) return obj.f[name];
    const key = Object.keys(obj.f).find(k => k.endsWith('+' + name));
    return key ? obj.f[key] : undefined;
}

// --- Blend modes: UserBlendOps, in PaintDotNet.LayerBlendMode's order ---

const MODES = [
    ['normal', 'Normal'], ['multiply', 'Multiply'], ['additive', 'Additive'], ['colorburn', 'Color Burn'],
    ['colordodge', 'Color Dodge'], ['reflect', 'Reflect'], ['glow', 'Glow'], ['overlay', 'Overlay'],
    ['difference', 'Difference'], ['negation', 'Negation'], ['lighten', 'Lighten'], ['darken', 'Darken'],
    ['screen', 'Screen'], ['xor', 'Xor'],
];

// INT_SCALE: a × b / 255, rounded
const scale = (a, b) => { const r = a * b + 0x80; return ((r >> 8) + r) >> 8; };

// F(A, B): A the pixel below, B the layer's
const BLEND = {
    normal: (a, b) => b,
    multiply: scale,
    additive: (a, b) => Math.min(255, a + b),
    colorburn: (a, b) => b === 0 ? 0 : Math.max(0, 255 - Math.floor((255 - a) * 255 / b)),
    colordodge: (a, b) => b === 255 ? 255 : Math.min(255, Math.floor(a * 255 / (255 - b))),
    reflect: (a, b) => b === 255 ? 255 : Math.min(255, Math.floor(a * a / (255 - b))),
    glow: (a, b) => a === 255 ? 255 : Math.min(255, Math.floor(b * b / (255 - a))),
    overlay: (a, b) => a < 128 ? scale(2 * a, b) : 255 - scale(2 * (255 - a), 255 - b),
    difference: (a, b) => Math.abs(b - a),
    negation: (a, b) => 255 - Math.abs(255 - a - b),
    lighten: (a, b) => Math.max(a, b),
    darken: (a, b) => Math.min(a, b),
    screen: (a, b) => b + a - scale(b, a),
    xor: (a, b) => a ^ b,
};

// One layer over dst (both BGRA, straight alpha), as UserBlendOp.Apply with the
// layer's opacity does
function blendLayer(dst, src, opacity, mode) {
    const F = BLEND[mode] || BLEND.normal;
    const normal = F === BLEND.normal;
    // the blend function of every pair of bytes, once
    const table = new Uint8Array(65536);
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) table[(a << 8) | b] = F(a, b);
    for (let i = 0; i < dst.length; i += 4) {
        let rhsA = src[i + 3];
        if (opacity !== 255) rhsA = scale(rhsA, opacity);
        if (rhsA === 0) continue;
        const lhsA = dst[i + 3];
        // what the formula below comes to over nothing, or for an opaque pixel in normal mode
        if (lhsA === 0 || (rhsA === 255 && normal)) {
            dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = rhsA;
            continue;
        }
        const y = scale(lhsA, 255 - rhsA);
        const totalA = y + rhsA;
        const x = scale(lhsA, rhsA);
        const z = rhsA - x;
        const b = dst[i], g = dst[i + 1], r = dst[i + 2];
        const sb = src[i], sg = src[i + 1], sr = src[i + 2];
        dst[i] = (b * y + sb * z + table[(b << 8) | sb] * x) / totalA;
        dst[i + 1] = (g * y + sg * z + table[(g << 8) | sg] * x) / totalA;
        dst[i + 2] = (r * y + sr * z + table[(r << 8) | sr] * x) / totalA;
        dst[i + 3] = totalA;
    }
}

// --- The document ---

let doc = null;

function readHeader(bytes) {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'PDN3') throw new Error('not a Paint.NET image (no "PDN3" at its start)');
    const length = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16);
    if (7 + length > bytes.length) throw new Error('the file is cut short');
    const xml = new TextDecoder().decode(bytes.subarray(7, 7 + length));
    const attr = name => { const m = new RegExp(`<pdnImage\\b[^>]*\\s${name}="([^"]*)"`).exec(xml); return m ? m[1] : ''; };
    return { end: 7 + length, version: attr('savedWithVersion'), layers: +attr('layers') || 0 };
}

// The pixels of each deferred MemoryBlock, after the stream
function readBlocks(bytes, pos, blocks) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const block of blocks) {
        const inline = field(block, 'pointerData');
        if (inline) { block.pixels = inline; continue; } // Paint.NET 2.x: in the stream
        if (!field(block, 'deferred')) continue;
        const length = field(block, 'length64') ?? field(block, 'length');
        if (pos + 5 > bytes.length) throw new Error('the pixels of a layer are missing: the file is cut short');
        const format = bytes[pos];
        const chunkSize = dv.getUint32(pos + 1);
        pos += 5;
        if (format > 1 || !chunkSize) throw new Error(`unknown pixel data format ${format}`);
        const pixels = new Uint8Array(length);
        const chunks = Math.ceil(length / chunkSize);
        for (let k = 0; k < chunks; k++) {
            if (pos + 8 > bytes.length) throw new Error('the pixels of a layer are cut short');
            const number = dv.getUint32(pos), size = dv.getUint32(pos + 4);
            pos += 8;
            if (number >= chunks) throw new Error('the pixels of a layer are damaged');
            if (pos + size > bytes.length) throw new Error('the pixels of a layer are cut short');
            const offset = number * chunkSize;
            const want = Math.min(chunkSize, length - offset);
            const data = bytes.subarray(pos, pos + size);
            pos += size;
            pixels.set((format === 0 ? fflate.gunzipSync(data) : data).subarray(0, want), offset);
        }
        block.pixels = pixels;
    }
}

function blendModeOf(bitmapLayer, props, nr) {
    const mode = nr.get(field(props, 'blendMode'));
    if (mode && typeof field(mode, 'value__') === 'number') {
        const m = MODES[field(mode, 'value__')];
        return m ? m[0] : 'normal';
    }
    // Paint.NET 3.x: the class of the layer's blend op
    const op = nr.get(field(nr.get(field(bitmapLayer, 'properties')), 'blendOp'));
    const name = op && /\+(\w+)BlendOp$/.exec(op.cls);
    const key = name ? name[1].toLowerCase() : 'normal';
    return BLEND[key] ? key : 'normal';
}

// EXIF entries of the document's metadata ("$exif.tagN[0]" → <exif id= len= type= value=base64 />)
function exifOf(document, nr) {
    const out = {};
    const items = nr.get(field(document, 'userMetadataItems'));
    if (!Array.isArray(items)) return out;
    for (const it of items.map(v => nr.get(v))) {
        const key = nr.get(field(it, 'key')), value = nr.get(field(it, 'value'));
        if (typeof key !== 'string' || typeof value !== 'string' || !key.startsWith('$exif')) continue;
        const id = /\bid="(\d+)"/.exec(value), data = /\bvalue="([^"]*)"/.exec(value);
        if (id && data) out[+id[1]] = Uint8Array.from(atob(data[1]), c => c.charCodeAt(0));
    }
    return out;
}

function openPdn(bytes) {
    const header = readHeader(bytes);
    const mark = bytes[header.end] << 8 | bytes[header.end + 1];
    if (mark === 0x1f8b) throw new Error('a Paint.NET 2.x document (gzip-compressed): not supported');
    if (mark !== 0x0001) throw new Error('unknown data after the header');
    const nr = new NrbfReader(bytes, header.end + 2);
    const document = nr.readAll();
    readBlocks(bytes, nr.p, nr.memoryBlocks);
    const width = field(document, 'width'), height = field(document, 'height');
    if (!(width > 0 && height > 0)) throw new Error('the document has no size');
    const list = nr.get(field(document, 'layers'));
    const items = nr.get(field(list, '_items')) || [];
    const count = field(list, '_size') ?? items.length;
    const layers = [];
    for (let i = 0; i < count; i++) {
        const bl = nr.get(items[i]);
        if (!bl) continue;
        const props = nr.get(field(bl, 'Layer+properties'));
        const surface = nr.get(field(bl, 'surface'));
        const block = nr.get(field(surface, 'scan0'));
        const stride = field(surface, 'stride');
        const layer = {
            id: i, name: nr.get(field(props, 'name')) || '', visible: field(props, 'visible') !== false,
            opacity: field(props, 'opacity') ?? 255, isBackground: !!field(props, 'isBackground'),
            mode: blendModeOf(bl, props, nr), problem: '',
        };
        const raw = block && block.pixels;
        const bpp = stride / width;
        if (!raw) layer.problem = 'its pixels are not in the file';
        else if (field(surface, 'width') !== width || field(surface, 'height') !== height) layer.problem = 'its size is not the image\'s';
        else if (bpp !== 4 && bpp !== 3) layer.problem = `${bpp * 8} bits a pixel: not supported`;
        else {
            // BGRA, straight alpha; 24-bit surfaces (no file seen has one) are opaque
            const px = new Uint8Array(width * height * 4);
            for (let y = 0; y < height; y++) {
                const row = raw.subarray(y * stride, y * stride + width * bpp);
                if (bpp === 4) px.set(row, y * width * 4);
                else for (let x = 0; x < width; x++) {
                    const o = (y * width + x) * 4;
                    px[o] = row[x * 3]; px[o + 1] = row[x * 3 + 1]; px[o + 2] = row[x * 3 + 2]; px[o + 3] = 255;
                }
            }
            layer.pixels = px;
        }
        layers.push(layer);
    }
    const exif = exifOf(document, nr);
    const version = nr.get(field(document, 'savedWith'));
    const savedWith = version && version.f
        ? ['Major', 'Minor', 'Build', 'Revision'].map(k => field(version, '_' + k) ?? field(version, k)).join('.')
        : header.version;
    doc = { width, height, layers };
    return {
        width, height, savedWith, layerCount: layers.length,
        resolution: resolutionOf(exif), software: exif[305] ? new TextDecoder().decode(exif[305]).replace(/\0+$/, '') : '',
        modes: MODES,
    };
}

// EXIF 282/283 (rationals) and 296 (2 inches, 3 centimetres)
function resolutionOf(exif) {
    const rational = b => b && b.length >= 8 ? new DataView(b.buffer, b.byteOffset).getUint32(0, true) / (new DataView(b.buffer, b.byteOffset).getUint32(4, true) || 1) : 0;
    let x = rational(exif[282]), y = rational(exif[283]);
    if (!x || !y) return null;
    if (exif[296] && exif[296][0] === 3) { x *= 2.54; y *= 2.54; }
    return [x, y];
}

// --- Compositing ---

function render(changes, only) {
    const out = new Uint8Array(doc.width * doc.height * 4);
    for (const l of doc.layers) {
        if (!l.pixels) continue;
        const c = changes[l.id] || {};
        if (only !== undefined) { if (l.id === only) blendLayer(out, l.pixels, 255, 'normal'); continue; }
        if (!(c.visible ?? l.visible)) continue;
        blendLayer(out, l.pixels, Math.round((c.opacity ?? l.opacity / 255) * 255), c.mode ?? l.mode);
    }
    // BGRA → RGBA
    for (let i = 0; i < out.length; i += 4) { const b = out[i]; out[i] = out[i + 2]; out[i + 2] = b; }
    return out;
}

// A small preview of each layer, RGBA
function thumbnail(l) {
    if (!l.pixels) return null;
    const s = Math.min(1, THUMB / Math.max(doc.width, doc.height));
    const tw = Math.max(1, Math.round(doc.width * s)), th = Math.max(1, Math.round(doc.height * s));
    const data = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const sx = Math.min(doc.width - 1, Math.floor((x + 0.5) / s)), sy = Math.min(doc.height - 1, Math.floor((y + 0.5) / s));
        const i = (sy * doc.width + sx) * 4, o = (y * tw + x) * 4;
        data[o] = l.pixels[i + 2]; data[o + 1] = l.pixels[i + 1]; data[o + 2] = l.pixels[i]; data[o + 3] = l.pixels[i + 3];
    }
    return { width: tw, height: th, data };
}

self.onmessage = ({ data }) => {
    const { id, cmd } = data;
    try {
        if (cmd === 'open') {
            const info = openPdn(new Uint8Array(data.bytes));
            // listed top first, as Paint.NET's Layers window has them
            const layers = doc.layers.map(l => ({
                id: l.id, name: l.name, visible: l.visible, opacity: l.opacity / 255, mode: l.mode,
                isBackground: l.isBackground, problem: l.problem,
            })).reverse();
            const thumbs = {};
            for (const l of doc.layers) { const t = thumbnail(l); if (t) thumbs[l.id] = t; }
            const image = render({});
            self.postMessage({ id, result: { info, layers, thumbs, image } }, [image.buffer]);
        } else if (cmd === 'render') {
            const image = render(data.changes || {});
            self.postMessage({ id, result: { image } }, [image.buffer]);
        } else if (cmd === 'layer') {
            const image = render({}, data.layerId);
            self.postMessage({ id, result: { image } }, [image.buffer]);
        }
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
