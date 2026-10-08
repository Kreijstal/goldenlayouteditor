// --- Paint Shop Pro images (.psp, .pspimage, .tub, .pspframe, ...) ---
// The picture as saved, with its layers: show or hide each (Shift+click an eye:
// that layer alone), change a layer's opacity or blend mode, and the raster
// layers are composited again, groups, masks and mask layers included, with Paint
// Shop Pro's own blend arithmetic. Vector, adjustment and art media layers aren't
// drawn here: while they show, the picture is the composite Paint Shop Pro stored
// in the file. Reading and compositing happen in a worker (public/psp-worker.js).
// Changes aren't saved. Thumbnails in the file browser are the thumbnail Paint
// Shop Pro keeps near the file's start, read by itself.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('PSP');
const WORKER_URL = '/psp-worker.js';
// Names Paint Shop Pro gives its images, tubes, frames, masks, brushes, shapes and selections
const PSP_RE = /\.(psp|pspimage|psptube|pspframe|pspmask|pspbrush|pspshape|pspselection|tub|pfr)$/i;
// ...of which these are other files' names too (PlayStation Portable makefiles,
// TrueDoc fonts...): one only if it starts "Paint Shop Pro Image File" (mirrors
// PSP_MAYBE_RE in ws-handler.js)
const PSP_MAYBE_RE = /\.(psp|tub|pfr)$/i;
const SIGNATURE = 'Paint Shop Pro Image File\n\x1a';

function isPspMaybeName(name) {
    return PSP_MAYBE_RE.test(name || '');
}

function isPsp(bytes) {
    return bytes.length >= 27 && String.fromCharCode(...bytes.subarray(0, 27)) === SIGNATURE;
}

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
        for (const p of pending.values()) p.reject(new Error(e.message || 'the Paint Shop Pro reader failed'));
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

// --- The stored thumbnail, read with Range requests (in a worker of its own) ---

