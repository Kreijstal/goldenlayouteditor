// --- OpenSCAD render worker ---
// Runs OpenSCAD off the main thread: the WebAssembly build made from source with the
// system emscripten by ~/git/openscad-wasm-build/build.sh, from @kreijstal/openscad-wasm on jsDelivr
// (openscad.js, emscripten's MODULARIZE + EXPORT_ES6 factory, openscad.wasm, and the
// Liberation Sans fonts in fonts/).
// Request:  { path, source, defines?, cache? } — absolute path of the .scad file, its
//           text, "name=value" overrides (OpenSCAD's -D), and [path, bytes|null]
//           pairs fetched by an earlier render (null: known to be missing)
// Response: { ok, kind: '3d'|'2d', off?, svg?, log, ms, cache } or { ok: false, error, log, cache }
// Files the model includes (include/use <...>, import("..."), surface("..."))
// are fetched from the server and placed in the in-memory filesystem at their
// real paths, so OpenSCAD resolves them the same way it does on the desktop.
// Paths built at run time (import(str(dir, name, ".stl"))) can't be read from the
// source; those are fetched when OpenSCAD reports them missing, then it runs again.

const OPENSCAD_URL = 'https://cdn.jsdelivr.net/npm/@kreijstal/openscad-wasm@2026.7.26-build.1/openscad.js';
// OpenSCAD's default font is Liberation Sans
const FONT_BASE = 'https://cdn.jsdelivr.net/npm/@kreijstal/openscad-wasm@2026.7.26-build.1/fonts/';
const FONTS = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf'];
const MAX_DEPENDENCIES = 2000;
const MAX_IMPORT_ROUNDS = 4;

let openscadModule = null;
let fontFiles = null;

function dirname(p) {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
}

function normalize(p) {
    const out = [];
    for (const part of p.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
    }
    return '/' + out.join('/');
}

function join(dir, rel) {
    return normalize(rel.startsWith('/') ? rel : dir + '/' + rel);
}

// Where OpenSCAD looks for include/use files besides the including file's folder
function libraryDirs(path) {
    const dirs = [];
    const home = path.match(/^\/home\/[^/]+|^\/root(?=\/)/);
    if (home) {
        dirs.push(home[0] + '/.local/share/OpenSCAD/libraries', home[0] + '/Documents/OpenSCAD/libraries');
    }
    dirs.push('/usr/share/openscad/libraries', '/usr/local/share/openscad/libraries');
    return dirs;
}

