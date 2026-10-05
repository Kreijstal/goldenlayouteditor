// --- draw.io import Plugin ---
// Shows diagram formats draw.io can import, converted by draw.io's own importers and
// drawn by draw.io's viewer (viewer-static.min.js: mxGraph, its shapes and stencils),
// all loaded from jsDelivr on first use:
//  - Gliffy (.gliffy, Gliffy's JSON): the Java GliffyDiagramConverter built for the
//    browser, js/gliffy/drawio-gliffy.min.js
//  - GraphML (.graphml, yEd's and plain): js/diagramly/graphml/mxGraphMlCodec.js. yEd
//    files keep their layout; plain graphs (networkx, igraph…) carry no positions, so
//    they are laid out here
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('DrawioImport');
const DRAWIO_BASE = 'https://cdn.jsdelivr.net/gh/jgraph/drawio@v32.0.2/src/main/webapp/';

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

const _loads = new Map();
// Each once, in order (later ones build on the viewer's mxGraph); a failure is retried
function loadScripts(paths, global) {
    const key = paths.join(' ');
    if (!_loads.has(key)) {
        _loads.set(key, paths.reduce((p, path) => p.then(() => loadScript(DRAWIO_BASE + path)), Promise.resolve())
            .then(() => {
                if (typeof window[global] === 'undefined' || typeof window.GraphViewer === 'undefined') {
                    throw new Error('draw.io did not load');
                }
            })
            .catch(err => { _loads.delete(key); throw err; }));
    }
    return _loads.get(key);
}

const VIEWER = 'js/viewer-static.min.js';

// Plain GraphML: a node's label from a data key named label/name/text/title, else its id
function plainGraphMlLabels(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const labelKeys = new Set();
    for (const key of doc.getElementsByTagName('key')) {
        const name = (key.getAttribute('attr.name') || '').toLowerCase();
        const target = key.getAttribute('for') || 'all';
        if ((target === 'node' || target === 'all') && ['label', 'name', 'text', 'title'].includes(name)) {
            labelKeys.add(key.getAttribute('id'));
        }
    }
    const labels = new Map();
    for (const node of doc.getElementsByTagName('node')) {
        let label = null;
        for (const data of node.children) {
            if (data.localName === 'data' && labelKeys.has(data.getAttribute('key')) && data.textContent.trim()) {
                label = data.textContent.trim();
                break;
            }
        }
        labels.set(node.getAttribute('id'), label != null ? label : node.getAttribute('id'));
    }
    const graph = doc.getElementsByTagName('graph')[0];
    return { labels, directed: !!graph && graph.getAttribute('edgedefault') === 'directed' };
}

const FORMATS = {
    gliffy: {
        re: /\.gliffy$/i,
        tag: 'gliffy',
        label: 'Gliffy',
        component: 'gliffyViewer',
        load: () => loadScripts([VIEWER, 'js/gliffy/drawio-gliffy.min.js'], 'mxGliffyToDrawio'),
        convert: async (text) => window.mxGliffyToDrawio.convert(text),
    },
    graphml: {
        re: /\.graphml$/i,
        tag: 'graphml',
        label: 'GraphML',
        component: 'graphmlViewer',
        load: () => loadScripts([VIEWER, 'js/diagramly/graphml/mxGraphMlCodec.js'], 'mxGraphMlCodec'),
        convert: (text) => new Promise((resolve, reject) => {
            const codec = new window.mxGraphMlCodec();
            // It builds pages in a bare mxGraph, but the viewer's view needs draw.io's
            // Graph (isRoundedPerimeter…), as draw.io's own Visio import uses
            codec.createMxGraph = () => new window.Graph();
            codec.decode(text, resolve, err => reject(err || new Error('Not GraphML')));
        }),
        // Plain graphs are laid out; yEd's get what draw.io's import leaves out
        prepare: (graph, text) => layoutPlainGraph(graph, text) ? 'auto layout' : (fixYed(graph, text), null),
    },
};

