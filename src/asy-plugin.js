// --- Asymptote viewer ---
// Asymptote programs (.asy) run by Asymptote itself, as WebAssembly, in a
// worker (public/asy-worker.js, asymptote-web loaded from jsDelivr on first
// use): what the program draws, as SVG at any zoom (the wheel, a pinch or
// + / − zooms at the pointer, dragging pans, 0 fits, 1 is one PostScript point
// per pixel). A program that imports a 3D module (three, graph3, solids...) is
// shown as Asymptote's own WebGL page, turned by dragging; the 2D / 3D button
// switches. Labels are set without TeX. The picture follows the file's text as
// it is edited; an error keeps the last picture and names its line and column.
// The source stays in the text editor. Also draws thumbnails of 2D programs in
// the file browser's grid.
// Not read: modules of the user's own (an import of a file beside the program),
// TeX in labels; in 2D, surfaces' mesh shading (asymptote-web's EPS to SVG).
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const ASY_RE = /\.asy$/i;
// Asymptote's 3D modules: a program importing one is drawn in WebGL
const THREE_D_RE = /^\s*(?:import|access|from|include)\s+"?(?:three|graph3|solids|tube|contour3|smoothcontour3|grid3|obj|bsp|labelpath3|three_\w+)\b/m;
const MIN_SCALE = 1 / 64, MAX_SCALE = 4096;
const BP_PER_CM = 72 / 2.54;
let _ctx = null;

let worker = null;
let nextId = 1;
const pending = new Map();

function startWorker() {
    worker = new Worker('/asy-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        if (data.error) {
            const err = new Error(data.error);
            err.log = data.log;
            p.reject(err);
            // Asymptote fails every program after one it gave up on: a fresh engine for those waiting
            if (data.broken) {
                worker.terminate();
                startWorker();
                for (const q of pending.values()) worker.postMessage(q.message);
            }
        } else {
            p.resolve(data.result);
        }
    };
    worker.onerror = e => {
        for (const p of pending.values()) p.reject(new Error(e.message || 'Asymptote failed to load'));
        pending.clear();
        worker.terminate();
        worker = null;
    };
}

// The program drawn: { output (SVG, or the WebGL page's HTML), format, warnings, log };
// an error carries what Asymptote said (err.log)
function asymptote(source, name, webgl) {
    if (!worker) startWorker();
    const message = { id: nextId++, source, name, webgl };
    return new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject, message });
        worker.postMessage(message);
    });
}

// What Asymptote said went wrong, in a line: "line 3, column 1: unexpected end of input"
// (its messages name the program input.asy, in the folder it ran in)
function errorLine(log, name) {
    const lines = (log || '').split('\n');
    for (const line of lines) {
        const m = /^(\S*?)([^/\s]+\.asy): (\d+)\.(\d+): (.+)$/.exec(line);
        if (!m) continue;
        const where = m[2] === 'input.asy' && m[1].startsWith('/tmp/asymptote-web/') ? '' : m[2] + ' ';
        return `${where}line ${m[3]}, column ${m[4]}: ${m[5].replace(/[:\s]+$/, '')}`.replace(/^./, c => c.toUpperCase());
    }
    const other = lines.find(l => /error|fatal/i.test(l) && !/could not load module/.test(l));
    return (other || lines.find(l => l.trim()) || '').trim().replace(/\/tmp\/asymptote-web\/render-\d+\/input\.asy/g, name);
}

// The warnings, each once, with how often
function warningText(warnings) {
    const count = new Map();
    for (const w of warnings || []) count.set(w, (count.get(w) || 0) + 1);
    return [...count].map(([w, n]) => n > 1 ? `${w} ×${n}` : w).join(' · ');
}

