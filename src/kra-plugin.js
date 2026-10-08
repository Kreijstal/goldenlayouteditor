// --- Krita documents (.kra, .krz) ---
// The picture as Krita saved it (its merged image), with its layers: show or
// hide each (Shift+click an eye: that layer alone), change a layer's opacity or
// blending mode, and the layers are composited again. Reading and compositing
// happen in a worker (public/kra-worker.js), written from Krita's own sources;
// vector layers are SVG, drawn here. Changes aren't saved. Thumbnails in the
// file browser are the document's preview.png, read from the ZIP by itself.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('KRA');
const WORKER_URL = '/kra-worker.js';
const KRA_RE = /\.kr[az]$/i;

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
        for (const p of pending.values()) p.reject(new Error(e.message || 'the Krita reader failed'));
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

// --- Reading one file from the ZIP, fetching only what it needs ---

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// A range of the file at url ("start-end" or "-length" from its end, as HTTP has
// them), or the whole file when the server sends all of it
async function fetchRange(url, range) {
    let resp = await fetch(url, { headers: { Range: 'bytes=' + range } });
    // a file shorter than the range asked from its end is refused (416): all of it, then
    if (!resp.ok && resp.headers.get('content-range')) resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (resp.status !== 206) return { bytes, start: 0, whole: true };
    const m = /bytes (\d+)-/.exec(resp.headers.get('content-range') || '');
    return { bytes, start: m ? +m[1] : 0, whole: false };
}