// The pages of draw.io XML (an mxfile of diagrams, compressed or not, or a bare model),
// each as { name, node: <mxGraphModel> }
function pagesOf(xml) {
    const { mxUtils, Graph } = window;
    const root = mxUtils.parseXml(xml).documentElement;
    if (root.nodeName !== 'mxfile') return [{ name: '', node: root }];
    return Array.from(root.getElementsByTagName('diagram')).map((d, i) => {
        let node = Array.from(d.children).find(c => c.nodeName === 'mxGraphModel');
        if (!node) node = mxUtils.parseXml(Graph.decompress(mxUtils.getTextContent(d))).documentElement;
        return { name: d.getAttribute('name') || `Page ${i + 1}`, node };
    });
}

// A plain graph's nodes all come at one spot: label them and lay them out, layered when
// directed, force-directed otherwise
function layoutPlainGraph(graph, sourceText) {
    const { mxFastOrganicLayout, mxHierarchicalLayout, mxConstants } = window;
    const model = graph.getModel();
    const parent = graph.getDefaultParent();
    const vertices = model.getChildVertices(parent);
    if (vertices.length < 2) return false;
    const spot = (v) => `${v.geometry.x},${v.geometry.y}`;
    if (!vertices.every(v => v.geometry && spot(v) === spot(vertices[0]))) return false;
    const { labels, directed } = plainGraphMlLabels(sourceText);
    model.beginUpdate();
    try {
        for (const v of vertices) {
            const id = graph.getCellStyle(v).graphMlID;
            const label = labels.get(id) != null ? labels.get(id) : (id || '');
            model.setValue(v, label);
            model.setStyle(v, `ellipse;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;graphMlID=${id}`);
            const w = Math.max(40, Math.min(160, 14 + 7 * String(label).length));
            model.setGeometry(v, new window.mxGeometry(0, 0, w, 40));
        }
        for (const e of model.getChildEdges(parent)) {
            const style = model.getStyle(e) || '';
            if (!directed && !/endArrow=/.test(style)) model.setStyle(e, style + (style ? ';' : '') + 'endArrow=none');
        }
        if (directed) {
            const layout = new mxHierarchicalLayout(graph, mxConstants.DIRECTION_NORTH);
            layout.intraCellSpacing = 30;
            layout.interRankCellSpacing = 60;
            layout.execute(parent);
        } else {
            const layout = new mxFastOrganicLayout(graph);
            layout.forceConstant = 80;
            layout.execute(parent);
        }
    } finally {
        model.endUpdate();
    }
    return true;
}

// Java's logical fonts, which yEd writes, as fonts a browser has
const JAVA_FONTS = { dialog: 'Helvetica', sansserif: 'Helvetica', serif: 'Times New Roman', dialoginput: 'Courier New', monospaced: 'Courier New' };
// yEd's arrowheads are larger than draw.io's defaults (6)
const ARROW_SIZES = { classic: 10, classicThin: 10, block: 10, open: 10, diamond: 14, oval: 8 };
// draw.io takes an outline from named styles ("rhombus;…"), but the import writes
// shape=…, which leaves every shape a rectangle to edges
const ELLIPSE = 'ellipsePerimeter';
const PERIMETERS = {
    ellipse: ELLIPSE, cloud: ELLIPSE, 'mxgraph.flowchart.start_1': ELLIPSE, 'mxgraph.flowchart.start_2': ELLIPSE,
    'mxgraph.flowchart.on-page_reference': ELLIPSE, 'mxgraph.flowchart.or': ELLIPSE, 'mxgraph.flowchart.summing_function': ELLIPSE,
    rhombus: 'rhombusPerimeter', 'mxgraph.flowchart.decision': 'rhombusPerimeter',
    triangle: 'trianglePerimeter', hexagon: 'hexagonPerimeter2', parallelogram: 'parallelogramPerimeter',
    trapezoid: 'trapezoidPerimeter', step: 'stepPerimeter',
};

function styleWith(style, values) {
    const parts = (style || '').split(';').filter(p => p && !(p.split('=')[0] in values));
    for (const [k, v] of Object.entries(values)) if (v != null) parts.push(`${k}=${v}`);
    return parts.join(';');
}

const yAll = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));
const yOne = (el, name) => yAll(el, name)[0] || null;

