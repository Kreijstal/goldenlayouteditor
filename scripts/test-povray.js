// Browser integration checks. Install Chromium with `npx playwright install chromium`.
// TEST_CHROMIUM_PATH can select a locally installed browser.
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const path = require('node:path');
const express = require('express');
const browserify = require('browserify');
const { chromium } = require('playwright');

async function main() {
    const entry = `require('./src/povray-plugin');
        const plugin = require('./src/plugins').getPlugins().find(p => p.id === 'povray');
        window.file = {id:'test', name:'test.pov', content:''};
        plugin.init({projectFiles:{test:window.file}});
        const events = {};
        window.panel = new plugin.components.povrayViewer({element:document.getElementById('host'),on:(name,fn)=>events[name]=fn},{});
        window.panel.fileId = 'test';
        window.destroyPanel = () => events.destroy();`;
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
        await page.evaluate(async () => {
            file.content = 'camera { location <0,0,-3> look_at <0,0,0> } light_source { <0,5,-5> color rgb 1 } sphere { <0,0,0>, 1 pigment { color rgb <1,0,0> } }';
            document.querySelector('select').value = '320,240';
            await panel.render();
            await panel.image.decode();
        });
        assert.equal(await page.locator('img').evaluate(img => img.naturalWidth), 320);
        const pixel = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 320; canvas.height = 240;
            const context = canvas.getContext('2d');
            context.drawImage(panel.image,0,0);
            return Array.from(context.getImageData(160,120,1,1).data);
        });
        assert.ok(pixel[0] > 100 && pixel[1] < 10, `Expected red sphere, got ${pixel}`);
        await page.evaluate(async () => {
            file.content = file.content.replace('<1,0,0>', '<0,0,1>');
            await panel.render();
            await panel.image.decode();
        });
        assert.match(await page.locator('[data-status]').innerText(), /320 × 240/);
        const invalid = await page.evaluate(async () => {
            file.content = 'sphere { <0,0,0>, 1 pigment { color rgb <1,0,0> }';
            return panel.render().then(() => 'unexpected success', error => error.message);
        });
        assert.match(invalid, /No matching/i);
        await page.evaluate(async () => {
            file.content = 'sphere { <0,0,0>,1 }';
            const rendering = panel.render();
            await new Promise(resolve => setTimeout(resolve, 0));
            panel.stop();
            await rendering;
            destroyPanel();
        });
        assert.deepEqual(errors, []);
        console.log('PASS: POV-Ray WASM pixels, current edits, parse errors and cancellation');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main();
