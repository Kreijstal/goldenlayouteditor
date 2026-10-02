// Music score viewer: MuseScore, MusicXML, Guitar Pro, MIDI and the other formats
// MuseScore imports, engraved by webmscore (MuseScore 4.6 compiled to WebAssembly,
// @kreijstal/webmscore-wasm on jsDelivr, built from source by ~/git/webmscore-wasm/build.sh).
// Pages as SVG side by side or stacked, with zoom; playback through the
// FluidR3Mono soundfont with the current measure highlighted and followed;
// parts, metadata, and export to PDF/MusicXML/MIDI/MSCZ. Read-only.
// Playback and measure positions follow musescore-web-display
// (github.com/partitioncloud/musescore-web-display, MIT).
const WEBMSCORE_URL = 'https://cdn.jsdelivr.net/npm/@kreijstal/webmscore-wasm@4.6.5-build.1/webmscore.mjs';
const SOUNDFONT_URL = 'https://cdn.jsdelivr.net/npm/@kreijstal/webmscore-wasm@4.6.5-build.1/FluidR3Mono_GM.sf3';
const SAMPLE_RATE = 44100;
const FRAMES = 512;          // frames per synthesized chunk, per channel
const BATCH = 48;            // chunks per synth call (~0.56 s)
const LOOKAHEAD = 2.5;       // seconds of audio kept scheduled ahead

// Formats webmscore reads (the importers it registers), by extension
export const SCORE_FORMATS = ['mscz', 'mscx', 'mscs', 'musicxml', 'mxl', 'xml', 'gp', 'gp3', 'gp4', 'gp5', 'gpx', 'gtp', 'ptb', 'mid', 'midi', 'kar'];

const EXPORTS = [
    { label: 'PDF', ext: 'pdf', type: 'application/pdf', make: s => s.savePdf() },
    { label: 'MusicXML', ext: 'musicxml', type: 'application/vnd.recordare.musicxml+xml', make: s => s.saveXml() },
    { label: 'MusicXML (compressed .mxl)', ext: 'mxl', type: 'application/vnd.recordare.musicxml', make: s => s.saveMxl() },
    { label: 'MIDI', ext: 'mid', type: 'audio/midi', make: s => s.saveMidi(true, true) },
    { label: 'MuseScore (.mscz)', ext: 'mscz', type: 'application/x-musescore', make: s => s.saveMsc('mscz') },
];

let _webmscore = null;
function loadWebMscore() {
    if (!_webmscore) {
        _webmscore = import(WEBMSCORE_URL).then(m => m.default).catch(err => {
            _webmscore = null;
            throw new Error(`webmscore is not available at ${WEBMSCORE_URL} (${err.message})`);
        });
    }
    return _webmscore;
}

let _soundfont = null;
function loadSoundfont() {
    if (!_soundfont) {
        _soundfont = fetch(SOUNDFONT_URL).then(r => {
            if (!r.ok) throw new Error(`soundfont: HTTP ${r.status}`);
            return r.arrayBuffer();
        }).catch(err => { _soundfont = null; throw err; });
    }
    return _soundfont;
}

