// --- CALS raster (.cals, .ct1; a .cal or .ras that is one) to PNG ---
// MIL-R-28002 Type 1, the US military's (and engineering drawings') scanned
// page: up to 16 128-byte text records ("srcdocid:", "rtype: 1", "rorient:",
// "rpelcnt:", "rdensty:"...), then the bilevel pixels, CCITT Group 4. No
// browser shows it; here GDAL's CALS driver (gdal3.js, GDAL compiled to
// WebAssembly by Bugra Sari, loaded from jsDelivr, some 40 MB, when one is
// first shown) reads it and writes a PNG, which any <img> shows. Not
// ImageMagick's (src/pict.js has it loaded): its CALS coder fails in
// WebAssembly (its Group 4 reader hands libtiff an integer for a resolution
// libtiff reads as a double, -nan: "Bad value -nan for XResolution"), and
// natively it draws the page white on black. .cal is also a calendar's (and
// others'), .ras a Sun raster's: one is CALS only if its bytes say so (isCals).
const { createLogger } = require('./debug');

const log = createLogger('CALS');
const GDAL = 'https://cdn.jsdelivr.net/npm/gdal3.js@2.8.1/dist/package';
const CALS_RE = /\.(cals|ct1)$/i;
// the names a CALS raster shares with other files
const MAYBE_RE = /\.(cal|ras)$/i;
// the record a CALS file starts with (ImageMagick's test: the header's first record)
const HEADER_RE = /^(version: MIL-STD-1840|srcdocid:|rorient:)/;

let gdalPromise = null;
const converted = new Map(); // source URL -> Promise<{ url, width, height, label }>

// Whether the name is one only CALS goes by (a .cal or .ras is one only once
// its bytes say so, see isCalsMaybeName)
function isCalsName(name) {
    return CALS_RE.test(name || '');
}

// A name CALS shares with other files (.cal, a calendar's; .ras, a Sun raster's)
function isCalsMaybeName(name) {
    return MAYBE_RE.test(name || '');
}

// Bytes that start a CALS raster
function isCals(bytes) {
    let s = '';
    for (let i = 0; i < Math.min(bytes.length, 32); i++) s += String.fromCharCode(bytes[i]);
    return HEADER_RE.test(s);
}

// Whether the file at url is a CALS raster (for a .cal or .ras)
async function isCalsUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first record's start: read until there is enough
    const reader = resp.body.getReader();
    const parts = [];
    let size = 0;
    while (size < 32) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    return isCals(bytes);
}

// gdal3.js on the page (its UMD build, initGdalJs), GDAL itself on this thread
// (its worker can't be started from another origin)
function gdal() {
    if (!gdalPromise) {
        gdalPromise = (async () => {
            if (!window.initGdalJs) {
                await new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = GDAL + '/gdal3.js';
                    s.onload = () => (window.initGdalJs ? resolve() : reject(new Error('gdal3.js did not load')));
                    s.onerror = () => reject(new Error('Could not load ' + s.src));
                    document.head.appendChild(s);
                });
            }
            return window.initGdalJs({ path: GDAL, useWorker: false });
        })();
        gdalPromise.catch(err => { gdalPromise = null; log.warn('GDAL failed to load:', err); });
    }
    return gdalPromise;
}

// { png: Uint8Array, width, height, label }
async function calsDecode(bytes, name) {
    if (!isCals(bytes)) throw new Error('not a CALS raster');
    const Gdal = await gdal();
    const opened = await Gdal.open(new File([bytes], name || 'page.cal'));
    const ds = opened.datasets[0];
    if (!ds) throw new Error((opened.errors && opened.errors[0] && opened.errors[0].message) || 'GDAL could not read it');
    try {
        const info = await Gdal.gdalinfo(ds);
        const [width, height] = info.size;
        // its two colors, white (0) and black (1), as gray
        const out = await Gdal.gdal_translate(ds, ['-of', 'PNG', '-expand', 'gray']);
        const png = await Gdal.getFileBytes(out);
        return { png, width, height, label: `CALS raster, Type 1, ${width}×${height}` };
    } finally {
        Gdal.close(ds);
    }
}

// The CALS raster at url as a PNG: { url (a blob: URL), width, height, label }
function calsImage(url, name) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = await calsDecode(new Uint8Array(await resp.arrayBuffer()), name);
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height, label: r.label };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('CALS decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isCalsName, isCalsMaybeName, isCals, isCalsUrl, calsDecode, calsImage };
