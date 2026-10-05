// --- Gliffy Plugin ---
// Shows Gliffy diagrams (.gliffy, Gliffy's JSON: contentType application/gliffy+json).
// They are converted the way draw.io imports them, by draw.io's own converter (the
// Java GliffyDiagramConverter built for the browser, js/gliffy/drawio-gliffy.min.js),
// and drawn by draw.io's viewer (viewer-static.min.js: mxGraph, its shapes and the
// stencils Gliffy's icons map to). Both load from jsDelivr on first use.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('Gliffy');
const DRAWIO_BASE = 'https://cdn.jsdelivr.net/gh/jgraph/drawio@v32.0.2/src/main/webapp/';
const GLIFFY_RE = /\.gliffy$/i;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

let _drawioPromise = null;
// The viewer first: the converter builds its cells with the viewer's mxGraph
function loadDrawio() {
    if (!_drawioPromise) {
        _drawioPromise = loadScript(DRAWIO_BASE + 'js/viewer-static.min.js')
            .then(() => loadScript(DRAWIO_BASE + 'js/gliffy/drawio-gliffy.min.js'))
            .then(() => {
                if (typeof window.mxGliffyToDrawio === 'undefined' || typeof window.GraphViewer === 'undefined') {
                    throw new Error('draw.io did not load');
                }
            })
            .catch(err => { _drawioPromise = null; throw err; });
    }
    return _drawioPromise;
}

class GliffyViewerComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = GliffyViewerComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.viewer = null;

        this.root = container.element;
        this.root.classList.add('gliffy-plugin-root');
        this._installStyles();
        this.root.innerHTML = `
<div class="gliffy-shell">
  <div class="gliffy-toolbar">
    <span class="gliffy-title"></span>
    <button type="button" data-zoom="out" title="Zoom out">−</button>
    <button type="button" data-zoom="in" title="Zoom in">+</button>
    <button type="button" data-zoom="fit" title="Fit the diagram to the view">Fit</button>
    <button type="button" data-zoom="actual" title="Actual size">1:1</button>
    <button type="button" class="gliffy-svg" title="Download the diagram as SVG" disabled>SVG</button>
    <span class="gliffy-status"></span>
  </div>
  <div class="gliffy-host"><div class="gliffy-message">Loading…</div></div>
</div>`;
        this.titleEl = this.root.querySelector('.gliffy-title');
        this.statusEl = this.root.querySelector('.gliffy-status');
        this.host = this.root.querySelector('.gliffy-host');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        this.root.querySelectorAll('[data-zoom]').forEach(b => {
            b.onclick = () => this._zoom(b.dataset.zoom);
        });
        this.svgBtn = this.root.querySelector('.gliffy-svg');
        this.svgBtn.onclick = () => this._saveSvg();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (GliffyViewerComponent._styleInstalled) return;
        GliffyViewerComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.gliffy-plugin-root{height:100%;background:#fff;overflow:hidden}
.gliffy-shell{display:flex;flex-direction:column;height:100%}
.gliffy-toolbar{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden}
.gliffy-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;margin-right:4px}
.gliffy-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer;flex-shrink:0}
.gliffy-toolbar button:hover{background:#444c56}
.gliffy-toolbar button:disabled{opacity:.5;cursor:default}
.gliffy-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.gliffy-host{position:relative;flex:1;min-height:0;color:#000;background:#fff}
.gliffy-canvas{position:absolute;inset:0;overflow:auto;cursor:grab;touch-action:none}
.gliffy-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#57606a;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.gliffy-message.error{color:#b42318}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath + '/' + this.ctx.getRelativePath(this.fileId);
    }

    async _text() {
        const file = this.fileData;
        if (typeof file.content === 'string' && file.content.length) return file.content;
        const path = this._path();
        if (!path) return '';
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return resp.text();
    }

    async _init() {
        if (!this.fileData) return this._fail('No Gliffy file selected.');
        let json;
        try {
            [, json] = await Promise.all([loadDrawio(), this._text()]);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the diagram: ' + err.message);
        }
        let xml;
        try {
            xml = window.mxGliffyToDrawio.convert(json);
        } catch (err) {
            log.error('Conversion failed:', err);
            return this._fail('Not a diagram draw.io can read as Gliffy: ' + err.message);
        }
        if (this._destroyed) return;
        this.host.textContent = '';
        const canvas = document.createElement('div');
        canvas.className = 'gliffy-canvas';
        this.host.appendChild(canvas);
        const { mxUtils, mxEvent, GraphViewer } = window;
        const node = mxUtils.parseXml(xml).documentElement;
        this.viewer = new GraphViewer(canvas, node, {
            highlight: '#0000ff', nav: true, toolbar: null, lightbox: false,
            resize: false, center: true, border: 20, 'dark-mode': false,
        });
        const graph = this.graph = this.viewer.graph;
        // The canvas scrolls; dragging the background pans it, the wheel with Ctrl zooms
        graph.container.style.overflow = 'auto';
        graph.setPanning(true);
        graph.panningHandler.useLeftButtonForPanning = true;
        graph.panningHandler.ignoreCell = true;
        graph.setTooltips(true);
        mxEvent.addMouseWheelListener((evt, up) => {
            if (!evt.ctrlKey && !evt.metaKey) return;
            up ? graph.zoomIn() : graph.zoomOut();
            mxEvent.consume(evt);
        }, canvas);
        this._resizeObserver = new ResizeObserver(() => { if (this._fitted) this._zoom('fit'); });
        this._resizeObserver.observe(this.host);
        this._zoom('fit');
        this.svgBtn.disabled = false;
        const cells = Object.keys(graph.model.cells || {}).length;
        this._status(`${cells} cells`);
        log.log(`Opened ${this._path() || this.fileData.name} (${cells} cells)`);
    }

    _zoom(how) {
        const graph = this.graph;
        if (!graph) return;
        this._fitted = how === 'fit';
        if (how === 'in') graph.zoomIn();
        else if (how === 'out') graph.zoomOut();
        else if (how === 'actual') graph.zoomActual();
        else {
            // Fit, but no larger than actual size
            graph.fit(20, false, 0, true, false, false);
            if (graph.view.scale > 1) graph.zoomActual();
            graph.center(true, true);
        }
    }

    // The whole diagram at actual size on white, as draw.io exports it; theme 'light'
    // pins its light-dark() colours, so a dark-themed viewer doesn't invert it
    _saveSvg() {
        const graph = this.graph;
        if (!graph) return;
        let svg;
        try {
            svg = graph.getSvg('#ffffff', 1, 10, false, null, true, null, null, null, null, null, 'light');
        } catch (err) {
            log.error('SVG export failed:', err);
            return this._status('SVG export failed: ' + err.message);
        }
        const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + window.mxUtils.getXml(svg);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
        a.download = (this.fileData.name || 'diagram.gliffy').replace(GLIFFY_RE, '') + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    _status(text) {
        this.statusEl.textContent = text;
    }

    _fail(message) {
        this.host.innerHTML = '<div class="gliffy-message error"></div>';
        this.host.firstChild.textContent = message;
    }

    _destroy() {
        this._destroyed = true;
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this.graph) this.graph.destroy();
        this.graph = null;
        this.viewer = null;
    }
}

registerPlugin({
    id: 'gliffy',
    name: 'Gliffy (draw.io)',
    components: {
        gliffyViewer: GliffyViewerComponent,
    },
    contextMenuItems: [{
        label: 'Open as Gliffy diagram',
        canHandle: (fileName) => GLIFFY_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = GliffyViewerComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('gliffyViewer', { fileId }, `${file.name} [gliffy]`, 'gliffy-' + fileId);
        },
    }],
    init(ctx) {
        GliffyViewerComponent._ctx = ctx;
    },
});
