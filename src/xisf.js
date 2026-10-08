// --- XISF, PixInsight's Extensible Image Serialization Format (.xisf; .xish, a distributed header) ---
// pixinsight.com/doc/docs/XISF-1.0-spec: a monolithic file is "XISF0100", the
// header's length (a little-endian uint32), four reserved bytes, an XML header
// and the data blocks it points to ("attachment:position:size"); a distributed
// unit's header is an .xish of XML alone, its blocks in files beside it
// ("path(@header_dir/name)", an .xisb's block index too: "path(...):0xid").
// Read here: every Image element (each one's channels and slices are pages),
// UInt8 to UInt64, Float32 and Float64, Complex32 and Complex64 samples
// (magnitude, real or imaginary part, phase), either byte order, the planar and
// normal pixel storages, the Gray, RGB and CIE L*a*b* color spaces (converted to
// RGB through the RGB working space, sRGB by default, as Annex B has it),
// bounds, offset and orientation, attached, embedded, inline and external
// blocks, and the zlib (the browser's DecompressionStream), lz4 and lz4hc
// (lz4js) and zstd (fzstd) compressions, with byte shuffling and subblocks;
// lz4js and fzstd come from esm.sh when one is met. No browser shows it: a
// page is drawn to a PNG for the image viewer, the preview and the thumbnails.
// The window is the image's bounds, the display function stored with it
// (PixInsight's screen transfer function), FITS's intervals and stretches
// (src/fits.js) taken over all channels, or typed in; by default the display
// function, else the bounds for data that fill them, else zscale. The FITS keywords and
// properties, the file's too, are in a panel that opens. The ICC profile and
// the thumbnail are left alone.
const { createLogger } = require('./debug');
const { INTERVALS, STRETCHES, fitsLimits, fitsLevels, rgbaToPng } = require('./fits');

const log = createLogger('XISF');
const XISF_RE = /\.(xisf|xish)$/i;
// fzstd (8 kB, sets window.fzstd), as src/archive-fallback.js loads it
const FZSTD_URL = 'https://esm.sh/fzstd@0.1.1/umd/index.js?raw';
// lz4js (an ES module of decompressBlock...)
const LZ4_URL = 'https://esm.sh/lz4js@0.2.0';
const files = new Map(); // URL -> Promise<file>
const drawn = new Map(); // URL + view -> Promise<{ url, ... }>

function isXisfName(name) {
    return XISF_RE.test(name || '');
}

// Bytes that start a monolithic XISF file
function isXisf(bytes) {
    return bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 8)) === 'XISF0100';
}

// --- Header ---

// The element's children named `name`, those a child Reference points to included
function childrenNamed(el, name, uids) {
    const out = [];
    for (const c of el.children) {
        if (c.localName === name) out.push(c);
        else if (c.localName === 'Reference') {
            const target = uids.get(c.getAttribute('ref'));
            if (target && target.localName === name) out.push(target);
        }
    }
    return out;
}

// "a:b:c" as numbers
function numbers(s) {
    return String(s || '').split(':').map(Number);
}

// A location attribute: { kind: 'attachment', pos, size } | { kind: 'inline'|'embedded', encoding }
// | { kind: 'path'|'url', target, id (an .xisb's block, a BigInt) }
function parseLocation(s) {
    s = String(s || '').trim();
    let m = /^attachment:(\d+):(\d+)$/.exec(s);
    if (m) return { kind: 'attachment', pos: Number(m[1]), size: Number(m[2]) };
    m = /^inline:(base64|hex)$/.exec(s);
    if (m) return { kind: 'inline', encoding: m[1] };
    if (s === 'embedded') return { kind: 'embedded' };
    // the target may hold parentheses: to the last ')'
    m = /^(path|url)\((.*)\)(?::(0x[0-9a-fA-F]+|\d+))?$/.exec(s);
    if (m) return { kind: m[1], target: m[2], id: m[3] === undefined ? null : BigInt(m[3]) };
    throw new Error(`location "${s}" is not read here`);
}

// A compression attribute (and subblocks): { codec ('zlib', 'lz4', 'lz4hc', 'zstd'),
// shuffle, size (uncompressed), itemSize, subblocks ([[compressed, uncompressed]...] or null) }
function parseCompression(s, subblocks) {
    if (!s) return null;
    const [name, size, itemSize] = s.split(':');
    const codec = name.replace(/\+sh$/, '');
    if (!['zlib', 'lz4', 'lz4hc', 'zstd'].includes(codec)) throw new Error(`compression "${name}" is not read here`);
    return {
        name, codec, shuffle: name.endsWith('+sh'), size: Number(size), itemSize: Number(itemSize) || 1,
        subblocks: subblocks ? subblocks.split(':').map(p => p.split(',').map(Number)) : null,
    };
}

