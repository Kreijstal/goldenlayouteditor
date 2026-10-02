// --- Compiled HTML Help (.chm) ---
// Opens Microsoft help files: the contents tree, the keyword index with a
// search, the topics with back and forward (links between them stay in the
// viewer), and the files inside with their sizes, each viewable or savable.
// Pages show in a sandboxed iframe with everything they reference taken from
// the archive; no scripts and no network unless switched on. Read-only. Only
// this shell is in the bundle: the reader (a JavaScript port of the LZX
// decompressor) and viewer (public/chm-viewer/) are loaded when a file is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('CHM');
const CHM_RE = /\.chm$/i;
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/chm-viewer/chm-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class ChmComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="chm-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="chm-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="chm-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.chm-status');
        this.host = this.root.querySelector('.chm-host');
        this.root.querySelector('.chm-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) container.on('destroy', () => { this.destroyed = true; if (this.viewer) this.viewer.destroy(); });
        this._init();
    }

    // The file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) throw new Error('help files need the server workspace');
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
            if (this.destroyed) return;
            this.host.textContent = '';
            this.viewer = mod.mountChmViewer(this.host, { bytes, name: this.fileData.name });
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the help file: ' + err.message);
        }
        const info = this.viewer.info;
        this._status(`${info.files} files · read-only`, info.warnings.length > 0);
        log.log(`Opened ${this.fileData.name}: ${info.files} files${info.title ? ', ' + info.title : ''}`);
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this.host.innerHTML = '<div style="padding:20px;color:#a33"></div>';
        this.host.firstChild.textContent = message;
    }
}

registerPlugin({
    id: 'chm',
    name: 'Compiled HTML Help',
    components: {
        chmViewer: ChmComponent,
    },
    contextMenuItems: [{
        label: 'Open as help file (CHM)',
        canHandle: (fileName) => CHM_RE.test(fileName || ''),
        action: (fileId) => {
            const file = _ctx && _ctx.projectFiles[fileId];
            if (file) _ctx.openEditorTab('chmViewer', { fileId }, `${file.name} [help]`, 'chm-' + fileId);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
