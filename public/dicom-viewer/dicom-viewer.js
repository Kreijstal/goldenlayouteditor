// DICOM viewer, loaded on demand by src/dicom-plugin.js. Modelled on the
// Nextcloud dicomviewer app (github.com/ayselafsar/dicomviewer): its sidebar's
// image and searchable attribute list, and, in place of the OHIF viewer it
// embeds, a cornerstone3D stack viewport: window/level, zoom/pan, frames,
// presets, invert/rotate/flip, length and angle measurements. Like its
// DICOMJSON data source, the other DICOM files in the folder are grouped into
// series (SeriesInstanceUID) that can be opened as one stack, sorted by
// InstanceNumber, then ImagePositionPatient. Read-only.
import { loadCornerstone, loadDicomParser } from './cornerstone.js';
import { buildAttributes, filterAttributes, countRows, vrCallback, uidName, decoderFor } from './attributes.js';

const PRESETS = [
    // [label, window width, window level]: the usual CT windows (HU)
    ['CT abdomen', 400, 50],
    ['CT lung', 1500, -600],
    ['CT bone', 2500, 480],
    ['CT brain', 80, 40],
];
const ENCAPSULATED_PDF = '1.2.840.10008.5.1.4.1.1.104.1';
const DEFLATED = '1.2.840.10008.1.2.1.99';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const MAX_SERIES_FILES = 2000;
const HEADER_BYTES = 128 * 1024;

let _nextId = 1;

