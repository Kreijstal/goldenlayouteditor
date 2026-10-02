// --- Video editor ---
// A timeline video editor in the manner of CapCut / ComeCut, built on
// Mediabunny (WebCodecs). A project (.vcut, JSON) lays clips of the folder's
// videos, pictures and sounds, and titles, out on tracks; the preview plays
// them together and Export renders the timeline into an MP4 or WebM file
// beside the project. Media are referred to by their path from the project's
// folder and are never copied or changed.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');
const { createLogger } = require('./debug');
const log = createLogger('VideoCut');

const MB_URL = 'https://esm.sh/mediabunny@1.61.0';
let _mb = null;
const mediabunny = () => _mb || (_mb = import(MB_URL));

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|mts|m2ts)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const IMAGE_DUR = 5;
const TEXT_DUR = 3;
const HEAD = 132;             // width of the track headers, px
const SNAP_PX = 8;
const PREVIEW_MAX = 1280;     // longest side of the frames decoded for the preview
const AUDIO_AHEAD = 1;        // seconds of sound scheduled ahead while playing
const FONTS = ['sans-serif', 'serif', 'monospace', 'Arial', 'Helvetica', 'Georgia', 'Impact', 'Verdana', 'Courier New', 'Times New Roman', 'Comic Sans MS'];
const SIZES = [
    ['1920×1080 (16:9)', 1920, 1080], ['1280×720 (16:9)', 1280, 720], ['3840×2160 (4K)', 3840, 2160],
    ['1080×1920 (9:16)', 1080, 1920], ['1080×1080 (1:1)', 1080, 1080], ['1080×1350 (4:5)', 1080, 1350],
];

const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clipEnd = c => c.start + c.dur;
const mediaKind = name => VIDEO_EXT.test(name) ? 'video' : AUDIO_EXT.test(name) ? 'audio' : IMAGE_EXT.test(name) ? 'image' : null;

function fmtTime(t, fps) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    const f = Math.floor((t - Math.floor(t)) * (fps || 30) + 1e-6);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

