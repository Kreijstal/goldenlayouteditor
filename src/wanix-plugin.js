// --- Wanix shell ---
// A shell that runs in the browser: Wanix (github.com/tractordev/wanix), a
// Plan 9-style namespace and Go/WASI runtime compiled to WebAssembly, running
// its rc shell. It needs no server, so the terminal falls back to it when the
// server's PTY is not there, and it can be opened on its own from Plugins.
//
// It is the one in-browser shell: the terminal's fallback, the rc panel, and
// JupyterLite's terminals (src/jupyterlite-plugin.js) are all sessions of it.
// Besides rc's commands it runs cargo and rustc (in Rubrc), clang and the
// other LLVM tools, and .wasm programs, all on the same files.
//
// One Wanix namespace is shared by every shell. The project is copied into
// its project/ folder when it starts, and kept in step while a shell is open:
// files changed in the shell go back to the server (or to the in-memory
// project), and what is edited in editors or saved in JupyterLite comes into
// the shell. Deleting a file in the shell deletes nothing outside it.
const { registerPlugin } = require('./plugins');
const { ensureXtermLoaded, makeTerminal } = require('./terminal');
const { createLogger } = require('./debug');
const log = createLogger('Wanix');

const WANIX_VERSION = '0.4.0-rc2';
const WANIX_URL = `https://cdn.jsdelivr.net/npm/wanix@${WANIX_VERSION}/dist/wanix.min.js`;
// The kernel built with Go, not the default TinyGo one: under TinyGo, opening
// a file that is not there yet with O_CREATE fails, so the shell cannot make files
const KERNEL_URL = `https://cdn.jsdelivr.net/npm/wanix@${WANIX_VERSION}/dist/wanix.debug.wasm`;
// rc, built from Wanix's sources with a fix by scripts/build-wanix.sh (npm run build:wanix)
const RC_URL = 'wanix-rc.wasm';
const NS_ID = 'gle-wanix';
const OPFS_DIR = 'Browser storage'; // LocalFS.OPFS_NAME
const PROJECT = 'project';
const MAX_FILES = 1000, MAX_DIRS = 200, MAX_FILE_SIZE = 4 * 1024 * 1024;
const SKIP_DIR_RE = /^(node_modules|\.git|__pycache__|\.cache)$/;
const SYNC_INTERVAL = 1500;

let ctx = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// ---- the namespace ----
let booting = null;

// Two bugs of Wanix's worker for Go programs (gojs/worker/worker.js, in 0.4.0-rc2
// and its main branch), fixed in its source as the kernel makes the worker
// from it: a #device path is put under the current folder like any relative
// one, so rc starts no program from a folder other than /; and a program named
// by an absolute path (/bin/clang, as rc's PATH lookup gives) is not found
function patchGoWorker() {
    if (window.Blob.gleGoWorker) return;
    const NativeBlob = window.Blob;
    window.Blob = new Proxy(NativeBlob, {
        construct(target, [parts, options], newTarget) {
            if (Array.isArray(parts) && parts.length === 1 && typeof parts[0] === 'string' && parts[0].includes('gojs worker started')) {
                parts = [parts[0]
                    .replace('if (!path.startsWith("/")) {', 'if (!path.startsWith("/") && !path.startsWith("#")) {')
                    .replace('fs.readFile(args[0])', 'fs.readFile(args[0].replace(/^\\/+/, ""))')];
            }
            return Reflect.construct(target, [parts, options], newTarget);
        },
        get(target, key) {
            return key === 'gleGoWorker' ? true : Reflect.get(target, key);
        },
    });
}

function bootWanix(onProgress) {
    if (booting) return booting;
    booting = (async () => {
        onProgress('Loading Wanix…');
        patchGoWorker();
        await import(WANIX_URL);
        const ns = document.createElement('wanix-namespace');
        ns.id = NS_ID;
        ns.setAttribute('wasm', KERNEL_URL);
        // The browser's private storage is mounted in it as in the editor's tree (src/vfs.js)
        ns.innerHTML = '<wanix-bind dst="." src="#ramfs/new"></wanix-bind>'
            + `<wanix-bind type="file" dst="rc.wasm" perm="0755" src="${RC_URL}"></wanix-bind>`
            + `<wanix-bind dst="${OPFS_DIR}" src="#web/opfs"></wanix-bind>`;
        onProgress('Starting Wanix (6 MB the first time)…');
        await new Promise((resolve, reject) => {
            ns.addEventListener('ready', resolve, { once: true });
            ns.addEventListener('error', e => reject((e.detail && e.detail.error) || new Error('Wanix did not start')), { once: true });
            document.body.appendChild(ns);
        });
        const root = ns.root;
        await makeDirs(root, PROJECT);
        return { ns, root };
    })();
    booting.catch(() => { booting = null; });
    return booting;
}

