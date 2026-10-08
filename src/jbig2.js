// --- JBIG2 bilevel images (.jb2, .jbig2) to PNG ---
// No browser shows them. MuPDF (mupdf.js, the copy the PDF viewer loads from
// jsDelivr) opens a standalone JBIG2 file, sequential or random-access
// organisation, as an image document of one page per JBIG2 page, decoded by
// jbig2dec; each page's image is taken at its own size (not the page's size at
// the file's resolution) and shown as a PNG, black on white. The first page is
// decoded when the file is opened (and is its thumbnail), the others when the
// pager turns to them. Not read: an embedded stream without the file header
// (as a PDF holds them, its globals apart), and what jbig2dec doesn't decode
// (intermediate generic regions, for one).
const { createLogger } = require('./debug');

const log = createLogger('JBIG2');
const JBIG2_RE = /\.(jb2|jbig2)$/i;
const MUPDF = 'https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js';
// The file header's ID string (T.88 D.4.1)
const MAGIC = [0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a];

const opened = new Map(); // URL -> Promise<{ url, label, pages, urls, draw }>

// Whether the name is one a JBIG2 file goes by
function isJbig2Name(name) {
    return JBIG2_RE.test(name || '');
}

// The JBIG2 file at url: { url (blob: URL of the first page's PNG), label,
// pages: [{ width, height, label }] (for addTiffPager), ... }
function jbig2Image(url) {
    let p = opened.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (!MAGIC.every((b, i) => bytes[i] === b)) throw new Error('not a JBIG2 file (no file header)');
            const mupdf = await import(MUPDF);
            const doc = mupdf.Document.openDocument(bytes, 'image/jbig2');
            const count = doc.countPages();
            if (!count) throw new Error('JBIG2 file with no pages');
            const pages = [];
            for (let i = 0; i < count; i++) pages.push({ label: `JBIG2 image, page ${i + 1}` });
            const urls = [];
            const drawing = [];
            // Page n as a PNG, decoded once: the image the page draws, at its own pixels
            const draw = (n) => {
                if (!drawing[n]) {
                    drawing[n] = (async () => {
                        let image = null;
                        doc.loadPage(n).run(new mupdf.Device({ fillImage(img) { image = img; } }), mupdf.Matrix.identity);
                        if (!image) throw new Error(`page ${n + 1} has no image`);
                        const pix = image.toPixmap();
                        Object.assign(pages[n], { width: pix.getWidth(), height: pix.getHeight() });
                        urls[n] = URL.createObjectURL(new Blob([pix.asPNG()], { type: 'image/png' }));
                        return urls[n];
                    })();
                    drawing[n].catch(err => { drawing[n] = null; log.warn(`page ${n + 1}:`, err); });
                }
                return drawing[n];
            };
            await draw(0);
            const { width, height } = pages[0];
            const label = count === 1 ? `JBIG2 image, ${width}×${height}` : `JBIG2 image, ${count} pages`;
            return { url: urls[0], label, pages, urls, draw };
        })();
        opened.set(url, p);
        p.catch(err => { opened.delete(url); log.warn('JBIG2 failed:', err); });
        if (opened.size > 64) {
            const [oldUrl, old] = opened.entries().next().value;
            opened.delete(oldUrl);
            old.then(d => d.urls.forEach(u => u && URL.revokeObjectURL(u))).catch(() => {});
        }
    }
    return p;
}

// One page of the file at url (for addTiffPager): { url }
async function jbig2Page(url, n) {
    const d = await opened.get(url);
    if (!d) throw new Error('not opened');
    if (!d.pages[n]) throw new Error(`no page ${n + 1}`);
    return { url: await d.draw(n) };
}

module.exports = { isJbig2Name, jbig2Image, jbig2Page };