const CSS = `
.scv{position:absolute;inset:0;display:flex;flex-direction:column;background:#e8e8e8;color:#222;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.scv-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 8px;background:#f6f8fa;border-bottom:1px solid #d0d7de;flex-shrink:0}
.scv-bar button,.scv-bar select{font:inherit;padding:3px 9px;border:1px solid #c4ccd4;border-radius:4px;background:#fff;color:#222;cursor:pointer}
.scv-bar button:hover:not(:disabled){background:#eef2f6}
.scv-bar button:disabled,.scv-bar select:disabled{opacity:.5;cursor:default}
.scv-bar button[aria-pressed=true]{background:#dbe9ff;border-color:#7aa7e6}
.scv-play{min-width:5.5em}
.scv-time{font-variant-numeric:tabular-nums;color:#555;min-width:7.5em}
.scv-seek{flex:1 1 120px;min-width:80px;max-width:320px}
.scv-zoom{min-width:3.5em;text-align:center;color:#555}
.scv-sep{width:1px;align-self:stretch;background:#d0d7de;margin:0 2px}
.scv-main{flex:1;min-height:0;display:flex}
.scv-pages{flex:1;min-width:0;overflow:auto;display:flex;gap:16px;padding:16px;box-sizing:border-box}
.scv-pages.h{flex-direction:row;align-items:flex-start}
.scv-pages.v{flex-direction:column;align-items:center}
.scv-page{position:relative;flex-shrink:0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)}
.scv-page img{display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none}
.scv-page .scv-cursor{position:absolute;background:rgba(80,140,255,.22);border:1px solid rgba(60,110,230,.55);pointer-events:none;display:none;mix-blend-mode:multiply}
.scv-page .scv-num{position:absolute;bottom:-1.5em;left:0;right:0;text-align:center;color:#777;font-size:11px}
.scv-info{width:280px;flex-shrink:0;overflow:auto;border-left:1px solid #d0d7de;background:#fff;padding:10px 12px;box-sizing:border-box}
.scv-info h3{margin:.2em 0 .1em;font-size:16px}
.scv-info h4{margin:1em 0 .3em;font-size:12px;text-transform:uppercase;color:#666;letter-spacing:.04em}
.scv-info table{border-collapse:collapse;width:100%}
.scv-info td{padding:2px 4px;vertical-align:top;border-bottom:1px solid #eee}
.scv-info td:first-child{color:#666;white-space:nowrap}
.scv-info .sub{color:#555;margin-bottom:.3em}
.scv-msg{margin:auto;padding:24px;color:#555;max-width:40em;text-align:center;white-space:pre-wrap}
.scv-msg.err{color:#a33}
@media (max-width:640px){.scv-info{position:absolute;right:0;top:0;bottom:0;width:min(85%,300px);box-shadow:-2px 0 8px rgba(0,0,0,.2)}.scv-main{position:relative}.scv-seek{order:9;max-width:none;flex-basis:100%}}
`;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function fmtTime(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

const KEYS = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINOR = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];

