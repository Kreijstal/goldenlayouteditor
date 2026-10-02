// The page side of Rubrc (github.com/oligamiq/rubrc): rustc, cargo and clang as
// WebAssembly, run by a shell inside a worker. This replaces Rubrc's own
// SolidJS/Monaco page, keeping what that page gives the worker: the WASI
// file system and host calls (sysroot download, crates.io proxy, running the
// programs cargo builds, file downloads) and the terminal plumbing, which goes
// through @oligami/shared-object ids. Bundled by scripts/build-rubrc.sh, next
// to the worker files copied from Rubrc's deployed site.
//
// Needs SharedArrayBuffer, so the page must be cross-origin isolated.
import { SharedObject, SharedObjectRef } from "@oligami/shared-object";
import { WASIFarm, wait_async_polyfill } from "@oligami/browser_wasi_shim-threads";
import { Directory, Fd, File, PreopenDirectory } from "@bjorn3/browser_wasi_shim";
import { createHttpBridge, isHttpBridgeMessage } from "../lib/src/http_bridge";
import { createChildProcessBridge, isChildProcessMessage } from "../lib/src/child_process_bridge";
import { createCratesProxyFetch } from "../lib/src/proxy";
import { fetch_compressed_stream } from "../lib/src/brotli_stream";
import { parseTar } from "../lib/src/parse_tar";

wait_async_polyfill();

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SYSROOT_URL = "https://oligamiq.github.io/rust_wasm/v0.2.0/";
const CRATES_PROXY = "https://proxy.rubrc.workers.dev";
const WRITE_FILE_SESSION = 0xeeeeeeee;

// Ids the worker and this page agree on (Rubrc's page/src/ctx.ts)
const CTX_KEYS = ["terminal_id", "waiter_id", "cmd_parser_id", "tree_id", "ls_id", "exec_file_id",
    "load_additional_sysroot_id", "input_char_id", "input_string_id", "interrupt_id", "resize_id",
    "get_terminal_size_id", "create_session_id", "vfs_ready_id", "close_session_id"];

// Keys the shell reads as one code (Rubrc's page/src/xterm.tsx)
const KEY_CODES = {
    "\x1b[A": 0x110001, "\x1bOA": 0x110001,
    "\x1b[B": 0x110002, "\x1bOB": 0x110002,
    "\x1b[C": 0x110003, "\x1bOC": 0x110003,
    "\x1b[D": 0x110004, "\x1bOD": 0x110004,
    "\x1b[H": 0x110005, "\x1bOH": 0x110005, "\x1b[1~": 0x110005,
    "\x1b[F": 0x110006, "\x1bOF": 0x110006, "\x1b[4~": 0x110006,
    "\x1b[3~": 0x110007,
};

