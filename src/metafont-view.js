// --- METAFONT and MetaPost files in the font viewer ---
// A .mf font (or a .mp file) is a program: MetaPost runs it (src/metafont.js)
// and the font viewer shows what it drew: every character in the grid, the one
// picked with its box (width, height, depth, italic correction), the font's
// parameters, and a line of sample text set with its kerns and ligatures.
// METAFONT's proof mode labels the points of each character. Read-only: the
// source is edited as text, and run again here.
const { runFile, parseTfm, setLine, PARAMS } = require('./metafont');
const { insideArchive } = require('./browse-mode');

const CELL = 64;
const SVG_NS = 'http://www.w3.org/2000/svg';
const NEIGHBOURS = /\.(mf|mp|tfm|tex|sty|mpx|mpiv|mpxl)$/i;
const MAX_NEIGHBOURS = 3000, MAX_BYTES = 40 << 20;
const MODES = [['localfont', 'Font'], ['proof', 'Proof (labelled points)'], ['smoke', 'Smoke proof']];

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function svg(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
}
const pt = (n) => `${+n.toFixed(3)}pt`;
const STYLE = `
.fe-mf-pic{position:relative;width:${CELL}px;height:${CELL}px;overflow:hidden}
.fe-mf-pic img,.fe-mf-sample img{position:absolute;pointer-events:none}
.fe-mf-sample{position:relative;height:64px;background:#fff;border:1px solid #d0d7de;overflow:hidden}
.fe-mf-mode{background:#22272e;color:#e6edf3;border:1px solid #545d68;border-radius:4px;font:inherit;padding:1px 4px}
.fe-mf-diag{grid-column:1/-1;color:#b42318;font:12px ui-monospace,monospace;white-space:pre-wrap;margin:0}
.fe-mf-log{grid-column:1/-1}
.fe-mf-log pre{max-height:240px;overflow:auto;background:#fff;border:1px solid #d0d7de;padding:6px;font:11px ui-monospace,monospace;margin:4px 0 0;white-space:pre-wrap}
.fe-info .fe-mf-val{align-self:center;font-variant-numeric:tabular-nums}
`;

/**
 * Turns a FontComponent (src/font-plugin.js) into a view of the METAFONT or
 * MetaPost file it was opened on.
 */
