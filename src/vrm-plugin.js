// --- VRM avatars (.vrm) ---
// Shows VRM 0.x and 1.0 avatars (glTF-binary based): the model with MToon
// materials and spring bones on an orbit camera, poses, expression sliders,
// eyes following the cursor, and the metadata (title, authors, usage
// permissions, thumbnail, counts). Read-only. Only this shell is in the
// bundle: the viewer (public/vrm-viewer/) and three.js / three-vrm from esm.sh
// are loaded when an avatar is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('VRM');
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/vrm-viewer/vrm-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class VrmComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#1e1e1e';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="vrm-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="vrm-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="vrm-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#aaa">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.vrm-status');
        this.host = this.root.querySelector('.vrm-host');
        this.root.querySelector('.vrm-title').textContent = (this.fileData && this.fileData.name) || '';
        this.destroyed = false;
        // Frees the WebGL context, textures and geometry
        if (container.on) container.on('destroy', () => { this.destroyed = true; if (this.viewer) this.viewer.destroy(); });
        this._init();
    }

    // The file's bytes: kept in memory (an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) throw new Error('VRM avatars need the server workspace');
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
            this.viewer = mod.mountVrmViewer(this.host, { bytes, name: this.fileData.name, onStatus: (t, e) => this._status(t, e) });
            await this.viewer.ready;
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the VRM avatar: ' + err.message);
        }
        const info = this.viewer.info;
        log.log(`Opened ${this.fileData.name}: ${info.kind === null ? 'not a VRM' + (info.error ? ' (' + info.error + ')' : '') : 'VRM ' + info.specVersion}`);
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this._status('Error', true);
        this.host.innerHTML = '<div style="padding:20px;color:#ffb4ab"></div>';
        this.host.firstChild.textContent = message;
    }
}

registerPlugin({
    id: 'vrm',
    name: 'VRM avatar',
    components: {
        vrmViewer: VrmComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
