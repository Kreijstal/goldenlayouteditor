// Windows Help (.hlp) viewer, loaded on demand by src/hlp-plugin.js.
// hlp-parse.js reads WinHelp 3.0/3.1/4.0 files; this shows them like WinHelp
// did: the help title, the contents topic first, the topic with its fonts,
// colours, alignment, indents, tab stops, tables, bitmaps (with hotspots) and
// metafiles (wmf.js), the non-scrolling region above the scrolling one, jumps
// followed inside the tab with back/forward, popups in a box, browse
// sequences, a topic list and the keyword index with a filter, and the
// internal files for debugging. Macros and jumps into other help files are
// shown but not run. OS/2 help (IPF, "HSP") goes to ipf-parse.js; other files
// named .hlp get a message (plain text ones are shown as text). Read-only.
import { WinHelpFile, HelpFormatError, detectHelpFormat, bestPicture, parsePictures, contextHash, ENCODINGS } from './hlp-parse.js';
import { renderWmf } from './wmf.js';

const PT = 96 / 72; // CSS px per point
const DEFAULT_TAB = 36; // points (half an inch)

function installStyles() {
    if (document.getElementById('hlp-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'hlp-viewer-style';
    style.textContent = `
.hlpv{height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0;position:relative}
.hlpv-bar{display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid #ddd;background:#f6f8fa;flex-shrink:0;flex-wrap:wrap}
.hlpv-bar button{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 9px;font:inherit;cursor:pointer;color:#333}
.hlpv-bar button:disabled{opacity:.45;cursor:default}
.hlpv-bar button.active{background:#2d333b;color:#fff;border-color:#2d333b}
.hlpv-bar select{font:inherit;font-size:12px;padding:1px 2px;border:1px solid #ccc;border-radius:4px;background:#fff;max-width:130px}
.hlpv-title{font-weight:600;margin-left:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 120px}
.hlpv-warn{padding:5px 10px;background:#fff8c5;border-bottom:1px solid #d4a72c;color:#6f4e00;font-size:12px;flex-shrink:0;max-height:70px;overflow:auto}
.hlpv-main{flex:1;min-height:0;display:flex;position:relative}
.hlpv-side{width:260px;flex-shrink:0;border-right:1px solid #ddd;display:flex;flex-direction:column;min-height:0;background:#fafafa}
.hlpv-side[hidden]{display:none}
.hlpv-tabs{display:flex;border-bottom:1px solid #ddd;flex-shrink:0}
.hlpv-tabs button{flex:1;border:none;background:none;padding:5px 4px;font:inherit;font-size:12px;cursor:pointer;color:#555;border-bottom:2px solid transparent}
.hlpv-tabs button.active{color:#0969da;border-bottom-color:#0969da;font-weight:600}
.hlpv-search{display:flex;gap:6px;align-items:center;padding:5px 6px;border-bottom:1px solid #eee;flex-shrink:0;flex-wrap:wrap}
.hlpv-search input[type=search]{flex:1;min-width:0;font:inherit;padding:3px 6px;border:1px solid #ccc;border-radius:4px}
.hlpv-search label{font-size:11px;color:#666;white-space:nowrap}
.hlpv-list{flex:1;overflow:auto;min-height:0;font-size:12px}
.hlpv-item{padding:3px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #f0f0f0}
.hlpv-item:hover{background:#eef3f8}
.hlpv-item.sel{background:#ddf4ff}
.hlpv-item.untitled{color:#888;font-style:italic}
.hlpv-sub{padding-left:22px;color:#0969da}
.hlpv-count{padding:4px 8px;color:#777;font-size:11px}
.hlpv-pane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;position:relative}
.hlpv-nsr{flex-shrink:0;max-height:45%;overflow:auto;border-bottom:1px solid #c8c8c8;padding:4px 10px}
.hlpv-nsr:empty{display:none}
.hlpv-sr{flex:1;min-height:0;overflow:auto;padding:4px 10px 24px}
.hlpv-doc{color:#000;font-family:Arial,"Helvetica Neue",Helvetica,sans-serif;font-size:10pt;line-height:normal}
.hlpv-p{margin:0;white-space:pre-wrap;overflow-wrap:break-word}
.hlpv-tab{display:inline-block;width:0}
.hlpv-link{cursor:pointer}
.hlpv-jump{color:#008000;text-decoration:underline}
.hlpv-popup{color:#008000;text-decoration:underline dotted}
.hlpv-jump span,.hlpv-popup span{color:inherit!important}
.hlpv-inert{cursor:help}
.hlpv-inert.hlpv-jump,.hlpv-inert.hlpv-popup{color:#6a6a6a}
.hlpv-link:focus-visible{outline:1px dotted #000}
.hlpv-img{display:inline-block;position:relative;vertical-align:baseline;line-height:0;max-width:100%}
.hlpv-img img,.hlpv-img canvas{display:block;max-width:100%;height:auto}
.hlpv-img.left{float:left;margin:0 8px 4px 0}
.hlpv-img.right{float:right;margin:0 0 4px 8px}
.hlpv-hot{position:absolute;display:block;cursor:pointer}
.hlpv-hot:hover{outline:1px dotted #008000;background:#00800010}
.hlpv-missing{display:inline-block;border:1px dashed #bbb;color:#888;font:11px sans-serif;padding:2px 6px;background:#f6f6f6}
.hlpv-embed{display:inline-block;border:1px dashed #bbb;color:#666;font:11px sans-serif;padding:2px 6px;margin:1px;background:#f6f6f6;white-space:normal}
.hlpv-button{font:inherit;font-size:9pt;padding:1px 8px;margin:1px}
.hlpv-table{border-collapse:collapse;table-layout:fixed;margin:0}
.hlpv-table td{vertical-align:top;padding:0;overflow-wrap:break-word}
.hlpv-err{color:#a33;font:12px sans-serif;padding:4px}
.hlpv-pop{position:absolute;z-index:20;background:#ffffe8;border:1px solid #777;box-shadow:2px 3px 10px #0004;max-width:min(460px,90%);max-height:60%;overflow:auto;padding:6px 10px;border-radius:2px}
.hlpv-note{position:absolute;z-index:21;left:50%;bottom:14px;transform:translateX(-50%);background:#2d333b;color:#fff;padding:6px 12px;border-radius:5px;font-size:12px;max-width:90%;box-shadow:0 2px 8px #0005}
.hlpv-msg{padding:24px;color:#444;line-height:1.5;max-width:720px}
.hlpv-msg h3{margin:0 0 8px;font-size:15px}
.hlpv-msg pre{background:#f6f8fa;border:1px solid #ddd;padding:8px;overflow:auto;font:12px ui-monospace,monospace;max-height:60vh;white-space:pre-wrap}
.hlpv-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;font-size:12px;padding:6px 8px;border-bottom:1px solid #eee}
.hlpv-kv span:nth-child(odd){color:#666}
.hlpv-kv span:nth-child(even){word-break:break-word}
.hlpv-files{border-collapse:collapse;width:100%;font-size:12px}
.hlpv-files th,.hlpv-files td{padding:2px 6px;text-align:left;border-bottom:1px solid #eee;white-space:nowrap}
.hlpv-files td.num{text-align:right;font-variant-numeric:tabular-nums}
.hlpv-files th{position:sticky;top:0;background:#f2f2f2}
.hlpv-files tr{cursor:pointer}
.hlpv-files tr:hover td{background:#eef3f8}
.hlpv-hex{font:12px ui-monospace,monospace;white-space:pre;margin:0}
.hlpv-pics{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
.hlpv-pics figure{margin:0;border:1px solid #ddd;padding:6px;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}
.hlpv-pics figcaption{font:11px sans-serif;color:#555;margin-top:4px;background:#fff}
@media (max-width:640px){
 .hlpv-side{position:absolute;inset:0;width:auto;z-index:5;border-right:none}
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

const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

// Windows 3.x font names the browser won't know
const FACE_ALIASES = {
    helv: 'Arial', 'ms sans serif': '"MS Sans Serif", Arial', 'tms rmn': '"Times New Roman"', 'ms serif': '"Times New Roman"',
    courier: '"Courier New"', system: 'Arial', modern: '"Courier New"', roman: '"Times New Roman"', script: 'cursive',
};
const GENERIC = { modern: 'monospace', roman: 'serif', swiss: 'sans-serif', script: 'cursive', decorative: 'fantasy' };
function fontFamily(f) {
    const face = (f.face || '').trim();
    const alias = FACE_ALIASES[face.toLowerCase()];
    const parts = [];
    if (face) parts.push(`"${face.replace(/"/g, '')}"`);
    if (alias) parts.push(alias);
    parts.push(GENERIC[f.family] || 'sans-serif');
    return parts.join(', ');
}