function mountMeta(view) {
    if (!document.getElementById('fe-mf-style')) {
        const s = el('style');
        s.id = 'fe-mf-style';
        s.textContent = STYLE;
        document.head.appendChild(s);
    }
    const path = view.path;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const isMf = /\.mf$/i.test(name);
    const urls = [];
    let result = null, figs = [], tfm = null, unit = 1, mode = 'localfont', running = false;

    // the editing parts of the font viewer have nothing to do here
    view.saveBtn.hidden = true;
    view.advanceEl.parentElement.hidden = true;
    view.root.querySelector('[data-zoom=fit]').hidden = true;
    view.sampleCanvas.hidden = true;
    const sampleEl = el('div', 'fe-mf-sample');
    view.sampleCanvas.after(sampleEl);
    view.root.querySelector('.fe-search').placeholder = isMf ? 'Find character (A, 65, 0x41)' : 'Find figure (number)';
    view.root.querySelector('.fe-info-btn').textContent = isMf ? 'Font info' : 'Info';

    const modeSel = el('select', 'fe-mf-mode');
    modeSel.title = "METAFONT's mode: Proof labels each character's points and draws its box";
    for (const [v, label] of MODES) modeSel.appendChild(new Option(label, v));
    modeSel.onchange = () => { mode = modeSel.value; go(); };
    const rerun = el('button', null, 'Run again');
    rerun.type = 'button';
    rerun.title = 'Run the file (and the files beside it) again';
    rerun.onclick = () => go();
    const search = view.root.querySelector('.fe-search');
    if (isMf) search.before(modeSel);
    search.before(rerun);

    const status = (t, err) => view._status(t, err);

    // The file and the ones beside it that it may `input` (macros, parameter files, a base)
    async function gather() {
        const files = {};
        const read = async (p) => {
            const r = await fetch('/workspace-file?path=' + encodeURIComponent(p));
            if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
            return new Uint8Array(await r.arrayBuffer());
        };
        const dir = path.slice(0, path.lastIndexOf('/')) || '/';
        if (!insideArchive(path) && view.ctx.wsClient) {
            const listing = await view.ctx.wsClient.wsRequest({ type: 'browseDir', path: dir, showHidden: false }).catch(() => null);
            let total = 0;
            const want = ((listing && listing.items) || []).filter(it => it.type === 'file' && it.name !== name && NEIGHBOURS.test(it.name)
                && (total += it.size || 0) <= MAX_BYTES).slice(0, MAX_NEIGHBOURS);
            for (let i = 0; i < want.length; i += 16) {
                await Promise.all(want.slice(i, i + 16).map(async it => {
                    try { files[it.name] = await read(dir.replace(/\/$/, '') + '/' + it.name); } catch (_) { /* unreadable: not offered */ }
                }));
            }
        }
        // the file itself: as it is in the editor when changed there and not saved, else as saved
        const unsaved = view.ctx.isDirty && view.ctx.isDirty(view.fileId);
        const own = unsaved && view.fileData && typeof view.fileData.content === 'string' ? view.fileData.content : null;
        files[name] = own != null ? new TextEncoder().encode(own) : await read(path);
        return files;
    }

    async function go() {
        if (running) return;
        running = true;
        rerun.disabled = modeSel.disabled = true;
        const keep = figs[view.index] ? figs[view.index].charcode : null;
        const t0 = performance.now();
        try {
            status('Reading the files…');
            let files = await gather();
            let runName = name;
            // `input` takes a plain name: a file called otherwise runs under one
            if (!/^[A-Za-z0-9_-]+\.(mf|mp)$/i.test(name)) {
                runName = 'mfview-main.' + (isMf ? 'mf' : 'mp');
                files = { ...files, [runName]: files[name] };
            }
            status(isMf ? `Running METAFONT (mfplain on MetaPost), ${MODES.find(m => m[0] === mode)[1].toLowerCase()} mode…` : 'Running MetaPost…');
            result = await runFile(runName, files, { mode, dir: path.slice(0, path.lastIndexOf('/')) });
        } catch (err) {
            running = false;
            rerun.disabled = modeSel.disabled = false;
            status('Could not run it: ' + err.message, true);
            view._fail('Could not run MetaPost: ' + err.message);
            return;
        }
        running = false;
        rerun.disabled = modeSel.disabled = false;
        const ms = performance.now() - t0;
        show(ms, keep);
    }

    function show(ms, keep) {
        urls.splice(0).forEach(u => URL.revokeObjectURL(u));
        figs = result.figures.slice().sort((a, b) => a.charcode - b.charcode);
        for (const f of figs) {
            f.url = URL.createObjectURL(new Blob([f.svg], { type: 'image/svg+xml' }));
            urls.push(f.url);
        }
        tfm = null;
        if (result.tfm) try { tfm = parseTfm(result.tfm); } catch (_) { /* no metrics then */ }
        // MetaPost draws in PostScript points times mfplain's magnification
        // (36 in the proof modes); the metrics are in printer's points
        const m = /mfview-unit ([\d.]+)/.exec(result.log || '');
        unit = m ? +m[1] : 0.99626 * (isMf && mode !== 'localfont' ? 36 : 1);
        buildInfo(ms);
        buildGrid();
        const errors = result.diagnostics.filter(d => d.severity === 'error');
        const what = isMf ? 'character' : 'figure';
        status([`${figs.length} ${what}${figs.length === 1 ? '' : 's'}`, isMf ? 'METAFONT via mfplain' : 'MetaPost',
            tfm ? `design size ${pt(tfm.designSize)}` : null, `${(ms / 1000).toFixed(1)} s`,
            errors.length ? `${errors.length} error${errors.length === 1 ? '' : 's'} (see ${isMf ? 'Font info' : 'Info'})` : null].filter(Boolean).join(' · '), !!errors.length && !figs.length);
        if (!figs.length) {
            view.infoEl.hidden = false;
            view._fail(errors.length ? `MetaPost stopped: ${errors[0].message}` : isMf
                ? 'No characters: this file only defines things. Open a font that uses it (one that calls beginchar, like cmr10.mf).'
                : 'No figures: the file has no beginfig … endfig.');
            sampleEl.textContent = '';
            return;
        }
        let at = keep != null ? figs.findIndex(f => f.charcode === keep) : -1;
        if (at < 0) at = Math.max(0, figs.findIndex(f => f.charcode === 97));
        view._select(at);
        view._drawSample();
    }

    // --- Font info: what the TFM says, the run's errors and its log ---
    function buildInfo(ms) {
        const info = view.infoEl;
        info.textContent = '';
        const row = (k, v) => { info.append(el('label', null, k), el('span', 'fe-mf-val', v)); };
        row('Engine', isMf ? `MetaPost 2.11 running METAFONT through mfplain, mode ${mode}` : 'MetaPost 2.11');
        if (tfm) {
            row('Design size', pt(tfm.designSize));
            if (tfm.codingScheme) row('Coding scheme', tfm.codingScheme);
            if (tfm.family) row('Family', tfm.family);
            row('Checksum', tfm.checksum.toString(8).padStart(11, '0') + ' (octal)');
            tfm.params.forEach((p, i) => row(`fontdimen ${i + 1}${PARAMS[i] ? ' (' + PARAMS[i] + ')' : ''}`, i === 0 ? String(+p.toFixed(5)) : pt(p * tfm.designSize)));
        }
        for (const d of result.diagnostics) {
            info.appendChild(el('pre', 'fe-mf-diag', `${d.severity}${d.file ? ` ${d.file}${d.line ? ':' + d.line : ''}` : ''}: ${d.message}${d.snippet ? '\n' + d.snippet : ''}`));
        }
        const log = el('details', 'fe-mf-log');
        log.append(el('summary', null, 'Log'), el('pre', null, result.log || ''));
        info.appendChild(log);
    }

    // --- The grid: each character on a common baseline and scale ---
    function layout() {
        const withBox = figs.some(f => f.width || f.height || f.depth);
        let top = 0, bottom = 0;
        for (const f of figs) {
            top = Math.max(top, withBox ? f.height * unit : 0, f.bbox[3]);
            bottom = Math.min(bottom, withBox ? -f.depth * unit : 0, f.bbox[1]);
        }
        return { top, bottom: Math.min(bottom, 0), withBox };
    }

    function buildGrid() {
        const L = layout();
        view.cells = [];
        view.gridEl.textContent = '';
        const frag = document.createDocumentFragment();
        figs.forEach((f, i) => {
            const cell = el('div', 'fe-cell');
            cell.dataset.index = i;
            const pic = el('div', 'fe-mf-pic');
            const w = f.bbox[2] - f.bbox[0], h = f.bbox[3] - f.bbox[1];
            // a font: all on one baseline at one scale; figures: each fitted
            const s = isMf ? (CELL - 10) / Math.max(L.top - L.bottom, 1e-6)
                : Math.min((CELL - 8) / Math.max(w, 1e-6), (CELL - 8) / Math.max(h, 1e-6));
            if (w > 0 && h > 0) {
                const img = el('img');
                img.src = f.url;
                img.alt = '';
                img.style.width = w * s + 'px';
                img.style.height = h * s + 'px';
                const advance = isMf && f.width ? f.width * unit : w;
                img.style.left = ((CELL - advance * s) / 2 + (isMf && f.width ? f.bbox[0] : 0) * s) + 'px';
                img.style.top = (isMf ? 5 + (L.top - f.bbox[3]) * s : (CELL - h * s) / 2) + 'px';
                pic.appendChild(img);
            }
            const label = el('span', null, isMf ? charLabel(f.charcode) : String(f.charcode));
            cell.title = isMf ? `${f.charcode} (0x${f.charcode.toString(16).toUpperCase()}) · width ${pt(f.width)}` : `figure ${f.charcode}`;
            cell.append(pic, label);
            cell.onclick = () => view._select(i);
            view.cells.push(cell);
            frag.appendChild(cell);
        });
        view.gridEl.appendChild(frag);
    }

    const charLabel = (c) => c > 32 && c < 127 ? String.fromCharCode(c) : `#${c}`;

    // --- The character picked: drawn large, with its box ---
    view._select = (i) => {
        if (!figs[i]) return;
        if (view.cells[view.index]) view.cells[view.index].classList.remove('sel');
        view.index = i;
        view.cells[i].classList.add('sel');
        const f = figs[i];
        view.glyphNameEl.textContent = isMf
            ? `${charLabel(f.charcode)} · code ${f.charcode} (0x${f.charcode.toString(16).toUpperCase()}, '${f.charcode.toString(8)})`
            : `Figure ${f.charcode}`;
        view.hintEl.textContent = isMf
            ? `width ${pt(f.width)} · height ${pt(f.height)} · depth ${pt(f.depth)}${f.ic ? ` · italic correction ${pt(f.ic)}` : ''}`
            : `${pt((f.bbox[2] - f.bbox[0]) / 0.99626)} × ${pt((f.bbox[3] - f.bbox[1]) / 0.99626)}`;
        drawBig(f);
    };

    function drawBig(f) {
        view.canvasEl.textContent = '';
        const W = f.width * unit, H = f.height * unit, D = f.depth * unit, IC = f.ic * unit;
        const box = isMf && (f.width || f.height || f.depth);
        const x0 = Math.min(f.bbox[0], 0), x1 = Math.max(f.bbox[2], box ? W + Math.max(IC, 0) : 0);
        const y0 = Math.min(f.bbox[1], box ? -D : 0), y1 = Math.max(f.bbox[3], box ? H : 0);
        const pad = Math.max(x1 - x0, y1 - y0) * 0.12 || 1;
        // y up, as the font's: drawn with y negated
        const s = svg('svg', { viewBox: `${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`, preserveAspectRatio: 'xMidYMid meet' }, view.canvasEl);
        const line = (xa, ya, xb, yb, color, dash) => svg('line', { x1: xa, y1: -ya, x2: xb, y2: -yb, stroke: color, 'vector-effect': 'non-scaling-stroke', ...(dash ? { 'stroke-dasharray': '4 3' } : {}) }, s);
        const label = (x, y, text, anchor) => {
            const t = svg('text', { x, y: -y, fill: '#8c959f', 'text-anchor': anchor || 'end', 'font-size': (y1 - y0 + 2 * pad) / 30, 'font-family': 'sans-serif' }, s);
            t.textContent = text;
        };
        if (box) {
            svg('rect', { x: 0, y: -H, width: W, height: H + D, fill: 'rgba(9,105,218,.05)', stroke: '#0969da', 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' }, s);
            line(x0 - pad, 0, x1 + pad, 0, '#8c959f');
            label(-pad * 0.15, 0, 'baseline');
            if (H) label(-pad * 0.15, H, 'height');
            if (D) label(-pad * 0.15, -D, 'depth');
            if (IC) { line(W + IC, H, W + IC, H / 2, '#bf8700', true); label(W + IC, H + pad * 0.1, 'italic corr.', 'middle'); }
        }
        svg('image', { href: f.url, x: f.bbox[0], y: -f.bbox[3], width: f.bbox[2] - f.bbox[0], height: f.bbox[3] - f.bbox[1], preserveAspectRatio: 'none' }, s);
    }

    view._fit = () => {};   // the drawing fits itself (viewBox)

    view._find = (text) => {
        text = text.trim();
        if (!text) return;
        let code = null;
        const m = text.match(/^(?:0x([0-9a-f]+)|'([0-7]+)|(\d+))$/i);
        if (m) code = m[1] ? parseInt(m[1], 16) : m[2] ? parseInt(m[2], 8) : parseInt(m[3], 10);
        else if ([...text].length === 1 && isMf) code = text.charCodeAt(0);
        const i = figs.findIndex(f => f.charcode === code);
        if (i < 0) return status(`No ${isMf ? 'character' : 'figure'} “${text}”`, true);
        view._select(i);
        view.cells[i].scrollIntoView({ block: 'nearest' });
    };

    view._onKey = (e) => {
        if (e.target.closest('input,select,textarea')) return;
        const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (d && figs[view.index + d]) { e.preventDefault(); view._select(view.index + d); view.cells[view.index].scrollIntoView({ block: 'nearest' }); }
    };

    // --- The sample: the text set as TeX would with the font (its ligatures and kerns) ---
    view._drawSample = () => {
        sampleEl.textContent = '';
        if (!figs.length || !isMf) { sampleEl.hidden = !isMf; view.sampleEl.hidden = !isMf; return; }
        const byCode = new Map(figs.map(f => [f.charcode, f]));
        const words = view.sampleEl.value.split(' ');
        const space = tfm && tfm.params[1] ? tfm.params[1] * tfm.designSize : (tfm ? tfm.designSize : 10) / 3;
        const L = layout();
        const scale = 44 / Math.max(L.top - L.bottom, 1e-6);   // px per drawing unit
        const baseline = 10 + L.top * scale;
        let x = 8;
        for (const [k, word] of words.entries()) {
            const codes = [...word].map(c => c.charCodeAt(0)).filter(c => byCode.has(c));
            const set = tfm ? setLine(tfm, codes) : codes.reduce((a, c) => { a.push({ code: c, x: a.w }); a.w += byCode.get(c).width; return a; }, Object.assign([], { w: 0 }));
            for (const g of set) {
                const f = byCode.get(g.code);
                if (!f) continue;
                const w = f.bbox[2] - f.bbox[0], h = f.bbox[3] - f.bbox[1];
                if (w <= 0 || h <= 0) continue;
                const img = el('img');
                img.src = f.url;
                img.alt = '';
                img.style.cssText = `left:${x + (g.x * unit + f.bbox[0]) * scale}px;top:${baseline - f.bbox[3] * scale}px;width:${w * scale}px;height:${h * scale}px`;
                sampleEl.appendChild(img);
            }
            x += ((set.width != null ? set.width : set.w) + (k < words.length - 1 ? space : 0)) * unit * scale;
            if (x > sampleEl.clientWidth + 50) break;
        }
    };

    if (view.container.on) view.container.on('destroy', () => urls.forEach(u => URL.revokeObjectURL(u)));
    view.titleEl.textContent = name;
    go();
}

module.exports = { mountMeta };
