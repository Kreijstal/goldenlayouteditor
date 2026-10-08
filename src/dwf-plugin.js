// --- DWF / DWFx viewer ---
// Autodesk Design Web Format: DWF (.dwf; DWF 6 packages, and the readable ASCII
// WHIP! streams AutoCAD R14 wrote) and DWFx (.dwfx, its XPS-based successor),
// drawn by dwf-viewer (loaded from jsDelivr when one is opened, the same build
// src/xps.js uses for XPS). Each sheet of a published set is a page: W2D sheets
// (DWF) and XPS FixedPages (DWFx) in 2D, dragging pans, the wheel zooms; an
// eModel's W3D/HSF meshes in 3D, dragging turns the model (with Shift or the
// right button pans), its assembly tree beside it. Also draws thumbnails in the
// file browser's grid: the first sheet, or the model.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const DWF_VIEWER = 'https://cdn.jsdelivr.net/npm/dwf-viewer@0.6.7/dist/index.js';
// Its rasterizer for dense W2D sheets when WebGL is not there
const DWF_WASM = 'https://cdn.jsdelivr.net/npm/dwf-viewer@0.6.7/public/dwfv-render.wasm';

const DWF_NAME_RE = /\.(dwf|dwfx)$/i;
const KINDS = { 'xps-fixed-page': '2D sheet (XPS)', 'w2d-text': '2D sheet (W2D)', 'w3d-model': '3D model (W3D)', image: 'image', unsupported: 'not drawn' };
const THUMB_SIZE = 256;
const MAX_THUMB_BYTES = 32 * 1024 * 1024;
let _ctx = null;
let _lib = null;

function ensureLib() {
    if (!_lib) {
        _lib = import(DWF_VIEWER);
        _lib.catch(() => { _lib = null; });
    }
    return _lib;
}

function workspaceUrl(rel) {
    return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
}

