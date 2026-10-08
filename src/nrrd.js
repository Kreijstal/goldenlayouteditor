// --- NRRD, Nearly Raw Raster Data (.nrrd; .nhdr, a detached header) ---
// Teem's format (teem.sourceforge.net/nrrd/format.html), 3D Slicer's and ITK's
// for volumes: a text header ("NRRD0001" to "NRRD0005", "field: value" lines,
// "key:=value" pairs) and the data, after a blank line in an .nrrd, in other
// files beside an .nhdr ("data file: name", "data file: format min max step"
// as sprintf's %03d..., or "data file: LIST" and the names on the lines after;
// relative to the header, fetched through /workspace-file). Read here: every
// type (int8 to int64, unsigned too, float, double), either endian, the raw,
// ascii, hex, gzip (the browser's DecompressionStream) and bzip2 (SheetJS's
// bz2, from jsDelivr, loaded when one is met) encodings, line skip and byte
// skip (-1: the data at the file's end), in any dimension. No browser shows
// it: a page is drawn to a PNG for the image viewer, the preview and the
// thumbnails. Two space axes are the picture, axis order kept (the first to the
// right, the second down, as unu saves one); an axis whose kind is RGB-color,
// RGBA-color, 3-color or 4-color (or ITK's 3 or 4-vector of bytes) is its
// color; every other axis turns pages, a volume's slices (the middle one first;
// which axis it is sliced across can be chosen), a 4-D file's lists or times.
// Scientific data being high dynamic range, the picture is windowed with FITS's
// intervals and stretches (src/fits.js, astropy's), the interval taken over the
// whole volume so its slices compare, or the window given by hand; bytes are
// shown as they are by default.
const { createLogger } = require('./debug');
const { INTERVALS, STRETCHES, fitsLimits, fitsLevels, rgbaToPng } = require('./fits');

const log = createLogger('NRRD');
const NRRD_RE = /\.(nrrd|nhdr)$/i;
// SheetJS's bzip2 decoder (16 kB, no dependencies): sets window.bz2
const BZ2_URL = 'https://cdn.jsdelivr.net/npm/bz2@1.0.1/index.js';

const files = new Map(); // header URL -> Promise<file>
const drawn = new Map(); // header URL + view -> Promise<{ url, ... }>

function isNrrdName(name) {
    return NRRD_RE.test(name || '');
}

// Bytes that start an NRRD header: "NRRD000" and the version
function isNrrd(bytes) {
    return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 7)) === 'NRRD000';
}

// --- Header ---

// Each type's names (the first is ours), bytes per value, and typed array
const TYPES = [
    [['int8', 'signed char', 'int8_t'], 1, Int8Array],
    [['uint8', 'uchar', 'unsigned char', 'uint8_t'], 1, Uint8Array],
    [['int16', 'short', 'short int', 'signed short', 'signed short int', 'int16_t'], 2, Int16Array],
    [['uint16', 'ushort', 'unsigned short', 'unsigned short int', 'uint16_t'], 2, Uint16Array],
    [['int32', 'int', 'signed int', 'int32_t'], 4, Int32Array],
    [['uint32', 'uint', 'unsigned int', 'uint32_t'], 4, Uint32Array],
    [['int64', 'longlong', 'long long', 'long long int', 'signed long long', 'signed long long int', 'int64_t'], 8, BigInt64Array],
    [['uint64', 'ulonglong', 'unsigned long long', 'unsigned long long int', 'uint64_t'], 8, BigUint64Array],
    [['float'], 4, Float32Array],
    [['double'], 8, Float64Array],
];
const TYPE_BY_NAME = new Map();
for (const [names, size, Array] of TYPES) for (const n of names) TYPE_BY_NAME.set(n, { name: names[0], size, Array });
// The values an integer type holds (bytes are shown as they are)
const TYPE_RANGE = { int8: [-128, 127], uint8: [0, 255], int16: [-32768, 32767], uint16: [0, 65535],
    int32: [-2147483648, 2147483647], uint32: [0, 4294967295], int64: [-(2 ** 63), 2 ** 63], uint64: [0, 2 ** 64] };