// The project is copied in when the first shell starts (not when the editor's
// tree merely shows the namespace)
let copying = null;
function copyProjectIn(root, onProgress) {
    if (!copying) {
        onProgress('Copying the project in…');
        copying = sync.copyIn(root);
        copying.catch(() => { copying = null; });
    }
    return copying;
}

// A path in a folder of the namespace ('.' is its top)
function inDir(dir, rel) {
    return dir === '.' || !dir ? rel : `${dir}/${rel}`;
}

// Wanix's makeDirAll fails when it has more than one folder to make
// ("resolve: operation not supported"); makeDir one level at a time works
async function makeDirs(root, path) {
    let at = '';
    for (const part of path.split('/').filter(Boolean)) {
        at = at ? `${at}/${part}` : part;
        try { await root.stat(at); continue; } catch { /* not there yet */ }
        await root.makeDir(at);
    }
}

// ---- keeping project/ in step ----
// rel path -> { sig: size:mtime in Wanix, text: last content both sides agreed on (text files) }
const sync = {
    known: new Map(),
    shells: 0,
    timer: null,
    busy: false,

    workspace() {
        const ws = ctx && ctx.currentWorkspacePath;
        return ws && ctx.wsClient && ctx.wsClient.isConnected() ? ws.replace(/\/+$/, '') : null;
    },

    // The project's files as { rel: { abs } } (workspace) or { rel: { fileId } } (in memory)
    async listSources() {
        const out = new Map();
        if (!ctx) return out;
        const ws = this.workspace();
        if (ws) {
            const queue = [[ws, '']];
            let dirs = 0;
            while (queue.length && out.size < MAX_FILES && dirs < MAX_DIRS) {
                const [abs, rel] = queue.shift();
                dirs++;
                const res = await ctx.wsClient.wsRequest({ type: 'browseDir', path: abs });
                if (res.error) continue;
                for (const item of res.items || []) {
                    if (item.type === 'directory') {
                        if (!SKIP_DIR_RE.test(item.name)) queue.push([abs + '/' + item.name, rel + item.name + '/']);
                    } else if (item.size <= MAX_FILE_SIZE && out.size < MAX_FILES) {
                        out.set(rel + item.name, { abs: abs + '/' + item.name });
                    }
                }
            }
        }
        for (const f of Object.values(ctx.projectFiles)) {
            if (f.lazy || typeof f.content !== 'string') continue;
            const rel = ctx.getRelativePath(f.id) || f.name;
            out.set(rel, Object.assign(out.get(rel) || {}, { fileId: f.id }));
        }
        return out;
    },

    async put(root, rel, data) {
        const dir = rel.includes('/') ? rel.replace(/\/[^/]*$/, '') : '';
        if (dir) await makeDirs(root, `${PROJECT}/${dir}`);
        await root.writeFile(`${PROJECT}/${rel}`, data);
        const st = await root.stat(`${PROJECT}/${rel}`);
        return `${st.Size}:${st.ModTime}`;
    },

    async copyIn(root) {
        const sources = await this.listSources();
        await Promise.all([...sources].map(async ([rel, src]) => {
            try {
                let data;
                const open = src.fileId && ctx.projectFiles[src.fileId];
                if (open && !open.lazy && typeof open.content === 'string') data = open.content;
                else if (src.abs) {
                    const res = await fetch('/workspace-file?path=' + encodeURIComponent(src.abs));
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    data = new Uint8Array(await res.arrayBuffer());
                } else return;
                const text = typeof data === 'string' ? data : asText(data);
                const sig = await this.put(root, rel, typeof data === 'string' ? encoder.encode(data) : data);
                this.known.set(rel, { sig, text });
            } catch (err) {
                log.warn('Could not copy in', rel, err);
            }
        }));
        log.log('Copied in', this.known.size, 'files');
    },

    async walk(root, dir, rel, out) {
        let entries;
        try { entries = await root.readDir(dir); } catch (e) { return; }
        for (const name of entries || []) {
            if (name.endsWith('/')) {
                if (!SKIP_DIR_RE.test(name.slice(0, -1))) await this.walk(root, inDir(dir, name.slice(0, -1)), rel + name, out);
            } else {
                out.push(rel + name);
            }
        }
    },

    // Shell → outside, then editors → shell
    async step(root) {
        const files = [];
        await this.walk(root, PROJECT, '', files);
        const ws = this.workspace();
        const byRel = new Map();
        for (const f of Object.values(ctx.projectFiles)) {
            if (!f.lazy && typeof f.content === 'string') byRel.set(ctx.getRelativePath(f.id) || f.name, f);
        }
        for (const rel of files) {
            const st = await root.stat(`${PROJECT}/${rel}`);
            const sig = `${st.Size}:${st.ModTime}`;
            const had = this.known.get(rel);
            if (had && had.sig === sig) continue;
            const data = await root.readFile(`${PROJECT}/${rel}`);
            const text = asText(data);
            if (had && text !== null && text === had.text) { had.sig = sig; continue; }
            try {
                if (ws) {
                    const res = await fetch('/upload-file?overwrite=1&path=' + encodeURIComponent(ws + '/' + rel),
                        { method: 'PUT', body: new Blob([data]) });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                } else if (text !== null) {
                    const f = byRel.get(rel);
                    if (f) ctx.setFileContent(f.id, text);
                    else if (ctx.createFile) ctx.createFile(rel, text);
                }
                this.known.set(rel, { sig, text });
                log.log('Synced out', rel);
            } catch (err) {
                log.warn('Could not sync out', rel, err);
            }
        }
        for (const [rel, f] of byRel) {
            const had = this.known.get(rel);
            if (had && had.text === f.content) continue;
            const sig = await this.put(root, rel, encoder.encode(f.content));
            this.known.set(rel, { sig, text: f.content });
        }
    },

    start(root) {
        this.shells++;
        if (this.timer) return;
        this.timer = setInterval(async () => {
            if (this.busy) return;
            this.busy = true;
            try { await this.step(root); } catch (err) { log.warn('Sync failed:', err); }
            this.busy = false;
        }, SYNC_INTERVAL);
    },

    stop() {
        if (--this.shells > 0 || !this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    },
};

// A file written outside the shell (JupyterLite's saves, say): into project/
// at once, rather than the shell keeping its older copy
async function noteWrite(abs, content) {
    const ws = sync.workspace();
    if (!booting || !ws || !abs.startsWith(ws + '/')) return;
    try {
        const { root } = await booting;
        const rel = abs.slice(ws.length + 1);
        const data = typeof content === 'string' ? encoder.encode(content) : content;
        const sig = await sync.put(root, rel, data);
        sync.known.set(rel, { sig, text: typeof content === 'string' ? content : asText(content) });
    } catch (err) {
        log.warn('Could not bring in', abs, err);
    }
}

function asText(bytes) {
    try { return decoder.decode(bytes); } catch (e) { return null; }
}

// ---- commands the page runs ----
// rc in Wanix starts Go programs only, so the tools that run in the page are
// /bin/<name> links to one Go program (scripts/wanix-command), which asks the
// page to run <name> through gleTools below (#js/gleTools in the shell) and
// passes its output and exit code on. Which names there are, and what each runs
// as, is the table /etc/tools: the shell's own file, listed, read and changed
// there like any other. The runners it names:
//   llvm <tool>   an LLVM tool from YoWASP (clang for C, C++ and LLVM IR to
//                 wasm32-wasip1), in public/wasi-tools-worker.js
//   rust <cmd>    cargo or rustc, in Rubrc (src/rubrc-plugin.js)
//   wasi          a WASI program: wasi prog.wasm [args]
//   git           isomorphic-git, on the shell's files (src/wanix-git.js)
// All but git run on a copy of the command's folder; the files it makes or changes are
// written back, and from there reach the project like any made in the shell.
// Paths must stay inside that folder.
const COMMAND_URL = 'wanix-command.wasm';
const COMMAND_PATH = 'lib/wanix-command.wasm';
const TOOLS_TABLE = 'etc/tools';
const DEFAULT_TOOLS = `# The shell's commands that run in the page: /bin/<name> for each line here,
# made when a shell starts or one of them runs (so a line added here is a
# command from then on). A line: <name> <runner> [what the runner runs]
#   llvm <tool>   an LLVM tool from YoWASP (C, C++, LLVM IR to wasm32-wasip1)
#   rust <cmd>    cargo or rustc, in Rubrc
#   wasi          a WASI program (preview 1): wasi prog.wasm [args]
#   git           isomorphic-git (git help); its settings: /etc/git/config
# All but git work on a copy of the current folder: paths must stay inside it.
clang      llvm clang
clang++    llvm clang++
wasm-ld    llvm wasm-ld
ar         llvm ar
ranlib     llvm ranlib
objdump    llvm objdump
objcopy    llvm objcopy
strip      llvm strip
size       llvm size
addr2line  llvm addr2line
c++filt    llvm c++filt
cargo      rust cargo
rustc      rust rustc
wasi       wasi
git        git
`;
const TOOLS_WORKER_URL = 'wasi-tools-worker.js';
let toolsWorker = null;
let toolsQueue = Promise.resolve(); // one command at a time in the worker

// /etc/tools as { name: [runner, ...what it runs] }
async function readTools(root) {
    let text;
    try { text = decoder.decode(await root.readFile(TOOLS_TABLE)); } catch (_) { return {}; }
    const tools = {};
    for (const line of text.split('\n')) {
        const words = line.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2 && !words[0].includes('/')) tools[words[0]] = words.slice(1);
    }
    return tools;
}