function fmtShort(t) {
    if (t < 60) return (Math.round(t * 10) / 10) + 's';
    return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

// --- The project ---

function newProject() {
    return {
        format: 'vcut', version: 1, width: 1920, height: 1080, fps: 30, background: '#000000',
        tracks: [
            { id: uid(), kind: 'visual', name: 'Video 1', clips: [] },
            { id: uid(), kind: 'audio', name: 'Audio 1', clips: [] },
        ],
    };
}

const CLIP_DEFAULTS = { in: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, volume: 1, fadeIn: 0, fadeOut: 0 };
const TEXT_DEFAULTS = { text: 'Title', font: 'sans-serif', size: 96, color: '#ffffff', bold: true, bg: '', stroke: 0, strokeColor: '#000000' };

function normalizeProject(p) {
    if (!p || typeof p !== 'object') throw new Error('not a video project');
    const out = { ...newProject(), ...p, tracks: [] };
    out.width = Math.max(16, Math.round(+out.width || 1920));
    out.height = Math.max(16, Math.round(+out.height || 1080));
    out.fps = clamp(+out.fps || 30, 1, 120);
    for (const t of Array.isArray(p.tracks) ? p.tracks : []) {
        const kind = t.kind === 'audio' ? 'audio' : 'visual';
        out.tracks.push({
            id: t.id || uid(), kind, name: t.name || (kind === 'audio' ? 'Audio' : 'Video'),
            muted: !!t.muted, hidden: !!t.hidden,
            clips: (Array.isArray(t.clips) ? t.clips : []).filter(c => c && (c.type === 'text' || c.src)).map(c => ({
                ...CLIP_DEFAULTS, ...(c.type === 'text' ? TEXT_DEFAULTS : {}), ...c,
                id: c.id || uid(), start: Math.max(0, +c.start || 0), dur: Math.max(0.01, +c.dur || 1),
            })).sort((a, b) => a.start - b.start),
        });
    }
    if (!out.tracks.some(t => t.kind === 'visual')) out.tracks.unshift({ id: uid(), kind: 'visual', name: 'Video 1', clips: [] });
    if (!out.tracks.some(t => t.kind === 'audio')) out.tracks.push({ id: uid(), kind: 'audio', name: 'Audio 1', clips: [] });
    return out;
}

// How far a clip is faded in or out at timeline time t, 0..1
function fadeFactor(c, t) {
    let f = 1;
    if (c.fadeIn > 0) f = Math.min(f, (t - c.start) / c.fadeIn);
    if (c.fadeOut > 0) f = Math.min(f, (clipEnd(c) - t) / c.fadeOut);
    return clamp(f, 0, 1);
}

// A clip's volume over [from, to] of the timeline as gain automation; ctxTime
// maps timeline time to the audio context's clock
function scheduleGain(param, c, vol, from, to, ctxTime) {
    const v = tl => vol * fadeFactor(c, tl);
    param.setValueAtTime(v(from), ctxTime(from));
    const points = [c.start + c.fadeIn, clipEnd(c) - c.fadeOut, clipEnd(c)].filter(p => p > from && p <= to).sort((a, b) => a - b);
    for (const p of points) param.linearRampToValueAtTime(v(p), ctxTime(p));
}

// --- Media: what a clip shows or plays, loaded once per file ---

class MediaStore {
    constructor(urlFor, onChange) {
        this.urlFor = urlFor;
        this.onChange = onChange;
        this.map = new Map();
    }

    get(src) {
        let m = this.map.get(src);
        if (!m) {
            m = { src, kind: mediaKind(src), duration: 0, width: 0, height: 0, first: 0, thumbs: [], peaks: null, error: null };
            m.ready = this._load(m).catch(err => {
                m.error = err.message || String(err);
                log.warn(`Could not read ${src}:`, err);
            }).then(() => { this.onChange(m); return m; });
            this.map.set(src, m);
        }
        return m;
    }

    async _load(m) {
        const url = await this.urlFor(m.src);
        if (m.kind === 'image') {
            const img = new Image();
            img.src = url;
            await img.decode();
            Object.assign(m, { image: img, width: img.naturalWidth || 512, height: img.naturalHeight || 512 });
            m.thumbs = [{ t: 0, canvas: img }];
            return;
        }
        const mb = await mediabunny();
        const input = new mb.Input({ source: new mb.UrlSource(url), formats: mb.ALL_FORMATS });
        m.input = input;
        let video = await input.getPrimaryVideoTrack();
        let audio = await input.getPrimaryAudioTrack();
        if (video && !(await video.canDecode())) { m.note = `this browser cannot decode its ${video.codec || 'video'}`; video = null; }
        if (audio && !(await audio.canDecode())) { m.note = `this browser cannot decode its ${audio.codec || 'sound'}`; audio = null; }
        if (!video && !audio) throw new Error(m.note || 'no video or sound in it');
        m.kind = video ? 'video' : 'audio';
        m.duration = await input.computeDuration();
        if (video) {
            m.video = video;
            m.width = await video.getDisplayWidth();
            m.height = await video.getDisplayHeight();
            m.first = Math.max(0, await video.getFirstTimestamp());
            const k = Math.min(1, PREVIEW_MAX / Math.max(m.width, m.height));
            m.sink = new mb.CanvasSink(video, { width: Math.max(2, Math.round(m.width * k)), height: Math.max(2, Math.round(m.height * k)), fit: 'fill' });
            this._thumbs(mb, m);
        }
        if (audio) {
            m.audio = audio;
            m.audioSink = new mb.AudioBufferSink(audio);
            this._peaks(m);
        }
    }

    // A handful of small frames spread over the video, for the bin and the clips
    async _thumbs(mb, m) {
        try {
            const h = 54, w = Math.max(8, Math.round(h * m.width / m.height));
            const sink = new mb.CanvasSink(m.video, { width: w, height: h, fit: 'fill' });
            const n = clamp(Math.ceil(m.duration / 2), 4, 60);
            const times = Array.from({ length: n }, (_, i) => m.first + (m.duration - m.first) * (i + 0.5) / n);
            let i = 0;
            for await (const wc of sink.canvasesAtTimestamps(times)) {
                if (wc) m.thumbs.push({ t: times[i], canvas: wc.canvas });
                i++;
                if (i === 1 || i % 8 === 0) this.onChange(m);
            }
            this.onChange(m);
        } catch (err) {
            log.warn(`No thumbnails for ${m.src}:`, err);
        }
    }

    // Loudness, 50 values a second, for the waveform
    async _peaks(m) {
        if (m.duration > 3 * 3600) return;
        try {
            const rate = 50;
            const peaks = new Float32Array(Math.ceil(m.duration * rate) + 1);
            m.peaks = peaks;
            let lastShown = performance.now();
            for await (const { buffer, timestamp } of m.audioSink.buffers(0, m.duration)) {
                const data = buffer.getChannelData(0);
                const per = buffer.sampleRate / rate;
                for (let j = 0; j < data.length; j += 4) {
                    const k = Math.floor((timestamp + j / buffer.sampleRate) * rate);
                    const a = Math.abs(data[j]);
                    if (k >= 0 && k < peaks.length && a > peaks[k]) peaks[k] = a;
                }
                if (per && performance.now() - lastShown > 700) { lastShown = performance.now(); this.onChange(m); }
            }
            this.onChange(m);
        } catch (err) {
            log.warn(`No waveform for ${m.src}:`, err);
        }
    }

    dispose() {
        for (const m of this.map.values()) try { if (m.input) m.input.dispose(); } catch (_) { /* gone */ }
        this.map.clear();
    }
}

// The frames of one clip while it plays: decodes ahead one frame and skips
// frames that are already late
class FrameStream {
    constructor(sink, t) {
        this.it = sink.canvases(t);
        this.cur = null;
        this.next = null;
        this.want = t;
        this.busy = false;
        this.done = false;
        this.pump();
    }

    pump() {
        if (this.busy || this.done || this.next) return;
        this.busy = true;
        this.it.next().then(r => {
            this.busy = false;
            if (this.done) return;
            if (r.done) { this.done = true; return; }
            const f = r.value;
            if (!this.cur || f.timestamp <= this.want) this.cur = f;
            else this.next = f;
            this.pump();
        }, err => {
            this.busy = false;
            this.done = true;
            log.warn('Decoding stopped:', err);
        });
    }

    advance(t) {
        this.want = t;
        if (this.next && this.next.timestamp <= t) {
            this.cur = this.next;
            this.next = null;
        }
        this.pump();
    }

    close() {
        this.done = true;
        this.it.return().catch(() => {});
    }
}

// The same for the export, where every frame is waited for
class ExportStream {
    constructor(sink, t) {
        this.it = sink.canvases(t);
        this.cur = null;
        this.next = null;
        this.done = false;
    }

    async frameAt(t) {
        for (;;) {
            if (!this.next && !this.done) {
                const r = await this.it.next();
                if (r.done) this.done = true;
                else this.next = r.value;
            }
            if (this.next && (!this.cur || this.next.timestamp <= t + 1e-6)) {
                this.cur = this.next;
                this.next = null;
            } else break;
        }
        return this.cur ? this.cur.canvas : null;
    }

    close() {
        this.done = true;
        this.it.return().catch(() => {});
    }
}

// Draws a title centred on the origin; returns its size
function drawText(g, c, k, measureOnly) {
    const size = Math.max(1, c.size * k);
    g.font = `${c.bold ? 700 : 400} ${size}px ${/\s/.test(c.font) ? `"${c.font}"` : c.font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = String(c.text || '').split('\n');
    const lh = size * 1.25;
    const w = Math.max(1, ...lines.map(l => g.measureText(l).width));
    const h = lh * lines.length;
    const pad = size * 0.3;
    if (measureOnly) return { w: w + 2 * pad, h: h + pad };
    if (c.bg) {
        g.fillStyle = c.bg;
        g.beginPath();
        if (g.roundRect) g.roundRect(-w / 2 - pad, -h / 2 - pad / 2, w + 2 * pad, h + pad, pad * 0.6);
        else g.rect(-w / 2 - pad, -h / 2 - pad / 2, w + 2 * pad, h + pad);
        g.fill();
    }
    lines.forEach((line, i) => {
        const y = -h / 2 + lh * (i + 0.5);
        if (c.stroke > 0) {
            g.lineWidth = c.stroke * k * 2;
            g.strokeStyle = c.strokeColor || '#000';
            g.lineJoin = 'round';
            g.strokeText(line, 0, y);
        }
        g.fillStyle = c.color || '#fff';
        g.fillText(line, 0, y);
    });
    return { w: w + 2 * pad, h: h + pad };
}

// --- The editor ---

class VideoCutComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = VideoCutComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.path = this.state.path || this._pathOf(this.fileId);
        this.project = null;
        this.selected = null;
        this.time = 0;
        this.pps = 60;
        this.playing = false;
        this.playToken = 0;
        this.streams = new Map();
        this.stills = new Map();
        this.audioNodes = [];
        this.history = [];
        this.hIndex = -1;
        this.dirty = false;
        this.exporting = null;
        this.store = new MediaStore(src => this._urlFor(src), m => this._mediaChanged(m));
        this.root = container.element;
        this.root.classList.add('vc-root');
        this.root.tabIndex = 0;
        VideoCutComponent._installStyles();
        this._buildUI();
        if (container.on) {
            container.on('destroy', () => this._destroy());
            container.on('resize', () => this._layout());
        }
        this._init();
    }

    _pathOf(fileId) {
        if (!fileId || !this.ctx || !this.ctx.currentWorkspacePath) return null;
        const rel = this.ctx.getRelativePath(fileId);
        return rel ? this.ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + rel : null;
    }

    get dir() {
        return this.path ? this.path.slice(0, this.path.lastIndexOf('/')) : (this.ctx && this.ctx.currentWorkspacePath || '').replace(/\/+$/, '');
    }

    async _urlFor(src) {
        const abs = src.startsWith('/') ? src : this.dir + '/' + src;
        return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(abs));
    }

    static _installStyles() {
        if (VideoCutComponent._styled) return;
        VideoCutComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.vc-root{height:100%;background:#1b1e23;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;outline:none;user-select:none}
.vc-shell{display:grid;grid-template-rows:auto minmax(120px,1fr) auto minmax(110px,var(--vc-tl,40%));height:100%}
.vc-toolbar{display:flex;align-items:center;gap:5px;padding:5px 8px;background:#262a31;border-bottom:1px solid #3a404a;flex-wrap:wrap}
.vc-root button,.vc-root select,.vc-root input{font:inherit;color:#e6edf3;background:#343a44;border:1px solid #4b5360;border-radius:4px}
.vc-root button{padding:3px 8px;cursor:pointer;white-space:nowrap}
.vc-root button:hover:not(:disabled){background:#414956}
.vc-root button:disabled{opacity:.4;cursor:default}
.vc-root button.vc-primary{background:#1f6feb;border-color:#388bfd}
.vc-root button.vc-primary:hover:not(:disabled){background:#388bfd}
.vc-root input,.vc-root select{padding:2px 4px;min-width:0}
.vc-root input[type=color]{padding:0;width:34px;height:22px}
.vc-root input[type=range]{padding:0;border:0;background:none}
.vc-title{font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:6px}
.vc-sep{width:1px;height:18px;background:#3a404a;margin:0 3px}
.vc-status{margin-left:auto;color:#9da7b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.vc-status.error{color:#ff938a}
.vc-main{display:grid;grid-template-columns:minmax(150px,210px) 1fr minmax(180px,240px);min-height:0}
.vc-bin,.vc-insp{overflow:auto;background:#20242a;min-height:0}
.vc-bin{border-right:1px solid #3a404a}
.vc-insp{border-left:1px solid #3a404a;padding:8px}
.vc-panel-head{display:flex;align-items:center;gap:4px;padding:6px 8px;font-weight:600;color:#adbac7;position:sticky;top:0;background:#20242a;z-index:1}
.vc-panel-head span{flex:1}
.vc-bin-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px;padding:0 8px 8px}
.vc-item{background:#2b3038;border:1px solid #3a404a;border-radius:5px;overflow:hidden;cursor:grab}
.vc-item:hover{border-color:#58a6ff}
.vc-item .vc-thumb{height:50px;background:#111 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#6e7681;font-size:18px;position:relative}
.vc-item .vc-thumb canvas,.vc-item .vc-thumb img{max-width:100%;max-height:100%}
.vc-item .vc-dur{position:absolute;right:3px;bottom:2px;font-size:10px;background:#000a;padding:0 3px;border-radius:3px;color:#ddd}
.vc-item .vc-name{padding:3px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}
.vc-item.error .vc-name{color:#ff938a}
.vc-empty{padding:10px;color:#768390;line-height:1.5}
.vc-stage{position:relative;display:flex;align-items:center;justify-content:center;background:#0d0f12;min-height:0;min-width:0;overflow:hidden}
.vc-stage canvas{background:#000;box-shadow:0 0 0 1px #30363d}
.vc-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:#9da7b3;text-align:center;padding:20px;background:#0d0f12}
.vc-message.error{color:#ff938a}
.vc-message[hidden],.vc-progress[hidden]{display:none}
.vc-transport{display:flex;align-items:center;gap:6px;padding:4px 8px;background:#262a31;border-top:1px solid #3a404a;border-bottom:1px solid #3a404a}
.vc-time{font-variant-numeric:tabular-nums;min-width:170px;text-align:center;color:#c9d1d9}
.vc-play{min-width:34px}
.vc-tl-scroll{overflow:auto;position:relative;background:#1b1e23;min-height:0}
.vc-tl-inner{position:relative;min-height:100%}
.vc-ruler{position:sticky;top:0;height:24px;z-index:4;background:#262a31;border-bottom:1px solid #3a404a;cursor:text}
.vc-ruler-corner{position:sticky;left:0;width:${HEAD}px;height:24px;background:#262a31;z-index:5;border-right:1px solid #3a404a;display:flex;align-items:center;gap:3px;padding:0 4px;box-sizing:border-box}
.vc-ruler canvas{position:absolute;top:0;height:24px}
.vc-track{display:flex;height:var(--h,52px);border-bottom:1px solid #2b3038}
.vc-track.audio{--h:40px}
.vc-thead{position:sticky;left:0;z-index:3;width:${HEAD}px;flex:none;background:#23272e;border-right:1px solid #3a404a;display:flex;align-items:center;gap:2px;padding:0 4px;box-sizing:border-box}
.vc-thead .vc-tname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#adbac7}
.vc-thead button{padding:0 4px;border:0;background:none;color:#9da7b3;font-size:13px}
.vc-thead button.off{color:#f0883e}
.vc-lane{position:relative;flex:1;min-width:0}
.vc-lane.drop{background:#1f6feb22}
.vc-clip{position:absolute;top:3px;bottom:3px;border-radius:5px;overflow:hidden;cursor:grab;box-sizing:border-box;border:1px solid #0006}
.vc-clip.video{background:#2f4f7a}
.vc-clip.image{background:#4d3f75}
.vc-clip.audio{background:#27584a}
.vc-clip.text{background:#7a5a22}
.vc-clip.missing{background:#6e2b2b}
.vc-clip.sel{outline:2px solid #f0f6fc;outline-offset:-1px;z-index:2}
.vc-clip canvas{position:absolute;left:0;top:0;height:100%;pointer-events:none;opacity:.85}
.vc-clip .vc-clabel{position:absolute;left:6px;top:2px;right:6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000;pointer-events:none}
.vc-clip .vc-h{position:absolute;top:0;bottom:0;width:7px;cursor:ew-resize;z-index:1}
.vc-clip .vc-h.l{left:0}.vc-clip .vc-h.r{right:0}
.vc-clip.sel .vc-h{background:#f0f6fc55}
.vc-clip .vc-fade{position:absolute;top:0;height:100%;pointer-events:none}
.vc-playhead{position:absolute;top:0;bottom:0;width:0;border-left:2px solid #ff5c5c;z-index:6;pointer-events:none}
.vc-playhead::before{content:'';position:absolute;left:-7px;top:0;border:6px solid transparent;border-top:8px solid #ff5c5c}
.vc-snapline{position:absolute;top:0;bottom:0;border-left:1px dashed #f0f6fc;z-index:5;pointer-events:none}
.vc-addtracks{position:sticky;left:0;display:flex;gap:4px;padding:6px;width:max-content}
.vc-insp h4{margin:2px 0 8px;font-size:12px;color:#adbac7}
.vc-row{display:grid;grid-template-columns:78px 1fr;align-items:center;gap:6px;margin-bottom:6px}
.vc-row label{color:#9da7b3}
.vc-row .vc-pair{display:flex;gap:4px;align-items:center}
.vc-row .vc-pair input[type=range]{flex:1;width:0;min-width:0}
.vc-row .vc-pair select{flex:1;width:0;min-width:0}
.vc-row .vc-pair input[type=number]{width:52px;flex:none}
.vc-insp textarea{width:100%;box-sizing:border-box;min-height:56px;font:inherit;color:#e6edf3;background:#343a44;border:1px solid #4b5360;border-radius:4px;resize:vertical}
.vc-insp .vc-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:10px}
.vc-hint{color:#768390;line-height:1.5;margin-top:10px}
.vc-narrow .vc-main{grid-template-columns:1fr 1fr;grid-template-rows:minmax(90px,1fr) minmax(0,42%)}
.vc-narrow .vc-stage{grid-column:1/-1;grid-row:1}
.vc-narrow .vc-bin{border-top:1px solid #3a404a}
.vc-narrow .vc-insp{border-top:1px solid #3a404a}
.vc-narrow .vc-title,.vc-narrow .vc-status{display:none}
.vc-narrow .vc-time{min-width:0}
.vc-dialog{position:absolute;right:8px;top:36px;z-index:20;background:#262a31;border:1px solid #4b5360;border-radius:6px;padding:10px;width:250px;box-shadow:0 8px 24px #0008}
.vc-dialog h4{margin:0 0 8px}
.vc-progress{height:6px;background:#343a44;border-radius:3px;overflow:hidden;margin:8px 0}
.vc-progress div{height:100%;width:0;background:#388bfd}
`;
        document.head.appendChild(style);
    }

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    _button(label, title, onClick, cls) {
        const b = this._el('button', cls, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', e => { e.stopPropagation(); onClick(e); this.root.focus({ preventScroll: true }); });
        return b;
    }

    _buildUI() {
        const shell = this._el('div', 'vc-shell');
        // Toolbar
        const tb = this._el('div', 'vc-toolbar');
        this.titleEl = this._el('span', 'vc-title', 'Video editor');
        this.undoBtn = this._button('↶', 'Undo (Ctrl+Z)', () => this._undo());
        this.redoBtn = this._button('↷', 'Redo (Ctrl+Shift+Z)', () => this._redo());
        this.splitBtn = this._button('✂ Split', 'Split at the playhead (S)', () => this._split());
        this.delBtn = this._button('🗑', 'Delete the selected clip (Delete)', () => this._deleteSelected());
        this.textBtn = this._button('T+ Text', 'Add a title at the playhead', () => this._addText());
        this.saveBtn = this._button('Save', 'Save the project (Ctrl+S); it also saves by itself', () => this._save());
        this.exportBtn = this._button('Export', 'Render the timeline to a video file', () => this._toggleExport(), 'vc-primary');
        this.statusEl = this._el('span', 'vc-status');
        tb.append(this.titleEl, this.undoBtn, this.redoBtn, this._el('span', 'vc-sep'), this.splitBtn, this.delBtn, this.textBtn,
            this._el('span', 'vc-sep'), this.saveBtn, this.exportBtn, this.statusEl);

        // Media, preview, inspector
        const main = this._el('div', 'vc-main');
        this.bin = this._el('div', 'vc-bin');
        const binHead = this._el('div', 'vc-panel-head');
        binHead.append(this._el('span', null, 'Media'),
            this._button('⟳', 'Look for new files in the folder', () => this._listMedia()),
            this._button('Import…', 'Copy files into the project folder', () => this.fileInput.click()));
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.multiple = true;
        this.fileInput.accept = 'video/*,audio/*,image/*';
        this.fileInput.hidden = true;
        this.fileInput.addEventListener('change', () => { this._import([...this.fileInput.files]); this.fileInput.value = ''; });
        this.binList = this._el('div', 'vc-bin-list');
        this.bin.append(binHead, this.binList, this.fileInput);

        this.stage = this._el('div', 'vc-stage');
        this.canvas = this._el('canvas');
        this.g = this.canvas.getContext('2d');
        this.message = this._el('div', 'vc-message', 'Loading…');
        this.stage.append(this.canvas, this.message);

        this.insp = this._el('div', 'vc-insp');
        main.append(this.bin, this.stage, this.insp);

        // Transport
        const tr = this._el('div', 'vc-transport');
        this.playBtn = this._button('▶', 'Play / pause (Space)', () => this._togglePlay(), 'vc-play');
        this.timeEl = this._el('span', 'vc-time', '00:00.00 / 00:00.00');
        const zoomOut = this._button('−', 'Zoom the timeline out (-)', () => this._zoomBy(1 / 1.5));
        const zoomIn = this._button('+', 'Zoom the timeline in (+)', () => this._zoomBy(1.5));
        const zoomFit = this._button('Fit', 'Fit the whole timeline', () => this._zoomFit());
        tr.append(this._button('⏮', 'To the start (Home)', () => this._seek(0)),
            this._button('◀|', 'One frame back (←)', () => this._step(-1)), this.playBtn,
            this._button('|▶', 'One frame on (→)', () => this._step(1)),
            this._button('⏭', 'To the end (End)', () => this._seek(this._duration())),
            this.timeEl, this._el('span', 'vc-sep'), zoomOut, zoomIn, zoomFit);

        // Timeline
        this.tlScroll = this._el('div', 'vc-tl-scroll');
        this.tlInner = this._el('div', 'vc-tl-inner');
        this.tlScroll.append(this.tlInner);
        this.tlScroll.addEventListener('scroll', () => this._drawRuler());
        this.tlScroll.addEventListener('wheel', e => this._timelineWheel(e), { passive: false });

        shell.append(tb, main, tr, this.tlScroll);
        this.root.appendChild(shell);

        this.root.addEventListener('keydown', e => this._key(e));
        this.root.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
        this.root.addEventListener('drop', e => {
            if (!e.dataTransfer.files.length || e.defaultPrevented) return;
            e.preventDefault();
            this._import([...e.dataTransfer.files]);
        });
        this._stageEvents();
        this.resizeObserver = new ResizeObserver(() => this._layout());
        this.resizeObserver.observe(this.stage);
        this.resizeObserver.observe(this.tlScroll);
        this._updateButtons();
    }

    // --- Loading and saving ---

    async _init() {
        if (!this.path) {
            this._showStart();
            return;
        }
        this.readOnly = insideArchive(this.path);
        this.titleEl.textContent = this.path.split('/').pop();
        try {
            const r = await fetch('/workspace-file?path=' + encodeURIComponent(this.path));
            if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
            const text = await r.text();
            this.project = text.trim() ? normalizeProject(JSON.parse(text)) : newProject();
        } catch (err) {
            this._fail(`Could not open ${this.path.split('/').pop()}: ${err.message}`);
            return;
        }
        this.history = [JSON.stringify(this.project)];
        this.hIndex = 0;
        this.message.hidden = true;
        for (const t of this.project.tracks) for (const c of t.clips) if (c.src) this.store.get(c.src);
        this._layout();
        this._renderTimeline();
        this._renderInspector();
        this._listMedia();
        this._zoomFit();
        this._status(this.readOnly ? 'Read only: the project is inside an archive' : 'Drag media onto the timeline');
    }

    _showStart() {
        this.message.textContent = '';
        this.message.append(this._el('div', null, 'Open a .vcut project from the file list, or start one in the workspace.'),
            this._button('New video project', 'Create Untitled.vcut in the workspace', () => this._createProject(), 'vc-primary'));
    }

    async _createProject() {
        if (!this.ctx || !this.ctx.currentWorkspacePath) {
            this.message.firstChild.textContent = 'Open a workspace folder first: the project and its media live there.';
            return;
        }
        const dir = (this.ctx.currentWorkspacePath || '').replace(/\/+$/, '');
        const body = JSON.stringify(newProject(), null, 2) + '\n';
        const name = await this._uploadUnique(dir, 'Untitled', '.vcut', new Blob([body], { type: 'application/json' }));
        if (!name) return;
        this.path = dir + '/' + name;
        this.message.textContent = 'Loading…';
        this._init();
    }

    // Writes a file under dir as stem+ext, or stem-2+ext … when that exists
    async _uploadUnique(dir, stem, ext, blob) {
        for (let n = 1; n < 1000; n++) {
            const name = stem + (n > 1 ? `-${n}` : '') + ext;
            const r = await fetch('/upload-file?path=' + encodeURIComponent(dir + '/' + name), { method: 'PUT', body: blob });
            if (r.status === 409) continue;
            if (!r.ok) {
                this._status(`Could not write ${name}: ${(await r.json().catch(() => ({}))).error || r.status}`, true);
                return null;
            }
            return name;
        }
        return null;
    }

    _scheduleSave() {
        if (this.readOnly || !this.path) return;
        this.dirty = true;
        this._updateButtons();
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this._save(), 1200);
    }

    async _save() {
        clearTimeout(this.saveTimer);
        if (this.readOnly || !this.project || !this.dirty) return;
        if (this.saving) { this.saveAgain = true; return; }
        this.saving = true;
        const text = JSON.stringify(this.project, null, 2) + '\n';
        try {
            const r = await fetch('/upload-file?overwrite=1&path=' + encodeURIComponent(this.path), { method: 'PUT', body: new Blob([text], { type: 'application/json' }) });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
            if (JSON.stringify(this.project, null, 2) + '\n' === text) this.dirty = false;
            if (this.fileId && this.ctx && this.ctx.projectFiles[this.fileId]) {
                this.ctx.setFileContent(this.fileId, text);
                this.ctx.clearDirty(this.fileId);
            }
        } catch (err) {
            this._status('Could not save: ' + err.message, true);
        } finally {
            this.saving = false;
            this._updateButtons();
            if (this.saveAgain) { this.saveAgain = false; this._scheduleSave(); }
        }
    }

    // --- Media bin ---

    async _listMedia() {
        const ws = this.ctx && this.ctx.wsClient;
        if (!ws || !ws.wsRequest || !this.dir) return;
        const found = [];
        const walk = async (abs, rel, depth) => {
            let res;
            try { res = await ws.wsRequest({ type: 'listDir', path: abs }); } catch (_) { return; }
            if (!res || res.error || !res.items) return;
            for (const it of res.items) {
                if (it.name.startsWith('.') || found.length >= 400) continue;
                if (it.isDirectory) {
                    if (depth < 2 && !/^(node_modules|target|dist|build)$/.test(it.name)) await walk(abs + '/' + it.name, rel + it.name + '/', depth + 1);
                } else if (mediaKind(it.name)) {
                    found.push(rel + it.name);
                }
            }
        };
        await walk(this.dir, '', 0);
        this.mediaList = found.sort((a, b) => a.localeCompare(b));
        this._renderBin();
    }

    _renderBin() {
        this.binList.textContent = '';
        const list = this.mediaList || [];
        if (!list.length) {
            const e = this._el('div', 'vc-empty', 'No videos, pictures or sounds in this folder yet. Import some, or drop files here.');
            e.style.gridColumn = '1/-1';
            this.binList.appendChild(e);
            return;
        }
        this.binItems = new Map();
        for (const src of list) {
            const item = this._el('div', 'vc-item');
            item.draggable = true;
            item.title = src + '\nDrag onto the timeline, or double-click to add at the end';
            const thumb = this._el('div', 'vc-thumb', { video: '🎞', image: '🖼', audio: '♪' }[mediaKind(src)]);
            const name = this._el('div', 'vc-name', src.split('/').pop());
            item.append(thumb, name);
            item.addEventListener('dragstart', e => {
                e.dataTransfer.setData('application/x-vcut-media', src);
                e.dataTransfer.effectAllowed = 'copy';
                this.store.get(src);
            });
            item.addEventListener('dblclick', () => this._appendMedia(src));
            item.addEventListener('mouseenter', () => this.store.get(src));
            this.binList.appendChild(item);
            this.binItems.set(src, { item, thumb });
            this._fillBinItem(src);
        }
        // Thumbnails for everything shown, a few at a time
        (async () => {
            for (const src of list) {
                if (!this.binItems || !this.binItems.has(src)) return;
                await this.store.get(src).ready;
            }
        })();
    }

    _fillBinItem(src) {
        const entry = this.binItems && this.binItems.get(src);
        const m = this.store.map.get(src);
        if (!entry || !m) return;
        entry.item.classList.toggle('error', !!m.error);
        if (m.error) entry.item.title = `${src}\n${m.error}`;
        const t = m.thumbs[0];
        if (t && !entry.thumb.querySelector('canvas,img')) {
            entry.thumb.textContent = '';
            const c = document.createElement('canvas');
            const w = t.canvas.width || t.canvas.naturalWidth, h = t.canvas.height || t.canvas.naturalHeight;
            const k = Math.min(1, 160 / Math.max(w, h));
            c.width = Math.max(1, Math.round(w * k));
            c.height = Math.max(1, Math.round(h * k));
            c.getContext('2d').drawImage(t.canvas, 0, 0, c.width, c.height);
            entry.thumb.appendChild(c);
        }
        if (m.duration && !entry.thumb.querySelector('.vc-dur')) entry.thumb.appendChild(this._el('span', 'vc-dur', fmtShort(m.duration)));
    }

    async _import(files) {
        if (!this.project || this.readOnly) return this._status('Open a project first', true);
        const media = files.filter(f => mediaKind(f.name));
        if (!media.length) return this._status('Only videos, pictures and sounds can be imported', true);
        const added = [];
        for (const [i, f] of media.entries()) {
            this._status(`Importing ${f.name} (${i + 1}/${media.length})…`);
            const dot = f.name.lastIndexOf('.');
            const name = await this._uploadUnique(this.dir, f.name.slice(0, dot), f.name.slice(dot), f);
            if (name) added.push(name);
        }
        await this._listMedia();
        this._status(added.length ? `Imported ${added.join(', ')}` : 'Nothing imported', !added.length);
        return added;
    }

    _mediaChanged(m) {
        if (this.destroyed) return;
        this._fillBinItem(m.src);
        clearTimeout(this.mediaTimer);
        this.mediaTimer = setTimeout(() => {
            if (!this.project) return;
            this._renderTimeline();
            this._draw();
            if (!this.playing) this._fetchStills();
        }, 60);
    }

    // --- Timeline model ---

    _duration() {
        let d = 0;
        if (this.project) for (const t of this.project.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
        return d;
    }

    _find(clipId) {
        for (const t of this.project.tracks) {
            const i = t.clips.findIndex(c => c.id === clipId);
            if (i >= 0) return { track: t, clip: t.clips[i], index: i };
        }
        return null;
    }

    _track(id) {
        return this.project.tracks.find(t => t.id === id);
    }

    _clipAt(track, t) {
        return track.clips.find(c => c.start <= t + 1e-9 && t < clipEnd(c) - 1e-9);
    }

    _free(track, start, end, except) {
        return track.clips.every(c => c.id === except || clipEnd(c) <= start + 1e-6 || c.start >= end - 1e-6);
    }

    _clipKind(c) {
        if (c.type === 'text') return 'text';
        const m = this.store.map.get(c.src);
        return (m && m.kind) || mediaKind(c.src) || 'video';
    }

    _trackKindFor(c) {
        return this._clipKind(c) === 'audio' ? 'audio' : 'visual';
    }

    _newTrack(kind, where) {
        const n = this.project.tracks.filter(t => t.kind === kind).length + 1;
        const t = { id: uid(), kind, name: `${kind === 'audio' ? 'Audio' : 'Video'} ${n}`, muted: false, hidden: false, clips: [] };
        const tracks = this.project.tracks;
        if (where !== undefined) tracks.splice(where, 0, t);
        else if (kind === 'visual') tracks.splice(0, 0, t);
        else tracks.push(t);
        return t;
    }

    // A track of the kind with room for [start, end): the preferred one, else the
    // first that has room, else a new one
    _trackWithRoom(kind, start, end, preferred) {
        if (preferred && preferred.kind === kind && this._free(preferred, start, end)) return preferred;
        const ordered = this.project.tracks.filter(t => t.kind === kind);
        if (kind === 'visual') ordered.reverse();
        return ordered.find(t => this._free(t, start, end)) || this._newTrack(kind);
    }

    _sortClips(track) {
        track.clips.sort((a, b) => a.start - b.start);
    }

    _commit(label) {
        const snap = JSON.stringify(this.project);
        if (snap === this.history[this.hIndex]) return;
        this.history = this.history.slice(0, this.hIndex + 1);
        this.history.push(snap);
        if (this.history.length > 300) this.history.shift();
        this.hIndex = this.history.length - 1;
        if (label) this._status(label);
        this._afterChange();
    }

    _afterChange() {
        if (this.selected && !this._find(this.selected)) this.selected = null;
        this._scheduleSave();
        this._renderTimeline();
        this._renderInspector();
        this._updateButtons();
        this._restartIfPlaying();
        this._draw();
        this._fetchStills();
    }

    _undo() {
        if (this.hIndex <= 0) return;
        this.project = JSON.parse(this.history[--this.hIndex]);
        this._afterChange();
    }

    _redo() {
        if (this.hIndex >= this.history.length - 1) return;
        this.project = JSON.parse(this.history[++this.hIndex]);
        this._afterChange();
    }

    _updateButtons() {
        const ok = !!this.project && !this.readOnly;
        this.undoBtn.disabled = !ok || this.hIndex <= 0;
        this.redoBtn.disabled = !ok || this.hIndex >= this.history.length - 1;
        this.splitBtn.disabled = !ok;
        this.delBtn.disabled = !ok || !this.selected;
        this.textBtn.disabled = !ok;
        this.saveBtn.disabled = !ok || !this.dirty;
        this.saveBtn.textContent = this.dirty ? 'Save •' : 'Saved';
        this.exportBtn.disabled = !this.project;
    }

    // --- Editing ---

    async _appendMedia(src) {
        if (this.readOnly) return;
        const m = await this.store.get(src).ready;
        if (m.error) return this._status(`${src}: ${m.error}`, true);
        const kind = m.kind === 'audio' ? 'audio' : 'visual';
        const tracks = this.project.tracks.filter(t => t.kind === kind);
        const track = kind === 'visual' ? tracks[tracks.length - 1] : tracks[0];
        const start = track ? track.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0) : 0;
        this._placeMedia(src, start, track);
    }

    async _placeMedia(src, start, preferred) {
        const m = await this.store.get(src).ready;
        if (m.error) return this._status(`${src}: ${m.error}`, true);
        const dur = m.kind === 'image' ? IMAGE_DUR : Math.max(0.05, m.duration);
        const kind = m.kind === 'audio' ? 'audio' : 'visual';
        const track = this._trackWithRoom(kind, start, start + dur, preferred);
        const clip = { ...CLIP_DEFAULTS, id: uid(), src, start, dur, in: 0 };
        track.clips.push(clip);
        this._sortClips(track);
        this.selected = clip.id;
        this._commit(`Added ${src.split('/').pop()}`);
    }

    _addText() {
        if (this.readOnly || !this.project) return;
        const start = this.time;
        const tracks = this.project.tracks.filter(t => t.kind === 'visual');
        // Titles go above the pictures: the top track with room, else a new top track
        const track = tracks.find(t => this._free(t, start, start + TEXT_DUR) && t.clips.every(c => c.type === 'text')) || this._newTrack('visual', 0);
        const clip = { ...CLIP_DEFAULTS, ...TEXT_DEFAULTS, id: uid(), type: 'text', start, dur: TEXT_DUR, y: 0.8 };
        track.clips.push(clip);
        this._sortClips(track);
        this.selected = clip.id;
        this._commit('Added a title');
    }

    _split() {
        if (this.readOnly || !this.project) return;
        const t = this.time;
        const minDur = 1 / this.project.fps;
        let targets = [];
        const sel = this.selected && this._find(this.selected);
        if (sel && sel.clip.start + minDur <= t && t <= clipEnd(sel.clip) - minDur) targets = [sel];
        else for (const track of this.project.tracks) {
            const clip = this._clipAt(track, t);
            if (clip && clip.start + minDur <= t && t <= clipEnd(clip) - minDur) targets.push({ track, clip });
        }
        if (!targets.length) return this._status('Nothing under the playhead to split', true);
        for (const { track, clip } of targets) {
            const cut = t - clip.start;
            const right = { ...clip, id: uid(), start: t, in: clip.in + cut, dur: clip.dur - cut, fadeIn: 0 };
            clip.dur = cut;
            clip.fadeOut = 0;
            track.clips.push(right);
            this._sortClips(track);
            if (sel) this.selected = right.id;
        }
        this._commit('Split');
    }

    _deleteSelected() {
        const f = this.selected && this._find(this.selected);
        if (!f || this.readOnly) return;
        f.track.clips.splice(f.index, 1);
        this.selected = null;
        this._commit('Deleted the clip');
    }

    _detachAudio() {
        const f = this.selected && this._find(this.selected);
        if (!f || this.readOnly) return;
        const c = f.clip;
        const track = this._trackWithRoom('audio', c.start, clipEnd(c));
        track.clips.push({ ...CLIP_DEFAULTS, id: uid(), src: c.src, start: c.start, in: c.in, dur: c.dur, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
        this._sortClips(track);
        c.volume = 0;
        this._commit('Sound detached to its own track');
    }

    _deleteTrack(track) {
        if (track.clips.length || this.project.tracks.filter(t => t.kind === track.kind).length <= 1) return;
        this.project.tracks = this.project.tracks.filter(t => t !== track);
        this._commit();
    }

    // --- Timeline view ---

    _x(t) { return HEAD + t * this.pps; }

    _timeAt(clientX) {
        const r = this.tlInner.getBoundingClientRect();
        return Math.max(0, (clientX - r.left - HEAD) / this.pps);
    }

    _renderTimeline() {
        if (!this.project) return;
        const dur = this._duration();
        const viewW = this.tlScroll.clientWidth || 800;
        const width = Math.max(viewW, this._x(dur + Math.max(10, viewW * 0.3 / this.pps)));
        this.tlInner.textContent = '';
        this.tlInner.style.width = width + 'px';
        this.clipEls = new Map();
        this.laneEls = new Map();

        // Ruler
        const ruler = this._el('div', 'vc-ruler');
        const corner = this._el('div', 'vc-ruler-corner');
        corner.append(this._el('span', null, ''));
        this.rulerCanvas = this._el('canvas');
        ruler.append(corner, this.rulerCanvas);
        ruler.addEventListener('pointerdown', e => this._scrub(e));
        this.tlInner.appendChild(ruler);

        // Tracks: pictures above sound
        const ordered = [...this.project.tracks.filter(t => t.kind === 'visual'), ...this.project.tracks.filter(t => t.kind === 'audio')];
        for (const track of ordered) {
            const row = this._el('div', 'vc-track ' + track.kind);
            const head = this._el('div', 'vc-thead');
            const name = this._el('span', 'vc-tname', track.name);
            name.title = 'Double-click to rename';
            name.addEventListener('dblclick', () => {
                if (this.readOnly) return;
                const v = window.prompt('Track name', track.name);
                if (v) { track.name = v; this._commit(); }
            });
            head.append(name);
            if (track.kind === 'visual') {
                const eye = this._button(track.hidden ? '◌' : '👁', track.hidden ? 'Show this track' : 'Hide this track', () => { track.hidden = !track.hidden; this._commit(); }, track.hidden ? 'off' : '');
                head.append(eye);
            }
            const mute = this._button(track.muted ? '🔇' : '🔊', track.muted ? 'Unmute this track' : 'Mute this track', () => { track.muted = !track.muted; this._commit(); }, track.muted ? 'off' : '');
            head.append(mute);
            if (!track.clips.length && this.project.tracks.filter(t => t.kind === track.kind).length > 1) {
                head.append(this._button('✕', 'Remove this empty track', () => this._deleteTrack(track)));
            }
            const lane = this._el('div', 'vc-lane');
            lane.dataset.track = track.id;
            this.laneEls.set(track.id, lane);
            lane.addEventListener('pointerdown', e => { if (e.target === lane) { this._select(null); this._scrub(e); } });
            lane.addEventListener('dragover', e => this._dragOver(e, lane));
            lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
            lane.addEventListener('drop', e => this._drop(e, track, lane));
            for (const c of track.clips) lane.appendChild(this._clipEl(c));
            row.append(head, lane);
            this.tlInner.appendChild(row);
        }
        const add = this._el('div', 'vc-addtracks');
        add.append(this._button('+ Video track', 'Add a track for pictures and titles', () => { this._newTrack('visual'); this._commit(); }),
            this._button('+ Audio track', 'Add a track for sounds', () => { this._newTrack('audio'); this._commit(); }));
        if (this.readOnly) [...add.children].forEach(b => { b.disabled = true; });
        this.tlInner.appendChild(add);

        this.playheadEl = this._el('div', 'vc-playhead');
        this.tlInner.appendChild(this.playheadEl);
        this._placePlayhead();
        this._drawRuler();
    }

    _clipEl(c) {
        const kind = this._clipKind(c);
        const m = c.src ? this.store.map.get(c.src) : null;
        const el = this._el('div', `vc-clip ${kind}` + (m && m.error ? ' missing' : '') + (c.id === this.selected ? ' sel' : ''));
        el.style.left = (c.start * this.pps) + 'px';
        const w = Math.max(2, c.dur * this.pps);
        el.style.width = w + 'px';
        const label = c.type === 'text' ? 'T  ' + (c.text || '').split('\n')[0] : c.src.split('/').pop();
        el.title = `${label}\n${fmtShort(c.start)} – ${fmtShort(clipEnd(c))}` + (m && m.error ? `\n${m.error}` : '');
        if (m && !m.error) {
            const cv = this._el('canvas');
            const cw = Math.min(Math.ceil(w), 8192);
            cv.width = cw;
            cv.height = kind === 'audio' ? 34 : 46;
            cv.style.width = cw + 'px';
            this._paintClip(cv, c, m, kind);
            el.appendChild(cv);
        }
        for (const [side, len] of [['l', c.fadeIn], ['r', c.fadeOut]]) {
            if (!(len > 0)) continue;
            const f = this._el('div', 'vc-fade');
            f.style.width = (len * this.pps) + 'px';
            f.style[side === 'l' ? 'left' : 'right'] = 0;
            f.style.background = `linear-gradient(to ${side === 'l' ? 'right' : 'left'}, #000a, transparent)`;
            el.appendChild(f);
        }
        el.appendChild(this._el('div', 'vc-clabel', label + (c.volume === 0 && kind === 'video' ? '  🔇' : '')));
        const hl = this._el('div', 'vc-h l'), hr = this._el('div', 'vc-h r');
        el.append(hl, hr);
        el.addEventListener('pointerdown', e => this._clipPointer(e, c, e.target === hl ? 'l' : e.target === hr ? 'r' : 'move'));
        el.addEventListener('dblclick', e => this._seek(clamp(this._timeAt(e.clientX), c.start, clipEnd(c))));
        this.clipEls.set(c.id, el);
        return el;
    }

    // Film strip or waveform, for the source times the clip covers
    _paintClip(cv, c, m, kind) {
        const g = cv.getContext('2d');
        const W = cv.width, H = cv.height;
        if (kind === 'video' || kind === 'image') {
            const thumbs = m.thumbs;
            if (!thumbs.length) return;
            const t0 = thumbs[0].canvas;
            const tw = Math.max(8, H * ((t0.width || t0.naturalWidth) / (t0.height || t0.naturalHeight)));
            for (let x = 0; x < W; x += tw) {
                const st = c.in + (x + tw / 2) / this.pps;
                let best = thumbs[0];
                for (const th of thumbs) if (Math.abs(th.t - st) < Math.abs(best.t - st)) best = th;
                g.drawImage(best.canvas, x, 0, tw, H);
            }
        } else if (kind === 'audio' && m.peaks) {
            g.fillStyle = '#7ee2b8';
            const mid = H / 2;
            for (let x = 0; x < W; x++) {
                const a = Math.floor((c.in + x / this.pps) * 50), b = Math.max(a + 1, Math.floor((c.in + (x + 1) / this.pps) * 50));
                let p = 0;
                for (let k = a; k < b && k < m.peaks.length; k++) if (m.peaks[k] > p) p = m.peaks[k];
                const h = Math.max(1, p * (H - 4) * c.volume);
                g.fillRect(x, mid - h / 2, 1, h);
            }
        }
    }

    _drawRuler() {
        if (!this.rulerCanvas) return;
        const cv = this.rulerCanvas;
        const view = Math.max(1, this.tlScroll.clientWidth - HEAD);
        const dpr = window.devicePixelRatio || 1;
        const left = this.tlScroll.scrollLeft;
        cv.style.left = (HEAD + left) + 'px';
        cv.style.width = view + 'px';
        cv.width = Math.round(view * dpr);
        cv.height = Math.round(24 * dpr);
        const g = cv.getContext('2d');
        g.scale(dpr, dpr);
        g.fillStyle = '#262a31';
        g.fillRect(0, 0, view, 24);
        // A tick spacing of at least 70px, in steps a person would pick
        const steps = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
        const major = steps.find(s => s * this.pps >= 70) || 3600;
        const minor = major / 5;
        const t0 = left / this.pps, t1 = (left + view) / this.pps;
        g.strokeStyle = '#4b5360';
        g.fillStyle = '#9da7b3';
        g.font = '10px sans-serif';
        g.beginPath();
        for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
            const x = Math.round(t * this.pps - left) + 0.5;
            const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
            g.moveTo(x, isMajor ? 12 : 18);
            g.lineTo(x, 24);
            if (isMajor) g.fillText(major < 1 ? fmtTime(t, this.project.fps) : fmtShort(Math.round(t)), x + 3, 10);
        }
        g.stroke();
    }

    _placePlayhead() {
        if (!this.playheadEl) return;
        this.playheadEl.style.left = (this._x(this.time) - 1) + 'px';
        this.timeEl.textContent = `${fmtTime(this.time, this.project.fps)} / ${fmtTime(this._duration(), this.project.fps)}`;
    }

    _followPlayhead() {
        const x = this._x(this.time), s = this.tlScroll;
        if (x < s.scrollLeft + HEAD || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = Math.max(0, x - HEAD - 40);
    }

    _zoomBy(f, clientX) {
        const s = this.tlScroll;
        const anchorX = clientX !== undefined ? clientX - s.getBoundingClientRect().left : HEAD + (this._x(this.time) - s.scrollLeft - HEAD);
        const at = (s.scrollLeft + anchorX - HEAD) / this.pps;
        this.pps = clamp(this.pps * f, 1, 800);
        this._renderTimeline();
        s.scrollLeft = Math.max(0, at * this.pps + HEAD - anchorX);
        this._drawRuler();
    }

    _zoomFit() {
        const d = this._duration();
        const view = Math.max(100, this.tlScroll.clientWidth - HEAD - 30);
        this.pps = clamp(d > 0 ? view / d : 60, 1, 800);
        this._renderTimeline();
        this.tlScroll.scrollLeft = 0;
    }

    _timelineWheel(e) {
        if (!e.ctrlKey && !e.metaKey) {
            if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
            // A plain wheel over the lanes scrolls sideways, as timelines do
            if (this.tlScroll.scrollHeight <= this.tlScroll.clientHeight + 2) {
                e.preventDefault();
                this.tlScroll.scrollLeft += e.deltaY;
            }
            return;
        }
        e.preventDefault();
        this._zoomBy(Math.exp(-e.deltaY * 0.002), e.clientX);
    }

    _select(id) {
        if (this.selected === id) return;
        this.selected = id;
        if (this.clipEls) for (const [cid, el] of this.clipEls) el.classList.toggle('sel', cid === id);
        this._renderInspector();
        this._updateButtons();
    }

    // Moves the playhead with the pointer from a press on the ruler or a lane
    _scrub(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        this.root.focus({ preventScroll: true });
        const wasPlaying = this.playing;
        if (wasPlaying) this._pause();
        this._seek(this._timeAt(e.clientX));
        const move = ev => this._seek(this._timeAt(ev.clientX));
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (wasPlaying) this._play();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    // Times a dragged edge sticks to: the playhead, 0 and the other clips' edges
    _snapPoints(exceptId) {
        const pts = [0, this.time];
        for (const t of this.project.tracks) for (const c of t.clips) if (c.id !== exceptId) pts.push(c.start, clipEnd(c));
        return pts;
    }

    _snap(times, pts) {
        let best = null;
        for (const t of times) for (const p of pts) {
            const d = p - t;
            if (Math.abs(d) * this.pps <= SNAP_PX && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, p };
        }
        return best;
    }

    _showSnap(p) {
        if (!this.snapEl) { this.snapEl = this._el('div', 'vc-snapline'); }
        if (p === null || p === undefined) { this.snapEl.remove(); return; }
        this.snapEl.style.left = this._x(p) + 'px';
        if (!this.snapEl.parentNode) this.tlInner.appendChild(this.snapEl);
    }

    _clipPointer(e, clip, mode) {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        this.root.focus({ preventScroll: true });
        this._select(clip.id);
        if (this.readOnly) return;
        const found = this._find(clip.id);
        const el = this.clipEls.get(clip.id);
        const x0 = e.clientX;
        const orig = { start: clip.start, dur: clip.dur, in: clip.in, track: found.track };
        const m = clip.src ? this.store.map.get(clip.src) : null;
        const mediaDur = m && (m.kind === 'video' || m.kind === 'audio') && m.duration ? m.duration : Infinity;
        const minDur = 1 / this.project.fps;
        const pts = this._snapPoints(clip.id);
        const track = found.track;
        const neighbours = track.clips.filter(c => c.id !== clip.id);
        const prevEnd = Math.max(0, ...neighbours.filter(c => c.start < orig.start).map(clipEnd));
        const nextStart = Math.min(Infinity, ...neighbours.filter(c => c.start >= clipEnd(orig)).map(c => c.start));
        let moved = false, target = track;
        const onMove = ev => {
            const dt = (ev.clientX - x0) / this.pps;
            if (!moved && Math.abs(ev.clientX - x0) < 3) return;
            moved = true;
            let snapAt = null;
            if (mode === 'move') {
                let s = Math.max(0, orig.start + dt);
                const sn = this._snap([s, s + orig.dur], pts);
                if (sn) { s = Math.max(0, s + sn.d); snapAt = sn.p; }
                clip.start = s;
                // Onto the track under the pointer, when it takes this kind of clip
                const lane = document.elementFromPoint(ev.clientX, ev.clientY);
                const laneEl = lane && lane.closest && lane.closest('.vc-lane');
                const over = laneEl && this._track(laneEl.dataset.track);
                if (over && over.kind === orig.track.kind && over !== target) {
                    target = over;
                    laneEl.appendChild(el);
                }
                el.style.left = (clip.start * this.pps) + 'px';
            } else if (mode === 'l') {
                const lo = Math.max(prevEnd, mediaDur === Infinity ? 0 : orig.start - orig.in);
                let s = clamp(orig.start + dt, lo, clipEnd(orig) - minDur);
                const sn = this._snap([s], pts);
                if (sn && s + sn.d >= lo && s + sn.d <= clipEnd(orig) - minDur) { s += sn.d; snapAt = sn.p; }
                clip.start = s;
                clip.in = orig.in + (s - orig.start);
                clip.dur = clipEnd(orig) - s;
                el.style.left = (clip.start * this.pps) + 'px';
                el.style.width = (clip.dur * this.pps) + 'px';
            } else {
                const hi = Math.min(nextStart, orig.start + (mediaDur - orig.in));
                let end = clamp(clipEnd(orig) + dt, orig.start + minDur, hi);
                const sn = this._snap([end], pts);
                if (sn && end + sn.d <= hi && end + sn.d >= orig.start + minDur) { end += sn.d; snapAt = sn.p; }
                clip.dur = end - orig.start;
                el.style.width = (clip.dur * this.pps) + 'px';
            }
            this._showSnap(snapAt);
            this._draw();
            if (!this.playing) this._fetchStills();
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            this._showSnap(null);
            if (!moved) return;
            if (mode === 'move') {
                track.clips.splice(track.clips.indexOf(clip), 1);
                let dest = target;
                if (!this._free(dest, clip.start, clipEnd(clip))) {
                    // No room there: a new track next to it
                    dest = this._newTrack(dest.kind, this.project.tracks.indexOf(dest) + (dest.kind === 'visual' ? 0 : 1));
                }
                dest.clips.push(clip);
                this._sortClips(dest);
            }
            this._commit(mode === 'move' ? 'Moved' : 'Trimmed');
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }

    _dragOver(e, lane) {
        const types = e.dataTransfer.types;
        if (this.readOnly || !(types.includes('application/x-vcut-media') || types.includes('Files'))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        lane.classList.add('drop');
    }

    async _drop(e, track, lane) {
        lane.classList.remove('drop');
        if (this.readOnly) return;
        const src = e.dataTransfer.getData('application/x-vcut-media');
        const files = [...e.dataTransfer.files];
        if (!src && !files.length) return;
        e.preventDefault();
        let t = this._timeAt(e.clientX);
        const sn = this._snap([t], this._snapPoints(null));
        if (sn) t += sn.d;
        const sources = src ? [src] : await this._import(files) || [];
        for (const s of sources) {
            await this._placeMedia(s, t, track);
            const m = this.store.map.get(s);
            t += m && m.kind === 'image' ? IMAGE_DUR : (m && m.duration) || 0;
        }
    }

    // --- Inspector ---

    _renderInspector() {
        const p = this.insp;
        p.textContent = '';
        if (!this.project) return;
        const f = this.selected && this._find(this.selected);
        const ro = this.readOnly;
        const row = (label, ...controls) => {
            const r = this._el('div', 'vc-row');
            r.append(this._el('label', null, label));
            const box = this._el('div', 'vc-pair');
            box.append(...controls);
            r.append(box);
            p.append(r);
            return r;
        };
        // A slider with a number beside it, bound to obj[key]
        const slider = (obj, key, min, max, step, scale = 1) => {
            const range = this._el('input');
            range.type = 'range';
            Object.assign(range, { min, max, step, value: obj[key] * scale, disabled: ro });
            const num = this._el('input');
            num.type = 'number';
            Object.assign(num, { min, max, step, value: +(obj[key] * scale).toFixed(2), disabled: ro });
            const set = (v, commit) => {
                v = +v;
                if (!Number.isFinite(v)) return;
                obj[key] = v / scale;
                range.value = v;
                num.value = +v.toFixed(2);
                this._liveEdit(commit);
            };
            range.addEventListener('input', () => set(range.value, false));
            range.addEventListener('change', () => set(range.value, true));
            num.addEventListener('change', () => set(num.value, true));
            return [range, num];
        };
        const input = (obj, key, type, extra) => {
            const el = this._el('input');
            el.type = type;
            Object.assign(el, extra || {});
            if (type === 'checkbox') el.checked = !!obj[key]; else el.value = obj[key] ?? '';
            el.disabled = ro;
            el.addEventListener('input', () => { obj[key] = type === 'checkbox' ? el.checked : type === 'number' ? +el.value : el.value; this._liveEdit(false); });
            el.addEventListener('change', () => this._liveEdit(true));
            return el;
        };

        if (!f) {
            const pr = this.project;
            p.append(this._el('h4', null, 'Project'));
            const sel = this._el('select');
            sel.disabled = ro;
            const custom = `${pr.width}×${pr.height}`;
            if (!SIZES.some(s => s[1] === pr.width && s[2] === pr.height)) sel.append(new Option(custom, 'custom'));
            for (const [label, w, h] of SIZES) sel.append(new Option(label, `${w}x${h}`, false, w === pr.width && h === pr.height));
            sel.addEventListener('change', () => {
                const [w, h] = sel.value.split('x').map(Number);
                if (w && h) { pr.width = w; pr.height = h; this._layout(); this._commit('Frame size changed'); }
            });
            row('Size', sel);
            const fps = this._el('select');
            fps.disabled = ro;
            for (const v of [24, 25, 30, 50, 60]) fps.append(new Option(v + ' fps', v, false, v === pr.fps));
            if (![24, 25, 30, 50, 60].includes(pr.fps)) fps.append(new Option(pr.fps + ' fps', pr.fps, true, true));
            fps.addEventListener('change', () => { pr.fps = +fps.value; this._commit(); });
            row('Frame rate', fps);
            row('Background', input(pr, 'background', 'color'));
            const hint = this._el('div', 'vc-hint');
            hint.innerHTML = 'Drag media from the left onto a track. Drag clips to move them, their edges to trim.<br>'
                + '<b>Space</b> play · <b>S</b> split · <b>Del</b> delete · <b>←/→</b> frame · <b>Ctrl+wheel</b> zoom · <b>Ctrl+Z</b> undo';
            p.append(hint);
            return;
        }
        const c = f.clip;
        const kind = this._clipKind(c);
        const m = c.src ? this.store.map.get(c.src) : null;
        p.append(this._el('h4', null, c.type === 'text' ? 'Title' : c.src.split('/').pop()));
        if (m && m.error) p.append(this._el('div', 'vc-hint', m.error));
        else if (m && m.note) p.append(this._el('div', 'vc-hint', 'Note: ' + m.note));
        if (c.type === 'text') {
            const ta = this._el('textarea');
            ta.value = c.text;
            ta.disabled = ro;
            ta.addEventListener('input', () => { c.text = ta.value; this._liveEdit(false); });
            ta.addEventListener('change', () => this._liveEdit(true));
            p.append(ta);
            const font = this._el('select');
            font.disabled = ro;
            for (const fn of FONTS) font.append(new Option(fn, fn, false, fn === c.font));
            font.addEventListener('change', () => { c.font = font.value; this._liveEdit(true); });
            row('Font', font, input(c, 'bold', 'checkbox', { title: 'Bold' }));
            row('Size', ...slider(c, 'size', 8, 400, 1));
            row('Colour', input(c, 'color', 'color'));
            const bgOn = this._el('input');
            bgOn.type = 'checkbox';
            bgOn.checked = !!c.bg;
            bgOn.disabled = ro;
            bgOn.title = 'A box behind the text';
            const bg = this._el('input');
            bg.type = 'color';
            bg.value = /^#[0-9a-f]{6}$/i.test(c.bg) ? c.bg : '#000000';
            bg.disabled = ro || !c.bg;
            bgOn.addEventListener('change', () => { c.bg = bgOn.checked ? bg.value : ''; bg.disabled = !bgOn.checked; this._liveEdit(true); });
            bg.addEventListener('input', () => { c.bg = bg.value; this._liveEdit(false); });
            bg.addEventListener('change', () => this._liveEdit(true));
            row('Box', bgOn, bg);
            row('Outline', ...slider(c, 'stroke', 0, 20, 0.5), input(c, 'strokeColor', 'color'));
        }
        if (kind !== 'audio') {
            row('X', ...slider(c, 'x', -50, 150, 0.5, 100));
            row('Y', ...slider(c, 'y', -50, 150, 0.5, 100));
            row('Scale', ...slider(c, 'scale', 5, 400, 1, 100));
            row('Rotation', ...slider(c, 'rotation', -180, 180, 1));
            row('Opacity', ...slider(c, 'opacity', 0, 100, 1, 100));
        }
        if (kind === 'video' || kind === 'audio') {
            if (m && m.audio !== undefined || kind === 'audio') row('Volume', ...slider(c, 'volume', 0, 200, 1, 100));
        }
        row('Fade in', ...slider(c, 'fadeIn', 0, Math.min(10, c.dur), 0.05));
        row('Fade out', ...slider(c, 'fadeOut', 0, Math.min(10, c.dur), 0.05));
        const info = this._el('div', 'vc-hint', `Starts ${fmtTime(c.start, this.project.fps)} · lasts ${fmtTime(c.dur, this.project.fps)}`
            + (c.src && m && m.duration ? ` · from ${fmtTime(c.in, this.project.fps)} of ${fmtTime(m.duration, this.project.fps)}` : ''));
        p.append(info);
        const actions = this._el('div', 'vc-actions');
        if (!ro) {
            actions.append(this._button('Split', 'Split at the playhead (S)', () => this._split()),
                this._button('Delete', 'Delete this clip', () => this._deleteSelected()));
            if (kind === 'video' && m && m.audio && c.volume > 0) actions.append(this._button('Detach audio', 'Move its sound to an audio track', () => this._detachAudio()));
            if (kind !== 'audio') actions.append(this._button('Reset position', 'Centre it at full size', () => {
                Object.assign(c, { x: 0.5, y: c.type === 'text' ? 0.8 : 0.5, scale: 1, rotation: 0 });
                this._commit();
            }));
        }
        p.append(actions);
    }

    // An inspector change: shown at once, kept in the history when finished
    _liveEdit(commit) {
        this._draw();
        const f = this.selected && this._find(this.selected);
        if (f && this.clipEls) {
            const old = this.clipEls.get(f.clip.id);
            if (old) {
                const el = this._clipEl(f.clip);
                old.replaceWith(el);
            }
        }
        if (commit) {
            const snap = JSON.stringify(this.project);
            if (snap !== this.history[this.hIndex]) {
                this.history = this.history.slice(0, this.hIndex + 1);
                this.history.push(snap);
                this.hIndex = this.history.length - 1;
                this._scheduleSave();
                this._updateButtons();
                this._restartIfPlaying();
            }
        }
    }

    // --- Preview ---

    _layout() {
        if (!this.project) return;
        this.root.classList.toggle('vc-narrow', this.root.clientWidth < 720);
        const sw = this.stage.clientWidth - 16, sh = this.stage.clientHeight - 16;
        if (sw <= 0 || sh <= 0) return;
        const { width: W, height: H } = this.project;
        const k = Math.min(sw / W, sh / H);
        const cw = Math.max(1, Math.floor(W * k)), ch = Math.max(1, Math.floor(H * k));
        const dpr = window.devicePixelRatio || 1;
        this.canvas.style.width = cw + 'px';
        this.canvas.style.height = ch + 'px';
        this.canvas.width = Math.min(W, Math.round(cw * dpr));
        this.canvas.height = Math.min(H, Math.round(ch * dpr));
        this._draw();
        this._drawRuler();
    }

    // Draws the frame at timeline time t into g; frameOf(clip) gives a video clip's picture
    _compose(g, W, H, t, frameOf) {
        const pr = this.project;
        g.save();
        g.fillStyle = pr.background || '#000';
        g.fillRect(0, 0, W, H);
        const k = W / pr.width;
        const visual = pr.tracks.filter(tr => tr.kind === 'visual' && !tr.hidden);
        for (let i = visual.length - 1; i >= 0; i--) {
            const c = this._clipAt(visual[i], t);
            if (!c) continue;
            const alpha = clamp(c.opacity, 0, 1) * fadeFactor(c, t);
            if (alpha <= 0) continue;
            g.save();
            g.globalAlpha = alpha;
            g.translate(c.x * W, c.y * H);
            if (c.rotation) g.rotate(c.rotation * Math.PI / 180);
            if (c.type === 'text') {
                g.scale(c.scale, c.scale);
                drawText(g, c, k);
            } else {
                const m = this.store.map.get(c.src);
                const pic = m && !m.error ? (m.kind === 'image' ? m.image : frameOf(c)) : null;
                if (pic && m.width && m.height) {
                    const base = Math.min(W / m.width, H / m.height) * c.scale;
                    const dw = m.width * base, dh = m.height * base;
                    g.drawImage(pic, -dw / 2, -dh / 2, dw, dh);
                }
            }
            g.restore();
        }
        g.restore();
    }

    _draw() {
        if (!this.project || !this.canvas.width) return;
        this._compose(this.g, this.canvas.width, this.canvas.height, this.time, c => {
            const s = this.streams.get(c.id);
            if (s && s.cur) return s.cur.canvas;
            const st = this.stills.get(c.id);
            return st && st.canvas;
        });
        // The selected clip's outline
        const f = this.selected && this._find(this.selected);
        if (f && !this.playing) {
            const b = this._bounds(f.clip, this.canvas.width, this.canvas.height);
            if (b && f.clip.start <= this.time && this.time < clipEnd(f.clip)) {
                const g = this.g;
                g.save();
                g.translate(b.cx, b.cy);
                if (f.clip.rotation) g.rotate(f.clip.rotation * Math.PI / 180);
                g.strokeStyle = '#58a6ff';
                g.lineWidth = Math.max(1, this.canvas.width / 600);
                g.setLineDash([6, 4]);
                g.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
                g.restore();
            }
        }
    }

    // Where a visual clip sits in a W×H frame (before rotation)
    _bounds(c, W, H) {
        if (c.type === 'text') {
            const s = drawText(this.g, c, W / this.project.width, true);
            return { cx: c.x * W, cy: c.y * H, w: s.w * c.scale, h: s.h * c.scale };
        }
        const m = this.store.map.get(c.src);
        if (!m || !m.width || m.kind === 'audio') return null;
        const base = Math.min(W / m.width, H / m.height) * c.scale;
        return { cx: c.x * W, cy: c.y * H, w: m.width * base, h: m.height * base };
    }

    // Dragging a picture or title in the preview moves it; the wheel over it scales it
    _stageEvents() {
        const hit = e => {
            if (!this.project) return null;
            const r = this.canvas.getBoundingClientRect();
            const px = (e.clientX - r.left) * this.canvas.width / r.width, py = (e.clientY - r.top) * this.canvas.height / r.height;
            const visual = this.project.tracks.filter(t => t.kind === 'visual' && !t.hidden);
            const order = this.selected ? [...visual].sort((a, b) => (b.clips.some(c => c.id === this.selected) ? 1 : 0) - (a.clips.some(c => c.id === this.selected) ? 1 : 0)) : visual;
            for (const tr of order) {
                const c = this._clipAt(tr, this.time);
                if (!c) continue;
                const b = this._bounds(c, this.canvas.width, this.canvas.height);
                if (!b) continue;
                const a = -(c.rotation || 0) * Math.PI / 180;
                const dx = px - b.cx, dy = py - b.cy;
                const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
                if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return { c, r };
            }
            return null;
        };
        this.canvas.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            this.root.focus({ preventScroll: true });
            const h = hit(e);
            this._select(h ? h.c.id : null);
            this._draw();
            if (!h || this.readOnly) return;
            e.preventDefault();
            const c = h.c, x0 = e.clientX, y0 = e.clientY, ox = c.x, oy = c.y;
            let moved = false;
            const move = ev => {
                moved = true;
                let nx = ox + (ev.clientX - x0) / h.r.width, ny = oy + (ev.clientY - y0) / h.r.height;
                // The centre lines hold it
                if (Math.abs(nx - 0.5) * h.r.width < 6) nx = 0.5;
                if (Math.abs(ny - 0.5) * h.r.height < 6) ny = 0.5;
                c.x = nx;
                c.y = ny;
                this._draw();
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                if (moved) { this._commit(); }
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });
        this.canvas.addEventListener('wheel', e => {
            const f = this.selected && this._find(this.selected);
            if (!f || this.readOnly || f.clip.start > this.time || this.time >= clipEnd(f.clip) || this._clipKind(f.clip) === 'audio') return;
            e.preventDefault();
            f.clip.scale = clamp(f.clip.scale * Math.exp(-e.deltaY * 0.0015), 0.05, 10);
            this._draw();
            clearTimeout(this.wheelTimer);
            this.wheelTimer = setTimeout(() => this._commit(), 400);
        }, { passive: false });
    }

    // Paused: fetch the frame under the playhead of every video clip showing
    _fetchStills() {
        if (!this.project || this.playing) return;
        const t = this.time;
        for (const tr of this.project.tracks) {
            if (tr.kind !== 'visual' || tr.hidden) continue;
            const c = this._clipAt(tr, t);
            if (!c || c.type === 'text') continue;
            const m = this.store.map.get(c.src);
            if (!m || !m.sink) continue;
            const src = Math.max(m.first, c.in + (t - c.start));
            let s = this.stills.get(c.id);
            if (!s) { s = { canvas: null, have: null, want: null, busy: false }; this.stills.set(c.id, s); }
            s.want = src;
            if (s.busy || s.have === src) continue;
            s.busy = true;
            (async () => {
                while (s.want !== s.have && !this.destroyed) {
                    const want = s.want;
                    const w = await m.sink.getCanvas(want).catch(err => { log.warn('Frame:', err); return null; });
                    s.have = want;
                    if (w) s.canvas = w.canvas;
                    if (!this.playing) this._draw();
                }
                s.busy = false;
            })();
        }
    }

    _seek(t) {
        this.time = clamp(t, 0, Math.max(this._duration(), 0));
        if (this.playing) {
            this._pause();
            this._play();
        }
        this._placePlayhead();
        this._draw();
        this._fetchStills();
    }

    _step(n) {
        const fps = this.project ? this.project.fps : 30;
        this._seek(Math.round(this.time * fps + n) / fps);
        this._followPlayhead();
    }

    _togglePlay() {
        if (this.playing) this._pause();
        else this._play();
    }

    _audioContext() {
        if (!this.ac) {
            this.ac = new AudioContext({ latencyHint: 'playback' });
            this.master = this.ac.createGain();
            this.master.connect(this.ac.destination);
        }
        if (this.ac.state === 'suspended') this.ac.resume();
        return this.ac;
    }

    _play() {
        if (!this.project || this.playing) return;
        const dur = this._duration();
        if (dur <= 0) return;
        if (this.time >= dur - 1e-3) this.time = 0;
        const ac = this._audioContext();
        this.playing = true;
        const token = ++this.playToken;
        this.clock = { base: ac.currentTime + 0.15, t0: this.time };
        this.playBtn.textContent = '⏸';
        for (const tr of this.project.tracks) {
            if (tr.muted) continue;
            for (const c of tr.clips) {
                if (c.type === 'text' || !(c.volume > 0) || clipEnd(c) <= this.time) continue;
                const m = this.store.map.get(c.src);
                if (m && m.audioSink) this._playClipAudio(c, m, token);
            }
        }
        const tick = () => {
            if (token !== this.playToken) return;
            const t = this.clock.t0 + Math.max(0, this.ac.currentTime - this.clock.base);
            if (t >= this._duration()) {
                this.time = this._duration();
                this._pause();
                this._placePlayhead();
                return;
            }
            this.time = t;
            this._advanceStreams(t);
            this._draw();
            this._placePlayhead();
            this._followPlayhead();
            this.raf = requestAnimationFrame(tick);
        };
        this._advanceStreams(this.time);
        this.raf = requestAnimationFrame(tick);
    }

    // Opens the frame streams of video clips about to show, advances the showing
    // ones, closes the finished ones
    _advanceStreams(t) {
        const live = new Set();
        for (const tr of this.project.tracks) {
            if (tr.kind !== 'visual' || tr.hidden) continue;
            for (const c of tr.clips) {
                if (c.type === 'text' || clipEnd(c) <= t || c.start > t + 0.5) continue;
                const m = this.store.map.get(c.src);
                if (!m || !m.sink) continue;
                live.add(c.id);
                const src = Math.max(m.first, c.in + Math.max(0, t - c.start));
                let s = this.streams.get(c.id);
                if (!s) {
                    s = new FrameStream(m.sink, src);
                    this.streams.set(c.id, s);
                }
                s.advance(src);
            }
        }
        for (const [id, s] of this.streams) if (!live.has(id)) { s.close(); this.streams.delete(id); }
    }

    async _playClipAudio(c, m, token) {
        const ac = this.ac;
        const { base, t0 } = this.clock;
        const ctxTime = tl => base + (tl - t0);
        const from = Math.max(t0, c.start), to = clipEnd(c);
        const gain = ac.createGain();
        gain.connect(this.master);
        this.audioNodes.push(gain);
        scheduleGain(gain.gain, c, c.volume, from, to, ctxTime);
        try {
            for await (const { buffer, timestamp } of m.audioSink.buffers(c.in + (from - c.start), c.in + c.dur)) {
                if (token !== this.playToken) break;
                const tl = c.start + (timestamp - c.in);
                const startTl = Math.max(tl, from);
                const offset = startTl - tl;
                const len = Math.min(buffer.duration - offset, to - startTl);
                if (len <= 0) continue;
                const node = ac.createBufferSource();
                node.buffer = buffer;
                node.connect(gain);
                node.start(Math.max(ac.currentTime, ctxTime(startTl)), offset, len);
                this.audioNodes.push(node);
                // Keep only a little scheduled ahead
                while (token === this.playToken && ctxTime(startTl) - ac.currentTime > AUDIO_AHEAD) await new Promise(r => setTimeout(r, 100));
            }
        } catch (err) {
            log.warn('Sound stopped:', err);
        }
    }

    _pause() {
        if (!this.playing) return;
        if (this.ac && this.clock) this.time = Math.min(this._duration(), this.clock.t0 + Math.max(0, this.ac.currentTime - this.clock.base));
        this.playing = false;
        this.playToken++;
        cancelAnimationFrame(this.raf);
        for (const n of this.audioNodes) {
            try { if (n.stop) n.stop(); n.disconnect(); } catch (_) { /* already stopped */ }
        }
        this.audioNodes = [];
        // The frames showing stay until the paused ones arrive
        for (const [id, s] of this.streams) {
            if (s.cur) this.stills.set(id, { canvas: s.cur.canvas, have: null, want: null, busy: false });
            s.close();
        }
        this.streams.clear();
        this.playBtn.textContent = '▶';
        this._placePlayhead();
        this._draw();
        this._fetchStills();
    }

    _restartIfPlaying() {
        if (!this.playing) return;
        this._pause();
        this._play();
    }

    // --- Export ---

    _toggleExport() {
        if (this.dialog) {
            if (!this.exporting) { this.dialog.remove(); this.dialog = null; }
            return;
        }
        const d = this._el('div', 'vc-dialog');
        d.addEventListener('pointerdown', e => e.stopPropagation());
        d.append(this._el('h4', null, 'Export'));
        const fmt = this._el('select');
        fmt.append(new Option('MP4 (H.264 / AAC)', 'mp4'), new Option('WebM (VP9 / Opus)', 'webm'));
        const res = this._el('select');
        const pr = this.project;
        for (const k of [1, 0.5, 0.25]) res.append(new Option(`${Math.round(pr.width * k / 2) * 2}×${Math.round(pr.height * k / 2) * 2}`, k));
        const q = this._el('select');
        q.append(new Option('High', 'high'), new Option('Medium', 'medium', true, true), new Option('Low', 'low'), new Option('Very high', 'veryhigh'));
        const add = (label, el) => { const r = this._el('div', 'vc-row'); r.append(this._el('label', null, label), el); d.append(r); };
        add('Format', fmt);
        add('Size', res);
        add('Quality', q);
        const bar = this._el('div', 'vc-progress');
        bar.append(this._el('div'));
        bar.hidden = true;
        const note = this._el('div', 'vc-hint', `${fmtTime(this._duration(), pr.fps)} at ${pr.fps} fps, written beside the project.`);
        const go = this._button('Export', 'Render the video', () => {
            if (this.exporting) { this.exporting.cancel = true; go.textContent = 'Stopping…'; return; }
            go.textContent = 'Cancel';
            bar.hidden = false;
            this._export({ format: fmt.value, scale: +res.value, quality: q.value }, (frac, text) => {
                bar.firstChild.style.width = (frac * 100).toFixed(1) + '%';
                note.textContent = text;
            }).finally(() => { go.textContent = 'Export'; });
        }, 'vc-primary');
        const close = this._button('Close', 'Close this', () => { if (!this.exporting) { d.remove(); this.dialog = null; } });
        const acts = this._el('div', 'vc-actions');
        acts.append(go, close);
        d.append(bar, note, acts);
        this.root.querySelector('.vc-shell').appendChild(d);
        this.root.querySelector('.vc-shell').style.position = 'relative';
        this.dialog = d;
    }

    async _export(opts, progress) {
        const dur = this._duration();
        if (dur <= 0) { progress(0, 'The timeline is empty.'); return; }
        this._pause();
        const job = { cancel: false };
        this.exporting = job;
        const pr = JSON.parse(JSON.stringify(this.project));
        const started = performance.now();
        let output = null;
        const streams = new Map();
        try {
            const mb = await mediabunny();
            const W = Math.max(2, Math.round(pr.width * opts.scale / 2) * 2), H = Math.max(2, Math.round(pr.height * opts.scale / 2) * 2);
            const format = opts.format === 'webm' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
            const quality = { low: mb.QUALITY_LOW, medium: mb.QUALITY_MEDIUM, high: mb.QUALITY_HIGH, veryhigh: mb.QUALITY_VERY_HIGH }[opts.quality] || mb.QUALITY_MEDIUM;
            const prefer = opts.format === 'webm' ? ['vp9', 'vp8', 'av1'] : ['avc', 'hevc', 'av1', 'vp9'];
            const vcodecs = prefer.filter(c => format.getSupportedVideoCodecs().includes(c));
            const vcodec = await mb.getFirstEncodableVideoCodec(vcodecs, { width: W, height: H });
            if (!vcodec) throw new Error(`this browser cannot encode ${opts.format.toUpperCase()} video at ${W}×${H}`);
            const audible = [];
            for (const tr of pr.tracks) {
                if (tr.muted) continue;
                for (const c of tr.clips) {
                    if (c.type === 'text' || !(c.volume > 0)) continue;
                    const m = this.store.map.get(c.src);
                    if (m && m.audioSink) audible.push({ c, m });
                }
            }
            const SR = 48000;
            let acodec = null;
            if (audible.length) {
                const aprefer = opts.format === 'webm' ? ['opus', 'vorbis'] : ['aac', 'opus', 'mp3'];
                acodec = await mb.getFirstEncodableAudioCodec(aprefer.filter(c => format.getSupportedAudioCodecs().includes(c)), { numberOfChannels: 2, sampleRate: SR });
                if (!acodec) log.warn('No audio encoder: exporting without sound');
            }
            const target = new mb.BufferTarget();
            output = new mb.Output({ format, target });
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const g = canvas.getContext('2d');
            const vsrc = new mb.CanvasSource(canvas, { codec: vcodec, quality });
            output.addVideoTrack(vsrc, { frameRate: pr.fps });
            const asrc = acodec ? new mb.AudioBufferSource({ codec: acodec, quality }) : null;
            if (asrc) output.addAudioTrack(asrc);
            await output.start();

            // Export-sized decoders, one per video file
            const sinks = new Map();
            const sinkFor = m => {
                if (!sinks.has(m.src)) {
                    const k = Math.min(1, Math.max(W / m.width, H / m.height) * 2);
                    sinks.set(m.src, new mb.CanvasSink(m.video, { width: Math.max(2, Math.round(m.width * k)), height: Math.max(2, Math.round(m.height * k)), fit: 'fill' }));
                }
                return sinks.get(m.src);
            };
            const saved = this.project;
            const frames = Math.max(1, Math.round(dur * pr.fps));
            const CHUNK = 5;
            let mixedTo = 0;
            for (let i = 0; i < frames; i++) {
                if (job.cancel) throw new Error('canceled');
                const t = i / pr.fps;
                // Sound goes in 5-second pieces, ahead of the pictures
                while (asrc && mixedTo < Math.min(dur, t + CHUNK)) {
                    const a = mixedTo, b = Math.min(dur, a + CHUNK);
                    await asrc.add(await this._mix(audible, a, b, SR));
                    mixedTo = b;
                }
                const pics = new Map();
                for (const tr of pr.tracks) {
                    if (tr.kind !== 'visual' || tr.hidden) continue;
                    const c = this._clipAt(tr, t);
                    if (!c || c.type === 'text') continue;
                    const m = this.store.map.get(c.src);
                    if (!m || !m.video) continue;
                    const src = Math.max(m.first, c.in + (t - c.start));
                    let s = streams.get(c.id);
                    if (!s) { s = new ExportStream(sinkFor(m), src); streams.set(c.id, s); }
                    pics.set(c.id, await s.frameAt(src));
                }
                for (const [id, s] of streams) if (!pics.has(id)) { s.close(); streams.delete(id); }
                this.project = pr;
                try { this._compose(g, W, H, t, c => pics.get(c.id)); } finally { this.project = saved; }
                await vsrc.add(t, 1 / pr.fps);
                if (i % 10 === 0) {
                    const el = (performance.now() - started) / 1000;
                    const left = el / (i + 1) * (frames - i - 1);
                    progress((i + 1) / frames, `Frame ${i + 1} of ${frames} · ${Math.round(left)}s left`);
                }
            }
            progress(1, 'Finishing…');
            await output.finalize();
            const stem = (this.path ? this.path.split('/').pop().replace(/\.vcut$/i, '') : 'export');
            const blob = new Blob([target.buffer], { type: format.mimeType });
            const name = await this._uploadUnique(this.dir, stem, format.fileExtension, blob);
            if (!name) throw new Error('could not write the file');
            const secs = ((performance.now() - started) / 1000).toFixed(1);
            progress(1, `Wrote ${name} (${(blob.size / 1048576).toFixed(1)} MB, ${vcodec}${acodec ? '/' + acodec : ''}) in ${secs}s`);
            this._status(`Exported ${name}`);
        } catch (err) {
            if (output && output.state !== 'finalized') await output.cancel().catch(() => {});
            const msg = err.message === 'canceled' ? 'Export canceled.' : 'Export failed: ' + err.message;
            if (err.message !== 'canceled') log.error('Export failed:', err);
            progress(0, msg);
        } finally {
            for (const s of streams.values()) s.close();
            this.exporting = null;
        }
    }

    // The mixed sound of [a, b) of the timeline
    async _mix(audible, a, b, sr) {
        const oc = new OfflineAudioContext(2, Math.max(1, Math.round((b - a) * sr)), sr);
        for (const { c, m } of audible) {
            const from = Math.max(a, c.start), to = Math.min(b, clipEnd(c));
            if (to <= from) continue;
            const gain = oc.createGain();
            gain.connect(oc.destination);
            scheduleGain(gain.gain, c, c.volume, from, to, tl => tl - a);
            for await (const { buffer, timestamp } of m.audioSink.buffers(c.in + (from - c.start), c.in + (to - c.start))) {
                const tl = c.start + (timestamp - c.in);
                const startTl = Math.max(tl, from);
                const offset = startTl - tl;
                const len = Math.min(buffer.duration - offset, to - startTl);
                if (len <= 0) continue;
                const node = oc.createBufferSource();
                node.buffer = buffer;
                node.connect(gain);
                node.start(startTl - a, offset, len);
            }
        }
        return oc.startRendering();
    }

    // --- Keys ---

    _key(e) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key;
        let handled = true;
        if (k === ' ') this._togglePlay();
        else if (mod && k.toLowerCase() === 'z' && !e.shiftKey) this._undo();
        else if (mod && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) this._redo();
        else if (mod && k.toLowerCase() === 's') this._save();
        else if (!mod && (k === 's' || k === 'S')) this._split();
        else if (k === 'Delete' || k === 'Backspace') this._deleteSelected();
        else if (k === 'ArrowLeft') this._step(e.shiftKey ? -this.project.fps : -1);
        else if (k === 'ArrowRight') this._step(e.shiftKey ? this.project.fps : 1);
        else if (k === 'Home') this._seek(0);
        else if (k === 'End') this._seek(this._duration());
        else if (k === '+' || k === '=') this._zoomBy(1.5);
        else if (k === '-') this._zoomBy(1 / 1.5);
        else if (k === 'Escape') { this._select(null); this._draw(); }
        else handled = false;
        if (handled) e.preventDefault();
    }

    _status(text, isError) {
        this.statusEl.textContent = text || '';
        this.statusEl.title = text || '';
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(msg) {
        this.message.hidden = false;
        this.message.textContent = msg;
        this.message.classList.add('error');
    }

    _destroy() {
        this.destroyed = true;
        if (this.dirty) this._save();
        this._pause();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.exporting) this.exporting.cancel = true;
        if (this.ac) this.ac.close().catch(() => {});
        this.store.dispose();
    }
}

registerPlugin({
    id: 'videocut',
    name: 'Video editor',
    components: {
        videoCut: VideoCutComponent,
    },
    toolbarButtons: [
        { label: 'Cut', title: 'Edit videos on a timeline', menuLabel: 'Video editor (timeline, .vcut)' },
    ],
    newFileTypes: [{ label: 'Video project', ext: 'vcut', content: () => JSON.stringify(newProject(), null, 2) + '\n' }],
    init(ctx) {
        VideoCutComponent._ctx = ctx;
    },
});

module.exports = { normalizeProject, fadeFactor };
