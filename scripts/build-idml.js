// Compile the imported TypeScript and self-host the pinned IDML runtime.
const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');
async function main() {
    const output = path.join(root, 'public/idml-viewer');
    await fs.mkdir(output, {recursive:true});
    const common = {bundle:true,platform:'browser',target:'es2022',legalComments:'eof',logLevel:'warning'};
    await build({...common,entryPoints:[path.join(root,'src/imported-idml/idml.ts')],outfile:path.join(root,'src/imported-idml/viewer.js'),format:'cjs'});
    await build({...common,entryPoints:[path.join(root,'src/imported-idml/idml.worker.ts')],outfile:path.join(output,'worker.js'),format:'esm'});
    const runtime = path.dirname(require.resolve('@paged-media/introspect-wasm'));
    await fs.copyFile(path.join(runtime,'paged_introspect_wasm_bg.wasm'),path.join(output,'introspect.wasm'));
    console.log('Built lazy IDML viewer, module worker and local WASM runtime.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