// Each sampleFormat's bytes per value, components (two for complex), typed array and DataView getter
const FORMATS = {
    UInt8: { name: 'UInt8', size: 1, comps: 1, Array: Uint8Array, get: 'getUint8', bits: 8 },
    UInt16: { name: 'UInt16', size: 2, comps: 1, Array: Uint16Array, get: 'getUint16', bits: 16 },
    UInt32: { name: 'UInt32', size: 4, comps: 1, Array: Uint32Array, get: 'getUint32', bits: 32 },
    // as doubles: exact to 2^53
    UInt64: { name: 'UInt64', size: 8, comps: 1, Array: Float64Array, get: 'getBigUint64', bits: 64 },
    Float32: { name: 'Float32', size: 4, comps: 1, Array: Float32Array, get: 'getFloat32' },
    Float64: { name: 'Float64', size: 8, comps: 1, Array: Float64Array, get: 'getFloat64' },
    Complex32: { name: 'Complex32', size: 8, comps: 2, Array: Float32Array, get: 'getFloat32' },
    Complex64: { name: 'Complex64', size: 16, comps: 2, Array: Float64Array, get: 'getFloat64' },
};
// Older names
FORMATS.Byte = FORMATS.UInt8;
FORMATS.UShort = FORMATS.UInt16;
FORMATS.UInt = FORMATS.UInt32;
FORMATS.Float = FORMATS.Float32;
FORMATS.Double = FORMATS.Float64;

// sRGB relative to D50, the RGB working space when none is given
const SRGB = { x: [0.648431, 0.321152, 0.155886], y: [0.330856, 0.597871, 0.066044], Y: [0.222491, 0.716888, 0.060621], gamma: 'srgb' };

// What an Image element says of the image (n: its index)
function describeImage(el, n, uids) {
    const attr = k => el.getAttribute(k);
    const geometry = numbers(attr('geometry'));
    if (geometry.length < 2 || geometry.some(v => !(Number.isInteger(v) && v > 0))) throw new Error(`geometry "${attr('geometry')}" is no image's`);
    const channels = geometry.pop();
    const dims = geometry;
    const format = FORMATS[attr('sampleFormat')];
    if (!format) throw new Error(`sampleFormat "${attr('sampleFormat')}" is not read here`);
    const colorSpace = attr('colorSpace') || 'Gray';
    if (!['Gray', 'RGB', 'CIELab'].includes(colorSpace)) throw new Error(`colorSpace "${colorSpace}" is not read here`);
    const pixelStorage = attr('pixelStorage') || 'Planar';
    if (!['Planar', 'Normal'].includes(pixelStorage)) throw new Error(`pixelStorage "${pixelStorage}" is not read here`);
    const byteOrder = attr('byteOrder') || 'little';
    // the representable range: given, else the integer type's, else [0, 1]
    let bounds = attr('bounds') ? numbers(attr('bounds')) : null;
    if (!bounds || bounds.length !== 2 || !bounds.every(Number.isFinite)) bounds = format.bits ? [0, 2 ** format.bits - 1] : [0, 1];
    // embedded: the block (and its compression) in a child Data element
    const data = childrenNamed(el, 'Data', uids)[0] || null;
    const location = parseLocation(attr('location'));
    const blockEl = location.kind === 'embedded' ? data : el;
    if (!blockEl) throw new Error('location "embedded", but no Data element');
    // the stored display function: [m, s, h, l, r], each [R, G, B, L]
    const dfEl = childrenNamed(el, 'DisplayFunction', uids)[0];
    const df = dfEl ? ['m', 's', 'h', 'l', 'r'].map(k => numbers(dfEl.getAttribute(k))) : null;
    const wsEl = childrenNamed(el, 'RGBWorkingSpace', uids)[0];
    const ws = wsEl ? {
        x: numbers(wsEl.getAttribute('x')), y: numbers(wsEl.getAttribute('y')), Y: numbers(wsEl.getAttribute('Y')),
        gamma: /^srgb$/i.test(wsEl.getAttribute('gamma')) ? 'srgb' : Number(wsEl.getAttribute('gamma')), name: wsEl.getAttribute('name'),
    } : SRGB;
    const width = dims[0], height = dims[1] || 1;
    return {
        n, el, id: attr('id'), dims, width, height, depth: dims.slice(2).reduce((a, b) => a * b, 1), channels, format, colorSpace,
        nominal: colorSpace === 'Gray' ? 1 : 3, pixelStorage, little: byteOrder !== 'big', byteOrder, bounds,
        location, blockEl, compression: parseCompression(blockEl.getAttribute('compression'), blockEl.getAttribute('subblocks')),
        offset: Number(attr('offset')) || 0, orientation: attr('orientation') || '0', imageType: attr('imageType'),
        df, ws, attrs: [...el.attributes].map(a => [a.name, a.value]),
        fits: childrenNamed(el, 'FITSKeyword', uids).map(k => ({ name: k.getAttribute('name'), value: k.getAttribute('value'), comment: k.getAttribute('comment') })),
        props: childrenNamed(el, 'Property', uids).map(property),
    };
}

