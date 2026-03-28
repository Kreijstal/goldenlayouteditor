// --- Pandoc Plugin ---
// Provides a converter panel using pandoc-wasm for format conversion
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const log = createLogger('Pandoc');

const PANDOC_VERSION = '1.0.1';

let pandocConvert = null;
let _loadPromise = null;

async function ensurePandocLoaded() {
    if (pandocConvert) return true;
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
        log.log('Loading pandoc-wasm from esm.sh...');
        try {
            const mod = await import(`https://esm.sh/pandoc-wasm@${PANDOC_VERSION}`);
            pandocConvert = mod.convert;
            log.log('pandoc-wasm loaded:', PANDOC_VERSION);
            return true;
        } catch (err) {
            log.error('Failed to load pandoc-wasm:', err);
            _loadPromise = null;
            return false;
        }
    })();
    return _loadPromise;
}

const FORMAT_MAP = {
    md: 'markdown', markdown: 'markdown',
    rst: 'rst',
    tex: 'latex', latex: 'latex',
    org: 'org',
    adoc: 'asciidoc',
    typ: 'typst',
    html: 'html', htm: 'html',
    txt: 'markdown',
};

const OUTPUT_FORMATS = [
    { id: 'html', label: 'HTML', ext: 'html' },
    { id: 'markdown', label: 'Markdown', ext: 'md' },
    { id: 'latex', label: 'LaTeX', ext: 'tex' },
    { id: 'typst', label: 'Typst', ext: 'typ' },
    { id: 'rst', label: 'reStructuredText', ext: 'rst' },
    { id: 'org', label: 'Org Mode', ext: 'org' },
    { id: 'plain', label: 'Plain Text', ext: 'txt' },
    { id: 'json', label: 'Pandoc AST (JSON)', ext: 'json' },
];

function detectFormat(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    return FORMAT_MAP[ext] || 'markdown';
}

function makeSelect(options, selected) {
    const sel = document.createElement('select');
    sel.style.cssText = 'padding:4px 6px;border:1px solid #555;border-radius:3px;background:#2a2a2a;color:#ddd;font-size:12px;';
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value || opt.id;
        o.textContent = opt.label || opt.value || opt.id;
        if (o.value === selected) o.selected = true;
        sel.appendChild(o);
    }
    return sel;
}

function makeCheckbox(label, checked) {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;color:#ccc;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    wrapper.appendChild(cb);
    wrapper.appendChild(document.createTextNode(label));
    return { wrapper, checkbox: cb };
}

function makeButton(text, style) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = 'padding:4px 12px;border:none;border-radius:3px;cursor:pointer;font-size:12px;' + (style || '');
    return btn;
}

class PandocConvertComponent {
    constructor(container, state) {
        this.container = container;
        this.rootElement = container.element;
        this.rootElement.style.cssText = 'display:flex;flex-direction:column;height:100%;background:#1e1e1e;color:#ddd;font-family:sans-serif;overflow:hidden;';

        const ctx = PandocConvertComponent._ctx;
        this.projectFiles = ctx ? ctx.projectFiles : {};
        this.openPluginPanel = ctx ? ctx.openPluginPanel : null;

        this._lastOutput = null;
        this._lastOutputFormat = null;
        this._build(state);
    }

