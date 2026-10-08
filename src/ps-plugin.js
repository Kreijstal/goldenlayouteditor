// --- PostScript viewer ---
// PostScript (.ps) and Encapsulated PostScript (.eps, .epsf, .epsi; also a
// DOS EPS, its binary header and TIFF or WMF preview before the PostScript)
// drawn by Ghostscript, as WebAssembly, in a worker (public/ps-worker.js,
// loaded from jsDelivr on first use): each page the program shows becomes a
// PNG, with buttons (or PageUp / PageDown) to turn them. An EPS is cropped to
// its bounding box and drawn big enough to fill the view. + / − (or ctrl and
// the wheel) zooms, 0 fits. The status bar gives the page's size, and what
// Ghostscript said went wrong (an error in the program keeps the pages it
// showed before). The pages follow the file's text as it is edited. Also draws
// thumbnails in the file browser's grid.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const PS_NAME_RE = /\.(ps|eps|epsf|epsi)$/i;
// A page at 144 dpi, twice what a PostScript point is on screen
const PAGE_RESOLUTION = 144;
// An EPS's long side in pixels, and how fine it may be drawn for that
const EPS_PIXELS = 1600, MIN_RESOLUTION = 18, MAX_RESOLUTION = 1200;
const THUMB_PIXELS = 256;
// Pages drawn at most (each kept as a PNG)
const MAX_PAGES = 500;
const MIN_ZOOM = 1 / 16, MAX_ZOOM = 16;
let _ctx = null;

// A DOS EPS starts C5 D0 D3 C6, then where its PostScript is and how long
function isDosEps(bytes) {
    return bytes.length >= 30 && bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6;
}

function latin1(bytes, start, end) {
    let s = '';
    for (let i = start; i < end; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
    return s;
}

// What the file is, from its first bytes: { eps, dos, bbox: [x0, y0, x1, y1] | null }
// (an EPS says so in its first line, %!PS-Adobe-n.n EPSF-n.n; its bounding box
// is a %%BoundingBox comment in the header, or at the end if it says (atend))
function describe(bytes) {
    const dos = isDosEps(bytes);
    let start = 0, end = bytes.length;
    if (dos) {
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        start = Math.min(bytes.length, v.getUint32(4, true));
        end = Math.min(bytes.length, start + v.getUint32(8, true));
    }
    const head = latin1(bytes, start, Math.min(end, start + 65536));
    const eps = dos || /^[\s\x04]*%!PS-Adobe-[\d.]+\s+EPSF/.test(head);
    const box = text => {
        const m = /%%BoundingBox:[ \t]*(-?[\d.]+)[ \t]+(-?[\d.]+)[ \t]+(-?[\d.]+)[ \t]+(-?[\d.]+)/.exec(text);
        return m ? m.slice(1, 5).map(Number) : null;
    };
    let bbox = box(head);
    if (!bbox && /%%BoundingBox:\s*\(atend\)/.test(head)) bbox = box(latin1(bytes, Math.max(start, end - 65536), end));
    if (bbox && (bbox[2] <= bbox[0] || bbox[3] <= bbox[1])) bbox = null;
    return { eps, dos, bbox };
}

// A PostScript file by its name, and (once read as text) its text if it is PostScript
function isPostScriptFile(f) {
    if (!PS_NAME_RE.test(f.name)) return false;
    // binary: a DOS EPS (or PostScript with binary data in it)
    if (f.viewType) return true;
    if (typeof f.content !== 'string' || f.lazy) return true;
    // (after a printer's escapes, PJL, a ^D...)
    return f.content.slice(0, 4096).includes('%!');
}

let worker = null;
let nextId = 1;
const pending = new Map();

// The PostScript program in bytes drawn: { pages: [Uint8Array (PNG)], log, code }
function ghostscript(bytes, eps, resolution, lastPage) {
    if (!worker) {
        worker = new Worker('/ps-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'Ghostscript failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer, eps, resolution, lastPage }, [copy.buffer]);
    });
}