function installStyles() {
    if (document.getElementById('dicom-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'dicom-viewer-style';
    style.textContent = `
.dcmv{height:100%;display:flex;flex-direction:column;background:#000;color:#ddd;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0;outline:none}
.dcmv-bar{display:flex;align-items:center;gap:4px;padding:4px 6px;background:#1f2328;border-bottom:1px solid #30363d;flex-shrink:0;flex-wrap:wrap}
.dcmv-bar button,.dcmv-bar select{background:#2d333b;color:#e6edf3;border:1px solid #444c56;border-radius:4px;padding:2px 8px;font:inherit;font-size:12px;cursor:pointer;min-height:26px}
.dcmv-bar select{max-width:260px}
.dcmv-bar button.on{background:#0e639c;border-color:#1177bb;color:#fff}
.dcmv-bar button:disabled{opacity:.4;cursor:default}
.dcmv-bar .dcmv-sep{width:1px;align-self:stretch;background:#444c56;margin:0 2px}
.dcmv-bar .dcmv-grow{flex:1}
.dcmv-main{flex:1;min-height:0;display:flex}
.dcmv-stage{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}
.dcmv-view{flex:1;min-height:0;position:relative;overflow:hidden;background:#000}
.dcmv-element{position:absolute;inset:0}
.dcmv-ov{position:absolute;z-index:3;pointer-events:none;color:#e8e8e8;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;text-shadow:0 0 3px #000,0 0 2px #000;white-space:pre;max-width:48%;overflow:hidden;text-overflow:ellipsis}
.dcmv-ov.tl{top:6px;left:8px}.dcmv-ov.tr{top:6px;right:8px;text-align:right}
.dcmv-ov.bl{bottom:6px;left:8px}.dcmv-ov.br{bottom:6px;right:8px;text-align:right}
.dcmv-msg{position:absolute;inset:0;z-index:4;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#ccc;background:#111}
.dcmv-msg div{max-width:560px;white-space:pre-wrap}
.dcmv-msg.err div{color:#ffb4ab}
.dcmv-msg button{margin-top:12px;background:#0e639c;color:#fff;border:1px solid #1177bb;border-radius:4px;padding:4px 12px;font:inherit;cursor:pointer}
.dcmv-frames{display:flex;align-items:center;gap:6px;padding:3px 8px;background:#1f2328;border-top:1px solid #30363d;flex-shrink:0;font-size:12px}
.dcmv-frames input[type=range]{flex:1;min-width:60px}
.dcmv-frames button{background:#2d333b;color:#e6edf3;border:1px solid #444c56;border-radius:4px;padding:1px 8px;font:inherit;cursor:pointer}
.dcmv-frames .dcmv-fno{font-variant-numeric:tabular-nums;white-space:nowrap}
.dcmv-side{width:420px;max-width:50%;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid #30363d;background:#fff;color:#222;min-height:0}
.dcmv-side[hidden]{display:none}
.dcmv-side-head{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #ddd;flex-shrink:0;flex-wrap:wrap}
.dcmv-side-head input{flex:1;min-width:120px;font:inherit;padding:3px 6px;border:1px solid #ccc;border-radius:4px}
.dcmv-side-head .dcmv-count{font-size:11px;color:#666;white-space:nowrap}
.dcmv-side-file{font-size:11px;color:#666;padding:2px 8px;border-bottom:1px solid #eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
.dcmv-note{padding:6px 8px;background:#fff8c5;border-bottom:1px solid #d4a72c;color:#6f4e00;font-size:12px;flex-shrink:0}
.dcmv-note button{margin-left:6px;font:inherit;font-size:12px;padding:1px 8px;cursor:pointer}
.dcmv-tree{flex:1;min-height:0;overflow:auto;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.dcmv-row{display:grid;grid-template-columns:86px 26px minmax(90px,38%) minmax(0,1fr);gap:0 6px;padding:1px 8px;border-bottom:1px solid #f2f2f2;align-items:baseline}
.dcmv-row:hover{background:#f6f8fa}
.dcmv-row .t{color:#57606a;white-space:nowrap}
.dcmv-row .v{color:#8250df}
.dcmv-row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#0550ae}
.dcmv-row .n.priv{color:#9a6700}
.dcmv-row .val{word-break:break-word;white-space:pre-wrap;color:#24292f}
.dcmv-row .val i{color:#6e7781}
.dcmv-row.sq{cursor:pointer}
.dcmv-row.sq .t::before{content:'▸ ';color:#888}
.dcmv-row.sq.open .t::before{content:'▾ '}
.dcmv-item{padding:1px 8px;color:#6e7781;font-style:italic;border-bottom:1px solid #f2f2f2}
.dcmv-row mark,.dcmv-item mark{background:#fff3a3;color:inherit}
.dcmv-more{padding:8px;color:#666;font-style:italic}
@media (max-width:700px){
 .dcmv-main{flex-direction:column}
 .dcmv-side{width:auto;max-width:none;height:45%;border-left:none;border-top:1px solid #30363d}
 .dcmv-row{grid-template-columns:78px 24px minmax(0,1fr);}
 .dcmv-row .val{grid-column:1 / -1;padding-left:12px}
}`;
    document.head.appendChild(style);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function button(label, title, onClick) {
    const b = el('button', null, label);
    b.type = 'button';
    if (title) b.title = title;
    b.onclick = onClick;
    return b;
}

function str(ds, tag) {
    if (!ds || !ds.elements[tag]) return '';
    try { return (ds.string(tag) || '').trim(); } catch (_) { return ''; }
}

function num(ds, tag, i = 0) {
    const s = str(ds, tag);
    if (!s) return null;
    const v = parseFloat(s.split('\\')[i]);
    return Number.isFinite(v) ? v : null;
}

function nums(ds, tag) {
    const s = str(ds, tag);
    if (!s) return null;
    const v = s.split('\\').map(parseFloat);
    return v.every(Number.isFinite) ? v : null;
}

function fmtDate(s) {
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s;
}

function fmtTime(s) {
    return /^\d{4}/.test(s) ? `${s.slice(0, 2)}:${s.slice(2, 4)}${s.length >= 6 ? ':' + s.slice(4, 6) : ''}` : s;
}

function fmtPN(s) {
    return s.split('=')[0].split('^').filter(Boolean).join(' ');
}

function hasPreamble(bytes) {
    return bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

// --- Parsing ---

// dicom-parser throws { exception, dataSet } with what it read so far
function parse(dicomParser, bytes, options = {}) {
    const attempt = (opts) => {
        try {
            return { dataSet: dicomParser.parseDicom(bytes, { vrCallback, ...opts }) };
        } catch (err) {
            const message = err && err.exception ? String(err.exception) : (err && err.message) || String(err);
            return { dataSet: (err && err.dataSet) || null, error: message.replace(/^dicomParser\.\w+:\s*/, '') };
        }
    };
    const result = attempt(options);
    if (!result.error || !/DICM prefix not found/.test(result.error) || hasPreamble(bytes)) return result;
    // No preamble and file meta (old ACR-NEMA style or a bare data set): explicit VR if the first
    // element has a VR, else implicit VR little endian
    const explicit = bytes.length > 6 && /^[A-Z]{2}$/.test(String.fromCharCode(bytes[4], bytes[5]));
    const bare = attempt({ ...options, TransferSyntaxUID: explicit ? EXPLICIT_LE : '1.2.840.10008.1.2' });
    if (bare.dataSet && Object.keys(bare.dataSet.elements).length) {
        bare.noMeta = true;
        return bare;
    }
    return result;
}

async function inflateAll(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The browser's inflater rejects bytes after the end of the deflate stream, and deflated data sets
// often have some (padding to an even length and more): retry without the last few bytes
async function inflateRaw(bytes) {
    for (let trim = 0; ; trim++) {
        try {
            return await inflateAll(bytes.subarray(0, bytes.length - trim));
        } catch (err) {
            if (trim >= 32 || trim >= bytes.length - 1) throw err;
        }
    }
}

// Where the file meta group (0002) ends and the data set starts
function metaEnd(dicomParser, bytes) {
    const meta = dicomParser.readPart10Header(bytes);
    let end = 0;
    for (const key in meta.elements) {
        const e = meta.elements[key];
        end = Math.max(end, e.dataOffset + e.length);
    }
    return { meta, end };
}

// Overwrites a value in place, padded to its length (UIDs with NUL, other strings with spaces)
function writeAscii(bytes, offset, length, text, pad) {
    for (let i = 0; i < length; i++) bytes[offset + i] = i < text.length ? text.charCodeAt(i) : pad;
}

// Reads a file into { bytes (as cornerstone gets them), dataSet (for the dump and the overlay),
// error, transferSyntax (the file's), noMeta }. A deflated data set is inflated (and labelled
// explicit VR little endian), then normalizePixels does what else cornerstone can't.
async function readDicom(dicomParser, original) {
    let bytes = original;
    let transferSyntax = '';
    let meta = null;
    let end = 0;
    try {
        ({ meta, end } = metaEnd(dicomParser, original));
        transferSyntax = (meta.string('x00020010') || '').replace(/\0/g, '').trim();
    } catch (_) {
        // no file meta: parse() tries it as a bare data set
    }
    if (transferSyntax === DEFLATED) {
        let inflated;
        try {
            inflated = await inflateRaw(original.subarray(end));
        } catch (err) {
            return { bytes, dataSet: meta, error: 'the deflated data set could not be inflated (' + err.message + ')', transferSyntax };
        }
        bytes = new Uint8Array(end + inflated.length);
        bytes.set(original.subarray(0, end));
        bytes.set(inflated, end);
        const ts = meta.elements.x00020010;
        writeAscii(bytes, ts.dataOffset, ts.length, EXPLICIT_LE, 0);
    }
    // The dump shows the inflated data set too (its transfer syntax row says what the file says)
    const parsed = parse(dicomParser, bytes);
    const ds = parsed.dataSet;
    if (ds && parsed.noMeta) delete ds.elements.x00020010; // dicom-parser's stand-in, not in the file
    const image = ds && !parsed.error ? normalizePixels(ds, bytes) : null;
    return { bytes: image || bytes, dataSet: ds, error: parsed.error, transferSyntax, noMeta: !!parsed.noMeta };
}

// A copy of the file with the (native, last) pixel data replaced: its 32-bit length precedes its
// value in explicit and implicit VR little endian alike
function replacePixelData(ds, bytes, pixels) {
    const px = ds.elements.x7fe00010;
    const pad = pixels.length % 2;
    const tail = bytes.subarray(px.dataOffset + px.length);
    const out = new Uint8Array(px.dataOffset + pixels.length + pad + tail.length);
    out.set(bytes.subarray(0, px.dataOffset));
    out.set(pixels, px.dataOffset);
    out.set(tail, px.dataOffset + pixels.length + pad);
    new DataView(out.buffer).setUint32(px.dataOffset - 4, pixels.length + pad, true);
    return out;
}

function nativeLittleEndian(ds) {
    const px = ds.elements.x7fe00010;
    const ts = str(ds, 'x00020010').replace(/\0/g, '');
    return px && !px.fragments && !px.encapsulatedPixelData && ts !== '1.2.840.10008.1.2.2';
}

// What cornerstone's loader doesn't handle itself, done on a copy of the file:
//  - uncompressed YBR_FULL_422 (two lumas share a chroma pair): upsampled to YBR_FULL;
//  - 1-bit pixels (segmentations, overlays-as-images): unpacked to one byte per pixel.
function normalizePixels(ds, bytes) {
    if (!nativeLittleEndian(ds)) return null;
    const px = ds.elements.x7fe00010;
    const src = bytes.subarray(px.dataOffset, px.dataOffset + px.length);
    const bitsAllocated = ds.uint16('x00280100');
    if (str(ds, 'x00280004') === 'YBR_FULL_422' && bitsAllocated === 8 && ds.uint16('x00280011') % 2 === 0) {
        const pairs = Math.floor(src.length / 4);
        const pixels = new Uint8Array(pairs * 6);
        for (let i = 0, o = 0; i < pairs; i++) {
            const y0 = src[4 * i], y1 = src[4 * i + 1], cb = src[4 * i + 2], cr = src[4 * i + 3];
            pixels[o++] = y0; pixels[o++] = cb; pixels[o++] = cr;
            pixels[o++] = y1; pixels[o++] = cb; pixels[o++] = cr;
        }
        const out = replacePixelData(ds, bytes, pixels);
        const pi = ds.elements.x00280004;
        writeAscii(out, pi.dataOffset, pi.length, 'YBR_FULL', 0x20);
        return out;
    }
    if (bitsAllocated === 1 && (ds.uint16('x00280002') || 1) === 1) {
        const count = ds.uint16('x00280010') * ds.uint16('x00280011') * frameCount(ds);
        const pixels = new Uint8Array(count);
        for (let i = 0; i < count && (i >> 3) < src.length; i++) pixels[i] = (src[i >> 3] >> (i & 7)) & 1;
        const out = replacePixelData(ds, bytes, pixels);
        const view = new DataView(out.buffer);
        // BitsAllocated, BitsStored, HighBit (US, little endian, all before the pixel data)
        for (const [tag, value] of [['x00280100', 8], ['x00280101', 8], ['x00280102', 7]]) {
            const e = ds.elements[tag];
            if (e && e.length === 2) view.setUint16(e.dataOffset, value, true);
        }
        return out;
    }
    return null;
}

// Native pixel data shorter than rows × columns × samples × frames needs: what is missing, or null
function missingPixels(ds) {
    const px = ds.elements.x7fe00010;
    if (!px || px.fragments || px.encapsulatedPixelData) return null;
    const bits = ds.uint16('x00280010') * ds.uint16('x00280011') * (ds.uint16('x00280002') || 1)
        * (ds.uint16('x00280100') || 8) * frameCount(ds);
    // YBR_FULL_422 stores two lumas per chroma pair: 2 samples per pixel, not 3
    const expected = Math.ceil(bits / 8 * (str(ds, 'x00280004') === 'YBR_FULL_422' ? 2 / 3 : 1));
    const present = Math.max(0, Math.min(px.length, ds.byteArray.length - px.dataOffset));
    return present < expected ? `the image data has ${present} of its ${expected} bytes` : null;
}

function hasPixels(ds) {
    return !!(ds && (ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009));
}

function frameCount(ds) {
    return Math.max(1, Math.round(num(ds, 'x00280008') || 1));
}

// --- Viewer ---

class DicomViewer {
    constructor(host, opts) {
        installStyles();
        this.opts = opts;
        this.id = 'dcmv' + (_nextId++);
        this.files = new Map();   // file name -> { bytes, dataSet, indexes: [fileManager index] }
        this.imageInfo = new Map(); // imageId -> { file, frame, frames }
        this.tool = 'WindowLevel';
        this.destroyed = false;
        this.info = { name: opts.name };

        this.root = el('div', 'dcmv');
        this.root.tabIndex = 0;
        this.bar = el('div', 'dcmv-bar');
        this.main = el('div', 'dcmv-main');
        this.stage = el('div', 'dcmv-stage');
        this.view = el('div', 'dcmv-view');
        this.element = el('div', 'dcmv-element');
        this.element.oncontextmenu = (e) => e.preventDefault();
        this.overlays = {};
        for (const pos of ['tl', 'tr', 'bl', 'br']) this.overlays[pos] = el('div', 'dcmv-ov ' + pos);
        this.view.append(this.element, ...Object.values(this.overlays));
        this.frames = el('div', 'dcmv-frames');
        this.frames.hidden = true;
        this.stage.append(this.view, this.frames);
        this.side = el('div', 'dcmv-side');
        this.main.append(this.stage, this.side);
        this.root.append(this.bar, this.main);
        host.appendChild(this.root);

        this._buildSide();
        this.root.addEventListener('keydown', (e) => this._onKey(e));
        this.resizeObserver = new ResizeObserver(() => this._resize());
        this.resizeObserver.observe(this.view);
    }

    async load() {
        const dicomParser = await loadDicomParser();
        this.dicomParser = dicomParser;
        const read = await readDicom(dicomParser, this.opts.bytes);
        const ds = read.dataSet;
        this.dataSet = ds;
        this.file = { name: this.opts.name, ...read };
        this.files.set(this.opts.name, this.file);
        const sop = str(ds, 'x00080016') || str(ds, 'x00020002');
        Object.assign(this.info, {
            sopClass: sop, sopClassName: uidName(sop), transferSyntax: read.transferSyntax || str(ds, 'x00020010'),
            modality: str(ds, 'x00080060'), frames: frameCount(ds), isImage: hasPixels(ds), error: read.error || null,
            rows: ds ? ds.uint16('x00280010') : 0, columns: ds ? ds.uint16('x00280011') : 0,
        });
        this._showAttributes(this.file);
        if (!ds || Object.keys(ds.elements).length === 0) {
            this._message(`This file could not be read as DICOM: it is not a DICOM file, or it is damaged (${read.error || 'no data elements'}).`, true);
            this.info.isImage = false;
            return this;
        }
        if (read.noMeta) this._note('No DICOM file meta header (no DICM preamble): read as a bare data set.');
        if (read.error) {
            this._note(`The file is truncated or damaged (${read.error}); the attributes up to that point are shown.`);
        }
        // An image without its pixel data, or with too little of it: cut short
        const imageLike = ds.elements.x00280010 || / Image Storage/.test(this.info.sopClassName);
        const short = this.info.isImage ? missingPixels(ds)
            : imageLike ? (read.error || `the file ends after ${ds.byteArray.length} bytes, before the image data`) : null;
        if (!short && !this.info.isImage) {
            this._showNonImage(ds);
            return this;
        }
        if (short) {
            this._buildToolbar(true);
            this._message(`The file is truncated or damaged: ${short}`, true);
            this.info.error = 'truncated: ' + short;
            return this;
        }
        this._message('Loading the viewer…');
        try {
            this.cs = await loadCornerstone();
        } catch (err) {
            this._message('Could not load the DICOM viewer libraries: ' + err.message, true);
            this.info.error = err.message;
            return this;
        }
        if (this.destroyed) return this;
        this._buildToolbar();
        this._setupViewport();
        const imageIds = this._addFile(this.file);
        await this._showStack(imageIds, 0);
        this._scanSeries();
        return this;
    }

    // --- Attributes panel ---

    _buildSide() {
        const head = el('div', 'dcmv-side-head');
        this.search = el('input');
        this.search.type = 'search';
        this.search.placeholder = 'Search attributes (tag, name, value)…';
        let timer = null;
        this.search.oninput = () => {
            clearTimeout(timer);
            timer = setTimeout(() => this._renderTree(), 200);
        };
        this.countEl = el('span', 'dcmv-count');
        head.append(this.search, this.countEl);
        this.sideFile = el('div', 'dcmv-side-file');
        this.noteHost = el('div');
        this.tree = el('div', 'dcmv-tree');
        this.side.append(head, this.sideFile, this.noteHost, this.tree);
        if (window.innerWidth < 700) this.side.hidden = true;
    }

    _showAttributes(file) {
        if (this.shownFile === file) return;
        this.shownFile = file;
        if (!file.rows) {
            file.rows = file.dataSet ? buildAttributes(file.dataSet) : [];
            const ts = file.rows.find(r => r.key === '00020010');
            if (ts && file.transferSyntax === DEFLATED) {
                ts.value = DEFLATED;
                ts.uidName = uidName(DEFLATED);
            }
        }
        this.sideFile.textContent = file.name;
        this.sideFile.title = file.name;
        this._renderTree();
    }

    _renderTree() {
        const all = (this.shownFile && this.shownFile.rows) || [];
        const query = this.search.value.trim();
        const rows = filterAttributes(all, query);
        this.tree.textContent = '';
        const total = countRows(all);
        this.countEl.textContent = query ? `${countRows(rows)} of ${total}` : `${total} attributes`;
        const budget = { left: query ? 3000 : 6000 };
        const re = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig') : null;
        this._renderRows(this.tree, rows, 0, !!query, re, budget);
        if (budget.left <= 0) this.tree.appendChild(el('div', 'dcmv-more', 'More rows not shown; narrow the search.'));
        if (!rows.length) this.tree.appendChild(el('div', 'dcmv-more', all.length ? 'No matching attributes.' : 'No DICOM attributes found.'));
    }

    _renderRows(parent, rows, depth, expand, re, budget) {
        for (const r of rows) {
            if (budget.left-- <= 0) return;
            const row = el('div', 'dcmv-row');
            row.style.paddingLeft = (8 + depth * 14) + 'px';
            const t = el('span', 't', r.tag);
            const v = el('span', 'v', r.vr);
            const n = el('span', 'n' + (r.name.startsWith('Private') ? ' priv' : ''), r.name);
            n.title = r.name;
            const val = el('span', 'val');
            if (r.value) val.appendChild(document.createTextNode(r.value));
            if (r.uidName) val.appendChild(el('i', null, ` [${r.uidName}]`));
            if (r.items && !r.value) val.appendChild(el('i', null, 'empty sequence'));
            if (re) for (const span of [t, n, val]) highlight(span, re);
            row.append(t, v, n, val);
            parent.appendChild(row);
            if (r.items && r.items.length) {
                row.classList.add('sq');
                const box = el('div');
                let rendered = false;
                const open = (on) => {
                    row.classList.toggle('open', on);
                    box.hidden = !on;
                    if (on && !rendered) {
                        rendered = true;
                        for (const item of r.items) {
                            const head = el('div', 'dcmv-item', item.name);
                            head.style.paddingLeft = (8 + (depth + 1) * 14) + 'px';
                            box.appendChild(head);
                            this._renderRows(box, item.rows, depth + 2, expand, re, budget);
                        }
                    }
                };
                row.onclick = () => open(box.hidden);
                box.hidden = true;
                parent.appendChild(box);
                if (expand || r.partial) open(true);
            }
        }
    }

    _note(text, action) {
        const note = el('div', 'dcmv-note', text);
        if (action) note.appendChild(button(action.label, null, action.onClick));
        this.noteHost.appendChild(note);
    }

    // --- Messages and non-image objects ---

    _message(text, isError, action) {
        if (this.msg) this.msg.remove();
        this.msg = null;
        if (text == null) return;
        this.msg = el('div', 'dcmv-msg' + (isError ? ' err' : ''));
        const box = el('div', null, text);
        if (action) {
            box.appendChild(el('br'));
            box.appendChild(button(action.label, null, action.onClick));
        }
        this.msg.appendChild(box);
        this.view.appendChild(this.msg);
    }

    _showNonImage(ds) {
        const sop = this.info.sopClass;
        const kind = this.info.sopClassName || (sop ? `SOP class ${sop}` : 'DICOM object');
        let text = `${kind}: this object holds no image. Its attributes are listed`
            + (this.side.hidden ? ' in the attributes panel.' : ' beside this.');
        let action = null;
        const doc = ds.elements.x00420011;
        if (sop === ENCAPSULATED_PDF || (doc && /pdf/i.test(str(ds, 'x00420012')))) {
            text = `${kind}: the document is a PDF (${doc ? doc.length : 0} bytes).`;
            if (doc && this.opts.openPdf) {
                action = {
                    label: 'Open the PDF',
                    onClick: () => {
                        const pdf = ds.byteArray.slice(doc.dataOffset, doc.dataOffset + doc.length);
                        const title = str(ds, 'x00420010') || this.opts.name.replace(/\.(dcm|dicom)$/i, '');
                        this.opts.openPdf(pdf, title.replace(/[\\/:*?"<>|]+/g, '_') + '.pdf');
                    },
                };
            }
        }
        this._message(text, false, action);
        this._note(`${kind}: no pixel data.`);
        this._buildToolbar(true);
    }

    // --- Toolbar ---

    _buildToolbar(attributesOnly) {
        this.bar.textContent = '';
        const toggleSide = button('Attributes', 'Show or hide the attribute list', () => {
            this.side.hidden = !this.side.hidden;
            toggleSide.classList.toggle('on', !this.side.hidden);
            this._resize();
        });
        toggleSide.classList.toggle('on', !this.side.hidden);
        if (attributesOnly) {
            this.bar.append(el('span', 'dcmv-grow'), toggleSide);
            return;
        }
        const tools = [
            ['WindowLevel', 'W/L', 'Window/level: drag (right drag zooms, middle drag pans, wheel scrolls frames)'],
            ['Pan', 'Pan', 'Pan: drag'],
            ['Zoom', 'Zoom', 'Zoom: drag up/down'],
            ['Length', 'Length', 'Measure a distance: drag (or click, click)'],
            ['Angle', 'Angle', 'Measure an angle: three clicks'],
        ];
        this.toolButtons = {};
        for (const [name, label, title] of tools) {
            const b = button(label, title, () => this._setTool(name));
            this.toolButtons[name] = b;
            this.bar.appendChild(b);
        }
        this.bar.appendChild(el('span', 'dcmv-sep'));
        this.presetSelect = el('select');
        this.presetSelect.title = 'Window presets';
        const addOption = (value, label) => {
            const o = el('option', null, label);
            o.value = value;
            this.presetSelect.appendChild(o);
        };
        addOption('', 'W/L preset…');
        addOption('default', 'Default (from file)');
        addOption('full', 'Full range');
        PRESETS.forEach(([label, w, l], i) => addOption(String(i), `${label} (${w}/${l})`));
        this.presetSelect.onchange = () => {
            this._applyPreset(this.presetSelect.value);
            this.presetSelect.value = '';
            this.root.focus();
        };
        this.invertBtn = button('Invert', 'Invert the grey scale (I)', () => this._invert());
        this.bar.append(this.presetSelect, this.invertBtn,
            button('↺', 'Rotate left 90°', () => this._rotate(-90)),
            button('↻', 'Rotate right 90° (R)', () => this._rotate(90)),
            button('⇆', 'Flip horizontally (H)', () => this._flip('flipHorizontal')),
            button('⇅', 'Flip vertically (V)', () => this._flip('flipVertical')),
            button('Reset', 'Reset window, zoom, rotation and flips (Esc)', () => this._reset()),
            button('Clear', 'Remove the measurements', () => this._clearMeasurements()));
        this.seriesSelect = el('select');
        this.seriesSelect.hidden = true;
        this.seriesSelect.title = 'Series in this folder';
        this.seriesSelect.onchange = () => this._openSeries(this.seriesSelect.value);
        this.bar.append(el('span', 'dcmv-sep'), this.seriesSelect, el('span', 'dcmv-grow'), toggleSide);
        this._setToolButtons();
    }

    _setToolButtons() {
        for (const [name, b] of Object.entries(this.toolButtons || {})) b.classList.toggle('on', name === this.tool);
    }

    // --- cornerstone ---

    _setupViewport() {
        const { core, tools } = this.cs;
        this._message(null);
        this.engine = new core.RenderingEngine(this.id + '-engine');
        this.viewportId = this.id + '-vp';
        this.engine.enableElement({
            viewportId: this.viewportId,
            type: core.Enums.ViewportType.STACK,
            element: this.element,
            defaultOptions: { background: [0, 0, 0] },
        });
        this.viewport = this.engine.getViewport(this.viewportId);
        const group = tools.ToolGroupManager.createToolGroup(this.id + '-tools');
        this.toolGroup = group;
        for (const name of ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle']) group.addTool(name);
        group.addViewport(this.viewportId, this.engine.id);
        const { MouseBindings } = tools.Enums;
        group.setToolActive('StackScroll', { bindings: [{ mouseButton: MouseBindings.Wheel }] });
        this._setTool('WindowLevel');

        const E = core.Enums.Events;
        this.element.addEventListener(E.IMAGE_RENDERED, () => this._updateOverlay());
        this.element.addEventListener(E.STACK_NEW_IMAGE, () => this._onNewImage());
    }

    _setTool(name) {
        if (!this.toolGroup) return;
        const { MouseBindings } = this.cs.tools.Enums;
        const group = this.toolGroup;
        this.tool = name;
        // Middle drag pans and right drag zooms whatever the left button does
        const extra = { Pan: MouseBindings.Auxiliary, Zoom: MouseBindings.Secondary };
        for (const t of ['WindowLevel', 'Pan', 'Zoom', 'Length', 'Angle']) {
            const bindings = [];
            if (t === name) bindings.push({ mouseButton: MouseBindings.Primary });
            if (extra[t]) bindings.push({ mouseButton: extra[t] });
            if (bindings.length) group.setToolActive(t, { bindings });
            else if (t === 'Length' || t === 'Angle') group.setToolPassive(t);
            else group.setToolDisabled(t);
        }
        this._setToolButtons();
    }

    // Registers a file's frames with the image loader: its imageIds
    _addFile(file) {
        if (file.imageIds) return file.imageIds;
        const { loader } = this.cs;
        const base = loader.wadouri.fileManager.add(new Blob([file.bytes]));
        file.fileIndex = parseInt(base.split(':')[1], 10);
        const frames = frameCount(file.dataSet);
        file.imageIds = frames > 1 ? Array.from({ length: frames }, (_, i) => `${base}?frame=${i + 1}`) : [base];
        file.imageIds.forEach((id, i) => this.imageInfo.set(id, { file, frame: i + 1, frames }));
        return file.imageIds;
    }

    async _showStack(imageIds, index) {
        const { core } = this.cs;
        this.imageIds = imageIds;
        this._message(null);
        try {
            // Load the first image here: a decode error then shows as a message, not a blank view
            await core.imageLoader.loadAndCacheImage(imageIds[index]);
            if (this.destroyed) return;
            await this.viewport.setStack(imageIds, index);
            this.viewport.render();
        } catch (err) {
            if (this.destroyed) return;
            const msg = (err && (err.message || err.error && err.error.message)) || String(err);
            const ts = this.info.transferSyntax;
            this._message(`Could not decode the image${ts ? ` (${uidName(ts) || ts})` : ''}:\n${msg}`, true);
            this.info.error = msg;
            return;
        }
        this.info.rendered = true;
        this._setupFrames();
        this._onNewImage();
        this.root.focus({ preventScroll: true });
    }

    _setupFrames() {
        const n = this.imageIds.length;
        this.frames.textContent = '';
        this.frames.hidden = n < 2;
        this._stopCine();
        if (n < 2) return;
        this.playBtn = button('▶', 'Play / pause (Space)', () => (this.cine ? this._stopCine() : this._startCine()));
        this.slider = el('input');
        this.slider.type = 'range';
        this.slider.min = '0';
        this.slider.max = String(n - 1);
        this.slider.value = String(this.viewport.getCurrentImageIdIndex());
        this.slider.oninput = () => this._goTo(+this.slider.value);
        this.frameNo = el('span', 'dcmv-fno');
        this.frames.append(this.playBtn, button('◀', 'Previous (↑)', () => this._step(-1)), this.slider,
            button('▶|', 'Next (↓)', () => this._step(1)), this.frameNo);
        this._resize();
    }

    _goTo(i) {
        if (!this.viewport || !this.imageIds) return;
        i = Math.max(0, Math.min(this.imageIds.length - 1, i));
        this.viewport.setImageIdIndex(i).catch(err => this._message('Could not decode the image: ' + err.message, true));
    }

    _step(d, loop) {
        if (!this.viewport || !this.imageIds) return;
        const n = this.imageIds.length;
        let i = this.viewport.getCurrentImageIdIndex() + d;
        if (loop) i = (i + n) % n;
        this._goTo(i);
    }

    _startCine() {
        const ds = this.dataSet;
        const frameTime = num(ds, 'x00181063');
        const fps = Math.max(1, Math.min(60, num(ds, 'x00082144') || (frameTime ? 1000 / frameTime : 10)));
        this.cine = setInterval(() => this._step(1, true), 1000 / fps);
        if (this.playBtn) this.playBtn.textContent = '❚❚';
    }

    _stopCine() {
        if (this.cine) clearInterval(this.cine);
        this.cine = null;
        if (this.playBtn) this.playBtn.textContent = '▶';
    }

    _onNewImage() {
        if (!this.viewport) return;
        const i = this.viewport.getCurrentImageIdIndex();
        const n = this.imageIds.length;
        if (this.slider) this.slider.value = String(i);
        const info = this.imageInfo.get(this.imageIds[i]);
        if (this.frameNo) {
            this.frameNo.textContent = `${i + 1} / ${n}`;
        }
        if (info && info.file !== this.shownFile && !this.side.hidden) {
            clearTimeout(this._dumpTimer);
            this._dumpTimer = setTimeout(() => this._showAttributes(info.file), 150);
        }
        this.info.index = i;
        this._updateOverlay();
    }

    _updateOverlay() {
        if (!this.viewport || !this.imageIds) return;
        const i = this.viewport.getCurrentImageIdIndex();
        const info = this.imageInfo.get(this.imageIds[i]);
        if (!info) return;
        const ds = info.file.dataSet;
        const lines = (...xs) => xs.filter(Boolean).join('\n');
        const sexAge = [str(ds, 'x00100040'), str(ds, 'x00101010')].filter(Boolean).join(' ');
        this.overlays.tl.textContent = lines(
            fmtPN(str(ds, 'x00100010')),
            str(ds, 'x00100020') && 'ID ' + str(ds, 'x00100020'),
            [fmtDate(str(ds, 'x00100030')), sexAge].filter(Boolean).join(' · '),
        );
        const series = [str(ds, 'x00200011') && 'Se ' + str(ds, 'x00200011'), str(ds, 'x0008103e')].filter(Boolean).join(' ');
        this.overlays.tr.textContent = lines(
            str(ds, 'x00081030'),
            [fmtDate(str(ds, 'x00080020')), fmtTime(str(ds, 'x00080030'))].filter(Boolean).join(' '),
            series,
            [str(ds, 'x00080060'), str(ds, 'x00200013') && 'Im ' + str(ds, 'x00200013')].filter(Boolean).join(' '),
            str(ds, 'x00080080'),
        );
        const n = this.imageIds.length;
        const rows = ds.uint16('x00280010'), cols = ds.uint16('x00280011');
        const pos = [];
        if (this.series) pos.push(`Image ${i + 1}/${n}`);
        if (info.frames > 1) pos.push(`Frame ${info.frame}/${info.frames}`);
        const loc = num(ds, 'x00201041');
        const thick = num(ds, 'x00180050');
        this.overlays.bl.textContent = lines(
            pos.join(' · '),
            `${cols} × ${rows}` + (str(ds, 'x00280004') ? ' ' + str(ds, 'x00280004') : ''),
            [loc != null && `Loc ${loc.toFixed(2)} mm`, thick != null && `Thick ${thick} mm`].filter(Boolean).join(' '),
            uidName(info.file.transferSyntax) || info.file.transferSyntax,
        );
        let wl = '';
        try {
            const { voiRange, invert } = this.viewport.getProperties();
            if (voiRange && Number.isFinite(voiRange.upper)) {
                const { windowWidth: w, windowCenter: l } = this.cs.core.utilities.windowLevel.toWindowLevel(voiRange.lower, voiRange.upper);
                const r = (x) => (Math.abs(x) >= 100 ? Math.round(x) : +x.toFixed(2));
                wl = `W ${r(w)} L ${r(l)}` + (invert ? ' · inverted' : '');
                this.info.window = { width: w, level: l, invert: !!invert };
            }
            if (this.invertBtn) this.invertBtn.classList.toggle('on', !!invert);
        } catch (_) { /* no image yet */ }
        let view = '';
        try {
            const zoom = this.viewport.getZoom();
            const pres = this.viewport.getViewPresentation();
            view = `Zoom ${Math.round(zoom * 100)}%`;
            if (pres.rotation) view += ` · Rot ${Math.round(pres.rotation)}°`;
            if (pres.flipHorizontal) view += ' · Flip H';
            if (pres.flipVertical) view += ' · Flip V';
            this.info.zoom = zoom;
            this.info.rotation = pres.rotation || 0;
        } catch (_) { /* no camera yet */ }
        this.overlays.br.textContent = lines(wl, view);
    }

    _applyPreset(value) {
        if (!value || !this.viewport) return;
        if (value === 'default') {
            this.viewport.resetProperties();
        } else if (value === 'full') {
            const image = this.viewport.csImage;
            if (!image) return;
            const lo = image.minPixelValue, hi = image.maxPixelValue;
            this.viewport.setProperties({ voiRange: { lower: lo, upper: hi > lo ? hi : lo + 1 } });
        } else {
            const [, w, l] = PRESETS[+value];
            this.viewport.setProperties({ voiRange: this.cs.core.utilities.windowLevel.toLowHighRange(w, l) });
        }
        this.viewport.render();
    }

    _invert() {
        if (!this.viewport) return;
        const { invert } = this.viewport.getProperties();
        this.viewport.setProperties({ invert: !invert });
        this.viewport.render();
    }

    _rotate(deg) {
        if (!this.viewport) return;
        const pres = this.viewport.getViewPresentation();
        this.viewport.setViewPresentation({ rotation: (((pres.rotation || 0) + deg) % 360 + 360) % 360 });
        this.viewport.render();
    }

    _flip(which) {
        if (!this.viewport) return;
        const pres = this.viewport.getViewPresentation();
        this.viewport.setViewPresentation({ [which]: !pres[which] });
        this.viewport.render();
    }

    _reset() {
        if (!this.viewport) return;
        this.viewport.resetProperties();
        this.viewport.setViewPresentation({ rotation: 0, flipHorizontal: false, flipVertical: false });
        this.viewport.resetCamera();
        this.viewport.render();
    }

    _clearMeasurements() {
        if (!this.cs) return;
        const { annotation } = this.cs.tools;
        try {
            for (const a of annotation.state.getAllAnnotations()) {
                if (this.element && a.metadata && (a.metadata.toolName === 'Length' || a.metadata.toolName === 'Angle')) {
                    annotation.state.removeAnnotation(a.annotationUID);
                }
            }
        } catch (_) { /* nothing to clear */ }
        if (this.viewport) this.viewport.render();
    }

    _onKey(e) {
        if (e.target !== this.root || !this.viewport) return;
        const k = e.key;
        if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') this._step(k === 'PageUp' ? -10 : -1);
        else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') this._step(k === 'PageDown' ? 10 : 1);
        else if (k === 'Home') this._goTo(0);
        else if (k === 'End') this._goTo(Infinity);
        else if (k === ' ') { if (this.imageIds.length > 1) (this.cine ? this._stopCine() : this._startCine()); }
        else if (k === 'i' || k === 'I') this._invert();
        else if (k === 'r' || k === 'R') this._rotate(90);
        else if (k === 'h' || k === 'H') this._flip('flipHorizontal');
        else if (k === 'v' || k === 'V') this._flip('flipVertical');
        else if (k === 'Escape') this._reset();
        else return;
        e.preventDefault();
    }

    _resize() {
        if (!this.engine || this.destroyed) return;
        cancelAnimationFrame(this._resizeFrame);
        this._resizeFrame = requestAnimationFrame(() => {
            if (this.destroyed) return;
            try { this.engine.resize(true, true); } catch (_) { /* element gone */ }
        });
    }

    // --- Series: the other DICOM files of the folder ---

    async _scanSeries() {
        if (!this.opts.siblings || !str(this.dataSet, 'x0020000e')) return;
        let siblings;
        try {
            siblings = (await this.opts.siblings()).slice(0, MAX_SERIES_FILES);
        } catch (err) {
            return;
        }
        if (!siblings.length || this.destroyed) return;
        const found = [{ name: this.opts.name, header: this.dataSet, file: this.file }];
        let next = 0;
        const worker = async () => {
            while (next < siblings.length && !this.destroyed) {
                const s = siblings[next++];
                try {
                    const entry = await this._readHeader(s);
                    if (entry) found.push(entry);
                } catch (_) { /* not readable: not part of a series */ }
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        if (this.destroyed) return;
        // Studies -> series -> instances, as dicomviewer's DICOMJSON
        const bySeries = new Map();
        for (const f of found) {
            const uid = str(f.header, 'x0020000e');
            if (!uid) continue;
            if (!bySeries.has(uid)) bySeries.set(uid, []);
            bySeries.get(uid).push(f);
        }
        const own = str(this.dataSet, 'x0020000e');
        this.seriesList = [...bySeries.entries()].map(([uid, instances]) => {
            const h = instances[0].header;
            return {
                uid, instances: sortInstances(instances),
                label: [str(h, 'x00080060'), str(h, 'x00200011') && '#' + str(h, 'x00200011'), str(h, 'x0008103e')].filter(Boolean).join(' '),
            };
        }).sort((a, b) => (b.uid === own) - (a.uid === own));
        this.info.series = this.seriesList.map(s => ({ uid: s.uid, label: s.label, count: s.instances.length, files: s.instances.map(i => i.name) }));
        const useful = this.seriesList.some(s => s.instances.length > 1) || this.seriesList.length > 1;
        if (!useful || !this.seriesSelect) return;
        const sel = this.seriesSelect;
        sel.textContent = '';
        const add = (value, label) => {
            const o = el('option', null, label);
            o.value = value;
            sel.appendChild(o);
        };
        add('', 'This file');
        this.seriesList.forEach((s, i) => {
            const n = s.instances.length;
            add(String(i), `${s.uid === own ? 'Series' : 'Other series'}: ${s.label || s.uid} (${n} file${n === 1 ? '' : 's'})`);
        });
        sel.hidden = false;
    }

    async _readHeader(sibling) {
        const url = await sibling.url();
        const resp = await fetch(url, { headers: { Range: `bytes=0-${HEADER_BYTES - 1}` } });
        if (!resp.ok) return null;
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (!hasPreamble(bytes) && !/\.(dcm|dicom)$/i.test(sibling.name)) return null;
        const { dataSet } = parse(this.dicomParser, bytes, { untilTag: 'x7fe00010' });
        if (!dataSet || !str(dataSet, 'x0020000e')) return null;
        const complete = resp.status === 200;
        return { name: sibling.name, header: dataSet, url, bytes: complete ? bytes : null };
    }

    async _openSeries(value) {
        this._stopCine();
        if (value === '') {
            this.series = null;
            await this._showStack(this.file.imageIds, 0);
            this._showAttributes(this.file);
            return;
        }
        const series = this.seriesList[+value];
        const instances = series.instances;
        let done = 0;
        const progress = () => this._message(`Loading the series: ${done} / ${instances.length} files…`);
        progress();
        let next = 0;
        const failed = [];
        const worker = async () => {
            while (next < instances.length && !this.destroyed) {
                const inst = instances[next++];
                if (!inst.file) {
                    try {
                        let bytes = inst.bytes;
                        if (!bytes) {
                            const resp = await fetch(inst.url);
                            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                            bytes = new Uint8Array(await resp.arrayBuffer());
                        }
                        const read = await readDicom(this.dicomParser, bytes);
                        inst.file = { name: inst.name, ...read };
                    } catch (err) {
                        failed.push(`${inst.name}: ${err.message}`);
                    }
                }
                done++;
                progress();
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        if (this.destroyed) return;
        const imageIds = [];
        let start = 0;
        for (const inst of instances) {
            if (!inst.file || !hasPixels(inst.file.dataSet)) continue;
            if (inst.file === this.file) start = imageIds.length;
            imageIds.push(...this._addFile(inst.file));
        }
        if (!imageIds.length) {
            this._message('None of the files in this series has an image.' + (failed.length ? '\n' + failed.join('\n') : ''), true);
            return;
        }
        this.series = series;
        this.info.openSeries = { uid: series.uid, images: imageIds.length, files: instances.map(i => i.name) };
        await this._showStack(imageIds, start);
        if (failed.length) this._note(`${failed.length} file(s) of the series could not be read: ${failed.join('; ')}`);
    }

    destroy() {
        this.destroyed = true;
        this._stopCine();
        clearTimeout(this._dumpTimer);
        this.resizeObserver.disconnect();
        if (this.cs) {
            const { core, tools, loader } = this.cs;
            try { tools.ToolGroupManager.destroyToolGroup(this.id + '-tools'); } catch (_) { /* gone */ }
            try { if (this.engine) this.engine.destroy(); } catch (_) { /* gone */ }
            for (const id of this.imageInfo.keys()) {
                try { core.cache.removeImageLoadObject(id, { force: true }); } catch (_) { /* not cached */ }
            }
            for (const f of this.files.values()) if (f.fileIndex != null) loader.wadouri.fileManager.remove(f.fileIndex);
            if (this.seriesList) {
                for (const s of this.seriesList) {
                    for (const inst of s.instances) if (inst.file && inst.file.fileIndex != null) loader.wadouri.fileManager.remove(inst.file.fileIndex);
                }
            }
        }
        this.root.remove();
    }
}

function highlight(span, re) {
    const text = span.textContent;
    re.lastIndex = 0;
    if (!re.test(text)) return;
    re.lastIndex = 0;
    span.textContent = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
        span.appendChild(document.createTextNode(text.slice(last, m.index)));
        span.appendChild(el('mark', null, m[0]));
        last = m.index + m[0].length;
    }
    span.appendChild(document.createTextNode(text.slice(last)));
}

// InstanceNumber first; where that is missing or repeated, the position along the slice normal
// (ImagePositionPatient · normal of ImageOrientationPatient); then the file name
function sortInstances(instances) {
    const key = (inst) => {
        const h = inst.header;
        const iop = nums(h, 'x00200037');
        const ipp = nums(h, 'x00200032');
        let dist = null;
        if (iop && iop.length === 6 && ipp && ipp.length === 3) {
            const n = [iop[1] * iop[5] - iop[2] * iop[4], iop[2] * iop[3] - iop[0] * iop[5], iop[0] * iop[4] - iop[1] * iop[3]];
            dist = n[0] * ipp[0] + n[1] * ipp[1] + n[2] * ipp[2];
        }
        return { number: num(h, 'x00200013'), dist };
    };
    const keyed = instances.map(inst => ({ inst, ...key(inst) }));
    const numbers = keyed.map(k => k.number);
    const numbersUsable = numbers.every(n => n != null) && new Set(numbers).size === numbers.length;
    keyed.sort((a, b) => {
        if (numbersUsable) return a.number - b.number;
        if (a.dist != null && b.dist != null && a.dist !== b.dist) return a.dist - b.dist;
        if (a.number != null && b.number != null && a.number !== b.number) return a.number - b.number;
        return a.inst.name.localeCompare(b.inst.name, undefined, { numeric: true });
    });
    return keyed.map(k => k.inst);
}

/**
 * Shows a DICOM file in host.
 * opts: { bytes: Uint8Array, name, siblings?: async () => [{ name, url: async () => string }],
 *         openPdf?: (bytes, name) => void }
 * Resolves to the viewer: { info, destroy() }.
 */
export async function mountDicomViewer(host, opts) {
    const viewer = new DicomViewer(host, opts);
    await viewer.load();
    return viewer;
}

export { readDicom };