const ENCODINGS = { raw: 'raw', txt: 'ascii', text: 'ascii', ascii: 'ascii', hex: 'hex', gz: 'gzip', gzip: 'gzip', bz2: 'bzip2', bzip2: 'bzip2' };
// Field names of old (and Teem's other) spellings
const ALIASES = { datafile: 'data file', lineskip: 'line skip', byteskip: 'byte skip', centerings: 'centers', 'axismins': 'axis mins', 'axismaxs': 'axis maxs' };

// Where the header ends in an .nrrd: { end (of the header text), data (where the data starts) },
// at the first empty line; the whole file for a detached header without one
function headerEnd(bytes) {
    for (let i = 0; i < bytes.length - 1; i++) {
        if (bytes[i] !== 0x0a) continue;
        if (bytes[i + 1] === 0x0a) return { end: i, data: i + 2 };
        if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) return { end: i, data: i + 3 };
    }
    return { end: bytes.length, data: bytes.length };
}

// The header's text: { version, fields: { name: value }, keys: [[key, value]], lines (after
// "data file: LIST", the files' names), text }
function parseHeader(text) {
    const lines = text.split(/\r?\n/);
    const magic = lines[0].trim();
    if (!/^NRRD000\d$/.test(magic)) throw new Error('not an NRRD header (no NRRD000x magic)');
    const fields = {}, keys = [];
    let list = null;
    for (const line of lines.slice(1)) {
        if (list) { if (line.trim()) list.push(line.trim()); continue; }
        if (!line.trim() || line.startsWith('#')) continue;
        const kv = line.indexOf(':=');
        const f = line.indexOf(': ');
        if (kv >= 0 && (f < 0 || kv < f)) { keys.push([line.slice(0, kv), line.slice(kv + 2)]); continue; }
        if (f < 0) throw new Error(`a header line is no field: "${line}"`);
        let name = line.slice(0, f).trim().toLowerCase();
        name = ALIASES[name.replace(/ /g, '')] || name;
        fields[name] = line.slice(f + 2).trim();
        if (name === 'data file' && /^LIST(\s|$)/.test(fields[name])) list = [];
    }
    return { version: Number(magic.slice(7)), fields, keys, lines: list, text };
}

// sprintf of one integer as a data file's format has it (%d, %03d, %5i, %u...)
function formatName(format, n) {
    return format.replace(/%(0?)(\d*)[diu]/, (_, zero, width) => {
        const s = String(Math.abs(n));
        const pad = Math.max(0, Number(width || 0) - s.length - (n < 0 ? 1 : 0));
        return n < 0 ? (zero ? '-' + '0'.repeat(pad) + s : ' '.repeat(pad) + '-' + s) : (zero ? '0' : ' ').repeat(pad) + s;
    }).replace(/%%/g, '%');
}

// The data files a header names (none: the data is in the file after it)
function dataFileNames(h) {
    const v = h.fields['data file'];
    if (!v) return [];
    if (/^LIST(\s|$)/.test(v)) return h.lines || [];
    const t = v.split(/\s+/);
    if (t.length >= 4 && t.length <= 5 && t[0].includes('%') && t.slice(1, 4).every(x => /^-?\d+$/.test(x))) {
        const [min, max, step] = t.slice(1, 4).map(Number);
        if (!step) throw new Error('data file: a step of 0');
        const names = [];
        for (let i = min; step > 0 ? i <= max : i >= max; i += step) names.push(formatName(t[0], i));
        return names;
    }
    return [v];
}

