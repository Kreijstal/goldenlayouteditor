// Published povrayst 0.1.0 build. Generated WASM is deliberately not committed.
const { createHash } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
async function main() {
    const url = 'https://raw.githubusercontent.com/typst/packages/main/packages/preview/povrayst/0.1.0/povray.wasm';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== '35d2605e7b543a73db472d9d4f7ed8e4bbba91b156d628608819bec89ab80acb') throw new Error('POV-Ray WASM checksum mismatch');
    const directory = path.resolve(__dirname, '../public/povray-viewer');
    await mkdir(directory, { recursive:true });
    await writeFile(path.join(directory, 'povray.wasm'), bytes);
    console.log('Downloaded and verified povrayst 0.1.0');
}
main();
