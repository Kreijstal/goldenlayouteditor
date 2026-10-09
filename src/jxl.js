// --- JPEG XL where the browser can't show it ---
// Safari shows JPEG XL; other browsers (mostly) don't. There, .jxl files are
// decoded in a worker (public/jxl-worker.js, jxl-oxide as WebAssembly) to PNG,
// or APNG for animations, which any <img> shows. TinyVG (.tvg), which no
// browser shows, becomes SVG here too (src/tvg.js), a TIFF's first page PNG
// (src/tiff.js), JPEG 2000 PNG (src/jp2.js), a HEIF's primary image PNG
// (src/heif.js), a Netpbm file's first image PNG (src/netpbm.js), a
// Radiance HDR picture's PNG, tone mapped (src/rgbe.js), a TGA's PNG
// (src/tga.js), a QOI's PNG (src/qoi.js), a PCX's (a DCX's first page)
// PNG (src/pcx.js), an SGI image's PNG (src/sgi.js), a Sun raster's PNG
// (src/sunras.js), an Amiga IFF picture's PNG (src/ilbm.js), a FITS
// file's first image's PNG, zscaled (src/fits.js), a JPEG XR's PNG, tone
// mapped if high dynamic range (src/jxr.js), a BPG's PNG, APNG if animated
// (src/bpg.js), a FLIF's, the same (src/flif.js), an NRRD's middle
// slice's PNG, windowed (src/nrrd.js; an .nhdr's data read from beside it),
// a VICAR image's first band's PNG, or its three bands' (src/vicar.js), an
// XISF file's first image's PNG, windowed (src/xisf.js; an .xish's blocks read
// from beside it), a PGF image's PNG (src/pgf.js), an ECW image's PNG, no
// more than 4096 pixels on its long side (src/ecw.js), a Micrografx Draw
// drawing's SVG (src/drw.js), a CorelDRAW drawing's first page's SVG, by
// LibreOffice (src/cdr.js), an OpenDocument drawing's first page's SVG, by
// LibreOffice (src/odg.js), an XPS document's first page's PNG (src/xps.js), a GEM raster image's PNG (src/gem.js), and an
// ERDAS IMAGINE image's first band's PNG, or its three bands', at an overview
// that fits (src/hfa.js), a Haiku vector icon's SVG (src/hvif.js), a
// QuickDraw PICT's PNG, by ImageMagick (src/pict.js), a Windows metafile's
// SVG (WMF, EMF, EMF+; gzipped too), by emf-converter (src/wmf.js), a
// Windows cursor's largest image's PNG, an animated cursor's first frame's (src/cur.js),
// an Apple icon image's largest image's (src/icns.js), and an Amiga IFF animation's
// first frame's, by FFmpeg (src/iffanim.js), a CALS raster's PNG, by GDAL (src/cals.js), a DPX
// or Cineon film scan's PNG, log to linear, by ImageMagick (src/dpx.js), a
// DirectDraw Surface's first level's PNG (src/dds.js), and an OpenEXR file's
// first layer's PNG, tone mapped (src/exr.js), a JBIG2 file's first page's PNG, by
// MuPDF (src/jbig2.js), an MNG animation's first frame's PNG or a JNG's PNG, by
// ImageMagick (src/mng.js), a JPEG-LS image's PNG, by CharLS (src/jls.js), a MIFF
// file's first image's PNG (src/miff.js) and a WBMP's PNG (src/wbmp.js), by
// ImageMagick, and an X Window dump's PNG (src/xwd.js) and a PICtor picture's
// PNG (src/pictor.js), by FFmpeg, and a camera raw file's half-size PNG, by
// LibRaw (src/raw.js).
const { createLogger } = require('./debug');
const { tvgToSvg } = require('./tvg');
const { isTiffName, tiffPage } = require('./tiff');
const { isHeifName, heifPage } = require('./heif');
const { isNetpbmName, netpbmPage } = require('./netpbm');
const { isRgbeName, isPicName, rgbeImage } = require('./rgbe');
const { isTgaName, tgaImage } = require('./tga');
const { isQoiName, qoiImage } = require('./qoi');
const { isPcxName, pcxPage } = require('./pcx');
const { isSgiName, sgiImage } = require('./sgi');
const { isSunName, sunImage } = require('./sunras');
const { isIlbmName, isIlbmMaybeName, ilbmImage } = require('./ilbm');
const { isAnimName, isAnimUrl, animImage } = require('./iffanim');
const { isFitsName, isFzName, fitsPage } = require('./fits');
const { isJxrName, jxrImage } = require('./jxr');
const { isBpgName, bpgImage } = require('./bpg');
const { isFlifName, flifImage } = require('./flif');
const { isNrrdName, nrrdPage } = require('./nrrd');
const { isVicarName, isVicarMaybeName, vicarPage } = require('./vicar');
const { isXisfName, xisfPage } = require('./xisf');
const { isPgfName, pgfImage } = require('./pgf');
const { isDrwName, drwImage } = require('./drw');
const { isCdrName, cdrImage } = require('./cdr');
const { isOdgName, odgImage } = require('./odg');
const { isXpsName, xpsImage } = require('./xps');
const { isJbig2Name, jbig2Image } = require('./jbig2');
const { isGemName, isGemMaybeName, isGemUrl, gemImage } = require('./gem');
const { isHfaMaybeName, isHfaUrl, hfaPage } = require('./hfa');
const { isEcwName, ecwImage } = require('./ecw');
const { isJp2Name, jp2Decode } = require('./jp2');
const { isHvifName, hvifImage } = require('./hvif');
const { isPictName, isPictUrl, pictImage } = require('./pict');
const { isCalsName, isCalsMaybeName, isCalsUrl, calsImage } = require('./cals');
const { isDpxName, isCinName, isCineonUrl, dpxImage } = require('./dpx');
const { isMngName, isJngName, isMngUrl, mngImage, jngImage } = require('./mng');
const { isWmfName, wmfImage } = require('./wmf');
const { isCursorName, cursorImage } = require('./cur');
const { isIcnsName, icnsImage } = require('./icns');
const { isDdsName, ddsImage } = require('./dds');
const { isExrName, exrImage } = require('./exr');
const { isJlsName, jlsImage } = require('./jls');
const { isMiffName, miffPage } = require('./miff');
const { isWbmpName, wbmpImage } = require('./wbmp');
const { isXwdName, xwdImage } = require('./xwd');
const { isPictorUrl, pictorImage } = require('./pictor');
const { isRawName, rawImage } = require('./raw');