// What the header says of the data and its axes
function describe(h) {
    const f = h.fields;
    const type = TYPE_BY_NAME.get((f.type || '').toLowerCase());
    if (!type) throw new Error(f.type === 'block' ? 'the "block" type holds no numbers to show' : `unknown type "${f.type}"`);
    const dim = Number(f.dimension);
    const sizes = (f.sizes || '').split(/\s+/).filter(Boolean).map(Number);
    if (!dim || sizes.length !== dim || sizes.some(s => !(s >= 1))) throw new Error(`sizes "${f.sizes}" are not ${dim} sizes`);
    const encoding = ENCODINGS[(f.encoding || '').toLowerCase()];
    if (!encoding) throw new Error(`encoding "${f.encoding}" is not read here`);
    const words = v => (v || '').split(/\s+/).filter(Boolean);
    const kinds = words(f.kinds).map(k => k.toLowerCase());
    const labels = [...(f.labels || '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
    // space directions: a vector per axis, or none
    const dirs = f['space directions'] ? (f['space directions'].match(/\([^)]*\)|none/g) || []).map(d => (d === 'none' ? null : d.slice(1, -1).split(',').map(Number))) : [];
    const axes = sizes.map((size, i) => ({ size, kind: kinds[i] || '', label: labels[i] || '', dir: dirs[i] || null }));
    // the byte order matters for raw, gzip... data of more than a byte, as Teem has it
    if (!f.endian && type.size > 1 && encoding !== 'ascii') throw new Error('no "endian" field: the byte order of the data is not known');
    const byteSkip = Number(f['byte skip'] || 0);
    if (!(byteSkip >= -1)) throw new Error(`byte skip: ${f['byte skip']} (it is -1, 0 or more)`);
    return {
        type, dim, sizes, axes, encoding, byteSkip,
        endian: (f.endian || 'little').toLowerCase(),
        lineSkip: Number(f['line skip'] || 0),
        space: (f.space || '').toLowerCase(),
        count: sizes.reduce((a, b) => a * b, 1),
    };
}

// --- Data ---

async function gunzip(bytes) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks = [];
    let n = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            n += value.length;
        }
    } catch (err) {
        // bytes after the gzip stream (padding, a NIfTI's tail...): what came before is the data
        if (!n) throw err;
    }
    const out = new Uint8Array(n);
    for (let i = 0, o = 0; i < chunks.length; o += chunks[i].length, i++) out.set(chunks[i], o);
    return out;
}

let bz2Promise = null;
function bunzip(bytes) {
    if (!bz2Promise) {
        bz2Promise = (typeof window !== 'undefined' && window.bz2) ? Promise.resolve(window.bz2) : new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = BZ2_URL;
            s.onload = () => (window.bz2 ? resolve(window.bz2) : reject(new Error('bz2 did not load')));
            s.onerror = () => reject(new Error('Could not load ' + BZ2_URL));
            document.head.appendChild(s);
        });
        bz2Promise.catch(() => { bz2Promise = null; });
    }
    return bz2Promise.then(bz2 => bz2.decompress(bytes));
}

// The bytes after `lines` lines
function skipLines(bytes, lines) {
    let at = 0;
    for (let l = 0; l < lines; l++) {
        const nl = bytes.indexOf(0x0a, at);
        if (nl < 0) throw new Error(`line skip: ${lines}, but the file has ${l} lines`);
        at = nl + 1;
    }
    return bytes.subarray(at);
}

// One file's (or the .nrrd's) part of the data, `count` values: bytes of the
// type (raw, hex, gzip, bzip2) or numbers (ascii)
async function decodePart(bytes, d, count, unzip = { gunzip, bunzip }) {
    let b = skipLines(bytes, d.lineSkip);
    const need = count * d.type.size;
    if (d.encoding === 'gzip' || d.encoding === 'bzip2') b = await (d.encoding === 'gzip' ? unzip.gunzip : unzip.bunzip)(b);
    if (d.byteSkip === -1) {
        if (d.encoding === 'ascii' || d.encoding === 'hex') throw new Error('byte skip: -1 is for binary data only');
        if (b.length < need) throw new Error(`${b.length} bytes of data, ${need} wanted`);
        b = b.subarray(b.length - need);
    } else if (d.byteSkip > 0) b = b.subarray(d.byteSkip);
    if (d.encoding === 'ascii') {
        const text = new TextDecoder('latin1').decode(b);
        const out = new Float64Array(count);
        const re = /[^\s,]+/g;
        let m, i = 0;
        while (i < count && (m = re.exec(text))) out[i++] = Number(m[0]);
        if (i < count) throw new Error(`${i} numbers in the text, ${count} wanted`);
        return out;
    }
    if (d.encoding === 'hex') {
        const out = new Uint8Array(need);
        let i = 0, hi = -1;
        for (let k = 0; k < b.length && i < need; k++) {
            const c = b[k];
            const v = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;
            if (v < 0) continue;
            if (hi < 0) hi = v; else { out[i++] = hi * 16 + v; hi = -1; }
        }
        if (i < need) throw new Error(`${i} bytes of hex data, ${need} wanted`);
        return out;
    }
    if (b.length < need) throw new Error(`${b.length} bytes of data, ${need} wanted`);
    return b.subarray(0, need);
}

