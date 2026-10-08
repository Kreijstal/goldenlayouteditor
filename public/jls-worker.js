// JPEG-LS to samples, for the image viewer (src/jls.js). CharLS, the JPEG-LS
// codec (github.com/team-charls/charls), as WebAssembly (@cornerstonejs/codec-charls,
// the decoder only, its .wasm fetched from jsDelivr the first time one is
// opened) reads lossless and near-lossless (NEAR > 0) scans of 2 to 16 bits a
// sample, one component or several, interleaved by line, by sample or not at
// all, HP's color transforms undone. Its samples come out one plane after
// another when a scan isn't interleaved ('none'), else pixel by pixel; here
// always pixel by pixel. Not read (CharLS's error said): subsampled components,
// several scans of a frame CharLS doesn't put together.
//   → { id, bytes }   ← { id, result: { width, height, bits, components, interleave, near, samples } } | { id, error }
// samples: Uint8Array (8 bits or fewer) or Uint16Array, components to a pixel
const DIST = 'https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-charls@1.2.7/dist/';
importScripts(DIST + 'charlswasm_decode.js');

const INTERLEAVE = ['none', 'line', 'sample'];

let loading = null;

function load() {
    if (!loading) {
        loading = self.CharLSWASM({ locateFile: name => DIST + name });
        loading.catch(() => { loading = null; });
    }
    return loading;
}

// The decoded frame of the bitstream in decoder's buffer
function read(decoder, bytes) {
    decoder.getEncodedBuffer(bytes.length).set(bytes);
    decoder.decode();
    const { width, height, bitsPerSample: bits, componentCount: components } = decoder.getFrameInfo();
    const interleave = decoder.getInterleaveMode();
    const near = decoder.getNearLossless();
    const out = decoder.getDecodedBuffer();
    // more than 8 bits: two bytes a sample, little-endian
    const stored = bits > 8
        ? new Uint16Array(out.buffer.slice(out.byteOffset, out.byteOffset + width * height * components * 2))
        : new Uint8Array(out.buffer.slice(out.byteOffset, out.byteOffset + width * height * components));
    let samples = stored;
    if (interleave === 0 && components > 1) {
        // planes to pixels
        const n = width * height;
        samples = new stored.constructor(stored.length);
        for (let c = 0; c < components; c++) {
            for (let i = 0, o = c; i < n; i++, o += components) samples[o] = stored[c * n + i];
        }
    }
    return { width, height, bits, components, interleave: INTERLEAVE[interleave] || String(interleave), near, samples };
}

async function decode(bytes) {
    const charls = await load();
    const decoder = new charls.JpegLSDecoder();
    try {
        return read(decoder, bytes);
    } catch (err) {
        // CharLS's exceptions reach JavaScript as pointers: its message
        throw new Error(typeof err === 'number' ? charls.getExceptionMessage(err) : err && err.message || String(err));
    } finally {
        decoder.delete();
    }
}

self.onmessage = async ({ data }) => {
    try {
        const result = await decode(new Uint8Array(data.bytes));
        self.postMessage({ id: data.id, result }, [result.samples.buffer]);
    } catch (err) {
        self.postMessage({ id: data.id, error: err && err.message || String(err) });
    }
};
