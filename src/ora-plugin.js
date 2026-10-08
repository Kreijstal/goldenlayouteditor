// --- OpenRaster images (.ora: Krita, MyPaint, GIMP, Pinta...) ---
// Read by jsora (jsora 0.3.0, its browser build loaded from jsDelivr when one is
// opened): the stack of layers and groups, each layer's PNG. Shown: the picture
// as the program that saved it composited it (mergedimage.png; the thumbnail
// when an older file has none), and the layers, each of which can be looked at
// alone. Not composited again here: jsora's own renderer (gpu.js) draws them
// upside down and blends them wrong, so hiding a layer or changing a mode isn't
// offered. Thumbnails in the file browser are the file's own, read from the ZIP
// by itself.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { zipEntry } = require('./kra-plugin');

const log = createLogger('ORA');
const JSORA_URL = 'https://cdn.jsdelivr.net/npm/jsora@0.3.0/dist/jsora.min.js';
const ORA_RE = /\.ora$/i;

// Oracle's configuration files (tnsnames.ora, init.ora...) are text: an OpenRaster image is a ZIP
function isOra(bytes) {
    return !!bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
}

let jsoraPromise = null;
function loadJsora() {
    if (!jsoraPromise) {
        jsoraPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = JSORA_URL;
            s.onload = () => window.jsora ? resolve(window.jsora) : reject(new Error('jsora did not load'));
            s.onerror = () => reject(new Error('Could not load ' + JSORA_URL));
            document.head.appendChild(s);
        });
        jsoraPromise.catch(() => { jsoraPromise = null; });
    }
    return jsoraPromise;
}

// The file's own thumbnail (256 pixels at most), else its merged image
const previews = new Map(); // url -> Promise<blob URL | null>
function oraPreviewUrl(url) {
    let p = previews.get(url);
    if (!p) {
        p = zipEntry(url, ['Thumbnails/thumbnail.png', 'mergedimage.png'])
            .then(png => png ? URL.createObjectURL(new Blob([png], { type: 'image/png' })) : null);
        previews.set(url, p);
        p.catch(err => { previews.delete(url); log.warn('OpenRaster preview failed:', err); });
        if (previews.size > 64) {
            const [oldKey, old] = previews.entries().next().value;
            previews.delete(oldKey);
            old.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
        }
    }
    return p;
}

// --- The viewer ---

const MODE_NAMES = {
    'svg:src-over': 'normal', 'svg:multiply': 'multiply', 'svg:screen': 'screen', 'svg:overlay': 'overlay',
    'svg:darken': 'darken', 'svg:lighten': 'lighten', 'svg:color-dodge': 'color dodge', 'svg:color-burn': 'color burn',
    'svg:hard-light': 'hard light', 'svg:soft-light': 'soft light', 'svg:difference': 'difference',
    'svg:color': 'color', 'svg:luminosity': 'luminosity', 'svg:hue': 'hue', 'svg:saturation': 'saturation',
    'svg:plus': 'plus', 'svg:dst-in': 'destination in', 'svg:dst-out': 'destination out',
    'svg:src-atop': 'source atop', 'svg:dst-atop': 'destination atop',
};

class OraComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = OraComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'image.ora';
        this.rows = [];
        this.selected = null; // a layer shown alone, or null: the picture
        this.zoom = 'fit';
        this.generation = 0;
        this.root = container.element;
        this.root.classList.add('ora-root');
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
        if (OraComponent._styleInstalled) return;
        OraComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.ora-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.ora-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.ora-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.ora-root button,.ora-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.ora-root button:hover{background:#444c56}
.ora-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ora-status{color:#adbac7;margin-left:auto}
.ora-main{display:grid;grid-template-columns:1fr 300px;min-height:0}
.ora-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.ora-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.ora-stage.dark{background:#111}.ora-stage.light{background:#fff}
.ora-stage canvas{flex:none;image-rendering:auto}
.ora-stage canvas.pixelated{image-rendering:pixelated}
.ora-side{border-left:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto minmax(80px,1fr) auto;min-height:0}
.ora-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px}
.ora-layers{overflow:auto;border-top:1px solid #373e47;border-bottom:1px solid #373e47}
.ora-layer{display:flex;align-items:center;gap:5px;padding:3px 6px;cursor:pointer;border-bottom:1px solid #2d333b;white-space:nowrap}
.ora-layer:hover{background:#2d333b}
.ora-layer.sel{background:#303b49}
.ora-layer.off .ora-name,.ora-layer.off canvas{opacity:.45}
.ora-layer.group .ora-name{font-weight:600}
.ora-layer canvas{flex:none;width:34px;height:26px;object-fit:contain;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.ora-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ora-tag{flex:none;font-size:10px;color:#adbac7;border:1px solid #444c56;border-radius:3px;padding:0 3px}
.ora-info{padding:4px 10px 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;max-height:200px;overflow:auto}
.ora-info span:nth-child(odd){color:#adbac7}
.ora-info span:nth-child(even){overflow-wrap:anywhere}
.ora-message{padding:20px;color:#adbac7;text-align:center}
.ora-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.ora-main{grid-template-columns:1fr;grid-template-rows:1fr 45%}.ora-side{border-left:none;border-top:1px solid #444c56}}
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
        const shell = this._el('div', 'ora-shell');
        const bar = this._el('div', 'ora-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.ora';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'ora-title', this.fileName);
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%'], ['4', '400%']], 'fit', v => { this.zoom = v; this._fit(); });
        const bg = this._select('Background', [['checker', 'Checker'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => { this.stage.className = 'ora-stage ' + v; });
        this.exportBtn = this._button('Save PNG', 'Save what is shown (the picture, or the layer alone) as a PNG', () => this._savePng());
        this.statusEl = this._el('span', 'ora-status');
        bar.append(this.fileInput, this._button('Open', 'Open a .ora from this computer', () => this.fileInput.click()), this.titleEl, zoom, bg, this.exportBtn, this.statusEl);

        const main = this._el('div', 'ora-main');
        this.stage = this._el('div', 'ora-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        const side = this._el('div', 'ora-side');
        this.layersEl = this._el('div', 'ora-layers');
        this.infoEl = this._el('div', 'ora-info');
        side.append(this._el('h3', null, 'Layers (click one to see it alone)'), this.layersEl, this.infoEl);
        main.append(this.stage, side);
        shell.append(bar, main);
        this.root.appendChild(shell);
        this.stage.appendChild(this._el('div', 'ora-message', 'Open an OpenRaster image (.ora).'));
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
        this.selected = null;
        this._closeBitmaps();
        try {
            if (!isOra(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)))) throw new Error('not an OpenRaster image (not a ZIP)');
            this.statusEl.textContent = 'Loading jsora…';
            const lib = await loadJsora();
            if (gen !== this.generation) return;
            this.statusEl.textContent = 'Reading layers…';
            const project = new lib.JSOra();
            await project.load(new Blob([buffer]));
            if (gen !== this.generation) return;
            this.project = project;
            this.width = project.width;
            this.height = project.height;
            // The picture as saved: mergedimage.png (OpenRaster 0.0.5 on), else the thumbnail
            // (older MyPaint files), from the ZIP jsora opened
            const zip = project._zipref;
            this.mergedFrom = zip.file('mergedimage.png') ? 'mergedimage.png' : zip.file('Thumbnails/thumbnail.png') ? 'Thumbnails/thumbnail.png' : null;
            this.merged = this.mergedFrom ? await createImageBitmap(await zip.file(this.mergedFrom).async('blob')) : null;
            if (gen !== this.generation) return;
            this.rows = [];
            this._collect(project.root, 0);
            await Promise.all(this.rows.filter(r => r.layer).map(r => r.item._image_elem.decode().catch(() => { r.problem = 'its PNG could not be read'; })));
            if (gen !== this.generation) return;
            this._renderLayers();
            this._renderInfo();
            this._show();
        } catch (err) {
            if (gen !== this.generation) return;
            log.error('Open failed:', err);
            this._error(`Could not open ${name}: ${err.message || err}`);
        }
    }

    // The stack, top first as in the file, with how deep each is in the groups
    _collect(group, depth) {
        for (const item of group.children) {
            const layer = item.type === 0; // jsora's TYPE_LAYER
            // (no visibility attribute: visible, the spec's default; jsora takes it as hidden)
            this.rows.push({ item, layer, depth, hidden: item._elem.getAttribute('visibility') === 'hidden' });
            if (!layer) this._collect(item, depth + 1);
        }
    }

    // What is on the stage: the picture as saved, or the selected layer alone at its place
    _show() {
        const row = this.selected;
        if (row) {
            const img = row.item._image_elem;
            this.canvas.width = this.width;
            this.canvas.height = this.height;
            const g = this.canvas.getContext('2d');
            g.clearRect(0, 0, this.width, this.height);
            g.drawImage(img, row.item.offsets[0], row.item.offsets[1]);
        } else if (this.merged) {
            this.canvas.width = this.merged.width;
            this.canvas.height = this.merged.height;
            this.canvas.getContext('2d').drawImage(this.merged, 0, 0);
        } else {
            this._error('This file has neither a merged image nor a thumbnail; its layers can be seen one by one.');
            this._status();
            return;
        }
        this.canvas.style.display = '';
        this.stage.querySelectorAll('.ora-message, .ora-error').forEach(e => e.remove());
        this._fit();
        this._status();
    }

    _status() {
        const layers = this.rows.filter(r => r.layer).length;
        const r = this.selected;
        const what = r ? `layer "${r.item.name || '(unnamed)'}" alone, ${r.item._image_elem.naturalWidth} × ${r.item._image_elem.naturalHeight} at ${r.item.offsets[0]}, ${r.item.offsets[1]}`
            : this.mergedFrom === 'mergedimage.png' ? 'as saved (its merged image)'
                : this.mergedFrom ? 'its thumbnail only: the file has no merged image' : 'no merged image';
        this.statusEl.textContent = `${this.width} × ${this.height} · ${layers} layers · ${what}`;
    }

    _fit() {
        if (!this.width) return;
        // a thumbnail stands in for the picture: drawn at the picture's size
        const k = !this.selected && this.mergedFrom && this.mergedFrom !== 'mergedimage.png' ? this.width / this.canvas.width : 1;
        const width = this.canvas.width * k, height = this.canvas.height * k;
        let scale = +this.zoom;
        if (this.zoom === 'fit') {
            const r = this.stage.getBoundingClientRect();
            scale = Math.min((r.width - 16) / width, (r.height - 16) / height);
            if (!(scale > 0)) scale = 1;
            if (scale > 1) scale = Math.max(1, Math.floor(scale)); // small images: whole steps
        }
        this.canvas.classList.toggle('pixelated', scale * k >= 2);
        this.canvas.style.width = Math.round(width * scale) + 'px';
        this.canvas.style.height = Math.round(height * scale) + 'px';
    }

    _renderLayers() {
        this.layersEl.innerHTML = '';
        const top = this._el('div', 'ora-layer group' + (this.selected ? '' : ' sel'));
        top.append(this._el('span', 'ora-name', this.mergedFrom === 'mergedimage.png' ? 'The picture (as saved)' : 'The picture (thumbnail)'));
        top.addEventListener('click', () => { this.selected = null; this._renderLayers(); this._show(); });
        this.layersEl.appendChild(top);
        for (const r of this.rows) {
            const it = r.item;
            const row = this._el('div', 'ora-layer' + (r.layer ? '' : ' group') + (r.hidden ? ' off' : '') + (this.selected === r ? ' sel' : ''));
            row.style.paddingLeft = (6 + r.depth * 14) + 'px';
            if (r.layer) {
                const thumb = this._el('canvas');
                const img = it._image_elem;
                if (img.naturalWidth) {
                    const s = Math.min(68 / img.naturalWidth, 52 / img.naturalHeight, 1);
                    thumb.width = Math.max(1, Math.round(img.naturalWidth * s));
                    thumb.height = Math.max(1, Math.round(img.naturalHeight * s));
                    thumb.getContext('2d').drawImage(img, 0, 0, thumb.width, thumb.height);
                }
                row.appendChild(thumb);
            } else {
                row.appendChild(this._el('span', 'ora-tag', 'group'));
            }
            const name = this._el('span', 'ora-name', it.name || '(unnamed)');
            name.title = it.name || '';
            row.appendChild(name);
            const op = it.composite_op || 'svg:src-over';
            if (op !== 'svg:src-over') row.appendChild(this._el('span', 'ora-tag', MODE_NAMES[op] || op));
            if (it.opacity < 1) row.appendChild(this._el('span', 'ora-tag', Math.round(it.opacity * 100) + '%'));
            if (r.hidden) row.appendChild(this._el('span', 'ora-tag', 'hidden'));
            if (!r.layer && it._elem.getAttribute('isolation') === 'isolate') row.appendChild(this._el('span', 'ora-tag', 'isolated'));
            if (r.problem) row.appendChild(Object.assign(this._el('span', 'ora-tag', 'unreadable'), { title: r.problem }));
            if (r.layer && !r.problem) row.addEventListener('click', () => { this.selected = r; this._renderLayers(); this._show(); });
            this.layersEl.appendChild(row);
        }
    }

    _renderInfo() {
        const p = this.project;
        const root = p._elem_root;
        const ppi = p.ppi;
        const rows = [
            ['Size', `${this.width} × ${this.height}`],
            ['Resolution', ppi ? `${ppi[0]} × ${ppi[1]} ppi` : ''],
            ['Layers', `${this.rows.filter(r => r.layer).length}${this.rows.some(r => !r.layer) ? ` in ${this.rows.filter(r => !r.layer).length} groups` : ''}`],
            ['Merged image', this.mergedFrom === 'mergedimage.png' ? (this.merged.width !== this.width || this.merged.height !== this.height ? `${this.merged.width} × ${this.merged.height} (not the image's size)` : 'yes') : 'none in the file'],
            ['OpenRaster', root.getAttribute('version') || ''],
        ];
        this.infoEl.innerHTML = '';
        for (const [k, v] of rows) if (v) this.infoEl.append(this._el('span', null, k), this._el('span', null, String(v)));
    }

    _savePng() {
        if (this.canvas.style.display === 'none') return;
        const base = this.fileName.replace(ORA_RE, '');
        const name = this.selected ? `${base}-${(this.selected.item.name || 'layer').replace(/[^\w.-]+/g, '_')}.png` : base + '.png';
        this.canvas.toBlob(blob => {
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
        this.stage.querySelectorAll('.ora-message, .ora-error').forEach(e => e.remove());
        this.canvas.style.display = 'none';
        this.stage.appendChild(this._el('div', 'ora-error', message));
    }

    _closeBitmaps() {
        if (this.merged && this.merged.close) this.merged.close();
        this.merged = null;
        this.project = null;
    }

    _destroy() {
        this.generation++;
        this._closeBitmaps();
    }
}

// File browser thumbnails: the file's own thumbnail
let _ctx = null;
const oraThumbnails = {
    canHandle(file) {
        // (a .ora read as text is Oracle's; browse mode hasn't read any yet: its content is '')
        return file.type === 'file' && ORA_RE.test(file.name) && !file.content;
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        try {
            const url = await oraPreviewUrl(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
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
    id: 'ora',
    name: 'OpenRaster images',
    components: {
        oraViewer: OraComponent,
    },
    toolbarButtons: [
        { label: 'ORA', title: 'Open the OpenRaster viewer', menuLabel: 'OpenRaster image (.ora) with layers' },
    ],
    thumbnailRenderers: [oraThumbnails],
    init(ctx) {
        OraComponent._ctx = ctx;
        _ctx = ctx;
    },
});

module.exports = { isOra };
