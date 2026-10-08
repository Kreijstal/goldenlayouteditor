// --- Photometry viewer (EULUMDAT .ldt, IESNA LM-63 .ies) ---
// A luminaire's light distribution drawn as eulumdat-rs draws it: polar,
// cartesian, heatmap, butterfly (3D), cone, isocandela or BUG rating, chosen in
// the toolbar; beside it the key figures eulumdat computes (flux, LOR, efficacy,
// beam and field angles, CIE flux code), the file's header as eulumdat reads it,
// its lamp sets and what eulumdat's validation finds wrong. Both formats are
// plain text: the editor stays a tab away, and the diagram follows the file's
// text as it is edited. eulumdat-rs is loaded from jsDelivr (src/eulumdat.js).
// Also draws polar-diagram thumbnails in the file browser's grid.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { PHOTOMETRY_DIAGRAMS, loadEulumdat, decodePhotometryText, photometrySummary, photometryHeader } = require('./eulumdat');

const log = createLogger('Photometry');
const PHOTOMETRY_NAME_RE = /\.(ldt|ies)$/i;
let _ctx = null;

function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (k === 'class') e.className = v;
        else e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== '') e.append(c instanceof Node ? c : String(c));
    return e;
}

function rowsTable(rows) {
    rows = rows.filter(r => r[1] !== '' && r[1] != null);
    if (!rows.length) return null;
    return el('table', { class: 'phot-kv' }, rows.map(([k, v]) => el('tr', null, el('th', null, k), el('td', null, v))));
}

async function readText(file) {
    // (a file the browser lists but hasn't read yet holds '' until then)
    if (typeof file.content === 'string' && !file.lazy) return file.content;
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + _ctx.getRelativePath(file.id)));
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return decodePhotometryText(new Uint8Array(await resp.arrayBuffer()));
}

// One diagram as SVG text, sized as src/eulumdat.js sizes it
async function diagramSvg(text, kind, dark) {
    const lib = await loadEulumdat();
    const spec = PHOTOMETRY_DIAGRAMS.find(d => d[0] === kind) || PHOTOMETRY_DIAGRAMS[0];
    return { svg: lib.photometryDiagram(text, spec[0], spec[2], spec[3], dark), width: spec[2] };
}

class PhotometryComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'photometry.ldt';
        this.kind = this.state.kind || 'polar';
        this.dark = false;
        this.source = null;
        this.svg = null;
        this.url = null;
        this.root = container.element;
        this.root.classList.add('phot-root');
        PhotometryComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (PhotometryComponent._styled) return;
        PhotometryComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.phot-root{height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#1f2328;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.phot-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;flex-wrap:wrap;flex-shrink:0}
.phot-toolbar button,.phot-toolbar select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.phot-toolbar button:hover{background:#444c56}
.phot-toolbar button.active{background:#1f6feb;border-color:#388bfd}
.phot-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.phot-body{flex:1;min-height:0;display:flex;flex-wrap:wrap;overflow:auto}
.phot-stage{flex:1 1 420px;min-width:0;padding:12px;display:flex;justify-content:center;align-items:flex-start}
.phot-stage.dark{background:#1a1a1a}
.phot-stage img{max-width:100%;height:auto;display:block}
.phot-side{flex:0 1 380px;min-width:260px;padding:12px;box-sizing:border-box}
.phot-side h4{margin:12px 0 4px;font-size:13px}
.phot-side h4:first-child{margin-top:0}
.phot-kv{border-collapse:collapse;font-size:12px;width:100%}
.phot-kv th{text-align:left;color:#59636e;font-weight:normal;padding:2px 10px 2px 0;vertical-align:top;white-space:nowrap}
.phot-kv td{padding:2px 0;word-break:break-word}
.phot-lamps{border-collapse:collapse;font-size:12px;width:100%}
.phot-lamps th,.phot-lamps td{border-bottom:1px solid #d1d9e0;padding:2px 6px 2px 0;text-align:left;vertical-align:top}
.phot-lamps th{color:#59636e;font-weight:normal}
.phot-warn{font-size:12px;color:#9a6700;margin:2px 0}
.phot-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;color:#adbac7;border-top:1px solid #444c56;white-space:nowrap;overflow:hidden;font-size:12px;flex-shrink:0}
.phot-status .phot-stale{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.phot-message{padding:20px;color:#59636e}
.phot-error{padding:20px;color:#cf222e;white-space:pre-wrap}
`;
        document.head.appendChild(style);
    }

    _button(label, title, onClick) {
        const b = el('button', { type: 'button', title }, label);
        b.addEventListener('click', onClick);
        return b;
    }

    _buildUI() {
        const bar = el('div', { class: 'phot-toolbar' });
        this.fileInput = el('input', { type: 'file', accept: '.ldt,.ies', style: 'display:none' });
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            // A file from this computer: shown, not followed
            this.fileId = null;
            this.fileName = f.name;
            this._show(decodePhotometryText(new Uint8Array(await f.arrayBuffer())));
        });
        this.titleEl = el('span', { class: 'phot-title' }, this.fileName);
        this.kindButtons = {};
        for (const [kind, label] of PHOTOMETRY_DIAGRAMS) {
            this.kindButtons[kind] = this._button(label, `Draw the ${label.toLowerCase()} diagram`, () => {
                this.kind = kind;
                this.state.kind = kind;
                if (this.container.setState) this.container.setState(this.state);
                this._draw();
            });
        }
        this.darkButton = this._button('Dark', 'Draw on a dark background', () => {
            this.dark = !this.dark;
            this._draw();
        });
        bar.append(
            this.fileInput,
            this._button('Open', 'Open an EULUMDAT (.ldt) or IES (.ies) file from this computer', () => this.fileInput.click()),
            this.titleEl,
            ...Object.values(this.kindButtons),
            this.darkButton,
            this._button('Save SVG', 'Save the diagram as SVG', () => this._saveSvg()),
        );
        this.stage = el('div', { class: 'phot-stage' }, el('div', { class: 'phot-message' }, 'Loading…'));
        this.side = el('div', { class: 'phot-side' });
        const status = el('div', { class: 'phot-status' });
        this.infoEl = el('span');
        this.staleEl = el('span', { class: 'phot-stale' });
        status.append(this.infoEl, this.staleEl);
        this.root.append(bar, el('div', { class: 'phot-body' }, this.stage, this.side), status);
        this._updateButtons();
    }

    _updateButtons() {
        for (const [k, b] of Object.entries(this.kindButtons)) b.classList.toggle('active', k === this.kind);
        this.darkButton.classList.toggle('active', this.dark);
        this.stage.classList.toggle('dark', this.dark);
    }

    async _init() {
        if (!this.fileId || !_ctx) {
            this.stage.innerHTML = '';
            this.stage.append(el('div', { class: 'phot-message' }, 'Open an EULUMDAT (.ldt) or IES (.ies) file.'));
            return;
        }
        const file = _ctx.projectFiles[this.fileId];
        if (!file) return;
        try {
            await this._show(await readText(file));
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        // Follow edits made in the file's editor tab
        this.watch = setInterval(() => {
            const f = this.fileId && _ctx.projectFiles[this.fileId];
            if (f && typeof f.content === 'string' && !f.lazy && f.content !== this.source) this._show(f.content);
        }, 400);
    }

    // Read the text: the diagram and the side panel, or (while it is being edited) what is wrong with it
    async _show(text) {
        this.source = text;
        this.titleEl.textContent = this.fileName;
        const seq = this.seq = (this.seq || 0) + 1;
        let header, summary;
        try {
            header = await photometryHeader(text);
            summary = await photometrySummary(text);
        } catch (err) {
            if (seq !== this.seq) return;
            // Keep the last diagram and say what is wrong
            if (this.svg) { this.staleEl.textContent = `Not updated: ${err.message}`; return; }
            log.error('Photometry failed:', err);
            this._error(`Could not read ${this.fileName} as EULUMDAT or IES: ${err.message || err}`);
            return;
        }
        if (seq !== this.seq) return;
        this.staleEl.textContent = '';
        this._side(header, summary);
        const lamps = header.lampSets.reduce((n, l) => n + Math.abs(l.count), 0);
        this.infoEl.textContent = `${header.format === 'IES' ? 'IES LM-63' : 'EULUMDAT'} · ${lamps} lamp${lamps === 1 ? '' : 's'}` +
            (header.warnings.length ? ` · ${header.warnings.length} validation note${header.warnings.length === 1 ? '' : 's'}` : '');
        await this._draw();
    }

    async _draw() {
        this._updateButtons();
        if (this.source == null) return;
        const seq = this.drawSeq = (this.drawSeq || 0) + 1;
        let out;
        try {
            out = await diagramSvg(this.source, this.kind, this.dark);
        } catch (err) {
            if (seq !== this.drawSeq) return;
            if (this.svg) { this.staleEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not draw ${this.fileName}: ${err.message || err}`);
            return;
        }
        if (seq !== this.drawSeq) return;
        this.svg = out.svg;
        // As an <img>, so nothing in the SVG runs
        const url = URL.createObjectURL(new Blob([out.svg], { type: 'image/svg+xml' }));
        const img = el('img', { alt: `${PHOTOMETRY_DIAGRAMS.find(d => d[0] === this.kind)[1]} diagram of ${this.fileName}` });
        img.style.width = out.width + 'px';
        img.src = url;
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = url;
        this.stage.innerHTML = '';
        this.stage.append(img);
    }

    _side(h, s) {
        const n = (v, unit, digits = 0) => Number.isFinite(v) && v ? v.toFixed(digits) + unit : '';
        const lamps = h.lampSets.length ? el('table', { class: 'phot-lamps' },
            el('tr', null, ['Lamps', 'Type', 'Flux', 'Colour', 'CRI', 'Watts'].map(t => el('th', null, t))),
            h.lampSets.map(l => el('tr', null, [l.count, l.type, n(l.flux, ' lm'), l.colour, l.colourRendering, n(l.watts, ' W', 1)].map(v => el('td', null, String(v)))))) : null;
        this.side.innerHTML = '';
        this.side.append(
            el('h4', null, 'Key figures'),
            rowsTable([
                ['Luminaire', s.luminaireName],
                ['Lamp flux', n(s.lampFlux, ' lm')], ['Luminaire flux', n(s.lampFlux * s.lor / 100, ' lm')],
                ['Wattage', n(s.wattage, ' W', 1)], ['Lamp efficacy', n(s.lampEfficacy, ' lm/W', 1)], ['Luminaire efficacy', n(s.luminaireEfficacy, ' lm/W', 1)],
                ['LOR', n(s.lor, ' %', 1)], ['DLOR / ULOR', s.lor ? `${s.dlor.toFixed(1)} / ${s.ulor.toFixed(1)} %` : ''],
                ['Max intensity', n(s.maxIntensity, ' cd/klm', 1)], ['Beam angle (50 %)', n(s.beamAngle, '°', 1)], ['Field angle (10 %)', n(s.fieldAngle, '°', 1)],
                ['CIE flux code', s.cieFluxCode],
            ]) || '',
            el('h4', null, h.format === 'IES' ? 'IES header' : 'EULUMDAT header'),
            rowsTable(h.rows) || '',
            lamps && el('h4', null, 'Lamp sets'), lamps || '',
            h.warnings.length ? el('h4', null, 'Validation (eulumdat)') : '',
            h.warnings.map(w => el('div', { class: 'phot-warn' }, w)),
        );
    }

    _saveSvg() {
        if (!this.svg) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([this.svg], { type: 'image/svg+xml' }));
        a.download = this.fileName.replace(/\.[^.]+$/, '') + '-' + this.kind + '.svg';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    _error(msg) {
        this.svg = null;
        this.stage.innerHTML = '';
        this.stage.append(el('div', { class: 'phot-error' }, msg));
    }

    _destroy() {
        clearInterval(this.watch);
        if (this.url) URL.revokeObjectURL(this.url);
    }
}

registerPlugin({
    id: 'photometry',
    name: 'Photometry (EULUMDAT, IES)',
    components: {
        photometryViewer: PhotometryComponent,
    },
    thumbnailRenderers: [{
        canHandle: file => PHOTOMETRY_NAME_RE.test(file.name),
        async render(file, container) {
            const { svg } = await diagramSvg(await readText(file), 'polar', false);
            const img = document.createElement('img');
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#fff';
            container.innerHTML = '';
            container.appendChild(img);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
