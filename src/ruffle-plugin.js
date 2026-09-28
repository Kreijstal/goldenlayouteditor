// --- Ruffle SWF Plugin ---
// Registers a local GoldenLayout component and lazy-loads Ruffle.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('Ruffle');
const RUFFLE_VERSION = '0.2.0-nightly.2026.4.26';
const RUFFLE_URL = `https://unpkg.com/@ruffle-rs/ruffle@${RUFFLE_VERSION}`;
const RUFFLE_PUBLIC_PATH = `https://unpkg.com/@ruffle-rs/ruffle@${RUFFLE_VERSION}/`;

let _rufflePromise = null;

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-ruffle-loader="${url}"]`);
        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)), { once: true });
            if (window.RufflePlayer && window.RufflePlayer.newest) resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.ruffleLoader = url;
        script.addEventListener('load', resolve, { once: true });
        script.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)), { once: true });
        document.head.appendChild(script);
    });
}

async function ensureRuffleLoaded() {
    if (!_rufflePromise) {
        _rufflePromise = (async () => {
            window.RufflePlayer = window.RufflePlayer || {};
            window.RufflePlayer.config = {
                ...(window.RufflePlayer.config || {}),
                publicPath: RUFFLE_PUBLIC_PATH,
                autoplay: 'auto',
                allowScriptAccess: false,
                allowNetworking: 'all',
                openUrlMode: 'confirm',
                warnOnUnsupportedContent: true,
                showSwfDownload: false,
            };
            await loadScript(RUFFLE_URL);
            const api = window.RufflePlayer && window.RufflePlayer.newest && window.RufflePlayer.newest();
            if (!api || typeof api.createPlayer !== 'function') {
                throw new Error('Ruffle did not register a player API');
            }
            return api;
        })();
    }
    return _rufflePromise;
}

function button(label, title, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.title = title || label;
    el.addEventListener('click', onClick);
    return el;
}

class RuffleSwfComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = RuffleSwfComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'movie.swf';
        this.player = null;
        this.objectUrl = null;

        this.root = container.element;
        this.root.classList.add('ruffle-plugin-root');
        this._installStyles();
        this._buildUI();

        if (container.on) {
            container.on('resize', () => this._resize());
            container.on('destroy', () => this._destroy());
        }

        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (RuffleSwfComponent._styleInstalled) return;
        RuffleSwfComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.ruffle-plugin-root{height:100%;background:#111827;color:#e5e7eb;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.ruffle-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.ruffle-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#1f2937;border-bottom:1px solid #374151;white-space:nowrap;overflow:auto}
.ruffle-toolbar button{background:#374151;color:#e5e7eb;border:1px solid #4b5563;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.ruffle-toolbar button:hover{background:#4b5563}
.ruffle-toolbar button:disabled{opacity:.45;cursor:not-allowed}
.ruffle-title{font-weight:600;min-width:80px;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.ruffle-status{margin-left:auto;color:#9ca3af;font-size:12px}
.ruffle-stage{position:relative;min-height:0;background:#050505;display:flex;align-items:center;justify-content:center;overflow:hidden}
.ruffle-stage ruffle-player{width:100%;height:100%;display:block}
.ruffle-message{padding:18px;color:#9ca3af;text-align:center}
.ruffle-error{padding:18px;color:#fecaca;text-align:center}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'ruffle-shell';

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'ruffle-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.swf,application/x-shockwave-flash';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(button('Open', 'Open local SWF file', () => this.fileInput.click()));
        this.reloadBtn = button('Reload', 'Reload SWF', () => this._reload());
        this.reloadBtn.disabled = true;
        this.toolbar.appendChild(this.reloadBtn);
        this.playBtn = button('Play', 'Resume playback', () => this.player && this.player.play());
        this.pauseBtn = button('Pause', 'Pause playback', () => this.player && this.player.pause());
        this.fullscreenBtn = button('Fullscreen', 'Enter fullscreen', () => this.player && this.player.enterFullscreen());
        this.toolbar.appendChild(this.playBtn);
        this.toolbar.appendChild(this.pauseBtn);
        this.toolbar.appendChild(this.fullscreenBtn);

        this.titleEl = document.createElement('span');
        this.titleEl.className = 'ruffle-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);

        this.statusEl = document.createElement('span');
        this.statusEl.className = 'ruffle-status';
        this.toolbar.appendChild(this.statusEl);

        this.stage = document.createElement('div');
        this.stage.className = 'ruffle-stage';
        this.stage.innerHTML = '<div class="ruffle-message">Open an SWF file to play it with Ruffle.</div>';

        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.stage);
        this.root.appendChild(this.shell);
    }

    async _init() {
        if (this.fileData) {
            await this._loadProjectFile();
        } else {
            this.statusEl.textContent = 'Ruffle loads when an SWF is opened';
        }
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed SWF loading requires the server workspace.');
                return;
            }
            const relPath = this.ctx.getRelativePath(this.fileId);
            const url = '/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + relPath);
            await this._loadUrl(url, this.fileData.name);
        } catch (err) {
            this._showError(err.message);
        }
    }

    async _loadFileObject(file) {
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = URL.createObjectURL(file);
        this.fileId = null;
        this.fileData = null;
        await this._loadUrl(this.objectUrl, file.name);
    }

    async _loadUrl(url, name) {
        this.fileName = name || this.fileName;
        this.titleEl.textContent = this.fileName;
        this.statusEl.textContent = 'Loading Ruffle...';
        this.stage.innerHTML = '';
        try {
            const api = await ensureRuffleLoaded();
            this.player = api.createPlayer();
            this.player.style.width = '100%';
            this.player.style.height = '100%';
            this.player.addEventListener('loadedmetadata', () => this._updateStatus());
            this.player.addEventListener('loadeddata', () => this._updateStatus());
            this.player.addEventListener('error', () => this._updateStatus('Ruffle error'));
            this.stage.appendChild(this.player);
            this.statusEl.textContent = 'Loading SWF...';
            await this.player.load({
                url,
                allowScriptAccess: false,
                openUrlMode: 'confirm',
            });
            this.reloadBtn.disabled = false;
            this._updateStatus();
        } catch (err) {
            this._showError(`Failed to load SWF: ${err.message}`);
        }
    }

    async _reload() {
        if (!this.player) return;
        try {
            this.statusEl.textContent = 'Reloading...';
            await this.player.reload();
            this._updateStatus();
        } catch (err) {
            this._showError(`Reload failed: ${err.message}`);
        }
    }

    _updateStatus(fallback) {
        if (!this.player) {
            this.statusEl.textContent = fallback || '';
            return;
        }
        const metadata = this.player.metadata;
        const percent = typeof this.player.PercentLoaded === 'function' ? this.player.PercentLoaded() : null;
        const parts = [];
        if (metadata && metadata.width && metadata.height) parts.push(`${metadata.width}x${metadata.height}`);
        if (typeof percent === 'number') parts.push(`${percent}%`);
        this.statusEl.textContent = parts.join(' | ') || fallback || 'Loaded';
    }

    _showMessage(message) {
        this.stage.innerHTML = `<div class="ruffle-message">${message}</div>`;
        this.statusEl.textContent = '';
    }

    _showError(message) {
        log.error(message);
        this.stage.innerHTML = `<div class="ruffle-error">${message}</div>`;
        this.statusEl.textContent = 'Error';
    }

    _resize() {
        if (this.player) {
            this.player.style.width = '100%';
            this.player.style.height = '100%';
        }
    }

    _destroy() {
        if (this.player) {
            try { this.player.remove(); } catch (_) { /* ignore */ }
            this.player = null;
        }
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}

registerPlugin({
    id: 'ruffle-swf',
    name: 'Ruffle SWF',
    components: {
        ruffleSwf: RuffleSwfComponent,
    },
    toolbarButtons: [
        { label: 'SWF', title: 'Open Ruffle SWF Viewer' },
    ],
    contextMenuItems: [{
        label: 'Open SWF with Ruffle',
        canHandle: (fileName) => /\.swf$/i.test(fileName || ''),
        action: (fileId) => {
            const ctx = RuffleSwfComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab(
                'ruffleSwf',
                { fileId },
                `${file.name} [swf]`,
                'swf-' + fileId
            );
        },
    }],
    init(ctx) {
        RuffleSwfComponent._ctx = ctx;
    },
});
