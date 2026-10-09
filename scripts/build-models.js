const {build} = require('esbuild');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
build({entryPoints:[path.join(root,'src/model-loaders.mjs')],outfile:path.join(root,'public/model3d-runtime/loaders.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'eof'}).catch(error=>{console.error(error);process.exitCode=1;});
