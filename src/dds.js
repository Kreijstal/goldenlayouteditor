// --- DirectDraw Surface (.dds) ---
// Direct3D's texture file: a header (and, for DXGI formats, a DX10 header
// after it), then each array layer's cube faces' (one face if not a cube)
// mip chains, one after another, compressed in blocks (BC1-BC7: DXT1/3/5,
// ATI1/2, BC6H's half floats, BC7) or not. No browser shows one. The file is
// laid out by @flighthq/texture-formats (its parseDds: the format, from the
// DXGI code, FourCC or channel masks, and every level's byte range), the
// blocks decoded by texture2ddecoder.js (K0lb3's texture2ddecoder as
// WebAssembly; a signed BC6H by tex-decoder, which reads that one), both
// loaded from jsDelivr when one is first shown. A file whose pixel format
// @flighthq/texture-formats doesn't map (24-bit RGB, luminance...) is read
// by ImageMagick (src/pict.js's magick-wasm), its main image (and cube faces). Each level becomes a PNG any <img> shows; the image viewer turns the
// layers, faces and mips and shows the colors with or without the alpha.
// Not shown: signed BC4/BC5 (SNORM; neither decoder reads them), volume
// textures, palette and typeless formats, 15- and 16-bit RGB (magick-wasm's
// ImageMagick doesn't read them either). Float formats (BC6H, RGBA16F,
// RGBA32F) are clamped to 0-1.
const { createLogger } = require('./debug');
const { addTiffPager } = require('./tiff');
const { magick } = require('./pict');

const log = createLogger('DDS');
const TEXTURE_FORMATS = 'https://cdn.jsdelivr.net/npm/@flighthq/texture-formats@0.4.0/+esm';
const T2D = 'https://cdn.jsdelivr.net/npm/texture2ddecoder.js@1.1.0/dist/index.mjs';
const TEX_BC6 = 'https://cdn.jsdelivr.net/npm/tex-decoder@2.0.0/build/esm/bc6.js/+esm';
const DDS_RE = /\.dds$/i;
const FACES = ['+X', '−X', '+Y', '−Y', '+Z', '−Z'];
// @flighthq/texture-formats' formats: a name, and how the level becomes RGBA
const FORMATS = {
    bc1: ['BC1 (DXT1)', 'decodeBc1'], bc1Srgb: ['BC1 (DXT1) sRGB', 'decodeBc1'],
    bc2: ['BC2 (DXT3)', 'decodeBc2'], bc2Srgb: ['BC2 (DXT3) sRGB', 'decodeBc2'],
    bc3: ['BC3 (DXT5)', 'decodeBc3'], bc3Srgb: ['BC3 (DXT5) sRGB', 'decodeBc3'],
    bc4: ['BC4 (ATI1)', 'decodeBc4'], bc4Snorm: ['BC4 SNORM', null],
    bc5: ['BC5 (ATI2)', 'decodeBc5'], bc5Snorm: ['BC5 SNORM', null],
    bc6hUfloat: ['BC6H unsigned float (HDR)', 'decodeBc6'], bc6hSfloat: ['BC6H signed float (HDR)', 'bc6s'],
    bc7: ['BC7', 'decodeBc7'], bc7Srgb: ['BC7 sRGB', 'decodeBc7'],
    rgba8unorm: ['RGBA8', 'rgba8'], rgba8Srgb: ['RGBA8 sRGB', 'rgba8'],
    bgra8unorm: ['BGRA8', 'bgra8'], bgra8Srgb: ['BGRA8 sRGB', 'bgra8'],
    r8unorm: ['R8', 'r8'], rg8unorm: ['RG8', 'rg8'],
    rgba16f: ['RGBA16F (HDR)', 'rgba16f'], rgba32f: ['RGBA32F (HDR)', 'rgba32f'],
};

let libPromise = null;
let bc6Promise = null;
const decoded = new Map(); // source URL -> Promise<{ pages, label, png: Map }>

function isDdsName(name) {
    return DDS_RE.test(name || '');
}

function ddsLib() {
    if (!libPromise) {
        libPromise = Promise.all([import(TEXTURE_FORMATS), import(T2D)])
            .then(([tf, t2d]) => ({ parseDds: tf.parseDds, explain: tf.explainTextureContainerParse, T2D: t2d.Texture2DDecoder }));
        libPromise.catch(() => { libPromise = null; });
    }
    return libPromise;
}

