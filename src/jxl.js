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
// file's first image's PNG, zscaled (src/fits.js) and a JPEG XR's PNG, tone
// mapped if high dynamic range (src/jxr.js).
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
const { isIlbmName, ilbmImage } = require('./ilbm');
const { isFitsName, isFzName, fitsPage } = require('./fits');
const { isJxrName, jxrImage } = require('./jxr');
const { isJp2Name, jp2Decode } = require('./jp2');

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
// ILBM, FITS and JPEG XR, or where the browser shows JPEG XL; else a blob: URL of the decoded
// PNG/APNG (JPEG XL), the SVG (TinyVG), the first page's PNG (TIFF, Netpbm, DCX,
// FITS, zscaled; an .fz only once known to be one),
// the PNG (JPEG 2000, TGA, QOI, PCX, SGI, Sun raster, ILBM; a .rgb, .bw..., .rs
// or .iff only once known to be one), the
// primary image's PNG (HEIF) or the tone mapped PNG (Radiance; a .pic only
// once known to be one; JPEG XR, if high dynamic range; a .wdp or .hdp only
// once known to be one)
async function displayableImageUrl(url, name) {
    if (isTiffName(name)) return (await tiffPage(url, 0)).url;
    if (isHeifName(name)) return (await heifPage(url, 0)).url;
    if (isNetpbmName(name)) return (await netpbmPage(url, 0)).url;
    if (isRgbeName(name) || isPicName(name)) return (await rgbeImage(url)).url;
    if (isTgaName(name)) return (await tgaImage(url)).url;
    if (isQoiName(name)) return (await qoiImage(url)).url;
    if (isPcxName(name)) return (await pcxPage(url, 0)).url;
    if (isSgiName(name)) return (await sgiImage(url)).url;
    if (isSunName(name)) return (await sunImage(url)).url;
    if (isIlbmName(name)) return (await ilbmImage(url)).url;
    if (isFitsName(name) || isFzName(name)) return (await fitsPage(url, 0)).url;
    if (isJxrName(name)) return (await jxrImage(url)).url;
    const tvg = TVG_RE.test(name || '');
    const jp2 = isJp2Name(name);
    if (!tvg && !jp2 && (!JXL_RE.test(name || '') || await jxlNative())) return url;
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (tvg) return URL.createObjectURL(new Blob([tvgToSvg(bytes)], { type: 'image/svg+xml' }));
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