function hexDump(bytes, max = 2048) {
    const lines = [];
    const n = Math.min(bytes.length, max);
    for (let i = 0; i < n; i += 16) {
        const row = bytes.subarray(i, Math.min(n, i + 16));
        const hex = Array.from(row, b => b.toString(16).padStart(2, '0')).join(' ');
        const asc = Array.from(row, b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        lines.push(i.toString(16).padStart(8, '0') + '  ' + hex.padEnd(48) + ' ' + asc);
    }
    if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
    return lines.join('\n');
}

// Macros WinHelp would run that just move between topics
function parseMacroJump(macro) {
    const m = /^\s*(JumpId|JI|PopupId|PI|JumpContents|Contents|JumpHash|JH|PopupHash|PopupContext|PC|JumpContext|JC|Back|Next|Prev)\s*\((.*)\)\s*;?\s*$/i.exec(macro || '');
    if (!m) return null;
    const name = m[1].toLowerCase();
    const args = [];
    m[2].replace(/"((?:[^"\\]|\\.)*)"|`((?:[^'\\]|\\.)*)'|([^,\s][^,]*)/g, (_, a, b, c) => { args.push(a != null ? a : b != null ? b : c.trim()); });
    const popup = name === 'popupid' || name === 'pi' || name === 'popuphash' || name === 'popupcontext' || name === 'pc';
    if (name === 'contents' || name === 'jumpcontents') return { contents: true, file: args[0] || '' };
    if (name === 'back' || name === 'next' || name === 'prev') return { nav: name };
    if (name === 'jumphash' || name === 'jh' || name === 'popuphash') return { file: args[0] || '', hash: Number(args[1]) >>> 0, popup };
    if (name === 'jumpcontext' || name === 'jc' || name === 'popupcontext' || name === 'pc') return { file: args[0] || '', mapId: Number(args[1]), popup };
    return { file: args[0] || '', context: args[1] || '', popup };
}

class HlpViewer {
    constructor(host, { bytes, name }) {
        installStyles();
        this.host = host;
        this.name = name || '';
        this.bytes = bytes;
        this.root = el('div', 'hlpv');
        host.appendChild(this.root);
        this.history = [];
        this.histPos = -1;
        this.bitmapUrls = new Map();
        this.objectUrls = [];
        this.sideTab = 'topics';
        this.format = detectHelpFormat(bytes);
        this.ready = this._open();
    }

    get info() {
        const h = this.help;
        if (h) return { format: 'winhelp', title: h.title, version: h.version, topics: h.topics.length, warnings: h.warnings.length };
        if (this.ipf) return { format: 'ipf', title: this.ipf.title, version: 'OS/2 IPF', topics: this.ipf.topics.length };
        return { format: this.format, error: this.error };
    }

    async _open() {
        if (this.format === 'winhelp') {
            try {
                this.help = new WinHelpFile(this.bytes);
            } catch (err) {
                this.error = err.message;
                this._message('This help file can’t be read', (err instanceof HelpFormatError ? '' : 'Unexpected error: ') + err.message, true);
                return;
            }
            this._build();
            this._go(this.help.contentsTopic(), { replace: true });
            return;
        }
        if (this.format === 'ipf') {
            let mod;
            try {
                mod = await import('./ipf-parse.js');
                this.ipf = mod.parseIpf(this.bytes);
            } catch (err) {
                this.error = err.message;
                this._message('OS/2 help file (IPF)', 'This is an OS/2 Information Presentation Facility file (.hlp/.inf, magic “HSP”), not Windows Help. It could not be read: ' + err.message, true);
                return;
            }
            this._buildIpf();
            return;
        }
        if (this.format === 'text') {
            this.error = 'not a Windows Help file';
            const box = this._message('Plain-text help file', 'This .hlp file is plain text (help for a text-mode or Unix program), not a Windows Help file. Its text:');
            const pre = el('pre');
            pre.textContent = new TextDecoder('windows-1252').decode(this.bytes.subarray(0, 2 * 1024 * 1024));
            box.appendChild(pre);
            return;
        }
        this.error = 'unknown format';
        const what = this.format === 'quickhelp' ? 'This looks like a Microsoft QuickHelp file (DOS programs such as QBasic and EDIT, magic “LN”), which this viewer does not read.'
            : 'This file is not a Windows Help file (WinHelp files start with 3F 5F 03 00) nor OS/2 help (“HSP”). The first bytes:';
        const box = this._message('Not a Windows Help file', what);
        const pre = el('pre');
        pre.textContent = hexDump(this.bytes, 512);
        box.appendChild(pre);
    }

    _message(title, text, isError) {
        this.root.textContent = '';
        const box = el('div', 'hlpv-msg');
        box.appendChild(el('h3', null, title));
        const p = el('p', null, text);
        if (isError) p.style.color = '#a33';
        box.appendChild(p);
        this.root.appendChild(box);
        return box;
    }

