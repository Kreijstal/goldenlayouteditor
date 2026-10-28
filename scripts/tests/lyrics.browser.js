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
        const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
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

        // A word-timed file beside the audio wins over line-timed SYLT inside it
        await open('song.mp3');
        await page.waitForFunction(() => document.querySelector('.lyr-line') && document.querySelector('.lyr-line').textContent === 'Beside the song');
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
