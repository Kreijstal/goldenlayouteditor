// --- Hangul Word Processor documents (.hwp, .hwpx) ---
// Shows HWP 5.0 (OLE compound file), HWP 3.x and HWPX (zipped OWPML) documents
// page by page, as the Hancom word processor lays them out: text with its fonts
// and sizes, tables, pictures, equations, headers and footers; with page
// navigation and zoom, and a password prompt for encrypted documents. Read-only.
// Rendering is rhwp's (github.com/edwardkim/rhwp, the engine of nextcloud-hwp),
// built to WebAssembly outside this repo (@kreijstal/rhwp-wasm on jsDelivr). Only this
// shell is in the bundle: the viewer (public/hwp-viewer/) and the engine are
// loaded when a document is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('HWP');
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/hwp-viewer/hwp-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class HwpComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="hwp-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="hwp-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="hwp-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.hwp-status');
        this.host = this.root.querySelector('.hwp-host');
        this.root.querySelector('.hwp-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) {
            container.on('destroy', () => { if (this.viewer) this.viewer.destroy(); });
            container.on('resize', () => { if (this.viewer) this.viewer.resize(); });
        }
        this._init();
    }

    // The file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) throw new Error('HWP documents need the server workspace');
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
            this.host.textContent = '';
            this.viewer = mod.mountHwpViewer(this.host, {
                bytes,
                name: this.fileData.name,
                onStatus: (text, isError) => this._status(text, isError),
            });
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the document: ' + err.message);
        }
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
    id: 'hwp',
    name: 'Hangul Word Processor document',
    components: {
        hwpViewer: HwpComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
