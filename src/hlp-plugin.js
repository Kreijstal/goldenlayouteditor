// --- Windows Help (.hlp) ---
// Opens WinHelp files (Windows 3.0/3.1/95, magic 0x00035F3F): the help title,
// the contents topic, topics with their fonts, colours, indents, tabs, tables,
// bitmaps and the non-scrolling region, jumps with back/forward, popups,
// browse sequences, the topic list and keyword index with a filter, and the
// internal files. OS/2 help (.hlp/.inf, "HSP") is shown as text with its
// contents and index; other files named .hlp get a message. Read-only. Only
// this shell is in the bundle: the reader and viewer (public/hlp-viewer/) are
// loaded when a help file is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('HLP');
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/hlp-viewer/hlp-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class HlpComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="hlp-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="hlp-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="hlp-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.hlp-status');
        this.host = this.root.querySelector('.hlp-host');
        this.root.querySelector('.hlp-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) container.on('destroy', () => { if (this.viewer) this.viewer.destroy(); });
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
            this.host.textContent = '';
            this.viewer = await mod.mountHlpViewer(this.host, { bytes, name: this.fileData.name });
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the help file: ' + err.message);
        }
        const info = this.viewer.info;
        if (info.error) this._status(info.format === 'winhelp' ? 'Damaged help file' : info.format === 'ipf' ? 'Damaged OS/2 help file' : 'Not a help file', true);
        else if (info.format === 'winhelp') this._status(`WinHelp ${info.version} · ${info.topics} topics · read-only`);
        else if (info.format === 'ipf') this._status(`OS/2 help · ${info.topics} topics · read-only`);
        log.log(`Opened ${this.fileData.name}: ${info.format}${info.version ? ' ' + info.version : ''}${info.topics != null ? `, ${info.topics} topics` : ''}${info.error ? ', ' + info.error : ''}`);
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
    id: 'hlp',
    name: 'Windows Help',
    components: {
        hlpViewer: HlpComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
