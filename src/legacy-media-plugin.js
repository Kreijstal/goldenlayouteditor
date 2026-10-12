const { registerPlugin } = require('./plugins');
const { readViewerFile, element } = require('./viewer-file');
const { resolveFileUrl } = require('./archive-fallback');
let ctx;
function validateMedia(bytes, name) {
    const text = new TextDecoder().decode(bytes.subarray(0, 128));
    if (/\.amr$/i.test(name)) return /^#!AMR(?:-WB)?\n/.test(text);
    if (/\.(aif|aiff|aifc)$/i.test(name)) return text.slice(0, 4) === 'FORM' && /^(AIFF|AIFC)$/.test(text.slice(8, 12));
    if (/\.3g2$/i.test(name)) return text.slice(4, 8) === 'ftyp' && /3g2[abc]/.test(text.slice(8));
    return false;
}
class LegacyMediaViewer {
    constructor(container, state) {
        this.fileId = state.fileId; this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:auto;background:#1f2328;color:#eee;font:13px system-ui';
        const bar = element('div', null, this.root); bar.style.padding = '10px';
        this.status = element('span', 'Reading media…', bar);
        this.convertButton = element('button', 'Convert for playback', bar); this.convertButton.hidden = true;
        this.convertButton.onclick = () => this.convert(true);
        container.on('destroy', () => { this.destroyed = true; if (this.player) { this.player.pause(); this.player.removeAttribute('src'); this.player.load(); } if (this.worker) this.worker.terminate(); clearTimeout(this.timeout); if (this.url) URL.revokeObjectURL(this.url); });
        this.load();
    }
    async load() {
        try {
            this.file = ctx.projectFiles[this.fileId];
            const video = /\.3g2$/i.test(this.file.name);
            if (!video) return await this.convert(false);
            let url;
            if (this.file.bytes) {
                if (!validateMedia(this.file.bytes, this.file.name)) throw new Error('Not a 3GPP2 media container.');
                url = this.url = URL.createObjectURL(new Blob([this.file.bytes], { type: 'video/3gpp2' }));
            } else {
                url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + ctx.getRelativePath(this.fileId)));
                const response = await fetch(url, { headers: { Range: 'bytes=0-127' } });
                if (!response.ok || !validateMedia(new Uint8Array(await response.arrayBuffer()), this.file.name)) throw new Error('Not a 3GPP2 media container.');
            }
            if (this.destroyed) return;
            this.convertButton.hidden = false;
            this.player = element('video', null, this.root); this.player.controls = true; this.player.style.cssText = 'width:100%;max-height:80%;background:#000';
            this.player.onerror = () => { if (!this.destroyed) this.status.textContent = 'Browser cannot play this codec; use Convert for playback.'; };
            this.player.onloadedmetadata = () => { if (!this.destroyed) this.status.textContent = `${this.file.name} · ${this.player.duration.toFixed(2)} s`; };
            this.status.textContent = this.file.name;
            this.player.src = url;
        } catch (err) { if (!this.destroyed) this.status.textContent = 'Could not play media: ' + err.message; }
    }
    async convert(video) {
        this.convertButton.disabled = true;
        try {
            const bytes = await readViewerFile(ctx, this.fileId, null, true);
            if (!validateMedia(bytes, this.file.name)) throw new Error('The file header does not match its media extension.');
            if (bytes.length > (video ? 256 : 64) * 1024 * 1024) throw new Error(`Conversion input is limited to ${video ? 256 : 64} MB.`);
            if (this.destroyed) return;
            this.status.textContent = video ? 'Converting video for playback…' : 'Decoding audio…';
            const result = await new Promise((resolve, reject) => {
                this.worker = new Worker(new URL('media-convert-worker.js', document.baseURI));
                this.timeout = setTimeout(() => { this.worker.terminate(); reject(new Error('Media conversion timed out after 120 seconds.')); }, 120000);
                this.worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
                this.worker.onerror = e => reject(new Error(e.message || 'Media worker failed.'));
                const buffer = bytes.slice().buffer; this.worker.postMessage({ bytes: buffer, video }, [buffer]);
            });
            clearTimeout(this.timeout); this.worker.terminate(); this.worker = null;
            if (this.destroyed) return;
            if (this.url) URL.revokeObjectURL(this.url);
            this.url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }));
            if (!this.player) { this.player = element(video ? 'video' : 'audio', null, this.root); this.player.controls = true; this.player.style.cssText = 'width:100%;max-height:80%;margin:auto'; }
            this.player.onerror = () => { if (!this.destroyed) this.status.textContent = 'Decoded output could not be played by this browser.'; };
            this.player.onloadedmetadata = () => { if (!this.destroyed) this.status.textContent = `${this.file.name} · decoded ${video ? 'MP4' : 'PCM audio'} · ${this.player.duration.toFixed(2)} s`; };
            this.player.src = this.url;
        } catch (err) {
            clearTimeout(this.timeout); if (this.worker) this.worker.terminate(); this.worker = null;
            if (!this.destroyed) this.status.textContent = 'Could not convert media: ' + err.message;
        } finally { if (!this.destroyed) this.convertButton.disabled = false; }
    }
}
registerPlugin({ id: 'legacy-media', name: '3GPP2, AIFF and AMR playback', components: { legacyMediaViewer: LegacyMediaViewer }, init(context) { ctx = context; } });
module.exports = { validateMedia };
