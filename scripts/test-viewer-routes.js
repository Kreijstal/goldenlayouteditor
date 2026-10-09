// Verify that newly supported suffixes reach their reader before generic routes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const acorn=require('acorn'),walk=require('acorn-walk');
const source=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');const ast=acorn.parse(source,{ecmaVersion:'latest',sourceType:'script'});let init;
walk.simple(ast,{VariableDeclarator(node){if(node.id.name==='FILE_VIEWERS')init=node.init;}});assert(init);
// Name-sniffing predicates are irrelevant for these unambiguous suffixes; keep
// them callable while evaluating the actual route array and regular expressions.
const bindings={};walk.simple(init,{Identifier(node){bindings[node.name]=()=>true;}});
const routes=vm.runInNewContext('('+source.slice(init.start,init.end)+')',bindings);
const groups={model3dViewer:'usd usda usdc usdz fbx pcd vtk vtp xyz ifc',bundleViewer:'bundle',scientificViewer:'h5 hdf hdf5 he5 nc nc4 netcdf npy npz',archiveReader:'7z ar cpio cab rar cbr cb7 cbt xar zipx bz2 bzip2 xz lzma lha lzh rpm srpm deb udeb tbz tbz2 txz tar.bz2 tar.xz gzip aab mcpack mctemplate mcworld',adobeContainerViewer:'indd indt xd icml idms inx ase aco'};
let count=0;for(const [component,formats] of Object.entries(groups))for(const format of formats.split(' ')){const route=routes.find(r=>r.re.test('sample.'+format));assert.equal(route?.componentType,component,format+' default reader');count++;}
console.log(count+' imported-format routes select their actual readers.');