// The values, in file order (the first axis fastest): a typed array of the type
// (64-bit integers as doubles), little-endian or big-endian bytes swapped
function toValues(parts, d) {
    if (parts[0] instanceof Float64Array) {
        // ascii: the numbers as they were written
        const out = new Float64Array(d.count);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }
    const bytes = new Uint8Array(d.count * d.type.size);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    const size = d.type.size;
    const little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (size > 1 && (d.endian === 'big') === little) {
        for (let i = 0; i < bytes.length; i += size) {
            for (let a = i, z = i + size - 1; a < z; a++, z--) { const t = bytes[a]; bytes[a] = bytes[z]; bytes[z] = t; }
        }
    }
    const typed = new d.type.Array(bytes.buffer);
    if (size === 8 && !(typed instanceof Float64Array)) return Float64Array.from(typed, Number);
    return typed;
}

// The whole file: { header, d (describe's), values, view helpers }, from the
// header's bytes and a reader of the files it names (by name, relative to it)
async function readNrrd(bytes, readFile, unzip) {
    const { end, data } = headerEnd(bytes);
    const h = parseHeader(new TextDecoder('latin1').decode(bytes.subarray(0, end)));
    const d = describe(h);
    const names = dataFileNames(h);
    let parts;
    if (!names.length) {
        parts = [await decodePart(bytes.subarray(data), d, d.count, unzip)];
    } else {
        if (d.count % names.length) throw new Error(`${d.count} values do not split into ${names.length} data files`);
        const each = d.count / names.length;
        parts = await Promise.all(names.map(async n => decodePart(await readFile(n), d, each, unzip)));
    }
    return { header: h, d, names, values: toValues(parts, d) };
}

// --- Pictures of it ---

// Kinds that are no space axis
const COLOR_KINDS = new Set(['rgb-color', 'rgba-color', '3-color', '4-color']);
const NOT_SPACE = new Set(['list', 'point', 'vector', 'covariant-vector', 'normal', 'stub', 'scalar', 'complex', '2-vector',
    '3-color', 'rgb-color', 'hsv-color', 'xyz-color', '4-color', 'rgba-color', '3-vector', '3-gradient', '3-normal', '4-vector',
    'quaternion', '2d-symmetric-matrix', '2d-masked-symmetric-matrix', '2d-matrix', '2d-masked-matrix', '3d-symmetric-matrix',
    '3d-masked-symmetric-matrix', '3d-matrix', '3d-masked-matrix', 'time']);
// Anatomical spaces: the letter each space axis goes toward
const SPACES = {
    'right-anterior-superior': 'RAS', ras: 'RAS', 'left-anterior-superior': 'LAS', las: 'LAS',
    'left-posterior-superior': 'LPS', lps: 'LPS', 'right-anterior-superior-time': 'RAS', 'left-anterior-superior-time': 'LAS',
    'left-posterior-superior-time': 'LPS',
};
const OPPOSITE = { R: 'L', L: 'R', A: 'P', P: 'A', S: 'I', I: 'S' };
const PLANE = { R: 'sagittal', L: 'sagittal', A: 'coronal', P: 'coronal', S: 'axial', I: 'axial' };

// The anatomical direction an axis goes toward (R, A, S...), if its space says
function axisDirection(d, axis) {
    const letters = SPACES[d.space];
    const v = d.axes[axis].dir;
    if (!letters || !v) return '';
    let best = 0;
    for (let i = 1; i < Math.min(3, v.length); i++) if (Math.abs(v[i]) > Math.abs(v[best])) best = i;
    if (!v[best]) return '';
    return v[best] > 0 ? letters[best] : OPPOSITE[letters[best]];
}

function axisName(d, axis) {
    const a = d.axes[axis];
    const dir = axisDirection(d, axis);
    return `axis ${axis}` + (a.label ? ` "${a.label}"` : '') + (dir ? ` (${dir}, ${PLANE[dir]} slices)` : a.kind && a.kind !== 'domain' && a.kind !== 'space' ? ` (${a.kind})` : '');
}

