// --- Lyrics in the audio player ---
// The <audio> with its lyrics above it, karaoke style: the line being sung
// centred and lit, its words filled as they are sung (where the lyrics time
// words), a click on a line seeks there. The lyrics (src/lyrics.js) come from
// - files beside the audio: song.lrc, song.en.elrc, song.ass, song.srt, song.ttml, song.vtt
// - the audio file itself: ID3 SYLT/USLT, Vorbis comments, MP4 ©lyr and text
//   tracks, Matroska (.mka) subtitle tracks, tags and attached lyrics files
// - Musixmatch, when asked (through server.js, which keeps to its lyrics methods)
// - a file opened or dropped on the player
// A menu picks among them; the best timed is shown first.
const { createLogger } = require('./debug');
const { LYRICS_RE, parseLyrics, parseRichsync, readEmbeddedLyrics, rank, plain } = require('./lyrics');

const log = createLogger('Lyrics');
const TOKEN_KEY = 'musixmatch-user-token';
const GROUPS = ['Beside the audio', 'In the file', 'Musixmatch', 'Opened'];
const KINDS = ['', 'words only', 'line by line', 'word by word'];

const storage = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* no storage */ } },
};

// --- Musixmatch ---

async function mxm(method, params) {
    const url = new URL('musixmatch/' + method, document.baseURI);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const token = storage.get(TOKEN_KEY);
    const resp = await fetch(url, { headers: token ? { 'x-musixmatch-token': token } : {} });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.header) throw new Error((data && data.error) || `HTTP ${resp.status}`);
    if (data.header.status_code === 401) {
        throw new Error(data.header.hint === 'captcha' ? 'Musixmatch asks for a captcha: set a user token of your own' : 'Musixmatch refused the user token');
    }
    return data.header.status_code === 200 ? data.body : null;
}

// What Musixmatch has for a song: its word-timed (richsync), line-timed and plain lyrics,
// found by ISRC when the file has one, else by title, artist, album and length
async function searchMusixmatch(q) {
    let track = null, richsync = null, subtitle = null, lyrics = null;
    if (q.isrc) {
        const b = await mxm('track.get', { track_isrc: q.isrc });
        track = b && b.track;
        if (track) {
            if (track.has_richsync) richsync = ((await mxm('track.richsync.get', { track_id: track.track_id })) || {}).richsync;
            if (track.has_subtitles) subtitle = ((await mxm('track.subtitle.get', { commontrack_id: track.commontrack_id })) || {}).subtitle;
            if (track.has_lyrics) lyrics = ((await mxm('track.lyrics.get', { track_id: track.track_id })) || {}).lyrics;
        }
    }
    if (!track) {
        const b = await mxm('macro.subtitles.get', {
            q_track: q.title, q_artist: q.artist, q_album: q.album, q_duration: q.duration ? Math.round(q.duration) : '',
            format: 'json', namespace: 'lyrics_richsynched', optional_calls: 'track.richsync',
        });
        const calls = (b && b.macro_calls) || {};
        const get = k => calls[k] && calls[k].message && calls[k].message.header.status_code === 200 ? calls[k].message.body || null : null;
        track = (get('matcher.track.get') || {}).track || null;
        richsync = (get('track.richsync.get') || {}).richsync;
        subtitle = (((get('track.subtitles.get') || {}).subtitle_list || [])[0] || {}).subtitle;
        lyrics = (get('track.lyrics.get') || {}).lyrics;
    }
    if (!track) return [];
    const name = `${track.track_name} — ${track.artist_name}`;
    const out = [];
    if (richsync && richsync.richsync_body) out.push({ label: name, meta: 'word by word', lyrics: parseRichsync(richsync.richsync_body) });
    if (subtitle && subtitle.subtitle_body) out.push({ label: name, meta: 'line by line', lyrics: parseLyrics(subtitle.subtitle_body) });
    if (lyrics && lyrics.lyrics_body) {
        // Its plain lyrics end with a notice and a tracking number
        const body = lyrics.lyrics_body.replace(/\n*\*{3,}[^\n]*\*{3,}[\s\S]*$/, '');
        if (body.trim()) out.push({ label: name, meta: 'words only', lyrics: plain(body) });
    }
    if (!out.length && lyrics && lyrics.restricted) throw new Error('Musixmatch may not show these lyrics here');
    return out.filter(r => r.lyrics && r.lyrics.lines.length);
}

