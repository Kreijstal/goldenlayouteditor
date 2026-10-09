// --- METAFONT and MetaPost, run in the browser ---
// MetaPost 2.11 (mplib, compiled to WebAssembly by mp-tikz-wasm) runs a
// MetaPost file as it is, and a METAFONT file through mfplain, MetaPost's
// emulation of plain METAFONT (as mf2pt1 does): each character comes out as a
// figure, drawn as MetaPost draws it, with its metrics, and the font's TFM
// (kerns, ligatures, parameters) as METAFONT would write it.

const MPOST = 'https://cdn.jsdelivr.net/npm/@kreijstal/mpost-wasm@0.3.1/dist/';
// what a run can need: MetaPost's macros, and Computer Modern (TFM and Type 1)
// with plain TeX and LaTeX for labels
const BUNDLES = ['core', 'cm-tfm', 'cm-type1', 'ps-fonts', 'tex-plain', 'latex-core'];

// The engine, in a worker of its own: the library's own worker would be
// cross-origin, so it runs in-process here, fetching its files as it needs them
const WORKER = `
let mp = null;
self.onmessage = async ({ data }) => {
    const { id, base, bundles, source, files, jobName } = data;
    try {
        if (!mp) {
            const { MetaPost } = await import(base + 'index.js');
            mp = await MetaPost.create({ worker: false, bundles, bundleBaseUrl: base + 'bundles/', logLevel: 'silent' });
        }
        // precision: false: the drawing exactly as MetaPost writes it, not rounded to 3 places
        const r = await mp.run(source, { format: ['svg'], files, jobName, svg: { precision: false } });
        const tfm = r.artifacts[jobName + '.tfm'] || null;
        self.postMessage({
            id, ok: true, status: r.status, log: r.log, diagnostics: r.diagnostics, tfm,
            figures: r.figures.map(f => ({ charcode: f.charcode, bbox: f.bbox, width: f.width, height: f.height, depth: f.depth, ic: f.italicCorrection, svg: f.svg })),
        });
    } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
    }
};`;

let worker = null, nextId = 1;
const pending = new Map();
function engine() {
    if (!worker) {
        worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })), { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.ok) p.resolve(data); else p.reject(new Error(data.error));
        };
        worker.onerror = (e) => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'MetaPost failed to start'));
            pending.clear();
            worker = null;
        };
    }
    return worker;
}

// One run at a time (the engine is single-threaded): each waits for the one before.
// The engine keeps the files of its runs (in its /work): a run on another
// directory's files starts a new one, so that it cannot `input` what was left
let queue = Promise.resolve(), lastDir = null;
function run(source, files, jobName, dir) {
    const job = queue.then(() => new Promise((resolve, reject) => {
        if (dir !== lastDir && worker) { worker.terminate(); worker = null; }
        lastDir = dir;
        const id = nextId++;
        pending.set(id, { resolve, reject });
        engine().postMessage({ id, base: MPOST, bundles: BUNDLES, source, files, jobName });
    }));
    queue = job.catch(() => {});
    return job;
}

// mfplain on top of plain.mp, which mplib always starts from: plain's units
// (in PostScript points) and label offsets are made unknown again, so that
// mfplain's own (in pixels) hold
const MF_PRELUDE = [
    'numeric mm,pt,dd,bp,cm,pc,cc,in;',
    'numeric labxf,labxf.lft,labxf.rt,labxf.bot,labxf.top,labyf,labyf.lft,labyf.rt,labyf.bot,labyf.top;',
    'input mfplain;',
    // once the font's mode_setup has set the magnification: how many units of
    // the drawing make a point; and the TFM written in the proof modes too
    'def mfview_setup_ = message "mfview-unit " & decimal(pt*bp_per_pixel); fontmaking:=1 enddef;',
    'extra_setup := "mfview_setup_";',
].join('\n');

/**
 * Runs a METAFONT (.mf) or MetaPost (.mp) file.
 * @param {string} name     the file's name, as `input` finds it among `files`
 * @param {Object<string, Uint8Array|string>} files  it and the files it reads
 * @param {object} o
 * @param {'localfont'|'proof'|'smoke'} [o.mode]  METAFONT's mode (proof: labelled points and boxes)
 * @param {string} [o.dir]  where the files are from
 * @returns {Promise<{status, log, diagnostics, figures, tfm}>}
 */
let runs = 0;
function runFile(name, files, { mode = 'localfont', dir = null } = {}) {
    const mf = /\.mf$/i.test(name);
    const base = name.replace(/\.(mf|mp)$/i, '');
    const source = mf
        ? `${MF_PRELUDE}\nmode:=${mode};\ninput ${base};\nend.\n`
        : `input ${base};\nend.\n`;
    // not the file's own name (`input cmr10` would then read the job itself), and
    // new each time: what a run gives back is only the files it made
    return run(source, files, `${mf ? 'mfjob' : 'mpjob'}${++runs}`, dir);
}

