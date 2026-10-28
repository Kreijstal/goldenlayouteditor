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

test('TTML (AMLL): translations and romanizations inline and in the head, background vocals, ruby, song parts', () => {
    const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions" xmlns:amll="http://www.example.com/ns/amll" xml:lang="ja" itunes:timing="Word">
<head><metadata><ttm:agent type="person" xml:id="v1"/><amll:meta key="musicName" value="Song Title"/><amll:meta key="artists" value="Artist Name"/>
<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">
<translations><translation type="subtitle" xml:lang="en"><text for="L1">ignored: given inline</text><text for="L2">After all</text></translation></translations>
<transliterations><transliteration xml:lang="ja-Latn"><text for="L2"><span begin="00:27.690" end="00:27.820">sho</span><span begin="00:27.820" end="00:27.950">sen</span></text></transliteration></transliterations>
</iTunesMetadata></metadata></head>
<body><div itunes:song-part="Verse">
<p begin="00:25.100" end="00:32.500" itunes:key="L1" ttm:agent="v1"><span begin="00:25.100" end="00:25.800">君</span><span begin="00:25.900" end="00:26.100">の</span><span begin="00:26.300" end="00:27.600">物語</span>
<span ttm:role="x-translation" xml:lang="en">Your story</span>
<span ttm:role="x-roman" xml:lang="ja-Latn">kimi no monogatari</span>
<span ttm:role="x-bg" begin="00:30.500" end="00:32.500"><span begin="00:30.500" end="00:31.500">(秘密</span><span begin="00:31.600" end="00:32.500">だよ)</span><span ttm:role="x-translation" xml:lang="en">It's a secret</span></span>
</p>
<p begin="00:27.690" end="00:28.000" itunes:key="L2" ttm:agent="v1"><span tts:ruby="container"><span tts:ruby="base">所</span><span tts:ruby="textContainer"><span tts:ruby="text" begin="00:27.690" end="00:27.820">しょ</span></span></span><span tts:ruby="container"><span tts:ruby="base">詮</span><span tts:ruby="textContainer"><span tts:ruby="text" begin="00:27.820" end="00:27.880">せ</span><span tts:ruby="text" begin="00:27.880" end="00:27.950">ん</span></span></span></p>
</div></body></tt>`;
    const l = L.parseLyrics(ttml, 'a.ttml');
    assert.deepEqual(l.meta, { title: 'Song Title', artist: 'Artist Name' });
    assert.deepEqual(l.extras, [{ kind: 'translation', lang: 'en' }, { kind: 'roman', lang: 'ja-Latn' }]);
    // The translations are not sung: not in the line's text or words
    assert.deepEqual(l.lines.map(x => [x.text, !!x.bg, x.part]), [['君の物語', false, 'Verse'], ['所詮', false, undefined], ['(秘密だよ)', true, undefined]]);
    const ex = x => (x.extras || []).map(e => [e.kind, e.lang, e.text, e.words && e.words.map(w => [w.text, w.start, w.end])]);
    assert.deepEqual(ex(l.lines[0]), [['translation', 'en', 'Your story', null], ['roman', 'ja-Latn', 'kimi no monogatari', null]]);
    assert.deepEqual(ex(l.lines[1]), [['translation', 'en', 'After all', null], ['roman', 'ja-Latn', 'shosen', [['sho', 27.69, 27.82], ['sen', 27.82, 27.95]]]]);
    assert.deepEqual(ex(l.lines[2]), [['translation', 'en', "It's a secret", null]]);
    assert.deepEqual(l.lines[1].words.map(w => [w.text, w.start, w.end, w.ruby.map(r => [r.text, r.start, r.end])]),
        [['所', 27.69, 27.82, [['しょ', 27.69, 27.82]]], ['詮', 27.82, 27.95, [['せ', 27.82, 27.88], ['ん', 27.88, 27.95]]]]);
});

test('TTML: language-learning annotations linked to words by xml:id', () => {
    const l = L.parseLyrics(fs.readFileSync(path.join(FIXTURES, 'learn.ttml'), 'utf8'), 'learn.ttml');
    assert.equal(l.meta.title, 'Turkish Learning Example');
    assert.deepEqual(l.lines[0].words.map(w => [w.text, w.id]), [['Seni ', 'w1'], ['seviyorum', 'w2']]);
    assert.deepEqual(l.lines[0].extras.map(e => [e.lang, e.text]), [['en', 'I love you.'], ['de', 'Ich liebe dich.']]);
    assert.deepEqual(l.annotations.w2, {
        lemma: 'sevmek', pos: 'verb', meanings: [{ lang: 'en', text: 'I love' }], grammar: ['Present continuous, first person singular'],
        morphemes: [{ form: 'sev', meaning: 'love' }, { form: 'iyor', meaning: 'progressive' }, { form: 'um', meaning: 'first person' }],
    });
    assert.deepEqual(l.annotations.w1, { lemma: 'sen', pos: 'pronoun', meanings: [{ lang: 'en', text: 'you' }], grammar: ['Accusative case'] });
});

test('TTML: word alignment with a translation, by TEI corresp and linkGrp', () => {
    const l = L.parseTtml(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tei="http://www.tei-c.org/ns/1.0" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"><head><metadata>
<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations><translation xml:lang="en"><text for="L1"><span xml:id="en1">I love</span> <span xml:id="en2">you</span>.</text></translation></translations></iTunesMetadata>
<tei:linkGrp type="alignment"><tei:link target="#w1 #en2"/></tei:linkGrp></metadata></head>
<body><div><p begin="1s" end="3s" itunes:key="L1"><span xml:id="w1" begin="1s" end="2s">Seni </span><span xml:id="w2" tei:corresp="#en1" begin="2s" end="3s">seviyorum</span></p></div></body></tt>`);
    assert.deepEqual(l.links, { w1: ['en2'], en2: ['w1'], w2: ['en1'], en1: ['w2'] });
    const tr = l.lines[0].extras[0];
    assert.equal(tr.text, 'I love you.');
    assert.deepEqual(tr.parts, [{ text: 'I love ', id: 'en1' }, { text: 'you', id: 'en2' }, { text: '.' }]);
});

