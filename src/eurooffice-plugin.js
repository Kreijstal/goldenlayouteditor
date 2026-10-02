// --- Euro-Office Plugin ---
// Edits Word documents and PowerPoint presentations in Euro-Office's editors (a
// fork of OnlyOffice under plain AGPL-3.0), running entirely in the browser with
// x2t, the converter, as WebAssembly, in the shell of github.com/Ranuts/document
// (scripts/build-eurooffice.sh). The server serves the build at /office; the page is
// driven over its iframe embed API: the file goes in as bytes, and a save (the
// Save button here, or the editor's own Save / Ctrl+S) comes back as a File
// that is written over the original.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { ensureArchiveAccess } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');

const log = createLogger('Office');
const EDITABLE_RE = /\.(docx|docm|dotx|dotm|pptx|pptm|ppsx|potx)$/i;

class OfficeComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = OfficeComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.dirty = false;
        this.pending = new Map(); // command id -> { resolve, reject }

        this.root = container.element;
        this.root.classList.add('oo-plugin-root');
        this._installStyles();
        this.root.innerHTML = `
<div class="oo-shell">
  <div class="oo-toolbar">
    <span class="oo-title"></span>
    <button type="button" class="oo-save" disabled title="Save (Ctrl+S in the editor works too)">Save</button>
    <span class="oo-status"></span>
  </div>
  <div class="oo-host"><iframe class="oo-frame" title="Euro-Office"></iframe><div class="oo-message">Loading Euro-Office…</div></div>
</div>`;
        this.titleEl = this.root.querySelector('.oo-title');
        this.saveBtn = this.root.querySelector('.oo-save');
        this.statusEl = this.root.querySelector('.oo-status');
        this.message = this.root.querySelector('.oo-message');
        this.frame = this.root.querySelector('iframe');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        this.saveBtn.onclick = () => this._requestSave();
        this._onMessage = e => this._handleMessage(e);
        window.addEventListener('message', this._onMessage);
        if (container.on) container.on('destroy', () => window.removeEventListener('message', this._onMessage));
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (OfficeComponent._styleInstalled) return;
        OfficeComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.oo-plugin-root{height:100%;overflow:hidden;background:#fff}
.oo-shell{display:flex;flex-direction:column;height:100%}
.oo-toolbar{display:flex;align-items:center;gap:8px;padding:4px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden}
.oo-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.oo-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 10px;font:inherit;cursor:pointer}
.oo-toolbar button:hover:not(:disabled){background:#444c56}
.oo-toolbar button:disabled{opacity:.5;cursor:default}
.oo-toolbar button[hidden]{display:none}
.oo-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.oo-status.error{color:#ffb4ab}
.oo-host{position:relative;flex:1;min-height:0}
.oo-frame{display:block;width:100%;height:100%;border:0}
.oo-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;background:#fff;color:#57606a;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.oo-message[hidden]{display:none}
.oo-message.error{color:#b42318}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + this.ctx.getRelativePath(this.fileId);
    }

    _init() {
        this.path = this._path();
        if (!this.path) return this._fail('Documents need the server workspace.');
        this.readOnly = insideArchive(this.path);
        this.saveBtn.hidden = this.readOnly;
        const url = new URL('office/editor.html', document.baseURI);
        url.searchParams.set('embed', '1');
        url.searchParams.set('embedOrigin', location.origin);
        url.searchParams.set('locale', (navigator.language || 'en').startsWith('de') ? 'de' : 'en');
        this.frame.src = url.href;
    }

    _post(type, payload = {}) {
        const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.frame.contentWindow.postMessage({ id, type, payload }, location.origin);
        return id;
    }

    async _handleMessage(event) {
        if (event.source !== this.frame.contentWindow || event.origin !== location.origin) return;
        const { type, payload } = event.data || {};
        if (typeof type !== 'string' || !type.startsWith('document:')) return;
        switch (type) {
            case 'document:ready':
                return this._open();
            case 'document:opened':
                this.message.hidden = true;
                this.saveBtn.disabled = this.readOnly;
                this._status(this.readOnly ? 'Read-only (inside an archive)' : '');
                return;
            case 'document:modified':
                if (!this.readOnly) {
                    this.dirty = true;
                    this._status('Unsaved changes');
                }
                return;
            case 'document:saved':
                return this._write(payload && payload.file);
            case 'document:error':
                log.error('Editor error:', payload && payload.message);
                if (this.message.hidden) this._status((payload && payload.message) || 'Error', true);
                else this._fail('Could not open the document: ' + ((payload && payload.message) || 'unknown error'));
                return;
        }
    }

    async _open() {
        if (this._opened) return;
        this._opened = true;
        try {
            if (this.readOnly) await ensureArchiveAccess();
            const r = await fetch('/workspace-file?path=' + encodeURIComponent(this.path), { cache: 'no-store' });
            if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
            const buffer = await r.arrayBuffer();
            this.message.textContent = 'Opening…';
            this._post('document:open-buffer', { fileName: this.fileData.name, buffer, readonly: this.readOnly });
        } catch (err) {
            log.error('Load failed:', err);
            this._fail('Could not open the document: ' + err.message);
        }
    }

    _requestSave() {
        if (this.readOnly || this._saving) return;
        this.saveBtn.disabled = true;
        this._status('Saving…');
        this._post('document:save');
    }

    async _write(file) {
        if (this.readOnly) return;
        try {
            if (!(file instanceof Blob)) throw new Error('the editor returned no file');
            this._saving = true;
            this._status('Saving…');
            const r = await fetch('/upload-file?overwrite=1&path=' + encodeURIComponent(this.path), { method: 'PUT', body: file });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
            this.dirty = false;
            this._status(`Saved ${new Date().toLocaleTimeString()}`);
            log.log(`Saved ${this.path} (${file.size} bytes)`);
        } catch (err) {
            log.error('Save failed:', err);
            this._status('Could not save: ' + err.message, true);
        } finally {
            this._saving = false;
            this.saveBtn.disabled = false;
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(message) {
        this.message.hidden = false;
        this.message.classList.add('error');
        this.message.textContent = message;
    }
}

registerPlugin({
    id: 'eurooffice',
    name: 'Euro-Office (in the browser)',
    components: {
        officeEditor: OfficeComponent,
    },
    contextMenuItems: [{
        label: 'Edit in Euro-Office',
        canHandle: (fileName) => EDITABLE_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = OfficeComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('officeEditor', { fileId }, `${file.name} [office]`, 'office-' + fileId);
        },
    }],
    init(ctx) {
        OfficeComponent._ctx = ctx;
    },
});
