// Asymptote programs to SVG (or, for 3D, to an interactive WebGL page), for the
// Asymptote viewer (src/asy-plugin.js). asymptote-web: Asymptote 3 built with
// Emscripten, its base modules (plain, graph, three...) in its file system,
// labels set without TeX (-tex none), EPS turned into SVG in JavaScript. What
// Asymptote says (errors with their line and column, warnings) comes back as
// its log. After a program Asymptote gives up on, the engine
// fails every later one, so the viewer starts a fresh worker then (`broken`).
//   → { id, source, name, webgl }
//   ← { id, result: { output, format, warnings, log } } | { id, error, log, broken }
const BASE = 'https://cdn.jsdelivr.net/npm/asymptote-web@0.3.3/dist/';

// Asymptote's messages: the engine binds the console's functions when it starts, so these
let log = [];
console.log = console.info = console.warn = console.error = (...args) => log.push(args.join(' '));

let engine = null;

async function asymptote() {
    if (!engine) {
        engine = import(BASE + 'asymptote-web.js').then(m => m.createAsymptote(m.getAssetUrls(BASE)));
        engine.catch(() => { engine = null; });
    }
    return engine;
}

async function render({ source, name, webgl }) {
    const asy = await asymptote();
    log = [];
    const r = await asy.render(source, {
        sourceFile: name,
        format: webgl ? 'webgl' : 'svg',
        // (3D in SVG: projected as vectors, there being no OpenGL to render it with)
        flags: webgl ? [] : ['-render=0'],
        // (the WebGL page carries its viewer, AsyGL, rather than fetching it)
        offline: true,
    });
    return { output: r.output, format: r.format, warnings: r.warnings, log: log.join('\n') };
}

// One program at a time: the engine's file system is shared
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
    queue = queue.then(() => render(data)).then(result => {
        self.postMessage({ id: data.id, result });
    }, err => {
        self.postMessage({ id: data.id, error: String(err && err.message || err), log: log.join('\n'), broken: !!(err && err.name === 'AsymptoteError') });
    });
};
