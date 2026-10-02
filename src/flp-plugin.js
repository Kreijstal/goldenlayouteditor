// --- FL Studio Project Plugin ---
// Opens FL Studio projects (.flp): project info, channels, patterns with a
// piano roll, playlist, mixer and the raw events, with the title, author,
// genre, comments, tempo and channel/pattern/insert names editable. Only this
// shell is in the bundle: the viewer (public/flp-viewer/) and
// @holzchopf/flp-file (from esm.sh) are loaded when a project is opened.
// Saving writes the file through flp-file, changing only the edited events.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');

const log = createLogger('FLP');
const FLP_RE = /\.flp$/i;
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/flp-viewer/flp-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

class FlpComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.dirty = false;
        this.changes = 0;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div class="flp-toolbar" style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden">
  <span class="flp-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <button type="button" class="flp-save" disabled title="Save (Ctrl+S)" style="background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer">Save</button>
  <span class="flp-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="flp-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.saveBtn = this.root.querySelector('.flp-save');
        this.statusEl = this.root.querySelector('.flp-status');
        this.host = this.root.querySelector('.flp-host');
        this.root.querySelector('.flp-title').textContent = (this.fileData && this.fileData.name) || '';
        this.saveBtn.onclick = () => this._save();
        this.root.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                e.stopPropagation();
                this._save();
            }
        }, true);
        if (container.on) container.on('destroy', () => { if (this.viewer) this.viewer.destroy(); });
        this._init();
    }

    _path() {
        if (!_ctx || !this.fileData || !_ctx.currentWorkspacePath) return null;
        return _ctx.currentWorkspacePath + '/' + _ctx.getRelativePath(this.fileId);
    }

    async _init() {
        const path = this._path();
        if (!path) return this._fail('FL Studio projects need the server workspace.');
        this.readOnly = insideArchive(path);
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(path))).then(async r => {
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                return new Uint8Array(await r.arrayBuffer());
            })]);
            this.host.textContent = '';
            this.viewer = await mod.mountFlpViewer(this.host, { bytes, readOnly: this.readOnly, onChange: () => this._onChange() });
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the project: ' + err.message);
        }
        this.saveBtn.hidden = this.readOnly;
        this._status(this.readOnly ? 'Read-only (inside an archive)' : `FL Studio ${this.viewer.project.versionString}`);
        log.log(`Opened ${path}`);
    }

    _onChange() {
        if (this.readOnly) return;
        this.changes++;
        this.dirty = true;
        this.saveBtn.disabled = false;
        this._status('Unsaved changes');
    }

    async _save() {
        if (!this.viewer || this.readOnly || this._saving || !this.dirty) return;
        const path = this._path();
        const changes = this.changes;
        this._saving = true;
        this.saveBtn.disabled = true;
        this._status('Saving…');
        try {
            if (!_ctx.wsClient || !_ctx.wsClient.isConnected()) throw new Error('not connected to the server');
            const out = this.viewer.getBytes();
            const slash = path.lastIndexOf('/');
            const result = await _ctx.wsClient.wsRequest({
                type: 'saveFile',
                workspacePath: path.slice(0, slash) || '/',
                relativePath: path.slice(slash + 1),
                content: bytesToBase64(out),
                encoding: 'base64',
            });
            if (!result || !result.success) throw new Error((result && result.error) || 'save failed');
            if (this.changes === changes) this.dirty = false;
            this.saveBtn.disabled = !this.dirty;
            this._status(`Saved ${new Date().toLocaleTimeString()}`);
            log.log(`Saved ${path} (${out.length} bytes)`);
        } catch (err) {
            log.error('Save failed:', err);
            this.saveBtn.disabled = false;
            this._status('Could not save: ' + err.message, true);
        } finally {
            this._saving = false;
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
    id: 'flp',
    name: 'FL Studio project',
    components: {
        flpViewer: FlpComponent,
    },
    contextMenuItems: [{
        label: 'Open as FL Studio project',
        canHandle: (fileName) => FLP_RE.test(fileName || ''),
        action: (fileId) => {
            const file = _ctx && _ctx.projectFiles[fileId];
            if (file) _ctx.openEditorTab('flpViewer', { fileId }, `${file.name} [flp]`, 'flp-' + fileId);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
