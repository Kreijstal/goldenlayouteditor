const {build}=require('esbuild');const path=require('node:path');const root=path.resolve(__dirname,'..');
build({entryPoints:[path.join(root,'src/scientific-worker.mjs')],outdir:path.join(root,'public/scientific-viewer'),bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',legalComments:'eof'}).catch(error=>{console.error(error);process.exitCode=1;});
