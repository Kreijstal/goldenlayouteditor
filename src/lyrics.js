// --- Lyrics for the audio player ---
// Timed lyrics, read into one shape the player (src/lyrics-view.js) shows as karaoke:
//   { lines: [{ start, end, text, words: [{ start, end, text, fill }] | null, voice, bg }],
//     synced, meta: { title, artist, album } }
// Times are seconds; start is null in lyrics that aren't timed. Words, when the
// format times them, join back into the line's text (their spaces included).
// - files: LRC and enhanced LRC (.lrc, .elrc: <mm:ss.xx> word times, v1:/v2: voices),
//   ASS/SSA (\k, \kf, \ko syllables), SubRip, WebVTT (<hh:mm:ss.ttt> word times),
//   TTML (Apple Music's too: spans per word, ttm:agent, x-bg background vocals)
// - inside the audio file: ID3v2 SYLT (synchronised) and USLT frames, and TXXX
//   LYRICS (in MP3, and in WAV/AIFF id3 chunks); Vorbis comments' LYRICS (FLAC, Ogg,
//   Opus); MP4's ©lyr and its text tracks; Matroska's (.mka) subtitle tracks,
//   LYRICS tags and attached lyrics files
// - Musixmatch's richsync (word times) and subtitles, as its desktop API gives them
const { parseSrt, mp4Tracks, mp4Cues, mkvScan, mkvTrackContent, rangeReader } = require('./subtitles');

const LYRICS_RE = /\.(lrc|elrc|ass|ssa|srt|ttml|vtt)$/i;

// --- Times ---

// "01:02.34", "1:02:03.456", "02:03", "1:02:03,456" → seconds
function clockTime(s) {
    const m = /^\s*(?:(\d+):)?(\d+):(\d{1,2})(?:[.,:](\d{1,3}))?\s*$/.exec(s);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +m[4].padEnd(3, '0') / 1000 : 0);
}

// --- Finishing lines ---

// Ends for lines and words that have none: the next one's start; the last word
// ends with its line. Lines are sorted, empty ones (instrumental breaks) only end the one before.
function finish(lines, meta = {}) {
    lines.sort((a, b) => a.start - b.start);
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.end == null || !(l.end > l.start)) {
            const next = lines.slice(i + 1).find(n => n.start > l.start);
            const lastWord = l.words && l.words.length ? l.words[l.words.length - 1] : null;
            const wordEnd = lastWord ? (lastWord.end != null ? lastWord.end : lastWord.start + 1) : l.start;
            l.end = next ? Math.max(next.start, wordEnd) : Math.max(wordEnd, l.start + 5);
            if (next && lastWord && lastWord.end == null) l.end = Math.min(l.end, next.start);
        }
        if (l.words) {
            l.words.forEach((w, k) => {
                if (w.end == null || !(w.end > w.start)) w.end = k + 1 < l.words.length ? l.words[k + 1].start : Math.max(l.end, w.start);
            });
            // Spaced as " <t> word <t> word": the spaces go with the words before them
            for (let k = 1; k < l.words.length; k++) {
                const lead = /^\s+/.exec(l.words[k].text), prev = l.words[k - 1];
                if (!lead) continue;
                if (!/\s$/.test(prev.text)) prev.text += lead[0];
                l.words[k].text = l.words[k].text.slice(lead[0].length);
            }
            l.words = l.words.filter(w => w.text);
            if (l.words.length) {
                l.words[0].text = l.words[0].text.replace(/^\s+/, '');
                l.words[l.words.length - 1].text = l.words[l.words.length - 1].text.replace(/\s+$/, '');
                l.words = l.words.filter(w => w.text);
            }
            if (!l.words.length) l.words = null;
            else {
                // A line's text is its words'; the line runs at least as long as they do
                l.text = l.words.map(w => w.text).join('');
                l.end = Math.max(l.end, l.words[l.words.length - 1].end);
            }
        }
        l.text = (l.text || '').replace(/[ \t]+$/gm, '').trim();
    }
    const kept = lines.filter(l => l.text.trim());
    return { lines: kept, synced: true, meta };
}

function plain(text, meta = {}) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').map(t => ({ start: null, end: null, text: t.trim(), words: null }));
    while (lines.length && !lines[lines.length - 1].text) lines.pop();
    while (lines.length && !lines[0].text) lines.shift();
    return { lines, synced: false, meta };
}

// --- LRC, enhanced LRC ---

