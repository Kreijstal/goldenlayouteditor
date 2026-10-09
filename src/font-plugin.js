// --- Font Editor Plugin ---
// Edits .ttf/.otf/.woff/.woff2 fonts: a grid of every glyph, an outline editor
// (drag points, box-select, nudge with the arrow keys, drag the advance width),
// the font's names, and a line of sample text. opentype.js (from esm.sh) reads
// and draws the font. Saving hands the changes to fontTools in Pyodide
// (public/py/font_edit.py), which writes them into the original file, so
// hinting, layout features and every other table are kept. Pyodide also reads
// WOFF2, which opentype.js can't.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { ensureArchiveAccess } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');
const { mountMeta } = require('./metafont-view');

const log = createLogger('Font');
const FONT_RE = /\.(ttf|otf|woff2?|mf|mp)$/i;
const META_RE = /\.(mf|mp)$/i;
const OPENTYPE_URL = 'https://esm.sh/opentype.js@2.0.0';
const PYODIDE_VERSION = '0.28.3';
const PYODIDE_URL = `https://esm.sh/pyodide@${PYODIDE_VERSION}/pyodide.mjs?raw`;
const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 64;
const NAME_FIELDS = [
    [1, 'fontFamily', 'Family'],
    [2, 'fontSubfamily', 'Style'],
    [4, 'fullName', 'Full name'],
    [6, 'postScriptName', 'PostScript name'],
    [5, 'version', 'Version'],
    [0, 'copyright', 'Copyright'],
    [8, 'manufacturer', 'Manufacturer'],
    [9, 'designer', 'Designer'],
    [13, 'license', 'License'],
];

let _opentype = null;
function loadOpentype() {
    if (!_opentype) _opentype = import(OPENTYPE_URL).then(m => (m.parse ? m : m.default)).catch(err => { _opentype = null; throw err; });
    return _opentype;
}

// Pyodide with fontTools, and font_edit.py imported: loaded on first save (or WOFF2)
let _py = null;
function loadFontTools() {
    if (!_py) {
        _py = (async () => {
            const { loadPyodide } = await import(PYODIDE_URL);
            const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });
            await pyodide.loadPackage(['fonttools', 'brotli']);
            const src = await fetch(new URL('py/font_edit.py', document.baseURI)).then(r => {
                if (!r.ok) throw new Error(`font_edit.py: HTTP ${r.status}`);
                return r.text();
            });
            pyodide.FS.writeFile('/home/pyodide/font_edit.py', src);
            return { pyodide, mod: pyodide.pyimport('font_edit') };
        })().catch(err => { _py = null; throw err; });
    }
    return _py;
}

// Runs font_edit.<fn>(bytes, ...args) and returns the bytes it gives back
async function fontTools(fn, bytes, ...args) {
    const { pyodide, mod } = await loadFontTools();
    const data = pyodide.toPy(new Uint8Array(bytes));
    try {
        const out = mod[fn](data, ...args);
        const copy = out.toJs();
        out.destroy();
        return copy.slice().buffer;
    } finally {
        data.destroy();
    }
}

// A TrueType contour list (points with onCurve / lastPointOfContour) as path
// commands, with the implied on-curve points between two off-curve ones
function ttCommands(points) {
    const cmds = [];
    let start = 0;
    for (let i = 0; i < points.length; i++) {
        if (!points[i].lastPointOfContour && i !== points.length - 1) continue;
        const c = points.slice(start, i + 1);
        start = i + 1;
        if (!c.length) continue;
        const n = c.length;
        const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        let first = c.findIndex(p => p.onCurve);
        let startPt;
        if (first < 0) { startPt = mid(c[0], c[1 % n]); first = 0; } else startPt = c[first];
        cmds.push({ type: 'M', x: startPt.x, y: startPt.y });
        let ctrl = null;
        const offset = c[first].onCurve ? 1 : 0;
        for (let k = 0; k < n; k++) {
            const p = c[(first + offset + k) % n];
            if (p.onCurve) {
                if (ctrl) cmds.push({ type: 'Q', x1: ctrl.x, y1: ctrl.y, x: p.x, y: p.y });
                else cmds.push({ type: 'L', x: p.x, y: p.y });
                ctrl = null;
            } else {
                if (ctrl) {
                    const m = mid(ctrl, p);
                    cmds.push({ type: 'Q', x1: ctrl.x, y1: ctrl.y, x: m.x, y: m.y });
                }
                ctrl = p;
            }
        }
        if (ctrl) cmds.push({ type: 'Q', x1: ctrl.x, y1: ctrl.y, x: startPt.x, y: startPt.y });
        cmds.push({ type: 'Z' });
    }
    return cmds;
}

