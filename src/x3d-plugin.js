// --- X3D player ---
// X3D scenes: the XML encoding (.x3d), the classic VRML encoding (.x3dv), the
// JSON encoding (.x3dj) and those gzipped (.x3dz, .x3dvz). X_ITE (Create3000's
// X3D browser, loaded from jsDelivr when one is opened) reads and plays them in
// its own <x3d-canvas>: its navigation (examine, walk, fly, ... from its
// right-click menu), the scene's viewpoints, its animations (TimeSensors,
// interpolators, scripts) and sensors. The files it names (Inline scenes,
// EXTERNPROTOs, textures, sounds) are read from beside it in the workspace.
// Not read: the binary encoding (.x3db, Fast Infoset: nothing on npm reads it)
// and VRML 1.0 (X_ITE reads VRML 97 / 2.0 only; .wrl stays three.js's).
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('X3D');
// Its components (assets/components/*.js), fonts and libraries load from beside the module
const X_ITE_URL = 'https://cdn.jsdelivr.net/npm/x_ite@16.4.3/dist/x_ite.min.mjs';
const X3D_RE = /\.(x3d|x3dv|x3dj|x3dz|x3dvz)$/i;
// A scene's URL as X_ITE sees it: a path, so that the files it names resolve beside it.
// fetch() of one is answered from /workspace-file (see installWorldFetch)
const WORLD_PREFIX = '/x3d-world';
const THUMB_SIZE = 256;
const THUMB_CACHE_LIMIT = 64;
let _ctx = null;
let _xitePromise = null;

function loadXite() {
    if (!_xitePromise) {
        installWorldFetch();
        _xitePromise = import(/* webpackIgnore: true */ X_ITE_URL).then(m => m.default || m).catch(err => { _xitePromise = null; throw err; });
    }
    return _xitePromise;
}

// X_ITE fetch()es everything a scene names (its textures too). A request for a
// /x3d-world/<path> URL is passed on as /workspace-file?path=<path>, through
// the page's fetch (so files inside archives are read as everywhere else)
let _worldFetchInstalled = false;
function installWorldFetch() {
    if (_worldFetchInstalled) return;
    _worldFetchInstalled = true;
    const net = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
        if (url.origin !== location.origin || !url.pathname.startsWith(WORLD_PREFIX + '/') || method.toUpperCase() !== 'GET') return net(input, init);
        const path = decodeURIComponent(url.pathname.slice(WORLD_PREFIX.length));
        return window.fetch('/workspace-file?path=' + encodeURIComponent(path), { signal: init && init.signal, cache: init && init.cache });
    };
}

