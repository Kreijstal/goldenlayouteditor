// --- Word Document Plugin ---
// Shows .docx files page by page with docx-preview (github.com/VolodymyrBaydalka/docxjs),
// the renderer docxjs-editor previews with: headers, footers, footnotes, comments
// and tracked changes included. Read-only. The library (and JSZip, which it needs)
// is loaded from the server on first use.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { ensureArchiveAccess } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');

const log = createLogger('Docx');
const DOCX_RE = /\.(docx|docm|dotx|dotm)$/i;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

let _lib = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

function ensureLib() {
    if (!_lib) {
        _lib = (async () => {
            if (!window.JSZip) await loadScript('https://esm.sh/jszip@3.10.2/dist/jszip.min.js?raw');
            if (!window.docx || !window.docx.renderAsync) await loadScript('https://esm.sh/docx-preview@0.4.1/dist/docx-preview.min.js?raw');
            return window.docx;
        })().catch(err => { _lib = null; throw err; });
    }
    return _lib;
}

// Inside the shadow root, around what docx-preview draws
const SHADOW_CSS = `
:host{display:block}
.docx-scroll{position:absolute;inset:0;overflow:auto;background:#808080}
.docx-zoom{transform-origin:0 0;width:max-content;min-width:100%}
.docx-zoom > .docx-wrapper{background:transparent;padding:20px 0}
.docx-zoom > .docx-wrapper > section{box-shadow:0 1px 6px rgba(0,0,0,.45);margin:0 auto 20px}
`;

class DocxComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = DocxComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.zoom = this.state.zoom || 'fit';

        this.root = container.element;
        this.root.classList.add('docx-plugin-root');
        this._installStyles();
        this.root.innerHTML = `
<div class="docx-shell">
  <div class="docx-toolbar">
    <span class="docx-title"></span>
    <button type="button" data-zoom="-" title="Zoom out">−</button>
    <button type="button" class="docx-zoom-label" data-zoom="fit" title="Fit width">Fit</button>
    <button type="button" data-zoom="+" title="Zoom in">+</button>
    <span class="docx-status"></span>
  </div>
  <div class="docx-host"><div class="docx-message">Loading…</div></div>
</div>`;
        this.titleEl = this.root.querySelector('.docx-title');
        this.statusEl = this.root.querySelector('.docx-status');
        this.zoomLabel = this.root.querySelector('.docx-zoom-label');
        this.host = this.root.querySelector('.docx-host');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        for (const b of this.root.querySelectorAll('[data-zoom]')) b.onclick = () => this._zoomBy(b.dataset.zoom);
        this.host.addEventListener('wheel', e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            this._zoomBy(e.deltaY < 0 ? '+' : '-');
        }, { passive: false });
        this._resizeObserver = new ResizeObserver(() => { if (this.zoom === 'fit') this._applyZoom(); });
        this._resizeObserver.observe(this.host);
        if (container.on) container.on('destroy', () => {
            this._resizeObserver.disconnect();
            for (const st of this.fontStyles || []) st.remove();
        });
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (DocxComponent._styleInstalled) return;
        DocxComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.docx-plugin-root{height:100%;overflow:hidden;background:#808080}
.docx-shell{display:flex;flex-direction:column;height:100%}
.docx-toolbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden}
.docx-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;margin-right:6px}
.docx-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 9px;font:inherit;cursor:pointer;min-width:28px}
.docx-toolbar button:hover{background:#444c56}
.docx-zoom-label{min-width:52px!important}
.docx-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.docx-host{position:relative;flex:1;min-height:0}
.docx-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;background:#fff;color:#57606a;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.docx-message.error{color:#b42318}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + this.ctx.getRelativePath(this.fileId);
    }

    async _init() {
        const path = this._path();
        if (!path) return this._fail('Word documents need the server workspace.');
        let lib, bytes;
        try {
            if (insideArchive(path)) await ensureArchiveAccess();
            [lib, bytes] = await Promise.all([ensureLib(), fetch('/workspace-file?path=' + encodeURIComponent(path)).then(async r => {
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                return r.arrayBuffer();
            })]);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the document: ' + err.message);
        }
        // Its own shadow root: the document's styles and the editor's don't meet
        const holder = document.createElement('div');
        const shadow = holder.attachShadow({ mode: 'open' });
        const css = document.createElement('style');
        css.textContent = SHADOW_CSS;
        const styles = document.createElement('div');
        this.scroller = document.createElement('div');
        this.scroller.className = 'docx-scroll';
        this.page = document.createElement('div');
        this.page.className = 'docx-zoom';
        this.scroller.appendChild(this.page);
        shadow.append(css, styles, this.scroller);
        try {
            await lib.renderAsync(bytes, this.page, styles, {
                className: 'docx',
                inWrapper: true,
                breakPages: true,
                ignoreLastRenderedPageBreak: true,
                renderHeaders: true,
                renderFooters: true,
                renderFootnotes: true,
                renderEndnotes: true,
                renderComments: true,
                renderChanges: true,
                experimental: true,
                useBase64URL: false,
            });
        } catch (err) {
            log.error('Render failed:', err);
            return this._fail('Could not read the document: ' + err.message);
        }
        // Fonts embedded in the document: @font-face does nothing inside a shadow root
        this.fontStyles = [];
        for (const st of styles.querySelectorAll('style')) {
            if (!/@font-face/.test(st.textContent)) continue;
            const copy = document.createElement('style');
            copy.textContent = st.textContent.match(/@font-face\s*\{[^}]*\}/g).join('\n');
            document.head.appendChild(copy);
            this.fontStyles.push(copy);
        }
        this.host.textContent = '';
        holder.style.cssText = 'position:absolute;inset:0';
        this.host.appendChild(holder);
        const pages = this.page.querySelectorAll('.docx-wrapper > section').length;
        this.statusEl.textContent = `${pages} page${pages === 1 ? '' : 's'} · read-only`;
        this._applyZoom();
        log.log(`Opened ${path}: ${pages} page(s)`);
    }

    // The widest page, unscaled
    _pageWidth() {
        let w = 0;
        for (const s of this.page.querySelectorAll('.docx-wrapper > section')) w = Math.max(w, s.offsetWidth);
        return w || 816;
    }

    _scale() {
        if (this.zoom !== 'fit') return this.zoom;
        const avail = this.host.clientWidth - 40;
        return Math.max(0.25, Math.min(2, avail / this._pageWidth()));
    }

    _applyZoom() {
        if (!this.page) return;
        const scale = this._scale();
        // CSS zoom keeps the scroll size right, unlike a transform
        this.page.style.zoom = scale;
        this.zoomLabel.textContent = this.zoom === 'fit' ? 'Fit' : Math.round(scale * 100) + '%';
    }

    _zoomBy(dir) {
        if (dir === 'fit') {
            this.zoom = 'fit';
        } else {
            const now = this._scale();
            const next = dir === '+' ? ZOOM_STEPS.find(z => z > now + 0.001) : [...ZOOM_STEPS].reverse().find(z => z < now - 0.001);
            if (next === undefined) return;
            this.zoom = next;
        }
        this.state.zoom = this.zoom;
        if (this.container.setState) this.container.setState(this.state);
        this._applyZoom();
    }

    _fail(message) {
        this.host.innerHTML = '<div class="docx-message error"></div>';
        this.host.firstChild.textContent = message;
    }
}

registerPlugin({
    id: 'docx',
    name: 'Word documents (docx-preview)',
    components: {
        docxViewer: DocxComponent,
    },
    contextMenuItems: [{
        label: 'Open as Word document',
        canHandle: (fileName) => DOCX_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = DocxComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('docxViewer', { fileId }, `${file.name} [docx]`, 'docx-' + fileId);
        },
    }],
    init(ctx) {
        DocxComponent._ctx = ctx;
    },
});
