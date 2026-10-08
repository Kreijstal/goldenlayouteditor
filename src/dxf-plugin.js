// --- DXF / DWG / DGN viewer ---
// AutoCAD drawings: DXF (.dxf, ASCII or binary) and DWG (.dwg), and MicroStation
// drawings (.dgn, V7 and V8), drawn by
// dxf-viewer (three.js, WebGL; loaded from esm.sh on first use). An ASCII DXF
// is handed to it as it is and the drawing follows the file's text as it is
// edited. A DWG is written out as ASCII DXF for it by LibreDWG (libredwg-web's
// WebAssembly, from jsDelivr), or, when LibreDWG can't read it, by acad-ts (a
// TypeScript port of ACadSharp, from esm.sh); a binary DXF by acad-ts; a DGN by
// cadkit (cadkit-wasm's WebAssembly, from jsDelivr), its levels as layers. The model
// space is drawn (dxf-viewer draws no paper space layouts); dragging pans, the
// wheel or a pinch zooms, 0 fits. The drawing's layers are listed beside it,
// each with a check box to show or hide it. Also draws thumbnails in the file
// browser's grid.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const THREE_URL = 'https://esm.sh/three@0.186.0';
const DXF_VIEWER_URL = 'https://esm.sh/dxf-viewer@1.0.49?deps=three@0.186.0,earcut@3.2.4,loglevel@1.9.2,opentype.js@1.3.5';
// (keep-names: acad-ts finds its DXF subclasses by the classes' names, which minifying loses)
const ACAD_URL = 'https://esm.sh/@node-projects/acad-ts@3.2.0?bundle&keep-names';
const LIBREDWG_URL = 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.15/wasm/libredwg-web.js';
const LIBREDWG_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.7.15/wasm/libredwg-web.wasm';
const CADKIT_URL = 'https://cdn.jsdelivr.net/npm/cadkit-wasm@0.2.1/web/cadkit_wasm.js';
// Text is drawn in these (dxf-viewer ignores the drawing's own text styles)
const FONTS = ['https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf'];

