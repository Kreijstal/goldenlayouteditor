// --- Lottie viewer ---
// Lottie animations (Bodymovin's JSON: a .json only when its text is Lottie)
// and dotLottie bundles (.lottie: a zip of one or more animations, their
// images, themes and state machines), played on a canvas by LottieFiles'
// dotlottie-web (ThorVG in WebAssembly; loaded from jsDelivr on first use).
// Play / pause, a frame slider to scrub, frame stepping, speed, direction,
// loop; a .lottie's animations, themes and markers can be picked. Images a
// .json names beside it (assets with "u" and "p") are read from its folder.
// The animation follows the file's text as it is edited. Also draws
// thumbnails in the file browser's grid (a frame from the middle).
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const VERSION = '0.81.0';
const LIB = `https://cdn.jsdelivr.net/npm/@lottiefiles/dotlottie-web@${VERSION}/dist/index.js`;
const WASM = `https://cdn.jsdelivr.net/npm/@lottiefiles/dotlottie-web@${VERSION}/dist/dotlottie-player.wasm`;

const DOTLOTTIE_RE = /\.lottie$/i;
const JSON_RE = /\.json$/i;

// Lottie's top level: a version "v", the frame rate "fr", in and out points
// "ip" / "op", the size "w" / "h" and "layers"; any other JSON stays text
function looksLikeLottie(text) {
    if (!/^\s*\{/.test(text)) return false;
    return /"v"\s*:\s*"\d+\.\d+/.test(text) && /"layers"\s*:\s*\[/.test(text)
        && ['fr', 'ip', 'op', 'w', 'h'].every(k => new RegExp(`"${k}"\\s*:\\s*-?\\d`).test(text));
}

// A .lottie, or a .json whose text (once read) is Lottie
function isLottieFile(f) {
    if (DOTLOTTIE_RE.test(f.name)) return true;
    if (!JSON_RE.test(f.name) || (f.viewType && f.viewType !== 'json')) return false;
    return typeof f.content === 'string' && looksLikeLottie(f.content);
}

let _ctx = null;
let _lib = null;

function ensureLib() {
    if (!_lib) {
        _lib = import(LIB).then(m => {
            m.DotLottie.setWasmUrl(WASM);
            return m.DotLottie;
        });
        _lib.catch(() => { _lib = null; });
    }
    return _lib;
}

async function fetchWorkspace(rel) {
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel)));
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
    return resp;
}

async function readText(file) {
    // (a file the browser lists but hasn't read yet holds '' until then)
    if (typeof file.content === 'string' && !file.lazy) return file.content;
    return (await fetchWorkspace(_ctx.getRelativePath(file.id))).text();
}

async function readBytes(file) {
    if (file.bytes instanceof Uint8Array) return file.bytes;
    return new Uint8Array(await (await fetchWorkspace(_ctx.getRelativePath(file.id))).arrayBuffer());
}

// The images a Lottie JSON names but does not embed ("u" folder + "p" name, not
// data: URLs), read from beside the file, as dotlottie-web's asset resolver
async function externalAssets(json, file) {
    const found = new Map();
    const assets = Array.isArray(json.assets) ? json.assets : [];
    const wanted = assets.filter(a => a && typeof a.p === 'string' && a.e !== 1 && !/^data:/.test(a.p));
    if (!wanted.length || !file || !_ctx || !_ctx.currentWorkspacePath) return null;
    const rel = _ctx.getRelativePath(file.id) || '';
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    await Promise.all(wanted.map(async a => {
        const path = (a.u || '').replace(/^\/+/, '') + a.p;
        try {
            const bytes = new Uint8Array(await (await fetchWorkspace(dir + path)).arrayBuffer());
            for (const key of [path, '/' + path, a.p]) found.set(key, bytes);
        } catch (_) { /* left unresolved: drawn without it */ }
    }));
    return found.size ? src => found.get(src) || found.get(src.replace(/^\/+/, '')) || found.get(src.split('/').pop()) : null;
}

