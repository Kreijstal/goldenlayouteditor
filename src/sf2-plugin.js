// --- SoundFont Plugin ---
// Opens .sf2/.sf3/.dls sound banks: what the bank says about itself, its
// presets (click one, then play it on the keyboard below, with the mouse or
// the computer keyboard: Z–M and Q–U rows, octave with - and +), its
// instruments and its samples (click to hear one as recorded). spessasynth
// (src/sf-synth.js) reads and plays the bank. "Use for MIDI" lets the MIDI
// editor play its files with this bank's instruments.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { ensureArchiveAccess } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');
const { loadCore, useBank, setPatch, rememberBank, recentBanks } = require('./sf-synth');

const log = createLogger('SoundFont');
const SF_RE = /\.(sf2|sf3|sfogg|dls)$/i;
const IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
// Computer keys, a semitone apart from the octave's C
const KEYS = { z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12,
    q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24 };
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

function noteName(p) {
    return NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

class SoundFontComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = SoundFontComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.tab = 'presets';
        this.octave = 4;
        this.velocity = 100;
        this.down = new Map();  // key or pointer -> note sounding

        this.root = container.element;
        this.root.classList.add('sf-plugin-root');
        this.root.tabIndex = 0;
        this._installStyles();
        this.root.innerHTML = `
<div class="sf-shell">
  <div class="sf-toolbar">
    <span class="sf-title"></span>
    <span class="sf-tabs"><button type="button" data-tab="presets">Presets</button><button type="button" data-tab="instruments">Instruments</button><button type="button" data-tab="samples">Samples</button><button type="button" data-tab="info">Info</button></span>
    <input class="sf-search" type="search" placeholder="Filter">
    <button type="button" class="sf-use" title="Play MIDI files in the MIDI editor with this bank">Use for MIDI</button>
    <span class="sf-status"></span>
  </div>
  <div class="sf-list"><div class="sf-message">Loading…</div></div>
  <div class="sf-player">
    <div class="sf-controls">
      <span class="sf-preset-name">No preset selected</span>
      <button type="button" data-oct="-1" title="Octave down (-)">−</button><span class="sf-oct"></span><button type="button" data-oct="1" title="Octave up (+)">+</button>
      <label>Velocity <input class="sf-vel" type="range" min="1" max="127" value="100"></label>
      <span class="sf-note"></span>
    </div>
    <canvas class="sf-keys"></canvas>
  </div>
</div>`;
        const q = s => this.root.querySelector(s);
        this.titleEl = q('.sf-title');
        this.statusEl = q('.sf-status');
        this.listEl = q('.sf-list');
        this.searchEl = q('.sf-search');
        this.presetEl = q('.sf-preset-name');
        this.octEl = q('.sf-oct');
        this.noteEl = q('.sf-note');
        this.keysEl = q('.sf-keys');
        this.useBtn = q('.sf-use');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        for (const b of this.root.querySelectorAll('[data-tab]')) b.onclick = () => this._setTab(b.dataset.tab);
        for (const b of this.root.querySelectorAll('[data-oct]')) b.onclick = () => this._shiftOctave(Number(b.dataset.oct));
        q('.sf-vel').oninput = e => { this.velocity = Number(e.target.value); };
        this.searchEl.addEventListener('input', () => this._renderList());
        this.useBtn.onclick = () => {
            rememberBank(this.path);
            this.useBtn.textContent = 'Use for MIDI ✓';
            this._status('The MIDI editor can now play with this bank (its Sound menu)');
        };
        this.root.addEventListener('keydown', e => this._onKey(e, true));
        this.root.addEventListener('keyup', e => this._onKey(e, false));
        this.root.addEventListener('blur', () => this._allOff());
        this._bindKeyboard();
        this._resizeObserver = new ResizeObserver(() => this._drawKeys());
        this._resizeObserver.observe(this.keysEl);
        if (container.on) container.on('destroy', () => {
            this._resizeObserver.disconnect();
            this._allOff();
            if (this._sampleSource) try { this._sampleSource.stop(); } catch (e) { /* ended */ }
        });
        this._shiftOctave(0);
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (SoundFontComponent._styleInstalled) return;
        SoundFontComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.sf-plugin-root{height:100%;overflow:hidden;background:#fff;outline:none;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#24292f}
.sf-shell{display:flex;flex-direction:column;height:100%}
.sf-toolbar,.sf-controls{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;white-space:nowrap;overflow:hidden}
.sf-controls{background:#f6f8fa;color:#24292f;border-color:#d0d7de;border-top:1px solid #d0d7de}
.sf-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;margin-right:4px}
.sf-toolbar button,.sf-controls button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 8px;font:inherit;cursor:pointer}
.sf-controls button{background:#fff;color:#24292f;border-color:#d0d7de;min-width:26px}
.sf-tabs{display:inline-flex}
.sf-tabs button{border-radius:0!important;margin-left:-1px}
.sf-tabs button:first-child{border-radius:4px 0 0 4px!important}
.sf-tabs button:last-child{border-radius:0 4px 4px 0!important}
.sf-tabs button.on{background:#316dca;border-color:#316dca}
.sf-search{width:150px;padding:2px 6px;border-radius:4px;border:1px solid #545d68;background:#22272e;color:#e6edf3;font:inherit}
.sf-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sf-status.error{color:#ff938a}
.sf-list{flex:1;min-height:0;overflow:auto;position:relative}
.sf-list table{border-collapse:collapse;width:100%}
.sf-list th{position:sticky;top:0;background:#f6f8fa;text-align:left;font-weight:600;padding:4px 10px;border-bottom:1px solid #d0d7de}
.sf-list td{padding:3px 10px;border-bottom:1px solid #eaeef2;font-variant-numeric:tabular-nums}
.sf-list tbody tr{cursor:pointer}
.sf-list tbody tr:hover{background:#f6f8fa}
.sf-list tr.sel{background:#ddf4ff!important}
.sf-list .dim{color:#57606a}
.sf-list .tag{font-size:11px;padding:0 5px;border-radius:8px;background:#fff8c5;color:#7d4e00;margin-left:6px}
.sf-info{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;padding:10px 14px}
.sf-info dt{color:#57606a}
.sf-info dd{margin:0;white-space:pre-wrap;word-break:break-word}
.sf-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#57606a}
.sf-message.error{color:#b42318}
.sf-player{flex:0 0 auto}
.sf-preset-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis}
.sf-oct{min-width:28px;text-align:center}
.sf-note{color:#57606a;margin-left:auto}
.sf-keys{display:block;width:100%;height:110px;touch-action:none;cursor:pointer}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + this.ctx.getRelativePath(this.fileId);
    }

    async _init() {
        this.path = this._path();
        if (!this.path) return this._fail('Sound banks need the server workspace.');
        try {
            if (insideArchive(this.path)) await ensureArchiveAccess();
            const [core, bytes] = await Promise.all([loadCore(), fetch('/workspace-file?path=' + encodeURIComponent(this.path)).then(async r => {
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                return r.arrayBuffer();
            })]);
            this.bytes = bytes;
            this.bank = core.SoundBankLoader.fromArrayBuffer(bytes.slice(0));
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the sound bank: ' + err.message);
        }
        const b = this.bank;
        this.presets = [...b.presets].sort((x, y) => (x.isDrum - y.isDrum) || (x.bankMSB - y.bankMSB) || (x.bankLSB - y.bankLSB) || (x.program - y.program));
        this.useBtn.hidden = insideArchive(this.path);
        if (recentBanks().includes(this.path)) this.useBtn.textContent = 'Use for MIDI ✓';
        this._status(`${b.presets.length} presets · ${b.instruments.length} instruments · ${b.samples.length} samples · ${(this.bytes.byteLength / 1048576).toFixed(1)} MB`);
        this._setTab('presets');
        log.log(`Opened ${this.path}: ${b.soundBankInfo.name}`);
    }

    _setTab(tab) {
        this.tab = tab;
        for (const b of this.root.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
        this.searchEl.hidden = tab === 'info';
        this._renderList();
    }

    _renderList() {
        if (!this.bank) return;
        const filter = this.searchEl.value.trim().toLowerCase();
        const match = s => !filter || s.toLowerCase().includes(filter);
        const b = this.bank;
        this.listEl.scrollTop = 0;
        if (this.tab === 'info') {
            const i = b.soundBankInfo;
            const rows = [
                ['Name', i.name], ['Version', i.version && `${i.version.major}.${i.version.minor}`], ['Sound engine', i.soundEngine],
                ['Product', i.product], ['Engineer', i.engineer], ['Copyright', i.copyright], // (a bank without a date gets today's from the reader)
                ['Created', i.creationDate && !isNaN(i.creationDate) && i.creationDate.toDateString() !== new Date().toDateString() ? i.creationDate.toLocaleDateString() : ''],
                ['Software', i.software], ['Comment', i.comment],
                ['Contents', `${b.presets.length} presets, ${b.instruments.length} instruments, ${b.samples.length} samples`],
            ].filter(r => r[1]);
            this.listEl.innerHTML = `<dl class="sf-info">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
            return;
        }
        let head, rows;
        if (this.tab === 'presets') {
            head = '<th>Bank</th><th>Program</th><th>Name</th><th>Zones</th>';
            rows = this.presets.map((p, i) => [p, i]).filter(([p]) => match(p.name)).map(([p, i]) =>
                `<tr data-i="${i}" class="${p === this.preset ? 'sel' : ''}"><td class="dim">${p.bankMSB}${p.bankLSB ? ':' + p.bankLSB : ''}</td><td>${p.program}</td><td>${esc(p.name)}${p.isDrum ? '<span class="tag">drums</span>' : ''}</td><td class="dim">${p.zones.length}</td></tr>`);
        } else if (this.tab === 'instruments') {
            head = '<th>#</th><th>Name</th><th>Zones</th><th>Used by</th>';
            rows = b.instruments.map((ins, i) => [ins, i]).filter(([ins]) => match(ins.name)).map(([ins, i]) => {
                const users = b.presets.filter(p => p.zones.some(z => z.instrument === ins)).map(p => p.name);
                return `<tr data-i="${i}"><td class="dim">${i}</td><td>${esc(ins.name)}</td><td class="dim">${ins.zones.length}</td><td class="dim">${esc(users.slice(0, 3).join(', '))}${users.length > 3 ? '…' : ''}</td></tr>`;
            });
        } else {
            head = '<th>#</th><th>Name</th><th>Root</th><th>Rate</th><th>Length</th><th>Loop</th>';
            rows = b.samples.map((s, i) => [s, i]).filter(([s]) => match(s.name)).map(([s, i]) => {
                const len = s.sampleData ? s.sampleData.length : null;
                return `<tr data-i="${i}"><td class="dim">${i}</td><td>${esc(s.name)}</td><td>${noteName(s.originalKey)}</td><td class="dim">${s.sampleRate} Hz</td><td class="dim">${len != null ? (len / s.sampleRate).toFixed(2) + ' s' : ''}</td><td class="dim">${s.loopEnd > s.loopStart ? `${s.loopStart}–${s.loopEnd}` : ''}</td></tr>`;
            });
        }
        this.listEl.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
        this.listEl.querySelector('tbody').onclick = e => {
            const tr = e.target.closest('tr');
            if (!tr) return;
            const i = Number(tr.dataset.i);
            for (const r of this.listEl.querySelectorAll('tr.sel')) r.classList.remove('sel');
            tr.classList.add('sel');
            if (this.tab === 'presets') this._selectPreset(this.presets[i]);
            else if (this.tab === 'samples') this._playSample(b.samples[i]);
            else if (this.tab === 'instruments') {
                // An instrument's first preset, to play it with
                const p = this.presets.find(pr => pr.zones.some(z => z.instrument === b.instruments[i]));
                if (p) this._selectPreset(p);
            }
            this.root.focus({ preventScroll: true });
        };
    }

    async _synth() {
        if (!this._synthReady) {
            this._status('Loading the synthesizer…');
            this._synthReady = useBank(this.path, this.bytes).then(s => {
                this._status(`${this.bank.presets.length} presets · ${this.bank.instruments.length} instruments · ${this.bank.samples.length} samples`);
                return s;
            }, err => {
                this._synthReady = null;
                throw err;
            });
        }
        return this._synthReady;
    }

    async _selectPreset(p) {
        this.preset = p;
        this.presetEl.textContent = `${p.bankMSB}:${p.program} ${p.name}`;
        try {
            const { synth } = await this._synth();
            // Drum kits on the drum channel
            this.channel = p.isDrum ? 9 : 0;
            setPatch(synth, this.channel, p.program, p.isDrum ? 0 : p.bankMSB, p.bankLSB);
            this._preview(60, 0.35);
        } catch (err) {
            log.error('Synth failed:', err);
            this._status('Could not start the synthesizer: ' + err.message, true);
        }
    }

    async _preview(note, seconds) {
        const { synth, context } = await this._synth();
        const t = context.currentTime;
        synth.noteOn(this.channel || 0, note, this.velocity, { time: t });
        synth.noteOff(this.channel || 0, note, { time: t + seconds });
    }

    async _playSample(s) {
        try {
            const { context } = await this._synth();
            const data = s.getAudioData();
            const buf = context.createBuffer(1, data.length, s.sampleRate);
            buf.copyToChannel(data, 0);
            if (this._sampleSource) try { this._sampleSource.stop(); } catch (e) { /* ended */ }
            const src = context.createBufferSource();
            src.buffer = buf;
            src.connect(context.destination);
            src.start();
            this._sampleSource = src;
            this.noteEl.textContent = `${s.name}: ${(data.length / s.sampleRate).toFixed(2)} s at ${s.sampleRate} Hz`;
        } catch (err) {
            this._status('Could not play the sample: ' + err.message, true);
        }
    }

    // --- The keyboard ---

    _range() {
        const lo = Math.max(0, (this.octave - 2) * 12 + 12);
        return [lo, Math.min(127, lo + 12 * 5)];
    }

    _shiftOctave(d) {
        this.octave = Math.min(8, Math.max(1, this.octave + d));
        this.octEl.textContent = 'C' + this.octave;
        this._drawKeys();
    }

    _layout() {
        const [lo, hi] = this._range();
        const W = this.keysEl.clientWidth, H = this.keysEl.clientHeight;
        const whites = [];
        for (let p = lo; p <= hi; p++) if (!IS_BLACK[p % 12]) whites.push(p);
        const ww = W / whites.length;
        const keys = {};
        whites.forEach((p, i) => { keys[p] = { x: i * ww, w: ww, h: H, black: false }; });
        for (let p = lo; p <= hi; p++) if (IS_BLACK[p % 12] && keys[p - 1]) keys[p] = { x: keys[p - 1].x + ww * 0.7, w: ww * 0.6, h: H * 0.6, black: true };
        return { lo, hi, keys, W, H };
    }

    _drawKeys() {
        const c = this.keysEl;
        const g = this._layout();
        if (!g.W) return;
        const dpr = window.devicePixelRatio || 1;
        c.width = g.W * dpr;
        c.height = g.H * dpr;
        const x = c.getContext('2d');
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        const on = new Set(this.down.values());
        for (const black of [false, true]) {
            for (let p = g.lo; p <= g.hi; p++) {
                const k = g.keys[p];
                if (!k || k.black !== black) continue;
                x.fillStyle = on.has(p) ? '#4cc9f0' : black ? '#1b1f24' : '#fff';
                x.fillRect(k.x, 0, k.w - (black ? 0 : 1), k.h);
                if (!black) {
                    x.fillStyle = '#d0d7de';
                    x.fillRect(k.x + k.w - 1, 0, 1, k.h);
                    if (p % 12 === 0) {
                        x.fillStyle = '#8c959f';
                        x.font = '11px sans-serif';
                        x.textAlign = 'center';
                        x.fillText('C' + (p / 12 - 1), k.x + k.w / 2, k.h - 6);
                    }
                }
            }
        }
    }

    _keyAt(px, py) {
        const g = this._layout();
        let white = null;
        for (let p = g.lo; p <= g.hi; p++) {
            const k = g.keys[p];
            if (!k || px < k.x || px >= k.x + k.w) continue;
            if (k.black && py < k.h) return p;
            if (!k.black) white = p;
        }
        return white;
    }

    async _noteOn(id, note) {
        if (note == null || note < 0 || note > 127) return;
        this._noteOff(id);
        this.down.set(id, note);
        this.noteEl.textContent = noteName(note);
        this._drawKeys();
        try {
            const { synth } = await this._synth();
            if (this.down.get(id) === note) synth.noteOn(this.channel || 0, note, this.velocity);
        } catch (err) {
            this._status('Could not start the synthesizer: ' + err.message, true);
        }
    }

    async _noteOff(id) {
        const note = this.down.get(id);
        if (note === undefined) return;
        this.down.delete(id);
        this._drawKeys();
        if (this._synthReady) (await this._synthReady).synth.noteOff(this.channel || 0, note);
    }

    _allOff() {
        for (const id of [...this.down.keys()]) this._noteOff(id);
    }

    _bindKeyboard() {
        const c = this.keysEl;
        c.addEventListener('pointerdown', e => {
            e.preventDefault();
            this.root.focus({ preventScroll: true });
            c.setPointerCapture(e.pointerId);
            const r = c.getBoundingClientRect();
            this._noteOn('p' + e.pointerId, this._keyAt(e.clientX - r.left, e.clientY - r.top));
        });
        c.addEventListener('pointermove', e => {
            if (!this.down.has('p' + e.pointerId)) return;
            const r = c.getBoundingClientRect();
            const n = this._keyAt(e.clientX - r.left, e.clientY - r.top);
            if (n !== this.down.get('p' + e.pointerId)) this._noteOn('p' + e.pointerId, n);
        });
        for (const ev of ['pointerup', 'pointercancel']) c.addEventListener(ev, e => this._noteOff('p' + e.pointerId));
    }

    _onKey(e, isDown) {
        if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        if (isDown && (k === '-' || k === '+' || k === '=')) {
            e.preventDefault();
            this._shiftOctave(k === '-' ? -1 : 1);
            return;
        }
        if (!(k in KEYS)) return;
        e.preventDefault();
        if (isDown) {
            if (!e.repeat) this._noteOn('k' + k, this.octave * 12 + 12 + KEYS[k]);
        } else {
            this._noteOff('k' + k);
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(message) {
        this.listEl.innerHTML = '';
        const m = document.createElement('div');
        m.className = 'sf-message error';
        m.textContent = message;
        this.listEl.appendChild(m);
    }
}

registerPlugin({
    id: 'soundfont',
    name: 'SoundFont viewer',
    components: {
        soundfontViewer: SoundFontComponent,
    },
    contextMenuItems: [{
        label: 'Open as sound bank',
        canHandle: (fileName) => SF_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = SoundFontComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('soundfontViewer', { fileId }, `${file.name} [sf]`, 'sf-' + fileId);
        },
    }],
    init(ctx) {
        SoundFontComponent._ctx = ctx;
    },
});