// MuseScore text with its markup (<sym>, <font>...) as plain text
function plainText(s) {
    return String(s || '').replace(/<sym>metNote(Quarter|Half|8th|Whole)Up<\/sym>/g, (m, d) => ({ Quarter: '♩', Half: '𝅗𝅥', '8th': '♪', Whole: '𝅝' })[d])
        .replace(/<sym>[^<]*<\/sym>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// Title and composer; a file without a title gets webmscore's temporary file name ("XXXXXX.ext")
export function scoreTitle(meta) {
    const frames = meta.textFramesData || {};
    let title = meta.title || '';
    if (/^[A-Za-z0-9]{6}\.[a-z0-9]+$/.test(title)) title = '';
    title = title || (frames.titles || [])[0] || '';
    return { title: plainText(title).replace(/\s*\n\s*/g, ' · '), composer: plainText(meta.composer || (frames.composers || [])[0] || '').replace(/\s*\n\s*/g, ', ') };
}

// The webmscore format name for a file: its extension
export function scoreFormat(name) {
    return ((name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
}

/**
 * Mount the viewer in `host` for the score `bytes` named `name`.
 * Returns { ready: Promise<metadata>, destroy() }.
 */
export function mountScoreViewer(host, { bytes, name, onStatus }) {
    const style = el('style');
    style.textContent = CSS;
    const root = el('div', 'scv');
    root.appendChild(style);
    host.appendChild(root);

    const bar = el('div', 'scv-bar');
    const playBtn = el('button', 'scv-play', '▶ Play');
    const stopBtn = el('button', null, '■');
    stopBtn.title = 'Stop and go back to the start';
    const timeEl = el('span', 'scv-time', '0:00 / 0:00');
    const seek = el('input', 'scv-seek');
    seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0; seek.title = 'Position';
    const followBtn = el('button', null, 'Follow');
    followBtn.title = 'Scroll to the measure being played';
    followBtn.setAttribute('aria-pressed', 'true');
    const zoomOut = el('button', null, '−'); zoomOut.title = 'Zoom out';
    const zoomLabel = el('span', 'scv-zoom', '100%');
    const zoomIn = el('button', null, '+'); zoomIn.title = 'Zoom in';
    const zoomFit = el('button', null, 'Fit'); zoomFit.title = 'Fit the page to the view';
    const layoutBtn = el('button', null, '⇅ Vertical'); layoutBtn.title = 'Lay the pages out side by side or one below the other';
    const partSel = el('select'); partSel.title = 'Part';
    const infoBtn = el('button', null, 'Info'); infoBtn.setAttribute('aria-pressed', 'false');
    const exportSel = el('select'); exportSel.title = 'Export';
    exportSel.appendChild(new Option('Export…', ''));
    for (const [i, x] of EXPORTS.entries()) exportSel.appendChild(new Option(x.label, String(i)));
    bar.append(playBtn, stopBtn, timeEl, seek, el('span', 'scv-sep'), followBtn, zoomOut, zoomLabel, zoomIn, zoomFit, layoutBtn,
        el('span', 'scv-sep'), partSel, infoBtn, exportSel);
    const controls = [playBtn, stopBtn, seek, followBtn, zoomOut, zoomIn, zoomFit, layoutBtn, partSel, infoBtn, exportSel];
    controls.forEach(c => { c.disabled = true; });

    const main = el('div', 'scv-main');
    const pagesEl = el('div', 'scv-pages h');
    pagesEl.appendChild(el('div', 'scv-msg', 'Engraving the score…'));
    const infoEl = el('div', 'scv-info');
    infoEl.hidden = true;
    main.append(pagesEl, infoEl);
    root.append(bar, main);

    let destroyed = false;
    let score = null;
    let meta = null;
    let pageSize = { w: 595, h: 842 };   // SVG viewBox of a page
    let pages = [];                       // { box, img, cursor, url }
    let elements = new Map();             // measure id -> { x, y, sx, sy, page }
    let events = [];                      // [{ time, elid }] sorted by time
    let duration = 0;
    let zoom = 1;
    let layout = 'h';
    let follow = true;
    let lastElid = null;

    // --- Playback state ---
    let ctx = null;
    let playing = false;
    let gen = 0;               // bumped on every stop/seek; stale synth loops end
    let startOffset = 0;       // score time at ctx time t0
    let t0 = 0;
    let sources = [];
    let pausedAt = 0;
    let raf = 0;
    let soundfontSet = false;

    const status = (text, isError) => { if (onStatus) onStatus(text, isError); };

    function currentTime() {
        if (!playing || !ctx) return pausedAt;
        return Math.max(startOffset, startOffset + ctx.currentTime - t0);
    }

    function updateTime() {
        const t = Math.min(currentTime(), duration);
        timeEl.textContent = `${fmtTime(t)} / ${fmtTime(duration)}`;
        if (!seek.matches(':active')) seek.value = duration ? Math.round(t / duration * 1000) : 0;
        showCursor(t);
    }

    // The measure sounding at time t
    function elidAt(t) {
        let lo = 0, hi = events.length - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (events[mid].time <= t + 1e-6) { found = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return found < 0 ? null : events[found].elid;
    }

    function showCursor(t) {
        const elid = (playing || t > 0) ? elidAt(t) : null;
        if (elid === lastElid) return;
        lastElid = elid;
        for (const p of pages) p.cursor.style.display = 'none';
        const m = elid == null ? null : elements.get(elid);
        if (!m || !pages[m.page]) return;
        const p = pages[m.page];
        const c = p.cursor;
        c.style.left = (m.x / pageSize.w * 100) + '%';
        c.style.top = (m.y / pageSize.h * 100) + '%';
        c.style.width = (m.sx / pageSize.w * 100) + '%';
        c.style.height = (m.sy / pageSize.h * 100) + '%';
        c.style.display = 'block';
        if (follow && playing) scrollIntoView(c);
    }

    function scrollIntoView(c) {
        const box = pagesEl.getBoundingClientRect();
        const r = c.getBoundingClientRect();
        const margin = 40;
        if (r.left < box.left + margin || r.right > box.right - margin) {
            pagesEl.scrollLeft += r.left - box.left - Math.max(margin, (box.width - r.width) / 3);
        }
        if (r.top < box.top + margin || r.bottom > box.bottom - margin) {
            pagesEl.scrollTop += r.top - box.top - Math.max(margin, (box.height - r.height) / 3);
        }
    }

    function tick() {
        raf = 0;
        if (destroyed) return;
        updateTime();
        if (playing) raf = requestAnimationFrame(tick);
    }

    async function ensureAudio() {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            ctx = new AC({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
        }
        if (ctx.state === 'suspended') await ctx.resume();
        if (!soundfontSet) {
            status('Loading the soundfont…');
            const sf = await loadSoundfont();
            await score.setSoundFont(new Uint8Array(sf.slice(0)));
            soundfontSet = true;
        }
    }

    function stopSources() {
        for (const s of sources) { try { s.onended = null; s.stop(); } catch { /* not started */ } }
        sources = [];
    }

    async function play(from) {
        const my = ++gen;
        playBtn.textContent = '⏸ Pause';
        try {
            await ensureAudio();
        } catch (err) {
            playBtn.textContent = '▶ Play';
            status('Cannot play: ' + err.message, true);
            return;
        }
        if (my !== gen || destroyed) return;
        stopSources();
        from = Math.max(0, Math.min(from, duration));
        const synth = await score.synthAudioBatch(from, BATCH);
        if (my !== gen || destroyed) { synth(true).catch(() => {}); return; }
        startOffset = from;
        t0 = ctx.currentTime + 0.12;
        let end = t0;
        playing = true;
        root.dataset.playing = '1';
        status(`Playing · ${scoreTitle(meta).title || name}`);
        if (!raf) raf = requestAnimationFrame(tick);
        for (;;) {
            if (my !== gen || destroyed) { synth(true).catch(() => {}); return; }
            if (end - ctx.currentTime > LOOKAHEAD) { await new Promise(r => setTimeout(r, 100)); continue; }
            let batch;
            try { batch = await synth(false); } catch (err) { status('Playback failed: ' + err.message, true); break; }
            if (my !== gen || destroyed) return;
            const n = batch.length;
            if (n) {
                const buf = ctx.createBuffer(2, n * FRAMES, SAMPLE_RATE);
                const left = buf.getChannelData(0), right = buf.getChannelData(1);
                batch.forEach((res, i) => {
                    const f = new Float32Array(res.chunk.buffer, res.chunk.byteOffset, FRAMES * 2);
                    left.set(f.subarray(0, FRAMES), i * FRAMES);
                    right.set(f.subarray(FRAMES, FRAMES * 2), i * FRAMES);
                });
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(ctx.destination);
                src.start(Math.max(end, ctx.currentTime));
                end = Math.max(end, ctx.currentTime) + buf.duration;
                sources.push(src);
                if (sources.length > 64) sources.shift();
            }
            if (!n || batch[n - 1].done) break;
        }
        // let the scheduled audio run out, then stop at the end
        const wait = () => {
            if (my !== gen || destroyed) return;
            if (ctx.currentTime < end) { setTimeout(wait, 200); return; }
            stop(0);
        };
        wait();
    }

    function pause() {
        pausedAt = Math.min(currentTime(), duration);
        gen++;
        playing = false;
        delete root.dataset.playing;
        stopSources();
        playBtn.textContent = '▶ Play';
        status(statusLine());
        updateTime();
    }

    function stop(at = 0) {
        gen++;
        playing = false;
        delete root.dataset.playing;
        stopSources();
        pausedAt = at;
        playBtn.textContent = '▶ Play';
        lastElid = undefined;
        updateTime();
        status(statusLine());
    }

    function seekTo(t) {
        t = Math.max(0, Math.min(t, duration));
        if (playing) play(t);
        else { pausedAt = t; lastElid = undefined; updateTime(); }
    }

    // --- Pages ---
    function applyZoom() {
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
        const pad = 32;
        const ar = pageSize.w / pageSize.h;
        let w;
        if (layout === 'h') {
            // a whole page in view: by height, or by width on a narrow (phone) view
            const h = Math.max(120, pagesEl.clientHeight - pad - 18);
            w = Math.min(h * ar, Math.max(120, pagesEl.clientWidth - pad)) * zoom;
        } else {
            w = Math.max(120, Math.min(pagesEl.clientWidth - pad, 1000)) * zoom;
        }
        for (const p of pages) {
            p.box.style.width = w + 'px';
            p.box.style.height = (w / ar) + 'px';
        }
    }

    function setZoom(z, anchor) {
        const old = zoom;
        zoom = Math.max(0.25, Math.min(5, z));
        // keep the point under the anchor (or the view centre) in place
        const rect = pagesEl.getBoundingClientRect();
        const ax = anchor ? anchor.x - rect.left : rect.width / 2;
        const ay = anchor ? anchor.y - rect.top : rect.height / 2;
        const fx = (pagesEl.scrollLeft + ax), fy = (pagesEl.scrollTop + ay);
        applyZoom();
        const k = zoom / old;
        pagesEl.scrollLeft = fx * k - ax;
        pagesEl.scrollTop = fy * k - ay;
    }

    function clearPages() {
        for (const p of pages) URL.revokeObjectURL(p.url);
        pages = [];
        pagesEl.textContent = '';
    }

    async function renderPages() {
        clearPages();
        const n = await score.npages();
        for (let i = 0; i < n; i++) {
            if (destroyed) return;
            let svg = await score.saveSvg(i, false);
            if (i === 0) {
                const vb = /viewBox="([\d.\s-]+)"/.exec(svg);
                if (vb) {
                    const [, , w, h] = vb[1].trim().split(/\s+/).map(Number);
                    if (w > 0 && h > 0) pageSize = { w, h };
                }
            }
            svg = svg.replace(/<title>[\s\S]*?<\/title>/, '');
            const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            const box = el('div', 'scv-page');
            box.dataset.page = String(i);
            const img = el('img');
            img.alt = `Page ${i + 1}`;
            img.src = url;
            img.draggable = false;
            const cursor = el('div', 'scv-cursor');
            box.append(img, cursor, el('div', 'scv-num', String(i + 1)));
            box.addEventListener('click', e => onPageClick(i, box, e));
            pagesEl.appendChild(box);
            pages.push({ box, img, cursor, url });
            if (i === 0) applyZoom();
        }
        applyZoom();
        lastElid = undefined;
        updateTime();
    }

    // Clicking a measure moves playback there
    function onPageClick(i, box, e) {
        const r = box.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width * pageSize.w;
        const y = (e.clientY - r.top) / r.height * pageSize.h;
        for (const [id, m] of elements) {
            if (m.page === i && x >= m.x && x <= m.x + m.sx && y >= m.y && y <= m.y + m.sy) {
                const ev = events.find(v => v.elid === id);
                if (ev) seekTo(ev.time);
                return;
            }
        }
    }

    async function loadPositions() {
        const pos = await score.measurePositions();
        elements = new Map();
        const els = pos.elements || [];
        els.forEach((e, i) => {
            let sx = e.sx;
            // a zero width (seen on some imports): up to the next measure on the line
            const next = els[i + 1];
            if (!sx && next && next.y === e.y && next.x > e.x) sx = next.x - e.x;
            elements.set(e.id, { x: e.x, y: e.y, sx: Math.max(sx, 16), sy: e.sy, page: +e.page });
        });
        events = (pos.events || []).map(v => ({ elid: v.elid, time: v.position / 1000 })).sort((a, b) => a.time - b.time);
    }

    // --- Metadata ---
    function statusLine() {
        if (!meta) return '';
        const parts = (meta.parts || []).length;
        return `${meta.pages} page${meta.pages === 1 ? '' : 's'} · ${meta.measures} measures · ${parts} part${parts === 1 ? '' : 's'} · ${fmtTime(meta.duration)} · read-only`;
    }

    function renderInfo() {
        infoEl.textContent = '';
        const m = meta;
        const { title, composer } = scoreTitle(m);
        infoEl.appendChild(el('h3', null, title || name));
        const subtitle = plainText(m.subtitle || ((m.textFramesData || {}).subtitles || [])[0]);
        if (subtitle) infoEl.appendChild(el('div', 'sub', subtitle));
        const k = m.keysig;
        const rows = [
            ['Composer', composer], ['Lyricist', plainText(m.poet)],
            ['Key signature', Number.isInteger(k) && KEYS[k + 7] ? `${k === 0 ? 'none' : Math.abs(k) + (k > 0 ? '♯' : '♭')} (${KEYS[k + 7]} major / ${MINOR[k + 7]} minor)` : ''],
            ['Time', m.timesig], ['Tempo', plainText(m.tempoText) || (m.tempo ? `♩ = ${Math.round(m.tempo)}` : '')],
            ['Measures', m.measures], ['Pages', m.pages], ['Duration', fmtTime(m.duration)],
            ['Lyrics', m.hasLyrics === 'true' ? 'yes' : ''], ['Chord symbols', m.hasHarmonies === 'true' ? 'yes' : ''],
            ['Page size', m.pageFormat ? `${Math.round(m.pageFormat.width)} × ${Math.round(m.pageFormat.height)} mm` : ''],
            ['Format', originalFormat], ['MuseScore', m.mscoreVersion], ['File version', m.fileVersion],
            ['Source', m.previousSource],
        ];
        const t = el('table');
        for (const [k, v] of rows) {
            if (v === '' || v == null || v === 0 && k !== 'Measures') continue;
            const tr = el('tr');
            tr.append(el('td', null, k), el('td', null, String(v)));
            t.appendChild(tr);
        }
        infoEl.appendChild(t);
        const parts = m.parts || [];
        if (parts.length) {
            infoEl.appendChild(el('h4', null, `Parts (${parts.length})`));
            const pt = el('table');
            for (const p of parts) {
                const kind = p.hasDrumStaff === 'true' ? 'percussion' : p.hasTabStaff === 'true' ? (p.hasPitchedStaff === 'true' ? 'staff + tab' : 'tablature') : '';
                const tr = el('tr');
                const desc = [p.instrumentName && p.instrumentName !== p.name ? plainText(p.instrumentName) : '', kind, p.program != null && p.hasDrumStaff !== 'true' ? `GM ${p.program + 1}` : '']
                    .filter(Boolean).join(' · ');
                tr.append(el('td', null, plainText(p.name) || plainText(p.instrumentName) || p.instrumentId || '(unnamed)'), el('td', null, desc));
                pt.appendChild(tr);
            }
            infoEl.appendChild(pt);
        }
    }

    function fillParts() {
        partSel.textContent = '';
        partSel.appendChild(new Option('Full score', '-1'));
        for (const x of meta.excerpts || []) partSel.appendChild(new Option(plainText(x.title) || `Part ${x.id + 1}`, String(x.id)));
        partSel.disabled = partSel.options.length < 2;
    }

    async function selectPart(id) {
        stop(0);
        controls.forEach(c => { c.disabled = true; });
        clearPages();
        pagesEl.appendChild(el('div', 'scv-msg', 'Engraving the part…'));
        try {
            await score.setExcerptId(id);
            await loadPositions();
            await renderPages();
        } catch (err) {
            fail('Could not show this part: ' + err.message);
        }
        controls.forEach(c => { c.disabled = false; });
        partSel.disabled = partSel.options.length < 2;
    }

    async function doExport(x) {
        status(`Exporting ${x.label}…`);
        try {
            const data = await x.make(score);
            const blob = new Blob([data], { type: x.type });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const base = name.replace(/\.[^.]+$/, '');
            const part = +partSel.value >= 0 ? '-' + partSel.selectedOptions[0].text.replace(/[\\/:*?"<>|]+/g, '_') : '';
            a.download = `${base}${part}.${x.ext}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
            status(statusLine());
        } catch (err) {
            status(`Export failed: ${err.message || err}`, true);
        }
    }

    function fail(message) {
        clearPages();
        pagesEl.appendChild(el('div', 'scv-msg err', message));
        status(message.split('\n')[0], true);
    }

    // --- Wiring ---
    playBtn.onclick = () => (playing ? pause() : play(pausedAt >= duration ? 0 : pausedAt));
    stopBtn.onclick = () => stop(0);
    seek.oninput = () => { timeEl.textContent = `${fmtTime(seek.value / 1000 * duration)} / ${fmtTime(duration)}`; };
    seek.onchange = () => seekTo(seek.value / 1000 * duration);
    followBtn.onclick = () => { follow = !follow; followBtn.setAttribute('aria-pressed', String(follow)); };
    zoomIn.onclick = () => setZoom(zoom * 1.25);
    zoomOut.onclick = () => setZoom(zoom / 1.25);
    zoomFit.onclick = () => { zoom = 1; applyZoom(); };
    layoutBtn.onclick = () => {
        layout = layout === 'h' ? 'v' : 'h';
        pagesEl.className = 'scv-pages ' + layout;
        layoutBtn.textContent = layout === 'h' ? '⇅ Vertical' : '⇆ Horizontal';
        zoom = 1;
        applyZoom();
    };
    infoBtn.onclick = () => {
        infoEl.hidden = !infoEl.hidden;
        infoBtn.setAttribute('aria-pressed', String(!infoEl.hidden));
        applyZoom();
    };
    partSel.onchange = () => selectPart(+partSel.value);
    exportSel.onchange = () => { const i = exportSel.value; exportSel.value = ''; if (i !== '') doExport(EXPORTS[+i]); };
    pagesEl.addEventListener('wheel', e => {
        if (!e.ctrlKey || !pages.length) return;
        e.preventDefault();
        setZoom(zoom * Math.exp(-e.deltaY / 400), { x: e.clientX, y: e.clientY });
    }, { passive: false });
    // vertical wheel scrolls the side-by-side pages sideways
    pagesEl.addEventListener('wheel', e => {
        if (e.ctrlKey || layout !== 'h' || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        if (pagesEl.scrollHeight > pagesEl.clientHeight + 2 && zoom > 1) return;
        pagesEl.scrollLeft += e.deltaY;
        e.preventDefault();
    }, { passive: false });
    root.tabIndex = 0;
    root.addEventListener('keydown', e => {
        if (e.target.closest('select,input')) return;
        if (e.key === ' ') { e.preventDefault(); if (!playBtn.disabled) playBtn.click(); }
        else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.25);
        else if (e.key === '-') setZoom(zoom / 1.25);
        else if (e.key === '0') zoomFit.click();
    });
    const ro = new ResizeObserver(() => { if (pages.length) applyZoom(); });
    ro.observe(pagesEl);

    const format = scoreFormat(name);
    const originalFormat = format.toUpperCase();
    const ready = (async () => {
        if (!SCORE_FORMATS.includes(format)) throw new Error(`.${format} files are not a score format webmscore reads`);
        const WebMscore = await loadWebMscore();
        if (destroyed) return null;
        status('Engraving…');
        try {
            // webmscore takes the buffer (transferred to its worker): give it a copy
            score = await WebMscore.load(format, bytes.slice(0));
        } catch (err) {
            // webmscore names its temporary file, or nothing ("File “” is ..."): name ours
            const msg = String(err && err.message || err).replace(/File “[^”]*”/, `“${name}”`).replace(/^WebMscore Err\[\d+\] /, '');
            throw new Error(`Could not read this ${originalFormat} file: ${msg}`);
        }
        if (destroyed) { score.destroy(false); return null; }
        meta = await score.metadata();
        duration = meta.duration || 0;
        renderInfo();
        fillParts();
        await loadPositions();
        await renderPages();
        if (!pages.length) throw new Error('The score has no pages.');
        controls.forEach(c => { c.disabled = false; });
        partSel.disabled = partSel.options.length < 2;
        status(statusLine());
        // parts that are not saved in the file are generated from the instruments
        if ((meta.parts || []).length > 1 && !(meta.excerpts || []).length) {
            score.generateExcerpts().then(() => score.metadata()).then(m => {
                if (destroyed) return;
                meta.excerpts = m.excerpts;
                fillParts();
            }).catch(() => {});
        }
        return meta;
    })().catch(err => {
        if (!destroyed) fail(err.message || String(err));
        throw err;
    });

    return {
        ready,
        get state() {
            return { playing, time: currentTime(), duration, zoom, layout, pages: pages.length, elid: lastElid, audio: ctx && ctx.state, meta };
        },
        play: () => play(pausedAt), pause, setZoom, seekTo,
        destroy() {
            destroyed = true;
            gen++;
            stopSources();
            if (raf) cancelAnimationFrame(raf);
            ro.disconnect();
            if (ctx) ctx.close().catch(() => {});
            clearPages();
            if (score) score.destroy(false);
            root.remove();
        },
    };
}
