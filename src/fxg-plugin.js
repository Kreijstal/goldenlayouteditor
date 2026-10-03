// --- FXG viewer ---
// Flash XML Graphics (.fxg, from Flex 4, Illustrator, Fireworks, Flash Catalyst)
// drawn as SVG (src/fxg.js) at any zoom: the wheel (or a pinch, or + / −) zooms
// at the pointer, dragging pans, 0 fits and 1 shows it at 100%. Bitmaps the file
// embeds (@Embed('…')) are read from beside it and inlined, so Save SVG writes
// one self-contained file. The picture follows the file's text as it is edited.
// Also draws .fxg thumbnails in the file browser's grid.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
const { fxgToSvg, fxgImageSources } = require('./fxg');

const FXG_RE = /\.fxg$/i;
const MIN_SCALE = 1 / 64, MAX_SCALE = 4096;
let _ctx = null;

function workspaceUrl(rel) {
    return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
}

// 'a/b/../c.png' relative to the folder `dir` ('' for the workspace root)
function joinPath(dir, rel) {
    const parts = (rel.startsWith('/') ? [] : dir.split('/')).filter(Boolean);
    for (const p of rel.split('/')) {
        if (!p || p === '.') continue;
        if (p === '..') parts.pop(); else parts.push(p);
    }
    return parts.join('/');
}

function dataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

const imageCache = new Map(); // workspace path -> Promise<{ href, width, height } | null>

// The bitmaps an FXG file embeds, read from the workspace beside it, as data: URLs with their sizes
async function loadImages(text, dir) {
    const images = new Map();
    if (!_ctx || !_ctx.currentWorkspacePath) return images;
    await Promise.all(fxgImageSources(text).map(async src => {
        if (/^(data|https?):/i.test(src)) { images.set(src, { href: src }); return; }
        const rel = joinPath(dir, src);
        let p = imageCache.get(rel);
        if (!p) {
            p = (async () => {
                try {
                    const resp = await fetch(await workspaceUrl(rel));
                    if (!resp.ok) return null;
                    const blob = await resp.blob();
                    let width, height;
                    try {
                        const bmp = await createImageBitmap(blob);
                        width = bmp.width; height = bmp.height;
                        bmp.close();
                    } catch (_) { /* SVG and others createImageBitmap can't size: stretched to the box */ }
                    return { href: await dataUrl(blob), width, height };
                } catch (_) {
                    return null;
                }
            })();
            imageCache.set(rel, p);
            if (imageCache.size > 200) imageCache.delete(imageCache.keys().next().value);
        }
        const img = await p;
        if (img) images.set(src, img);
    }));
    return images;
}

// The SVG element for converted FXG, in the page (hidden) so its extent can be measured
function svgElement(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    return document.importNode(doc.documentElement, true);
}

// Text without a width or height gets a box far larger than it (src/fxg.js);
// once laid out, each is shrunk to what its text takes, so it can be measured
function fitTextBoxes(svg) {
    for (const fo of svg.querySelectorAll('foreignObject')) {
        const div = fo.firstElementChild;
        if (!div) continue;
        if (+fo.getAttribute('width') >= 100000) fo.setAttribute('width', Math.ceil(div.offsetWidth) + 1);
        if (+fo.getAttribute('height') >= 100000) fo.setAttribute('height', Math.ceil(div.offsetHeight) + 1);
    }
}

