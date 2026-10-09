const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {once} = require('node:events');
const {Readable} = require('node:stream');
const express = require('express');
const browserify = require('browserify');
const {chromium} = require('playwright');
const {createFixture} = require('./cd5-fixture');
const {parseCd5,decodeKernel,decodeBand,decodeLayer,layerRgba} = require('../src/cd5');
const bytes=array=>Uint8Array.from(array);
const known=[
    [1,[128,4,0,0,0,42,0],[42,42,42,42]],
    [1,[1,3,0,0,0,5,6,7,0],[5,6,7]],
    [2,[132,10,0x98,0x76,0],[10,11,13,12,12]],
    [7,[10,8,0,0,0,0x55,1,2,3,4],[1,10,2,10,3,10,4,10]],
    [8,[4,1,2,3,4,0x90,0],[1,2,3,4,1,2,3,4]],
    [8,[18,...Array.from({length:18},(_,i)=>i+1),0xc0,0x20,0],[...Array.from({length:18},(_,i)=>i+1),...Array.from({length:18},(_,i)=>i+1)]],
    [6,[...Array.from({length:256},(_,i)=>255-i),4,0,0,0,1,0xa1,0x38],[255,254,253,252]],
];
for(const [id,src,out] of known) assert.deepEqual(Array.from(decodeKernel(id,bytes(src),1024)),out);
assert.throws(()=>decodeKernel(8,bytes([0x80,0]),1024),/reference before output/);
assert.throws(()=>decodeKernel(1,bytes([128,255,255,255,255,42]),1024),/capacity/);
assert.throws(()=>decodeKernel(99,bytes([1]),1024),/unsupported compression/);
const fixture=bytes(createFixture()), doc=parseCd5(fixture);
assert.equal(doc.layers.length,2);
const expected=[255,0,0,255,0,255,0,128,0,0,255,255,255,255,255,0];
assert.deepEqual(Array.from(layerRgba(doc.layers[0],decodeLayer(doc.layers[0]).pixels)),expected);
assert.throws(()=>parseCd5(fixture.subarray(0,fixture.length-1)),/truncated/);
assert.throws(()=>parseCd5(bytes([...fixture,0])),/trailing/);
const band=doc.layers[0].bands[0].slice();new DataView(band.buffer).setUint32(8,100,true);
assert.throws(()=>decodeBand(band),/band decoded/);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(f=>f.isDirectory()?walk(path.join(dir,f.name)):[path.join(dir,f.name)]);}
if(process.env.CD5_CORPUS){
    let files=0,layers=0,rasters=0,bands=0;
    for(const file of walk(process.env.CD5_CORPUS).filter(f=>/\.cd5$/i.test(f))){
        const d=parseCd5(new Uint8Array(fs.readFileSync(file)));files++;
        for(const band of d.previewBands){decodeBand(band);bands++;}
        for(const l of d.layers){const raw=decodeLayer(l);layers++;bands+=l.bands.length;if(l.pixelSize){layerRgba(l,raw.pixels);rasters++;}}
    }
    console.log('PASS corpus:',{files,layers,rasters,bands});
}
async function main(){
    const entry=`const {Cd5Panel}=require('./src/cd5-plugin');
    const {getPlugins}=require('./src/plugins');
    window.events={};window.openCd5=async file=>{
        const plugin=getPlugins().find(p=>p.id==='cd5');plugin.init({projectFiles:{test:{id:'test',name:'colours.cd5',bytes:new Uint8Array(file)}}});
        window.panel=new Cd5Panel({element:document.getElementById('host'),on:(name,fn)=>events[name]=fn},{fileId:'test'});await panel.ready;
    };`;
    const bundle=await new Promise((resolve,reject)=>browserify({basedir:path.resolve(__dirname,'..')}).add(Readable.from([entry])).bundle((e,b)=>e?reject(e):resolve(b)));
    const app=express();app.get('/test.js',(_,res)=>res.type('js').send(bundle));app.get('/test',(_,res)=>res.send('<div id="host" style="width:800px;height:600px"></div><script src="/test.js"></script>'));app.use(express.static(path.resolve(__dirname,'../public')));
    const server=app.listen(0,'127.0.0.1');await once(server,'listening');
    const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
    try{
        const page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
        const origin=`http://127.0.0.1:${server.address().port}`;await page.goto(origin+'/test');await page.evaluate(file=>openCd5(file),Array.from(fixture));
        const rendered=()=>page.locator('canvas').evaluate(c=>Array.from(c.getContext('2d').getImageData(0,0,2,2).data));
        assert.deepEqual(await rendered(),[255,0,0,255,0,255,0,128,0,0,255,255,0,0,0,0]);
        assert.equal(await page.locator('[aria-label="CD5 layer"] option').count(),2);
        await page.locator('[aria-label="CD5 layer"]').selectOption('1');await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('CD5 4.10')&&!document.querySelector('[data-export]').disabled);
        assert.deepEqual(await rendered(),[0,0,0,255,80,80,80,255,160,160,160,255,255,255,255,255]);
        await page.locator('[aria-label="Zoom"]').selectOption('4');assert.equal(await page.locator('canvas').evaluate(c=>c.style.width),'8px');
        const downloadEvent=page.waitForEvent('download');await page.locator('[data-export]').click();const download=await downloadEvent;
        const png=fs.readFileSync(await download.path());assert.deepEqual(Array.from(png.subarray(0,8)),[137,80,78,71,13,10,26,10]);assert.equal(png.readUInt32BE(16),2);
        // New document cancels queued decode work; closed tabs terminate their worker.
        await page.evaluate(async file=>{const pending=panel.selectLayer(0);await panel.open(new Uint8Array(file),'again.cd5');await pending;},Array.from(fixture));
        assert.deepEqual(await rendered(),[255,0,0,255,0,255,0,128,0,0,255,255,0,0,0,0]);await page.evaluate(()=>events.destroy());assert.equal(await page.evaluate(()=>panel.worker),null);
        // A failed worker propagates its error; reopening restores a fresh worker.
        await page.goto(origin+'/test');await page.evaluate(file=>openCd5(file),Array.from(fixture));
        await assert.rejects(page.evaluate(()=>panel.open(new Uint8Array(32),'invalid.cd5')),/invalid magic/);
        assert.match(await page.locator('[data-status]').innerText(),/invalid magic/);
        await page.evaluate(file=>panel.open(new Uint8Array(file),'restored.cd5'),Array.from(fixture));
        assert.deepEqual(await rendered(),[255,0,0,255,0,255,0,128,0,0,255,255,0,0,0,0]);
        // Standalone file picker uses the same production worker and decoder.
        await page.goto(origin+'/cd5-viewer/');await page.locator('input[type=file]').setInputFiles({name:'colours.cd5',mimeType:'application/octet-stream',buffer:Buffer.from(fixture)});
        await page.waitForFunction(()=>!document.querySelector('[data-export]').disabled);assert.deepEqual(await rendered(),[255,0,0,255,0,255,0,128,0,0,255,255,0,0,0,0]);
        if(process.env.CD5_BROWSER_SAMPLE){
            await page.locator('input[type=file]').setInputFiles(process.env.CD5_BROWSER_SAMPLE);
            await page.waitForFunction(name=>document.querySelector('[data-status]').textContent.includes(name+' · CD5')&&!document.querySelector('[data-export]').disabled,path.basename(process.env.CD5_BROWSER_SAMPLE));
            assert.ok(await page.locator('canvas').evaluate(c=>c.width>2));
        }
        await page.screenshot({path:process.env.CD5_SCREENSHOT || '/tmp/cd5-viewer.png'});
        assert.deepEqual(errors,[]);console.log('PASS: native-answer codec vectors, malformed files, browser worker, layer selection, zoom, PNG export, cancellation, standalone file picker');
    }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main();
