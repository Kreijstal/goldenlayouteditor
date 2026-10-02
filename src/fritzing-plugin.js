// --- Fritzing Plugin ---
// Opens .fzz/.fz sketches in Fritzing itself, compiled to WebAssembly (the page
// at /fritzing/, see server.js). The page loads the sketch from /workspace-file
// and, when Fritzing saves, posts the file's bytes back here; they are written
// to disk over the same WebSocket save the other editors use.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('Fritzing');
const FRITZING_RE = /\.(fzz|fz)$/i;

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

// An empty sketch: a .fzz is a zip holding the .fz (plain XML)
const EMPTY_FZ = '<?xml version="1.0" encoding="UTF-8"?>\n<module fritzingVersion="1.0.0">\n <views/>\n <instances/>\n</module>\n';

function crc32(bytes) {
    let crc = ~0;
    for (const b of bytes) {
        crc ^= b;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
}

// Zip with one uncompressed entry
function storedZip(name, data) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(14, 0x21, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    const centralOffset = 30 + nameBytes.length + data.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, 1, true);
    end.setUint16(10, 1, true);
    end.setUint32(12, 46 + nameBytes.length, true);
    end.setUint32(16, centralOffset, true);
    const parts = [local, nameBytes, data, central, nameBytes, end].map(p => new Uint8Array(p.buffer || p));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

class FritzingComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = FritzingComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;

        this.root = container.element;
        this.root.classList.add('fritzing-plugin-root');
        this._installStyles();
        this.root.innerHTML = '<div class="fritzing-shell"><iframe class="fritzing-frame" title="Fritzing"></iframe><div class="fritzing-toast" hidden></div></div>';
        this.frame = this.root.querySelector('iframe');
        this.toast = this.root.querySelector('.fritzing-toast');
        this._onMessage = (e) => this._handleMessage(e);
        window.addEventListener('message', this._onMessage);
        if (container.on) container.on('destroy', () => window.removeEventListener('message', this._onMessage));
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (FritzingComponent._styleInstalled) return;
        FritzingComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.fritzing-plugin-root{height:100%;background:#d92b27;overflow:hidden}
.fritzing-shell{position:relative;height:100%}
.fritzing-frame{display:block;width:100%;height:100%;border:0}
.fritzing-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:#202124;color:#e8eaed;padding:8px 14px;border-radius:6px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);max-width:90%}
.fritzing-toast[hidden]{display:none}
.fritzing-toast.error{background:#7f1d1d}
`;
        document.head.appendChild(style);
    }

    _init() {
        const url = new URL('fritzing/index.html', document.baseURI);
        if (this.ctx && this.fileData && this.ctx.currentWorkspacePath) {
            this.filePath = this.ctx.currentWorkspacePath + '/' + this.ctx.getRelativePath(this.fileId);
            url.searchParams.set('file', this.filePath);
        }
        this.frame.src = url.href;
    }

    async _handleMessage(event) {
        if (event.source !== this.frame.contentWindow || !event.data || event.data.type !== 'fritzing-saved') return;
        const { path, bytes } = event.data;
        const slash = path.lastIndexOf('/');
        const name = path.slice(slash + 1);
        // Only the opened sketch or a sketch saved next to it (Save As)
        const folder = this.filePath ? this.filePath.slice(0, this.filePath.lastIndexOf('/')) : null;
        if (!folder || path.slice(0, slash) !== folder || !FRITZING_RE.test(name) || !(bytes instanceof Uint8Array)) {
            log.warn('Ignored a save outside the sketch folder:', path);
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
            log.error('Fritzing save failed:', err);
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
    id: 'fritzing',
    name: 'Fritzing',
    components: {
        fritzingEditor: FritzingComponent,
    },
    newFileTypes: [{
        label: 'Fritzing sketch',
        ext: 'fzz',
        content: stem => storedZip(stem + '.fz', new TextEncoder().encode(EMPTY_FZ)),
    }],
    contextMenuItems: [{
        label: 'Open in Fritzing',
        canHandle: (fileName) => FRITZING_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = FritzingComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('fritzingEditor', { fileId }, `${file.name} [fritzing]`, 'fritzing-' + fileId);
        },
    }],
    init(ctx) {
        FritzingComponent._ctx = ctx;
    },
});
