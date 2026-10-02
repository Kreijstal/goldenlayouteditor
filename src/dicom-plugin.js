// --- DICOM (.dcm, .dicom, and files with the DICM preamble) ---
// Medical images: a cornerstone3D stack viewer (window/level, zoom/pan,
// frames, presets, measurements) beside the full attribute list, and the
// folder's other DICOM files grouped into series that open as one stack.
// Modelled on the Nextcloud dicomviewer app. Read-only. Only this shell is in
// the bundle: the viewer (public/dicom-viewer/) and its libraries (esm.sh)
// are loaded when a file is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('DICOM');
let _ctx = null;
let _viewerPromise = null;
// The encapsulated PDF last opened (an in-memory file): replaced by the next one. Not removed when
// the DICOM viewer closes, as opening the PDF in browse mode replaces the viewer
let _pdfId = null;

// Names a series scan looks at: DICOM extensions and extensionless files
const SERIES_NAME_RE = /^[^.]+$|\.(dcm|dicom|dic|ima)$/i;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/dicom-viewer/dicom-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

// Whether a file has DICOM's "DICM" at offset 128 (after the preamble): from its first bytes when
// browse mode kept them (file.head), else from its text (the preamble is usually NULs, one char each)
function hasDicomPreamble(file) {
    if (!file) return false;
    const head = file.head || file.bytes;
    if (head instanceof Uint8Array) {
        return head.length >= 132 && head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d;
    }
    return typeof file.content === 'string' && file.content.slice(128, 132) === 'DICM';
}

function randomToken() {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(36) + a[1].toString(36);
}

class DicomComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#000';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="dcm-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="dcm-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="dcm-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#aaa;font:13px sans-serif">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.dcm-status');
        this.host = this.root.querySelector('.dcm-host');
        this.root.querySelector('.dcm-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) {
            container.on('destroy', () => {
                this.destroyed = true;
                if (this.viewer) this.viewer.destroy();
            });
        }
        this._init();
    }

    _relPath(fileId) {
        return _ctx.getRelativePath ? _ctx.getRelativePath(fileId) : null;
    }

    _fileUrl(fileId) {
        const rel = this._relPath(fileId);
        if (!_ctx.currentWorkspacePath || !rel) throw new Error('DICOM files need the server workspace');
        return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
    }

    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const resp = await fetch(await this._fileUrl(this.fileId));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    // The other files of the same folder that could be DICOM: the series scan reads their headers
    _siblings() {
        const own = this._relPath(this.fileId);
        if (!own || !_ctx.currentWorkspacePath || this.fileData.memoryOnly) return [];
        const dir = own.includes('/') ? own.slice(0, own.lastIndexOf('/') + 1) : '';
        const out = [];
        for (const [id, f] of Object.entries(_ctx.projectFiles)) {
            if (id === this.fileId || !f || f.type === 'directory' || f.memoryOnly || !SERIES_NAME_RE.test(f.name)) continue;
            const rel = this._relPath(id);
            if (!rel || rel !== dir + f.name) continue;
            out.push({ name: f.name, size: f.size, url: () => this._fileUrl(id) });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }

    // An encapsulated PDF: opened in the app's PDF viewer as an in-memory file beside this one
    _openPdf(bytes, name) {
        if (!_ctx.addMemoryFile || !_ctx.currentWorkspacePath) throw new Error('PDFs need the server workspace');
        if (_pdfId) _ctx.removeMemoryFile(_pdfId);
        const own = this._relPath(this.fileId) || this.fileData.name;
        const dir = own.includes('/') ? own.slice(0, own.lastIndexOf('/') + 1) : '';
        const file = { name, type: 'file', content: '', bytes, viewType: 'pdf', cursor: { row: 0, column: 0 }, selection: null };
        _pdfId = _ctx.addMemoryFile(file, `${dir}.in-memory-${randomToken()}/${name}`, bytes);
        _ctx.openEditorTab('editor', { fileId: _pdfId }, name, 'editor-' + _pdfId);
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
            if (this.destroyed) return;
            this.host.textContent = '';
            this.viewer = await mod.mountDicomViewer(this.host, {
                bytes,
                name: this.fileData.name,
                siblings: async () => this._siblings(),
                openPdf: (pdf, name) => {
                    try {
                        this._openPdf(pdf, name);
                    } catch (err) {
                        this._status('Could not open the PDF: ' + err.message, true);
                    }
                },
            });
            if (this.destroyed) { this.viewer.destroy(); return; }
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the DICOM file: ' + err.message);
        }
        const info = this.viewer.info;
        const parts = [info.modality, info.sopClassName || info.sopClass];
        if (info.isImage) parts.push(`${info.columns}×${info.rows}` + (info.frames > 1 ? ` · ${info.frames} frames` : ''));
        parts.push('read-only');
        this._status(info.error ? info.error : parts.filter(Boolean).join(' · '), !!info.error);
        log.log(`Opened ${this.fileData.memoryOnly ? '(in-memory file)' : this.fileData.name}: ${info.sopClassName || '?'}, ${info.transferSyntax || '?'}${info.error ? ', ' + info.error : ''}`);
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.title = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this.host.innerHTML = '<div style="padding:20px;color:#ffb4ab;font:13px sans-serif;white-space:pre-wrap"></div>';
        this.host.firstChild.textContent = message;
        this._status('error', true);
    }
}

registerPlugin({
    id: 'dicom',
    name: 'DICOM viewer',
    components: {
        dicomViewer: DicomComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { hasDicomPreamble };
