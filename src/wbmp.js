// --- Wireless Bitmaps (.wbmp) to PNG ---
// WAP's pictures for phones' screens: a type (0, the only one there is: black
// and white, no compression), a fixed header byte (0), the width and height as
// multi-byte integers (seven bits a byte, the top bit set on all but the last),
// then the rows, a bit a pixel (1 white), each padded to a byte. There is no
// magic number: a .wbmp is taken for one when its first bytes hold up. No
// browser shows it; here ImageMagick does (magick-wasm, the copy src/pict.js
// loads), written as a PNG for the image viewer and thumbnails.
const { createLogger } = require('./debug');
const { magick } = require('./pict');

const log = createLogger('WBMP');
const WBMP_RE = /\.wbmp$/i;

const converted = new Map(); // source URL -> Promise<{ url, width, height, label }>

function isWbmpName(name) {
    return WBMP_RE.test(name || '');
}

// Bytes that start as a level-0 WBMP does: type 0, a fixed header with no extension
// headers (its top bit clear), then a width and height of up to four bytes each
function isWbmp(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0 || (bytes[1] & 0x80)) return false;
    let p = 2;
    for (let n = 0; n < 2; n++) {
        let len = 0;
        while (p < bytes.length && (bytes[p] & 0x80) && len < 4) { p++; len++; }
        if (p >= bytes.length || len >= 4) return false;
        p++;
    }
    return true;
}

async function wbmpDecode(bytes) {
    if (!isWbmp(bytes)) throw new Error('not a WBMP file (type 0)');
    const { ImageMagick, MagickFormat } = await magick();
    return ImageMagick.read(bytes, MagickFormat.Wbmp, image => {
        const { width, height } = image;
        const png = image.write(MagickFormat.Png, data => data.slice());
        return { png, width, height, label: `WBMP (Wireless Bitmap), ${width}×${height}, black and white` };
    });
}

// The WBMP file at url as a PNG: { url (a blob: URL), width, height, label }
function wbmpImage(url) {
    let p = converted.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const r = await wbmpDecode(new Uint8Array(await resp.arrayBuffer()));
            return { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height, label: r.label };
        })();
        converted.set(url, p);
        p.catch(err => { converted.delete(url); log.warn('WBMP decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (converted.size > 64) {
            const [oldUrl, old] = converted.entries().next().value;
            converted.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isWbmpName, isWbmp, wbmpDecode, wbmpImage };