// The axis holding a pixel's color, or -1
function colorAxis(d) {
    const i = d.axes.findIndex(a => COLOR_KINDS.has(a.kind) && (a.size === 3 || a.size === 4));
    if (i >= 0) return i;
    // ITK writes an RGB(A) image's color as a vector of bytes, as 3D Slicer shows it
    if (d.type.name === 'uint8' && /vector$/.test((d.axes[0] || {}).kind) && (d.axes[0].size === 3 || d.axes[0].size === 4)) return 0;
    return -1;
}

// The axes a slice can be cut across (or across which pages turn): the space
// axes longer than 1 (any axis longer than 1, if fewer than two are)
function spaceAxes(d) {
    const color = colorAxis(d);
    const long = d.axes.map((a, i) => i).filter(i => i !== color && d.axes[i].size > 1);
    const space = long.filter(i => !NOT_SPACE.has(d.axes[i].kind));
    return space.length >= 2 ? space : long;
}

// How the file is shown with its slices cut across axis `slice` (default: the
// last space axis of three or more): { x, y, color, pageAxes (the slice's axis
// first), pages, first (the middle slice), slices: the axes it can be cut across }
function nrrdView(d, slice = -1) {
    const space = spaceAxes(d);
    const color = colorAxis(d);
    if (space.length < 2) throw new Error(`${space.length ? 'a 1-D' : 'an'} NRRD of ${d.sizes.join('×')} values is no picture`);
    const cuts = space.length >= 3 ? space : [];
    if (!cuts.includes(slice)) slice = cuts.length ? cuts[cuts.length - 1] : -1;
    const [x, y] = space.filter(i => i !== slice);
    const pageAxes = d.axes.map((a, i) => i).filter(i => i !== x && i !== y && i !== color && d.axes[i].size > 1);
    if (slice >= 0) pageAxes.sort((a, b) => (b === slice) - (a === slice));
    const pages = pageAxes.reduce((n, i) => n * d.sizes[i], 1);
    const first = slice >= 0 ? Math.floor(d.sizes[slice] / 2) : 0;
    return { x, y, color, slice, pageAxes, pages, first, slices: cuts, width: d.sizes[x], height: d.sizes[y] };
}

// Strides of the axes (the first fastest)
function strides(d) {
    const s = [];
    let n = 1;
    for (const size of d.sizes) { s.push(n); n *= size; }
    return s;
}

// The position of page `page` along each page axis (the first fastest)
function pagePosition(d, v, page) {
    const pos = {};
    for (const a of v.pageAxes) { pos[a] = page % d.sizes[a]; page = Math.floor(page / d.sizes[a]); }
    return pos;
}

function pageLabel(d, v, page) {
    const pos = pagePosition(d, v, page);
    return v.pageAxes.map(a => `${axisName(d, a)}: ${pos[a] + 1} of ${d.sizes[a]}`).join(', ') || `${v.width}×${v.height}`;
}

// The values of one page's channel `c` (of the color axis), row by row
function pageChannel(file, v, page, c = 0) {
    const { d, values } = file;
    const st = strides(d);
    const pos = pagePosition(d, v, page);
    let base = 0;
    for (const a of v.pageAxes) base += pos[a] * st[a];
    if (v.color >= 0) base += c * st[v.color];
    const out = new Float64Array(v.width * v.height);
    const sx = st[v.x], sy = st[v.y];
    for (let y = 0, o = 0; y < v.height; y++) {
        for (let x = 0, i = base + y * sy; x < v.width; x++, i += sx) out[o++] = values[i];
    }
    return out;
}

// Up to a million of the values of the whole file (no alpha), for an interval
// the slices share
function volumeSample(file, v) {
    const { d, values } = file;
    const st = strides(d);
    const step = Math.max(1, Math.floor(values.length / 1e6));
    const alpha = v.color >= 0 && d.sizes[v.color] === 4 ? 3 : -1;
    const out = [];
    for (let i = 0; i < values.length; i += step) {
        if (alpha >= 0 && Math.floor(i / st[v.color]) % 4 === alpha) continue;
        out.push(values[i]);
    }
    return Float64Array.from(out);
}