// A Property element: { id, type, value (as written, or what it holds) }
function property(p) {
    const type = p.getAttribute('type') || '';
    let value = p.getAttribute('value');
    if (value === null) {
        if (p.getAttribute('location') && !/^String$/.test(type)) {
            const dims = p.getAttribute('length') || [p.getAttribute('rows'), p.getAttribute('columns')].filter(Boolean).join('×');
            value = `(${dims ? dims + ' values, ' : ''}${p.getAttribute('location').replace(/:.*/, '')} block)`;
        } else value = p.textContent;
    }
    return { id: p.getAttribute('id'), type, value, comment: p.getAttribute('comment') };
}

// The header's XML: { images, meta (the file's properties), xml }
function parseHeader(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'xisf') {
        const err = doc.getElementsByTagName('parsererror')[0];
        throw new Error(err ? `the header is no XML: ${err.textContent.trim().split('\n')[0]}` : 'the header has no xisf root element');
    }
    // elements with a uid, for Reference elements to point to
    const uids = new Map();
    for (const e of root.getElementsByTagName('*')) if (e.getAttribute('uid')) uids.set(e.getAttribute('uid'), e);
    const images = [...root.children].filter(c => c.localName === 'Image').map((el, n) => describeImage(el, n, uids));
    if (!images.length) throw new Error('the file holds no image');
    const meta = [...root.children].filter(c => c.localName === 'Metadata').flatMap(m => childrenNamed(m, 'Property', uids).map(property));
    // properties of the unit (children of the root)
    meta.push(...childrenNamed(root, 'Property', uids).map(property));
    return { images, meta, version: root.getAttribute('version'), xml };
}

// --- Data blocks ---

function decodeText(text, encoding) {
    const s = text.replace(/\s+/g, '');
    if (encoding === 'hex') {
        const out = new Uint8Array(s.length >> 1);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16);
        return out;
    }
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// Block `id` of an .xisb data blocks file: its bytes (and uncompressed length)
function xisbBlock(bytes, id, name) {
    if (String.fromCharCode(...bytes.subarray(0, 8)) !== 'XISB0100') throw new Error(`${name} is no XISF data blocks file`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // the block index: nodes of 40-byte elements, linked from byte 16
    for (let node = 16, hops = 0; node && hops < 1e5; hops++) {
        const count = dv.getUint32(node, true);
        for (let k = 0, e = node + 16; k < count; k++, e += 40) {
            if (dv.getBigUint64(e, true) !== id) continue;
            const pos = Number(dv.getBigUint64(e + 8, true)), len = Number(dv.getBigUint64(e + 16, true));
            if (!pos) throw new Error(`block 0x${id.toString(16)} of ${name} is free`);
            return bytes.subarray(pos, pos + len);
        }
        node = Number(dv.getBigUint64(node + 8, true));
    }
    throw new Error(`${name} has no block 0x${id.toString(16)}`);
}

let lz4Promise = null;
function lz4() {
    if (!lz4Promise) {
        lz4Promise = import(LZ4_URL).then(m => (m.decompressBlock ? m : m.default));
        lz4Promise.catch(() => { lz4Promise = null; });
    }
    return lz4Promise;
}

let zstdPromise = null;
function zstd() {
    if (!zstdPromise) {
        zstdPromise = window.fzstd ? Promise.resolve(window.fzstd) : new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = FZSTD_URL;
            s.onload = () => (window.fzstd ? resolve(window.fzstd) : reject(new Error('fzstd did not load')));
            s.onerror = () => reject(new Error('Could not load ' + FZSTD_URL));
            document.head.appendChild(s);
        });
        zstdPromise.catch(() => { zstdPromise = null; });
    }
    return zstdPromise;
}

async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The reverse of byte shuffling: the items' first bytes, then their second
// bytes...; the bytes after the last whole item as they are
function unshuffle(data, itemSize) {
    if (itemSize < 2) return data;
    const out = new Uint8Array(data.length);
    const n = Math.floor(data.length / itemSize);
    for (let j = 0; j < itemSize; j++) {
        const from = j * n;
        for (let i = 0, o = j; i < n; i++, o += itemSize) out[o] = data[from + i];
    }
    out.set(data.subarray(n * itemSize), n * itemSize);
    return out;
}