// What draw.io's GraphML import leaves out of yEd's files, put back from the source:
//  - UML class nodes (y:UMLClassNode): fill, border, stereotype, attribute and method compartments
//  - drop shadows (y:DropShadow)
//  - edge ends: yEd attaches an edge at a port (y:Path sx/sy/tx/ty, from the node's
//    centre) and clips its first and last segment at the node's outline; draw.io kept the
//    port but projected it onto the outline from the centre, which slants straight edges
//  - arrowheads at yEd's size, and Java's logical fonts (Dialog…) as browser fonts
function fixYed(graph, sourceText) {
    const { mxGeometry, mxPoint } = window;
    const doc = new DOMParser().parseFromString(sourceText, 'application/xml');
    const nodes = new Map(yAll(doc, 'node').map(n => [n.getAttribute('id'), n]));
    const model = graph.getModel();
    const view = graph.view;
    const cells = Object.values(model.cells);
    const idOf = (cell) => graph.getCellStyle(cell).graphMlID;
    model.beginUpdate();
    try {
        for (const cell of cells) {
            const style = model.getStyle(cell) || '';
            const font = /(?:^|;)fontFamily=([^;,]*)(?:;|$)/.exec(style);
            if (font) {
                const f = font[1];
                // Java's logical fonts, and a generic fallback for fonts the browser may lack (Menlo…)
                const family = JAVA_FONTS[f.toLowerCase()] || (/mono|menlo|monaco|consolas|courier/i.test(f) ? `${f},monospace`
                    : /serif/i.test(f) && !/sans/i.test(f) ? `${f},serif` : null);
                if (family) model.setStyle(cell, styleWith(style, { fontFamily: family }));
            }
            if (!cell.vertex) continue;
            const cs = graph.getCellStyle(cell);
            // its own style: the default style's rectangle perimeter always fills cs.perimeter
            if (!/(^|;)perimeter=/.test(model.getStyle(cell) || '') && PERIMETERS[cs.shape]) model.setStyle(cell, styleWith(model.getStyle(cell), { perimeter: PERIMETERS[cs.shape] }));
            const node = nodes.get(idOf(cell));
            if (!node) continue;
            // the node's own realizer, not a nested graph's
            const realizer = Array.from(node.children).filter(c => c.localName === 'data')
                .map(d => Array.from(d.children).find(c => c.namespaceURI !== doc.documentElement.namespaceURI))
                .find(Boolean);
            if (!realizer) continue;
            const own = (name) => Array.from(realizer.children).find(c => c.localName === name) || null;
            const shadow = own('DropShadow');
            if (shadow) model.setStyle(cell, styleWith(model.getStyle(cell), { shadow: 1 }));
            if (realizer.localName === 'UMLClassNode') fixUmlClass(graph, cell, own, mxGeometry);
        }

        // Edge ends, from the drawn positions
        view.validate();
        for (const edge of cells) {
            if (!edge.edge || !edge.source || !edge.target) continue;
            const st = graph.getCellStyle(edge);
            const values = {};
            for (const end of ['end', 'start']) {
                const arrow = st[end + 'Arrow'];
                if (ARROW_SIZES[arrow] && st[end + 'Size'] == null) values[end + 'Size'] = ARROW_SIZES[arrow];
            }
            const es = view.getState(edge);
            const ss = view.getState(edge.source), ts = view.getState(edge.target);
            if (es && ss && ts && es.absolutePoints && es.absolutePoints.length >= 2) {
                const pts = es.absolutePoints;
                const port = (s, x, y) => x != null ? new mxPoint(s.x + x * s.width, s.y + y * s.height) : new mxPoint(s.getCenterX(), s.getCenterY());
                const sp = port(ss, st.exitX, st.exitY), tp = port(ts, st.entryX, st.entryY);
                const clipEnd = (s, p, toward, key) => {
                    if (st[key + 'X'] == null || st[key + 'Perimeter'] == 0) return;
                    const b = clipAtOutline(view, s, p, toward);
                    if (!b) return;
                    values[key + 'X'] = +((b.x - s.x) / s.width).toFixed(4);
                    values[key + 'Y'] = +((b.y - s.y) / s.height).toFixed(4);
                    values[key + 'Perimeter'] = 0;
                };
                clipEnd(ss, sp, pts.length > 2 ? pts[1] : tp, 'exit');
                clipEnd(ts, tp, pts.length > 2 ? pts[pts.length - 2] : sp, 'entry');
            }
            if (Object.keys(values).length) model.setStyle(edge, styleWith(model.getStyle(edge), values));
        }
    } finally {
        model.endUpdate();
    }
}

