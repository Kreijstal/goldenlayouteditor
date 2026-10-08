// --- Windows metafiles (.wmf, .emf; gzipped, .wmz, .emz) to SVG ---
// Windows' own vector pictures: recorded GDI calls, 16-bit (WMF, with or
// without the Aldus "placeable" header that gives it a size) or 32-bit (EMF,
// whose comment records may hold GDI+'s, EMF+). Office, Visio and the
// clipboard are full of them; no browser shows them. Here they become SVG,
// which any <img> shows: emf-converter (github.com/ChristopherVR/emf-converter,
// Apache-2.0; its browser build, some 2 MB, from jsDelivr when one is first
// shown) replays the records as Windows does. Its limits are this viewer's:
// text is drawn in the browser's fonts (not the metafile's TrueType ones),
// and a few GDI+ image effects differ from Windows'.
const { createLogger } = require('./debug');

const log = createLogger('WMF');
const EMF_CONVERTER = 'https://cdn.jsdelivr.net/npm/emf-converter@4.17.0/dist/browser.mjs';
const WMF_RE = /\.(wmf|emf|wmz|emz)$/i;

let converterPromise = null;
const converted = new Map(); // source URL -> Promise<{ url, label }>

function isWmfName(name) {
    return WMF_RE.test(name || '');
}

// What the bytes are: 'placeable' (an Aldus placeable WMF), 'wmf', 'emf', 'emf+'
// (an EMF whose first record after the header is an EMF+ comment), or '' (none)
function metafileKind(b) {
    if (b.length < 18) return '';
    const u32 = at => (b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24) >>> 0;
    if (u32(0) === 0x9ac6cdd7) return 'placeable';
    // a WMF header: type 1 (memory) or 2 (disk), 9 words long, version 0x100 or 0x300
    if ((b[0] === 1 || b[0] === 2) && b[1] === 0 && b[2] === 9 && b[3] === 0 && b[5] <= 3) return 'wmf';
    // EMR_HEADER, then " EMF" at 40
    if (u32(0) === 1 && b.length >= 88 && u32(40) === 0x464d4520) {
        const next = u32(4);
        // EMR_COMMENT (70) whose data starts "EMF+"
        return b.length >= next + 16 && u32(next) === 70 && u32(next + 12) === 0x2b464d45 ? 'emf+' : 'emf';
    }
    return '';
}

function converter() {
    if (!converterPromise) {
        converterPromise = import(EMF_CONVERTER);
        converterPromise.catch(() => { converterPromise = null; });
    }
    return converterPromise;
}

async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The picture's SVG (a string) and what it is
async function wmfToSvg(bytes) {
    // .wmz/.emz (or any metafile) gzipped
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (gzipped) bytes = await gunzip(bytes);
    const kind = metafileKind(bytes);
    if (!kind) throw new Error('Not a Windows metafile');
    const { convertMetafileToSvg } = await converter();
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const svg = await convertMetafileToSvg(buf);
    if (!svg) throw new Error('emf-converter could not draw this metafile');
    const name = { placeable: 'Windows Metafile (placeable)', wmf: 'Windows Metafile', emf: 'Enhanced Metafile', 'emf+': 'Enhanced Metafile (EMF+)' }[kind];
    const size = svg.match(/<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/);
    return { svg, label: name + (gzipped ? ', gzipped' : '') + (size ? `, ${Math.round(size[1])}×${Math.round(size[2])}` : '') };
}

// { url: blob URL of the SVG, label }
function wmfImage(url) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const { svg, label } = await wmfToSvg(new Uint8Array(await resp.arrayBuffer()));
            return { url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), label };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('Metafile decode failed:', err); });
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isWmfName, metafileKind, wmfToSvg, wmfImage };