// A compressed block's bytes: its subblocks decompressed one by one (each a zlib
// stream, an LZ4 block or a zstd frame), concatenated, then unshuffled
async function decompress(bytes, c) {
    const parts = c.subblocks || [[bytes.length, c.size]];
    const out = new Uint8Array(c.size);
    const codec = c.codec === 'zstd' ? await zstd() : c.codec.startsWith('lz4') ? await lz4() : null;
    let at = 0, o = 0;
    for (const [clen, ulen] of parts) {
        const src = bytes.subarray(at, at + clen);
        if (src.length < clen) throw new Error('the compressed block ends early');
        let got;
        if (c.codec === 'zlib') {
            const d = await inflate(src);
            out.set(d.subarray(0, Math.min(d.length, out.length - o)), o);
            got = d.length;
        } else if (c.codec === 'zstd') {
            got = codec.decompress(src, out.subarray(o, o + ulen)).length;
        } else {
            got = codec.decompressBlock(src, out, 0, src.length, o) - o;
        }
        if (got !== ulen) throw new Error(`a ${c.name} block decompresses to ${got} bytes, not ${ulen}`);
        at += clen;
        o += ulen;
    }
    if (o !== c.size) throw new Error(`a ${c.name} block decompresses to ${o} bytes, not ${c.size}`);
    return c.shuffle ? unshuffle(out, c.itemSize) : out;
}

// The bytes of an image's block. fetchFile(target) fetches a file a path() or
// url() location names
async function blockBytes(bytes, img, fetchFile) {
    const loc = img.location;
    let raw;
    if (loc.kind === 'attachment') {
        if (!bytes || loc.pos + loc.size > bytes.length) throw new Error(`the block at ${loc.pos} (${loc.size} bytes) is past the file's end (${bytes ? bytes.length : 0} bytes)`);
        raw = bytes.subarray(loc.pos, loc.pos + loc.size);
    } else if (loc.kind === 'inline') raw = decodeText(img.el.textContent, loc.encoding);
    else if (loc.kind === 'embedded') raw = decodeText(img.blockEl.textContent, img.blockEl.getAttribute('encoding') || 'base64');
    else {
        const file = await fetchFile(loc.kind, loc.target);
        raw = loc.id === null ? file : xisbBlock(file, loc.id, loc.target);
    }
    return img.compression ? decompress(raw, img.compression) : raw;
}

// The image's samples, channel by channel: [channel] -> typed array of
// width × height × depth values (complex ones as real and imaginary pairs)
function readChannels(raw, img) {
    const { format, channels, pixelStorage, little } = img;
    const npix = img.width * img.height * img.depth;
    const comps = format.comps, csize = format.size / comps;
    const need = npix * channels * format.size;
    if (raw.length < need) throw new Error(`${raw.length} bytes of samples, ${need} wanted (${img.dims.join('×')}, ${channels} channel${channels > 1 ? 's' : ''}, ${format.name})`);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const out = [];
    for (let c = 0; c < channels; c++) {
        const a = new format.Array(npix * comps);
        // where channel c's values are: one plane after another, or each pixel's channels in turn
        const start = pixelStorage === 'Planar' ? c * npix * format.size : c * format.size;
        const step = pixelStorage === 'Planar' ? format.size : channels * format.size;
        if (format.size === 1) {
            for (let i = 0, o = start; i < npix; i++, o += step) a[i] = raw[o];
        } else if (format.get === 'getBigUint64') {
            for (let i = 0, o = start; i < npix; i++, o += step) a[i] = Number(dv.getBigUint64(o, little));
        } else {
            const get = dv[format.get].bind(dv);
            for (let i = 0, o = start; i < npix; i++, o += step) {
                for (let k = 0; k < comps; k++) a[i * comps + k] = get(o + k * csize, little);
            }
        }
        out.push(a);
    }
    return out;
}

// --- Color ---

// CIE L*a*b* (normalized as XISF stores it) to RGB, in [0, 1], through the RGB
// working space: Annex B's equations
function labToRgbFn(ws) {
    const { x, y, Y } = ws;
    // the RGB to XYZ matrix, and the D50 white it takes (1, 1, 1) to
    const M = [[0, 1, 2].map(k => Y[k] * x[k] / y[k]), Y.slice(), [0, 1, 2].map(k => Y[k] * (1 - x[k] - y[k]) / y[k])];
    const XW = M[0][0] + M[0][1] + M[0][2], ZW = M[2][0] + M[2][1] + M[2][2];
    // its inverse
    const [[a, b, c], [d, e, f], [g, h, i]] = M;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const inv = [[e * i - f * h, c * h - b * i, b * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, b * g - a * h, a * e - b * d]]
        .map(r => r.map(v => v / det));
    const eps = 216 / 24389, kappa = 24389 / 27;
    const g3 = t => (t * t * t > eps ? t * t * t : (116 * t - 16) / kappa);
    const delin = ws.gamma === 'srgb' ? v => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) : v => Math.pow(Math.max(v, 0), 1 / ws.gamma);
    const clip = v => Math.min(1, Math.max(0, v));
    return (L, A, B, out) => {
        const fy = (L + 0.16) / 1.16;
        const fx = fy + 50 / 29 * (A - 0.5), fz = fy - 50 / 29 * (B - 0.5);
        const X = XW * g3(fx), Yv = g3(fy), Z = ZW * g3(fz);
        for (let k = 0; k < 3; k++) out[k] = clip(delin(clip(inv[k][0] * X + inv[k][1] * Yv + inv[k][2] * Z)));
        return out;
    };
}

