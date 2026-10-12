// Real browser previews with CDN parsers/WASM. Requires ffmpeg and 7z only to
// generate local fixtures, and Playwright Chromium. Run after npm run build.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const { chromium } = require('playwright');
const archiver = require('archiver');
const fixture = require('./extra-preview-fixtures');
const root = path.resolve(__dirname, '../..'), port = process.env.PREVIEW_TEST_PORT || 3143;
async function zip(file, entries) {
    const output = require('node:fs').createWriteStream(file), archive = archiver('zip');
    const done = new Promise((resolve, reject) => { output.on('close', resolve); archive.on('error', reject); output.on('error', reject); });
    archive.pipe(output); Object.entries(entries).forEach(([name, content]) => archive.append(content, { name }));
    await archive.finalize(); await done;
}
function command(cmd, args, cwd) {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`${cmd} fixture failed: ${result.error || result.stderr || result.stdout}`);
}
async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'extra-previews-'));
    let browser, server;
    try {
        await Promise.all([
            fs.writeFile(path.join(temp, 'palette.aco'), fixture.palette()),
            fs.writeFile(path.join(temp, 'brushes.abr'), fixture.brushes()),
            fs.writeFile(path.join(temp, 'music.abc'), fixture.abc),
            fs.writeFile(path.join(temp, 'alembic.abc'), Buffer.from('Ogawa\0binary fixture')),
            fs.writeFile(path.join(temp, 'steam.acf'), fixture.steam),
            fs.writeFile(path.join(temp, 'aircraft.acf'), 'Aircraft fixture\n'),
            fs.writeFile(path.join(temp, 'session.als'), zlib.gzipSync(Buffer.from(fixture.ableton))),
            fs.writeFile(path.join(temp, 'alloy.als'), 'sig Foo {}\n'),
            fs.writeFile(path.join(temp, 'template.ait'), fixture.miniPdf()),
            fs.writeFile(path.join(temp, 'bad.ait'), 'not a PDF template'),
            fs.writeFile(path.join(temp, 'entry.txt'), 'Extracted 7z fixture'),
            fs.writeFile(path.join(temp, 'entry.md'), '# Extracted Markdown fixture'),
            fs.writeFile(path.join(temp, 'audio.amr'), Buffer.concat([Buffer.from('#!AMR\n'), ...Array.from({ length: 25 }, () => Buffer.concat([Buffer.from([0x3c]), Buffer.alloc(31)]))])),
        ]);
        await zip(path.join(temp, 'bundle.aab'), { 'BundleConfig.pb': fixture.pb(1, fixture.pb(1, '1.0')), 'base/manifest/AndroidManifest.xml': fixture.androidManifest(), 'base/dex/classes.dex': Buffer.from('dex\n035\0'), 'base/assets/readme.txt': 'AAB asset fixture', 'feature/manifest/AndroidManifest.xml': fixture.androidManifest() });
        await zip(path.join(temp, 'bad.aab'), { 'AndroidManifest.xml': fixture.androidManifest() });
        const upstreamAab = await fetch('https://raw.githubusercontent.com/google/bundletool/586a43a450712a1067f3d92cf7574dee68226302/src/test/resources/com/android/tools/build/bundletool/testdata/bundle/install-time-permanent-modules.aab');
        if (!upstreamAab.ok) throw new Error(`Upstream AAB fixture download: HTTP ${upstreamAab.status}`);
        await fs.writeFile(path.join(temp, 'upstream.aab'), new Uint8Array(await upstreamAab.arrayBuffer()));
        command('7z', ['a', '-t7z', 'archive.7z', 'entry.txt', 'entry.md'], temp);
        command('7z', ['a', '-t7z', '-pfixture-password', 'encrypted.7z', 'entry.txt'], temp);
        for (const ext of ['aif', 'aiff', 'aifc']) command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-ar', '8000', '-ac', '1', '-c:a', ext === 'aifc' ? 'pcm_s16le' : 'pcm_s16be', '-f', 'aiff', path.join(temp, 'audio.' + ext)], temp);
        command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=5:duration=0.6', '-c:v', 'h263', '-pix_fmt', 'yuv420p', '-an', '-f', '3g2', path.join(temp, 'video.3g2')], temp);
        server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Server listening')) resolve(); }); server.on('exit', code => reject(new Error(`Server exited ${code}`))); });
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        async function open(name) {
            await page.goto(`http://localhost:${port}/?browse=${encodeURIComponent(temp)}`, { waitUntil: 'domcontentloaded' });
            await page.getByText(name, { exact: true }).click(); await page.locator('.bm-viewer').waitFor();
        }
        async function wait(locator, timeout = 60000) {
            await locator.waitFor({ timeout }).catch(async e => { throw new Error((await page.locator('.bm-viewer-body').innerText()).slice(0, 1500) + '\n' + e.message); });
        }
        await open('music.abc');
        await wait(page.locator('.bm-viewer-body svg'));
        await page.locator('select[aria-label="ABC tune"]').selectOption('1');
        await page.locator('svg').getByText('Second fixture', { exact: true }).waitFor();
        await open('alembic.abc');
        assert.equal(await page.locator('select[aria-label="ABC tune"]').count(), 0);
        console.log('PASS ABC tune rendering/selection and Alembic collision');
        await open('steam.acf'); await page.getByRole('heading', { name: 'Steam app manifest' }).waitFor();
        await page.getByRole('cell', { name: 'Steam fixture', exact: true }).waitFor();
        await open('aircraft.acf'); assert.equal(await page.getByRole('heading', { name: 'Steam app manifest' }).count(), 0);
        await open('session.als'); await wait(page.getByRole('heading', { name: 'Ableton Live Set' }));
        await page.getByRole('cell', { name: 'Piano fixture', exact: true }).waitFor();
        await open('alloy.als'); assert.equal(await page.getByRole('heading', { name: 'Ableton Live Set' }).count(), 0);
        console.log('PASS Steam/Ableton domain summaries and suffix collisions');
        await open('palette.aco'); await page.getByRole('heading', { name: 'Adobe palette · 3 colors' }).waitFor();
        await page.getByText('#ff0000', { exact: true }).waitFor();
        assert.equal(await page.locator('.bm-viewer-body [onerror]').count(), 0);
        await open('brushes.abr'); await page.getByRole('heading', { name: 'Photoshop brushes · 1 sampled tips' }).waitFor();
        assert.equal(await page.locator('.bm-viewer-body canvas').count(), 1);
        const tip = await page.locator('.bm-viewer-body canvas').evaluate(c => [...c.getContext('2d').getImageData(0,0,2,2).data]);
        assert.deepEqual([tip[0],tip[4],tip[8],tip[12]], [0,64,128,255]);
        console.log('PASS Adobe palette colors, safe names and brush-tip pixels');
        await open('bundle.aab'); await wait(page.getByRole('heading', { name: 'Android App Bundle · 2 modules' }));
        assert.equal(await page.getByRole('cell', { name: 'org.example.preview', exact: true }).count(), 2);
        await page.locator('input[placeholder="Filter archive entries"]').fill('readme.txt');
        await page.getByRole('button', { name: 'Open entry', exact: true }).click();
        await wait(page.frameLocator('.upstream-reader-frame').frameLocator('iframe').getByText('AAB asset fixture', { exact: true }));
        await open('bad.aab'); await page.getByText(/AAB needs BundleConfig.pb/).waitFor();
        await open('upstream.aab');
        await wait(page.getByRole('heading', { name: 'Android App Bundle · 4 modules' }));
        assert.equal(await page.getByRole('cell', { name: 'com.google.android.samples.dynamicfeatures.ondemand', exact: true }).count(), 4);
        console.log('PASS AAB module/protobuf inspection and extracted asset preview');
        await open('archive.7z'); await wait(page.getByRole('heading', { name: '7z archive' }));
        await page.locator('input[placeholder="Filter archive entries"]').fill('entry.md');
        await page.getByRole('button', { name: 'Open entry', exact: true }).click();
        await wait(page.frameLocator('iframe[title="Rendered Markdown"]').getByRole('heading', { name: 'Extracted Markdown fixture' }));
        await open('encrypted.7z'); await wait(page.getByRole('heading', { name: '7z archive' }));
        await page.locator('input[placeholder="Archive password"]').fill('fixture-password');
        await page.getByRole('button', { name: 'Open with password', exact: true }).click();
        await wait(page.getByRole('button', { name: 'Open entry', exact: true }));
        await page.getByRole('button', { name: 'Open entry', exact: true }).click();
        await wait(page.frameLocator('.upstream-reader-frame').frameLocator('iframe').getByText('Extracted 7z fixture', { exact: true }));
        console.log('PASS 7z listing, password-assisted extraction and contained-file viewers');
        await open('template.ait'); await wait(page.locator('.pdfv-page canvas'));
        assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isVisible(), false);
        await open('bad.ait'); await page.getByText(/not an Illustrator file this viewer reads/).waitFor();
        console.log('PASS PDF-compatible AIT rendering without overwriting templates');
        for (const ext of ['aif','aifc','aiff','amr']) {
            await open('audio.' + ext);
            await wait(page.getByText(/decoded PCM audio/), 120000);
            const media = await page.locator('audio').evaluate(a => ({ ready: a.readyState, duration: a.duration, error: a.error && a.error.code }));
            assert.ok(media.ready >= 1); assert.ok(media.duration > 0.1); assert.equal(media.error, null);
            console.log(`PASS ${ext.toUpperCase()} decoded audio playback`);
        }
        await open('video.3g2');
        await page.getByRole('button', { name: 'Convert for playback', exact: true }).click();
        await wait(page.getByText(/decoded MP4/), 120000);
        const video = await page.locator('video').evaluate(v => ({ width: v.videoWidth, duration: v.duration, error: v.error && v.error.code }));
        assert.equal(video.width, 128); assert.ok(video.duration > 0); assert.equal(video.error, null);
        console.log('PASS 3G2 transcoding and playable video output');
        assert.deepEqual(errors, []);
        console.log('PASS no uncaught browser errors');
    } finally {
        if (browser) await browser.close(); if (server) server.kill();
        await fs.rm(temp, { recursive: true, force: true });
    }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
