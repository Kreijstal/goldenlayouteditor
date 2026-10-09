// Camera raw files to pictures, for the image viewer (src/raw.js). LibRaw
// (0.22, libraw.org) as WebAssembly (libraw-wasm 1.6.0, built with LCMS and
// libjpeg, its .wasm fetched from jsDelivr the first time one is opened)
// reads Adobe DNG (lossless and lossy), Canon CRW (CIFF), CR2 and CR3, Nikon
// NEF/NRW, Sony ARW/SRF/SR2, Olympus ORF, Panasonic RW2, Fujifilm RAF, Pentax
// PEF, Samsung SRW and the others LibRaw knows. A file is opened with the
// options of a decode (dcraw's: the camera's white balance, half size...),
// then demosaiced and turned to 8-bit sRGB by LibRaw's dcraw_process, as
// dcraw_emu does, and becomes a PNG; or its embedded preview (a JPEG, as it
// is, a bitmap as a JPEG) is taken out without the raw data, turned as the
// camera was held (LibRaw's flip; previews are stored as the sensor saw them)
// and, for a thumbnail, made no bigger than size on its long side.
//   → { id, bytes, what: 'image' | 'thumb', settings, size }
//   ← { id, result: { image (PNG or JPEG bytes), type, width, height, meta } } | { id, error }
// meta: LibRaw's metadata (camera, exposure, sizes, colour data...)
const DIST = 'https://cdn.jsdelivr.net/npm/libraw-wasm@1.6.0/dist/';

let loading = null;

// LibRaw's module. It runs threads (pthreads, as workers of their own): a
// worker can't start one from another origin's script, so each starts from
// a blob: that imports jsDelivr's.
function load() {
    if (!loading) {
        loading = import(DIST + 'libraw.js').then(m => m.default({
            mainScriptUrlOrBlob: new Blob([`import ${JSON.stringify(DIST + 'libraw.js')};`], { type: 'text/javascript' }),
        }));
        loading.catch(() => { loading = null; });
    }
    return loading;
}

// An 8-bit RGB (or gray) image of LibRaw's drawn on a canvas
function toCanvas(img) {
    const n = img.width * img.height;
    const rgba = new Uint8ClampedArray(n * 4);
    const d = img.data, k = img.colors;
    for (let i = 0, p = 0, o = 0; i < n; i++, p += k, o += 4) {
        rgba[o] = d[p];
        rgba[o + 1] = d[p + (k > 1 ? 1 : 0)];
        rgba[o + 2] = d[p + (k > 2 ? 2 : 0)];
        rgba[o + 3] = 255;
    }
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d').putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
    return canvas;
}

async function encode(canvas, type, quality) {
    return new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer());
}

// LibRaw's exceptions reach JavaScript as objects (or pointers) with the message somewhere
function message(lib, err) {
    if (typeof err === 'number' && lib.getExceptionMessage) return lib.getExceptionMessage(err).join(': ');
    if (err && err.message) return err.message;
    return String(err);
}

// LibRaw's flip (dcraw's: 3 half a turn, 5 a quarter counterclockwise, 6 clockwise)
// to a canvas transform: the drawn width and height and the turn in quarters
const TURNS = { 3: 2, 5: 3, 6: 1 };

// An embedded preview (an encoded JPEG of width × height as stored) turned by
// flip and no bigger than size (0: as big as it is): the JPEG as it is when
// neither is needed, else a JPEG drawn again. Some previews carry an Exif
// orientation of their own, which the browser follows (Chromium's
// createImageBitmap too, whatever it is asked): one that came out turned a
// quarter is not turned again. (A half turn can't be told so: it is made.)
async function preview(jpeg, width, height, flip, size) {
    const blob = new Blob([jpeg], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    let turn = TURNS[flip] || 0;
    if (turn % 2 && width !== height && bitmap.width === height && bitmap.height === width) turn = 0;
    const scale = size ? Math.min(1, size / Math.max(bitmap.width, bitmap.height)) : 1;
    if (!turn && scale === 1) {
        const out = { image: jpeg, width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return out;
    }
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    const [cw, ch] = turn % 2 ? [h, w] : [w, h];
    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext('2d');
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(turn * Math.PI / 2);
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
    bitmap.close();
    return { image: await encode(canvas, 'image/jpeg', 0.92), width: cw, height: ch };
}

async function decode(bytes, what, settings, size) {
    const lib = await load();
    const raw = new lib.LibRaw();
    try {
        raw.open(bytes, settings || {});
        const meta = raw.metadata(false);
        if (what === 'thumb') {
            const t = raw.thumbnailData();
            if (!t || !t.data || !t.data.length) throw new Error('no embedded preview');
            if (t.format === 'bitmap') {
                // a bitmap preview (8-bit RGB): a JPEG of it, to turn and scale as the others
                t.data = await encode(toCanvas({ data: t.data, width: t.width, height: t.height, colors: 3 }), 'image/jpeg', 0.92);
            } else if (t.format !== 'jpeg') {
                throw new Error(`embedded preview in a format not shown (${t.format})`);
            }
            return { ...await preview(t.data, t.width, t.height, meta.flip, size || 0), type: 'image/jpeg', meta };
        }
        const img = raw.imageData();
        if (!img || img.bits !== 8) throw new Error('LibRaw gave no 8-bit image');
        return { image: await encode(toCanvas(img), 'image/png'), type: 'image/png', width: img.width, height: img.height, meta };
    } catch (err) {
        throw new Error(message(lib, err));
    } finally {
        raw.delete();
    }
}

self.onmessage = async ({ data }) => {
    try {
        const result = await decode(new Uint8Array(data.bytes), data.what, data.settings, data.size);
        self.postMessage({ id: data.id, result }, [result.image.buffer]);
    } catch (err) {
        self.postMessage({ id: data.id, error: err && err.message || String(err) });
    }
};