// --- Pictures of it ---

// The parts of a complex value one can look at
const PARTS = [['magnitude', 'magnitude'], ['real', 'real part'], ['imaginary', 'imaginary part'], ['phase', 'phase']];

// The pages of image `img`, per slice: for a color image the color picture first,
// then each channel; for a gray one each channel
function imagePages(img) {
    const pages = [];
    for (let z = 0; z < img.depth; z++) {
        if (img.nominal === 3 && img.channels >= 3) pages.push({ image: img.n, z, rgb: true });
        for (let c = 0; c < img.channels; c++) pages.push({ image: img.n, z, channel: c });
    }
    return pages;
}

// The values of channel c of slice z (its part, of complex values), row by row
function channelValues(file, img, c, z, part = 'magnitude') {
    const all = file.data[img.n][c];
    const n = img.width * img.height;
    const comps = img.format.comps;
    const band = all.subarray(z * n * comps, (z + 1) * n * comps);
    if (comps === 1) return band;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const re = band[2 * i], im = band[2 * i + 1];
        out[i] = part === 'real' ? re : part === 'imaginary' ? im : part === 'phase' ? Math.atan2(im, re) : Math.hypot(re, im);
    }
    return out;
}

// A CIE L*a*b* slice's RGB channels, in the image's bounds as the samples are
function labRgb(file, img, z) {
    const key = `${img.n}#${z}`;
    file.lab = file.lab || new Map();
    if (!file.lab.has(key)) {
        const [lo, hi] = img.bounds, range = hi - lo || 1;
        const [L, A, B] = [0, 1, 2].map(c => channelValues(file, img, c, z));
        const n = img.width * img.height;
        const out = [0, 1, 2].map(() => new Float32Array(n));
        const conv = labToRgbFn(img.ws);
        const rgb = [0, 0, 0];
        for (let i = 0; i < n; i++) {
            conv((L[i] - lo) / range, (A[i] - lo) / range, (B[i] - lo) / range, rgb);
            for (let k = 0; k < 3; k++) out[k][i] = lo + rgb[k] * range;
        }
        file.lab.set(key, out);
    }
    return file.lab.get(key);
}

// The values a page shows: [channel values] (three for a color page, in RGB)
function pageValues(file, page, part) {
    const img = file.header.images[page.image];
    if (!page.rgb) return [channelValues(file, img, page.channel, page.z, part)];
    if (img.colorSpace === 'CIELab') return labRgb(file, img, page.z);
    return [0, 1, 2].map(c => channelValues(file, img, c, page.z, part));
}

// Up to a million of the values of all nominal channels and slices of an image,
// for an interval they share
function imageSample(file, img, part) {
    const n = img.width * img.height;
    const step = Math.max(1, Math.floor(n * img.depth * img.nominal / 1e6));
    const out = [];
    for (let z = 0; z < img.depth; z++) {
        const bands = img.colorSpace === 'CIELab' ? labRgb(file, img, z) : [...Array(Math.min(img.nominal, img.channels)).keys()].map(c => channelValues(file, img, c, z, part));
        bands.forEach((v, b) => { for (let i = (z + b) % step; i < n; i += step) out.push(v[i]); });
    }
    return Float64Array.from(out);
}

// [vmin, vmax] of an interval: the bounds, FITS's (zscale, min/max, 99.5%, 99%)
// over the image's channels, or [min, max] given by hand ('df' takes the bounds)
function xisfLimits(file, img, interval, part = 'magnitude') {
    if (Array.isArray(interval)) return interval;
    if (interval === 'bounds' || interval === 'df') return img.bounds;
    const key = `${img.n}#${part}#${interval}`;
    file.limits = file.limits || new Map();
    if (!file.limits.has(key)) file.limits.set(key, fitsLimits(imageSample(file, img, part), interval));
    return file.limits.get(key);
}

// The interval an image is first shown with: its display function if it has one
// (not the identity); data that fill their bounds (a picture already stretched)
// as they are; else, linear data (a raw frame, a stack not yet stretched) in a
// sliver of its bounds, zscaled
function defaultInterval(file, img) {
    if (img.df && !img.df.every((v, k) => v.every(x => x === [0.5, 0, 1, 0, 1][k]))) return 'df';
    if (img.format.comps === 2) return '99.5';
    const [lo, hi] = xisfLimits(file, img, '99.5');
    return hi - lo >= 0.25 * (img.bounds[1] - img.bounds[0]) ? 'bounds' : 'zscale';
}

