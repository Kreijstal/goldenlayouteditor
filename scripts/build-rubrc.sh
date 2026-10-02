#!/bin/sh
# Builds what the Rust toolchain (src/rubrc-plugin.js, used by the in-browser shell) loads, into $RUBRC_OUT
# (default ~/git/rubrc-site; published as @kreijstal/rubrc by ~/git/npm-publish/stage-rubrc.sh):
#   host.js                the page side, scripts/rubrc/host.js bundled against Rubrc's sources
#   worker.js, child_process_worker.js, and the files they load (the 384 MB
#   toolchain as three brotli parts): copied from Rubrc's deployed site, since
#   building the toolchain needs its wasi_virt_layer setup
# Needs git, bun and node. RUBRC_SRC (default ~/git/rubrc) is the checkout used.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${RUBRC_OUT:-$HOME/git/rubrc-site}
src=${RUBRC_SRC:-$HOME/git/rubrc}
rev=807ace9e9cf266b1b1004372abdefc2152785d69 # main, which rubrc.pages.dev is built from
site=https://rubrc.pages.dev/

[ -d "$src/.git" ] || git clone -q --filter=blob:limit=1m https://github.com/oligamiq/rubrc.git "$src"
git -C "$src" fetch -q --depth 1 origin "$rev"
git -C "$src" -c advice.detachedHead=false checkout -q "$rev"
(cd "$src" && bun install --frozen-lockfile)

mkdir -p "$src/embed" "$out"
cp "$here/rubrc/host.js" "$src/embed/host.js"
cat > "$src/embed/vite.config.mjs" <<EOF
import { defineConfig } from "vite";
export default defineConfig({
    root: "$src/embed",
    optimizeDeps: { exclude: ["brotli-dec-wasm"] },
    build: {
        target: "esnext",
        outDir: "$out",
        emptyOutDir: false,
        lib: { entry: "$src/embed/host.js", formats: ["es"], fileName: () => "host.js" },
    },
});
EOF
(cd "$src" && ./node_modules/.bin/vite build -c embed/vite.config.mjs)

# The worker files: found from the deployed page, then everything they name
node - "$site" "$out" <<'EOF'
const [site, out] = process.argv.slice(2);
const fs = await import('node:fs');
const get = async name => {
    const r = await fetch(new URL('assets/' + name, site));
    if (!r.ok || /text\/html/.test(r.headers.get('content-type'))) throw new Error(`${name}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
};
const page = await (await fetch(site)).text();
const index = (await get(page.match(/assets\/(index-[\w-]+\.js)/)[1])).toString();
const app = (await get(index.match(/\.\/(App-[\w-]+\.js)/)[1])).toString();
// worker-*.js there only exports the real worker's URL
const workerUrlModule = (await get(index.match(/import\(`\.\/(worker-[\w-]+\.js)`\)/)[1])).toString();
const entries = {
    'worker.js': workerUrlModule.match(/`(worker-[\w-]+\.js)`/)[1],
    'child_process_worker.js': app.match(/`(child_process_worker-[\w-]+\.js)`/)[1],
};
const seen = new Set();
const queue = Object.values(entries);
while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const file = `${out}/${name}`;
    const data = fs.existsSync(file) && /-[\w-]{8}\./.test(name) ? fs.readFileSync(file) : await get(name);
    fs.writeFileSync(file, data);
    console.log(data.length, name);
    if (/\.wasm\.br\.json$/.test(name)) { for (const p of JSON.parse(data).parts) queue.push(p.file); continue; }
    if (!name.endsWith('.js')) continue;
    for (const m of data.toString().matchAll(/[`"'](?:\.\/)?([\w.-]+-[\w-]{8}\.(?:js|wasm))[?`"']/g)) {
        // The toolchain is named as .wasm but served as a manifest of brotli parts
        queue.push(m[1].startsWith('vfs.core-') ? m[1] + '.br.json' : m[1]);
    }
}
// Stable names for host.js to start
for (const [alias, name] of Object.entries(entries)) fs.writeFileSync(`${out}/${alias}`, `import "./${name}";\n`);
EOF