const LRC_TIME = /\[(\d+:\d{1,2}(?:[.:]\d{1,3})?)\]/y;
const LRC_TAG = /^\[([a-z#]+):([^\]]*)\]\s*$/i;
const LRC_WORD = /<(\d+:\d{1,2}(?:[.:]\d{1,3})?)>|\[(\d+:\d{1,2}(?:[.:]\d{1,3})?)\]/g;

function parseLrc(text) {
    const meta = {};
    let offset = 0;
    const lines = [];
    for (const raw of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trim();
        const tag = LRC_TAG.exec(line);
        if (tag) {
            const k = tag[1].toLowerCase(), v = tag[2].trim();
            if (k === 'offset') offset = (+v || 0) / 1000;
            else if (k === 'ti') meta.title = v;
            else if (k === 'ar') meta.artist = v;
            else if (k === 'al') meta.album = v;
            continue;
        }
        // The line's times: several in a row mean it is sung at each of them
        const starts = [];
        let p = 0;
        for (;;) {
            LRC_TIME.lastIndex = p;
            const m = LRC_TIME.exec(line);
            if (!m) break;
            starts.push(clockTime(m[1]));
            p = LRC_TIME.lastIndex;
            while (line[p] === ' ' && line[p + 1] === '[') p++;
        }
        if (!starts.length) continue;
        let body = line.slice(p);
        // Voices: "v1:", "v2:" (and "bg:" for background vocals)
        let voice = null, bg = false;
        const v = /^\s*(v\d+|bg)\s*:\s?/i.exec(body);
        if (v) { if (v[1].toLowerCase() === 'bg') bg = true; else voice = v[1].toLowerCase(); body = body.slice(v[0].length); }
        // Word times, <mm:ss.xx> (or [mm:ss.xx] after the text began); the text
        // before the first is sung at the line's time, a time with no text after it ends the word before
        const parts = [];
        let last = 0, m;
        LRC_WORD.lastIndex = 0;
        while ((m = LRC_WORD.exec(body))) {
            parts.push({ text: body.slice(last, m.index), next: clockTime(m[1] || m[2]) });
            last = LRC_WORD.lastIndex;
        }
        const tail = body.slice(last);
        for (const start of starts) {
            const t0 = start - offset;
            if (!parts.length) { lines.push({ start: t0, end: null, text: body, words: null, voice, bg }); continue; }
            const words = [];
            let at = t0;
            for (const part of parts) {
                if (part.text) words.push({ start: at, end: null, text: part.text });
                else if (words.length && words[words.length - 1].end == null) words[words.length - 1].end = part.next - offset;
                at = part.next - offset;
            }
            if (tail) words.push({ start: at, end: null, text: tail });
            else if (words.length && words[words.length - 1].end == null) words[words.length - 1].end = at;
            lines.push({ start: t0, end: null, text: words.map(w => w.text).join(''), words, voice, bg });
        }
    }
    if (!lines.length) return null;
    // LRC lines end where the next starts (a word-timed line ends with its last word)
    for (const l of lines) if (l.words && l.words.length) {
        const w = l.words[l.words.length - 1];
        if (w.end != null) l.end = w.end;
    }
    return finish(lines, meta);
}

// --- SubRip, WebVTT ---

function stripTags(s) {
    return s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function parseSrtLyrics(text) {
    const cues = parseSrt(text);
    if (!cues.length) return null;
    return finish(cues.map(c => ({ start: c.start, end: c.end, text: stripTags(c.text.replace(/\{\\[^}]*\}/g, '')), words: null })));
}

// A cue's text, its <hh:mm:ss.ttt> timestamps making words
function vttCue(start, end, body) {
    const voiceTag = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(body);
    const parts = body.split(/<((?:\d+:)?\d+:\d{2}\.\d{3})>/);
    const line = { start, end, text: '', words: null, voice: voiceTag ? voiceTag[1].trim() : null };
    if (parts.length === 1) { line.text = stripTags(body); return line; }
    line.words = [];
    let at = start;
    for (let i = 0; i < parts.length; i += 2) {
        const t = stripTags(parts[i]);
        if (t) line.words.push({ start: at, end: null, text: t });
        if (i + 1 < parts.length) at = clockTime(parts[i + 1]);
    }
    return line;
}

function parseVttLyrics(text) {
    const lines = [];
    for (const block of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
        const rows = block.split('\n');
        const i = rows.findIndex(l => l.includes('-->'));
        if (i < 0 || /^(NOTE|STYLE|REGION)\b/.test(rows[0])) continue;
        const [a, b] = rows[i].split('-->');
        const start = clockTime(a), end = clockTime((b || '').trim().split(/\s+/)[0] || '');
        if (start === null || end === null) continue;
        lines.push(vttCue(start, end, rows.slice(i + 1).join('\n')));
    }
    return lines.length ? finish(lines) : null;
}

// --- ASS / SSA ---

function assFields(text) {
    const out = { styles: {}, events: [], meta: {} };
    let format = null, section = '';
    for (const line of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
        const s = /^\s*\[([^\]]+)\]/.exec(line);
        if (s) { section = s[1].toLowerCase(); format = null; continue; }
        const m = /^(\w+):\s*(.*)$/.exec(line);
        if (!m) continue;
        if (section === 'script info') {
            if (m[1] === 'Title') out.meta.title = m[2].trim();
            continue;
        }
        if (m[1] === 'Format') { format = m[2].split(',').map(x => x.trim().toLowerCase()); continue; }
        if (!format || (m[1] !== 'Dialogue' && m[1] !== 'Comment')) continue;
        const parts = m[2].split(',');
        const fields = parts.slice(0, format.length - 1).concat(parts.slice(format.length - 1).join(','));
        const get = k => (fields[format.indexOf(k)] || '').trim();
        out.events.push({ kind: m[1], start: clockTime(get('start')), end: clockTime(get('end')), style: get('style'), name: get('name'), effect: get('effect'), text: fields[format.indexOf('text')] || '' });
    }
    return out;
}

// One dialogue line: its text, and its syllables when it has \k tags
function assLine(ev) {
    const words = [];
    let at = ev.start, pending = null, text = '', timed = false, drawing = false;
    const clean = s => s.replace(/\\N/g, '\n').replace(/\\n/g, ' ').replace(/\\h/g, ' ');
    for (const piece of ev.text.split(/(\{[^}]*\})/)) {
        if (piece.startsWith('{') && piece.endsWith('}')) {
            // \k<cs> (sung at once), \kf / \K (filled across), \ko (outlined), \kt<cs> (from the line's start)
            const re = /\\(kf|ko|kt|k|K)(\d+(?:\.\d+)?)/g;
            const p = /\\p(\d+)/.exec(piece);
            if (p) drawing = +p[1] > 0;
            let m;
            while ((m = re.exec(piece))) {
                timed = true;
                const cs = +m[2] / 100;
                if (m[1] === 'kt') { at = ev.start + cs; continue; }
                pending = { start: at, end: at + cs, text: '', fill: m[1] === 'kf' || m[1] === 'K' ? 'sweep' : 'step' };
                words.push(pending);
                at += cs;
            }
            continue;
        }
        if (drawing) continue;
        const t = clean(piece);
        text += t;
        if (pending) pending.text += t;
        else if (t) words.push({ start: ev.start, end: ev.start, text: t, fill: 'step' });
    }
    return { start: ev.start, end: ev.end, text, words: timed ? words : null, voice: ev.name || null, style: ev.style };
}

function parseAssLyrics(text) {
    const { events, meta } = assFields(text);
    // Karaoke templater scripts: their syllables in "karaoke" comments, the
    // dialogue made from them ("fx") repeats each one; the comments are the lyrics
    const kara = events.filter(e => e.kind === 'Comment' && /karaoke/i.test(e.effect) && /\\k/i.test(e.text));
    const used = kara.length ? kara : events.filter(e => e.kind === 'Dialogue' && !/^fx$/i.test(e.effect));
    const lines = used.filter(e => e.start !== null && e.end !== null && e.end > e.start).map(assLine);
    return lines.length ? finish(lines, meta) : null;
}

// --- TTML ---

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unescapeXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (XML_ENTITIES[e] ?? m));

// A small XML reader: { name (without prefix), attrs (local names too), children: (node | string)[] }
function parseXml(text) {
    const root = { name: '#root', attrs: {}, children: [] };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
    let m;
    while ((m = re.exec(text))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) top.children.push(m[1]);
        else if (m[2]) {
            const local = m[2].replace(/^.*:/, '');
            for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === local) { stack.length = i; break; }
        } else if (m[3]) {
            const attrs = {};
            const ar = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
            let a;
            while ((a = ar.exec(m[4]))) {
                const v = unescapeXml(a[2] !== undefined ? a[2] : a[3]);
                attrs[a[1]] = v;
                const local = a[1].replace(/^.*:/, '');
                if (!(local in attrs)) attrs[local] = v;
            }
            const node = { name: m[3].replace(/^.*:/, ''), qname: m[3], attrs, children: [] };
            top.children.push(node);
            if (!m[5]) stack.push(node);
        } else if (m[6] !== undefined) top.children.push(unescapeXml(m[6]));
    }
    return root;
}

const find = (node, name) => {
    if (typeof node === 'string') return null;
    if (node.name === name) return node;
    for (const c of node.children) { const f = find(c, name); if (f) return f; }
    return null;
};

// TTML's times: clock ("00:01:02.345", "00:01:02:12" frames, and Apple's "1:02.345"), or offsets ("1.5s", "120ms", "40f", "100t")
function ttmlTime(s, rates) {
    if (!s) return null;
    s = s.trim();
    let m = /^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/.exec(s);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / rates.frame;
    m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (m) return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3];
    m = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)?$/.exec(s);
    if (!m) return null;
    const v = +m[1];
    return { h: v * 3600, m: v * 60, s: v, ms: v / 1000, f: v / rates.frame, t: v / rates.tick }[m[2] || 's'];
}

// Text of a node and its descendants
// (a note in it is not part of it)
const textOf = n => typeof n === 'string' ? n : n.name === 'note' ? '' : n.children.map(textOf).join('');
// TTML's whitespace: runs of it are one space
const squeeze = t => t.replace(/\s+/g, ' ');