function is3d(text) {
    return THREE_D_RE.test(text);
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

function svgElement(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    return document.importNode(doc.documentElement, true);
}

function download(text, type, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

class AsyComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'picture.asy';
        this.result = null;
        this.extent = null;
        this.view = null; // { x, y, s }: the stage's top-left corner in picture units (bp), and pixels per unit
        this.svg = null;
        this.frame = null;
        this.source = null;
        this.webgl = null; // null: by what the program imports
        this.busy = false;
        this.pointers = new Map();
        this.root = container.element;
        this.root.classList.add('asy-root');
        AsyComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (AsyComponent._styled) return;
        AsyComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.asy-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.asy-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.asy-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.asy-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.asy-root button:hover{background:#444c56}
.asy-root button:disabled{opacity:.5;cursor:default}
.asy-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.asy-zoom{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.asy-stage{position:relative;overflow:hidden;min-height:0;cursor:grab;touch-action:none;outline:none;background:#15181c}
.asy-stage.dragging{cursor:grabbing}
.asy-stage.webgl{cursor:default;background:#ffffff}
.asy-stage>svg{position:absolute;left:0;top:0;display:block}
.asy-stage>iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#ffffff}
.asy-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.asy-status .asy-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.asy-status .asy-pos{margin-left:auto;font-variant-numeric:tabular-nums}
.asy-message{padding:20px;color:#adbac7;text-align:center}
.asy-error{padding:20px;color:#ffb4ab;text-align:center;white-space:pre-wrap}
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
        const shell = this._el('div', 'asy-shell');
        const bar = this._el('div', 'asy-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.asy';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            this.fileId = null;
            this.fileName = f.name;
            this.webgl = null;
            this._show(await f.text(), true);
        });
        this.titleEl = this._el('span', 'asy-title', this.fileName);
        this.zoomEl = this._el('span', 'asy-zoom', '');
        this.modeBtn = this._button('3D', 'Show the program in 3D (WebGL) or in 2D (SVG)', () => {
            this.webgl = !this._webgl();
            this._show(this.source, true);
        });
        this.zoomBtns = [
            this._button('Fit', 'Show the whole picture (0)', () => this._fit()),
            this._button('100%', 'One PostScript point per pixel (1)', () => this._zoomTo(1)),
            this._button('−', 'Zoom out (−)', () => this._zoomBy(0.5)),
            this.zoomEl,
            this._button('+', 'Zoom in (+)', () => this._zoomBy(2)),
        ];
        this.saveBtn = this._button('Save SVG', 'Save the picture', () => this._save());
        bar.append(
            this.fileInput,
            this._button('Open', 'Open an Asymptote program from this computer', () => this.fileInput.click()),
            this.titleEl,
            this.modeBtn,
            ...this.zoomBtns,
            this.saveBtn,
        );
        this.stage = this._el('div', 'asy-stage');
        this.stage.tabIndex = 0;
        this.stage.appendChild(this._el('div', 'asy-message', 'Open an Asymptote program (.asy).'));
        const status = this._el('div', 'asy-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'asy-warn', '');
        this.posEl = this._el('span', 'asy-pos', '');
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
                '0': () => this._fit(), '1': () => this._zoomTo(1),
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
            this._show(await readText(file), true);
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

    _webgl() {
        return this.webgl === null ? is3d(this.source || '') : this.webgl;
    }

    async _show(text, fit) {
        this.source = text;
        this.titleEl.textContent = this.fileName;
        // One run at a time; edits made meanwhile are drawn when it ends, the last of them only
        if (this.busy) { this.again = this.again || fit; return; }
        this.busy = true;
        const webgl = this._webgl();
        this.modeBtn.textContent = webgl ? '2D' : '3D';
        if (!this.result) this.infoEl.textContent = 'Running Asymptote…';
        let result, failure = null;
        try {
            result = await asymptote(text, this.fileName, webgl);
        } catch (err) {
            failure = err;
        }
        this.busy = false;
        if (this.source !== text || this._webgl() !== webgl) {
            const again = this.again;
            this.again = false;
            this._show(this.source, fit || again);
            return;
        }
        if (failure) {
            const msg = errorLine(failure.log, this.fileName) || failure.message;
            // While the file is being edited, keep the last picture and say what is wrong
            if (this.result && this.result.format === (webgl ? 'webgl' : 'svg')) { this.warnEl.textContent = `Not updated: ${msg}`; this.warnEl.title = failure.log || ''; return; }
            this.result = null;
            this.infoEl.textContent = '';
            this.warnEl.textContent = '';
            this._error(`${this.fileName}: ${msg}`);
            return;
        }
        this.result = result;
        this.warnEl.textContent = warningText(result.warnings);
        this.warnEl.title = this.warnEl.textContent;
        this.saveBtn.textContent = webgl ? 'Save HTML' : 'Save SVG';
        for (const b of this.zoomBtns) if (b.tagName === 'BUTTON') b.disabled = webgl;
        if (webgl) this._showWebgl(result.output); else this._showSvg(result.output, fit);
    }

    _showSvg(svgText, fit) {
        this.frame = null;
        this.stage.classList.remove('webgl');
        this.svg = svgElement(svgText);
        const w = parseFloat(this.svg.getAttribute('width')) || 0, h = parseFloat(this.svg.getAttribute('height')) || 0;
        const vb = (this.svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
        const extent = vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0
            ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } : { x: 0, y: 0, width: w || 100, height: h || 100 };
        // The page, white, behind the drawing
        const page = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        page.setAttribute('x', extent.x); page.setAttribute('y', extent.y);
        page.setAttribute('width', extent.width); page.setAttribute('height', extent.height);
        page.setAttribute('fill', '#fff');
        const first = this.svg.firstChild;
        this.svg.insertBefore(page, first && first.nodeName === 'defs' ? first.nextSibling : first);
        this.svg.setAttribute('overflow', 'visible');
        this.stage.innerHTML = '';
        this.stage.appendChild(this.svg);
        const changed = !this.extent || ['x', 'y', 'width', 'height'].some(k => this.extent[k] !== extent[k]);
        this.extent = extent;
        const cm = v => (v / BP_PER_CM).toFixed(2);
        this.infoEl.textContent = `${+extent.width.toFixed(2)} × ${+extent.height.toFixed(2)} bp (${cm(extent.width)} × ${cm(extent.height)} cm)`;
        if (fit || changed || !this.view) this._fit(); else this._apply();
    }

    // Asymptote's own WebGL page (AsyGL), in a frame of its own; not sandboxed:
    // AsyGL, embedded, keeps its WebGL context and canvas in the top document
    _showWebgl(html) {
        this.svg = null;
        this.view = null;
        this.extent = null;
        this.zoomEl.textContent = '';
        this.stage.classList.add('webgl');
        this.stage.innerHTML = '';
        this.frame = this._el('iframe');
        this.frame.title = this.fileName;
        this.frame.srcdoc = html;
        this.stage.appendChild(this.frame);
        this.infoEl.textContent = '3D (WebGL): drag to turn, shift-drag to zoom, right-click for the menu';
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

    _zoomTo(s) {
        if (this.view) this._zoomBy(s / this.view.s);
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

    // The visible part of the picture as the SVG's viewBox: drawn afresh at each zoom, so it stays sharp
    _apply() {
        if (!this.svg || !this.view) return;
        const [w, h] = this._size();
        const v = this.view;
        this.svg.setAttribute('width', w);
        this.svg.setAttribute('height', h);
        this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${w / v.s} ${h / v.s}`);
        const pct = v.s * 100;
        this.zoomEl.textContent = (pct >= 100 ? Math.round(pct) : +pct.toPrecision(3)) + '%';
    }

    // The pointer's place in PostScript points, as Asymptote measures them (y up, from the picture's bottom left)
    _showPosition(px, py) {
        if (!this.view || !this.extent) return;
        const x = this.view.x + px / this.view.s - this.extent.x;
        const y = this.extent.y + this.extent.height - (this.view.y + py / this.view.s);
        const d = Math.max(0, Math.min(6, Math.ceil(Math.log10(this.view.s))));
        this.posEl.textContent = `${x.toFixed(d)}, ${y.toFixed(d)} bp`;
    }

    _save() {
        if (!this.result) return;
        const base = this.fileName.replace(/\.asy$/i, '');
        if (this.result.format === 'webgl') download(this.result.output, 'text/html', base + '.html');
        else download(this.result.output, 'image/svg+xml', base + '.svg');
    }

    _error(msg) {
        this.svg = null;
        this.frame = null;
        this.view = null;
        this.extent = null;
        this.stage.classList.remove('webgl');
        this.stage.innerHTML = '';
        this.stage.appendChild(this._el('div', 'asy-error', msg));
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }
}

registerPlugin({
    id: 'asymptote',
    name: 'Asymptote pictures',
    components: {
        asyViewer: AsyComponent,
    },
    toolbarButtons: [
        { label: 'Asymptote', title: 'Open the Asymptote viewer', menuLabel: 'Asymptote programs (.asy) as pictures' },
    ],
    thumbnailRenderers: [{
        canHandle: file => ASY_RE.test(file.name),
        async render(file, container) {
            const text = await readText(file);
            // (a 3D program's surfaces need WebGL: its icon stays)
            if (is3d(text)) throw new Error('a 3D program');
            const { output } = await asymptote(text, file.name, false);
            const img = document.createElement('img');
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(output);
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#ffffff';
            container.innerHTML = '';
            container.appendChild(img);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
