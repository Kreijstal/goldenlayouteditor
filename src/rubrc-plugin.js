// --- Rust toolchain ---
// rustc and cargo as WebAssembly, in the browser: Rubrc
// (github.com/oligamiq/rubrc), whose shell runs in a worker. Served at /rubrc
// (cdn-apps.js): our host.js (scripts/build-rubrc.sh) and the rest from Rubrc's live
// site, rubrc.pages.dev (a 56 MB download the first time; the browser keeps it). Sysroots come from Rubrc's site when a target first needs one.
//
// cargo/rustc typed in the in-browser shell (src/wanix-plugin.js) run here,
// through runRust. Rubrc's / is made to mirror the shell's current folder for
// the line, and its builds (.wasm files, Cargo.lock) go back to that folder
// afterwards. Rubrc takes text files only. Its file system keeps no clock, so
// cargo cannot tell a changed file from times: the fingerprints of the folder's
// own packages are dropped instead, and they are rebuilt.
//
// Needs SharedArrayBuffer: the server sends the cross-origin isolation headers.
const { createLogger } = require('./debug');
const log = createLogger('Rubrc');

const BASE = '/rubrc/';

let rubrc = null;
// What Rubrc's / holds: the folder it mirrors (a key) and the text of each
// file as last written there
const mirror = { folder: null, pushed: new Map() };
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function startRubrc() {
    if (rubrc) return rubrc;
    rubrc = (async () => {
        if (!self.crossOriginIsolated) {
            throw new Error('this page is not cross-origin isolated, so there is no SharedArrayBuffer (the server sends COOP/COEP headers; Safari does not support COEP credentialless)');
        }
        const { createRubrc } = await import(/* webpackIgnore: true */ BASE + 'host.js');
        return createRubrc({ base: new URL(BASE, location.href), files: {}, onLog: t => log.log(t.trimEnd()) });
    })();
    rubrc.catch(() => { rubrc = null; });
    return rubrc;
}

// Output of a line run to its end, as text (for ls and the like)
async function capture(r, line) {
    let text = '';
    const dec = new TextDecoder();
    await r.exec(line, b => { text += dec.decode(b, { stream: true }); }).done;
    return text;
}

// The names in a folder of Rubrc's (none when it isn't there)
async function listDir(r, dir) {
    const text = await capture(r, `ls -a ${dir}`);
    if (/No such file|not a directory|^ls:/im.test(text)) return [];
    return text.split(/\s+/).filter(n => n && n !== '.' && n !== '..');
}

// Makes Rubrc's / hold files ({ rel: Uint8Array | string }) of the folder
// `folder` and no others: switching folders clears the last one's. Text files
// only; target/ is Rubrc's own.
async function mirrorFolder(r, folder, files) {
    if (mirror.folder !== folder) {
        if (mirror.folder !== null) {
            for (const top of new Set([...mirror.pushed.keys()].map(rel => rel.split('/')[0]).concat('target'))) {
                await r.exec(`rm -r ${top}`).done;
            }
        }
        mirror.folder = folder;
        mirror.pushed = new Map();
    }
    const changed = [];
    for (const [rel, data] of Object.entries(files)) {
        if (rel === 'target' || rel.startsWith('target/') || /\s/.test(rel)) continue;
        let text = data;
        if (typeof data !== 'string') {
            try { text = textDecoder.decode(data); } catch { continue; }
        }
        if (mirror.pushed.get(rel) === text) continue;
        await r.writeFile(rel, text);
        mirror.pushed.set(rel, text);
        changed.push(rel);
    }
    for (const rel of [...mirror.pushed.keys()]) {
        if (rel in files) continue;
        await r.exec(`rm ${rel}`).done;
        mirror.pushed.delete(rel);
        changed.push(rel);
    }
    if (changed.length) await dropOwnBuilds(r);
    return changed;
}