const DXF_NAME_RE = /\.(dxf|dwg|dgn)$/i;
const BINARY_DXF_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';
// A DWG starts with its version: AC1.2 ... AC2.10 (before R10), then AC1001 ... AC1032
const DWG_MAGIC_RE = /^AC(?:1\.\d|2\.\d|10\d\d)/;
// A DGN V7 starts with its 2D or 3D design file header element (type 9, level 8); a V8 is an
// OLE compound file
const DGN_V7_MAGIC = [[0x08, 0x09, 0xfe, 0x02], [0xc8, 0x09, 0xfe, 0x02]];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const RELEASES = {
    AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004',
    AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018',
};
// $DWGCODEPAGE of a DXF older than 2007 (later ones are UTF-8), as TextDecoder names it
const CODEPAGES = { ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5' };
const THUMB_SIZE = 256;
const MAX_THUMB_BYTES = 16 * 1024 * 1024;
let _ctx = null;
let _libs = null;
let _acad = null;
let _libredwg = null;
let _cadkit = null;
let _libredwgQueue = Promise.resolve();

function ensureLibs() {
    if (!_libs) {
        _libs = Promise.all([import(THREE_URL), import(DXF_VIEWER_URL)])
            .then(([three, dxf]) => ({ three, DxfViewer: dxf.DxfViewer }));
        _libs.catch(() => { _libs = null; });
    }
    return _libs;
}

function ensureAcad() {
    if (!_acad) {
        _acad = import(ACAD_URL);
        _acad.catch(() => { _acad = null; });
    }
    return _acad;
}

// cadkit-wasm's module, its WebAssembly (next to it) instantiated once
function ensureCadkit() {
    if (!_cadkit) {
        _cadkit = import(CADKIT_URL).then(async mod => { await mod.default(); return mod; });
        _cadkit.catch(() => { _cadkit = null; });
    }
    return _cadkit;
}

// A DGN (V7 or V8) as ASCII DXF text, by cadkit, with the version and cadkit's warnings
async function cadkitToDxf(bytes) {
    const cadkit = await ensureCadkit();
    const format = cadkit.detect(bytes);
    if (format !== 'dgn_v7' && format !== 'dgn_v8') throw new Error('not a MicroStation DGN drawing');
    const doc = cadkit.read(bytes);
    try {
        const info = doc.info();
        const warnings = doc.warnings();
        const app = info.application ? `, saved by ${info.application}` : '';
        return {
            text: doc.toDxf(), version: info.version + (info.units && info.units !== 'unitless' ? ` (${info.units})` : '') + app,
            by: 'cadkit', unread: 0,
            note: warnings.length ? `cadkit: ${[...new Set(warnings.map(w => w.message))].join('; ')}` : '',
        };
    } finally {
        doc.free();
    }
}

// libredwg-web's module and its WebAssembly, compiled once
function ensureLibredwg() {
    if (!_libredwg) {
        _libredwg = Promise.all([import(LIBREDWG_URL), WebAssembly.compileStreaming(fetch(LIBREDWG_WASM_URL))])
            .then(([mod, wasm]) => ({ createModule: mod.default, wasm }));
        _libredwg.catch(() => { _libredwg = null; });
    }
    return _libredwg;
}

// A DWG as ASCII DXF bytes, by LibreDWG's dwg_write_dxf. Each file gets an instance of its own (one
// that has converted a file fails on the next), one at a time (each reserves 1 GB of memory).
function libredwgToDxf(bytes) {
    const job = _libredwgQueue.then(async () => {
        const { createModule, wasm } = await ensureLibredwg();
        const m = await createModule({
            instantiateWasm: (imports, done) => WebAssembly.instantiate(wasm, imports).then(instance => done(instance, wasm)),
            print() {}, printErr() {},
        });
        m.FS.writeFile('in.dwg', bytes);
        const error = m.dwg_write_dxf('in.dwg', 'out.dxf');
        // (128 and up: LibreDWG's critical errors)
        if (error >= 128 || !m.FS.analyzePath('out.dxf').exists) throw new Error(`LibreDWG error ${error}`);
        return m.FS.readFile('out.dxf');
    });
    _libredwgQueue = job.catch(() => {});
    return job;
}

function latin1(bytes, start, end) {
    let s = '';
    for (let i = start; i < Math.min(end, bytes.length); i++) s += String.fromCharCode(bytes[i]);
    return s;
}

function startsWith(bytes, magic) {
    return magic.every((b, i) => bytes[i] === b);
}

// A DGN V7 or V8 by its first bytes (a V8 being an OLE compound file, which only a .dgn is taken for)
function isDgn(bytes) {
    return DGN_V7_MAGIC.some(m => startsWith(bytes, m)) || startsWith(bytes, OLE_MAGIC);
}

// 'dxfb' (binary DXF), 'dwg', 'dgn' or 'dxf' (text)
function kindOf(bytes) {
    if (latin1(bytes, 0, BINARY_DXF_SENTINEL.length) === BINARY_DXF_SENTINEL) return 'dxfb';
    if (DWG_MAGIC_RE.test(latin1(bytes, 0, 6))) return 'dwg';
    if (isDgn(bytes)) return 'dgn';
    return 'dxf';
}

// An ASCII DXF's text from its bytes: UTF-8 from 2007 on, before that in $DWGCODEPAGE
function decodeDxf(bytes) {
    const head = latin1(bytes, 0, 4096);
    const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(head);
    const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head);
    let label = 'utf-8';
    if (!ver || ver[1] < 'AC1021') {
        const name = cp ? cp[1].toUpperCase() : 'ANSI_1252';
        label = CODEPAGES[name] || (/^ANSI_12[5-9]\d$/.test(name) ? 'windows-' + name.slice(5) : 'windows-1252');
    }
    try { return new TextDecoder(label).decode(bytes); } catch (_) { return new TextDecoder('utf-8').decode(bytes); }
}

function workspaceUrl(rel) {
    return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
}