// Where the segment from p (inside the shape) to q leaves the shape's outline, by
// bisection with the shape's own perimeter (rectangle, ellipse, rhombus…); null when
// p isn't inside or q isn't outside
function clipAtOutline(view, state, p, q) {
    const perimeter = view.getPerimeterFunction(state);
    if (!perimeter) return null;
    const bounds = view.getPerimeterBounds(state);
    const cx = bounds.getCenterX(), cy = bounds.getCenterY();
    const inside = (x, y) => {
        const d = Math.hypot(x - cx, y - cy);
        if (d < 1e-6) return true;
        const o = perimeter(bounds, state, new window.mxPoint(x, y), false);
        return o && d <= Math.hypot(o.x - cx, o.y - cy) + 0.01;
    };
    if (!inside(p.x, p.y) || inside(q.x, q.y)) return null;
    let a = 0, b = 1;
    for (let i = 0; i < 40; i++) {
        const m = (a + b) / 2;
        if (inside(p.x + (q.x - p.x) * m, p.y + (q.y - p.y) * m)) a = m; else b = m;
    }
    return new window.mxPoint(p.x + (q.x - p.x) * b, p.y + (q.y - p.y) * b);
}

// A yEd UML class box: the name (draw.io's import made its label) with the stereotype
// above it, then the attribute and the method compartment under lines
function fixUmlClass(graph, cell, own, mxGeometry) {
    const model = graph.getModel();
    const fill = own('Fill'), border = own('BorderStyle'), uml = own('UML');
    const colour = (el, attr) => el && el.getAttribute(attr) ? el.getAttribute(attr) : null;
    model.setStyle(cell, styleWith(model.getStyle(cell), {
        shape: 'rect', html: 1,
        fillColor: fill && fill.getAttribute('transparent') === 'true' ? 'none' : (colour(fill, 'color') || '#ffffff'),
        gradientColor: colour(fill, 'color2'),
        strokeColor: border && border.getAttribute('hasColor') === 'false' ? 'none' : (colour(border, 'color') || '#000000'),
        strokeWidth: colour(border, 'width') || 1,
    }));
    if (!uml || uml.getAttribute('omitDetails') === 'true') return;
    const w = cell.geometry.width, h = cell.geometry.height;
    const name = own('NodeLabel');
    const top = name ? parseFloat(name.getAttribute('y') || 0) + parseFloat(name.getAttribute('height') || 0) + 3 : 22;
    const stereotype = uml.getAttribute('stereotype');
    if (stereotype) {
        const lbl = new window.mxCell(`«${stereotype}»`, new mxGeometry(0, 0, w, 14), 'text;html=1;align=center;verticalAlign=top;fontSize=11;spacing=0;spacingTop=1;');
        lbl.vertex = true;
        graph.addCell(lbl, cell);
    }
    const lines = (el) => el ? el.textContent.split('\n').map(l => l.trim()).filter(Boolean) : [];
    const attrs = lines(yOne(uml, 'AttributeLabel')), methods = lines(yOne(uml, 'MethodLabel'));
    const lineH = 15;
    const attrsH = attrs.length ? attrs.length * lineH + 6 : Math.max(0, Math.min(8, (h - top) / 2));
    const sections = [[top, attrs], [top + attrsH, methods]];
    for (const [y, text] of sections) {
        if (y >= h - 1) continue;
        const sep = new window.mxCell('', new mxGeometry(0, y, w, 0),
            `line;strokeWidth=1;fillColor=none;html=1;strokeColor=${graph.getCellStyle(cell).strokeColor};`);
        sep.vertex = true;
        graph.addCell(sep, cell);
        if (!text.length) continue;
        const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const body = new window.mxCell(text.map(esc).join('<br>'), new mxGeometry(0, y + 2, w, text.length * lineH + 2),
            'text;html=1;align=left;verticalAlign=top;spacingLeft=4;spacingTop=0;fontSize=12;fontFamily=Helvetica;whiteSpace=nowrap;overflow=hidden;');
        body.vertex = true;
        graph.addCell(body, cell);
    }
}

