// HEIF/HEIC to PNG, for the image viewer (src/heif.js), an image at a time.
// Only Safari shows HEIC, so libheif (libheif-js, libheif with libde265 built
// with Emscripten, the .wasm inlined) decodes it here. Every top-level image of
// the file is a page, the primary one first (a burst, a Live Photo's still, the
// frames of a collection); libheif assembles grids and overlays and applies the
// rotation, mirroring and crop the file asks for, and 10/12-bit images come out
// as 8-bit RGBA. Thumbnails, depth maps and alpha planes aren't pages; image
// sequences (.heics tracks) aren't read.
//   → { id, bytes, page }   ← { id, result: { pages: [{ width, height, label }], page, image, type } } | { id, error }
importScripts('https://cdn.jsdelivr.net/npm/libheif-js@1.23.5/libheif-wasm/libheif-bundle.js');

let heif = null;

// The file's top-level images, the primary one first, as { handle, label }
function listPages(images) {
    const pages = images.map((handle, i) => ({
        handle,
        label: handle.is_primary() ? 'Primary image' : `Image ${i + 1}`,
    }));
    const primary = pages.findIndex(p => p.handle.is_primary());
    if (primary > 0) pages.unshift(pages.splice(primary, 1)[0]);
    if (pages.length === 1) pages[0].label = 'Image';
    return pages;
}

function rgba(handle) {
    const width = handle.get_width(), height = handle.get_height();
    return new Promise((resolve, reject) => {
        handle.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, d => {
            if (d) resolve(d); else reject(new Error('libheif could not decode this image'));
        });
    });
}

self.onmessage = async ({ data }) => {
    const { id, page } = data;
    let decoder = null;
    try {
        if (!heif) heif = libheif();
        decoder = new heif.HeifDecoder();
        const pages = listPages(decoder.decode(new Uint8Array(data.bytes)));
        if (!pages.length) throw new Error('no images in this HEIF file (or none libheif reads)');
        const p = pages[Math.min(Math.max(page | 0, 0), pages.length - 1)];
        const { data: pixels, width, height } = await rgba(p.handle);
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
        const image = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        self.postMessage({
            id,
            result: {
                pages: pages.map(q => ({ width: q.handle.get_width(), height: q.handle.get_height(), label: q.label })),
                page: pages.indexOf(p),
                image,
                type: 'image/png',
            },
        }, [image.buffer]);
        pages.forEach(q => q.handle.free());
    } catch (e) {
        self.postMessage({ id, error: e && e.message ? e.message : String(e) });
    } finally {
        // the context holds the whole file; free it before the next one comes
        if (decoder && decoder.decoder) heif.heif_context_free(decoder.decoder);
    }
};