// A project file as { kind, text } (an ASCII DXF) or { kind, bytes } (a binary DXF, a DWG or a DGN)
async function readDrawing(file) {
    // (a file the browser lists but hasn't read yet holds '' until then)
    if (typeof file.content === 'string' && !file.lazy && !file.viewType) return { kind: 'dxf', text: file.content };
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await workspaceUrl(_ctx.getRelativePath(file.id)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return fromBytes(new Uint8Array(await resp.arrayBuffer()), file.name);
}

function fromBytes(bytes, name) {
    const kind = kindOf(bytes);
    if (/\.dgn$/i.test(name) && kind !== 'dgn') throw new Error('not a MicroStation DGN drawing');
    return kind === 'dxf' ? { kind, text: decodeDxf(bytes) } : { kind, bytes };
}

// What dxf-viewer reads: the ASCII DXF itself, or LibreDWG's or acad-ts' reading of a DWG or a
// binary DXF, or cadkit's of a DGN, written out as one. Also the version, which library read it, and how many objects
// acad-ts could not read.
async function asciiDxf(drawing) {
    if (drawing.kind === 'dxf') {
        const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(drawing.text.slice(0, 4096));
        return { text: drawing.text, version: ver && ver[1], unread: 0 };
    }
    if (drawing.kind === 'dgn') return cadkitToDxf(drawing.bytes);
    if (drawing.kind === 'dwg') {
        const version = latin1(drawing.bytes, 0, 6);
        try {
            return { text: decodeDxf(await libredwgToDxf(drawing.bytes)), version, by: 'LibreDWG', unread: 0 };
        } catch (err) {
            const dxf = await acadToDxf(drawing);
            return { ...dxf, version, note: `LibreDWG could not read it (${err.message})` };
        }
    }
    return acadToDxf(drawing);
}

async function acadToDxf(drawing) {
    const acad = await ensureAcad();
    let unread = 0;
    const notify = (sender, e) => { if (e && (e.notificationType === 3 || e.notificationType === -1)) unread++; };
    const doc = drawing.kind === 'dwg'
        ? acad.DwgReader.readFromStream(drawing.bytes.buffer.slice(drawing.bytes.byteOffset, drawing.bytes.byteOffset + drawing.bytes.byteLength), notify)
        : acad.DxfReader.readFromStream(drawing.bytes, notify);
    const parts = [];
    acad.DxfWriter.writeToStream({ write(s) { parts.push(s); } }, doc, false);
    const version = acad.ACadVersion[doc.header.version];
    return { text: parts.join(''), version: /^AC\d{4}$/.test(version) ? version : null, by: 'acad-ts', unread };
}

function describeVersion(kind, version) {
    if (kind === 'dgn') return `MicroStation DGN ${version}`;
    const what = kind === 'dwg' ? 'DWG' : kind === 'dxfb' ? 'binary DXF' : 'DXF';
    if (!version) return what;
    return `${what} ${version}` + (RELEASES[version] ? ` (AutoCAD ${RELEASES[version]})` : '');
}

// Load ASCII DXF text into a DxfViewer
async function loadText(viewer, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/dxf' }));
    try {
        await viewer.Load({ url, fonts: FONTS });
    } finally {
        URL.revokeObjectURL(url);
    }
}

// Model space only: a layout's paper space entities would land on top of it
const SCENE_OPTIONS = { suppressPaperSpace: true };

class DxfComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'drawing.dxf';
        this.viewer = null;
        this.source = null;     // the text shown (an ASCII DXF's, followed as it is edited)
        this.loaded = false;
        this.hidden = new Set(); // layers hidden, kept across edits
        this.light = false;
        this.root = container.element;
        this.root.classList.add('dxf-root');
        DxfComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (DxfComponent._styled) return;
        DxfComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.dxf-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.dxf-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.dxf-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.dxf-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.dxf-root button:hover{background:#444c56}
.dxf-root button.on{background:#316dca;border-color:#4184e4}
.dxf-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dxf-body{display:flex;min-height:0}
.dxf-stage{position:relative;flex:1;min-width:0;overflow:hidden;outline:none;background:#212830}
.dxf-stage canvas{display:block}
.dxf-layers{width:220px;flex:none;overflow:auto;background:#22272e;border-left:1px solid #444c56;padding:6px 0}
.dxf-layers[hidden]{display:none}
.dxf-layers-head{display:flex;gap:4px;align-items:center;padding:0 8px 6px;color:#adbac7}
.dxf-layers-head span{flex:1}
.dxf-layers-head button{padding:1px 6px}
.dxf-layer{display:flex;align-items:center;gap:6px;padding:2px 8px;cursor:pointer;white-space:nowrap}
.dxf-layer:hover{background:#2d333b}
.dxf-layer i{width:10px;height:10px;flex:none;border:1px solid #545d68}
.dxf-layer span{overflow:hidden;text-overflow:ellipsis}
.dxf-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.dxf-status .dxf-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.dxf-status .dxf-pos{margin-left:auto;font-variant-numeric:tabular-nums}
.dxf-message{position:absolute;inset:0;padding:20px;color:#adbac7;text-align:center}
.dxf-error{position:absolute;inset:0;padding:20px;color:#ff7b72;text-align:center;white-space:pre-wrap;background:#1f2328}
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
        const shell = this._el('div', 'dxf-shell');
        const bar = this._el('div', 'dxf-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.dxf,.dwg,.dgn';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            this.fileId = null;
            this.fileName = f.name;
            clearInterval(this.watch);
            this.hidden.clear();
            let drawing;
            try {
                drawing = fromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
            } catch (err) {
                this._error(`Could not read ${f.name}: ${err.message}`);
                return;
            }
            this._show(drawing, true);
        });
        this.titleEl = this._el('span', 'dxf-title', this.fileName);
        this.layersButton = this._button('Layers', 'Show or hide the list of layers', () => {
            this.layersEl.hidden = !this.layersEl.hidden;
            this.layersButton.classList.toggle('on', !this.layersEl.hidden);
        });
        this.layersButton.classList.add('on');
        this.paperButton = this._button('Paper', 'Draw on white (black lines stay visible) or on dark like AutoCAD\'s model space', () => {
            this.light = !this.light;
            this.paperButton.classList.toggle('on', this.light);
            this.stage.style.background = this.light ? '#ffffff' : '';
            if (this.viewer) this.viewer.SetClearColor(this.light ? 0xffffff : 0x212830);
        });
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a DXF, DWG or DGN file from this computer', () => this.fileInput.click()),
            this.titleEl,
            this._button('Fit', 'Show the whole drawing (0)', () => this._fit()),
            this._button('−', 'Zoom out (−)', () => this._zoomBy(0.5)),
            this._button('+', 'Zoom in (+)', () => this._zoomBy(2)),
            this.layersButton,
            this.paperButton,
        );
        const body = this._el('div', 'dxf-body');
        this.stage = this._el('div', 'dxf-stage');
        this.stage.tabIndex = 0;
        this.messageEl = this._el('div', 'dxf-message', 'Open an AutoCAD DXF or DWG, or a MicroStation DGN drawing.');
        this.stage.appendChild(this.messageEl);
        this.layersEl = this._el('div', 'dxf-layers');
        body.append(this.stage, this.layersEl);
        const status = this._el('div', 'dxf-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'dxf-warn', '');
        this.posEl = this._el('span', 'dxf-pos', '');
        status.append(this.infoEl, this.warnEl, this.posEl);
        shell.append(bar, body, status);
        this.root.appendChild(shell);
        this.stage.addEventListener('keydown', e => {
            if (!this.loaded || e.ctrlKey || e.metaKey || e.altKey) return;
            const keys = { '+': () => this._zoomBy(Math.SQRT2), '=': () => this._zoomBy(Math.SQRT2), '-': () => this._zoomBy(Math.SQRT1_2), '0': () => this._fit() };
            if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
        });
        this.stage.addEventListener('pointerdown', () => this.stage.focus());
        this.stage.addEventListener('pointermove', e => this._showPosition(e));
        this.stage.addEventListener('pointerleave', () => { this.posEl.textContent = ''; });
    }

    async _init() {
        if (!this.fileId || !_ctx) return;
        const file = _ctx.projectFiles[this.fileId];
        if (!file) return;
        let drawing;
        try {
            drawing = await readDrawing(file);
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        await this._show(drawing, true);
        if (drawing.kind !== 'dxf' || file.viewType) return;
        // Follow edits made in the file's editor tab
        this.watch = setInterval(() => {
            const f = _ctx.projectFiles[this.fileId];
            if (this.busy || !f || typeof f.content !== 'string' || f.content === this.source) return;
            this._show({ kind: 'dxf', text: f.content }, false);
        }, 400);
    }

    async _ensureViewer() {
        if (this.viewer) return this.viewer;
        const { three, DxfViewer } = await ensureLibs();
        this.three = three;
        this.viewer = new DxfViewer(this.stage, {
            autoResize: true,
            clearColor: new three.Color(this.light ? 0xffffff : 0x212830),
            sceneOptions: SCENE_OPTIONS,
        });
        if (!this.viewer.HasRenderer()) throw new Error('WebGL is not available');
        return this.viewer;
    }

    // Draw a drawing; fit it to the view, or (while it is edited) keep the view where it was unless
    // the drawing's extent changed
    async _show(drawing, fit) {
        this.busy = true;
        this.titleEl.textContent = this.fileName;
        if (drawing.text !== undefined) this.source = drawing.text;
        const keep = !fit && this.loaded ? this._viewInDrawing() : null;
        const oldBounds = keep && JSON.stringify(this.viewer.GetBounds());
        try {
            const viewer = await this._ensureViewer();
            const dxf = await asciiDxf(drawing);
            try {
                await loadText(viewer, dxf.text);
            } catch (err) {
                // While the file is being edited, put the last drawing back and say what is wrong
                if (this.lastGood && this.lastGood !== dxf.text) {
                    await loadText(viewer, this.lastGood).catch(() => {});
                    this._applyLayers();
                    if (keep) this._restoreView(keep);
                    this.warnEl.textContent = `Not updated: ${err.message}`;
                    return;
                }
                throw err;
            }
            this.lastGood = dxf.text;
            this.loaded = true;
            this.messageEl.remove();
            if (this.errorEl) { this.errorEl.remove(); this.errorEl = null; }
            this._applyLayers();
            this._listLayers();
            if (keep && JSON.stringify(viewer.GetBounds()) === oldBounds) this._restoreView(keep);
            const layers = viewer.GetLayers(true).length;
            const bounds = viewer.GetBounds();
            const size = bounds ? `${fmt(bounds.maxX - bounds.minX)} × ${fmt(bounds.maxY - bounds.minY)}` : 'empty';
            this.infoEl.textContent = `${describeVersion(drawing.kind, dxf.version)}${dxf.by ? ', read by ' + dxf.by : ''} · ${size} · ${layers} layer${layers === 1 ? '' : 's'} drawn`;
            this.warnEl.textContent = [dxf.note, dxf.unread && `${dxf.unread} object${dxf.unread === 1 ? '' : 's'} acad-ts could not read`].filter(Boolean).join('; ');
            if (!bounds) this.warnEl.textContent = 'Nothing in the model space that dxf-viewer draws';
        } catch (err) {
            this._error(`Could not show ${this.fileName}: ${err.message}`);
        } finally {
            this.busy = false;
        }
    }

    // The view's centre in drawing coordinates, and its width
    _viewInDrawing() {
        const cam = this.viewer.GetCamera();
        const o = this.viewer.GetOrigin() || { x: 0, y: 0 };
        return { x: cam.position.x + o.x, y: cam.position.y + o.y, width: (cam.right - cam.left) / cam.zoom };
    }

    _restoreView(v) {
        const o = this.viewer.GetOrigin() || { x: 0, y: 0 };
        this.viewer.SetView({ x: v.x - o.x, y: v.y - o.y }, v.width);
        this.viewer.Render();
    }

    _applyLayers() {
        for (const name of this.hidden) this.viewer.ShowLayer(name, false);
    }

    _listLayers() {
        const layers = this.viewer.GetLayers(true);
        this.layersEl.innerHTML = '';
        const head = this._el('div', 'dxf-layers-head');
        const setAll = show => {
            for (const l of layers) {
                if (show) this.hidden.delete(l.name); else this.hidden.add(l.name);
                this.viewer.ShowLayer(l.name, show);
            }
            for (const box of this.layersEl.querySelectorAll('input')) box.checked = show;
        };
        head.append(this._el('span', null, `Layers (${layers.length})`),
            this._button('All', 'Show every layer', () => setAll(true)),
            this._button('None', 'Hide every layer', () => setAll(false)));
        this.layersEl.appendChild(head);
        for (const l of layers) {
            const row = this._el('label', 'dxf-layer');
            row.title = l.displayName;
            const box = this._el('input');
            box.type = 'checkbox';
            box.checked = !this.hidden.has(l.name);
            box.addEventListener('change', () => {
                if (box.checked) this.hidden.delete(l.name); else this.hidden.add(l.name);
                this.viewer.ShowLayer(l.name, box.checked);
            });
            const swatch = this._el('i');
            swatch.style.background = '#' + (l.color >>> 0).toString(16).padStart(6, '0').slice(-6);
            row.append(box, swatch, this._el('span', null, l.displayName));
            this.layersEl.appendChild(row);
        }
    }

    _fit() {
        if (!this.loaded) return;
        const b = this.viewer.GetBounds(), o = this.viewer.GetOrigin();
        if (!b) return;
        this.viewer.FitView(b.minX - o.x, b.maxX - o.x, b.minY - o.y, b.maxY - o.y);
        this.viewer.Render();
    }

    _zoomBy(factor) {
        if (!this.loaded) return;
        const v = this._viewInDrawing();
        this._restoreView({ ...v, width: v.width / factor });
    }

    // The pointer's place in drawing units
    _showPosition(e) {
        if (!this.loaded || !this.three) return;
        const r = this.stage.getBoundingClientRect();
        const v = new this.three.Vector3((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1, 1)
            .unproject(this.viewer.GetCamera());
        const o = this.viewer.GetOrigin() || { x: 0, y: 0 };
        this.posEl.textContent = `${fmt(v.x + o.x)}, ${fmt(v.y + o.y)}`;
    }

    _error(msg) {
        if (!this.errorEl) this.errorEl = this._el('div', 'dxf-error');
        this.errorEl.textContent = msg;
        this.stage.appendChild(this.errorEl);
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.viewer) this.viewer.Destroy();
        this.viewer = null;
    }
}

function fmt(v) {
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 1 ? v.toFixed(2).replace(/\.?0+$/, '') : +v.toPrecision(3) + '';
}

// Thumbnails: one viewer, off screen, drawing one file at a time
let _thumbViewer = null;
let _thumbQueue = Promise.resolve();

function drawThumbnail(text) {
    const job = _thumbQueue.then(async () => {
        const { three, DxfViewer } = await ensureLibs();
        if (!_thumbViewer) {
            _thumbViewer = new DxfViewer(document.createElement('div'), {
                canvasWidth: THUMB_SIZE, canvasHeight: THUMB_SIZE, preserveDrawingBuffer: true,
                clearColor: new three.Color(0xffffff), sceneOptions: SCENE_OPTIONS,
            });
            if (!_thumbViewer.HasRenderer()) { _thumbViewer = null; throw new Error('WebGL is not available'); }
        }
        await loadText(_thumbViewer, text);
        if (!_thumbViewer.GetBounds()) throw new Error('nothing drawn');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = THUMB_SIZE;
        canvas.getContext('2d').drawImage(_thumbViewer.GetCanvas(), 0, 0, THUMB_SIZE, THUMB_SIZE);
        _thumbViewer.Clear();
        return canvas;
    });
    _thumbQueue = job.catch(() => {});
    return job;
}

registerPlugin({
    id: 'dxf',
    name: 'AutoCAD DXF and DWG, MicroStation DGN drawings',
    components: {
        dxfViewer: DxfComponent,
    },
    toolbarButtons: [
        { label: 'DXF', title: 'Open the DXF / DWG / DGN viewer', menuLabel: 'AutoCAD DXF and DWG, MicroStation DGN drawings' },
    ],
    thumbnailRenderers: [{
        canHandle: file => DXF_NAME_RE.test(file.name) && !(file.size > MAX_THUMB_BYTES),
        async render(file, container) {
            const dxf = await asciiDxf(await readDrawing(file));
            const canvas = await drawThumbnail(dxf.text);
            canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#ffffff';
            container.innerHTML = '';
            container.appendChild(canvas);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { isDgn };
