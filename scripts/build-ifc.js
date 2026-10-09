const {build}=require('esbuild');const fs=require('node:fs/promises');const path=require('node:path');const root=path.resolve(__dirname,'..');
async function main(){
 const output=path.join(root,'public/ifc-viewer');await fs.mkdir(output,{recursive:true});
 await build({entryPoints:[path.join(root,'src/ifc-worker.mjs')],outfile:path.join(output,'worker.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'eof'});
 await fs.copyFile(require.resolve('web-ifc/web-ifc.wasm'),path.join(output,'web-ifc.wasm'));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
