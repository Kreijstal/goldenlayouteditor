// --- Packet captures (.pcap, .pcapng, …) ---
// Wireshark's own dissectors, as WebAssembly (Wiregasm), in a worker
// (public/pcap-worker.js): the packet list with Wireshark's colouring, display
// filters, the protocol tree with its bytes, following a stream,
// conversations and endpoints, and exporting the files carried (HTTP, SMB, …).
// A capture is read whole into the worker.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('PCAP');
const WORKER_URL = '/pcap-worker.js';
const ROW_HEIGHT = 20;
const CHUNK = 500;
// Taps for the files a capture carries (Wireshark's File → Export Objects)
const EO_TAPS = ['eo:http', 'eo:smb', 'eo:imf', 'eo:tftp', 'eo:dicom', 'eo:ftp-data'];
const STAT_TAPS = {
    Conversations: ['conv:Ethernet', 'conv:IPv4', 'conv:IPv6', 'conv:TCP', 'conv:UDP'],
    Endpoints: ['endpt:Ethernet', 'endpt:IPv4', 'endpt:IPv6', 'endpt:TCP', 'endpt:UDP'],
};

function b64bytes(s) {
    const bin = atob(s || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const color = n => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// Requests to the worker, answered in order of their ids
function startWorker(onProgress) {
    const worker = new Worker(WORKER_URL);
    const pending = new Map();
    let next = 1;
    worker.onmessage = ({ data }) => {
        if (data.progress) return onProgress(data.progress);
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.result);
    };
    worker.onerror = e => {
        for (const p of pending.values()) p.reject(new Error(e.message || 'worker failed'));
        pending.clear();
    };
    return {
        call(cmd, args = {}, transfer = []) {
            const id = next++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                worker.postMessage({ id, cmd, ...args }, transfer);
            });
        },
        terminate() { worker.terminate(); },
    };
}

class PcapComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = PcapComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'capture.pcap';
        this.ws = null;
        this.filter = '';
        this.matched = 0;
        this.chunks = new Map(); // chunk index → Promise<frames>
        this.selected = null;
        this.expanded = new Set(); // tree nodes kept open from frame to frame, by filter field
        this.generation = 0;

        this.root = container.element;
        this.root.classList.add('pcap-root');
        this._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (PcapComponent._styleInstalled) return;
        PcapComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.pcap-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;position:relative}
