// Compiled HTML Help viewer (.chm), loaded on demand by src/chm-plugin.js.
// chm-parse.js reads the archive (chm-lzx.js decompresses it). On the left
// the contents tree (.hhc; without one, the topics of #TOPICS), the keyword
// index (.hhk) with a search box, and the archive's files with their size and
// section, each of which can be viewed or saved. On the right the topic, in a
// sandboxed iframe: every reference in the page and its style sheets (src,
// href of style sheets, url(), @import, background, srcset, frames) points at
// the file inside the archive (relative paths, /paths, ms-its: and
// mk:@MSITStore: URLs), links between topics move the viewer, with back and
// forward. Pages are decoded from their declared charset, else the help
// file's language's code page.
//
// By default the page runs no scripts and loads nothing from the network:
// the iframe has allow-same-origin but not allow-scripts (so the page's own
// blob: URLs load, and the viewer itself handles the clicks), and a CSP in
// each document allows only blob:/data:. "Scripts" turns on allow-scripts
// instead, without allow-same-origin: the page then has an opaque origin, which
// Chrome refuses blob: URLs to, so the files are data: URLs and a small script
// of ours reports link clicks by postMessage. "Remote" adds http(s) to the CSP.
// External links open in a new browser tab. Read-only; the blob: URLs are
// revoked when the tab closes.
import { openChm, parseSitemap, indexEntries, sniffCharset, decoderFor } from './chm-parse.js';

const HTML_RE = /\.(html?|xhtml|shtml|hta)$/i;
const MAX_FRAME_DEPTH = 4;
const MAX_INDEX_ROWS = 400;
const MIME_BY_EXT = {
    htm: 'text/html', html: 'text/html', shtml: 'text/html', xhtml: 'application/xhtml+xml', css: 'text/css', js: 'text/javascript',
    txt: 'text/plain', xml: 'text/xml', hhc: 'text/plain', hhk: 'text/plain', json: 'application/json',
    png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', bmp: 'image/bmp', ico: 'image/x-icon',
    svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', wmf: 'image/wmf', emf: 'image/emf',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
    mp3: 'audio/mpeg', wav: 'audio/wav', mid: 'audio/midi', mp4: 'video/mp4', avi: 'video/x-msvideo', pdf: 'application/pdf',
};

