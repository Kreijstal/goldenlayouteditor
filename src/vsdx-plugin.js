// --- VSDX Plugin ---
// Uses the VSDX editor modules directly from GitHub via esm.sh.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('VSDX');
const VSDX_PARSER_URL = 'https://esm.sh/gh/Kreijstal/vsdxeditor/src/vsdx-parser.js';
const VSD_PARSER_URL = 'https://esm.sh/gh/Kreijstal/vsdxeditor/src/vsd-parser.js';
const VSDX_RENDERER_URL = 'https://esm.sh/gh/Kreijstal/vsdxeditor/src/svg-renderer.js';

let _libsPromise = null;
async function loadVsdxLibs() {
    if (!_libsPromise) {
        _libsPromise = (async () => {
            const [vsdxParser, vsdParser, renderer] = await Promise.all([
                import(VSDX_PARSER_URL),
                import(VSD_PARSER_URL),
                import(VSDX_RENDERER_URL),
            ]);
            return {
                parseVsdx: vsdxParser.parseVsdx,
                saveVsdxLayerPermissions: vsdxParser.saveVsdxLayerPermissions,
                getVsdxShapeXmlSnippet: vsdxParser.getVsdxShapeXmlSnippet,
                replaceVsdxShapeXmlSnippet: vsdxParser.replaceVsdxShapeXmlSnippet,
                parseVsd: vsdParser.parseVsd,
                renderPage: renderer.renderPage,
            };
        })();
    }
    return _libsPromise;
}

function bytesToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

function walkShapes(shapes, cb, depth = 0) {
    for (const shape of shapes || []) {
        cb(shape, depth);
        walkShapes(shape.subShapes, cb, depth + 1);
    }
}

class VsdxViewerComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = VsdxViewerComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || this.state.fileName || 'diagram.vsdx';
        this.fileType = /\.vsd$/i.test(this.fileName) ? 'vsd' : 'vsdx';
        this.buffer = null;
        this.pages = [];
        this.currentPageIndex = 0;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.isPanning = false;
        this.selectedShape = null;
        this.dirty = false;

        this.root = container.element;
        this.root.classList.add('vsdx-plugin-root');
        this._installStyles();
        this._buildUI();

        if (container.on) {
            container.on('resize', () => this._fitViewport());
            container.on('destroy', () => this._destroy());
        }

        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (VsdxViewerComponent._styleInstalled) return;
        VsdxViewerComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.vsdx-plugin-root{height:100%;background:#1f2328;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.vsdx-shell{display:grid;grid-template-rows:auto auto 1fr;height:100%}
.vsdx-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#24292f;border-bottom:1px solid #394049;white-space:nowrap;overflow:auto}
.vsdx-toolbar button,.vsdx-side button{background:#30363d;color:#e6edf3;border:1px solid #57606a;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.vsdx-toolbar button:hover,.vsdx-side button:hover{background:#3b434c}
.vsdx-toolbar button:disabled,.vsdx-side button:disabled{opacity:.45;cursor:not-allowed}
.vsdx-title{font-weight:600;color:#f0f3f6;min-width:80px;max-width:280px;overflow:hidden;text-overflow:ellipsis}
.vsdx-status{margin-left:auto;color:#9da7b1;font-size:12px}
.vsdx-tabs{display:flex;gap:0;background:#24292f;border-bottom:1px solid #394049;overflow:auto}
.vsdx-tabs button{border:0;border-right:1px solid #394049;background:transparent;color:#c9d1d9;padding:7px 14px;cursor:pointer}
.vsdx-tabs button.active{background:#0969da;color:white}
.vsdx-main{display:grid;grid-template-columns:1fr 280px;min-height:0}
.vsdx-viewport{position:relative;overflow:hidden;background:#f6f8fa;cursor:grab}
.vsdx-canvas{position:absolute;left:24px;top:24px;transform-origin:0 0}
.vsdx-canvas svg{display:block;background:white;box-shadow:0 2px 12px rgba(0,0,0,.22)}
.vsdx-canvas g[data-shape-id].selected>*{outline:2px solid #0969da}
.vsdx-side{display:grid;grid-template-rows:auto minmax(160px,1fr) minmax(120px,1fr);min-width:0;border-left:1px solid #394049;background:#1f2328}
.vsdx-side-section{min-height:0;border-bottom:1px solid #394049;display:flex;flex-direction:column}
.vsdx-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#9da7b1;margin:0;padding:8px 10px;border-bottom:1px solid #30363d}
.vsdx-list{overflow:auto;padding:6px}
.vsdx-layer{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;padding:4px;border-radius:4px}
.vsdx-layer input[type=text]{min-width:0;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:3px;padding:3px 5px}
.vsdx-shape{display:block;width:100%;text-align:left;margin:0 0 3px 0;overflow:hidden;text-overflow:ellipsis}
.vsdx-empty,.vsdx-error{padding:18px;color:#9da7b1}
.vsdx-error{color:#ffb4b4}
.vsdx-drop{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:#8b949e}
.vsdx-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
.vsdx-dialog{width:min(900px,90vw);height:min(620px,82vh);background:#1f2328;border:1px solid #57606a;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.vsdx-dialog textarea{flex:1;resize:none;margin:10px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;padding:10px}
.vsdx-dialog-actions{display:flex;justify-content:flex-end;gap:8px;padding:0 10px 10px}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'vsdx-shell';

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'vsdx-toolbar';
        this.openInput = document.createElement('input');
        this.openInput.type = 'file';
        this.openInput.accept = '.vsd,.vsdx';
        this.openInput.style.display = 'none';
        this.openInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.openInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local VSD/VSDX file', () => this.openInput.click()));
        this.saveBtn = makeButton('Save', 'Save VSDX changes to workspace or download', () => this._save());
        this.saveBtn.disabled = true;
        this.toolbar.appendChild(this.saveBtn);
        this.toolbar.appendChild(makeButton('Download', 'Download current VSDX', () => this._download()));
        this.toolbar.appendChild(makeButton('+', 'Zoom in', () => this._setZoom(this.zoom * 1.2)));
        this.toolbar.appendChild(makeButton('-', 'Zoom out', () => this._setZoom(this.zoom / 1.2)));
        this.toolbar.appendChild(makeButton('Fit', 'Reset view', () => this._resetView()));
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'vsdx-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'vsdx-status';
        this.toolbar.appendChild(this.statusEl);

        this.tabsEl = document.createElement('div');
        this.tabsEl.className = 'vsdx-tabs';

        this.main = document.createElement('div');
        this.main.className = 'vsdx-main';
        this.viewport = document.createElement('div');
        this.viewport.className = 'vsdx-viewport';
        this.canvas = document.createElement('div');
        this.canvas.className = 'vsdx-canvas';
        this.viewport.appendChild(this.canvas);
        this.side = document.createElement('div');
        this.side.className = 'vsdx-side';
        this.side.innerHTML = `
<div class="vsdx-side-section"><h3>Layers</h3><div class="vsdx-list" data-role="layers"></div></div>
<div class="vsdx-side-section"><h3>Shapes</h3><div class="vsdx-list" data-role="shapes"></div></div>
<div class="vsdx-side-section"><h3>Selection</h3><div class="vsdx-list" data-role="selection"></div></div>`;
        this.layersEl = this.side.querySelector('[data-role="layers"]');
        this.shapesEl = this.side.querySelector('[data-role="shapes"]');
        this.selectionEl = this.side.querySelector('[data-role="selection"]');
        this.main.appendChild(this.viewport);
        this.main.appendChild(this.side);

        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.tabsEl);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);

        this.viewport.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.viewport.addEventListener('mousedown', (e) => this._startPan(e));
        this._moveHandler = (e) => this._movePan(e);
        this._upHandler = () => this._endPan();
        window.addEventListener('mousemove', this._moveHandler);
        window.addEventListener('mouseup', this._upHandler);
    }

    async _init() {
        try {
            await loadVsdxLibs();
            if (this.fileData) {
                await this._loadProjectFile();
            } else {
                this.statusEl.textContent = 'Open or drop a .vsd/.vsdx file';
                this.canvas.innerHTML = '<div class="vsdx-drop">Open a VSD or VSDX file to view and edit it.</div>';
            }
        } catch (err) {
            this._showError(`Failed to load VSDX modules: ${err.message}`);
        }
    }

    async _loadProjectFile() {
        if (!this.ctx || !this.fileData) return;
        this.statusEl.textContent = 'Loading...';
        const relPath = this.ctx.getRelativePath(this.fileId);
        if (this.ctx.currentWorkspacePath && relPath) {
            const url = '/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + relPath);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._loadBuffer(await resp.arrayBuffer(), this.fileData.name);
            return;
        }
        this._showError('This VSDX file is not backed by a workspace file. Use Open to load it locally.');
    }

    async _loadFileObject(file) {
        await this._loadBuffer(await file.arrayBuffer(), file.name);
        this.fileId = null;
        this.fileData = null;
    }

    async _loadBuffer(buffer, name) {
        const libs = await loadVsdxLibs();
        this.buffer = buffer;
        this.fileName = name;
        this.fileType = /\.vsd$/i.test(name) ? 'vsd' : 'vsdx';
        this.titleEl.textContent = name;
        this.statusEl.textContent = 'Parsing...';
        const result = this.fileType === 'vsd' ? await libs.parseVsd(buffer) : await libs.parseVsdx(buffer);
        this.pages = result.pages || [];
        const firstForeground = this.pages.findIndex(page => !page.isBackground);
        this.currentPageIndex = firstForeground >= 0 ? firstForeground : 0;
        this.selectedShape = null;
        this.dirty = false;
        this._renderAll();
    }

    _renderAll() {
        this._buildTabs();
        this._renderCurrentPage();
        this._renderLayers();
        this._renderShapes();
        this._renderSelection();
        this._updateStatus();
    }

    _buildTabs() {
        this.tabsEl.innerHTML = '';
        this.pages.forEach((page, index) => {
            if (page.isBackground) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = page.name || `Page ${index + 1}`;
            btn.className = index === this.currentPageIndex ? 'active' : '';
            btn.addEventListener('click', () => {
                this.currentPageIndex = index;
                this.selectedShape = null;
                this._renderAll();
            });
            this.tabsEl.appendChild(btn);
        });
    }

    _currentPage() {
        return this.pages[this.currentPageIndex] || null;
    }

    _renderCurrentPage() {
        const page = this._currentPage();
        this.canvas.innerHTML = '';
        if (!page) {
            this.canvas.innerHTML = '<div class="vsdx-empty">No pages found.</div>';
            return;
        }
        const background = page.backPage ? this.pages.find(p => String(p.id) === String(page.backPage)) : null;
        const rendered = background ? { ...page, shapes: [...(background.shapes || []), ...(page.shapes || [])] } : page;
        loadVsdxLibs().then(libs => {
            this.canvas.innerHTML = '';
            libs.renderPage(rendered, this.canvas);
            this._applyLayerVisibility();
            this._wireShapeSelection();
            this._syncSelectionHighlight();
            this._updateTransform();
        }).catch(err => this._showError(err.message));
    }

    _renderLayers() {
        const page = this._currentPage();
        this.layersEl.innerHTML = '';
        if (!page || !page.layers || page.layers.length === 0) {
            this.layersEl.innerHTML = '<div class="vsdx-empty">No layers on this page.</div>';
            return;
        }
        for (const layer of page.layers) {
            const row = document.createElement('div');
            row.className = 'vsdx-layer';
            const visible = document.createElement('input');
            visible.type = 'checkbox';
            visible.checked = layer.visible !== false;
            visible.title = 'Visible';
            visible.addEventListener('change', () => {
                layer.visible = visible.checked;
                this._markDirty();
                this._applyLayerVisibility();
            });
            const name = document.createElement('input');
            name.type = 'text';
            name.value = layer.name || `Layer ${layer.index}`;
            name.addEventListener('change', () => {
                layer.name = name.value;
                this._markDirty();
            });
            const print = document.createElement('input');
            print.type = 'checkbox';
            print.checked = layer.print !== false;
            print.title = 'Print';
            print.addEventListener('change', () => {
                layer.print = print.checked;
                this._markDirty();
            });
            row.appendChild(visible);
            row.appendChild(name);
            row.appendChild(print);
            this.layersEl.appendChild(row);
        }
    }

    _renderShapes() {
        const page = this._currentPage();
        this.shapesEl.innerHTML = '';
        if (!page || !page.shapes || page.shapes.length === 0) {
            this.shapesEl.innerHTML = '<div class="vsdx-empty">No shapes.</div>';
            return;
        }
        walkShapes(page.shapes, (shape, depth) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'vsdx-shape';
            btn.style.paddingLeft = `${8 + depth * 14}px`;
            btn.textContent = `${shape.name || shape.nameU || 'Shape'} (${shape.id})`;
            btn.addEventListener('click', () => this._selectShape(shape));
            this.shapesEl.appendChild(btn);
        });
    }

    _renderSelection() {
        this.selectionEl.innerHTML = '';
        const shape = this.selectedShape;
        if (!shape) {
            this.selectionEl.innerHTML = '<div class="vsdx-empty">Select a shape in the drawing or list.</div>';
            return;
        }
        const name = document.createElement('input');
        name.type = 'text';
        name.value = shape.name || shape.nameU || '';
        name.placeholder = 'Shape name';
        name.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:8px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:3px;padding:5px;';
        name.addEventListener('change', () => {
            shape.name = name.value;
            this._markDirty();
            this._renderShapes();
        });
        this.selectionEl.appendChild(name);

        const xmlBtn = makeButton('Edit XML', 'Edit selected VSDX shape XML', () => this._openShapeXmlEditor(shape));
        xmlBtn.disabled = this.fileType !== 'vsdx';
        this.selectionEl.appendChild(xmlBtn);
    }

    _applyLayerVisibility() {
        const page = this._currentPage();
        const svg = this.canvas.querySelector('svg');
        if (!page || !svg) return;
        const hidden = new Set((page.layers || []).filter(layer => layer.visible === false).map(layer => String(layer.index)));
        svg.querySelectorAll('g[data-layers]').forEach(g => {
            const layers = (g.getAttribute('data-layers') || '').split(',').filter(Boolean);
            g.style.display = layers.length && layers.every(layer => hidden.has(String(layer))) ? 'none' : '';
        });
    }

    _wireShapeSelection() {
        this.canvas.querySelectorAll('g[data-shape-id]').forEach(g => {
            g.style.cursor = 'pointer';
            g.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = g.getAttribute('data-shape-id');
                const page = this._currentPage();
                let found = null;
                walkShapes(page ? page.shapes : [], shape => {
                    if (String(shape.id) === String(id)) found = shape;
                });
                if (found) this._selectShape(found);
            });
        });
    }

    _selectShape(shape) {
        this.selectedShape = shape;
        this._syncSelectionHighlight();
        this._renderSelection();
    }

    _syncSelectionHighlight() {
        const selectedId = this.selectedShape ? String(this.selectedShape.id) : null;
        this.canvas.querySelectorAll('g[data-shape-id]').forEach(g => {
            g.classList.toggle('selected', selectedId && g.getAttribute('data-shape-id') === selectedId);
        });
    }

    async _openShapeXmlEditor(shape) {
        if (!this.buffer || this.fileType !== 'vsdx') return;
        const page = this._currentPage();
        const libs = await loadVsdxLibs();
        const textarea = document.createElement('textarea');
        textarea.value = await libs.getVsdxShapeXmlSnippet(this.buffer, page.id, shape.id);
        const modal = document.createElement('div');
        modal.className = 'vsdx-modal';
        const dialog = document.createElement('div');
        dialog.className = 'vsdx-dialog';
        const actions = document.createElement('div');
        actions.className = 'vsdx-dialog-actions';
        actions.appendChild(makeButton('Cancel', 'Cancel XML edit', () => modal.remove()));
        actions.appendChild(makeButton('Apply XML', 'Apply XML to current VSDX buffer', async () => {
            try {
                this.buffer = await libs.replaceVsdxShapeXmlSnippet(this.buffer, page.id, shape.id, textarea.value);
                modal.remove();
                await this._loadBuffer(this.buffer, this.fileName);
                this._markDirty();
            } catch (err) {
                alert(`Failed to apply XML: ${err.message}`);
            }
        }));
        dialog.appendChild(textarea);
        dialog.appendChild(actions);
        modal.appendChild(dialog);
        document.body.appendChild(modal);
        textarea.focus();
    }

    _markDirty() {
        this.dirty = true;
        this.saveBtn.disabled = this.fileType !== 'vsdx';
        if (this.ctx && this.fileId) this.ctx.markDirty(this.fileId);
        this._updateStatus();
    }

    async _save() {
        if (!this.buffer || this.fileType !== 'vsdx') return;
        this.statusEl.textContent = 'Saving...';
        try {
            const libs = await loadVsdxLibs();
            this.buffer = await libs.saveVsdxLayerPermissions(this.buffer, this.pages);
            if (this.ctx && this.fileId && this.ctx.currentWorkspacePath && this.ctx.wsClient && this.ctx.wsClient.isConnected()) {
                const relativePath = this.ctx.getRelativePath(this.fileId);
                const result = await this.ctx.wsClient.wsRequest({
                    type: 'saveFile',
                    workspacePath: this.ctx.currentWorkspacePath,
                    relativePath,
                    content: bytesToBase64(this.buffer),
                    encoding: 'base64',
                });
                if (!result || !result.success) throw new Error((result && result.error) || 'Save failed');
                this.dirty = false;
                if (this.ctx.clearDirty) this.ctx.clearDirty(this.fileId);
            } else {
                this._download();
                this.dirty = false;
            }
            this._updateStatus();
        } catch (err) {
            this._showError(`Save failed: ${err.message}`);
        }
    }

    _download() {
        if (!this.buffer) return;
        const blob = new Blob([this.buffer], { type: 'application/vnd.ms-visio.drawing.main+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.fileName || 'diagram.vsdx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    _updateStatus() {
        const page = this._currentPage();
        const parts = [];
        if (this.pages.length) parts.push(`${this.pages.filter(p => !p.isBackground).length} page(s)`);
        if (page) parts.push(`${Math.round(this.zoom * 100)}%`);
        if (this.fileType === 'vsd') parts.push('VSD view only');
        if (this.dirty) parts.push('modified');
        this.statusEl.textContent = parts.join(' | ');
        this.saveBtn.disabled = !this.buffer || this.fileType !== 'vsdx';
    }

    _showError(message) {
        log.error(message);
        this.statusEl.textContent = 'Error';
        this.canvas.innerHTML = `<div class="vsdx-error">${message}</div>`;
    }

    _setZoom(value) {
        this.zoom = Math.max(0.1, Math.min(20, value));
        this._updateTransform();
        this._updateStatus();
    }

    _resetView() {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this._updateTransform();
        this._updateStatus();
    }

    _updateTransform() {
        this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }

    _fitViewport() {
        this._updateTransform();
    }

    _onWheel(e) {
        e.preventDefault();
        const rect = this.viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left - 24;
        const my = e.clientY - rect.top - 24;
        const nextZoom = Math.max(0.1, Math.min(20, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
        const scale = nextZoom / this.zoom;
        this.panX = mx - scale * (mx - this.panX);
        this.panY = my - scale * (my - this.panY);
        this.zoom = nextZoom;
        this._updateTransform();
        this._updateStatus();
    }

    _startPan(e) {
        if (e.button !== 0 || e.target.closest('g[data-shape-id]')) return;
        this.isPanning = true;
        this.panStartX = e.clientX - this.panX;
        this.panStartY = e.clientY - this.panY;
        this.viewport.style.cursor = 'grabbing';
    }

    _movePan(e) {
        if (!this.isPanning) return;
        this.panX = e.clientX - this.panStartX;
        this.panY = e.clientY - this.panStartY;
        this._updateTransform();
    }

    _endPan() {
        this.isPanning = false;
        if (this.viewport) this.viewport.style.cursor = 'grab';
    }

    _destroy() {
        window.removeEventListener('mousemove', this._moveHandler);
        window.removeEventListener('mouseup', this._upHandler);
    }
}

registerPlugin({
    id: 'vsdx',
    name: 'VSDX',
    components: {
        vsdxViewer: VsdxViewerComponent,
    },
    toolbarButtons: [
        { label: 'VSDX', title: 'Open VSD/VSDX Viewer' },
    ],
    contextMenuItems: [{
        label: 'Open VSD/VSDX Viewer',
        canHandle: (fileName) => /\.(vsd|vsdx)$/i.test(fileName || ''),
        action: (fileId) => {
            const ctx = VsdxViewerComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab(
                'vsdxViewer',
                { fileId },
                `${file.name} [vsdx]`,
                'vsdx-' + fileId
            );
        },
    }],
    init(ctx) {
        VsdxViewerComponent._ctx = ctx;
    },
});
