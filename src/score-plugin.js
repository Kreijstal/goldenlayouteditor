// --- Music scores (MuseScore, MusicXML, Guitar Pro, MIDI...) ---
// Engraves a score with webmscore (MuseScore compiled to WebAssembly,
// @kreijstal/webmscore-wasm on jsDelivr) and shows its pages side by side or stacked, with zoom, playback
// through a soundfont following the measures, its parts and metadata, and export
// to PDF/MusicXML/MIDI. Read-only. Only this shell is in the bundle: the viewer
// (public/score-viewer/) and webmscore are loaded when a score is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('Score');
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/score-viewer/score-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

class ScoreComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#e8e8e8';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="score-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="score-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="score-host" style="flex:1;min-height:0;position:relative;overflow:hidden"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.score-status');
        this.titleEl = this.root.querySelector('.score-title');
        this.host = this.root.querySelector('.score-host');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) container.on('destroy', () => { if (this.viewer) this.viewer.destroy(); this.destroyed = true; });
        this._init();
    }

    // The file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (path) {
            const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
            if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
            return new Uint8Array(await resp.arrayBuffer());
        }
        // A text score (MusicXML, MSCX) made in the editor
        if (typeof file.content === 'string') return new TextEncoder().encode(file.content);
        throw new Error('the score is not readable here');
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        let mod, bytes;
        try {
            [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the score: ' + err.message);
        }
        if (this.destroyed) return;
        this.host.textContent = '';
        const name = this.fileData.name;
        this.viewer = mod.mountScoreViewer(this.host, { bytes, name, onStatus: (t, e) => this._status(t, e) });
        try {
            const meta = await this.viewer.ready;
            if (!meta) return;
            const { title, composer } = mod.scoreTitle(meta);
            if (title) this.titleEl.textContent = `${title}${composer && !title.includes(composer) ? ' — ' + composer : ''}`;
            this.titleEl.title = name;
            log.log(`Opened ${name}: ${meta.pages} pages, ${meta.measures} measures, ${(meta.parts || []).length} parts`);
        } catch (err) {
            log.error('Engraving failed:', err);
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this.host.innerHTML = '<div style="padding:20px;color:#a33"></div>';
        this.host.firstChild.textContent = message;
        this._status(message, true);
    }
}

registerPlugin({
    id: 'score',
    name: 'Music score viewer',
    components: {
        scoreViewer: ScoreComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
