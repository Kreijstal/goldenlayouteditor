// Module worker running command-line WebAssembly tools on a copy of a folder,
// for the in-browser shell (src/wanix-plugin.js):
//   clang, clang++, wasm-ld, ar, … : LLVM from YoWASP (yowasp.org), with a
//     wasm32-wasip1 C library; downloaded (about 100 MB) the first time used
//   run: any WASI (preview 1) program, with browser_wasi_shim
// The folder comes in as { 'rel/path': Uint8Array } and is the program's /
// and its working directory; the files it made or changed go back.
//   → { type: 'run', tool, args, files }          tool: a YoWASP command or 'wasi'
//   ← { type: 'out', fd, data } … { type: 'progress', text }
//   ← { type: 'done', code, files } | { type: 'error', message }
import * as shim from 'https://esm.sh/@bjorn3/browser_wasi_shim@0.4.2';

const YOWASP_CLANG = 'https://cdn.jsdelivr.net/npm/@yowasp/clang@22.0.0-git20542-10/gen/bundle.js';
let yowasp = null;

const out = fd => data => { if (data && data.length) self.postMessage({ type: 'out', fd, data }); };

// { a: { b: bytes } } ⇄ { 'a/b': bytes }
function toTree(files) {
    const tree = {};
    for (const [path, data] of Object.entries(files)) {
        const parts = path.split('/');
        const name = parts.pop();
        let d = tree;
        for (const p of parts) d = d[p] = d[p] || {};
        d[name] = data;
    }
    return tree;
}
function flatten(tree, prefix = '', acc = {}) {
    for (const [name, v] of Object.entries(tree)) {
        if (v instanceof Uint8Array) acc[prefix + name] = v;
        else if (typeof v === 'string') acc[prefix + name] = new TextEncoder().encode(v);
        else if (v && typeof v === 'object') flatten(v, prefix + name + '/', acc);
    }
    return acc;
}
function changed(before, after) {
    const res = {};
    for (const [path, data] of Object.entries(after)) {
        const old = before[path];
        if (old && old.length === data.length && old.every((b, i) => b === data[i])) continue;
        res[path] = data;
    }
    return res;
}

async function runYowasp(tool, args, files) {
    if (!yowasp) {
        self.postMessage({ type: 'progress', text: 'Loading LLVM (about 100 MB the first time)…' });
        yowasp = await import(YOWASP_CLANG);
    }
    const command = yowasp.commands[tool];
    if (!command) throw new Error(`${tool}: not an LLVM tool here`);
    let lastShown = 0;
    try {
        const tree = await command(args, toTree(files), {
            stdout: out(1),
            stderr: out(2),
            fetchProgress: ({ totalLength, doneLength }) => {
                const pct = Math.floor(100 * doneLength / (totalLength || 1));
                if (pct >= lastShown + 10 || pct === 100) {
                    lastShown = pct;
                    self.postMessage({ type: 'progress', text: `Downloading LLVM… ${pct}%` });
                }
            },
        });
        return { code: 0, files: tree ? flatten(tree) : {} };
    } catch (err) {
        if (err instanceof yowasp.Exit) return { code: err.code, files: err.files ? flatten(err.files) : {} };
        throw err;
    }
}

function runWasi(args, files) {
    const { WASI, File, Directory, OpenFile, ConsoleStdout, PreopenDirectory } = shim;
    const root = new Map();
    for (const [path, data] of Object.entries(files)) {
        const parts = path.split('/');
        const name = parts.pop();
        let d = root;
        for (const p of parts) {
            let next = d.get(p);
            if (!(next instanceof Directory)) { next = new Directory(new Map()); d.set(p, next); }
            d = next.contents;
        }
        d.set(name, new File(data.slice()));
    }
    const path = args[0].replace(/^\.\//, '');
    const wasm = files[path];
    if (!wasm) return { code: 127, files: {}, message: `${args[0]}: no such file` };
    const send = fd => ({ write: data => out(fd)(data.slice()) });
    const wasi = new WASI(args, [], [
        new OpenFile(new File(new Uint8Array(0))), // no stdin
        new ConsoleStdout(send(1).write),
        new ConsoleStdout(send(2).write),
        new PreopenDirectory('/', root),
        new PreopenDirectory('.', root),
    ]);
    const module = new WebAssembly.Module(wasm);
    const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport });
    let code = 0;
    try {
        code = wasi.start(instance);
    } catch (err) {
        if (err && err.code !== undefined && /exit/i.test(err.constructor?.name || '')) code = err.code;
        else { out(2)(new TextEncoder().encode(`${args[0]}: ${err.message || err}\n`)); code = 134; }
    }
    const after = {};
    const walk = (dir, prefix) => {
        for (const [name, node] of dir) {
            if (node instanceof Directory) walk(node.contents, prefix + name + '/');
            else if (node instanceof File) after[prefix + name] = node.data;
        }
    };
    walk(root, '');
    return { code, files: after };
}

self.onmessage = async ({ data }) => {
    if (data.type !== 'run') return;
    try {
        const r = data.tool === 'wasi' ? runWasi(data.args, data.files) : await runYowasp(data.tool, data.args, data.files);
        if (r.message) out(2)(new TextEncoder().encode(r.message + '\n'));
        const files = changed(data.files, r.files);
        self.postMessage({ type: 'done', code: r.code, files });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
