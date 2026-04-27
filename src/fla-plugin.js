// --- FLA/XFL Plugin ---
// Lazy-loads JSZip and inspects packaged Adobe Animate/Flash FLA files.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('FLA');
const JSZIP_URL = 'https://esm.sh/jszip@3.10.1';
const FLA_RE = /\.(fla|xfl)$/i;

let _jszipPromise = null;

async function ensureJsZipLoaded() {
    if (!_jszipPromise) {
        _jszipPromise = import(JSZIP_URL).then(mod => {
            const JSZip = mod.default || mod;
            if (typeof JSZip !== 'function') throw new Error('JSZip did not load');
            return JSZip;
        });
    }
    return _jszipPromise;
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error(err.textContent || 'XML parse error');
    return doc;
}

function attrMap(node) {
    const out = {};
    for (const attr of Array.from(node.attributes || [])) out[attr.name] = attr.value;
    return out;
}

function byName(doc, name) {
    return Array.from(doc.getElementsByTagName(name));
}

function entryKind(path) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.xml')) return 'xml';
    if (/\.(as|js|txt|json|html|css)$/i.test(path)) return 'text';
    if (/\.(png|jpg|jpeg|gif|bmp|svg|webp)$/i.test(path)) return 'image';
    if (/\.(mp3|wav|aif|aiff|ogg)$/i.test(path)) return 'audio';
    if (/\.(mp4|mov|flv|f4v)$/i.test(path)) return 'video';
    return 'binary';
}