// What the picture draws, strokes included (getBBox leaves them out, and
// browsers don't take its { stroke: true }): each stroked shape's box grown by
// half the stroke's width, or as far as a miter may reach
function strokedBox(svg) {
    const b = svg.getBBox();
    let x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
    for (const el of svg.querySelectorAll('[stroke]')) {
        if (el.closest('defs, mask, pattern') || el.getAttribute('stroke') === 'none') continue;
        let grow = (parseFloat(el.getAttribute('stroke-width')) || 1) / 2;
        if (el.getAttribute('stroke-linejoin') === 'miter') grow *= parseFloat(el.getAttribute('stroke-miterlimit')) || 4;
        else if (el.getAttribute('stroke-linecap') === 'square') grow *= Math.SQRT2;
        const e = el.getBBox(), m = el.getCTM();
        for (const [px, py] of [[e.x - grow, e.y - grow], [e.x + e.width + grow, e.y - grow], [e.x - grow, e.y + e.height + grow], [e.x + e.width + grow, e.y + e.height + grow]]) {
            const q = new DOMPoint(px, py).matrixTransform(m);
            x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
        }
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// The area to show: the Graphic's viewWidth × viewHeight, or else what it draws
function extentOf(result, svg) {
    let probe = null;
    if (!svg.isConnected) {
        probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
        probe.appendChild(svg);
        document.body.appendChild(probe);
    }
    fitTextBoxes(svg);
    let box = null;
    if (result.width !== null && result.height !== null && result.width > 0 && result.height > 0) {
        box = { x: 0, y: 0, width: result.width, height: result.height };
    } else {
        try { box = strokedBox(svg); } catch (_) { box = null; }
    }
    if (probe) { probe.remove(); svg.remove(); }
    if (!box || !(box.width > 0) || !(box.height > 0)) return { x: 0, y: 0, width: 100, height: 100 };
    return { x: box.x, y: box.y, width: box.width, height: box.height };
}

// A standalone SVG file of the picture `svg` (as measured by extentOf)
function standaloneSvg(svg, extent) {
    svg = svg.cloneNode(true);
    for (const page of svg.querySelectorAll('.fxg-page')) page.remove();
    svg.setAttribute('viewBox', `${extent.x} ${extent.y} ${extent.width} ${extent.height}`);
    svg.setAttribute('width', extent.width);
    svg.setAttribute('height', extent.height);
    svg.removeAttribute('overflow');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}

async function readText(file) {
    if (typeof file.content === 'string') return file.content;
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await workspaceUrl(_ctx.getRelativePath(file.id)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
}

function folderOf(rel) {
    return rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

class FxgComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'picture.fxg';
        this.dir = this.fileId && _ctx ? folderOf(_ctx.getRelativePath(this.fileId)) : '';
        this.result = null;
        this.extent = null;
        this.view = null; // { x, y, s }: the stage's top-left corner in picture units, and pixels per unit
        this.svg = null;
        this.source = null;
        this.pointers = new Map();
        this.root = container.element;
        this.root.classList.add('fxg-root');
        FxgComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (FxgComponent._styled) return;
        FxgComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.fxg-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.fxg-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.fxg-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.fxg-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.fxg-root button:hover{background:#444c56}
.fxg-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fxg-zoom{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.fxg-stage{position:relative;overflow:hidden;min-height:0;cursor:grab;touch-action:none;outline:none;background:#15181c}
.fxg-stage.dragging{cursor:grabbing}
.fxg-stage>svg{position:absolute;left:0;top:0;display:block}
.fxg-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.fxg-status .fxg-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.fxg-status .fxg-pos{margin-left:auto;font-variant-numeric:tabular-nums}
.fxg-message{padding:20px;color:#adbac7;text-align:center}
.fxg-error{padding:20px;color:#ffb4ab;text-align:center;white-space:pre-wrap}
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
        const shell = this._el('div', 'fxg-shell');
        const bar = this._el('div', 'fxg-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.fxg';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            // A file from this computer: its bitmaps can't be read, so they show as outlines
            this.fileId = null;
            this.dir = null;
            this.fileName = f.name;
            this._show(await f.text(), true);
        });
        this.titleEl = this._el('span', 'fxg-title', this.fileName);
        this.zoomEl = this._el('span', 'fxg-zoom', '');
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a .fxg from this computer', () => this.fileInput.click()),
            this.titleEl,
            this._button('Fit', 'Show the whole picture (0)', () => this._fit()),
            this._button('100%', 'One unit per pixel (1)', () => this._zoomTo(1)),
            this._button('−', 'Zoom out (−)', () => this._zoomBy(0.5)),
            this.zoomEl,
            this._button('+', 'Zoom in (+)', () => this._zoomBy(2)),
            this._button('Save SVG', 'Save the picture as SVG', () => this._saveSvg()),
        );
        this.stage = this._el('div', 'fxg-stage');
        this.stage.tabIndex = 0;
        this.stage.appendChild(this._el('div', 'fxg-message', 'Open a Flash XML Graphics file (.fxg).'));
        const status = this._el('div', 'fxg-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'fxg-warn', '');
        this.posEl = this._el('span', 'fxg-pos', '');
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
            // Links in the picture's text still work
            if (e.target.closest && e.target.closest('a')) return;
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

    async _show(text, fit) {
        this.source = text;
        const seq = this.seq = (this.seq || 0) + 1;
        this.titleEl.textContent = this.fileName;
        let result;
        try {
            const images = this.dir === null ? new Map() : await loadImages(text, this.dir);
            if (seq !== this.seq) return;
            result = fxgToSvg(text, { images });
        } catch (err) {
            if (seq !== this.seq) return;
            // While the file is being edited, keep the last picture and say what is wrong
            if (this.result) { this.warnEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not show ${this.fileName}: ${err.message}`);
            return;
        }
        this.result = result;
        this.svg = svgElement(result.svg);
        this.stage.innerHTML = '';
        this.stage.appendChild(this.svg);
        const extent = extentOf(result, this.svg);
        const changed = !this.extent || ['x', 'y', 'width', 'height'].some(k => this.extent[k] !== extent[k]);
        this.extent = extent;
        // The page: the Graphic's own area, white, behind the drawing
        const page = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        page.setAttribute('x', extent.x); page.setAttribute('y', extent.y);
        page.setAttribute('width', extent.width); page.setAttribute('height', extent.height);
        page.setAttribute('fill', '#fff');
        page.setAttribute('class', 'fxg-page');
        const first = this.svg.firstChild;
        this.svg.insertBefore(page, first && first.nodeName === 'defs' ? first.nextSibling : first);
        this._describe(result);
        if (fit || changed || !this.view) this._fit(); else this._apply();
    }

    _describe(r) {
        const c = r.counts;
        const shapes = ['Rect', 'Ellipse', 'Line', 'Path'].reduce((n, k) => n + (c[k] || 0), 0);
        const parts = [`${+this.extent.width.toFixed(2)}×${+this.extent.height.toFixed(2)}`];
        if (r.version) parts.push(`FXG ${r.version}`);
        parts.push(`${shapes} shape${shapes === 1 ? '' : 's'}`);
        if (c.Group) parts.push(`${c.Group} group${c.Group === 1 ? '' : 's'}`);
        if (c.text) parts.push(`${c.text} text`);
        if (c.BitmapImage) parts.push(`${c.BitmapImage} bitmap${c.BitmapImage === 1 ? '' : 's'}`);
        const grads = (c['linear gradient'] || 0) + (c['radial gradient'] || 0);
        if (grads) parts.push(`${grads} gradient${grads === 1 ? '' : 's'}`);
        if (c['symbol instance']) parts.push(`${c['symbol instance']} symbol${c['symbol instance'] === 1 ? '' : 's'}`);
        this.infoEl.textContent = parts.join(' · ');
        const warn = [];
        if (r.missingImages.length) warn.push(`missing bitmap${r.missingImages.length === 1 ? '' : 's'}: ${r.missingImages.join(', ')}`);
        if (r.unsupported.length) warn.push(`not drawn: ${r.unsupported.join(', ')}`);
        this.warnEl.textContent = warn.join(' · ');
        this.warnEl.title = warn.join('\n');
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

    _showPosition(px, py) {
        if (!this.view) return;
        const x = this.view.x + px / this.view.s, y = this.view.y + py / this.view.s;
        const d = Math.max(0, Math.min(6, Math.ceil(Math.log10(this.view.s))));
        this.posEl.textContent = `${x.toFixed(d)}, ${y.toFixed(d)}`;
    }

    _saveSvg() {
        if (!this.result) return;
        const blob = new Blob([standaloneSvg(this.svg, this.extent)], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = this.fileName.replace(/\.fxg$/i, '') + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    _error(msg) {
        this.svg = null;
        this.view = null;
        this.stage.innerHTML = '';
        this.stage.appendChild(this._el('div', 'fxg-error', msg));
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }
}

registerPlugin({
    id: 'fxg',
    name: 'FXG pictures',
    components: {
        fxgViewer: FxgComponent,
    },
    toolbarButtons: [
        { label: 'FXG', title: 'Open the FXG viewer', menuLabel: 'Flash XML Graphics (.fxg) as vectors' },
    ],
    thumbnailRenderers: [{
        canHandle: file => FXG_RE.test(file.name),
        async render(file, container) {
            const text = await readText(file);
            const rel = _ctx.getRelativePath(file.id);
            const result = fxgToSvg(text, { images: await loadImages(text, folderOf(rel)) });
            const el = svgElement(result.svg);
            const svg = standaloneSvg(el, extentOf(result, el));
            const img = document.createElement('img');
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            img.style.cssText = 'width:100%;height:100%;object-fit:contain';
            container.innerHTML = '';
            container.appendChild(img);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