// Apple Music's and AMLL's TTML (amll.dev/en/guides/lyric/ttml), and plain TTML. Besides the
// timed lines and words, kept for the player:
// - translations and romanizations, inline (<span ttm:role="x-translation|x-roman" xml:lang>)
//   or in <head><iTunesMetadata> (<translation|transliteration><text for="L1">, the line's
//   itunes:key), plain or timed word by word: line.extras [{ kind, lang, text, words }]
// - ruby (<span tts:ruby="container"> with a base and timed text spans): word.ruby [{ text, start, end }];
//   a word made of containers and text (furigana over its kanji): each part also has
//   base, the characters it reads, and seg, which container it came from
// - word ids (xml:id), for annotations about them, and itunes:song-part on a div: line.part
// - language-learning annotations in a foreign namespace, linked to words by id:
//   <annotations><word ref="w1" lemma pos difficulty sense><meaning xml:lang>…</meaning>
//   <grammar>…</grammar><morpheme form meaning/></word></annotations> (docs/lyrics.md)
// - which sung words go with which translation words: TEI's corresp and link (alignment())
// - notes (TEI's <note type="translator" resp target>): in a line or its translation
//   (line.notes), or pointing at a line or a word from anywhere (lyrics.notes { id: [notes] })
// The result also lists the extras there are (lyrics.extras [{ kind, lang }]) and has
// lyrics.annotations { id: { lemma, pos, … } } and lyrics.links { id: [ids] }. Untimed
// translation words with ids are kept as extra.parts [{ text, id }].
function parseTtml(text) {
    const doc = parseXml(text);
    const tt = find(doc, 'tt');
    if (!tt) return null;
    const frame = (+tt.attrs.frameRate || 30) * ratio(tt.attrs.frameRateMultiplier);
    const rates = { frame, tick: +tt.attrs.tickRate || frame || 1 };
    const body = find(tt, 'body');
    if (!body) return null;
    const meta = {};
    const title = find(tt, 'title');
    if (title) meta.title = textOf(title).trim();
    // Agents: the first person sings on the left, the others on the right; a group is everyone
    const agents = {};
    const head = find(tt, 'head');
    const sidecar = []; // { kind, lang, key, node }
    const annotations = {};
    if (head) {
        const collect = n => {
            if (typeof n === 'string') return;
            if (n.name === 'agent' && n.attrs.id) agents[n.attrs.id] = n.attrs.type || 'person';
            // AMLL's metadata
            if (n.name === 'meta' && n.attrs.key && n.attrs.value) {
                const k = { musicName: 'title', artists: 'artist', album: 'album', isrc: 'isrc' }[n.attrs.key];
                if (k && !meta[k]) meta[k] = n.attrs.value;
            }
            if (n.name === 'translation' || n.name === 'transliteration') {
                const kind = n.name === 'translation' ? 'translation' : 'roman';
                for (const t of n.children) {
                    if (typeof t !== 'string' && t.name === 'text' && t.attrs.for) sidecar.push({ kind, lang: n.attrs.lang || '', key: t.attrs.for, node: t });
                }
            }
            if (n.name === 'annotations') {
                for (const w of n.children) if (typeof w !== 'string' && w.name === 'word' && w.attrs.ref) annotations[w.attrs.ref] = annotation(w);
                return;
            }
            n.children.forEach(collect);
        };
        collect(head);
    }
    const voices = {};
    const voiceOf = id => {
        if (!id) return null;
        if (agents[id] === 'group') return 'group';
        if (!(id in voices)) voices[id] = `v${Object.keys(voices).length + 1}`;
        return voices[id];
    };
    const lines = [];
    const kinds = []; // the extras there are, in order: { kind, lang }
    const noteKind = (kind, lang) => { if (!kinds.some(k => k.kind === kind && k.lang === lang)) kinds.push({ kind, lang }); };
    // Times of a child: relative to its parent's begin, as TTML says, unless (as
    // Apple Music writes them) they are on the document's clock already
    const span = (b, e, dur, base, parentEnd) => {
        let start = ttmlTime(b, rates), end = ttmlTime(e, rates);
        const d = ttmlTime(dur, rates);
        if (start !== null && base && start < base - 0.01) { start += base; if (end !== null) end += base; }
        if (start === null) start = base;
        if (end === null) end = d !== null ? start + d : parentEnd;
        return { start, end };
    };
    // The words in a node: { start, end, text, untimed, bg, id, ruby }; translations and
    // romanizations met on the way go to extras
    const walkText = (node, base, end, words, bg, extras) => {
        for (const c of node.children) {
            if (typeof c === 'string') {
                const t = squeeze(c);
                if (!t) continue;
                if (words.length && !t.trim()) { words[words.length - 1].text += ' '; continue; }
                if (t.trim()) words.push({ start: base, end, text: t, untimed: true, bg });
                continue;
            }
            if (c.name === 'br') { if (words.length) words[words.length - 1].text += '\n'; continue; }
            if (c.name !== 'span') continue;
            const role = c.attrs.role;
            if (role === 'x-translation' || role === 'x-roman') {
                if (extras) extras.push({ kind: role === 'x-roman' ? 'roman' : 'translation', lang: c.attrs.lang || '', node: c, base, end, bg });
                continue;
            }
            const isBg = bg || role === 'x-bg';
            const t = span(c.attrs.begin, c.attrs.end, c.attrs.dur, base, end);
            // A ruby container's base text, and its reading's parts
            const readingOf = (box, ruby) => {
                let baseText = '';
                const each = n => {
                    if (typeof n === 'string') return;
                    if (n.attrs.ruby === 'base') baseText += textOf(n);
                    else if (n.attrs.ruby === 'text') {
                        const rt = span(n.attrs.begin, n.attrs.end, n.attrs.dur, t.start, t.end);
                        ruby.push({ text: squeeze(textOf(n)).trim(), start: rt.start, end: rt.end, timed: n.attrs.begin != null });
                    } else n.children.forEach(each);
                };
                box.children.forEach(each);
                return baseText;
            };
            const kids = c.children.filter(k => typeof k !== 'string' && k.name === 'span');
            if (kids.length && kids.every(k => k.attrs.ruby === 'container')) {
                // A word with readings over some of its characters (furigana over the kanji):
                // each part of a reading knows the text it sits on (base) and its run (seg)
                const ruby = [];
                let text = '';
                c.children.forEach((k, seg) => {
                    if (typeof k === 'string') { text += k; return; }
                    if (k.name !== 'span') return;
                    const from = ruby.length, base = readingOf(k, ruby);
                    text += base;
                    for (const r of ruby.slice(from)) Object.assign(r, { base, seg });
                });
                const txt = squeeze(text);
                if (txt) words.push({ start: t.start, end: t.end, text: txt, untimed: c.attrs.begin == null, bg: isBg, id: c.attrs.id, ruby: ruby.map(({ timed, ...r }) => r) });
                continue;
            }
            if (c.attrs.ruby === 'container') {
                // A word and its reading above it, the reading timed in parts
                const ruby = [];
                const baseText = readingOf(c, ruby);
                const timedRuby = ruby.filter(r => r.timed);
                const untimed = c.attrs.begin == null && !timedRuby.length;
                const start = c.attrs.begin != null || !timedRuby.length ? t.start : Math.min(...timedRuby.map(r => r.start));
                const stop = c.attrs.end != null || !timedRuby.length ? t.end : Math.max(...timedRuby.map(r => r.end));
                if (baseText) words.push({ start, end: stop, text: squeeze(baseText), untimed, bg: isBg, id: c.attrs.id, ruby: ruby.map(({ timed, ...r }) => r) });
                continue;
            }
            const timedKids = c.children.some(k => typeof k !== 'string' && k.name === 'span');
            const notes = inlineNotes(c, {});
            if (timedKids || (c.attrs.begin == null && c.children.some(k => typeof k !== 'string' && k.name !== 'note'))) walkText(c, t.start, t.end, words, isBg, extras);
            else {
                const txt = squeeze(textOf(c));
                if (txt) words.push({ start: t.start, end: t.end, text: txt, untimed: c.attrs.begin == null, bg: isBg, id: c.attrs.id, notes: notes.length ? notes : undefined });
            }
        }
    };
    // Words → a line's words: untimed text among timed words (a styled span, punctuation)
    // goes with the word before it; null when none is timed
    const tidy = (ws, timed) => {
        if (timed) ws = ws.reduce((out, w) => {
            if (!w.untimed) out.push({ ...w });
            else if (out.length) out[out.length - 1].text += w.text;
            else out.lead = (out.lead || '') + w.text;
            return out;
        }, []);
        if (ws.lead && ws.length) ws[0].text = ws.lead + ws[0].text;
        if (!ws.length) return ws;
        ws[ws.length - 1].text = ws[ws.length - 1].text.replace(/\s+$/, '');
        ws[0].text = ws[0].text.replace(/^\s+/, '');
        return ws;
    };
    const wordOf = w => {
        const out = { start: w.start, end: w.end, text: w.text };
        if (w.id) out.id = w.id;
        if (w.ruby && w.ruby.length) out.ruby = w.ruby;
        if (w.notes) out.notes = w.notes;
        return out;
    };
    // A translation or romanization: its text, and its words when they are timed
    const extraOf = (x, base, end) => {
        const ws = [];
        walkText(x.node, base, end, ws, false, null);
        const main = ws.filter(w => !w.bg), back = ws.filter(w => w.bg);
        const make = list => {
            const timed = list.some(w => !w.untimed);
            const tidied = tidy(list, timed);
            const text = tidied.map(w => w.text).join('').replace(/[ \t]+$/gm, '').trim();
            if (!text) return null;
            const out = { kind: x.kind, lang: x.lang, text, words: timed ? tidied.map(wordOf) : null };
            // Untimed words with ids, for alignment with the sung ones
            if (!timed && tidied.some(w => w.id || w.notes)) out.parts = tidied.map(w => Object.assign({ text: w.text }, w.id && { id: w.id }, w.notes && { notes: w.notes }));
            return out;
        };
        return { main: make(x.bg ? ws : main), back: x.bg ? null : make(back) };
    };
    const byKey = {};
    const walk = (node, base, end, agent, part) => {
        for (const c of node.children) {
            if (typeof c === 'string') continue;
            const t = span(c.attrs.begin, c.attrs.end, c.attrs.dur, base, end);
            const who = c.attrs.agent || agent;
            if (c.name === 'p') {
                const words = [], extras = [];
                walkText(c, t.start, t.end, words, false, extras);
                if (!words.length) continue;
                const timed = words.some(w => !w.untimed);
                const main = words.filter(w => !w.bg), back = words.filter(w => w.bg);
                const made = {};
                const make = (ws, bg) => {
                    ws = tidy(ws, timed);
                    if (!ws.length) return;
                    const line = {
                        start: timed ? Math.min(...ws.map(w => w.start)) : t.start, end: timed ? Math.max(...ws.map(w => w.end ?? t.end)) : t.end,
                        text: ws.map(w => w.text).join(''), words: timed ? ws.map(wordOf) : null,
                        voice: voiceOf(who), bg,
                    };
                    // Untimed words with ids, notes or readings: kept for their cards and alignment
                    if (!timed && ws.some(w => w.id || w.notes || (w.ruby && w.ruby.length))) line.parts = ws.map(w => Object.assign({ text: w.text }, w.id && { id: w.id }, w.notes && { notes: w.notes }, w.ruby && w.ruby.length && { ruby: w.ruby.map(r => Object.assign({ text: r.text }, r.base && { base: r.base, seg: r.seg })) }));
                    if (part) { line.part = part; part = null; }
                    lines.push(line);
                    made[bg ? 'back' : 'main'] = line;
                };
                make(main.length ? main : back, !main.length);
                if (main.length) make(back, true);
                if (!made.main && made.back) made.main = made.back;
                for (const x of extras) {
                    const e = extraOf(x, t.start, t.end);
                    const target = x.bg ? made.back || made.main : made.main;
                    if (e.main) (target.extras = target.extras || []).push(e.main), noteKind(x.kind, x.lang);
                    if (e.back && made.back) (made.back.extras = made.back.extras || []).push(e.back);
                }
                // Notes in the line, and in its translations (the translator's, in their language)
                const notes = inlineNotes(c, {});
                for (const x of extras) if (!x.bg) notes.push(...inlineNotes(x.node, { type: x.kind === 'translation' ? 'translator' : '', lang: x.lang }));
                if (notes.length) made.main.notes = notes;
                if (c.attrs.key) byKey[c.attrs.key] = made;
                if (c.attrs.id) byKey[c.attrs.id] = made;
            } else walk(c, t.start, t.end, who, c.attrs['song-part'] || c.attrs.songPart || null);
        }
    };
    walk(body, 0, null, null, null);
    if (!lines.length) return null;
    // Translations and romanizations in the head, for the lines with those keys
    for (const x of sidecar) {
        const made = byKey[x.key];
        if (!made) continue;
        const e = extraOf(x, made.main.start, made.main.end);
        const notes = inlineNotes(x.node, { type: x.kind === 'translation' ? 'translator' : '', lang: x.lang });
        if (notes.length) (made.main.notes = made.main.notes || []).push(...notes);
        // A language given inline too is shown once
        const has = (l, k) => l && l.extras && l.extras.some(y => y.kind === k.kind && y.lang === k.lang);
        if (e.main && !has(made.main, e.main)) (made.main.extras = made.main.extras || []).push(e.main), noteKind(x.kind, x.lang);
        if (e.back && made.back && made.back !== made.main && !has(made.back, e.back)) (made.back.extras = made.back.extras || []).push(e.back);
    }
    // Background vocals ("(ooh)") sung in their brackets, mostly written so already
    for (const l of lines) if (l.bg && l.words) {
        const first = l.words[0], last = l.words[l.words.length - 1];
        if (!/^\(/.test(first.text)) { first.text = '(' + first.text; last.text += ')'; }
    }
    const out = finish(lines, meta);
    if (tt.attrs.lang) out.lang = tt.attrs.lang;
    if (kinds.length) out.extras = kinds;
    if (Object.keys(annotations).length) out.annotations = annotations;
    const links = alignment(doc);
    if (Object.keys(links).length) out.links = links;
    // Notes pointing at lines (their xml:id or itunes:key) or at words (their xml:id)
    const wordNotes = {};
    const each = n => {
        if (typeof n === 'string') return;
        if (n.name === 'note' && n.attrs.target) {
            const note = noteOf(n, {}, doc);
            for (const id of n.attrs.target.split(/\s+/).filter(x => x.startsWith('#')).map(x => x.slice(1))) {
                const line = byKey[id] && byKey[id].main;
                if (line) (line.notes = line.notes || []).push(note);
                else (wordNotes[id] = wordNotes[id] || []).push(note);
            }
            return;
        }
        n.children.forEach(each);
    };
    each(doc);
    if (Object.keys(wordNotes).length) out.notes = wordNotes;
    return out;
}

// Notes (TEI's <note type resp target>, any namespace): { text, type, resp, lang }. Who
// wrote one (resp="#tr1") is named by the element with that id, if there is one.
function noteOf(n, defaults, doc) {
    const text = squeeze(n.children.map(c => typeof c === 'string' ? c : textOf(c)).join('')).trim();
    let resp = n.attrs.resp || '';
    if (resp.startsWith('#') && doc) {
        const id = resp.slice(1);
        const find = x => typeof x === 'string' ? null : x.attrs.id === id ? x : x.children.reduce((f, c) => f || find(c), null);
        const who = find(doc);
        resp = who ? squeeze(textOf(who)).trim() || id : id;
    }
    return { text, type: n.attrs.type || defaults.type || '', resp, lang: n.attrs.lang || defaults.lang || '' };
}
// The notes directly in a line or a translation, not pointing elsewhere
const inlineNotes = (node, defaults) => node.children
    .filter(c => typeof c !== 'string' && c.name === 'note' && !c.attrs.target)
    .map(c => noteOf(c, defaults, null))
    .filter(n => n.text);

// Which words go with which (TEI P5's alignment, tei-c.org/release/doc/tei-p5-doc/en/html/SA.html):
// corresp="#en1 #en2" on an element with an xml:id, and <linkGrp><link target="#w1 #en2"/>,
// each in any namespace. Both ways: { id: [ids] }
function alignment(doc) {
    const links = {};
    const join = ids => {
        ids = [...new Set(ids)];
        for (const a of ids) for (const b of ids) if (a !== b) {
            const l = links[a] = links[a] || [];
            if (!l.includes(b)) l.push(b);
        }
    };
    const ids = v => (v || '').split(/\s+/).filter(x => x.startsWith('#')).map(x => x.slice(1));
    const each = n => {
        if (typeof n === 'string') return;
        if (n.attrs.corresp && n.attrs.id) for (const to of ids(n.attrs.corresp)) join([n.attrs.id, to]);
        if (n.name === 'link' && n.attrs.target) join(ids(n.attrs.target));
        n.children.forEach(each);
    };
    each(doc);
    return links;
}

// A word's annotation: <word ref lemma pos difficulty sense> with <meaning xml:lang>,
// <grammar>, <morpheme form meaning> (and lemma, pos, … as elements too)
function annotation(w) {
    const a = {};
    for (const k of ['lemma', 'pos', 'difficulty', 'sense']) if (w.attrs[k]) a[k] = w.attrs[k];
    const meanings = [], grammar = [], morphemes = [];
    for (const c of w.children) {
        if (typeof c === 'string') continue;
        const t = squeeze(textOf(c)).trim();
        if (c.name === 'meaning') { if (t) meanings.push({ lang: c.attrs.lang || '', text: t }); }
        else if (c.name === 'grammar') { if (t) grammar.push(t); }
        else if (c.name === 'morpheme') morphemes.push({ form: c.attrs.form || t, meaning: c.attrs.meaning || (c.attrs.form ? t : '') });
        else if (['lemma', 'pos', 'difficulty', 'sense'].includes(c.name) && t) a[c.name] = t;
    }
    if (meanings.length) a.meanings = meanings;
    if (grammar.length) a.grammar = grammar;
    if (morphemes.length) a.morphemes = morphemes;
    return a;
}

// "1000 1001" → 1000/1001
function ratio(s) {
    const m = /^(\d+)\s+(\d+)$/.exec((s || '').trim());
    return m ? +m[1] / +m[2] : 1;
}

// --- Musixmatch ---

// richsync_body: [{ ts, te, l: [{ c: text, o: seconds from ts }], x: the line }]
function parseRichsync(body) {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    const lines = [];
    for (const line of data) {
        const words = [];
        line.l.forEach((w, i) => {
            if (!w.c) return;
            if (!w.c.trim() && words.length) { words[words.length - 1].text += w.c; return; }
            const next = line.l.slice(i + 1).find(n => n.c && n.c.trim());
            words.push({ start: line.ts + w.o, end: next ? line.ts + next.o : line.te, text: w.c });
        });
        lines.push({ start: line.ts, end: line.te, text: line.x, words: words.length ? words : null });
    }
    return lines.length ? finish(lines) : null;
}

// subtitle_body in Musixmatch's own format: [{ text, time: { total } }]
function parseMxmSubtitle(body) {
    const data = typeof body === 'string' ? JSON.parse(body) : body;
    const lines = data.map(x => ({ start: x.time.total, end: null, text: x.text, words: null }));
    return lines.length ? finish(lines) : null;
}

// --- Any lyrics text ---

// A lyrics file's (or tag's) text → lyrics, or null; the name says what it is when it has one
function parseLyrics(text, name = '') {
    text = text.replace(/^﻿/, '');
    const ext = (/\.([^.]+)$/.exec(name) || [])[1];
    const lower = ext ? ext.toLowerCase() : '';
    if (lower === 'ass' || lower === 'ssa' || /^\s*\[Script Info\]/i.test(text)) return parseAssLyrics(text);
    if (lower === 'ttml' || /^\s*(<\?xml[^>]*>\s*)?<(\w+:)?tt[\s>]/.test(text)) return parseTtml(text);
    if (lower === 'vtt' || /^WEBVTT/.test(text)) return parseVttLyrics(text);
    if (lower === 'srt' || /^\s*\d+\s*\n\s*\d+:\d+:\d+[,.]\d+\s*-->/.test(text)) return parseSrtLyrics(text);
    if (/^\s*\[\{"/.test(text)) {
        try { const d = JSON.parse(text); return d[0] && d[0].l ? parseRichsync(d) : parseMxmSubtitle(d); } catch { /* not JSON */ }
    }
    const lrc = parseLrc(text);
    if (lrc) return lrc;
    if (lower === 'lrc' || lower === 'elrc' || !name) return text.trim() ? plain(text) : null;
    return null;
}

// How good lyrics are, to pick among several: word times, then line times, then words only
const rank = l => !l || !l.lines.length ? 0 : !l.synced ? 1 : l.lines.some(x => x.words) ? 3 : 2;

// --- Text in tags ---

function decodeLatin1(b) { let s = ''; for (const x of b) s += String.fromCharCode(x); return s; }
function decodeId3(b, enc) {
    if (enc === 0) return decodeLatin1(b);
    if (enc === 3) return new TextDecoder().decode(b);
    if (enc === 1 && b.length >= 2) {
        if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
        if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
        return new TextDecoder('utf-16le').decode(b);
    }
    return new TextDecoder(enc === 2 ? 'utf-16be' : 'utf-16le').decode(b);
}
// A terminated string at b[p] in encoding enc: [text, the position after its terminator]
function id3String(b, p, enc) {
    const wide = enc === 1 || enc === 2;
    let q = p;
    if (wide) { while (q + 1 < b.length && (b[q] || b[q + 1])) q += 2; } else { while (q < b.length && b[q]) q++; }
    return [decodeId3(b.subarray(p, q), enc), Math.min(b.length, q + (wide ? 2 : 1))];
}

// --- ID3v2 ---

const syncsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];
const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const le32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const unsync = b => {
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0) i++; }
    return out.subarray(0, n);
};