let thumbWorker = null;
const previews = new Map(); // url -> Promise<blob URL | null>
function pspPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        if (!thumbWorker) thumbWorker = startWorker();
        p = thumbWorker.call('thumb', { url: new URL(url, location.href).href }).then(blob => blob ? URL.createObjectURL(blob) : null);
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('Paint Shop Pro thumbnail failed:', err); });
        if (previews.size > 64) {
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

// --- The viewer ---

class PspComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = PspComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'image.pspimage';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.selected = null;
        this.zoom = 'fit';
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.root = container.element;
        this.root.classList.add('psp-root');
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
        if (PspComponent._styleInstalled) return;
        PspComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.psp-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.psp-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.psp-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.psp-root button,.psp-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.psp-root button:hover{background:#444c56}
.psp-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.psp-status{color:#adbac7;margin-left:auto}
.psp-main{display:grid;grid-template-columns:1fr 280px;min-height:0}
.psp-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.psp-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.psp-stage.dark{background:#111}.psp-stage.light{background:#fff}
.psp-stage canvas{flex:none}
.psp-stage canvas.pixelated{image-rendering:pixelated}
.psp-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.psp-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.psp-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.psp-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.psp-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.psp-layer:hover{background:#2d333b}
.psp-layer.sel{background:#303b49}
.psp-layer.off .psp-name,.psp-layer.off canvas{opacity:.45}
.psp-eye{flex:none;width:22px;padding:0!important;text-align:center}
.psp-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.psp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.psp-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.psp-tag.warn{color:#e3b341;border-color:#9e6a03}
.psp-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.psp-props input[type=range]{width:100%}
.psp-props .full{grid-column:1/-1}
.psp-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:160px;overflow:auto;border-top:1px solid #373e47}
.psp-info span:nth-child(odd){color:#adbac7}
.psp-info span:nth-child(even){overflow-wrap:anywhere}
.psp-message{padding:20px;color:#adbac7;text-align:center}
.psp-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.psp-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.psp-side{border-left:none;border-top:1px solid #444c56}}
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
        const shell = this._el('div', 'psp-shell');
        const bar = this._el('div', 'psp-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.psp,.pspimage,.psptube,.pspframe,.pspmask,.pspbrush,.pspshape,.pspselection,.tub,.pfr';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'psp-title', this.fileName);
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        const bg = this._select('Background', [['checker', 'Checker'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => { this.stage.className = 'psp-stage ' + v; });
        const reset = this._button('Reset', 'Undo all changes to layers: the picture as saved', () => { this.changes = {}; this._renderLayers(); this._showProps(); this._render(); });
        const save = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(PSP_RE, '') + '.png'));
        this.statusEl = this._el('span', 'psp-status');
        bar.append(this.fileInput, this._button('Open', 'Open a Paint Shop Pro image from this computer', () => this.fileInput.click()), this.titleEl, zoom, bg, reset, save, this.statusEl);

        const main = this._el('div', 'psp-main');
        this.stage = this._el('div', 'psp-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'psp-side');
        const head = this._el('h3', null, 'Layers');
        head.appendChild(this._button('All on', 'Show every layer', () => {
            for (const l of this.layers) this._set(l.id, 'visible', l.visible ? undefined : true);
            this._renderLayers();
            this._render();
        }));
        this.layersEl = this._el('div', 'psp-layers');
        this.propsEl = this._el('div', 'psp-props');
        this.infoEl = this._el('div', 'psp-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'psp-message', 'Open a Paint Shop Pro image (.psp, .pspimage, .tub, ...).'));
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
            this.source = r.source;
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
        this.stage.querySelectorAll('.psp-message, .psp-error').forEach(e => e.remove());
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
        const what = this.source === 'stored' ? 'Paint Shop Pro\'s composite'
            : this.source === 'stored-jpeg' ? 'Paint Shop Pro\'s composite (JPEG)'
            : `composited here${i.missing ? ' without the vector, adjustment or art media layers' : ''}`;
        this.statusEl.textContent = `${i.width} × ${i.height} · ${this.layers.length} layer${this.layers.length === 1 ? '' : 's'} · ${what}`
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
                this.source = r.source;
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
            const row = this._el('div', 'psp-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : ''));
            row.style.paddingLeft = (6 + 14 * l.depth) + 'px';
            const eye = this._button(visible ? '👁' : ' ', 'Show / hide (Shift+click: this layer alone)', e => {
                e.stopPropagation();
                if (e.shiftKey) {
                    for (const o of this.layers) this._set(o.id, 'visible', (o === l) === o.visible ? undefined : o === l);
                } else this._set(l.id, 'visible', !visible === l.visible ? undefined : !visible);
                this._renderLayers();
                this._render();
            });
            eye.className = 'psp-eye';
            const thumb = this._el('canvas');
            const t = this.thumbs && this.thumbs[l.id];
            if (t) {
                thumb.width = t.width;
                thumb.height = t.height;
                thumb.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
            }
            const name = this._el('span', 'psp-name', l.name || '(unnamed)');
            name.title = l.name;
            row.append(eye, thumb, name);
            if (l.kind !== 'raster') row.appendChild(this._el('span', 'psp-tag', l.kind));
            const mode = this._get(l, 'mode');
            if (mode !== '0' && l.type !== 6) row.appendChild(this._el('span', 'psp-tag', this.modeNames.get(mode) || mode));
            if (this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'psp-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
            if (l.problem) {
                const w = this._el('span', 'psp-tag warn', 'not drawn');
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
        const facts = [`${l.kind} layer`, l.hasMask ? `a mask${l.maskDisabled ? ' (disabled)' : ''}` : '',
            l.protected ? 'transparency locked' : '', l.problem].filter(Boolean);
        const details = this._el('span', 'full', facts.join(' · '));
        details.style.color = '#adbac7';
        const save = this._button('Save layer as PNG', 'This layer alone, at full opacity, its mask applied (a mask layer: its mask)', async () => {
            const r = await this.ws.call('layer', { layerId: l.id });
            const c = document.createElement('canvas');
            c.width = this.info.width;
            c.height = this.info.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), c.width, c.height), 0, 0);
            this._savePng(c, `${this.fileName.replace(PSP_RE, '')}-${(l.name || 'layer').replace(/[^\w.-]+/g, '_')}.png`);
        });
        save.classList.add('full');
        this.propsEl.append(this._el('b', 'full', l.name), this._el('span', null, 'Visible'), vis, opLabel, op, this._el('span', null, 'Mode'), mode, details, save);
    }

    _renderInfo() {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const c = i.creator || {};
        const date = t => t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';
        // the creating program's version: major, minor and revision bytes (0x07000404 is 7.04)
        const version = v => v ? `${v >>> 24}.${(v >> 16) & 255}${(v >> 8) & 255}` : '';
        const stored = i.stored.map(s => `${s.type === 1 ? 'thumbnail' : 'composite'} ${s.width} × ${s.height}${s.jpeg ? ' (JPEG)' : ''}${s.alpha ? ' with transparency' : ''}`);
        const t = i.tube;
        const rows = [
            ['Size', `${i.width} × ${i.height}`],
            ['Pixels', i.depth >= 24 ? `${i.depth}-bit RGB` : i.grey ? `${i.depth}-bit grey` : `${i.depth}-bit, ${i.colours} colours`],
            ['Compression', i.compression],
            ['Resolution', i.resolution ? `${i.resolution.toFixed(0)} pixels/${i.metric === 2 ? 'cm' : 'inch'}` : ''],
            ['File format', i.version],
            ['Created with', c.app === 1 && c.version ? `Paint Shop Pro ${version(c.version)}` : ''],
            ['Title', c.title], ['Artist', c.artist], ['Copyright', c.copyright], ['Description', c.description],
            ['Created', date(c.created)], ['Modified', date(c.modified)],
            ['Tube', t ? `${t.cells} cell${t.cells === 1 ? '' : 's'}, ${t.cols} × ${t.rows}, step ${t.step}` : ''],
            ['Stored', stored.join(', ') + (i.storedProblem ? ` (damaged: ${i.storedProblem})` : '')],
            ['Shown', i.source === 'composited' ? `the layers composited here${i.missing ? ' (the vector, adjustment or art media layers aren\'t drawn)' : ''}`
                : `Paint Shop Pro's composite${i.source === 'stored-jpeg' ? ' (JPEG)' : ''}, until a layer is changed`],
            ['Also', [i.profile && 'an ICC profile', i.selection && 'a selection', i.alphaChannels && 'alpha channels'].filter(Boolean).join(', ')],
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
        this.stage.querySelectorAll('.psp-message, .psp-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'psp-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
    }
}

// File browser thumbnails: the file's stored thumbnail (a .psp, .tub or .pfr
// that isn't Paint Shop Pro's keeps its icon)
let _ctx = null;
const pspThumbnails = {
    canHandle(file) {
        // (a .psp read as text is someone else's; browse mode hasn't read any yet: its content is '')
        return file.type === 'file' && PSP_RE.test(file.name) && !(isPspMaybeName(file.name) && file.content);
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await pspPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
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
    id: 'psp',
    name: 'Paint Shop Pro images',
    components: {
        pspViewer: PspComponent,
    },
    toolbarButtons: [
        { label: 'PSP', title: 'Open the Paint Shop Pro image viewer', menuLabel: 'Paint Shop Pro image (.psp, .pspimage) with layers' },
    ],
    thumbnailRenderers: [pspThumbnails],
    init(ctx) {
        PspComponent._ctx = ctx;
        _ctx = ctx;
    },
});

module.exports = { isPspMaybeName, isPsp };
