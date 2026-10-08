// --- CorelDRAW drawings (.cdr, .cdt; .cmx, Corel Presentation Exchange) to SVG ---
// No browser shows them; here LibreOffice, compiled to WebAssembly, opens them
// with libcdr, as LibreOffice Draw does, and saves the first page as SVG, which
// any <img> shows. LibreOffice's SVG export only ever writes a drawing's first
// page, so the others are PNGs (at the size the converter picks), drawn
// when the pager turns to them (several pages come as a zip, which JSZip opens). The build is @anasse84/zentopdf-wasm's (the one on npm that
// has libcdr in it), driven by @matbee/libreoffice-converter's worker, whose
// LibreOfficeKit calls that build keeps. libcdr reads CorelDRAW 7 to 2021
// (RIFF "CDR7".."CDRB"..., and the zips of X4 and later) and CMX; not older
// files (CorelDRAW 3's "CDRX" among them), as LibreOffice can't either. The
// build is large (some 50 MB, brotli'd, from jsDelivr, which the browser can't
// unpack itself: brotli-dec-wasm does), so it is fetched only when a drawing is
// opened, once; no thumbnails. .cdr is also an Apple disk image's, .cdt an
// Amstrad tape's and .cmx a Fuchsia component manifest's: a file is CorelDRAW's
// only if it starts "RIFF" and "CDR"/"cdr"/"CMX" (or, a .cdr or .cdt, is a zip).
const { createLogger } = require('./debug');

const log = createLogger('CDR');
const CDR_RE = /\.(cdr|cdt|cmx)$/i;
const ZIP_RE = /\.(cdr|cdt)$/i;
const CONVERTER = 'https://esm.sh/@matbee/libreoffice-converter@2.7.2/browser';
// raw: the worker as published, which runs as a blob: worker (a worker must be same-origin)
const CONVERTER_WORKER = 'https://esm.sh/@matbee/libreoffice-converter@2.7.2/dist/browser.worker.global.js?raw';
const SOFFICE = 'https://cdn.jsdelivr.net/npm/@anasse84/zentopdf-wasm@3.0.8/assets/';
const BROTLI = 'https://cdn.jsdelivr.net/npm/brotli-dec-wasm@2.3.2/pkg/brotli_dec_wasm.js';
const JSZIP = 'https://esm.sh/jszip@3.10.1';

let converterPromise = null;
let queue = Promise.resolve(); // one document at a time
const converted = new Map(); // source URL -> Promise<{ url, label, pages, urls }>

// Whether the name is one a CorelDRAW drawing goes by (it is one only once its
// bytes say so, see isCdr)
function isCdrName(name) {
    return CDR_RE.test(name || '');
}

// Bytes that start a CorelDRAW drawing or CMX file (name: a zip counts only for .cdr and .cdt)
function isCdr(bytes, name) {
    if (bytes.length < 12) return false;
    const s = String.fromCharCode(...bytes.subarray(0, 12));
    if (s.startsWith('RIFF') && /^(CDR|cdr|CMX)/.test(s.slice(8))) return true;
    return ZIP_RE.test(name || '') && s.startsWith('PK\x03\x04');
}

// Whether the file at url is a CorelDRAW drawing (not a disk image, tape, manifest...)
async function isCdrUrl(url, name) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isCdr(value, name);
}

// What the file says it is, for the tooltip
function describe(bytes) {
    const s = String.fromCharCode(...bytes.subarray(0, 12));
    if (s.startsWith('PK')) return 'CorelDRAW drawing (X4 or later)';
    if (s.slice(8, 11) === 'CMX') return 'Corel Presentation Exchange (CMX)';
    const v = s[11];
    const version = { 7: '7', 8: '8', 9: '9', A: '10', B: '11', C: '12', D: 'X3' }[v.toUpperCase()];
    return version ? `CorelDRAW ${version} drawing` : 'CorelDRAW drawing';
}

// A blob: URL of the file at url, unbrotli'd a few MB at a time
async function unbrotli(url, type) {
    const { default: init, DecompressStream } = await import(BROTLI);
    await init();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const input = new Uint8Array(await resp.arrayBuffer());
    const stream = new DecompressStream();
    const parts = [];
    try {
        for (let at = 0; ;) {
            const r = stream.decompress(input.subarray(at), 1 << 22);
            parts.push(r.buf);
            at += r.input_offset;
            if (r.code === 1) break; // done
            if (r.code === 2 && at >= input.length) throw new Error(`${url} ends early`);
        }
    } finally {
        stream.free();
    }
    return URL.createObjectURL(new Blob(parts, { type }));
}

