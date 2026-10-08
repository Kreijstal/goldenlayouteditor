// OpenEXR to float planes, for the image viewer (src/exr.js). Two readers,
// both loaded from esm.sh the first time an .exr is opened:
// - @bb-studio/exr (exr-lab's decoder, plain JavaScript): every part of a
//   scanline file and every channel of it by name, uint, half and float alike,
//   as floats (uint as the integers stored); all of OpenEXR's compressions
//   (none, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA, DWAB); subsampled
//   channels (a luminance / chroma image's RY, BY) expanded to the full size,
//   each sample repeated.
// - three.js's EXRLoader (three@0.186.1; the 3D viewer's 0.164.1 reads no part
//   but the first) for the parts @bb-studio/exr doesn't read: tiled ones (the
//   full resolution level) and deep scanline ones (each pixel's samples
//   composited front to back), and DWA compressed RGB(A) or Y ones, which it
//   reads better. It gives R, G, B and A, or Y, only.
//   → { id, bytes }   ← { id, result: { parts: [{ name, width, height, channels, planes, dataWindow, displayWindow,
//                                     types, chromaticities, reader, kind, compression }], skipped } } | { id, error }
// channels: the names of the channels read; planes: a Float32Array each, the
// data window's, top row first; the windows: { xMin, yMin, xMax, yMax }; types:
// each of the part's channels' type (uint, half, float); chromaticities: the
// header's, if it has them; skipped: the parts neither reads, with why.
const EXR_URL = 'https://esm.sh/@bb-studio/exr@0.2.0?deps=fflate@0.8.2';
const THREE_URL = 'https://esm.sh/three@0.186.1';
const PIXEL_TYPES = ['uint', 'half', 'float'];
const COMPRESSIONS = ['none', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K256', 'HTJ2K32'];

let exr = null;
let three = null;

function loadExr() {
    if (!exr) {
        exr = import(EXR_URL);
        exr.catch(() => { exr = null; });
    }
    return exr;
}

function loadThree() {
    if (!three) {
        three = Promise.all([import(THREE_URL), import(THREE_URL + '/examples/jsm/loaders/EXRLoader.js')])
            .then(([T, L]) => ({ FloatType: T.FloatType, EXRLoader: L.EXRLoader }));
        three.catch(() => { three = null; });
    }
    return three;
}

// Part `index` by three.js's EXRLoader: R, G, B (and A), or Y
async function readThree(buffer, index) {
    const { FloatType, EXRLoader } = await loadThree();
    const loader = new EXRLoader();
    loader.setDataType(FloatType);
    loader.part = index;
    const r = loader.parse(buffer);
    const n = r.width * r.height;
    const names = r.header.channels.map(c => c.name);
    const channels = names.includes('R') || names.includes('RY') ? ['R', 'G', 'B'] : ['Y'];
    if (names.includes('A')) channels.push('A');
    // RGBA interleaved, bottom row first (a texture's)
    const planes = channels.map((c, k) => {
        const plane = new Float32Array(n);
        const at = c === 'A' ? 3 : k;
        for (let y = 0; y < r.height; y++) {
            const from = (r.height - 1 - y) * r.width, to = y * r.width;
            for (let x = 0; x < r.width; x++) plane[to + x] = r.data[(from + x) * 4 + at];
        }
        return plane;
    });
    const { dataWindow, displayWindow } = r.header;
    return { width: r.width, height: r.height, channels, planes, dataWindow, displayWindow, reader: 'three.js' };
}

async function decode(bytes) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const { parseExr, decodeExrPart, expandDecodedPartChannels } = await loadExr();
    let structure;
    try {
        structure = parseExr(buffer);
    } catch (err) {
        // a header @bb-studio/exr doesn't read: the first part as three.js reads it
        const d = await readThree(buffer, 0).catch(e => { throw new Error(`Neither @bb-studio/exr (${err.message}) nor three.js (${e.message}) reads this file`); });
        return { parts: [{ name: '', kind: '', types: {}, compression: '', ...d }], skipped: [] };
    }
    const parts = [];
    const skipped = [];
    for (const [index, part] of structure.parts.entries()) {
        const name = typeof part.attributes.name === 'string' ? part.attributes.name : '';
        const kind = typeof part.type === 'string' ? part.type : part.attributes.tiles ? 'tiledimage' : 'scanlineimage';
        const types = {};
        for (const c of part.channels) types[c.name] = PIXEL_TYPES[c.pixelType] || '?';
        const info = { name, kind, types, compression: COMPRESSIONS[part.compression] || '', chromaticities: part.attributes.chromaticities };
        // tiled and deep parts: three.js's; DWAA / DWAB ones too when three.js
        // reads all their channels (@bb-studio/exr 0.2.0 gets some of their
        // blocks wrong, far off: a few hundred pixels of a 644×874 image)
        const dwa = part.compression === 8 || part.compression === 9;
        const own = kind === 'scanlineimage' && !(dwa && part.channels.every(c => ['R', 'G', 'B', 'A', 'Y'].includes(c.name)));
        let why = '';
        if (own) {
            try {
                const decoded = decodeExrPart(buffer, structure, { partId: part.id });
                const byName = expandDecodedPartChannels(decoded, part.dataWindow);
                const channels = part.channels.map(c => c.name).filter(c => byName[c]);
                // uint comes as a fraction of 2^32 - 1: the integer again (ids, counts)
                for (const c of part.channels) {
                    const plane = byName[c.name];
                    if (c.pixelType === 0 && plane) for (let i = 0; i < plane.length; i++) plane[i] = Math.round(plane[i] * 4294967295);
                }
                parts.push({ ...info, width: decoded.width, height: decoded.height, channels, planes: channels.map(c => byName[c]),
                    dataWindow: part.dataWindow, displayWindow: part.displayWindow, reader: '@bb-studio/exr' });
                continue;
            } catch (err) {
                why = err.message;
            }
        }
        try {
            parts.push({ ...info, ...await readThree(buffer, index) });
        } catch (err) {
            skipped.push(`${name || `part ${index + 1}`}: ${why ? `${why}; ` : ''}${err.message.replace(/^THREE\.EXRLoader: /, '')}`);
        }
    }
    if (!parts.length) throw new Error(skipped.join('; ') || 'no parts');
    return { parts, skipped };
}

let queue = Promise.resolve();

self.onmessage = ({ data: { id, bytes } }) => {
    queue = queue.then(() => decode(new Uint8Array(bytes))).then(
        // planes may share a buffer
        result => self.postMessage({ id, result }, [...new Set(result.parts.flatMap(p => p.planes.map(a => a.buffer)))]),
        err => self.postMessage({ id, error: err.message || String(err) }));
};
