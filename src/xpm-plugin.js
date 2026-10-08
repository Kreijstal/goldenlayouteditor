// --- X bitmaps (.xbm) and pixmaps (.xpm) ---
// X11's icons and cursors as C source: an XBM is two #defines (the width and
// height, a hotspot perhaps) and a char array of bits, a row's bits padded to a
// byte, the lowest bit leftmost; an XPM (XPM3) a char* array of strings, the
// first "width height colors chars-per-pixel", then a line per color (a key,
// c / m / g / s and an X color name, #rgb or None for transparent), then a
// string per row. The text stays the file's, in the editor; this viewer shows
// the picture, read by ImageMagick (magick-wasm, the copy src/pict.js loads)
// and blown up with square pixels on a checkerboard (what an XPM leaves None is
// see-through), drawn again as the text is edited. Also draws thumbnails in the
// file browser's grid. Not read by this ImageMagick: X10 bitmaps (an array of
// unsigned shorts), XPM2 ("! XPM2") and XPM1; a broken file keeps the last
// picture and says what ImageMagick said.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
const { magick } = require('./pict');

const XPM_NAME_RE = /\.(xbm|xpm)$/i;
const MAX_ZOOM = 64;
let _ctx = null;

// 'xbm' or 'xpm' by the file's name
const kindOf = name => (/\.xbm$/i.test(name || '') ? 'xbm' : 'xpm');

function workspaceUrl(rel) {
    return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
}