// /etc/tools (unless there), the program, and /bin/<name> for each line
async function installTools(root) {
    await makeDirs(root, 'etc');
    await makeDirs(root, 'lib');
    await makeDirs(root, 'bin');
    try { await root.stat(TOOLS_TABLE); } catch (_) { await root.writeFile(TOOLS_TABLE, encoder.encode(DEFAULT_TOOLS)); }
    try { await root.stat(COMMAND_PATH); } catch (_) {
        const resp = await fetch(COMMAND_URL);
        if (!resp.ok) throw new Error(`${COMMAND_URL}: HTTP ${resp.status}`);
        await root.writeFile(COMMAND_PATH, new Uint8Array(await resp.arrayBuffer()));
        await root.chmod(COMMAND_PATH, 0o755);
    }
    await linkTools(root);
}

async function linkTools(root) {
    const have = new Set(((await root.readDir('bin').catch(() => [])) || []).map(n => n.replace(/\/$/, '')));
    for (const name of Object.keys(await readTools(root))) {
        if (!have.has(name)) await root.symlink('/' + COMMAND_PATH, `bin/${name}`).catch(err => log.warn('bin/' + name, err));
    }
}

// The runners: (root, dir, words, io, done(code)) → { input(text), stop() }.
// io: { out(text), err(text) }
const runners = {
    llvm: (root, dir, [tool, ...args], io, done) => runInWorker(root, dir, tool, args, io, done),
    wasi: (root, dir, args, io, done) => {
        if (args.length) return runInWorker(root, dir, 'wasi', args, io, done);
        io.err('usage: wasi prog.wasm [args]\n');
        done(2);
        return { input: null, stop() {} };
    },
    rust: (root, dir, words, io, done) => runRust(root, dir, words, io, done),
    git: (root, dir, args, io, done) => require('./wanix-git').gitRunner(root, dir, args, io, done, {
        // This site's server, when it is one, passes git's requests on (server.js)
        serverProxy: () => (ctx && ctx.wsClient && ctx.wsClient.isConnected() && !ctx.wsClient.isLocal() ? new URL('cors-proxy', document.baseURI).href : null),
    }),
};