class DrawioImportComponent {
    constructor(container, state, format) {
        this.container = container;
        this.state = state || {};
        this.format = format;
        this.ctx = DrawioImportComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.viewer = null;

        this.root = container.element;
        this.root.classList.add('drawio-import-root');
        this._installStyles();
        this.root.innerHTML = `
<div class="dimp-shell">
  <div class="dimp-toolbar">
    <span class="dimp-title"></span>
    <select class="dimp-page" title="Page" hidden></select>
    <button type="button" data-zoom="out" title="Zoom out">−</button>
    <button type="button" data-zoom="in" title="Zoom in">+</button>
    <button type="button" data-zoom="fit" title="Fit the diagram to the view">Fit</button>
    <button type="button" data-zoom="actual" title="Actual size">1:1</button>
    <button type="button" class="dimp-svg" title="Download the diagram as SVG" disabled>SVG</button>
    <span class="dimp-status"></span>
  </div>
  <div class="dimp-host"><div class="dimp-message">Loading…</div></div>
</div>`;
        this.titleEl = this.root.querySelector('.dimp-title');
        this.statusEl = this.root.querySelector('.dimp-status');
        this.pageEl = this.root.querySelector('.dimp-page');
        this.host = this.root.querySelector('.dimp-host');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        this.root.querySelectorAll('[data-zoom]').forEach(b => {
            b.onclick = () => this._zoom(b.dataset.zoom);
        });
        this.svgBtn = this.root.querySelector('.dimp-svg');
        this.svgBtn.onclick = () => this._saveSvg();
        this.pageEl.onchange = () => this._show(+this.pageEl.value);
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (DrawioImportComponent._styleInstalled) return;
        DrawioImportComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.drawio-import-root{height:100%;background:#fff;overflow:hidden}
.dimp-shell{display:flex;flex-direction:column;height:100%}
.dimp-toolbar{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden}
.dimp-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;margin-right:4px}
.dimp-toolbar button,.dimp-toolbar select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer;flex-shrink:0}
.dimp-toolbar select{padding:2px 4px;max-width:160px}
.dimp-toolbar button:hover{background:#444c56}
.dimp-toolbar button:disabled{opacity:.5;cursor:default}
.dimp-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.dimp-host{position:relative;flex:1;min-height:0;color:#000;background:#fff}
/* GraphViewer sizes its container to the diagram and hides overflow; it fills the panel here */
.dimp-canvas{position:absolute;inset:0;width:auto!important;height:auto!important;overflow:auto!important;cursor:grab;touch-action:none}
.dimp-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#57606a;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dimp-message.error{color:#b42318}
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
        const { label } = this.format;
        if (!this.fileData) return this._fail(`No ${label} file selected.`);
        let text;
        try {
            [, text] = await Promise.all([this.format.load(), this._text()]);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the diagram: ' + err.message);
        }
        try {
            this.pages = pagesOf(await this.format.convert(text));
            if (!this.pages.length) throw new Error('no diagram in it');
        } catch (err) {
            log.error('Conversion failed:', err);
            return this._fail(`Not a diagram draw.io can read as ${label}: ${err.message || err}`);
        }
        if (this._destroyed) return;
        this.sourceText = text;
        if (this.pages.length > 1) {
            this.pages.forEach((p, i) => this.pageEl.add(new Option(p.name, i)));
            this.pageEl.hidden = false;
        }
        this._show(0);
        log.log(`Opened ${this._path() || this.fileData.name} (${this.pages.length} page(s))`);
    }

    _show(index) {
        this._teardown();
        this.host.textContent = '';
        const canvas = document.createElement('div');
        canvas.className = 'dimp-canvas';
        this.host.appendChild(canvas);
        const { mxEvent, GraphViewer } = window;
        try {
            this.viewer = new GraphViewer(canvas, this.pages[index].node.cloneNode(true), {
                highlight: '#0000ff', nav: true, toolbar: null, lightbox: false,
                resize: false, center: true, border: 20, 'dark-mode': false,
            });
        } catch (err) {
            log.error('Render failed:', err);
            return this._fail('Could not draw the diagram: ' + err.message);
        }
        const graph = this.graph = this.viewer.graph;
        let note = null;
        try {
            note = this.format.prepare ? this.format.prepare(graph, this.sourceText) : null;
        } catch (err) {
            log.error('Fixing up the import failed:', err);
        }
        // The canvas scrolls; dragging the background pans it, the wheel with Ctrl zooms
        graph.setPanning(true);
        graph.panningHandler.useLeftButtonForPanning = true;
        graph.panningHandler.ignoreCell = true;
        graph.setTooltips(true);
        mxEvent.addMouseWheelListener((evt, up) => {
            if (!evt.ctrlKey && !evt.metaKey) return;
            up ? graph.zoomIn() : graph.zoomOut();
            mxEvent.consume(evt);
        }, canvas);
        // Zoomed in, a diagram reaching left of or above the origin would be cut off where
        // scrolling can't go: keep its top-left corner on the canvas
        const { mxEvent: E } = window;
        const keep = () => this._keepReachable();
        for (const name of [E.SCALE, E.TRANSLATE, E.SCALE_AND_TRANSLATE]) graph.view.addListener(name, keep);
        this._resizeObserver = new ResizeObserver(() => { if (this._fitted) this._zoom('fit'); });
        this._resizeObserver.observe(this.host);
        this._zoom('fit');
        this.svgBtn.disabled = false;
        const cells = Object.keys(graph.model.cells || {}).length;
        this._status(`${cells} cells` + (note ? ' · ' + note : ''));
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

    _keepReachable() {
        const graph = this.graph;
        if (!graph || this._shifting) return;
        const view = graph.view, s = view.scale, border = 20;
        const b = graph.getGraphBounds();
        const dx = b.x < border ? (border - b.x) / s : 0;
        const dy = b.y < border ? (border - b.y) / s : 0;
        if (!dx && !dy) return;
        this._shifting = true;
        try {
            view.setTranslate(view.translate.x + dx, view.translate.y + dy);
            graph.container.scrollLeft += dx * s;
            graph.container.scrollTop += dy * s;
        } finally {
            this._shifting = false;
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
        let name = (this.fileData.name || 'diagram').replace(this.format.re, '');
        if (this.pages.length > 1) name += '-' + this.pages[+this.pageEl.value].name.replace(/[^\w.-]+/g, '_');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
        a.download = name + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    _status(text) {
        this.statusEl.textContent = text;
    }

    _fail(message) {
        this.svgBtn.disabled = true;
        this.host.innerHTML = '<div class="dimp-message error"></div>';
        this.host.firstChild.textContent = message;
    }

    _teardown() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        this._resizeObserver = null;
        if (this.graph) this.graph.destroy();
        this.graph = null;
        this.viewer = null;
    }

    _destroy() {
        this._destroyed = true;
        this._teardown();
    }
}

const components = {};
const contextMenuItems = [];
for (const format of Object.values(FORMATS)) {
    components[format.component] = class extends DrawioImportComponent {
        constructor(container, state) { super(container, state, format); }
    };
    contextMenuItems.push({
        label: `Open as ${format.label} diagram`,
        canHandle: (fileName) => format.re.test(fileName || ''),
        action: (fileId) => {
            const ctx = DrawioImportComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab(format.component, { fileId }, `${file.name} [${format.tag}]`, `${format.tag}-${fileId}`);
        },
    });
}

registerPlugin({
    id: 'drawio-import',
    name: 'Gliffy and GraphML (draw.io)',
    components,
    contextMenuItems,
    init(ctx) {
        DrawioImportComponent._ctx = ctx;
    },
});
