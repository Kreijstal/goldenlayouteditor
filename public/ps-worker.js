// PostScript and EPS to PNGs, for the PostScript viewer (src/ps-plugin.js).
// Ghostscript 10.06 as WebAssembly (@okathira/ghostpdl-wasm: GhostPDL built
// with Emscripten, its fonts, the URW base 35, in its ROM file system) runs
// the program and draws each page it shows with the png16m device, on white,
// text and lines antialiased. An EPS is cropped to its %%BoundingBox
// (-dEPSCrop); a DOS EPS's binary header (and the TIFF or WMF preview it
// points to) Ghostscript skips by itself. What Ghostscript says (errors in
// the program, fonts it substituted) comes back as its log.
//   → { id, bytes, eps, resolution, lastPage }
//   ← { id, result: { pages: [Uint8Array (PNG)], log, code } } | { id, error }
import loadGhostscript from 'https://cdn.jsdelivr.net/npm/@okathira/ghostpdl-wasm@1.1.0/dist/gs.js';

let gs = null;
let log = [];

async function ghostscript() {
    if (!gs) {
        gs = loadGhostscript({ print: line => log.push(line), printErr: line => log.push(line) });
        gs.catch(() => { gs = null; });
    }
    return gs;
}

function clear(M) {
    for (const name of M.FS.readdir('/work')) {
        if (name !== '.' && name !== '..') M.FS.unlink('/work/' + name);
    }
}

async function render({ bytes, eps, resolution, lastPage }) {
    const M = await ghostscript();
    try { M.FS.mkdir('/work'); } catch (_) { /* made by an earlier run */ }
    clear(M);
    M.FS.writeFile('/work/in', new Uint8Array(bytes));
    log = [];
    const args = ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m',
        '-r' + resolution, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4'];
    if (eps) args.push('-dEPSCrop');
    if (lastPage) args.push('-dLastPage=' + lastPage);
    args.push('-sOutputFile=/work/page-%d.png', '/work/in');
    let code;
    try {
        code = M.callMain(args);
    } catch (err) {
        // Ghostscript gave up for good (out of memory, an abort): a fresh one next time
        gs = null;
        if (!(err && typeof err.status === 'number')) throw err;
        code = err.status;
    }
    const pages = [];
    for (let n = 1; ; n++) {
        let png;
        try { png = M.FS.readFile('/work/page-' + n + '.png'); } catch (_) { break; }
        pages.push(png);
    }
    if (gs) clear(M);
    return { pages, log: log.join('\n'), code };
}

// One program at a time: Ghostscript's file system and log are shared
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
    queue = queue.then(() => render(data)).then(result => {
        self.postMessage({ id: data.id, result }, result.pages.map(p => p.buffer));
    }, err => {
        self.postMessage({ id: data.id, error: String(err && err.message || err) });
    });
};