    _build(state) {
        // Controls area
        const controls = document.createElement('div');
        controls.style.cssText = 'padding:10px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid #333;flex-shrink:0;';

        // Source file
        const sourceRow = this._makeRow('Source:');
        const fileOptions = Object.values(this.projectFiles)
            .filter(f => f.name && f.content !== undefined)
            .map(f => ({ value: f.id, label: f.name }));
        this.sourceSelect = makeSelect(fileOptions, state.fileId || '');
        this.sourceSelect.onchange = () => this._onSourceChange();
        sourceRow.appendChild(this.sourceSelect);
        controls.appendChild(sourceRow);

        // From format
        const fromRow = this._makeRow('From:');
        const fromOptions = [...new Set(Object.values(FORMAT_MAP))].sort().map(f => ({ id: f, label: f }));
        const detectedFrom = state.fileId && this.projectFiles[state.fileId]
            ? detectFormat(this.projectFiles[state.fileId].name) : 'markdown';
        this.fromSelect = makeSelect(fromOptions, detectedFrom);
        fromRow.appendChild(this.fromSelect);
        controls.appendChild(fromRow);

        // To format
        const toRow = this._makeRow('To:');
        this.toSelect = makeSelect(OUTPUT_FORMATS, 'html');
        toRow.appendChild(this.toSelect);
        controls.appendChild(toRow);

        // Options
        const optRow = document.createElement('div');
        optRow.style.cssText = 'display:flex;gap:16px;align-items:center;';
        const { wrapper: standaloneW, checkbox: standaloneCb } = makeCheckbox('Standalone', true);
        const { wrapper: tocW, checkbox: tocCb } = makeCheckbox('Table of Contents', false);
        this.standaloneCb = standaloneCb;
        this.tocCb = tocCb;
        optRow.appendChild(standaloneW);
        optRow.appendChild(tocW);
        controls.appendChild(optRow);

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
        this.convertBtn = makeButton('Convert', 'background:#4CAF50;color:white;');
        this.convertBtn.onclick = () => this._convert();
        this.saveBtn = makeButton('Save as file', 'background:#2196F3;color:white;display:none;');
        this.saveBtn.onclick = () => this._saveAsFile();
        this.statusSpan = document.createElement('span');
        this.statusSpan.style.cssText = 'font-size:11px;color:#999;margin-left:8px;';
        this.statusSpan.textContent = 'Ready';
        btnRow.appendChild(this.convertBtn);
        btnRow.appendChild(this.saveBtn);
        btnRow.appendChild(this.statusSpan);
        controls.appendChild(btnRow);

        this.rootElement.appendChild(controls);

        // Output area
        this.outputArea = document.createElement('div');
        this.outputArea.style.cssText = 'flex:1;overflow:auto;background:#1a1a1a;border-bottom:1px solid #333;position:relative;';

        this.outputPre = document.createElement('pre');
        this.outputPre.style.cssText = 'margin:0;padding:10px;font-size:12px;font-family:"Cascadia Code","Fira Code",monospace;color:#ccc;white-space:pre-wrap;word-wrap:break-word;';
        this.outputPre.textContent = 'Output will appear here after conversion.';

        this.outputIframe = document.createElement('iframe');
        this.outputIframe.style.cssText = 'width:100%;height:100%;border:none;background:white;display:none;';

        this.outputArea.appendChild(this.outputPre);
        this.outputArea.appendChild(this.outputIframe);
        this.rootElement.appendChild(this.outputArea);

        // Diagnostics area
        this.diagnostics = document.createElement('div');
        this.diagnostics.style.cssText = 'height:60px;background:#212529;color:#f8f9fa;font-family:monospace;font-size:11px;white-space:pre-wrap;padding:6px 10px;overflow-y:auto;flex-shrink:0;';
        this.diagnostics.textContent = '';
        this.rootElement.appendChild(this.diagnostics);
    }