// --- Styles ---

let styleInstalled = false;
function installStyles() {
    if (styleInstalled) return;
    styleInstalled = true;
    const style = document.createElement('style');
    style.textContent = `
.lyr-wrap{--lyr-sung:#5cc8ff;--lyr-unsung:#f0f3f6;--lyr-future:#8b949e;--lyr-past:#596069;position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#111418;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.lyr-wrap.drop{outline:2px dashed var(--lyr-sung);outline-offset:-6px}
.lyr-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #2d333b;flex:none}
.lyr-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lyr-title b{font-weight:600}
.lyr-title span{color:#8b949e;margin-left:6px}
.lyr-bar button{background:#21262d;color:#e6edf3;border:1px solid #3d444d;border-radius:4px;padding:2px 8px;cursor:pointer;font:inherit}
.lyr-bar button:hover{background:#30363d}
.lyr-offset{color:#8b949e;font-variant-numeric:tabular-nums;min-width:48px;text-align:center}
.lyr-src{position:relative}
.lyr-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:5;min-width:260px;max-width:380px;max-height:70vh;overflow:auto;background:rgba(20,22,26,.98);border:1px solid #444c56;border-radius:6px;padding:4px 0;box-shadow:0 6px 20px rgba(0,0,0,.5)}
.lyr-menu[hidden]{display:none}
.lyr-menu .h{padding:6px 12px 2px;color:#8b949e;font-size:11px;text-transform:uppercase}
.lyr-menu button{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;background:none;border:none;border-radius:0;color:inherit;padding:5px 12px;cursor:pointer;font:inherit}
.lyr-menu button:hover{background:#30363d}
.lyr-menu button::before{content:'';width:12px;flex:none}
.lyr-menu button.sel::before{content:'✓'}
.lyr-menu button:disabled{color:#6e7681;cursor:default;background:none}
.lyr-menu .meta{margin-left:auto;color:#8b949e;font-size:11px;white-space:nowrap}
.lyr-menu .note{padding:4px 12px 4px 32px;color:#8b949e;font-size:11px}
.lyr-menu .sep{border-top:1px solid #30363d;margin:4px 0}
.lyr-pane{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 24px;text-align:center}
.lyr-pad{flex:none}
.lyr-line{font-size:clamp(17px,3vw,30px);font-weight:700;line-height:1.3;padding:.28em 0;color:var(--lyr-future);white-space:pre-line;cursor:pointer;transition:color .25s,opacity .25s,transform .25s;transform-origin:center}
.lyr-line.past{color:var(--lyr-past)}
.lyr-line.active{color:var(--lyr-unsung);transform:scale(1.05)}
.lyr-line.bg{font-size:clamp(13px,2vw,20px);font-weight:600;opacity:.85}
.lyr-wrap.duet .lyr-line.v1{text-align:left;transform-origin:left}
.lyr-wrap.duet .lyr-line.v2,.lyr-wrap.duet .lyr-line.v4{text-align:right;transform-origin:right}
.lyr-line.active .lyr-w.sung{color:var(--lyr-sung)}
.lyr-line.active .lyr-w.now{background:linear-gradient(90deg,var(--lyr-sung) calc(var(--p,0)*100%),var(--lyr-unsung) calc(var(--p,0)*100%));-webkit-background-clip:text;background-clip:text;color:transparent}
.lyr-pane.untimed .lyr-line{cursor:default;color:#c9d1d9;font-size:clamp(15px,2.2vw,22px);font-weight:500}
.lyr-empty{margin:auto;padding:24px;color:#8b949e;text-align:center;line-height:1.6}
.lyr-empty button{margin:4px;background:#21262d;color:#e6edf3;border:1px solid #3d444d;border-radius:4px;padding:4px 10px;cursor:pointer;font:inherit}
.lyr-wrap audio{display:block;width:calc(100% - 20px);margin:8px 10px;flex:none}
`;
    document.head.appendChild(style);
}

