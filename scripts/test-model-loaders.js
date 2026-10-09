// Exercise the production lazy panel, real USD crate parser and WebGL renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {once} = require('node:events');
const express = require('express');
const {chromium} = require('playwright');
const JSZip = require('jszip');
const root = path.resolve(__dirname,'..');
async function main(){
 const ascii=fs.readFileSync(path.join(__dirname,'fixtures/triangle.usda'));
 const crate=fs.readFileSync(path.join(__dirname,'fixtures/triangle.usdc'));
 const zip=new JSZip();zip.file('triangle.usdc',crate);const usdz=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});
 const samples={ifc:fs.readFileSync(path.join(__dirname,'fixtures/wall.ifc')),obj:Buffer.from('v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n'),stl:Buffer.from('solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 2 0\nendloop\nendfacet\nendsolid triangle'),usda:ascii,usd:crate,usdc:crate,usdz,
 xyz:Buffer.from('0 0 0\n2 0 0\n0 2 0\n'),
 pcd:Buffer.from('VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 3\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 3\nDATA ascii\n0 0 0\n2 0 0\n0 2 0\n'),
 vtk:Buffer.from('# vtk DataFile Version 3.0\ntriangle\nASCII\nDATASET POLYDATA\nPOINTS 3 float\n0 0 0 2 0 0 0 2 0\nPOLYGONS 1 4\n3 0 1 2\n'+ ' '.repeat(250)),
 vtp:Buffer.from('<?xml version="1.0"?><VTKFile type="PolyData" version="0.1" byte_order="LittleEndian"><PolyData><Piece NumberOfPoints="3" NumberOfPolys="1"><PointData/><CellData/><Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 2 0 0 0 2 0</DataArray></Points><Polys><DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray><DataArray type="Int32" Name="offsets" format="ascii">3</DataArray></Polys></Piece></PolyData></VTKFile>')};
 if(process.env.TEST_FBX_PATH)samples.fbx=fs.readFileSync(process.env.TEST_FBX_PATH);
 const app=express();const requests=[];let blockWasm=false,blockedResolve,blockedResponse;app.use((req,res,next)=>{requests.push(req.path);if(blockWasm&&req.path.endsWith('/ifc-viewer/web-ifc.wasm')){blockedResponse=res;blockedResolve();return;}next();});
 app.get('/project/test',(_,res)=>res.send(`<div id="host" style="width:900px;height:600px"></div><script>const NativeWorker=Worker;window.activeWorkers=new Set();window.Worker=class extends NativeWorker{constructor(...a){super(...a);activeWorkers.add(this);}terminate(){activeWorkers.delete(this);return super.terminate();}};window.ace={config:{set(){},setModuleUrl(){}},require(){return{}},define(){}};const add=document.addEventListener.bind(document);document.addEventListener=(e,...a)=>{if(e!=='DOMContentLoaded')add(e,...a)};</script><script src="/project/bundle.js"></script>`));
 app.use('/project',express.static(path.join(root,'public')));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM_PATH,headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
 const page=await browser.newPage();const errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!/^(http:\/\/127\.0\.0\.1:|blob:|data:)/.test(r.url()))external.push(r.url());});
 await page.goto(`http://127.0.0.1:${server.address().port}/project/test`);
 assert(!requests.some(p=>/viewer-chunks|model3d-runtime|ifc-viewer/.test(p)),'no model download at startup');
 await page.evaluate(()=>{window.plugin=__gleViewerRequire('shared:src/plugins.js').getPlugins().find(p=>p.id==='model3d');window.openModel=async(name,bytes)=>{window.events={};plugin.init({projectFiles:{f:{id:'f',name,bytes:new Uint8Array(bytes)}}});window.panel=new plugin.components.model3dViewer({element:document.getElementById('host'),on:(e,fn)=>(events[e]||=[]).push(fn)},{fileId:'f'});await panel.ready;};window.closeModel=()=>events.destroy.forEach(f=>f());});
 for(const [ext,bytes] of Object.entries(samples)){
 await page.evaluate(({name,bytes})=>openModel(name,bytes),{name:'sample.'+ext,bytes:[...bytes]});
 const stats=await page.evaluate(()=>{const model=panel.model;let vertices=0;model.traverse(o=>{vertices+=o.geometry?.getAttribute('position')?.count||0;});const size=new panel.THREE.Box3().setFromObject(model).getSize(new panel.THREE.Vector3());return {vertices,bounds:size.toArray(),rendered:panel.renderer.info.render.calls};});
 assert(stats.vertices>=3,ext+' parsed vertices');assert(stats.bounds.every(Number.isFinite),ext+' finite bounds');assert(stats.rendered>0,ext+' actual WebGL draw');
 if(ext==='ifc')stats.bounds.forEach((n,i)=>assert(Math.abs(n-[4,3,0.2][i])<0.0001));
 if(ext!=='fbx' && ext!=='stl' && ext!=='ifc')assert.deepEqual(stats.bounds,[2,2,0]);
 assert(await page.locator('.model3d-stage canvas').count());await page.getByRole('button',{name:'Wireframe',exact:true}).click();await page.getByRole('button',{name:'Reset',exact:true}).click();await page.evaluate(()=>closeModel());
 assert.equal(await page.evaluate(()=>activeWorkers.size),0,'native worker disposed');
 console.log(ext+': geometry, bounds, WebGL, controls and cleanup passed');
 }
 blockWasm=true;const blocked=new Promise(resolve=>blockedResolve=resolve);const opening=page.evaluate(bytes=>openModel('closing.ifc',bytes),[...samples.ifc]);await blocked;await page.evaluate(()=>closeModel());await opening;assert.equal(await page.evaluate(()=>activeWorkers.size),0);blockedResponse.end();blockWasm=false;
 await assert.rejects(page.evaluate(()=>openModel('bad.ifc',[1,2,3])),/Not an IFC STEP/);await page.evaluate(()=>closeModel());
 await assert.rejects(page.evaluate(()=>openModel('bad.usdc',[0,1,2,3])),/Not a USD/);await page.evaluate(()=>closeModel());
 assert.equal(requests.filter(p=>p==='/project/model3d-runtime/loaders.js').length,1,'cached runtime import');assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 console.log('All model tests passed; startup remains lazy and requests stay local.');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
