// --- Gerber viewer ---
// PCB artwork: Gerber (RS-274X) layers and Excellon drill files, drawn as SVG by
// tracespace's gerber-to-svg; the board the folder's layers make, top and
// bottom, by pcb-stackup (both loaded from jsDelivr on first use, as their
// browser builds). What each file is (copper, solder mask, silkscreen, paste,
// outline, drill; top, bottom or inner) comes from its name, by
// whats-that-gerber, as CAM tools name them. The wheel (or a pinch, or + / −)
// zooms at the pointer, dragging pans, 0 fits. The layer follows the file's text
// as it is edited. Also draws layer thumbnails in the file browser's grid.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const LIBS = {
    gerberToSvg: 'https://cdn.jsdelivr.net/npm/gerber-to-svg@4.2.8/dist/gerber-to-svg.min.js',
    pcbStackup: 'https://cdn.jsdelivr.net/npm/pcb-stackup@4.2.8/dist/pcb-stackup.min.js',
    whatsThatGerber: 'https://cdn.jsdelivr.net/npm/whats-that-gerber@4.2.7/dist/whats-that-gerber.min.js',
};

// Names only Gerber and drill files have (KiCad, Altium/Protel, gEDA, OSH Park...)
const GERBER_NAME_RE = /\.(ger|gtl|gbl|gto|gbo|gts|gbs|gtp|gbp|gko|gml|gta|gba|gm\d+|gp[1-9tb]|gbr|art|pho|cmp|sol|plc|pls|stc|sts|crc|crs|drl|xln|drd|exc|g[1-9]\d?)$/i;
// ...of which these others use too (GIMP brushes, AOL ART pictures, Eagle's own
// names, .g1 for anything): one of them only when its text is Gerber or Excellon
const SHARED_NAME_RE = /\.(gbr|art|pho|cmp|sol|plc|pls|stc|sts|crc|crs|drd|exc|g[1-9]\d?)$/i;

// Gerber text has a format statement, a unit or a G04 comment line; Excellon starts its header with M48
function looksLikeGerber(text) {
    const head = text.slice(0, 8192);
    return /%FS[LTD]?[AI]?X\d\dY\d\d\*%|%MO(IN|MM)\*%|%TF\.\w+|^G04[ *]/m.test(head) || /^M48\s*$/m.test(head);
}

// A Gerber or drill file's name, and (once read) its text if it is one
function isGerberFile(f) {
    if (!GERBER_NAME_RE.test(f.name) || f.viewType) return false;
    if (typeof f.content !== 'string') return !SHARED_NAME_RE.test(f.name);
    return looksLikeGerber(f.content);
}

// Layer colors as a fabricated board shows them
const LAYER_COLORS = {
    copper: '#d4a74a', soldermask: '#2e8b57', silkscreen: '#f2f2f2', solderpaste: '#9aa0a6',
    drill: '#e6edf3', outline: '#e3b341', drawing: '#7aa2f7',
};
const LAYER_NAMES = {
    copper: 'copper', soldermask: 'solder mask', silkscreen: 'silkscreen', solderpaste: 'solder paste',
    drill: 'drill', outline: 'outline', drawing: 'drawing',
};
const MIN_SCALE = 1 / 4096, MAX_SCALE = 4096;
let _ctx = null;
let _libs = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

