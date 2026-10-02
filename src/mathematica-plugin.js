// --- Mathematica Notebook Plugin ---
// Shows Mathematica notebooks (.nb) as Mathematica lays them out, without a
// kernel: the notebook's text is read (wl-parse.js) and its cells drawn
// (nb-render.js): sections, text, typeset input and output, plots as SVG,
// 3D graphics that turn when dragged. Groups fold with their brackets on
// the right, as in Mathematica. Nothing is evaluated.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
const { parseWL, expandCompressedData } = require('./wl-parse');
const { renderNotebook, drawScene, NB_CSS } = require('./nb-render');

const NB_RE = /\.nb$/i;
let _ctx = null;

function installStyles() {
    if (document.getElementById('nb-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'nb-viewer-style';
    style.textContent = NB_CSS + `
.nb-viewer-root{height:100%;overflow:auto;background:#fff}
.nb-viewer-status{padding:20px;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#555}
.nb-viewer-status.error{color:#a33}
`;
    document.head.appendChild(style);
}

// Pixels (RasterBox) as an image URL
function rasterUrl(width, height, rgba) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas.toDataURL();
}

// Turning a 3D graphic: dragging moves the view point around the box's centre
function bindScenes(root, scenes) {
    for (const el of root.querySelectorAll('.nb-g3d[data-scene]')) {
        const scene = scenes[+el.dataset.scene];
        if (!scene) continue;
        let view = { viewPoint: scene.viewPoint.slice() };
        let drag = null;
        el.addEventListener('pointerdown', (e) => {
            drag = { x: e.clientX, y: e.clientY, vp: view.viewPoint.slice() };
            el.setPointerCapture(e.pointerId);
            el.classList.add('dragging');
            e.preventDefault();
        });
        el.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const [x, y, z] = drag.vp;
            const r = Math.hypot(x, y, z);
            let az = Math.atan2(y, x) - (e.clientX - drag.x) * 0.01;
            let el2 = Math.asin(Math.max(-1, Math.min(1, z / r))) + (e.clientY - drag.y) * 0.01;
            el2 = Math.max(-1.55, Math.min(1.55, el2));
            view = { viewPoint: [r * Math.cos(el2) * Math.cos(az), r * Math.cos(el2) * Math.sin(az), r * Math.sin(el2)] };
            const { html } = drawScene(scene, view);
            el.innerHTML = html;
        });
        const end = () => { drag = null; el.classList.remove('dragging'); };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
    }
}

class MathematicaViewer {
    constructor(container, state) {
        this.container = container;
        this.fileId = state && state.fileId;
        installStyles();
        this.root = container.element;
        this.root.classList.add('nb-viewer-root');
        this.root.addEventListener('click', (e) => {
            const br = e.target.closest('.nb-gbr');
            if (!br) return;
            const group = br.parentElement;
            const closed = !group.classList.contains('closed');
            group.classList.toggle('closed', closed);
            const kids = [...group.children].filter(k => !k.classList.contains('nb-br'));
            kids.forEach((k, i) => { if (i > 0) { if (closed) k.setAttribute('data-hidden', '1'); else k.removeAttribute('data-hidden'); } });
        });
        this.load();
    }

    status(text, isError) {
        this.root.innerHTML = `<div class="nb-viewer-status${isError ? ' error' : ''}"></div>`;
        this.root.firstChild.textContent = text;
    }

    async text() {
        const file = _ctx && _ctx.projectFiles[this.fileId];
        if (!file) return null;
        if (typeof file.content === 'string' && file.content.length) return file.content;
        if (!_ctx.currentWorkspacePath) return null;
        const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + _ctx.getRelativePath(this.fileId)));
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`could not read the file (${resp.status})`);
        return resp.text();
    }

    async load() {
        this.status('Reading the notebook…');
        try {
            const src = await this.text();
            if (src === null) { this.status('No notebook file selected.', true); return; }
            const expr = await expandCompressedData(parseWL(src));
            const { html, scenes } = renderNotebook(expr, { rasterUrl });
            this.root.innerHTML = html;
            bindScenes(this.root, scenes);
        } catch (err) {
            this.status('Could not show this notebook: ' + err.message, true);
        }
    }
}

registerPlugin({
    id: 'mathematica',
    name: 'Mathematica notebooks',
    components: {
        mathematicaViewer: MathematicaViewer,
    },
    contextMenuItems: [{
        label: 'Open as Mathematica notebook',
        canHandle: (fileName) => NB_RE.test(fileName || ''),
        action: (fileId) => {
            const file = _ctx && _ctx.projectFiles[fileId];
            if (file) _ctx.openEditorTab('mathematicaViewer', { fileId }, `${file.name} [notebook]`, 'mathematica-' + fileId);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