// The size of an ID3v2 tag at the start of b (header and footer included), or 0
function id3Size(b) {
    if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
    return 10 + syncsafe(b, 6) + (b[5] & 0x10 ? 10 : 0);
}

// An ID3v2 tag's frames: { id, data }
function id3Frames(tag) {
    const major = tag[3], flags = tag[5];
    let body = tag.subarray(10, 10 + syncsafe(tag, 6));
    if (major < 4 && flags & 0x80) body = unsync(body);
    let p = 0;
    if (flags & 0x40) p = major === 3 ? 4 + be32(body, 0) : syncsafe(body, 0);
    const frames = [];
    const idLen = major === 2 ? 3 : 4, headLen = major === 2 ? 6 : 10;
    while (p + headLen <= body.length) {
        const id = decodeLatin1(body.subarray(p, p + idLen));
        if (!/^[A-Z0-9]+$/.test(id)) break;
        let size = major === 2 ? (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5] : major === 4 ? syncsafe(body, p + 4) : be32(body, p + 4);
        // Some taggers wrote 2.4 frame sizes as plain integers
        if (major === 4 && size > 0x7f) {
            const plainSize = be32(body, p + 4), at = p + headLen + plainSize;
            const okSafe = /^[A-Z0-9]{4}$/.test(decodeLatin1(body.subarray(p + headLen + size, p + headLen + size + 4))) || p + headLen + size === body.length;
            const okPlain = /^[A-Z0-9]{4}$/.test(decodeLatin1(body.subarray(at, at + 4))) || at === body.length;
            if (!okSafe && okPlain) size = plainSize;
        }
        const fflags = major === 2 ? 0 : (body[p + 8] << 8) | body[p + 9];
        let data = body.subarray(p + headLen, p + headLen + size);
        p += headLen + size;
        // Compressed and encrypted frames are left out
        if (major === 3 && fflags & 0xc0) continue;
        if (major === 4) {
            if (fflags & 0x0c) continue;
            if (fflags & 0x01) data = data.subarray(4);
            if (fflags & 0x02 || flags & 0x80) data = unsync(data);
        }
        frames.push({ id, data });
    }
    return frames;
}

