// JPEG 2000 to 8-bit RGBA, for public/jp2-worker.js (.jp2 and friends) and
// public/tiff-worker.js (a TIFF's JPEG 2000 strips and tiles): OpenJPEG as
// pdf.js builds it for its JPXDecode (pdf.js's image decoders and their
// openjpeg.wasm). It reads JP2/JPX files and bare codestreams, HTJ2K included,
// and makes RGBA of sYCC, subsampled chroma, palettes, 16-bit and alpha. ICC
// profiles aren't applied; a JPX file's first codestream is the picture.
import { JpxImage } from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/image_decoders/pdf.image_decoders.min.mjs';

JpxImage.setOptions({ useWasm: true, useWorkerFetch: true, wasmUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/wasm/' });

// Where the codestream starts: a JP2/JPX file's jp2c box, or 0 for a bare one
function codestreamStart(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 12 || v.getUint32(4) !== 0x6a502020) return 0; // 'jP  '
    for (let p = 0; p + 8 <= bytes.length;) {
        let len = v.getUint32(p), head = 8;
        const type = v.getUint32(p + 4);
        if (len === 1) { len = Number(v.getBigUint64(p + 8)); head = 16; }
        else if (len === 0) len = bytes.length - p;
        if (type === 0x6a703263) return p + head; // 'jp2c'
        if (len < head) break;
        p += len;
    }
    throw new Error('no codestream (jp2c box) in this JPEG 2000 file');
}

// From the codestream's main header: { width, height, components, subsampled,
// mct } (the size of the image OpenJPEG makes: its least subsampled component's;
// subsampled, whether some components are smaller, which OpenJPEG then takes for
// YCbCr; mct, whether the components are RGB put through the multiple component
// transform)
export function jp2Info(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = codestreamStart(bytes);
    if (v.getUint16(p) !== 0xff4f || v.getUint16(p + 2) !== 0xff51) throw new Error('not a JPEG 2000 codestream');
    p += 2;
    const xsiz = v.getUint32(p + 6), ysiz = v.getUint32(p + 10), xosiz = v.getUint32(p + 14), yosiz = v.getUint32(p + 18);
    const components = v.getUint16(p + 38);
    let dx = 255, dy = 255, subsampled = false;
    for (let i = 0; i < components; i++) {
        const cdx = bytes[p + 41 + 3 * i], cdy = bytes[p + 42 + 3 * i];
        if (i && (cdx !== bytes[p + 41] || cdy !== bytes[p + 42])) subsampled = true;
        dx = Math.min(dx, cdx);
        dy = Math.min(dy, cdy);
    }
    const info = {
        width: Math.ceil(xsiz / dx) - Math.ceil(xosiz / dx),
        height: Math.ceil(ysiz / dy) - Math.ceil(yosiz / dy),
        components,
        subsampled,
        mct: false,
    };
    // the markers after SIZ, up to the first tile, for COD
    for (p += 2 + v.getUint16(p + 2); p + 4 <= bytes.length && v.getUint16(p) !== 0xff90;) {
        if (v.getUint16(p) === 0xff52) { info.mct = bytes[p + 8] !== 0; break; }
        p += 2 + v.getUint16(p + 2);
    }
    return info;
}

// { rgba: Uint8ClampedArray, width, height }
export async function jp2Rgba(bytes) {
    const { width, height } = jp2Info(bytes);
    // numComponents 0: as many as the image has, made RGBA; smaskInData: its alpha kept
    const rgba = await JpxImage.instance.decode(bytes, { numComponents: 0, smaskInData: true });
    if (rgba.length !== width * height * 4) throw new Error(`JPEG 2000 decoded to ${rgba.length} bytes, not ${width}×${height} RGBA`);
    return { rgba, width, height };
}
