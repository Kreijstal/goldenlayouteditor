// --- Corel PHOTO-PAINT images (.cpt) ---
// The picture as PHOTO-PAINT composites it, with its objects: show or hide each
// (Shift+click an eye: that object alone with the background), change an object's
// opacity or merge mode, turn its clip mask off; a mask or saved channel can be
// shown, cutting the picture to it. Reading and compositing happen in a worker
// (public/cpt-worker.js). Changes aren't saved. Thumbnails in the file browser are
// the one the file keeps, read by itself with Range requests (without one: the
// picture, shrunk).
//
// Files from PHOTO-PAINT 7 on ("CPT7FILE", "CPT8FILE", "CPT9FILE") and PHOTO-PAINT 6's
// (a TIFF). .cpt is also Compact Pro archives' and others' name: one is opened here
// only if it starts with one of those (sniffed in the listings, see CPT_MAYBE_RE in
// ws-handler.js).
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('CPT');
const WORKER_URL = '/cpt-worker.js';
const CPT_RE = /\.cpt$/i;

// "CPT7FILE", "CPT8FILE", "CPT9FILE", or a TIFF (PHOTO-PAINT 6's)
function isCpt(bytes) {
    if (bytes.length < 8) return false;
    const head = String.fromCharCode(...bytes.subarray(0, 8));
    return /^CPT[789]FILE$/.test(head) || head.startsWith('II*\0') || head.startsWith('MM\0*');
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
        for (const p of pending.values()) p.reject(new Error(e.message || 'the CPT reader failed'));
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

function pictureUrl(r) {
    if (!r) return null;
    const c = document.createElement('canvas');
    c.width = r.width;
    c.height = r.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), r.width, r.height), 0, 0);
    return new Promise(resolve => c.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/png'));
}

// --- The stored thumbnail, for the file browser: the worker reads only its block ---

let thumbWorker = null;
const previews = new Map(); // url -> Promise<blob URL | null>
function cptPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        if (!thumbWorker) thumbWorker = startWorker();
        p = thumbWorker.call('thumbnail', { url: new URL(url, location.href).href, max: 256 }).then(pictureUrl);
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('CPT thumbnail failed:', err); });
        if (previews.size > 64) {
            // the oldest goes; its URL a while later, so a thumbnail still loading from it isn't left blank
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && setTimeout(() => URL.revokeObjectURL(u), 60000)).catch(() => {});
        }
    }
    return p;
}

// --- The viewer ---

class CptComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = CptComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'picture.cpt';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.selected = null;
        this.zoom = 'fit';
        this.paper = false;
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.root = container.element;
        this.root.classList.add('cpt-root');
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
        if (CptComponent._styleInstalled) return;
        CptComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.cpt-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.cpt-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.cpt-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.cpt-root button,.cpt-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.cpt-root button:hover{background:#444c56}
.cpt-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpt-status{color:#adbac7;margin-left:auto}
.cpt-main{display:grid;grid-template-columns:1fr 290px;min-height:0}
.cpt-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.cpt-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.cpt-stage.dark{background:#111}.cpt-stage.light{background:#fff}.cpt-stage.paper{background:#2a2e34}
.cpt-stage canvas{flex:none}
.cpt-stage canvas.pixelated{image-rendering:pixelated}
.cpt-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.cpt-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.cpt-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.cpt-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.cpt-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.cpt-layer:hover{background:#2d333b}
.cpt-layer.sel{background:#303b49}
.cpt-layer.off .cpt-name,.cpt-layer.off canvas{opacity:.45}
.cpt-layer.grouped{border-left:2px solid #6cb6ff}
.cpt-sep{padding:4px 8px 2px;font-size:10px;text-transform:uppercase;color:#768390}
.cpt-eye{flex:none;width:22px;padding:0!important;text-align:center}
.cpt-clip{flex:none;color:#adbac7;width:10px}
.cpt-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.cpt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.cpt-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.cpt-tag.warn{color:#e3b341;border-color:#9e6a03}
.cpt-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.cpt-props input[type=range]{width:100%}
.cpt-props .full{grid-column:1/-1}
.cpt-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:170px;overflow:auto;border-top:1px solid #373e47}
.cpt-info span:nth-child(odd){color:#adbac7}
.cpt-info span:nth-child(even){overflow-wrap:anywhere}
.cpt-info canvas{max-width:120px;max-height:90px;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.cpt-message{padding:20px;color:#adbac7;text-align:center}
.cpt-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.cpt-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.cpt-side{border-left:none;border-top:1px solid #444c56}}
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
        const shell = this._el('div', 'cpt-shell');
        const bar = this._el('div', 'cpt-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.cpt';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'cpt-title', this.fileName);
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        this.bgSel = this._select('Background: transparent where there is no background (on a checkerboard, dark or light), or on white paper as PHOTO-PAINT flattens it',
            [['checker', 'Checker'], ['paper', 'Paper'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => this._background(v));
        const reset = this._button('Reset', 'Undo all changes to objects: the picture as saved', () => { this.changes = {}; this._renderLayers(); this._showProps(); this._render(); });
        const save = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(CPT_RE, '') + '.png'));
        this.statusEl = this._el('span', 'cpt-status');
        bar.append(this.fileInput, this._button('Open', 'Open a .cpt from this computer', () => this.fileInput.click()), this.titleEl, zoom, this.bgSel, reset, save, this.statusEl);

        const main = this._el('div', 'cpt-main');
        this.stage = this._el('div', 'cpt-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'cpt-side');
        const head = this._el('h3', null, 'Objects');
        head.appendChild(this._button('All on', 'Show every object', () => {
            for (const l of this.layers) if (l.kind !== 'mask') this._set(l.id, 'visible', l.visible ? undefined : true);
            this._renderLayers();
            this._render();
        }));
        this.layersEl = this._el('div', 'cpt-layers');
        this.propsEl = this._el('div', 'cpt-props');
        this.infoEl = this._el('div', 'cpt-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'cpt-message', 'Open a Corel PHOTO-PAINT image (.cpt).'));
        this.canvas.style.display = 'none';
    }

    // 'paper': the picture flattened on white, as PHOTO-PAINT exports one without a background
    _background(v) {
        this.bgSel.value = v;
        this.stage.className = 'cpt-stage ' + v;
        const paper = v === 'paper';
        if (this.info && paper !== this.paper) {
            this.paper = paper;
            this._render();
        }
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
        this.statusEl.textContent = 'Reading objects…';
        try {
            const t0 = performance.now();
            const r = await this.ws.call('open', { bytes: buffer }, [buffer]);
            if (gen !== this.generation) return;
            this.info = r.info;
            this.layers = r.layers;
            this.thumbs = r.thumbs;
            this.stored = r.stored;
            this.byId = new Map(this.layers.map(l => [l.id, l]));
            this.modeNames = new Map(r.info.modes);
            this.paper = false;
            this._background('checker');
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
        this.stage.querySelectorAll('.cpt-message, .cpt-error').forEach(e => e.remove());
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

    _status(ms) {
        const i = this.info;
        const objects = this.layers.filter(l => l.kind === 'object').length;
        const changed = Object.keys(this.changes).length;
        this.statusEl.textContent = `${i.width} × ${i.height} · ${objects} object${objects === 1 ? '' : 's'}`
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
        if (this.rendering) { this.renderAgain = true; return; }
        this.rendering = true;
        const gen = this.generation;
        try {
            do {
                this.renderAgain = false;
                this.statusEl.textContent = 'Compositing…';
                const t0 = performance.now();
                const r = await this.ws.call('render', { changes: this.changes, paper: this.paper });
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

    // Top first, as PHOTO-PAINT's Objects docker lists them; masks and channels after
    _renderLayers() {
        this.layersEl.innerHTML = '';
        const pictures = this.layers.filter(l => l.kind !== 'mask').reverse(), masks = this.layers.filter(l => l.kind === 'mask');
        for (const l of pictures) this.layersEl.appendChild(this._row(l));
        if (masks.length) {
            this.layersEl.appendChild(this._el('div', 'cpt-sep', 'Masks and channels'));
            for (const l of masks) this.layersEl.appendChild(this._row(l));
        }
    }

    _row(l) {
        const visible = this._get(l, 'visible');
        const row = this._el('div', 'cpt-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : '') + (l.grouped ? ' grouped' : ''));
        if (l.grouped) row.title = 'In a group';
        const eye = this._button(visible ? '👁' : ' ', l.kind === 'mask' ? 'Cut the picture to this mask' : 'Show / hide (Shift+click: this object alone, on the background)', e => {
            e.stopPropagation();
            if (e.shiftKey && l.kind !== 'mask') {
                for (const o of this.layers) {
                    if (o.kind === 'mask') continue;
                    const keep = o.id === l.id || o.kind === 'background';
                    this._set(o.id, 'visible', keep === o.visible ? undefined : keep);
                }
            } else this._set(l.id, 'visible', !visible === l.visible ? undefined : !visible);
            this._renderLayers();
            this._render();
        });
        eye.className = 'cpt-eye';
        const clip = this._el('span', 'cpt-clip', l.clipToParent ? '↓' : '');
        if (l.clipToParent) clip.title = 'Clipped to the object below';
        const thumb = this._el('canvas');
        const t = this.thumbs && this.thumbs[l.id];
        if (t) {
            thumb.width = t.width;
            thumb.height = t.height;
            thumb.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
        }
        const name = this._el('span', 'cpt-name', l.name || '(unnamed)');
        name.title = l.name;
        row.append(eye, clip, thumb, name);
        if (l.kind === 'mask') row.appendChild(this._el('span', 'cpt-tag', 'mask'));
        if (l.text) row.appendChild(this._el('span', 'cpt-tag', 'text'));
        if (l.hasClip) {
            const on = this._get(l, 'clipOn');
            const tag = this._el('span', 'cpt-tag', on ? 'clip mask' : 'clip mask off');
            tag.title = 'Its clip mask: what of it shows';
            row.appendChild(tag);
        }
        const mode = this._get(l, 'mode');
        if (l.kind === 'object' && mode !== 'normal') row.appendChild(this._el('span', 'cpt-tag', this.modeNames.get(mode) || mode));
        if (l.kind === 'object' && this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'cpt-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
        if (l.problem) {
            const w = this._el('span', 'cpt-tag warn', /Normal|isn't drawn/.test(l.problem) ? 'not applied' : 'approximate');
            w.title = l.problem;
            row.appendChild(w);
        }
        row.addEventListener('click', () => { this.selected = l.id; this._renderLayers(); this._showProps(); });
        return row;
    }

    _showProps() {
        this.propsEl.innerHTML = '';
        const l = this.byId && this.byId.get(this.selected);
        if (!l) {
            this.propsEl.appendChild(this._el('span', 'full', 'Select an object to change it.')).style.color = '#adbac7';
            return;
        }
        const vis = this._el('input');
        vis.type = 'checkbox';
        vis.checked = this._get(l, 'visible');
        vis.addEventListener('change', () => { this._set(l.id, 'visible', vis.checked === l.visible ? undefined : vis.checked); this._renderLayers(); this._render(); });
        const items = [this._el('b', 'full', l.name), this._el('span', null, l.kind === 'mask' ? 'Cut to it' : 'Visible'), vis];
        if (l.kind === 'object') {
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
            const mode = this._select('Merge mode', this.info.modes, this._get(l, 'mode'), v => {
                this._set(l.id, 'mode', v === l.mode ? undefined : v);
                this._renderLayers();
                this._render();
            });
            items.push(opLabel, op, this._el('span', null, 'Merge'), mode);
            if (l.hasClip) {
                const cm = this._el('input');
                cm.type = 'checkbox';
                cm.checked = this._get(l, 'clipOn');
                cm.addEventListener('change', () => { this._set(l.id, 'clipOn', cm.checked === l.clipOn ? undefined : cm.checked); this._renderLayers(); this._render(); });
                items.push(this._el('span', null, 'Clip mask'), cm);
            }
        }
        const facts = [l.kind === 'background' ? 'the background' : l.kind === 'mask' ? 'a mask or saved channel (not part of the picture)' : 'object',
            l.kind === 'object' ? `${l.width} × ${l.height} at ${l.left}, ${l.top}` : '',
            l.clipToParent ? 'clipped to the object below' : '', l.grouped ? 'in a group' : '', l.text ? 'text (as PHOTO-PAINT rendered it)' : '',
            l.problem].filter(Boolean);
        const details = this._el('span', 'full', facts.join(' · '));
        details.style.color = '#adbac7';
        const save = this._button('Save as PNG', 'This object (or mask) alone, at full opacity, where it is in the picture', async () => {
            const r = await this.ws.call('layer', { layerId: l.id });
            const c = document.createElement('canvas');
            c.width = this.info.width;
            c.height = this.info.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), c.width, c.height), 0, 0);
            this._savePng(c, `${this.fileName.replace(CPT_RE, '')}-${(l.name || 'object').replace(/[^\w.-]+/g, '_')}.png`);
        });
        save.classList.add('full');
        this.propsEl.append(...items, details, save);
    }

    _renderInfo() {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const rows = [
            ['Size', `${i.width} × ${i.height} px${i.dpi ? ` (${(i.width / i.dpi * 2.54).toFixed(1)} × ${(i.height / i.dpi * 2.54).toFixed(1)} cm)` : ''}`],
            ['Resolution', i.dpi ? (i.dpiV && i.dpiV !== i.dpi ? `${i.dpi} × ${i.dpiV} dpi` : `${i.dpi} dpi`) : ''],
            ['Colour', i.model],
            ['Format', i.format],
            ['Comment', i.comment],
        ];
        for (const [k, v] of rows) if (v) this.infoEl.append(this._el('span', null, k), this._el('span', null, String(v)));
        if (this.stored) {
            const c = this._el('canvas');
            c.width = this.stored.width;
            c.height = this.stored.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(this.stored.data), c.width, c.height), 0, 0);
            c.title = 'The thumbnail the file keeps';
            this.infoEl.append(this._el('span', null, `Thumbnail ${c.width} × ${c.height}`), c);
        }
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
        this.stage.querySelectorAll('.cpt-message, .cpt-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'cpt-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
    }
}

// File browser thumbnails: the one the file keeps (or the picture, shrunk)
let _ctx = null;
const cptThumbnails = {
    canHandle(file) {
        // (a .cpt read as text isn't PHOTO-PAINT's; browse mode hasn't read any yet: its content is '')
        return file.type === 'file' && CPT_RE.test(file.name) && !file.content;
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await cptPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
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
    id: 'cpt',
    name: 'Corel PHOTO-PAINT images',
    components: {
        cptViewer: CptComponent,
    },
    toolbarButtons: [
        { label: 'CPT', title: 'Open the Corel PHOTO-PAINT viewer', menuLabel: 'Corel PHOTO-PAINT image (.cpt) with objects' },
    ],
    thumbnailRenderers: [cptThumbnails],
    init(ctx) {
        CptComponent._ctx = ctx;
        _ctx = ctx;
    },
});

module.exports = { isCpt };
