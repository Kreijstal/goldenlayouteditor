const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {once}=require('node:events'),express=require('express'),{chromium}=require('playwright');
const {fixture}=require('./loop-fixtures');
async function main(){
 const root=path.resolve(__dirname,'..'),app=express(),requests=[];
 app.use((req,res,next)=>{requests.push(req.path);next();});
 app.get('/project/test',(_,res)=>res.send(`<div id="host" style="height:700px;width:1100px"></div><script>window.ace={config:{set(){},setModuleUrl(){}},require(){return{}},define(){}};const add=document.addEventListener.bind(document);document.addEventListener=(e,...a)=>{if(e!=='DOMContentLoaded')add(e,...a)};</script><script src="/project/bundle.js"></script>`));
 app.use('/project',express.static(path.join(root,'public')));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/project/test`);
  assert(!requests.some(p=>p.includes('viewer-chunks')));
  const menu=await page.evaluate(()=>{
   window.plugin=__gleViewerRequire('shared:src/plugins.js').getPlugins().find(p=>p.id==='loop');
   return plugin.contextMenuItems[0].canHandle('sample.LOOP');
  });assert.equal(menu,true);assert(!requests.some(p=>p.includes('viewer-chunks')));
  const open=async(bytes)=>page.evaluate(async bytes=>{
   window.events={};plugin.init({projectFiles:{f:{id:'f',name:'sample.loop',bytes:new Uint8Array(bytes)}}});
   window.panel=new plugin.components.loopViewer({element:document.getElementById('host'),on:(e,fn)=>(events[e]||=[]).push(fn)},{fileId:'f'});await panel.ready;
  },[...bytes]);
  await open(fixture());
  assert((await page.locator('.loop-document').innerText()).includes('Hallo, 世界! <script>parent.hacked=1</script>'));
  assert.equal(await page.locator('.loop-document script,.loop-document img').count(),0);
  assert.equal(await page.evaluate(()=>window.hacked),undefined);
  assert.equal(await page.locator('.loop-document span').evaluate(el=>el.style.fontWeight),'bold');
  assert.equal(await page.locator('.loop-structure').count(),1);
  await page.evaluate(()=>events.destroy.forEach(fn=>fn()));assert.equal(await page.locator('.loop-document').count(),0);
  await open(fixture({empty:true}));assert((await page.locator('.loop-document').innerText()).includes('Empty paragraph component'));
  await page.evaluate(()=>events.destroy.forEach(fn=>fn()));
  if(process.argv[2]) {await open(fs.readFileSync(process.argv[2]));assert.equal(await page.evaluate(()=>panel.model.entries.length),22);assert((await page.locator('.loop-document').innerText()).includes('Empty paragraph component'));await page.evaluate(()=>events.destroy.forEach(fn=>fn()));}
  assert.equal(requests.filter(p=>/viewer-chunks\/loop-plugin/.test(p)).length,1);assert.deepEqual(errors,[]);
  console.log('Loop browser: production lazy chunk, synchronous menu, Unicode text safety, formatting, empty sample and disposal passed.');
 } finally {await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
