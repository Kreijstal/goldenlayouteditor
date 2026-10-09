// Browser integration checks. Install Chromium with `npx playwright install chromium`.
// TEST_CHROMIUM_PATH can select a locally installed browser.
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const path = require('node:path');
const express = require('express');
const browserify = require('browserify');
const { chromium } = require('playwright');
const { extractAffinityPreviews } = require('../src/affinity-preview');

async function main() {
    assert.throws(() => extractAffinityPreviews(new Uint8Array(20)), /Not an Affinity/);
    assert.throws(() => extractAffinityPreviews(Uint8Array.from([0, 255, 75, 65])), /No embedded/);
    const entry = `require('./src/legacy-art-plugin');
        const plugin = require('./src/plugins').getPlugins().find(p => p.id === 'legacy-art');
        window.openArt = async (type, name, bytes) => {
            const file = {id:'test', name, bytes:new Uint8Array(bytes)};
            plugin.init({projectFiles:{test:file}});
            const events = {};
            const root = document.getElementById('host');
            window.panel = new plugin.components[type]({element:root,on:(name, fn)=>events[name]=fn},{fileId:'test'});
            window.destroyArt = () => events.destroy();
            await window.panel.ready;
        };`;
    const bundle = await new Promise((resolve, reject) => browserify({ basedir:path.resolve(__dirname, '..') })
        .add(Readable.from([entry])).bundle((error, data) => error ? reject(error) : resolve(data)));
    const app = express();
    app.get('/test.js', (_, res) => res.type('js').send(bundle));
    app.get('/test', (_, res) => res.send('<div id="host" style="width:800px;height:700px"></div><script src="/test.js"></script>'));
    app.use(express.static(path.resolve(__dirname, '../public')));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const browser = await chromium.launch({ executablePath:process.env.TEST_CHROMIUM_PATH, headless:true, args:['--no-sandbox', '--disable-gpu'] });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/test`);
        // Generate a real PNG in the browser, then embed two sizes in an Affinity container.
        await page.evaluate(async () => {
            const png = async size => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = size;
                const context = canvas.getContext('2d');
                context.fillStyle = '#ff0000'; context.fillRect(0, 0, size, size);
                return new Uint8Array(await (await fetch(canvas.toDataURL())).arrayBuffer());
            };
            const small = await png(2), large = await png(8);
            await openArt('affinityPreview', 'test.afphoto', [0,255,75,65,...small,...large]);
            await document.querySelector('#host img').decode();
        });
        assert.equal(await page.locator('#host img').evaluate(img => img.naturalWidth), 8);
        assert.equal(await page.locator('#host select option').count(), 2);
        await page.locator('#host select').selectOption('1');
        await page.locator('#host img').evaluate(img => img.decode());
        assert.equal(await page.locator('#host img').evaluate(img => img.naturalWidth), 2);
        await page.evaluate(() => destroyArt());
        assert.equal(await page.locator('#host img').count(), 0);

        // A red filled bar. Deliberately no final newline: the last command must render.
        await page.evaluate(() => openArt('ripViewer', 'test.rip', Array.from(new TextEncoder().encode('!|c04|S0104|B0A0A2S2S'))));
        let frame = page.frames().find(frame => frame.url().endsWith('/rip.html'));
        const pixel = await frame.evaluate(() => Array.from(document.querySelector('canvas').getContext('2d').getImageData(20,20,1,1).data));
        assert.deepEqual(pixel, [170,0,0,255]);
        await page.evaluate(() => destroyArt());
        assert.equal(await page.locator('#host iframe').count(), 0);

        // NAPLPS filled rectangle with two three-byte coordinates; no trailing opcode.
        await page.evaluate(() => openArt('naplpsViewer', 'test.nap', [0x31,0x49,0x40,0x40,0x52,0x40,0x40]));
        frame = page.frames().find(frame => frame.url().endsWith('/naplps.html'));
        const drawn = await frame.evaluate(() => {
            const canvas = document.querySelector('canvas');
            const pixels = canvas.getContext('2d').getImageData(0,0,640,640).data;
            let lit = 0;
            for (let i=0;i<pixels.length;i+=4) if (pixels[i] || pixels[i+1] || pixels[i+2]) lit++;
            return lit;
        });
        assert.ok(drawn > 100, `NAPLPS rectangle must draw, got ${drawn} lit pixels`);
        assert.match(await page.locator('#host').innerText(), /1 commands/);
        await page.evaluate(() => destroyArt());
        assert.deepEqual(errors, []);
        console.log('PASS: Affinity previews, selection, RIP and NAPLPS pixels, final instructions, tab cleanup');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main();
