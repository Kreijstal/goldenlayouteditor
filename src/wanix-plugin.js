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
const RC_URL = `https://cdn.jsdelivr.net/npm/wanix-extras@${WANIX_VERSION}/dist/rc.wasm`;
const NS_ID = 'gle-wanix';
const PROJECT = 'project';
const MAX_FILES = 1000, MAX_DIRS = 200, MAX_FILE_SIZE = 4 * 1024 * 1024;
const SKIP_DIR_RE = /^(node_modules|\.git|__pycache__|\.cache)$/;
const SYNC_INTERVAL = 1500;

let ctx = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

// ---- the namespace ----
let booting = null;

function bootWanix(onProgress) {
    if (booting) return booting;
    booting = (async () => {
        onProgress('Loading Wanix…');
        await import(WANIX_URL);
        const ns = document.createElement('wanix-namespace');
        ns.id = NS_ID;
        ns.setAttribute('wasm', KERNEL_URL);
        ns.innerHTML = '<wanix-bind dst="." src="#ramfs/new"></wanix-bind>'
            + `<wanix-bind type="file" dst="rc.wasm" perm="0755" src="${RC_URL}"></wanix-bind>`;
        onProgress('Starting Wanix (6 MB the first time)…');
        await new Promise((resolve, reject) => {
            ns.addEventListener('ready', resolve, { once: true });
            ns.addEventListener('error', e => reject((e.detail && e.detail.error) || new Error('Wanix did not start')), { once: true });
            document.body.appendChild(ns);
        });
        const root = ns.root;
        await makeDirs(root, PROJECT);
        onProgress('Copying the project in…');
        await sync.copyIn(root);
        return { ns, root };
    })();
    booting.catch(() => { booting = null; });
    return booting;
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
                if (!SKIP_DIR_RE.test(name.slice(0, -1))) await this.walk(root, `${dir}/${name.slice(0, -1)}`, rel + name, out);
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

// ---- commands run here rather than by rc ----
// rc can only start Go programs, so a line naming an LLVM tool (from YoWASP:
// clang for C, C++ and LLVM IR to wasm32-wasip1) or a .wasm file (a WASI
// program) is run by public/wasi-tools-worker.js instead, on a copy of the
// shell's current folder; the files it makes or changes are written back, and
// from there reach the project like any made in the shell. No stdin, and
// paths must stay inside the current folder.
const LLVM_TOOLS = new Set(['clang', 'clang++', 'wasm-ld', 'ar', 'ranlib', 'objdump', 'objcopy', 'strip', 'size', 'addr2line', 'c++filt']);
const TOOLS_WORKER_URL = '/wasi-tools-worker.js';
let toolsWorker = null;

// Words of a command line: blanks split, '…' quotes (rc's quoting)
function splitWords(line) {
    const words = [];
    let word = null, quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === "'" && line[i + 1] === "'") { word += "'"; i++; }
            else if (ch === "'") quoted = false;
            else word += ch;
        } else if (ch === "'") { quoted = true; word = word || ''; }
        else if (/\s/.test(ch)) { if (word !== null) words.push(word); word = null; }
        else word = (word || '') + ch;
    }
    if (word !== null) words.push(word);
    return words;
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
            const st = await root.stat(`${dir}/${rel}`);
            if (st.Size > MAX_FILE_SIZE) continue;
            files[rel] = await root.readFile(`${dir}/${rel}`);
        } catch (err) { /* gone meanwhile */ }
    }
    return files;
}

// Runs words[0] (an LLVM tool or a .wasm) in dir; resolves when it is done.
// Returns a function that stops it.
function runHere(root, dir, words, term, done) {
    const tool = LLVM_TOOLS.has(words[0]) ? words[0] : 'wasi';
    const args = tool === 'wasi' ? words : words.slice(1);
    let stopped = false;
    const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
    let progress = false;
    const finish = code => {
        if (stopped) return;
        stopped = true;
        if (progress) term.write('\r\x1b[K');
        done(code);
    };
    (async () => {
        const files = await readFolder(root, dir);
        if (!toolsWorker) toolsWorker = new Worker(TOOLS_WORKER_URL, { type: 'module' });
        const worker = toolsWorker;
        worker.onmessage = async ({ data }) => {
            if (data.type === 'out') {
                // Programs write bare \n; the terminal wants \r\n
                const text = decoders[data.fd].decode(data.data, { stream: true }).replace(/\r?\n/g, '\r\n');
                term.write(data.fd === 2 ? `\x1b[31m${text}\x1b[0m` : text);
            }
            else if (data.type === 'progress') { progress = true; term.write(`\r\x1b[90m${data.text}\x1b[0m\x1b[K`); }
            else if (data.type === 'error') { term.writeln(`\r\x1b[31m${words[0]}: ${data.message}\x1b[0m`); finish(1); }
            else if (data.type === 'done') {
                for (const [rel, bytes] of Object.entries(data.files)) {
                    try {
                        if (rel.includes('/')) await makeDirs(root, `${dir}/${rel.replace(/\/[^/]*$/, '')}`);
                        await root.writeFile(`${dir}/${rel}`, bytes);
                    } catch (err) {
                        term.writeln(`\x1b[31mCould not write ${rel}: ${err.message || err}\x1b[0m`);
                    }
                }
                finish(data.code);
            }
        };
        worker.postMessage({ type: 'run', tool, args, files });
    })().catch(err => { term.writeln(`\x1b[31m${words[0]}: ${err.message || err}\x1b[0m`); finish(1); });
    return () => {
        if (toolsWorker) { toolsWorker.terminate(); toolsWorker = null; }
        finish(130);
    };
}

