// --- PaintTool SAI documents (.sai, .sai2) ---
// The picture with its layers: show or hide each (Shift+click an eye: that layer
// alone, with its folders and what's in it), turn a mask on or off, change a
// layer's opacity or blend mode, and the layers are composited again. Reading and
// compositing happen in a worker (public/sai-worker.js; a .sai's file system is
// public/sai-vfs.js). A .sai2 keeps the picture as SAI composited it: that is
// what's shown until a layer is changed or "Layers" is picked. Changes aren't
// saved. Thumbnails in the file browser are the ones the files keep (a .sai2
// without one: its picture), read with Range requests.
//
// .sai is also BWA's alignment indexes' and SAIL programs' name: one is opened
// here only if its first page deciphers as PaintTool SAI's (sniffed in the
// listings, see SAI_MAYBE_RE in ws-handler.js).
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { isSai } = require('../public/sai-vfs.js');

const log = createLogger('SAI');
const WORKER_URL = '/sai-worker.js';
const SAI_RE = /\.sai2?$/i;
const TYPE_NAMES = { folder: 'folder', layer: '', mask: 'mask', linework: 'linework', text: 'text', shape: 'shape' };

function isSai2(bytes) {
    return bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 16)) === 'SAI-CANVAS-TYPE0';
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
        for (const p of pending.values()) p.reject(new Error(e.message || 'the SAI reader failed'));
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

// A picture the worker sent (RGBA) as a PNG, or the JPEG a .sai2 keeps, as a blob URL
function pictureUrl(r) {
    if (!r) return Promise.resolve(null);
    if (r.jpeg) return Promise.resolve(URL.createObjectURL(new Blob([r.jpeg], { type: 'image/jpeg' })));
    const c = document.createElement('canvas');
    c.width = r.width;
    c.height = r.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), r.width, r.height), 0, 0);
    return new Promise(resolve => c.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/png'));
}

// --- The stored thumbnail, for the file browser: the worker reads only what it needs ---

let thumbWorker = null;
const previews = new Map(); // url -> Promise<blob URL | null>
function saiPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        if (!thumbWorker) thumbWorker = startWorker();
        p = thumbWorker.call('thumbnail', { url: new URL(url, location.href).href, max: 256 }).then(pictureUrl);
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('SAI thumbnail failed:', err); });
        if (previews.size > 64) {
            // the oldest goes; its URL a while later, so a thumbnail still loading from it (a big
            // folder's first files, the slowest) isn't left blank
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && setTimeout(() => URL.revokeObjectURL(u), 60000)).catch(() => {});
        }
    }
    return p;
}

// --- The viewer ---

class SaiComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = SaiComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'picture.sai';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.selected = null;
        this.zoom = 'fit';
        this.source = 'layers'; // or 'saved': the picture a .sai2 keeps
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.root = container.element;
        this.root.classList.add('sai-root');
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
        if (SaiComponent._styleInstalled) return;
        SaiComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.sai-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.sai-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.sai-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.sai-root button,.sai-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.sai-root button:hover{background:#444c56}
.sai-root select:disabled{opacity:.5;cursor:default}
.sai-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sai-status{color:#adbac7;margin-left:auto}
.sai-main{display:grid;grid-template-columns:1fr 290px;min-height:0}
.sai-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.sai-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.sai-stage.dark{background:#111}.sai-stage.light{background:#fff}.sai-stage.paper{background:#2a2e34}
.sai-stage canvas{flex:none}
.sai-stage canvas.pixelated{image-rendering:pixelated}
.sai-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.sai-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.sai-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.sai-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.sai-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.sai-layer:hover{background:#2d333b}
.sai-layer.sel{background:#303b49}
.sai-layer.off .sai-name,.sai-layer.off canvas{opacity:.45}
.sai-layer.folder .sai-name{font-weight:600}
.sai-layer.mask .sai-name{font-style:italic}
.sai-eye{flex:none;width:22px;padding:0!important;text-align:center}
.sai-clip{flex:none;color:#adbac7;width:10px}
.sai-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.sai-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sai-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.sai-tag.warn{color:#e3b341;border-color:#9e6a03}
.sai-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.sai-props input[type=range]{width:100%}
.sai-props .full{grid-column:1/-1}
.sai-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:170px;overflow:auto;border-top:1px solid #373e47}
.sai-info span:nth-child(odd){color:#adbac7}
.sai-info span:nth-child(even){overflow-wrap:anywhere}
.sai-info img,.sai-info canvas{max-width:120px;max-height:90px;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.sai-message{padding:20px;color:#adbac7;text-align:center}
.sai-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.sai-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.sai-side{border-left:none;border-top:1px solid #444c56}}
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
        const shell = this._el('div', 'sai-shell');
        const bar = this._el('div', 'sai-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.sai,.sai2';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'sai-title', this.fileName);
        this.sourceSel = this._select('The picture: as PaintTool SAI saved it (a .sai2 keeps it), or the layers composited here',
            [['saved', 'As saved'], ['layers', 'Layers']], 'layers', v => { this.source = v; this._render(); });
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        this.bgSel = this._select('Background: the paper (white, or the colour a .sai2 sets), or the picture transparent', [['checker', 'Checker'], ['paper', 'Paper'], ['dark', 'Dark'], ['light', 'Light']],
            'checker', v => this._background(v));
        const reset = this._button('Reset', 'Undo all changes to layers: the picture as saved', () => {
            this.changes = {};
            if (this.info && this.info.savedPicture) this.source = 'saved';
            this._renderLayers();
            this._showProps();
            this._render();
        });
        const save = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(SAI_RE, '') + '.png'));
        this.statusEl = this._el('span', 'sai-status');
        bar.append(this.fileInput, this._button('Open', 'Open a .sai or .sai2 from this computer', () => this.fileInput.click()), this.titleEl,
            this.sourceSel, zoom, this.bgSel, reset, save, this.statusEl);

        const main = this._el('div', 'sai-main');
        this.stage = this._el('div', 'sai-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'sai-side');
        const head = this._el('h3', null, 'Layers');
        head.appendChild(this._button('All on', 'Show every layer', () => {
            for (const l of this.layers) if (!l.mask) this._set(l.id, 'visible', l.visible ? undefined : true);
            this._changed();
        }));
        this.layersEl = this._el('div', 'sai-layers');
        this.propsEl = this._el('div', 'sai-props');
        this.infoEl = this._el('div', 'sai-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'sai-message', 'Open a PaintTool SAI document (.sai, .sai2).'));
        this.canvas.style.display = 'none';
    }

    // 'paper': the layers on the paper; the others: transparent, on a checkerboard, dark or light
    _background(v) {
        this.bgSel.value = v;
        this.stage.className = 'sai-stage ' + v;
        const paper = v === 'paper';
        if (this.info && paper !== this.paper) {
            this.paper = paper;
            // the saved picture has the paper in it or not; the layers can go either way
            if (this.source === 'saved' && paper !== this.info.paper) this.source = 'layers';
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
        const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
        if (!isSai2(head) && !isSai(head)) {
            this._error(`${name} isn't a PaintTool SAI document (its first page doesn't decipher as one).`);
            return;
        }
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
            this.paper = r.info.paper;
            this.source = r.info.savedPicture ? 'saved' : 'layers';
            this.sourceSel.disabled = !r.info.savedPicture;
            this.sourceSel.value = this.source;
            this._background(this.paper ? 'paper' : 'checker');
            this._paint(r.image);
            this._renderLayers();
            this._showProps();
            this._renderInfo(r.stored);
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
        this.stage.querySelectorAll('.sai-message, .sai-error').forEach(e => e.remove());
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
        const changed = Object.keys(this.changes).length;
        const notDrawn = this.layers.filter(l => l.problem && /not drawn/.test(l.problem) && this._get(l, 'visible')).length;
        const what = this.source === 'saved' ? 'as PaintTool SAI saved it'
            : `composited here${notDrawn ? `, without ${notDrawn} layer${notDrawn === 1 ? '' : 's'} not drawn` : ''}`;
        const n = this.layers.filter(l => !l.mask).length;
        this.statusEl.textContent = `${i.width} × ${i.height} · ${n} layer${n === 1 ? '' : 's'} · ${what}`
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

    // A layer changed: the picture is the layers' from now on
    _changed() {
        this.source = 'layers';
        this._renderLayers();
        this._render();
    }

    // Recomposite in the worker (or show the saved picture); while one runs, changes made meanwhile wait for the next
    async _render() {
        if (!this.ws || !this.info) return;
        this.sourceSel.value = this.source;
        if (this.rendering) { this.renderAgain = true; return; }
        this.rendering = true;
        const gen = this.generation;
        try {
            do {
                this.renderAgain = false;
                this.statusEl.textContent = 'Compositing…';
                const t0 = performance.now();
                const r = await this.ws.call('render', { changes: this.changes, paper: this.paper, saved: this.source === 'saved' });
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
            // a mask's eye turns it on or off
            const key = l.mask ? 'maskOn' : 'visible';
            const visible = this._get(l, key);
            const row = this._el('div', 'sai-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : '') + (l.folder ? ' folder' : '') + (l.mask ? ' mask' : ''));
            row.style.paddingLeft = (6 + 14 * l.depth) + 'px';
            const eye = this._button(visible ? '👁' : ' ', l.mask ? 'Mask on / off' : 'Show / hide (Shift+click: this layer alone)', e => {
                e.stopPropagation();
                if (e.shiftKey && !l.mask) {
                    // this layer alone: it, the folders it's in and what's in it
                    const keep = this._family(l);
                    for (const o of this.layers) if (!o.mask) this._set(o.id, 'visible', keep.has(o.id) === o.visible ? undefined : keep.has(o.id));
                } else this._set(l.id, key, !visible === l[key] ? undefined : !visible);
                this._changed();
            });
            eye.className = 'sai-eye';
            const clip = this._el('span', 'sai-clip', l.clipping ? '↓' : '');
            if (l.clipping) clip.title = 'Clipped to the layer below';
            const thumb = this._el('canvas');
            const t = this.thumbs && this.thumbs[l.id];
            if (t) {
                thumb.width = t.width;
                thumb.height = t.height;
                thumb.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
            }
            const name = this._el('span', 'sai-name', l.name || '(unnamed)');
            name.title = l.name;
            row.append(eye, clip, thumb, name);
            const kind = TYPE_NAMES[l.type] ?? l.type;
            if (kind) row.appendChild(this._el('span', 'sai-tag', l.mask && !this._get(l, 'maskOn') ? 'mask off' : kind));
            const mode = this._get(l, 'mode');
            if (mode !== 'normal' && !l.mask) row.appendChild(this._el('span', 'sai-tag', this.modeNames.get(mode) || mode));
            if (this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'sai-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
            if (l.threshold !== undefined) row.appendChild(this._el('span', 'sai-tag', `binary ${l.threshold}%`));
            if (l.protectAlpha) row.appendChild(this._el('span', 'sai-tag', 'preserve opacity'));
            if (l.problem) {
                const w = this._el('span', 'sai-tag warn', /not drawn/.test(l.problem) ? 'not drawn' : /not applied/.test(l.problem) ? 'not applied' : 'approximate');
                w.title = l.problem;
                row.appendChild(w);
            }
            row.addEventListener('click', () => { this.selected = l.id; this._renderLayers(); this._showProps(); });
            this.layersEl.appendChild(row);
        }
    }

    // A layer's ids with its folders' and everything in it
    _family(l) {
        const keep = new Set([l.id]);
        for (let p = l.parent; p !== -1 && this.byId.has(p); p = this.byId.get(p).parent) keep.add(p);
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
            c.addEventListener('change', () => { this._set(l.id, key, c.checked === l[key] ? undefined : c.checked); this._changed(); });
            return c;
        };
        const facts = [l.folder ? 'folder' : l.mask ? `mask of the layer above${l.maskLinked ? ', moves with it' : ''}` : `${l.type} layer`,
            l.clipping ? 'clipped to the layer below' : '', l.protectAlpha ? 'preserve opacity' : '',
            l.threshold !== undefined ? `binary colour, threshold ${l.threshold}%` : '',
            l.texture ? `paper texture “${l.texture}”${l.textureScale ? `, scale ${l.textureScale}%` : ''}${l.textureStrength ? `, strength ${l.textureStrength}` : ''}` : '',
            l.fringe ? `watercolour edge, width ${l.fringe.width}, ${l.fringe.opacity}%` : '', l.problem].filter(Boolean);
        const details = this._el('span', 'full', facts.join(' · '));
        details.style.color = '#adbac7';
        const save = this._button('Save layer as PNG', 'This layer alone, at full opacity', async () => {
            const r = await this.ws.call('layer', { layerId: l.id });
            const c = document.createElement('canvas');
            c.width = this.info.width;
            c.height = this.info.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), c.width, c.height), 0, 0);
            this._savePng(c, `${this.fileName.replace(SAI_RE, '')}-${(l.name || 'layer').replace(/[^\w.-]+/g, '_')}.png`);
        });
        save.classList.add('full');
        this.propsEl.append(this._el('b', 'full', l.name || '(unnamed)'));
        if (l.mask) this.propsEl.append(this._el('span', null, 'On'), check('maskOn'));
        else {
            const op = this._el('input');
            op.type = 'range'; op.min = 0; op.max = 100; op.step = 1;
            op.value = Math.round(this._get(l, 'opacity') * 100);
            const opLabel = this._el('span', null, `Opacity ${op.value}%`);
            op.addEventListener('input', () => {
                opLabel.textContent = `Opacity ${op.value}%`;
                const v = op.value / 100;
                this._set(l.id, 'opacity', Math.abs(v - l.opacity) < 0.005 ? undefined : v);
                this.source = 'layers';
                this._render();
            });
            op.addEventListener('change', () => this._renderLayers());
            // pass through is a folder's
            const modes = this.info.modes.filter(([v]) => v !== 'through' || l.folder);
            const mode = this._select('Blend mode', modes, this._get(l, 'mode'), v => {
                this._set(l.id, 'mode', v === l.mode ? undefined : v);
                this._changed();
            });
            this.propsEl.append(this._el('span', null, 'Visible'), check('visible'), opLabel, op, this._el('span', null, 'Mode'), mode);
        }
        this.propsEl.append(details, save);
    }

    _renderInfo(stored) {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const hex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
        const rows = [
            ['Size', `${i.width} × ${i.height} px${i.dpi ? ` (${(i.width / i.dpi * 2.54).toFixed(1)} × ${(i.height / i.dpi * 2.54).toFixed(1)} cm)` : ''}`],
            ['Resolution', i.dpi ? `${i.dpi} dpi` : ''],
            ['Paper', i.paper ? `opaque, ${hex(i.paperColor)}` : 'transparent'],
            ['Format', i.format === 'sai2' ? 'PaintTool SAI Ver.2 (.sai2)' : 'PaintTool SAI (.sai)'],
            ['Saved', i.saved],
            ['Saved picture', i.format === 'sai2' ? (i.savedPicture ? 'kept in the file' : 'none') : ''],
        ];
        for (const [k, v] of rows) if (v) this.infoEl.append(this._el('span', null, k), this._el('span', null, String(v)));
        if (stored) {
            const label = this._el('span', null, stored.jpeg ? 'Thumbnail (JPEG)' : `Thumbnail ${stored.width} × ${stored.height}`);
            const img = this._el('img');
            img.alt = '';
            img.title = 'The thumbnail the file keeps';
            pictureUrl(stored.jpeg ? stored : { image: stored.data, width: stored.width, height: stored.height }).then(u => { if (u) img.src = u; });
            this.infoEl.append(label, img);
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
        this.stage.querySelectorAll('.sai-message, .sai-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'sai-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
    }
}

// File browser thumbnails: the ones the files keep
let _ctx = null;
const saiThumbnails = {
    canHandle(file) {
        // (a .sai read as text is a SAIL program; browse mode hasn't read any yet: its content is '')
        return file.type === 'file' && SAI_RE.test(file.name) && !file.content;
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await saiPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
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
    id: 'sai',
    name: 'PaintTool SAI documents',
    components: {
        saiViewer: SaiComponent,
    },
    toolbarButtons: [
        { label: 'SAI', title: 'Open the PaintTool SAI viewer', menuLabel: 'PaintTool SAI document (.sai, .sai2) with layers' },
    ],
    thumbnailRenderers: [saiThumbnails],
    init(ctx) {
        SaiComponent._ctx = ctx;
        _ctx = ctx;
    },
});

module.exports = { isSai };