// A tool of public/wasi-tools-worker.js: an LLVM tool, or 'wasi' (args[0] the program)
function runInWorker(root, dir, tool, args, io, done) {
    let stopped = false;
    const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
    let progress = false;
    const finish = code => {
        if (stopped) return;
        stopped = true;
        if (progress) io.err('\r\x1b[K');
        done(code);
    };
    const run = async () => {
        const files = await readFolder(root, dir);
        if (stopped) return;
        if (!toolsWorker) toolsWorker = new Worker(TOOLS_WORKER_URL, { type: 'module' });
        const worker = toolsWorker;
        await new Promise(resolve => {
            const end = code => { finish(code); resolve(); };
            worker.onmessage = async ({ data }) => {
                if (data.type === 'out') {
                    const text = decoders[data.fd].decode(data.data, { stream: true });
                    if (data.fd === 2) io.err(text); else io.out(text);
                }
                else if (data.type === 'progress') { progress = true; io.err(`\r\x1b[90m${data.text}\x1b[0m\x1b[K`); }
                else if (data.type === 'error') { io.err(`\r\x1b[31m${tool === 'wasi' ? args[0] : tool}: ${data.message}\x1b[0m\n`); end(1); }
                else if (data.type === 'done') {
                    for (const [rel, bytes] of Object.entries(data.files)) {
                        try {
                            if (rel.includes('/')) await makeDirs(root, inDir(dir, rel.replace(/\/[^/]*$/, '')));
                            await root.writeFile(inDir(dir, rel), bytes);
                        } catch (err) {
                            io.err(`Could not write ${rel}: ${err.message || err}\n`);
                        }
                    }
                    end(data.code);
                }
            };
            worker.onerror = () => end(1);
            worker.postMessage({ type: 'run', tool, args, files });
            stopWorker = () => { worker.terminate(); if (toolsWorker === worker) toolsWorker = null; end(130); };
        });
    };
    let stopWorker = null;
    toolsQueue = toolsQueue.then(run).catch(err => { io.err(`${tool}: ${err.message || err}\n`); finish(1); });
    return {
        input: null, // no stdin
        stop() { if (stopWorker) stopWorker(); else finish(130); },
    };
}