// 8-bit levels through a display function's channel k: the values normalized
// to the bounds, clipped to [s, h], the midtones transfer function of m, then
// expanded from [l, r]; -1 where NaN
function dfLevels(values, img, k) {
    const [m, s, h, l, r] = img.df.map(v => (v[k] === undefined ? v[0] : v[k]));
    const [lo, hi] = img.bounds, range = hi - lo || 1;
    const mtf = x => (x === 0 || x === 1 || m === 0.5 ? x : (m - 1) * x / ((2 * m - 1) * x - m));
    const out = new Int16Array(values.length);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isNaN(v)) { out[i] = -1; continue; }
        let x = Math.min(1, Math.max(0, (v - lo) / range));
        x = h > s ? Math.min(1, Math.max(0, (x - s) / (h - s))) : (x < s ? 0 : 1);
        x = mtf(x);
        x = r > l ? Math.min(1, Math.max(0, (x - l) / (r - l))) : x;
        out[i] = Math.round(x * 255);
    }
    return out;
}

// The page's picture turned and flipped as the image's orientation asks
function orient(rgba, w, h, orientation) {
    const [rot, flip] = String(orientation).split(';');
    const turn = { 0: 0, 90: 1, 180: 2, '-90': 3, 270: 3 }[rot.trim()] || 0;
    if (!turn && flip === undefined) return { rgba, width: w, height: h };
    const W = turn % 2 ? h : w, H = turn % 2 ? w : h;
    const src = new Uint32Array(rgba.buffer, rgba.byteOffset, w * h);
    const out = new Uint8ClampedArray(W * H * 4);
    const dst = new Uint32Array(out.buffer);
    for (let y = 0; y < H; y++) {
        for (let x0 = 0; x0 < W; x0++) {
            // the flip after the rotation: read from the mirrored column
            const x = flip !== undefined ? W - 1 - x0 : x0;
            let sx, sy;
            if (turn === 0) { sx = x; sy = y; }
            else if (turn === 1) { sx = w - 1 - y; sy = x; } // counter-clockwise
            else if (turn === 2) { sx = w - 1 - x; sy = h - 1 - y; }
            else { sx = y; sy = h - 1 - x; } // clockwise
            dst[y * W + x0] = src[sy * w + sx];
        }
    }
    return { rgba: out, width: W, height: H };
}

// RGBA of a page: gray, or a color picture (an alpha channel after the color
// ones making it see-through)
function xisfRgba(file, page, interval, stretch, part) {
    const img = file.header.images[page.image];
    const values = pageValues(file, page, part);
    const limits = xisfLimits(file, img, interval, part);
    const levels = values.map((v, b) => (interval === 'df' ? dfLevels(v, img, page.rgb ? b : Math.min(page.channel, 2)) : fitsLevels(v, limits, stretch)));
    const n = img.width * img.height;
    let alpha = null;
    if (page.rgb && img.channels > 3) {
        const [lo, hi] = img.bounds;
        alpha = fitsLevels(channelValues(file, img, 3, page.z), [lo, hi], 'linear');
    }
    const out = new Uint8ClampedArray(n * 4);
    const rgb = levels.length === 3;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        const r = levels[0][i], g = levels[rgb ? 1 : 0][i], b = levels[rgb ? 2 : 0][i];
        out[o] = Math.max(r, 0);
        out[o + 1] = Math.max(g, 0);
        out[o + 2] = Math.max(b, 0);
        // NaN: see-through
        out[o + 3] = r < 0 && g < 0 && b < 0 ? 0 : alpha ? Math.max(alpha[i], 0) : 255;
    }
    return orient(out, img.width, img.height, img.orientation);
}

// What an image is, in a few words
function summary(img) {
    const c = img.compression;
    return [img.format.name, `${img.dims.join('×')}`, `${img.channels} channel${img.channels > 1 ? 's' : ''}`, img.colorSpace,
        img.imageType || '', img.pixelStorage === 'Normal' ? 'normal storage' : '', img.byteOrder === 'big' ? 'big-endian' : '',
        c ? `${c.name}${c.subblocks ? ` (${c.subblocks.length} subblocks)` : ''}` : '',
        img.location.kind === 'attachment' ? '' : `${img.location.kind} block`,
        img.orientation !== '0' ? `orientation ${img.orientation}` : '', img.df ? 'display function' : ''].filter(Boolean).join(', ');
}

