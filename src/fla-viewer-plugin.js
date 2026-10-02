// --- FLA Viewer Plugin ---
// Opens Adobe Animate/Flash .fla source files with the parser and canvas player of
// github.com/lifeart/fla-viewer, loaded from esm.sh (public/fla-viewer/fla-viewer.js).
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

let _ctx = null;
let _viewerModulePromise = null;

function extOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function workspaceUrl(fileId) {
    if (!_ctx || !_ctx.currentWorkspacePath) return null;
    const rel = _ctx.getRelativePath(fileId);
    if (!rel) return null;
    return '/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel);
}

function ensureStyles() {
    if (document.getElementById('fla-viewer-plugin-style')) return;
    const style = document.createElement('style');
    style.id = 'fla-viewer-plugin-style';
    style.textContent = `
.fla-viewer-root {
  box-sizing: border-box;
  display: grid;
  grid-template-rows: auto 1fr auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #25282d;
  color: #f3f4f6;
  font: 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.fla-toolbar {
  display: grid;
  grid-template-columns: repeat(5, auto) minmax(96px, 180px) minmax(140px, 1fr) 96px auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.12);
  background: #31353b;
}
.fla-toolbar button,
.fla-toolbar select {
  height: 28px;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 4px;
  background: #424852;
  color: #fff;
  font: inherit;
}
.fla-toolbar button {
  min-width: 52px;
  padding: 0 10px;
}
.fla-toolbar button:disabled,
.fla-toolbar input:disabled,
.fla-toolbar select:disabled {
  opacity: 0.55;
}
.fla-toolbar input[type="range"] {
  width: 100%;
}
.fla-frame-label {
  min-width: 160px;
  color: #d1d5db;
  white-space: nowrap;
  text-align: right;
}
.fla-stage-wrap {
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: #181a1f;
}
.fla-stage {
  display: block;
  max-width: 100%;
  max-height: 100%;
  background: #fff;
}
.fla-status {
  min-height: 28px;
  padding: 6px 10px;
  border-top: 1px solid rgba(255,255,255,0.12);
  color: #cbd5e1;
  background: #25282d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 720px) {
  .fla-toolbar {
    grid-template-columns: repeat(5, auto) minmax(0, 1fr);
  }
  .fla-toolbar select,
  .fla-toolbar input[type="range"],
  .fla-frame-label {
    grid-column: 1 / -1;
    min-width: 0;
    text-align: left;
  }
}`;
    document.head.appendChild(style);
}

async function loadViewerModule() {
    if (!_viewerModulePromise) {
        _viewerModulePromise = import('/fla-viewer/fla-viewer.js');
    }
    return _viewerModulePromise;
}

async function mountFLAViewer(root, url, name) {
    ensureStyles();
    root.textContent = 'Loading FLA viewer...';
    const mod = await loadViewerModule();
    return mod.mountFLAViewer(root, { url, name });
}

class FLAViewerPanel {
    constructor(container, state) {
        this.container = container;
        this.root = container.element;
        this.fileId = state && state.fileId;
        this.viewer = null;
        this.root.style.cssText += 'overflow:hidden;';
        this.open();
        container.on('destroy', () => {
            if (this.viewer && this.viewer.destroy) this.viewer.destroy();
        });
    }

    async open() {
        if (!this.fileId || !_ctx || !_ctx.projectFiles[this.fileId]) {
            this.root.textContent = 'No FLA file selected.';
            return;
        }
        const file = _ctx.projectFiles[this.fileId];
        const url = await resolveFileUrl(workspaceUrl(this.fileId));
        if (!url) {
            this.root.textContent = 'FLA viewing requires a server workspace.';
            return;
        }
        this.viewer = await mountFLAViewer(this.root, url, file.name);
    }
}

registerPlugin({
    id: 'fla-viewer',
    name: 'FLA Viewer',
    components: {
        flaViewer: FLAViewerPanel,
    },
    contextMenuItems: [
        {
            label: 'Open FLA Viewer',
            canHandle: (fileName) => extOf(fileName) === 'fla',
            action: (fileId) => {
                if (_ctx) _ctx.openPluginPanel('flaViewer', 'FLA Viewer', { fileId });
            },
        },
    ],
    thumbnailRenderers: [
        {
            canHandle(file) {
                return file.type === 'file' && extOf(file.name) === 'fla';
            },
            render(file, container) {
                container.textContent = 'FLA';
                container.style.fontSize = '13px';
            },
        },
    ],
    init(ctx) {
        _ctx = ctx;
        window.__goldenlayoutFlaViewer = {
            mount: mountFLAViewer,
        };
    },
});
