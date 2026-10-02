// --- GIMP images (.xcf) ---
// The picture as GIMP composites it, with its layers: show or hide each (Shift+
// click an eye: that layer alone), change a layer's opacity, mode or mask, and
// the picture is recomposited. Reading and compositing happen in a worker
// (public/xcf-worker.js), written from GIMP's own sources. Changes aren't saved.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('XCF');
const WORKER_URL = '/xcf-worker.js';

function startWorker() {
    const worker = new Worker(WORKER_URL);
    const pending = new Map();
    let next = 1;
    worker.onmessage = ({ data }) => {
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
    };
    worker.onerror = e => {
        for (const p of pending.values()) p.reject(new Error(e.message || 'the XCF reader failed'));
        pending.clear();
    };
    return {
        call(cmd, args = {}, transfer = []) {
            const id = next++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                worker.postMessage({ id, cmd, ...args }, transfer);
            });
        },
        terminate() { worker.terminate(); },
    };
}

class XcfComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = XcfComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'image.xcf';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.collapsed = new Set();
        this.selected = null;
        this.zoom = 'fit';
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.root = container.element;
        this.root.classList.add('xcf-root');
        this._installStyles();
        this._buildUI();
        if (container.on) {
            container.on('destroy', () => this._destroy());
            container.on('resize', () => this._fit());
        }
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (XcfComponent._styleInstalled) return;
        XcfComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.xcf-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.xcf-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.xcf-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.xcf-root button,.xcf-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.xcf-root button:hover{background:#444c56}
.xcf-root button:disabled{opacity:.4;cursor:default}
.xcf-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xcf-status{color:#adbac7;margin-left:auto}
.xcf-main{display:grid;grid-template-columns:1fr 300px;min-height:0}
.xcf-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.xcf-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.xcf-stage.dark{background:#111}.xcf-stage.light{background:#fff}
.xcf-stage canvas{flex:none;image-rendering:auto}
.xcf-stage canvas.pixelated{image-rendering:pixelated}
.xcf-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.xcf-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.xcf-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.xcf-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.xcf-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.xcf-layer:hover{background:#2d333b}
.xcf-layer.sel{background:#303b49}
.xcf-layer.off .xcf-name,.xcf-layer.off canvas{opacity:.45}
.xcf-eye{flex:none;width:22px;padding:0!important;text-align:center}
.xcf-twisty{flex:none;width:12px;color:#adbac7;text-align:center}
.xcf-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.xcf-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.xcf-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.xcf-tag.warn{color:#e3b341;border-color:#9e6a03}
.xcf-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.xcf-props input[type=range]{width:100%}
.xcf-props .full{grid-column:1/-1}
.xcf-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:180px;overflow:auto;border-top:1px solid #373e47}
.xcf-info span:nth-child(odd){color:#adbac7}
.xcf-message{padding:20px;color:#adbac7;text-align:center}
.xcf-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.xcf-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.xcf-side{border-left:none;border-top:1px solid #444c56}}
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

    _select(title, options, value, onChange) {
        const s = this._el('select');
        s.title = title;
        for (const [v, label] of options) s.appendChild(Object.assign(this._el('option', null, label), { value: v }));
        s.value = value;
        s.addEventListener('change', () => onChange(s.value));
        return s;
    }

    _buildUI() {
        this.root.innerHTML = '';
        const shell = this._el('div', 'xcf-shell');
        const bar = this._el('div', 'xcf-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.xcf';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'xcf-title', this.fileName);
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        const bg = this._select('Background', [['checker', 'Checker'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => { this.stage.className = 'xcf-stage ' + v; });
        this.resetBtn = this._button('Reset', 'Undo all changes to layers', () => { this.changes = {}; this._renderLayers(); this._showProps(); this._render(); });
        this.exportBtn = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(/\.xcf$/i, '') + '.png'));
        this.statusEl = this._el('span', 'xcf-status');
        bar.append(this.fileInput, this._button('Open', 'Open an .xcf from this computer', () => this.fileInput.click()), this.titleEl, zoom, bg, this.resetBtn, this.exportBtn, this.statusEl);

        const main = this._el('div', 'xcf-main');
        this.stage = this._el('div', 'xcf-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'xcf-side');
        const head = this._el('h3', null, 'Layers');
        head.appendChild(this._button('All on', 'Show every layer as saved', () => { for (const l of this.layers) this._set(l.id, 'visible', undefined); this._renderLayers(); this._render(); }));
        this.layersEl = this._el('div', 'xcf-layers');
        this.propsEl = this._el('div', 'xcf-props');
        this.infoEl = this._el('div', 'xcf-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'xcf-message', 'Open a GIMP image (.xcf).'));
        this.canvas.style.display = 'none';
    }

    async _init() {
        if (!this.fileData) return;
        if (!this.ctx || !this.ctx.currentWorkspacePath) {
            this._error('Opening a project file needs the server workspace; use Open.');
            return;
        }
        try {
            this.statusEl.textContent = 'Reading…';
            const rel = this.ctx.getRelativePath(this.fileId);
            const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + rel));
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._open(this.fileData.name, await resp.arrayBuffer());
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
        }
    }

    async _open(name, buffer) {
        const gen = ++this.generation;
        this.fileName = name;
        this.titleEl.textContent = name;
        this.changes = {};
        this.selected = null;
        if (!this.ws) this.ws = startWorker();
        this.statusEl.textContent = 'Reading layers…';
        try {
            const r = await this.ws.call('open', { bytes: buffer }, [buffer]);
            if (gen !== this.generation) return;
            this.info = r.info;
            this.layers = r.layers;
            this.thumbs = r.thumbs;
            this.byId = new Map(this.layers.map(l => [l.id, l]));
            this._paint(r.image);
            this._renderLayers();
            this._showProps();
            this._renderInfo();
            this.statusEl.textContent = `${r.info.width} × ${r.info.height} · ${this.layers.length} layers`;
        } catch (err) {
            if (gen !== this.generation) return;
            log.error('Open failed:', err);
            this._error(`Could not open ${name}: ${err.message}`);
        }
    }

    _paint(pixels) {
        const { width, height } = this.info;
        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer || pixels), width, height), 0, 0);
        this.canvas.style.display = '';
        this.stage.querySelectorAll('.xcf-message, .xcf-error').forEach(e => e.remove());
        this._fit();
    }

    _fit() {
        if (!this.info) return;
        const { width, height } = this.info;
        let scale = +this.zoom;
        if (this.zoom === 'fit') {
            const r = this.stage.getBoundingClientRect();
            scale = Math.min((r.width - 16) / width, (r.height - 16) / height);
            if (!(scale > 0)) scale = 1;
            if (scale > 1) scale = Math.max(1, Math.floor(scale)); // small images: whole steps
        }
        this.canvas.classList.toggle('pixelated', scale >= 2);
        this.canvas.style.width = Math.round(width * scale) + 'px';
        this.canvas.style.height = Math.round(height * scale) + 'px';
    }

    // The value in effect: the viewer's change, or what the file says
    _get(l, key) {
        const c = this.changes[l.id];
        return c && c[key] !== undefined ? c[key] : l[key];
    }

    _set(id, key, value) {
        const c = this.changes[id] || (this.changes[id] = {});
        if (value === undefined) delete c[key]; else c[key] = value;
    }

    // Recomposite in the worker; while one runs, changes made meanwhile wait for the next
    async _render() {
        if (this.rendering) { this.renderAgain = true; return; }
        this.rendering = true;
        const gen = this.generation;
        try {
            do {
                this.renderAgain = false;
                const t0 = performance.now();
                const r = await this.ws.call('render', { changes: this.changes });
                if (gen !== this.generation) return;
                this._paint(r.image);
                const changed = Object.values(this.changes).filter(c => Object.keys(c).length).length;
                this.statusEl.textContent = `${this.info.width} × ${this.info.height} · ${this.layers.length} layers${changed ? ` · ${changed} changed (not saved to the file)` : ''} · ${Math.round(performance.now() - t0)} ms`;
            } while (this.renderAgain);
        } catch (err) {
            this._error(err.message);
        } finally {
            this.rendering = false;
        }
    }

    _hiddenByCollapse(l) {
        // A layer is out of the list when a group above it is collapsed
        const i = this.layers.indexOf(l);
        let depth = l.depth;
        for (let k = i - 1; k >= 0 && depth > 0; k--) {
            const p = this.layers[k];
            if (p.depth < depth) {
                if (this.collapsed.has(p.id)) return true;
                depth = p.depth;
            }
        }
        return false;
    }

    _renderLayers() {
        this.layersEl.innerHTML = '';
        for (const l of this.layers) {
            if (this._hiddenByCollapse(l)) continue;
            const visible = this._get(l, 'visible');
            const row = this._el('div', 'xcf-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : ''));
            row.style.paddingLeft = (6 + l.depth * 14) + 'px';
            const eye = this._button(visible ? '👁' : ' ', 'Show / hide (Shift+click: this layer alone)', e => {
                e.stopPropagation();
                if (e.shiftKey) this._solo(l); else this._set(l.id, 'visible', !visible === l.visible ? undefined : !visible);
                this._renderLayers();
                this._render();
            });
            eye.className = 'xcf-eye';
            const twisty = this._el('span', 'xcf-twisty', l.group ? (this.collapsed.has(l.id) ? '▸' : '▾') : '');
            if (l.group) twisty.addEventListener('click', e => {
                e.stopPropagation();
                if (this.collapsed.has(l.id)) this.collapsed.delete(l.id); else this.collapsed.add(l.id);
                this._renderLayers();
            });
            const thumb = this._el('canvas');
            const t = this.thumbs && this.thumbs[l.id];
            if (t) {
                thumb.width = t.width;
                thumb.height = t.height;
                thumb.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
            }
            const name = this._el('span', 'xcf-name', l.name || '(unnamed)');
            name.title = `${l.name}\n${l.width} × ${l.height} at ${l.x}, ${l.y}`;
            row.append(eye, twisty, thumb, name);
            const mode = this._get(l, 'mode');
            const modeName = this.info.modes[mode] || mode;
            if (!(mode === 28 || mode === 0 || (l.group && mode === 61))) row.appendChild(this._el('span', 'xcf-tag', modeName));
            if (this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'xcf-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
            if (l.hasMask) row.appendChild(this._el('span', 'xcf-tag', this._get(l, 'applyMask') ? 'mask' : 'mask off'));
            if (l.text) row.appendChild(this._el('span', 'xcf-tag', 'T'));
            if (l.link) row.appendChild(this._el('span', 'xcf-tag', 'link'));
            if (l.vector) row.appendChild(this._el('span', 'xcf-tag', 'vector'));
            if (l.effects) {
                const w = this._el('span', 'xcf-tag warn', `${l.effects} filter${l.effects > 1 ? 's' : ''}`);
                w.title = 'GIMP 3 non-destructive filters are not applied here';
                row.appendChild(w);
            }
            if (l.broken) row.appendChild(this._el('span', 'xcf-tag warn', 'unreadable'));
            row.addEventListener('click', () => { this.selected = l.id; this._renderLayers(); this._showProps(); });
            this.layersEl.appendChild(row);
        }
    }

    // This layer alone: it, its groups and its own children on, everything else off
    _solo(target) {
        const i = this.layers.indexOf(target);
        const keep = new Set([target.id]);
        let depth = target.depth;
        for (let k = i - 1; k >= 0 && depth > 0; k--) {
            if (this.layers[k].depth < depth) { keep.add(this.layers[k].id); depth = this.layers[k].depth; }
        }
        for (let k = i + 1; k < this.layers.length && this.layers[k].depth > target.depth; k++) keep.add(this.layers[k].id);
        for (const l of this.layers) {
            const want = keep.has(l.id) ? true : false;
            this._set(l.id, 'visible', want === l.visible ? undefined : want);
        }
    }

    _showProps() {
        this.propsEl.innerHTML = '';
        const l = this.byId && this.byId.get(this.selected);
        if (!l) {
            this.propsEl.appendChild(this._el('span', 'full', 'Select a layer to change it.')).style.color = '#adbac7';
            return;
        }
        const title = this._el('b', 'full', l.name);
        const vis = this._el('input');
        vis.type = 'checkbox';
        vis.checked = this._get(l, 'visible');
        vis.addEventListener('change', () => { this._set(l.id, 'visible', vis.checked === l.visible ? undefined : vis.checked); this._renderLayers(); this._render(); });
        const op = this._el('input');
        op.type = 'range'; op.min = 0; op.max = 100; op.step = 1;
        op.value = Math.round(this._get(l, 'opacity') * 100);
        const opLabel = this._el('span', null, `Opacity ${op.value}%`);
        op.addEventListener('input', () => {
            opLabel.textContent = `Opacity ${op.value}%`;
            const v = op.value / 100;
            this._set(l.id, 'opacity', Math.abs(v - l.opacity) < 0.005 ? undefined : v);
            this._render();
        });
        op.addEventListener('change', () => this._renderLayers());
        const modes = this.info.modes.map((m, i) => [i, m]).filter(([i]) => l.group || i !== 61);
        const mode = this._select('Layer mode', modes, this._get(l, 'mode'), v => {
            this._set(l.id, 'mode', +v === l.mode ? undefined : +v);
            this._renderLayers();
            this._render();
        });
        this.propsEl.append(title, this._el('span', null, 'Visible'), vis, opLabel, op, this._el('span', null, 'Mode'), mode);
        if (l.hasMask) {
            const m = this._el('input');
            m.type = 'checkbox';
            m.checked = this._get(l, 'applyMask');
            m.addEventListener('change', () => { this._set(l.id, 'applyMask', m.checked === l.applyMask ? undefined : m.checked); this._renderLayers(); this._render(); });
            this.propsEl.append(this._el('span', null, 'Apply mask'), m);
        }
        const details = this._el('span', 'full', `${l.width} × ${l.height} at ${l.x}, ${l.y}${l.group ? ' · group' : ''}${l.text ? ' · text layer' : ''}${l.effects ? ` · ${l.effects} filter(s) not applied` : ''}`);
        details.style.color = '#adbac7';
        const save = this._button('Save layer as PNG', 'This layer alone (with its mask), image-sized', async () => {
            const r = await this.ws.call('layer', { layerId: l.id });
            const c = document.createElement('canvas');
            c.width = this.info.width;
            c.height = this.info.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), c.width, c.height), 0, 0);
            this._savePng(c, `${this.fileName.replace(/\.xcf$/i, '')}-${(l.name || 'layer').replace(/[^\w.-]+/g, '_')}.png`);
        });
        save.classList.add('full');
        this.propsEl.append(details, save);
    }

    _renderInfo() {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const rows = [
            ['Size', `${i.width} × ${i.height}`],
            ['Mode', i.mode + (i.colors ? ` (${i.colors} colours)` : '')],
            ['Precision', i.precision],
            ['XCF version', i.version],
            ['Compression', i.compression],
            ['Resolution', i.resolution ? `${i.resolution[0].toFixed(0)} × ${i.resolution[1].toFixed(0)} dpi` : ''],
            ['Channels', i.channels && i.channels.length ? i.channels.join(', ') : ''],
            ['Comment', i.comment],
        ];
        for (const [k, v] of rows) if (v !== '' && v !== undefined) this.infoEl.append(this._el('span', null, k), this._el('span', null, String(v)));
    }

    _savePng(canvas, name) {
        canvas.toBlob(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }, 'image/png');
    }

    _error(message) {
        this.statusEl.textContent = 'Error';
        this.stage.querySelectorAll('.xcf-message, .xcf-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'xcf-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
    }
}

registerPlugin({
    id: 'xcf',
    name: 'GIMP images',
    components: {
        xcfViewer: XcfComponent,
    },
    toolbarButtons: [
        { label: 'XCF', title: 'Open the GIMP image viewer', menuLabel: 'GIMP image (.xcf) with layers' },
    ],
    init(ctx) {
        XcfComponent._ctx = ctx;
    },
});
