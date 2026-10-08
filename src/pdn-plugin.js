// --- Paint.NET images (.pdn) ---
// The picture as Paint.NET composites it, with its layers: show or hide each
// (Shift+click an eye: that layer alone), change a layer's opacity or blend mode,
// and the layers are composited again. Reading and compositing happen in a worker
// (public/pdn-worker.js), written from Paint.NET's own sources. Changes aren't
// saved. Thumbnails in the file browser are the PNG Paint.NET keeps in the file's
// header, read by itself.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('PDN');
const WORKER_URL = '/pdn-worker.js';
const PDN_RE = /\.pdn$/i;

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
        for (const p of pending.values()) p.reject(new Error(e.message || 'the Paint.NET reader failed'));
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

// --- The header's thumbnail, fetching only the header ---

async function fetchRange(url, start, end) {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // a server that ignores Range sends the whole file
    return resp.status === 206 ? bytes : bytes.subarray(start, end + 1);
}

// "PDN3", the XML header's length (24 bits), then <pdnImage ...><custom><thumb png="base64" />
async function pdnThumbnailPng(url) {
    let head = await fetchRange(url, 0, 65535);
    if (String.fromCharCode(head[0], head[1], head[2], head[3]) !== 'PDN3') return null;
    const length = head[4] | (head[5] << 8) | (head[6] << 16);
    if (head.length < 7 + length) head = await fetchRange(url, 0, 7 + length - 1);
    const xml = new TextDecoder().decode(head.subarray(7, 7 + length));
    const m = /<thumb\b[^>]*\spng="([^"]+)"/.exec(xml);
    if (!m) return null;
    return Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
}