// How fine to draw: an EPS (its bounding box in points) at `pixels` on its long side, a page at `pageRes`
function resolutionFor(info, pixels, pageRes) {
    if (!info.eps || !info.bbox) return pageRes;
    const [x0, y0, x1, y1] = info.bbox;
    const r = pixels * 72 / Math.max(x1 - x0, y1 - y0);
    return Math.round(Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, r)));
}

// What Ghostscript said went wrong, in a line: "Error: /undefined in foo"...
function errorLine(log) {
    const m = /^(Error: .*|.*Unrecoverable error.*|.*\*\*\*\*.*)$/m.exec(log || '');
    return m ? m[1].trim() : '';
}

function workspaceUrl(rel) {
    return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
}

// The text as bytes again, in the encoding it was read in (PostScript is mostly
// ASCII, its strings often Latin-1)
function encode(text, encoding) {
    const enc = (encoding || 'utf-8').toLowerCase();
    if (enc === 'utf-8' || enc === 'utf8') return new TextEncoder().encode(text);
    let table = null;
    try {
        const all = new Uint8Array(256).map((_, i) => i);
        const chars = new TextDecoder(enc).decode(all);
        if (chars.length === 256) { table = new Map(); for (let i = 255; i >= 0; i--) table.set(chars.charCodeAt(i), i); }
    } catch (_) { /* not one this browser decodes */ }
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[i] = table && table.has(c) ? table.get(c) : c < 256 ? c : 0x3f;
    }
    return out;
}

