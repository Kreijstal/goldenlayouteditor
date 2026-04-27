// --- WASM Plugin ---
// Lazy-loads WABT when a WebAssembly module is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('WASM');
const WABT_URL = 'https://esm.sh/wabt@1.0.37';
const WASM_RE = /\.wasm$/i;

let _wabtPromise = null;

async function ensureWabtLoaded() {
    if (!_wabtPromise) {
        _wabtPromise = (async () => {
            const mod = await import(WABT_URL);
            const factory = mod.default || mod;
            const wabt = typeof factory === 'function' ? await factory() : factory;
            if (!wabt || typeof wabt.readWasm !== 'function') {
                throw new Error('WABT did not export readWasm');
            }
            return wabt;
        })();
    }
    return _wabtPromise;
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

const SECTION_NAMES = {
    0: 'custom',
    1: 'type',
    2: 'import',
    3: 'function',
    4: 'table',
    5: 'memory',
    6: 'global',
    7: 'export',
    8: 'start',
    9: 'element',
    10: 'code',
    11: 'data',
    12: 'dataCount',
    13: 'tag',
};

function readVarUint32(bytes, offset) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (pos < bytes.length) {
        const byte = bytes[pos++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { value: result >>> 0, next: pos };
        shift += 7;
        if (shift > 35) throw new Error('Invalid varuint32');
    }
    throw new Error('Unexpected EOF while reading varuint32');
}

function decodeUtf8(bytes) {
    return new TextDecoder().decode(bytes);
}

function parseWasmSections(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 8) throw new Error('File is too small to be a WASM module');
    if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error('Invalid WASM magic header');
    }
    const version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    const sections = [];
    let offset = 8;
    while (offset < bytes.length) {
        const sectionOffset = offset;
        const id = bytes[offset++];
        const sizeInfo = readVarUint32(bytes, offset);
        const size = sizeInfo.value;
        const payloadOffset = sizeInfo.next;
        const payloadEnd = payloadOffset + size;
        if (payloadEnd > bytes.length) throw new Error(`Section ${id} extends beyond EOF`);
        const section = {
            id,
            name: SECTION_NAMES[id] || `unknown-${id}`,
            offset: sectionOffset,
            payloadOffset,
            size,
            end: payloadEnd,
        };
        if (id === 0 && size > 0) {
            const nameLen = readVarUint32(bytes, payloadOffset);
            section.customName = decodeUtf8(bytes.subarray(nameLen.next, nameLen.next + nameLen.value));
        }
        sections.push(section);
        offset = payloadEnd;
    }
    return {
        magic: '\\0asm',
        version,
        byteLength: bytes.length,
        sections,
    };
}

class WasmInspectorComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = WasmInspectorComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'module.wasm';
        this.ast = null;
        this.wat = '';

        this.root = container.element;
        this.root.classList.add('wasm-plugin-root');
        this._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (WasmInspectorComponent._styleInstalled) return;
        WasmInspectorComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.wasm-plugin-root{height:100%;background:#1f2328;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.wasm-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.wasm-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow:auto}
.wasm-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.wasm-toolbar button:hover{background:#444c56}
.wasm-title{font-weight:600;min-width:120px;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.wasm-status{margin-left:auto;color:#adbac7;font-size:12px}
.wasm-main{display:grid;grid-template-columns:320px 1fr;min-height:0}
.wasm-side{min-height:0;border-right:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto 1fr}
.wasm-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px;border-bottom:1px solid #444c56}
.wasm-sections{overflow:auto;padding:6px}
.wasm-section{display:grid;grid-template-columns:1fr auto;gap:6px;width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px;background:#2d333b;border:1px solid #444c56;border-radius:4px;color:#e6edf3;text-align:left;cursor:pointer}
.wasm-section.active{border-color:#6cb6ff;background:#303b49}
.wasm-section-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wasm-section-meta{color:#adbac7;font-size:11px;grid-column:1 / span 2}
.wasm-content{min-width:0;min-height:0;display:grid;grid-template-rows:auto 1fr;background:#1f2328}
.wasm-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.wasm-card{background:#2d333b;border:1px solid #444c56;border-radius:4px;padding:7px 8px;min-width:0}
.wasm-card-label{color:#adbac7;font-size:11px;text-transform:uppercase}
.wasm-card-value{font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wasm-output{margin:0;padding:12px;overflow:auto;color:#d1d7e0;background:#1f2328;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;line-height:1.45;tab-size:2}
.wasm-message,.wasm-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#adbac7}
.wasm-error{color:#ffb4ab}
@media (max-width:800px){.wasm-main{grid-template-columns:1fr}.wasm-side{display:none}.wasm-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'wasm-shell';
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'wasm-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.wasm,application/wasm';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', e => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local WASM module', () => this.fileInput.click()));
        this.toolbar.appendChild(makeButton('Sections', 'Show section AST', () => this._renderJson(this.ast)));
        this.toolbar.appendChild(makeButton('WAT', 'Show WAT disassembly', () => this._renderWat()));
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'wasm-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'wasm-status';
        this.toolbar.appendChild(this.statusEl);

        this.main = document.createElement('div');
        this.main.className = 'wasm-main';
        this.side = document.createElement('div');
        this.side.className = 'wasm-side';
        this.side.innerHTML = '<h3>Sections</h3><div class="wasm-sections"></div>';
        this.sectionsEl = this.side.querySelector('.wasm-sections');
        this.content = document.createElement('div');
        this.content.className = 'wasm-content';
        this.summaryEl = document.createElement('div');
        this.summaryEl.className = 'wasm-summary';
        this.outputEl = document.createElement('pre');
        this.outputEl.className = 'wasm-output';
        this.content.appendChild(this.summaryEl);
        this.content.appendChild(this.outputEl);
        this.main.appendChild(this.side);
        this.main.appendChild(this.content);
        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open a WASM module to inspect sections and WAT.');
    }

    async _init() {
        if (this.fileData) await this._loadProjectFile();
        else this.statusEl.textContent = 'WABT loads when a WASM module is opened';
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed WASM loading requires the server workspace.');
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
        this.statusEl.textContent = 'Parsing sections...';
        this._clear();
        try {
            this.ast = parseWasmSections(buffer);
            this._renderSections();

            this.statusEl.textContent = 'Loading WABT...';
            const wabt = await ensureWabtLoaded();
            const module = wabt.readWasm(new Uint8Array(buffer), { readDebugNames: true });
            module.generateNames();
            module.applyNames();
            this.wat = module.toText({ foldExprs: false, inlineExport: false });
            module.destroy();
            this.statusEl.textContent = `${this.ast.byteLength} bytes | ${this.ast.sections.length} section(s)`;
            this._renderJson(this.ast);
        } catch (err) {
            log.error('Failed to open WASM:', err);
            this._showError(`Failed to open WASM: ${err.message}`);
        }
    }

    _renderSections() {
        this.sectionsEl.innerHTML = '';
        for (const section of this.ast.sections) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'wasm-section';
            btn.innerHTML = '<span class="wasm-section-name"></span><strong></strong><span class="wasm-section-meta"></span>';
            btn.querySelector('.wasm-section-name').textContent = section.customName ? `${section.name}: ${section.customName}` : section.name;
            btn.querySelector('strong').textContent = String(section.id);
            btn.querySelector('.wasm-section-meta').textContent = `${section.size} bytes @ ${section.offset}`;
            btn.addEventListener('click', () => this._selectSection(section));
            this.sectionsEl.appendChild(btn);
        }
    }

    _selectSection(section) {
        for (const btn of this.sectionsEl.querySelectorAll('.wasm-section')) {
            btn.classList.toggle('active', btn.querySelector('strong').textContent === String(section.id) &&
                btn.querySelector('.wasm-section-meta').textContent.endsWith(`@ ${section.offset}`));
        }
        this._renderJson(section);
    }

    _renderWat() {
        this._renderSummary();
        this.outputEl.className = 'wasm-output';
        this.outputEl.textContent = this.wat || 'WAT output is not available.';
    }

    _renderJson(value) {
        this._renderSummary();
        this.outputEl.className = 'wasm-output';
        this.outputEl.textContent = JSON.stringify(value || null, null, 2);
    }

    _renderSummary() {
        const cards = [
            ['File', this.fileName],
            ['Version', this.ast ? String(this.ast.version) : ''],
            ['Bytes', this.ast ? String(this.ast.byteLength) : '0'],
            ['Sections', this.ast ? String(this.ast.sections.length) : '0'],
        ];
        this.summaryEl.innerHTML = '';
        for (const [label, value] of cards) {
            const card = document.createElement('div');
            card.className = 'wasm-card';
            card.innerHTML = '<div class="wasm-card-label"></div><div class="wasm-card-value"></div>';
            card.querySelector('.wasm-card-label').textContent = label;
            card.querySelector('.wasm-card-value').textContent = value;
            this.summaryEl.appendChild(card);
        }
    }

    _showMessage(message) {
        this._clear();
        this.outputEl.className = 'wasm-message';
        this.outputEl.textContent = message;
    }

    _showError(message) {
        this.outputEl.className = 'wasm-error';
        this.outputEl.textContent = message;
        this.statusEl.textContent = 'Error';
    }

    _clear() {
        this.sectionsEl.innerHTML = '';
        this.summaryEl.innerHTML = '';
        this.outputEl.className = 'wasm-output';
        this.outputEl.textContent = '';
    }

    _destroy() {}
}

registerPlugin({
    id: 'wasm',
    name: 'WASM',
    components: {
        wasmInspector: WasmInspectorComponent,
    },
    toolbarButtons: [
        { label: 'WASM', title: 'Open WASM Inspector' },
    ],
    contextMenuItems: [{
        label: 'Open WASM Inspector',
        canHandle: (fileName) => WASM_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = WasmInspectorComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('wasmInspector', { fileId }, `${file.name} [wasm]`, 'wasm-' + fileId);
        },
    }],
    init(ctx) {
        WasmInspectorComponent._ctx = ctx;
    },
});