// [vmin, vmax] of an interval: FITS's (zscale, min/max, 99.5%, 99%) over the
// whole volume, the type's range ('type'), or [min, max] given by hand
function nrrdLimits(file, v, interval) {
    if (Array.isArray(interval)) return interval;
    const key = `${v.color}#${interval}`;
    file.limits = file.limits || new Map();
    if (!file.limits.has(key)) {
        file.limits.set(key, interval === 'type' && TYPE_RANGE[file.d.type.name]
            ? TYPE_RANGE[file.d.type.name] : fitsLimits(volumeSample(file, v), interval === 'type' ? 'minmax' : interval));
    }
    return file.limits.get(key);
}

// The interval a file is first shown with: bytes as they are, else 99.5% of the values
function defaultInterval(d) {
    return d.type.name === 'uint8' ? 'type' : '99.5';
}

// RGBA of a page: gray, or the color axis's red, green, blue (and alpha)
function nrrdRgba(file, v, page, interval, stretch) {
    const limits = nrrdLimits(file, v, interval);
    const n = v.color >= 0 ? file.d.sizes[v.color] : 1;
    const levels = [];
    for (let c = 0; c < Math.min(n, 3); c++) levels.push(fitsLevels(pageChannel(file, v, page, c), limits, stretch));
    let alpha = null;
    if (n === 4) {
        // alpha: of the type's range for integers, 0 to 1 for floats
        const a = pageChannel(file, v, page, 3);
        const [lo, hi] = TYPE_RANGE[file.d.type.name] ? [Math.max(0, TYPE_RANGE[file.d.type.name][0]), TYPE_RANGE[file.d.type.name][1]] : [0, 1];
        alpha = fitsLevels(a, [lo, hi], 'linear');
    }
    const out = new Uint8ClampedArray(v.width * v.height * 4);
    for (let i = 0, o = 0; i < v.width * v.height; i++, o += 4) {
        const r = levels[0][i], g = levels[levels.length > 1 ? 1 : 0][i], b = levels[levels.length > 2 ? 2 : 0][i];
        out[o] = Math.max(r, 0);
        out[o + 1] = Math.max(g, 0);
        out[o + 2] = Math.max(b, 0);
        out[o + 3] = r < 0 && g < 0 && b < 0 ? 0 : alpha ? Math.max(alpha[i], 0) : 255;
    }
    return out;
}

// --- In the browser ---

// The path of a file named in the header at url (a /workspace-file URL), relative to the header
function siblingUrl(url, name) {
    const u = new URL(url, location.href);
    const path = /\/workspace-file$/.test(u.pathname) && u.searchParams.get('path');
    if (!path) throw new Error(`the data file "${name}" is beside the header, which has no path here`);
    const parts = name.startsWith('/') ? [] : path.split('/').slice(0, -1).filter(Boolean);
    for (const p of name.split('/')) {
        if (p === '..') parts.pop();
        else if (p && p !== '.') parts.push(p);
    }
    return '/workspace-file?path=' + encodeURIComponent((name.startsWith('/') || path.startsWith('/') ? '/' : '') + parts.join('/'));
}

async function fetchBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