function installStyles() {
    if (document.getElementById('chm-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'chm-viewer-style';
    style.textContent = `
.chmv{height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0}
.chmv-bar{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid #ddd;background:#fafafa;flex-shrink:0;flex-wrap:wrap}
.chmv-bar button{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 9px;font:inherit;cursor:pointer;color:#333}
.chmv-bar button:disabled{opacity:.4;cursor:default}
.chmv-bar button.active{background:#2d333b;color:#fff;border-color:#2d333b}
.chmv-bar button.chmv-remote.active{background:#9a6700;border-color:#9a6700}
.chmv-bar button.chmv-scripts.active{background:#9a6700;border-color:#9a6700}
.chmv-showing{color:#555;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.chmv-showing b{color:#222;font-weight:600}
.chmv-warn{padding:6px 10px;background:#fff8c5;border-bottom:1px solid #d4a72c;color:#6f4e00;font-size:12px;flex-shrink:0;max-height:80px;overflow:auto;white-space:pre-wrap}
.chmv-main{flex:1;min-height:0;display:flex}
.chmv-side{width:min(34%,320px);flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid #d0d7de;min-height:0;background:#fff}
.chmv-side.wide{width:min(62%,700px)}
.chmv-side[hidden]{display:none}
.chmv-tabs{display:flex;border-bottom:1px solid #d0d7de;flex-shrink:0;background:#f6f8fa}
.chmv-tabs button{flex:1;border:none;border-bottom:2px solid transparent;background:none;padding:5px 4px;font:inherit;cursor:pointer;color:#57606a}
.chmv-tabs button.active{border-bottom-color:#fd8c73;color:#24292f;font-weight:600}
.chmv-pane{flex:1;min-height:0;display:flex;flex-direction:column}
.chmv-pane[hidden]{display:none}
.chmv-search{margin:6px;padding:4px 7px;border:1px solid #ccc;border-radius:4px;font:inherit;flex-shrink:0;min-width:0}
.chmv-scroll{flex:1;min-height:0;overflow:auto}
.chmv-tree ul{list-style:none;margin:0;padding:0 0 0 14px}
.chmv-tree>ul{padding:4px 0}
.chmv-node{display:flex;align-items:flex-start;gap:3px;padding:1px 6px 1px 2px;cursor:pointer;border-radius:3px;line-height:1.35}
.chmv-node:hover{background:#f3f4f6}
.chmv-node.sel{background:#ddf4ff}
.chmv-node .chmv-tw{width:12px;flex-shrink:0;color:#888;font-size:10px;padding-top:2px;text-align:center}
.chmv-node .chmv-ic{flex-shrink:0}
.chmv-node .chmv-lbl{min-width:0;overflow-wrap:anywhere}
.chmv-idx-row{padding:2px 8px;cursor:pointer;line-height:1.35;overflow-wrap:anywhere}
.chmv-idx-row:hover{background:#f3f4f6}
.chmv-idx-row.sub{padding-left:22px}
.chmv-idx-row.head{color:#555;cursor:default}
.chmv-idx-row.head:hover{background:none}
.chmv-idx-row.see{color:#0969da}
.chmv-idx-row .chmv-n{color:#888;font-size:11px;margin-left:4px}
.chmv-idx-topics{margin:0 0 4px 22px;border-left:2px solid #d0d7de}
.chmv-idx-topic{padding:2px 8px;cursor:pointer;color:#0969da}
.chmv-idx-topic:hover{text-decoration:underline}
.chmv-note{padding:6px 8px;color:#777;font-size:12px}
.chmv-info{padding:6px 8px;font-size:12px;color:#57606a;border-bottom:1px solid #eee;flex-shrink:0}
.chmv-info b{color:#24292f;font-weight:600}
.chmv-table{border-collapse:collapse;font-size:12px;width:100%}
.chmv-table th,.chmv-table td{padding:2px 6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.chmv-table th{position:sticky;top:0;background:#f6f8fa;font-weight:600;z-index:1}
.chmv-table td.chmv-path{font-family:ui-monospace,monospace;word-break:break-all}
.chmv-table td.chmv-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.chmv-table td.chmv-act,.chmv-table td.chmv-sec{white-space:nowrap}
.chmv-table td.chmv-act button{border:1px solid #ccc;background:#fff;border-radius:4px;padding:0 6px;font:inherit;cursor:pointer;margin-right:3px}
.chmv-table tr.sel td{background:#ddf4ff}
.chmv-page{flex:1;min-width:0;display:flex;background:#fff}
.chmv-page iframe{flex:1;border:none;background:#fff;width:100%;height:100%}
.chmv-error{padding:20px;color:#a33;white-space:pre-wrap}
@media (max-width:700px){.chmv-main{flex-direction:column}.chmv-side,.chmv-side.wide{width:auto;height:40%;border-right:none;border-bottom:1px solid #d0d7de}}
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

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function extOf(path) {
    const m = /\.([A-Za-z0-9]+)$/.exec(path);
    return m ? m[1].toLowerCase() : '';
}

function mimeOf(path) {
    return MIME_BY_EXT[extOf(path)] || 'application/octet-stream';
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

// "/a/b/../c.htm" → "/a/c.htm"
function normalizePath(p) {
    const out = [];
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
    }
    return '/' + out.join('/');
}

function dirOf(path) {
    return path.slice(0, path.lastIndexOf('/') + 1) || '/';
}

function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
}

// "a.png 1x, b.png 2x" → [[url, descriptor]...]
function parseSrcset(value) {
    return value.split(/,\s+|,(?=\S+\s)/).map(s => s.trim()).filter(Boolean).map(s => {
        const m = /^(\S+)(\s+.*)?$/.exec(s);
        return [m[1], m[2] || ''];
    });
}

function isTextual(bytes) {
    const n = Math.min(bytes.length, 4096);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
    return true;
}

function hexDump(bytes, limit) {
    const n = Math.min(bytes.length, limit);
    const lines = [];
    for (let o = 0; o < n; o += 16) {
        let hex = '', asc = '';
        for (let i = 0; i < 16; i++) {
            if (o + i < n) {
                const b = bytes[o + i];
                hex += b.toString(16).padStart(2, '0') + (i === 7 ? '  ' : ' ');
                asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
            } else hex += i === 7 ? '    ' : '   ';
        }
        lines.push(o.toString(16).padStart(8, '0') + '  ' + hex + ' ' + asc);
    }
    if (bytes.length > n) lines.push(`… ${bytes.length - n} more bytes`);
    return lines.join('\n');
}

class ChmViewer {
    constructor(host, { bytes, name }) {
        installStyles();
        this.host = host;
        this.name = name || 'help.chm';
        this.chm = openChm(bytes);
        this.scripts = false;
        this.remote = false;
        this.urls = new Map();       // `${mode}|${path}` → url of a file as the page sees it
        this.blobUrls = new Set();   // to revoke
        this.titles = new Map();     // lower-case path → topic title
        this.tocByPath = new Map();  // lower-case path → TOC node
        this.history = [];
        this.histPos = -1;
        this.token = Math.random().toString(36).slice(2) + Date.now().toString(36);
        this.info = { files: this.chm.files.filter(f => !f.name.endsWith('/')).length, title: this.chm.title, warnings: this.chm.warnings };
        for (const t of this.chm.topics()) {
            if (t.title && t.local) {
                const key = this._key(this._resolve(t.local, '/'));
                if (key && !this.titles.has(key)) this.titles.set(key, t.title);
            }
        }
        this._build();
        this._onMessage = e => this._message(e);
        window.addEventListener('message', this._onMessage);
        const start = this._defaultTopic();
        if (start) this.navigate(start);
        else this._showMessage('This help file has no pages.');
    }

    _key(target) {
        return target && target.path ? target.path.toLowerCase() : null;
    }

    // --- UI ---
    _build() {
        const root = el('div', 'chmv');
        const bar = el('div', 'chmv-bar');
        const btn = (text, title, cls) => { const b = el('button', cls, text); b.type = 'button'; b.title = title; bar.appendChild(b); return b; };
        this.paneBtn = btn('☰', 'Show or hide the contents', 'active');
        this.backBtn = btn('◀', 'Back');
        this.fwdBtn = btn('▶', 'Forward');
        this.homeBtn = btn('⌂', 'Home (the default topic)');
        this.showing = el('span', 'chmv-showing');
        bar.appendChild(this.showing);
        this.scriptsBtn = btn('Scripts', 'Run the pages\' scripts (off: no scripts run)', 'chmv-scripts');
        this.remoteBtn = btn('Remote', 'Load images, styles and scripts from the network (off: only files inside the help file)', 'chmv-remote');
        root.appendChild(bar);
        if (this.chm.warnings.length) root.appendChild(el('div', 'chmv-warn', this.chm.warnings.join('\n')));

        const main = el('div', 'chmv-main');
        const side = el('div', 'chmv-side');
        const tabs = el('div', 'chmv-tabs');
        const panes = {};
        const tabBtns = {};
        for (const [id, label] of [['toc', 'Contents'], ['index', 'Index'], ['files', 'Files']]) {
            const b = el('button', null, label);
            b.type = 'button';
            b.onclick = () => this._tab(id);
            tabs.appendChild(b);
            tabBtns[id] = b;
            panes[id] = el('div', 'chmv-pane chmv-' + id);
        }
        side.append(tabs, panes.toc, panes.index, panes.files);
        this.side = side;
        this.panes = panes;
        this.tabBtns = tabBtns;

        const page = el('div', 'chmv-page');
        main.append(side, page);
        root.appendChild(main);
        this.page = page;
        this._newFrame();
        this.host.appendChild(root);
        this.root = root;

        this.paneBtn.onclick = () => {
            side.hidden = !side.hidden;
            this.paneBtn.classList.toggle('active', !side.hidden);
        };
        this.backBtn.onclick = () => this._go(-1);
        this.fwdBtn.onclick = () => this._go(1);
        this.homeBtn.onclick = () => { const t = this._defaultTopic(); if (t) this.navigate(t); };
        this.scriptsBtn.onclick = () => this._setMode(!this.scripts, this.remote);
        this.remoteBtn.onclick = () => this._setMode(this.scripts, !this.remote);

        this._buildToc();
        this._buildIndex();
        this._buildFiles();
        this._tab(this.tocRoot ? 'toc' : this.indexRows ? 'index' : 'files');
        this._updateNav();
    }

    _tab(id) {
        for (const k of Object.keys(this.panes)) {
            this.panes[k].hidden = k !== id;
            this.tabBtns[k].classList.toggle('active', k === id);
        }
        this.side.classList.toggle('wide', id === 'files');
        if (id === 'index' && this.indexSearch) this.indexSearch.focus({ preventScroll: true });
    }

    _newFrame() {
        if (this.frame) this.frame.remove();
        const frame = el('iframe');
        frame.title = 'Help topic';
        // No scripts: same origin (so the page's blob: URLs load and its clicks reach us), never with allow-scripts.
        // Scripts: an opaque origin, never with allow-same-origin.
        frame.setAttribute('sandbox', this.scripts ? 'allow-scripts' : 'allow-same-origin');
        frame.addEventListener('load', () => this._frameLoaded());
        this.page.appendChild(frame);
        this.frame = frame;
    }

    _setMode(scripts, remote) {
        const changedSandbox = scripts !== this.scripts;
        this.scripts = scripts;
        this.remote = remote;
        this.scriptsBtn.classList.toggle('active', scripts);
        this.remoteBtn.classList.toggle('active', remote);
        this._revokeAll();
        if (changedSandbox) this._newFrame();
        const cur = this.history[this.histPos];
        if (cur) this._show(cur);
    }

    _revokeAll() {
        for (const u of this.blobUrls) URL.revokeObjectURL(u);
        this.blobUrls.clear();
        this.urls.clear();
    }

    // --- Contents ---
    _buildToc() {
        const pane = this.panes.toc;
        let items = [];
        let note = '';
        if (this.chm.contentsFile) {
            try {
                items = parseSitemap(this.chm.decodeText(this.chm.read(this.chm.contentsFile))).items;
            } catch (err) {
                note = `Could not read the contents (${this.chm.contentsFile}): ${err.message}`;
            }
        }
        if (!items.length) {
            // No .hhc: the topics the compiler listed (#TOPICS)
            items = this.chm.topics().filter(t => t.local && HTML_RE.test(t.local.replace(/#.*$/, '')))
                .map(t => ({ name: t.title || t.local, local: t.local, children: [] }));
            if (items.length) note = note || 'No table of contents in this help file: its topics, in the order they were compiled.';
        }
        if (note) pane.appendChild(el('div', 'chmv-note', note));
        if (!items.length) {
            pane.appendChild(el('div', 'chmv-note', 'No table of contents.'));
            return;
        }
        const scroll = el('div', 'chmv-scroll chmv-tree');
        pane.appendChild(scroll);
        this.tocRoot = { children: items, el: null };
        this.firstTocTopic = null;
        const index = (list, parent) => {
            for (const it of list) {
                it.parent = parent;
                if (it.local) {
                    const target = this._resolve(it.local, '/');
                    it.target = target;
                    const key = this._key(target);
                    if (key) {
                        if (!this.tocByPath.has(key)) this.tocByPath.set(key, it);
                        if (it.name && !this.titles.has(key)) this.titles.set(key, it.name);
                        if (!this.firstTocTopic && target.path) this.firstTocTopic = target;
                    }
                }
                index(it.children, it);
            }
        };
        index(items, this.tocRoot);
        const ul = el('ul');
        scroll.appendChild(ul);
        this.tocRoot.ul = ul;
        this.tocRoot.open = true;
        for (const it of items) ul.appendChild(this._tocNode(it));
    }

    _tocNode(it) {
        const li = el('li');
        const row = el('div', 'chmv-node');
        const hasKids = it.children.length > 0;
        const tw = el('span', 'chmv-tw', hasKids ? '▸' : '');
        const ic = el('span', 'chmv-ic', hasKids ? '📁' : '📄');
        row.append(tw, ic, el('span', 'chmv-lbl', it.name || it.local || '(untitled)'));
        if (it.local) row.title = it.local;
        li.appendChild(row);
        it.row = row;
        it.li = li;
        it.tw = tw;
        it.ic = ic;
        tw.onclick = e => { e.stopPropagation(); this._toggleToc(it); };
        row.onclick = () => {
            if (it.target) this.navigate(it.target);
            if (hasKids && (!it.open || !it.target)) this._toggleToc(it, true);
        };
        return li;
    }

    _toggleToc(it, open) {
        if (!it.children.length) return;
        const want = open != null ? open : !it.open;
        if (want && !it.ul) {
            it.ul = el('ul');
            for (const c of it.children) it.ul.appendChild(this._tocNode(c));
            it.li.appendChild(it.ul);
        }
        if (it.ul) it.ul.hidden = !want;
        it.open = want;
        it.tw.textContent = want ? '▾' : '▸';
        it.ic.textContent = want ? '📂' : '📁';
    }

    // Highlight the contents entry of the page shown, opening its folders
    _syncToc(target) {
        if (this.tocSel) this.tocSel.classList.remove('sel');
        this.tocSel = null;
        const it = this.tocByPath.get(this._key(target));
        if (!it) return;
        const chain = [];
        for (let p = it.parent; p && p !== this.tocRoot; p = p.parent) chain.unshift(p);
        for (const p of chain) this._toggleToc(p, true);
        if (!it.row) return;
        it.row.classList.add('sel');
        this.tocSel = it.row;
        // Scroll the contents only (scrollIntoView could scroll the app's layout too)
        const sc = it.row.closest('.chmv-scroll');
        if (sc && !this.panes.toc.hidden) {
            const r = it.row.getBoundingClientRect();
            const b = sc.getBoundingClientRect();
            if (r.top < b.top || r.bottom > b.bottom) sc.scrollTop += r.top - b.top - b.height / 3;
        }
    }

    // --- Index ---
    _buildIndex() {
        const pane = this.panes.index;
        let entries = [];
        if (this.chm.indexFile) {
            try {
                entries = indexEntries(parseSitemap(this.chm.decodeText(this.chm.read(this.chm.indexFile))).items);
            } catch (err) {
                pane.appendChild(el('div', 'chmv-note', `Could not read the index (${this.chm.indexFile}): ${err.message}`));
            }
        }
        if (!entries.length) {
            pane.appendChild(el('div', 'chmv-note', 'No keyword index in this help file.'));
            return;
        }
        const rows = [];
        const flatten = (list, depth, parent) => {
            for (const e of list) {
                const full = parent ? parent + ', ' + e.keyword : e.keyword;
                rows.push({ entry: e, depth, parent, text: full.toLowerCase() });
                flatten(e.children, depth + 1, full);
            }
        };
        flatten(entries, 0, '');
        this.indexRows = rows;
        const search = el('input', 'chmv-search');
        search.type = 'search';
        search.placeholder = `Search ${rows.length} keywords…`;
        const scroll = el('div', 'chmv-scroll');
        pane.append(search, scroll);
        this.indexSearch = search;
        this.indexList = scroll;
        search.addEventListener('input', () => this._renderIndex(search.value));
        search.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const first = scroll.querySelector('.chmv-idx-row:not(.head)');
                if (first) first.click();
            }
        });
        this._renderIndex('');
    }

    _renderIndex(query) {
        const q = query.trim().toLowerCase();
        const list = this.indexList;
        list.textContent = '';
        let rows = this.indexRows;
        if (q) {
            // Keywords starting with the text first, then the ones containing it
            const starts = [], contains = [];
            for (const r of rows) {
                const kw = r.entry.keyword.toLowerCase();
                if (kw.startsWith(q) || r.text.startsWith(q)) starts.push(r);
                else if (r.text.includes(q)) contains.push(r);
            }
            rows = starts.concat(contains);
        }
        const shown = rows.slice(0, MAX_INDEX_ROWS);
        for (const r of shown) {
            const e = r.entry;
            const label = q && r.parent ? `${r.parent} › ${e.keyword}` : e.keyword;
            const row = el('div', 'chmv-idx-row' + (r.depth && !q ? ' sub' : ''));
            if (r.depth && !q) row.style.paddingLeft = (8 + 14 * r.depth) + 'px';
            row.appendChild(document.createTextNode(label || '(untitled)'));
            if (e.topics.length > 1) row.appendChild(el('span', 'chmv-n', `(${e.topics.length})`));
            if (!e.topics.length && e.seeAlso) {
                row.classList.add('see');
                row.appendChild(el('span', 'chmv-n', `see ${e.seeAlso}`));
            } else if (!e.topics.length) {
                row.classList.add('head');
            }
            row.onclick = () => this._indexClick(e, row);
            list.appendChild(row);
        }
        if (!rows.length) list.appendChild(el('div', 'chmv-note', 'No keyword matches.'));
        else if (rows.length > shown.length) list.appendChild(el('div', 'chmv-note', `${rows.length - shown.length} more — type more of the keyword.`));
    }

    _indexClick(e, row) {
        if (e.topics.length === 1) {
            const t = this._resolve(e.topics[0].local, '/');
            if (t) this.navigate(t);
        } else if (e.topics.length > 1) {
            // Several topics: list them under the keyword (again: hide them)
            if (row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains('chmv-idx-topics')) {
                row.nextSibling.remove();
                return;
            }
            const box = el('div', 'chmv-idx-topics');
            for (const tp of e.topics) {
                const target = this._resolve(tp.local, '/');
                const title = (target && this.titles.get(this._key(target))) || tp.title || tp.local;
                const a = el('div', 'chmv-idx-topic', title);
                a.title = tp.local;
                a.onclick = () => { if (target) this.navigate(target); };
                box.appendChild(a);
            }
            row.after(box);
        } else if (e.seeAlso) {
            this.indexSearch.value = e.seeAlso;
            this._renderIndex(e.seeAlso);
        }
    }

    // --- Files ---
    _buildFiles() {
        const pane = this.panes.files;
        const chm = this.chm;
        const info = el('div', 'chmv-info');
        const L = chm.lzx;
        const parts = [
            ['Title', chm.title || '—'],
            ['Language', `0x${chm.lcid.toString(16).padStart(4, '0')} (${chm.codepage})`],
            ['Format', `ITSF v${chm.version}`],
        ];
        if (L) parts.push(['LZX', `window ${L.windowSize / 1024} KB, reset every ${L.resetInterval / 1024} KB, ${fmtSize(L.compressedLen)} → ${fmtSize(L.uncompressedLen)}`]);
        if (chm.system.compiler) parts.push(['Compiler', chm.system.compiler]);
        if (chm.system.timestamp) parts.push(['Compiled', new Date(chm.system.timestamp * 1000).toISOString().slice(0, 10)]);
        parts.forEach(([k, v], i) => {
            if (i) info.appendChild(document.createTextNode(' · '));
            info.appendChild(document.createTextNode(k + ': '));
            info.appendChild(el('b', null, v));
        });
        const search = el('input', 'chmv-search');
        search.type = 'search';
        const files = chm.files.filter(f => !f.name.endsWith('/'));
        search.placeholder = `Filter ${files.length} files…`;
        const scroll = el('div', 'chmv-scroll');
        pane.append(info, search, scroll);
        const table = el('table', 'chmv-table');
        table.innerHTML = '<thead><tr><th>Path</th><th style="text-align:right">Size</th><th>Section</th><th></th></tr></thead>';
        const tbody = el('tbody');
        table.appendChild(tbody);
        scroll.appendChild(table);
        this.fileRows = new Map();
        for (const f of files) {
            const tr = el('tr');
            tr.appendChild(el('td', 'chmv-path', f.name));
            tr.appendChild(el('td', 'chmv-num', fmtSize(f.length)));
            tr.appendChild(el('td', 'chmv-sec', f.section === 0 ? '0 · stored' : f.section === 1 ? '1 · LZX' : String(f.section)));
            const act = el('td', 'chmv-act');
            const view = el('button', null, 'View');
            view.type = 'button';
            view.onclick = () => this.navigate({ path: f.name, anchor: '', raw: !HTML_RE.test(f.name) });
            const save = el('button', null, 'Save');
            save.type = 'button';
            save.onclick = () => this._save(f);
            act.append(view, save);
            tr.appendChild(act);
            tr.dataset.name = f.name.toLowerCase();
            tbody.appendChild(tr);
            this.fileRows.set(f.name.toLowerCase(), tr);
        }
        search.addEventListener('input', () => {
            const q = search.value.trim().toLowerCase();
            for (const tr of tbody.children) tr.hidden = !!q && !tr.dataset.name.includes(q);
        });
    }

    _save(f) {
        try {
            const name = f.name.slice(f.name.lastIndexOf('/') + 1).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'file';
            saveBytes(this.chm.read(f), name, mimeOf(f.name));
        } catch (err) {
            this._showMessage(`Could not read ${f.name}: ${err.message}`);
        }
    }

    // --- References ---

    // A reference in a page (or the contents) → { path, anchor } inside the archive,
    // { external } for a web link, or null (javascript:, unknown)
    _resolve(ref, base) {
        if (ref == null) return null;
        ref = String(ref).trim();
        if (!ref) return null;
        if (/^javascript:/i.test(ref)) return null;
        if (/^(https?:|ftp:|mailto:|news:|data:)/i.test(ref) || ref.startsWith('//')) return { external: ref };
        let anchor = '';
        const hash = ref.indexOf('#');
        if (hash >= 0) {
            anchor = ref.slice(hash + 1);
            ref = ref.slice(0, hash);
        }
        // ms-its:file.chm::/page.htm, mk:@MSITStore:C:\dir\file.chm::/page.htm, its:..., file.chm::/page.htm
        const prefix = /^(ms-its:|its:|mk:@msitstore:)/i.exec(ref);
        if (prefix || ref.includes('::')) {
            const rest = prefix ? ref.slice(prefix[0].length) : ref;
            const sep = rest.indexOf('::');
            const inner = sep >= 0 ? rest.slice(sep + 2) : '';
            const chmName = safeDecode(sep >= 0 ? rest.slice(0, sep) : rest).replace(/\\/g, '/').split('/').pop();
            const innerPath = normalizePath(safeDecode(inner).replace(/\\/g, '/'));
            if (chmName && chmName.toLowerCase() !== this.name.toLowerCase()) {
                // Another help file: only if the page is in this one too (a renamed copy)
                const e = inner && this.chm.entry(innerPath);
                if (e) return { path: e.name, anchor };
                return { missing: `${chmName}::${inner || '/'}`, otherChm: chmName };
            }
            if (!inner || innerPath === '/') return this._defaultTopic();
            ref = innerPath;
            base = '/';
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) {
            return { external: ref + (hash >= 0 ? '#' + anchor : '') };
        }
        if (!ref) return { path: null, anchor, sameDoc: true };
        ref = ref.replace(/\?.*$/, '').replace(/\\/g, '/');
        const tryPath = p => {
            const n = normalizePath(p);
            const e = this.chm.entry(n);
            return e ? e.name : null;
        };
        const joined = ref.startsWith('/') ? ref : dirOf(base || '/') + ref;
        const path = tryPath(safeDecode(joined)) || tryPath(joined);
        if (!path) return { missing: normalizePath(safeDecode(joined)), anchor };
        return { path, anchor };
    }

    _defaultTopic() {
        const chm = this.chm;
        if (chm.system.defaultTopic) {
            const t = this._resolve(chm.system.defaultTopic, '/');
            if (t && t.path) return t;
        }
        if (this.firstTocTopic) return this.firstTocTopic;
        const f = chm.files.find(x => HTML_RE.test(x.name) && !x.name.startsWith('::') && x.length > 0);
        return f ? { path: f.name, anchor: '' } : null;
    }

    // --- Documents for the iframe ---

    _blobUrl(data, type) {
        const url = URL.createObjectURL(new Blob([data], { type }));
        this.blobUrls.add(url);
        return url;
    }

    _mode() {
        return (this.scripts ? 's' : '-') + (this.remote ? 'r' : '-');
    }

    // A URL the page can load for data of a type: blob: when the page is same-origin, else data:
    _dataUrl(data, type) {
        if (!this.scripts) return this._blobUrl(data, type);
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        return `data:${type}${typeof data === 'string' ? ';charset=utf-8' : ''};base64,` + bytesToBase64(bytes);
    }

    // URL of an archive file as a resource of a page
    _fileUrl(path, depth) {
        const key = this._mode() + '|' + path.toLowerCase();
        if (this.urls.has(key)) return this.urls.get(key);
        let url;
        const ext = extOf(path);
        try {
            if (ext === 'css') {
                url = this._dataUrl(this._rewriteCss(this.chm.decodeText(this.chm.read(path)), path, depth || 0), 'text/css');
            } else if (HTML_RE.test(path)) {
                url = this._docUrl(path, (depth || 0) + 1);
            } else {
                url = this._dataUrl(this.chm.read(path), mimeOf(path));
            }
        } catch (err) {
            url = null;
        }
        if (url) this.urls.set(key, url);
        return url;
    }

    _resourceUrl(ref, base, depth) {
        const t = this._resolve(ref, base);
        if (!t) return null;
        if (t.external) return /^data:/i.test(t.external) ? t.external : (this.remote ? t.external : null);
        if (!t.path) return null;
        const url = this._fileUrl(t.path, depth);
        return url && t.anchor && HTML_RE.test(t.path) ? url + '#' + t.anchor : url;
    }

    _rewriteCss(css, base, depth) {
        if (depth > 6) return css;
        const fix = (ref) => {
            ref = ref.trim().replace(/^["']|["']$/g, '');
            if (/^(data|blob):/i.test(ref)) return ref;
            const url = this._resourceUrl(ref, base, depth + 1);
            return url || 'about:invalid';
        };
        return css
            .replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi, (m, q, ref) => `@import url("${fix(ref)}")`)
            .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, q, ref) => `url("${fix(ref)}")`);
    }

    _csp() {
        const net = this.remote ? ' http: https:' : '';
        if (!this.scripts) {
            return `default-src 'none'; img-src blob: data:${net}; style-src blob: data: 'unsafe-inline'${net}; font-src blob: data:${net}; `
                + `media-src blob: data:${net}; frame-src blob:; script-src 'none'`;
        }
        return `default-src 'none'; img-src data:${net}; style-src data: 'unsafe-inline'${net}; font-src data:${net}; media-src data:${net}; `
            + `frame-src data:; script-src 'unsafe-inline' 'unsafe-eval' data:${net}; connect-src${this.remote ? net : " 'none'"}`;
    }

    // The page, its references pointing into the archive, as a URL for the iframe
    _docUrl(path, depth) {
        if (depth > MAX_FRAME_DEPTH) return null;
        const bytes = this.chm.read(path);
        const charset = sniffCharset(bytes) || this.chm.codepage;
        const text = decoderFor(charset).decode(bytes);
        const doc = new DOMParser().parseFromString(text, 'text/html');
        const title = doc.title && doc.title.trim();
        if (title && !this.titles.has(path.toLowerCase())) this.titles.set(path.toLowerCase(), title);
        const res = ref => this._resourceUrl(ref, path, depth);

        for (const e of doc.querySelectorAll('base, meta[http-equiv], meta[charset]')) {
            const he = (e.getAttribute('http-equiv') || '').toLowerCase();
            if (e.tagName === 'BASE' || e.hasAttribute('charset') || he === 'content-type' || he === 'refresh' || he === 'content-security-policy' || he === 'set-cookie') e.remove();
        }
        if (!this.scripts) {
            // Event handler attributes could not run anyway
            for (const e of doc.querySelectorAll('*')) {
                for (const a of [...e.attributes]) if (/^on/i.test(a.name)) e.removeAttribute(a.name);
            }
        }
        for (const e of doc.querySelectorAll('script, noscript')) {
            if (e.tagName === 'NOSCRIPT') { if (this.scripts) e.remove(); else e.replaceWith(...e.childNodes); continue; }
            if (!this.scripts) { e.remove(); continue; }
            if (e.hasAttribute('src')) {
                const u = res(e.getAttribute('src'));
                if (u) e.setAttribute('src', u); else e.removeAttribute('src');
            }
        }
        for (const e of doc.querySelectorAll('img[src], input[src], embed[src], audio[src], video[src], source[src], track[src], bgsound[src]')) {
            const u = res(e.getAttribute('src'));
            if (u) e.setAttribute('src', u); else e.removeAttribute('src');
        }
        for (const e of doc.querySelectorAll('frame[src], iframe[src]')) {
            const t = this._resolve(e.getAttribute('src'), path);
            let u = null;
            if (t && t.path) {
                u = this._fileUrl(t.path, depth);
                if (u && t.anchor) u += '#' + t.anchor;
            } else if (t && t.external && this.remote) {
                u = t.external;
            }
            e.setAttribute('src', u || 'about:blank');
        }
        for (const e of doc.querySelectorAll('[srcset]')) {
            const v = parseSrcset(e.getAttribute('srcset')).map(([u, d]) => { const r = res(u); return r ? r + d : null; }).filter(Boolean).join(', ');
            if (v) e.setAttribute('srcset', v); else e.removeAttribute('srcset');
        }
        for (const e of doc.querySelectorAll('[background]')) {
            const u = res(e.getAttribute('background'));
            if (u) e.setAttribute('background', u); else e.removeAttribute('background');
        }
        for (const e of doc.querySelectorAll('object[data]')) {
            const u = res(e.getAttribute('data'));
            if (u) e.setAttribute('data', u); else e.removeAttribute('data');
        }
        for (const e of doc.querySelectorAll('link[href]')) {
            const rel = (e.getAttribute('rel') || '').toLowerCase();
            if (/stylesheet|icon/.test(rel)) {
                const u = res(e.getAttribute('href'));
                if (u) e.setAttribute('href', u); else e.remove();
            } else {
                e.remove(); // prefetch, alternate, ...: nothing to load
            }
        }
        for (const e of doc.querySelectorAll('style')) e.textContent = this._rewriteCss(e.textContent, path, depth);
        for (const e of doc.querySelectorAll('[style]')) e.setAttribute('style', this._rewriteCss(e.getAttribute('style'), path, depth));

        const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.documentElement.firstChild);
        const csp = doc.createElement('meta');
        csp.setAttribute('http-equiv', 'Content-Security-Policy');
        csp.setAttribute('content', this._csp());
        const cs = doc.createElement('meta');
        cs.setAttribute('charset', 'utf-8');
        head.insertBefore(csp, head.firstChild);
        head.insertBefore(cs, head.firstChild);
        doc.documentElement.setAttribute('data-chm-path', path);
        if (this.scripts) {
            // Ours: tell the viewer about link clicks (the page is cross-origin to it)
            const s = doc.createElement('script');
            s.textContent = `(function(){var T=${JSON.stringify(this.token)},P=${JSON.stringify(path)};`
                + `document.addEventListener('click',function(e){if(e.defaultPrevented)return;var a=e.target&&e.target.closest&&e.target.closest('a[href],area[href]');if(!a)return;`
                + `var h=a.getAttribute('href');if(/^#/.test(h)||/^javascript:/i.test(h))return;e.preventDefault();top.postMessage({chmLink:T,href:h,base:P},'*');});})();`;
            head.insertBefore(s, csp.nextSibling);
        }
        const dt = doc.doctype;
        let doctype = '';
        if (dt) {
            doctype = '<!DOCTYPE ' + dt.name + (dt.publicId ? ` PUBLIC "${dt.publicId}"` : '') + (dt.systemId ? (dt.publicId ? '' : ' SYSTEM') + ` "${dt.systemId}"` : '') + '>\n';
        }
        const html = doctype + doc.documentElement.outerHTML;
        return this._dataUrl(html, 'text/html');
    }

    // A page of our own (an image, a file's text, a message), same rules as the topics
    _wrapUrl(title, bodyHtml) {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(this._csp())}">`
            + `<title>${escapeHtml(title)}</title><style>body{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:12px;color:#222}`
            + `pre{font:12px ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;margin:0}.err{color:#a33}`
            + `.img{background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px;display:inline-block}</style></head><body>${bodyHtml}</body></html>`;
        return this._dataUrl(html, 'text/html');
    }

    _rawUrl(path) {
        const bytes = this.chm.read(path);
        const mime = mimeOf(path);
        if (/^image\//.test(mime) && !/wmf|emf/.test(mime)) {
            return this._wrapUrl(path, `<div class="img"><img src="${escapeHtml(this._dataUrl(bytes, mime))}" alt=""></div><p>${escapeHtml(path)} · ${bytes.length} bytes</p>`);
        }
        if (isTextual(bytes)) {
            const text = decoderFor(sniffCharset(bytes) || this.chm.codepage).decode(bytes.subarray(0, 4 * 1024 * 1024));
            return this._wrapUrl(path, `<pre>${escapeHtml(text)}</pre>`);
        }
        return this._wrapUrl(path, `<pre>${escapeHtml(hexDump(bytes, 256 * 1024))}</pre>`);
    }

    // --- Navigation ---
    navigate(target, opts = {}) {
        if (!target) return;
        if (target.external) return this._openExternal(target.external);
        const cur = this.history[this.histPos];
        if (target.sameDoc) target = { path: cur ? cur.path : null, anchor: target.anchor };
        if (!opts.replace) {
            if (cur && cur.path === target.path && cur.anchor === target.anchor && !!cur.raw === !!target.raw && !target.missing) return;
            this.history.splice(this.histPos + 1);
            this.history.push(target);
            this.histPos = this.history.length - 1;
        }
        this._show(target, cur);
        this._updateNav();
    }

    _go(delta) {
        const pos = this.histPos + delta;
        if (pos < 0 || pos >= this.history.length) return;
        const cur = this.history[this.histPos];
        this.histPos = pos;
        this._show(this.history[pos], cur);
        this._updateNav();
    }

    _updateNav() {
        this.backBtn.disabled = this.histPos <= 0;
        this.fwdBtn.disabled = this.histPos >= this.history.length - 1;
    }

    _show(target, prev) {
        let url;
        let label;
        if (target.missing) {
            label = target.missing;
            url = this._wrapUrl('Not found', target.otherChm
                ? `<p class="err">This link points into another help file, ${escapeHtml(target.otherChm)}, which is not open:</p><pre>${escapeHtml(target.missing)}</pre>`
                : `<p class="err">This page is not in the help file:</p><pre>${escapeHtml(target.missing)}</pre>`);
        } else {
            try {
                url = target.raw ? this._rawUrl(target.path) : this._fileUrl(target.path, 0);
                if (!url) throw new Error('could not be read');
            } catch (err) {
                url = this._wrapUrl('Error', `<p class="err">Could not show ${escapeHtml(target.path)}:</p><pre>${escapeHtml(err.message)}</pre>`);
            }
            label = target.path;
        }
        const key = target.path && target.path.toLowerCase();
        const title = key && this.titles.get(key);
        this.showing.textContent = '';
        if (title) {
            this.showing.appendChild(el('b', null, title));
            this.showing.appendChild(document.createTextNode('  ' + label + (target.anchor ? '#' + target.anchor : '')));
        } else {
            this.showing.textContent = label + (target.anchor ? '#' + target.anchor : '');
        }
        this.showing.title = this.showing.textContent;
        // The same page: only scroll to the anchor
        const samePage = prev && !target.raw && !prev.raw && prev.path === target.path && this.frame.dataset.base === url;
        this.frame.dataset.base = url;
        this.pendingAnchor = target.anchor || '';
        if (samePage) this._scrollTo(this.pendingAnchor);
        else this._load(url + (target.anchor ? '#' + target.anchor : ''));
        this._syncToc(target);
        for (const tr of this.fileRows.values()) tr.classList.remove('sel');
        const row = key && this.fileRows.get(key);
        if (row) row.classList.add('sel');
    }

    // Show a URL in the iframe without adding to the browser's history (Back there would page the iframe)
    _load(url) {
        try {
            this.frame.contentWindow.location.replace(url);
        } catch (e) {
            this.frame.src = url;
        }
    }

    _scrollTo(anchor) {
        if (this.scripts) {
            // Cross-origin: set the fragment
            this._load(this.frame.dataset.base + '#' + anchor);
            return;
        }
        const doc = this.frame.contentDocument;
        if (!doc) return;
        if (!anchor) { doc.documentElement.scrollTop = 0; if (doc.body) doc.body.scrollTop = 0; return; }
        const t = doc.getElementById(anchor) || doc.getElementsByName(anchor)[0] || doc.getElementById(safeDecode(anchor));
        if (t) t.scrollIntoView();
    }

    _openExternal(url) {
        if (/^(https?:|ftp:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    }

    // Same-origin pages (no scripts): handle their link clicks here
    _frameLoaded() {
        if (this.scripts) return;
        let doc;
        try { doc = this.frame.contentDocument; } catch (e) { return; }
        if (doc) this._hookDoc(doc, 0);
    }

    _hookDoc(doc, depth) {
        if (!doc || doc._chmHooked || depth > MAX_FRAME_DEPTH) return;
        doc._chmHooked = true;
        doc.addEventListener('click', e => {
            const a = e.target && e.target.closest && e.target.closest('a[href], area[href]');
            if (!a) return;
            e.preventDefault();
            const base = doc.documentElement.getAttribute('data-chm-path') || '/';
            this._link(a.getAttribute('href'), base, doc);
        }, true);
        for (const f of doc.querySelectorAll('frame, iframe')) {
            const hook = () => { try { this._hookDoc(f.contentDocument, depth + 1); } catch (e) { /* not ours */ } };
            f.addEventListener('load', hook);
            hook();
        }
    }

    _link(href, base, doc) {
        const t = this._resolve(href, base);
        if (!t) return;
        if (t.external) return this._openExternal(t.external);
        const cur = this.history[this.histPos];
        // An anchor in a frame of a frameset: scroll that frame
        if ((t.sameDoc || (t.path && t.path === base)) && doc && cur && base !== cur.path) {
            const el2 = doc.getElementById(t.anchor) || doc.getElementsByName(t.anchor)[0];
            if (el2) el2.scrollIntoView();
            return;
        }
        if (t.sameDoc) return this.navigate({ path: base, anchor: t.anchor });
        this.navigate(t);
    }

    _message(e) {
        const d = e.data;
        if (!d || d.chmLink !== this.token || !this.scripts) return;
        this._link(String(d.href || ''), String(d.base || '/'), null);
    }

    _showMessage(text) {
        this.frame.dataset.base = '';
        this._load(this._wrapUrl('Message', `<p class="err">${escapeHtml(text)}</p>`));
    }

    destroy() {
        window.removeEventListener('message', this._onMessage);
        if (this.frame) this.frame.src = 'about:blank';
        this._revokeAll();
        this.host.textContent = '';
    }
}

export function mountChmViewer(host, opts) {
    return new ChmViewer(host, opts);
}
