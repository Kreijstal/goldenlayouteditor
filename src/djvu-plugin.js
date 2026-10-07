// --- DjVu reader (.djvu, .djv) ---
// The tab for a DjVu document; the reader is djvu-viewer.js (pages drawn by
// djvu-rs in WebAssembly, the text layer, outline, links and search). Read-only.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { mountDjvuViewer } = require('./djvu-viewer');

const log = createLogger('DjVu');
let _ctx = null;

class DjvuComponent {
    constructor(container, state) {
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;overflow:hidden;background:#525659';
        this.root.innerHTML = '<div style="padding:20px;color:#ddd;font:14px sans-serif">Loading…</div>';
        if (container.on) container.on('destroy', () => { this.gone = true; if (this.viewer) this.viewer.destroy(); });
        this._init();
    }

    // The file's bytes: kept in memory (an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) throw new Error('DjVu files need the server workspace');
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const bytes = await this._readBytes();
            if (this.gone) return;
            this.root.textContent = '';
            this.viewer = await mountDjvuViewer(this.root, { bytes, name: this.fileData.name });
            if (this.gone) this.viewer.destroy();
        } catch (err) {
            log.error('Load failed:', err);
            this._fail('Could not open the DjVu file: ' + err.message);
        }
    }

    _fail(message) {
        this.root.innerHTML = '<div style="padding:20px;color:#f88;font:14px sans-serif"></div>';
        this.root.firstChild.textContent = message;
    }
}

registerPlugin({
    id: 'djvu',
    name: 'DjVu reader',
    components: {
        djvuViewer: DjvuComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