function nrrdFile(url) {
    let p = files.get(url);
    if (!p) {
        p = (async () => {
            const { resolveFileUrl } = require('./archive-fallback');
            return readNrrd(await fetchBytes(url), async name => {
                try {
                    return await fetchBytes(await resolveFileUrl(siblingUrl(url, name)));
                } catch (err) {
                    throw new Error(`data file ${name}: ${err.message}`);
                }
            });
        })();
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: another slice or window reads the values again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// A page of the NRRD file at url, drawn: { url (a blob: URL of its PNG), page,
// pages, label, width, height, view, limits }. page null: the middle slice;
// opts: slice (the axis cut across), interval (or [min, max]), stretch
function nrrdPage(url, page = null, opts = {}) {
    const key = `${url}#${page}#${opts.slice}#${opts.interval}#${opts.stretch}`;
    let p = drawn.get(key);
    if (!p) {
        p = (async () => {
            const file = await nrrdFile(url);
            const v = nrrdView(file.d, opts.slice === undefined ? -1 : opts.slice);
            const n = page === null ? v.first : Math.max(0, Math.min(v.pages - 1, page));
            const interval = opts.interval || defaultInterval(file.d);
            const png = await rgbaToPng(nrrdRgba(file, v, n, interval, opts.stretch || 'linear'), v.width, v.height);
            return { url: URL.createObjectURL(png), page: n, pages: v.pages, label: pageLabel(file.d, v, n),
                width: v.width, height: v.height, view: v, limits: nrrdLimits(file, v, interval) };
        })();
        drawn.set(key, p);
        p.catch(err => { drawn.delete(key); log.warn('NRRD decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (drawn.size > 64) {
            const [oldKey, old] = drawn.entries().next().value;
            drawn.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the NRRD file at url (root is the viewer's
// element, positioned): page buttons, the axis slices are cut across, the
// interval (or a window typed in) and the stretch; the header in a panel that opens
function addNrrdControls(root, img, url) {
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
    const prev = button('‹', 'Previous slice');
    const info = document.createElement('span');
    const next = button('›', 'Next slice');
    const across = select([], 'The axis slices are cut across');
    const interval = select([['type', "type's range"], ...INTERVALS, ['custom', 'window']], 'Interval: the values shown black to white (over the whole volume)');
    const lo = number('Shown black (and below)');
    const hi = number('Shown white (and above)');
    const stretch = select(STRETCHES, 'Stretch');
    bar.append(prev, info, next, across, interval, lo, hi, stretch);

    const header = document.createElement('details');
    header.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1;max-width:calc(100% - 16px);'
        + 'background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const summary = document.createElement('summary');
    summary.textContent = 'Header';
    summary.style.cssText = 'cursor:pointer;';
    const text = document.createElement('div');
    text.style.cssText = 'max-height:60vh;overflow:auto;margin-top:4px;font:12px monospace;white-space:pre;user-select:text;';
    header.append(summary, text);

    let page = null, pages = 0, turn = 0;
    const opts = () => ({
        slice: across.options.length ? Number(across.value) : undefined,
        interval: interval.value === 'custom' ? [Number(lo.value), Number(hi.value)] : interval.value,
        stretch: stretch.value,
    });
    const show = async n => {
        const mine = ++turn;
        try {
            const d = await nrrdPage(url, n, opts());
            if (mine !== turn) return;
            img.src = d.url;
            page = d.page;
            pages = d.pages;
            info.textContent = `${page + 1} / ${pages}`;
            info.title = `${d.label}, ${d.width}×${d.height}`;
            img.title = info.title;
            prev.hidden = next.hidden = info.hidden = pages < 2;
            prev.disabled = page === 0;
            next.disabled = page === pages - 1;
            if (interval.value !== 'custom') {
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
    // another axis: its middle slice
    across.onchange = () => show(null);
    interval.onchange = () => show(page);
    lo.onchange = hi.onchange = () => { interval.value = 'custom'; show(page); };
    stretch.onchange = () => show(page);
    root.tabIndex = root.tabIndex >= 0 ? root.tabIndex : 0;
    root.addEventListener('keydown', e => {
        if (e.target.closest && e.target.closest('select, input, details')) return;
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { show(page + 1); e.preventDefault(); }
        else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { show(page - 1); e.preventDefault(); }
    });
    nrrdFile(url).then(file => {
        const v = nrrdView(file.d);
        for (const a of v.slices) across.add(new Option(`across ${axisName(file.d, a)}`, a));
        across.value = v.slice;
        across.hidden = !v.slices.length;
        if (!TYPE_RANGE[file.d.type.name]) interval.remove(0);
        interval.value = defaultInterval(file.d);
        text.textContent = file.header.text;
        summary.textContent = `Header (${file.d.type.name}, ${file.d.sizes.join('×')}, ${file.d.encoding}${file.names.length ? `, ${file.names.length} data file${file.names.length > 1 ? 's' : ''}` : ''})`;
        show(null);
    }).catch(err => { info.textContent = err.message; });
    root.append(bar, header);
    return bar;
}

module.exports = {
    isNrrdName, isNrrd, parseHeader, dataFileNames, describe, readNrrd, nrrdView, pageChannel, nrrdLimits, nrrdRgba,
    nrrdFile, nrrdPage, addNrrdControls,
};