// cargo and rustc run in Rubrc, whose / is made to hold the folder; the builds
// come back into it (target/…/*.wasm, which `wasi target/wasm32-wasip1/debug/app.wasm` runs)
function runRust(root, dir, words, io, done) {
    const { runRust: run } = require('./rubrc-plugin');
    let handle = null, finished = false;
    const finish = code => { if (!finished) { finished = true; done(code); } };
    const line = words.map(w => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
    (async () => {
        const files = await readFolder(root, dir);
        // The folder as a key for Rubrc's mirror: from the top of the project ('')
        const key = dir === PROJECT ? '' : dir.startsWith(PROJECT + '/') ? dir.slice(PROJECT.length + 1) : '/' + dir;
        handle = run(key, files, line, text => io.out(text), text => io.err(`\x1b[90m${text}\x1b[0m\n`));
        const out = await handle.done;
        for (const [rel, bytes] of Object.entries(out)) {
            const path = inDir(dir, rel);
            try {
                const old = files[rel];
                if (old && old.length === bytes.length && old.every((b, i) => b === bytes[i])) continue;
                if (rel.includes('/')) await makeDirs(root, path.replace(/\/[^/]*$/, ''));
                await root.writeFile(path, bytes);
            } catch (err) {
                io.err(`Could not write ${rel}: ${err.message || err}\n`);
            }
        }
        finish(0);
    })().catch(err => { io.err(`${words[0]}: ${err.message || err}\n`); finish(1); });
    return {
        input: data => { if (handle) handle.input(data); },
        stop: () => { if (handle) handle.interrupt(); else finish(130); },
    };
}

// What /bin/<name> calls (#js/gleTools/<function> in the shell; see
// scripts/wanix-command/main.go for the encoding). Running commands are jobs.
const jobs = new Map();
let lastJob = 0;
const b64 = {
    encode: text => { const bytes = encoder.encode(text); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); },
    decode: data => new TextDecoder().decode(Uint8Array.from(atob(String(data)), c => c.charCodeAt(0))),
};