function pathData(cmds) {
    let d = '';
    for (const c of cmds) {
        if (c.type === 'M' || c.type === 'L') d += `${c.type}${c.x} ${c.y}`;
        else if (c.type === 'Q') d += `Q${c.x1} ${c.y1} ${c.x} ${c.y}`;
        else if (c.type === 'C') d += `C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x} ${c.y}`;
        else if (c.type === 'Z') d += 'Z';
    }
    return d;
}

function svg(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
}

class FontComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = FontComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.edited = new Set();     // indexes of the glyphs changed since the last save
        this.nameEdits = {};         // nameID -> text
        this.undo = [];
        this.redo = [];
        this.selected = new Set();   // handle indexes in the current glyph

        this.root = container.element;
        this.root.classList.add('font-plugin-root');
        this.root.tabIndex = 0;
        this._installStyles();
        this.root.innerHTML = `
<div class="fe-shell">
  <div class="fe-toolbar">
    <span class="fe-title"></span>
    <button type="button" class="fe-save" disabled title="Save (Ctrl+S)">Save</button>
    <button type="button" class="fe-info-btn">Font info</button>
    <input class="fe-search" type="search" placeholder="Find glyph (a, U+0041, name)">
    <span class="fe-status"></span>
  </div>
  <div class="fe-info" hidden></div>
  <div class="fe-main">
    <div class="fe-grid"></div>
    <div class="fe-editor">
      <div class="fe-glyphbar">
        <span class="fe-glyphname"></span>
        <label>Advance <input class="fe-advance" type="number" step="1"></label>
        <button type="button" data-zoom="fit" title="Fit">Fit</button>
        <span class="fe-hint"></span>
      </div>
      <div class="fe-canvas"><div class="fe-message">Loading…</div></div>
    </div>
  </div>
  <div class="fe-preview">
    <input class="fe-sample" value="The quick brown fox jumps over the lazy dog 0123456789">
    <canvas class="fe-sample-canvas"></canvas>
  </div>
</div>`;
        const q = s => this.root.querySelector(s);
        this.titleEl = q('.fe-title');
        this.saveBtn = q('.fe-save');
        this.statusEl = q('.fe-status');
        this.infoEl = q('.fe-info');
        this.gridEl = q('.fe-grid');
        this.canvasEl = q('.fe-canvas');
        this.glyphNameEl = q('.fe-glyphname');
        this.advanceEl = q('.fe-advance');
        this.hintEl = q('.fe-hint');
        this.sampleEl = q('.fe-sample');
        this.sampleCanvas = q('.fe-sample-canvas');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';

        this.saveBtn.onclick = () => this._save();
        q('.fe-info-btn').onclick = () => { this.infoEl.hidden = !this.infoEl.hidden; };
        q('.fe-search').addEventListener('keydown', e => { if (e.key === 'Enter') this._find(e.target.value); });
        q('[data-zoom=fit]').onclick = () => this._fit();
        this.sampleEl.addEventListener('input', () => this._drawSample());
        this.advanceEl.addEventListener('change', () => {
            const v = Math.round(Number(this.advanceEl.value));
            if (!this.glyph || !Number.isFinite(v) || v === this.glyph.advanceWidth) return;
            this._checkpoint();
            this.glyph.advanceWidth = v;
            this._changed();
        });
        this.root.addEventListener('keydown', e => this._onKey(e));
        this._resizeObserver = new ResizeObserver(() => this._drawSample());
        this._resizeObserver.observe(this.sampleCanvas.parentElement);
        this._canvasObserver = new ResizeObserver(() => this._fit());
        this._canvasObserver.observe(this.canvasEl);
        if (container.on) container.on('destroy', () => {
            this._resizeObserver.disconnect();
            this._canvasObserver.disconnect();
            if (this._cellObserver) this._cellObserver.disconnect();
        });
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (FontComponent._styleInstalled) return;
        FontComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.font-plugin-root{height:100%;overflow:hidden;background:#fff;outline:none;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.fe-shell{display:flex;flex-direction:column;height:100%}
.fe-toolbar,.fe-glyphbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;white-space:nowrap;overflow:hidden}
.fe-glyphbar{background:#f6f8fa;color:#24292f;border-color:#d0d7de}
.fe-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;margin-right:6px}
.fe-toolbar button,.fe-glyphbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 9px;font:inherit;cursor:pointer}
.fe-glyphbar button{background:#fff;color:#24292f;border-color:#d0d7de}
.fe-toolbar button:disabled{opacity:.5;cursor:default}
.fe-search{width:190px;padding:2px 6px;border-radius:4px;border:1px solid #545d68;background:#22272e;color:#e6edf3;font:inherit}
.fe-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fe-status.error{color:#ff938a}
.fe-info[hidden]{display:none}
.fe-info{display:grid;grid-template-columns:max-content 1fr;gap:4px 10px;padding:8px 12px;border-bottom:1px solid #d0d7de;background:#f6f8fa;max-height:40%;overflow:auto}
.fe-info input{font:inherit;padding:2px 6px;border:1px solid #d0d7de;border-radius:4px;min-width:0}
.fe-info label{align-self:center;color:#57606a}
.fe-main{flex:1;display:flex;min-height:0}
.fe-grid{width:40%;min-width:150px;max-width:560px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,${CELL}px);grid-auto-rows:${CELL + 16}px;align-content:start;gap:1px;background:#d0d7de;border-right:1px solid #d0d7de}
.fe-cell{background:#fff;display:flex;flex-direction:column;align-items:center;cursor:pointer;position:relative}
.fe-cell canvas{width:${CELL}px;height:${CELL}px}
.fe-cell span{font-size:10px;color:#57606a;max-width:${CELL - 4}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fe-cell.sel{background:#ddf4ff}
.fe-cell.edited span{color:#bf8700;font-weight:600}
.fe-editor{flex:1;display:flex;flex-direction:column;min-width:0}
.fe-glyphname{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis}
.fe-advance{width:70px;font:inherit}
.fe-hint{margin-left:auto;color:#57606a;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.fe-canvas{position:relative;flex:1;min-height:0;background:#fff}
.fe-canvas svg{position:absolute;inset:0;width:100%;height:100%;touch-action:none;user-select:none}
.fe-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#57606a}
.fe-message.error{color:#b42318}
.fe-preview{border-top:1px solid #d0d7de;padding:6px 10px;display:flex;flex-direction:column;gap:4px;background:#f6f8fa}
.fe-sample{font:inherit;padding:2px 6px;border:1px solid #d0d7de;border-radius:4px}
.fe-sample-canvas{width:100%;height:64px;background:#fff;border:1px solid #d0d7de}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + this.ctx.getRelativePath(this.fileId);
    }

    async _init() {
        this.path = this._path();
        if (!this.path) return this._fail('Fonts need the server workspace.');
        // a METAFONT or MetaPost program: what it draws, run in MetaPost
        if (META_RE.test(this.path)) return mountMeta(this);
        this.readOnly = insideArchive(this.path);
        let opentype;
        try {
            if (this.readOnly) await ensureArchiveAccess();
            [opentype, this.bytes] = await Promise.all([loadOpentype(), fetch('/workspace-file?path=' + encodeURIComponent(this.path)).then(async r => {
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                return r.arrayBuffer();
            })]);
            this.opentype = opentype;
            let sfnt = this.bytes;
            if (new TextDecoder().decode(new Uint8Array(sfnt, 0, 4)) === 'wOF2') {
                this._status('Loading fontTools to read WOFF2…');
                sfnt = await fontTools('to_sfnt', sfnt);
            }
            this.font = opentype.parse(sfnt);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the font: ' + err.message);
        }
        this.cff = this.font.outlinesFormat === 'cff';
        this._buildInfo();
        this._buildGrid();
        this._status(this._summary());
        const start = this.font.charToGlyph('a');
        this._select(start && start.index ? start.index : Math.min(1, this.font.numGlyphs - 1));
        this._drawSample();
        log.log(`Opened ${this.path}: ${this.font.numGlyphs} glyphs, ${this.font.outlinesFormat}`);
    }

    _summary() {
        const f = this.font;
        const parts = [`${f.numGlyphs} glyphs`, this.cff ? 'CFF' : 'TrueType', `${f.unitsPerEm} units/em`];
        if (this.readOnly) parts.push('read-only');
        const n = this.edited.size + Object.keys(this.nameEdits).length;
        if (n) parts.push(`${n} unsaved change${n === 1 ? '' : 's'}`);
        return parts.join(' · ');
    }

    // --- Font info (the name table) ---

    _name(key) {
        const names = this.font.names;
        for (const table of [names.windows, names.macintosh, names.unicode, names]) {
            const rec = table && table[key];
            if (rec && typeof rec === 'object') return rec.en || Object.values(rec)[0] || '';
        }
        return '';
    }

    _buildInfo() {
        this.infoEl.textContent = '';
        for (const [id, key, label] of NAME_FIELDS) {
            const l = document.createElement('label');
            l.textContent = label;
            const input = document.createElement('input');
            input.value = this._name(key);
            input.readOnly = this.readOnly;
            input.addEventListener('change', () => {
                this.nameEdits[id] = input.value;
                this._changed(true);
            });
            this.infoEl.append(l, input);
        }
    }

    // --- Glyph grid ---

    _buildGrid() {
        this.cells = [];
        this._cellObserver = new IntersectionObserver(entries => {
            for (const e of entries) if (e.isIntersecting) this._drawCell(Number(e.target.dataset.index));
        }, { root: this.gridEl });
        // In chunks, so a CJK font's tens of thousands of cells don't hold up the page
        let i = 0;
        const chunk = () => {
            const frag = document.createDocumentFragment();
            for (const end = Math.min(this.font.numGlyphs, i + 2000); i < end; i++) {
                const cell = document.createElement('div');
                cell.className = 'fe-cell';
                cell.dataset.index = i;
                const label = document.createElement('span');
                const g = this.font.glyphs.get(i);
                label.textContent = g.unicode !== undefined ? String.fromCodePoint(g.unicode) : (g.name || '#' + i);
                cell.title = `${g.name || ''} #${i}${g.unicode !== undefined ? ' U+' + g.unicode.toString(16).toUpperCase().padStart(4, '0') : ''}`;
                cell.append(document.createElement('canvas'), label);
                cell.onclick = () => this._select(Number(cell.dataset.index));
                this.cells.push(cell);
                frag.appendChild(cell);
                this._cellObserver.observe(cell);
            }
            this.gridEl.appendChild(frag);
            if (this.index !== undefined && this.cells[this.index]) this.cells[this.index].classList.add('sel');
            if (i < this.font.numGlyphs) setTimeout(chunk);
        };
        chunk();
    }

    _drawCell(i) {
        const cell = this.cells[i];
        if (!cell) return;
        const canvas = cell.firstChild;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = CELL * dpr;
        canvas.height = CELL * dpr;
        const c = canvas.getContext('2d');
        c.scale(dpr, dpr);
        const f = this.font;
        const size = CELL * 0.7;
        const scale = size / f.unitsPerEm;
        const g = f.glyphs.get(i);
        const x = (CELL - g.advanceWidth * scale) / 2;
        const baseline = CELL * 0.5 + (f.ascender + f.descender) / 2 * scale;
        c.clearRect(0, 0, CELL, CELL);
        try {
            const p = g.getPath(x, baseline, size);
            p.fill = '#24292f';
            p.draw(c);
        } catch (err) { /* an unreadable glyph stays blank */ }
        cell.classList.toggle('edited', this.edited.has(i));
    }

    _find(text) {
        text = text.trim();
        if (!text) return;
        const f = this.font;
        let index = -1;
        const m = text.match(/^(?:U\+|0x)([0-9a-f]+)$/i);
        if (m) index = f.charToGlyphIndex(String.fromCodePoint(parseInt(m[1], 16)));
        else if ([...text].length === 1) index = f.charToGlyphIndex(text);
        if (index <= 0) {
            for (let i = 0; i < f.numGlyphs; i++) if (f.glyphs.get(i).name === text) { index = i; break; }
        }
        if (index < 0 || (index === 0 && text !== '.notdef')) return this._status(`No glyph for “${text}”`, true);
        this._select(index);
        this.cells[index].scrollIntoView({ block: 'nearest' });
    }

    // --- The glyph being edited ---

    _select(index) {
        if (this.cells[this.index]) this.cells[this.index].classList.remove('sel');
        this.index = index;
        if (this.cells[index]) this.cells[index].classList.add('sel');
        this.glyph = this.font.glyphs.get(index);
        this.glyph.path; // parses the outline (and, for TrueType, its points)
        this.selected.clear();
        const g = this.glyph;
        this.glyphNameEl.textContent = `${g.name || '#' + index}${g.unicode !== undefined ? ' · U+' + g.unicode.toString(16).toUpperCase().padStart(4, '0') + ' ' + String.fromCodePoint(g.unicode) : ''}`;
        this.advanceEl.value = g.advanceWidth;
        this.advanceEl.disabled = this.readOnly;
        this._buildHandles();
        this._buildEditor();
        this._fit();
        this.hintEl.textContent = this.readOnly ? 'In an archive: read-only'
            : g.isComposite ? 'Composite glyph: made of other glyphs, its outline is not editable here'
            : this.handles.length ? 'Drag points · box-select · arrows nudge (Shift ×10) · Ctrl+Z undo'
            : 'Empty glyph';
    }

    // Draggable points. TrueType: the glyph's own points, on- and off-curve.
    // CFF: each command's end and control points, a contour's closing point
    // joined with its start
    _buildHandles() {
        const g = this.glyph;
        const handles = [];
        if (g.isComposite) {
            this.handles = handles;
            return;
        }
        if (!this.cff) {
            const pts = g.points || [];
            let start = 0;
            pts.forEach((p, i) => {
                handles.push({ on: p.onCurve, refs: [p], attached: [] });
                if (p.lastPointOfContour || i === pts.length - 1) {
                    // An on-curve point carries the off-curve points next to it
                    const n = i - start + 1;
                    for (let k = start; k <= i; k++) {
                        if (!pts[k].onCurve) continue;
                        const prev = start + (k - start - 1 + n) % n, next = start + (k - start + 1) % n;
                        for (const j of [prev, next]) if (j !== k && !pts[j].onCurve) handles[k].attached.push(j);
                    }
                    start = i + 1;
                }
            });
        } else {
            const cmds = g.path.commands;
            let prevEnd = null, contourStart = null;
            cmds.forEach((c, ci) => {
                if (c.type === 'Z') {
                    prevEnd = contourStart = null;
                    return;
                }
                let c1 = null, c2 = null;
                if (c.type === 'C' || c.type === 'Q') {
                    handles.push({ on: false, refs: [{ obj: c, x: 'x1', y: 'y1' }], attached: [] });
                    c1 = handles.length - 1;
                    // The first control belongs to the point the curve leaves from
                    if (prevEnd !== null && c.type === 'C') handles[prevEnd].attached.push(c1);
                }
                if (c.type === 'C') {
                    handles.push({ on: false, refs: [{ obj: c, x: 'x2', y: 'y2' }], attached: [] });
                    c2 = handles.length - 1;
                }
                const ref = { obj: c, x: 'x', y: 'y' };
                const next = cmds[ci + 1];
                const closes = c.type !== 'M' && contourStart !== null && (!next || next.type === 'Z' || next.type === 'M');
                const sp = contourStart !== null ? this._pos(handles[contourStart]) : null;
                let end;
                if (closes && sp.x === c.x && sp.y === c.y) {
                    handles[contourStart].refs.push(ref);
                    end = contourStart;
                } else {
                    handles.push({ on: true, refs: [ref], attached: [] });
                    end = handles.length - 1;
                    if (c.type === 'M') contourStart = end;
                }
                if (c2 !== null) handles[end].attached.push(c2);
                else if (c1 !== null) handles[end].attached.push(c1);
                prevEnd = end;
            });
        }
        this.handles = handles;
    }

    _pos(h) {
        const r = h.refs[0];
        return r.obj ? { x: r.obj[r.x], y: r.obj[r.y] } : { x: r.x, y: r.y };
    }

    _move(h, dx, dy) {
        for (const r of h.refs) {
            if (r.obj) { r.obj[r.x] += dx; r.obj[r.y] += dy; } else { r.x += dx; r.y += dy; }
        }
    }

    _commands() {
        const g = this.glyph;
        if (this.cff || g.isComposite || !g.points) return g.path.commands;
        return ttCommands(g.points);
    }

    _buildEditor() {
        this.canvasEl.textContent = '';
        const f = this.font, g = this.glyph;
        const s = svg('svg', {}, this.canvasEl);
        this.svg = s;
        // Font units, y up
        const root = svg('g', { transform: 'scale(1,-1)' }, s);
        const os2 = f.tables.os2 || {};
        const lines = [[0, 'baseline'], [f.ascender, 'ascender'], [f.descender, 'descender']];
        if (os2.sxHeight) lines.push([os2.sxHeight, 'x-height']);
        if (os2.sCapHeight) lines.push([os2.sCapHeight, 'cap height']);
        const W = f.unitsPerEm * 4;
        this.metrics = svg('g', {}, root);
        for (const [y, label] of lines) {
            svg('line', { x1: -W, x2: W, y1: y, y2: y, stroke: y === 0 ? '#8c959f' : '#d0d7de', 'vector-effect': 'non-scaling-stroke' }, this.metrics);
            const t = svg('text', { x: -8, y: -y - 4, transform: 'scale(1,-1)', fill: '#8c959f', 'text-anchor': 'end', class: 'fe-metric-label' }, this.metrics);
            t.textContent = label;
        }
        svg('line', { x1: 0, x2: 0, y1: -W, y2: W, stroke: '#d0d7de', 'vector-effect': 'non-scaling-stroke' }, this.metrics);
        this.advLine = svg('line', { y1: -W, y2: W, stroke: '#0969da', 'stroke-width': 6, 'stroke-opacity': 0, 'vector-effect': 'non-scaling-stroke', style: this.readOnly ? '' : 'cursor:ew-resize' }, root);
        this.advVisible = svg('line', { y1: -W, y2: W, stroke: '#0969da', 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, root);
        this.outline = svg('path', { fill: 'rgba(36,41,47,.12)', stroke: '#24292f', 'vector-effect': 'non-scaling-stroke', 'fill-rule': 'nonzero' }, root);
        this.handleLines = svg('g', { stroke: '#a475f9', 'vector-effect': 'non-scaling-stroke' }, root);
        this.pointLayer = svg('g', {}, root);
        this.band = svg('rect', { fill: 'rgba(9,105,218,.1)', stroke: '#0969da', 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' }, root);
        this._render();
        this._bindPointer();
        if (g.isComposite) this.outline.setAttribute('fill', 'rgba(36,41,47,.25)');
    }

    _render() {
        const g = this.glyph;
        const cmds = this._commands();
        this.outline.setAttribute('d', pathData(cmds));
        for (const l of [this.advLine, this.advVisible]) { l.setAttribute('x1', g.advanceWidth); l.setAttribute('x2', g.advanceWidth); }
        // Control lines: off-curve to its on-curve neighbours
        this.handleLines.textContent = '';
        this.handles.forEach((h, i) => {
            if (!h.on) return;
            const p = this._pos(h);
            for (const j of h.attached) {
                const q = this._pos(this.handles[j]);
                svg('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, 'vector-effect': 'non-scaling-stroke' }, this.handleLines);
            }
        });
        const r = this._unit() * 4;
        this.pointLayer.textContent = '';
        this.pointEls = this.handles.map((h, i) => {
            const p = this._pos(h);
            const sel = this.selected.has(i);
            const el = h.on
                ? svg('rect', { x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r })
                : svg('circle', { cx: p.x, cy: p.y, r });
            el.setAttribute('fill', sel ? '#0969da' : h.on ? '#fff' : '#fff');
            el.setAttribute('stroke', h.on ? '#24292f' : '#8250df');
            el.setAttribute('vector-effect', 'non-scaling-stroke');
            el.dataset.h = i;
            if (!this.readOnly) el.style.cursor = 'move';
            this.pointLayer.appendChild(el);
            return el;
        });
    }

    // Font units per screen pixel
    _unit() {
        const vb = this.svg.viewBox.baseVal;
        const w = this.svg.clientWidth || 1;
        return vb && vb.width ? vb.width / w : 1;
    }

    _fit() {
        if (!this.svg) return;
        const f = this.font, g = this.glyph;
        const top = Math.max(f.ascender, (f.tables.os2 || {}).sCapHeight || 0);
        const bottom = Math.min(f.descender, 0);
        const pad = f.unitsPerEm * 0.15;
        const w = Math.max(g.advanceWidth, f.unitsPerEm * 0.5);
        const box = [-pad, -top - pad, w + 2 * pad, top - bottom + 2 * pad];
        // The whole box in view, centred
        const cw = this.svg.clientWidth || 400, ch = this.svg.clientHeight || 400;
        const scale = Math.max(box[2] / cw, box[3] / ch);
        const vw = cw * scale, vh = ch * scale;
        this.svg.setAttribute('viewBox', `${box[0] - (vw - box[2]) / 2} ${box[1] - (vh - box[3]) / 2} ${vw} ${vh}`);
        for (const t of this.svg.querySelectorAll('.fe-metric-label')) t.setAttribute('font-size', 11 * scale);
        this._render();
    }

    _toFont(e) {
        const pt = this.svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const p = pt.matrixTransform(this.svg.getScreenCTM().inverse());
        return { x: p.x, y: -p.y };
    }

    _bindPointer() {
        const s = this.svg;
        s.addEventListener('wheel', e => {
            e.preventDefault();
            const vb = s.viewBox.baseVal;
            const k = e.deltaY < 0 ? 1 / 1.15 : 1.15;
            const p = this._toFont(e);
            const x = vb.x + (p.x - vb.x) * (1 - k), y = vb.y + (-p.y - vb.y) * (1 - k);
            s.setAttribute('viewBox', `${x} ${y} ${vb.width * k} ${vb.height * k}`);
            for (const t of s.querySelectorAll('.fe-metric-label')) t.setAttribute('font-size', 11 * this._unit());
            this._render();
        }, { passive: false });
        s.addEventListener('pointerdown', e => {
            // (the points are redrawn under the pointer, which would leave focus on the page)
            e.preventDefault();
            this.root.focus({ preventScroll: true });
            const start = this._toFont(e);
            const target = e.target;
            let drag = null;
            if (e.button === 1 || (e.button === 0 && e.altKey)) {
                drag = { kind: 'pan', vb: s.viewBox.baseVal, cx: e.clientX, cy: e.clientY, x: s.viewBox.baseVal.x, y: s.viewBox.baseVal.y };
            } else if (this.readOnly || this.glyph.isComposite) {
                return;
            } else if (target.dataset && target.dataset.h !== undefined) {
                const i = Number(target.dataset.h);
                if (e.shiftKey) {
                    if (this.selected.has(i)) this.selected.delete(i); else this.selected.add(i);
                } else if (!this.selected.has(i)) {
                    this.selected = new Set([i]);
                }
                this._checkpoint();
                drag = { kind: 'points', last: start, moved: false };
            } else if (target === this.advLine) {
                this._checkpoint();
                drag = { kind: 'advance' };
            } else {
                if (!e.shiftKey) this.selected.clear();
                drag = { kind: 'band', start, base: new Set(this.selected) };
            }
            s.setPointerCapture(e.pointerId);
            this._render();
            const onMove = ev => {
                const p = this._toFont(ev);
                if (drag.kind === 'pan') {
                    const u = this._unit();
                    s.setAttribute('viewBox', `${drag.x - (ev.clientX - drag.cx) * u} ${drag.y - (ev.clientY - drag.cy) * u} ${drag.vb.width} ${drag.vb.height}`);
                } else if (drag.kind === 'points') {
                    const dx = Math.round(p.x - drag.last.x), dy = Math.round(p.y - drag.last.y);
                    if (!dx && !dy) return;
                    drag.last = { x: drag.last.x + dx, y: drag.last.y + dy };
                    drag.moved = true;
                    this._moveSelected(dx, dy, false);
                } else if (drag.kind === 'advance') {
                    this.glyph.advanceWidth = Math.max(0, Math.round(p.x));
                    this.advanceEl.value = this.glyph.advanceWidth;
                    this._render();
                } else if (drag.kind === 'band') {
                    const x0 = Math.min(drag.start.x, p.x), x1 = Math.max(drag.start.x, p.x);
                    const y0 = Math.min(drag.start.y, p.y), y1 = Math.max(drag.start.y, p.y);
                    Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, visibility: 'visible' }).forEach(([k, v]) => this.band.setAttribute(k, v));
                    this.selected = new Set(drag.base);
                    this.handles.forEach((h, i) => {
                        const q = this._pos(h);
                        if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) this.selected.add(i);
                    });
                    this._render();
                }
            };
            const onUp = () => {
                s.removeEventListener('pointermove', onMove);
                s.removeEventListener('pointerup', onUp);
                s.removeEventListener('pointercancel', onUp);
                this.band.setAttribute('visibility', 'hidden');
                if (drag.kind === 'points' && !drag.moved) this.undo.pop();
                if ((drag.kind === 'points' && drag.moved) || drag.kind === 'advance') this._changed();
            };
            s.addEventListener('pointermove', onMove);
            s.addEventListener('pointerup', onUp);
            s.addEventListener('pointercancel', onUp);
        });
    }

    // Moves the selected points, and the off-curve points of the selected
    // on-curve ones along with them
    _moveSelected(dx, dy, commit = true) {
        if (!this.selected.size) return;
        if (commit) this._checkpoint();
        const moving = new Set(this.selected);
        for (const i of this.selected) if (this.handles[i].on) for (const j of this.handles[i].attached) moving.add(j);
        for (const i of moving) this._move(this.handles[i], dx, dy);
        this._outlineChanged();
        if (commit) this._changed();
    }

    // The glyph's path from its edited points, for the grid and the sample
    _outlineChanged() {
        const g = this.glyph;
        if (!this.cff) {
            const p = new this.opentype.Path();
            p.commands = ttCommands(g.points);
            g.path = p;
        }
        this._render();
    }

    _snapshot() {
        const g = this.glyph;
        return {
            index: this.index,
            advance: g.advanceWidth,
            data: this.cff ? g.path.commands.map(c => ({ ...c })) : (g.points || []).map(p => ({ x: p.x, y: p.y })),
            wasEdited: this.edited.has(this.index),
        };
    }

    _restore(snap) {
        if (snap.index !== this.index) this._select(snap.index);
        const g = this.glyph;
        g.advanceWidth = snap.advance;
        if (this.cff) {
            g.path.commands.forEach((c, i) => Object.assign(c, snap.data[i]));
        } else {
            (g.points || []).forEach((p, i) => { p.x = snap.data[i].x; p.y = snap.data[i].y; });
        }
        if (!snap.wasEdited) this.edited.delete(this.index);
        this.advanceEl.value = g.advanceWidth;
        this._outlineChanged();
        this._changed(false, !snap.wasEdited);
    }

    _checkpoint() {
        this.undo.push(this._snapshot());
        if (this.undo.length > 200) this.undo.shift();
        this.redo = [];
    }

    _history(from, to) {
        const snap = from.pop();
        if (!snap) return;
        if (snap.index !== this.index) this._select(snap.index);
        to.push(this._snapshot());
        this._restore(snap);
    }

    // After an edit: marks the glyph, redraws its cell and the sample
    _changed(namesOnly, unmark) {
        if (!namesOnly && this.glyph && !unmark) this.edited.add(this.index);
        if (!namesOnly) {
            this._drawCell(this.index);
            this._drawSample();
            this._render();
        }
        this.saveBtn.disabled = this.readOnly || !(this.edited.size || Object.keys(this.nameEdits).length);
        this._status(this._summary());
    }

    _onKey(e) {
        if (e.target.tagName === 'INPUT') return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            this._save();
        } else if (mod && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) this._history(this.redo, this.undo); else this._history(this.undo, this.redo);
        } else if (mod && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            this._history(this.redo, this.undo);
        } else if (mod && e.key.toLowerCase() === 'a' && this.handles) {
            e.preventDefault();
            this.selected = new Set(this.handles.map((_, i) => i));
            this._render();
        } else if (e.key.startsWith('Arrow') && this.selected.size && !this.readOnly) {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 1;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
            this._moveSelected(d[0], d[1]);
        } else if (e.key === 'Escape') {
            this.selected.clear();
            this._render();
        }
    }

    _drawSample() {
        if (!this.font) return;
        const canvas = this.sampleCanvas;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w) return;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const c = canvas.getContext('2d');
        c.scale(dpr, dpr);
        c.clearRect(0, 0, w, h);
        const f = this.font;
        const size = h * 0.6;
        const scale = size / f.unitsPerEm;
        const baseline = h / 2 + (f.ascender + f.descender) / 2 * scale;
        try {
            const p = f.getPath(this.sampleEl.value, 8, baseline, size);
            p.fill = '#24292f';
            p.draw(c);
        } catch (err) {
            log.warn('Sample text:', err);
        }
    }

    // --- Saving ---

    _edits() {
        const glyphs = {};
        for (const index of this.edited) {
            const g = this.font.glyphs.get(index);
            const e = { advance: g.advanceWidth };
            if (!g.isComposite) {
                if (this.cff) e.commands = g.path.commands;
                else if (g.points && g.points.length) e.points = g.points.map(p => [p.x, p.y]);
            }
            glyphs[index] = e;
        }
        return { names: this.nameEdits, glyphs };
    }

    async _save() {
        if (this.readOnly || this._saving || this.saveBtn.disabled) return;
        this._saving = true;
        this.saveBtn.disabled = true;
        try {
            this._status('Loading fontTools…');
            await loadFontTools();
            this._status('Saving…');
            const out = await fontTools('apply_edits', this.bytes, JSON.stringify(this._edits()));
            const r = await fetch('/upload-file?overwrite=1&path=' + encodeURIComponent(this.path), { method: 'PUT', body: new Blob([out]) });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
            this.bytes = out;
            const saved = this.edited.size;
            this.edited.clear();
            this.nameEdits = {};
            for (const cell of this.gridEl.querySelectorAll('.fe-cell.edited')) cell.classList.remove('edited');
            this._status(`Saved ${new Date().toLocaleTimeString()} · ${this._summary()}`);
            log.log(`Saved ${this.path} (${out.byteLength} bytes, ${saved} glyph(s))`);
        } catch (err) {
            log.error('Save failed:', err);
            this._status('Could not save: ' + err.message, true);
            this.saveBtn.disabled = false;
        } finally {
            this._saving = false;
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(message) {
        this.canvasEl.innerHTML = '';
        const m = document.createElement('div');
        m.className = 'fe-message error';
        m.textContent = message;
        this.canvasEl.appendChild(m);
    }
}

registerPlugin({
    id: 'font',
    name: 'Font editor',
    components: {
        fontEditor: FontComponent,
    },
    contextMenuItems: [{
        label: 'Open in font editor',
        canHandle: (fileName) => FONT_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = FontComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('fontEditor', { fileId }, `${file.name} [font]`, 'font-' + fileId);
        },
    }],
    init(ctx) {
        FontComponent._ctx = ctx;
    },
});
