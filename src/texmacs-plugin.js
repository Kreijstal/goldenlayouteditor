// --- TeXmacs Plugin ---
// Opens TeXmacs (.tm) and Mogan (.tmu) documents in Mogan STEM, the maintained
// TeXmacs fork, compiled to WebAssembly (the page at /mogan/, see server.js).
// The page loads the document from /workspace-file and, when Mogan saves, posts
// the file's bytes back here; they are written to disk over the same WebSocket
// save the other editors use.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('TeXmacs');
const TEXMACS_RE = /\.(tm|tmu)$/i;

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

class TexmacsComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = TexmacsComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;

        this.root = container.element;
        this.root.classList.add('texmacs-plugin-root');
        this._installStyles();
        this.root.innerHTML = '<div class="texmacs-shell"><iframe class="texmacs-frame" title="Mogan"></iframe><div class="texmacs-toast" hidden></div></div>';
        this.frame = this.root.querySelector('iframe');
        this.toast = this.root.querySelector('.texmacs-toast');
        this._onMessage = (e) => this._handleMessage(e);
        window.addEventListener('message', this._onMessage);
        if (container.on) container.on('destroy', () => window.removeEventListener('message', this._onMessage));
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (TexmacsComponent._styleInstalled) return;
        TexmacsComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.texmacs-plugin-root{height:100%;background:#f5f5f5;overflow:hidden}
.texmacs-shell{position:relative;height:100%}
.texmacs-frame{display:block;width:100%;height:100%;border:0}
.texmacs-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:#202124;color:#e8eaed;padding:8px 14px;border-radius:6px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);max-width:90%}
.texmacs-toast[hidden]{display:none}
.texmacs-toast.error{background:#7f1d1d}
`;
        document.head.appendChild(style);
    }

    _init() {
        const url = new URL('mogan/index.html', document.baseURI);
        if (this.ctx && this.fileData && this.ctx.currentWorkspacePath) {
            this.filePath = this.ctx.currentWorkspacePath + '/' + this.ctx.getRelativePath(this.fileId);
            url.searchParams.set('file', this.filePath);
        }
        this.frame.src = url.href;
    }

    async _handleMessage(event) {
        if (event.source !== this.frame.contentWindow || !event.data || event.data.type !== 'mogan-saved') return;
        const { path, bytes } = event.data;
        const slash = path.lastIndexOf('/');
        const name = path.slice(slash + 1);
        // Only the opened document or one saved next to it (Save As)
        const folder = this.filePath ? this.filePath.slice(0, this.filePath.lastIndexOf('/')) : null;
        if (!folder || path.slice(0, slash) !== folder || !TEXMACS_RE.test(name) || !(bytes instanceof Uint8Array)) {
            log.warn("Ignored a save outside the document's folder:", path);
            return;
        }
        try {
            if (!this.ctx || !this.ctx.wsClient || !this.ctx.wsClient.isConnected()) throw new Error('not connected to the server');
            const result = await this.ctx.wsClient.wsRequest({
                type: 'saveFile',
                workspacePath: path.slice(0, slash) || '/',
                relativePath: name,
                content: bytesToBase64(bytes),
                encoding: 'base64',
            });
            if (!result || !result.success) throw new Error((result && result.error) || 'save failed');
            log.log(`Saved ${path} (${bytes.length} bytes)`);
            this._showToast(`Saved ${name}`);
        } catch (err) {
            log.error('Mogan save failed:', err);
            this._showToast(`Could not save ${name}: ${err.message}`, true);
        }
    }

    _showToast(text, isError) {
        this.toast.textContent = text;
        this.toast.classList.toggle('error', !!isError);
        this.toast.hidden = false;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { this.toast.hidden = true; }, isError ? 8000 : 2500);
    }
}

registerPlugin({
    id: 'texmacs',
    name: 'TeXmacs (Mogan)',
    components: {
        texmacsEditor: TexmacsComponent,
    },
    newFileTypes: [{
        label: 'TeXmacs document',
        ext: 'tm',
        content: () => '<TeXmacs|2.1>\n\n<style|generic>\n\n<\\body>\n  \n</body>\n\n<initial|<\\collection>\n</collection>>\n',
    }],
    contextMenuItems: [{
        label: 'Open in Mogan',
        canHandle: (fileName) => TEXMACS_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = TexmacsComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('texmacsEditor', { fileId }, `${file.name} [texmacs]`, 'texmacs-' + fileId);
        },
    }],
    init(ctx) {
        TexmacsComponent._ctx = ctx;
    },
});