const ID3_ALIASES = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TXX: 'TXXX', ULT: 'USLT', SLT: 'SYLT', TRC: 'TSRC', TLE: 'TLEN' };

// An ID3v2 tag → { meta, sources: [{ label, meta, lyrics }] }; frameSeconds turns
// SYLT's MPEG-frame timestamps into seconds
function id3Lyrics(tag, frameSeconds) {
    const meta = {}, sources = [];
    for (const f of id3Frames(tag)) {
        const id = ID3_ALIASES[f.id] || f.id, d = f.data;
        if (!d.length) continue;
        const enc = d[0];
        if (id === 'TIT2' || id === 'TPE1' || id === 'TALB' || id === 'TSRC' || id === 'TLEN') {
            const v = decodeId3(d.subarray(1), enc).replace(/\0+$/, '').split('\0')[0].trim();
            if (id === 'TIT2') meta.title = v;
            else if (id === 'TPE1') meta.artist = v;
            else if (id === 'TALB') meta.album = v;
            else if (id === 'TSRC') meta.isrc = v;
            else if (+v) meta.duration = +v / 1000;
        } else if (id === 'USLT') {
            const lang = decodeLatin1(d.subarray(1, 4));
            const [desc, p] = id3String(d, 4, enc);
            const text = decodeId3(d.subarray(p), enc).replace(/\0+$/, '');
            const lyrics = parseLyrics(text);
            if (lyrics) sources.push({ label: `ID3 lyrics${desc ? ` — ${desc}` : ''}`, language: lang, meta: lyrics.synced ? 'USLT (LRC)' : 'USLT', lyrics });
        } else if (id === 'SYLT') {
            const lang = decodeLatin1(d.subarray(1, 4));
            const format = d[4], type = d[5];
            let [desc, p] = id3String(d, 6, enc);
            const entries = [];
            while (p < d.length) {
                const [text, q] = id3String(d, p, enc);
                if (q + 4 > d.length) break;
                const stamp = be32(d, q);
                entries.push({ text, time: format === 1 ? stamp * (frameSeconds || 1152 / 44100) : stamp / 1000 });
                p = q + 4;
            }
            const lyrics = syltLines(entries);
            if (lyrics) sources.push({ label: `ID3 synced lyrics${desc ? ` — ${desc}` : ''}${type !== 1 && SYLT_TYPES[type] ? ` (${SYLT_TYPES[type]})` : ''}`, language: lang, meta: 'SYLT', lyrics });
        } else if (id === 'TXXX') {
            const [desc, p] = id3String(d, 1, enc);
            if (!/lyric/i.test(desc)) continue;
            const lyrics = parseLyrics(decodeId3(d.subarray(p), enc).replace(/\0+$/, ''));
            if (lyrics) sources.push({ label: `ID3 ${desc}`, meta: 'TXXX', lyrics });
        }
    }
    return { meta, sources };
}
const SYLT_TYPES = { 0: 'other', 1: 'lyrics', 2: 'transcription', 3: 'movement', 4: 'events', 5: 'chord', 6: 'trivia', 7: 'web pages', 8: 'images' };

