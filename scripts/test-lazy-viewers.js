// Exercise the production build, including every generated plugin interface.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require('playwright');
const { createFixture } = require('./cd5-fixture');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/viewer-chunks/manifest.json')));
async function main() {
    const app = express();
    const requests = [];
    app.use((req, res, next) => { if (req.path.includes('/viewer-chunks/')) requests.push(req.path); next(); });
    app.get('/project/test', (_, res) => res.send(`<div id="host"></div><script>
        window.ace = {config:{set(){},setModuleUrl(){}},require(){return {}},define(){}};
        // Isolate plugin startup from editor/server setup. Use the actual production bundle.
        const add = document.addEventListener.bind(document);
        document.addEventListener = (event, ...args) => { if(event !== 'DOMContentLoaded') add(event, ...args); };
        </script><script src="/project/bundle.js"></script>`));
    app.use('/project', express.static(path.join(root, 'public')));
    app.use(express.static(path.join(root, 'public'))); // existing worker URLs use the site root
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/project/test`);
        assert.deepEqual(errors, []);
        assert.equal(requests.length, 0, 'startup must not request a viewer');
        const metadata = await page.evaluate(() => {
            const req = window.__gleViewerRequire;
            window.plugins = req('shared:src/plugins.js').getPlugins();
            window.lazy = req('shared:src/lazy-viewers.js');
            window.realPlugins = {};
            for (const plugin of plugins) {
                if (!plugin.acceptImplementation) continue;
                const accept = plugin.acceptImplementation;
                plugin.acceptImplementation = real => { realPlugins[plugin.id] = real; accept(real); };
            }
            const names = ['x.cd5','x.rip','x.nap','x.afphoto','x.pov','x.psd','x.ora','x.gliffy','x.graphml','x.pdf','x.typ','x.txt','x.png'];
            const result = {};
            for (const plugin of plugins) {
                result[plugin.id] = {
                    components: Object.keys(plugin.components || {}),
                    toolbar: (plugin.toolbarButtons || []).map(b => b.label),
                    menus: (plugin.contextMenuItems || []).map(item => ({label:item.label, matches:names.map(name => item.canHandle ? item.canHandle(name) : null)})),
                    thumbnails: (plugin.thumbnailRenderers || []).map(item => names.map(name => item.canHandle ? item.canHandle({name,type:'file'}) : null)),
                    newFiles: (plugin.newFileTypes || []).map(item => [item.label,item.ext]),
                };
            }
            return result;
        });
        assert(metadata.cd5.components.includes('cd5Viewer'));
        assert.equal(requests.length, 0, 'menus and predicates must stay synchronous and eager');

        // A destroyed loading tab must never instantiate the real viewer.
        let release;
        const blocked = new Promise(resolve => { release = resolve; });
        await page.route('**/viewer-chunks/cd5-plugin.*.js', async route => { await blocked; await route.continue(); });
        await page.evaluate(bytes => {
            const plugin = plugins.find(p => p.id === 'cd5');
            plugin.init({projectFiles:{test:{id:'test',name:'test.cd5',bytes:new Uint8Array(bytes)}}});
            window.events = {};
            window.container = {element:document.getElementById('host'),on:(name,fn)=>(events[name] ||= []).push(fn)};
            window.cancelled = new plugin.components.cd5Viewer(container,{fileId:'test'});
            events.destroy.forEach(fn=>fn());
        }, [...createFixture()]);
        release();
        await page.evaluate(() => cancelled.ready);
        assert.equal(await page.locator('#host canvas').count(), 0);
        await page.unroute('**/viewer-chunks/cd5-plugin.*.js');
        await page.evaluate(async () => {
            events = {};
            document.getElementById('host').replaceChildren();
            const Comp = plugins.find(p => p.id === 'cd5').components.cd5Viewer;
            const firstHost = document.createElement('div');
            document.getElementById('host').appendChild(firstHost);
            const first = new Comp({element:firstHost,on:container.on},{fileId:'test'});
            const secondHost = document.createElement('div');
            document.getElementById('host').appendChild(secondHost);
            const second = new Comp({element:secondHost,on:container.on},{fileId:'test'});
            await Promise.all([first.ready,second.ready]);
            window.cd5 = first;
        });
        assert.equal(requests.filter(p => /cd5-plugin\./.test(p)).length, 1, 'reopens share a cached download');
        assert.equal(await page.locator('#host canvas').count(), 2);
        assert.equal(await page.evaluate(() => cd5.info.layers.length), 2);

        // The shared memory-file registry must survive chunk boundaries.
        assert.equal(await page.evaluate(async () => {
            const files = window.__gleViewerRequire('shared:src/archive-fallback.js');
            files.addMemoryFile('/.in-memory-test/test.qoi', new Uint8Array([113,111,105,102,0,0,0,1,0,0,0,1,4,0,255,255,0,0,255,0,0,0,0,0,0,0,1]));
            const module = await lazy.loadModule('qoi');
            const url = await files.resolveFileUrl('/workspace-file?path=%2F.in-memory-test%2Ftest.qoi');
            const image = await module.qoiImage(url);
            const dispatched = await window.__gleViewerRequire('shared:src/jxl.js').displayableImageUrl(url,'test.qoi');
            if (dispatched !== image.url) throw new Error('Image dispatcher did not use the cached decoder');
            return image.pages[0].width;
        }), 1);

        // Non-panel entry points also cross the lazy boundary.
        const beforeHooks = requests.length;
        assert.match(await page.evaluate(async () => {
            const plugin = plugins.find(p => p.id === 'bpmn');
            return plugin.newFileTypes[0].content('sample');
        }), /definitions/);
        assert.equal(requests.length, beforeHooks + 1);
        assert.match(requests.at(-1), /bpmn-plugin/);
        await page.evaluate(async () => {
            const plugin = plugins.find(p => p.id === 'hex-editor');
            window.openedTabs = [];
            plugin.init({projectFiles:{test:{id:'test',name:'sample.bin'}},openEditorTab:(...args)=>openedTabs.push(args)});
            await plugin.contextMenuItems[0].action('test');
            await plugin.contextMenuItems[0].action('test');
        });
        assert.equal(await page.evaluate(() => openedTabs.length), 2);
        assert.equal(requests.filter(p=>/hex-editor-plugin/.test(p)).length, 1);
        await page.evaluate(async () => {
            const files = window.__gleViewerRequire('shared:src/archive-fallback.js');
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const blob = await new Promise(resolve => canvas.toBlob(resolve));
            files.addMemoryFile('/.in-memory-thumbs/test.png',new Uint8Array(await blob.arrayBuffer()));
            const plugin = plugins.find(p=>p.id==='thumbnails');
            plugin.init({currentWorkspacePath:'/.in-memory-thumbs',getRelativePath:()=> 'test.png'});
            const host = document.createElement('div'); host.id = 'thumbnail'; document.body.appendChild(host);
            await plugin.thumbnailRenderers[0].render({id:'thumb',name:'test.png',type:'file'},host);
        });
        await page.waitForFunction(()=>document.querySelector('#thumbnail img')?.naturalWidth === 1);
        assert.equal(requests.filter(p=>/thumbnails-plugin/.test(p)).length, 1);

        // Load each chunk without constructing its heavyweight third-party runtime.
        await page.evaluate(async names => { for (const name of names) await lazy.loadModule(name); }, Object.keys(manifest));
        const differences = await page.evaluate(expected => {
            const names = ['x.cd5','x.rip','x.nap','x.afphoto','x.pov','x.psd','x.ora','x.gliffy','x.graphml','x.pdf','x.typ','x.txt','x.png'];
            const differences = [];
            for (const [id, real] of Object.entries(realPlugins)) {
                const actual = {
                    components:Object.keys(real.components || {}),
                    toolbar:(real.toolbarButtons || []).map(b=>b.label),
                    menus:(real.contextMenuItems || []).map(item=>({label:item.label,matches:names.map(name=>item.canHandle ? item.canHandle(name) : null)})),
                    thumbnails:(real.thumbnailRenderers || []).map(item=>names.map(name=>item.canHandle ? item.canHandle({name,type:'file'}) : null)),
                    newFiles:(real.newFileTypes || []).map(item=>[item.label,item.ext]),
                };
                if(JSON.stringify(actual)!==JSON.stringify(expected[id])) differences.push(id);
            }
            return differences;
        }, metadata);
        assert.deepEqual(differences, [], 'lazy interfaces must preserve registration metadata and predicates');
        assert.deepEqual(errors, []);
        // Script errors reject ready and show an error at the viewer boundary.
        await page.evaluate(() => {
            lazy.setManifest({broken:'viewer-chunks/missing.js'});
            lazy.registerLazyPlugin({id:'broken',name:'Broken',components:{brokenViewer:class {}}},'broken');
        });
        assert.match(await page.evaluate(async () => {
            const Comp = plugins.find(p=>p.id==='broken').components.brokenViewer;
            const panel = new Comp(container,{});
            try { await panel.ready; } catch(error) { return error.message; }
        }), /Failed to load viewer/);
        console.log(`Lazy loading passed: zero startup requests, ${Object.keys(manifest).length} modules, metadata parity, shared files, reopen/cancellation/error handling, subdirectory URLs.`);
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
