// --- HP-GL viewer ---
// HP-GL and HP-GL/2 plotter files (.hpgl, .hpg, .hgl, .pen; a .plt only when its
// text is HP-GL), drawn on a canvas by hpgl-viewer (loaded from jsDelivr on
// first use). hpgl-viewer plots what a pen does with PU, PD, PA, AA and SP; the
// other instructions it skips (labels, circles, relative moves, fills, scaling),
// and the status bar names them. The drawing is fitted to what the pens drew;
// the wheel (or a pinch, or + / −) zooms at the pointer, dragging pans, 0 fits.
// The drawing follows the file's text as it is edited. Also draws thumbnails in
// the file browser's grid.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const LIB = 'https://cdn.jsdelivr.net/npm/hpgl-viewer@1.0.0/lib/hpgl-viewer.js';

// Names only HP-GL files have; .plt (also gnuplot scripts, AutoCAD plot files...) only when the text is HP-GL
const HPGL_NAME_RE = /\.(hpgl|hpg|hgl|pen|plt)$/i;
const SHARED_NAME_RE = /\.plt$/i;

// HP-GL is instructions of two capital letters, each ended by ";": the usual first
// ones (IN, DF, SP, PU, PD, PA...), after any PCL / RTL escapes, twice in the head
function looksLikeHpgl(text) {
    const head = text.slice(0, 4096);
    const found = head.match(/(?:^|[;\s:\x1b])(?:IN|DF|BP|PS|SP|PU|PD|PA|SC|IP|LT|VS)\s*(?:-?[\d.]+(?:\s*,\s*-?[\d.]+)*)?\s*;/g);
    return !!found && found.length >= 2;
}

// An HP-GL file's name, and (once read) its text if it is HP-GL
function isHpglFile(f) {
    if (!HPGL_NAME_RE.test(f.name) || f.viewType) return false;
    if (typeof f.content !== 'string') return !SHARED_NAME_RE.test(f.name);
    return looksLikeHpgl(f.content);
}

// Pens as a plotter's carousel usually holds them, on white paper
// (hpgl-viewer gives SP n the color at n − 1, and keeps the last color for SP1)
const PEN_COLORS = ['#000000', '#d32f2f', '#2e7d32', '#1565c0', '#8e24aa', '#00838f', '#ef6c00', '#6d4c41'];
const PLOTTER_UNITS_PER_MM = 40;
const MIN_SCALE = 1 / 65536, MAX_SCALE = 1024;
let _ctx = null;
let _lib = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

function ensureLib() {
    if (!_lib) {
        _lib = (window.HPGLViewer ? Promise.resolve() : loadScript(LIB)).then(() => {
            if (typeof window.HPGLViewer !== 'function') throw new Error('hpgl-viewer did not load');
            return window.HPGLViewer;
        });
        _lib.catch(() => { _lib = null; });
    }
    return _lib;
}

function workspaceUrl(rel) {
    return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
}