// ---- Rust ----
// cargo and rustc run in Rubrc (src/rubrc-plugin.js), whose / is made to hold
// the current folder; the builds come back into it (target/…/*.wasm, which
// ./target/wasm32-wasip1/debug/app.wasm then runs here).
const RUST_TOOLS = new Set(['cargo', 'rustc']);

function runRustHere(root, dir, line, term, done) {
    const { runRust } = require('./rubrc-plugin');
    let handle = null, finished = false;
    const finish = code => { if (!finished) { finished = true; done(code); } };
    (async () => {
        const files = await readFolder(root, dir);
        // The folder as a key for Rubrc's mirror: from the top of the project ('')
        const key = dir === PROJECT ? '' : dir.startsWith(PROJECT + '/') ? dir.slice(PROJECT.length + 1) : '/' + dir;
        handle = runRust(key, files, line, text => term.write(text.replace(/\r?\n/g, '\r\n')),
            text => term.writeln(`\x1b[90m${text}\x1b[0m`));
        const out = await handle.done;
        for (const [rel, bytes] of Object.entries(out)) {
            const path = `${dir}/${rel}`;
            try {
                const old = files[rel];
                if (old && old.length === bytes.length && old.every((b, i) => b === bytes[i])) continue;
                if (rel.includes('/')) await makeDirs(root, path.replace(/\/[^/]*$/, ''));
                await root.writeFile(path, bytes);
            } catch (err) {
                term.writeln(`\x1b[31mCould not write ${rel}: ${err.message || err}\x1b[0m`);
            }
        }
        finish(0);
    })().catch(err => { term.writeln(`\r\x1b[31m${line.split(/\s/)[0]}: ${err.message || err}\x1b[0m`); finish(1); });
    return {
        input: data => { if (handle) handle.input(data); },
        stop: () => { if (handle) handle.interrupt(); else finish(130); },
    };
}

// ---- a shell on an xterm ----
// rc reads whole lines, so the line is edited here, as Plan 9 does in its
// terminal rather than in the kernel: Backspace, Ctrl+U, Ctrl+C, and ↑/↓ for
// the lines entered before.
// opts: { dir: the folder of the project to start in, onExit() when the shell ends }
async function attachShell(term, onProgress, opts = {}) {
    if (!onProgress) onProgress = text => term.writeln(`\x1b[90m${text}\x1b[0m`);
    const { ns, root } = await bootWanix(onProgress);
    let start = PROJECT;
    if (opts.dir) {
        const wanted = resolveDir(PROJECT, opts.dir);
        if (wanted.startsWith(PROJECT + '/')) {
            try { await makeDirs(root, wanted); start = wanted; } catch { /* stay at the top */ }
        }
    }
    const task = document.createElement('wanix-task');
    task.setAttribute('cmd', 'rc.wasm');
    task.setAttribute('wd', start);
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
    let cwd = start; // rc's, followed through the cd lines typed
    let stopHere = null; // while a command runs here
    let takesInput = null; // and when what it runs reads what is typed (Rust programs)
    const setLine = s => { term.write('\b \b'.repeat([...line].length)); line = s; term.write(s); };
    const enter = text => {
        const words = splitWords(text);
        if (words[0] === 'cd' && words[1]) cwd = resolveDir(cwd, words[1]);
        if (words.length && RUST_TOOLS.has(words[0])) {
            const job = runRustHere(root, cwd, text, term, code => {
                stopHere = null;
                takesInput = null;
                if (code) term.writeln(`\x1b[90m[exit ${code}]\x1b[0m`);
                writer.write(encoder.encode('\n')); // for rc's prompt
            });
            stopHere = job.stop;
            takesInput = job.input;
            return;
        }
        if (words.length && (LLVM_TOOLS.has(words[0]) || /\.wasm$/.test(words[0]))) {
            stopHere = runHere(root, cwd, words, term, code => {
                stopHere = null;
                if (code) term.writeln(`\x1b[90m[exit ${code}]\x1b[0m`);
                writer.write(encoder.encode('\n')); // for rc's prompt
                const rest = typedAhead;
                typedAhead = '';
                if (rest) setTimeout(() => onData(rest), 100);
            });
            return;
        }
        writer.write(encoder.encode(text + '\n'));
    };
    let typedAhead = '';
    const onData = data => {
        if (stopHere) {
            if (data.includes('\x03')) { typedAhead = ''; term.write('^C\r\n'); stopHere(); }
            else if (takesInput) takesInput(data);
            else typedAhead += data; // for when it is done, as a terminal would
            return;
        }
        if (data === '\x1b[A' || data === '\x1b[B') {
            back = Math.max(0, Math.min(history.length, back + (data === '\x1b[A' ? 1 : -1)));
            setLine(back ? history[history.length - back] : '');
            return;
        }
        if (data.startsWith('\x1b')) return; // other keys: no cursor movement within the line
        const chars = [...data];
        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            if (ch === '\r' || ch === '\n') {
                term.write('\r\n');
                if (line.trim() && history[history.length - 1] !== line) history.push(line);
                enter(line);
                line = '';
                back = 0;
                if (stopHere) { typedAhead += chars.slice(i + 1).join(''); return; }
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
    constructor(container) {
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
        terminal.writeln('Wanix rc shell, in the browser. The project is in ./ (project/); type help.');
        terminal.writeln('\x1b[90mAlso cargo/rustc (Rust, to wasm32-wasip1), clang/clang++ (C, C++) and ./prog.wasm to run what they build.\x1b[0m');
        try {
            const detach = await attachShell(terminal);
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

module.exports = { attachShell, noteWrite };
