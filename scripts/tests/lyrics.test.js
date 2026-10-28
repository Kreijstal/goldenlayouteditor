// node --test scripts/tests/lyrics.test.js
// Fixtures: python3 scripts/lyrics-fixtures.py
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const L = require('../../src/lyrics');

const FIXTURES = path.join(__dirname, 'fixtures', 'lyrics');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg || ''} ${a} ≉ ${b}`);
const words = l => l.words.map(w => [w.text, +w.start.toFixed(2), +w.end.toFixed(2)]);

test('LRC: line times, repeated lines, offset, metadata', () => {
    const l = L.parseLrc('[ti:Song]\n[ar:Someone]\n[offset:500]\n[00:01.00][00:10.00]Chorus\n[00:05.50]Verse\n[00:12.00]\n');
    assert.equal(l.meta.title, 'Song');
    assert.equal(l.meta.artist, 'Someone');
    assert.deepEqual(l.lines.map(x => [x.text, x.start, x.end]), [['Chorus', 0.5, 5], ['Verse', 5, 9.5], ['Chorus', 9.5, 11.5]]);
});

test('enhanced LRC: word times, spacing, voices', () => {
    const l = L.parseLyrics('[00:01.00]v1: <00:01.00> Hel <00:01.50> lo <00:02.00> world <00:03.00>\n[00:04.00]v2:<00:04.00>Next<00:05.00>', 'a.elrc');
    assert.equal(l.lines[0].text, 'Hel lo world');
    assert.equal(l.lines[0].voice, 'v1');
    assert.deepEqual(words(l.lines[0]), [['Hel ', 1, 1.5], ['lo ', 1.5, 2], ['world', 2, 3]]);
    near(l.lines[0].end, 3);
    assert.equal(l.lines[1].voice, 'v2');
    assert.deepEqual(words(l.lines[1]), [['Next', 4, 5]]);
});

test('LRC with [mm:ss] word times after the text began (Musixmatch "custom" via orpheusdl)', () => {
    const l = L.parseLrc('[00:01.00]Hel<00:01.40>lo <00:02.00>you<00:02.50>');
    assert.deepEqual(words(l.lines[0]), [['Hel', 1, 1.4], ['lo ', 1.4, 2], ['you', 2, 2.5]]);
});

test('unsynced text stays as lines without times', () => {
    const l = L.parseLyrics('Just\nwords\n', 'a.lrc');
    assert.equal(l.synced, false);
    assert.deepEqual(l.lines.map(x => x.text), ['Just', 'words']);
});

test('SubRip and WebVTT, with WebVTT word timestamps and voices', () => {
    const srt = L.parseLyrics('1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nThere\n', 'a.srt');
    assert.deepEqual(srt.lines.map(x => [x.text, x.start, x.end]), [['Hello', 1, 2], ['There', 3, 4]]);
    const vtt = L.parseLyrics('WEBVTT\n\nNOTE skip me\n\n00:01.000 --> 00:03.000\n<v Singer>Hel<00:01.500>lo <00:02.000>world\n', 'a.vtt');
    assert.equal(vtt.lines[0].voice, 'Singer');
    assert.deepEqual(words(vtt.lines[0]), [['Hel', 1, 1.5], ['lo ', 1.5, 2], ['world', 2, 3]]);
});

test('ASS karaoke: \\k, \\kf, \\kt syllables; templater comments over fx lines; drawings left out', () => {
    const head = '[Script Info]\nTitle: Kara\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    const l = L.parseLyrics(head + 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,Alice,0,0,0,,{\\an8}{\\k50}Hel{\\kf50}lo{\\k0} {\\k100}world\\Nagain\n', 'a.ass');
    assert.equal(l.meta.title, 'Kara');
    assert.equal(l.lines[0].voice, 'Alice');
    assert.deepEqual(words(l.lines[0]), [['Hel', 1, 1.5], ['lo ', 1.5, 2], ['world\nagain', 2, 3]]);
    assert.equal(l.lines[0].words[1].fill, 'sweep');
    assert.equal(l.lines[0].words[0].fill, 'step');
    const kara = L.parseLyrics(head
        + 'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,karaoke,{\\k50}A{\\k50}B\n'
        + 'Dialogue: 0,0:00:01.00,0:00:01.50,Default,,0,0,0,fx,{\\pos(1,1)}A\n'
        + 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\n', 'a.ass');
    assert.deepEqual(kara.lines.map(x => x.text), ['AB']);
    const t = L.parseLyrics(head + 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\kt100\\k50}late\n', 'a.ass');
    assert.deepEqual(words(t.lines[0]), [['late', 2, 2.5]]);
});

test('TTML: Apple Music word spans, agents, background vocals, absolute times', () => {
    const ttml = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word">
<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>
<body dur="10.000"><div begin="1.000" end="9.000">
<p begin="1.000" end="3.000" ttm:agent="v1"><span begin="1.000" end="1.500">Hel</span><span begin="1.500" end="2.000">lo</span> <span begin="2.000" end="3.000">world</span><span ttm:role="x-bg"><span begin="2.200" end="2.800">(ooh)</span></span></p>
<p begin="4.000" end="5.000" ttm:agent="v2"><span begin="4.000" end="5.000">Rock&amp;roll</span></p>
</div></body></tt>`;
    const l = L.parseLyrics(ttml, 'a.ttml');
    assert.deepEqual(l.lines.map(x => [x.text, x.voice, !!x.bg]), [['Hello world', 'v1', false], ['(ooh)', 'v1', true], ['Rock&roll', 'v2', false]]);
    assert.deepEqual(words(l.lines[0]), [['Hel', 1, 1.5], ['lo ', 1.5, 2], ['world', 2, 3]]);
});