.pcap-shell{display:grid;grid-template-rows:auto auto minmax(60px,1fr) 5px minmax(60px,1fr) 5px minmax(40px,.7fr);height:100%}
.pcap-toolbar,.pcap-filterbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow-x:auto}
.pcap-root button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}
.pcap-root button:hover{background:#444c56}
.pcap-root button:disabled{opacity:.4;cursor:default}
.pcap-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.pcap-status{margin-left:auto;color:#adbac7}
.pcap-filter{flex:1;min-width:160px;background:#1f2328;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:4px 6px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
.pcap-filter.ok{border-color:#2ea043;background:#12261a}
.pcap-filter.bad{border-color:#da3633;background:#2d1417}
.pcap-list{overflow:auto;position:relative;background:#fff;color:#000;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
.pcap-list-head{position:sticky;top:0;z-index:2;display:flex;background:#e6e6e6;border-bottom:1px solid #bbb;font-weight:600}
.pcap-list-body{position:relative}
.pcap-row{position:absolute;left:0;display:flex;height:${ROW_HEIGHT}px;line-height:${ROW_HEIGHT}px;cursor:default;min-width:100%}
.pcap-row.sel{background:#2f6fd6!important;color:#fff!important}
.pcap-cell,.pcap-list-head span{flex:none;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-sizing:border-box}
.pcap-split{background:#444c56;cursor:row-resize}
.pcap-tree{overflow:auto;padding:4px 0;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;background:#1f2328}
.pcap-node{padding:1px 6px;white-space:nowrap;cursor:default}
.pcap-node:hover{background:#2d333b}
.pcap-node.sel{background:#2f6fd6;color:#fff}
.pcap-node .tw{display:inline-block;width:14px;color:#adbac7}
.pcap-node.proto{font-weight:600}
.pcap-node a{color:#6cb6ff}
.pcap-bytes{overflow:auto;background:#1f2328;display:flex;flex-direction:column}
.pcap-tabs{display:flex;gap:4px;padding:3px 6px;border-bottom:1px solid #373e47}
.pcap-tabs button{padding:1px 8px}
.pcap-tabs button.on{background:#316dca;border-color:#4184e4}
.pcap-hex{margin:0;padding:4px 8px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#d1d7e0;white-space:pre}
.pcap-hex mark{background:#2f6fd6;color:#fff}
.pcap-overlay{position:absolute;inset:24px;z-index:10;background:#22272e;border:1px solid #545d68;border-radius:6px;box-shadow:0 8px 30px #000a;display:grid;grid-template-rows:auto 1fr}
.pcap-overlay-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #444c56;flex-wrap:wrap}
.pcap-overlay-head b{margin-right:auto}
.pcap-overlay-body{overflow:auto}
.pcap-stream{margin:0;padding:8px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.pcap-stream .c{color:#ff938a}.pcap-stream .s{color:#79c0ff}
.pcap-table{border-collapse:collapse;width:100%;font-size:12px}
.pcap-table th{position:sticky;top:0;background:#2d333b;color:#adbac7;text-align:left;font-weight:600}
.pcap-table th,.pcap-table td{border:1px solid #373e47;padding:3px 6px;white-space:nowrap}
.pcap-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.pcap-table tbody tr:hover td{background:#2d333b;cursor:pointer}
.pcap-message{padding:20px;color:#adbac7;text-align:center}
.pcap-error{padding:20px;color:#ffb4ab;text-align:center}
`;
        document.head.appendChild(style);
    }

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    _button(label, title, onClick) {
        const b = this._el('button', null, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = this._el('div', 'pcap-shell');
        const toolbar = this._el('div', 'pcap-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.pcap,.pcapng,.cap,.ntar,.erf,.snoop,.pcap.gz,.pcapng.gz';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, await f.arrayBuffer());
        });
        this.titleEl = this._el('span', 'pcap-title', this.fileName);
        this.followBtn = this._button('Follow stream', 'The selected packet’s TCP/UDP/HTTP… stream, reassembled', () => this._follow());
        this.followBtn.disabled = true;
        const conv = this._button('Conversations', 'Traffic between each pair of addresses', () => this._stats('Conversations'));
        const endp = this._button('Endpoints', 'Traffic per address', () => this._stats('Endpoints'));
        const eo = this._button('Export objects', 'Files carried in the capture (HTTP, SMB, IMF, TFTP, DICOM, FTP)', () => this._exportObjects());
        this.statusEl = this._el('span', 'pcap-status');
        toolbar.append(this.fileInput, this._button('Open', 'Open a capture from this computer', () => this.fileInput.click()),
            this.titleEl, this.followBtn, conv, endp, eo, this.statusEl);
        this.statButtons = [conv, endp, eo];

        const filterbar = this._el('div', 'pcap-filterbar');
        this.filterInput = this._el('input', 'pcap-filter');
        this.filterInput.placeholder = 'Display filter, e.g. http.request || dns.qry.name contains "example"';
        this.filterInput.spellcheck = false;
        this.completions = this._el('datalist');
        this.completions.id = 'pcap-complete-' + Math.random().toString(36).slice(2);
        this.filterInput.setAttribute('list', this.completions.id);
        this.filterInput.addEventListener('input', () => this._checkFilter());
        this.filterInput.addEventListener('keydown', e => { if (e.key === 'Enter') this._applyFilter(this.filterInput.value); });
        filterbar.append(this.filterInput, this.completions,
            this._button('Apply', 'Apply the display filter', () => this._applyFilter(this.filterInput.value)),
            this._button('Clear', 'Show every packet', () => { this.filterInput.value = ''; this._checkFilter(); this._applyFilter(''); }));

        this.list = this._el('div', 'pcap-list');
        this.listHead = this._el('div', 'pcap-list-head');
        this.listBody = this._el('div', 'pcap-list-body');
        this.list.append(this.listHead, this.listBody);
        this.list.tabIndex = 0;
        this.list.addEventListener('scroll', () => this._renderRows());
        this.list.addEventListener('keydown', e => this._listKey(e));
        this.tree = this._el('div', 'pcap-tree');
        this.bytes = this._el('div', 'pcap-bytes');
        const split1 = this._el('div', 'pcap-split');
        const split2 = this._el('div', 'pcap-split');
        this.shell.append(toolbar, filterbar, this.list, split1, this.tree, split2, this.bytes);
        this.root.appendChild(this.shell);
        this._splitter(split1, 2);
        this._splitter(split2, 4);
        this.listBody.appendChild(this._el('div', 'pcap-message', 'Open a packet capture (.pcap, .pcapng, …).'));
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this._renderRows());
            this.resizeObserver.observe(this.list);
        }
    }

    // Dragging a split bar moves space between the panes above and below it
    _splitter(bar, above) {
        bar.addEventListener('pointerdown', e => {
            e.preventDefault();
            const rows = [...this.shell.children].map(c => c.getBoundingClientRect().height);
            const y0 = e.clientY;
            const move = ev => {
                const d = ev.clientY - y0;
                const a = Math.max(40, rows[above] + d), b = Math.max(40, rows[above + 2] + rows[above] - a);
                const r = rows.slice();
                r[above] = a;
                r[above + 2] = b;
                this.shell.style.gridTemplateRows = r.map((h, i) => i < 2 ? 'auto' : i % 2 ? '5px' : `${h}fr`).join(' ');
            };
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });
    }

    async _init() {
        if (!this.fileData) return;
        if (!this.ctx || !this.ctx.currentWorkspacePath) {
            this._error('Opening a project file needs the server workspace; use Open.');
            return;
        }
        try {
            this.statusEl.textContent = 'Reading the capture…';
            const rel = this.ctx.getRelativePath(this.fileId);
            const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + rel));
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._open(this.fileData.name, await resp.arrayBuffer());
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
        }
    }

    async _open(name, buffer) {
        const gen = ++this.generation;
        this.fileName = name;
        this.titleEl.textContent = name;
        this.chunks.clear();
        this.selected = null;
        this.matched = 0;
        this.tree.innerHTML = '';
        this.bytes.innerHTML = '';
        this.followBtn.disabled = true;
        if (!this.ws) this.ws = startWorker(text => { this.statusEl.textContent = text; });
        this.statusEl.textContent = 'Starting Wireshark…';
        try {
            const r = await this.ws.call('open', { name, bytes: buffer }, [buffer]);
            if (gen !== this.generation) return;
            this.summary = r.summary;
            this.columns = r.columns;
            this.version = r.version;
            this._renderHead();
            await this._applyFilter(this.filter);
        } catch (err) {
            if (gen !== this.generation) return;
            log.error('Open failed:', err);
            this._error(`Could not open ${name}: ${err.message}`);
        }
    }

    _renderHead() {
        const widths = { 'No.': 70, Time: 100, Source: 170, Destination: 170, Protocol: 80, Length: 64, Info: 900 };
        this.colWidths = this.columns.map(c => widths[c] || 120);
        this.listHead.innerHTML = '';
        this.columns.forEach((c, i) => {
            const s = this._el('span', null, c);
            s.style.width = this.colWidths[i] + 'px';
            this.listHead.appendChild(s);
        });
    }

    _status() {
        const s = this.summary;
        if (!s) return;
        const shown = this.filter ? `${this.matched.toLocaleString()} of ${s.packet_count.toLocaleString()} shown` : `${s.packet_count.toLocaleString()} packets`;
        this.statusEl.textContent = `${shown} · ${s.elapsed_time.toFixed(1)} s · ${s.file_type} · Wireshark ${this.version}`;
    }

    async _checkFilter() {
        const text = this.filterInput.value;
        this.filterInput.classList.remove('ok', 'bad');
        this.filterInput.title = '';
        if (!this.ws || !text.trim()) return;
        try {
            const r = await this.ws.call('check', { filter: text });
            if (this.filterInput.value !== text) return;
            this.filterInput.classList.add(r.ok ? 'ok' : 'bad');
            this.filterInput.title = r.error || '';
            // Field names for the last word typed
            const word = text.match(/[\w.-]+$/);
            if (word && word[0].length >= 2) {
                const fields = await this.ws.call('complete', { text: word[0] });
                if (this.filterInput.value !== text) return;
                const before = text.slice(0, text.length - word[0].length);
                this.completions.innerHTML = '';
                for (const f of fields.slice(0, 50)) {
                    const o = this._el('option');
                    o.value = before + f.field;
                    o.label = f.name;
                    this.completions.appendChild(o);
                }
            }
        } catch (err) {
            log.warn('Filter check:', err);
        }
    }

    async _applyFilter(filter) {
        if (!this.summary) return;
        const gen = this.generation;
        try {
            if (filter.trim()) {
                const c = await this.ws.call('check', { filter });
                if (!c.ok) {
                    this.filterInput.classList.add('bad');
                    this.statusEl.textContent = `Filter: ${c.error}`;
                    return;
                }
            }
            this.filter = filter;
            this.chunks.clear();
            const first = await this._chunk(0);
            if (gen !== this.generation) return;
            this.matched = first.matched;
            this.listBody.innerHTML = '';
            this.listBody.style.height = (this.matched * ROW_HEIGHT) + 'px';
            this.listBody.style.width = this.colWidths.reduce((a, b) => a + b, 0) + 'px';
            this.list.scrollTop = 0;
            this.rowEls = new Map();
            this._status();
            this._renderRows();
            if (!this.matched) this.listBody.appendChild(this._el('div', 'pcap-message', 'No packets match.'));
            // Keep the packet that was selected, if it's still shown; else the first
            const all = first.frames;
            if (this.selected === null && all[0]) this._select(all[0].number, 0);
        } catch (err) {
            this._error(err.message);
        }
    }

    // Frames [i * CHUNK, (i + 1) * CHUNK) of the filtered list
    _chunk(i) {
        let p = this.chunks.get(i);
        if (!p) {
            p = this.ws.call('frames', { filter: this.filter, skip: i * CHUNK, limit: CHUNK });
            this.chunks.set(i, p);
            p.catch(() => this.chunks.delete(i));
        }
        return p;
    }

    async _renderRows() {
        if (!this.summary || !this.matched || !this.rowEls) return;
        const gen = this.generation, filter = this.filter;
        const top = Math.max(0, Math.floor((this.list.scrollTop - ROW_HEIGHT) / ROW_HEIGHT) - 10);
        const bottom = Math.min(this.matched, Math.ceil((this.list.scrollTop + this.list.clientHeight) / ROW_HEIGHT) + 10);
        for (const [i, el] of this.rowEls) {
            if (i < top || i >= bottom) { el.remove(); this.rowEls.delete(i); }
        }
        for (let c = Math.floor(top / CHUNK); c * CHUNK < bottom; c++) {
            const { frames } = await this._chunk(c);
            if (gen !== this.generation || filter !== this.filter) return;
            for (let k = 0; k < frames.length; k++) {
                const i = c * CHUNK + k;
                if (i < top || i >= bottom || this.rowEls.has(i)) continue;
                const f = frames[k];
                const row = this._el('div', 'pcap-row');
                row.style.top = (i * ROW_HEIGHT) + 'px';
                row.style.background = color(f.bg);
                row.style.color = color(f.fg);
                row.dataset.number = f.number;
                f.columns.forEach((text, j) => {
                    const cell = this._el('span', 'pcap-cell', text);
                    cell.style.width = this.colWidths[j] + 'px';
                    row.appendChild(cell);
                });
                if (f.number === this.selected) row.classList.add('sel');
                row.addEventListener('click', () => { this._select(f.number, i); this.list.focus(); });
                this.listBody.appendChild(row);
                this.rowEls.set(i, row);
            }
        }
    }

    _listKey(e) {
        if (!this.matched || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
        e.preventDefault();
        const i = Math.max(0, Math.min(this.matched - 1, (this.selectedIndex || 0) + (e.key === 'ArrowDown' ? 1 : -1)));
        this._chunk(Math.floor(i / CHUNK)).then(({ frames }) => {
            const f = frames[i % CHUNK];
            if (!f) return;
            this._select(f.number, i);
            const y = i * ROW_HEIGHT;
            const head = this.listHead.offsetHeight;
            if (y < this.list.scrollTop) this.list.scrollTop = y;
            else if (y + ROW_HEIGHT > this.list.scrollTop + this.list.clientHeight - head) this.list.scrollTop = y + ROW_HEIGHT - this.list.clientHeight + head;
        });
    }

    async _select(number, index) {
        this.selected = number;
        this.selectedIndex = index;
        for (const el of this.listBody.querySelectorAll('.pcap-row.sel')) el.classList.remove('sel');
        const row = this.listBody.querySelector(`.pcap-row[data-number="${number}"]`);
        if (row) row.classList.add('sel');
        try {
            const f = await this.ws.call('frame', { number });
            if (this.selected !== number) return;
            this.frame = f;
            this.frameSources = f.sources.map(s => ({ name: s.name, bytes: b64bytes(s.data) }));
            this.followBtn.disabled = !f.follow.length;
            this.followBtn.title = f.follow.length ? `Follow ${f.follow[0][0]} stream (${f.follow[0][1]})` : 'Not part of a stream';
            this._renderTree();
            this._renderBytes(0, null);
        } catch (err) {
            this.tree.innerHTML = '';
            this.tree.appendChild(this._el('div', 'pcap-error', err.message));
        }
    }

    _renderTree() {
        this.tree.innerHTML = '';
        const add = (nodes, depth, parentKey) => {
            for (const n of nodes) {
                const key = parentKey + '/' + (n.filter.split(/\s|==/)[0] || n.label.split(':')[0]);
                const el = this._el('div', 'pcap-node' + (n.type === 'proto' ? ' proto' : ''));
                el.style.paddingLeft = (6 + depth * 16) + 'px';
                const tw = this._el('span', 'tw', n.children.length ? (this.expanded.has(key) ? '▾' : '▸') : '');
                el.appendChild(tw);
                if (n.type === 'framenum' && n.fnum) {
                    el.append(n.label.replace(/\d+$/, ''));
                    const a = this._el('a', null, String(n.fnum));
                    a.href = '#';
                    a.addEventListener('click', ev => { ev.preventDefault(); this._goTo(n.fnum); });
                    el.appendChild(a);
                } else {
                    el.append(n.label);
                }
                if (n.filter) el.title = `${n.filter}\nDouble-click: filter on this`;
                el.addEventListener('click', () => {
                    for (const s of this.tree.querySelectorAll('.pcap-node.sel')) s.classList.remove('sel');
                    el.classList.add('sel');
                    this._renderBytes(n.source, n.length ? [n.start, n.length] : null);
                });
                el.addEventListener('dblclick', () => {
                    if (!n.filter) return;
                    this.filterInput.value = n.filter;
                    this._checkFilter();
                    this._applyFilter(n.filter);
                });
                tw.addEventListener('click', ev => {
                    ev.stopPropagation();
                    if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
                    this._renderTree();
                });
                this.tree.appendChild(el);
                if (n.children.length && this.expanded.has(key)) add(n.children, depth + 1, key);
            }
        };
        add(this.frame.tree, 0, '');
    }

    // Hex dump of one data source (the frame, reassembled or decoded data), with a range marked
    _renderBytes(sourceIndex, range) {
        this.bytes.innerHTML = '';
        const sources = this.frameSources || [];
        if (!sources.length) return;
        const idx = Math.min(sourceIndex || 0, sources.length - 1);
        if (sources.length > 1) {
            const tabs = this._el('div', 'pcap-tabs');
            sources.forEach((s, i) => {
                const b = this._button(s.name, s.name, () => this._renderBytes(i, null));
                if (i === idx) b.classList.add('on');
                tabs.appendChild(b);
            });
            this.bytes.appendChild(tabs);
        }
        const data = sources[idx].bytes;
        const [from, len] = range || [-1, 0];
        const to = from + len;
        const pre = this._el('pre', 'pcap-hex');
        const esc = c => c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c;
        const lines = [];
        const limit = Math.min(data.length, 1 << 20);
        for (let off = 0; off < limit; off += 16) {
            let hex = '', ascii = '';
            for (let i = 0; i < 16; i++) {
                const p = off + i;
                if (p >= data.length) { hex += '   '; continue; }
                const b = data[p];
                const inR = p >= from && p < to;
                const h = b.toString(16).padStart(2, '0');
                const a = b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '·';
                hex += (inR ? `<mark>${h}</mark>` : h) + (i === 7 ? '  ' : ' ');
                ascii += inR ? `<mark>${a}</mark>` : a;
            }
            lines.push(`${off.toString(16).padStart(4, '0')}  ${hex} ${ascii}`);
        }
        pre.innerHTML = lines.join('\n').replace(/<\/mark>(\s*)<mark>/g, '$1');
        this.bytes.appendChild(pre);
        const mark = pre.querySelector('mark');
        if (mark) mark.scrollIntoView({ block: 'nearest' });
    }

    // Select a packet by number, clearing a filter that hides it
    async _goTo(number) {
        let index = null;
        for (let c = 0; c * CHUNK < this.matched && index === null; c++) {
            const { frames } = await this._chunk(c);
            const k = frames.findIndex(f => f.number === number);
            if (k >= 0) index = c * CHUNK + k;
        }
        if (index === null && this.filter) {
            this.filterInput.value = '';
            this.filterInput.classList.remove('ok', 'bad');
            await this._applyFilter('');
            index = number - 1;
        }
        if (index === null) return;
        this.list.scrollTop = Math.max(0, index * ROW_HEIGHT - this.list.clientHeight / 2);
        this._select(number, index);
    }

    _overlay(title, actions = []) {
        if (this.overlay) this.overlay.remove();
        const o = this._el('div', 'pcap-overlay');
        const head = this._el('div', 'pcap-overlay-head');
        head.appendChild(this._el('b', null, title));
        head.append(...actions, this._button('✕', 'Close', () => { o.remove(); this.overlay = null; }));
        const body = this._el('div', 'pcap-overlay-body');
        o.append(head, body);
        this.root.appendChild(o);
        this.overlay = o;
        return body;
    }

    async _follow() {
        if (!this.frame || !this.frame.follow.length) return;
        const [proto, filter] = this.frame.follow[0];
        const body = this._overlay(`Follow ${proto} stream · ${filter}`);
        body.appendChild(this._el('div', 'pcap-message', 'Reassembling…'));
        try {
            const r = await this.ws.call('follow', { proto, filter });
            const payloads = r.payloads.map(p => ({ ...p, bytes: b64bytes(p.data) }));
            let asHex = false;
            const render = () => {
                body.innerHTML = '';
                const pre = this._el('pre', 'pcap-stream');
                const dec = new TextDecoder('utf-8', { fatal: false });
                for (const p of payloads) {
                    const span = this._el('span', p.server ? 's' : 'c');
                    if (asHex) {
                        const lines = [];
                        for (let o = 0; o < p.bytes.length; o += 16) {
                            const row = p.bytes.subarray(o, o + 16);
                            lines.push(o.toString(16).padStart(8, '0') + '  ' + Array.from(row, b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48)
                                + '  ' + Array.from(row, b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join(''));
                        }
                        span.textContent = lines.join('\n') + '\n\n';
                    } else {
                        span.textContent = dec.decode(p.bytes).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '.');
                    }
                    span.title = `Frame ${p.number} (${p.server ? 'server' : 'client'})`;
                    pre.appendChild(span);
                }
                body.appendChild(pre);
            };
            const head = this.overlay.querySelector('.pcap-overlay-head');
            // Wiregasm's sbytes/cbytes come swapped: count them here
            const sent = side => payloads.filter(p => p.server === side).reduce((n, p) => n + p.bytes.length, 0);
            const info = this._el('span', null,
                `client ${r.chost}:${r.cport} sent ${fmtBytes(sent(0))} · server ${r.shost}:${r.sport} sent ${fmtBytes(sent(1))}`);
            info.style.color = '#adbac7';
            const hexBtn = this._button('Hex', 'Show as hex dump', () => { asHex = !asHex; hexBtn.textContent = asHex ? 'Text' : 'Hex'; render(); });
            const filterBtn = this._button('Filter on it', 'Show only this stream’s packets', () => {
                this.filterInput.value = filter;
                this._checkFilter();
                this._applyFilter(filter);
                this.overlay.remove();
                this.overlay = null;
            });
            head.insertBefore(info, head.lastChild);
            head.insertBefore(hexBtn, head.lastChild);
            head.insertBefore(filterBtn, head.lastChild);
            render();
        } catch (err) {
            body.innerHTML = '';
            body.appendChild(this._el('div', 'pcap-error', err.message));
        }
    }

    async _stats(kind) {
        const taps = STAT_TAPS[kind];
        const tabs = taps.map(t => t.split(':')[1]);
        const body = this._overlay(kind + (this.filter ? ` (filter: ${this.filter})` : ''));
        body.appendChild(this._el('div', 'pcap-message', 'Counting…'));
        try {
            const args = {};
            taps.forEach((t, i) => {
                args['tap' + i] = t;
                if (this.filter) args['filter' + i] = this.filter;
            });
            const r = await this.ws.call('tap', { taps: args });
            const results = r.taps;
            const head = this.overlay.querySelector('.pcap-overlay-head');
            let current = results.findIndex(t => (t.convs || t.hosts || []).length && /TCP|IPv4/.test(t.tap));
            if (current < 0) current = 0;
            const buttons = tabs.map((name, i) => {
                const n = (results[i] && (kind === 'Conversations' ? results[i].convs : results[i].hosts) || []).length;
                const b = this._button(`${name} (${n})`, name, () => { current = i; show(); });
                head.insertBefore(b, head.lastChild);
                return b;
            });
            const show = () => {
                buttons.forEach((b, i) => b.classList.toggle('on', i === current));
                body.innerHTML = '';
                const t = results[current] || {};
                const rows = (kind === 'Conversations' ? t.convs : t.hosts) || [];
                const ports = /TCP|UDP/.test(tabs[current]);
                const cols = kind === 'Conversations'
                    ? [['Address A', c => c.saddr], ...(ports ? [['Port A', c => c.sport]] : []), ['Address B', c => c.daddr], ...(ports ? [['Port B', c => c.dport]] : []),
                        ['Packets', c => c.txf + c.rxf, 1], ['Bytes', c => c.txb + c.rxb, 1], ['A→B', c => fmtBytes(c.txb), 1], ['B→A', c => fmtBytes(c.rxb), 1],
                        ['Start', c => c.start.toFixed(3), 1], ['Duration', c => (c.stop - c.start).toFixed(3), 1]]
                    : [['Address', h => h.host], ...(ports ? [['Port', h => h.port]] : []), ['Packets', h => h.txf + h.rxf, 1], ['Bytes', h => h.txb + h.rxb, 1],
                        ['Tx packets', h => h.txf, 1], ['Tx bytes', h => fmtBytes(h.txb), 1], ['Rx packets', h => h.rxf, 1], ['Rx bytes', h => fmtBytes(h.rxb), 1]];
                const table = this._el('table', 'pcap-table');
                const hr = table.createTHead().insertRow();
                for (const [name] of cols) hr.appendChild(this._el('th', null, name));
                const tb = table.createTBody();
                for (const row of rows.slice().sort((a, b) => (b.txb + b.rxb) - (a.txb + a.rxb))) {
                    const tr = tb.insertRow();
                    for (const [, get, num] of cols) {
                        const td = tr.insertCell();
                        td.textContent = get(row);
                        if (num) td.className = 'num';
                    }
                    tr.title = row.filter + '\nClick: filter on this';
                    tr.addEventListener('click', () => {
                        this.filterInput.value = row.filter;
                        this._checkFilter();
                        this._applyFilter(row.filter);
                        this.overlay.remove();
                        this.overlay = null;
                    });
                }
                if (!rows.length) body.appendChild(this._el('div', 'pcap-message', 'None.'));
                else body.appendChild(table);
            };
            show();
        } catch (err) {
            body.innerHTML = '';
            body.appendChild(this._el('div', 'pcap-error', err.message));
        }
    }

    async _exportObjects() {
        const body = this._overlay('Export objects');
        body.appendChild(this._el('div', 'pcap-message', 'Looking for files…'));
        try {
            const args = {};
            EO_TAPS.forEach((t, i) => { args['tap' + i] = t; });
            const r = await this.ws.call('tap', { taps: args });
            const objects = [];
            for (const t of r.taps) for (const o of t.objects || []) objects.push({ ...o, proto: t.tap.replace(/^eo:/, '').toUpperCase() });
            body.innerHTML = '';
            if (!objects.length) {
                body.appendChild(this._el('div', 'pcap-message', 'No files found (HTTP, SMB, IMF, TFTP, DICOM, FTP).'));
                return;
            }
            const table = this._el('table', 'pcap-table');
            const hr = table.createTHead().insertRow();
            for (const h of ['Packet', 'Protocol', 'Host', 'Type', 'Size', 'File name', '']) hr.appendChild(this._el('th', null, h));
            const tb = table.createTBody();
            for (const o of objects) {
                const tr = tb.insertRow();
                const cells = [o.pkt, o.proto, o.hostname, o.type, fmtBytes(o.len), o.filename];
                cells.forEach((v, i) => {
                    const td = tr.insertCell();
                    td.textContent = v;
                    if (i === 0 || i === 4) td.className = 'num';
                    if (i === 5) { td.style.maxWidth = '420px'; td.style.overflow = 'hidden'; td.style.textOverflow = 'ellipsis'; td.title = v; }
                });
                const td = tr.insertCell();
                td.appendChild(this._button('Save', 'Download this file', async ev => {
                    ev.stopPropagation();
                    try {
                        const d = await this.ws.call('download', { token: o._download });
                        const url = URL.createObjectURL(new Blob([b64bytes(d.data)], { type: d.mime || 'application/octet-stream' }));
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = (d.file || o.filename || 'object').split(/[/\\?]/).filter(Boolean).pop() || 'object';
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                    } catch (err) {
                        log.warn('Download:', err);
                    }
                }));
                tr.addEventListener('click', () => { this.overlay.remove(); this.overlay = null; this._goTo(o.pkt); });
            }
            body.appendChild(table);
        } catch (err) {
            body.innerHTML = '';
            body.appendChild(this._el('div', 'pcap-error', err.message));
        }
    }

    _error(message) {
        this.statusEl.textContent = 'Error';
        this.listBody.innerHTML = '';
        this.listBody.style.height = '';
        this.listBody.appendChild(this._el('div', 'pcap-error', message));
    }

    _destroy() {
        this.generation++;
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.ws) this.ws.terminate();
        this.ws = null;
    }
}

registerPlugin({
    id: 'pcap',
    name: 'Packet captures',
    components: {
        pcapViewer: PcapComponent,
    },
    toolbarButtons: [
        { label: 'PCAP', title: 'Open packet capture viewer', menuLabel: 'Packet capture (Wireshark)' },
    ],
    init(ctx) {
        PcapComponent._ctx = ctx;
    },
});
