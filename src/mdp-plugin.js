// --- MediBang Paint / FireAlpaca files (.mdp) ---
// The picture as FireAlpaca composites it, with its layers: show or hide each
// (Shift+click an eye: that layer alone, with its folders and what's in it),
// change a layer's opacity or blend mode, and the layers are composited again.
// Reading and compositing happen in a worker (public/mdp-worker.js). Changes
// aren't saved. Thumbnails in the file browser are the one the file keeps (BGRA,
// zlib'd, right after the XML), read by itself.
//
// .mdp is also Microsoft Developer Studio's projects', GROMACS' parameter files'
// and MicroDesign's pages' name: one is opened here only if it starts "mdipack"
// (sniffed in the listings, see MDP_MAYBE_RE in ws-handler.js).
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('MDP');
const WORKER_URL = '/mdp-worker.js';
const MDP_RE = /\.mdp$/i;
const SIGNATURE = 'mdipack\0';
const TYPE_NAMES = { folder: 'folder', '32bpp': '', '8bpp': '8 bit', '1bpp': '1 bit', text: 'text' };
const HALFTONE_NAMES = { dots: 'halftone', xline: 'h. lines', yline: 'v. lines' };

function isMdp(bytes) {
    return bytes.length >= 8 && String.fromCharCode(...bytes.subarray(0, 8)) === SIGNATURE;
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
        for (const p of pending.values()) p.reject(new Error(e.message || 'the MDP reader failed'));
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

// --- The stored thumbnail, fetching only the start of the file ---

async function fetchRange(url, start, end) {
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // a server that ignores Range sends the whole file
    return resp.status === 206 ? bytes : bytes.subarray(start, end + 1);
}

async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// "mdipack\0", version, the XML's size and the binary part's; the XML's <Thumb width height bin>;
// then "PAC " entries, the thumbnail's usually first: BGRA rows, stored or zlib'd
async function mdpThumbnail(url) {
    let head = await fetchRange(url, 0, 65535);
    if (!isMdp(head)) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const mdiSize = dv.getUint32(12, true);
    if (head.length < 20 + mdiSize + 132) head = await fetchRange(url, 0, 20 + mdiSize + 132 - 1);
    const xml = new TextDecoder().decode(head.subarray(20, 20 + mdiSize));
    const m = /<Thumb\b([^>]*)>/.exec(xml);
    if (!m) return null;
    const attr = (k) => (new RegExp(`\\s${k}="([^"]*)"`).exec(m[1]) || [])[1];
    const width = +attr('width'), height = +attr('height'), bin = attr('bin') || 'thumb';
    if (!(width > 0 && height > 0 && width * height <= 4096 * 4096)) return null;
    // walk the entries from their headers alone
    let p = 20 + mdiSize;
    for (let i = 0; i < 64; i++) {
        const h = await fetchRange(url, p, p + 131);
        if (h.length < 132 || String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'PAC ') return null;
        const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
        const chunk = hv.getUint32(4, true), type = hv.getUint32(8, true), size = hv.getUint32(12, true);
        let n = 0;
        while (n < 64 && h[68 + n]) n++;
        if (new TextDecoder().decode(h.subarray(68, 68 + n)) === bin) {
            let d = await fetchRange(url, p + 132, p + 132 + size - 1);
            if (type === 1) d = await inflate(d); else if (type !== 0) return null;
            if (d.length < width * height * 4) return null;
            const px = new Uint8ClampedArray(width * height * 4);
            for (let j = 0; j < px.length; j += 4) { px[j] = d[j + 2]; px[j + 1] = d[j + 1]; px[j + 2] = d[j]; px[j + 3] = d[j + 3]; }
            return new ImageData(px, width, height);
        }
        if (chunk < 132) return null;
        p += chunk;
    }
    return null;
}

const previews = new Map(); // url -> Promise<blob URL | null>
function mdpPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        p = mdpThumbnail(url).then(img => {
            if (!img) return null;
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            c.getContext('2d').putImageData(img, 0, 0);
            return new Promise(resolve => c.toBlob(b => resolve(b ? URL.createObjectURL(b) : null), 'image/png'));
        });
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('MDP thumbnail failed:', err); });
        if (previews.size > 64) {
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

// --- The viewer ---

class MdpComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = MdpComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'picture.mdp';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.selected = null;
        this.zoom = 'fit';
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.root = container.element;
        this.root.classList.add('mdp-root');
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
        if (MdpComponent._styleInstalled) return;
        MdpComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.mdp-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.mdp-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.mdp-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.mdp-root button,.mdp-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.mdp-root button:hover{background:#444c56}
.mdp-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdp-status{color:#adbac7;margin-left:auto}
.mdp-main{display:grid;grid-template-columns:1fr 290px;min-height:0}
.mdp-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.mdp-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.mdp-stage.dark{background:#111}.mdp-stage.light{background:#fff}.mdp-stage.paper{background:#2a2e34}
.mdp-stage canvas{flex:none}
.mdp-stage canvas.pixelated{image-rendering:pixelated}
.mdp-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.mdp-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.mdp-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.mdp-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.mdp-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.mdp-layer:hover{background:#2d333b}
.mdp-layer.sel{background:#303b49}
.mdp-layer.off .mdp-name,.mdp-layer.off canvas{opacity:.45}
.mdp-layer.folder .mdp-name{font-weight:600}
.mdp-eye{flex:none;width:22px;padding:0!important;text-align:center}
.mdp-clip{flex:none;color:#adbac7;width:10px}
.mdp-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.mdp-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.mdp-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.mdp-tag.warn{color:#e3b341;border-color:#9e6a03}
.mdp-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.mdp-props input[type=range]{width:100%}
.mdp-props .full{grid-column:1/-1}
.mdp-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:170px;overflow:auto;border-top:1px solid #373e47}
.mdp-info span:nth-child(odd){color:#adbac7}
.mdp-info span:nth-child(even){overflow-wrap:anywhere}
.mdp-info canvas{max-width:120px;max-height:90px;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.mdp-message{padding:20px;color:#adbac7;text-align:center}
.mdp-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.mdp-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.mdp-side{border-left:none;border-top:1px solid #444c56}}
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
        const shell = this._el('div', 'mdp-shell');
        const bar = this._el('div', 'mdp-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.mdp';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'mdp-title', this.fileName);
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        this.bgSel = this._select('Background: the paper (the canvas colour the file sets), or the picture transparent', [['checker', 'Checker'], ['paper', 'Paper'], ['dark', 'Dark'], ['light', 'Light']],
            'checker', v => this._background(v));
        const reset = this._button('Reset', 'Undo all changes to layers: the picture as saved', () => { this.changes = {}; this._renderLayers(); this._showProps(); this._render(); });
        const save = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(MDP_RE, '') + '.png'));
        this.statusEl = this._el('span', 'mdp-status');
        bar.append(this.fileInput, this._button('Open', 'Open an .mdp from this computer', () => this.fileInput.click()), this.titleEl, zoom, this.bgSel, reset, save, this.statusEl);

        const main = this._el('div', 'mdp-main');
        this.stage = this._el('div', 'mdp-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'mdp-side');
        const head = this._el('h3', null, 'Layers');
        head.appendChild(this._button('All on', 'Show every layer', () => {
            for (const l of this.layers) this._set(l.id, 'visible', l.visible ? undefined : true);
            this._renderLayers();
            this._render();
        }));
        this.layersEl = this._el('div', 'mdp-layers');
        this.propsEl = this._el('div', 'mdp-props');
        this.infoEl = this._el('div', 'mdp-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'mdp-message', 'Open a MediBang Paint or FireAlpaca file (.mdp).'));
        this.canvas.style.display = 'none';
    }

    // 'paper': the layers on the canvas colour the file sets (FireAlpaca's picture with its checkerboard
    // off, and what it exports then); the others: transparent, on a checkerboard, dark or light
    _background(v) {
        this.bgSel.value = v;
        this.stage.className = 'mdp-stage ' + v;
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
        this.statusEl.textContent = 'Reading layers…';
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
            // composited on the paper when the file has the checkerboard off
            this.paper = !r.info.checker;
            this._background(this.paper ? 'paper' : 'checker');
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
        this.stage.querySelectorAll('.mdp-message, .mdp-error').forEach(e => e.remove());
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

    _renderLayers() {
        this.layersEl.innerHTML = '';
        for (const l of this.layers) {
            const visible = this._get(l, 'visible');
            const row = this._el('div', 'mdp-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : '') + (l.folder ? ' folder' : ''));
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
            eye.className = 'mdp-eye';
            const clip = this._el('span', 'mdp-clip', l.clipping ? '↓' : '');
            if (l.clipping) clip.title = 'Clipped to the layer below';
            const thumb = this._el('canvas');
            const t = this.thumbs && this.thumbs[l.id];
            if (t) {
                thumb.width = t.width;
                thumb.height = t.height;
                thumb.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
            }
            const name = this._el('span', 'mdp-name', l.name || '(unnamed)');
            name.title = l.text || l.name;
            row.append(eye, clip, thumb, name);
            const kind = l.mask || (TYPE_NAMES[l.type] ?? l.type);
            if (kind) row.appendChild(this._el('span', 'mdp-tag', kind));
            if (l.halftone) row.appendChild(this._el('span', 'mdp-tag', HALFTONE_NAMES[l.halftone] || l.halftone));
            const mode = this._get(l, 'mode');
            if (mode !== 'normal') row.appendChild(this._el('span', 'mdp-tag', this.modeNames.get(mode) || mode));
            if (this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'mdp-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
            if (l.draft) row.appendChild(this._el('span', 'mdp-tag', 'draft'));
            if (l.problem) {
                const w = this._el('span', 'mdp-tag warn', /not applied/.test(l.problem) ? 'not applied' : 'approximate');
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
        // pass through is a folder's
        const modes = this.info.modes.filter(([v]) => v !== 'through' || l.folder);
        const mode = this._select('Blend mode', modes, this._get(l, 'mode'), v => {
            this._set(l.id, 'mode', v === l.mode ? undefined : v);
            this._renderLayers();
            this._render();
        });
        const hex = (c) => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
        const facts = [l.folder ? 'folder' : l.mask ? `${l.mask} of the layer below (${l.mask === 'stencil' ? 'keeps it where painted' : 'erases it where painted'})` : `${l.type === 'text' ? 'text' : l.type} layer`,
            l.clipping ? 'clipped to the layer below' : '', l.color ? `colour ${hex(l.color)}` : '',
            l.halftone ? `${HALFTONE_NAMES[l.halftone] || l.halftone}${l.halftoneLines ? `, ${l.halftoneLines} lines` : ''}` : '',
            l.protectAlpha ? 'alpha protected' : '', l.locked ? 'locked' : '', l.draft ? 'draft (not exported)' : '',
            l.text ? `“${l.text.replace(/\n/g, ' / ')}”` : '', l.problem].filter(Boolean);
        const details = this._el('span', 'full', facts.join(' · '));
        details.style.color = '#adbac7';
        const save = this._button('Save layer as PNG', 'This layer alone, at full opacity', async () => {
            const r = await this.ws.call('layer', { layerId: l.id });
            const c = document.createElement('canvas');
            c.width = this.info.width;
            c.height = this.info.height;
            c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), c.width, c.height), 0, 0);
            this._savePng(c, `${this.fileName.replace(MDP_RE, '')}-${(l.name || 'layer').replace(/[^\w.-]+/g, '_')}.png`);
        });
        save.classList.add('full');
        this.propsEl.append(this._el('b', 'full', l.name), this._el('span', null, 'Visible'), vis, opLabel, op, this._el('span', null, 'Mode'), mode, details, save);
    }

    _renderInfo() {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const rows = [
            ['Size', `${i.width} × ${i.height} px${i.dpi ? ` (${(i.width / i.dpi * 2.54).toFixed(1)} × ${(i.height / i.dpi * 2.54).toFixed(1)} cm)` : ''}`],
            ['Resolution', i.dpi ? `${i.dpi} dpi` : ''],
            ['Background', `${i.checker ? 'transparent (checker)' : 'paper'}, rgb(${i.background.join(', ')})`],
            ['Saved with', i.app],
            ['Created', i.created],
            ['Updated', i.updated],
            ['Animation', i.animation],
            ['Colour profile', i.icc ? 'embedded (not applied)' : ''],
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
        this.stage.querySelectorAll('.mdp-message, .mdp-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'mdp-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
    }
}

// File browser thumbnails: the one the file keeps
let _ctx = null;
const mdpThumbnails = {
    canHandle(file) {
        // (an .mdp read as text is a project's or a parameter file; browse mode hasn't read any yet: its content is '')
        return file.type === 'file' && MDP_RE.test(file.name) && !file.content;
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await mdpPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
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
    id: 'mdp',
    name: 'MediBang Paint / FireAlpaca files',
    components: {
        mdpViewer: MdpComponent,
    },
    toolbarButtons: [
        { label: 'MDP', title: 'Open the MediBang Paint / FireAlpaca viewer', menuLabel: 'MediBang Paint / FireAlpaca file (.mdp) with layers' },
    ],
    thumbnailRenderers: [mdpThumbnails],
    init(ctx) {
        MdpComponent._ctx = ctx;
        _ctx = ctx;
    },
});

module.exports = { isMdp };