async function blobUrlOf(url, type) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return URL.createObjectURL(new Blob([await resp.arrayBuffer()], { type }));
}

function converter() {
    if (!converterPromise) {
        converterPromise = (async () => {
            const [{ WorkerBrowserConverter }, browserWorkerJs, sofficeJs, sofficeWasm, sofficeData] = await Promise.all([
                import(CONVERTER),
                blobUrlOf(CONVERTER_WORKER, 'text/javascript'),
                blobUrlOf(SOFFICE + 'soffice.js', 'text/javascript'), // its threads' script too
                unbrotli(SOFFICE + 'soffice.wasm.br', 'application/wasm'),
                unbrotli(SOFFICE + 'soffice.data.br', 'application/octet-stream'),
            ]);
            const c = new WorkerBrowserConverter({ browserWorkerJs, sofficeJs, sofficeWasm, sofficeData, sofficeWorkerJs: sofficeJs });
            await c.initialize();
            // LibreOffice holds what it needs of these now; the script stays, for its threads
            URL.revokeObjectURL(sofficeWasm);
            URL.revokeObjectURL(sofficeData);
            return c;
        })();
        converterPromise.catch(err => { converterPromise = null; log.warn('LibreOffice failed to load:', err); });
    }
    return converterPromise;
}

// The drawing's pages as SVG or PNG: [Uint8Array]. The converter knows no
// CorelDRAW (it would allow PDF alone): it is told the document is a drawing
// (.odg), and LibreOffice tells the format by its bytes, as it always does. A
// drawing of several pages comes back as a zip of page_1, page_2...
async function convertPages(bytes, format) {
    const c = await converter();
    const run = queue.then(() => c.convert(bytes, { inputFormat: 'odg', outputFormat: format }, 'drawing.odg'));
    queue = run.catch(() => {});
    const out = (await run).data;
    if (!(out[0] === 0x50 && out[1] === 0x4b)) return [out];
    const { default: JSZip } = await import(JSZIP);
    const zip = await JSZip.loadAsync(out);
    const names = Object.keys(zip.files).filter(n => n.endsWith('.' + format))
        .sort((a, b) => (+(a.match(/\d+/) || [0])[0]) - (+(b.match(/\d+/) || [0])[0]));
    return Promise.all(names.map(n => zip.file(n).async('uint8array')));
}

// The CorelDRAW drawing at url: { url (a blob: URL of the first page's SVG),
// label, pages ([{ label }], for the pager), bytes, urls (each page's blob: URL, once drawn) }
function cdrImage(url, name) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (!isCdr(bytes, name)) throw new Error('not a CorelDRAW drawing');
            const svgs = await convertPages(bytes, 'svg'); // as many as there are pages, each the first's
            const label = describe(bytes);
            const urls = [URL.createObjectURL(new Blob([svgs[0]], { type: 'image/svg+xml' }))];
            const pages = svgs.map((_, i) => ({ label: `${label}, page ${i + 1}${i ? ' (PNG)' : ''}` }));
            return { url: urls[0], label, pages, bytes, urls };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('CorelDRAW conversion failed:', err); });
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => d.urls.forEach(u => URL.revokeObjectURL(u))).catch(() => {});
        }
    }
    return p;
}

// One page of the drawing at url (for addTiffPager): { url }; the first the
// SVG, the others PNGs, all drawn the first time one is asked for
async function cdrPage(url, n) {
    const d = await cdrImage(url);
    if (n === 0) return { url: d.urls[0] };
    if (!d.pngs) {
        d.pngs = convertPages(d.bytes, 'png').then(pngs => {
            pngs.forEach((png, i) => { if (i) d.urls[i] = URL.createObjectURL(new Blob([png], { type: 'image/png' })); });
        });
        d.pngs.catch(() => { d.pngs = null; });
    }
    await d.pngs;
    if (!d.urls[n]) throw new Error(`no page ${n + 1}`);
    return { url: d.urls[n] };
}

module.exports = { isCdrName, isCdr, isCdrUrl, cdrImage, cdrPage };
