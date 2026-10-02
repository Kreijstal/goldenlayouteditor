// --- MIDI Editor Plugin ---
// Edits .mid files in a Synthesia-style piano roll (notes fall towards a
// keyboard that lights up as they sound) and shows them as sheet music.
//   - Piano roll: double-click to add a note, drag to move (time and pitch),
//     drag a note's top edge to change its length, box-select, Delete, arrow
//     keys (Up/Down a semitone, Shift an octave; Left/Right a grid step),
//     Ctrl+Z / Ctrl+Y, wheel to scroll, Ctrl+wheel to zoom.
//   - Sheet: the notes transcribed to MusicXML (src/midi-musicxml.js) and
//     engraved with OpenSheetMusicDisplay, with a cursor following playback;
//     "MusicXML" saves that transcription next to the file.
//   - Playback: Tone.js with the Salamander grand piano samples for every
//     instrument, drum tracks through two small synths; or, picked under
//     Sound, a SoundFont opened with "Use for MIDI" in the SoundFont viewer,
//     which plays each track's own General MIDI instrument, drums, pedal,
//     volume, pan and pitch bends (spessasynth, src/sf-synth.js).
// @tonejs/midi reads and writes the file. Libraries come from esm.sh.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { ensureArchiveAccess } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');
const { midiToMusicXML } = require('./midi-musicxml');
const { useBank, setPatch, recentBanks } = require('./sf-synth');

const log = createLogger('Midi');
const MIDI_RE = /\.(mid|midi|kar|smf)$/i;
const MIDI_URL = 'https://esm.sh/@tonejs/midi@2.0.28';
const TONE_URL = 'https://esm.sh/tone@15.1.22';
const OSMD_URL = 'https://esm.sh/opensheetmusicdisplay@2.1.3';
const SALAMANDER = 'https://tonejs.github.io/audio/salamander/';
const COLORS = ['#4cc9f0', '#f72585', '#7ae582', '#ffb703', '#b388ff', '#ff7b54', '#48cae4', '#e9c46a'];
const KEYBOARD_H = 96;
const IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

function once(url, pick) {
    let p = null;
    return () => {
        if (!p) p = import(url).then(pick).catch(err => { p = null; throw err; });
        return p;
    };
}
const loadMidi = once(MIDI_URL, m => m.Midi || (m.default && m.default.Midi));
const loadTone = once(TONE_URL, m => (m.Sampler ? m : m.default));
const loadOSMD = once(OSMD_URL, m => m.OpenSheetMusicDisplay || (m.default && m.default.OpenSheetMusicDisplay));

// The piano (and drum synths), made once
let _instruments = null;
function loadInstruments(Tone) {
    if (!_instruments) {
        _instruments = new Promise((resolve, reject) => {
            const urls = {};
            for (const n of ['A0', 'C1', 'D#1', 'F#1', 'A1', 'C2', 'D#2', 'F#2', 'A2', 'C3', 'D#3', 'F#3', 'A3', 'C4', 'D#4', 'F#4', 'A4', 'C5', 'D#5', 'F#5', 'A5', 'C6', 'D#6', 'F#6', 'A6', 'C7', 'D#7', 'F#7', 'A7', 'C8']) {
                urls[n] = n.replace('#', 's') + '.mp3';
            }
            const piano = new Tone.Sampler({
                urls, baseUrl: SALAMANDER, release: 1,
                onload: () => {
                    const kick = new Tone.MembraneSynth({ volume: -8 }).toDestination();
                    const hat = new Tone.NoiseSynth({ volume: -22, envelope: { attack: 0.001, decay: 0.08, sustain: 0 } }).toDestination();
                    resolve({ piano, kick, hat });
                },
                onerror: reject,
            }).toDestination();
        }).catch(err => { _instruments = null; throw err; });
    }
    return _instruments;
}

class MidiComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = MidiComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.view = this.state.view || 'both';
        this.selected = new Set();
        this.undo = [];
        this.redo = [];
        this.dirty = false;
        this.tick = 0;             // the playhead, at the keyboard's top edge
        this.pxPerTick = 0.25;
        this.snapDiv = 4;          // grid steps per quarter (0: off)
        this.rate = 1;
        this.target = 0;           // track that new notes go into
        this.playing = false;

        this.root = container.element;
        this.root.classList.add('midi-plugin-root');
        this.root.tabIndex = 0;
        this._installStyles();
        this.root.innerHTML = `
<div class="me-shell">
  <div class="me-toolbar">
    <span class="me-title"></span>
    <button type="button" class="me-save" disabled title="Save (Ctrl+S)">Save</button>
    <span class="me-sep"></span>
    <button type="button" class="me-home" title="To the start (Home)">⏮</button>
    <button type="button" class="me-play" title="Play / pause (Space)">▶</button>
    <span class="me-time">0:00.0</span>
    <select class="me-rate" title="Speed">
      <option value="0.5">50%</option><option value="0.75">75%</option><option value="1" selected>100%</option><option value="1.25">125%</option><option value="1.5">150%</option>
    </select>
    <select class="me-sound" title="What to play with: the built-in piano, or a SoundFont opened with “Use for MIDI”"></select>
    <span class="me-sep"></span>
    <label>Grid <select class="me-snap">
      <option value="1">1/4</option><option value="2">1/8</option><option value="4" selected>1/16</option><option value="8">1/32</option><option value="0">off</option>
    </select></label>
    <span class="me-sep"></span>
    <span class="me-views">
      <button type="button" data-view="roll">Piano roll</button><button type="button" data-view="both">Both</button><button type="button" data-view="sheet">Sheet</button>
    </span>
    <button type="button" class="me-export" title="Save the sheet as MusicXML next to this file">MusicXML</button>
    <span class="me-status"></span>
  </div>
  <div class="me-tracks"></div>
  <div class="me-body">
    <div class="me-sheet-pane"><div class="me-sheet"></div><div class="me-sheet-msg"></div></div>
    <div class="me-roll-pane"><canvas class="me-roll"></canvas><div class="me-roll-msg">Loading…</div></div>
  </div>
</div>`;
        const q = s => this.root.querySelector(s);
        this.titleEl = q('.me-title');
        this.saveBtn = q('.me-save');
        this.playBtn = q('.me-play');
        this.timeEl = q('.me-time');
        this.statusEl = q('.me-status');
        this.tracksEl = q('.me-tracks');
        this.body = q('.me-body');
        this.sheetPane = q('.me-sheet-pane');
        this.sheetEl = q('.me-sheet');
        this.sheetMsg = q('.me-sheet-msg');
        this.rollPane = q('.me-roll-pane');
        this.canvas = q('.me-roll');
        this.rollMsg = q('.me-roll-msg');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';

        this.saveBtn.onclick = () => this._save();
        this.playBtn.onclick = () => this._togglePlay();
        q('.me-home').onclick = () => this._seek(0);
        q('.me-rate').onchange = e => {
            const wasPlaying = this.playing;
            if (wasPlaying) this._pause();
            this.rate = Number(e.target.value);
            if (wasPlaying) this._play();
        };
        this.soundEl = q('.me-sound');
        this.sound = this.state.sound || '';
        this._fillSounds();
        this.soundEl.addEventListener('pointerdown', () => this._fillSounds());
        this.soundEl.onchange = () => {
            const wasPlaying = this.playing;
            if (wasPlaying) this._pause();
            this.sound = this.soundEl.value;
            if (this.container.setState) try { this.container.setState({ ...this.state, view: this.view, sound: this.sound }); } catch (e) { /* not in a layout */ }
            if (wasPlaying) this._play();
        };
        q('.me-snap').onchange = e => { this.snapDiv = Number(e.target.value); this._draw(); };
        for (const b of this.root.querySelectorAll('[data-view]')) b.onclick = () => this._setView(b.dataset.view);
        q('.me-export').onclick = () => this._exportXML();
        this.root.addEventListener('keydown', e => this._onKey(e));
        this._resizeObserver = new ResizeObserver(() => this._draw());
        this._resizeObserver.observe(this.rollPane);
        if (container.on) container.on('destroy', () => {
            this._pause();
            this._resizeObserver.disconnect();
            this._destroyed = true;
        });
        this._setView(this.view);
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (MidiComponent._styleInstalled) return;
        MidiComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.midi-plugin-root{height:100%;overflow:hidden;background:#1b1f24;outline:none;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6edf3}
.me-shell{display:flex;flex-direction:column;height:100%}
.me-toolbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow:hidden}
.me-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;margin-right:4px}
.me-toolbar button,.me-toolbar select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 8px;font:inherit;cursor:pointer}
.me-toolbar button:disabled{opacity:.5;cursor:default}
.me-views{display:inline-flex}
.me-views button{border-radius:0;margin-left:-1px}
.me-views button:first-child{border-radius:4px 0 0 4px}
.me-views button:last-child{border-radius:0 4px 4px 0}
.me-views button.on{background:#316dca;border-color:#316dca}
.me-sep{width:1px;height:18px;background:#545d68}
.me-time{font-variant-numeric:tabular-nums;min-width:56px;color:#adbac7}
.me-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.me-status.error{color:#ff938a}
.me-tracks{display:flex;gap:4px;padding:4px 10px;background:#22272e;border-bottom:1px solid #444c56;overflow-x:auto;white-space:nowrap}
.me-track{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid #444c56;border-radius:12px;cursor:pointer;font-size:12px;user-select:none}
.me-track.target{border-color:#e6edf3;background:#373e47}
.me-track.hidden .me-track-name{opacity:.45;text-decoration:line-through}
.me-track i{width:10px;height:10px;border-radius:50%;display:inline-block}
.me-track b{font-weight:400;cursor:pointer;opacity:.8}
.me-track b.off{opacity:.3}
.me-body{flex:1;display:flex;flex-direction:column;min-height:0}
.me-sheet-pane{position:relative;flex:1;min-height:0;overflow:auto;background:#fff;color:#24292f}
.me-sheet-msg{position:absolute;top:10px;left:0;right:0;text-align:center;color:#57606a;pointer-events:none}
.me-roll-pane{position:relative;flex:1;min-height:0}
.me-roll{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.me-roll-msg[hidden]{display:none}
.me-roll-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#adbac7;pointer-events:none}
.me-roll-msg.error{color:#ff938a}
.midi-plugin-root[data-view=roll] .me-sheet-pane{display:none}
.midi-plugin-root[data-view=sheet] .me-roll-pane{display:none}
.midi-plugin-root[data-view=both] .me-sheet-pane{flex:0 0 42%;border-bottom:1px solid #444c56}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + this.ctx.getRelativePath(this.fileId);
    }

    async _init() {
        this.path = this._path();
        if (!this.path) return this._fail('MIDI files need the server workspace.');
        this.readOnly = insideArchive(this.path);
        try {
            if (this.readOnly) await ensureArchiveAccess();
            const [Midi, bytes] = await Promise.all([loadMidi(), fetch('/workspace-file?path=' + encodeURIComponent(this.path)).then(async r => {
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                return r.arrayBuffer();
            })]);
            this.Midi = Midi;
            this.midi = new Midi(bytes);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the MIDI file: ' + err.message);
        }
        if (!this.midi.tracks.length) this.midi.addTrack();
        this.trackState = this.midi.tracks.map((t, i) => ({ color: COLORS[i % COLORS.length], visible: true, muted: false }));
        this.target = Math.max(0, this.midi.tracks.findIndex(t => t.notes.length && !t.instrument.percussion));
        this.rollMsg.hidden = true;
        this._buildTracks();
        this._bindRoll();
        this._status(this._summary());
        this._draw();
        this._sheetStale = true;
        this._renderSheet();
        log.log(`Opened ${this.path}: ${this.midi.tracks.length} tracks, ${this._noteCount()} notes`);
    }

    _noteCount() {
        return this.midi.tracks.reduce((a, t) => a + t.notes.length, 0);
    }

    _summary() {
        const parts = [`${this.midi.tracks.length} track${this.midi.tracks.length === 1 ? '' : 's'}`, `${this._noteCount()} notes`];
        const bpm = this.midi.header.tempos[0];
        parts.push(`${Math.round(bpm ? bpm.bpm : 120)} bpm`);
        if (this.readOnly) parts.push('read-only');
        if (this.dirty) parts.push('unsaved');
        return parts.join(' · ');
    }

    _setView(view) {
        this.view = view;
        this.root.dataset.view = view;
        for (const b of this.root.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === view);
        if (this.state) this.state.view = view;
        if (this.container.setState) try { this.container.setState({ ...this.state, view }); } catch (e) { /* not in a layout */ }
        requestAnimationFrame(() => { this._draw(); this._renderSheet(); });
    }

    // --- Tracks ---

    _buildTracks() {
        this.tracksEl.textContent = '';
        this.midi.tracks.forEach((t, i) => {
            const st = this.trackState[i];
            const chip = document.createElement('span');
            chip.className = 'me-track' + (i === this.target ? ' target' : '') + (st.visible ? '' : ' hidden');
            chip.title = 'Click: add new notes to this track';
            const dot = document.createElement('i');
            dot.style.background = st.color;
            const name = document.createElement('span');
            name.className = 'me-track-name';
            const inst = t.instrument.percussion ? 'drums' : t.instrument.name;
            name.textContent = `${t.name || inst || 'Track ' + (i + 1)} (${t.notes.length})`;
            const eye = document.createElement('b');
            eye.textContent = '👁';
            eye.title = 'Show / hide in the piano roll';
            eye.classList.toggle('off', !st.visible);
            eye.onclick = e => { e.stopPropagation(); st.visible = !st.visible; this._buildTracks(); this._draw(); };
            const mute = document.createElement('b');
            mute.textContent = st.muted ? '🔇' : '🔊';
            mute.title = 'Mute / unmute';
            mute.onclick = e => { e.stopPropagation(); st.muted = !st.muted; this._buildTracks(); };
            chip.append(dot, name, eye, mute);
            chip.onclick = () => { this.target = i; this._buildTracks(); };
            this.tracksEl.appendChild(chip);
        });
        if (!this.readOnly) {
            const add = document.createElement('span');
            add.className = 'me-track';
            add.textContent = '+ track';
            add.onclick = () => {
                this._checkpoint();
                const t = this.midi.addTrack();
                t.name = 'Track ' + this.midi.tracks.length;
                this.trackState.push({ color: COLORS[(this.midi.tracks.length - 1) % COLORS.length], visible: true, muted: false });
                this.target = this.midi.tracks.length - 1;
                this._changed();
            };
            this.tracksEl.appendChild(add);
        }
    }

    // --- Piano roll geometry ---

    _layout() {
        const W = this.rollPane.clientWidth, H = this.rollPane.clientHeight;
        // The keys the notes need, whole octaves, at least three
        let lo = 108, hi = 21;
        for (const t of this.midi.tracks) for (const n of t.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
        if (lo > hi) { lo = 48; hi = 83; }
        lo = Math.max(21, Math.floor((lo - 2) / 12) * 12);
        hi = Math.min(108, Math.ceil((hi + 3) / 12) * 12 - 1);
        while (hi - lo < 35) { if (lo > 21) lo = Math.max(21, lo - 12); if (hi < 108) hi = Math.min(108, hi + 12); if (lo === 21 && hi === 108) break; }
        const whites = [];
        for (let p = lo; p <= hi; p++) if (!IS_BLACK[p % 12]) whites.push(p);
        const ww = W / whites.length;
        const keys = {};
        whites.forEach((p, i) => { keys[p] = { x: i * ww, w: ww, black: false }; });
        for (let p = lo; p <= hi; p++) {
            if (!IS_BLACK[p % 12]) continue;
            const left = keys[p - 1];
            if (!left) continue;
            keys[p] = { x: left.x + ww - ww * 0.3, w: ww * 0.6, black: true };
        }
        this.geo = { W, H, lo, hi, keys, ww, rollH: H - KEYBOARD_H };
        return this.geo;
    }

    _y(tick) {
        return this.geo.rollH - (tick - this.tick) * this.pxPerTick;
    }

    _tickAt(y) {
        return this.tick + (this.geo.rollH - y) / this.pxPerTick;
    }

    _pitchAt(x) {
        const g = this.geo;
        // Black keys sit on top of the white ones
        for (let p = g.lo; p <= g.hi; p++) {
            const k = g.keys[p];
            if (k && k.black && x >= k.x && x < k.x + k.w) return p;
        }
        for (let p = g.lo; p <= g.hi; p++) {
            const k = g.keys[p];
            if (k && !k.black && x >= k.x && x < k.x + k.w) return p;
        }
        return x < 0 ? g.lo : g.hi;
    }

    _snap(ticks, mode = 'round') {
        if (!this.snapDiv) return Math.round(ticks);
        const s = this.midi.header.ppq / this.snapDiv;
        return Math[mode](ticks / s) * s;
    }

    _gridStep() {
        return this.snapDiv ? this.midi.header.ppq / this.snapDiv : this.midi.header.ppq / 4;
    }

    // Measure starts from the time signatures, up to `until`
    _measures(until) {
        const h = this.midi.header;
        const sigs = h.timeSignatures.length ? h.timeSignatures : [{ ticks: 0, timeSignature: [4, 4] }];
        const out = [];
        let t = 0, i = 0;
        while (t <= until && out.length < 100000) {
            while (i + 1 < sigs.length && sigs[i + 1].ticks <= t) i++;
            const [n, d] = sigs[i].timeSignature;
            const beat = h.ppq * 4 / d;
            out.push({ t, beats: n, beat });
            t += n * beat;
        }
        return out;
    }

    _draw() {
        if (!this.midi || this.view === 'sheet' || this._destroyed) return;
        const g = this._layout();
        const dpr = window.devicePixelRatio || 1;
        const c = this.canvas;
        if (!g.W || !g.H) return;
        if (c.width !== Math.round(g.W * dpr) || c.height !== Math.round(g.H * dpr)) {
            c.width = Math.round(g.W * dpr);
            c.height = Math.round(g.H * dpr);
        }
        const x = c.getContext('2d');
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        x.fillStyle = '#1b1f24';
        x.fillRect(0, 0, g.W, g.H);
        x.save();
        x.beginPath();
        x.rect(0, 0, g.W, g.rollH);
        x.clip();
        // Lanes for the black keys
        x.fillStyle = '#16191d';
        for (let p = g.lo; p <= g.hi; p++) if (IS_BLACK[p % 12]) x.fillRect(g.keys[p].x, 0, g.keys[p].w, g.rollH);
        x.strokeStyle = '#262b31';
        for (let p = g.lo; p <= g.hi; p++) if (p % 12 === 0 || p % 12 === 5) { x.beginPath(); x.moveTo(g.keys[p].x + 0.5, 0); x.lineTo(g.keys[p].x + 0.5, g.rollH); x.stroke(); }
        // Beats and bars
        const top = this._tickAt(0);
        x.font = '11px sans-serif';
        this._measures(top).forEach((m, mi) => {
            for (let b = 0; b < m.beats; b++) {
                const t = m.t + b * m.beat;
                const y = Math.round(this._y(t)) + 0.5;
                if (y < 0 || y > g.rollH) continue;
                x.strokeStyle = b ? '#2b3139' : '#4b5563';
                x.beginPath(); x.moveTo(0, y); x.lineTo(g.W, y); x.stroke();
            }
            const y = this._y(m.t);
            if (y > 12 && y <= g.rollH) {
                x.fillStyle = '#768390';
                x.fillText(String(mi + 1), 4, y - 3);
            }
        });
        // Notes
        const sounding = new Map();
        this.midi.tracks.forEach((t, ti) => {
            const st = this.trackState[ti];
            if (!st.visible) return;
            for (const n of t.notes) {
                const k = g.keys[n.midi];
                if (!k) continue;
                const y1 = this._y(n.ticks), y0 = this._y(n.ticks + n.durationTicks);
                if (n.ticks <= this.tick && this.tick < n.ticks + n.durationTicks) sounding.set(n.midi, st.color);
                if (y1 < 0 || y0 > g.rollH) continue;
                const pad = k.black ? 0 : 1.5;
                x.fillStyle = st.color;
                x.globalAlpha = k.black ? 0.8 : 1;
                this._roundRect(x, k.x + pad, y0, k.w - 2 * pad, Math.max(3, y1 - y0), 4);
                x.fill();
                x.globalAlpha = 1;
                if (this.selected.has(n)) {
                    x.strokeStyle = '#fff';
                    x.lineWidth = 2;
                    x.stroke();
                    x.lineWidth = 1;
                }
            }
        });
        if (this.band) {
            x.fillStyle = 'rgba(88,166,255,.15)';
            x.strokeStyle = '#58a6ff';
            const b = this.band;
            x.fillRect(b.x, b.y, b.w, b.h);
            x.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
        }
        x.restore();
        // The keyboard
        const ky = g.rollH;
        x.fillStyle = '#e53935';
        x.fillRect(0, ky - 2, g.W, 2);
        for (const black of [false, true]) {
            for (let p = g.lo; p <= g.hi; p++) {
                const k = g.keys[p];
                if (!k || k.black !== black) continue;
                const h = black ? KEYBOARD_H * 0.62 : KEYBOARD_H;
                const lit = sounding.get(p) || (this._pressed === p ? '#9ca3af' : null);
                x.fillStyle = lit || (black ? '#111' : '#f5f5f5');
                x.fillRect(k.x + (black ? 0 : 0.5), ky, k.w - (black ? 0 : 1), h);
                if (!black && p % 12 === 0 && k.w > 14) {
                    x.fillStyle = '#888';
                    x.font = `${Math.min(11, k.w * 0.6)}px sans-serif`;
                    x.textAlign = 'center';
                    x.fillText('C' + (p / 12 - 1), k.x + k.w / 2, ky + KEYBOARD_H - 6);
                    x.textAlign = 'start';
                }
            }
        }
        this._drawTime();
    }

    _roundRect(x, l, t, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        x.beginPath();
        x.moveTo(l + r, t);
        x.arcTo(l + w, t, l + w, t + h, r);
        x.arcTo(l + w, t + h, l, t + h, r);
        x.arcTo(l, t + h, l, t, r);
        x.arcTo(l, t, l + w, t, r);
        x.closePath();
    }

    _drawTime() {
        const s = this.midi.header.ticksToSeconds(Math.max(0, this.tick));
        this.timeEl.textContent = `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
    }

    // --- Piano roll editing ---

    _noteAt(px, py) {
        const g = this.geo;
        let best = null;
        this.midi.tracks.forEach((t, ti) => {
            if (!this.trackState[ti].visible) return;
            for (const n of t.notes) {
                const k = g.keys[n.midi];
                if (!k || px < k.x || px > k.x + k.w) continue;
                const y1 = this._y(n.ticks), y0 = this._y(n.ticks + n.durationTicks);
                if (py >= y0 - 2 && py <= Math.max(y1, y0 + 3) + 2) {
                    // Black keys lie over the white ones
                    if (!best || (k.black && !g.keys[best.note.midi].black)) best = { note: n, track: ti, edge: py <= y0 + 6 };
                }
            }
        });
        return best;
    }

    _trackOf(note) {
        return this.midi.tracks.findIndex(t => t.notes.includes(note));
    }

    _bindRoll() {
        const c = this.canvas;
        c.addEventListener('wheel', e => {
            e.preventDefault();
            if (e.ctrlKey) {
                const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
                this.pxPerTick = Math.min(4, Math.max(0.02, this.pxPerTick * k));
            } else if (!this.playing) {
                this.tick = Math.max(-this.midi.header.ppq, this.tick - e.deltaY / this.pxPerTick * 0.5);
                this._syncCursor();
            }
            this._draw();
        }, { passive: false });
        c.addEventListener('dblclick', e => {
            if (this.readOnly) return;
            const r = c.getBoundingClientRect();
            const px = e.clientX - r.left, py = e.clientY - r.top;
            if (py >= this.geo.rollH || this._noteAt(px, py)) return;
            const track = this.midi.tracks[this.target];
            if (!track) return;
            this._checkpoint();
            const n = track.addNote({ midi: this._pitchAt(px), ticks: Math.max(0, this._snap(this._tickAt(py), 'floor')), durationTicks: this.noteLen || this.midi.header.ppq, velocity: 0.8 });
            this.trackState[this.target].visible = true;
            this.selected = new Set([n]);
            this._preview(n.midi);
            this._changed();
        });
        c.addEventListener('pointerdown', e => {
            if (!this.midi) return;
            e.preventDefault();
            this.root.focus({ preventScroll: true });
            const r = c.getBoundingClientRect();
            const px = e.clientX - r.left, py = e.clientY - r.top;
            let drag;
            if (py >= this.geo.rollH) {
                // The keyboard plays
                this._pressed = this._pitchAt(px);
                this._preview(this._pressed);
                drag = { kind: 'key' };
            } else if (e.button === 1) {
                drag = { kind: 'pan', y: py, tick: this.tick };
            } else {
                const hit = this._noteAt(px, py);
                if (hit && !this.readOnly) {
                    if (e.shiftKey) {
                        if (this.selected.has(hit.note)) this.selected.delete(hit.note); else this.selected.add(hit.note);
                    } else if (!this.selected.has(hit.note)) {
                        this.selected = new Set([hit.note]);
                    }
                    this._preview(hit.note.midi);
                    const notes = [...this.selected];
                    drag = {
                        kind: hit.edge ? 'resize' : 'move', px, py, pitch: this._pitchAt(px), moved: false,
                        orig: notes.map(n => ({ n, ticks: n.ticks, dur: n.durationTicks, midi: n.midi })),
                    };
                    this._checkpoint();
                } else if (hit) {
                    this.selected = new Set([hit.note]);
                    this._preview(hit.note.midi);
                    drag = { kind: 'none' };
                } else {
                    if (!e.shiftKey) this.selected.clear();
                    drag = { kind: 'band', px, py, base: new Set(this.selected) };
                }
            }
            c.setPointerCapture(e.pointerId);
            this._draw();
            const onMove = ev => {
                const mx = ev.clientX - r.left, my = ev.clientY - r.top;
                if (drag.kind === 'pan') {
                    this.tick = Math.max(-this.midi.header.ppq, drag.tick + (my - drag.y) / this.pxPerTick);
                } else if (drag.kind === 'move') {
                    const dt = this._snap((drag.py - my) / this.pxPerTick);
                    const dp = this._pitchAt(mx) - drag.pitch;
                    const minT = Math.min(...drag.orig.map(o => o.ticks));
                    const dtc = Math.max(dt, -minT);
                    for (const o of drag.orig) {
                        o.n.ticks = o.ticks + dtc;
                        o.n.midi = Math.min(127, Math.max(0, o.midi + dp));
                    }
                    if (dtc || dp) drag.moved = true;
                    if (dp !== drag.lastDp) { drag.lastDp = dp; if (dp) this._preview(drag.orig[0].n.midi); }
                } else if (drag.kind === 'resize') {
                    const dt = this._snap((drag.py - my) / this.pxPerTick);
                    for (const o of drag.orig) o.n.durationTicks = Math.max(this.snapDiv ? this._gridStep() : 1, o.dur + dt);
                    if (dt) drag.moved = true;
                } else if (drag.kind === 'band') {
                    const x0 = Math.min(drag.px, mx), y0 = Math.min(drag.py, my);
                    this.band = { x: x0, y: y0, w: Math.abs(mx - drag.px), h: Math.abs(my - drag.py) };
                    this.selected = new Set(drag.base);
                    const t0 = this._tickAt(y0 + this.band.h), t1 = this._tickAt(y0);
                    this.midi.tracks.forEach((t, ti) => {
                        if (!this.trackState[ti].visible) return;
                        for (const n of t.notes) {
                            const k = this.geo.keys[n.midi];
                            if (!k || k.x + k.w < x0 || k.x > x0 + this.band.w) continue;
                            if (n.ticks + n.durationTicks >= t0 && n.ticks <= t1) this.selected.add(n);
                        }
                    });
                }
                this._draw();
            };
            const onUp = () => {
                c.removeEventListener('pointermove', onMove);
                c.removeEventListener('pointerup', onUp);
                c.removeEventListener('pointercancel', onUp);
                this._pressed = null;
                this.band = null;
                if (drag.kind === 'move' || drag.kind === 'resize') {
                    if (drag.moved) this._changed(); else this.undo.pop();
                    // New notes get the length last given to one
                    if (drag.kind === 'resize' && drag.moved) this.noteLen = drag.orig[0].n.durationTicks;
                }
                this._draw();
            };
            c.addEventListener('pointermove', onMove);
            c.addEventListener('pointerup', onUp);
            c.addEventListener('pointercancel', onUp);
        });
    }

    _snapshot() {
        return this.midi.tracks.map(t => t.notes.map(n => ({ midi: n.midi, ticks: n.ticks, durationTicks: n.durationTicks, velocity: n.velocity })));
    }

    _restore(snap) {
        while (this.midi.tracks.length > snap.length) {
            this.midi.tracks.pop();
            this.trackState.pop();
        }
        this.midi.tracks.forEach((t, i) => {
            t.notes.length = 0;
            for (const n of snap[i]) t.addNote(n);
        });
        this.target = Math.min(this.target, this.midi.tracks.length - 1);
        this.selected.clear();
        this._changed();
    }

    _checkpoint() {
        this.undo.push(this._snapshot());
        if (this.undo.length > 100) this.undo.shift();
        this.redo = [];
    }

    _history(from, to) {
        const snap = from.pop();
        if (!snap) return;
        to.push(this._snapshot());
        this._restore(snap);
    }

    _changed() {
        for (const t of this.midi.tracks) t.notes.sort((a, b) => a.ticks - b.ticks);
        this.dirty = true;
        this.saveBtn.disabled = this.readOnly;
        this._buildTracks();
        this._status(this._summary());
        this._draw();
        this._sheetStale = true;
        clearTimeout(this._sheetTimer);
        this._sheetTimer = setTimeout(() => this._renderSheet(), 600);
        if (this.playing) this._reschedule();
    }

    _onKey(e) {
        if (!this.midi || /INPUT|SELECT/.test(e.target.tagName)) return;
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key;
        const edit = fn => {
            if (this.readOnly || !this.selected.size) return;
            e.preventDefault();
            this._checkpoint();
            fn([...this.selected]);
            this._changed();
        };
        if (mod && k.toLowerCase() === 's') { e.preventDefault(); this._save(); }
        else if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this._history(this.redo, this.undo); else this._history(this.undo, this.redo); }
        else if (mod && k.toLowerCase() === 'y') { e.preventDefault(); this._history(this.redo, this.undo); }
        else if (mod && k.toLowerCase() === 'a') {
            e.preventDefault();
            this.selected = new Set();
            this.midi.tracks.forEach((t, i) => { if (this.trackState[i].visible) for (const n of t.notes) this.selected.add(n); });
            this._draw();
        }
        else if (k === ' ') { e.preventDefault(); this._togglePlay(); }
        else if (k === 'Home') { e.preventDefault(); this._seek(0); }
        else if (k === 'Escape') { this.selected.clear(); this._draw(); }
        else if (k === 'Delete' || k === 'Backspace') edit(notes => {
            for (const t of this.midi.tracks) for (let i = t.notes.length - 1; i >= 0; i--) if (this.selected.has(t.notes[i])) t.notes.splice(i, 1);
            this.selected.clear();
        });
        else if (k === 'ArrowUp' || k === 'ArrowDown') edit(notes => {
            const d = (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
            for (const n of notes) n.midi = Math.min(127, Math.max(0, n.midi + d));
            this._preview(notes[0].midi);
        });
        else if (k === 'ArrowLeft' || k === 'ArrowRight') edit(notes => {
            const d = (k === 'ArrowRight' ? 1 : -1) * this._gridStep();
            if (notes.some(n => n.ticks + d < 0)) return;
            for (const n of notes) n.ticks += d;
        });
    }

    // --- Playback ---

    _fillSounds() {
        const banks = recentBanks();
        if (this.sound && !banks.includes(this.sound)) banks.unshift(this.sound);
        this.soundEl.textContent = '';
        this.soundEl.add(new Option('Piano', ''));
        for (const b of banks) this.soundEl.add(new Option(b.split('/').pop().replace(/\.\w+$/, ''), b));
        this.soundEl.value = this.sound;
    }

    // The SoundFont synthesizer with the chosen bank, and each track's instrument set
    async _soundFont() {
        const sf = await useBank(this.sound);
        this.midi.tracks.forEach(t => {
            if (t.channel === 9 || t.instrument.percussion) return;
            setPatch(sf.synth, t.channel, t.instrument.number);
        });
        return sf;
    }

    async _preview(pitch) {
        if (this.sound) {
            try {
                const sf = await this._soundFont();
                const t = this.midi.tracks[this.target];
                const ch = t ? t.channel : 0;
                const now = sf.context.currentTime;
                sf.synth.noteOn(ch, pitch, 90, { time: now });
                sf.synth.noteOff(ch, pitch, { time: now + 0.4 });
            } catch (err) { /* no sound yet */ }
            return;
        }
        try {
            const Tone = await loadTone();
            await Tone.start();
            const inst = await loadInstruments(Tone);
            inst.piano.triggerAttackRelease(Tone.Frequency(pitch, 'midi').toNote(), 0.4, undefined, 0.7);
        } catch (err) { /* no sound yet */ }
    }

    async _togglePlay() {
        if (this.playing) this._pause(); else await this._play();
    }

    async _play() {
        if (!this.midi || this.playing) return;
        this.sf = null;
        this.inst = null;
        try {
            if (this.sound) {
                this._status('Loading the sound bank…');
                this.sf = await this._soundFont();
                this._now = () => this.sf.context.currentTime;
            } else {
                this._status('Loading the piano…');
                const Tone = await loadTone();
                await Tone.start();
                this.inst = await loadInstruments(Tone);
                this.Tone = Tone;
                this._now = () => Tone.now();
            }
        } catch (err) {
            log.error('Audio failed:', err);
            return this._status('Could not load the sound: ' + (err && err.message || err), true);
        }
        this._status(this._summary());
        const h = this.midi.header;
        if (this.tick >= this._endTick()) this.tick = 0;
        this.playing = true;
        this.playBtn.textContent = '⏸';
        this.t0 = this._now() + 0.1;
        this.startSec = h.ticksToSeconds(Math.max(0, this.tick));
        if (this.sf) this._controllersAt(this.startSec);
        this._reschedule();
        this._timer = setInterval(() => this._schedule(), 40);
        const frame = () => {
            if (!this.playing) return;
            const sec = this.startSec + (this._now() - this.t0) * this.rate;
            this.tick = sec < 0 ? 0 : h.secondsToTicks(sec);
            if (this.tick > this._endTick() + h.ppq) { this._pause(); return; }
            this._draw();
            this._syncCursor();
            this._raf = requestAnimationFrame(frame);
        };
        this._raf = requestAnimationFrame(frame);
    }

    _endTick() {
        let end = 0;
        for (const t of this.midi.tracks) for (const n of t.notes) end = Math.max(end, n.ticks + n.durationTicks);
        return end;
    }

    // Where scheduling stands: notes starting from the current time on
    _reschedule() {
        const now = this.startSec + (this._now() - this.t0) * this.rate;
        this.scheduledTo = Math.max(this.startSec, now);
        this._schedule();
    }

    _schedule() {
        if (!this.playing) return;
        const now = this.startSec + (this._now() - this.t0) * this.rate;
        const until = now + 0.25;
        const from = this.scheduledTo;
        const at = sec => this.t0 + (sec - this.startSec) / this.rate;
        this.midi.tracks.forEach((t, ti) => {
            if (this.trackState[ti].muted) return;
            const drums = t.instrument.percussion;
            for (const n of t.notes) {
                const s = n.time;
                if (s < from || s >= until) continue;
                const dur = Math.max(0.05, n.duration / this.rate);
                try {
                    if (this.sf) {
                        this.sf.synth.noteOn(t.channel, n.midi, Math.max(1, Math.round(n.velocity * 127)), { time: at(s) });
                        this.sf.synth.noteOff(t.channel, n.midi, { time: at(s) + dur });
                    } else if (drums) {
                        if (n.midi === 35 || n.midi === 36) this.inst.kick.triggerAttackRelease('C1', 0.1, at(s), n.velocity);
                        else this.inst.hat.triggerAttackRelease(0.05, at(s), n.velocity);
                    } else {
                        this.inst.piano.triggerAttackRelease(this.Tone.Frequency(n.midi, 'midi').toNote(), dur, at(s), n.velocity);
                    }
                } catch (err) { /* a drum hit at the same instant as the last one */ }
            }
            if (!this.sf) return;
            for (const [num, list] of Object.entries(t.controlChanges)) {
                for (const cc of list) {
                    if (cc.time >= from && cc.time < until) this.sf.synth.controllerChange(t.channel, Number(num), Math.round(cc.value * 127), { time: at(cc.time) });
                }
            }
            for (const pb of t.pitchBends) {
                if (pb.time >= from && pb.time < until) this.sf.synth.pitchWheel(t.channel, Math.round((pb.value + 1) * 8192), { time: at(pb.time) });
            }
        });
        this.scheduledTo = until;
    }

    // Controllers and pitch bends as they stand at `sec`, for playback from there
    _controllersAt(sec) {
        const synth = this.sf.synth;
        for (const t of this.midi.tracks) {
            for (const [num, list] of Object.entries(t.controlChanges)) {
                let last = null;
                for (const cc of list) if (cc.time < sec) last = cc;
                if (last) synth.controllerChange(t.channel, Number(num), Math.round(last.value * 127));
            }
            let bend = null;
            for (const pb of t.pitchBends) if (pb.time < sec) bend = pb;
            synth.pitchWheel(t.channel, bend ? Math.round((bend.value + 1) * 8192) : 8192);
        }
    }

    _pause() {
        if (!this.playing) return;
        this.playing = false;
        clearInterval(this._timer);
        cancelAnimationFrame(this._raf);
        if (this.inst) this.inst.piano.releaseAll();
        if (this.sf) this.sf.synth.stopAll(true);
        this.playBtn.textContent = '▶';
        this._draw();
    }

    _seek(tick) {
        const wasPlaying = this.playing;
        this._pause();
        this.tick = tick;
        this._draw();
        this._syncCursor();
        if (wasPlaying) this._play();
    }

    // --- Sheet ---

    async _renderSheet() {
        if (!this.midi || this.view === 'roll' || !this._sheetStale || this._sheetBusy) return;
        this._sheetBusy = true;
        this._sheetStale = false;
        try {
            this.sheetMsg.textContent = 'Engraving…';
            const OSMD = await loadOSMD();
            const xml = midiToMusicXML(this.midi, { title: (this.fileData && this.fileData.name || '').replace(/\.\w+$/, '') });
            if (!this.osmd) {
                this.osmd = new OSMD(this.sheetEl, { backend: 'svg', autoResize: true, drawTitle: true, followCursor: true, drawingParameters: 'compacttight' });
            }
            const scroll = this.sheetPane.scrollTop;
            await this.osmd.load(xml);
            this.osmd.render();
            this.osmd.cursor.show();
            this._cursorWhole = 0;
            this._syncCursor(true);
            this.sheetPane.scrollTop = scroll;
            this.sheetMsg.textContent = '';
        } catch (err) {
            log.error('Sheet failed:', err);
            this.sheetMsg.textContent = 'Could not engrave the sheet: ' + err.message;
        } finally {
            this._sheetBusy = false;
            if (this._sheetStale) setTimeout(() => this._renderSheet(), 100);
        }
    }

    // The sheet's cursor at the playhead
    _syncCursor(force) {
        const cur = this.osmd && this.osmd.cursor;
        if (!cur || this.view === 'roll') return;
        const unit = this.midi.header.ppq / 4;
        const target = Math.round(Math.max(0, this.tick) / unit) * unit / (this.midi.header.ppq * 4);
        const at = () => cur.Iterator.currentTimeStamp.RealValue;
        if (force || target < at()) cur.reset();
        let moved = false;
        while (!cur.Iterator.EndReached && at() < target) {
            cur.next();
            moved = true;
        }
        if (!cur.Iterator.EndReached && at() > target && moved) cur.previous();
        if (cur.Iterator.EndReached) cur.previous();
    }

    async _exportXML() {
        if (!this.midi) return;
        const xmlPath = this.path.replace(/\.\w+$/, '') + '.musicxml';
        const replace = this._exportConfirm === xmlPath;
        const xml = midiToMusicXML(this.midi, { title: (this.fileData && this.fileData.name || '').replace(/\.\w+$/, '') });
        try {
            if (insideArchive(xmlPath)) throw new Error('the file is inside an archive');
            const r = await fetch('/upload-file?' + (replace ? 'overwrite=1&' : '') + 'path=' + encodeURIComponent(xmlPath), { method: 'PUT', body: new Blob([xml], { type: 'application/xml' }) });
            if (r.status === 409) {
                this._exportConfirm = xmlPath;
                return this._status(`${xmlPath.split('/').pop()} exists: click MusicXML again to replace it`, true);
            }
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
            this._exportConfirm = null;
            this._status(`Wrote ${xmlPath.split('/').pop()}`);
        } catch (err) {
            this._status('Could not write MusicXML: ' + err.message, true);
        }
    }

    // --- Saving ---

    async _save() {
        if (this.readOnly || !this.dirty || this._saving) return;
        this._saving = true;
        this.saveBtn.disabled = true;
        try {
            const bytes = this.midi.toArray();
            const r = await fetch('/upload-file?overwrite=1&path=' + encodeURIComponent(this.path), { method: 'PUT', body: new Blob([bytes], { type: 'audio/midi' }) });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
            this.dirty = false;
            this._status(`Saved ${new Date().toLocaleTimeString()} · ${this._summary()}`);
            log.log(`Saved ${this.path} (${bytes.length} bytes)`);
        } catch (err) {
            log.error('Save failed:', err);
            this._status('Could not save: ' + err.message, true);
            this.saveBtn.disabled = false;
        } finally {
            this._saving = false;
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(message) {
        this.rollMsg.hidden = false;
        this.rollMsg.classList.add('error');
        this.rollMsg.textContent = message;
        this.sheetMsg.textContent = '';
    }
}

registerPlugin({
    id: 'midi',
    name: 'MIDI editor',
    components: {
        midiEditor: MidiComponent,
    },
    contextMenuItems: [{
        label: 'Open in MIDI editor',
        canHandle: (fileName) => MIDI_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = MidiComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('midiEditor', { fileId }, `${file.name} [midi]`, 'midi-' + fileId);
        },
    }],
    init(ctx) {
        MidiComponent._ctx = ctx;
    },
});
