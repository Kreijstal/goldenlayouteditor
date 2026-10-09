const {build} = require('esbuild');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
build({entryPoints:[path.join(root,'src/imported-bundle/gitBundle.ts')],outfile:path.join(root,'src/imported-bundle/viewer.js'),bundle:true,format:'cjs',platform:'browser',target:'es2022',legalComments:'eof'}).catch(error=>{console.error(error);process.exitCode=1;});