test('TTML: times relative to their parent, offset and clock forms, line timing', () => {
    const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" ttp:frameRate="25" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"><body><div>
<p begin="00:00:10.000" end="00:00:12:00"><span begin="0s" end="500ms">A</span><span begin="0.5s" dur="1s"> B</span></p>
<p begin="1:15.5" end="1:17">Line<br/>two</p></div></body></tt>`;
    const l = L.parseTtml(ttml);
    assert.deepEqual(words(l.lines[0]), [['A ', 10, 10.5], ['B', 10.5, 11.5]]);
    assert.deepEqual(l.lines.slice(1).map(x => [x.text, x.start, x.end, x.words]), [['Line\ntwo', 75.5, 77, null]]);
});

test('Musixmatch richsync and subtitles', () => {
    const rich = JSON.stringify([{ ts: 1, te: 3, x: 'Hello world', l: [{ c: 'Hello', o: 0 }, { c: ' ', o: 0.6 }, { c: 'world', o: 1 }] }]);
    const l = L.parseRichsync(rich);
    assert.deepEqual(words(l.lines[0]), [['Hello ', 1, 2], ['world', 2, 3]]);
    const s = L.parseMxmSubtitle([{ text: 'One', time: { total: 1.5 } }, { text: 'Two', time: { total: 4 } }]);
    assert.deepEqual(s.lines.map(x => [x.text, x.start, x.end]), [['One', 1.5, 4], ['Two', 4, 9]]);
});

test('SYLT: whole lines, and syllables split at line breaks', () => {
    assert.deepEqual(L.syltLines([{ text: 'A', time: 1 }, { text: 'B', time: 3 }]).lines.map(x => [x.text, x.start, x.end]), [['A', 1, 3], ['B', 3, 8]]);
    const l = L.syltLines([{ text: '\nHel', time: 1 }, { text: 'lo ', time: 1.5 }, { text: 'you', time: 2 }, { text: '\nNext', time: 4 }]);
    assert.deepEqual(l.lines.map(x => x.text), ['Hello you', 'Next']);
    assert.deepEqual(words(l.lines[0]), [['Hel', 1, 1.5], ['lo ', 1.5, 2], ['you', 2, 4]]);
});

// --- Inside audio files, read over HTTP with Range requests ---

let server, base;
const ranges = [];
before(async () => {
    server = http.createServer((req, res) => {
        const file = path.join(FIXTURES, path.basename(decodeURIComponent(req.url)));
        if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
        const data = fs.readFileSync(file);
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (!m) { res.setHeader('Content-Length', data.length); return res.end(data); }
        const start = +m[1], end = Math.min(data.length - 1, m[2] ? +m[2] : data.length - 1);
        ranges.push(end - start + 1);
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
        res.end(data.subarray(start, end + 1));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;
});
after(() => server.close());

async function embedded(name) {
    const found = [];
    const r = await L.readEmbeddedLyrics(base + name, { onSource: s => found.push(s), onMeta: m => Object.assign(found.meta = found.meta || {}, m) });
    const sources = [...found, ...r.sources];
    for (const s of sources) if (s.load) s.lyrics = await s.load();
    return { meta: { ...found.meta, ...r.meta }, sources };
}

test('MP3: ID3v2.4 SYLT syllables, USLT, title, artist, ISRC', async () => {
    const { meta, sources } = await embedded('sylt.mp3');
    assert.deepEqual(meta, { title: 'Fixture Song', artist: 'Fixture Artist', album: 'Fixture Album', isrc: 'USXXX2600001' });
    const sylt = sources.find(s => s.meta === 'SYLT');
    assert.equal(sylt.label, 'ID3 synced lyrics — karaoke');
    assert.deepEqual(sylt.lyrics.lines.map(x => x.text), ['Hello world', 'Second line']);
    assert.deepEqual(words(sylt.lyrics.lines[0]), [['Hel', 0.5, 0.8], ['lo ', 0.8, 1.2], ['world', 1.2, 2]]);
    const uslt = sources.find(s => s.meta === 'USLT');
    assert.equal(uslt.lyrics.synced, false);
    assert.equal(L.rank(sylt.lyrics), 3);
    assert.equal(L.rank(uslt.lyrics), 1);
});

test('MP3: ID3v2.3 SYLT in MPEG frames', async () => {
    const { sources } = await embedded('sylt-frames.mp3');
    const l = sources[0].lyrics.lines;
    assert.deepEqual(l.map(x => x.text), ['First line', 'Next line']);
    near(l[0].start, 19 * 1152 / 44100);
    near(l[1].start, 43 * 1152 / 44100);
});

test('FLAC and Opus: LYRICS comments with enhanced LRC', async () => {
    for (const name of ['lyrics.flac', 'lyrics.opus']) {
        const { meta, sources } = await embedded(name);
        assert.equal(meta.title, 'Fixture Song', name);
        assert.equal(sources.length, 1, name);
        assert.deepEqual(words(sources[0].lyrics.lines[0]), [['Hel', 0.5, 0.8], ['lo ', 0.8, 1.2], ['world', 1.2, 1.8]], name);
    }
});

test('Ogg Vorbis: UNSYNCEDLYRICS and SYNCEDLYRICS comments', async () => {
    const { meta, sources } = await embedded('lyrics.ogg');
    assert.equal(meta.title, 'Fixture Song');
    const byMeta = Object.fromEntries(sources.map(s => [s.meta, s]));
    assert.deepEqual(Object.keys(byMeta).sort(), ['SYNCEDLYRICS (LRC)', 'UNSYNCEDLYRICS']);
    assert.equal(byMeta.UNSYNCEDLYRICS.lyrics.synced, false);
    assert.deepEqual(byMeta.UNSYNCEDLYRICS.lyrics.lines.map(x => x.text), ['Hello world', 'Second line']);
    assert.deepEqual(byMeta['SYNCEDLYRICS (LRC)'].lyrics.lines.map(x => [x.text, x.start]), [['Hello world', 0.5], ['Second line', 2]]);
});

test('M4A: ©lyr and a 3GPP timed text track', async () => {
    const { meta, sources } = await embedded('lyrics.m4a');
    assert.equal(meta.artist, 'Fixture Artist');
    assert.deepEqual(sources[0].lyrics.lines.map(x => x.text), ['Hello world', 'Second line']);
    const track = sources.find(s => s.meta === 'tx3g');
    assert.equal(track.label, 'Text track (eng)');
    const lyrics = await track.load();
    assert.deepEqual(lyrics.lines.map(x => [x.text, x.start, x.end]), [['Hello world', 0.5, 1.8], ['Second line', 2, 3]]);
});

test('M4A: a TTML (stpp) track timed word by word', async () => {
    const { sources } = await embedded('lyrics-ttml.m4a');
    const track = sources.find(s => s.meta === 'TTML');
    assert.equal(track.label, 'Text track (eng)');
    const lyrics = await track.load();
    assert.deepEqual(words(lyrics.lines[0]), [['Hel', 0.5, 0.8], ['lo ', 0.8, 1.2], ['world', 1.2, 1.8]]);
    assert.deepEqual([lyrics.lines[1].text, lyrics.lines[1].start, lyrics.lines[1].end], ['Second line', 2, 3]);
});

test('MKA: subtitle tracks, the LYRICS tag and an attached .lrc', async () => {
    const { meta, sources } = await embedded('lyrics.mka');
    assert.equal(meta.title, 'Fixture Song');
    assert.equal(meta.artist, 'Fixture Artist');
    const byMeta = Object.fromEntries(sources.map(s => [s.meta, s]));
    assert.deepEqual(byMeta['S_TEXT/UTF8'].lyrics.lines.map(x => [x.text, x.start, x.end]), [['Hello world', 0.5, 1.8], ['Second line', 2, 3]]);
    assert.equal(byMeta['S_TEXT/UTF8'].language, 'eng');
    assert.deepEqual(words(byMeta['S_TEXT/ASS'].lyrics.lines[0]), [['Hel', 0.5, 0.8], ['lo ', 0.8, 1.2], ['world', 1.2, 1.8]]);
    assert.equal(byMeta.LYRICS.lyrics.synced, false);
    assert.equal(byMeta.attached.label, 'song.lrc');
    assert.equal(L.rank(byMeta.attached.lyrics), 3);
});