// The header for its panel: each image's attributes, FITS keywords and
// properties, then the file's properties
function headerText(header) {
    const lines = [];
    const props = list => list.map(p => `  ${p.id} (${p.type}) = ${p.value}${p.comment ? ' / ' + p.comment : ''}`);
    for (const img of header.images) {
        if (header.images.length > 1) lines.push(`--- image ${img.n + 1}${img.id ? ` (${img.id})` : ''} ---`);
        lines.push(img.attrs.map(([k, v]) => `${k}="${v}"`).join(' '));
        if (img.fits.length) {
            lines.push('', 'FITS keywords:');
            for (const k of img.fits) lines.push(`  ${(k.name || '').padEnd(8)}= ${k.value || ''}${k.comment ? ' / ' + k.comment : ''}`);
        }
        if (img.props.length) lines.push('', 'Properties:', ...props(img.props));
        if (img.df) lines.push('', 'Display function: ' + ['m', 's', 'h', 'l', 'r'].map((k, i) => `${k}=${img.df[i].join(':')}`).join(' '));
        lines.push('');
    }
    if (header.meta.length) lines.push('File properties:', ...props(header.meta));
    return lines.join('\n');
}

// --- Reading ---

// The whole file: { header, data ([image][channel] -> values), pages, text }.
// fetchFile(kind, target) fetches an external block's file
async function readXisf(bytes, fetchFile) {
    let xml, monolithic = isXisf(bytes);
    if (monolithic) {
        const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
        if (16 + len > bytes.length) throw new Error(`a header of ${len} bytes, in a file of ${bytes.length}`);
        xml = new TextDecoder().decode(bytes.subarray(16, 16 + len));
    } else {
        xml = new TextDecoder().decode(bytes);
        if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<xisf[\s>]/.test(xml)) throw new Error('not an XISF file (no XISF0100 signature, no xisf header)');
    }
    const header = parseHeader(xml);
    const data = [];
    for (const img of header.images) {
        let raw = await blockBytes(monolithic ? bytes : null, img, fetchFile);
        data.push(readChannels(raw, img));
        raw = null;
    }
    const pages = header.images.flatMap(imagePages);
    return { header, data, pages, monolithic, text: headerText(header) };
}

// --- In the browser ---

async function fetchBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