    // --- layout ---
    _build() {
        const h = this.help;
        this.root.textContent = '';
        const bar = el('div', 'hlpv-bar');
        const btn = (label, title, fn) => { const b = el('button', null, label); b.type = 'button'; b.title = title; b.onclick = fn; bar.appendChild(b); return b; };
        this.sideBtn = btn('☰', 'Show or hide the topic list and index', () => this._toggleSide());
        btn('Contents', 'Go to the contents topic', () => this._go(h.contentsTopic()));
        btn('Index', 'Show the keyword index', () => { this._showSide(true); this._setSideTab('index'); this.searchInput.focus(); });
        this.backBtn = btn('◀ Back', 'Back (Alt+Left)', () => this._step(-1));
        this.fwdBtn = btn('Forward ▶', 'Forward (Alt+Right)', () => this._step(1));
        this.prevBtn = btn('<<', 'Previous topic in the browse sequence', () => this._browse(-1));
        this.nextBtn = btn('>>', 'Next topic in the browse sequence', () => this._browse(1));
        this.titleEl = el('span', 'hlpv-title');
        bar.appendChild(this.titleEl);
        const enc = el('select');
        enc.title = 'Text encoding';
        for (const e of new Set([h.encoding, ...ENCODINGS])) { const o = el('option', null, e); o.value = e; enc.appendChild(o); }
        enc.value = h.encoding;
        enc.onchange = () => this._reencode(enc.value);
        bar.appendChild(enc);
        this.root.appendChild(bar);
        this._fillTitle();

        if (h.warnings.length) {
            const w = el('div', 'hlpv-warn');
            for (const msg of h.warnings) w.appendChild(el('div', null, msg));
            this.root.appendChild(w);
            this.warnEl = w;
        }

        const main = el('div', 'hlpv-main');
        this.side = el('div', 'hlpv-side');
        const tabs = el('div', 'hlpv-tabs');
        this.tabBtns = {};
        for (const [id, label] of [['topics', 'Topics'], ['index', 'Index'], ['files', 'Files']]) {
            const b = el('button', null, label);
            b.type = 'button';
            b.onclick = () => this._setSideTab(id);
            tabs.appendChild(b);
            this.tabBtns[id] = b;
        }
        const search = el('div', 'hlpv-search');
        this.searchInput = el('input');
        this.searchInput.type = 'search';
        this.searchInput.oninput = () => this._renderSide();
        this.searchInput.onkeydown = e => {
            if (e.key === 'Enter') { const first = this.listEl.querySelector('.hlpv-item'); if (first) first.click(); }
        };
        this.fullText = el('input');
        this.fullText.type = 'checkbox';
        this.fullText.onchange = () => this._renderSide();
        this.fullTextLabel = el('label');
        this.fullTextLabel.append(this.fullText, ' in text');
        this.untitled = el('input');
        this.untitled.type = 'checkbox';
        this.untitled.onchange = () => this._renderSide();
        this.untitledLabel = el('label');
        this.untitledLabel.append(this.untitled, ' untitled');
        search.append(this.searchInput, this.fullTextLabel, this.untitledLabel);
        this.listEl = el('div', 'hlpv-list');
        this.side.append(tabs, search, this.listEl);

        this.pane = el('div', 'hlpv-pane');
        this.nsr = el('div', 'hlpv-nsr hlpv-doc');
        this.sr = el('div', 'hlpv-sr hlpv-doc');
        this.pane.append(this.nsr, this.sr);
        const mw = h.mainWindow;
        if (mw && mw.rgb) this.sr.style.background = rgb(mw.rgb);
        if (mw && mw.rgbNsr) this.nsr.style.background = rgb(mw.rgbNsr);
        main.append(this.side, this.pane);
        this.root.appendChild(main);
        this.main = main;
        if (this.host.clientWidth && this.host.clientWidth < 640) this.side.hidden = true;
        this._setSideTab('topics');

        this.root.tabIndex = -1;
        this.root.addEventListener('keydown', this._onKey = e => {
            if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); this._step(-1); }
            else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); this._step(1); }
            else if (e.key === 'Escape') this._closePopup();
        });
        this._onDocDown = e => { if (this.popup && !this.popup.contains(e.target)) this._closePopup(); };
        document.addEventListener('mousedown', this._onDocDown, true);
        this._resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._layoutTabs(this.pane)) : null;
        if (this._resizeObs) this._resizeObs.observe(this.pane);
    }

    _fillTitle() {
        const h = this.help;
        this.titleEl.textContent = h.title || this.name;
        this.titleEl.title = [h.title, h.copyright].filter(Boolean).join('\n');
    }

    _toggleSide() { this._showSide(this.side.hidden); }
    _showSide(on) { this.side.hidden = !on; this.sideBtn.classList.toggle('active', on); }

    _setSideTab(id) {
        this.sideTab = id;
        for (const [k, b] of Object.entries(this.tabBtns)) b.classList.toggle('active', k === id);
        this.searchInput.placeholder = id === 'index' ? 'Type a keyword' : id === 'files' ? 'Filter internal files' : 'Filter topics';
        this.fullTextLabel.hidden = id !== 'topics';
        this.untitledLabel.hidden = id !== 'topics';
        this._renderSide();
    }

    _renderSide() {
        const q = this.searchInput.value.trim().toLowerCase();
        this.listEl.textContent = '';
        if (this.sideTab === 'topics') this._renderTopicList(q);
        else if (this.sideTab === 'index') this._renderIndex(q);
        else this._renderFiles(q);
    }

    _topicLabel(t) {
        return t.title || `(untitled topic ${t.index + 1})`;
    }

    _renderTopicList(q) {
        const h = this.help;
        const showUntitled = this.untitled.checked || !h.topics.some(t => t.title);
        let topics = h.topics.filter(t => showUntitled || t.title);
        if (q) {
            if (this.fullText.checked) {
                if (!this._texts) this._texts = new Map();
                topics = topics.filter(t => {
                    if (t.title.toLowerCase().includes(q)) return true;
                    let s = this._texts.get(t);
                    if (s == null) { try { s = h.topicText(t).toLowerCase(); } catch { s = ''; } this._texts.set(t, s); }
                    return s.includes(q);
                });
            } else topics = topics.filter(t => this._topicLabel(t).toLowerCase().includes(q));
        }
        const frag = document.createDocumentFragment();
        const max = 3000;
        for (const t of topics.slice(0, max)) {
            const it = el('div', 'hlpv-item' + (t.title ? '' : ' untitled') + (this.current === t ? ' sel' : ''), this._topicLabel(t));
            it.title = this._topicLabel(t);
            it.onclick = () => { this._go(t); if (this.host.clientWidth < 640) this._showSide(false); };
            frag.appendChild(it);
        }
        this.listEl.appendChild(el('div', 'hlpv-count', `${topics.length} of ${h.topics.length} topics` + (topics.length > max ? ` (first ${max} shown)` : '')));
        this.listEl.appendChild(frag);
    }

    _renderIndex(q) {
        const h = this.help;
        if (!this._keywords) {
            try { this._keywords = h.keywords('K'); } catch (err) { this._keywords = []; this._kwError = err.message; }
        }
        const kws = this._keywords;
        if (!kws.length) {
            this.listEl.appendChild(el('div', 'hlpv-count', this._kwError ? 'The keyword index can’t be read: ' + this._kwError : 'This help file has no keyword index.'));
            return;
        }
        // WinHelp jumps to the first keyword starting with what was typed; matches elsewhere follow
        let list = kws;
        if (q) {
            const starts = kws.filter(k => k.keyword.toLowerCase().startsWith(q));
            const inner = kws.filter(k => !k.keyword.toLowerCase().startsWith(q) && k.keyword.toLowerCase().includes(q));
            list = starts.concat(inner);
        }
        this.listEl.appendChild(el('div', 'hlpv-count', `${list.length} of ${kws.length} keywords`));
        const frag = document.createDocumentFragment();
        for (const k of list.slice(0, 3000)) {
            const it = el('div', 'hlpv-item', k.keyword + (k.offsets.length > 1 ? `  (${k.offsets.length})` : ''));
            it.title = k.keyword;
            it.onclick = () => {
                const topics = k.offsets.map(o => ({ o, t: h.topicByOffset(o) })).filter(x => x.t);
                if (topics.length === 1) { this._go(topics[0].t, { offset: topics[0].o }); if (this.host.clientWidth < 640) this._showSide(false); return; }
                // Several topics: list them under the keyword (WinHelp's "Topics Found")
                if (it._open) { it._open.forEach(x => x.remove()); it._open = null; return; }
                it._open = topics.map(({ o, t }) => {
                    const sub = el('div', 'hlpv-item hlpv-sub', this._topicLabel(t));
                    sub.onclick = () => { this._go(t, { offset: o }); if (this.host.clientWidth < 640) this._showSide(false); };
                    return sub;
                });
                it.after(...it._open);
            };
            frag.appendChild(it);
        }
        this.listEl.appendChild(frag);
    }

    _renderFiles(q) {
        const h = this.help;
        const kv = el('div', 'hlpv-kv');
        const add = (k, v) => { if (v == null || v === '') return; kv.append(el('span', null, k), el('span', null, String(v))); };
        add('Title', h.title);
        add('Copyright', h.copyright);
        add('Format', `WinHelp ${h.version} (|SYSTEM ${h.major}.${h.minor}, flags 0x${h.flags.toString(16)})`);
        if (h.genDate) add('Compiled', new Date(h.genDate * 1000).toISOString().slice(0, 19).replace('T', ' '));
        add('Topic blocks', `${h.topicBlockSize / 1024} KB, ${h.compressed ? 'LZ77-compressed' : 'not compressed'}`);
        add('Phrases', h.phraseMode ? `${h.phrases.count} (${h.phraseMode === 'hall' ? 'Hall compression' : '|Phrases'})` : 'none');
        add('Topics', h.topics.length);
        add('Context ids', h.contextMap.size || (h.toMap ? `${h.toMap.length} topic numbers (|TOMAP)` : 0));
        add('Fonts', h.fonts.length);
        add('Encoding', h.encoding + (h.charset != null ? ` (charset ${h.charset})` : '') + (h.lcid != null ? `, LCID 0x${h.lcid.toString(16)}` : ''));
        if (h.cntFile) add('Contents file', h.cntFile);
        for (const w of h.windows) add('Window', `${w.name || w.type || '?'}${w.caption ? ' “' + w.caption + '”' : ''}${w.rgb ? ' bg ' + rgb(w.rgb) : ''}${w.rgbNsr ? ' nsr ' + rgb(w.rgbNsr) : ''}`);
        h.configMacros.forEach(m => add('Startup macro', m));
        add('Internal files', `${h.fileList.length}, ${fmtSize(h.bytes.length)} in all`);
        this.listEl.appendChild(kv);
        const table = el('table', 'hlpv-files');
        const head = el('tr');
        for (const c of ['Internal file', 'Size', 'Offset']) head.appendChild(el('th', null, c));
        table.appendChild(head);
        for (const f of h.fileList) {
            if (q && !f.name.toLowerCase().includes(q)) continue;
            const tr = el('tr');
            tr.append(el('td', null, f.name), Object.assign(el('td', 'num', f.ok ? fmtSize(f.used) : 'truncated'), { title: `${f.used} bytes used, ${f.reserved} reserved` }), el('td', 'num', '0x' + f.offset.toString(16)));
            tr.onclick = () => this._showInternalFile(f);
            table.appendChild(tr);
        }
        this.listEl.appendChild(table);
    }

    // The debug view of one internal file: pictures for |bmN, else a hex dump
    _showInternalFile(f) {
        const h = this.help;
        this._closePopup();
        this.current = null;
        this.nsr.textContent = '';
        this.sr.textContent = '';
        this.sr.appendChild(el('h3', null, `${f.name} — ${f.used} bytes at 0x${f.offset.toString(16)}`));
        const data = h.bytes.subarray(f.start, f.end);
        const bm = /^\|?bm(\d+)$/.exec(f.name);
        if (bm) {
            const r = h.bitmapFile(+bm[1]);
            if (r.error) this.sr.appendChild(el('div', 'hlpv-err', r.error));
            else {
                const box = el('div', 'hlpv-pics');
                r.pictures.forEach((p, i) => {
                    const fig = el('figure');
                    if (p.type === 'error') fig.appendChild(el('div', 'hlpv-err', p.error));
                    else fig.appendChild(this._pictureElement(p, { key: `${f.name}#${i}` }));
                    const desc = p.type === 'wmf' ? `metafile ${p.width}×${p.height} (0.01 mm)` : p.type === 'error' ? '' : `${p.type.toUpperCase()} ${p.width}×${p.height}, ${p.bpp} bit${p.xdpi ? ', ' + p.xdpi + ' dpi' : ''}`;
                    fig.appendChild(el('figcaption', null, `#${i + 1} ${desc}${p.packing != null ? ', packing ' + ['none', 'RLE', 'LZ77', 'LZ77+RLE'][p.packing] : ''}${p.hotspots && p.hotspots.length ? `, ${p.hotspots.length} hotspots` : ''}`));
                    box.appendChild(fig);
                });
                this.sr.appendChild(box);
            }
        }
        const pre = el('pre', 'hlpv-hex');
        pre.textContent = hexDump(data, bm ? 512 : 4096);
        this.sr.appendChild(pre);
        this.sr.scrollTop = 0;
        this._updateNav();
    }

    // --- navigation ---
    _go(topic, opts = {}) {
        if (!topic) return this._note('That topic is not in this help file.');
        this._closePopup();
        const entry = { topic, offset: opts.offset };
        if (!opts.fromHistory) {
            if (this.histPos >= 0) this.history[this.histPos].scroll = this.sr.scrollTop;
            this.history.splice(this.histPos + 1);
            this.history.push(entry);
            this.histPos = this.history.length - 1;
        }
        this.current = topic;
        this._renderTopic(topic, this.nsr, this.sr);
        let scroll = 0;
        if (opts.fromHistory && opts.scroll != null) scroll = opts.scroll;
        else if (opts.offset != null && opts.offset !== topic.offset) {
            const target = opts.offset >>> 0;
            let best = null;
            for (const node of this.sr.querySelectorAll('[data-off]')) if (+node.dataset.off <= target) best = node;
            if (best) scroll = best.offsetTop - this.sr.offsetTop;
        }
        this.sr.scrollTop = scroll;
        this._updateNav();
        if (this.sideTab === 'topics') {
            for (const it of this.listEl.querySelectorAll('.hlpv-item.sel')) it.classList.remove('sel');
        }
    }

    _step(dir) {
        const i = this.histPos + dir;
        if (i < 0 || i >= this.history.length) return;
        this.history[this.histPos].scroll = this.sr.scrollTop;
        this.histPos = i;
        const e = this.history[i];
        this._go(e.topic, { fromHistory: true, scroll: e.scroll, offset: e.offset });
    }

    _browse(dir) {
        if (!this.current) return;
        const t = this.help.browse(this.current, dir);
        if (t) this._go(t);
    }

    _updateNav() {
        this.backBtn.disabled = this.histPos <= 0;
        this.fwdBtn.disabled = this.histPos >= this.history.length - 1;
        const cur = this.current;
        this.prevBtn.disabled = !cur || !this.help.browse(cur, -1);
        this.nextBtn.disabled = !cur || !this.help.browse(cur, 1);
        this.titleEl.textContent = (this.help.title || this.name) + (cur && cur.title ? ' — ' + cur.title : '');
    }

    _reencode(enc) {
        const keep = this.current ? this.current.index : null;
        try {
            this.help = new WinHelpFile(this.bytes, { encoding: enc });
        } catch (err) {
            return this._note('Could not re-read the file: ' + err.message);
        }
        this._keywords = null;
        this._texts = null;
        this.bitmapUrls.clear();
        this.history = [];
        this.histPos = -1;
        this._fillTitle();
        this._renderSide();
        this._go(keep != null ? this.help.topics[keep] : this.help.contentsTopic());
    }

    // Where a link leads: { topic, offset } or { note }
    _resolve(item) {
        const h = this.help;
        if (item.file) {
            const own = this.name && item.file.replace(/^.*[\\/]/, '').toLowerCase() === this.name.toLowerCase();
            if (!own) return { note: `Jumps to a topic in ${item.file}, another help file — not opened here.` };
        }
        if (item.topicNumber != null) {
            const t = h.topicByNumber(item.topicNumber);
            return t ? { topic: t } : { note: `Topic number ${item.topicNumber} is not in this file.` };
        }
        if (item.hash != null) {
            const r = h.topicByHash(item.hash);
            if (r && r.topic) return { topic: r.topic, offset: r.offset };
            if (h.hc30) { const t = h.topicByNumber(item.hash); if (t) return { topic: t }; }
            return { note: 'The target topic of this link is not in this help file.' };
        }
        if (item.context != null) {
            const r = h.topicByHash(contextHash(item.context));
            return r && r.topic ? { topic: r.topic, offset: r.offset } : { note: `Context “${item.context}” is not in this help file.` };
        }
        return { note: 'This link leads nowhere.' };
    }

    _activate(item, anchor, ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        if (item.kind === 'macro') {
            const j = parseMacroJump(item.macro);
            if (j) {
                if (j.nav === 'back') return this._step(-1);
                if (j.nav === 'next') return this._browse(1);
                if (j.nav === 'prev') return this._browse(-1);
                if (j.file && !(this.name && j.file.replace(/^.*[\\/]/, '').toLowerCase() === this.name.toLowerCase())) return this._note(`Macro not run: ${item.macro} (another help file)`);
                if (j.contents) return this._go(this.help.contentsTopic());
                let target;
                if (j.mapId != null) {
                    const off = this.help.ctxoMap.get(j.mapId);
                    target = off != null ? { topic: this.help.topicByOffset(off), offset: off } : { note: `Map id ${j.mapId} is not in this file.` };
                } else target = this._resolve(j);
                return this._follow(target, j.popup, anchor);
            }
            return this._note(`Macro not run: ${item.macro}`);
        }
        this._follow(this._resolve(item), item.kind === 'popup', anchor, item.window);
    }

    _follow(target, popup, anchor) {
        if (!target || target.note || !target.topic) return this._note((target && target.note) || 'That topic is not in this help file.');
        if (popup) this._openPopup(target.topic, anchor);
        else this._go(target.topic, { offset: target.offset });
    }

    _openPopup(topic, anchor) {
        this._closePopup();
        const pop = el('div', 'hlpv-pop hlpv-doc');
        this._renderTopic(topic, pop, pop);
        this.pane.appendChild(pop);
        this.popup = pop;
        const pr = this.pane.getBoundingClientRect();
        const ar = anchor ? anchor.getBoundingClientRect() : { left: pr.left + 20, bottom: pr.top + 20, top: pr.top + 20 };
        const w = pop.offsetWidth, hgt = pop.offsetHeight;
        let left = Math.max(4, Math.min(ar.left - pr.left, pr.width - w - 8));
        let top = ar.bottom - pr.top + 4;
        if (top + hgt > pr.height - 4 && ar.top - pr.top - hgt - 4 > 0) top = ar.top - pr.top - hgt - 4;
        pop.style.left = left + 'px';
        pop.style.top = Math.max(4, top) + 'px';
        this._layoutTabs(pop);
    }

    _closePopup() {
        if (this.popup) { this.popup.remove(); this.popup = null; }
    }

    _note(text) {
        if (this.noteEl) this.noteEl.remove();
        const n = el('div', 'hlpv-note', text);
        (this.pane || this.root).appendChild(n);
        this.noteEl = n;
        clearTimeout(this._noteTimer);
        this._noteTimer = setTimeout(() => { n.remove(); if (this.noteEl === n) this.noteEl = null; }, 4000);
    }

    // --- topic rendering ---
    _renderTopic(topic, nsrEl, srEl) {
        const h = this.help;
        nsrEl.textContent = '';
        if (srEl !== nsrEl) srEl.textContent = '';
        let blocks;
        try {
            blocks = h.topicContent(topic);
        } catch (err) {
            srEl.appendChild(el('div', 'hlpv-err', 'This topic can’t be read: ' + err.message));
            return;
        }
        const state = { font: null, link: null };
        for (const block of blocks) {
            const target = block.nonScroll ? nsrEl : srEl;
            if (block.kind === 'error') { target.appendChild(el('div', 'hlpv-err', 'Damaged paragraph: ' + block.error)); continue; }
            if (block.kind === 'table') target.appendChild(this._renderTable(block, state));
            else for (const para of block.paras) {
                const p = this._renderPara(para, state);
                p.dataset.off = block.offset;
                target.appendChild(p);
            }
        }
        if (!blocks.length) srEl.appendChild(el('div', 'hlpv-count', '(empty topic)'));
        if (topic.macros.length) {
            const n = el('div', 'hlpv-count', 'Topic macros (not run): ' + topic.macros.join('; '));
            srEl.appendChild(n);
        }
        // tab stops need the laid-out text
        this._layoutTabs(nsrEl);
        if (srEl !== nsrEl) this._layoutTabs(srEl);
    }

    _paraStyle(p, fmt) {
        const s = p.style;
        if (fmt.spaceBefore) s.paddingTop = Math.max(0, fmt.spaceBefore) + 'pt';
        if (fmt.spaceAfter) s.paddingBottom = Math.max(0, fmt.spaceAfter) + 'pt';
        // indents as margins, so borders start at the indent as in WinHelp
        if (fmt.leftIndent) s.marginLeft = Math.max(0, fmt.leftIndent) + 'pt';
        if (fmt.rightIndent) s.marginRight = Math.max(0, fmt.rightIndent) + 'pt';
        if (fmt.firstIndent) s.textIndent = fmt.firstIndent + 'pt';
        if (fmt.lineSpacing && fmt.lineSpacing < 0) s.lineHeight = -fmt.lineSpacing + 'pt';
        else if (fmt.lineSpacing > 0) s.minHeight = fmt.lineSpacing + 'pt';
        if (fmt.align !== 'left') s.textAlign = fmt.align;
        if (fmt.border) {
            const b = fmt.border;
            const line = `${b.double ? 'double' : 'solid'} ${b.double ? 3 : b.thick ? 2 : 1}px #000`;
            if (b.box) { s.border = line; s.padding = '1pt 2pt'; }
            if (b.top) s.borderTop = line;
            if (b.bottom) s.borderBottom = line;
            if (b.left) s.borderLeft = line;
            if (b.right) s.borderRight = line;
        }
    }

    _fontStyle(span, n) {
        const f = this.help.fonts[n];
        if (!f) return;
        const s = span.style;
        s.fontFamily = fontFamily(f);
        if (f.size) s.fontSize = f.size + 'pt';
        if (f.bold) s.fontWeight = 'bold';
        if (f.italic) s.fontStyle = 'italic';
        const deco = [];
        if (f.underline || f.doubleUnderline) deco.push('underline');
        if (f.strike) deco.push('line-through');
        if (deco.length) s.textDecoration = deco.join(' ') + (f.doubleUnderline ? ' double' : '');
        if (f.smallCaps) s.fontVariant = 'small-caps';
        if (f.color && (f.color[0] || f.color[1] || f.color[2])) s.color = rgb(f.color);
    }

    _renderPara(para, state) {
        const p = el('div', 'hlpv-p');
        this._paraStyle(p, para.fmt);
        if (para.fmt.tabs) p._tabs = para.fmt.tabs;
        p._fmt = para.fmt;
        let span = null;
        const target = () => state.link ? state.link : p;
        const newSpan = () => {
            span = el('span');
            if (state.font != null) this._fontStyle(span, state.font);
            target().appendChild(span);
            return span;
        };
        const put = node => { target().appendChild(node); span = null; };
        for (const it of para.items) {
            switch (it.t) {
            case 'text': (span || newSpan()).appendChild(document.createTextNode(it.s)); break;
            case 'font': state.font = it.n; span = null; break;
            case 'br': put(el('br')); break;
            case 'tab': { const t = el('span', 'hlpv-tab'); t.textContent = '​'; put(t); break; }
            case 'link': {
                const a = el('a', 'hlpv-link');
                a.tabIndex = 0;
                const external = it.file && !(this.name && it.file.replace(/^.*[\\/]/, '').toLowerCase() === this.name.toLowerCase());
                const inert = it.kind === 'macro' ? !parseMacroJump(it.macro) : external;
                if (!it.plain) a.classList.add(it.kind === 'popup' ? 'hlpv-popup' : 'hlpv-jump');
                if (inert) a.classList.add('hlpv-inert');
                a.title = it.kind === 'macro' ? `Macro${inert ? ' (not run)' : ''}: ${it.macro}`
                    : external ? `${it.kind === 'popup' ? 'Popup' : 'Jump'} into ${it.file} (another help file, not opened)`
                        : it.window ? `Jump (window “${it.window}”)` : '';
                a.onclick = e => this._activate(it, a, e);
                a.onkeydown = e => { if (e.key === 'Enter') this._activate(it, a, e); };
                p.appendChild(a);
                state.link = a;
                span = null;
                break;
            }
            case 'endlink': state.link = null; span = null; break;
            case 'img': put(this._inlineImage(it)); break;
            case 'embed': put(this._embed(it)); break;
            }
        }
        state.link = null;
        if (!p.firstChild) p.appendChild(document.createTextNode('​'));
        return p;
    }

    _renderTable(block, state) {
        const table = el('table', 'hlpv-table');
        const cols = block.cols;
        const colgroup = el('colgroup');
        const n = cols.length || 1;
        const gap = n > 1 ? Math.max(0, cols[1].gap) : 0;
        const unit = this.help.fontUnit;
        if (block.relative) {
            // widths relative to the window (they sum to 32767)
            const total = cols.reduce((s, c) => s + Math.max(0, c.width) + Math.max(0, c.gap), 0) || 1;
            cols.forEach((c, i) => { const cg = el('col'); cg.style.width = ((Math.max(0, c.width) + (i ? Math.max(0, c.gap) : 0)) / total * 100) + '%'; colgroup.appendChild(cg); });
            table.style.width = '100%';
            if (block.minWidth) table.style.minWidth = block.minWidth * unit + 'pt';
        } else {
            let w = 0;
            cols.forEach((c, i) => {
                const cw = (Math.max(0, c.width) + (i ? Math.max(0, c.gap) : gap)) * unit;
                w += cw;
                const cg = el('col');
                cg.style.width = cw + 'pt';
                colgroup.appendChild(cg);
            });
            table.style.width = w + 'pt';
            const left = (cols[0] ? cols[0].gap : 0) - gap;
            if (left) table.style.marginLeft = Math.max(0, left * unit) + 'pt';
        }
        table.appendChild(colgroup);
        const tr = el('tr');
        let lastCol = -1;
        for (const cell of block.cells) {
            // skipped columns get empty cells
            for (let c = lastCol + 1; c < cell.col; c++) tr.appendChild(el('td'));
            const td = el('td');
            td.style.padding = `0 ${gap * unit / 2}pt`;
            for (const para of cell.paras) td.appendChild(this._renderPara(para, state));
            td.dataset.off = block.offset;
            tr.appendChild(td);
            lastCol = cell.col;
        }
        table.appendChild(tr);
        table.dataset.off = block.offset;
        return table;
    }

    // Tab stops: each tab span is widened to reach the next stop of its paragraph
    _layoutTabs(root) {
        if (!root || !root.isConnected) return;
        const tabs = root.querySelectorAll('.hlpv-tab');
        if (!tabs.length || tabs.length > 5000) return;
        for (const t of tabs) t.style.width = '0px';
        for (const t of tabs) {
            const p = t.closest('.hlpv-p');
            if (!p) continue;
            const fmt = p._fmt || {};
            const pr = p.getBoundingClientRect();
            // points from the left margin (the paragraph's box starts at its left indent)
            const x = (t.getBoundingClientRect().left - pr.left) / PT + Math.max(0, fmt.leftIndent || 0);
            const stops = (p._tabs || []).map(s => s.pos);
            if (fmt.firstIndent < 0 && fmt.leftIndent > 0) stops.push(fmt.leftIndent); // hanging indent: the indent is a stop
            stops.sort((a, b) => a - b);
            let next = stops.find(s => s > x + 0.5);
            if (next == null) next = (Math.floor(x / DEFAULT_TAB) + 1) * DEFAULT_TAB;
            const width = Math.max(2, (next - x) * PT);
            if (pr.width && (x - Math.max(0, fmt.leftIndent || 0)) * PT + width > pr.width) { t.style.width = '0.6em'; continue; }
            t.style.width = width + 'px';
        }
    }

    // --- pictures ---
    _inlineImage(it) {
        const h = this.help;
        let set, key;
        if (it.bitmap != null) { set = h.bitmapFile(it.bitmap); key = 'bm' + it.bitmap; }
        else { set = it.inline; key = null; }
        if (!set || set.error) return el('span', 'hlpv-missing', set ? `[picture: ${set.error}]` : '[picture]');
        const pic = bestPicture(set.pictures);
        if (!pic || pic.type === 'error') return el('span', 'hlpv-missing', `[picture: ${pic ? pic.error : 'empty'}]`);
        const box = el('span', 'hlpv-img' + (it.align === 'left' ? ' left' : it.align === 'right' ? ' right' : ''));
        box.appendChild(this._pictureElement(pic, { key }));
        // hotspots, scaled with the picture
        const scale = this._pictureScale(pic);
        for (const hs of pic.hotspots || []) {
            const a = el('a', 'hlpv-hot');
            a.style.left = hs.x * scale.x + 'px';
            a.style.top = hs.y * scale.y + 'px';
            a.style.width = hs.w * scale.x + 'px';
            a.style.height = hs.h * scale.y + 'px';
            const item = hs.kind === 'macro' ? { kind: 'macro', macro: hs.macro } : { kind: hs.kind, context: hs.context, file: hs.file, window: hs.window };
            a.title = hs.kind === 'macro' ? `Macro: ${hs.macro}` : `${hs.kind === 'popup' ? 'Popup' : 'Jump'}: ${hs.context}${hs.file ? ' in ' + hs.file : ''}`;
            a.tabIndex = 0;
            a.onclick = e => this._activate(item, a, e);
            box.appendChild(a);
        }
        return box;
    }

    _pictureScale(pic) {
        if (pic.type === 'wmf') return { x: 1, y: 1, w: pic.width * 96 / 2540, h: pic.height * 96 / 2540 };
        // bitmaps are shown at 96 dpi; a resolution of 0 (old files) means screen pixels
        const sx = pic.xdpi > 20 && pic.xdpi < 1200 ? 96 / pic.xdpi : 1;
        const sy = pic.ydpi > 20 && pic.ydpi < 1200 ? 96 / pic.ydpi : sx;
        return { x: sx, y: sy, w: pic.width * sx, h: pic.height * sy };
    }

    _pictureElement(pic, { key }) {
        const sc = this._pictureScale(pic);
        if (pic.type === 'wmf') {
            const w = Math.max(1, Math.round(sc.w)), hgt = Math.max(1, Math.round(sc.h));
            try {
                const c = renderWmf(pic.data, w, hgt);
                c.title = `metafile ${w}×${hgt}`;
                return c;
            } catch (err) {
                const ph = el('span', 'hlpv-missing', `[metafile ${w}×${hgt}: ${err.message}]`);
                ph.style.width = w + 'px';
                ph.style.height = hgt + 'px';
                return ph;
            }
        }
        let url = key && this.bitmapUrls.get(key);
        if (!url) {
            const c = document.createElement('canvas');
            c.width = pic.width;
            c.height = pic.height;
            c.getContext('2d').putImageData(new ImageData(pic.rgba, pic.width, pic.height), 0, 0);
            url = c.toDataURL('image/png');
            if (key) this.bitmapUrls.set(key, url);
        }
        const img = el('img');
        img.src = url;
        img.alt = '';
        img.width = Math.round(sc.w);
        img.height = Math.round(sc.h);
        img.draggable = false;
        if (sc.x === 1 && sc.y === 1) img.style.imageRendering = 'pixelated';
        return img;
    }

    _embed(it) {
        const text = it.text || '';
        if (text[0] === '!') {
            // {button Label, Macro}
            const comma = text.indexOf(',');
            const label = (comma > 0 ? text.slice(1, comma) : text.slice(1)).trim() || ' ';
            const macro = comma > 0 ? text.slice(comma + 1).trim() : '';
            const b = el('button', 'hlpv-button', label);
            b.type = 'button';
            b.title = `Macro: ${macro}`;
            b.onclick = e => this._activate({ kind: 'macro', macro }, b, e);
            return b;
        }
        if (text[0] === '*') return el('span', 'hlpv-embed', `[media clip: ${text.replace(/^\*[^,]*,[^,]*,/, '')}]`);
        const box = el('span', 'hlpv-embed', `[embedded window: ${text}]`);
        box.title = 'Embedded windows run code from a DLL; not shown.';
        return box;
    }

    // --- OS/2 help ---
    _buildIpf() {
        const doc = this.ipf;
        this.root.textContent = '';
        const bar = el('div', 'hlpv-bar');
        const btn = (label, title, fn) => { const b = el('button', null, label); b.type = 'button'; b.title = title; b.onclick = fn; bar.appendChild(b); return b; };
        this.sideBtn = btn('☰', 'Show or hide the contents', () => this._toggleSide());
        this.backBtn = btn('◀ Back', 'Back', () => this._ipfStep(-1));
        this.fwdBtn = btn('Forward ▶', 'Forward', () => this._ipfStep(1));
        this.titleEl = el('span', 'hlpv-title', doc.title || this.name);
        bar.appendChild(this.titleEl);
        this.root.appendChild(bar);
        if (doc.warnings.length) {
            const w = el('div', 'hlpv-warn');
            for (const msg of doc.warnings) w.appendChild(el('div', null, msg));
            this.root.appendChild(w);
        }
        const main = el('div', 'hlpv-main');
        this.side = el('div', 'hlpv-side');
        const tabs = el('div', 'hlpv-tabs');
        this.tabBtns = {};
        for (const [id, label] of [['topics', 'Contents'], ['index', 'Index']]) {
            const b = el('button', null, label);
            b.type = 'button';
            b.onclick = () => { this.sideTab = id; for (const [k, x] of Object.entries(this.tabBtns)) x.classList.toggle('active', k === id); this._ipfSide(); };
            tabs.appendChild(b);
            this.tabBtns[id] = b;
        }
        const search = el('div', 'hlpv-search');
        this.searchInput = el('input');
        this.searchInput.type = 'search';
        this.searchInput.placeholder = 'Filter';
        this.searchInput.oninput = () => this._ipfSide();
        search.appendChild(this.searchInput);
        this.listEl = el('div', 'hlpv-list');
        this.side.append(tabs, search, this.listEl);
        this.pane = el('div', 'hlpv-pane');
        this.nsr = el('div', 'hlpv-nsr hlpv-doc');
        this.sr = el('div', 'hlpv-sr hlpv-doc');
        this.pane.append(this.nsr, this.sr);
        main.append(this.side, this.pane);
        this.root.appendChild(main);
        if (this.host.clientWidth && this.host.clientWidth < 640) this.side.hidden = true;
        this.tabBtns.topics.click();
        const first = doc.topics.find(t => t.visible !== false) || doc.topics[0];
        if (first) this._ipfGo(first);
        else this.sr.appendChild(el('div', 'hlpv-count', 'This file has no topics.'));
    }

    _ipfSide() {
        const doc = this.ipf;
        const q = this.searchInput.value.trim().toLowerCase();
        this.listEl.textContent = '';
        const frag = document.createDocumentFragment();
        if (this.sideTab === 'index') {
            const list = doc.index.filter(k => !q || k.text.toLowerCase().includes(q));
            this.listEl.appendChild(el('div', 'hlpv-count', doc.index.length ? `${list.length} of ${doc.index.length} index entries` : 'This file has no index.'));
            for (const k of list) {
                const it = el('div', 'hlpv-item', k.text);
                if (k.level > 1) it.style.paddingLeft = 8 + (k.level - 1) * 14 + 'px';
                it.onclick = () => { const t = doc.topics[k.topic]; if (t) this._ipfGo(t); };
                frag.appendChild(it);
            }
        } else {
            const list = doc.topics.filter(t => !q || t.title.toLowerCase().includes(q));
            for (const t of list) {
                const it = el('div', 'hlpv-item' + (t.visible === false ? ' untitled' : ''), t.title || `(topic ${t.index + 1})`);
                if (!q) it.style.paddingLeft = 8 + Math.max(0, t.level - 1) * 14 + 'px';
                it.onclick = () => this._ipfGo(t);
                frag.appendChild(it);
            }
        }
        this.listEl.appendChild(frag);
    }

    _ipfGo(topic, fromHistory) {
        this._closePopup();
        if (!fromHistory) {
            this.history.splice(this.histPos + 1);
            this.history.push(topic);
            this.histPos = this.history.length - 1;
        }
        this.current = topic;
        this.sr.textContent = '';
        this.nsr.textContent = '';
        let content;
        try { content = this.ipf.topicContent(topic); } catch (err) { this.sr.appendChild(el('div', 'hlpv-err', 'This topic can’t be read: ' + err.message)); content = null; }
        if (content) this._ipfRender(content, this.sr);
        this.sr.scrollTop = 0;
        this.backBtn.disabled = this.histPos <= 0;
        this.fwdBtn.disabled = this.histPos >= this.history.length - 1;
        this.titleEl.textContent = (this.ipf.title || this.name) + (topic.title ? ' — ' + topic.title : '');
    }

    _ipfStep(dir) {
        const i = this.histPos + dir;
        if (i < 0 || i >= this.history.length) return;
        this.histPos = i;
        this._ipfGo(this.history[i], true);
    }

    _ipfRender(content, host) {
        host.appendChild(el('h2', null, content.title || ''));
        for (const para of content.paras) {
            const p = el('div', 'hlpv-p');
            if (para.gap) p.style.paddingTop = '6pt';
            if (para.firstIndent) p.style.textIndent = para.firstIndent + 'em';
            if (para.mono) { p.style.fontFamily = 'monospace'; p.style.whiteSpace = 'pre'; }
            if (para.indent) p.style.paddingLeft = para.indent + 'em';
            if (para.align && para.align !== 'left') p.style.textAlign = para.align;
            for (const it of para.items) {
                if (it.t === 'text') {
                    const s = el('span', null, it.s);
                    if (it.bold) s.style.fontWeight = 'bold';
                    if (it.italic) s.style.fontStyle = 'italic';
                    if (it.underline) s.style.textDecoration = 'underline';
                    if (it.color) s.style.color = it.color;
                    p.appendChild(s);
                } else if (it.t === 'link') {
                    const a = el('a', 'hlpv-link hlpv-jump', it.s);
                    a.tabIndex = 0;
                    const t = it.topic != null ? this.ipf.topics[it.topic] : null;
                    if (!t) { a.classList.add('hlpv-inert'); a.title = it.note || 'Link target not in this file'; }
                    a.onclick = e => { e.preventDefault(); if (t) this._ipfGo(t); else this._note(a.title); };
                    p.appendChild(a);
                } else if (it.t === 'br') p.appendChild(el('br'));
                else if (it.t === 'img') p.appendChild(this._ipfImage(it));
            }
            host.appendChild(p);
        }
    }

    _ipfImage(it) {
        const pic = it.bitmap;
        if (!pic || pic.error) return el('span', 'hlpv-missing', `[picture${pic && pic.error ? ': ' + pic.error : ''}]`);
        const c = document.createElement('canvas');
        c.width = pic.width;
        c.height = pic.height;
        c.getContext('2d').putImageData(new ImageData(pic.rgba, pic.width, pic.height), 0, 0);
        const img = el('img');
        img.src = c.toDataURL('image/png');
        img.width = pic.width;
        img.height = pic.height;
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        return img;
    }

    destroy() {
        if (this._onDocDown) document.removeEventListener('mousedown', this._onDocDown, true);
        if (this._resizeObs) this._resizeObs.disconnect();
        clearTimeout(this._noteTimer);
        this.root.remove();
    }
}

export async function mountHlpViewer(host, opts) {
    const v = new HlpViewer(host, opts);
    await v.ready;
    return v;
}

// For tests and the debug console
export { parsePictures };
