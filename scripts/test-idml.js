// Production-bundle tests using the actual IDML WASM engine and synthetic page pixels.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require('playwright');
const { createIdmlFixture } = require('./idml-fixture');
const root = path.resolve(__dirname,'..');
async function main() {
    const fixture = await createIdmlFixture();
    const app = express(); const requests = [];
    let blockWasm=false, blockedWasmRequested, blockedWasmResponse;
    app.use((req,res,next)=>{if(/viewer-chunks|idml-viewer/.test(req.path))requests.push(req.path);next();});
    app.use((req,res,next)=>{
        if(blockWasm && req.path==='/project/idml-viewer/introspect.wasm'){blockedWasmResponse=res;blockedWasmRequested();return;}
        next();
    });
    app.get('/project/test',(_,res)=>res.send(`<div id="host" style="height:650px;width:1000px"></div><script>
        window.ace={config:{set(){},setModuleUrl(){}},require(){return{}},define(){}};
        const add=document.addEventListener.bind(document);document.addEventListener=(event,...args)=>{if(event!=='DOMContentLoaded')add(event,...args)};
        window.activeWorkers=new Set();window.workerStarts=0;
        const NativeWorker=window.Worker;
        window.Worker=class extends NativeWorker{constructor(...args){super(...args);activeWorkers.add(this);workerStarts++;}terminate(){activeWorkers.delete(this);return super.terminate();}};
        </script><script src="/project/bundle.js"></script>`));
    app.use('/project',express.static(path.join(root,'public')));
    app.use(express.static(path.join(root,'public')));
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
    try {
        const page=await browser.newPage();const errors=[],external=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('request',request=>{if(!/^(http:\/\/127\.0\.0\.1:|blob:|data:)/.test(request.url()))external.push(request.url());});
        await page.goto(`http://127.0.0.1:${server.address().port}/project/test`);
        assert.equal(requests.length,0,'viewer, worker and WASM must remain unloaded at startup');
        await page.evaluate(()=>{
            window.plugin=window.__gleViewerRequire('shared:src/plugins.js').getPlugins().find(p=>p.id==='idml');
            window.openIdml=async bytes=>{
                window.events={};document.getElementById('host').replaceChildren();
                plugin.init({projectFiles:{test:{id:'test',name:'sample.idml',bytes:new Uint8Array(bytes)}}});
                window.panel=new plugin.components.idmlViewer({element:document.getElementById('host'),on:(name,fn)=>(events[name]||=[]).push(fn)},{fileId:'test'});
                await panel.ready;
            };
            window.closeIdml=()=>events.destroy.forEach(fn=>fn());
        });
        await page.evaluate(bytes=>openIdml(bytes),[...fixture]);
        assert.equal(await page.locator('.idml-page-button').count(),2);
        assert.equal(await page.locator('.idml-viewer').getAttribute('data-idml-backend'),'cpu-tiny-skia');
        const pixel=()=>page.locator('.idml-page-shell canvas').evaluate(c=>[...c.getContext('2d').getImageData(60,60,1,1).data]);
        assert.deepEqual(await pixel(),[255,0,0,255]);
        assert.equal(await page.locator('.idml-page-shell canvas').evaluate(c=>c.width),192);
        await page.getByRole('button',{name:'Next IDML page'}).click();
        await page.waitForFunction(()=>document.querySelector('.idml-status').textContent.includes('2/2'));
        assert.deepEqual(await pixel(),[0,0,255,255]);
        assert(await page.getByRole('button',{name:'Next IDML page'}).isDisabled());
        const transform=await page.locator('.idml-page-shell').evaluate(el=>el.style.transform);
        await page.getByRole('button',{name:'+',exact:true}).click();
        assert.notEqual(await page.locator('.idml-page-shell').evaluate(el=>el.style.transform),transform);
        await page.getByRole('button',{name:'Fit',exact:true}).click();
        await page.getByRole('button',{name:'Previous IDML page'}).click();
        await page.waitForFunction(()=>document.querySelector('.idml-status').textContent.includes('1/2'));
        assert.deepEqual(await pixel(),[255,0,0,255]);
        assert.equal(await page.evaluate(()=>activeWorkers.size),1);
        await page.evaluate(()=>closeIdml());
        assert.equal(await page.evaluate(()=>activeWorkers.size),0);
        // Use the viewer's real file-picker handler after opening an empty panel.
        await page.evaluate(()=>{
            events={};panel=new plugin.components.idmlViewer({element:document.getElementById('host'),on:(name,fn)=>(events[name]||=[]).push(fn)},{});
            return panel.ready;
        });
        await page.locator('input[type=file]').setInputFiles({name:'picker.idml',mimeType:'application/octet-stream',buffer:Buffer.from(fixture)});
        await page.waitForFunction(()=>document.querySelector('.idml-status')?.textContent.includes('1/2'));
        assert.deepEqual(await pixel(),[255,0,0,255]);
        await page.evaluate(()=>closeIdml());
        assert.equal(await page.evaluate(()=>activeWorkers.size),0);
        // A malformed package must reject rather than becoming a metadata-only preview.
        const failure=await page.evaluate(async()=>{try{await openIdml([1,2,3]);}catch(error){return error.message;}});
        assert.match(failure,/ZIP|IDML|archive/i);
        assert.equal(await page.evaluate(()=>activeWorkers.size),0);
        await page.evaluate(()=>closeIdml());
        // Close while the worker is waiting for WASM; ready rejects and the worker terminates.
        blockWasm=true;
        const loading=new Promise(resolve=>{blockedWasmRequested=resolve;});
        await page.evaluate(bytes=>{
            window.cancelled=openIdml(bytes).then(()=>({ok:true}),error=>({name:error.name,message:error.message}));
        },[...fixture]);
        await loading;
        await page.evaluate(()=>closeIdml());
        const cancelled=await page.evaluate(()=>window.cancelled);
        assert.equal(cancelled.name,'AbortError');
        assert.equal(await page.evaluate(()=>activeWorkers.size),0);
        assert.equal(await page.locator('canvas').count(),0);
        blockedWasmResponse.end();blockWasm=false;
        assert.equal(requests.filter(p=>/idml-plugin\./.test(p)).length,1,'reopens reuse the viewer chunk');
        assert(requests.some(p=>p==='/project/idml-viewer/worker.js'));
        assert(requests.some(p=>p==='/project/idml-viewer/introspect.wasm'));
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
        // Optional full editor file-drop smoke with a locally available Ace distribution.
        if(process.env.TEST_ACE_DIR) {
            const editor=await browser.newPage();const editorErrors=[];editor.on('pageerror',e=>editorErrors.push(e.message));
            await editor.route('https://esm.sh/ace-builds@1.43.6/src-min-noconflict/**',async route=>{
                const file=new URL(route.request().url()).pathname.split('/src-min-noconflict/')[1];
                await route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(process.env.TEST_ACE_DIR,file))});
            });
            await editor.goto(`http://127.0.0.1:${server.address().port}/`);await editor.waitForFunction(()=>window.app);
            await editor.evaluate(bytes=>{
                const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'drop.idml'));
                window.__$goldenviewerEditor.projectFilesComponentInstance.handleDrop(new DragEvent('drop',{dataTransfer:transfer}));
            },[...fixture]);
            await editor.waitForFunction(()=>document.querySelector('.idml-status')?.textContent.includes('1/2'));
            assert.deepEqual(await editor.locator('.idml-page-shell canvas').evaluate(c=>[...c.getContext('2d').getImageData(60,60,1,1).data]),[255,0,0,255]);
            assert.deepEqual(editorErrors,[]);
            await editor.close();
        }
        console.log('IDML passed: real WASM pixels on two pages, navigation/zoom/fit, local file picker, malformed-input rejection, worker cancellation/cleanup, lazy assets, cached chunk, subdirectory URLs'+(process.env.TEST_ACE_DIR?', full-editor file drop.':'.'));
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