test('TTML: notes (TEI) in lines, translations and words, and pointing at them', () => {
    const l = L.parseTtml(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tei="http://www.tei-c.org/ns/1.0" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal"><head><metadata>
<tei:respStmt><tei:name xml:id="tr1">Ayşe Y.</tei:name></tei:respStmt>
<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations><translation xml:lang="en"><text for="L1"><span xml:id="en1">I love</span> <span xml:id="en2">you</span>.<tei:note>No separate word for I.</tei:note></text></translation></translations></iTunesMetadata>
<tei:note type="translator" resp="#tr1" target="#w1 #en2">Seni: the accusative of sen.</tei:note>
<tei:note type="cultural" target="#L1">A folk song's line.</tei:note>
</metadata></head>
<body><div><p begin="1s" end="3s" itunes:key="L1"><span xml:id="w1" begin="1s" end="2s">Seni </span><span begin="2s" end="3s">seviyorum<tei:note>Sung twice live.</tei:note></span><tei:note resp="editor">Second verse only.</tei:note><span ttm:role="x-translation" xml:lang="de">Ich liebe dich<tei:note>Du, not Sie.</tei:note></span></p></div></body></tt>`);
    const line = l.lines[0];
    // Notes are not sung, nor part of a translation
    assert.equal(line.text, 'Seni seviyorum');
    assert.deepEqual(line.extras.map(e => e.text), ['Ich liebe dich', 'I love you.']);
    assert.deepEqual(line.notes, [
        { text: 'Second verse only.', type: '', resp: 'editor', lang: '' },
        { text: 'Du, not Sie.', type: 'translator', resp: '', lang: 'de' },
        { text: 'No separate word for I.', type: 'translator', resp: '', lang: 'en' },
        { text: "A folk song's line.", type: 'cultural', resp: '', lang: '' },
    ]);
    assert.deepEqual(line.words[1].notes, [{ text: 'Sung twice live.', type: '', resp: '', lang: '' }]);
    const seni = { text: 'Seni: the accusative of sen.', type: 'translator', resp: 'Ayşe Y.', lang: '' };
    assert.deepEqual(l.notes, { w1: [seni], en2: [seni] });
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
