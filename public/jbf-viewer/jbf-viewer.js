// Paint Shop Pro thumbnail cache viewer (pspbrwse.jbf), loaded on demand by
// src/jbf-plugin.js. jbf-parse.js reads the file; the thumbnails are JPEGs
// (PSP 6+) or 8-bit BMPs rebuilt from the RLE of older versions, which the
// browser decodes. Shows the header, every entry as a grid or a table, and one
// entry larger with all its fields; a thumbnail can be saved. Read-only.
import { parseJbf } from './jbf-parse.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function installStyles() {
    if (document.getElementById('jbf-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'jbf-viewer-style';
    style.textContent = `
.jbfv{height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0}
.jbfv-meta{display:flex;flex-wrap:wrap;gap:4px 14px;padding:5px 10px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a;flex-shrink:0}
.jbfv-meta b{color:#24292f;font-weight:600}
.jbfv-meta .jbfv-path{font-family:ui-monospace,monospace;color:#24292f;word-break:break-all}
.jbfv-error{padding:6px 10px;background:#ffebe9;border-bottom:1px solid #ff8182;color:#82071e;font-size:12px;flex-shrink:0}
.jbfv-warn{padding:6px 10px;background:#fff8c5;border-bottom:1px solid #d4a72c;color:#6f4e00;font-size:12px;flex-shrink:0;max-height:80px;overflow:auto}
.jbfv-warn div{white-space:pre-wrap}
.jbfv-bar{display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid #ddd;background:#fafafa;flex-shrink:0;flex-wrap:wrap}
.jbfv-bar button{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 10px;font:inherit;cursor:pointer;color:#333}
.jbfv-bar button.active{background:#2d333b;color:#fff;border-color:#2d333b}
.jbfv-bar input{font:inherit;padding:2px 6px;border:1px solid #ccc;border-radius:4px;min-width:0;flex:0 1 200px}
.jbfv-bar .jbfv-count{margin-left:auto;color:#666;font-size:12px}
.jbfv-main{flex:1;min-height:0;display:flex;position:relative}
.jbfv-list{flex:1;min-width:0;overflow:auto}
.jbfv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;padding:10px}
.jbfv-card{border:1px solid #ddd;border-radius:6px;padding:6px;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;background:#fff;min-width:0}
.jbfv-card:hover{border-color:#8c959f}
.jbfv-card.sel{border-color:#0969da;box-shadow:0 0 0 2px #0969da40}
.jbfv-thumb{width:120px;height:120px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}
.jbfv-thumb img{max-width:100%;max-height:100%}
.jbfv-none{color:#888;font-size:11px;text-align:center;padding:4px}
.jbfv-name{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
.jbfv-sub{font-size:11px;color:#777;white-space:nowrap}
.jbfv-flag{font-size:10px;color:#9a6700;background:#fff8c5;border-radius:3px;padding:0 4px}
.jbfv-table{border-collapse:collapse;font-size:12px;width:100%}
.jbfv-table th,.jbfv-table td{padding:3px 8px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}
.jbfv-table th{position:sticky;top:0;background:#f2f2f2;font-weight:600}
.jbfv-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.jbfv-table tr{cursor:pointer}
.jbfv-table tr:hover td{background:#f6f8fa}
.jbfv-table tr.sel td{background:#ddf4ff}
.jbfv-detail{width:340px;flex-shrink:0;border-left:1px solid #ddd;overflow:auto;background:#fff;padding:10px 12px;box-sizing:border-box}
.jbfv-detail h3{margin:0 0 8px;font-size:14px;word-break:break-all}
.jbfv-big{display:flex;align-items:center;justify-content:center;min-height:160px;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px;border:1px solid #ddd;border-radius:4px}
.jbfv-big img{max-width:100%;image-rendering:auto}
.jbfv-actions{display:flex;gap:6px;margin:8px 0;flex-wrap:wrap}
.jbfv-actions button{border:1px solid #ccc;background:#fff;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer}
.jbfv-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 10px;font-size:12px}
.jbfv-kv span:nth-child(odd){color:#666}
.jbfv-kv span:nth-child(even){word-break:break-all}
.jbfv-empty{padding:20px;color:#666}
@media (max-width:640px){
 .jbfv-detail{position:absolute;inset:0;width:auto;border-left:none;z-index:2}
 .jbfv-grid{grid-template-columns:repeat(auto-fill,minmax(104px,1fr));padding:6px;gap:6px}
 .jbfv-thumb{width:96px;height:96px}
}
`;
    document.head.appendChild(style);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

const pad = n => String(n).padStart(2, '0');
function fmtDate(sec, utc) {
    const d = new Date(sec * 1000);
    if (isNaN(d)) return String(sec);
    return utc
        ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
        : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// Short date for the cards: "Mar 4 1999"
function fmtShortDate(sec) {
    const d = new Date(sec * 1000);
    return isNaN(d) ? '' : `${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

function saveBytes(bytes, name, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// The name a saved thumbnail gets: the image's name plus .jpg/.bmp, as jbfinspect -d names it
function thumbFileName(entry) {
    return (entry.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || `image${entry.index}`) + '.' + entry.thumb.ext;
}

class JbfViewer {
    constructor(host, { bytes, name }) {
        installStyles();
        this.host = host;
        this.name = name || '';
        this.jbf = parseJbf(bytes);
        this.urls = new Map();
        this.mode = 'grid';
        this.filter = '';
        this.selected = null;
        this.root = el('div', 'jbfv');
        host.appendChild(this.root);
        this._render();
        this._onKey = e => this._key(e);
        this.root.tabIndex = -1;
        this.root.addEventListener('keydown', this._onKey);
    }

    get info() {
        const j = this.jbf;
        return { version: j.version && j.version.string, psp: j.psp, count: j.count, entries: j.entries.length, error: j.error };
    }

    _url(entry) {
        if (!entry.thumb) return null;
        let url = this.urls.get(entry);
        if (!url) {
            url = URL.createObjectURL(new Blob([entry.thumb.bytes], { type: entry.thumb.mime }));
            this.urls.set(entry, url);
        }
        return url;
    }

    _img(entry, box) {
        const url = this._url(entry);
        if (!url) {
            box.appendChild(el('div', 'jbfv-none', 'no thumbnail'));
            return;
        }
        const img = el('img');
        img.alt = entry.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = () => { img.replaceWith(el('div', 'jbfv-none', 'thumbnail can’t be decoded')); };
        img.src = url;
        box.appendChild(img);
    }

    _render() {
        const j = this.jbf;
        this.root.textContent = '';
        const meta = el('div', 'jbfv-meta');
        const item = (k, v, cls) => { const s = el('span'); s.append(k ? k + ' ' : '', Object.assign(el('b', cls), { textContent: v })); meta.appendChild(s); };
        if (j.version) {
            item('JBF', `${j.version.string} (PSP ${j.psp})`);
            if (j.volume) item('Volume', j.volume);
            item('', j.path || '(no path)', 'jbfv-path');
            item('Images', j.entries.length === j.count ? String(j.count) : `${j.count} in header, ${j.entries.length} read`);
        }
        item('File', fmtSize(j.size));
        this.root.appendChild(meta);
        if (j.error) this.root.appendChild(el('div', 'jbfv-error', (j.entries.length ? 'Reading stopped: ' : 'Could not read the file: ') + j.error));
        if (j.warnings.length) {
            const w = el('div', 'jbfv-warn');
            for (const msg of j.warnings) w.appendChild(el('div', null, msg));
            this.root.appendChild(w);
        }
        if (!j.entries.length) {
            if (!j.error) this.root.appendChild(el('div', 'jbfv-empty', 'This cache holds no images.'));
            return;
        }

        const bar = el('div', 'jbfv-bar');
        this.gridBtn = el('button', null, 'Grid');
        this.tableBtn = el('button', null, 'Table');
        this.gridBtn.onclick = () => this._setMode('grid');
        this.tableBtn.onclick = () => this._setMode('table');
        const search = el('input');
        search.type = 'search';
        search.placeholder = 'Filter names';
        search.oninput = () => { this.filter = search.value.toLowerCase(); this._renderList(); };
        this.countEl = el('span', 'jbfv-count');
        bar.append(this.gridBtn, this.tableBtn, search, this.countEl);
        this.root.appendChild(bar);

        const main = el('div', 'jbfv-main');
        this.listEl = el('div', 'jbfv-list');
        this.detailEl = el('div', 'jbfv-detail');
        this.detailEl.hidden = true;
        main.append(this.listEl, this.detailEl);
        this.root.appendChild(main);
        this._setMode(this.mode);
    }

    _setMode(mode) {
        this.mode = mode;
        this.gridBtn.classList.toggle('active', mode === 'grid');
        this.tableBtn.classList.toggle('active', mode === 'table');
        this._renderList();
    }

    _visible() {
        return this.jbf.entries.filter(e => !this.filter || e.name.toLowerCase().includes(this.filter));
    }

    _renderList() {
        const entries = this._visible();
        this.countEl.textContent = entries.length === this.jbf.entries.length ? `${entries.length} images` : `${entries.length} of ${this.jbf.entries.length}`;
        this.listEl.textContent = '';
        this.rows = new Map();
        if (this.mode === 'grid') {
            const grid = el('div', 'jbfv-grid');
            for (const e of entries) {
                const card = el('div', 'jbfv-card');
                card.title = e.name;
                const box = el('div', 'jbfv-thumb');
                this._img(e, box);
                const sub = el('div', 'jbfv-sub', [e.type, `${e.width}×${e.height}`, fmtSize(e.filesize)].filter(Boolean).join(' · '));
                card.append(box, el('div', 'jbfv-name', e.name), sub);
                if (e.broken || (e.thumb && e.thumb.truncated) || e.truncatedBitmap) card.appendChild(el('span', 'jbfv-flag', e.broken ? 'broken bitmap' : 'cut off'));
                card.onclick = () => this._select(e);
                grid.appendChild(card);
                this.rows.set(e, card);
            }
            this.listEl.appendChild(grid);
        } else {
            const table = el('table', 'jbfv-table');
            const head = table.createTHead().insertRow();
            const cols = ['#', 'Name', 'Type', 'Resolution', 'Depth', 'Size', 'Modified', 'Thumbnail'];
            for (const c of cols) head.appendChild(el('th', null, c));
            const body = table.createTBody();
            for (const e of entries) {
                const tr = body.insertRow();
                const cells = [
                    [String(e.index), 'num'], [e.name], [e.type], [`${e.width}×${e.height}`, 'num'], [e.depth + ' bpp', 'num'],
                    [e.filesize.toLocaleString(), 'num'], [fmtDate(e.mtime)],
                    [e.thumb ? `${e.thumb.ext.toUpperCase()} ${fmtSize(e.thumb.bytes.length)}` : '—'],
                ];
                for (const [text, cls] of cells) tr.appendChild(el('td', cls, text));
                tr.onclick = () => this._select(e);
                body.appendChild(tr);
                this.rows.set(e, tr);
            }
            this.listEl.appendChild(table);
        }
        if (this.selected && this.rows.has(this.selected)) this.rows.get(this.selected).classList.add('sel');
    }

    _select(entry) {
        if (this.selected && this.rows.has(this.selected)) this.rows.get(this.selected).classList.remove('sel');
        this.selected = entry;
        if (!entry) {
            this.detailEl.hidden = true;
            return;
        }
        const row = this.rows.get(entry);
        if (row) {
            row.classList.add('sel');
            row.scrollIntoView({ block: 'nearest' });
        }
        this._renderDetail(entry);
    }

    _renderDetail(e) {
        const d = this.detailEl;
        d.hidden = false;
        d.textContent = '';
        d.appendChild(el('h3', null, e.name));
        const big = el('div', 'jbfv-big');
        this._img(e, big);
        const img = big.querySelector('img');
        // Small thumbnails are shown at up to twice their size
        if (img) img.onload = () => { img.style.width = Math.min(img.naturalWidth * 2, d.clientWidth - 26) + 'px'; };
        d.appendChild(big);

        const actions = el('div', 'jbfv-actions');
        const prev = el('button', null, '‹ Prev'), next = el('button', null, 'Next ›'), close = el('button', null, 'Close');
        prev.onclick = () => this._step(-1);
        next.onclick = () => this._step(1);
        close.onclick = () => this._select(null);
        actions.append(prev, next);
        if (e.thumb) {
            const save = el('button', null, `Save .${e.thumb.ext}`);
            save.title = 'Save this thumbnail';
            save.onclick = () => saveBytes(e.thumb.bytes, thumbFileName(e), e.thumb.mime);
            actions.appendChild(save);
        }
        actions.appendChild(close);
        d.appendChild(actions);

        const kv = el('div', 'jbfv-kv');
        const row = (k, v) => { if (v !== undefined && v !== null && v !== '') kv.append(el('span', null, k), el('span', null, String(v))); };
        row('Entry', `#${e.index} of ${this.jbf.count}`);
        row('Name', e.name);
        row('Format', e.type || '(not stored in v1.3)');
        if (e.typeCode !== undefined) row('Type code', '0x' + e.typeCode.toString(16).padStart(4, '0'));
        if (e.fourcc !== undefined) row('Extension field', `${e.fourcc.replace(/\0+$/, '')} (stored reversed)`);
        row('Dimensions', `${e.width} × ${e.height}`);
        row('Color depth', `${e.depth} bpp`);
        row('Original size', `${e.filesize.toLocaleString()} bytes (${fmtSize(e.filesize)})`);
        row('Modified', fmtDate(e.mtime));
        row('Modified (UTC)', fmtDate(e.mtime, true));
        if (e.filetime !== undefined) row('FILETIME', e.filetime.toString());
        else row('UNIX time', e.mtime);
        if (e.pels !== undefined) row('Unknown field', `${e.pels.toLocaleString()} (≈ w×h×channels)`);
        if (e.imageIndex !== undefined) row('Image index', e.imageIndex);
        if (e.bitmap) row('Bitmap', `${e.bitmap.width} × ${e.bitmap.height}, ${e.bitmap.bitCount} bpp, ${e.bitmap.sizeImage.toLocaleString()} bytes`);
        if (e.thumb) row('Thumbnail', `${e.thumb.format}, ${e.thumb.bytes.length.toLocaleString()} bytes${e.thumb.truncated ? ` (cut off, ${e.thumb.length.toLocaleString()} stored)` : ''}`);
        else row('Thumbnail', 'none (entry has no thumbnail)');
        if (e.broken) row('Note', 'broken RLE bitmap: the thumbnail is garbled');
        if (e.truncatedBitmap) row('Note', 'the file ends inside this bitmap');
        row('Offset', '0x' + e.offset.toString(16));
        d.appendChild(kv);
    }

    _step(delta) {
        const list = this._visible();
        if (!list.length) return;
        const i = list.indexOf(this.selected);
        this._select(list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i + delta)))]);
    }

    _key(e) {
        if (!this.selected || e.target.tagName === 'INPUT') return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); this._step(1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); this._step(-1); }
        else if (e.key === 'Escape') this._select(null);
    }

    destroy() {
        this.root.removeEventListener('keydown', this._onKey);
        for (const url of this.urls.values()) URL.revokeObjectURL(url);
        this.urls.clear();
        this.root.remove();
    }
}

export function mountJbfViewer(host, opts) {
    return new JbfViewer(host, opts);
}
