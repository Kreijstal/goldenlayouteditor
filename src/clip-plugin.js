// --- Clip Studio Paint files (.clip) ---
// The picture with its layers: show or hide each (Shift+click an eye: that layer
// alone), change a layer's opacity, blending mode or mask, and the layers are
// composited again. Reading and compositing happen in a worker
// (public/clip-worker.js), at the mipmap level chosen (100%, 50%... as Clip
// Studio Paint keeps them). Text, vector lines and other layers Clip Studio Paint
// draws itself aren't always saved as pixels: while one shows, the picture is the
// preview Clip Studio Paint stored (often smaller than the canvas). Changes aren't
// saved. Thumbnails in the file browser are that preview, read by itself.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('CLIP');
const WORKER_URL = '/clip-worker.js';
const CLIP_RE = /\.clip$/i;
const KIND_NAMES = {
    folder: 'folder', raster: '', vector: 'vector', text: 'text', fill: 'fill', tone: 'tone', paper: 'paper',
    correction: 'correction', image: 'image', story: 'story info', other: 'other',
};

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
        for (const p of pending.values()) p.reject(new Error(e.message || 'the Clip Studio Paint reader failed'));
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

// --- The stored preview, for the file browser: the worker reads only the database ---

let thumbWorker = null;
const previews = new Map(); // url -> Promise<blob URL | null>
function clipPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        if (!thumbWorker) thumbWorker = startWorker();
        p = thumbWorker.call('thumbnail', { url: new URL(url, location.href).href })
            .then(r => r.png ? URL.createObjectURL(new Blob([r.png], { type: 'image/png' })) : null);
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('Clip Studio Paint thumbnail failed:', err); });
        if (previews.size > 64) {
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

// --- The viewer ---

class ClipComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = ClipComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'picture.clip';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.selected = null;
        this.zoom = 'fit';
        this.level = 0;
        this.source = 'composited'; // or 'preview': the picture Clip Studio Paint stored
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.root = container.element;
        this.root.classList.add('clip-root');
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
        if (ClipComponent._styleInstalled) return;
        ClipComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.clip-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.clip-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.clip-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.clip-root button,.clip-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.clip-root button:hover{background:#444c56}
.clip-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip-status{color:#adbac7;margin-left:auto}
.clip-main{display:grid;grid-template-columns:1fr 290px;min-height:0}
.clip-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.clip-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.clip-stage.dark{background:#111}.clip-stage.light{background:#fff}
.clip-stage canvas{flex:none}
.clip-stage canvas.pixelated{image-rendering:pixelated}
.clip-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.clip-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.clip-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.clip-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.clip-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.clip-layer:hover{background:#2d333b}
.clip-layer.sel{background:#303b49}
.clip-layer.off .clip-name,.clip-layer.off canvas{opacity:.45}
.clip-layer.folder .clip-name{font-weight:600}
.clip-eye{flex:none;width:22px;padding:0!important;text-align:center}
.clip-clip{flex:none;color:#adbac7;width:10px}
.clip-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.clip-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.clip-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.clip-tag.warn{color:#e3b341;border-color:#9e6a03}
.clip-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.clip-props input[type=range]{width:100%}
.clip-props .full{grid-column:1/-1}
.clip-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:170px;overflow:auto;border-top:1px solid #373e47}
.clip-info span:nth-child(odd){color:#adbac7}
.clip-info span:nth-child(even){overflow-wrap:anywhere}
.clip-message{padding:20px;color:#adbac7;text-align:center}
.clip-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.clip-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.clip-side{border-left:none;border-top:1px solid #444c56}}
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
        this._options(s, options, value);
        s.addEventListener('change', () => onChange(s.value));
        return s;
    }

    _options(s, options, value) {
        s.innerHTML = '';
        for (const [v, label] of options) s.appendChild(Object.assign(this._el('option', null, label), { value: v }));
        s.value = value;
    }

    _buildUI() {
        this.root.innerHTML = '';
        const shell = this._el('div', 'clip-shell');
        const bar = this._el('div', 'clip-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.clip';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'clip-title', this.fileName);
        this.sourceSel = this._select('The picture: the preview Clip Studio Paint stored, or the layers composited here',
            [['preview', 'As saved'], ['composited', 'Layers']], 'composited', v => this._showSource(v));
        this.levelSel = this._select('Resolution: the mipmap level the layers are composited at', [['0', '100%']], '0', v => {
            this.level = +v;
            this.source = 'composited';
            this.sourceSel.value = 'composited';
            this._render();
        });
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        const bg = this._select('Background', [['checker', 'Checker'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => { this.stage.className = 'clip-stage ' + v; });
        const reset = this._button('Reset', 'Undo all changes to layers: the picture as saved', () => {
            this.changes = {};
            this._renderLayers();
            this._showProps();
            if (this.preview && this.info.missing) this._showSource('preview'); else this._render();
        });
        const save = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(CLIP_RE, '') + '.png'));
        this.statusEl = this._el('span', 'clip-status');
        bar.append(this.fileInput, this._button('Open', 'Open a .clip from this computer', () => this.fileInput.click()), this.titleEl,
            this.sourceSel, this.levelSel, zoom, bg, reset, save, this.statusEl);

        const main = this._el('div', 'clip-main');
        this.stage = this._el('div', 'clip-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'clip-side');
        const head = this._el('h3', null, 'Layers');
        head.appendChild(this._button('All on', 'Show every layer', () => {
            for (const l of this.layers) this._set(l.id, 'visible', l.visible ? undefined : true);
            this._renderLayers();
            this._render();
        }));
        this.layersEl = this._el('div', 'clip-layers');
        this.propsEl = this._el('div', 'clip-props');
        this.infoEl = this._el('div', 'clip-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'clip-message', 'Open a Clip Studio Paint file (.clip).'));
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
            this.level = r.level;
            this._options(this.levelSel, r.info.levels.map(([w, h], k) => [String(k), `${100 / 2 ** k}% (${w} × ${h})`]), String(r.level));
            this.preview = null;
            if (r.preview) {
                try { this.preview = await createImageBitmap(new Blob([r.preview], { type: 'image/png' })); } catch (err) { log.warn('The stored preview did not decode:', err); }
            }
            if (gen !== this.generation) return;
            this.sourceSel.disabled = !this.preview;
            this.lastImage = r;
            // while a layer shows that isn't drawn here, the picture is Clip Studio Paint's
            if (this.preview && r.info.missing) this._showSource('preview', Math.round(performance.now() - t0));
            else { this.source = 'composited'; this.sourceSel.value = 'composited'; this._paint(r); this._status(Math.round(performance.now() - t0)); }
            this._renderLayers();
            this._showProps();
            this._renderInfo();
        } catch (err) {
            if (gen !== this.generation) return;
            log.error('Open failed:', err);
            this._error(`Could not open ${name}: ${err.message}`);
        }
    }

    // 'preview': the stored picture, drawn at the size of the level shown; 'composited': the layers
    _showSource(source, ms) {
        if (source === 'preview' && this.preview) {
            this.source = 'preview';
            this.sourceSel.value = 'preview';
            const [w, h] = this.info.levels[this.level] || [this.info.width, this.info.height];
            this.canvas.width = w;
            this.canvas.height = h;
            const g = this.canvas.getContext('2d');
            g.clearRect(0, 0, w, h);
            g.imageSmoothingQuality = 'high';
            g.drawImage(this.preview, 0, 0, w, h);
            this._shown();
            this._status(ms);
        } else {
            this.source = 'composited';
            this.sourceSel.value = 'composited';
            this._render();
        }
    }

    _paint(r) {
        this.canvas.width = r.width;
        this.canvas.height = r.height;
        this.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), r.width, r.height), 0, 0);
        this._shown();
    }

    _shown() {
        this.canvas.style.display = '';
        this.stage.querySelectorAll('.clip-message, .clip-error').forEach(e => e.remove());
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
        const what = this.source === 'preview'
            ? `Clip Studio Paint's preview (${i.preview ? `${i.preview[0]} × ${i.preview[1]}` : 'stored'})`
            : `composited here at ${100 / 2 ** this.level}%${i.missing ? `, without ${i.missing} layer${i.missing === 1 ? '' : 's'} not drawn` : ''}`;
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
        if (!this.ws || !this.info) return;
        this.source = 'composited';
        this.sourceSel.value = 'composited';
        if (this.rendering) { this.renderAgain = true; return; }
        this.rendering = true;
        const gen = this.generation;
        try {
            do {
                this.renderAgain = false;
                this.statusEl.textContent = 'Compositing…';
                const t0 = performance.now();
                const r = await this.ws.call('render', { changes: this.changes, level: this.level });
                if (gen !== this.generation) return;
                if (this.source !== 'composited') return;
                this._paint(r);
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
            const row = this._el('div', 'clip-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : '') + (l.folder ? ' folder' : ''));
            row.style.paddingLeft = (6 + 14 * l.depth) + 'px';
            const eye = this._button(visible ? '👁' : ' ', 'Show / hide (Shift+click: this layer alone)', e => {
                e.stopPropagation();
                if (e.shiftKey) {
                    // this layer alone: it, the folders it's in and what's in it
                    const keep = this._family(l);
                    for (const o of this.layers) this._set(o.id, 'visible', keep.has(o.id) === o.visible ? undefined : keep.has(o.id));
                } else this._set(l.id, 'visible', !visible === l.visible ? undefined : !visible);
                this._renderLayers();
                this._render();
            });
            eye.className = 'clip-eye';
            const clip = this._el('span', 'clip-clip', l.clip ? '↓' : '');
            if (l.clip) clip.title = 'Clipped to the layer below';
            const thumb = this._el('canvas');
            const t = this.thumbs && this.thumbs[l.id];
            if (t) {
                thumb.width = t.width;
                thumb.height = t.height;
                thumb.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
            }
            const name = this._el('span', 'clip-name', l.name || '(unnamed)');
            name.title = l.name;
            row.append(eye, clip, thumb, name);
            const kind = l.kind === 'correction' ? l.filter : KIND_NAMES[l.kind];
            if (kind) row.appendChild(this._el('span', 'clip-tag', kind));
            const mode = this._get(l, 'mode');
            if (mode !== '0') row.appendChild(this._el('span', 'clip-tag', this.modeNames.get(mode) || mode));
            if (this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'clip-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
            if (l.hasMask) {
                const m = this._el('span', 'clip-tag', this._get(l, 'maskOn') ? 'mask' : 'mask off');
                m.title = 'A layer mask';
                row.appendChild(m);
            }
            if (l.draft) row.appendChild(this._el('span', 'clip-tag', 'draft'));
            if (l.problem) {
                const w = this._el('span', 'clip-tag warn', /not applied/.test(l.problem) ? 'not applied' : 'not drawn');
                w.title = l.problem;
                row.appendChild(w);
            }
            if (l.note) {
                const n = this._el('span', 'clip-tag', 'approximate');
                n.title = l.note;
                row.appendChild(n);
            }
            row.addEventListener('click', () => { this.selected = l.id; this._renderLayers(); this._showProps(); });
            this.layersEl.appendChild(row);
        }
    }

    // A layer's ids with its folders' and everything in it
    _family(l) {
        const keep = new Set([l.id]);
        for (let p = l.parent; p !== null && p !== undefined && this.byId.has(p); p = this.byId.get(p).parent) keep.add(p);
        const at = this.layers.indexOf(l);
        for (let i = at + 1; i < this.layers.length && this.layers[i].depth > l.depth; i++) keep.add(this.layers[i].id);
        return keep;
    }

    _showProps() {
        this.propsEl.innerHTML = '';
        const l = this.byId && this.byId.get(this.selected);
        if (!l) {
            this.propsEl.appendChild(this._el('span', 'full', 'Select a layer to change it.')).style.color = '#adbac7';
            return;
        }
        const check = (key) => {
            const c = this._el('input');
            c.type = 'checkbox';
            c.checked = this._get(l, key);
            c.addEventListener('change', () => { this._set(l.id, key, c.checked === l[key] ? undefined : c.checked); this._renderLayers(); this._render(); });
            return c;
        };
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
        const modes = this.info.modes.filter(([v]) => v !== '30' || l.folder);
        const mode = this._select('Blending mode', modes, this._get(l, 'mode'), v => {
            this._set(l.id, 'mode', v === l.mode ? undefined : v);
            this._renderLayers();
            this._render();
        });
        const facts = [`${l.kind === 'correction' ? `${l.filter} correction` : (KIND_NAMES[l.kind] || 'raster')} layer`,
            l.clip ? 'clipped to the layer below' : '', l.draft ? 'draft (not exported by Clip Studio Paint)' : '',
            l.colorType === 1 ? 'grey' : l.colorType === 2 ? 'monochrome' : '',
            l.layerColor ? `layer colour #${l.layerColor.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}` : '',
            l.problem, l.note].filter(Boolean);
        const details = this._el('span', 'full', facts.join(' · '));
        details.style.color = '#adbac7';
        const save = this._button('Save layer as PNG', 'This layer alone, at full opacity, its mask applied, at the resolution shown', async () => {
            const r = await this.ws.call('layer', { layerId: l.id, level: this.level });
            const c = document.createElement('canvas');
            c.width = r.width;
            c.height = r.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), r.width, r.height), 0, 0);
            this._savePng(c, `${this.fileName.replace(CLIP_RE, '')}-${(l.name || 'layer').replace(/[^\w.-]+/g, '_')}.png`);
        });
        save.classList.add('full');
        this.propsEl.append(this._el('b', 'full', l.name), this._el('span', null, 'Visible'), check('visible'), opLabel, op, this._el('span', null, 'Mode'), mode);
        if (l.hasMask) this.propsEl.append(this._el('span', null, 'Mask'), check('maskOn'));
        this.propsEl.append(details, save);
    }

    _renderInfo() {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const notDrawn = this.layers.filter(l => l.problem && l.visible).map(l => l.name || '(unnamed)');
        const rows = [
            ['Size', `${i.width} × ${i.height} px${i.size ? ` (${i.size})` : ''}`],
            ['Resolution', i.resolution ? `${+i.resolution.toFixed(2)} dpi` : ''],
            ['Levels', i.levels.map((_, k) => `${100 / 2 ** k}%`).join(', ')],
            ['Preview', i.preview ? `${i.preview[0]} × ${i.preview[1]} PNG` : 'none'],
            ['Format', i.version],
            ['Not drawn', notDrawn.length ? notDrawn.join(', ') : ''],
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
        this.stage.querySelectorAll('.clip-message, .clip-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'clip-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
        if (this.preview && this.preview.close) this.preview.close();
    }
}

// File browser thumbnails: the preview Clip Studio Paint stored
let _ctx = null;
const clipThumbnails = {
    canHandle(file) {
        return file.type === 'file' && CLIP_RE.test(file.name);
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await clipPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
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
    id: 'clip',
    name: 'Clip Studio Paint files',
    components: {
        clipViewer: ClipComponent,
    },
    toolbarButtons: [
        { label: 'CLIP', title: 'Open the Clip Studio Paint viewer', menuLabel: 'Clip Studio Paint file (.clip) with layers' },
    ],
    thumbnailRenderers: [clipThumbnails],
    init(ctx) {
        ClipComponent._ctx = ctx;
        _ctx = ctx;
    },
});