function texBc6() {
    if (!bc6Promise) {
        bc6Promise = import(TEX_BC6).then(m => m.decodeBC6S);
        bc6Promise.catch(() => { bc6Promise = null; });
    }
    return bc6Promise;
}

// floats (4 a pixel) clamped to 0-1, as bytes
function floatsToRgba(f) {
    const rgba = new Uint8ClampedArray(f.length);
    for (let i = 0; i < f.length; i++) rgba[i] = f[i] * 255 + 0.5;
    return rgba;
}

// One level's bytes as RGBA (width × height × 4)
async function levelRgba(lib, kind, data, width, height) {
    const n = width * height;
    const rgba = new Uint8ClampedArray(n * 4);
    if (kind.startsWith('decode')) {
        // BGRA, BC4's red (shown gray), BC5's red and green
        const bgra = await lib.T2D[kind](data, width, height);
        for (let i = 0; i < n; i++) {
            rgba[i * 4] = bgra[i * 4 + 2];
            rgba[i * 4 + 1] = kind === 'decodeBc4' ? bgra[i * 4 + 2] : bgra[i * 4 + 1];
            rgba[i * 4 + 2] = kind === 'decodeBc4' ? bgra[i * 4 + 2] : bgra[i * 4];
            rgba[i * 4 + 3] = bgra[i * 4 + 3];
        }
        return rgba;
    }
    if (kind === 'bc6s') return new Uint8ClampedArray((await texBc6())(data.slice(), width, height));
    if (kind === 'rgba8') { rgba.set(data.subarray(0, n * 4)); return rgba; }
    if (kind === 'rgba16f' || kind === 'rgba32f') {
        if (kind === 'rgba16f' && typeof Float16Array === 'undefined') throw new Error('this browser has no Float16Array to read half floats');
        const copy = data.slice();
        return floatsToRgba(kind === 'rgba16f' ? new Float16Array(copy.buffer, 0, n * 4) : new Float32Array(copy.buffer, 0, n * 4));
    }
    for (let i = 0; i < n; i++) {
        if (kind === 'bgra8') {
            rgba[i * 4] = data[i * 4 + 2]; rgba[i * 4 + 1] = data[i * 4 + 1]; rgba[i * 4 + 2] = data[i * 4]; rgba[i * 4 + 3] = data[i * 4 + 3];
        } else if (kind === 'rg8') {
            rgba[i * 4] = data[i * 2]; rgba[i * 4 + 1] = data[i * 2 + 1]; rgba[i * 4 + 3] = 255;
        } else { // r8, gray
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = data[i]; rgba[i * 4 + 3] = 255;
        }
    }
    return rgba;
}

async function rgbaUrl(rgba, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed')), 'image/png'));
    return URL.createObjectURL(blob);
}

// The file's levels as pages ({ width, height, label, rgba() }) and what it holds:
// @flighthq/texture-formats' layout, else ImageMagick's images
async function readDds(bytes) {
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'DDS ') throw new Error('Not a DirectDraw Surface (no "DDS " signature)');
    const lib = await ddsLib();
    const c = lib.parseDds(bytes);
    if (c) {
        const [name, kind] = FORMATS[c.format] || [c.format, null];
        const pages = c.levels.map((l, i) => {
            // layer → face → mip, as Direct3D's subresources
            const mip = i % c.mipLevels;
            const face = Math.floor(i / c.mipLevels) % c.faces;
            const layer = Math.floor(i / (c.mipLevels * c.faces));
            const where = [c.layers > 1 && `Layer ${layer}`, c.faces > 1 && `${FACES[face]} face`, c.mipLevels > 1 && `mip ${mip}`].filter(Boolean).join(', ');
            return {
                width: l.width, height: l.height, label: where || name,
                rgba: () => {
                    if (!kind) throw new Error(`${name} is not decoded here`);
                    return levelRgba(lib, kind, bytes.subarray(l.byteOffset, l.byteOffset + l.byteLength), l.width, l.height);
                },
            };
        });
        const label = `DirectDraw Surface: ${name}, ${c.width}×${c.height}`
            + (c.mipLevels > 1 ? `, ${c.mipLevels} mips` : '')
            + (c.faces > 1 ? ', cube map' : '')
            + (c.layers > 1 ? `, ${c.layers} layers` : '')
            + (!kind ? ' (not decoded: no decoder here reads it)' : /HDR/.test(name) ? ' (clamped to 0–1)' : '');
        return { pages, label, width: c.width, height: c.height };
    }
    const why = (lib.explain(bytes) || {}).reason || 'not read';
    const { ImageMagick, MagickFormat } = await magick().catch(() => ({}));
    if (!ImageMagick) throw new Error(`The DDS's layout: ${why}`);
    let images;
    try {
        images = ImageMagick.readCollection(bytes, MagickFormat.Dds, coll => coll.map(image => {
            image.depth = 8;
            return { width: image.width, height: image.height, data: image.write(MagickFormat.Rgba, d => d.slice()) };
        }));
    } catch (err) {
        throw new Error(`Neither @flighthq/texture-formats (${why}) nor ImageMagick (${err.message}) reads this DDS`);
    }
    if (!images.length) throw new Error('The file holds no image');
    const pages = images.map((e, i) => ({
        width: e.width, height: e.height,
        label: images.length === 6 ? `${FACES[i]} face` : `Image ${i + 1}`,
        rgba: async () => new Uint8ClampedArray(e.data.buffer, e.data.byteOffset, e.width * e.height * 4),
    }));
    const label = `DirectDraw Surface (read by ImageMagick), ${images[0].width}×${images[0].height}`
        + (images.length === 6 ? ', cube map' : images.length > 1 ? `, ${images.length} images` : '');
    return { pages, label, width: images[0].width, height: images[0].height };
}

