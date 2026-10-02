// --- Spreadsheet Plugin ---
// Edits .xlsx workbooks in fortune-sheet (github.com/Kreijstal/fortune-sheet-vanilla,
// a React-free FortuneSheet), reading and writing the file with ExcelJS. Both
// libraries are loaded from esm.sh on first use. Saving
// writes into the workbook as it was read, so parts the grid doesn't show are kept.
// CSV and TSV files open as one sheet and are saved back as delimited text (csv-sheet.js).
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { workbookToSheets, sheetsIntoWorkbook } = require('./xlsx-fortune');
const { insideArchive } = require('./browse-mode');
const { readDelimited, writeDelimited, decodeText, encodeText } = require('./csv-sheet');

const log = createLogger('Spreadsheet');
const EDITABLE_RE = /\.(xlsx|csv|tsv)$/i;
const DELIMITED_RE = /\.(csv|tsv)$/i;

let _libs = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    return loadScript('https://esm.sh/exceljs@4.4.0/dist/exceljs.min.js?raw').then(() => window.ExcelJS);
}

// { ExcelJS, FortuneSheet, format }
function ensureLibs() {
    if (!_libs) {
        _libs = Promise.all([
            loadExcelJS(),
            import('https://esm.sh/gh/Kreijstal/fortune-sheet-vanilla@f654726'),
        ]).then(([ExcelJS, fs]) => ({ ExcelJS, FortuneSheet: fs.FortuneSheet, format: fs.update }))
            .catch(err => { _libs = null; throw err; });
    }
    return _libs;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

class SpreadsheetComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = SpreadsheetComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.dirty = false;

        this.root = container.element;
        this.root.classList.add('sheet-plugin-root');
        this._installStyles();
        this.root.innerHTML = `
<div class="sheet-shell">
  <div class="sheet-toolbar">
    <span class="sheet-title"></span>
    <button type="button" class="sheet-save" disabled title="Save (Ctrl+S)">Save</button>
    <span class="sheet-status"></span>
  </div>
  <div class="sheet-host"><div class="sheet-message">Loading…</div></div>
</div>`;
        this.titleEl = this.root.querySelector('.sheet-title');
        this.saveBtn = this.root.querySelector('.sheet-save');
        this.statusEl = this.root.querySelector('.sheet-status');
        this.host = this.root.querySelector('.sheet-host');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        this.saveBtn.onclick = () => this._save();
        this.root.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                e.stopPropagation();
                this._save();
            }
        }, true);
        // The grid sizes itself on window resizes only
        this._resizeObserver = new ResizeObserver(() => {
            if (this.sheet) window.dispatchEvent(new Event('resize'));
        });
        this._resizeObserver.observe(this.host);
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (SpreadsheetComponent._styleInstalled) return;
        SpreadsheetComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.sheet-plugin-root{height:100%;background:#fff;overflow:hidden}
.sheet-shell{display:flex;flex-direction:column;height:100%}
.sheet-toolbar{display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden}
.sheet-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sheet-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer}
.sheet-toolbar button:hover:not(:disabled){background:#444c56}
.sheet-toolbar button:disabled{opacity:.5;cursor:default}
.sheet-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.sheet-status.error{color:#ffb4ab}
.sheet-host{position:relative;flex:1;min-height:0}
.sheet-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#57606a;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.sheet-message.error{color:#b42318}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath + '/' + this.ctx.getRelativePath(this.fileId);
    }

    async _init() {
        const path = this._path();
        if (!path) return this._fail('Spreadsheets need the server workspace.');
        // Inside an archive the file can be read but not written
        this.readOnly = insideArchive(path);
        let libs, bytes;
        try {
            [libs, bytes] = await Promise.all([ensureLibs(), fetch('/workspace-file?path=' + encodeURIComponent(path)).then(async r => {
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            })]);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the spreadsheet: ' + err.message);
        }
        this.libs = libs;
        this.bytes = bytes;
        this.delimited = DELIMITED_RE.test(path);
        let sheets;
        try {
            sheets = workbookToSheets(await this._workbook(), libs.format);
        } catch (err) {
            log.error('Parse failed:', err);
            return this._fail('Could not read the workbook: ' + err.message);
        }
        this.host.textContent = '';
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;inset:0';
        this.host.appendChild(el);
        this.sheet = new libs.FortuneSheet(el, {
            data: sheets,
            allowEdit: !this.readOnly,
            defaultFontSize: 11, // Excel's
            rowHeaderWidth: 46,
            columnHeaderHeight: 20,
            onOp: ops => this._onOps(ops),
        });
        this.saveBtn.hidden = this.readOnly;
        this._status(this.readOnly ? 'Read-only' : this.delimited ? this._dialectLabel() : `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`);
        log.log(`Opened ${path}: ${sheets.length} sheet(s)`);
    }

    _onOps(ops) {
        // Selection moves are ops too; only content changes make the file dirty
        const real = (ops || []).some(op => !(op.path || []).some(p => typeof p === 'string' && /^luckysheet_select|^luckysheet_selection|^jfrefreshgrid/.test(p)));
        if (!real || this.readOnly) return;
        this.dirty = true;
        this.saveBtn.disabled = false;
        this._status('Unsaved changes');
    }

    async _save() {
        if (!this.sheet || this.readOnly || this._saving) return;
        const path = this._path();
        const ctx = this.ctx;
        this._saving = true;
        this.saveBtn.disabled = true;
        this._status('Saving…');
        try {
            if (!ctx.wsClient || !ctx.wsClient.isConnected()) throw new Error('not connected to the server');
            // Into a fresh copy of the file as last saved, so each save starts from disk
            const wb = await this._workbook();
            sheetsIntoWorkbook(wb, this.sheet.getData());
            const out = this.delimited
                ? encodeText(writeDelimited(wb.worksheets[0], this.dialect), this.dialect.encoding, this.dialect.bom)
                : new Uint8Array(await wb.xlsx.writeBuffer());
            const slash = path.lastIndexOf('/');
            const result = await ctx.wsClient.wsRequest({
                type: 'saveFile',
                workspacePath: path.slice(0, slash) || '/',
                relativePath: path.slice(slash + 1),
                content: bytesToBase64(out),
                encoding: 'base64',
            });
            if (!result || !result.success) throw new Error((result && result.error) || 'save failed');
            this.bytes = out;
            this.dirty = false;
            this._status(`Saved ${new Date().toLocaleTimeString()}`);
            log.log(`Saved ${path} (${out.length} bytes)`);
        } catch (err) {
            log.error('Save failed:', err);
            this.saveBtn.disabled = false;
            this._status('Could not save: ' + err.message, true);
        } finally {
            this._saving = false;
        }
    }

    // The workbook in this.bytes: the .xlsx itself, or delimited text as one sheet
    async _workbook() {
        const wb = new this.libs.ExcelJS.Workbook();
        if (this.delimited) {
            const { text, encoding, bom } = decodeText(this.bytes);
            const name = (this.fileData && this.fileData.name || 'Sheet1').replace(/\.(csv|tsv)$/i, '').replace(/[*?:\\/[\]]/g, '_').slice(0, 31) || 'Sheet1';
            this.dialect = { ...readDelimited(wb.addWorksheet(name), text, this.fileData && this.fileData.name), encoding, bom };
        } else if (this.bytes.length) await wb.xlsx.load(this.bytes);
        return wb;
    }

    _dialectLabel() {
        const d = this.dialect;
        const names = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };
        return `${names[d.delimiter]}-separated · ${d.widths.length} rows · ${d.encoding}${d.bom ? ' (BOM)' : ''}`;
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(message) {
        this.host.innerHTML = '<div class="sheet-message error"></div>';
        this.host.firstChild.textContent = message;
    }

    _destroy() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this.sheet) this.sheet.destroy();
        this.sheet = null;
    }
}

// An empty workbook with one sheet
async function emptyWorkbook() {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1');
    return new Uint8Array(await wb.xlsx.writeBuffer());
}

registerPlugin({
    id: 'spreadsheet',
    name: 'Spreadsheet (fortune-sheet)',
    components: {
        spreadsheetEditor: SpreadsheetComponent,
    },
    newFileTypes: [{ label: 'Spreadsheet', ext: 'xlsx', content: () => emptyWorkbook() }],
    contextMenuItems: [{
        label: 'Open as spreadsheet',
        canHandle: (fileName) => EDITABLE_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = SpreadsheetComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('spreadsheetEditor', { fileId }, `${file.name} [sheet]`, 'sheet-' + fileId);
        },
    }],
    init(ctx) {
        SpreadsheetComponent._ctx = ctx;
    },
});