function worldUrl(path) {
    return location.origin + WORLD_PREFIX + path.split('/').map(encodeURIComponent).join('/');
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

class X3dComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'scene.x3d';
        this.canvas = null;
        this.browser = null;
        this.paused = false;
        this.root = container.element;
        this.root.classList.add('x3d-root');
        X3dComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._load();
    }

    static _installStyles() {
        if (X3dComponent._styled) return;
        X3dComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.x3d-root{height:100%;background:#181a1f;color:#e8eaed;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.x3d-shell{display:flex;flex-direction:column;height:100%}
.x3d-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2b2d31;border-bottom:1px solid #3c4043;white-space:nowrap;overflow:auto}
.x3d-toolbar button{background:#3c4043;color:#e8eaed;border:1px solid #5f6368;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.x3d-toolbar button:hover{background:#4a4d52}
.x3d-toolbar button:disabled{opacity:.45;cursor:default}
.x3d-title{font-weight:600;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.x3d-viewpoint{color:#8ab4f8;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.x3d-status{margin-left:auto;color:#bdc1c6;font-size:12px}
.x3d-main{display:grid;grid-template-columns:1fr 300px;min-height:0;flex:1}
.x3d-stage{position:relative;min-width:0;min-height:0;background:#111317;overflow:hidden}
.x3d-stage x3d-canvas{position:absolute;inset:0;width:100%;height:100%}
.x3d-side{min-height:0;border-left:1px solid #3c4043;background:#202124;display:flex;flex-direction:column}
.x3d-side h3{font-size:12px;text-transform:uppercase;color:#bdc1c6;margin:0;padding:8px 10px;border-bottom:1px solid #3c4043}
.x3d-info{overflow:auto;padding:10px;flex:1}
.x3d-stat{display:grid;grid-template-columns:auto 1fr;gap:8px;padding:6px 0;border-bottom:1px solid #303134}
.x3d-stat span:first-child{color:#bdc1c6}
.x3d-stat span:last-child{text-align:right;overflow-wrap:anywhere}
.x3d-message,.x3d-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#bdc1c6;white-space:pre-wrap}
.x3d-error{color:#fecaca}
@media (max-width:800px){.x3d-main{grid-template-columns:1fr}.x3d-side{display:none}.x3d-title{display:none}}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        const shell = document.createElement('div');
        shell.className = 'x3d-shell';
        const toolbar = document.createElement('div');
        toolbar.className = 'x3d-toolbar';
        this.prevBtn = makeButton('◀', 'Previous viewpoint', () => this._viewpoint('previousViewpoint'));
        this.viewpointEl = document.createElement('span');
        this.viewpointEl.className = 'x3d-viewpoint';
        this.nextBtn = makeButton('▶', 'Next viewpoint', () => this._viewpoint('nextViewpoint'));
        this.viewAllBtn = makeButton('View all', 'Look at the whole scene', () => this.browser && this.browser.viewAll());
        this.pauseBtn = makeButton('Pause', 'Stop or go on with the animations', () => this._togglePause());
        this.reloadBtn = makeButton('Reload', 'Read the scene again (after editing it)', () => this._load());
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'x3d-title';
        this.titleEl.textContent = this.fileName;
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'x3d-status';
        toolbar.append(this.prevBtn, this.viewpointEl, this.nextBtn, this.viewAllBtn, this.pauseBtn, this.reloadBtn, this.titleEl, this.statusEl);
        const main = document.createElement('div');
        main.className = 'x3d-main';
        this.stage = document.createElement('div');
        this.stage.className = 'x3d-stage';
        const side = document.createElement('div');
        side.className = 'x3d-side';
        side.innerHTML = '<h3>Scene</h3><div class="x3d-info"></div>';
        this.infoEl = side.querySelector('.x3d-info');
        main.append(this.stage, side);
        shell.append(toolbar, main);
        this.root.appendChild(shell);
        this._setControls(false);
        // a viewpoint chosen from X_ITE's own menu, or bound by the scene
        this.stage.addEventListener('pointerup', () => setTimeout(() => this._showViewpoint(), 50));
    }

    _setControls(on) {
        for (const btn of [this.prevBtn, this.nextBtn, this.viewAllBtn, this.pauseBtn]) btn.disabled = !on;
    }

    _message(text, cls = 'x3d-message') {
        this._clearMessage();
        this.messageEl = document.createElement('div');
        this.messageEl.className = cls;
        this.messageEl.textContent = text;
        this.stage.appendChild(this.messageEl);
    }

    _clearMessage() {
        if (this.messageEl) this.messageEl.remove();
        this.messageEl = null;
    }

    async _load() {
        this._setControls(false);
        if (!_ctx || !this.fileId || !_ctx.currentWorkspacePath) {
            this._message('X3D scenes are read from the server workspace.');
            return;
        }
        const path = _ctx.currentWorkspacePath + '/' + _ctx.getRelativePath(this.fileId);
        this.statusEl.textContent = 'Loading X_ITE...';
        try {
            const X3D = await loadXite();
            if (!this.canvas) {
                this.canvas = X3D.createBrowser();
                this.canvas.setAttribute('splashScreen', 'false');
                this.stage.appendChild(this.canvas);
                this.browser = this.canvas.browser;
            }
            this.statusEl.textContent = 'Reading scene...';
            this.paused = false;
            this.pauseBtn.textContent = 'Pause';
            await this.browser.loadURL(new X3D.MFString(worldUrl(path)));
            this._clearMessage();
            this._showInfo();
            this._showViewpoint();
            this._setControls(true);
            this.statusEl.textContent = 'Right-click for navigation and viewpoints';
        } catch (err) {
            log.error('Failed to read X3D scene:', err);
            this._message(`Failed to read the X3D scene: ${err && err.message || err}`, 'x3d-error');
            this.statusEl.textContent = 'Error';
        }
    }

    // What the scene says about itself
    _showInfo() {
        const scene = this.browser.currentScene;
        const rows = [
            ['encoding', scene.encoding],
            ['X3D version', scene.specificationVersion],
            ['profile', scene.profile ? scene.profile.name : ''],
            ['components', Array.from(scene.components || [], c => c.name).join(', ')],
            ['root nodes', scene.rootNodes.length],
            ['prototypes', scene.protos.length + scene.externprotos.length],
            ['routes', scene.routes.length],
        ];
        for (const key of ['title', 'description', 'creator', 'created', 'modified']) {
            const value = scene.getMetaData ? scene.getMetaData(key) : null;
            if (value && value.length) rows.push([key, [].concat(value).join(' ')]);
        }
        this.infoEl.innerHTML = '';
        for (const [key, value] of rows) {
            if (value === '' || value === undefined || value === null) continue;
            const row = document.createElement('div');
            row.className = 'x3d-stat';
            row.innerHTML = '<span></span><span></span>';
            row.children[0].textContent = key;
            row.children[1].textContent = String(value);
            this.infoEl.appendChild(row);
        }
    }

    _viewpoint(method) {
        if (!this.browser) return;
        this.browser[method]();
        setTimeout(() => this._showViewpoint(), 50);
    }

    _showViewpoint() {
        const vp = this.browser && this.browser.activeViewpoint;
        this.viewpointEl.textContent = vp ? (vp.description || vp.getNodeName() || '(viewpoint)') : '';
    }

    _togglePause() {
        if (!this.browser) return;
        this.paused = !this.paused;
        if (this.paused) this.browser.endUpdate();
        else this.browser.beginUpdate();
        this.pauseBtn.textContent = this.paused ? 'Play' : 'Pause';
    }

    _destroy() {
        if (this.canvas) {
            this.browser.endUpdate();
            this.browser.loseContext();
            this.canvas.remove();
        }
        this.canvas = this.browser = null;
    }
}

// --- Thumbnails ---
// One hidden canvas draws them all (a page gets only a few WebGL contexts), one at a time
let _thumbCanvas = null;
let _thumbQueue = Promise.resolve();
const _thumbCache = new Map(); // absolute path -> data URL

async function drawThumbnail(path) {
    const X3D = await loadXite();
    if (!_thumbCanvas) {
        _thumbCanvas = X3D.createBrowser();
        for (const [k, v] of [['splashScreen', 'false'], ['contextMenu', 'false'], ['notifications', 'false'], ['preserveDrawingBuffer', 'true']]) _thumbCanvas.setAttribute(k, v);
        _thumbCanvas.style.cssText = `position:fixed;left:-${THUMB_SIZE * 2}px;top:0;width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;pointer-events:none`;
        document.body.appendChild(_thumbCanvas);
    }
    const browser = _thumbCanvas.browser;
    browser.beginUpdate();
    try {
        await browser.loadURL(new X3D.MFString(worldUrl(path)));
        await browser.nextFrame();
        await browser.nextFrame();
        return _thumbCanvas.toDataURL('image/png');
    } finally {
        browser.endUpdate();
    }
}

const x3dThumbnails = {
    canHandle(file) {
        return file.type === 'file' && X3D_RE.test(file.name);
    },
    async render(file, container) {
        if (!_ctx || !_ctx.currentWorkspacePath) return;
        const rel = _ctx.getRelativePath(file.id);
        if (!rel) return;
        const path = _ctx.currentWorkspacePath + '/' + rel;
        try {
            let url = _thumbCache.get(path);
            if (!url) {
                const job = _thumbQueue.then(() => drawThumbnail(path));
                _thumbQueue = job.catch(() => {});
                url = await job;
                _thumbCache.set(path, url);
                if (_thumbCache.size > THUMB_CACHE_LIMIT) _thumbCache.delete(_thumbCache.keys().next().value);
            }
            container.textContent = '';
            container.style.fontSize = '';
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;';
            container.appendChild(img);
        } catch (_) { /* keeps its icon */ }
    },
};

registerPlugin({
    id: 'x3d',
    name: 'X3D',
    components: {
        x3dViewer: X3dComponent,
    },
    thumbnailRenderers: [x3dThumbnails],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { X3D_RE };
