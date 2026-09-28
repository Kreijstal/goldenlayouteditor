// --- XLSX AST Plugin ---
// Lazy-loads the xlsx parser when a spreadsheet file is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('XLSX');
const XLSX_URL = 'https://esm.sh/xlsx@0.18.5';
const SPREADSHEET_RE = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;

let _xlsxPromise = null;

async function ensureXlsxLoaded() {
    if (!_xlsxPromise) {
        _xlsxPromise = (async () => {
            const mod = await import(XLSX_URL);
            const xlsx = mod.default || mod;
            if (!xlsx || typeof xlsx.read !== 'function') {
                throw new Error('xlsx did not export read');
            }
            return xlsx;
        })();
    }
    return _xlsxPromise;
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

function cellAddressCompare(a, b) {
    const ar = a.match(/^([A-Z]+)(\d+)$/i);
    const br = b.match(/^([A-Z]+)(\d+)$/i);
    if (!ar || !br) return a.localeCompare(b);
    const rowDelta = Number(ar[2]) - Number(br[2]);
    if (rowDelta) return rowDelta;
    return ar[1].localeCompare(br[1]);
}

function simplifyCell(cell) {
    const out = {};
    for (const key of ['t', 'v', 'w', 'f', 'F', 'z', 'l', 'c']) {
        if (cell[key] !== undefined) out[key] = cell[key];
    }
    return out;
}

function buildWorkbookAst(workbook) {
    const ast = {
        SheetNames: workbook.SheetNames || [],
        Workbook: workbook.Workbook || null,
        Props: workbook.Props || null,
        Custprops: workbook.Custprops || null,
        Sheets: {},
    };

    for (const name of workbook.SheetNames || []) {
        const sheet = workbook.Sheets[name] || {};
        const cells = {};
        const cellKeys = Object.keys(sheet)
            .filter(key => key[0] !== '!')
            .sort(cellAddressCompare);

        for (const key of cellKeys) {
            cells[key] = simplifyCell(sheet[key]);
        }

        ast.Sheets[name] = {
            ref: sheet['!ref'] || null,
            merges: sheet['!merges'] || [],
            cols: sheet['!cols'] || [],
            rows: sheet['!rows'] || [],
            cells,
        };
    }

    return ast;
}

class XlsxAstComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = XlsxAstComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'workbook.xlsx';
        this.workbook = null;
        this.ast = null;
        this.selectedSheet = null;

        this.root = container.element;
        this.root.classList.add('xlsx-plugin-root');
        this._installStyles();
        this._buildUI();

        if (container.on) {
            container.on('destroy', () => this._destroy());
        }

        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (XlsxAstComponent._styleInstalled) return;
        XlsxAstComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.xlsx-plugin-root{height:100%;background:#1f2328;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.xlsx-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.xlsx-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow:auto}
.xlsx-toolbar button,.xlsx-toolbar select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:4px 9px;font:inherit}
.xlsx-toolbar button{cursor:pointer}
.xlsx-toolbar button:hover{background:#444c56}
.xlsx-title{font-weight:600;min-width:100px;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.xlsx-status{margin-left:auto;color:#adbac7;font-size:12px}
.xlsx-main{display:grid;grid-template-columns:280px 1fr;min-height:0}
.xlsx-side{min-height:0;border-right:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto 1fr}
.xlsx-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px;border-bottom:1px solid #444c56}
.xlsx-tree{overflow:auto;padding:6px}
.xlsx-sheet{display:block;width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px;background:#2d333b;border:1px solid #444c56;border-radius:4px;color:#e6edf3;text-align:left;cursor:pointer}
.xlsx-sheet.active{border-color:#6cb6ff;background:#303b49}
.xlsx-sheet-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xlsx-sheet-meta{color:#adbac7;font-size:11px;margin-top:2px}
.xlsx-content{min-width:0;min-height:0;display:grid;grid-template-rows:auto 1fr;background:#1f2328}
.xlsx-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.xlsx-card{background:#2d333b;border:1px solid #444c56;border-radius:4px;padding:7px 8px;min-width:0}
.xlsx-card-label{color:#adbac7;font-size:11px;text-transform:uppercase}
.xlsx-card-value{font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xlsx-json{margin:0;padding:12px;overflow:auto;color:#d1d7e0;background:#1f2328;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;line-height:1.45;tab-size:2}
.xlsx-message,.xlsx-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#adbac7}
.xlsx-error{color:#ffb4ab}
@media (max-width:800px){.xlsx-main{grid-template-columns:1fr}.xlsx-side{display:none}.xlsx-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'xlsx-shell';

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'xlsx-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.xlsx,.xlsm,.xlsb,.xls,.ods';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local spreadsheet file', () => this.fileInput.click()));
        this.toolbar.appendChild(makeButton('Workbook AST', 'Show workbook AST', () => this._renderJson(this.ast)));

        this.sheetSelect = document.createElement('select');
        this.sheetSelect.title = 'Select sheet AST';
        this.sheetSelect.addEventListener('change', () => this._selectSheet(this.sheetSelect.value));
        this.toolbar.appendChild(this.sheetSelect);

        this.titleEl = document.createElement('span');
        this.titleEl.className = 'xlsx-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);

        this.statusEl = document.createElement('span');
        this.statusEl.className = 'xlsx-status';
        this.toolbar.appendChild(this.statusEl);

        this.main = document.createElement('div');
        this.main.className = 'xlsx-main';

        this.side = document.createElement('div');
        this.side.className = 'xlsx-side';
        this.side.innerHTML = '<h3>Sheets</h3><div class="xlsx-tree"></div>';
        this.sheetsEl = this.side.querySelector('.xlsx-tree');

        this.content = document.createElement('div');
        this.content.className = 'xlsx-content';
        this.summaryEl = document.createElement('div');
        this.summaryEl.className = 'xlsx-summary';
        this.jsonEl = document.createElement('pre');
        this.jsonEl.className = 'xlsx-json';
        this.content.appendChild(this.summaryEl);
        this.content.appendChild(this.jsonEl);

        this.main.appendChild(this.side);
        this.main.appendChild(this.content);
        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open a spreadsheet file to inspect its parsed AST.');
    }

    async _init() {
        if (this.fileData) {
            await this._loadProjectFile();
        } else {
            this.statusEl.textContent = 'xlsx loads when a spreadsheet is opened';
        }
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed spreadsheet loading requires the server workspace.');
                return;
            }
            const relPath = this.ctx.getRelativePath(this.fileId);
            const url = '/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + relPath);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._loadBuffer(await resp.arrayBuffer(), this.fileData.name);
        } catch (err) {
            this._showError(err.message);
        }
    }

    async _loadFileObject(file) {
        await this._loadBuffer(await file.arrayBuffer(), file.name);
    }

    async _loadBuffer(buffer, name) {
        this.fileName = name || this.fileName;
        this.titleEl.textContent = this.fileName;
        this.statusEl.textContent = 'Loading xlsx...';
        this._clear();

        try {
            const XLSX = await ensureXlsxLoaded();
            this.statusEl.textContent = 'Parsing workbook...';
            this.workbook = XLSX.read(buffer, {
                type: 'array',
                cellFormula: true,
                cellHTML: false,
                cellNF: true,
                cellStyles: true,
                cellDates: true,
                WTF: false,
            });
            this.ast = buildWorkbookAst(this.workbook);
            this._renderWorkbook();
        } catch (err) {
            log.error('Failed to open spreadsheet:', err);
            this._showError(`Failed to parse spreadsheet: ${err.message}`);
        }
    }

    _renderWorkbook() {
        const names = this.ast ? this.ast.SheetNames : [];
        this.sheetSelect.innerHTML = '';
        this.sheetsEl.innerHTML = '';

        for (const name of names) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            this.sheetSelect.appendChild(option);

            const sheet = this.ast.Sheets[name];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'xlsx-sheet';
            btn.innerHTML = `<div class="xlsx-sheet-name"></div><div class="xlsx-sheet-meta"></div>`;
            btn.querySelector('.xlsx-sheet-name').textContent = name;
            btn.querySelector('.xlsx-sheet-meta').textContent = `${sheet.ref || 'no range'} | ${Object.keys(sheet.cells).length} cell(s)`;
            btn.addEventListener('click', () => this._selectSheet(name));
            this.sheetsEl.appendChild(btn);
        }

        this.statusEl.textContent = `${names.length} sheet(s)`;
        if (names.length) {
            this._selectSheet(names[0]);
        } else {
            this._renderJson(this.ast);
        }
    }

    _selectSheet(name) {
        this.selectedSheet = name;
        this.sheetSelect.value = name;
        for (const btn of this.sheetsEl.querySelectorAll('.xlsx-sheet')) {
            btn.classList.toggle('active', btn.querySelector('.xlsx-sheet-name').textContent === name);
        }
        this._renderJson(this.ast && this.ast.Sheets ? this.ast.Sheets[name] : null);
    }

    _renderJson(value) {
        this._renderSummary();
        this.jsonEl.textContent = JSON.stringify(value || null, null, 2);
    }

    _renderSummary() {
        const sheet = this.selectedSheet && this.ast ? this.ast.Sheets[this.selectedSheet] : null;
        const cells = sheet ? Object.keys(sheet.cells).length : 0;
        const cards = [
            ['File', this.fileName],
            ['Sheets', this.ast ? String(this.ast.SheetNames.length) : '0'],
            ['Selected', this.selectedSheet || 'Workbook'],
            ['Cells', String(cells)],
        ];
        this.summaryEl.innerHTML = '';
        for (const [label, value] of cards) {
            const card = document.createElement('div');
            card.className = 'xlsx-card';
            card.innerHTML = '<div class="xlsx-card-label"></div><div class="xlsx-card-value"></div>';
            card.querySelector('.xlsx-card-label').textContent = label;
            card.querySelector('.xlsx-card-value').textContent = value;
            this.summaryEl.appendChild(card);
        }
    }

    _showMessage(message) {
        this._clear();
        this.summaryEl.innerHTML = '';
        this.jsonEl.className = 'xlsx-message';
        this.jsonEl.textContent = message;
    }

    _showError(message) {
        this.summaryEl.innerHTML = '';
        this.jsonEl.className = 'xlsx-error';
        this.jsonEl.textContent = message;
        this.statusEl.textContent = 'Error';
    }

    _clear() {
        this.sheetSelect.innerHTML = '';
        this.sheetsEl.innerHTML = '';
        this.summaryEl.innerHTML = '';
        this.jsonEl.className = 'xlsx-json';
        this.jsonEl.textContent = '';
    }

    _destroy() {}
}

registerPlugin({
    id: 'xlsx',
    name: 'XLSX',
    components: {
        xlsxAst: XlsxAstComponent,
    },
    toolbarButtons: [
        { label: 'XLSX', title: 'Open XLSX AST Inspector' },
    ],
    contextMenuItems: [{
        label: 'Open XLSX AST',
        canHandle: (fileName) => SPREADSHEET_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = XlsxAstComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab(
                'xlsxAst',
                { fileId },
                `${file.name} [xlsx]`,
                'xlsx-' + fileId
            );
        },
    }],
    init(ctx) {
        XlsxAstComponent._ctx = ctx;
    },
});
