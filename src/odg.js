// --- OpenDocument drawings (.odg; .otg, a template; .fodg, one flat XML file) to SVG ---
// No browser shows them; LibreOffice Draw's own files, opened by the same
// LibreOffice, compiled to WebAssembly, as CorelDRAW drawings are (src/cdr.js):
// the first page as SVG, the others as PNGs, drawn when the pager turns to
// them (all of them PNGs for a presentation saved as .odg, which LibreOffice's
// SVG export leaves blank; a page's background, which it leaves out, shows
// only on the PNGs). It is large (some 50 MB), fetched only when a drawing is opened, so
// thumbnails are the picture LibreOffice keeps in the zip,
// Thumbnails/thumbnail.png (JSZip reads it); a .fodg has none.
const { createLogger } = require('./debug');
const { drawingImage, drawingPage } = require('./cdr');

const log = createLogger('ODG');
const ODG_RE = /\.(odg|otg|fodg)$/i;
const ZIP_RE = /\.(odg|otg)$/i;
const JSZIP = 'https://esm.sh/jszip@3.10.1';

const thumbs = new Map(); // URL -> Promise<blob URL | null>

// Whether the name is one an OpenDocument drawing goes by
function isOdgName(name) {
    return ODG_RE.test(name || '');
}

// The file's mimetype: the zip's first entry, stored (or the flat file's
// office:mimetype); throws for one that is neither
function mimetype(bytes, name) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8192)); // a character a byte
    if (head.startsWith('PK\x03\x04')) {
        if (!ZIP_RE.test(name || '')) throw new Error('not an OpenDocument drawing');
        const size = bytes[18] | bytes[19] << 8; // its size, as it is stored, not compressed
        return head.slice(30, 38) === 'mimetype' ? head.slice(38, 38 + size) : '';
    }
    const m = head.match(/office:mimetype="([^"]*)"/);
    if (!m || !/office:document/.test(head)) throw new Error('not an OpenDocument drawing');
    return m[1];
}

// What the file says it is, for the tooltip
function describe(bytes, name) {
    const mime = mimetype(bytes, name);
    const flat = bytes[0] === 0x50 ? '' : 'flat ';
    if (/graphics-template$/.test(mime)) return `OpenDocument drawing template (${flat}${mime})`;
    if (/graphics$/.test(mime)) return `OpenDocument drawing (${flat}${mime})`;
    return `OpenDocument file${mime ? ` (${flat}${mime})` : ''}`;
}

// The drawing at url (see drawingImage in src/cdr.js). LibreOffice's SVG
// export draws a drawing's first page, but nothing of a presentation's (an
// .odg can be Impress's): that one's pages are all PNGs
function odgImage(url, name) {
    return drawingImage(url, bytes => describe(bytes, name), bytes => /graphics(-template)?$/.test(mimetype(bytes, name)));
}

const odgPage = drawingPage;

// A blob: URL of the picture LibreOffice stored in the drawing at url, or null (a .fodg, or none)
function odgThumbnail(url, name) {
    if (!ZIP_RE.test(name || '')) return Promise.resolve(null);
    let p = thumbs.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const { default: JSZip } = await import(JSZIP);
            const zip = await JSZip.loadAsync(await resp.arrayBuffer());
            const entry = zip.file('Thumbnails/thumbnail.png');
            if (!entry) return null;
            return URL.createObjectURL(new Blob([await entry.async('uint8array')], { type: 'image/png' }));
        })();
        thumbs.set(url, p);
        p.catch(err => { thumbs.delete(url); log.warn('OpenDocument thumbnail failed:', err); });
        if (thumbs.size > 64) {
            const [oldUrl, old] = thumbs.entries().next().value;
            thumbs.delete(oldUrl);
            old.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

module.exports = { isOdgName, odgImage, odgPage, odgThumbnail };