    _makeRow(label) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:12px;min-width:50px;color:#aaa;';
        row.appendChild(lbl);
        return row;
    }

    _onSourceChange() {
        const fileId = this.sourceSelect.value;
        const file = this.projectFiles[fileId];
        if (file) {
            const from = detectFormat(file.name);
            this.fromSelect.value = from;
        }
    }

    async _convert() {
        const fileId = this.sourceSelect.value;
        const file = this.projectFiles[fileId];
        if (!file) {
            this.statusSpan.textContent = 'No source file selected';
            this.statusSpan.style.color = '#f88';
            return;
        }

        const from = this.fromSelect.value;
        const to = this.toSelect.value;

        this.convertBtn.disabled = true;
        this.statusSpan.style.color = '#999';
        this.statusSpan.textContent = 'Loading pandoc-wasm...';
        this.diagnostics.textContent = '';

        const loaded = await ensurePandocLoaded();
        if (!loaded) {
            this.statusSpan.textContent = 'Failed to load pandoc-wasm';
            this.statusSpan.style.color = '#f88';
            this.convertBtn.disabled = false;
            return;
        }

        this.statusSpan.textContent = 'Converting...';

        try {
            // Build virtual files from project
            const files = {};
            Object.values(this.projectFiles).forEach(f => {
                if (f.name && f.content !== undefined) {
                    files[f.name] = f.content;
                }
            });

            const opts = { from, to };
            if (this.standaloneCb.checked) opts.standalone = true;
            if (this.tocCb.checked) opts['table-of-contents'] = true;

            const result = await pandocConvert(opts, file.content, files);

            this._lastOutput = result.stdout || '';
            this._lastOutputFormat = to;

            // Show output
            if (to === 'html' && this.standaloneCb.checked) {
                this.outputPre.style.display = 'none';
                this.outputIframe.style.display = '';
                this.outputIframe.srcdoc = this._lastOutput;
            } else {
                this.outputIframe.style.display = 'none';
                this.outputPre.style.display = '';
                this.outputPre.textContent = this._lastOutput;
            }

            // Show warnings/stderr
            if (result.stderr) {
                this.diagnostics.textContent = result.stderr;
            } else {
                this.diagnostics.textContent = '';
            }

            this.statusSpan.textContent = 'Done';
            this.statusSpan.style.color = '#4CAF50';
            this.saveBtn.style.display = '';

        } catch (err) {
            log.error('Pandoc conversion failed:', err);
            this.statusSpan.textContent = 'Error';
            this.statusSpan.style.color = '#f88';
            this.diagnostics.textContent = err.message || String(err);
        }

        this.convertBtn.disabled = false;
    }

    _saveAsFile() {
        if (!this._lastOutput) return;

        const fileId = this.sourceSelect.value;
        const file = this.projectFiles[fileId];
        if (!file) return;

        const ctx = PandocConvertComponent._ctx;
        const format = OUTPUT_FORMATS.find(f => f.id === this._lastOutputFormat);
        const ext = format ? format.ext : 'txt';
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const newName = baseName + '.' + ext;

        // Check if file already exists
        const existing = Object.values(this.projectFiles).find(f => f.name === newName);
        if (existing) {
            existing.content = this._lastOutput;
            this.statusSpan.textContent = `Updated ${newName}`;
        } else if (ctx && ctx.createFile) {
            const newId = ctx.createFile(newName, this._lastOutput);
            this.statusSpan.textContent = `Created ${newName}`;

            // Update the source dropdown
            const opt = document.createElement('option');
            opt.value = newId;
            opt.textContent = newName;
            this.sourceSelect.appendChild(opt);
        }
        this.statusSpan.style.color = '#4CAF50';
    }
}

registerPlugin({
    id: 'pandoc',
    name: 'Pandoc',
    components: {
        pandocConvert: PandocConvertComponent,
    },
    toolbarButtons: [
        { label: 'Pandoc', title: 'Open Pandoc Converter', style: 'font-weight:bold;' },
    ],
    contextMenuItems: [{
        label: 'Convert with Pandoc...',
        canHandle: (fileName) => {
            const ext = fileName.split('.').pop().toLowerCase();
            return ext in FORMAT_MAP;
        },
        action: (fileId) => {
            // openPluginPanel is set on the class via init()
            if (PandocConvertComponent._openPanel) {
                PandocConvertComponent._openPanel(fileId);
            }
        },
    }],
    init(ctx) {
        PandocConvertComponent._ctx = ctx;
        PandocConvertComponent._openPanel = (fileId) => {
            ctx.openPluginPanel('pandocConvert', 'Pandoc Convert', { fileId });
        };
    },
});
