// --- MHTML web archives (.mht, .mhtml) ---
// Opens pages saved as a single file by Chrome/Edge ("Webpage, Single File"),
// Internet Explorer or Word: the page rebuilt from the archive's parts in a
// sandboxed frame (no scripts; nothing from the network unless "Load remote
// content" is switched on), the subject, date and address it was saved from,
// and the list of parts, each of which can be viewed or saved. Read-only.
// Only this shell is in the bundle: the reader and viewer (public/mht-viewer/)
// are loaded when an archive is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('MHT');
const MHT_RE = /\.(mht|mhtml)$/i;
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/mht-viewer/mht-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class MhtComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="mht-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="mht-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="mht-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.mht-status');
        this.host = this.root.querySelector('.mht-host');
        this.root.querySelector('.mht-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) container.on('destroy', () => { if (this.viewer) this.viewer.destroy(); this.viewer = null; });
        this._init();
    }

    // The file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) {
            // A file dropped into an in-memory project is kept as text; archives are 7-bit text as a rule
            if (typeof file.content === 'string' && file.content) return new TextEncoder().encode(file.content);
            throw new Error('web archives need the server workspace');
        }
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
            this.host.textContent = '';
            this.viewer = mod.mountMhtViewer(this.host, { bytes, name: this.fileData.name });
        } catch (err) {
            log.error('Load failed:', err);
            this._status('Not opened', true);
            return this._fail('Could not open the web archive: ' + err.message);
        }
        const info = this.viewer.info;
        this._status(`${info.parts} part${info.parts === 1 ? '' : 's'} · read-only`, info.warnings.length > 0);
        log.log(`Opened ${this.fileData.name}: ${info.parts} parts, root ${info.root}${info.warnings.length ? ', ' + info.warnings.join('; ') : ''}`);
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this.host.innerHTML = '<div style="padding:20px;color:#a33;white-space:pre-wrap"></div>';
        this.host.firstChild.textContent = message;
    }
}

registerPlugin({
    id: 'mht',
    name: 'MHTML web archive',
    components: {
        mhtViewer: MhtComponent,
    },
    contextMenuItems: [{
        label: 'Open as web archive',
        canHandle: (fileName) => MHT_RE.test(fileName || ''),
        action: (fileId) => {
            const file = _ctx && _ctx.projectFiles[fileId];
            if (file) _ctx.openEditorTab('mhtViewer', { fileId }, `${file.name} [mht]`, 'mht-' + fileId);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
