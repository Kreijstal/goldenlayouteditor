const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');const root=path.resolve(__dirname,'..'),PIN='f3934e9a75fe01d6fd74830e996a0111a7dc4fc2';
let source=process.env.GOLDENLAYOUT_UPSTREAM_SOURCE||path.join(root,'.cache/jdeworks-file-viewer');
if(!fs.existsSync(path.join(source,'.git'))){fs.mkdirSync(source,{recursive:true});execFileSync('git',['init',source],{stdio:'inherit'});execFileSync('git',['-C',source,'remote','add','origin','https://github.com/jdeworks/file-viewer.git'],{stdio:'inherit'});execFileSync('git',['-C',source,'fetch','--depth','1','origin',PIN],{stdio:'inherit'});execFileSync('git',['-C',source,'checkout','--detach','FETCH_HEAD'],{stdio:'inherit'});}
if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==PIN)throw Error('Upstream reader source must match pinned commit '+PIN);
const output=path.join(root,'public/upstream-viewer');fs.mkdirSync(output,{recursive:true});for(const folder of ['core','types','vendor','assets'])fs.cpSync(path.join(source,'docs',folder),path.join(output,folder),{recursive:true});
for(const name of ['bridge.html','bridge.js','lmms.js','bplist.js','gff.js','bcf.js','bcf-worker.js','bcf-view.js','shortcut.js','signature.js','project-xml.js','kicad.js','cp437.js','gcode.js','typst.js','docextras.js','odf.js','browser-text.js','binary-extras.js','sheetaliases.js','adobealiases.js','diagrams.js','office-packages.js','ofd.js','acis.js','blend-backups.js','ofc.js','parasolid.js','solidworks.js','lrf.js','olb.js','dra.js','azw3.js','lrx.js'])fs.copyFileSync(path.join(root,'src/imported-upstream',name),path.join(output,name));fs.copyFileSync(path.join(source,'LICENSE'),path.join(output,'LICENSE'));console.log('Built pinned upstream reader pack; parsers and vendor assets load individually on demand.');

require('esbuild').build({entryPoints:[path.join(root,'src/imported-upstream/json5.js')],outfile:path.join(output,'json5-parser.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'eof'}).catch(error=>{console.error(error);process.exitCode=1;});
fs.copyFileSync(path.join(root,'public/licenses/imported-viewers/json5-MIT.txt'),path.join(output,'json5-LICENSE.txt'));

// Keep upstream on-click molecular rendering, but make replacement teardown final.
const molecularPath=path.join(output,'core/molview.js');let molecular=fs.readFileSync(molecularPath,'utf8');
for(const [before,after] of [
 ['let viewer = null;', 'let disposed = false;\n  let viewer = null;'],
 ['function teardown() {','function teardown() {\n    disposed = true;\n    if (viewer) { viewer.spin(false); const canvas = panel.querySelector("canvas"); const gl = canvas?.getContext("webgl"); gl?.getExtension("WEBGL_lose_context")?.loseContext(); }'],
 ['if (mounted || loading) return;', 'if (disposed || mounted || loading) return;'],
 ['loading = false;\n    mounted = true;', 'loading = false;\n    if (disposed) return;\n    mounted = true;']
]){if(!molecular.includes(before))throw Error('Pinned molecular cleanup patch mismatch');molecular=molecular.replace(before,after);}fs.writeFileSync(molecularPath,molecular);

const swiftPath=path.join(output,'types/text/mt940/renderer.js');const swift=fs.readFileSync(swiftPath,'utf8');const before='|\\Z)/mg';if(!swift.includes(before))throw Error('Pinned SWIFT end-of-input patch mismatch');fs.writeFileSync(swiftPath,swift.replace(before,'|(?![\\s\\S]))/mg'));
const thriftPath=path.join(output,'types/text/thrift/renderer.js');let thrift=fs.readFileSync(thriftPath,'utf8');const thriftBefore='\\s*[,;]/g;';if(!thrift.includes(thriftBefore))throw Error('Pinned Thrift last-field patch mismatch');thrift=thrift.replace(thriftBefore,'\\s*(?:[,;]|$)/g;');fs.writeFileSync(thriftPath,thrift);
const hydrogenPath=path.join(output,'types/text/hydrogen/renderer.js');const hydrogen=fs.readFileSync(hydrogenPath,'utf8');const hydrogenBefore='/<hydrogen_drumkit>/i';if(!hydrogen.includes(hydrogenBefore))throw Error('Pinned Hydrogen root patch mismatch');fs.writeFileSync(hydrogenPath,hydrogen.replace(hydrogenBefore,'/<(?:hydrogen_)?drumkit\\b/i'));
