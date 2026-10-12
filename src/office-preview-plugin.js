const { registerPlugin } = require('./plugins');
const { readViewerFile, element, table } = require('./viewer-file');
const { documentPdf } = require('./cdr');
const { mountPdfViewer } = require('./pdf-viewer');
const NUMBERS_LIB = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
let ctx, zipPromise, numbersPromise;

function loadZip() {
    if (!zipPromise) {
        zipPromise = import('https://esm.sh/jszip@3.10.1').then(m => m.default || m);
        zipPromise.catch(() => { zipPromise = null; });
    }
    return zipPromise;
}
function loadNumbers() {
    if (!numbersPromise) {
        numbersPromise = import(NUMBERS_LIB);
        numbersPromise.catch(() => { numbersPromise = null; });
    }
    return numbersPromise;
}

async function officePackage(bytes, name) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Not a ZIP-based office document.');
    const Zip = await loadZip(), zip = await Zip.loadAsync(bytes);
    if (/\.numbers$/i.test(name)) {
        if (!zip.file('Index/Document.iwa')) throw new Error('Not a supported Numbers 3+ IWA workbook. Older XML-based Numbers files are not supported.');
        return zip;
    }
    const format = name.split('.').pop().toLowerCase();
    const expected = { odt: 'application/vnd.oasis.opendocument.text', odp: 'application/vnd.oasis.opendocument.presentation' }[format];
    const mime = zip.file('mimetype');
    if (!mime || !expected || (await mime.async('string')).trim() !== expected) throw new Error(`The package mimetype does not match .${format}.`);
    if (!zip.file('content.xml')) throw new Error('The OpenDocument package has no content.xml.');
    const manifest = zip.file('META-INF/manifest.xml');
    if (manifest && /encryption-data/.test(await manifest.async('string'))) throw new Error('Encrypted OpenDocument packages are not supported.');
    return zip;
}

class OpenDocumentPreview {
    constructor(container, state) {
        this.fileId = state.fileId;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#222;font:13px system-ui';
        this.status = element('div', 'Reading OpenDocument…', this.root);
        this.status.style.padding = '8px';
        this.host = element('div', null, this.root);
        this.host.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
        container.on('destroy', () => { this.destroyed = true; this.cleanup(); });
        this.load();
    }
    cleanup() {
        if (this.pdf) { this.pdf.destroy(); this.pdf = null; }
        if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    }
    async load() {
        try {
            const file = ctx.projectFiles[this.fileId];
            const bytes = await readViewerFile(ctx, this.fileId);
            await officePackage(bytes, file.name);
            if (this.destroyed) return;
            this.status.textContent = 'Rendering with LibreOffice…';
            const pdf = await documentPdf(bytes, file.name.split('.').pop().toLowerCase(), file.name);
            if (this.destroyed) return;
            this.url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
            this.status.textContent = `${file.name} · converted PDF preview · source remains unchanged`;
            const viewer = await mountPdfViewer(this.host, { url: this.url });
            if (this.destroyed) { viewer.destroy(); return; }
            this.pdf = viewer;
        } catch (err) { if (!this.destroyed) this.status.textContent = 'Could not preview OpenDocument: ' + err.message; }
    }
}

class NumbersPreview {
    constructor(container, state) {
        this.fileId = state.fileId;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;overflow:auto;background:#fff;color:#222;font:13px system-ui;padding:10px;box-sizing:border-box';
        container.on('destroy', () => { this.destroyed = true; });
        this.load();
    }
    async load() {
        this.root.textContent = 'Reading Numbers workbook…';
        try {
            const file = ctx.projectFiles[this.fileId], bytes = await readViewerFile(ctx, this.fileId);
            await officePackage(bytes, file.name);
            const XLSX = await loadNumbers();
            const book = XLSX.read(bytes, { type: 'array', cellDates: true, cellNF: true, cellHTML: false });
            if (this.destroyed) return;
            this.root.replaceChildren();
            element('h3', `${file.name} · ${book.SheetNames.length} table(s)`, this.root);
            element('p', 'Read-only table data. Each Numbers table is shown separately; charts and canvas layout are not reproduced.', this.root);
            const pick = element('select', null, this.root);
            pick.setAttribute('aria-label', 'Numbers table');
            book.SheetNames.forEach(name => { const option = element('option', name, pick); option.value = name; });
            const status = element('p', '', this.root), grid = element('div', null, this.root);
            grid.style.overflow = 'auto';
            const show = () => {
                grid.replaceChildren();
                const sheet = book.Sheets[pick.value];
                if (!sheet || !sheet['!ref']) { status.textContent = 'Empty table'; return; }
                const range = XLSX.utils.decode_range(sheet['!ref']);
                const endRow = Math.min(range.e.r, range.s.r + 199), endCol = Math.min(range.e.c, range.s.c + 99);
                const columns = ['Row'], rows = [];
                for (let c = range.s.c; c <= endCol; c++) columns.push(XLSX.utils.encode_col(c));
                for (let r = range.s.r; r <= endRow; r++) {
                    const row = [r + 1];
                    for (let c = range.s.c; c <= endCol; c++) {
                        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
                        row.push(cell ? cell.w !== undefined ? cell.w : cell.v instanceof Date ? cell.v.toISOString() : cell.v == null ? '' : String(cell.v) : '');
                    }
                    rows.push(row);
                }
                status.textContent = `${pick.value} · ${sheet['!ref']} · showing ${rows.length} rows × ${columns.length - 1} columns (maximum 200 × 100)`;
                table(grid, columns, rows);
            };
            pick.onchange = show;
            show();
        } catch (err) { if (!this.destroyed) this.root.textContent = 'Could not preview Numbers: ' + err.message; }
    }
}

registerPlugin({ id: 'office-previews', name: 'Numbers and OpenDocument previews', components: { numbersViewer: NumbersPreview, openDocumentViewer: OpenDocumentPreview }, init(context) { ctx = context; } });
module.exports = { officePackage };