async function readText(file) {
    // (a file the browser lists but hasn't read yet holds '' until then)
    if (typeof file.content === 'string' && !file.lazy) return file.content;
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await workspaceUrl(_ctx.getRelativePath(file.id)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
}

// The XBM or XPM text as a PNG: { png: Uint8Array, width, height, label }
async function xpmDecode(text, kind) {
    const { ImageMagick, MagickFormat } = await magick();
    const bytes = new TextEncoder().encode(text);
    return ImageMagick.read(bytes, kind === 'xbm' ? MagickFormat.Xbm : MagickFormat.Xpm, image => {
        const { width, height, hasAlpha } = image;
        const png = image.write(MagickFormat.Png, data => data.slice());
        const label = kind === 'xbm'
            ? `X bitmap, ${width}×${height}`
            : `X pixmap, ${width}×${height}, ${image.colormapSize > 0 ? image.colormapSize + ' colors' : 'direct color'}${hasAlpha ? ', transparent where None' : ''}`;
        return { png, width, height, label };
    });
}

class XpmComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'picture.xpm';
        this.source = null;
        this.picture = null; // { url, width, height, label }
        this.zoom = 0; // pixels a pixel; 0: fitted
        this.root = container.element;
        this.root.classList.add('xpm-root');
        XpmComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (XpmComponent._styled) return;
        XpmComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.xpm-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.xpm-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.xpm-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.xpm-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.xpm-root button:hover{background:#444c56}
.xpm-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xpm-zoom{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
.xpm-stage{overflow:auto;min-height:0;display:flex;outline:none}
.xpm-stage>img{margin:auto;flex:none;image-rendering:pixelated;background-color:#fff;
 background-image:conic-gradient(#ccc 25%,#fff 0 50%,#ccc 0 75%,#fff 0);background-size:16px 16px}
.xpm-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.xpm-status .xpm-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.xpm-error{padding:20px;color:#cf222e;text-align:center;white-space:pre-wrap;margin:auto}
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
        const shell = this._el('div', 'xpm-shell');
        const bar = this._el('div', 'xpm-toolbar');
        this.titleEl = this._el('span', 'xpm-title', this.fileName);
        this.zoomEl = this._el('span', 'xpm-zoom', '');
        bar.append(
            this.titleEl,
            this._button('Fit', 'Fit the picture to the view (0)', () => this._setZoom(0)),
            this._button('−', 'Zoom out (−)', () => this._setZoom(Math.max(1, this._scale() / 2))),
            this.zoomEl,
            this._button('+', 'Zoom in (+)', () => this._setZoom(Math.min(MAX_ZOOM, this._scale() * 2))),
        );
        this.stage = this._el('div', 'xpm-stage');
        this.stage.tabIndex = 0;
        this.stage.addEventListener('keydown', e => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const keys = {
                '+': () => this._setZoom(Math.min(MAX_ZOOM, this._scale() * 2)), '=': () => this._setZoom(Math.min(MAX_ZOOM, this._scale() * 2)),
                '-': () => this._setZoom(Math.max(1, this._scale() / 2)), '0': () => this._setZoom(0),
            };
            if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
        });
        this.img = this._el('img');
        this.img.alt = this.fileName;
        const status = this._el('div', 'xpm-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'xpm-warn', '');
        status.append(this.infoEl, this.warnEl);
        shell.append(bar, this.stage, status);
        this.root.appendChild(shell);
        this.resizeObserver = new ResizeObserver(() => { if (!this.zoom) this._apply(); });
        this.resizeObserver.observe(this.stage);
    }

    async _init() {
        if (!this.fileId || !_ctx) return;
        const file = _ctx.projectFiles[this.fileId];
        if (!file) return;
        try {
            await this._show(await readText(file));
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        // Follow edits made in the file's editor tab
        this.watch = setInterval(() => {
            const f = _ctx.projectFiles[this.fileId];
            if (f && typeof f.content === 'string' && f.content !== this.source) this._show(f.content);
        }, 400);
    }

    async _show(text) {
        this.source = text;
        const seq = this.seq = (this.seq || 0) + 1;
        let r;
        try {
            r = await xpmDecode(text, kindOf(this.fileName));
        } catch (err) {
            if (seq !== this.seq) return;
            // While the file is being edited, keep the last picture and say what is wrong
            if (this.picture) { this.warnEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not show ${this.fileName}: ${err.message}`);
            return;
        }
        if (seq !== this.seq) return;
        if (this.picture) URL.revokeObjectURL(this.picture.url);
        this.picture = { url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), width: r.width, height: r.height, label: r.label };
        this.img.src = this.picture.url;
        if (!this.img.isConnected) { this.stage.innerHTML = ''; this.stage.appendChild(this.img); }
        this.infoEl.textContent = r.label;
        this.warnEl.textContent = '';
        this._apply();
    }

    // Pixels a picture pixel: the zoom chosen, or the largest whole number that fits
    _scale() {
        if (this.zoom) return this.zoom;
        if (!this.picture) return 1;
        const w = this.stage.clientWidth - 16, h = this.stage.clientHeight - 16;
        return Math.max(1, Math.min(MAX_ZOOM, Math.floor(Math.min(w / this.picture.width, h / this.picture.height))));
    }

    _setZoom(z) {
        this.zoom = z;
        this._apply();
    }

    _apply() {
        if (!this.picture) return;
        const s = this._scale();
        this.img.style.width = this.picture.width * s + 'px';
        this.img.style.height = this.picture.height * s + 'px';
        this.zoomEl.textContent = `${s}×${this.zoom ? '' : ' (fit)'}`;
    }

    _error(msg) {
        this.stage.innerHTML = '';
        this.stage.appendChild(this._el('div', 'xpm-error', msg));
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.picture) URL.revokeObjectURL(this.picture.url);
    }
}

registerPlugin({
    id: 'xpm',
    name: 'X bitmaps and pixmaps',
    components: {
        xpmViewer: XpmComponent,
    },
    thumbnailRenderers: [{
        canHandle: file => XPM_NAME_RE.test(file.name) && !file.viewType,
        async render(file, container) {
            const r = await xpmDecode(await readText(file), kindOf(file.name));
            const img = document.createElement('img');
            img.src = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }));
            img.title = r.label;
            img.onload = () => URL.revokeObjectURL(img.src);
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;image-rendering:pixelated';
            container.innerHTML = '';
            container.appendChild(img);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { xpmDecode };
