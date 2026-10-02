// --- KeePass databases (.kdbx) ---
// Opens KeePass password databases (KDBX 3.1 and 4.x, as KeePass 2, KeePassXC,
// KeeWeb write them) read-only: asks for the master password and/or key file in
// the tab, then shows the groups, entries, fields, TOTP codes and attachments.
// KeePass 1.x .kdb and old KDBX 2 files get a message saying why they can't be
// opened. Only this shell is in the bundle: the viewer (public/kdbx-viewer/,
// with kdbxweb and hash-wasm's Argon2 from esm.sh) is loaded when one opens.
// The decrypted database stays in the viewer's memory for this tab: nothing of
// it is sent to the server, put in storage or saved. The log (which goes to the
// server) only gets the file name, format and timings.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('KDBX');
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/kdbx-viewer/kdbx-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class KdbxComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="kdbx-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="kdbx-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="kdbx-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.kdbx-status');
        this.host = this.root.querySelector('.kdbx-host');
        this.root.querySelector('.kdbx-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) container.on('destroy', () => { if (this.viewer) this.viewer.destroy(); this.viewer = null; });
        this._init();
    }

    // The encrypted file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) throw new Error('KeePass databases need the server workspace');
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        const name = this.fileData.name;
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
            this.host.textContent = '';
            this.viewer = mod.mountKdbxViewer(this.host, {
                bytes, name,
                setStatus: (text, isError) => this._status(text, isError),
                onUnlock: (info) => log.log(`Unlocked ${name}: ${info.version}, ${info.kdf}, ${info.entries} entries, ${info.ms} ms`),
            });
        } catch (err) {
            log.error('Load failed:', err.message);
            return this._fail('Could not open the database: ' + err.message);
        }
        const h = this.viewer.header;
        log.log(`Opened ${name}: ${h.version || h.kind}${h.unsupported ? ' (unsupported)' : ''}`);
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
    id: 'kdbx',
    name: 'KeePass databases',
    components: {
        kdbxViewer: KdbxComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
