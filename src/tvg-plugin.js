// --- TinyVG viewer ---
// A TinyVG picture (.tvg) at any zoom: the wheel (or a pinch, or + / −)
// zooms at the pointer, dragging pans, 0 fits and 1 shows it at 100%. Each
// view is drawn afresh from the vectors by src/tvg-view.js, exactly, so edges
// stay sharp however deep it goes.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
const { parseTvg, tvgToSvg } = require('./tvg');
const { prepare, renderView, fitView, panView, zoomView, viewPoint } = require('./tvg-view');

const LOG10_2 = Math.log10(2);

function formatZoom(z) {
    if (Math.abs(z) < 20) {
        const pct = 2 ** z * 100;
        return (pct >= 100 ? Math.round(pct) : +pct.toPrecision(3)) + '%';
    }
    // Powers of ten past a million: 3.2e45×
    const d = z * LOG10_2, k = Math.floor(d);
    return `${(10 ** (d - k)).toFixed(1)}e${k}×`;
}

class TvgComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = TvgComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'picture.tvg';
        this.doc = null;
        this.prepared = null;
        this.view = null;
        this.frame = 0;
        this.pointers = new Map();
        this.root = container.element;
        this.root.classList.add('tvg-root');
        this._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (TvgComponent._styleInstalled) return;
        TvgComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.tvg-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.tvg-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.tvg-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.tvg-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.tvg-root button:hover{background:#444c56}
.tvg-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tvg-zoom{min-width:70px;text-align:center;font-variant-numeric:tabular-nums}
.tvg-stage{position:relative;overflow:hidden;min-height:0;cursor:grab;touch-action:none;outline:none;background:#15181c}
.tvg-stage.dragging{cursor:grabbing}
.tvg-stage svg{position:absolute;left:0;top:0;display:block}
.tvg-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.tvg-status .tvg-pos{margin-left:auto;font-variant-numeric:tabular-nums}
.tvg-message{padding:20px;color:#adbac7;text-align:center}
.tvg-error{padding:20px;color:#ffb4ab;text-align:center}
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
        this.root.innerHTML = '';
        const shell = this._el('div', 'tvg-shell');
        const bar = this._el('div', 'tvg-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.tvg';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'tvg-title', this.fileName);
        this.zoomEl = this._el('span', 'tvg-zoom', '');
        const zoomBy = dz => () => this._zoom(dz);
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a .tvg from this computer', () => this.fileInput.click()),
            this.titleEl,
            this._button('Fit', 'Show the whole picture (0)', () => this._fit()),
            this._button('100%', 'One unit per pixel (1)', () => this._actualSize()),
            this._button('−', 'Zoom out (−)', zoomBy(-1)),
            this.zoomEl,
            this._button('+', 'Zoom in (+)', zoomBy(1)),
            this._button('Save SVG', 'Save the whole picture as SVG', () => this._saveSvg()),
        );
        this.stage = this._el('div', 'tvg-stage');
        this.stage.tabIndex = 0;
        this.stage.appendChild(this._el('div', 'tvg-message', 'Open a TinyVG picture (.tvg).'));
        const status = this._el('div', 'tvg-status');
        this.infoEl = this._el('span', null, '');
        this.posEl = this._el('span', 'tvg-pos', '');
        status.append(this.infoEl, this.posEl);
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
            // Pixels (trackpads, pinches) or lines (mouse wheels)
            const dz = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.002);
            const [x, y] = local(e);
            this.view = zoomView(this.view, dz, x, y);
            this._schedule();
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
                this.view = panView(this.view, x - prev[0], y - prev[1]);
            } else if (this.pointers.size === 2) {
                // Pinch: zoom by the change in spread, around the midpoint, which also pans
                const other = [...this.pointers].find(([id]) => id !== e.pointerId)[1];
                const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
                const d1 = Math.hypot(x - other[0], y - other[1]);
                const m0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2];
                const m1 = [(x + other[0]) / 2, (y + other[1]) / 2];
                if (d0 > 0 && d1 > 0) this.view = zoomView(this.view, Math.log2(d1 / d0), m0[0], m0[1]);
                this.view = panView(this.view, m1[0] - m0[0], m1[1] - m0[1]);
            }
            this.pointers.set(e.pointerId, [x, y]);
            this._schedule();
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
            this.view = zoomView(this.view, e.shiftKey ? -1 : 1, x, y);
            this._schedule();
        });
        st.addEventListener('keydown', e => {
            if (!this.view || e.ctrlKey || e.metaKey || e.altKey) return;
            const step = 40;
            const keys = {
                '+': () => this._zoom(0.5), '=': () => this._zoom(0.5), '-': () => this._zoom(-0.5),
                '0': () => this._fit(), '1': () => this._actualSize(),
                ArrowLeft: () => this._pan(step, 0), ArrowRight: () => this._pan(-step, 0),
                ArrowUp: () => this._pan(0, step), ArrowDown: () => this._pan(0, -step),
            };
            if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
        });
    }

    async _init() {
        if (!this.fileData) return;
        if (!this.ctx || !this.ctx.currentWorkspacePath) {
            this._error('Opening a project file needs the server workspace; use Open.');
            return;
        }
        try {
            const rel = this.ctx.getRelativePath(this.fileId);
            const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + rel));
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            this._open(this.fileData.name, await resp.arrayBuffer());
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
        }
    }

    _open(name, buffer) {
        this.fileName = name;
        this.titleEl.textContent = name;
        try {
            this.doc = parseTvg(new Uint8Array(buffer));
            this.prepared = prepare(this.doc);
        } catch (err) {
            this._error(`Could not show ${name}: ${err.message}`);
            return;
        }
        const d = this.doc;
        const counts = d.commands.filter(c => c.type !== 'text_hint').length;
        const texts = d.commands.length - counts;
        const bits = { reduced: 8, default: 16, enhanced: 32 }[d.coordinateRange];
        this.infoEl.textContent = `${d.width}×${d.height} · ${counts} shapes${texts ? ` · ${texts} text hints` : ''} · ${d.colors.length} colors (${d.colorEncoding})`
            + ` · ${bits}-bit units in 1/${2 ** d.scale} · ${d.size.toLocaleString()} bytes`;
        this.view = null;
        this._resize();
    }

    _size() {
        return [Math.max(1, this.stage.clientWidth), Math.max(1, this.stage.clientHeight)];
    }

    _resize() {
        if (!this.doc) return;
        const [w, h] = this._size();
        this.view = this.view ? { ...this.view, width: w, height: h } : fitView(this.doc, w, h);
        this._schedule();
    }

    _fit() {
        if (!this.doc) return;
        const [w, h] = this._size();
        this.view = fitView(this.doc, w, h);
        this._schedule();
    }

    _actualSize() {
        if (!this.view) return;
        this.view = zoomView(this.view, -this.view.z, this.view.width / 2, this.view.height / 2);
        this._schedule();
    }

    _zoom(dz) {
        if (!this.view) return;
        this.view = zoomView(this.view, dz, this.view.width / 2, this.view.height / 2);
        this._schedule();
    }

    _pan(dx, dy) {
        this.view = panView(this.view, dx, dy);
        this._schedule();
    }

    _schedule() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this._render();
        });
    }

    _render() {
        if (!this.view) return;
        try {
            this.stage.innerHTML = renderView(this.prepared, this.view);
        } catch (err) {
            this._error(`Could not draw ${this.fileName}: ${err.message}`);
            return;
        }
        this.zoomEl.textContent = formatZoom(this.view.z);
    }

    _showPosition(x, y) {
        if (!this.view) return;
        // Doubles hold the position to about 15 digits, enough down to ~10^13×
        const decimals = Math.ceil(this.view.z * LOG10_2) + 1;
        if (decimals > 15) { this.posEl.textContent = ''; return; }
        const p = viewPoint(this.view, x, y);
        const f = v => v.toFixed(Math.max(0, decimals));
        this.posEl.textContent = `${f(p.x)}, ${f(p.y)}`;
    }

    _saveSvg() {
        if (!this.doc) return;
        const blob = new Blob([tvgToSvg(this.doc)], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = this.fileName.replace(/\.tvg$/i, '') + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    _error(msg) {
        this.stage.innerHTML = '';
        this.stage.appendChild(this._el('div', 'tvg-error', msg));
    }

    _destroy() {
        if (this.frame) cancelAnimationFrame(this.frame);
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }
}

registerPlugin({
    id: 'tvg',
    name: 'TinyVG pictures',
    components: {
        tvgViewer: TvgComponent,
    },
    toolbarButtons: [
        { label: 'TVG', title: 'Open the TinyVG viewer', menuLabel: 'TinyVG picture (.tvg) at any zoom' },
    ],
    init(ctx) {
        TvgComponent._ctx = ctx;
    },
});
