// --- Paint Shop Pro thumbnail caches (.jbf) ---
// Opens the pspbrwse.jbf files the Jasc Paint Shop Pro / Animation Shop file
// browser leaves in each folder: the cache's header (version, folder, count)
// and every thumbnail with its file name, size, dimensions, date and format;
// one can be shown larger and saved. Read-only. Only this shell is in the
// bundle: the reader and viewer (public/jbf-viewer/, a port of jbfinspect) are
// loaded when a cache is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('JBF');
const JBF_RE = /\.jbf$/i;
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/jbf-viewer/jbf-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class JbfComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="jbf-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="jbf-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="jbf-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.jbf-status');
        this.host = this.root.querySelector('.jbf-host');
        this.root.querySelector('.jbf-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) container.on('destroy', () => { if (this.viewer) this.viewer.destroy(); });
        this._init();
    }

    // The file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) throw new Error('thumbnail caches need the server workspace');
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
            this.host.textContent = '';
            this.viewer = mod.mountJbfViewer(this.host, { bytes, name: this.fileData.name });
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the thumbnail cache: ' + err.message);
        }
        const info = this.viewer.info;
        this._status(info.version ? `PSP ${info.psp} cache · ${info.entries} images · read-only` : 'Not a thumbnail cache', !!info.error);
        log.log(`Opened ${this.fileData.name}: v${info.version}, ${info.entries}/${info.count} entries${info.error ? ', ' + info.error : ''}`);
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
    id: 'jbf',
    name: 'Paint Shop Pro thumbnail cache',
    components: {
        jbfViewer: JbfComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