async function readText(file) {
    // (a file the browser lists but hasn't read yet holds '' until then)
    if (typeof file.content === 'string' && !file.lazy) return file.content;
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await workspaceUrl(_ctx.getRelativePath(file.id)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
}

let _idSeq = 0;
// hpgl-viewer bound to a canvas: it maps plotter units one to one (x right, y
// down from 1), so the canvas transform alone places the drawing. Its pen moves
// can also be only measured, for the extent of what the pens drew.
async function makePlotter(canvas) {
    const HPGLViewer = await ensureLib();
    // (it finds its canvas by id)
    const id = canvas.id = canvas.id || 'hpgl-canvas-' + (++_idSeq);
    const detached = !canvas.isConnected;
    if (detached) { canvas.style.display = 'none'; document.body.appendChild(canvas); }
    const viewer = HPGLViewer({
        container: id, layerColors: PEN_COLORS.slice(),
        canvasWidth: 1, machineTravelWidth: 1, machineTravelHeight: 1, machineRatio: 1,
    });
    if (detached) { canvas.remove(); canvas.style.display = ''; }
    const g = canvas.getContext('2d');
    const real = { moveTo: g.moveTo, lineTo: g.lineTo, arc: g.arc, stroke: g.stroke, clearRect: g.clearRect };
    let box = null, lineWidth = 1;
    const grow = (x, y) => {
        if (!isFinite(x) || !isFinite(y)) return;
        if (!box) box = { x0: x, y0: y, x1: x, y1: y };
        else { box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y); }
    };
    let measuring = false;
    g.moveTo = function (x, y) { if (measuring) grow(x, y); else real.moveTo.call(g, x, y); };
    g.lineTo = function (x, y) { if (measuring) grow(x, y); else real.lineTo.call(g, x, y); };
    g.arc = function (x, y, r, a0, a1, ccw) {
        if (measuring) { grow(x - r, y - r); grow(x + r, y + r); } else real.arc.call(g, x, y, r, a0, a1, ccw);
    };
    // A pen's line is as wide at any zoom
    g.stroke = function () {
        if (measuring) return;
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.lineWidth = lineWidth;
        real.stroke.call(g);
        g.restore();
    };
    // (the page is cleared before each drawing, not by it)
    g.clearRect = function () {};

    // hpgl-viewer logs each instruction it can't plot: counted by name
    const run = text => {
        const skipped = {};
        const log = console.log;
        console.log = (...args) => {
            const m = args[0] === '[HPGL Viewer]' && /^Could not parse line:\s*(\S{0,2})/.exec(String(args[1]));
            if (!m) return log.apply(console, args);
            const name = /^[A-Z]{2}$/.test(m[1]) ? m[1] : 'other';
            skipped[name] = (skipped[name] || 0) + 1;
        };
        try { viewer.draw(text); } finally { console.log = log; }
        return skipped;
    };
    return {
        // What the pens drew, in hpgl-viewer's units (x, 1 − y), and the instructions not plotted
        measure(text) {
            box = null;
            measuring = true;
            g.beginPath();
            let skipped;
            try { skipped = run(text); } finally { measuring = false; g.beginPath(); }
            const extent = box && { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
            return { extent, skipped };
        },
        // Draw with the picture point (vx, vy) at the canvas' top-left corner, s device pixels per unit
        draw(text, vx, vy, s, width = 1) {
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.fillStyle = '#ffffff';
            g.fillRect(0, 0, canvas.width, canvas.height);
            g.setTransform(s, 0, 0, s, -vx * s, -vy * s);
            g.lineCap = g.lineJoin = 'round';
            lineWidth = width;
            g.beginPath();
            run(text);
            g.setTransform(1, 0, 0, 1, 0, 0);
        },
    };
}

class HpglComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'drawing.hpgl';
        this.text = null;
        this.extent = null;
        this.view = null; // { x, y, s }: the stage's top-left corner in picture units, and pixels per unit
        this.source = null;
        this.pointers = new Map();
        this.root = container.element;
        this.root.classList.add('hpgl-root');
        HpglComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (HpglComponent._styled) return;
        HpglComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.hpgl-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.hpgl-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.hpgl-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.hpgl-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.hpgl-root button:hover{background:#444c56}
.hpgl-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hpgl-zoom{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.hpgl-stage{position:relative;overflow:hidden;min-height:0;cursor:grab;touch-action:none;outline:none;background:#ffffff}
.hpgl-stage.dragging{cursor:grabbing}
.hpgl-stage>canvas{position:absolute;left:0;top:0;display:block}
.hpgl-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.hpgl-status .hpgl-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.hpgl-status .hpgl-pos{margin-left:auto;font-variant-numeric:tabular-nums}
.hpgl-message{padding:20px;color:#57606a;text-align:center}
.hpgl-error{padding:20px;color:#cf222e;text-align:center;white-space:pre-wrap}
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
        const shell = this._el('div', 'hpgl-shell');
        const bar = this._el('div', 'hpgl-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.hpgl,.hpg,.hgl,.pen,.plt';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            this.fileId = null;
            this.fileName = f.name;
            this._show(await f.text(), true);
        });
        this.titleEl = this._el('span', 'hpgl-title', this.fileName);
        this.zoomEl = this._el('span', 'hpgl-zoom', '');
        bar.append(
            this.fileInput,
            this._button('Open', 'Open an HP-GL file from this computer', () => this.fileInput.click()),
            this.titleEl,
            this._button('Fit', 'Show the whole drawing (0)', () => this._fit()),
            this._button('−', 'Zoom out (−)', () => this._zoomBy(0.5)),
            this.zoomEl,
            this._button('+', 'Zoom in (+)', () => this._zoomBy(2)),
        );
        this.stage = this._el('div', 'hpgl-stage');
        this.stage.tabIndex = 0;
        this.stage.appendChild(this._el('div', 'hpgl-message', 'Open an HP-GL plotter file.'));
        this.canvas = this._el('canvas');
        const status = this._el('div', 'hpgl-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'hpgl-warn', '');
        this.posEl = this._el('span', 'hpgl-pos', '');
        status.append(this.infoEl, this.warnEl, this.posEl);
        shell.append(bar, this.stage, status);
        this.root.appendChild(shell);
        this._bindInput();
        this.resizeObserver = new ResizeObserver(() => this._resize());
        this.resizeObserver.observe(this.stage);
    }

    _bindInput() {
        const st = this.stage;
        const local = e => { const r = st.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        st.addEventListener('wheel', e => {
            if (!this.view) return;
            e.preventDefault();
            const dz = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.002);
            const [x, y] = local(e);
            this._zoomAt(2 ** dz, x, y);
        }, { passive: false });
        st.addEventListener('pointerdown', e => {
            if (!this.view || (e.pointerType === 'mouse' && e.button !== 0)) return;
            st.setPointerCapture(e.pointerId);
            st.focus();
            this.pointers.set(e.pointerId, local(e));
            st.classList.add('dragging');
        });
        st.addEventListener('pointermove', e => {
            const [x, y] = local(e);
            this._showPosition(x, y);
            const prev = this.pointers.get(e.pointerId);
            if (!prev || !this.view) return;
            if (this.pointers.size === 1) {
                this._pan(x - prev[0], y - prev[1]);
            } else if (this.pointers.size === 2) {
                const other = [...this.pointers].find(([id]) => id !== e.pointerId)[1];
                const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
                const d1 = Math.hypot(x - other[0], y - other[1]);
                const m0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2];
                const m1 = [(x + other[0]) / 2, (y + other[1]) / 2];
                if (d0 > 0 && d1 > 0) this._zoomAt(d1 / d0, m0[0], m0[1]);
                this._pan(m1[0] - m0[0], m1[1] - m0[1]);
            }
            this.pointers.set(e.pointerId, [x, y]);
        });
        const up = e => {
            this.pointers.delete(e.pointerId);
            if (!this.pointers.size) st.classList.remove('dragging');
        };
        st.addEventListener('pointerup', up);
        st.addEventListener('pointercancel', up);
        st.addEventListener('pointerleave', () => { this.posEl.textContent = ''; });
        st.addEventListener('dblclick', e => {
            if (!this.view) return;
            const [x, y] = local(e);
            this._zoomAt(e.shiftKey ? 0.5 : 2, x, y);
        });
        st.addEventListener('keydown', e => {
            if (!this.view || e.ctrlKey || e.metaKey || e.altKey) return;
            const step = 40;
            const keys = {
                '+': () => this._zoomBy(Math.SQRT2), '=': () => this._zoomBy(Math.SQRT2), '-': () => this._zoomBy(Math.SQRT1_2),
                '0': () => this._fit(),
                ArrowLeft: () => this._pan(step, 0), ArrowRight: () => this._pan(-step, 0),
                ArrowUp: () => this._pan(0, step), ArrowDown: () => this._pan(0, -step),
            };
            if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
        });
    }

    async _init() {
        if (!this.fileId || !_ctx) return;
        const file = _ctx.projectFiles[this.fileId];
        if (!file) return;
        try {
            await this._show(await readText(file), true);
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        // Follow edits made in the file's editor tab
        this.watch = setInterval(() => {
            const f = _ctx.projectFiles[this.fileId];
            if (f && typeof f.content === 'string' && f.content !== this.source) this._show(f.content, false);
        }, 400);
    }

    async _show(text, fit) {
        this.source = text;
        const seq = this.seq = (this.seq || 0) + 1;
        this.titleEl.textContent = this.fileName;
        let measured;
        try {
            if (!this.plotter) this.plotter = await makePlotter(this.canvas);
            measured = this.plotter.measure(text);
        } catch (err) {
            if (seq !== this.seq) return;
            // While the file is being edited, keep the last drawing and say what is wrong
            if (this.text !== null) { this.warnEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not show ${this.fileName}: ${err.message}`);
            return;
        }
        if (seq !== this.seq) return;
        const { extent, skipped } = measured;
        if (!extent) {
            this.text = null;
            this._error(`${this.fileName}: no pen strokes hpgl-viewer can plot` + this._skippedText(skipped, ' (it skips '));
            return;
        }
        // A single point or a straight line still gets an area
        const pad = Math.max(extent.width, extent.height) * 0.01 || 1;
        const e = { x: extent.x - pad, y: extent.y - pad, width: extent.width + 2 * pad, height: extent.height + 2 * pad };
        const changed = !this.extent || ['x', 'y', 'width', 'height'].some(k => this.extent[k] !== e[k]);
        this.extent = e;
        this.text = text;
        if (!this.canvas.isConnected) { this.stage.innerHTML = ''; this.stage.appendChild(this.canvas); }
        const mm = v => (v / PLOTTER_UNITS_PER_MM).toFixed(1);
        this.infoEl.textContent = `${mm(extent.width)} × ${mm(extent.height)} mm (${Math.round(extent.width)} × ${Math.round(extent.height)} plotter units)`;
        this.warnEl.textContent = this._skippedText(skipped, 'not plotted: ');
        if (fit || changed || !this.view) this._fit(); else this._apply();
    }

    _skippedText(skipped, lead) {
        const names = Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([n, c]) => c > 1 ? `${n} ×${c}` : n);
        if (!names.length) return '';
        return lead + names.join(', ') + (lead.startsWith(' (') ? ')' : '');
    }

    _size() {
        return [Math.max(1, this.stage.clientWidth), Math.max(1, this.stage.clientHeight)];
    }

    _fit() {
        if (!this.extent) return;
        const [w, h] = this._size();
        const e = this.extent, pad = 16;
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((w - 2 * pad) / e.width, (h - 2 * pad) / e.height)));
        this.view = { s, x: e.x + e.width / 2 - w / 2 / s, y: e.y + e.height / 2 - h / 2 / s };
        this.fitScale = s;
        this._apply();
    }

    _zoomAt(factor, px, py) {
        if (!this.view) return;
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.s * factor));
        // The picture point under (px, py) stays there
        const ux = this.view.x + px / this.view.s, uy = this.view.y + py / this.view.s;
        this.view = { s, x: ux - px / s, y: uy - py / s };
        this._apply();
    }

    _zoomBy(factor) {
        const [w, h] = this._size();
        this._zoomAt(factor, w / 2, h / 2);
    }

    _pan(dx, dy) {
        if (!this.view) return;
        this.view = { ...this.view, x: this.view.x - dx / this.view.s, y: this.view.y - dy / this.view.s };
        this._apply();
    }

    _resize() {
        if (this.view) this._apply();
        else if (this.extent) this._fit();
    }

    // The visible part of the drawing, plotted afresh at each zoom, so it stays sharp
    _apply() {
        if (!this.plotter || this.text === null || !this.view) return;
        const [w, h] = this._size();
        const dpr = window.devicePixelRatio || 1;
        const v = this.view;
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.plotter.draw(this.text, v.x, v.y, v.s * dpr, 1.25 * dpr);
        // Zoom relative to the whole drawing fitted
        const pct = v.s / (this.fitScale || v.s) * 100;
        this.zoomEl.textContent = (pct >= 100 ? Math.round(pct) : +pct.toPrecision(3)) + '%';
    }

    // The pointer's place in plotter units (y up), and in millimetres
    _showPosition(px, py) {
        if (!this.view || !this.extent) return;
        const x = this.view.x + px / this.view.s;
        const y = 1 - (this.view.y + py / this.view.s);
        this.posEl.textContent = `${Math.round(x)}, ${Math.round(y)} (${(x / PLOTTER_UNITS_PER_MM).toFixed(1)}, ${(y / PLOTTER_UNITS_PER_MM).toFixed(1)} mm)`;
    }

    _error(msg) {
        this.view = null;
        this.stage.innerHTML = '';
        this.stage.appendChild(this._el('div', 'hpgl-error', msg));
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }
}

registerPlugin({
    id: 'hpgl',
    name: 'HP-GL plotter files',
    components: {
        hpglViewer: HpglComponent,
    },
    toolbarButtons: [
        { label: 'HP-GL', title: 'Open the HP-GL viewer', menuLabel: 'HP-GL plotter files as drawings' },
    ],
    thumbnailRenderers: [{
        canHandle: file => HPGL_NAME_RE.test(file.name) && !file.viewType,
        async render(file, container) {
            const text = await readText(file);
            // .plt: the file's icon stays unless the text is HP-GL
            if (SHARED_NAME_RE.test(file.name) && !looksLikeHpgl(text)) throw new Error('not an HP-GL file');
            const canvas = document.createElement('canvas');
            const plotter = await makePlotter(canvas);
            const { extent } = plotter.measure(text);
            if (!extent) throw new Error('nothing plotted');
            const size = 256, pad = 8;
            const s = Math.min((size - 2 * pad) / (extent.width || 1), (size - 2 * pad) / (extent.height || 1));
            canvas.width = canvas.height = size;
            plotter.draw(text, extent.x + extent.width / 2 - size / 2 / s, extent.y + extent.height / 2 - size / 2 / s, s, 1.5);
            canvas.id = '';
            canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#ffffff';
            container.innerHTML = '';
            container.appendChild(canvas);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { isHpglFile };
