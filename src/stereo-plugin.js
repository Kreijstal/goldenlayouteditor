// --- Stereo picture viewer ---
// Stereo pictures: an MPO (CIPA DC-007 Multi-Picture Object: a 3D camera's or
// a Nintendo 3DS's JPEGs one after another, indexed in the first one's APP2)
// and the side-by-side JPS (JPEG) and PNS (PNG), whose right eye is on the
// left (made for crossed eyes). ExifReader (loaded from jsDelivr when an MPO is
// opened) reads the MPO's index and gives its images; stereo-img (Google's web
// component, three.js, loaded from jsDelivr when one is opened) shows the pair
// as one eye, the other, a wiggle between them or a red-cyan anaglyph, and in
// a VR headset in 3D. The two pictures can also be shown side by side, for
// crossed or for parallel eyes, and the eyes swapped (for a JPS or PNS saved
// with the left eye on the left). The plain picture (an MPO's first JPEG, the
// whole side-by-side image) stays in the image viewer, the second choice.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const STEREO_IMG = 'https://cdn.jsdelivr.net/npm/stereo-img@1.28.0/stereo-img.js';
const EXIFREADER = 'https://cdn.jsdelivr.net/npm/exifreader@4.47.0/+esm';
const MPO_RE = /\.mpo$/i;
const MODES = [
    ['left', 'Left', 'The left eye\'s picture'],
    ['right', 'Right', 'The right eye\'s picture'],
    ['wiggle', 'Wiggle', 'The two pictures one after the other'],
    ['anaglyph', 'Anaglyph', 'Red-cyan glasses'],
    ['cross', 'Cross', 'Side by side for crossed eyes (the right eye\'s picture on the left)'],
    ['parallel', 'Parallel', 'Side by side for parallel eyes (the left eye\'s picture on the left)'],
];
let _ctx = null;
let _stereoImgPromise = null;
let _exifReaderPromise = null;

function loadStereoImg() {
    if (!_stereoImgPromise) _stereoImgPromise = import(/* webpackIgnore: true */ STEREO_IMG).catch(err => { _stereoImgPromise = null; throw err; });
    return _stereoImgPromise;
}

function loadExifReader() {
    if (!_exifReaderPromise) _exifReaderPromise = import(/* webpackIgnore: true */ EXIFREADER).then(m => m.default || m).catch(err => { _exifReaderPromise = null; throw err; });
    return _exifReaderPromise;
}

// The two eyes' pictures, as blobs: an MPO's first two disparity images
// (its left and right eye, by CIPA DC-007), or a side-by-side file whole
// (split by stereo-img). { left, right } or { whole }, and what the file is
async function readStereo(buffer, name) {
    if (!MPO_RE.test(name)) {
        const type = /\.pns$/i.test(name) ? 'image/png' : 'image/jpeg';
        return { whole: new Blob([buffer], { type }), label: /\.pns$/i.test(name) ? 'side-by-side PNG' : 'side-by-side JPEG' };
    }
    const ExifReader = await loadExifReader();
    const tags = ExifReader.load(buffer, { expanded: true, includeTags: { mpf: true } });
    const images = (tags.mpf && tags.mpf.Images || []).filter(im => im.image && im.image.byteLength);
    const eyes = images.filter(im => /Disparity/i.test(im.ImageType && im.ImageType.description || ''));
    const label = `MPO, ${images.length} image${images.length === 1 ? '' : 's'}`;
    if (eyes.length >= 2) {
        return { left: new Blob([eyes[0].image], { type: 'image/jpeg' }), right: new Blob([eyes[1].image], { type: 'image/jpeg' }), label };
    }
    // Not a stereo pair (a panorama, a multi-angle set, a preview): its first picture, the same for both eyes
    const first = images.length ? images[0].image : buffer;
    const blob = new Blob([first], { type: 'image/jpeg' });
    return { left: blob, right: blob, mono: true, label: images.length ? label + ', not a stereo pair' : 'JPEG without a multi-picture index' };
}

function dataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

// A side-by-side picture's two eyes as bitmaps, [left eye, right eye]: the right half and the left half
async function halves(blob) {
    const whole = await createImageBitmap(blob);
    const w = Math.floor(whole.width / 2), h = whole.height;
    const eyes = await Promise.all([createImageBitmap(whole, w, 0, w, h), createImageBitmap(whole, 0, 0, w, h)]);
    whole.close();
    return eyes;
}

class StereoComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'picture.mpo';
        this.mode = 'left';
        this.swap = false;
        this.data = null;
        this.bitmaps = null; // [left, right] for the side-by-side views
        this.stereoEl = null;
        this.root = container.element;
        this.root.classList.add('stereo-root');
        StereoComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._load();
    }

    static _installStyles() {
        if (StereoComponent._styled) return;
        StereoComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.stereo-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.stereo-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.stereo-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.stereo-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.stereo-root button:hover{background:#444c56}
.stereo-root button.active{background:#1f6feb;border-color:#388bfd}
.stereo-root label{display:flex;align-items:center;gap:4px}
.stereo-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stereo-stage{position:relative;overflow:hidden;min-height:0;background:#101010}
.stereo-stage stereo-img{position:absolute;inset:0;width:100%;height:100%!important}
.stereo-stage canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.stereo-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.stereo-message{padding:20px;color:#adbac7;text-align:center}
.stereo-error{padding:20px;color:#ffb4ab;text-align:center;white-space:pre-wrap}
`;
        document.head.appendChild(style);
    }

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    _buildUI() {
        const shell = this._el('div', 'stereo-shell');
        const bar = this._el('div', 'stereo-toolbar');
        bar.appendChild(this._el('span', 'stereo-title', this.fileName));
        this.modeButtons = MODES.map(([mode, label, title]) => {
            const b = this._el('button', null, label);
            b.type = 'button';
            b.title = title;
            b.dataset.mode = mode;
            b.addEventListener('click', () => this._setMode(mode));
            bar.appendChild(b);
            return b;
        });
        const swapLabel = this._el('label');
        swapLabel.title = 'Take the other picture for each eye';
        this.swapInput = this._el('input');
        this.swapInput.type = 'checkbox';
        this.swapInput.addEventListener('change', () => { this.swap = this.swapInput.checked; this._show(); });
        swapLabel.append(this.swapInput, 'Swap eyes');
        bar.appendChild(swapLabel);
        this.stage = this._el('div', 'stereo-stage');
        this.stage.appendChild(this._el('div', 'stereo-message', `Reading ${this.fileName}…`));
        const status = this._el('div', 'stereo-status');
        this.infoEl = this._el('span', null, '');
        this.hintEl = this._el('span', null, '');
        status.append(this.infoEl, this.hintEl);
        shell.append(bar, this.stage, status);
        this.root.appendChild(shell);
        this._markMode();
    }

    async _load() {
        try {
            if (!_ctx || !_ctx.currentWorkspacePath || !this.fileId) throw new Error('opening a stereo picture needs the server workspace');
            const rel = _ctx.getRelativePath(this.fileId);
            const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            this.data = await readStereo(await resp.arrayBuffer(), this.fileName);
            this.bitmaps = this.data.whole ? await halves(this.data.whole)
                : await Promise.all([createImageBitmap(this.data.left), createImageBitmap(this.data.right)]);
            // data: URLs, not blob: ones: stereo-img revokes what it has loaded, then reads its Exif (the
            // focal length, for the angle of view) from the same URL
            this.urls = {};
            for (const k of ['whole', 'left', 'right']) if (this.data[k]) this.urls[k] = await dataUrl(this.data[k]);
            const [l] = this.bitmaps;
            this.infoEl.textContent = `${this.data.label} · ${l.width}×${l.height} per eye`;
            await loadStereoImg();
            this._show();
        } catch (err) {
            this.stage.innerHTML = '';
            this.stage.appendChild(this._el('div', 'stereo-error', `Could not show ${this.fileName}: ${err.message}`));
        }
    }

    _setMode(mode) {
        this.mode = mode;
        this._markMode();
        this._show();
    }

    _markMode() {
        for (const b of this.modeButtons) b.classList.toggle('active', b.dataset.mode === this.mode);
    }

    _show() {
        if (!this.data || !this.bitmaps) return;
        if (this.mode === 'cross' || this.mode === 'parallel') {
            this._removeStereoImg();
            this._drawSideBySide();
            this.hintEl.textContent = this.mode === 'cross' ? 'cross your eyes until the two pictures meet' : 'look through the screen until the two pictures meet';
            return;
        }
        if (this.canvas) { this.canvas.remove(); this.canvas = null; }
        this.hintEl.textContent = 'drag to look around · the VR button shows it in a headset';
        let el = this.stereoEl;
        if (!el) {
            // made by the parser, in the stage: its constructor sets its own style, which createElement forbids
            this.stage.innerHTML = '<stereo-img></stereo-img>';
            el = this.stereoEl = this.stage.firstElementChild;
        }
        el.setAttribute('controlslist', 'vr');
        el.setAttribute('flat', this.mode);
        // the pictures again only when the eyes change
        if (el._stereoSwap === this.swap) return;
        el._stereoSwap = this.swap;
        if (this.data.whole) {
            el.removeAttribute('src-right');
            el.setAttribute('type', this.swap ? 'left-right' : 'right-left');
            el.setAttribute('src', this.urls.whole);
        } else {
            const [left, right] = this.swap ? [this.urls.right, this.urls.left] : [this.urls.left, this.urls.right];
            el.setAttribute('type', 'pair');
            el.setAttribute('src-right', right);
            el.setAttribute('src', left);
        }
    }

    // Both pictures next to each other on a canvas, the right eye's on the left for crossed eyes
    _drawSideBySide() {
        let [left, right] = this.bitmaps;
        if (this.swap) [left, right] = [right, left];
        const [a, b] = this.mode === 'cross' ? [right, left] : [left, right];
        if (!this.canvas) {
            this.stage.innerHTML = '';
            this.canvas = this._el('canvas');
            this.stage.appendChild(this.canvas);
        }
        const c = this.canvas;
        c.width = a.width + b.width;
        c.height = Math.max(a.height, b.height);
        const g = c.getContext('2d');
        g.drawImage(a, 0, 0);
        g.drawImage(b, a.width, 0);
    }

    _removeStereoImg() {
        if (!this.stereoEl) return;
        const r = this.stereoEl.renderer;
        if (r) { r.setAnimationLoop(null); r.dispose(); }
        clearInterval(this.stereoEl.wiggleIntervalID);
        this.stereoEl.remove();
        this.stereoEl = null;
    }

    _destroy() {
        this._removeStereoImg();
        if (this.bitmaps) for (const b of new Set(this.bitmaps)) b.close();
        this.bitmaps = null;
    }
}

registerPlugin({
    id: 'stereo',
    name: 'Stereo pictures',
    components: {
        stereoViewer: StereoComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
