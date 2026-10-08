// --- GLDF luminaire data (.gldf, Global Lighting Data Format) ---
// Shows what a GLDF container holds: the product (name, number, manufacturer,
// description, series, its pictures and descriptive attributes), each variant
// with its mountings, emitters and pictures, each photometry drawn as eulumdat
// draws it (polar, cartesian, heatmap... diagrams, with its key figures), and
// every file in the container. Read-only; geometry (L3D, R3D) is listed, not drawn.
// gldf-rs (github.com/holg/gldf-rs) reads the container, built to WebAssembly
// outside this repo (@kreijstal/gldf-rs-wasm on jsDelivr); the LDT / IES files are
// eulumdat-rs's (src/eulumdat.js). Both are loaded when a file is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { PHOTOMETRY_DIAGRAMS, decodePhotometryText, photometryDiagramUrl, photometrySummary } = require('./eulumdat');

const log = createLogger('GLDF');
const GLDF_BASE = 'https://cdn.jsdelivr.net/npm/@kreijstal/gldf-rs-wasm@0.4.0-build.1/';
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
let _ctx = null;
let _gldfPromise = null;

function loadGldf() {
    if (!_gldfPromise) {
        _gldfPromise = import(GLDF_BASE + 'gldf_wasm.js')
            .then(async lib => {
                await lib.default({ module_or_path: GLDF_BASE + 'gldf_wasm_bg.wasm' });
                return lib;
            })
            .catch(err => { _gldfPromise = null; throw err; });
    }
    return _gldfPromise;
}

const asArray = v => v == null ? [] : Array.isArray(v) ? v : [v];

// A GLDF text: { Locale: [{ '@language', '$text' }] }, in the browser's language, else English, else the first
function localized(v) {
    if (v == null) return '';
    if (typeof v !== 'object') return String(v);
    const locales = asArray(v.Locale);
    if (!locales.length) return v.$text != null ? String(v.$text) : '';
    const lang = (navigator.language || 'en').slice(0, 2);
    const pick = locales.find(l => (l['@language'] || '').slice(0, 2) === lang) || locales.find(l => l['@language'] === 'en') || locales[0];
    return pick.$text || '';
}

// Every value of an attribute (e.g. '@emitterId') anywhere below a node
function collect(node, key, out = []) {
    if (Array.isArray(node)) node.forEach(n => collect(n, key, out));
    else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (k === key) out.push(v);
            else collect(v, key, out);
        }
    }
    return out;
}

// A nested element as [label, text] rows: 'Electrical › IngressProtectionIPCode', 'IP20'
function flatten(node, prefix = '', rows = []) {
    if (node == null || node === '') return rows;
    if (typeof node !== 'object') { rows.push([prefix, String(node)]); return rows; }
    if (Array.isArray(node)) {
        if (node.every(n => n == null || typeof n !== 'object')) rows.push([prefix, node.join(', ')]);
        else node.forEach(n => flatten(n, prefix, rows));
        return rows;
    }
    if (node.Locale) { rows.push([prefix, localized(node)]); return rows; }
    for (const [k, v] of Object.entries(node)) {
        const label = k === '$text' ? prefix : (prefix ? prefix + ' › ' : '') + k.replace(/^@/, '');
        flatten(v, label, rows);
    }
    return rows;
}

function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (k === 'style') e.style.cssText = v;
        else if (k === 'class') e.className = v;
        else e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== '') e.append(c instanceof Node ? c : String(c));
    return e;
}

function rowsTable(rows) {
    if (!rows.length) return null;
    return el('table', { class: 'gldf-kv' }, rows.map(([k, v]) => el('tr', null, el('th', null, k), el('td', null, v))));
}

function formatSize(n) {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}

class GldfComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.urls = [];
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        GldfComponent._installStyle();
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="gldf-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="gldf-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="gldf-host"><div style="padding:20px;color:#555">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.gldf-status');
        this.host = this.root.querySelector('.gldf-host');
        this.root.querySelector('.gldf-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) container.on('destroy', () => this.urls.forEach(u => URL.revokeObjectURL(u)));
        this._init();
    }

    static _installStyle() {
        if (GldfComponent._styleInstalled) return;
        GldfComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.gldf-host{flex:1;min-height:0;overflow:auto;padding:14px 18px;color:#1f2328;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45}
.gldf-host h2{font-size:20px;margin:0 0 2px}
.gldf-host h3{font-size:15px;margin:22px 0 8px;padding-bottom:4px;border-bottom:1px solid #d0d7de}
.gldf-host h4{font-size:13px;margin:0 0 6px}
.gldf-sub{color:#59636e;margin-bottom:8px}
.gldf-desc{white-space:pre-wrap;margin:6px 0;max-width:80ch}
.gldf-pics{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}
.gldf-pics figure{margin:0;max-width:260px}
.gldf-pics img{max-width:260px;max-height:200px;border:1px solid #d0d7de;border-radius:4px;background:#f6f8fa;display:block}
.gldf-pics figcaption{font-size:11px;color:#59636e}
.gldf-kv{border-collapse:collapse;margin:4px 0}
.gldf-kv th{text-align:left;font-weight:normal;color:#59636e;padding:2px 14px 2px 0;vertical-align:top}
.gldf-kv td{padding:2px 0;white-space:pre-wrap}
.gldf-card{border:1px solid #d0d7de;border-radius:6px;padding:10px 12px;margin:0 0 10px}
.gldf-chip{display:inline-block;background:#ddf4ff;color:#0969da;border-radius:10px;padding:0 8px;margin:0 4px 4px 0;font-size:12px;cursor:pointer}
.gldf-phot{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.gldf-phot img{max-width:100%;border:1px solid #d0d7de;border-radius:4px}
.gldf-phot select{font:inherit;margin-bottom:6px}
.gldf-files td,.gldf-files th{padding:1px 14px 1px 0;text-align:left}
.gldf-err{color:#a33}`;
        document.head.appendChild(style);
    }

    // The file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) throw new Error('GLDF files need the server workspace');
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        let read;
        try {
            const [lib, bytes] = await Promise.all([loadGldf(), this._readBytes()]);
            read = lib.readGldf(bytes);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not read the GLDF file: ' + err.message);
        }
        this.product = JSON.parse(read.product);
        this.entries = read.files;
        this.host.textContent = '';
        this._render();
    }

    // A file definition (GeneralDefinitions/Files/File) by id, with its bytes when it is in the container
    _file(id) {
        const def = asArray(this.product.GeneralDefinitions?.Files?.File).find(f => f['@id'] === id);
        if (!def) return null;
        const name = def.$text || '';
        if (def['@type'] === 'url') return { def, name, url: name };
        const folder = (def['@contentType'] || '').split('/')[0];
        const entry = this.entries.find(e => e.path === folder + '/' + name) || this.entries.find(e => e.path === name || e.path.endsWith('/' + name));
        return { def, name, entry };
    }

    _blobUrl(bytes, type) {
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        this.urls.push(url);
        return url;
    }

    _pictures(pictures) {
        const figs = asArray(pictures?.Image).map(img => {
            const f = this._file(img['@fileId']);
            const caption = img['@imageType'] || '';
            if (!f) return null;
            if (f.url) return el('figure', null, el('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.name), el('figcaption', null, caption + ' (not in the file)'));
            if (!f.entry) return el('figure', null, el('span', { class: 'gldf-err' }, f.name + ' is missing'));
            const type = IMAGE_TYPES[f.name.split('.').pop().toLowerCase()] || 'application/octet-stream';
            return el('figure', null, el('img', { src: this._blobUrl(f.entry.bytes, type), alt: f.name, title: f.name }), el('figcaption', null, caption));
        }).filter(Boolean);
        return figs.length ? el('div', { class: 'gldf-pics' }, figs) : null;
    }

    _render() {
        const p = this.product;
        const header = p.Header || {};
        const meta = p.ProductDefinitions?.ProductMetaData || {};
        const general = p.GeneralDefinitions || {};
        const name = localized(meta.Name) || this.fileData.name;
        const series = asArray(meta.ProductSeries?.ProductSerie).map(s => localized(s.Name)).filter(Boolean).join(', ');
        const variants = asArray(p.ProductDefinitions?.Variants?.Variant);
        const photometries = asArray(general.Photometries?.Photometry);
        this._status(`${variants.length} variant${variants.length === 1 ? '' : 's'}, ${photometries.length} photometr${photometries.length === 1 ? 'y' : 'ies'}, ${this.entries.length} files`);

        const fv = header.FormatVersion || {};
        const version = fv['@major'] != null ? `${fv['@major']}.${fv['@minor']}${fv['@pre-release'] ? '-rc.' + fv['@pre-release'] : ''}` : '';
        this.host.append(...[
            el('h2', null, name),
            el('div', { class: 'gldf-sub' }, [header.Manufacturer, localized(meta.ProductNumber), series].filter(Boolean).join(' · ')),
            this._pictures(meta.Pictures),
            localized(meta.Description) && el('div', { class: 'gldf-desc' }, localized(meta.Description)),
            localized(meta.TenderText) && el('details', null, el('summary', null, 'Tender text'), el('div', { class: 'gldf-desc' }, localized(meta.TenderText))),
            rowsTable(flatten(meta.DescriptiveAttributes)),
            rowsTable(flatten(meta.LuminaireMaintenance, 'LuminaireMaintenance')),
        ].filter(Boolean));

        if (variants.length) {
            this.host.append(el('h3', null, `Variants (${variants.length})`));
            for (const v of variants) this.host.append(this._variant(v));
        }
        if (photometries.length) {
            this.host.append(el('h3', null, `Photometry (${photometries.length})`));
            for (const ph of photometries) this.host.append(this._photometry(ph));
        }
        const lightSources = [...asArray(general.LightSources?.FixedLightSource), ...asArray(general.LightSources?.ChangeableLightSource)];
        if (lightSources.length) {
            this.host.append(el('h3', null, `Light sources (${lightSources.length})`));
            for (const ls of lightSources) {
                const { Name, Description, ...rest } = ls;
                this.host.append(el('div', { class: 'gldf-card' }, el('h4', null, [localized(Name), ls['@id']].filter(Boolean).join(' — ')), localized(Description), rowsTable(flatten(rest).filter(r => r[0] !== 'id'))));
            }
        }
        this.host.append(...[
            el('h3', null, 'GLDF'),
            rowsTable([
                ['Format version', version], ['Created with', header.CreatedWithApplication], ['Created', header.GldfCreationTimeCode],
                ['Author', header.Author], ['GLDF id', header.UniqueGldfId], ['Product id', meta.UniqueProductId],
            ].filter(r => r[1] && r[1] !== '__empty__')),
            this._files(),
        ].filter(Boolean));
    }

    _variant(v) {
        // the photometries it lights with: its emitters' photometry references
        const emitterIds = new Set(collect(v, '@emitterId'));
        const emitters = asArray(this.product.GeneralDefinitions?.Emitters?.Emitter).filter(e => emitterIds.has(e['@id']));
        const photIds = [...new Set(collect(emitters, '@photometryId'))];
        const { Name, Description, TenderText, Pictures, ProductNumber, Geometry, ...rest } = v;
        const rows = [['Product number', localized(ProductNumber)], ...flatten(rest)].filter(r => r[1] && r[0] !== 'id');
        return el('div', { class: 'gldf-card' },
            el('h4', null, localized(Name) || v['@id']),
            localized(Description) && el('div', { class: 'gldf-desc' }, localized(Description)),
            this._pictures(Pictures),
            rowsTable(rows),
            photIds.length && el('div', null, el('span', { style: 'color:#59636e;margin-right:6px' }, 'Photometry:'),
                photIds.map(id => {
                    const chip = el('span', { class: 'gldf-chip', title: 'Show this photometry' }, id);
                    chip.addEventListener('click', () => this.host.querySelector(`[data-phot="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth' }));
                    return chip;
                })),
        );
    }

    _photometry(ph) {
        const card = el('div', { class: 'gldf-card', 'data-phot': ph['@id'] });
        const f = this._file(ph.PhotometryFileReference?.['@fileId']);
        card.append(el('h4', null, ph['@id'] + (f ? ' — ' + f.name : '')));
        const descriptive = rowsTable(flatten(ph.DescriptivePhotometry));
        if (!f || f.url || !f.entry) {
            card.append(f && f.url ? el('div', null, 'Photometry file not in the container: ', el('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.url)) : el('div', { class: 'gldf-err' }, 'Photometry file missing'), descriptive || '');
            return card;
        }
        const text = decodePhotometryText(f.entry.bytes);
        const select = el('select', null, PHOTOMETRY_DIAGRAMS.map(([kind, label]) => el('option', { value: kind }, label)));
        const img = el('img', { alt: 'Photometric diagram of ' + f.name });
        const side = el('div', { style: 'min-width:220px' });
        card.append(el('div', { class: 'gldf-phot' }, el('div', null, select, el('br'), img), side));
        const draw = async () => {
            try {
                const url = await photometryDiagramUrl(text, select.value);
                this.urls.push(url);
                img.style.width = PHOTOMETRY_DIAGRAMS.find(d => d[0] === select.value)[2] + 'px';
                img.src = url;
            } catch (err) {
                log.error('Diagram failed:', err);
                img.replaceWith(el('div', { class: 'gldf-err' }, 'Could not draw the photometry: ' + err.message));
            }
        };
        select.addEventListener('change', draw);
        draw();
        photometrySummary(text).then(s => {
            const n = (v, unit, digits = 0) => Number.isFinite(v) && v ? v.toFixed(digits) + unit : '';
            side.append(rowsTable([
                ['Luminaire', s.luminaireName], ['Number', s.luminaireNumber], ['Identification', s.identification],
                ['Lamp flux', n(s.lampFlux, ' lm')], ['Wattage', n(s.wattage, ' W', 1)], ['Efficacy', n(s.luminaireEfficacy, ' lm/W', 1)],
                ['LOR', n(s.lor, ' %', 1)], ['DLOR / ULOR', s.lor ? `${s.dlor.toFixed(1)} / ${s.ulor.toFixed(1)} %` : ''],
                ['Max intensity', n(s.maxIntensity, ' cd/klm', 1)], ['Beam angle', n(s.beamAngle, '°', 1)], ['Field angle', n(s.fieldAngle, '°', 1)],
                ['CIE flux code', s.cieFluxCode],
            ].filter(r => r[1])), descriptive || '');
        }, err => side.append(el('div', { class: 'gldf-err' }, err.message)));
        return card;
    }

    _files() {
        const defs = asArray(this.product.GeneralDefinitions?.Files?.File);
        const kind = path => defs.find(d => d['@type'] !== 'url' && path.endsWith(d.$text))?.['@contentType'] || '';
        const rows = this.entries.map(e => el('tr', null, el('td', null, e.path), el('td', null, kind(e.path)), el('td', null, formatSize(e.bytes.length))));
        const remote = defs.filter(d => d['@type'] === 'url').map(d => el('tr', null, el('td', null, el('a', { href: d.$text, target: '_blank', rel: 'noopener' }, d.$text)), el('td', null, d['@contentType'] || ''), el('td', null, 'link')));
        return el('details', null, el('summary', null, `Files (${this.entries.length}${remote.length ? ` + ${remote.length} links` : ''})`),
            el('table', { class: 'gldf-files' }, rows, remote));
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this._status('', false);
        this.host.innerHTML = '<div class="gldf-err"></div>';
        this.host.firstChild.textContent = message;
    }
}

registerPlugin({
    id: 'gldf',
    name: 'GLDF luminaire data',
    components: {
        gldfViewer: GldfComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});
