const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {once}=require('node:events');const express=require('express');const {chromium}=require('playwright');const {classicNetcdf,numpyFixtures}=require('./scientific-fixtures');
const root=path.resolve(__dirname,'..');
async function main(){
 const fixtures={...await numpyFixtures(),nc:classicNetcdf(),h5:fs.readFileSync(path.join(__dirname,'fixtures/scientific.h5'))};
 const app=express();const requests=[];let delayWorker=false,blockedResolve,blockedResponse;
 app.use((req,res,next)=>{requests.push(req.path);if(delayWorker&&req.path.endsWith('/scientific-worker.js')){blockedResponse=res;blockedResolve();return;}next();});
 app.get('/project/test',(_,res)=>res.send(`<div id="host" style="height:650px;width:1200px"></div><script>window.ace={config:{set(){},setModuleUrl(){}},require(){return{}},define(){}};const add=document.addEventListener.bind(document);document.addEventListener=(e,...a)=>{if(e!=='DOMContentLoaded')add(e,...a)};const NativeWorker=Worker;window.activeWorkers=new Set();window.Worker=class extends NativeWorker{constructor(...a){super(...a);activeWorkers.add(this);}terminate(){activeWorkers.delete(this);return super.terminate();}};</script><script src="/project/bundle.js"></script>`));app.use('/project',express.static(path.join(root,'public')));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try{const page=await browser.newPage();const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!/^(http:\/\/127\.0\.0\.1:|blob:|data:)/.test(r.url()))external.push(r.url());});await page.goto(`http://127.0.0.1:${server.address().port}/project/test`);assert(!requests.some(p=>/viewer-chunks|scientific-viewer/.test(p)));
 await page.evaluate(()=>{window.plugin=__gleViewerRequire('shared:src/plugins.js').getPlugins().find(p=>p.id==='scientific-data');window.openScientific=async(name,bytes)=>{window.events={};plugin.init({projectFiles:{f:{id:'f',name,bytes:new Uint8Array(bytes)}}});window.panel=new plugin.components.scientificViewer({element:document.getElementById('host'),on:(e,fn)=>(events[e]||=[]).push(fn)},{fileId:'f'});await panel.ready;};window.closeScientific=()=>events.destroy.forEach(fn=>fn());});
 for(const [ext,bytes] of Object.entries(fixtures)){
  await page.evaluate(({name,bytes})=>openScientific(name,bytes),{name:'sample.'+ext,bytes:[...bytes]});
  if(ext==='h5')await page.locator('.scientific-datasets button').filter({hasText:'/experiment/values'}).click();
  const values=await page.locator('.scientific-values tr td:nth-child(2)').allTextContents();assert.deepEqual(values,ext==='nc'?['1.5','2.5','3.5']:ext==='h5'?['1','2','3']:['1','2','3','4','5','6']);
  if(ext==='npy'||ext==='npz')assert(!requests.some(p=>p.includes('hdf5_hl')),'NumPy must not load HDF5 WASM');
  if(ext==='npy'||ext==='npz')assert.match(await page.locator('.scientific-detail').innerText(),/\[2,3\]/);
  if(ext==='npz')assert.equal(await page.locator('.scientific-datasets button').count(),2);
  if(ext==='h5'){assert.match(await page.locator('.scientific-detail').innerText(),/measurement/);assert.match(await page.locator('.scientific-detail').innerText(),/degrees/);}
  await page.getByRole('searchbox',{name:'Find dataset'}).fill(ext==='h5'?'values':'does-not-exist');assert.equal(await page.locator('.scientific-datasets button:visible').count(),ext==='h5'?1:0);
  assert.equal(await page.evaluate(()=>activeWorkers.size),0,'completed worker terminated');await page.evaluate(()=>closeScientific());console.log(ext+': real values, dimensions, selection, search and cleanup passed');
 }
 assert(!requests.some(p=>p.includes('hdf5_hl')&&p.includes('http:')));assert.deepEqual(external,[]);
 for(const [file,expected] of [['scientific-big-endian.npy',['1','2','3','4','5','6']],['scientific-fortran.npy',['1','4','2','5','3','6']]]){await page.evaluate(bytes=>openScientific('sample.npy',bytes),[...fs.readFileSync(path.join(__dirname,'fixtures',file))]);assert.deepEqual(await page.locator('.scientific-values tr td:nth-child(2)').allTextContents(),expected);await page.evaluate(()=>closeScientific());}
 await assert.rejects(page.evaluate(()=>openScientific('bad.npy',[1,2,3])),/Truncated NumPy header/);await page.evaluate(()=>closeScientific());
 delayWorker=true;const blocked=new Promise(resolve=>blockedResolve=resolve);const opening=page.evaluate(bytes=>openScientific('closing.h5',bytes),[...fixtures.h5]);await blocked;await page.evaluate(()=>closeScientific());await opening;assert.equal(await page.evaluate(()=>activeWorkers.size),0);blockedResponse.end();delayWorker=false;
 assert.equal(requests.filter(p=>/viewer-chunks\/scientific-plugin/.test(p)).length,1);assert.deepEqual(errors,[]);console.log('Scientific startup laziness, local requests, cancellation and errors passed.');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
