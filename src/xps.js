// --- XPS and OpenXPS documents (.xps, .oxps) to PNG ---
// No browser shows them. dwf-viewer (loaded from jsDelivr when one is opened)
// reads the package, its FixedDocumentSequence and each FixedPage (DWFx, which
// it is written for, is XPS inside), and draws a page on a canvas: paths,
// glyphs in the fonts the file embeds, images the browser decodes (not the
// TIFF or HD Photo ones an XPS may hold). The first page is drawn when the
// file is opened (and is its thumbnail), the others when the pager turns to them.
// Right-to-left text (BidiLevel) reads backwards, and a document
// whose pages are named by absolute part names (PageContent Source="/Documents/1/
// Pages/1.fpage") is not shown at all: dwf-viewer 0.6.7 looks for them in the wrong place.
const { createLogger } = require('./debug');

const log = createLogger('XPS');
const XPS_RE = /\.(xps|oxps)$/i;
const DWF_VIEWER = 'https://cdn.jsdelivr.net/npm/dwf-viewer@0.6.7/dist/index.js';
const SCALE = 2; // a page is in 1/96 inch: drawn at 192 dpi
const MAX_SIDE = 4096;

const opened = new Map(); // URL -> Promise<{ url, label, pages, urls, draw }>

// Whether the name is one an XPS document goes by
function isXpsName(name) {
    return XPS_RE.test(name || '');
}

// The XPS document at url: { url (blob: URL of the first page's PNG), label,
// pages: [{ label }] (for addTiffPager), ... }; throws for one dwf-viewer
// finds no fixed pages in
function xpsImage(url, name) {
    let p = opened.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('not an XPS document (not a zip)');
            const dwf = await import(DWF_VIEWER);
            const doc = await dwf.openDwfDocument(bytes, { fileName: name });
            const fixed = doc.pageData.filter(pg => pg.kind === 'xps-fixed-page');
            if (!fixed.length) throw new Error('not an XPS document (no fixed pages)');
            const renderer = new dwf.PageRenderer(doc);
            const what = /\.oxps$/i.test(name || '') ? 'OpenXPS document' : 'XPS document';
            const label = `${what}, ${fixed.length} page${fixed.length === 1 ? '' : 's'}`;
            const urls = [];
            const drawing = [];
            // Page n as a PNG, drawn once
            const draw = (n) => {
                if (!drawing[n]) {
                    drawing[n] = (async () => {
                        const pg = fixed[n];
                        const scale = Math.min(SCALE, MAX_SIDE / Math.max(pg.width, pg.height));
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(pg.width * scale));
                        canvas.height = Math.max(1, Math.round(pg.height * scale));
                        // it fits the page inside a margin of 24 pixels: zoomed to fill the canvas instead
                        const zoom = (canvas.width / pg.width) / Math.min((canvas.width - 48) / pg.width, (canvas.height - 48) / pg.height);
                        const stats = await renderer.render(doc.pageData.indexOf(pg), canvas, { zoom, preferWebgl: false, preferWasm: false, lineWeightMode: 'physical' });
                        (stats.warnings || []).forEach(w => log.warn(`page ${n + 1}: ${w.message}`));
                        const png = await new Promise(res => canvas.toBlob(res, 'image/png'));
                        urls[n] = URL.createObjectURL(png);
                        return urls[n];
                    })();
                    drawing[n].catch(() => { drawing[n] = null; });
                }
                return drawing[n];
            };
            await draw(0);
            const pages = fixed.map((_, i) => ({ label: `${what}, page ${i + 1}` }));
            return { url: urls[0], label, pages, urls, draw };
        })();
        opened.set(url, p);
        p.catch(err => { opened.delete(url); log.warn('XPS failed:', err); });
        if (opened.size > 64) {
            const [oldUrl, old] = opened.entries().next().value;
            opened.delete(oldUrl);
            old.then(d => d.urls.forEach(u => u && URL.revokeObjectURL(u))).catch(() => {});
        }
    }
    return p;
}

// One page of the document at url (for addTiffPager): { url }
async function xpsPage(url, n) {
    const d = await opened.get(url);
    if (!d) throw new Error('not opened');
    if (!d.pages[n]) throw new Error(`no page ${n + 1}`);
    return { url: await d.draw(n) };
}

module.exports = { isXpsName, xpsImage, xpsPage };