// SYLT entries → lines. Entries are syllables or words when some begin (or end) with
// a line break, each starting a line; otherwise each entry is a line.
function syltLines(entries) {
    entries = entries.filter(e => e.text !== undefined).sort((a, b) => a.time - b.time);
    if (!entries.length) return null;
    const syllables = entries.some(e => /[\r\n]/.test(e.text));
    if (!syllables) return finish(entries.filter(e => e.text.trim()).map(e => ({ start: e.time, end: null, text: e.text.trim(), words: null })));
    const lines = [];
    let cur = null, breakNext = true;
    for (const e of entries) {
        const lead = /^[\r\n]+/.test(e.text), trail = /[\r\n]+$/.test(e.text);
        const text = e.text.replace(/[\r\n]+/g, '');
        if (lead || breakNext || !cur) { cur = { start: e.time, end: null, text: '', words: [] }; lines.push(cur); }
        breakNext = trail;
        if (text) cur.words.push({ start: e.time, end: null, text });
        else if (cur.words.length && cur.words[cur.words.length - 1].end == null) cur.words[cur.words.length - 1].end = e.time;
    }
    for (const l of lines) {
        if (l.words.length) l.start = l.words[0].start;
        else l.words = null;
    }
    // A line's last syllable lasts until the next line begins, at most a few seconds
    lines.forEach((l, i) => {
        if (!l.words) return;
        const w = l.words[l.words.length - 1];
        if (w.end == null) w.end = Math.min(i + 1 < lines.length ? lines[i + 1].start : w.start + 2, w.start + 2);
    });
    return finish(lines);
}

// Seconds per MPEG audio frame, from the first frame header in b
function mpegFrameSeconds(b) {
    for (let i = 0; i + 4 <= b.length; i++) {
        if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
        const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, rateIndex = (b[i + 2] >> 2) & 3;
        if (version === 1 || layer === 0 || rateIndex === 3 || (b[i + 2] >> 4) === 15) continue;
        const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
        const samples = layer === 3 ? 384 : layer === 2 || version === 3 ? 1152 : 576;
        return samples / rate;
    }
    return null;
}

// --- Vorbis comments (FLAC, Ogg Vorbis, Opus) ---

function vorbisComments(b, p = 0) {
    const out = [];
    const vendorLen = le32(b, p);
    p += 4 + vendorLen;
    const count = le32(b, p);
    p += 4;
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
        const len = le32(b, p);
        p += 4;
        if (p + len > b.length) break;
        const s = new TextDecoder().decode(b.subarray(p, p + len));
        p += len;
        const eq = s.indexOf('=');
        if (eq > 0) out.push([s.slice(0, eq).toUpperCase(), s.slice(eq + 1)]);
    }
    return out;
}

function commentLyrics(comments) {
    const meta = {}, sources = [];
    for (const [k, v] of comments) {
        if (k === 'TITLE') meta.title = v;
        else if (k === 'ARTIST' && !meta.artist) meta.artist = v;
        else if (k === 'ALBUM') meta.album = v;
        else if (k === 'ISRC') meta.isrc = v;
        else if (/LYRICS/.test(k)) {
            const lyrics = parseLyrics(v);
            if (lyrics) sources.push({ label: k === 'LYRICS' ? 'Lyrics tag' : `${k[0]}${k.slice(1).toLowerCase()} tag`, meta: lyrics.synced ? `${k} (LRC)` : k, lyrics });
        }
    }
    return { meta, sources };
}

// --- Reading the audio file ---

// Reads of a URL, each range fetched once
function cachedReader(url) {
    const r = rangeReader(url), cache = new Map();
    return {
        size: r.size,
        read(start, end) {
            const k = start + ':' + end;
            if (!cache.has(k)) cache.set(k, r.read(start, end).catch(err => { cache.delete(k); throw err; }));
            return cache.get(k);
        },
    };
}

async function id3At(reader, offset, head) {
    const size = id3Size(head);
    if (!size) return null;
    const tag = await reader.read(offset, offset + size);
    const after = await reader.read(offset + size, offset + size + 4096).catch(() => new Uint8Array(0));
    return { size, ...id3Lyrics(tag, mpegFrameSeconds(after)) };
}

async function flacLyrics(reader, p) {
    for (let n = 0; n < 128; n++) {
        const h = await reader.read(p, p + 4);
        if (h.length < 4) break;
        const type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
        if (type === 4) return commentLyrics(vorbisComments(await reader.read(p + 4, p + 4 + len)));
        if (h[0] & 0x80) break;
        p += 4 + len;
    }
    return { meta: {}, sources: [] };
}

// The comment packet of an Ogg stream (the second packet of the first stream)
async function oggLyrics(reader) {
    const packets = [];
    let packet = [], serial = null, p = 0;
    while (packets.length < 2 && p < 32 * 1024 * 1024) {
        const h = await reader.read(p, p + 27);
        if (h.length < 27 || decodeLatin1(h.subarray(0, 4)) !== 'OggS') break;
        const n = h[26];
        const segs = await reader.read(p + 27, p + 27 + n);
        const bodyLen = segs.reduce((a, b) => a + b, 0);
        const body = await reader.read(p + 27 + n, p + 27 + n + bodyLen);
        const s = le32(h, 14);
        if (serial === null) serial = s;
        if (s === serial) {
            let q = 0;
            for (const len of segs) {
                packet.push(body.subarray(q, q + len));
                q += len;
                if (len < 255) {
                    const total = packet.reduce((a, b) => a + b.length, 0), joined = new Uint8Array(total);
                    let at = 0;
                    for (const x of packet) { joined.set(x, at); at += x.length; }
                    packets.push(joined);
                    packet = [];
                    if (packets.length === 2) break;
                }
            }
        }
        p += 27 + n + bodyLen;
    }
    const c = packets[1];
    if (!c) return { meta: {}, sources: [] };
    if (decodeLatin1(c.subarray(0, 7)) === '\x03vorbis') return commentLyrics(vorbisComments(c, 7));
    if (decodeLatin1(c.subarray(0, 8)) === 'OpusTags') return commentLyrics(vorbisComments(c, 8));
    return { meta: {}, sources: [] };
}

