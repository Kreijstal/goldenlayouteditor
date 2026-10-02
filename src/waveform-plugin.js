// --- Waveform Plugin ---
// Opens VCD/FST/GHW waveforms in Surfer (https://surfer-project.org). Surfer is an
// egui/WebAssembly app; server.js passes it through at /surfer/ so it runs on our
// origin, and it is told which file to load via its inject_message() hook.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('Waveform');
const WAVEFORM_RE = /\.(vcd|fst|ghw)$/i;
const SURFER_PATH = 'surfer/';
const READY_TIMEOUT_MS = 60000;

// Name of the first top-level $scope in a VCD header (read with a Range request)
async function vcdTopScope(url) {
    try {
        const resp = await fetch(url, { headers: { Range: 'bytes=0-65535' } });
        if (!resp.ok) return null;
        const text = (await resp.text()).slice(0, 65536);
        const m = text.match(/\$scope\s+\S+\s+(\S+)\s+\$end/);
        return m ? m[1] : null;
    } catch (_) {
        return null;
    }
}

class WaveformViewerComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = WaveformViewerComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.destroyed = false;

        this.root = container.element;
        this.root.classList.add('waveform-plugin-root');
        this._installStyles();
        this.root.innerHTML = '<div class="waveform-shell"><iframe class="waveform-frame" title="Surfer waveform viewer"></iframe><div class="waveform-overlay">Loading Surfer...</div></div>';
        this.frame = this.root.querySelector('iframe');
        this.overlay = this.root.querySelector('.waveform-overlay');
        if (container.on) container.on('destroy', () => { this.destroyed = true; });
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (WaveformViewerComponent._styleInstalled) return;
        WaveformViewerComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.waveform-plugin-root{height:100%;background:#404040;overflow:hidden}
.waveform-shell{position:relative;height:100%}
.waveform-frame{display:block;width:100%;height:100%;border:0}
.waveform-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;background:#404040;color:#e8eaed;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.waveform-overlay[hidden]{display:none}
.waveform-overlay.error{color:#fecaca}
`;
        document.head.appendChild(style);
    }

    _fileUrl() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        const abs = this.ctx.currentWorkspacePath + '/' + this.ctx.getRelativePath(this.fileId);
        return new URL('/workspace-file?path=' + encodeURIComponent(abs), location.href).href;
    }

    async _init() {
        let url;
        try {
            url = await resolveFileUrl(this._fileUrl());
        } catch (err) {
            this._fail('Could not read the file: ' + err.message);
            return;
        }
        if (!url) {
            this._fail('Waveform viewing requires the server workspace.');
            return;
        }
        this.frame.src = new URL(SURFER_PATH, document.baseURI).href;
        // Surfer defines window.inject_message once its WebAssembly has started
        const started = Date.now();
        while (!this.destroyed) {
            let win = null;
            try { win = this.frame.contentWindow; } catch (_) { /* not ready */ }
            if (win && typeof win.inject_message === 'function') {
                try {
                    await this._load(win, url);
                    this.overlay.hidden = true;
                } catch (err) {
                    log.error('Surfer rejected the load message:', err);
                    this._fail('Surfer could not load this file: ' + err.message);
                }
                return;
            }
            if (Date.now() - started > READY_TIMEOUT_MS) {
                this._fail('Surfer did not start. It is loaded from app.surfer-project.org through this server, so the server needs internet access.');
                return;
            }
            await new Promise(r => setTimeout(r, 150));
        }
    }

    // Load through a Surfer command file, so the signals of the top scope are added
    // once the file has loaded (Surfer runs the commands in order, waiting for the load)
    async _load(win, url) {
        const send = msg => win.inject_message(JSON.stringify(msg));
        const narrow = this.root.clientWidth < 700;
        if (narrow) {
            // Phone: waveforms need the width; the scope/variable panel is in View
            send({ SetUIZoomFactor: 0.5 });
            send({ SetSidePanelVisible: false });
        }
        const scope = /\.vcd$/i.test(this.fileData.name) ? await vcdTopScope(url) : null;
        const commands = [`load_url ${url}`];
        if (scope) commands.push(`scope_add ${scope}`, 'zoom_fit');
        send({ LoadCommandFromData: Array.from(new TextEncoder().encode(commands.join('\n') + '\n')) });
    }

    _fail(message) {
        this.overlay.textContent = message;
        this.overlay.classList.add('error');
        this.overlay.hidden = false;
    }
}

registerPlugin({
    id: 'waveform',
    name: 'Waveform (Surfer)',
    components: {
        waveformViewer: WaveformViewerComponent,
    },
    contextMenuItems: [{
        label: 'Open in Surfer',
        canHandle: (fileName) => WAVEFORM_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = WaveformViewerComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('waveformViewer', { fileId }, `${file.name} [wave]`, 'wave-' + fileId);
        },
    }],
    init(ctx) {
        WaveformViewerComponent._ctx = ctx;
    },
});