function ensureLibs() {
    if (!_libs) {
        _libs = Promise.all(Object.entries(LIBS).map(([name, src]) => window[name] ? null : loadScript(src)))
            .then(() => ({ gerberToSvg: window.gerberToSvg, pcbStackup: window.pcbStackup, whatsThatGerber: window.whatsThatGerber }));
        _libs.catch(() => { _libs = null; });
    }
    return _libs;
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

function folderOf(rel) {
    return rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

let _idSeq = 0;
// The layer drawn as an SVG document's text, in the color of what it is
async function layerSvg(text, name) {
    const { gerberToSvg, whatsThatGerber } = await ensureLibs();
    const kind = whatsThatGerber([name])[name] || {};
    const svg = await new Promise((resolve, reject) => {
        gerberToSvg(text, {
            id: 'gerber' + (++_idSeq),
            attributes: { color: LAYER_COLORS[kind.type] || '#d4a74a' },
            plotAsOutline: kind.type === 'outline',
        }, (err, out) => err ? reject(err) : resolve(out));
    });
    return { svg, kind };
}

// The SVG element for an SVG document's text
function svgElement(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.documentElement.nodeName !== 'svg') throw new Error('no picture');
    return document.importNode(doc.documentElement, true);
}

function viewBoxOf(svg) {
    const v = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (v.length !== 4 || !(v[2] > 0) || !(v[3] > 0)) return null;
    return { x: v[0], y: v[1], width: v[2], height: v[3] };
}

class GerberComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'layer.gbr';
        this.dir = this.fileId && _ctx ? folderOf(_ctx.getRelativePath(this.fileId)) : null;
        this.mode = 'layer';
        this.layer = null; // { svg, kind } of the file
        this.board = null; // pcb-stackup's result for the folder (a promise)
        this.extent = null;
        this.view = null; // { x, y, s }: the stage's top-left corner in picture units, and pixels per unit
        this.svg = null;
        this.source = null;
        this.pointers = new Map();
        this.root = container.element;
        this.root.classList.add('gerber-root');
        GerberComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (GerberComponent._styled) return;
        GerberComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.gerber-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.gerber-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.gerber-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.gerber-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.gerber-root button:hover{background:#444c56}
.gerber-root button.active{background:#1f6feb;border-color:#388bfd}
.gerber-root button:disabled{opacity:.5;cursor:default}
.gerber-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gerber-zoom{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.gerber-stage{position:relative;overflow:hidden;min-height:0;cursor:grab;touch-action:none;outline:none;background:#101418}
.gerber-stage.dragging{cursor:grabbing}
.gerber-stage>svg{position:absolute;left:0;top:0;display:block}
.gerber-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.gerber-status .gerber-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.gerber-status .gerber-pos{margin-left:auto;font-variant-numeric:tabular-nums}
.gerber-message{padding:20px;color:#adbac7;text-align:center}
.gerber-error{padding:20px;color:#ffb4ab;text-align:center;white-space:pre-wrap}
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
        const shell = this._el('div', 'gerber-shell');
        const bar = this._el('div', 'gerber-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            // A file from this computer: its folder can't be read, so there is no board
            this.fileId = null;
            this.dir = null;
            this.board = null;
            this.fileName = f.name;
            this.mode = 'layer';
            this._show(await f.text(), true);
        });
        this.titleEl = this._el('span', 'gerber-title', this.fileName);
        this.zoomEl = this._el('span', 'gerber-zoom', '');
        this.modeButtons = {
            layer: this._button('Layer', 'This file alone', () => this._setMode('layer')),
            top: this._button('Top', 'The board the layers in this folder make, from above', () => this._setMode('top')),
            bottom: this._button('Bottom', 'The board the layers in this folder make, from below', () => this._setMode('bottom')),
        };
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a Gerber or drill file from this computer', () => this.fileInput.click()),
            this.titleEl,
            this.modeButtons.layer, this.modeButtons.top, this.modeButtons.bottom,
            this._button('Fit', 'Show the whole picture (0)', () => this._fit()),
            this._button('−', 'Zoom out (−)', () => this._zoomBy(0.5)),
            this.zoomEl,
            this._button('+', 'Zoom in (+)', () => this._zoomBy(2)),
            this._button('Save SVG', 'Save what is shown as SVG', () => this._saveSvg()),
        );
        this.stage = this._el('div', 'gerber-stage');
        this.stage.tabIndex = 0;
        this.stage.appendChild(this._el('div', 'gerber-message', 'Open a Gerber (RS-274X) or Excellon drill file.'));
        const status = this._el('div', 'gerber-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'gerber-warn', '');
        this.posEl = this._el('span', 'gerber-pos', '');
        status.append(this.infoEl, this.warnEl, this.posEl);
        shell.append(bar, this.stage, status);
        this.root.appendChild(shell);
        this._updateModeButtons();
        this._bindInput();
        this.resizeObserver = new ResizeObserver(() => this._resize());
        this.resizeObserver.observe(this.stage);
    }

    _updateModeButtons() {
        for (const [m, b] of Object.entries(this.modeButtons)) {
            b.classList.toggle('active', m === this.mode);
            if (m !== 'layer') b.disabled = this.dir === null;
        }
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
            if (f && typeof f.content === 'string' && f.content !== this.source) {
                this.board = null;
                this._show(f.content, false);
            }
        }, 400);
    }

    async _show(text, fit) {
        this.source = text;
        const seq = this.seq = (this.seq || 0) + 1;
        this.titleEl.textContent = this.fileName;
        this._updateModeButtons();
        let layer;
        try {
            layer = await layerSvg(text, this.fileName);
        } catch (err) {
            if (seq !== this.seq) return;
            // While the file is being edited, keep the last picture and say what is wrong
            if (this.layer) { this.warnEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not show ${this.fileName}: ${err.message}`);
            return;
        }
        if (seq !== this.seq) return;
        this.layer = layer;
        if (this.mode === 'layer') this._display(layer.svg, fit, this._layerInfo(layer.kind));
    }

    _layerInfo(kind) {
        const what = [kind.side && kind.side !== 'all' ? kind.side : null, LAYER_NAMES[kind.type]].filter(Boolean).join(' ');
        return what ? `${what} layer` : 'layer of unknown kind (by its name)';
    }

    async _setMode(mode) {
        if (mode === this.mode && this.svg) return;
        this.mode = mode;
        this._updateModeButtons();
        if (mode === 'layer') {
            if (this.layer) this._display(this.layer.svg, true, this._layerInfo(this.layer.kind));
            return;
        }
        const seq = this.seq = (this.seq || 0) + 1;
        this.warnEl.textContent = '';
        this.infoEl.textContent = 'Reading the folder’s layers…';
        let board;
        try {
            if (!this.board) this.board = this._loadBoard();
            board = await this.board;
        } catch (err) {
            this.board = null;
            if (seq !== this.seq) return;
            this._error(`Could not put the board together: ${err.message}`);
            return;
        }
        if (seq !== this.seq || this.mode !== mode) return;
        const used = board.layers.filter(l => l.type);
        const info = `${used.length} layer${used.length === 1 ? '' : 's'}: ` + used.map(l => l.filename).join(', ');
        this._display(board[mode].svg, true, info);
        if (board.skipped.length) this.warnEl.textContent = `not used: ${board.skipped.join(', ')}`;
    }

    // Every Gerber and drill file in this one's folder, by its name, stacked into a board
    async _loadBoard() {
        const { pcbStackup, whatsThatGerber } = await ensureLibs();
        const ws = _ctx.wsClient;
        if (!ws || !ws.wsRequest || !_ctx.currentWorkspacePath) throw new Error('reading the folder needs the server workspace');
        const abs = _ctx.currentWorkspacePath + (this.dir ? '/' + this.dir : '');
        const res = await ws.wsRequest({ type: 'listDir', path: abs });
        if (!res || res.error) throw new Error((res && res.error) || 'the folder could not be listed');
        const names = res.items.filter(it => !it.isDirectory).map(it => it.name);
        const kinds = whatsThatGerber(names);
        const skipped = [];
        const layers = (await Promise.all(names.filter(n => kinds[n] && kinds[n].type).map(async name => {
            const resp = await fetch(await workspaceUrl((this.dir ? this.dir + '/' : '') + name));
            if (!resp.ok) { skipped.push(name); return null; }
            const text = await resp.text();
            if (!looksLikeGerber(text)) { skipped.push(name); return null; }
            return { filename: name, gerber: text };
        }))).filter(Boolean);
        if (!layers.length) throw new Error('no layers named as CAM tools name them in this folder');
        const board = await pcbStackup(layers, { id: 'gerber-board' + (++_idSeq) });
        board.skipped = skipped;
        return board;
    }

    _display(svgText, fit, info) {
        let svg;
        try {
            svg = svgElement(svgText);
        } catch (err) {
            this._error(`Could not show ${this.fileName}: ${err.message}`);
            return;
        }
        const extent = viewBoxOf(svg) || { x: 0, y: 0, width: 100, height: 100 };
        const changed = !this.extent || ['x', 'y', 'width', 'height'].some(k => this.extent[k] !== extent[k]);
        this.extent = extent;
        // The unit is the one the width is given in ("2.7in", "60mm")
        this.units = ((svg.getAttribute('width') || '').match(/[a-z]+$/) || ['in'])[0];
        this.svg = svg;
        svg.removeAttribute('style');
        this.stage.innerHTML = '';
        this.stage.appendChild(svg);
        this.infoEl.textContent = info;
        this.warnEl.textContent = '';
        if (fit || changed || !this.view) this._fit(); else this._apply();
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

    // The visible part of the picture as the SVG's viewBox: drawn afresh at each zoom, so it stays sharp
    _apply() {
        if (!this.svg || !this.view) return;
        const [w, h] = this._size();
        const v = this.view;
        this.svg.setAttribute('width', w);
        this.svg.setAttribute('height', h);
        this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${w / v.s} ${h / v.s}`);
        // Zoom relative to the whole picture fitted
        const pct = v.s / (this.fitScale || v.s) * 100;
        this.zoomEl.textContent = (pct >= 100 ? Math.round(pct) : +pct.toPrecision(3)) + '%';
    }

    // The pointer's place on the board: tracespace draws in thousandths of the file's unit, y up
    _showPosition(px, py) {
        if (!this.view || !this.extent) return;
        const x = this.view.x + px / this.view.s;
        const y = 2 * this.extent.y + this.extent.height - (this.view.y + py / this.view.s);
        this.posEl.textContent = `${(x / 1000).toFixed(3)}, ${(y / 1000).toFixed(3)} ${this.units}`;
    }

    _saveSvg() {
        if (!this.svg || !this.extent) return;
        const svg = this.svg.cloneNode(true);
        const e = this.extent;
        svg.setAttribute('viewBox', `${e.x} ${e.y} ${e.width} ${e.height}`);
        svg.setAttribute('width', e.width);
        svg.setAttribute('height', e.height);
        const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
        const blob = new Blob([text], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = this.fileName.replace(/\.[^.]+$/, '') + (this.mode === 'layer' ? '' : '-' + this.mode) + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    _error(msg) {
        this.svg = null;
        this.view = null;
        this.stage.innerHTML = '';
        this.stage.appendChild(this._el('div', 'gerber-error', msg));
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }
}

registerPlugin({
    id: 'gerber',
    name: 'Gerber PCB artwork',
    components: {
        gerberViewer: GerberComponent,
    },
    toolbarButtons: [
        { label: 'Gerber', title: 'Open the Gerber viewer', menuLabel: 'Gerber and drill files (PCB artwork) as vectors' },
    ],
    thumbnailRenderers: [{
        canHandle: file => GERBER_NAME_RE.test(file.name) && !file.viewType,
        async render(file, container) {
            const text = await readText(file);
            // A name others use too: the file's icon stays unless the text is Gerber or Excellon
            if (SHARED_NAME_RE.test(file.name) && !looksLikeGerber(text)) throw new Error('not a Gerber or drill file');
            const { svg } = await layerSvg(text, file.name);
            const img = document.createElement('img');
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#101418';
            container.innerHTML = '';
            container.appendChild(img);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { isGerberFile };
