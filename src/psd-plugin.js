// --- PSD Plugin ---
// Lazy-loads our ag-psd fork from esm.sh when a PSD is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('PSD');
const AG_PSD_URL = 'https://esm.sh/gh/Kreijstal/ag-psd@psdjs-compat-cmyk/src/index.ts';

let _agPsdPromise = null;

async function ensureAgPsdLoaded() {
    if (!_agPsdPromise) {
        _agPsdPromise = (async () => {
            const mod = await import(AG_PSD_URL);
            if (typeof mod.readPsd !== 'function') {
                throw new Error('ag-psd did not export readPsd');
            }
            return mod;
        })();
    }
    return _agPsdPromise;
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

function walkLayers(layers, cb, depth = 0) {
    for (const layer of layers || []) {
        cb(layer, depth);
        walkLayers(layer.children, cb, depth + 1);
    }
}

class PsdViewerComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = PsdViewerComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'image.psd';
        this.psd = null;
        this.objectUrl = null;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.isPanning = false;

        this.root = container.element;
        this.root.classList.add('psd-plugin-root');
        this._installStyles();
        this._buildUI();

        if (container.on) {
            container.on('resize', () => this._updateTransform());
            container.on('destroy', () => this._destroy());
        }

        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (PsdViewerComponent._styleInstalled) return;
        PsdViewerComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.psd-plugin-root{height:100%;background:#202124;color:#e8eaed;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.psd-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.psd-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2b2d31;border-bottom:1px solid #3c4043;white-space:nowrap;overflow:auto}
.psd-toolbar button{background:#3c4043;color:#e8eaed;border:1px solid #5f6368;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.psd-toolbar button:hover{background:#4a4d52}
.psd-title{font-weight:600;min-width:80px;max-width:300px;overflow:hidden;text-overflow:ellipsis}
.psd-status{margin-left:auto;color:#bdc1c6;font-size:12px}
.psd-main{display:grid;grid-template-columns:1fr 300px;min-height:0}
.psd-stage{position:relative;overflow:hidden;background:#141517;cursor:grab}
.psd-canvas-wrap{position:absolute;left:24px;top:24px;transform-origin:0 0}
.psd-canvas-wrap canvas{display:block;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 50%/24px 24px;box-shadow:0 2px 16px rgba(0,0,0,.45)}
.psd-side{min-height:0;border-left:1px solid #3c4043;background:#202124;display:grid;grid-template-rows:auto 1fr}
.psd-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#bdc1c6;margin:0;padding:8px 10px;border-bottom:1px solid #3c4043}
.psd-layer-list{overflow:auto;padding:6px}
.psd-layer{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;width:100%;box-sizing:border-box;margin-bottom:3px;padding:4px 6px;background:#2b2d31;border:1px solid #3c4043;border-radius:4px;color:#e8eaed;text-align:left}
.psd-layer.hidden{opacity:.55}
.psd-layer-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.psd-layer-meta{color:#bdc1c6;font-size:11px}
.psd-message,.psd-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#bdc1c6}
.psd-error{color:#fecaca}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'psd-shell';

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'psd-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.psd,image/vnd.adobe.photoshop';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local PSD file', () => this.fileInput.click()));
        this.toolbar.appendChild(makeButton('+', 'Zoom in', () => this._setZoom(this.zoom * 1.2)));
        this.toolbar.appendChild(makeButton('-', 'Zoom out', () => this._setZoom(this.zoom / 1.2)));
        this.toolbar.appendChild(makeButton('Fit', 'Reset view', () => this._resetView()));

        this.titleEl = document.createElement('span');
        this.titleEl.className = 'psd-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);

        this.statusEl = document.createElement('span');
        this.statusEl.className = 'psd-status';
        this.toolbar.appendChild(this.statusEl);

        this.main = document.createElement('div');
        this.main.className = 'psd-main';
        this.stage = document.createElement('div');
        this.stage.className = 'psd-stage';
        this.canvasWrap = document.createElement('div');
        this.canvasWrap.className = 'psd-canvas-wrap';
        this.stage.appendChild(this.canvasWrap);
        this.side = document.createElement('div');
        this.side.className = 'psd-side';
        this.side.innerHTML = '<h3>Layers</h3><div class="psd-layer-list"></div>';
        this.layersEl = this.side.querySelector('.psd-layer-list');
        this.main.appendChild(this.stage);
        this.main.appendChild(this.side);

        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open a PSD file to inspect it.');

        this.stage.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.stage.addEventListener('mousedown', (e) => this._startPan(e));
        this._moveHandler = (e) => this._movePan(e);
        this._upHandler = () => this._endPan();
        window.addEventListener('mousemove', this._moveHandler);
        window.addEventListener('mouseup', this._upHandler);
    }

    async _init() {
        if (this.fileData) {
            await this._loadProjectFile();
        } else {
            this.statusEl.textContent = 'ag-psd loads when a PSD is opened';
        }
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed PSD loading requires the server workspace.');
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
        this.statusEl.textContent = 'Loading ag-psd...';
        this.canvasWrap.innerHTML = '';
        this.layersEl.innerHTML = '';

        try {
            const agPsd = await ensureAgPsdLoaded();
            this.statusEl.textContent = 'Parsing PSD...';
            this.psd = agPsd.readPsd(buffer, {
                logMissingFeatures: true,
                skipLinkedFilesData: true,
            });
            this._renderPsd();
        } catch (err) {
            this._showError(`Failed to open PSD: ${err.message}`);
        }
    }

    _renderPsd() {
        this.canvasWrap.innerHTML = '';
        const psd = this.psd;
        if (!psd) return;

        if (psd.canvas) {
            this.canvasWrap.appendChild(psd.canvas);
        } else {
            this.canvasWrap.innerHTML = '<div class="psd-message">PSD has no composite canvas.</div>';
        }

        this._renderLayers();
        this._resetView();
        this.statusEl.textContent = `${psd.width}x${psd.height} | ${this._countLayers()} layer(s) | mode ${psd.colorMode} | ${psd.bitsPerChannel} bpc`;
    }

    _renderLayers() {
        this.layersEl.innerHTML = '';
        const psd = this.psd;
        if (!psd || !psd.children || !psd.children.length) {
            this.layersEl.innerHTML = '<div class="psd-message">No layers.</div>';
            return;
        }

        walkLayers(psd.children, (layer, depth) => {
            const row = document.createElement('div');
            row.className = 'psd-layer' + (layer.hidden ? ' hidden' : '');
            row.style.marginLeft = `${depth * 12}px`;
            const marker = document.createElement('span');
            marker.textContent = layer.children && layer.children.length ? '▸' : '•';
            const name = document.createElement('span');
            name.className = 'psd-layer-name';
            name.textContent = layer.name || '(unnamed)';
            name.title = layer.name || '';
            const meta = document.createElement('span');
            meta.className = 'psd-layer-meta';
            const width = Math.max(0, (layer.right || 0) - (layer.left || 0));
            const height = Math.max(0, (layer.bottom || 0) - (layer.top || 0));
            meta.textContent = `${width}x${height}`;
            row.appendChild(marker);
            row.appendChild(name);
            row.appendChild(meta);
            this.layersEl.appendChild(row);
        });
    }

    _countLayers() {
        let count = 0;
        if (this.psd) walkLayers(this.psd.children || [], () => count++);
        return count;
    }

    _showMessage(message) {
        this.canvasWrap.innerHTML = `<div class="psd-message">${message}</div>`;
    }

    _showError(message) {
        log.error(message);
        this.canvasWrap.innerHTML = `<div class="psd-error">${message}</div>`;
        this.statusEl.textContent = 'Error';
    }

    _setZoom(value) {
        this.zoom = Math.max(0.05, Math.min(20, value));
        this._updateTransform();
    }

    _resetView() {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this._updateTransform();
    }

    _updateTransform() {
        this.canvasWrap.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }

    _onWheel(e) {
        e.preventDefault();
        const rect = this.stage.getBoundingClientRect();
        const mx = e.clientX - rect.left - 24;
        const my = e.clientY - rect.top - 24;
        const nextZoom = Math.max(0.05, Math.min(20, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
        const scale = nextZoom / this.zoom;
        this.panX = mx - scale * (mx - this.panX);
        this.panY = my - scale * (my - this.panY);
        this.zoom = nextZoom;
        this._updateTransform();
    }

    _startPan(e) {
        if (e.button !== 0) return;
        this.isPanning = true;
        this.panStartX = e.clientX - this.panX;
        this.panStartY = e.clientY - this.panY;
        this.stage.style.cursor = 'grabbing';
    }

    _movePan(e) {
        if (!this.isPanning) return;
        this.panX = e.clientX - this.panStartX;
        this.panY = e.clientY - this.panStartY;
        this._updateTransform();
    }

    _endPan() {
        this.isPanning = false;
        if (this.stage) this.stage.style.cursor = 'grab';
    }

    _destroy() {
        window.removeEventListener('mousemove', this._moveHandler);
        window.removeEventListener('mouseup', this._upHandler);
    }
}

registerPlugin({
    id: 'psd',
    name: 'PSD',
    components: {
        psdViewer: PsdViewerComponent,
    },
    toolbarButtons: [
        { label: 'PSD', title: 'Open PSD Viewer' },
    ],
    contextMenuItems: [{
        label: 'Open PSD Viewer',
        canHandle: (fileName) => /\.psd$/i.test(fileName || ''),
        action: (fileId) => {
            const ctx = PsdViewerComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab(
                'psdViewer',
                { fileId },
                `${file.name} [psd]`,
                'psd-' + fileId
            );
        },
    }],
    init(ctx) {
        PsdViewerComponent._ctx = ctx;
    },
});