// The file's bytes: its text as edited, or (a binary one, a DOS EPS, or one not read yet) as stored
async function readBytes(file) {
    if (typeof file.content === 'string' && !file.lazy && !file.viewType) return encode(file.content, file.encoding);
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await workspaceUrl(_ctx.getRelativePath(file.id)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

class PostScriptComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'document.ps';
        this.pages = []; // blob: URLs
        this.page = 0;
        this.zoom = null; // null: fit
        this.source = null;
        this.root = container.element;
        this.root.classList.add('ps-root');
        PostScriptComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (PostScriptComponent._styled) return;
        PostScriptComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.ps-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.ps-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.ps-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.ps-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.ps-root button:hover:not(:disabled){background:#444c56}
.ps-root button:disabled{opacity:.45;cursor:default}
.ps-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-pageno,.ps-zoom{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.ps-stage{overflow:auto;min-height:0;outline:none;background:#525659;display:flex}
.ps-stage>img{margin:auto;display:block;background:#ffffff;box-shadow:0 1px 6px rgba(0,0,0,.5);image-rendering:auto}
.ps-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.ps-status .ps-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.ps-message{margin:auto;padding:20px;color:#adbac7;text-align:center}
.ps-error{margin:auto;padding:20px;color:#ff7b72;text-align:center;white-space:pre-wrap}
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
        const shell = this._el('div', 'ps-shell');
        const bar = this._el('div', 'ps-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.ps,.eps,.epsf,.epsi';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            this.fileId = null;
            this.fileName = f.name;
            const bytes = new Uint8Array(await f.arrayBuffer());
            this._queue(() => this._show(bytes, true));
        });
        this.titleEl = this._el('span', 'ps-title', this.fileName);
        this.prevBtn = this._button('◀', 'Previous page (PageUp)', () => this._go(this.page - 1));
        this.pageEl = this._el('span', 'ps-pageno', '');
        this.nextBtn = this._button('▶', 'Next page (PageDown)', () => this._go(this.page + 1));
        this.zoomEl = this._el('span', 'ps-zoom', '');
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a PostScript or EPS file from this computer', () => this.fileInput.click()),
            this.titleEl,
            this.prevBtn, this.pageEl, this.nextBtn,
            this._button('Fit', 'Show the whole page (0)', () => this._setZoom(null)),
            this._button('−', 'Zoom out (−)', () => this._zoomBy(Math.SQRT1_2)),
            this.zoomEl,
            this._button('+', 'Zoom in (+)', () => this._zoomBy(Math.SQRT2)),
        );
        this.stage = this._el('div', 'ps-stage');
        this.stage.tabIndex = 0;
        this.stage.appendChild(this._el('div', 'ps-message', 'Open a PostScript or EPS file.'));
        this.img = this._el('img');
        this.img.alt = '';
        this.img.addEventListener('load', () => this._apply());
        const status = this._el('div', 'ps-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'ps-warn', '');
        status.append(this.infoEl, this.warnEl);
        shell.append(bar, this.stage, status);
        this.root.appendChild(shell);
        this.stage.addEventListener('wheel', e => {
            if (!e.ctrlKey || !this.pages.length) return;
            e.preventDefault();
            this._zoomBy(2 ** (-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)));
        }, { passive: false });
        this.stage.addEventListener('keydown', e => {
            if (!this.pages.length || e.ctrlKey || e.metaKey || e.altKey) return;
            const keys = {
                '+': () => this._zoomBy(Math.SQRT2), '=': () => this._zoomBy(Math.SQRT2), '-': () => this._zoomBy(Math.SQRT1_2),
                '0': () => this._setZoom(null),
                PageUp: () => this._go(this.page - 1), PageDown: () => this._go(this.page + 1),
                Home: () => this._go(0), End: () => this._go(this.pages.length - 1),
            };
            if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
        });
        this.resizeObserver = new ResizeObserver(() => this._apply());
        this.resizeObserver.observe(this.stage);
        this._updateBar();
    }

    async _init() {
        if (!this.fileId || !_ctx) return;
        const file = _ctx.projectFiles[this.fileId];
        if (!file) return;
        if (typeof file.content === 'string' && !file.lazy && !file.viewType) this.source = file.content;
        let bytes;
        try {
            bytes = await readBytes(file);
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        this._queue(() => this._show(bytes, true));
        // Follow edits made in the file's editor tab
        this.watch = setInterval(() => {
            const f = _ctx.projectFiles[this.fileId];
            if (!f || typeof f.content !== 'string' || f.lazy || f.viewType || f.content === this.source) return;
            this.source = f.content;
            this._queue(() => this._show(encode(f.content, f.encoding), false));
        }, 400);
    }

    // One Ghostscript run at a time; while one runs, only the latest edit waits
    _queue(job) {
        if (this.running) { this.next = job; return; }
        this.running = true;
        job().finally(() => {
            this.running = false;
            const next = this.next;
            this.next = null;
            if (next) this._queue(next);
        });
    }

    async _show(bytes, first) {
        this.titleEl.textContent = this.fileName;
        const info = describe(bytes);
        const resolution = resolutionFor(info, EPS_PIXELS, PAGE_RESOLUTION);
        if (first && !this.pages.length) this.stage.replaceChildren(this._el('div', 'ps-message', 'Ghostscript is drawing the pages…'));
        let r;
        try {
            r = await ghostscript(bytes, info.eps, resolution, MAX_PAGES);
        } catch (err) {
            // While the file is being edited, keep the last pages and say what is wrong
            if (this.pages.length) { this.warnEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not draw ${this.fileName}: ${err.message}`);
            return;
        }
        const problem = errorLine(r.log) || (r.code ? `Ghostscript stopped (code ${r.code})` : '');
        if (!r.pages.length) {
            if (this.pages.length && !first) { this.warnEl.textContent = 'Not updated: ' + (problem || 'no page shown'); return; }
            this._error(`${this.fileName}: ` + (problem ? `Ghostscript stopped: ${problem}` : 'the program shows no page'));
            return;
        }
        for (const u of this.pages) URL.revokeObjectURL(u);
        this.pages = r.pages.map(p => URL.createObjectURL(new Blob([p], { type: 'image/png' })));
        this.resolution = resolution;
        if (first) this.page = 0;
        this.page = Math.min(this.page, this.pages.length - 1);
        const kind = info.dos ? 'DOS EPS (with a preview)' : info.eps ? 'EPS' : 'PostScript';
        this.kind = kind + (info.eps && !info.bbox ? ', no bounding box' : '');
        const n = r.pages.length;
        this.warnEl.textContent = n >= MAX_PAGES ? `only the first ${MAX_PAGES} pages are drawn`
            : problem ? `Ghostscript stopped after ${n} page${n > 1 ? 's' : ''}: ${problem}` : '';
        if (!this.img.isConnected) this.stage.replaceChildren(this.img);
        this._go(this.page);
    }

    _go(n) {
        if (!this.pages.length) return;
        this.page = Math.max(0, Math.min(this.pages.length - 1, n));
        if (this.img.src !== this.pages[this.page]) this.img.src = this.pages[this.page];
        this._updateBar();
    }

    _updateBar() {
        const n = this.pages.length;
        this.pageEl.textContent = n ? `${this.page + 1} / ${n}` : '';
        this.prevBtn.disabled = !n || this.page === 0;
        this.nextBtn.disabled = !n || this.page >= n - 1;
        [this.prevBtn, this.pageEl, this.nextBtn].forEach(e => { e.hidden = n < 2; });
    }

    _fitZoom() {
        const w = this.img.naturalWidth, h = this.img.naturalHeight;
        if (!w || !h) return 1;
        const pad = 16;
        return Math.min((this.stage.clientWidth - 2 * pad) / w, (this.stage.clientHeight - 2 * pad) / h);
    }

    _setZoom(z) {
        this.zoom = z === null ? null : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
        this._apply();
    }

    _zoomBy(factor) {
        this._setZoom((this.zoom || this._fitZoom()) * factor);
    }

    // The page at the zoom (fitted unless zoomed), and its size in the status bar
    _apply() {
        const w = this.img.naturalWidth, h = this.img.naturalHeight;
        if (!w || !h || !this.img.isConnected) return;
        const z = this.zoom || this._fitZoom();
        this.img.style.width = Math.max(1, Math.round(w * z)) + 'px';
        this.img.style.height = Math.max(1, Math.round(h * z)) + 'px';
        // Zoom relative to the page at its real size (an inch is 96 CSS pixels)
        const pct = z * this.resolution / 96 * 100;
        this.zoomEl.textContent = (pct >= 100 ? Math.round(pct) : +pct.toPrecision(3)) + '%';
        const pt = v => Math.round(v * 72 / this.resolution);
        const mm = v => (v * 25.4 / this.resolution).toFixed(1);
        this.infoEl.textContent = `${this.kind}: ${pt(w)} × ${pt(h)} pt (${mm(w)} × ${mm(h)} mm)`;
    }

    _error(msg) {
        for (const u of this.pages) URL.revokeObjectURL(u);
        this.pages = [];
        this._updateBar();
        this.stage.replaceChildren(this._el('div', 'ps-error', msg));
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        for (const u of this.pages) URL.revokeObjectURL(u);
    }
}

registerPlugin({
    id: 'postscript',
    name: 'PostScript and EPS',
    components: {
        psViewer: PostScriptComponent,
    },
    toolbarButtons: [
        { label: 'PS', title: 'Open the PostScript viewer', menuLabel: 'PostScript and EPS files as pages' },
    ],
    thumbnailRenderers: [{
        canHandle: file => PS_NAME_RE.test(file.name),
        async render(file, container) {
            const bytes = await readBytes(file);
            const info = describe(bytes);
            // (the file's icon stays for one that isn't PostScript)
            if (!info.dos && !latin1(bytes, 0, Math.min(bytes.length, 4096)).includes('%!')) throw new Error('not PostScript');
            // the first page, a page about as big as the thumbnail
            const r = await ghostscript(bytes, info.eps, resolutionFor(info, THUMB_PIXELS, Math.round(THUMB_PIXELS * 72 / 792)), 1);
            if (!r.pages.length) throw new Error(errorLine(r.log) || 'no page shown');
            const img = document.createElement('img');
            img.src = URL.createObjectURL(new Blob([r.pages[0]], { type: 'image/png' }));
            img.onload = img.onerror = () => URL.revokeObjectURL(img.src);
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;background:#ffffff';
            container.innerHTML = '';
            container.appendChild(img);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { isPostScriptFile };