// Cargo would take its last build of the folder's packages as current (no file
// times to go by): remove their fingerprints, keeping what dependencies built
async function dropOwnBuilds(r) {
    const names = new Set();
    for (const [rel, text] of mirror.pushed) {
        if (!/(^|\/)Cargo\.toml$/.test(rel)) continue;
        const m = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(text);
        if (m) names.add(m[1]);
    }
    if (!names.size) names.add('main'); // Rubrc's own Cargo.toml when the folder has none
    for (const dir of await profileDirs(r)) {
        for (const entry of await listDir(r, `${dir}/.fingerprint`)) {
            const pkg = entry.replace(/-[0-9a-f]{16}$/, '');
            if (pkg !== entry && (names.has(pkg) || names.has(pkg.replace(/_/g, '-')))) await r.exec(`rm -r ${dir}/.fingerprint/${entry}`).done;
        }
    }
}

// Cargo's output folders: target/debug, target/<triple>/release, …
async function profileDirs(r) {
    const dirs = [];
    for (const top of await listDir(r, 'target')) {
        if (top === 'debug' || top === 'release') dirs.push(`target/${top}`);
        else if (!top.includes('.')) {
            for (const p of await listDir(r, `target/${top}`)) if (p === 'debug' || p === 'release') dirs.push(`target/${top}/${p}`);
        }
    }
    return dirs;
}

// Rubrc's chatter in a build's output
const NOISE_RE = /^(DEBUG: main started|DEBUG: logger setup done|Linking using LC_ALL=.*)\n/gm;

// Runs a cargo or rustc line in `files`' folder (key: folder), writing its
// output with write(text). Returns { done: Promise<{ rel: Uint8Array }> of the
// builds to put back, input(data), interrupt() }.
function runRust(folder, files, line, write, onProgress) {
    let job = null, stopped = false;
    const pending = [];
    const handle = {
        input(data) { if (job) job.input(data); else pending.push(data); },
        interrupt() { stopped = true; if (job) job.interrupt(); },
    };
    handle.done = (async () => {
        if (!rubrc) onProgress('Loading the Rust toolchain (56 MB the first time)…');
        const r = await startRubrc();
        await mirrorFolder(r, folder, files);
        if (stopped) return {};
        let held = '';
        const dec = new TextDecoder();
        job = r.exec(line, bytes => {
            const text = held + dec.decode(bytes, { stream: true });
            const nl = text.lastIndexOf('\n');
            held = text.slice(nl + 1);
            const lines = text.slice(0, nl + 1).replace(NOISE_RE, '');
            if (lines) write(lines);
        });
        for (const d of pending.splice(0)) job.input(d);
        await job.done;
        if (held) write(held);
        const out = await builds(r, line);
        // Rubrc has these already: when they come back in, they are not changes
        if (mirror.folder === folder) {
            for (const [rel, data] of Object.entries(out)) {
                if (rel.startsWith('target/')) continue;
                try { mirror.pushed.set(rel, textDecoder.decode(data)); } catch { /* not text */ }
            }
        }
        return out;
    })();
    return handle;
}

// The files a cargo or rustc line made, to put back: .wasm files of target/,
// Cargo.lock, or rustc's output
async function builds(r, line) {
    const words = line.trim().split(/\s+/);
    const paths = new Set();
    if (words[0] === 'cargo') {
        paths.add('Cargo.lock');
        for (const dir of await profileDirs(r)) {
            for (const name of await listDir(r, dir)) if (/\.wasm$/.test(name)) paths.add(`${dir}/${name}`);
        }
    } else {
        const o = words.indexOf('-o');
        if (o > 0 && words[o + 1]) paths.add(words[o + 1].replace(/^\.?\//, ''));
        else {
            const src = words.slice(1).find(w => /\.rs$/.test(w));
            if (src) paths.add(src.replace(/^.*\//, '').replace(/\.rs$/, '.wasm'));
        }
    }
    const out = {};
    for (const p of paths) {
        const data = await r.readFile(p);
        if (data) out[p] = data;
    }
    return out;
}

module.exports = { runRust };