// --- TFM: the font metrics METAFONT (and MetaPost) write ---

const fix = (v, i) => v.getInt32(i) / 1048576;

/**
 * @returns {{designSize, checksum, codingScheme, family, params: number[], chars: Map<code, {width,height,depth,ic}>, ligKern: function}}
 */
function parseTfm(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const h = (i) => v.getUint16(i * 2);
    const [lf, lh, bc, ec, nw, nh, nd, ni, nl, nk, ne, np] = Array.from({ length: 12 }, (_, i) => h(i));
    if (lf * 4 > bytes.length || bc > ec + 1 || ec > 255) throw new Error('not a TFM file');
    const word = (i) => i * 4;
    const header = 6;
    const ci = header + lh, wd = ci + ec - bc + 1, ht = wd + nw, dp = ht + nh, it = dp + nd, lk = it + ni, kn = lk + nl, ex = kn + nk, pa = ex + ne;
    const bcpl = (at, max) => {
        const n = Math.min(bytes[word(at)], max - 1);
        return n ? new TextDecoder('latin1').decode(bytes.subarray(word(at) + 1, word(at) + 1 + n)) : '';
    };
    const out = {
        checksum: v.getUint32(word(header)),
        designSize: fix(v, word(header + 1)),
        codingScheme: lh >= 12 ? bcpl(header + 2, 40) : '',
        family: lh >= 17 ? bcpl(header + 12, 20) : '',
        params: Array.from({ length: np }, (_, i) => fix(v, word(pa + i))),
        chars: new Map(),
    };
    const info = (c) => (c < bc || c > ec) ? null : bytes.subarray(word(ci + c - bc), word(ci + c - bc) + 4);
    for (let c = bc; c <= ec; c++) {
        const b = info(c);
        if (!b[0]) continue;
        const ds = out.designSize;
        out.chars.set(c, {
            width: fix(v, word(wd + b[0])) * ds,
            height: fix(v, word(ht + (b[1] >> 4))) * ds,
            depth: fix(v, word(dp + (b[1] & 15))) * ds,
            ic: fix(v, word(it + (b[2] >> 2))) * ds,
        });
    }
    const instr = (i) => bytes.subarray(word(lk + i), word(lk + i) + 4);
    // the lig/kern step between `left` and `right`: {kern} (in points) or {lig: {op, char}}, or null
    out.ligKern = (left, right) => {
        const b = info(left);
        if (!b || (b[2] & 3) !== 1) return null;
        let i = b[3];
        let s = instr(i);
        if (s[0] > 128) { i = 256 * s[2] + s[3]; s = instr(i); }
        for (;;) {
            if (s[1] === right && s[0] <= 128) {
                if (s[2] >= 128) return { kern: fix(v, word(kn + 256 * (s[2] - 128) + s[3])) * out.designSize };
                return { lig: { op: s[2], char: s[3] } };
            }
            if (s[0] >= 128) return null;
            i += s[0] + 1;
            s = instr(i);
        }
    };
    return out;
}

/**
 * Sets a line of character codes as TeX would with the font: its ligatures
 * (fi, ff, --, ``…) and kerns.
 * @returns {Array<{code, x}>}  x in points
 */
function setLine(tfm, codes) {
    const s = codes.filter(c => tfm.chars.has(c));
    // ligatures: the program's ops (TFM's =:, =:|, |=:, |=:|, with the cursor moves of >, >>)
    for (let k = 0, guard = 0; k < s.length - 1 && guard < 10000; guard++) {
        const step = tfm.ligKern(s[k], s[k + 1]);
        if (!step || !step.lig || !tfm.chars.has(step.lig.char)) { k++; continue; }
        const { op, char } = step.lig;
        // op = 4a + 2b + c: b keeps the left character, c the right one, and the
        // cursor then moves a places on (so =: goes on from the ligature, |=: from the left)
        const keepLeft = (op >> 1) & 1, keepRight = op & 1, skip = op >> 2;
        s.splice(k, 2, ...(keepLeft ? [s[k]] : []), char, ...(keepRight ? [s[k + 1]] : []));
        k += skip;
    }
    const out = [];
    let x = 0;
    s.forEach((code, k) => {
        out.push({ code, x });
        x += tfm.chars.get(code).width;
        const step = k < s.length - 1 ? tfm.ligKern(code, s[k + 1]) : null;
        if (step && step.kern) x += step.kern;
    });
    out.width = x;
    return out;
}

// The TFM's parameters, by their place (fontdimen 1–7; math fonts have more)
const PARAMS = ['slant', 'space', 'stretch', 'shrink', 'x-height', 'quad', 'extra space'];

module.exports = { runFile, parseTfm, setLine, PARAMS, MPOST };