async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The bytes of the first of `names` the ZIP at url holds (an empty one is not there), or null
async function zipEntry(url, names) {
    // the end of central directory record is in the last 64 KB (and 22 bytes)
    const tail = await fetchRange(url, '-65558');
    const all = tail.whole ? tail.bytes : null;
    const b = tail.bytes;
    let eocd = -1;
    for (let i = b.length - 22; i >= 0; i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const cdSize = u32(b, eocd + 12), cdOffset = u32(b, eocd + 16);
    const cd = all ? all.subarray(cdOffset, cdOffset + cdSize)
        : cdOffset >= tail.start ? b.subarray(cdOffset - tail.start, cdOffset - tail.start + cdSize)
            : (await fetchRange(url, `${cdOffset}-${cdOffset + cdSize - 1}`)).bytes;
    const found = {};
    for (let p = 0; p + 46 <= cd.length && u32(cd, p) === 0x02014b50;) {
        const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
        const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
        if (names.includes(name) && u32(cd, p + 24)) found[name] = { method: u16(cd, p + 10), compSize: u32(cd, p + 20), offset: u32(cd, p + 42) };
        p += 46 + nameLen + extraLen + commentLen;
    }
    const name = names.find(n => found[n]);
    if (!name) return null;
    const e = found[name];
    let local;
    if (all) local = all.subarray(e.offset);
    else {
        // the local header's extra field may differ from the central one's: some room for it
        const r = await fetchRange(url, `${e.offset}-${e.offset + 30 + 1024 + e.compSize - 1}`);
        local = r.whole ? r.bytes.subarray(e.offset) : r.bytes;
    }
    const dataStart = 30 + u16(local, 26) + u16(local, 28);
    const data = local.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    return null;
}

// The document's own small preview (preview.png, 256 pixels at most), else its merged image
const previews = new Map(); // url -> Promise<blob URL | null>
function kraPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        p = zipEntry(url, ['preview.png', 'mergedimage.png'])
            .then(png => png ? URL.createObjectURL(new Blob([png], { type: 'image/png' })) : null);
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('Krita preview failed:', err); });
        if (previews.size > 64) {
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

// Whether a picture (an ImageBitmap, or { width, height, data }) is transparent all over, judged small
function isBlank(picture) {
    if (!picture) return true;
    let data = picture.data;
    if (!data) {
        const c = document.createElement('canvas');
        c.width = Math.min(64, picture.width);
        c.height = Math.min(64, picture.height);
        const g = c.getContext('2d');
        g.drawImage(picture, 0, 0, c.width, c.height);
        data = g.getImageData(0, 0, c.width, c.height).data;
    }
    for (let i = 3; i < data.length; i += 4) if (data[i]) return false;
    return true;
}

// --- The viewer ---

const KIND_TAGS = {
    vector: 'vector', clone: 'clone', filter: 'filter', fill: 'fill', file: 'file', reference: 'reference',
    'transparency mask': 'transparency', 'filter mask': 'filter mask', 'selection mask': 'selection',
    'transform mask': 'transform', 'colorize mask': 'colorize',
};

class KraComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = KraComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'image.kra';
        this.ws = null;
        this.layers = [];
        this.changes = {};
        this.collapsed = new Set();
        this.selected = null;
        this.zoom = 'fit';
        this.generation = 0;
        this.rendering = false;
        this.renderAgain = false;
        this.merged = null;
        this.root = container.element;
        this.root.classList.add('kra-root');
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
        if (KraComponent._styleInstalled) return;
        KraComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.kra-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.kra-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.kra-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.kra-root button,.kra-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.kra-root button:hover{background:#444c56}
.kra-root button:disabled{opacity:.4;cursor:default}
.kra-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kra-status{color:#adbac7;margin-left:auto}
.kra-main{display:grid;grid-template-columns:1fr 300px;min-height:0}
.kra-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.kra-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.kra-stage.dark{background:#111}.kra-stage.light{background:#fff}
.kra-stage canvas{flex:none;image-rendering:auto}
.kra-stage canvas.pixelated{image-rendering:pixelated}
.kra-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto auto;min-height:0}
.kra-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px;display:flex;align-items:center;gap:6px}
.kra-side h3 button{margin-left:auto;padding:1px 6px;font-size:11px;text-transform:none}
.kra-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.kra-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.kra-layer:hover{background:#2d333b}
.kra-layer.sel{background:#303b49}
.kra-layer.off .kra-name,.kra-layer.off canvas{opacity:.45}
.kra-layer.mask .kra-name{font-style:italic}
.kra-eye{flex:none;width:22px;padding:0!important;text-align:center}
.kra-twisty{flex:none;width:12px;color:#adbac7;text-align:center}
.kra-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.kra-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.kra-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.kra-tag.warn{color:#e3b341;border-color:#9e6a03}
.kra-props{padding:6px 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center}
.kra-props input[type=range]{width:100%}
.kra-props select{max-width:100%}
.kra-props .full{grid-column:1/-1}
.kra-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:180px;overflow:auto;border-top:1px solid #373e47}
.kra-info span:nth-child(odd){color:#adbac7}
.kra-info span:nth-child(even){overflow-wrap:anywhere}
.kra-message{padding:20px;color:#adbac7;text-align:center}
.kra-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.kra-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.kra-side{border-left:none;border-top:1px solid #444c56}}
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
        const shell = this._el('div', 'kra-shell');
        const bar = this._el('div', 'kra-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.kra,.krz';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'kra-title', this.fileName);
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        const bg = this._select('Background', [['checker', 'Checker'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => { this.stage.className = 'kra-stage ' + v; });
        this.resetBtn = this._button('Reset', 'Undo all changes to layers: the picture as Krita saved it', () => { this.changes = {}; this._renderLayers(); this._showProps(); this._render(); });
        this.exportBtn = this._button('Save PNG', 'Save the picture as shown as a PNG', () => this._savePng(this.canvas, this.fileName.replace(KRA_RE, '') + '.png'));
        this.statusEl = this._el('span', 'kra-status');
        bar.append(this.fileInput, this._button('Open', 'Open a .kra from this computer', () => this.fileInput.click()), this.titleEl, zoom, bg, this.resetBtn, this.exportBtn, this.statusEl);

        const main = this._el('div', 'kra-main');
        this.stage = this._el('div', 'kra-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'kra-side');
        const head = this._el('h3', null, 'Layers');
        head.appendChild(this._button('All on', 'Show every layer as saved', () => { for (const l of this.layers) this._set(l.id, 'visible', undefined); this._renderLayers(); this._render(); }));
        this.layersEl = this._el('div', 'kra-layers');
        this.propsEl = this._el('div', 'kra-props');
        this.infoEl = this._el('div', 'kra-info');
        side.append(head, this.layersEl, this.propsEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'kra-message', 'Open a Krita document (.kra).'));
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
        this.merged = null;
        this.mergedNote = '';
        if (!this.ws) this.ws = startWorker();
        this.statusEl.textContent = 'Reading layers…';
        try {
            const r = await this.ws.call('open', { bytes: buffer }, [buffer]);
            if (gen !== this.generation) return;
            this.info = r.info;
            this.layers = r.layers;
            this.thumbs = r.thumbs;
            this.byId = new Map(this.layers.map(l => [l.id, l]));
            this.collapsed = new Set(this.layers.filter(l => l.group && l.collapsed).map(l => l.id));
            this.modeNames = new Map(r.info.modes);
            if (r.merged) {
                // Krita's own composite of the layers, shown as long as nothing is changed;
                // unless it is blank where the layers are not (some of Krita's own templates)
                const merged = await createImageBitmap(new Blob([r.merged], { type: 'image/png' }));
                if (gen !== this.generation) return;
                if (isBlank(merged) && !isBlank(r.preview)) {
                    this.mergedNote = 'empty in the file: composited here';
                    merged.close();
                } else {
                    this.merged = merged;
                    this._paintBitmap(this.merged);
                }
            }
            this._renderLayers();
            this._showProps();
            this._renderInfo();
            this._status();
            const svgs = Object.entries(r.svgs || {});
            if (svgs.length) await this._drawShapes(svgs, gen);
            if (gen !== this.generation) return;
            if (!this.merged) await this._render();
        } catch (err) {
            if (gen !== this.generation) return;
            log.error('Open failed:', err);
            this._error(`Could not open ${name}: ${err.message}`);
        }
    }

    // Vector layers are SVG with the page in points (72 a inch); drawn at the image's size
    async _drawShapes(svgs, gen) {
        const { width, height } = this.info;
        const shapes = {};
        const transfer = [];
        for (const [id, text] of svgs) {
            const l = this.byId.get(+id);
            try {
                const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
                if (svg.nodeName !== 'svg') throw new Error('not SVG');
                if (!svg.getAttribute('viewBox')) {
                    const pt = v => parseFloat(v) || 0;
                    svg.setAttribute('viewBox', `0 0 ${pt(svg.getAttribute('width'))} ${pt(svg.getAttribute('height'))}`);
                }
                svg.setAttribute('width', width);
                svg.setAttribute('height', height);
                svg.setAttribute('preserveAspectRatio', 'none');
                const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
                try {
                    const img = new Image();
                    img.src = url;
                    await img.decode();
                    const c = document.createElement('canvas');
                    c.width = width;
                    c.height = height;
                    const g = c.getContext('2d');
                    g.drawImage(img, l ? l.x : 0, l ? l.y : 0, width, height);
                    const data = g.getImageData(0, 0, width, height).data;
                    shapes[id] = data.buffer;
                    transfer.push(data.buffer);
                } finally {
                    URL.revokeObjectURL(url);
                }
            } catch (err) {
                log.warn('Vector layer not drawn:', l && l.name, err);
                if (l) { l.problem = `its SVG could not be drawn (${err.message || err})`; }
            }
        }
        if (gen !== this.generation || !transfer.length) return;
        const r = await this.ws.call('shapes', { shapes }, transfer);
        if (gen !== this.generation) return;
        Object.assign(this.thumbs, r.thumbs);
        this._renderLayers();
    }

    _paintBitmap(bitmap) {
        this.canvas.width = bitmap.width;
        this.canvas.height = bitmap.height;
        const g = this.canvas.getContext('2d');
        g.clearRect(0, 0, bitmap.width, bitmap.height);
        g.drawImage(bitmap, 0, 0);
        this._shown();
    }

    _paint(pixels) {
        const { width, height } = this.info;
        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer || pixels), width, height), 0, 0);
        this._shown();
    }

    _shown() {
        this.canvas.style.display = '';
        this.stage.querySelectorAll('.kra-message, .kra-error').forEach(e => e.remove());
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
        return Object.values(this.changes).filter(c => Object.keys(c).length).length;
    }

    _status(ms) {
        const i = this.info;
        const changed = this._changedCount();
        const what = changed || !this.merged
            ? `composited here${changed ? ` · ${changed} changed (not saved to the file)` : ''}${i.approximate ? ' · colours approximate' : ''}`
            : 'as Krita saved it';
        this.statusEl.textContent = `${i.width} × ${i.height} · ${this.layers.filter(l => !l.mask).length} layers · ${what}${ms !== undefined ? ` · ${ms} ms` : ''}`;
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

    // Recomposite in the worker (or back to Krita's merged image when nothing is
    // changed); while one runs, changes made meanwhile wait for the next
    async _render() {
        if (this.rendering) { this.renderAgain = true; return; }
        this.rendering = true;
        const gen = this.generation;
        try {
            do {
                this.renderAgain = false;
                if (this.merged && !this._changedCount()) {
                    this._paintBitmap(this.merged);
                    this._status();
                    continue;
                }
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

    _hiddenByCollapse(l) {
        // A layer is out of the list when a layer above it in the tree is collapsed
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
            const row = this._el('div', 'kra-layer' + (visible ? '' : ' off') + (this.selected === l.id ? ' sel' : '') + (l.mask ? ' mask' : ''));
            row.style.paddingLeft = (6 + l.depth * 14) + 'px';
            const eye = this._button(visible ? '👁' : ' ', 'Show / hide (Shift+click: this layer alone)', e => {
                e.stopPropagation();
                if (e.shiftKey && !l.mask) this._solo(l); else this._set(l.id, 'visible', !visible === l.visible ? undefined : !visible);
                this._renderLayers();
                this._render();
            });
            eye.className = 'kra-eye';
            const twisty = this._el('span', 'kra-twisty', l.hasChildren ? (this.collapsed.has(l.id) ? '▸' : '▾') : '');
            if (l.hasChildren) twisty.addEventListener('click', e => {
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
            const name = this._el('span', 'kra-name', l.name || '(unnamed)');
            name.title = `${l.name}\n${l.kind}${l.extent ? `, ${l.extent[2]} × ${l.extent[3]} at ${l.extent[0]}, ${l.extent[1]}` : ''}`;
            row.append(eye, twisty, thumb, name);
            if (KIND_TAGS[l.kind]) row.appendChild(this._el('span', 'kra-tag', l.kind === 'filter' && l.filter ? l.filter : KIND_TAGS[l.kind]));
            const mode = this._get(l, 'mode');
            if (!l.mask && mode !== 'normal') row.appendChild(this._el('span', 'kra-tag', this.modeNames.get(mode) || mode));
            if (l.passthrough) row.appendChild(this._el('span', 'kra-tag', 'pass-through'));
            if (l.alphaLocked) row.appendChild(Object.assign(this._el('span', 'kra-tag', 'α'), { title: 'Inherit alpha: drawn only over the layers below it in its group' }));
            if (this._get(l, 'opacity') < 1) row.appendChild(this._el('span', 'kra-tag', Math.round(this._get(l, 'opacity') * 100) + '%'));
            if (l.problem) {
                const w = this._el('span', 'kra-tag warn', l.broken ? 'unreadable' : 'not shown');
                w.title = l.problem;
                row.appendChild(w);
            }
            row.addEventListener('click', () => { this.selected = l.id; this._renderLayers(); this._showProps(); });
            this.layersEl.appendChild(row);
        }
    }

    // This layer alone: it, the groups it is in and what is in it on, the other layers off
    _solo(target) {
        const i = this.layers.indexOf(target);
        const keep = new Set([target.id]);
        let depth = target.depth;
        for (let k = i - 1; k >= 0 && depth > 0; k--) {
            if (this.layers[k].depth < depth) { keep.add(this.layers[k].id); depth = this.layers[k].depth; }
        }
        for (let k = i + 1; k < this.layers.length && this.layers[k].depth > target.depth; k++) keep.add(this.layers[k].id);
        for (const l of this.layers) {
            if (l.mask && !keep.has(l.id)) continue; // masks stay as they are
            const want = keep.has(l.id);
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
        this.propsEl.append(title, this._el('span', null, 'Visible'), vis);
        if (!l.mask) {
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
            const modes = [...this.info.modes];
            if (!this.modeNames.has(l.mode)) modes.push([l.mode, `${l.mode} (drawn as Normal)`]);
            const mode = this._select('Blending mode', modes, this._get(l, 'mode'), v => {
                this._set(l.id, 'mode', v === l.mode ? undefined : v);
                this._renderLayers();
                this._render();
            });
            this.propsEl.append(opLabel, op, this._el('span', null, 'Mode'), mode);
        }
        const facts = [l.kind + (l.filter ? ` (${l.filter})` : '') + (l.source ? ` of "${l.source}"` : '')];
        if (l.colorSpace) facts.push(`${l.colorSpace}${l.depthName ? `, ${l.depthName}` : ''}`);
        if (l.extent) facts.push(`${l.extent[2]} × ${l.extent[3]} at ${l.extent[0]}, ${l.extent[1]}`);
        if (l.locked) facts.push('locked');
        if (l.note) facts.push(l.note);
        if (l.problem) facts.push(l.problem);
        const details = this._el('span', 'full', facts.join(' · '));
        details.style.color = '#adbac7';
        this.propsEl.append(details);
        if (!l.mask) {
            const save = this._button('Save layer as PNG', 'This layer alone (with its masks), image-sized', async () => {
                const r = await this.ws.call('layer', { layerId: l.id });
                const c = document.createElement('canvas');
                c.width = this.info.width;
                c.height = this.info.height;
                c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.image.buffer || r.image), c.width, c.height), 0, 0);
                this._savePng(c, `${this.fileName.replace(KRA_RE, '')}-${(l.name || 'layer').replace(/[^\w.-]+/g, '_')}.png`);
            });
            save.classList.add('full');
            this.propsEl.append(save);
        }
    }

    _renderInfo() {
        const i = this.info;
        this.infoEl.innerHTML = '';
        const rows = [
            ['Size', `${i.width} × ${i.height}`],
            ['Colour', `${i.model}${i.depth ? `, ${i.depth}` : ''}${i.linear ? ', linear' : ''}`],
            ['Profile', i.profile],
            ['Background', i.background],
            ['Resolution', i.resolution ? `${i.resolution[0].toFixed(0)} × ${i.resolution[1].toFixed(0)} dpi` : ''],
            ['Merged image', this.merged ? 'yes (shown until a layer is changed)' : this.mergedNote || 'none: composited here'],
            ['Animation', i.animation],
            ['Title', i.title],
            ['Author', i.author],
            ['Created', i.created],
            ['Saved', i.edited],
            ['Description', i.description || i.abstract],
            ['Krita', i.kritaVersion],
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
        this.stage.querySelectorAll('.kra-message, .kra-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'kra-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.ws) this.ws.terminate();
        this.ws = null;
        if (this.merged && this.merged.close) this.merged.close();
    }
}

// File browser thumbnails: the document's preview.png
let _ctx = null;
const kraThumbnails = {
    canHandle(file) {
        return file.type === 'file' && KRA_RE.test(file.name);
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await kraPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
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
    id: 'kra',
    name: 'Krita documents',
    components: {
        kraViewer: KraComponent,
    },
    toolbarButtons: [
        { label: 'KRA', title: 'Open the Krita document viewer', menuLabel: 'Krita document (.kra) with layers' },
    ],
    thumbnailRenderers: [kraThumbnails],
    init(ctx) {
        KraComponent._ctx = ctx;
        _ctx = ctx;
    },
});