function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function references(text) {
    const code = stripComments(text);
    const refs = [];
    for (const m of code.matchAll(/\b(include|use)\s*<([^>\n]+)>/g)) refs.push({ kind: 'scad', name: m[2].trim() });
    for (const m of code.matchAll(/\b(import|surface)\s*\(\s*(?:file\s*=\s*)?"([^"\n]+)"/g)) refs.push({ kind: 'data', name: m[2] });
    return refs;
}

// Files fetched for this render, seeded from the caller's cache of earlier renders
let fileCache = new Map();
// Without a service worker the page reads files inside archives itself, so this
// worker asks it for every file: { read: path, rid } -> { type: 'read-result', rid, bytes }
let readViaPage = false;
const pageReads = new Map();
let nextRead = 0;

async function fetchFile(path) {
    if (fileCache.has(path)) return fileCache.get(path);
    let bytes = null;
    if (readViaPage) {
        bytes = await new Promise((resolve) => {
            const rid = ++nextRead;
            pageReads.set(rid, resolve);
            self.postMessage({ read: path, rid });
        });
        fileCache.set(path, bytes);
        return bytes;
    }
    try {
        const resp = await fetch('/workspace-file?path=' + encodeURIComponent(path));
        if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (_) { /* treated as missing */ }
    fileCache.set(path, bytes);
    return bytes;
}

// Breadth-first walk of everything the model pulls in; returns Map(path -> bytes)
async function collectDependencies(path, source) {
    const files = new Map();
    const tried = new Set([path]);
    let queue = [{ path, text: source }];
    const libs = libraryDirs(path);
    const decoder = new TextDecoder();
    while (queue.length && files.size < MAX_DEPENDENCIES) {
        const next = [];
        await Promise.all(queue.map(async ({ path: from, text }) => {
            for (const ref of references(text)) {
                const candidates = [join(dirname(from), ref.name)];
                if (ref.kind === 'scad' && !ref.name.startsWith('/')) for (const d of libs) candidates.push(join(d, ref.name));
                for (const candidate of candidates) {
                    if (files.has(candidate)) break;
                    if (tried.has(candidate)) continue;
                    tried.add(candidate);
                    const bytes = await fetchFile(candidate);
                    if (!bytes) continue;
                    files.set(candidate, bytes);
                    if (ref.kind === 'scad') next.push({ path: candidate, text: decoder.decode(bytes) });
                    break;
                }
            }
        }));
        queue = next;
    }
    return files;
}

async function loadFonts() {
    if (!fontFiles) {
        fontFiles = Promise.all(FONTS.map(async name => {
            const resp = await fetch(FONT_BASE + name);
            if (!resp.ok) throw new Error('font ' + name);
            return [name, new Uint8Array(await resp.arrayBuffer())];
        })).catch(() => { fontFiles = null; return []; });
    }
    return fontFiles;
}

function mkdirs(FS, dir) {
    let cur = '';
    for (const part of dir.split('/').filter(Boolean)) {
        cur += '/' + part;
        try { FS.mkdir(cur); } catch (_) { /* exists */ }
    }
}

// callMain can only run once per module instance, so each render gets a fresh one
async function runOpenSCAD(args, files, fonts) {
    if (!openscadModule) openscadModule = import(OPENSCAD_URL);
    const { default: OpenSCAD } = await openscadModule;
    const log = [];
    const instance = await OpenSCAD({
        noInitialRun: true,
        print: line => log.push(line),
        printErr: line => log.push(line),
        // Environment variables go in before the runtime starts: its C library takes
        // its copy of ENV the first time anything reads the environment
        preRun: [module => {
            module.ENV.FONTCONFIG_FILE = '/fonts/fonts.conf';
            // OPENSCADPATH names the library folders the desktop OpenSCAD searches
            // for include/use, so they resolve the same way here
            module.ENV.OPENSCADPATH = libraryDirs(args[0]).join(':');
        }],
    });
    const FS = instance.FS;
    mkdirs(FS, '/fonts');
    for (const [name, bytes] of fonts) FS.writeFile('/fonts/' + name, bytes);
    FS.writeFile('/fonts/fonts.conf', '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/fonts</dir></fontconfig>');
    // Every file goes in at its real path (library folders included, see OPENSCADPATH)
    for (const [p, bytes] of files) {
        mkdirs(FS, dirname(p));
        try { FS.writeFile(p, bytes); } catch (_) { /* e.g. a file where a folder should be */ }
    }
    mkdirs(FS, '/out');
    let code;
    try {
        code = instance.callMain(args.slice()); // callMain unshifts the program name into the array
    } catch (err) {
        code = typeof err === 'number' ? err : (err && err.status) ?? -1;
        if (typeof err === 'object' && err && err.message && !/exit/i.test(err.name || '')) log.push('ERROR: ' + err.message);
    }
    const output = args[args.indexOf('-o') + 1];
    let data = null;
    try { data = FS.readFile(output, { encoding: 'utf8' }); } catch (_) { /* no output */ }
    return { code, log, data };
}

// Run, and while OpenSCAD reports import files it couldn't open, fetch them and run again
async function runWithImports(id, args, files, fonts) {
    let result;
    for (let round = 0; ; round++) {
        result = await runOpenSCAD(args, files, fonts);
        if (round === MAX_IMPORT_ROUNDS) return result;
        const missing = new Set();
        for (const line of result.log) {
            const m = line.match(/Can't open import file '([^']+)'/);
            if (m) missing.add(normalize(m[1]));
        }
        const wanted = [...missing].filter(p => !files.has(p) && fileCache.get(p) !== null);
        if (!wanted.length) return result;
        self.postMessage({ id, progress: `Fetching ${wanted.length} imported file${wanted.length === 1 ? '' : 's'}...` });
        let added = 0;
        await Promise.all(wanted.map(async p => {
            const bytes = await fetchFile(p);
            if (bytes) { files.set(p, bytes); added++; }
        }));
        if (!added) return result;
        self.postMessage({ id, progress: `Rendering with OpenSCAD (${files.size} files)...` });
    }
}

// Drop OpenSCAD's startup noise and cache statistics
function cleanLog(log) {
    return log.filter(line => line.trim() && !/^(Could not initialize localization|Geometries in cache|Geometry cache size|CGAL Polyhedrons in cache|CGAL cache size|Fontconfig error: Cannot load default config)/.test(line.trim()));
}

self.onmessage = async (event) => {
    if (event.data.type === 'read-result') {
        const resolve = pageReads.get(event.data.rid);
        pageReads.delete(event.data.rid);
        if (resolve) resolve(event.data.bytes);
        return;
    }
    const { id, path, source, defines = [], cache = [] } = event.data;
    readViaPage = !!event.data.readViaPage;
    const started = performance.now();
    fileCache = new Map(cache);
    const cacheOut = () => [...fileCache];
    const defineArgs = defines.flatMap(d => ['-D', d]);
    try {
        self.postMessage({ id, progress: 'Fetching included files...' });
        const [deps, fonts] = await Promise.all([collectDependencies(path, source), loadFonts()]);
        // Files an earlier render fetched (imports with computed paths among them) go in
        // up front, so re-rendering with other parameters needs no extra round
        for (const [p, bytes] of fileCache) if (bytes && !deps.has(p)) deps.set(p, bytes);
        deps.set(path, new TextEncoder().encode(source));
        self.postMessage({ id, progress: `Rendering with OpenSCAD (${deps.size} file${deps.size === 1 ? '' : 's'})...` });
        let result = await runWithImports(id, [path, ...defineArgs, '--backend=manifold', '-o', '/out/model.off'], deps, fonts);
        let kind = '3d';
        const is2d = result.log.some(l => /top level object is a 2D object/i.test(l)) ||
            (!result.data && result.log.some(l => /not a 3D object/i.test(l)));
        if (is2d) {
            result = await runWithImports(id, [path, ...defineArgs, '--backend=manifold', '-o', '/out/model.svg'], deps, fonts);
            kind = '2d';
        }
        const log = cleanLog(result.log);
        const ms = Math.round(performance.now() - started);
        if (!result.data) {
            const empty = log.some(l => /top level object is empty/i.test(l));
            const firstError = log.find(l => /ERROR/.test(l));
            const error = empty ? 'The model is empty (nothing to render).' : firstError || 'OpenSCAD could not render this file.';
            self.postMessage({ id, ok: false, error, log, ms, cache: cacheOut() });
            return;
        }
        self.postMessage({ id, ok: true, kind, off: kind === '3d' ? result.data : null, svg: kind === '2d' ? result.data : null, log, ms, files: deps.size, cache: cacheOut() });
    } catch (err) {
        self.postMessage({ id, ok: false, error: err.message || String(err), log: [], cache: cacheOut() });
    }
};