const log = createLogger('JXL');
// A 1×1 JPEG XL (Modernizr's test)
const PROBE = 'data:image/jxl;base64,/woIAAAMABKIAgC4AF3lEgAAFSqjjBu8nOv58kOHxbSN6wxttW1hSaLIODZJJ3BIEkkaoCUzGM6qJAE=';
const JXL_RE = /\.jxl$/i;
const TVG_RE = /\.tvg$/i;

let nativePromise = null;
let worker = null;
let nextId = 1;
const pending = new Map();
const converted = new Map(); // source URL -> Promise<blob URL>

function jxlNative() {
    if (!nativePromise) {
        nativePromise = new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img.width === 1);
            img.onerror = () => resolve(false);
            img.src = PROBE;
        });
    }
    return nativePromise;
}

// Bytes of a JPEG XL file (codestream or container)
function isJxl(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a) return true;
    const sig = [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
    return bytes.length >= 12 && sig.every((b, i) => bytes[i] === b);
}

// { png: Uint8Array (a PNG, or an APNG for animations), width, height, frames, loops, animated }
function jxlDecode(bytes) {
    if (!worker) {
        worker = new Worker('/jxl-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'JPEG XL decoder failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
    });
}

// A URL an <img> can show: the file's own for anything but JPEG XL, TinyVG,
// TIFF, JPEG 2000, HEIF, Netpbm, Radiance, TGA, QOI, PCX, SGI, Sun raster, IFF
// ILBM, DEEP, FITS, JPEG XR, BPG, FLIF, NRRD, VICAR, XISF, PGF, ECW, Micrografx Draw, CorelDRAW, OpenDocument drawings, XPS, GEM, ERDAS IMAGINE, Haiku vector icons, QuickDraw PICT, Windows metafiles, CALS rasters, JBIG2, DPX, Cineon, MNG, JNG, JPEG-LS, MIFF, WBMP and X Window dumps, or where the browser shows JPEG XL; else a blob: URL of the decoded
// PNG/APNG (JPEG XL), the SVG (TinyVG), the first page's PNG (TIFF, Netpbm, DCX,
// FITS, zscaled; an .fz only once known to be one),
// the PNG (JPEG 2000, TGA, QOI, PCX, SGI, Sun raster, ILBM, DEEP (its first frame); a .rgb, .bw..., .rs
// or .iff only once known to be one), the
// primary image's PNG (HEIF) or the tone mapped PNG (Radiance; a .pic only
// once known to be one; JPEG XR, if high dynamic range; a .wdp or .hdp only
// once known to be one), the PNG/APNG (BPG, FLIF), the middle slice's PNG (NRRD),
// the first band's PNG, in color for three (VICAR; an .img only once known to be one)
// or the first page's PNG, windowed as the image asks (XISF), the PNG (PGF; a
// .pgf only once known to be one), the PNG at a scale that fits (ECW), the SVG
// (Micrografx Draw; a .drw only once known to be one), the first page's SVG
// (CorelDRAW, CMX; a .cdr, .cdt or .cmx only once known to be one), the first
// page's SVG (OpenDocument drawings, .odg, .otg, .fodg), the first page's PNG
// (XPS, OpenXPS), the PNG (GEM; an .img
// that is one, else VICAR's) or the first band's PNG, in color for three, at an
// overview that fits (ERDAS IMAGINE; an .img that starts "EHFA_HEADER_TAG"), the SVG
// (Haiku vector icon), the PNG (QuickDraw PICT; a .pic only once known to be one) or the
// SVG (Windows metafile: .wmf, .emf, gzipped .wmz, .emz) or the largest image's PNG
// (Windows cursor: .cur, an animated .ani's first frame; Apple icon image: .icns) or the
// first frame's PNG (Amiga IFF animation: .anim, .anm; an .iff only once known to be one;
// Autodesk FLIC animation: .fli, .flc, .flx) or
// the PNG (CALS raster: .cals, .ct1; a .cal or .ras only once known to be one) or the PNG,
// a logarithmic one turned linear (DPX: .dpx; Cineon: a .cin only once known to be one) or
// the first level's PNG (DirectDraw Surface: .dds) or the first layer's PNG, tone
// mapped (OpenEXR: .exr) or the first page's PNG (JBIG2: .jb2, .jbig2) or the first
// frame's PNG (MNG: a .mng only once known to be one) or the PNG (JNG: .jng) or the
// PNG, more than 8 bits windowed to their range (JPEG-LS: .jls) or the first image's PNG
// (MIFF: .miff) or the PNG (WBMP: .wbmp; X Window dump: .xwd; PICtor: a .pic only once known to be one)
// or the half-size PNG, demosaiced (camera raw: .dng, .crw, .cr2, .cr3, .nef, .arw...)
async function displayableImageUrl(url, name) {
    if (isTiffName(name)) return (await tiffPage(url, 0)).url;
    if (isHeifName(name)) return (await heifPage(url, 0)).url;
    if (isNetpbmName(name)) return (await netpbmPage(url, 0)).url;
    // a .pic: QuickDraw PICT if it starts as one, PICtor (PC Paint) if it starts as one, else Radiance's
    if (isPictName(name) || (isPicName(name) && await isPictUrl(url).catch(() => false))) return (await pictImage(url)).url;
    if (isPicName(name) && await isPictorUrl(url).catch(() => false)) return (await pictorImage(url)).url;
    if (isRgbeName(name) || isPicName(name)) return (await rgbeImage(url)).url;
    if (isTgaName(name)) return (await tgaImage(url)).url;
    if (isQoiName(name)) return (await qoiImage(url)).url;
    if (isPcxName(name)) return (await pcxPage(url, 0)).url;
    if (isSgiName(name)) return (await sgiImage(url)).url;
    // a .cal or .ras: CALS if it starts as CALS does, else (a .ras) a Sun raster
    if (isCalsName(name) || (isCalsMaybeName(name) && await isCalsUrl(url).catch(() => false))) return (await calsImage(url, name)).url;
    if (isSunName(name)) return (await sunImage(url)).url;
    // a .cin: Cineon if it starts as one (else an input method's table)
    if (isDpxName(name) || (isCinName(name) && await isCineonUrl(url).catch(() => false))) return (await dpxImage(url)).url;
    // an .iff: an animation if its FORM is ANIM, else a picture
    if (isAnimName(name) || (isIlbmMaybeName(name) && await isAnimUrl(url).catch(() => false))) return (await animImage(url)).url;
    if (isIlbmName(name)) return (await ilbmImage(url)).url;
    if (isFitsName(name) || isFzName(name)) return (await fitsPage(url, 0)).url;
    if (isJxrName(name)) return (await jxrImage(url)).url;
    if (isBpgName(name)) return (await bpgImage(url)).url;
    if (isFlifName(name)) return (await flifImage(url)).url;
    if (isNrrdName(name)) return (await nrrdPage(url)).url;
    if (isHfaMaybeName(name) && await isHfaUrl(url).catch(() => false)) return (await hfaPage(url)).url;
    if (isGemName(name) || (isGemMaybeName(name) && await isGemUrl(url).catch(() => false))) return (await gemImage(url)).url;
    if (isVicarName(name) || isVicarMaybeName(name)) return (await vicarPage(url)).url;
    if (isXisfName(name)) return (await xisfPage(url)).url;
    if (isPgfName(name)) return (await pgfImage(url)).url;
    if (isEcwName(name)) return (await ecwImage(url)).url;
    if (isDrwName(name)) return (await drwImage(url)).url;
    if (isCdrName(name)) return (await cdrImage(url, name)).url;
    if (isOdgName(name)) return (await odgImage(url, name)).url;
    if (isXpsName(name)) return (await xpsImage(url, name)).url;
    if (isJbig2Name(name)) return (await jbig2Image(url)).url;
    if (isHvifName(name)) return (await hvifImage(url)).url;
    if (isWmfName(name)) return (await wmfImage(url)).url;
    if (isCursorName(name)) return (await cursorImage(url)).url;
    if (isIcnsName(name)) return (await icnsImage(url)).url;
    if (isDdsName(name)) return (await ddsImage(url)).url;
    if (isExrName(name)) return (await exrImage(url)).url;
    // a .mng: MNG if it starts as one (else Ott's text)
    if (isMngName(name) && await isMngUrl(url).catch(() => false)) return (await mngImage(url)).url;
    if (isJngName(name)) return (await jngImage(url)).url;
    if (isJlsName(name)) return (await jlsImage(url)).url;
    if (isMiffName(name)) return (await miffPage(url, 0)).url;
    if (isWbmpName(name)) return (await wbmpImage(url)).url;
    if (isXwdName(name)) return (await xwdImage(url)).url;
    if (isRawName(name)) return (await rawImage(url)).url;
    const tvg = TVG_RE.test(name || '');
    const jp2 = isJp2Name(name);
    if (!tvg && !jp2 && (!JXL_RE.test(name || '') || await jxlNative())) return url;
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (tvg) return URL.createObjectURL(new Blob([await tvgToSvg(bytes)], { type: 'image/svg+xml' }));
            const r = jp2 ? await jp2Decode(bytes) : await jxlDecode(bytes);
            return URL.createObjectURL(new Blob([r.png], { type: 'image/png' }));
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn(`${tvg ? 'TinyVG' : jp2 ? 'JPEG 2000' : 'JPEG XL'} decode failed:`, err); });
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(u => URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

module.exports = { jxlNative, jxlDecode, isJxl, displayableImageUrl };
