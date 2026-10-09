const {build}=require('esbuild');const path=require('node:path');const root=path.resolve(__dirname,'..');
build({entryPoints:[path.join(root,'src/imported-adobe/worker.ts')],outfile:path.join(root,'public/adobe-viewer/worker.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'eof'}).catch(error=>{console.error(error);process.exitCode=1;});
