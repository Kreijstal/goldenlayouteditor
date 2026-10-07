// TIFF to PNG, for the image viewer (src/tiff.js), a page at a time. UTIF.js
// (github.com/photopea/UTIF.js) reads most TIFFs: LZW, Deflate, PackBits,
// JPEG, CCITT fax (G3/G4), tiles, palettes, CMYK, 16-bit. What it can't,
// LogLuv HDR (SGILog/SGILog24) and separate planes, LibTIFF does (tiff.js,
// LibTIFF built with Emscripten, loaded only then). A TIFF/EP's previews in
// SubIFDs (a camera's full-size JPEG) are pages too; raw sensor data (CFA)
// isn't developed.
//   → { id, bytes, page }   ← { id, result: { pages: [{ width, height, label }], page, image, type } } | { id, error }
self.window = self; // UTIF.js asks window for a CMYK colour converter
importScripts(
    'https://cdn.jsdelivr.net/npm/pako@1.0.11/dist/pako_inflate.min.js',
    'https://cdn.jsdelivr.net/npm/utif2@4.1.0/UTIF.js',
);
const TIFFJS_URL = 'https://cdn.jsdelivr.net/npm/tiff.js@1.0.0/tiff.min.js';

// Compressions UTIF.js decodes (UTIF.decode._decompress); its SGILog reader is
// only right for big-endian files, so LogLuv goes to LibTIFF
const UTIF_COMPRESSIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 32767, 32773, 32809, 32946, 34316, 34713, 34892]);
// ... and the ones tiff.js's LibTIFF (4.0, without JPEG) does
const LIBTIFF_COMPRESSIONS = new Set([1, 2, 3, 4, 5, 8, 32766, 32773, 32809, 32908, 32909, 32946, 34676, 34677]);
const COMPRESSION_NAMES = {
    32895: 'TIFF/IT CT padding', 32896: 'TIFF/IT linework (LW)', 32897: 'TIFF/IT monochrome picture (MP)',
    32898: 'TIFF/IT binary line art (BL)', 34661: 'JBIG', 34712: 'JPEG 2000', 34887: 'LERC',
    34925: 'LZMA', 50000: 'Zstandard', 50001: 'WebP', 50002: 'JPEG XL',
};
const PHOTOMETRIC_CFA = 32803, PHOTOMETRIC_LINEAR_RAW = 34892;
const PHOTOMETRIC_LOGL = 32844, PHOTOMETRIC_LOGLUV = 32845;

let libtiff = null;

function tag(ifd, t, d) {
    const v = ifd['t' + t];
    return v ? v[0] : d;
}

// The images in the file: the IFD chain's, each followed by its SubIFDs (a
// TIFF/EP's previews), as { ifd, dir (in the chain, for LibTIFF), label }
function listPages(ifds) {
    const pages = [];
    ifds.forEach((ifd, dir) => {
        const n = ifds.length > 1 ? `Page ${dir + 1}` : 'Image';
        pages.push({ ifd, dir, label: tag(ifd, 254, 0) & 1 ? `${n} (reduced resolution)` : n });
        (ifd.subIFD || []).forEach((sub, i) => {
            const photometric = tag(sub, 262, -1);
            if (photometric === PHOTOMETRIC_CFA || photometric === PHOTOMETRIC_LINEAR_RAW) return; // raw sensor data
            if (sub.t513 && sub.t514) pages.push({ ifd: sub, dir: -1, label: `${n}, preview ${i + 1} (JPEG)` });
            else if (sub.t256) pages.push({ ifd: sub, dir: -1, label: `${n}, ${tag(sub, 254, 0) & 1 ? 'preview' : 'image'} ${i + 1}` });
        });
    });
    return pages;
}

async function png(rgba, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height), 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

// RGBA of the dir'th image of the chain, by LibTIFF's TIFFReadRGBAImage
function libtiffRgba(bytes, dir) {
    if (!libtiff) {
        importScripts(TIFFJS_URL);
        // asm.js: memory is fixed when it starts
        Tiff.initialize({ TOTAL_MEMORY: 512 * 1024 * 1024 });
        libtiff = Tiff;
    }
    const tiff = new libtiff({ buffer: bytes });
    try {
        tiff.setDirectory(dir);
        return { rgba: new Uint8Array(tiff.readRGBAImage()), width: tiff.width(), height: tiff.height() };
    } finally {
        tiff.close();
    }
}

async function render(bytes, ifds, p) {
    const { ifd } = p;
    // a JPEG of its own (a camera's preview, old-style JPEG): the browser decodes it
    if (ifd.t513 && ifd.t514) {
        const at = ifd.t513[0];
        return { image: bytes.slice(at, at + ifd.t514[0]), type: 'image/jpeg' };
    }
    const compression = tag(ifd, 259, 1);
    const photometric = tag(ifd, 262, -1);
    if (photometric === PHOTOMETRIC_CFA || photometric === PHOTOMETRIC_LINEAR_RAW) {
        throw new Error('raw sensor data (TIFF/EP or DNG CFA) is not developed here');
    }
    const byLibtiff = photometric === PHOTOMETRIC_LOGL || photometric === PHOTOMETRIC_LOGLUV
        || tag(ifd, 284, 1) === 2 || !UTIF_COMPRESSIONS.has(compression);
    if (byLibtiff) {
        if (!LIBTIFF_COMPRESSIONS.has(compression)) {
            throw new Error(`compression ${COMPRESSION_NAMES[compression] || compression} is not supported`);
        }
        if (p.dir < 0) throw new Error('this image (in a SubIFD) needs LibTIFF, which reads only the main images');
        const { rgba, width, height } = libtiffRgba(bytes, p.dir);
        return { image: await png(rgba, width, height), type: 'image/png' };
    }
    UTIF.decodeImage(bytes, ifd, ifds);
    let rgba;
    try {
        rgba = UTIF.toRGBA8(ifd);
    } catch (e) {
        // UTIF.js throws the bit depth or sample count it has no conversion for
        throw e instanceof Error ? e : new Error(`${tag(ifd, 258, 1)}-bit, ${tag(ifd, 277, 1)}-sample images with photometric ${photometric} are not supported`);
    }
    return { image: await png(rgba, ifd.width, ifd.height), type: 'image/png' };
}

self.onmessage = async ({ data }) => {
    const { id, page } = data;
    try {
        const bytes = new Uint8Array(data.bytes);
        const ifds = UTIF.decode(bytes);
        const pages = listPages(ifds);
        if (!pages.length) throw new Error('no images in this TIFF');
        const p = pages[Math.min(Math.max(page | 0, 0), pages.length - 1)];
        const { image, type } = await render(bytes, ifds, p);
        self.postMessage({
            id,
            result: {
                pages: pages.map(q => ({ width: tag(q.ifd, 256, 0), height: tag(q.ifd, 257, 0), label: q.label })),
                page: pages.indexOf(p),
                image,
                type,
            },
        }, [image.buffer]);
    } catch (e) {
        self.postMessage({ id, error: e && e.message ? e.message : String(e) });
    }
};
