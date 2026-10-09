// Build genuine SHA-1/SHA-256 Git repositories and test the lazy bundle UI.
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');const {once}=require('node:events');
const express=require('express');const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
function fixture(format){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gle-bundle-'));
 const git=(...args)=>execFileSync('git',args,{cwd:directory,stdio:'pipe'});
 git('init','--object-format='+format);git('config','user.name','Viewer fixture');git('config','user.email','fixture@example.invalid');
 fs.mkdirSync(path.join(directory,'nested'));const large=Array.from({length:500},(_,i)=>`line ${i}: content for delta matching\n`).join('');
 fs.writeFileSync(path.join(directory,'nested','large.txt'),large);fs.writeFileSync(path.join(directory,'hello.txt'),'hello bundle\n');git('add','.');git('commit','-m','first fixture');
 fs.writeFileSync(path.join(directory,'nested','large.txt'),large+'new line\n');fs.writeFileSync(path.join(directory,'hello.txt'),'second <script>unsafe()</script> bundle\n');git('add','.');git('commit','-m','second fixture');git('gc');
 git('bundle','create','sample.bundle','--all');const bytes=fs.readFileSync(path.join(directory,'sample.bundle'));fs.rmSync(directory,{recursive:true,force:true});return bytes;
}
async function main(){
 const fixtures=['sha1','sha256'].map(format=>({format,bytes:fixture(format)}));
 const app=express();const requests=[];app.use((req,res,next)=>{requests.push(req.path);next();});
 app.get('/project/test',(_,res)=>res.send(`<div id="host" style="height:650px;width:1200px"></div><script>window.ace={config:{set(){},setModuleUrl(){}},require(){return{}},define(){}};const add=document.addEventListener.bind(document);document.addEventListener=(e,...a)=>{if(e!=='DOMContentLoaded')add(e,...a)};</script><script src="/project/bundle.js"></script>`));app.use('/project',express.static(path.join(root,'public')));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/project/test`);assert(!requests.some(p=>p.includes('viewer-chunks')));
 await page.evaluate(()=>{window.plugin=__gleViewerRequire('shared:src/plugins.js').getPlugins().find(p=>p.id==='git-bundle');window.openBundle=async bytes=>{window.events={};plugin.init({projectFiles:{f:{id:'f',name:'sample.bundle',bytes:new Uint8Array(bytes)}}});window.panel=new plugin.components.bundleViewer({element:document.getElementById('host'),on:(e,fn)=>(events[e]||=[]).push(fn)},{fileId:'f'});await panel.ready;};window.closeBundle=()=>events.destroy.forEach(fn=>fn());});
 for(const {format,bytes} of fixtures){
 await page.evaluate(bytes=>openBundle(bytes),[...bytes]);assert.equal(await page.locator('.git-bundle-list button').count(),2);
 assert.match(await page.locator('.git-bundle-viewer').innerText(),new RegExp(format));
 await page.locator('.git-bundle-tree button').filter({hasText:'hello.txt'}).click();assert.match(await page.locator('.git-bundle-code').innerText(),/second <script>unsafe\(\)<\/script>/);assert.equal(await page.locator('.git-bundle-code script').count(),0);
 const history=page.locator('.git-bundle-list button');await history.filter({hasText:'first fixture'}).click();await page.locator('.git-bundle-tree button').filter({hasText:'hello.txt'}).click();assert.equal(await page.locator('.git-bundle-code').innerText(),'hello bundle\n');
 await page.getByRole('button',{name:'+',exact:true}).click();assert.equal(await page.locator('.git-bundle-viewer').evaluate(el=>el.style.getPropertyValue('--bundle-font-size')),'14.3px');
 await page.evaluate(()=>closeBundle());assert.equal(await page.locator('.git-bundle-viewer').count(),0);console.log(format+': refs/history/tree/blob/deltas/escaping/zoom/disposal passed');
 }
 await assert.rejects(page.evaluate(()=>openBundle([1,2,3])),/header is incomplete/);await page.evaluate(()=>closeBundle());
 assert.equal(requests.filter(p=>/viewer-chunks\/bundle-plugin/.test(p)).length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