const toBytes = data => {
    if (data instanceof Uint8Array) return data;
    if (data?.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
    if (Array.isArray(data)) return new Uint8Array(data);
    if (data && typeof data === "object") return new Uint8Array(Array.isArray(data.data) ? data.data : Object.values(data));
    return new Uint8Array();
};

// A tree of browser_wasi_shim inodes from { 'a/b.rs': string | Uint8Array }
function buildTree(files) {
    const root = new Map();
    for (const [path, data] of Object.entries(files)) {
        const parts = path.split("/").filter(Boolean);
        const name = parts.pop();
        let dir = root;
        for (const p of parts) {
            let next = dir.get(p);
            if (!(next instanceof Directory)) { next = new Directory(new Map()); dir.set(p, next); }
            dir = next.contents;
        }
        dir.set(name, new File(typeof data === "string" ? encoder.encode(data) : data));
    }
    return root;
}

// Starts Rubrc. base: URL of the directory holding the worker files.
// files: the project, placed at / (a Cargo project wants /Cargo.toml and
// /src/main.rs). onLog: messages from the toolchain host outside any terminal.
export function createRubrc({ base, files = {}, onLog = () => {}, debug = false }) {
    const ctx = Object.fromEntries(CTX_KEYS.map(k => [k, crypto.randomUUID()]));
    const sinks = new Map(); // session id → (bytes) => void
    // Session 0 runs a start-up script that ends by loading the wasm32-wasip1
    // sysroot; commands wait for that (cargo fails without it)
    let startup = "", resolveSettled;
    const settled = new Promise(r => { resolveSettled = r; });
    setTimeout(() => resolveSettled(), 120000);
    const write = (sessionId, data) => {
        const bytes = toBytes(data);
        if (debug) console.log(`[rubrc ${sessionId}]`, JSON.stringify(decoder.decode(bytes)));
        if (sessionId === 0 && startup !== null) {
            startup += decoder.decode(bytes);
            if (/load_sysroot[\s\S]*\n\/[^\n]* \$ $/.test(startup)) { startup = null; resolveSettled(); }
        }
        const sink = sinks.get(sessionId);
        if (sink) sink(bytes);
    };
    const keep = []; // SharedObjects stay registered while referenced

    // What the page's terminal gives the worker
    const terminal = args => write(args.sessionId, args.data);
    Object.assign(terminal, {
        reset_err_buff() {}, get_err_buff: () => "", reset_out_buff() {}, get_out_buff: () => "",
    });
    keep.push(new SharedObject(terminal, ctx.terminal_id));
    keep.push(new SharedObject({
        is_all_done: () => true, is_cmd_run_end: () => true, set_end_of_exec() {},
    }, ctx.waiter_id));
    let size = { cols: 80, rows: 24 };
    keep.push(new SharedObject(() => size, ctx.get_terminal_size_id));
    let resolveReady;
    const ready = new Promise(r => { resolveReady = r; });
    keep.push(new SharedObject(() => { started = true; resolveReady(); }, ctx.vfs_ready_id));

    const call = id => new SharedObjectRef(id).proxy();
    const inputChar = call(ctx.input_char_id);
    const inputString = call(ctx.input_string_id);
    const interrupt = call(ctx.interrupt_id);
    const resize = call(ctx.resize_id);
    const createSession = call(ctx.create_session_id);
    const closeSession = call(ctx.close_session_id);

    // The farm's stdio: the VFS logs there while starting, and the programs
    // `cargo run` starts print there, so after start it goes to the session
    // that was last typed in
    let active = 0;
    let started = false;
    class LogFd extends Fd {
        constructor(color) { super(); this.color = color; }
        fd_write(data) {
            if (started && sinks.has(active)) {
                write(active, this.color ? encoder.encode(`\x1b[${this.color}m${decoder.decode(data)}\x1b[0m`) : data);
            } else {
                onLog(decoder.decode(data));
            }
            return { ret: 0, nwritten: data.byteLength };
        }
        fd_seek() { return { ret: 8, offset: 0n }; }
        fd_filestat_get() { return { ret: 8, filestat: null }; }
    }
    const tree = buildTree({
        "Cargo.toml": '[package]\nname = "main"\nversion = "0.1.0"\nedition = "2021"\n',
        ".cargo/config.toml": "",
        ...files,
    });
    tree.set("sysroot", new Directory(new Map()));
    const root = new PreopenDirectory("/", tree);

    let farm;
    const httpBridge = createHttpBridge(createCratesProxyFetch({ proxyBaseUrl: CRATES_PROXY }));
    const childBridge = createChildProcessBridge({
        getWasiRef: () => farm.get_ref(),
        workerUrl: new URL("child_process_worker.js", base).href,
        filesystemRoot: root.dir,
        uploadTimeoutMs: 30000,
        executionTimeoutMs: 120000,
    });
    let download = null;
    let catchDownload = null; // while readFile runs: takes the bytes instead of saving them
    let sysroot = [];
    let current = null;
    farm = new WASIFarm(new LogFd(), new LogFd(), new LogFd(31), [root], {
        allocator_size: 100 * 1024 * 1024,
        base_call_allocator_size: 64 * 1024 * 1024,
        unknown_fn: async msg => {
            if (isHttpBridgeMessage(msg)) return await httpBridge(msg);
            if (isChildProcessMessage(msg)) return await childBridge(msg);
            switch (msg.name) {
                case "downloadFileStart":
                    download = { name: msg.args.name, chunks: [] };
                    return;
                case "downloadFileChunk":
                    download?.chunks.push(toBytes(msg.args.data));
                    return;
                case "downloadFileEnd": {
                    if (!download) return;
                    if (catchDownload) {
                        const parts = download.chunks;
                        const data = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
                        let at = 0;
                        for (const c of parts) { data.set(c, at); at += c.length; }
                        catchDownload(data);
                        download = null;
                        return;
                    }
                    const url = URL.createObjectURL(new Blob(download.chunks));
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = download.name.replaceAll("\\", "/").replace(/^.*\//, "") || "download";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                    download = null;
                    return;
                }
                case "sysrootStartFetch": {
                    const { triple } = msg.args;
                    sysroot = [];
                    onLog(`Downloading the ${triple} sysroot…\n`);
                    try {
                        const stream = await fetch_compressed_stream(`${SYSROOT_URL}${triple}.tar.br`);
                        await parseTar(stream, f => sysroot.push({
                            name: encoder.encode(f.name),
                            data: f.data || new Uint8Array(),
                            isDir: f.type === "directory",
                        }));
                    } catch (err) {
                        onLog(`Could not fetch the ${triple} sysroot: ${err}\n`);
                    }
                    return {};
                }
                case "sysrootGetNextFileMeta":
                    current = sysroot.shift() || null;
                    return current
                        ? { has_file: true, name_len: current.name.length, data_len: current.isDir ? -1 : current.data.length }
                        : { has_file: false, name_len: 0, data_len: 0 };
                case "sysrootReadFileName":
                    if (!current) throw new Error("No sysroot file");
                    return { name: Array.from(current.name) };
                case "sysrootReadFileChunk": {
                    if (!current) return { chunk: [] };
                    const n = msg.args.chunk_len;
                    const chunk = current.data.subarray(0, n);
                    current.data = current.data.subarray(n);
                    return { chunk: Array.from(chunk) };
                }
                case "terminalWrite":
                    write(msg.args.session_id, msg.args.data);
                    return;
                default:
                    console.warn("[rubrc] unknown host call", msg);
            }
        },
    });

    const worker = new Worker(new URL("worker.js", base), { type: "module" });
    worker.postMessage({ ctx });
    worker.postMessage({ wasi_ref: farm.get_ref() });

    // Session 0 exists from the start; others are made on demand
    let nextSession = 1;
    let execSession = null, execQueue = Promise.resolve();
    const sendKeys = (id, data) => {
        if (KEY_CODES[data]) return inputChar({ sessionId: id, c: KEY_CODES[data] });
        if (data.length > 1) return inputString({ sessionId: id, data });
        const c = data.codePointAt(0);
        if (c === 3) return interrupt({ sessionId: id });
        if (c !== undefined) return inputChar({ sessionId: id, c });
    };
    const free = [0];
    let hidden = null;

    return {
        ready,
        // A shell session. onOutput(bytes); returns { input(str), resize(cols, rows), close() }
        async openSession(onOutput, cols = 80, rows = 24) {
            size = { cols, rows };
            await ready;
            const id = free.length ? free.shift() : nextSession++;
            sinks.set(id, onOutput);
            active = id;
            if (id !== 0) await createSession({ sessionId: id });
            await resize({ sessionId: id, cols, rows });
            return {
                id,
                input(data) {
                    active = id;
                    if (KEY_CODES[data]) return inputChar({ sessionId: id, c: KEY_CODES[data] });
                    if (data.length > 1) return inputString({ sessionId: id, data });
                    const c = data.codePointAt(0);
                    if (c === 3) return interrupt({ sessionId: id });
                    if (c !== undefined) return inputChar({ sessionId: id, c });
                },
                resize(c, r) {
                    size = { cols: c, rows: r };
                    return resize({ sessionId: id, cols: c, rows: r });
                },
                close() {
                    sinks.delete(id);
                    // Session 0 can't be closed; it's handed to the next terminal
                    if (id === 0) { free.unshift(0); return; }
                    return closeSession({ sessionId: id });
                },
            };
        },
        // Runs a command line in a session of its own whose output is dropped
        async run(line) {
            await ready;
            if (hidden === null) {
                hidden = nextSession++;
                await createSession({ sessionId: hidden });
            }
            return inputString({ sessionId: hidden, data: line + "\r" });
        },
        // Writes a text file into the shell's file system (path from /)
        async writeFile(path, content) {
            await ready;
            return inputString({ sessionId: WRITE_FILE_SESSION, data: JSON.stringify({ path: "/" + path.replace(/^\/+/, ""), content }) });
        },
        // Runs a command line to its end in a session of its own, at /. Its output
        // goes to onOutput (bytes; the line's echo and the next prompt left out).
        // Returns { done (a Promise), input(data) for what the program reads,
        // interrupt() }. Lines run one after another.
        exec(line, onOutput = () => {}) {
            let session = null;
            const typed = [];
            const job = {
                input(data) { if (session === null) typed.push(data); else sendKeys(session, data); },
                interrupt() { if (session !== null) interrupt({ sessionId: session }); },
            };
            job.done = execQueue = execQueue.catch(() => {}).then(async () => {
                await ready;
                await settled;
                if (execSession === null) {
                    execSession = nextSession++;
                    sinks.set(execSession, () => {});
                    await createSession({ sessionId: execSession });
                    await new Promise(r => setTimeout(r, 200)); // its first prompt
                }
                session = execSession;
                active = session; // what the programs it starts print comes here
                const dec = new TextDecoder();
                let echoed = false, held = "";
                await new Promise(resolve => {
                    sinks.set(session, bytes => {
                        let text = held + dec.decode(toBytes(bytes), { stream: true });
                        held = "";
                        if (!echoed) {
                            const i = text.indexOf("\n");
                            if (i < 0) { held = text; return; }
                            text = text.slice(i + 1);
                            echoed = true;
                        }
                        // The prompt, "<cwd> $ ", ends the command: keep back a last line
                        // that could be one until it is complete
                        const nl = text.lastIndexOf("\n");
                        const last = text.slice(nl + 1);
                        if (/^\/[^\n]* \$ $/.test(last)) {
                            if (nl >= 0) onOutput(encoder.encode(text.slice(0, nl + 1)));
                            sinks.set(session, () => {});
                            resolve();
                            return;
                        }
                        if (/^\/[^\n\r\x1b]*$/.test(last)) { held = last; text = text.slice(0, nl + 1); }
                        if (text) onOutput(encoder.encode(text));
                    });
                    inputString({ sessionId: session, data: line + "\r" });
                    for (const d of typed.splice(0)) sendKeys(session, d);
                });
            });
            return job;
        },
        // A file's bytes (through the shell's download command), or null
        async readFile(path) {
            let data = null, text = "";
            catchDownload = d => { data = d; };
            try {
                await this.exec(`download ${path}`, b => { text += decoder.decode(b); }).done;
            } finally {
                catchDownload = null;
            }
            return data;
        },
        terminate() {
            worker.terminate();
            keep.length = 0;
        },
    };
}
