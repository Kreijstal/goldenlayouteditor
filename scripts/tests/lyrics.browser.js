// The audio player's lyrics in the browser: node scripts/tests/lyrics.browser.js
// Run after npm run build (node scripts/build-viewers.js). Starts its own server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const fixtures = path.join(__dirname, 'fixtures', 'lyrics');
const port = process.env.LYRICS_TEST_PORT || 3143;

async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lyrics-test-'));
    let browser, server;
    try {
        await fs.copyFile(path.join(fixtures, 'sylt.mp3'), path.join(temp, 'sylt.mp3'));
        await fs.copyFile(path.join(fixtures, 'lyrics.mka'), path.join(temp, 'lyrics.mka'));
        await fs.copyFile(path.join(fixtures, 'lyrics-ttml.m4a'), path.join(temp, 'lyrics-ttml.m4a'));
        // Line-timed SYLT inside, word-timed enhanced LRC beside: the file beside wins
        await fs.copyFile(path.join(fixtures, 'sylt-frames.mp3'), path.join(temp, 'song.mp3'));
        // TTML beside the audio: two translations, a romanization, ruby and annotated words
        await fs.copyFile(path.join(fixtures, 'sylt-frames.mp3'), path.join(temp, 'learn.mp3'));
        await fs.writeFile(path.join(temp, 'learn.ttml'), `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xmlns:learn="https://example.org/ns/lyrics-learning" xmlns:tei="http://www.tei-c.org/ns/1.0" xml:lang="tr" itunes:timing="Word">
<head><metadata><ttm:title>Seni seviyorum</ttm:title>
<learn:annotations><learn:word ref="w2" lemma="sevmek" pos="verb"><learn:meaning xml:lang="en">I love</learn:meaning><learn:meaning xml:lang="de">ich liebe</learn:meaning><learn:grammar>Present continuous, first person singular</learn:grammar><learn:morpheme form="sev" meaning="love"/><learn:morpheme form="iyor" meaning="progressive"/><learn:morpheme form="um" meaning="first person"/></learn:word></learn:annotations>
<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations>
<translation type="subtitle" xml:lang="en"><text for="L1"><span xml:id="en1">I love</span> <span xml:id="en2">you</span>.<tei:note>Turkish needs no word for I.</tei:note></text><text for="L2">The world</text></translation>
<translation type="subtitle" xml:lang="de"><text for="L1">Ich liebe dich.<tei:note>Du, not Sie.</tei:note></text></translation></translations></iTunesMetadata>
<tei:respStmt><tei:name xml:id="tr1">Ayşe Y.</tei:name></tei:respStmt>
<tei:note type="translator" resp="#tr1" target="#w1">Seni is the accusative of sen.</tei:note>
<tei:linkGrp type="alignment"><tei:link target="#w1 #en2"/></tei:linkGrp></metadata></head>
<body><div>
<p begin="0.5s" end="1.8s" itunes:key="L1"><span xml:id="w1" begin="0.5s" end="1.0s">Seni </span><span xml:id="w2" tei:corresp="#en1" begin="1.0s" end="1.8s">seviyorum</span><span ttm:role="x-roman" xml:lang="tr-Latn">se-ni se-vi-yo-rum</span></p>
<p begin="2s" end="3s" itunes:key="L2"><span tts:ruby="container"><span tts:ruby="base">世界</span><span tts:ruby="textContainer"><span tts:ruby="text" begin="2s" end="2.4s">せ</span><span tts:ruby="text" begin="2.4s" end="3s">かい</span></span></span></p>
</div></body></tt>`);
        await fs.writeFile(path.join(temp, 'song.elrc'), '[00:00.20]v1:<00:00.20>Beside <00:00.60>the <00:00.90>song<00:01.50>\n');
        server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            server.stdout.on('data', data => { if (String(data).includes('Server listening')) resolve(); });
            server.on('exit', code => reject(new Error(`Test server exited: ${code}`)));
        });
        const origin = `http://localhost:${port}`;

        // Musixmatch: only its lyrics methods, and never the all-zero token
        assert.equal((await fetch(`${origin}/musixmatch/token.get`)).status, 403);
        assert.equal((await fetch(`${origin}/musixmatch/track.get?track_isrc=X`, { headers: { 'x-musixmatch-token': '0000' } })).status, 400);
        console.log('PASS Musixmatch proxy limits');

        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 900, height: 600 }, locale: 'en-US' });
        page.setDefaultTimeout(20000);
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        async function open(name) {
            await page.goto(`${origin}/?browse=${encodeURIComponent(temp)}`, { waitUntil: 'domcontentloaded' });
            await page.locator('.bm-name').filter({ hasText: name }).click();
            await page.locator('.lyr-wrap').waitFor();
        }
        const seek = t => page.evaluate(async t => {
            const a = document.querySelector('.lyr-wrap audio');
            const wait = ev => new Promise((resolve, reject) => {
                a.addEventListener(ev, resolve, { once: true });
                setTimeout(() => reject(new Error(`no ${ev}: readyState ${a.readyState}, error ${a.error && a.error.message}, src ${a.src}`)), 10000);
            });
            if (a.readyState < 1) await wait('loadedmetadata');
            a.currentTime = t;
            await wait('seeked');
        }, t);
        const menu = () => page.evaluate(() => [...document.querySelectorAll('.lyr-menu > *')].map(e => (e.className.includes('sel') ? '✓ ' : '') + e.textContent));

        // MP3 with SYLT syllables: lit as they are sung
        await open('sylt.mp3');
        await page.locator('.lyr-line').nth(1).waitFor();
        assert.deepEqual(await page.locator('.lyr-line').allTextContents(), ['Hello world', 'Second line']);
        assert.equal(await page.locator('.lyr-title b').textContent(), 'Fixture Song');
        await seek(1.0);
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.lyr-line')[0].children].map(w => w.className)),
            ['lyr-w sung', 'lyr-w now', 'lyr-w']);
        assert.match(await page.locator('.lyr-line').first().getAttribute('class'), /\bactive\b/);
        const p = +(await page.locator('.lyr-w.now').evaluate(w => w.style.getPropertyValue('--p')));
        assert.ok(p > 0.4 && p < 0.6, `fill ${p}`);
        // The offset shows them later
        for (let i = 0; i < 3; i++) await page.locator('.lyr-bar button', { hasText: '+' }).click();
        assert.equal(await page.locator('.lyr-offset').textContent(), '+0.3 s');
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.lyr-line')[0].children].map(w => w.className)),
            ['lyr-w now', 'lyr-w', 'lyr-w']);
        await page.screenshot({ path: path.join(process.env.LYRICS_SCREENSHOTS || temp, 'lyrics-sylt.png') });
        const m = await menu();
        assert.ok(m.includes('✓ ID3 synced lyrics — karaokeSYLT, word by word'), m.join(' | '));
        assert.ok(m.includes('ID3 lyricsUSLT, words only'), m.join(' | '));
        console.log('PASS MP3 SYLT karaoke');

        // Clicking a line seeks to it (its 2.0 s, shown 0.3 s later), and plays
        await page.locator('.lyr-line').nth(1).click();
        await page.waitForFunction(() => { const t = document.querySelector('.lyr-wrap audio').currentTime; return t >= 2.29 && t < 3; });
        await page.waitForFunction(() => document.querySelectorAll('.lyr-line')[1].classList.contains('active'));
        console.log('PASS line click seeks');

        // MKA: tracks, tag and attachment, in the menu
        await open('lyrics.mka');
        await page.waitForFunction(() => document.querySelectorAll('.lyr-line').length);
        await page.waitForFunction(() => !document.querySelector('.lyr-menu .note'));
        const mk = await menu();
        for (const want of ['Lyrics tagLYRICS, words only', 'Track 2 (eng)S_TEXT/UTF8, line by line', 'Track 3 — KaraokeS_TEXT/ASS, word by word', 'song.lrcattached, word by word']) {
            assert.ok(mk.some(x => x.replace(/^✓ /, '') === want), `${want} in ${mk.join(' | ')}`);
        }
        assert.equal(await page.locator('.lyr-line').first().textContent(), 'Hello world');
        assert.equal(await page.locator('.lyr-line').first().locator('.lyr-w').count(), 3);
        await page.screenshot({ path: path.join(process.env.LYRICS_SCREENSHOTS || temp, 'lyrics-mka.png') });
        console.log('PASS MKA lyrics sources');

        // M4A: a TTML text track, word by word
        await open('lyrics-ttml.m4a');
        await page.waitForFunction(() => document.querySelectorAll('.lyr-line').length === 2);
        assert.equal(await page.locator('.lyr-line').first().locator('.lyr-w').count(), 3);
        await seek(1.0);
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.lyr-line')[0].children].map(w => w.className)),
            ['lyr-w sung', 'lyr-w now', 'lyr-w']);
        const tm = await menu();
        assert.ok(tm.includes('✓ Text track (eng)TTML, word by word'), tm.join(' | '));
        console.log('PASS M4A TTML track');

        // TTML: translation and romanization under the lines, ruby, a word's card
        await open('learn.mp3');
        await page.waitForFunction(() => document.querySelectorAll('.lyr-line').length === 2);
        const subs = () => page.evaluate(() => [...document.querySelectorAll('.lyr-line')].map(l => [...l.querySelectorAll('.lyr-sub')].map(s => s.className.replace('lyr-sub ', '') + ':' + [...s.childNodes].filter(n => !(n.classList && n.classList.contains('lyr-tn'))).map(n => n.textContent).join(''))));
        assert.deepEqual(await subs(), [['ro:se-ni se-vi-yo-rum', 'tr:I love you.'], ['tr:The world']]);
        assert.equal(await page.locator('.lyr-line').nth(1).locator('ruby').evaluate(r => r.firstChild.textContent + '|' + r.querySelector('rt').textContent), '世界|せかい');
        // Aligned words: the one being sung lights its translation, and so does pointing at one
        const paired = () => page.evaluate(() => [...document.querySelectorAll('[data-pair]')].map(e => e.textContent));
        await seek(1.4);
        assert.deepEqual(await paired(), ['seviyorum', 'I love']);
        await page.screenshot({ path: path.join(process.env.LYRICS_SCREENSHOTS || temp, 'lyrics-align.png') });
        await page.locator('.lyr-sub.tr span', { hasText: 'you' }).hover();
        assert.deepEqual(await paired(), ['Seni ', 'seviyorum', 'I love', 'you']);
        await page.mouse.move(5, 300);
        assert.deepEqual(await paired(), ['seviyorum', 'I love']);
        await seek(2.5);
        assert.deepEqual(await paired(), []);
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.lyr-line')[1].querySelectorAll('rt .lyr-w')].map(w => w.className)), ['lyr-w sung', 'lyr-w now']);
        await page.screenshot({ path: path.join(process.env.LYRICS_SCREENSHOTS || temp, 'lyrics-ruby.png') });
        let lm = await menu();
        assert.ok(lm.includes('✓ Englishen') && lm.includes('Germande') && lm.includes('✓ Turkish (Latin)tr-Latn'), lm.join(' | '));
        await page.locator('.lyr-src > button').click();
        await page.locator('.lyr-menu button', { hasText: 'German' }).click();
        assert.deepEqual(await subs(), [['ro:se-ni se-vi-yo-rum', 'tr:Ich liebe dich.'], []]);
        // An annotated word opens its card and does not seek
        const before = await page.evaluate(() => document.querySelector('.lyr-wrap audio').currentTime);
        await page.locator('.lyr-w.ann', { hasText: 'seviyorum' }).click();
        await page.locator('.lyr-card').waitFor();
        const cardText = await page.locator('.lyr-card').innerText();
        assert.match(cardText, /seviyorum\s*sevmek\s*verb/);
        assert.ok(cardText.indexOf('ich liebe') < cardText.indexOf('I love'), 'German meaning first while German is shown: ' + cardText);
        assert.match(cardText, /Present continuous/);
        assert.match(cardText, /en ↔\s*I love/);
        assert.deepEqual(await page.locator('.lyr-card .parts span').evaluateAll(s => s.map(x => x.textContent)), ['sevlove', 'iyorprogressive', 'umfirst person']);
        assert.equal(await page.evaluate(() => document.querySelector('.lyr-wrap audio').currentTime), before);
        await page.screenshot({ path: path.join(process.env.LYRICS_SCREENSHOTS || temp, 'lyrics-learn.png') });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.lyr-card').isHidden(), true);
        // Notes: the translation shown has its translator's note (*), a word its own
        assert.deepEqual(await page.locator('.lyr-line').first().locator('.lyr-tn').evaluateAll(b => b.map(x => x.parentElement.className + ':' + x.title)),
            ['lyr-sub tr:Du, not Sie.']);
        await page.locator('.lyr-w.ann', { hasText: 'Seni' }).click();
        assert.match(await page.locator('.lyr-card').innerText(), /Translator’s note — Ayşe Y\.\s*Seni is the accusative of sen\./);
        await page.locator('.lyr-tn').click();
        const lineCard = await page.locator('.lyr-card').innerText();
        assert.match(lineCard, /^Seni seviyorum\s*Translator’s note \(de\)\s*Du, not Sie\.$/);
        await page.screenshot({ path: path.join(process.env.LYRICS_SCREENSHOTS || temp, 'lyrics-note.png') });
        await page.keyboard.press('Escape');
        console.log('PASS TTML translations, ruby, word cards and notes');

        // A word-timed file beside the audio wins over line-timed SYLT inside it
        await open('song.mp3');
        await page.waitForFunction(() => document.querySelector('.lyr-line') && document.querySelector('.lyr-line').textContent === 'Beside the song');
        // The file beside the audio can win before the one inside it is read
        await page.waitForFunction(() => !/Looking for lyrics/.test(document.querySelector('.lyr-menu').textContent));
        const sm = await menu();
        assert.ok(sm.some(x => x.startsWith('✓ song.elrc')), sm.join(' | '));
        assert.ok(sm.some(x => x === 'ID3 synced lyricsSYLT, line by line'), sm.join(' | '));
        console.log('PASS lyrics beside the audio');

        assert.deepEqual(errors, []);
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
        await fs.rm(temp, { recursive: true, force: true });
    }
}

main().catch(err => { console.error(err); process.exit(1); });
