// --- ImageMagick's own images (.miff) to PNG ---
// MIFF, the Magick Image File Format: a header of key=value text ("id=ImageMagick",
// class, colors, columns, rows, depth, colorspace, compression, alpha-trait...,
// ended by ":\x1a"), a colormap for a PseudoClass image, then the pixels,
// raw, RLE, Zip, BZip or LZMA compressed; one image after another in the same
// file (scenes: pages, the frames of an animation). Only ImageMagick writes and
// reads it; here ImageMagick does (magick-wasm, the copy src/pict.js loads):
// each image written as a PNG (a CMYK one turned RGB by ImageMagick), shown in
// the image viewer with buttons to turn the images; thumbnails of the first.
// This ImageMagick is Q8: a 16-bit or floating-point image is shown at 8 bits.
const { createLogger } = require('./debug');
const { magick } = require('./pict');

const log = createLogger('MIFF');
const MIFF_RE = /\.miff$/i;
const MIFF_MAGIC = 'id=ImageMagick';

const files = new Map(); // source URL -> Promise<{ pngs, pages }>
const converted = new Map(); // source URL + page -> Promise<{ url, pages, page }>

function isMiffName(name) {
    return MIFF_RE.test(name || '');
}

// Bytes that start a MIFF file (its header's first key, after any blanks)
function isMiff(bytes) {
    const head = String.fromCharCode(...bytes.subarray(0, 64));
    return head.trimStart().startsWith(MIFF_MAGIC);
}

// ImageMagick's names for what a MIFF image's header says
const nameOf = (en, v) => Object.keys(en).find(k => en[k] === v) || String(v);

function describe(image, ColorSpace, CompressionMethod, ClassType) {
    const { width, height, depth, hasAlpha } = image;
    const pseudo = image.classType === ClassType.Pseudo;
    const compression = image.compression === CompressionMethod.NoCompression || image.compression === CompressionMethod.Undefined
        ? '' : nameOf(CompressionMethod, image.compression) + ' compressed';
    return [
        `MIFF, ${width}×${height}`,
        `${depth}-bit ${nameOf(ColorSpace, image.colorSpace)}${hasAlpha ? ' and alpha' : ''}`,
        pseudo ? `${image.colormapSize} colors (PseudoClass)` : '',
        compression,
        image.animationDelay ? `${image.animationDelay * 1000 / (image.animationTicksPerSecond || 100)} ms delay` : '',
    ].filter(Boolean).join(', ');
}

// Every image in the file as a PNG: { pngs: [Uint8Array], pages: [{ width, height, label }] }
async function miffDecode(bytes) {
    if (!isMiff(bytes)) throw new Error('not a MIFF file');
    const { ImageMagick, MagickFormat, ColorSpace, CompressionMethod, ClassType } = await magick();
    return ImageMagick.readCollection(bytes, MagickFormat.Miff, images => {
        if (!images.length) throw new Error('ImageMagick found no images');
        const pngs = [], pages = [];
        for (const image of images) {
            pages.push({ width: image.width, height: image.height, label: describe(image, ColorSpace, CompressionMethod, ClassType) });
            pngs.push(image.write(MagickFormat.Png, data => data.slice()));
        }
        return { pngs, pages };
    });
}

function miffFile(url) {
    let p = files.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return miffDecode(new Uint8Array(await resp.arrayBuffer()));
        })();
        files.set(url, p);
        p.catch(err => { files.delete(url); log.warn('MIFF decode failed:', err); });
        // the PNGs of a file of many images add up: few kept
        if (files.size > 8) files.delete(files.keys().next().value);
    }
    return p;
}

// Image `page` of the MIFF file at url: { url (a blob: URL of its PNG), pages: [{ width, height, label }], page }
function miffPage(url, page = 0) {
    const key = url + '#' + page;
    let p = converted.get(key);
    if (!p) {
        p = (async () => {
            const { pngs, pages } = await miffFile(url);
            const n = Math.max(0, Math.min(pages.length - 1, page));
            return { url: URL.createObjectURL(new Blob([pngs[n]], { type: 'image/png' })), pages, page: n };
        })();
        converted.set(key, p);
        p.catch(err => { converted.delete(key); log.warn('MIFF decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (converted.size > 64) {
            const [oldKey, old] = converted.entries().next().value;
            converted.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isMiffName, isMiff, miffDecode, miffPage };