// --- The player ---

// Puts the audio under its lyrics. opts: { url, name, siblings: [{ name, url: () => Promise<string> }] }
// Returns { element, destroy() }
function attachLyrics(audio, opts) {
    installStyles();
    const el = (tag, cls, parent, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    };
    const wrap = el('div', 'lyr-wrap');
    const bar = el('div', 'lyr-bar', wrap);
    const title = el('div', 'lyr-title', bar);
    const earlier = el('button', '', bar, '−');
    earlier.title = 'Show the lyrics earlier';
    const offsetLabel = el('span', 'lyr-offset', bar);
    offsetLabel.title = 'How much later than their times the lyrics are shown';
    const later = el('button', '', bar, '+');
    later.title = 'Show the lyrics later';
    const src = el('div', 'lyr-src', bar);
    const srcButton = el('button', '', src, 'Lyrics ▾');
    srcButton.title = 'Where the lyrics come from';
    const menu = el('div', 'lyr-menu', src);
    menu.hidden = true;
    const pane = el('div', 'lyr-pane', wrap);
    wrap.appendChild(audio);
    const fileInput = el('input', '', wrap);
    fileInput.type = 'file';
    fileInput.accept = '.lrc,.elrc,.ass,.ssa,.srt,.ttml,.vtt,.xml,.txt';
    fileInput.hidden = true;

    const entries = []; // { label, meta, group, language, lyrics, load, error, unsupported }
    const meta = {};
    let selected = null, chosenByUser = false, destroyed = false, scanning = 'Looking for lyrics…', searching = null;
    let offset = 0, rows = [], raf = 0, centred = null, userScrolled = 0;
    const stem = opts.name.replace(/\.[^.]+$/, '');

    const showTitle = () => {
        title.textContent = '';
        el('b', '', title, meta.title || stem);
        if (meta.artist) el('span', '', title, meta.artist);
        title.title = [meta.title || opts.name, meta.artist, meta.album].filter(Boolean).join(' — ');
    };
    const showOffset = () => {
        offsetLabel.textContent = `${offset > 0 ? '+' : offset < 0 ? '−' : ''}${Math.abs(offset).toFixed(1)} s`;
    };

    // --- The menu ---

    const closeMenu = () => { menu.hidden = true; };
    const renderMenu = () => {
        menu.textContent = '';
        const item = (label, metaText, isSel, onClick, disabled) => {
            const b = el('button', isSel ? 'sel' : '', menu, label);
            if (metaText) el('span', 'meta', b, metaText);
            b.disabled = !!disabled;
            b.addEventListener('click', () => { closeMenu(); onClick(); });
        };
        item('Off', '', selected === null, () => { chosenByUser = true; select(null); });
        for (const group of GROUPS) {
            const list = entries.filter(e => e.group === group);
            if (!list.length) continue;
            el('div', 'h', menu, group);
            for (const e of list) {
                const kind = e.lyrics ? KINDS[rank(e.lyrics)] : '';
                item(e.label, e.error ? 'failed' : [e.meta, kind].filter(Boolean).join(', '), selected === e, () => { chosenByUser = true; select(e); }, e.unsupported || !!e.error);
            }
        }
        if (scanning) el('div', 'note', menu, scanning);
        el('div', 'sep', menu);
        item(searching || 'Search Musixmatch', '', false, () => musixmatch(false), !!searching);
        item('Search Musixmatch for…', '', false, () => musixmatch(true), !!searching);
        item('Musixmatch user token…', storage.get(TOKEN_KEY) ? 'set' : '', false, askToken);
        item('Open lyrics file…', '.lrc .elrc .ass .srt .ttml .vtt', false, () => fileInput.click());
        srcButton.textContent = selected ? 'Lyrics ●' : 'Lyrics ▾';
    };
    const add = e => {
        entries.push(e);
        renderMenu();
        return e;
    };

    // --- Showing lyrics ---

    const resizePads = () => {
        const h = Math.max(0, pane.clientHeight / 2 - 24);
        for (const p of pane.querySelectorAll('.lyr-pad')) p.style.height = h + 'px';
    };
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resizePads) : null;
    if (resizeObserver) resizeObserver.observe(pane);

    const showEmpty = () => {
        pane.className = 'lyr-pane';
        pane.textContent = '';
        rows = [];
        const box = el('div', 'lyr-empty', pane);
        if (scanning) { box.textContent = scanning; return; }
        el('div', '', box, selected === null && entries.some(e => e.lyrics) ? 'Lyrics are off.' : 'No lyrics found for this song.');
        const hint = el('div', '', box, `Put a ${stem}.lrc (or .elrc, .ass, .srt, .ttml, .vtt) beside it, drop one here, or:`);
        hint.style.fontSize = '12px';
        const b1 = el('button', '', box, 'Open lyrics file…');
        b1.addEventListener('click', () => fileInput.click());
        const b2 = el('button', '', box, searching || 'Search Musixmatch');
        b2.disabled = !!searching;
        b2.addEventListener('click', () => musixmatch(false));
    };

    const show = lyrics => {
        pane.textContent = '';
        rows = [];
        centred = null;
        pane.className = 'lyr-pane' + (lyrics.synced ? '' : ' untimed');
        const voices = new Set(lyrics.lines.map(l => l.voice).filter(Boolean));
        // Two singers or more (v1, v2, …): one to the left, the other to the right
        const duet = lyrics.synced && [...voices].filter(v => /^v\d+$/.test(v)).length > 1;
        wrap.classList.toggle('duet', duet);
        el('div', 'lyr-pad', pane);
        if (!lyrics.synced) {
            const note = el('div', 'lyr-empty', pane, 'These lyrics are not timed.');
            note.style.padding = '0 0 12px';
        }
        for (const line of lyrics.lines) {
            const row = el('div', 'lyr-line' + (line.bg ? ' bg' : '') + (duet && line.voice ? ' ' + line.voice : ''), pane);
            const r = { line, el: row, state: '', words: null };
            if (line.words) {
                r.words = line.words.map(w => ({ w, el: el('span', 'lyr-w', row, w.text), state: '' }));
            } else row.textContent = line.text || ' ';
            if (lyrics.synced) {
                row.addEventListener('click', () => {
                    audio.currentTime = Math.max(0, line.start + offset);
                    userScrolled = 0;
                    if (audio.paused) audio.play().catch(() => {});
                });
            }
            rows.push(r);
        }
        el('div', 'lyr-pad', pane);
        resizePads();
        if (lyrics.synced) update(true);
        else pane.scrollTop = 0;
    };

    // The lines and words at the audio's time; the newest line sung kept in the middle
    function update(force) {
        if (!rows.length || !selected || !selected.lyrics || !selected.lyrics.synced) return;
        const t = audio.currentTime - offset;
        let focus = null;
        for (const r of rows) {
            const l = r.line;
            const state = t >= l.end ? 'past' : t >= l.start ? 'active' : '';
            if (state !== r.state) { r.el.className = r.el.className.replace(/\s*\b(past|active)\b/g, '') + (state ? ' ' + state : ''); r.state = state; }
            if (state === 'active') focus = r;
            if (r.words && (state === 'active' || r.wordsDirty)) {
                r.wordsDirty = state === 'active';
                for (const x of r.words) {
                    const w = x.w;
                    let s = '', p = 0;
                    if (state === 'active') {
                        if (t >= w.end) s = 'sung';
                        else if (t >= w.start) {
                            p = w.fill === 'step' ? 1 : (t - w.start) / Math.max(0.001, w.end - w.start);
                            s = p >= 1 ? 'sung' : 'now';
                        }
                    }
                    if (s !== x.state) { x.el.className = 'lyr-w' + (s ? ' ' + s : ''); x.state = s; }
                    if (s === 'now') x.el.style.setProperty('--p', p.toFixed(3));
                }
            }
        }
        // Between lines: the next one waits in the middle
        if (!focus) focus = rows.find(r => r.line.start > t) || null;
        if (focus && (focus !== centred || force) && Date.now() - userScrolled > 3000) {
            centred = focus;
            const top = focus.el.offsetTop - pane.clientHeight / 2 + focus.el.offsetHeight / 2;
            if (typeof pane.scrollTo === 'function') pane.scrollTo({ top, behavior: force ? 'auto' : 'smooth' });
            else pane.scrollTop = top;
        }
    }
    const tick = () => {
        raf = 0;
        update(false);
        if (!audio.paused && !destroyed) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => { if (!raf) raf = requestAnimationFrame(tick); };
    const onSeek = () => { userScrolled = 0; update(true); };
    const onTime = () => { if (!raf) update(false); };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('seeked', onSeek);
    audio.addEventListener('timeupdate', onTime);
    for (const ev of ['wheel', 'touchmove']) pane.addEventListener(ev, () => { userScrolled = Date.now(); }, { passive: true });

    async function select(e) {
        selected = e;
        renderMenu();
        if (!e) return showEmpty();
        try {
            if (!e.lyrics && e.load) e.lyrics = await e.load();
            if (!e.lyrics || !e.lyrics.lines.length) throw new Error('no lyrics in it');
        } catch (err) {
            log.warn('Lyrics failed:', err);
            e.error = err.message || String(err);
            if (selected === e) { selected = null; chosenByUser = false; autoPick(); }
            renderMenu();
            return;
        }
        if (selected !== e || destroyed) return;
        if (e.lyrics.meta) for (const k of ['title', 'artist']) if (!meta[k] && e.lyrics.meta[k]) meta[k] = e.lyrics.meta[k];
        showTitle();
        show(e.lyrics);
    }

    // The best lyrics found so far, until the viewer chooses: more finely timed
    // first, then beside the audio before inside it before Musixmatch's
    function autoPick() {
        if (chosenByUser || destroyed) return;
        const score = e => rank(e.lyrics) * 10 - GROUPS.indexOf(e.group);
        const best = entries.filter(e => e.lyrics && !e.error).sort((a, b) => score(b) - score(a))[0];
        if (best && best !== selected && (!selected || !selected.lyrics || score(best) > score(selected))) select(best);
        else if (!best && !selected) showEmpty();
    }
    // Loads every source in the background (they are small), choosing as they come
    const loadAndPick = async e => {
        if (!e.lyrics && e.load && !e.unsupported) {
            try { e.lyrics = await e.load(); } catch (err) { e.error = err.message || String(err); }
            if (e.lyrics && !e.lyrics.lines.length) e.lyrics = null;
            renderMenu();
        }
        autoPick();
    };

    // --- Where lyrics come from ---

    const openText = (name, text) => {
        const lyrics = parseLyrics(text, name);
        chosenByUser = true;
        const e = add({ label: name, meta: name.split('.').pop().toUpperCase(), group: 'Opened', lyrics: lyrics || null, error: lyrics ? null : 'not lyrics' });
        if (lyrics) select(e);
    };
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (f) openText(f.name, await f.text());
    });
    wrap.addEventListener('dragover', ev => {
        if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); wrap.classList.add('drop'); }
    });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
    wrap.addEventListener('drop', async ev => {
        wrap.classList.remove('drop');
        const f = ev.dataTransfer && ev.dataTransfer.files[0];
        if (!f) return;
        ev.preventDefault();
        openText(f.name, await f.text());
    });

    function askToken() {
        const current = storage.get(TOKEN_KEY);
        const v = window.prompt('Your Musixmatch user token (the usertoken parameter the Musixmatch app sends, e.g. from '
            + 'apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0 opened in a browser after solving '
            + 'its captcha). Leave empty to let this server ask for one. It is kept in this browser only.', current);
        if (v === null) return;
        storage.set(TOKEN_KEY, v.trim());
        renderMenu();
    }

    async function musixmatch(ask) {
        if (searching) return;
        const q = { ...meta, duration: isFinite(audio.duration) ? audio.duration : meta.duration };
        // Without tags: "Artist - Title" from the file's name
        const named = /^(?:\d+[\s.-]+)?(.+?)\s+-\s+(.+)$/.exec(stem);
        if (!q.title) { q.title = named ? named[2] : stem; if (!q.artist && named) q.artist = named[1]; }
        if (ask || !q.artist) {
            const v = window.prompt('Search Musixmatch for (Artist - Title):', [q.artist, q.title].filter(Boolean).join(' - '));
            if (v === null) return;
            const m = /^(.*?)\s+-\s+(.*)$/.exec(v.trim());
            Object.assign(q, m ? { artist: m[1], title: m[2] } : { artist: '', title: v.trim() });
            delete q.isrc;
            delete q.album;
        }
        searching = 'Searching Musixmatch…';
        renderMenu();
        if (!entries.some(e => e.lyrics)) showEmpty();
        try {
            const found = await searchMusixmatch(q);
            if (destroyed) return;
            for (const old of entries.filter(e => e.group === 'Musixmatch')) entries.splice(entries.indexOf(old), 1);
            if (!found.length) throw new Error(`Musixmatch has no lyrics for ${[q.artist, q.title].filter(Boolean).join(' – ')}`);
            const added = found.map(f => add({ ...f, group: 'Musixmatch' }));
            chosenByUser = true;
            select(added.sort((a, b) => rank(b.lyrics) - rank(a.lyrics))[0]);
        } catch (err) {
            log.warn('Musixmatch failed:', err);
            searching = null;
            renderMenu();
            if (!destroyed) window.alert(err.message || String(err));
        }
        searching = null;
        renderMenu();
        if (!selected) showEmpty();
    }

    // Files beside the audio: stem.lrc, stem.en.ttml, stem.ja.ass, …
    const sibling = (opts.siblings || []).filter(s => LYRICS_RE.test(s.name) && s.name.toLowerCase().startsWith(stem.toLowerCase() + '.'));
    const besides = sibling.map(s => {
        const middle = s.name.replace(LYRICS_RE, '').slice(stem.length + 1);
        return add({
            label: middle ? `${s.name} (${middle})` : s.name, group: 'Beside the audio', meta: s.name.split('.').pop().toUpperCase(),
            load: async () => {
                const resp = await fetch(await s.url());
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return parseLyrics(await resp.text(), s.name);
            },
        });
    });
    const embedded = readEmbeddedLyrics(opts.url, {
        onSource: s => { if (!destroyed) loadAndPick(add({ ...s, group: 'In the file' })); },
        onMeta: m => { Object.assign(meta, Object.fromEntries(Object.entries(m).filter(([, v]) => v))); showTitle(); },
    }).then(r => {
        if (destroyed) return;
        Object.assign(meta, Object.fromEntries(Object.entries(r.meta).filter(([, v]) => v)));
        showTitle();
        return Promise.all(r.sources.map(s => loadAndPick(add({ ...s, group: 'In the file' }))));
    }).catch(err => log.warn('Could not read lyrics in the file:', err));
    Promise.all([embedded, ...besides.map(loadAndPick)]).then(() => {
        scanning = null;
        if (destroyed) return;
        renderMenu();
        if (!selected) autoPick();
        if (!selected) showEmpty();
    });

    earlier.addEventListener('click', () => { offset = Math.round((offset - 0.1) * 10) / 10; showOffset(); update(true); });
    later.addEventListener('click', () => { offset = Math.round((offset + 0.1) * 10) / 10; showOffset(); update(true); });
    srcButton.addEventListener('click', ev => { ev.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', ev => ev.stopPropagation());
    document.addEventListener('click', closeMenu);

    showTitle();
    showOffset();
    renderMenu();
    showEmpty();
    return {
        element: wrap,
        destroy() {
            destroyed = true;
            if (raf) cancelAnimationFrame(raf);
            if (resizeObserver) resizeObserver.disconnect();
            document.removeEventListener('click', closeMenu);
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('seeked', onSeek);
            audio.removeEventListener('timeupdate', onTime);
        },
    };
}

module.exports = { attachLyrics, searchMusixmatch };
