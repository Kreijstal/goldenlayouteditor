// JPEG 2000 to PNG, for the image viewer (src/jp2.js): no browser shows JPEG
// 2000 any more, so OpenJPEG (public/jp2-decode.mjs) decodes it here.
//   → { id, bytes }   ← { id, result: { png, width, height } } | { id, error }
import { jp2Rgba } from './jp2-decode.mjs';

self.onmessage = async ({ data }) => {
    const { id } = data;
    try {
        const { rgba, width, height } = await jp2Rgba(new Uint8Array(data.bytes));
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
        const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        self.postMessage({ id, result: { png, width, height } }, [png.buffer]);
    } catch (e) {
        self.postMessage({ id, error: e && e.message ? e.message : String(e) });
    }
};