async function ddsFile(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const d = await readDds(new Uint8Array(await resp.arrayBuffer()));
            d.png = new Map(); // `${page}:${opaque}` -> Promise<blob URL>
            return d;
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('DDS decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => d.png.forEach(u => u.then(x => URL.revokeObjectURL(x)).catch(() => {}))).catch(() => {});
        }
    }
    return p;
}

// Page `page` (a layer's face's mip) as { url, pages: [{ width, height, label }], page },
// for addTiffPager; `opaque` drops the alpha, showing the colors under it
async function ddsPage(url, page = 0, opaque = false) {
    const d = await ddsFile(url);
    const n = Math.max(0, Math.min(d.pages.length - 1, page));
    const key = `${n}:${opaque}`;
    let png = d.png.get(key);
    if (!png) {
        png = (async () => {
            const e = d.pages[n];
            let rgba = await e.rgba();
            if (opaque) {
                rgba = new Uint8ClampedArray(rgba);
                for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
            }
            return rgbaUrl(rgba, e.width, e.height);
        })();
        d.png.set(key, png);
        png.catch(() => d.png.delete(key));
    }
    const pages = d.pages.map(e => ({ width: e.width, height: e.height, label: e.label }));
    return { url: await png, pages, page: n };
}

// { url (the first level, as a PNG blob URL), label }
async function ddsImage(url) {
    const d = await ddsFile(url);
    return { url: (await ddsPage(url, 0)).url, label: d.label };
}

// The viewer's <img> for a DDS: what it holds, buttons to turn its layers, faces
// and mips (each shown as large as the first, pixels kept square), the alpha on or off
function addDdsControls(root, img, url) {
    root.style.position = 'relative';
    ddsFile(url).then(d => {
        img.title = d.label;
        let page = 0;
        let opaque = false;
        // a smaller mip blown up to the texture's size
        img.addEventListener('load', () => {
            const small = img.naturalWidth < d.width;
            img.style.imageRendering = small ? 'pixelated' : '';
            img.style.width = small ? `${d.width}px` : '';
        });
        const pageOf = (u, n) => { page = n; return ddsPage(u, n, opaque); };
        let bar = addTiffPager(root, img, url, d.pages, pageOf);
        if (!bar) {
            bar = document.createElement('div');
            bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:4px;align-items:center;z-index:1;'
                + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 4px;font:12px sans-serif;';
            root.appendChild(bar);
        }
        const alpha = document.createElement('button');
        alpha.style.cssText = 'background:none;color:inherit;border:1px solid rgba(255,255,255,0.4);border-radius:3px;font:inherit;cursor:pointer;padding:1px 6px;margin-left:4px;';
        const label = () => {
            alpha.textContent = opaque ? 'RGB' : 'RGBA';
            alpha.title = opaque ? 'Alpha ignored (the colors under it); click to apply it' : 'Alpha applied; click to ignore it';
        };
        label();
        alpha.onclick = async () => {
            opaque = !opaque;
            label();
            const shown = page;
            const r = await ddsPage(url, shown, opaque).catch(() => null);
            if (r && shown === page) img.src = r.url;
        };
        bar.appendChild(alpha);
    }).catch(err => { img.title = `Could not read the DDS: ${err.message}`; });
}

module.exports = { isDdsName, ddsFile, ddsImage, ddsPage, addDdsControls };