const previews = new Map(); // url -> Promise<blob URL | null>
function pdnPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        p = pdnThumbnailPng(url).then(png => png ? URL.createObjectURL(new Blob([png], { type: 'image/png' })) : null);
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('Paint.NET thumbnail failed:', err); });
        if (previews.size > 64) {
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

// --- The viewer ---

class PdnComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = PdnComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'image.pdn';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.selected = null;
        this.zoom = 'fit';
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.root = container.element;
        this.root.classList.add('pdn-root');
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
        if (PdnComponent._styleInstalled) return;
        PdnComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.pdn-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.pdn-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.pdn-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.pdn-root button,.pdn-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.pdn-root button:hover{background:#444c56}
.pdn-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdn-status{color:#adbac7;margin-left:auto}
.pdn-main{display:grid;grid-template-columns:1fr 280px;min-height:0}
.pdn-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.pdn-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.pdn-stage.dark{background:#111}.pdn-stage.light{background:#fff}
.pdn-stage canvas{flex:none}
.pdn-stage canvas.pixelated{image-rendering:pixelated}
.pdn-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.pdn-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.pdn-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.pdn-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.pdn-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.pdn-layer:hover{background:#2d333b}
.pdn-layer.sel{background:#303b49}
.pdn-layer.off .pdn-name,.pdn-layer.off canvas{opacity:.45}
.pdn-eye{flex:none;width:22px;padding:0!important;text-align:center}
.pdn-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.pdn-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.pdn-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.pdn-tag.warn{color:#e3b341;border-color:#9e6a03}
.pdn-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.pdn-props input[type=range]{width:100%}
.pdn-props .full{grid-column:1/-1}
.pdn-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:160px;overflow:auto;border-top:1px solid #373e47}
.pdn-info span:nth-child(odd){color:#adbac7}
.pdn-info span:nth-child(even){overflow-wrap:anywhere}
.pdn-message{padding:20px;color:#adbac7;text-align:center}
.pdn-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.pdn-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.pdn-side{border-left:none;border-top:1px solid #444c56}}
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
        const shell = this._el('div', 'pdn-shell');
        const bar = this._el('div', 'pdn-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.pdn';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'pdn-title', this.fileName);
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        const bg = this._select('Background', [['checker', 'Checker'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => { this.stage.className = 'pdn-stage ' + v; });
        const reset = this._button('Reset', 'Undo all changes to layers: the picture as saved', () => { this.changes = {}; this._renderLayers(); this._showProps(); this._render(); });
        const save = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(PDN_RE, '') + '.png'));
        this.statusEl = this._el('span', 'pdn-status');
        bar.append(this.fileInput, this._button('Open', 'Open a .pdn from this computer', () => this.fileInput.click()), this.titleEl, zoom, bg, reset, save, this.statusEl);

        const main = this._el('div', 'pdn-main');
        this.stage = this._el('div', 'pdn-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'pdn-side');
        const head = this._el('h3', null, 'Layers');
        head.appendChild(this._button('All on', 'Show every layer', () => {
            for (const l of this.layers) this._set(l.id, 'visible', l.visible ? undefined : true);
            this._renderLayers();
            this._render();
        }));
        this.layersEl = this._el('div', 'pdn-layers');
        this.propsEl = this._el('div', 'pdn-props');
        this.infoEl = this._el('div', 'pdn-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'pdn-message', 'Open a Paint.NET image (.pdn).'));
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
            const t0 = performance.now();
            const r = await this.ws.call('open', { bytes: buffer }, [buffer]);
            if (gen !== this.generation) return;
            this.info = r.info;
            this.layers = r.layers;
            this.thumbs = r.thumbs;
            this.byId = new Map(this.layers.map(l => [l.id, l]));
            this.modeNames = new Map(r.info.modes);
            this._paint(r.image);
            this._renderLayers();
            this._showProps();
            this._renderInfo();
            this._status(Math.round(performance.now() - t0));
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
        this.stage.querySelectorAll('.pdn-message, .pdn-error').forEach(e => e.remove());
        this._fit();
    }

    _fit() {
        if (!this.info) return;
        const { width, height } = this.canvas;
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

    _changedCount() {
        return Object.keys(this.changes).length;
    }

    _status(ms) {
        const i = this.info;
        const changed = this._changedCount();
        this.statusEl.textContent = `${i.width} × ${i.height} · ${this.layers.length} layer${this.layers.length === 1 ? '' : 's'}`
            + `${changed ? ` · ${changed} changed (not saved to the file)` : ''}${ms !== undefined ? ` · ${ms} ms` : ''}`;
    }

    // The value in effect: the viewer's change, or what the file says
    _get(l, key) {
        const c = this.changes[l.id];
        return c && c[key] !== undefined ? c[key] : l[key];
    }

    _set(id, key, value) {
        const c = this.changes[id] || (this.changes[id] = {});
        if (value === undefined) delete c[key]; else c[key] = value;
        if (!Object.keys(c).length) delete this.changes[id];
    }

    // Recomposite in the worker; while one runs, changes made meanwhile wait for the next
    async _render() {
        if (this.rendering) { this.renderAgain = true; return; }
        this.rendering = true;
        const gen = this.generation;
        try {
            do {
                this.renderAgain = false;
                this.statusEl.textContent = 'Compositing…';
                const t0 = performance.now();
                const r = await this.ws.call('render', { changes: this.changes });
                if (gen !== this.generation) return;
                this._paint(r.image);
                this._status(Math.round(performance.now() - t0));
            } while (this.renderAgain);
        } catch (err) {
            this._error(err.message);
        } finally {
            this.rendering = false;
        }
    }

    _renderLayers() {
        this.layersEl.innerHTML = '';
        for (const l of this.layers) {
            const visible = this._get(l, 'visible');
            const row = this._el('div', 'pdn-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : ''));
            const eye = this._button(visible ? '👁' : ' ', 'Show / hide (Shift+click: this layer alone)', e => {
                e.stopPropagation();
                if (e.shiftKey) {
                    for (const o of this.layers) this._set(o.id, 'visible', (o === l) === o.visible ? undefined : o === l);
                } else this._set(l.id, 'visible', !visible === l.visible ? undefined : !visible);
                this._renderLayers();
                this._render();
            });
            eye.className = 'pdn-eye';
            const thumb = this._el('canvas');
            const t = this.thumbs && this.thumbs[l.id];
            if (t) {
                thumb.width = t.width;
                thumb.height = t.height;
                thumb.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
            }
            const name = this._el('span', 'pdn-name', l.name || '(unnamed)');
            name.title = l.name;
            row.append(eye, thumb, name);
            const mode = this._get(l, 'mode');
            if (mode !== 'normal') row.appendChild(this._el('span', 'pdn-tag', this.modeNames.get(mode) || mode));
            if (this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'pdn-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
            if (l.problem) {
                const w = this._el('span', 'pdn-tag warn', 'not shown');
                w.title = l.problem;
                row.appendChild(w);
            }
            row.addEventListener('click', () => { this.selected = l.id; this._renderLayers(); this._showProps(); });
            this.layersEl.appendChild(row);
        }
    }

    _showProps() {
        this.propsEl.innerHTML = '';
        const l = this.byId && this.byId.get(this.selected);
        if (!l) {
            this.propsEl.appendChild(this._el('span', 'full', 'Select a layer to change it.')).style.color = '#adbac7';
            return;
        }
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
        const mode = this._select('Blend mode', this.info.modes, this._get(l, 'mode'), v => {
            this._set(l.id, 'mode', v === l.mode ? undefined : v);
            this._renderLayers();
            this._render();
        });
        const facts = [l.isBackground ? 'background layer' : '', l.problem].filter(Boolean);
        const details = this._el('span', 'full', facts.join(' · '));
        details.style.color = '#adbac7';
        const save = this._button('Save layer as PNG', 'This layer alone, at full opacity', async () => {
            const r = await this.ws.call('layer', { layerId: l.id });
            const c = document.createElement('canvas');
            c.width = this.info.width;
            c.height = this.info.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), c.width, c.height), 0, 0);
            this._savePng(c, `${this.fileName.replace(PDN_RE, '')}-${(l.name || 'layer').replace(/[^\w.-]+/g, '_')}.png`);
        });
        save.classList.add('full');
        this.propsEl.append(this._el('b', 'full', l.name), this._el('span', null, 'Visible'), vis, opLabel, op, this._el('span', null, 'Mode'), mode, details, save);
    }

    _renderInfo() {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const rows = [
            ['Size', `${i.width} × ${i.height}`],
            ['Resolution', i.resolution ? `${i.resolution[0].toFixed(0)} × ${i.resolution[1].toFixed(0)} dpi` : ''],
            ['Saved with', i.savedWith ? `Paint.NET ${i.savedWith}` : ''],
            ['Software', i.software],
        ];
        for (const [k, v] of rows) if (v) this.infoEl.append(this._el('span', null, k), this._el('span', null, String(v)));
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
        this.stage.querySelectorAll('.pdn-message, .pdn-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'pdn-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
    }
}

// File browser thumbnails: the PNG in the file's header
let _ctx = null;
const pdnThumbnails = {
    canHandle(file) {
        return file.type === 'file' && PDN_RE.test(file.name);
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await pdnPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
            if (!url) return;
            container.textContent = '';
            container.style.fontSize = '';
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;';
            container.appendChild(img);
        } catch (_) { /* keeps its icon */ }
    },
};

registerPlugin({
    id: 'pdn',
    name: 'Paint.NET images',
    components: {
        pdnViewer: PdnComponent,
    },
    toolbarButtons: [
        { label: 'PDN', title: 'Open the Paint.NET image viewer', menuLabel: 'Paint.NET image (.pdn) with layers' },
    ],
    thumbnailRenderers: [pdnThumbnails],
    init(ctx) {
        PdnComponent._ctx = ctx;
        _ctx = ctx;
    },
});