// WAV and AIFF: an ID3v2 tag in an "id3 " chunk
async function chunkId3(reader, little) {
    for (let p = 12, n = 0; n < 256; n++) {
        const h = await reader.read(p, p + 8);
        if (h.length < 8) break;
        const id = decodeLatin1(h.subarray(0, 4)), size = little ? le32(h, 4) : be32(h, 4);
        if (/^id3 $/i.test(id)) {
            const head = await reader.read(p + 8, p + 18);
            return await id3At(reader, p + 8, head);
        }
        p += 8 + size + (size & 1);
    }
    return null;
}

// MP4's iTunes tags: moov/udta/meta/ilst
const MP4_TAGS = { '©lyr': 'lyrics', '©nam': 'title', '©ART': 'artist', '©alb': 'album' };
async function mp4Lyrics(reader) {
    const meta = {}, sources = [];
    let moov = null;
    for (let p = 0, n = 0; n < 1024; n++) {
        const h = await reader.read(p, p + 16);
        if (h.length < 8) break;
        let size = be32(h, 0);
        if (size === 1) size = be32(h, 8) * 2 ** 32 + be32(h, 12);
        else if (size === 0) size = (reader.size() || p) - p;
        if (size < 8) break;
        if (decodeLatin1(h.subarray(4, 8)) === 'moov') { moov = await reader.read(p, p + size); break; }
        p += size;
    }
    if (moov) {
        const kids = (s, e) => {
            const out = [];
            for (let p = s; p + 8 <= e;) {
                const size = be32(moov, p);
                if (size < 8) break;
                out.push({ type: decodeLatin1(moov.subarray(p + 4, p + 8)), start: p + 8, end: Math.min(e, p + size) });
                p += size;
            }
            return out;
        };
        const udta = kids(8, moov.length).find(x => x.type === 'udta');
        const m = udta && kids(udta.start, udta.end).find(x => x.type === 'meta');
        if (m) {
            // meta is a full box (four bytes of version and flags) in MP4, not in QuickTime
            const start = be32(moov, m.start) === 0 ? m.start + 4 : m.start;
            const ilst = kids(start, m.end).find(x => x.type === 'ilst');
            for (const item of ilst ? kids(ilst.start, ilst.end) : []) {
                const kind = MP4_TAGS[item.type];
                const data = kids(item.start, item.end).find(x => x.type === 'data');
                if (!data) continue;
                let value = new TextDecoder().decode(moov.subarray(data.start + 8, data.end));
                if (item.type === '----') {
                    const name = kids(item.start, item.end).find(x => x.type === 'name');
                    const n = name ? new TextDecoder().decode(moov.subarray(name.start + 4, name.end)) : '';
                    if (n === 'ISRC') meta.isrc = value;
                    else if (/lyric/i.test(n)) { const lyrics = parseLyrics(value); if (lyrics) sources.push({ label: n, meta: 'iTunes tag', lyrics }); }
                    continue;
                }
                if (!kind) continue;
                if (kind === 'lyrics') {
                    const lyrics = parseLyrics(value);
                    if (lyrics) sources.push({ label: 'Lyrics tag', meta: lyrics.synced ? '©lyr (LRC)' : '©lyr', lyrics });
                } else meta[kind] = value;
            }
        }
    }
    // Text tracks: timed lines; TTML (stpp) lines or words
    try {
        const tracks = await mp4Tracks(reader);
        for (const t of tracks.filter(x => x.codec === 'stpp')) {
            sources.push({
                label: `Text track${t.language && t.language !== 'und' ? ` (${t.language})` : ''}`, meta: 'TTML', language: t.language,
                load: () => mp4Ttml(reader, t),
            });
        }
        for (const t of tracks.filter(x => x.format)) {
            sources.push({
                label: `Text track${t.language && t.language !== 'und' ? ` (${t.language})` : ''}`, meta: t.codec, language: t.language,
                load: async () => finish((await mp4Cues(reader, t)).map(c => c.vtt ? vttCue(c.start, c.end, c.text) : { start: c.start, end: c.end, text: stripTags(c.text), words: null })),
            });
        }
    } catch { /* no tracks */ }
    return { meta, sources };
}

// An MP4 TTML track: each sample a TTML document. Its times count from the start of the
// track (as ffmpeg writes them) or, when they fall before the sample, from the sample.
async function mp4Ttml(reader, track) {
    const lines = [], extras = [], annotations = {}, links = {};
    let meta = {};
    for (const s of track.samples.filter(x => x.size > 0)) {
        const doc = parseTtml(new TextDecoder().decode(await reader.read(s.offset, s.offset + s.size)));
        if (!doc) continue;
        meta = { ...doc.meta, ...meta };
        for (const k of doc.extras || []) if (!extras.some(x => x.kind === k.kind && x.lang === k.lang)) extras.push(k);
        Object.assign(annotations, doc.annotations);
        for (const [k, v] of Object.entries(doc.links || {})) links[k] = [...new Set([...(links[k] || []), ...v])];
        const first = Math.min(...doc.lines.map(l => l.start));
        const shift = first < s.time - 0.01 ? s.time : 0;
        for (const l of doc.lines) {
            const move = x => ({ ...x, start: x.start + shift, end: x.end == null ? x.end : x.end + shift });
            const moveWords = ws => ws && ws.map(w => ({ ...move(w), ruby: w.ruby && w.ruby.map(move) }));
            lines.push({ ...move(l), words: moveWords(l.words), extras: l.extras && l.extras.map(x => ({ ...x, words: moveWords(x.words) })) });
        }
    }
    if (!lines.length) return null;
    const out = finish(lines, meta);
    if (extras.length) out.extras = extras;
    if (Object.keys(annotations).length) out.annotations = annotations;
    if (Object.keys(links).length) out.links = links;
    return out;
}

// --- Matroska ---

const EBML_IDS = { Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac, Tags: 0x1254c367, Tag: 0x7373, Targets: 0x63c0, TargetTypeValue: 0x68ca, SimpleTag: 0x67c8, TagName: 0x45a3, TagString: 0x4487, TagLanguage: 0x447a, Cluster: 0x1f43b675, Info: 0x1549a966, Title: 0x7ba9 };

function ebmlVint(b, p, keepMarker) {
    if (p >= b.length) return null;
    let len = 1;
    while (len <= 8 && !(b[p] & (0x80 >> (len - 1)))) len++;
    if (len > 8 || p + len > b.length) return null;
    let v = keepMarker ? b[p] : b[p] & (0xff >> len), ones = v === (0xff >> len);
    for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) ones = false; }
    return { value: v, len, unknown: !keepMarker && ones };
}
function ebmlKids(b) {
    const out = [];
    for (let p = 0; p < b.length;) {
        const id = ebmlVint(b, p, true), size = id && ebmlVint(b, p + id.len, false);
        if (!size) break;
        const s = p + id.len + size.len, e = size.unknown ? b.length : Math.min(b.length, s + size.value);
        out.push({ id: id.value, data: b.subarray(s, e) });
        p = e;
    }
    return out;
}
const ebmlUint = b => { let v = 0; for (const x of b) v = v * 256 + x; return v; };