async function buildFlaAst(zip) {
    const entries = [];
    zip.forEach((path, file) => {
        if (!file.dir) entries.push({ path, kind: entryKind(path), size: file._data && file._data.uncompressedSize });
    });

    const domEntry = zip.file('DOMDocument.xml') || zip.file(/(^|\/)DOMDocument\.xml$/i)[0];
    const ast = {
        format: 'FLA/XFL package',
        entryCount: entries.length,
        entries,
        document: null,
        timelines: [],
        library: [],
        media: entries.filter(item => ['image', 'audio', 'video'].includes(item.kind)),
        scripts: entries.filter(item => /\.(as|js)$/i.test(item.path)),
    };

    if (domEntry) {
        const xml = await domEntry.async('string');
        const doc = parseXml(xml);
        const root = doc.documentElement;
        ast.document = {
            path: domEntry.name,
            root: root ? root.nodeName : null,
            attributes: root ? attrMap(root) : {},
        };
        ast.timelines = byName(doc, 'DOMTimeline').map(node => ({
            name: node.getAttribute('name') || '',
            layerCount: byName(node, 'DOMLayer').length,
            frameCount: byName(node, 'DOMFrame').length,
        }));
    }

    const libraryFiles = entries.filter(item => /^LIBRARY\//i.test(item.path) && item.kind === 'xml');
    for (const item of libraryFiles.slice(0, 500)) {
        try {
            const xml = await zip.file(item.path).async('string');
            const doc = parseXml(xml);
            const root = doc.documentElement;
            ast.library.push({
                path: item.path,
                type: root ? root.nodeName : 'unknown',
                name: root ? (root.getAttribute('name') || root.getAttribute('itemID') || '') : '',
                attributes: root ? attrMap(root) : {},
            });
        } catch (err) {
            ast.library.push({ path: item.path, error: err.message });
        }
    }

    return ast;
}

class FlaInspectorComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = FlaInspectorComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'project.fla';
        this.zip = null;
        this.ast = null;
        this.selectedEntry = null;

        this.root = container.element;
        this.root.classList.add('fla-plugin-root');
        this._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (FlaInspectorComponent._styleInstalled) return;
        FlaInspectorComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.fla-plugin-root{height:100%;background:#1f2328;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.fla-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.fla-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow:auto}
.fla-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.fla-toolbar button:hover{background:#444c56}
.fla-title{font-weight:600;min-width:120px;max-width:340px;overflow:hidden;text-overflow:ellipsis}
.fla-status{margin-left:auto;color:#adbac7;font-size:12px}
.fla-main{display:grid;grid-template-columns:340px 1fr;min-height:0}
.fla-side{min-height:0;border-right:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto 1fr}
.fla-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px;border-bottom:1px solid #444c56}
.fla-entry-list{overflow:auto;padding:6px}
.fla-entry{display:block;width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px;background:#2d333b;border:1px solid #444c56;border-radius:4px;color:#e6edf3;text-align:left;cursor:pointer}
.fla-entry.active{border-color:#6cb6ff;background:#303b49}
.fla-entry-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fla-entry-meta{color:#adbac7;font-size:11px;margin-top:2px}
.fla-content{min-width:0;min-height:0;display:grid;grid-template-rows:auto 1fr;background:#1f2328}
.fla-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.fla-card{background:#2d333b;border:1px solid #444c56;border-radius:4px;padding:7px 8px;min-width:0}
.fla-card-label{color:#adbac7;font-size:11px;text-transform:uppercase}
.fla-card-value{font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fla-output{margin:0;padding:12px;overflow:auto;color:#d1d7e0;background:#1f2328;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;line-height:1.45;tab-size:2}
.fla-message,.fla-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#adbac7}
.fla-error{color:#ffb4ab}
@media (max-width:800px){.fla-main{grid-template-columns:1fr}.fla-side{display:none}.fla-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'fla-shell';
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'fla-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.fla,.xfl';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', e => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local FLA file', () => this.fileInput.click()));
        this.toolbar.appendChild(makeButton('Project AST', 'Show parsed FLA/XFL AST', () => this._renderJson(this.ast)));
        this.toolbar.appendChild(makeButton('Manifest', 'Show package entries', () => this._renderJson(this.ast && this.ast.entries)));
        this.toolbar.appendChild(makeButton('Export JSON', 'Create FLA AST JSON file', () => this._exportJson()));
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'fla-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'fla-status';
        this.toolbar.appendChild(this.statusEl);

        this.main = document.createElement('div');
        this.main.className = 'fla-main';
        this.side = document.createElement('div');
        this.side.className = 'fla-side';
        this.side.innerHTML = '<h3>Package Entries</h3><div class="fla-entry-list"></div>';
        this.entriesEl = this.side.querySelector('.fla-entry-list');
        this.content = document.createElement('div');
        this.content.className = 'fla-content';
        this.summaryEl = document.createElement('div');
        this.summaryEl.className = 'fla-summary';
        this.outputEl = document.createElement('pre');
        this.outputEl.className = 'fla-output';
        this.content.appendChild(this.summaryEl);
        this.content.appendChild(this.outputEl);
        this.main.appendChild(this.side);
        this.main.appendChild(this.content);
        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open a packaged FLA file to inspect its XFL project data.');
    }

    async _init() {
        if (this.fileData) await this._loadProjectFile();
        else this.statusEl.textContent = 'JSZip loads when a FLA is opened';
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed FLA loading requires the server workspace.');
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
        this.statusEl.textContent = 'Loading JSZip...';
        this._clear();
        try {
            const JSZip = await ensureJsZipLoaded();
            this.statusEl.textContent = 'Reading FLA package...';
            this.zip = await JSZip.loadAsync(buffer);
            this.ast = await buildFlaAst(this.zip);
            this._renderEntries();
            this._renderJson(this.ast);
            this.statusEl.textContent = `${this.ast.entryCount} file(s) | ${this.ast.library.length} library item(s)`;
        } catch (err) {
            log.error('Failed to open FLA:', err);
            this._showError(`Failed to open FLA: ${err.message}`);
        }
    }

    _renderEntries() {
        this.entriesEl.innerHTML = '';
        for (const entry of this.ast.entries) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fla-entry';
            btn.innerHTML = '<div class="fla-entry-name"></div><div class="fla-entry-meta"></div>';
            btn.querySelector('.fla-entry-name').textContent = entry.path;
            btn.querySelector('.fla-entry-meta').textContent = `${entry.kind}${entry.size !== undefined ? ` | ${entry.size} bytes` : ''}`;
            btn.addEventListener('click', () => this._selectEntry(entry));
            this.entriesEl.appendChild(btn);
        }
    }

    async _selectEntry(entry) {
        this.selectedEntry = entry;
        for (const btn of this.entriesEl.querySelectorAll('.fla-entry')) {
            btn.classList.toggle('active', btn.querySelector('.fla-entry-name').textContent === entry.path);
        }
        try {
            if (entry.kind === 'xml' || entry.kind === 'text') {
                this._renderText(await this.zip.file(entry.path).async('string'));
            } else {
                this._renderJson(entry);
            }
        } catch (err) {
            this._showError(err.message);
        }
    }

    _renderText(value) {
        this._renderSummary();
        this.outputEl.className = 'fla-output';
        this.outputEl.textContent = value;
    }

    _renderJson(value) {
        this._renderSummary();
        this.outputEl.className = 'fla-output';
        this.outputEl.textContent = JSON.stringify(value || null, null, 2);
    }

    _renderSummary() {
        const cards = [
            ['File', this.fileName],
            ['Entries', this.ast ? String(this.ast.entryCount) : '0'],
            ['Library', this.ast ? String(this.ast.library.length) : '0'],
            ['Media', this.ast ? String(this.ast.media.length) : '0'],
        ];
        this.summaryEl.innerHTML = '';
        for (const [label, value] of cards) {
            const card = document.createElement('div');
            card.className = 'fla-card';
            card.innerHTML = '<div class="fla-card-label"></div><div class="fla-card-value"></div>';
            card.querySelector('.fla-card-label').textContent = label;
            card.querySelector('.fla-card-value').textContent = value;
            this.summaryEl.appendChild(card);
        }
    }

    _exportJson() {
        if (!this.ast || !this.ctx) return;
        const name = this.fileName.replace(/\.[^.]+$/, '') + '.fla.json';
        const id = this.ctx.createFile(name, JSON.stringify(this.ast, null, 2));
        this.ctx.openEditorTab('editor', { fileId: id, filePath: name }, name, 'editor-' + id);
    }

    _showMessage(message) {
        this._clear();
        this.outputEl.className = 'fla-message';
        this.outputEl.textContent = message;
    }

    _showError(message) {
        this.outputEl.className = 'fla-error';
        this.outputEl.textContent = message;
        this.statusEl.textContent = 'Error';
    }

    _clear() {
        this.entriesEl.innerHTML = '';
        this.summaryEl.innerHTML = '';
        this.outputEl.className = 'fla-output';
        this.outputEl.textContent = '';
    }

    _destroy() {}
}

registerPlugin({
    id: 'fla',
    name: 'FLA',
    components: {
        flaInspector: FlaInspectorComponent,
    },
    toolbarButtons: [
        { label: 'FLA', title: 'Open FLA/XFL Inspector' },
    ],
    contextMenuItems: [{
        label: 'Open FLA/XFL Inspector',
        canHandle: (fileName) => FLA_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = FlaInspectorComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('flaInspector', { fileId }, `${file.name} [fla]`, 'fla-' + fileId);
        },
    }],
    init(ctx) {
        FlaInspectorComponent._ctx = ctx;
    },
});