const gleTools = {
    runners,
    // name NUL folder NUL args… → the job's number, or a message (base64)
    start(request) {
        const [name, folder, ...args] = b64.decode(request).split('\0');
        const id = ++lastJob;
        const job = { name, out: '', err: '', code: null, input: null, stop: null, at: Date.now() };
        jobs.set(id, job);
        (async () => {
            const { root } = await bootWanix(() => {});
            await linkTools(root);
            const entry = (await readTools(root))[name];
            const runner = entry && runners[entry[0]];
            if (!runner) throw new Error(entry ? `no runner ${entry[0]} (see /etc/tools)` : 'not in /etc/tools');
            const dir = folder.split('/').filter(Boolean).join('/') || '.';
            const io = { out: t => { job.out += t; }, err: t => { job.err += t; } };
            const handle = runner(root, dir, [...entry.slice(1), ...args], io, code => { job.code = code || 0; });
            job.input = handle.input || null;
            job.stop = handle.stop;
        })().catch(err => { job.err += `${name}: ${err.message || err}\n`; job.code = 127; });
        return id;
    },
    // job → "running|out|err" or "code|out|err", the output since the last poll
    poll(id) {
        const job = jobs.get(Number(id));
        if (!job) return `1||${b64.encode('no such job\n')}`;
        const answer = `${job.code === null ? 'running' : job.code}|${b64.encode(job.out)}|${b64.encode(job.err)}`;
        job.out = job.err = '';
        if (job.code !== null) jobs.delete(Number(id));
        return answer;
    },
    input(id, data) {
        const job = jobs.get(Number(id));
        if (job && job.input) job.input(b64.decode(data));
    },
    stop(id) {
        const job = jobs.get(Number(id));
        if (job && job.stop) job.stop();
    },
};
globalThis.gleTools = gleTools;

// The newest command still running, for the terminal (Ctrl+C, what is typed)
function runningJob() {
    let newest = null;
    for (const job of jobs.values()) if (job.code === null && (!newest || job.at > newest.at)) newest = job;
    return newest;
}

// A folder of the namespace, from where rc is: 'project', 'project/src', …
function resolveDir(cwd, arg) {
    const parts = arg.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
    for (const p of arg.split('/')) {
        if (!p || p === '.') continue;
        if (p === '..') parts.pop();
        else parts.push(p);
    }
    return parts.join('/');
}

async function readFolder(root, dir) {
    const rels = [];
    await sync.walk(root, dir, '', rels);
    const files = {};
    for (const rel of rels.slice(0, MAX_FILES)) {
        try {
            const st = await root.stat(inDir(dir, rel));
            if (st.Size > MAX_FILE_SIZE) continue;
            files[rel] = await root.readFile(inDir(dir, rel));
        } catch (err) { /* gone meanwhile */ }
    }
    return files;
}