// The /workspace-file URL of a file an external block names, relative to the
// header at url for "@header_dir/..."; a url() location is fetched as it is
function blockFileUrl(url, kind, target) {
    if (kind === 'url') return target;
    const u = new URL(url, location.href);
    const path = /\/workspace-file$/.test(u.pathname) && u.searchParams.get('path');
    let name = target;
    const rel = /^@header_dir\//.test(name);
    if (rel) {
        if (!path) throw new Error(`the block file "${target}" is beside the header, which has no path here`);
        name = name.replace(/^@header_dir\//, '');
    }
    const parts = rel ? path.split('/').slice(0, -1).filter(Boolean) : [];
    for (const p of name.split('/')) {
        if (p === '..') parts.pop();
        else if (p && p !== '.') parts.push(p);
    }
    return '/workspace-file?path=' + encodeURIComponent((!rel || path.startsWith('/') ? '/' : '') + parts.join('/'));
}

function xisfFile(url) {
    let p = files.get(url);
    if (!p) {
        p = (async () => {
            const { resolveFileUrl } = require('./archive-fallback');
            const blockFiles = new Map();
            return readXisf(await fetchBytes(url), (kind, target) => {
                // several blocks in one .xisb: fetched once
                if (!blockFiles.has(target)) {
                    blockFiles.set(target, (async () => {
                        try {
                            const u = blockFileUrl(url, kind, target);
                            return await fetchBytes(kind === 'url' ? u : await resolveFileUrl(u));
                        } catch (err) {
                            throw new Error(`block file ${target}: ${err.message}`);
                        }
                    })());
                }
                return blockFiles.get(target);
            });
        })();
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: another page or window reads the values again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

function pageLabel(file, pg) {
    const imgs = file.header.images, img = imgs[pg.image];
    const names = img.colorSpace === 'CIELab' ? ['L*', 'a*', 'b*'] : img.colorSpace === 'RGB' ? ['red', 'green', 'blue'] : [];
    return [imgs.length > 1 ? `image ${pg.image + 1} of ${imgs.length}` : '',
        img.depth > 1 ? `slice ${pg.z + 1} of ${img.depth}` : '',
        pg.rgb ? (img.colorSpace === 'CIELab' ? 'CIE L*a*b* as RGB' : 'RGB')
            : img.channels > 1 ? `channel ${pg.channel + 1} of ${img.channels}${names[pg.channel] ? ` (${names[pg.channel]})` : pg.channel >= img.nominal ? ' (alpha)' : ''}` : ''].filter(Boolean).join(', ');
}

// Page `page` of the XISF file at url, drawn: { url (a blob: URL of its PNG),
// page, pages, image, label, width, height, limits, interval }. opts: interval
// (or [min, max]; default the image's own), stretch, part (of complex values)
function xisfPage(url, page = 0, opts = {}) {
    const key = `${url}#${page}#${opts.interval}#${opts.stretch}#${opts.part}`;
    let p = drawn.get(key);
    if (!p) {
        p = (async () => {
            const file = await xisfFile(url);
            const n = Math.max(0, Math.min(file.pages.length - 1, page));
            const pg = file.pages[n];
            const img = file.header.images[pg.image];
            let interval = opts.interval || defaultInterval(file, img);
            if (interval === 'df' && !img.df) interval = 'bounds';
            const part = opts.part || 'magnitude';
            const { rgba, width, height } = xisfRgba(file, pg, interval, opts.stretch || 'linear', part);
            const png = await rgbaToPng(rgba, width, height);
            return { url: URL.createObjectURL(png), page: n, pages: file.pages.length, image: img, interval,
                label: pageLabel(file, pg), width, height, limits: xisfLimits(file, img, interval, part) };
        })();
        drawn.set(key, p);
        p.catch(err => { drawn.delete(key); log.warn('XISF decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (drawn.size > 64) {
            const [oldKey, old] = drawn.entries().next().value;
            drawn.delete(oldKey);
            old.then(r => URL.revokeObjectURL(r.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the XISF file at url (root is the viewer's
// element, positioned): page buttons (images, slices, the color picture and
// channels), the part of complex values, the interval (bounds, display function,
// FITS's, or a window typed in) and the stretch; the header in a panel that opens
function addXisfControls(root, img, url) {
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
    const prev = button('‹', 'Previous page');
    const info = document.createElement('span');
    const next = button('›', 'Next page');
    const part = select(PARTS, 'The part of the complex values shown');
    const interval = select([['bounds', 'bounds'], ['df', 'display function'], ...INTERVALS, ['custom', 'window']],
        "Interval: the values shown black to white (over the image's channels); the display function is the one stored with it");
    const lo = number('Shown black (and below)');
    const hi = number('Shown white (and above)');
    const stretch = select(STRETCHES, 'Stretch');
    bar.append(prev, info, next, part, interval, lo, hi, stretch);

    const header = document.createElement('details');
    header.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1;max-width:calc(100% - 16px);'
        + 'background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const sum = document.createElement('summary');
    sum.textContent = 'Header';
    sum.style.cssText = 'cursor:pointer;';
    const text = document.createElement('div');
    text.style.cssText = 'max-height:60vh;overflow:auto;margin-top:4px;font:12px monospace;white-space:pre;user-select:text;';
    header.append(sum, text);

    let page = 0, pages = 0, turn = 0, shownImage = -1, file = null;
    // the controls an image needs: the part for complex values, the display function if stored
    const fit = im => {
        part.hidden = im.format.comps === 1;
        interval.querySelector('option[value="df"]').hidden = !im.df;
        interval.value = defaultInterval(file, im);
        stretch.disabled = interval.value === 'df';
        sum.textContent = `Header (${summary(im)})`;
    };
    const opts = () => ({
        interval: interval.value === 'custom' ? [Number(lo.value), Number(hi.value)] : interval.value,
        stretch: stretch.value,
        part: part.value,
    });
    const show = async n => {
        const mine = ++turn;
        // another image: its own default window
        const im = file.header.images[file.pages[Math.max(0, Math.min(file.pages.length - 1, n))].image];
        if (im.n !== shownImage) { shownImage = im.n; fit(im); }
        try {
            const d = await xisfPage(url, n, opts());
            if (mine !== turn) return;
            img.src = d.url;
            page = d.page;
            pages = d.pages;
            info.textContent = `${page + 1} / ${pages}`;
            info.title = `${d.label ? d.label + ', ' : ''}${d.width}×${d.height}`;
            img.title = info.title;
            info.hidden = prev.hidden = next.hidden = pages < 2;
            prev.disabled = page === 0;
            next.disabled = page === pages - 1;
            stretch.disabled = d.interval === 'df';
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
    part.onchange = () => show(page);
    interval.onchange = () => show(page);
    lo.onchange = hi.onchange = () => { interval.value = 'custom'; show(page); };
    stretch.onchange = () => show(page);
    root.tabIndex = root.tabIndex >= 0 ? root.tabIndex : 0;
    root.addEventListener('keydown', e => {
        if (e.target.closest && e.target.closest('select, input, details')) return;
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { show(page + 1); e.preventDefault(); }
        else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { show(page - 1); e.preventDefault(); }
    });
    xisfFile(url).then(f => {
        file = f;
        text.textContent = f.text;
        show(0);
    }).catch(err => { info.textContent = err.message; });
    root.append(bar, header);
    return bar;
}

module.exports = {
    isXisfName, isXisf, parseHeader, parseLocation, parseCompression, unshuffle, decompress, xisbBlock, readChannels,
    labToRgbFn, readXisf, channelValues, xisfLimits, xisfRgba, xisfFile, xisfPage, addXisfControls,
};