// What the JSON says of itself: size, frame rate, frames, layers
function describeJson(json) {
    const frames = (json.op || 0) - (json.ip || 0);
    return {
        name: json.nm || '', version: json.v || '', width: json.w, height: json.h, fps: json.fr,
        frames, layers: Array.isArray(json.layers) ? json.layers.length : 0,
        assets: Array.isArray(json.assets) ? json.assets.length : 0,
        markers: Array.isArray(json.markers) ? json.markers.length : 0,
    };
}

class LottieComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.file = this.fileId && _ctx && _ctx.projectFiles[this.fileId] || null;
        this.fileName = (this.file || {}).name || 'animation.json';
        this.source = null; // the text last shown (a .json)
        this.player = null;
        this.pending = null; // what to restore once a reload has loaded: { frame, playing }
        this.scrubbing = false;
        this.root = container.element;
        this.root.classList.add('lottie-root');
        LottieComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (LottieComponent._styled) return;
        LottieComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.lottie-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.lottie-shell{display:grid;grid-template-rows:auto 1fr auto auto;height:100%}
.lottie-toolbar,.lottie-controls{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;flex-wrap:wrap}
.lottie-toolbar{border-bottom:1px solid #444c56}
.lottie-controls{border-top:1px solid #444c56}
.lottie-root button,.lottie-root select,.lottie-root input[type=number]{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit}
.lottie-root button{cursor:pointer;min-width:30px}
.lottie-root button:hover{background:#444c56}
.lottie-root input[type=number]{width:64px;padding:3px 4px}
.lottie-root label{display:inline-flex;align-items:center;gap:4px}
.lottie-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lottie-scrub{flex:1;min-width:120px}
.lottie-time{font-variant-numeric:tabular-nums;white-space:nowrap}
.lottie-stage{position:relative;min-height:0;outline:none}
.lottie-stage.bg-checker{background:repeating-conic-gradient(#d0d4d9 0 25%,#ffffff 0 50%) 0 0/16px 16px}
.lottie-stage.bg-white{background:#ffffff}
.lottie-stage.bg-black{background:#000000}
.lottie-stage>canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.lottie-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.lottie-status .lottie-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.lottie-message{position:absolute;inset:0;padding:20px;color:#57606a;text-align:center;background:#ffffff}
.lottie-error{position:absolute;inset:0;padding:20px;color:#cf222e;text-align:center;white-space:pre-wrap;background:#ffffff}
`;
        document.head.appendChild(style);
    }

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    _button(label, title, onClick) {
        const b = this._el('button', null, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _select(title, options, onChange) {
        const s = this._el('select');
        s.title = title;
        for (const [value, label] of options) s.appendChild(new Option(label, value));
        s.addEventListener('change', () => onChange(s.value));
        return s;
    }

    _buildUI() {
        const shell = this._el('div', 'lottie-shell');
        const bar = this._el('div', 'lottie-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.json,.lottie';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            clearInterval(this.watch);
            this.fileId = this.file = null;
            this.fileName = f.name;
            if (DOTLOTTIE_RE.test(f.name)) this._showBundle(new Uint8Array(await f.arrayBuffer()));
            else this._showText(await f.text(), true);
        });
        this.titleEl = this._el('span', 'lottie-title', this.fileName);
        this.animSelect = this._select('Animation in this .lottie', [], id => this._loadAnimation(id));
        this.themeSelect = this._select('Theme', [], id => {
            if (!this.player) return;
            if (id) this.player.setTheme(id); else this.player.resetTheme();
            // (drawn again now, also while paused)
            this.player.setFrame(this.player.currentFrame);
        });
        this.markerSelect = this._select('Play only a marker\'s segment', [], name => this._setMarker(name));
        this.bgSelect = this._select('Background', [['checker', 'Checkerboard'], ['white', 'White'], ['black', 'Black']], v => this._setBackground(v));
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a Lottie (.json) or dotLottie (.lottie) file from this computer', () => this.fileInput.click()),
            this.titleEl, this.animSelect, this.themeSelect, this.markerSelect, this.bgSelect,
        );

        this.stage = this._el('div', 'lottie-stage');
        this.stage.tabIndex = 0;
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        this.messageEl = this._el('div', 'lottie-message', 'Open a Lottie animation.');
        this.stage.appendChild(this.messageEl);
        this._setBackground('checker');

        const controls = this._el('div', 'lottie-controls');
        this.playBtn = this._button('▶', 'Play / pause (space)', () => this._togglePlay());
        this.scrub = this._el('input', 'lottie-scrub');
        this.scrub.type = 'range';
        this.scrub.min = 0;
        this.scrub.step = 'any';
        this.scrub.value = 0;
        this.scrub.title = 'Scrub';
        this.scrub.addEventListener('pointerdown', () => this._startScrub());
        this.scrub.addEventListener('input', () => { this._startScrub(); this._seek(+this.scrub.value); });
        this.scrub.addEventListener('change', () => this._endScrub());
        this.scrub.addEventListener('pointerup', () => this._endScrub());
        this.frameInput = this._el('input');
        this.frameInput.type = 'number';
        this.frameInput.min = 0;
        this.frameInput.step = 1;
        this.frameInput.title = 'Frame';
        this.frameInput.addEventListener('change', () => { this._pause(); this._seek(+this.frameInput.value); });
        this.timeEl = this._el('span', 'lottie-time', '');
        this.speedSelect = this._select('Speed', [['0.25', '0.25×'], ['0.5', '0.5×'], ['1', '1×'], ['1.5', '1.5×'], ['2', '2×'], ['4', '4×']], v => this.player && this.player.setSpeed(+v));
        this.speedSelect.value = '1';
        this.modeSelect = this._select('Direction', [['forward', 'Forward'], ['reverse', 'Reverse'], ['bounce', 'Bounce'], ['reverse-bounce', 'Reverse bounce']], v => this.player && this.player.setMode(v));
        this.loopBox = this._el('input');
        this.loopBox.type = 'checkbox';
        this.loopBox.checked = true;
        this.loopBox.addEventListener('change', () => this.player && this.player.setLoop(this.loopBox.checked));
        const loopLabel = this._el('label', null);
        loopLabel.append(this.loopBox, 'Loop');
        controls.append(
            this._button('⏮', 'First frame (Home)', () => { this._pause(); this._seek(0); }),
            this._button('◀', 'Previous frame (←)', () => this._step(-1)),
            this.playBtn,
            this._button('▶|', 'Next frame (→)', () => this._step(1)),
            this.scrub, this.frameInput, this.timeEl, this.speedSelect, this.modeSelect, loopLabel,
        );

        const status = this._el('div', 'lottie-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'lottie-warn', '');
        status.append(this.infoEl, this.warnEl);
        shell.append(bar, this.stage, controls, status);
        this.root.appendChild(shell);
        this._showPickers();

        this.stage.addEventListener('keydown', e => {
            if (!this.player || e.ctrlKey || e.metaKey || e.altKey) return;
            const keys = {
                ' ': () => this._togglePlay(),
                ArrowLeft: () => this._step(e.shiftKey ? -10 : -1), ArrowRight: () => this._step(e.shiftKey ? 10 : 1),
                Home: () => { this._pause(); this._seek(0); }, End: () => { this._pause(); this._seek(this._lastFrame()); },
            };
            if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
        });
        this.stage.addEventListener('click', () => this.stage.focus());
    }

    _setBackground(v) {
        this.stage.classList.remove('bg-checker', 'bg-white', 'bg-black');
        this.stage.classList.add('bg-' + v);
    }

    async _init() {
        if (!this.file) return;
        try {
            if (DOTLOTTIE_RE.test(this.fileName)) {
                await this._showBundle(await readBytes(this.file));
                return;
            }
            await this._showText(await readText(this.file), true);
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        // Follow edits made in the file's editor tab
        this.watch = setInterval(() => {
            const f = _ctx.projectFiles[this.fileId];
            if (f && typeof f.content === 'string' && !f.lazy && f.content !== this.source) this._showText(f.content, false);
        }, 400);
    }

    // The player, made once on this canvas; its events drive the controls
    _ensurePlayer() {
        if (!this.playerReady) {
            this.playerReady = ensureLib().then(DotLottie => {
                const p = this.player = new DotLottie({
                    canvas: this.canvas, autoplay: false, loop: this.loopBox.checked,
                    layout: { fit: 'contain', align: [0.5, 0.5] },
                    renderConfig: { autoResize: true, freezeOnOffscreen: false },
                });
                p.addEventListener('load', () => this._loaded());
                p.addEventListener('loadError', e => this._loadFailed(e && e.error));
                p.addEventListener('frame', () => this._showFrame());
                for (const t of ['play', 'pause', 'stop', 'complete']) p.addEventListener(t, () => this._showPlaying());
                // (a load() before its WebAssembly is ready is dropped)
                return p.isReady ? p : new Promise(resolve => p.addEventListener('ready', () => resolve(p)));
            });
            this.playerReady.catch(() => { this.playerReady = null; });
        }
        return this.playerReady;
    }

    // A .json's text: checked as JSON here first, so an edit half made keeps the last animation
    async _showText(text, first) {
        this.source = text;
        let json;
        try {
            json = JSON.parse(text);
            if (!json || typeof json !== 'object' || !Array.isArray(json.layers)) throw new Error('no "layers": not a Lottie animation');
        } catch (err) {
            if (this.loadedOnce) { this.warnEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not show ${this.fileName}: ${err.message}`);
            return;
        }
        const seq = this.seq = (this.seq || 0) + 1;
        let player, assetResolver;
        try {
            [player, assetResolver] = await Promise.all([this._ensurePlayer(), externalAssets(json, this.file)]);
        } catch (err) {
            this._error(`Could not load dotlottie-web: ${err.message}`);
            return;
        }
        if (seq !== this.seq) return;
        this.meta = describeJson(json);
        this.pending = first || !this.loadedOnce ? { frame: null, playing: true } : { frame: player.currentFrame, playing: player.isPlaying };
        this.bundle = false;
        player.load({ ...this._playback(), data: json, ...(assetResolver ? { assetResolver } : {}) });
        if (!player.isLoaded) this._loadFailed(null);
    }

    // A .lottie's bytes
    async _showBundle(bytes) {
        let player;
        try {
            player = await this._ensurePlayer();
        } catch (err) {
            this._error(`Could not load dotlottie-web: ${err.message}`);
            return;
        }
        this.meta = null;
        this.bundle = true;
        this.pending = { frame: null, playing: true };
        // (a copy: the player takes the buffer)
        player.load({ ...this._playback(), data: bytes.slice().buffer });
        // (a zip it cannot read is dropped without a loadError)
        if (!player.isLoaded) this._loadFailed(new Error('dotlottie-web could not read it (not a dotLottie zip, or a damaged one)'));
    }

    _loadAnimation(id) {
        if (!this.player || !id) return;
        this.pending = { frame: null, playing: true };
        this.player.loadAnimation(id);
    }

    _playback() {
        return {
            autoplay: false, loop: this.loopBox.checked, speed: +this.speedSelect.value, mode: this.modeSelect.value,
            layout: { fit: 'contain', align: [0.5, 0.5] },
        };
    }

    _loaded() {
        const p = this.player;
        this.loadedOnce = true;
        this.messageEl.remove();
        this.warnEl.textContent = '';
        const pending = this.pending || { frame: null, playing: true };
        this.pending = null;
        // The marker kept across a reload, if it is still there
        const marker = this.markerSelect.value;
        this._showPickers();
        if (marker && [...this.markerSelect.options].some(o => o.value === marker)) { this.markerSelect.value = marker; p.setMarker(marker); }
        this.scrub.max = this._lastFrame();
        this.frameInput.max = this._lastFrame();
        if (pending.frame !== null) p.setFrame(Math.min(pending.frame, this._lastFrame()));
        if (pending.playing) p.play(); else p.pause();
        this._showInfo();
        this._showFrame();
        this._showPlaying();
    }

    _loadFailed(err) {
        const msg = (err && err.message) || 'dotlottie-web could not read it';
        if (this.loadedOnce && !this.bundle) { this.warnEl.textContent = `Not updated: ${msg}`; return; }
        this._error(`Could not show ${this.fileName}: ${msg}`);
    }

    // The .lottie's animations and themes, and the animation's markers, offered when there are any
    _showPickers() {
        const p = this.player;
        const manifest = p && this.bundle ? p.manifest : null;
        const fill = (select, options, value) => {
            select.innerHTML = '';
            for (const [v, label] of options) select.appendChild(new Option(label, v));
            select.hidden = options.length <= 1;
            if (value !== undefined) select.value = value;
        };
        const anims = manifest && manifest.animations || [];
        fill(this.animSelect, anims.length > 1 ? anims.map(a => [a.id, a.id]) : [], p && p.activeAnimationId);
        const themes = manifest && manifest.themes || [];
        fill(this.themeSelect, themes.length ? [['', 'No theme'], ...themes.map(t => [t.id, t.id])] : [], (p && p.activeThemeId) || '');
        const markers = p && p.isLoaded ? p.markers() || [] : [];
        fill(this.markerSelect, markers.length ? [['', 'Whole animation'], ...markers.map(m => [m.name, m.name])] : [], '');
    }

    _setMarker(name) {
        const p = this.player;
        if (!p) return;
        if (name) p.setMarker(name);
        else p.resetSegment();
        this._showFrame();
    }

    _showInfo() {
        const p = this.player;
        const size = p.animationSize();
        const fps = p.duration > 0 ? p.totalFrames / p.duration : 0;
        const parts = [`${Math.round(size.width)} × ${Math.round(size.height)}`,
            `${+fps.toFixed(2)} fps`, `${Math.round(p.totalFrames)} frames`, `${p.duration.toFixed(2)} s`];
        if (this.meta) {
            parts.push(`${this.meta.layers} layer${this.meta.layers === 1 ? '' : 's'}`);
            if (this.meta.assets) parts.push(`${this.meta.assets} asset${this.meta.assets === 1 ? '' : 's'}`);
            if (this.meta.version) parts.push(`Lottie ${this.meta.version}`);
            // Bodymovin before 4.1.9 wrote colors as 0-255, which dotlottie-web takes for 0-1 (lottie-web converts them)
            const v = this.meta.version.split('.').map(Number);
            this.warnEl.textContent = this.meta.version && (v[0] - 4 || v[1] - 1 || v[2] - 9) < 0
                ? `colors may be wrong: a Lottie ${this.meta.version} file writes them as 0-255, which dotlottie-web doesn't convert` : '';
            if (this.meta.name) parts.push(`"${this.meta.name}"`);
        } else if (this.bundle) {
            const m = p.manifest;
            const n = m && m.animations ? m.animations.length : 1;
            parts.push(`dotLottie, ${n} animation${n === 1 ? '' : 's'}` + (m && m.generator ? `, by ${m.generator}` : ''));
        }
        this.infoEl.textContent = parts.join(' · ');
        this.titleEl.textContent = this.fileName;
    }

    _lastFrame() {
        return this.player ? Math.max(0, this.player.totalFrames - 1) : 0;
    }

    _showFrame() {
        const p = this.player;
        if (!p || !p.isLoaded) return;
        const f = p.currentFrame;
        if (!this.scrubbing) this.scrub.value = f;
        if (document.activeElement !== this.frameInput) this.frameInput.value = Math.round(f);
        const fps = p.duration > 0 ? p.totalFrames / p.duration : 0;
        this.timeEl.textContent = `/ ${Math.round(this._lastFrame())}` + (fps ? ` · ${(f / fps).toFixed(2)} s` : '');
    }

    _showPlaying() {
        const playing = !!(this.player && this.player.isPlaying);
        this.playBtn.textContent = playing ? '⏸' : '▶';
    }

    _togglePlay() {
        const p = this.player;
        if (!p || !p.isLoaded) return;
        if (p.isPlaying) p.pause();
        else {
            // At the end of a run that doesn't loop: from the start again
            if (!p.loop && p.currentFrame >= this._lastFrame() - 0.01) p.setFrame(0);
            p.play();
        }
        this._showPlaying();
    }

    _pause() {
        if (this.player && this.player.isPlaying) this.player.pause();
        this._showPlaying();
    }

    _seek(frame) {
        const p = this.player;
        if (!p || !p.isLoaded || !isFinite(frame)) return;
        p.setFrame(Math.max(0, Math.min(this._lastFrame(), frame)));
        this._showFrame();
    }

    _step(n) {
        if (!this.player) return;
        this._pause();
        this._seek(Math.round(this.player.currentFrame) + n);
    }

    // Dragging the slider pauses; letting go plays on if it was playing
    _startScrub() {
        if (this.scrubbing || !this.player) return;
        this.scrubbing = true;
        this.wasPlaying = this.player.isPlaying;
        this._pause();
    }

    _endScrub() {
        if (!this.scrubbing) return;
        this.scrubbing = false;
        if (this.wasPlaying && this.player) this.player.play();
        this._showPlaying();
    }

    _error(msg) {
        this.messageEl.remove();
        if (this.errorEl) this.errorEl.remove();
        this.errorEl = this._el('div', 'lottie-error', msg);
        this.stage.appendChild(this.errorEl);
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.player) { try { this.player.destroy(); } catch (_) { /* gone already */ } }
        this.player = null;
    }
}

// One frame (from the middle) drawn at 256 pixels, copied, and the player let go
async function renderThumbnail(data, assetResolver) {
    const DotLottie = await ensureLib();
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const player = new DotLottie({
        canvas, autoplay: false, loop: false,
        renderConfig: { autoResize: false, freezeOnOffscreen: false, devicePixelRatio: 1 },
    });
    try {
        if (!player.isReady) await new Promise(resolve => player.addEventListener('ready', resolve));
        // (it loads at once, or not at all)
        player.load({ data, autoplay: false, loop: false, layout: { fit: 'contain', align: [0.5, 0.5] }, ...(assetResolver ? { assetResolver } : {}) });
        if (!player.isLoaded) throw new Error('not a Lottie animation');
        player.setFrame(Math.floor(player.totalFrames / 2));
        const out = document.createElement('canvas');
        out.width = out.height = size;
        out.getContext('2d').drawImage(canvas, 0, 0);
        return out;
    } finally {
        player.destroy();
    }
}

registerPlugin({
    id: 'lottie',
    name: 'Lottie animations',
    components: {
        lottieViewer: LottieComponent,
    },
    toolbarButtons: [
        { label: 'Lottie', title: 'Open the Lottie player', menuLabel: 'Lottie animations (.json, .lottie)' },
    ],
    thumbnailRenderers: [{
        canHandle: file => DOTLOTTIE_RE.test(file.name) || (JSON_RE.test(file.name) && !file.viewType),
        async render(file, container) {
            let canvas;
            if (DOTLOTTIE_RE.test(file.name)) {
                canvas = await renderThumbnail((await readBytes(file)).slice().buffer);
            } else {
                // .json: the file's icon stays unless the text is Lottie
                const text = await readText(file);
                if (!looksLikeLottie(text)) throw new Error('not a Lottie animation');
                const json = JSON.parse(text);
                canvas = await renderThumbnail(json, await externalAssets(json, file));
            }
            canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;background:repeating-conic-gradient(#d0d4d9 0 25%,#ffffff 0 50%) 0 0/16px 16px';
            container.innerHTML = '';
            container.appendChild(canvas);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { isLottieFile, looksLikeLottie };
