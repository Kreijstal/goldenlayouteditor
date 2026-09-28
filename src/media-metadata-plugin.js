// --- Media Metadata Plugin ---
// Lazy-loads mediainfo.js and reads media metadata using chunked range reads.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('MediaMeta');
const MEDIAINFO_SCRIPT_URL = 'https://unpkg.com/mediainfo.js@0.3.7/dist/umd/index.min.js';
const MEDIAINFO_WASM_URL = 'https://unpkg.com/mediainfo.js@0.3.7/dist/MediaInfoModule.wasm';
const MEDIA_RE = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|ts|m2ts|3gp|mp3|m4a|aac|flac|wav|ogg|opus)$/i;

let _mediaInfoPromise = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-src="${src}"]`);
        if (existing) {
            if (window.MediaInfo && window.MediaInfo.mediaInfoFactory) resolve();
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.dataset.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
}

async function ensureMediaInfoLoaded() {
    if (!_mediaInfoPromise) {
        _mediaInfoPromise = (async () => {
            await loadScript(MEDIAINFO_SCRIPT_URL);
            const factory = window.MediaInfo && (window.MediaInfo.mediaInfoFactory || window.MediaInfo.default);
            if (typeof factory !== 'function') throw new Error('mediainfo.js did not load');
            return factory({
                format: 'object',
                full: true,
                locateFile: () => MEDIAINFO_WASM_URL,
            });
        })();
    }
    return _mediaInfoPromise;
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

function tracksOf(result) {
    return result && result.media && Array.isArray(result.media.track) ? result.media.track : [];
}

function pickTrack(tracks, type) {
    return tracks.find(track => track['@type'] === type) || null;
}

function formatSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return value || '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

class MediaMetadataComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = MediaMetadataComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'media';
        this.result = null;
        this.selectedTrack = null;
        this.localBlob = null;

        this.root = container.element;
        this.root.classList.add('media-meta-root');
        this._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (MediaMetadataComponent._styleInstalled) return;
        MediaMetadataComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.media-meta-root{height:100%;background:#1f2328;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.media-meta-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.media-meta-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow:auto}
.media-meta-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.media-meta-toolbar button:hover{background:#444c56}
.media-meta-title{font-weight:600;min-width:120px;max-width:340px;overflow:hidden;text-overflow:ellipsis}
.media-meta-status{margin-left:auto;color:#adbac7;font-size:12px}
.media-meta-main{display:grid;grid-template-columns:320px 1fr;min-height:0}
.media-meta-side{min-height:0;border-right:1px solid #444c56;background:#22272e;display:grid;grid-template-rows:auto 1fr}
.media-meta-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px;border-bottom:1px solid #444c56}
.media-meta-tracks{overflow:auto;padding:6px}
.media-meta-track{display:block;width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px;background:#2d333b;border:1px solid #444c56;border-radius:4px;color:#e6edf3;text-align:left;cursor:pointer}
.media-meta-track.active{border-color:#6cb6ff;background:#303b49}
.media-meta-track-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.media-meta-track-meta{color:#adbac7;font-size:11px;margin-top:2px}
.media-meta-content{min-width:0;min-height:0;display:grid;grid-template-rows:auto 1fr;background:#1f2328}
.media-meta-summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;padding:8px 10px;border-bottom:1px solid #444c56;background:#22272e}
.media-meta-card{background:#2d333b;border:1px solid #444c56;border-radius:4px;padding:7px 8px;min-width:0}
.media-meta-card-label{color:#adbac7;font-size:11px;text-transform:uppercase}
.media-meta-card-value{font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.media-meta-output{margin:0;padding:12px;overflow:auto;color:#d1d7e0;background:#1f2328;font:12px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;line-height:1.45;tab-size:2}
.media-meta-message,.media-meta-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#adbac7}
.media-meta-error{color:#ffb4ab}
@media (max-width:800px){.media-meta-main{grid-template-columns:1fr}.media-meta-side{display:none}.media-meta-summary{grid-template-columns:repeat(2,minmax(120px,1fr))}}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'media-meta-shell';
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'media-meta-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.mpg,.mpeg,.ts,.m2ts,.3gp,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', e => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local media file', () => this.fileInput.click()));
        this.toolbar.appendChild(makeButton('All Metadata', 'Show complete metadata JSON', () => this._renderJson(this.result)));
        this.toolbar.appendChild(makeButton('Export JSON', 'Create a metadata JSON file', () => this._exportJson()));
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'media-meta-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'media-meta-status';
        this.toolbar.appendChild(this.statusEl);

        this.main = document.createElement('div');
        this.main.className = 'media-meta-main';
        this.side = document.createElement('div');
        this.side.className = 'media-meta-side';
        this.side.innerHTML = '<h3>Tracks</h3><div class="media-meta-tracks"></div>';
        this.tracksEl = this.side.querySelector('.media-meta-tracks');
        this.content = document.createElement('div');
        this.content.className = 'media-meta-content';
        this.summaryEl = document.createElement('div');
        this.summaryEl.className = 'media-meta-summary';
        this.outputEl = document.createElement('pre');
        this.outputEl.className = 'media-meta-output';
        this.content.appendChild(this.summaryEl);
        this.content.appendChild(this.outputEl);
        this.main.appendChild(this.side);
        this.main.appendChild(this.content);
        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open an audio or video file to inspect metadata.');
    }

    async _init() {
        if (this.fileData) await this._loadProjectFile();
        else this.statusEl.textContent = 'MediaInfo loads when media is opened';
    }

    async _loadProjectFile() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
            this._showMessage('Workspace-backed media metadata requires the server workspace.');
            return;
        }
        this.fileName = this.fileData.name;
        this.titleEl.textContent = this.fileName;
        await this._analyze({
            name: this.fileName,
            getSize: async () => {
                const relPath = this.ctx.getRelativePath(this.fileId);
                const stat = await this.ctx.wsClient.statFile(this.ctx.currentWorkspacePath, relPath);
                return stat.size;
            },
            readChunk: async (size, offset) => {
                const relPath = this.ctx.getRelativePath(this.fileId);
                const result = await this.ctx.wsClient.readFileRange(this.ctx.currentWorkspacePath, relPath, offset, size);
                return result.bytes;
            },
        });
    }

    async _loadFileObject(file) {
        this.localBlob = file;
        this.fileName = file.name;
        this.titleEl.textContent = this.fileName;
        await this._analyze({
            name: file.name,
            getSize: () => file.size,
            readChunk: async (size, offset) => {
                const buffer = await file.slice(offset, offset + size).arrayBuffer();
                return new Uint8Array(buffer);
            },
        });
    }

    async _analyze(source) {
        this.statusEl.textContent = 'Loading mediainfo.js...';
        this._clear();
        try {
            const mediaInfo = await ensureMediaInfoLoaded();
            this.statusEl.textContent = 'Reading metadata...';
            const size = await source.getSize();
            this.result = await mediaInfo.analyzeData(size, source.readChunk);
            this._renderResult();
        } catch (err) {
            log.error('Failed to read media metadata:', err);
            this._showError(`Failed to read media metadata: ${err.message}`);
        }
    }

    _renderResult() {
        const tracks = tracksOf(this.result);
        this.tracksEl.innerHTML = '';
        for (const track of tracks) {
            const type = track['@type'] || 'Track';
            const label = track.Format || track.CodecID || track.Title || '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'media-meta-track';
            btn.innerHTML = '<div class="media-meta-track-name"></div><div class="media-meta-track-meta"></div>';
            btn.querySelector('.media-meta-track-name').textContent = type;
            btn.querySelector('.media-meta-track-meta').textContent = label;
            btn.addEventListener('click', () => this._selectTrack(track));
            this.tracksEl.appendChild(btn);
        }

        this.statusEl.textContent = `${tracks.length} track(s)`;
        this._renderJson(this.result);
    }

    _selectTrack(track) {
        this.selectedTrack = track;
        for (const btn of this.tracksEl.querySelectorAll('.media-meta-track')) {
            btn.classList.toggle('active', btn.querySelector('.media-meta-track-name').textContent === (track['@type'] || 'Track') &&
                btn.querySelector('.media-meta-track-meta').textContent === (track.Format || track.CodecID || track.Title || ''));
        }
        this._renderJson(track);
    }

    _renderJson(value) {
        this._renderSummary();
        this.outputEl.className = 'media-meta-output';
        this.outputEl.textContent = JSON.stringify(value || null, null, 2);
    }

    _renderSummary() {
        const tracks = tracksOf(this.result);
        const general = pickTrack(tracks, 'General') || {};
        const video = pickTrack(tracks, 'Video') || {};
        const audio = pickTrack(tracks, 'Audio') || {};
        const cards = [
            ['Format', general.Format || video.Format || audio.Format || ''],
            ['Duration', formatSeconds(general.Duration || video.Duration || audio.Duration)],
            ['Video', video.Format ? `${video.Format}${video.Width ? ` ${video.Width}x${video.Height || ''}` : ''}` : ''],
            ['Audio', audio.Format ? `${audio.Format}${audio.Channels ? ` ${audio.Channels}ch` : ''}` : ''],
        ];
        this.summaryEl.innerHTML = '';
        for (const [label, value] of cards) {
            const card = document.createElement('div');
            card.className = 'media-meta-card';
            card.innerHTML = '<div class="media-meta-card-label"></div><div class="media-meta-card-value"></div>';
            card.querySelector('.media-meta-card-label').textContent = label;
            card.querySelector('.media-meta-card-value').textContent = value || '-';
            this.summaryEl.appendChild(card);
        }
    }

    _exportJson() {
        if (!this.result || !this.ctx) return;
        const name = this.fileName.replace(/\.[^.]+$/, '') + '.media.json';
        const id = this.ctx.createFile(name, JSON.stringify(this.result, null, 2));
        this.ctx.openEditorTab('editor', { fileId: id, filePath: name }, name, 'editor-' + id);
    }

    _showMessage(message) {
        this._clear();
        this.outputEl.className = 'media-meta-message';
        this.outputEl.textContent = message;
    }

    _showError(message) {
        this.outputEl.className = 'media-meta-error';
        this.outputEl.textContent = message;
        this.statusEl.textContent = 'Error';
    }

    _clear() {
        this.tracksEl.innerHTML = '';
        this.summaryEl.innerHTML = '';
        this.outputEl.className = 'media-meta-output';
        this.outputEl.textContent = '';
    }

    _destroy() {}
}

registerPlugin({
    id: 'media-metadata',
    name: 'Media Metadata',
    components: {
        mediaMetadata: MediaMetadataComponent,
    },
    toolbarButtons: [
        { label: 'MediaInfo', title: 'Open Media Metadata Inspector' },
    ],
    contextMenuItems: [{
        label: 'Read Media Metadata',
        canHandle: (fileName) => MEDIA_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = MediaMetadataComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('mediaMetadata', { fileId }, `${file.name} [metadata]`, 'media-meta-' + fileId);
        },
    }],
    init(ctx) {
        MediaMetadataComponent._ctx = ctx;
    },
});