// Matroska's tags (found through the SeekHead, or among the first top-level elements),
// and the segment's title: { tags: [{ target, name, value, language }], title }
async function mkvTags(reader) {
    const out = [];
    let title = '';
    const head = await reader.read(0, 64);
    const ebml = ebmlVint(head, 0, true), ebmlSize = ebml && ebmlVint(head, ebml.len, false);
    if (!ebmlSize) return { tags: out, title };
    let p = ebml.len + ebmlSize.len + ebmlSize.value;
    const seg = await reader.read(p, p + 12);
    const sid = ebmlVint(seg, 0, true), ssize = sid && ebmlVint(seg, sid.len, false);
    if (!ssize || sid.value !== EBML_IDS.Segment) return { tags: out, title };
    const segStart = p + sid.len + ssize.len;
    const readElement = async at => {
        const h = await reader.read(at, at + 12);
        const id = ebmlVint(h, 0, true), size = id && ebmlVint(h, id.len, false);
        if (!size) return null;
        return { id: id.value, start: at + id.len + size.len, size: size.unknown ? null : size.value };
    };
    const tagsAt = [];
    let q = segStart;
    for (let n = 0; n < 64; n++) {
        const el = await readElement(q);
        if (!el || el.size === null) break;
        if (el.id === EBML_IDS.SeekHead) {
            for (const s of ebmlKids(await reader.read(el.start, el.start + el.size)).filter(x => x.id === EBML_IDS.Seek)) {
                const f = {};
                for (const c of ebmlKids(s.data)) f[c.id] = c.data;
                if (f[EBML_IDS.SeekID] && ebmlUint(f[EBML_IDS.SeekID]) === EBML_IDS.Tags && f[EBML_IDS.SeekPosition]) tagsAt.push(segStart + ebmlUint(f[EBML_IDS.SeekPosition]));
            }
        } else if (el.id === EBML_IDS.Info) {
            const t = ebmlKids(await reader.read(el.start, el.start + el.size)).find(x => x.id === EBML_IDS.Title);
            if (t) title = new TextDecoder().decode(t.data);
        } else if (el.id === EBML_IDS.Tags) tagsAt.push(q);
        else if (el.id === EBML_IDS.Cluster && tagsAt.length) break;
        q = el.start + el.size;
    }
    for (const at of [...new Set(tagsAt)]) {
        const el = await readElement(at);
        if (!el || el.id !== EBML_IDS.Tags || el.size === null || el.size > 16 * 1024 * 1024) continue;
        for (const tag of ebmlKids(await reader.read(el.start, el.start + el.size)).filter(x => x.id === EBML_IDS.Tag)) {
            let target = 50;
            const walk = (kids, prefix) => {
                for (const k of kids) {
                    if (k.id === EBML_IDS.Targets) {
                        const t = ebmlKids(k.data).find(x => x.id === EBML_IDS.TargetTypeValue);
                        if (t) target = ebmlUint(t.data);
                    } else if (k.id === EBML_IDS.SimpleTag) {
                        const f = {};
                        for (const c of ebmlKids(k.data)) f[c.id] = c.data;
                        const name = f[EBML_IDS.TagName] ? new TextDecoder().decode(f[EBML_IDS.TagName]).toUpperCase() : '';
                        if (f[EBML_IDS.TagString]) out.push({ target, name: prefix + name, value: new TextDecoder().decode(f[EBML_IDS.TagString]), language: f[EBML_IDS.TagLanguage] ? new TextDecoder().decode(f[EBML_IDS.TagLanguage]) : '' });
                        walk(ebmlKids(k.data).filter(c => c.id === EBML_IDS.SimpleTag), prefix + name + '/');
                    }
                }
            };
            walk(ebmlKids(tag.data), '');
        }
    }
    return { tags: out, title };
}

async function mkvLyrics(url, reader, onSource, onMeta) {
    const meta = {}, titles = {};
    try {
        const { tags, title } = await mkvTags(reader);
        if (title) titles.segment = title;
        for (const t of tags) {
            // Album-level (50) titles name the album; a track's (30) name the song
            if (t.name === 'TITLE') titles[t.target <= 30 ? 'track' : 'album'] = t.value;
            else if (t.name === 'ARTIST' && (!meta.artist || t.target <= 30)) meta.artist = t.value;
            else if (t.name === 'ISRC') meta.isrc = t.value;
            else if (/LYRICS/.test(t.name)) {
                const lyrics = parseLyrics(t.value);
                if (lyrics) onSource({ label: `Lyrics tag${t.language && t.language !== 'und' ? ` (${t.language})` : ''}`, language: t.language, meta: lyrics.synced ? 'LYRICS (LRC)' : 'LYRICS', lyrics });
            }
        }
    } catch { /* no tags */ }
    // Album-level (50) titles name the album, a track's (30) the song; a file with
    // only the first (as ffmpeg writes them) is the song's
    if (titles.track) { meta.title = titles.track; if (titles.album) meta.album = titles.album; } else meta.title = titles.album || titles.segment;
    onMeta(meta);
    // Subtitle tracks and attached lyrics files, in one pass over the file
    const scan = mkvScan(url, tracks => {
        for (const t of tracks) {
            onSource({
                label: `Track ${t.number}${t.name ? ` — ${t.name}` : ''}${t.language && t.language !== 'und' ? ` (${t.language})` : ''}`,
                language: t.language, meta: t.codec, unsupported: !t.format,
                load: () => scan.then(r => {
                    const track = r.tracks.find(x => x.number === t.number);
                    const content = mkvTrackContent(track);
                    return content.kind === 'ass' ? parseAssLyrics(content.ass) : parseVttLyrics(content.vtt);
                }),
            });
        }
    });
    const r = await scan;
    for (const a of r.attachments || []) {
        const lyrics = parseLyrics(new TextDecoder().decode(a.data), a.name);
        if (lyrics) onSource({ label: a.name, meta: 'attached', lyrics });
    }
    return { meta: {}, sources: [] };
}

// The lyrics inside an audio file and what it says it is: { meta, sources }, each
// source { label, meta, language, lyrics } or, read later, { …, load: () => Promise<lyrics> }.
// onSource and onMeta see what is found while the file is still read (Matroska's tracks).
async function readEmbeddedLyrics(url, { onSource = () => {}, onMeta = () => {} } = {}) {
    const reader = cachedReader(url);
    const head = await reader.read(0, 16);
    const magic = decodeLatin1(head.subarray(0, 4));
    const result = { meta: {}, sources: [] };
    const merge = r => { if (!r) return; Object.assign(result.meta, ...Object.entries(r.meta).filter(([, v]) => v).map(([k, v]) => ({ [k]: v }))); result.sources.push(...r.sources); };
    if (magic.startsWith('ID3')) {
        const id3 = await id3At(reader, 0, await reader.read(0, 10));
        if (!id3) return result;
        merge(id3);
        // FLAC with an ID3 tag before it
        const after = await reader.read(id3.size, id3.size + 4);
        if (decodeLatin1(after) === 'fLaC') merge(await flacLyrics(reader, id3.size + 4));
    } else if (magic === 'fLaC') merge(await flacLyrics(reader, 4));
    else if (magic === 'OggS') merge(await oggLyrics(reader));
    else if (magic === 'RIFF' && decodeLatin1(head.subarray(8, 12)) === 'WAVE') merge(await chunkId3(reader, true));
    else if (magic === 'FORM' && /^AIF[FC]$/.test(decodeLatin1(head.subarray(8, 12)))) merge(await chunkId3(reader, false));
    else if (be32(head, 0) === 0x1a45dfa3) merge(await mkvLyrics(url, reader, onSource, onMeta));
    else if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(decodeLatin1(head.subarray(4, 8)))) merge(await mp4Lyrics(reader));
    return result;
}

module.exports = {
    LYRICS_RE, parseLyrics, parseLrc, parseSrtLyrics, parseVttLyrics, parseAssLyrics, parseTtml, parseRichsync, parseMxmSubtitle,
    id3Lyrics, syltLines, vorbisComments, commentLyrics, readEmbeddedLyrics, rank, plain, parseXml,
};
