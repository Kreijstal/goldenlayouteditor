// ECW to PNG, for the image viewer (src/ecw.js). ecw2tiff (github.com/itamarwe/ecw2tiff,
// MIT: a from-scratch decoder of ER Mapper's Enhanced Compression Wavelet,
// versions 2 and 3, no ECW SDK code) as WebAssembly (@kreijstal/ecw2tiff-wasm:
// the decoder, reading from memory, and a small C API) undoes the entropy
// coding, the wavelet pyramid and the YUV transform to 8-bit samples: gray
// (one band), RGB (YUV: what the SDK writes of RGB), the first three bands of
// a multi-band file as RGB (one of two bands as gray); an ECW v3's opacity
// band it decodes but doesn't give, so such a picture is opaque here. A scale
// is the image at 1/scale of its size (a power of two), decoded from the
// file's coarser levels alone, as the SDK's views at a lower resolution are.
//   → { id, bytes, scale }   (scale: 1, 2, 4..., 'fit': the largest picture no more than FIT on its long side,
//                             or 'thumb': the smallest at least THUMB on its long side)
//   ← { id, result: { png, width, height, fullWidth, fullHeight, scale, scales, label } } | { id, error }
import createEcw from 'https://cdn.jsdelivr.net/npm/@kreijstal/ecw2tiff-wasm@0.1.1-build.1/ecw2tiff.mjs';

const THUMB = 256;
// a mosaic of tens of gigapixels is shown whole only at a fraction of its size
const FIT = 4096;
const FORMATS = { grey: 'gray', yuv: 'RGB (YUV)', multi: 'multi-band', rgb: 'RGB' };
// ECW's cell units (the SDK's CellSizeUnits; 4 is unknown)
const UNITS = { 1: 'm', 2: '°', 3: 'ft' };

let ecw = null;

async function toPng(rgba, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

// What the file is, for the tooltip
function describe(info) {
    let label = `ECW v${info.version}, ${FORMATS[info.format] || info.format}`;
    if (info.format === 'multi' || info.bands !== info.channels) label += `, ${info.bands} bands`;
    if (info.format === 'multi' && info.bands > 3) label += ' (the first three shown as RGB)';
    else if (info.channels === 2) label += ' (the first shown)';
    if (info.version >= 3 && info.bands > info.channels) label += ', its opacity band not shown';
    if (info.compressionRate > 1) label += `, target ratio ${info.compressionRate}:1`;
    label += `, ${info.levels.length + 1} resolution levels`;
    const proj = [info.projection, info.datum].filter(s => s && s !== 'RAW').join(' / ');
    if (proj || info.epsg) label += `, ${proj}${info.epsg ? `${proj ? ' ' : ''}(EPSG:${info.epsg})` : ''}`;
    if (proj || info.epsg) {
        const u = UNITS[info.cellUnits] || '';
        label += `, cells ${info.cellSize[0]}×${Math.abs(info.cellSize[1])}${u ? ' ' + u : ''} from ${info.origin[0]}, ${info.origin[1]}`;
    }
    return label;
}

async function decodeEcw(bytes, scale) {
    if (!ecw) ecw = createEcw();
    const img = (await ecw).open(bytes);
    try {
        const { info } = img;
        // the pyramid: the full size, then one level coarser for each of the file's levels
        const scales = info.levels.length + 1;
        const size = s => Math.max(Math.ceil(info.width / 2 ** s), Math.ceil(info.height / 2 ** s));
        let s;
        if (scale === 'thumb') {
            for (s = 0; s + 1 < scales && size(s + 1) >= THUMB;) s++;
        } else if (scale === 'fit') {
            for (s = 0; size(s) > FIT;) s++;
        } else {
            s = Math.max(0, Math.round(Math.log2(scale || 1)));
        }
        const d = img.decode(2 ** s);
        const n = d.width * d.height;
        const rgba = new Uint8ClampedArray(n * 4);
        for (let i = 0, o = 0; i < n; i++, o += 4) {
            const p = i * d.channels;
            if (d.channels >= 3) {
                rgba[o] = d.data[p]; rgba[o + 1] = d.data[p + 1]; rgba[o + 2] = d.data[p + 2];
            } else {
                rgba[o] = rgba[o + 1] = rgba[o + 2] = d.data[p];
            }
            rgba[o + 3] = 255;
        }
        return {
            png: await toPng(rgba, d.width, d.height), width: d.width, height: d.height,
            fullWidth: info.width, fullHeight: info.height, scale: 2 ** s, scales, label: describe(info),
        };
    } finally {
        img.close();
    }
}

self.onmessage = async ({ data }) => {
    const { id, bytes, scale } = data;
    try {
        const result = await decodeEcw(new Uint8Array(bytes), scale);
        self.postMessage({ id, result }, [result.png.buffer]);
    } catch (err) {
        self.postMessage({ id, error: err.message || String(err) });
    }
};