// ---- a shell on an xterm ----
// rc reads whole lines, so the line is edited here, as Plan 9 does in its
// terminal rather than in the kernel: Backspace, Ctrl+U, Ctrl+C, and ↑/↓ for
// the lines entered before.
// opts: { dir: the folder of the project to start in, onExit() when the shell ends }
async function attachShell(term, onProgress, opts = {}) {
    if (!onProgress) onProgress = text => term.writeln(`\x1b[90m${text}\x1b[0m`);
    const { ns, root } = await bootWanix(onProgress);
    await copyProjectIn(root, onProgress);
    let start = PROJECT;
    if (opts.dir) {
        const wanted = resolveDir(PROJECT, opts.dir);
        if (wanted.startsWith(PROJECT + '/')) {
            try { await makeDirs(root, wanted); start = wanted; } catch { /* stay at the top */ }
        }
    }
    // A folder of the namespace itself (the file browser's), if it is one
    if (opts.wd) {
        const wanted = resolveDir('', opts.wd) || '.';
        try { if ((await root.stat(wanted)).IsDir) start = wanted; } catch { /* stay in the project */ }
    }
    await installTools(root);
    const task = document.createElement('wanix-task');
    task.setAttribute('cmd', 'rc.wasm');
    task.setAttribute('wd', start);
    task.setAttribute('env', 'PATH=/bin');
    task.setAttribute('term', '');
    task.setAttribute('start', '');
    ns.appendChild(task);
    await task._nsReady;
    if (!task.term) throw new Error('Wanix gave the shell no terminal');
    const dataPath = task.term + '/data';
    await root.waitFor(dataPath, 30000);

    const reader = (await root.openReadable(dataPath)).getReader();
    const writer = (await root.openWritable(dataPath)).getWriter();
    let closed = false;
    (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) term.write(value);
            }
        } catch (err) {
            if (!closed) log.warn('Shell read failed:', err);
        }
        if (!closed) {
            term.writeln('\r\n\x1b[33m[Shell exited]\x1b[0m');
            if (opts.onExit) opts.onExit();
        }
    })();

    const history = [];
    let line = '', back = 0;
    const setLine = s => { term.write('\b \b'.repeat([...line].length)); line = s; term.write(s); };
    const onData = data => {
        // While a command of /etc/tools runs: Ctrl+C stops it, and what is typed
        // goes to it if it reads it (Rust programs); otherwise to rc, for after
        const job = runningJob();
        if (job && data.includes('\x03')) {
            term.write('^C\r\n');
            line = '';
            if (job.stop) job.stop();
            return;
        }
        if (job && job.input) {
            job.input(data);
            return;
        }
        if (data === '\x1b[A' || data === '\x1b[B') {
            back = Math.max(0, Math.min(history.length, back + (data === '\x1b[A' ? 1 : -1)));
            setLine(back ? history[history.length - back] : '');
            return;
        }
        if (data.startsWith('\x1b')) return; // other keys: no cursor movement within the line
        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                term.write('\r\n');
                if (line.trim() && history[history.length - 1] !== line) history.push(line);
                writer.write(encoder.encode(line + '\n'));
                line = '';
                back = 0;
            } else if (ch === '\x7f' || ch === '\b') {
                if (line) { line = [...line].slice(0, -1).join(''); term.write('\b \b'); }
            } else if (ch === '\x15') {
                setLine('');
            } else if (ch === '\x03') {
                term.write('^C\r\n');
                line = '';
                writer.write(encoder.encode('\n'));
            } else if (ch >= ' ' || ch === '\t') {
                line += ch;
                term.write(ch);
            }
        }
    };
    const input = term.onData(onData);

    sync.start(root);
    return () => {
        closed = true;
        input.dispose();
        sync.stop();
        writer.write(encoder.encode('exit\n')).catch(() => {}).finally(() => {
            writer.close().catch(() => {});
            reader.cancel().catch(() => {});
            task.remove();
        });
    };
}

// ---- the panel ----
class WanixTerminalComponent {
    constructor(container, state) {
        this.dir = state && state.dir;
        this.rootElement = container.element;
        this.rootElement.style.cssText = 'background:#1e1e1e;padding:0;overflow:hidden;';
        this.detach = null;
        this.destroyed = false;
        container.on('destroy', () => {
            this.destroyed = true;
            if (this.detach) this.detach();
            if (this.terminal) this.terminal.dispose();
        });
        this._init(container);
    }

    async _init(container) {
        try {
            await ensureXtermLoaded();
        } catch (err) {
            this.rootElement.innerHTML = `<div style="padding:20px;color:#f88;">Failed to load xterm.js: ${err.message}</div>`;
            return;
        }
        if (this.destroyed) return;
        const { terminal, fit } = makeTerminal(this.rootElement, container);
        this.terminal = terminal;
        terminal.writeln(`Wanix rc shell, in the browser. The project is in ${this.dir ? '/project' : './ (project/)'}; help lists the commands.`);
        try {
            const detach = await attachShell(terminal, undefined, { wd: this.dir });
            if (this.destroyed) detach();
            else this.detach = detach;
            fit();
        } catch (err) {
            log.warn('Wanix failed:', err);
            terminal.writeln(`\x1b[31mWanix did not start: ${err.message || err}\x1b[0m`);
        }
    }
}

registerPlugin({
    id: 'wanix',
    name: 'Wanix',
    components: {
        wanixTerminal: WanixTerminalComponent,
    },
    toolbarButtons: [
        { label: 'rc', title: 'Open in-browser shell', menuLabel: 'Terminal — in-browser shell (Wanix)' },
    ],
    init(c) {
        ctx = c;
    },
});

// The namespace's root (booting Wanix if needed), for the editor's tree (src/vfs.js)
async function wanixRoot(onProgress) {
    return (await bootWanix(onProgress || (() => {}))).root;
}

// Whether Wanix is up already (its tree can be read without starting it)
function wanixStarted() {
    return !!booting;
}

module.exports = { attachShell, noteWrite, wanixRoot, wanixStarted };