// A project file's bytes
async function readBytes(file) {
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await workspaceUrl(_ctx.getRelativePath(file.id)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

// "DWF 6.00", "ASCII DWF 0.34 (AutoCAD R14)", "DWFx": what the file says it is; null when it is
// neither a DWF ("(DWF V" and a version) nor a zip (a DWFx, or a DWF package without the header)
function describeFile(bytes) {
    const head = String.fromCharCode(...bytes.subarray(0, 12));
    const m = /^\(DWF V(\d\d)\.(\d\d)\)/.exec(head);
    if (m) {
        const ver = `${+m[1]}.${m[2]}`;
        return +m[1] < 6 ? `ASCII DWF ${ver}` : `DWF ${ver}`;
    }
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
    return null;
}

// The document dwf-viewer reads from the bytes; throws for what is not a DWF or DWFx
async function openDocument(bytes, name) {
    const what = describeFile(bytes);
    if (!what) throw new Error('not a DWF or DWFx file (it starts with neither "(DWF V" nor a zip header)');
    const dwf = await ensureLib();
    // (it keeps the bytes it is given: a copy, so the caller's stay whole)
    const doc = await dwf.openDwfDocument(bytes.slice(), { fileName: name });
    if (doc.kind === 'unknown' && what === 'zip') throw new Error('a zip, but no DWF manifest or XPS pages in it');
    if (!doc.pageData.length) throw new Error('no sheets in it');
    return { dwf, doc, what: what === 'zip' ? (doc.kind === 'dwfx' ? 'DWFx' : 'DWF package') : what };
}

class DwfComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'drawing.dwf';
        this.viewer = null;
        this.doc = null;
        this.root = container.element;
        this.root.classList.add('dwf-root');
        DwfComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (DwfComponent._styled) return;
        DwfComponent._styled = true;
        const style = document.createElement('style');
        // (dwf-viewer's own layout, after its styles/dwf-viewer.css, with its toolbar left out for ours)
        style.textContent = `
.dwf-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.dwf-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.dwf-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.dwf-root button,.dwf-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit}
.dwf-root button{cursor:pointer}
.dwf-root button:hover{background:#444c56}
.dwf-root button.on{background:#316dca;border-color:#4184e4}
.dwf-root button:disabled{opacity:.45;cursor:default}
.dwf-root select{max-width:320px}
.dwf-title{font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwf-stage{position:relative;min-height:0;overflow:hidden}
.dwf-stage .dwfv-root{height:100%;min-height:0;display:grid;grid-template-rows:1fr}
.dwf-stage .dwfv-toolbar{display:none}
.dwf-stage .dwfv-workspace{min-height:0;display:grid;grid-template-columns:minmax(200px,280px) 1fr}
.dwf-stage .dwfv-tree{overflow:auto;border-right:1px solid #444c56;background:#22272e;color:#e6edf3;padding:6px 8px}
.dwf-stage .dwfv-tree[style*="display: none"]+.dwfv-stage{grid-column:1/-1}
.dwf-stage.notree .dwfv-tree{display:none!important}
.dwf-stage.notree .dwfv-stage{grid-column:1/-1}
.dwf-stage .dwfv-tree-header{font-weight:600;margin-bottom:4px}
.dwf-stage .dwfv-tree-stats{color:#adbac7;margin-bottom:8px}
.dwf-stage .dwfv-tree details{margin-left:8px}
.dwf-stage .dwfv-tree summary{cursor:pointer;padding:1px 0;white-space:nowrap}
.dwf-stage .dwfv-tree-meta{color:#768390;font:10px ui-monospace,monospace;padding-left:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dwf-stage .dwfv-stage{position:relative;overflow:hidden;background:#545d68}
.dwf-stage .dwfv-canvas{position:absolute;inset:0;width:100%;height:100%}
.dwf-stage .dwfv-webgl-canvas{pointer-events:none}
.dwf-stage .dwfv-overlay-canvas{pointer-events:auto;touch-action:none;cursor:grab}
.dwf-stage .dwfv-overlay-canvas:active{cursor:grabbing}
.dwf-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.dwf-status .dwf-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.dwf-message{position:absolute;inset:0;padding:20px;color:#adbac7;text-align:center}
.dwf-error{position:absolute;inset:0;padding:20px;color:#ff7b72;text-align:center;white-space:pre-wrap;background:#1f2328}
`;
        document.head.appendChild(style);
    }

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    _button(label, title, onClick) {
        const b = this._el('button', null, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _buildUI() {
        const shell = this._el('div', 'dwf-shell');
        const bar = this._el('div', 'dwf-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.dwf,.dwfx';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            this.fileId = null;
            this.fileName = f.name;
            this._show(new Uint8Array(await f.arrayBuffer()));
        });
        this.titleEl = this._el('span', 'dwf-title', this.fileName);
        this.pageSelect = this._el('select');
        this.pageSelect.title = 'Sheet';
        this.pageSelect.addEventListener('change', () => this._goTo(this.pageSelect.selectedIndex));
        this.prevButton = this._button('‹', 'Previous sheet (Page Up)', () => this._goTo(this.pageSelect.selectedIndex - 1));
        this.nextButton = this._button('›', 'Next sheet (Page Down)', () => this._goTo(this.pageSelect.selectedIndex + 1));
        this.treeButton = this._button('Tree', 'Show or hide the model\'s assembly tree', () => {
            this.stage.classList.toggle('notree');
            this.treeButton.classList.toggle('on', !this.stage.classList.contains('notree'));
        });
        this.treeButton.classList.add('on');
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a DWF or DWFx file from this computer', () => this.fileInput.click()),
            this.titleEl,
            this.prevButton, this.pageSelect, this.nextButton,
            this._button('Fit', 'Show the whole sheet, or the model as it was saved (0)', () => this._fit()),
            this._button('−', 'Zoom out (−)', () => this._zoomBy(0.8)),
            this._button('+', 'Zoom in (+)', () => this._zoomBy(1.25)),
            this.treeButton,
        );
        this.stage = this._el('div', 'dwf-stage');
        this.stage.tabIndex = 0;
        this.messageEl = this._el('div', 'dwf-message', 'Open an Autodesk DWF or DWFx file.');
        this.stage.appendChild(this.messageEl);
        const status = this._el('div', 'dwf-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'dwf-warn', '');
        status.append(this.infoEl, this.warnEl);
        shell.append(bar, this.stage, status);
        this.root.appendChild(shell);
        this._updatePager();
        this.stage.addEventListener('keydown', e => {
            if (!this.doc || e.ctrlKey || e.metaKey || e.altKey) return;
            const i = this.pageSelect.selectedIndex;
            const keys = {
                '+': () => this._zoomBy(1.25), '=': () => this._zoomBy(1.25), '-': () => this._zoomBy(0.8), '0': () => this._fit(),
                PageUp: () => this._goTo(i - 1), PageDown: () => this._goTo(i + 1),
            };
            if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
        });
        this.stage.addEventListener('pointerdown', () => this.stage.focus());
    }

    async _init() {
        if (!this.fileId || !_ctx) return;
        const file = _ctx.projectFiles[this.fileId];
        if (!file) return;
        let bytes;
        try {
            bytes = await readBytes(file);
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        await this._show(bytes);
    }

    async _show(bytes) {
        this.titleEl.textContent = this.fileName;
        this.titleEl.title = this.fileName;
        this.infoEl.textContent = 'Reading…';
        this.warnEl.textContent = '';
        try {
            const what = describeFile(bytes);
            if (!what) throw new Error('not a DWF or DWFx file (it starts with neither "(DWF V" nor a zip header)');
            const dwf = await ensureLib();
            if (!this.viewer) {
                const self = this;
                this.host = this._el('div');
                this.host.style.height = '100%';
                this.stage.appendChild(this.host);
                this.viewer = new dwf.DwfViewer(this.host, {
                    wasmUrl: DWF_WASM, background: '#ffffff', lineWeightMode: 'adaptive', maxDevicePixelRatio: 2,
                });
                // its model tree's heading, in English
                const populate = this.viewer.populateModelTree;
                this.viewer.populateModelTree = function () {
                    populate.call(this);
                    const page = this.doc && this.doc.pageData[this.pageIndex];
                    const head = this.treePanel.querySelector('.dwfv-tree-header');
                    if (head && page) head.textContent = `Model · ${page.model.stats.nodeCount || 0} nodes`;
                };
                // the backend it drew with, for the status bar
                const render = this.viewer.render;
                this.viewer.render = async function () {
                    const stats = await render.call(this);
                    if (stats) { self.lastStats = stats; self._showStats(stats); }
                    return stats;
                };
            }
            this.messageEl.remove();
            if (this.errorEl) { this.errorEl.remove(); this.errorEl = null; }
            this.doc = null;
            this.lastStats = null;
            // (it keeps the bytes it is given: a copy, so ours stay whole)
            await this.viewer.load(bytes.slice(), { fileName: this.fileName });
            const doc = this.viewer.getDocument();
            if (doc.kind === 'unknown' && what === 'zip') throw new Error('a zip, but no DWF manifest or XPS pages in it');
            if (!doc.pageData.length) throw new Error('no sheets in it');
            this.what = what === 'zip' ? (doc.kind === 'dwfx' ? 'DWFx' : 'DWF package') : what;
            this.doc = doc;
            this.pageSelect.replaceChildren(...doc.pageData.map((p, i) => this._el('option', null, `${i + 1}. ${p.name}`)));
            this.pageSelect.selectedIndex = 0;
            this._updatePager();
            this._showStats(this.lastStats);
        } catch (err) {
            this.infoEl.textContent = '';
            this._error(`Could not show ${this.fileName}: ${err.message}`);
        }
    }

    _goTo(i) {
        if (!this.doc || i < 0 || i >= this.doc.pageData.length) return;
        // (its own page list, hidden with its toolbar, turns the page and fits it)
        this.viewer.pageSelect.selectedIndex = i;
        this.viewer.pageSelect.dispatchEvent(new Event('change'));
        this.pageSelect.selectedIndex = i;
        this._updatePager();
    }

    _updatePager() {
        const n = this.doc ? this.doc.pageData.length : 0;
        const i = this.pageSelect.selectedIndex;
        this.pageSelect.disabled = n < 2;
        this.prevButton.disabled = !(i > 0);
        this.nextButton.disabled = !(i < n - 1);
        const page = this.doc && this.doc.pageData[i];
        this.treeButton.hidden = !(page && page.kind === 'w3d-model' && page.model.sceneTree && page.model.sceneTree.length);
    }

    // The status bar: the file's format, the sheet's kind and size or the model's meshes, what it was drawn with
    // and what dwf-viewer could not draw
    _showStats(stats) {
        const page = this.doc && this.doc.pageData[this.pageSelect.selectedIndex];
        if (!page) return;
        const parts = [this.what, `sheet ${this.pageSelect.selectedIndex + 1} of ${this.doc.pageData.length}`, KINDS[page.kind] || page.kind];
        if (page.kind === 'xps-fixed-page') parts.push(`${fmt(page.width / 96)} × ${fmt(page.height / 96)} in`);
        if (page.kind === 'w3d-model') {
            const s = page.model.stats;
            parts.push(`${s.meshCount} meshes, ${s.triangleCount.toLocaleString()} triangles`);
        }
        if (stats) parts.push(`drawn by ${stats.backend}`);
        this.infoEl.textContent = parts.join(' · ');
        const warnings = (stats ? stats.warnings : page.diagnostics).filter(d => d.level !== 'info');
        this.warnEl.textContent = warnings.length ? `${warnings.length} not drawn: ${warnings.map(w => w.message).join('; ')}` : '';
        this.warnEl.title = this.warnEl.textContent;
    }

    _fit() {
        if (this.doc) this.viewer.fit();
    }

    _zoomBy(factor) {
        if (!this.doc) return;
        this.viewer.zoomAtCenter(factor);
        this.viewer.requestRender();
    }

    _error(msg) {
        if (!this.errorEl) this.errorEl = this._el('div', 'dwf-error');
        this.errorEl.textContent = msg;
        this.stage.appendChild(this.errorEl);
    }

    _destroy() {
        if (this.viewer) this.viewer.dispose();
        this.viewer = null;
    }
}

function fmt(v) {
    return (+v.toFixed(2)).toString();
}

// Thumbnails: the first sheet (or the model) drawn one file at a time; a model through one WebGL canvas
let _thumbQueue = Promise.resolve();
let _thumbGl = null;

function drawThumbnail(bytes, name) {
    const job = _thumbQueue.then(async () => {
        const { dwf, doc } = await openDocument(bytes, name);
        const page = doc.pageData[0];
        const renderer = new dwf.PageRenderer(doc);
        try {
            const canvas = document.createElement('canvas');
            const aspect = page.kind === 'w3d-model' ? 1 : page.width / page.height;
            canvas.width = Math.max(1, Math.round(THUMB_SIZE * Math.min(1, aspect)));
            canvas.height = Math.max(1, Math.round(THUMB_SIZE * Math.min(1, 1 / aspect)));
            const options = { preferWebgl: false, preferWasm: false, background: '#ffffff', lineWeightMode: 'hairline' };
            if (page.kind === 'w3d-model') {
                if (!_thumbGl) _thumbGl = document.createElement('canvas');
                _thumbGl.width = canvas.width;
                _thumbGl.height = canvas.height;
                options.webglCanvas = _thumbGl;
            }
            const stats = await renderer.render(0, canvas, options);
            if (stats.backend === 'unsupported') throw new Error('nothing drawn');
            // (the model is on the WebGL canvas, read before the browser clears it)
            if (page.kind === 'w3d-model') canvas.getContext('2d').drawImage(_thumbGl, 0, 0);
            return canvas;
        } finally {
            renderer.dispose();
        }
    });
    _thumbQueue = job.catch(() => {});
    return job;
}

registerPlugin({
    id: 'dwf',
    name: 'Autodesk DWF and DWFx',
    components: {
        dwfViewer: DwfComponent,
    },
    toolbarButtons: [
        { label: 'DWF', title: 'Open the DWF / DWFx viewer', menuLabel: 'Autodesk DWF and DWFx' },
    ],
    thumbnailRenderers: [{
        canHandle: file => DWF_NAME_RE.test(file.name) && !(file.size > MAX_THUMB_BYTES),
        async render(file, container) {
            const canvas = await drawThumbnail(await readBytes(file), file.name);
            canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#ffffff';
            container.innerHTML = '';
            container.appendChild(canvas);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
