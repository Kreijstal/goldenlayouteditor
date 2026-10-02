// ELF viewer (executables, shared objects, object files, kernel modules,
// firmware), loaded on demand by src/elf-plugin.js. Parses the file in plain JS
// (elf-parse.js) and shows its header, sections, segments, symbols (demangled),
// relocations and dynamic imports; disassembles the code with Capstone (built
// from source to WebAssembly by ~/git/capstone-wasm/build.sh, from
// @kreijstal/capstone-wasm on jsDelivr) in a Web Worker, lazily, as a virtualized list; builds cross
// references (calls, branches, data accesses, addresses built in registers);
// detects functions in stripped binaries from their prologues and from call
// targets; and keeps a per-file memory map (ROM/flash, RAM, MMIO, …) the user
// edits, which names the regions references go to. Read-only.
import { parseElf, detectIsa, ISA_CHOICES, ISA_BY_ID, JUMP_SLOT_TYPES } from './elf-parse.js';
import { buildPlan, isMappingSymbol, symbolAddress } from './plan.js';
import { demangle } from './demangle.js';
import { REF_KINDS, REF_KIND } from './analysis.js';

const ROW_H = 18;
const MAX_SCROLL_PX = 8e6;      // browsers cap element heights; longer lists scroll scaled
const TABS = [
    ['header', 'Header'], ['sections', 'Sections'], ['segments', 'Segments'], ['symbols', 'Symbols'],
    ['relocs', 'Relocations'], ['imports', 'Imports'], ['xrefs', 'Xrefs'], ['memmap', 'Memory map'],
    ['disasm', 'Disassembly'], ['hex', 'Hex'],
];
const REGION_KINDS = { rom: 'ROM / flash', ram: 'RAM', mmio: 'MMIO / peripheral', other: 'other' };
const KIND_SHORT = { rom: 'ROM', ram: 'RAM', mmio: 'MMIO', other: 'mem' };
const STORAGE_PREFIX = 'elf-viewer:v1:';

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function installStyles() {
    if (document.getElementById('elf-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'elf-viewer-style';
    style.textContent = `
.elfv{height:100%;display:flex;flex-direction:column;background:#fff;color:#1f2328;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0}
.elfv-bar{display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid #d0d7de;background:#f6f8fa;flex-shrink:0;flex-wrap:wrap}
.elfv button,.elfv select,.elfv input{font:inherit;font-size:12px}
.elfv-bar button,.elfv-bar select,.elfv-tool button,.elfv-tool select{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 8px;cursor:pointer;color:#333;min-height:24px}
.elfv input[type=text],.elfv input[type=search]{border:1px solid #ccc;border-radius:4px;padding:2px 6px;min-height:20px}
.elfv-bar label,.elfv-tool label{display:inline-flex;align-items:center;gap:4px;color:#57606a;font-size:12px}
.elfv-bar .elfv-status{margin-left:auto;color:#57606a;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.elfv-body{flex:1;display:flex;min-height:0}
.elfv-nav{width:118px;flex-shrink:0;border-right:1px solid #d0d7de;background:#f6f8fa;overflow:auto;padding:4px 0}
.elfv-nav button{display:block;width:100%;text-align:left;border:0;background:none;padding:5px 12px;cursor:pointer;color:#1f2328;font-size:13px}
.elfv-nav button:hover{background:#eaeef2}
.elfv-nav button.on{background:#ddf4ff;color:#0969da;font-weight:600;box-shadow:inset 3px 0 0 #0969da}
.elfv-nav button .n{color:#8c959f;font-weight:400;font-size:11px;margin-left:4px}
.elfv-panel{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.elfv-panel[hidden]{display:none}
.elfv-tool{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid #eaeef2;flex-shrink:0;flex-wrap:wrap}
.elfv-tool .info{color:#57606a;font-size:12px}
.elfv-scroll{flex:1;min-height:0;overflow:auto}
.elfv-pad{padding:10px 14px}
.elfv table.t{border-collapse:collapse;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}
.elfv table.t th{position:sticky;top:0;background:#f6f8fa;text-align:left;font-weight:600;border-bottom:1px solid #d0d7de;padding:3px 8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.elfv table.t td{padding:2px 8px;border-bottom:1px solid #f0f2f4}
.elfv table.t tr.click{cursor:pointer}
.elfv table.t tr.click:hover td{background:#f3f8ff}
.elfv table.kv td:first-child{color:#57606a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding-right:16px;vertical-align:top}
.elfv h3{font-size:13px;margin:14px 0 6px}
.elfv .muted{color:#8c959f}
.elfv .warn{color:#9a6700}
.elfv .err{color:#cf222e}
.elfv a.go,.elfv span.go{color:#0969da;cursor:pointer;text-decoration:none}
.elfv a.go:hover,.elfv span.go:hover{text-decoration:underline}
.elfv-vl{position:relative;overflow:auto;flex:1;min-height:0;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.elfv-vl .sizer{position:relative;width:100%}
.elfv-vl .win{position:absolute;left:0;min-width:100%}
.elfv-dis .win{width:max-content}
.elfv-vl .r{height:${ROW_H}px;line-height:${ROW_H}px;white-space:pre;padding:0 8px;box-sizing:border-box}
.elfv-vl .r.sel{background:#fff8c5}
.elfv-grid .r{display:grid;gap:0 12px;cursor:pointer}
.elfv-grid .r:hover{background:#f3f8ff}
.elfv-grid .r>span{overflow:hidden;text-overflow:ellipsis}
.elfv-gh{display:grid;gap:0 12px;padding:0 8px;height:22px;line-height:22px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:12px;font-weight:600;flex-shrink:0;user-select:none}
.elfv-gh span{cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.elfv-gh span.s::after{content:" ▲";color:#0969da}
.elfv-gh span.s.d::after{content:" ▼"}
.elfv .tag{display:inline-block;font:10px -apple-system,BlinkMacSystemFont,sans-serif;padding:0 4px;border-radius:3px;line-height:14px;vertical-align:1px}
.elfv .tag.det{background:#fff1e5;color:#bc4c00;border:1px solid #ffd8b5}
.elfv .tag.plt{background:#ddf4ff;color:#0969da}
.elfv .tag.rom{background:#dafbe1;color:#1a7f37}
.elfv .tag.ram{background:#ddf4ff;color:#0550ae}
.elfv .tag.mmio{background:#ffebe9;color:#cf222e}
.elfv .tag.other{background:#eaeef2;color:#57606a}
.elfv-dis .r{display:flex;gap:0}
.elfv-dis .a{color:#57606a;width:calc(var(--aw) * 1ch + 2ch);flex-shrink:0;cursor:pointer}
.elfv-dis .a:hover{color:#0969da;text-decoration:underline}
.elfv-dis .rg{width:9ch;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;color:#8c959f}
.elfv-dis .b{color:#8c959f;width:22ch;flex-shrink:0;overflow:hidden;text-overflow:ellipsis}
.elfv-dis .m{color:#8250df;width:9ch;flex-shrink:0;font-weight:600}
.elfv-dis .o{color:#1f2328}
.elfv-dis .c{color:#6e7781;margin-left:2ch}
.elfv-dis .c .str{color:#0a3069}
.elfv-dis .c .rl{color:#953800}
.elfv-dis .r.lbl{color:#0550ae;font-weight:600}
.elfv-dis .r.lbl .x{font-weight:400;color:#8c959f;margin-left:2ch}
.elfv-dis .r.hdr{color:#57606a;background:#f6f8fa;font-style:italic}
.elfv-dis .r.data .m{color:#6e7781}
.elfv-dis .r.bad .m{color:#cf222e}
.elfv-dis .r.ld{color:#c0c0c0}
.elfv-hexv .ad{color:#57606a}
.elfv-hexv .hx{color:#1f2328}
.elfv-hexv .as{color:#6e7781}
.elfv-hexv .hl{background:#fff8c5}
.elfv-mm td input[type=text]{box-sizing:content-box;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.elfv-mm td{padding:2px 4px}
.elfv-mm td.perm label{margin-right:4px}
.elfv-msg{margin:24px auto;max-width:560px;padding:14px 18px;background:#fff;border:1px solid #d0d7de;border-radius:6px;line-height:1.5}
.elfv-msg.err{border-color:#ff8182;background:#ffebe9;color:#82071e}
.elfv-prog{height:3px;background:#0969da;width:0;transition:width .15s;flex-shrink:0}
`;
    document.head.appendChild(style);
}

// --- a virtualized list: fixed-height rows, rendered as HTML strings for the visible window
class VList {
    constructor(parent, { render, className = '', onClick, onResize }) {
        this.render = render;
        this.count = 0;
        this.el = document.createElement('div');
        this.el.className = 'elfv-vl ' + className;
        this.sizer = document.createElement('div');
        this.sizer.className = 'sizer';
        this.win = document.createElement('div');
        this.win.className = 'win';
        this.sizer.appendChild(this.win);
        this.el.appendChild(this.sizer);
        parent.appendChild(this.el);
        this._raf = 0;
        this.el.addEventListener('scroll', () => this.schedule());
        if (onClick) this.el.addEventListener('click', (ev) => {
            const row = ev.target.closest('.r');
            if (!row || row.dataset.i === undefined) return;
            onClick(ev, +row.dataset.i, row);
        });
        this._ro = new ResizeObserver(() => { this.schedule(); if (onResize) onResize(); });
        this._ro.observe(this.el);
    }
    setCount(n) {
        this.count = n;
        this.sizer.style.height = Math.min(n * ROW_H, MAX_SCROLL_PX) + 'px';
        this.schedule();
    }
    _geom() {
        const viewH = this.el.clientHeight || 400;
        const total = this.count * ROW_H;
        const virt = Math.min(total, MAX_SCROLL_PX);
        const ratio = total > virt && virt > viewH ? (total - viewH) / (virt - viewH) : 1;
        return { viewH, ratio };
    }
    schedule() {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
    }
    firstVisible() {
        const { ratio } = this._geom();
        return Math.floor(this.el.scrollTop * ratio / ROW_H);
    }
    draw() {
        const { viewH, ratio } = this._geom();
        const vTop = this.el.scrollTop * ratio;
        const first = Math.max(0, Math.floor(vTop / ROW_H));
        const n = Math.min(this.count - first, Math.ceil(viewH / ROW_H) + 2);
        this.win.style.top = (this.el.scrollTop - (vTop - first * ROW_H)) + 'px';
        const parts = [];
        for (let i = 0; i < n; i++) parts.push(this.render(first + i));
        this.win.innerHTML = parts.join('');
        this.visible = [first, first + n];
    }
    scrollTo(i, align = 'third') {
        const { viewH, ratio } = this._geom();
        let vTop = i * ROW_H - (align === 'top' ? 0 : viewH / 3);
        this.el.scrollTop = Math.max(0, vTop / ratio);
        this.draw();
    }
    destroy() { this._ro.disconnect(); cancelAnimationFrame(this._raf); }
}

// --- a sortable, filterable virtual table
class VTable {
    constructor(parent, { columns, onClick }) {
        // columns: [{ key, label, width, sort: (row) => value, html: (row) => string }]
        this.columns = columns;
        this.rows = [];
        this.view = [];
        this.sortKey = null;
        this.sortDir = 1;
        const tmpl = columns.map(c => c.width || '1fr').join(' ');
        this.head = document.createElement('div');
        this.head.className = 'elfv-gh';
        this.head.style.gridTemplateColumns = tmpl;
        this.head.innerHTML = columns.map(c => `<span data-k="${c.key}" title="Sort by ${esc(c.label)}">${esc(c.label)}</span>`).join('');
        parent.appendChild(this.head);
        this.head.addEventListener('click', (ev) => {
            const k = ev.target.closest('span') && ev.target.closest('span').dataset.k;
            if (!k) return;
            if (this.sortKey === k) this.sortDir = -this.sortDir; else { this.sortKey = k; this.sortDir = 1; }
            this.apply();
        });
        this.list = new VList(parent, {
            onResize: () => this.alignHead(),
            className: 'elfv-grid',
            render: (i) => {
                const row = this.view[i];
                if (!row) return '';
                return `<div class="r" data-i="${i}" style="grid-template-columns:${tmpl}">${columns.map(c => `<span>${c.html(row)}</span>`).join('')}</div>`;
            },
            onClick: (ev, i) => onClick && onClick(ev, this.view[i]),
        });
        this.filterFn = null;
    }
    setRows(rows) { this.rows = rows; this.apply(); }
    setFilter(fn) { this.filterFn = fn; this.apply(); }
    apply() {
        let v = this.filterFn ? this.rows.filter(this.filterFn) : this.rows.slice();
        if (this.sortKey) {
            const c = this.columns.find(x => x.key === this.sortKey);
            const d = this.sortDir;
            const vals = new Map(v.map(r => [r, c.sort(r)]));
            v.sort((a, b) => {
                const x = vals.get(a), y = vals.get(b);
                return (x < y ? -1 : x > y ? 1 : 0) * d;
            });
        }
        this.view = v;
        for (const s of this.head.children) {
            s.classList.toggle('s', s.dataset.k === this.sortKey);
            s.classList.toggle('d', s.dataset.k === this.sortKey && this.sortDir < 0);
        }
        this.list.setCount(v.length);
        this.list.draw();
        this.alignHead();
    }
    // the header's columns line up with the rows' (which lose the scrollbar's width)
    alignHead() {
        const sb = this.list.el.offsetWidth - this.list.el.clientWidth;
        this.head.style.paddingRight = (8 + Math.max(0, sb)) + 'px';
    }
    destroy() { this.list.destroy(); }
}

function lowerBound(arr, x, key) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (key(arr[mid]) < x) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function parseHexOrDec(s) {
    s = s.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s);
    if (/^[0-9a-f]+$/i.test(s)) return BigInt('0x' + s);
    return null;
}

class ElfViewer {
    constructor(host, opts) {
        installStyles();
        this.host = host;
        this.opts = opts;
        this.name = opts.name || '';
        this.storageKey = STORAGE_PREFIX + (opts.storageKey || this.name);
        this.lists = [];
        this.history = [];
        this.rowCache = new Map();
        this.pending = new Set();
        this.reqId = 0;
        this.root = document.createElement('div');
        this.root.className = 'elfv';
        host.appendChild(this.root);
        try {
            this.elf = parseElf(opts.bytes);
        } catch (err) {
            this.root.innerHTML = `<div class="elfv-msg err"></div>`;
            this.root.firstChild.textContent = 'Not a readable ELF file: ' + err.message;
            this.status(err.message, true);
            return;
        }
        this.settings = this.loadSettings();
        this.detected = detectIsa(this.elf);
        this.prepareSymbols();
        this.buildUi();
        this.applyTarget();
    }

    // ---------------------------------------------------------------- settings (localStorage)
    loadSettings() {
        const def = { isa: 'auto', endian: 'auto', armMode: 'auto', detect: 'auto', demangle: true, regions: null };
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (raw) return Object.assign(def, JSON.parse(raw));
        } catch (err) { /* private mode, blocked storage: defaults */ }
        return def;
    }
    saveSettings() {
        try { localStorage.setItem(this.storageKey, JSON.stringify(this.settings)); } catch (err) { /* not persisted */ }
    }

    status(text, isError) { if (this.opts.onStatus) this.opts.onStatus(text, isError); }

    // ---------------------------------------------------------------- formatting
    fmt(addr) {
        const w = this.elf.addrWidth;
        if (this.elf.bias) return (BigInt(addr) + this.elf.bias).toString(16).padStart(w, '0');
        return (addr < 0 ? 0 : addr).toString(16).padStart(w, '0');
    }
    fmt0x(addr) {
        if (this.elf.bias) return '0x' + (BigInt(addr) + this.elf.bias).toString(16);
        return '0x' + addr.toString(16);
    }
    hexN(n) { return '0x' + n.toString(16); }
    dname(s) {
        if (!s) return '';
        if (!this.settings.demangle) return s;
        if (!this._dm) this._dm = new Map();
        let d = this._dm.get(s);
        if (d === undefined) { d = demangle(s) || s; this._dm.set(s, d); }
        return d;
    }
    // user input address (absolute) -> viewer address
    fromAbs(big) { return Number(BigInt.asUintN(64, big - this.elf.bias)); }

    // ---------------------------------------------------------------- symbols
    prepareSymbols() {
        const elf = this.elf;
        for (const s of elf.symbols) s.addr = symbolAddress(elf, s);
        this.realFuncCount = elf.symbols.filter(s => s.type === 2 && s.shndx !== 0).length;
    }

    // Code labels: real symbols, PLT stubs, detected functions. Rebuilt after the sweep.
    buildLabels() {
        const elf = this.elf;
        const inCode = (a) => this.codeRegionAt(a) !== null;
        const labels = [];
        const seen = new Map();
        const add = (l) => {
            const k = l.addr + '\0' + l.name;
            if (seen.has(k)) return;
            seen.set(k, l);
            labels.push(l);
        };
        const inSymtab = new Set(elf.symbols.filter(t => t.table === 'symtab').map(t => t.name + '\0' + t.addr));
        for (const s of elf.symbols) {
            if (!s.name || s.shndx === 0 || s.type === 3 || s.type === 4 || isMappingSymbol(s.name)) continue;
            if (s.table === 'dynsym' && inSymtab.has(s.name + '\0' + s.addr)) continue;
            add({ addr: s.addr, name: s.name, size: s.size, kind: 'sym', sym: s, func: s.type === 2 || inCode(s.addr) });
        }
        for (const p of this.pltLabels || []) add(p);
        this.detectedFuncs = [];
        if (this.funcs) {
            const have = new Set(labels.filter(l => l.func).map(l => l.addr));
            const found = new Map();
            for (const f of this.funcs) if (!have.has(f.addr) && !found.has(f.addr)) found.set(f.addr, f.why);
            if (this.refs) {
                const { from, to, kind } = this.refs;
                for (let i = 0; i < to.length; i++) {
                    if (kind[i] !== REF_KIND.call) continue;
                    const t = to[i];
                    if (have.has(t) || found.has(t) || !inCode(t)) continue;
                    found.set(t, 'call target');
                }
            }
            for (const [addr, why] of found) {
                const l = { addr, name: 'sub_' + this.fmt(addr).replace(/^0+(?=.)/, ''), size: 0, kind: 'detected', why, func: true };
                this.detectedFuncs.push(l);
                if (this.detectOn()) add(l);
            }
        }
        labels.sort((a, b) => a.addr - b.addr || (a.kind === 'sym' ? -1 : 1));
        this.labels = labels;
        this.labelsAt = new Map();
        for (const l of labels) {
            if (!l.func && !inCode(l.addr)) continue;
            const arr = this.labelsAt.get(l.addr);
            if (arr) arr.push(l); else this.labelsAt.set(l.addr, [l]);
        }
        // for "name+off": functions and objects with sizes, plus code labels
        this.symLabels = labels.filter(l => l.func || l.size > 0 || (l.sym && l.sym.type === 1));
    }

    detectOn() {
        const d = this.settings.detect;
        return d === 'auto' ? this.realFuncCount === 0 : !!d;
    }

    // "name+0x10" for an address, or null
    symbolize(addr, exactOnly = false) {
        const L = this.symLabels;
        if (!L || !L.length) return null;
        let i = lowerBound(L, addr + 1, l => l.addr) - 1;
        if (i < 0) return null;
        // prefer a real symbol over a detected one at the same address
        let l = L[i];
        while (i > 0 && L[i - 1].addr === l.addr && l.kind !== 'sym') { i--; if (L[i].kind === 'sym') l = L[i]; }
        const off = addr - l.addr;
        if (off === 0) return { label: l, text: this.dname(l.name) };
        if (exactOnly) return null;
        if (l.size > 0 ? off < l.size : (l.func && off < 0x10000 && this.codeRegionAt(addr) === this.codeRegionAt(l.addr))) {
            return { label: l, text: this.dname(l.name) + '+' + this.hexN(off) };
        }
        return null;
    }

    findSymbolByName(q) {
        const exact = this.labels.find(l => l.name === q) || this.labels.find(l => this.dname(l.name) === q);
        if (exact) return exact;
        const lq = q.toLowerCase();
        return this.labels.find(l => l.name.toLowerCase() === lq || this.dname(l.name).toLowerCase() === lq)
            || this.elf.symbols.find(s => s.name === q) && { addr: null, name: q, sym: this.elf.symbols.find(s => s.name === q), kind: 'sym' };
    }

    // "main", "main+0x10", "0x1234", "1234" -> { addr } or { sym (undefined) } or null
    resolve(q) {
        q = q.trim();
        if (!q) return null;
        const m = /^(.*?)\s*\+\s*(0x[0-9a-f]+|\d+)$/i.exec(q);
        if (m && m[1]) {
            const base = this.resolve(m[1]);
            if (base && base.addr !== null && base.addr !== undefined) return { addr: base.addr + Number(BigInt(m[2])), label: base.label };
        }
        const l = this.findSymbolByName(q);
        if (l) return { addr: l.addr, label: l, sym: l.sym };
        const v = parseHexOrDec(q);
        if (v !== null) return { addr: this.fromAbs(v) };
        return null;
    }

    // ---------------------------------------------------------------- regions
    codeRegionAt(addr) {
        if (!this.plan) return null;
        for (const r of this.plan.regions) if (addr >= r.addr && addr < r.addr + r.size) return r;
        return null;
    }
    sectionAt(addr) {
        if (!this._secs) this._secs = this.elf.sections.filter(s => s.alloc && s.size && !(s.type === 8 && (s.flags & 0x400))).sort((a, b) => a.addr - b.addr);  // not .tbss: it takes no addresses
        const S = this._secs;
        let i = lowerBound(S, addr + 1, s => s.addr) - 1;
        let best = null;
        // overlapping sections (TLS .tbss): look back a little
        for (let k = i; k >= 0 && k > i - 4; k--) {
            const s = S[k];
            if (addr >= s.addr && addr < s.addr + s.size && (!best || s.size < best.size)) best = s;
        }
        return best;
    }
    // memory-map region (the most specific one)
    regionAt(addr) {
        const R = this.memRegions;
        if (!R) return null;
        let best = null;
        for (const r of R) if (addr >= r.startN && addr < r.startN + r.sizeN && (!best || r.sizeN < best.sizeN)) best = r;
        return best;
    }

    defaultRegions() {
        const elf = this.elf;
        const out = [];
        const loads = elf.segments.filter(p => p.type === 1 && p.memsz > 0);
        for (const p of loads) {
            const secs = elf.sections.filter(s => s.alloc && s.size && s.addr >= p.vaddr && s.addr < p.vaddr + p.memsz).map(s => s.name);
            const kind = (p.flags & 2) ? 'ram' : 'rom';
            // named after its most telling section: ".text +3"
            const main = ['.text', '.data', '.rodata', '.bss', '.isr_vector', '.init_array'].find(n => secs.includes(n)) || secs[0];
            out.push({ name: main ? main + (secs.length > 1 ? ' +' + (secs.length - 1) : '') : `LOAD[${p.index}]`, start: this.fmt0x(p.vaddr), size: this.hexN(p.memsz), kind, perms: p.flagsStr.replace(/-/g, '').toLowerCase() });
            // loaded from elsewhere (initialised data copied from flash at reset)
            if (p.paddr !== p.vaddr && p.filesz > 0) out.push({ name: `load image of ${secs[0] || 'LOAD[' + p.index + ']'}`, start: this.fmt0x(p.paddr), size: this.hexN(p.filesz), kind: 'rom', perms: 'r' });
        }
        if (!loads.length) {
            for (const s of elf.sections) {
                if (!s.alloc || !s.size) continue;
                out.push({ name: s.name, start: this.fmt0x(s.addr), size: this.hexN(s.size), kind: s.write ? 'ram' : 'rom', perms: 'r' + (s.write ? 'w' : '') + (s.exec ? 'x' : '') });
            }
        }
        if (elf.armAttrs && elf.armAttrs.profile === 'M') out.push(...CORTEX_M_MAP.map(r => ({ ...r })));
        return out;
    }

    normalizeRegions() {
        const list = this.settings.regions || this.defaultRegions();
        this.memRegions = [];
        for (const r of list) {
            const s = parseHexOrDec(String(r.start || '')), z = parseHexOrDec(String(r.size || ''));
            if (s === null || z === null) continue;
            this.memRegions.push({ ...r, startN: this.fromAbs(s), sizeN: Number(z) });
        }
    }

    // ---------------------------------------------------------------- UI shell
    buildUi() {
        const elf = this.elf, h = elf.header;
        const det = this.detected;
        const isaOpts = [`<option value="auto">Auto: ${esc(det ? ISA_BY_ID[det.id].label : 'none (' + h.machineName + ')')}</option>`]
            .concat(ISA_CHOICES.map(c => `<option value="${c.id}">${esc(c.label)}</option>`)).join('');
        this.root.innerHTML = `
<div class="elfv-bar">
  <label title="Instruction set to disassemble as">ISA <select class="x-isa">${isaOpts}</select></label>
  <label title="Byte order of the code">Endian <select class="x-endian"><option value="auto">Auto (${h.endian})</option><option value="little">little</option><option value="big">big</option></select></label>
  <label class="x-armwrap" title="ARM or Thumb, where mapping symbols do not say">Mode <select class="x-arm"><option value="auto">Auto</option><option value="arm">ARM</option><option value="thumb">Thumb</option></select></label>
  <label title="Function prologues and call targets as sub_… labels (not real symbols)"><input type="checkbox" class="x-detect"> Detect functions</label>
  <label title="Show C++ names demangled"><input type="checkbox" class="x-demangle"> Demangle</label>
  <input type="text" class="x-goto" placeholder="Go to symbol or address" style="width:180px">
  <span class="elfv-status"></span>
</div>
<div class="elfv-prog"></div>
<div class="elfv-body">
  <div class="elfv-nav">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}<span class="n" data-n="${k}"></span></button>`).join('')}</div>
  ${TABS.map(([k]) => `<div class="elfv-panel" data-panel="${k}" hidden></div>`).join('')}
</div>`;
        this.$ = (sel) => this.root.querySelector(sel);
        this.panels = {};
        for (const [k] of TABS) this.panels[k] = this.$(`[data-panel="${k}"]`);
        this.statusEl = this.$('.elfv-status');
        this.progEl = this.$('.elfv-prog');
        this.$('.elfv-nav').addEventListener('click', (ev) => {
            const b = ev.target.closest('button[data-tab]');
            if (b) this.showTab(b.dataset.tab);
        });
        const isaSel = this.$('.x-isa');
        isaSel.value = this.settings.isa in ISA_BY_ID ? this.settings.isa : 'auto';
        isaSel.onchange = () => { this.settings.isa = isaSel.value; this.saveSettings(); this.applyTarget(); };
        const en = this.$('.x-endian');
        en.value = this.settings.endian;
        en.onchange = () => { this.settings.endian = en.value; this.saveSettings(); this.applyTarget(); };
        const arm = this.$('.x-arm');
        arm.value = this.settings.armMode;
        arm.onchange = () => { this.settings.armMode = arm.value; this.saveSettings(); this.applyTarget(); };
        const detect = this.$('.x-detect');
        detect.checked = this.detectOn();
        detect.onchange = () => { this.settings.detect = detect.checked; this.saveSettings(); this.relabel(); };
        const dm = this.$('.x-demangle');
        dm.checked = this.settings.demangle;
        dm.onchange = () => { this.settings.demangle = dm.checked; this.saveSettings(); this.relabel(); };
        const go = this.$('.x-goto');
        go.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter') return;
            const r = this.resolve(go.value);
            if (!r || r.addr === null || r.addr === undefined) { this.flash(`Not found: ${go.value}`); return; }
            this.goto(r.addr);
        });
        this.root.addEventListener('click', (ev) => this.onLinkClick(ev));

        this.normalizeRegions();
        this.renderHeader();
        this.renderSections();
        this.renderSegments();
        this.renderSymbolsPanel();
        this.renderRelocs();
        this.invalidate('imports', () => this.renderImports());
        this.renderXrefsPanel();
        this.renderMemMap();
        this.renderDisasmPanel();
        this.renderHexPanel();
        this.setCount('sections', elf.sections.length);
        this.setCount('segments', elf.segments.length);
        this.setCount('relocs', elf.relocs.length);
        this.setCount('imports', elf.symbols.filter(s => s.shndx === 0 && s.name && s.table === (elf.symbols.some(x => x.table === 'dynsym') ? 'dynsym' : 'symtab')).length);
        this.showTab(this.plan === undefined && this.detected ? 'disasm' : 'header');
    }

    setCount(tab, n) {
        const el = this.$(`[data-n="${tab}"]`);
        if (el) el.textContent = n ? String(n) : '';
    }

    // re-render a panel now when it is shown, else when it next is
    invalidate(tab, fn) {
        if (!this.dirty) this.dirty = new Map();
        if (this.tab === tab) { this.dirty.delete(tab); fn(); } else this.dirty.set(tab, fn);
    }

    showTab(k) {
        this.tab = k;
        if (this.dirty && this.dirty.has(k)) { const fn = this.dirty.get(k); this.dirty.delete(k); fn(); }
        for (const b of this.root.querySelectorAll('.elfv-nav button')) b.classList.toggle('on', b.dataset.tab === k);
        for (const [key, p] of Object.entries(this.panels)) p.hidden = key !== k;
        for (const l of this.lists) l.schedule();
    }

    flash(text) {
        this.statusEl.textContent = text;
        this.statusEl.classList.add('warn');
        clearTimeout(this._flashT);
        this._flashT = setTimeout(() => { this.statusEl.classList.remove('warn'); this.updateStatus(); }, 2500);
    }

    updateStatus() {
        const h = this.elf.header;
        const parts = [h.class, h.endian + ' endian', h.machineName, h.typeName.replace(/ \(.*/, '')];
        if (this.isa) parts.push(this.isa.label);
        if (this.sweepInfo) parts.push(this.sweepInfo);
        this.statusEl.textContent = this.sweepInfo || '';
        this.status(parts.join(' · '));
    }

    // links anywhere: data-go (address), data-xref (address), data-tab
    onLinkClick(ev) {
        const a = ev.target.closest('[data-go],[data-xref],[data-hexsec]');
        if (!a || !this.root.contains(a)) return;
        if (a.dataset.go !== undefined) { ev.preventDefault(); this.goto(+a.dataset.go); }
        else if (a.dataset.xref !== undefined) { ev.preventDefault(); this.showXrefs(+a.dataset.xref); }
        else if (a.dataset.hexsec !== undefined) { ev.preventDefault(); this.showHex('s' + a.dataset.hexsec); }
    }

    // Go to an address: disassembly when it is code, else the hex view of its section, else its xrefs
    goto(addr, opts = {}) {
        if (this.codeRegionAt(addr) && this.rows) {
            if (!opts.noHistory && this.tab === 'disasm' && this.disList) {
                const cur = this.addrOfRow(this.disList.firstVisible() + 3);
                if (cur !== null) this.history.push(cur);
            }
            this.showTab('disasm');
            this.scrollDisasmTo(addr);
            return;
        }
        if (this.codeRegionAt(addr) && !this.rows) { this.showTab('disasm'); this.pendingGoto = addr; return; }
        const sec = this.sectionAt(addr);
        if (sec && sec.hasData) { this.showHex('s' + sec.index, addr); return; }
        this.showXrefs(addr);
    }

    // ---------------------------------------------------------------- target (ISA) and analysis
    effectiveIsaId() {
        if (this.settings.isa !== 'auto' && ISA_BY_ID[this.settings.isa]) return this.settings.isa;
        return this.detected ? this.detected.id : null;
    }

    applyTarget() {
        const id = this.effectiveIsaId();
        this.isa = id ? ISA_BY_ID[id] : null;
        this.$('.x-armwrap').style.display = this.isa && this.isa.armFamily ? '' : 'none';
        if (this.worker) { this.worker.terminate(); this.worker = null; }
        this.rows = null;
        this.refs = null;
        this.sweptRefs = null;
        this.funcs = null;
        this.pltLabels = null;
        this.disRows = null;
        this.disRowCount = 0;
        this._inflight = null;
        this._batch = null;
        this.rowCache.clear();
        this.pending.clear();
        this.sweepInfo = '';
        this.plan = id ? buildPlan(this.elf, id, this.settings.armMode) : { regions: buildPlan(this.elf, 'x86', 'auto').regions.map(r => ({ ...r, runs: [] })), memory: [], codeLe: true };
        if (this.settings.endian !== 'auto') this.plan.codeLe = this.settings.endian === 'little';
        this.buildLabels();
        this.buildRelocRefs();
        this.refreshAfterAnalysis();
        this.updateStatus();
        if (!id) { this.showDisasmMessage(`No disassembler for e_machine ${this.elf.header.machine} (${this.elf.header.machineName}). Choose an ISA in the toolbar to disassemble anyway.`); return; }
        if (!this.plan.regions.length) { this.showDisasmMessage('No executable sections or segments in this file.'); return; }
        this.startWorker();
    }

    startWorker() {
        const elf = this.elf;
        const setup = {
            le: this.settings.endian === 'auto' ? elf.header.le : this.settings.endian === 'little',
            codeLe: this.plan.codeLe, is64: elf.header.is64, bias: elf.bias.toString(), isaId: this.isa.id,
            memory: this.plan.memory, regions: this.plan.regions.map(r => ({ id: r.id, name: r.name, addr: r.addr, offset: r.offset, size: r.size, runs: r.runs })),
        };
        let w;
        try {
            w = new Worker(new URL('./elf-worker.js', import.meta.url), { type: 'module' });
        } catch (err) {
            this.showDisasmMessage('Could not start the disassembler worker: ' + err.message);
            return;
        }
        this.worker = w;
        const t0 = performance.now();
        this.sweepInfo = 'loading Capstone…';
        this.updateStatus();
        w.onmessage = (ev) => {
            if (w !== this.worker) return;
            const m = ev.data;
            if (m.type === 'ready') { this.capstoneVersion = m.version; this.sweepInfo = 'disassembling…'; this.updateStatus(); }
            else if (m.type === 'progress') {
                this.progEl.style.width = (m.frac * 100).toFixed(1) + '%';
                this.sweepInfo = `disassembling ${m.where} ${(m.frac * 100).toFixed(0)}%`;
                this.updateStatus();
            } else if (m.type === 'swept') {
                this.progEl.style.width = '0';
                this.onSwept(m, performance.now() - t0);
            } else if (m.type === 'rows') this.onRows(m);
            else if (m.type === 'error') {
                if (m.id !== undefined) { this.pending.clear(); return; }
                this.progEl.style.width = '0';
                this.sweepInfo = 'disassembler error';
                this.updateStatus();
                this.showDisasmMessage('Disassembly failed: ' + m.message);
            }
        };
        w.onerror = (ev) => {
            if (w !== this.worker) return;
            this.showDisasmMessage('The disassembler worker failed: ' + (ev.message || 'could not load Capstone from jsDelivr'));
        };
        // a copy: the page keeps its bytes for the hex view
        const copy = elf.bytes.slice().buffer;
        w.postMessage({ type: 'init', bytes: copy, setup }, [copy]);
    }

    onSwept(m, ms) {
        this.rows = m.rows;
        this.funcs = m.funcs;
        const n = Object.values(m.rows).reduce((a, r) => a + r.length, 0);
        // the sweep's references, plus those of relocations in code
        this.sweptRefs = m.refs;
        this.mergeRefs();
        this.computePltLabels();
        this.buildLabels();
        this.buildDisasmRows();
        this.sweepInfo = `${n.toLocaleString()} instructions, ${this.refs.to.length.toLocaleString()} refs (${(ms / 1000).toFixed(1)} s)`;
        this.updateStatus();
        this.refreshAfterAnalysis();
        if (this.pendingGoto !== undefined) { const a = this.pendingGoto; delete this.pendingGoto; this.goto(a); }
        else if (this.disList && this.disList.el.scrollTop === 0) this.scrollDisasmTo(this.initialAddress(), 'top');
    }

    initialAddress() {
        const main = this.labels.find(l => l.name === 'main' && l.func);
        if (main) return main.addr;
        const e = this.elf.header.entry;
        if (this.codeRegionAt(e)) return e;
        return this.plan.regions[0].addr;
    }

    // relocations that apply inside code: their symbols are references too (object files)
    buildRelocRefs() {
        const elf = this.elf;
        const from = [], to = [], kind = [];
        this.codeRelocs = [];
        for (const r of elf.relocs) {
            if (!this.codeRegionAt(r.offset)) continue;
            this.codeRelocs.push(r);
            const s = r.symbol;
            if (!s || s.shndx === 0) continue;
            let t;
            if (s.type === 3 && s.section) {
                const pcrel = /PC|PLT|REL(?!ATIVE)|CALL|JUMP|BRANCH|JAL|PREL/.test(r.typeName);
                t = s.section.addr + Number(r.addend || 0n) + (pcrel && (elf.header.machine === 62 || elf.header.machine === 3) ? 4 : 0);
            } else t = s.addr;
            from.push(r.offset);
            to.push(t);
            kind.push(/CALL|PLT32|JUMP|BRANCH|JAL|PC24|THM_CALL|REL24|26/.test(r.typeName) && !/GOT|HI|LO|ABS/.test(r.typeName) ? REF_KIND.call : REF_KIND.addr);
        }
        this.codeRelocs.sort((a, b) => a.offset - b.offset);
        this.codeRelocsByName = new Map();
        for (const r of this.codeRelocs) {
            if (!r.symName) continue;
            const l = this.codeRelocsByName.get(r.symName);
            if (l) l.push(r); else this.codeRelocsByName.set(r.symName, [r]);
        }
        this.relocRefs = { from, to, kind };
        this.mergeRefs();
    }

    mergeRefs() {
        const a = this.sweptRefs || { from: [], to: [], kind: [] }, b = this.relocRefs || { from: [], to: [], kind: [] };
        this._topTargets = null;
        if (!b.from.length && a.byFrom) {
            // the worker sorted them already
            this.refs = a;
            this.byFrom = a.byFrom;
            this.byTo = a.byTo;
            return;
        }
        const n = a.from.length + b.from.length;
        const from = new Float64Array(n), to = new Float64Array(n), kind = new Uint8Array(n);
        from.set(a.from); to.set(a.to); kind.set(a.kind);
        from.set(b.from, a.from.length); to.set(b.to, a.from.length); kind.set(b.kind, a.from.length);
        this.refs = { from, to, kind };
        const byFrom = new Uint32Array(n), byTo = new Uint32Array(n);
        for (let i = 0; i < n; i++) byFrom[i] = byTo[i] = i;
        byFrom.sort((x, y) => from[x] - from[y]);
        byTo.sort((x, y) => to[x] - to[y] || from[x] - from[y]);
        this.byFrom = byFrom;
        this.byTo = byTo;
    }

    refsFrom(addr) {
        const { from } = this.refs;
        const ord = this.byFrom;
        let lo = 0, hi = ord.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (from[ord[mid]] < addr) lo = mid + 1; else hi = mid; }
        const out = [];
        for (let i = lo; i < ord.length && from[ord[i]] === addr; i++) out.push(ord[i]);
        return out;
    }
    refsTo(lo, hi = lo + 1) {
        const { to } = this.refs;
        const ord = this.byTo;
        let a = 0, b = ord.length;
        while (a < b) { const mid = (a + b) >> 1; if (to[ord[mid]] < lo) a = mid + 1; else b = mid; }
        const out = [];
        for (let i = a; i < ord.length && to[ord[i]] < hi; i++) out.push(ord[i]);
        return out;
    }

    // Is a reference worth showing: calls, jumps and loads/stores always; address constants only when
    // they land somewhere known (a section, a memory-map region, a symbol)
    refShown(i) {
        const k = this.refs.kind[i];
        if (k === REF_KIND.call || k === REF_KIND.jump || k === REF_KIND.read || k === REF_KIND.write) return true;
        const t = this.refs.to[i];
        return !!(this.sectionAt(t) || this.regionAt(t) || this.symbolize(t, true));
    }

    // "MMIO write", "RAM read", "address of (ROM)", "call"
    refClass(i) {
        const k = REF_KINDS[this.refs.kind[i]];
        if (k === 'call' || k === 'jump') return k;
        const reg = this.regionAt(this.refs.to[i]);
        const where = reg ? KIND_SHORT[reg.kind] || 'mem' : (this.sectionAt(this.refs.to[i]) || {}).name || '';
        const what = { read: 'read', write: 'write', addr: 'address', ptr: 'pointer' }[k];
        return where ? `${where} ${what}` : what;
    }

    computePltLabels() {
        const elf = this.elf;
        const types = JUMP_SLOT_TYPES[elf.header.machine] || [];
        const slots = new Map();
        for (const r of elf.relocs) if (types.includes(r.type) && r.symName) slots.set(r.offset, r.symName);
        const out = [];
        const seen = new Set();
        if (slots.size && this.refs) {
            const { from, to, kind } = this.refs;
            for (let i = 0; i < from.length; i++) {
                if (kind[i] !== REF_KIND.read && kind[i] !== REF_KIND.addr && kind[i] !== REF_KIND.ptr) continue;
                const name = slots.get(to[i]);
                if (!name) continue;
                const sec = this.sectionAt(from[i]);
                if (!sec || !/^\.plt/.test(sec.name)) continue;
                const ent = sec.entsize || 16;
                const start = sec.addr + Math.floor((from[i] - sec.addr) / ent) * ent;
                if (seen.has(start)) continue;
                seen.add(start);
                out.push({ addr: start, name: name + '@plt', size: ent, kind: 'plt', func: true });
            }
        }
        this.pltLabels = out;
    }

    relabel() {
        this._dm = null;
        this.buildLabels();
        if (this.rows) this.buildDisasmRows();
        this.refreshAfterAnalysis();
    }

    refreshAfterAnalysis() {
        this.fillSymbols();
        if (this.disList) { this.disList.setCount(this.disRowCount || 0); this.disList.draw(); }
        this.invalidate('xrefs', () => this.renderXrefResults());
        this.invalidate('imports', () => this.renderImports());
        this.invalidate('header', () => this.renderHeader());
        this.setCount('symbols', this.symTable ? this.symTable.rows.length : 0);
        this.setCount('xrefs', this.refs ? this.refs.to.length : 0);
    }

    // ---------------------------------------------------------------- Header
    renderHeader() {
        const elf = this.elf, h = elf.header;
        const p = this.panels.header;
        const rows = [];
        const kv = (k, v) => rows.push(`<tr><td>${esc(k)}</td><td>${v}</td></tr>`);
        kv('File', esc(this.name) + ` <span class="muted">(${elf.bytes.length.toLocaleString()} bytes)</span>`);
        kv('Class', esc(h.class));
        kv('Data', esc(h.endian + ' endian') + (h.machine === 40 && (h.flags & 0x800000) ? ' <span class="muted">(BE8: code little endian)</span>' : ''));
        kv('OS/ABI', esc(`${h.osabiName} (${h.osabi})`) + (h.abiversion ? ', ABI version ' + h.abiversion : ''));
        kv('Type', esc(h.typeName) + (elf.synthetic ? ' <span class="warn">— sections placed at made-up addresses one after the other, as all are at 0</span>' : ''));
        kv('Machine', esc(`${h.machineName} (e_machine ${h.machine})`));
        kv('ISA', this.isa ? esc(this.isa.label) + (this.settings.isa === 'auto' && this.detected ? ` <span class="muted">(${esc(this.detected.why)})</span>` : ' <span class="warn">(set by hand)</span>') : '<span class="warn">none known — choose one in the toolbar</span>');
        kv('Entry point', this.codeRegionAt(h.entry) ? `<a class="go" data-go="${h.entry}">${this.fmt0x(h.entry)}</a>` : esc(this.fmt0x(h.entry)));
        kv('Flags', esc('0x' + h.flags.toString(16)) + (flagsText(h) ? ' <span class="muted">' + esc(flagsText(h)) + '</span>' : ''));
        kv('Headers', esc(`ELF ${h.ehsize} bytes; ${elf.segments.length} program headers at ${h.phoff} (${h.phentsize} bytes each); ${elf.sections.length} section headers at ${h.shoff} (${h.shentsize} bytes each); names in section ${h.shstrndx}`));
        if (h.interp) kv('Interpreter', esc(h.interp));
        if (h.soname) kv('SONAME', esc(h.soname));
        if (elf.needed.length) kv('Needed', esc(elf.needed.join(', ')));
        if (h.buildId) kv('Build ID', esc(h.buildId));
        if (elf.armAttrs) kv('ARM attributes', esc([elf.armAttrs.cpuName, elf.armAttrs.arch && 'Arm' + elf.armAttrs.arch, elf.armAttrs.profile && elf.armAttrs.profile + '-profile'].filter(Boolean).join(', ')));
        for (const n of elf.notes) kv('Note ' + n.owner, esc(`${n.what}: ${n.text}`) + ` <span class="muted">${esc(n.section || '')}</span>`);
        if (elf.bias) kv('Addresses', `<span class="muted">above 2^53: kept relative to 0x${elf.bias.toString(16)} inside the viewer</span>`);
        kv('Symbols', `${elf.symbols.filter(s => s.table === 'symtab').length} in .symtab, ${elf.symbols.filter(s => s.table === 'dynsym').length} in .dynsym` + (this.realFuncCount ? '' : ' <span class="warn">— no function symbols (stripped?): turn on Detect functions</span>'));
        if (this.detectedFuncs) kv('Detected functions', `${this.detectedFuncs.length} <span class="muted">(prologues and call targets${this.detectOn() ? '' : '; hidden: Detect functions is off'})</span>`);
        if (this.capstoneVersion) kv('Disassembler', esc(`Capstone ${this.capstoneVersion} (WebAssembly)`));
        for (const w of elf.warnings) kv('Warning', `<span class="warn">${esc(w)}</span>`);
        p.innerHTML = `<div class="elfv-scroll"><div class="elfv-pad"><table class="t kv">${rows.join('')}</table></div></div>`;
    }

    // ---------------------------------------------------------------- Sections / Segments
    renderSections() {
        const elf = this.elf;
        const p = this.panels.sections;
        const rows = elf.sections.map(s => `<tr class="click" data-sec="${s.index}">
<td>${s.index}</td><td>${esc(s.name)}</td><td>${esc(s.typeName)}</td><td>${esc(s.flagsStr)}</td><td>${s.alloc ? this.fmt(s.addr) : '<span class="muted">' + this.fmt(s.addr) + '</span>'}</td>
<td>${this.hexN(s.offset)}</td><td>${this.hexN(s.size)}</td><td>${s.size.toLocaleString()}</td><td>${s.entsize ? this.hexN(s.entsize) : ''}</td><td>${s.link || ''}</td><td>${s.info || ''}</td><td>${s.addralign || ''}</td></tr>`).join('');
        p.innerHTML = `<div class="elfv-tool"><span class="info">Click a section: code opens in the disassembly, anything else in the hex view. Flags: W write, A alloc, X exec, M merge, S strings, I info, G group, T TLS.</span></div>
<div class="elfv-scroll"><table class="t"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Flags</th><th>Address</th><th>Offset</th><th>Size</th><th>(dec)</th><th>EntSize</th><th>Link</th><th>Info</th><th>Align</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        p.querySelector('tbody').addEventListener('click', (ev) => {
            const tr = ev.target.closest('tr[data-sec]');
            if (!tr) return;
            const s = elf.sections[+tr.dataset.sec];
            if (s.exec && this.codeRegionAt(s.addr) && s.hasData) this.goto(s.addr);
            else if (s.hasData) this.showHex('s' + s.index);
            else this.flash(`${s.name || 'section ' + s.index} has no data in the file (${s.typeName})`);
        });
    }

    renderSegments() {
        const elf = this.elf;
        const p = this.panels.segments;
        const rows = elf.segments.map(g => {
            const secs = elf.sections.filter(s => s.size && (g.type === 1 || g.type === 2 || g.type === 7 || g.type === 0x6474e552)
                ? s.alloc && s.size && s.addr >= g.vaddr && s.addr + s.size <= g.vaddr + g.memsz
                : s.offset >= g.offset && s.offset + s.size <= g.offset + g.filesz && s.type !== 8 && s.size).map(s => s.name);
            return `<tr class="click" data-seg="${g.index}"><td>${g.index}</td><td>${esc(g.typeName)}</td><td>${this.hexN(g.offset)}</td><td>${this.fmt(g.vaddr)}</td><td>${this.fmt(g.paddr)}</td>
<td>${this.hexN(g.filesz)}</td><td>${this.hexN(g.memsz)}</td><td>${g.flagsStr}</td><td>${this.hexN(g.align)}</td><td style="white-space:normal;font-family:inherit">${esc(secs.join(' '))}${g.type === 3 && elf.header.interp ? ' <span class="muted">[' + esc(elf.header.interp) + ']</span>' : ''}</td></tr>`;
        }).join('');
        p.innerHTML = `<div class="elfv-tool"><span class="info">Program headers: how the file is loaded. Click one to see its bytes. Memory map regions start from the LOAD segments.</span></div>
<div class="elfv-scroll"><table class="t"><thead><tr><th>#</th><th>Type</th><th>Offset</th><th>VirtAddr</th><th>PhysAddr</th><th>FileSiz</th><th>MemSiz</th><th>Flags</th><th>Align</th><th>Sections</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="muted">No program headers (an object file?)</td></tr>'}</tbody></table></div>`;
        p.querySelector('tbody').addEventListener('click', (ev) => {
            const tr = ev.target.closest('tr[data-seg]');
            if (tr) this.showHex('p' + tr.dataset.seg);
        });
    }

    // ---------------------------------------------------------------- Symbols
    renderSymbolsPanel() {
        const p = this.panels.symbols;
        p.innerHTML = `<div class="elfv-tool"><input type="search" class="x-symq" placeholder="Filter by name or address" style="width:240px">
<label><input type="checkbox" class="x-symall"> Section, file and mapping symbols</label>
<label><input type="checkbox" class="x-symund" checked> Undefined (imports)</label>
<label><input type="checkbox" class="x-symdet" checked> Detected functions</label>
<span class="info x-symcount"></span></div>`;
        this.symTable = new VTable(p, {
            columns: [
                { key: 'name', label: 'Name', width: 'minmax(220px,3fr)', sort: r => r.dn.toLowerCase(), html: r => (r.kind === 'detected' ? '<span class="tag det" title="' + esc('detected: ' + r.why + '; not a symbol of the file') + '">detected</span> ' : r.kind === 'plt' ? '<span class="tag plt">plt</span> ' : '') + `<span title="${esc(r.name)}">${esc(r.dn)}</span>` },
                { key: 'value', label: 'Value', width: `${this.elf.addrWidth + 2}ch`, sort: r => r.addr ?? -1, html: r => r.und ? '<span class="muted">' + this.fmt(r.addr || 0) + '</span>' : this.fmt(r.addr) },
                { key: 'size', label: 'Size', width: '8ch', sort: r => r.size, html: r => r.size ? String(r.size) : '' },
                { key: 'type', label: 'Type', width: '8ch', sort: r => r.type, html: r => esc(r.type) },
                { key: 'bind', label: 'Bind', width: '7ch', sort: r => r.bind, html: r => esc(r.bind) },
                { key: 'sec', label: 'Section', width: '12ch', sort: r => r.sec, html: r => esc(r.sec) },
                { key: 'table', label: 'Table', width: '8ch', sort: r => r.table, html: r => esc(r.table) },
                { key: 'refs', label: 'Refs', width: '6ch', sort: r => this.refCountFor(r), html: r => { const n = this.refCountFor(r); return n ? `<a class="go" data-xrefsym="1">${n}</a>` : '<span class="muted">0</span>'; } },
            ],
            onClick: (ev, r) => {
                if (ev.target.closest('[data-xrefsym]')) { this.showXrefsForQuery(r.name); return; }
                if (r.und) { this.showXrefsForQuery(r.name); return; }
                this.goto(r.addr);
            },
        });
        this.lists.push(this.symTable.list);
        const q = p.querySelector('.x-symq'), all = p.querySelector('.x-symall'), und = p.querySelector('.x-symund'), det = p.querySelector('.x-symdet');
        const update = () => {
            const text = q.value.trim().toLowerCase();
            const hexq = /^(0x)?[0-9a-f]+$/.test(text) ? text.replace(/^0x/, '') : null;
            this.symTable.setFilter(r => {
                if (!all.checked && r.hidden) return false;
                if (!und.checked && r.und) return false;
                if (!det.checked && r.kind === 'detected') return false;
                if (!text) return true;
                return r.dn.toLowerCase().includes(text) || r.name.toLowerCase().includes(text) || (hexq !== null && !r.und && this.fmt(r.addr).includes(hexq));
            });
            p.querySelector('.x-symcount').textContent = `${this.symTable.view.length.toLocaleString()} of ${this.symTable.rows.length.toLocaleString()}`;
        };
        this._symUpdate = update;
        q.addEventListener('input', update);
        all.onchange = und.onchange = det.onchange = update;
    }

    refCountFor(r) {
        if (!this.refs || r.und && !r.pltAddr) return r.und ? this.relocsForSymbol(r.name).length : 0;
        if (r._rc !== undefined && r._rcRefs === this.refs) return r._rc;
        const a = r.und ? r.pltAddr : r.addr;
        let n = 0;
        for (const i of this.refsTo(a, a + Math.max(1, r.size && r.type === 'OBJECT' ? r.size : 1))) if (this.refShown(i)) n++;
        if (r.und) n += this.relocsForSymbol(r.name).length;
        r._rc = n; r._rcRefs = this.refs;
        return n;
    }

    relocsForSymbol(name) {
        return (this.codeRelocsByName && this.codeRelocsByName.get(name)) || [];
    }

    fillSymbols() {
        if (!this.symTable) return;
        const elf = this.elf;
        const rows = [];
        const plt = new Map((this.pltLabels || []).map(l => [l.name.replace(/@plt$/, ''), l.addr]));
        const dn = (n) => this.dname(n) || '';   // demangled when first shown, filtered or sorted
        for (const s of elf.symbols) {
            if (s.index === 0 && !s.name) continue;
            const und = s.shndx === 0;
            rows.push({
                name: s.name, get dn() { return dn(this.name); }, addr: s.addr, size: s.size, type: s.typeName, bind: s.bindName, sec: s.secName,
                table: s.table, kind: 'sym', und, pltAddr: und ? plt.get(s.name) : undefined,
                hidden: s.type === 3 || s.type === 4 || isMappingSymbol(s.name) || !s.name,
            });
        }
        for (const l of this.pltLabels || []) rows.push({ name: l.name, get dn() { return dn(this.name.replace(/@plt$/, '')) + '@plt'; }, addr: l.addr, size: l.size, type: 'FUNC', bind: '', sec: (this.sectionAt(l.addr) || {}).name || '', table: 'plt', kind: 'plt' });
        for (const l of this.detectedFuncs || []) rows.push({ name: l.name, dn: l.name, addr: l.addr, size: 0, type: 'FUNC', bind: '', sec: (this.sectionAt(l.addr) || {}).name || '', table: 'detected', kind: 'detected', why: l.why });
        this.symTable.rows = rows;
        this._symUpdate();
    }

    // ---------------------------------------------------------------- Relocations / imports
    renderRelocs() {
        const p = this.panels.relocs;
        const elf = this.elf;
        p.innerHTML = `<div class="elfv-tool"><input type="search" class="x-relq" placeholder="Filter by symbol, type or section" style="width:240px"><span class="info x-relcount"></span></div>`;
        const t = new VTable(p, {
            columns: [
                { key: 'sec', label: 'Section', width: '14ch', sort: r => r.section, html: r => esc(r.section) },
                { key: 'off', label: 'Offset', width: `${elf.addrWidth + 2}ch`, sort: r => r.offset, html: r => this.fmt(r.offset) },
                { key: 'type', label: 'Type', width: '24ch', sort: r => r.typeName, html: r => esc(r.typeName) },
                { key: 'sym', label: 'Symbol', width: 'minmax(200px,3fr)', sort: r => this.dname(r.symName), html: r => esc(this.dname(r.symName)) },
                { key: 'add', label: 'Addend', width: '14ch', sort: r => Number(r.addend || 0n), html: r => r.addend === null ? '' : (r.addend < 0n ? '-0x' + (-r.addend).toString(16) : '0x' + r.addend.toString(16)) },
                { key: 'in', label: 'Applies to', width: 'minmax(120px,2fr)', sort: r => r.target, html: r => { const s = this.symbolize(r.offset); return esc((s ? s.text : '') || r.target); } },
            ],
            onClick: (ev, r) => this.goto(r.offset),
        });
        this.lists.push(t.list);
        t.setRows(elf.relocs);
        const q = p.querySelector('.x-relq');
        const upd = () => {
            const s = q.value.trim().toLowerCase();
            t.setFilter(s ? (r => r.symName.toLowerCase().includes(s) || this.dname(r.symName).toLowerCase().includes(s) || r.typeName.toLowerCase().includes(s) || r.section.toLowerCase().includes(s)) : null);
            p.querySelector('.x-relcount').textContent = `${t.view.length.toLocaleString()} of ${elf.relocs.length.toLocaleString()} relocations` + (elf.relocs.length ? '' : ' (none: a static executable or a stripped object)');
        };
        q.addEventListener('input', upd);
        upd();
    }

    renderImports() {
        const p = this.panels.imports;
        const elf = this.elf;
        const und = elf.symbols.filter(s => s.shndx === 0 && s.name && s.table === (elf.symbols.some(x => x.table === 'dynsym') ? 'dynsym' : 'symtab'));
        const plt = new Map((this.pltLabels || []).map(l => [l.name.replace(/@plt$/, ''), l.addr]));
        const slots = new Map();
        const types = JUMP_SLOT_TYPES[elf.header.machine] || [];
        for (const r of elf.relocs) if (r.symName && (types.includes(r.type) || !slots.has(r.symName))) slots.set(r.symName, r);
        const rows = und.map(s => {
            const r = slots.get(s.name);
            const pa = plt.get(s.name);
            const n = this.refs ? (pa !== undefined ? this.refsTo(pa).length : 0) + this.relocsForSymbol(s.name).length : 0;
            return `<tr class="click" data-imp="${esc(s.name)}"><td>${esc(this.dname(s.name))}</td><td>${esc(s.typeName)}</td><td>${esc(s.bindName)}</td>
<td>${r ? this.fmt(r.offset) + ' <span class="muted">' + esc(r.typeName) + '</span>' : ''}</td><td>${pa !== undefined ? `<a class="go" data-go="${pa}">${this.fmt(pa)}</a>` : ''}</td><td>${n || ''}</td></tr>`;
        }).join('');
        const dyn = elf.dynamic.map(d => `<tr><td>${esc(d.tagName)}</td><td>${esc(d.value)}</td></tr>`).join('');
        p.innerHTML = `<div class="elfv-scroll"><div class="elfv-pad">
<h3 style="margin-top:0">Needed libraries</h3><div>${elf.needed.length ? elf.needed.map(esc).join(', ') : '<span class="muted">none</span>'}${elf.header.interp ? ' <span class="muted">· interpreter ' + esc(elf.header.interp) + '</span>' : ''}</div>
<h3>Imported symbols (${und.length})</h3>
<table class="t"><thead><tr><th>Symbol</th><th>Type</th><th>Bind</th><th>GOT slot / relocation</th><th>PLT stub</th><th>Refs</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">none</td></tr>'}</tbody></table>
<h3>Dynamic section (${elf.dynamic.length})</h3>
<table class="t"><thead><tr><th>Tag</th><th>Value</th></tr></thead><tbody>${dyn || '<tr><td colspan="2" class="muted">none (static or relocatable)</td></tr>'}</tbody></table>
</div></div>`;
        p.querySelector('tbody').addEventListener('click', (ev) => {
            if (ev.target.closest('[data-go]')) return;
            const tr = ev.target.closest('tr[data-imp]');
            if (tr) this.showXrefsForQuery(tr.dataset.imp);
        });
        this.setCount('imports', und.length);
    }

    // ---------------------------------------------------------------- Xrefs
    renderXrefsPanel() {
        const p = this.panels.xrefs;
        p.innerHTML = `<div class="elfv-tool"><input type="search" class="x-xq" placeholder="Symbol or address (main, 0x401000, puts)" style="width:260px"><button class="x-xgo">Find references</button>
${REF_KINDS.map(k => `<label><input type="checkbox" data-k="${k}" checked> ${k}</label>`).join('')}
<span class="info x-xinfo"></span></div>`;
        this.xrefTable = new VTable(p, {
            columns: [
                { key: 'from', label: 'From', width: `${this.elf.addrWidth + 2}ch`, sort: r => r.from, html: r => `<a class="go" data-go="${r.from}">${this.fmt(r.from)}</a>` },
                { key: 'fn', label: 'In', width: 'minmax(160px,2fr)', sort: r => r.fn, html: r => esc(r.fn) },
                { key: 'freg', label: 'Region', width: '12ch', sort: r => r.freg, html: r => r.fregKind ? `<span class="tag ${r.fregKind}">${esc(r.freg)}</span>` : esc(r.freg) },
                { key: 'kind', label: 'Kind', width: '16ch', sort: r => r.cls, html: r => esc(r.cls) },
                { key: 'to', label: 'Target', width: 'minmax(160px,2fr)', sort: r => r.to, html: r => esc(r.toText) },
                { key: 'treg', label: 'Target region', width: '14ch', sort: r => r.treg, html: r => r.tregKind ? `<span class="tag ${r.tregKind}">${esc(r.treg)}</span>` : esc(r.treg) },
            ],
            onClick: (ev, r) => { if (r.top) this.showXrefs(r.to); else this.goto(r.from); },
        });
        this.lists.push(this.xrefTable.list);
        const q = p.querySelector('.x-xq');
        const go = () => { this.xrefQuery = q.value.trim(); this.renderXrefResults(); };
        p.querySelector('.x-xgo').onclick = go;
        q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
        for (const cb of p.querySelectorAll('input[data-k]')) cb.onchange = () => this.renderXrefResults();
        this.xrefQuery = '';
    }

    showXrefs(addr) {
        this.panels.xrefs.querySelector('.x-xq').value = this.fmt0x(addr);
        this.xrefQuery = this.fmt0x(addr);
        this.showTab('xrefs');
        this.renderXrefResults();
    }
    showXrefsForQuery(q) {
        this.panels.xrefs.querySelector('.x-xq').value = q;
        this.xrefQuery = q;
        this.showTab('xrefs');
        this.renderXrefResults();
    }

    regionTag(addr) {
        const r = this.regionAt(addr);
        if (r) return { text: r.name, kind: r.kind in KIND_SHORT ? r.kind : 'other' };
        const s = this.sectionAt(addr);
        return { text: s ? s.name : '', kind: '' };
    }

    xrefRow(i) {
        const { from, to } = this.refs;
        const f = from[i], t = to[i];
        const fs = this.symbolize(f), ts = this.symbolize(t);
        const fr = this.regionTag(f), tr = this.regionTag(t);
        return { from: f, to: t, fn: fs ? fs.text : '', freg: fr.text, fregKind: fr.kind, cls: this.refClass(i), toText: (ts ? ts.text + '  ' : '') + this.fmt0x(t), treg: tr.text, tregKind: tr.kind };
    }

    renderXrefResults() {
        if (!this.xrefTable) return;
        const p = this.panels.xrefs;
        const info = p.querySelector('.x-xinfo');
        if (!this.refs || !this.rows) {
            this.xrefTable.setRows([]);
            info.textContent = this.isa ? 'Cross references are built after the disassembly…' : 'No ISA: nothing disassembled';
            return;
        }
        const kinds = new Set([...p.querySelectorAll('input[data-k]')].filter(c => c.checked).map(c => REF_KIND[c.dataset.k]));
        const q = this.xrefQuery;
        if (!q) {
            // the most referenced targets
            if (!this._topTargets) {
                const counts = new Map();
                const { to, kind } = this.refs;
                for (let i = 0; i < to.length; i++) {
                    if (!this.refShown(i)) continue;
                    const c = counts.get(to[i]);
                    if (c) { c.n++; c.kinds.add(kind[i]); } else counts.set(to[i], { n: 1, kinds: new Set([kind[i]]), i });
                }
                this._topTargets = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 2000);
            }
            const rows = this._topTargets.filter(([, c]) => [...c.kinds].some(k => kinds.has(k))).map(([t, c]) => {
                const ts = this.symbolize(t), tr = this.regionTag(t);
                return { top: true, from: t, to: t, fn: `${c.n} references`, freg: '', cls: [...c.kinds].map(k => REF_KINDS[k]).join(', '), toText: (ts ? ts.text + '  ' : '') + this.fmt0x(t), treg: tr.text, tregKind: tr.kind };
            });
            this.xrefTable.setRows(rows);
            info.textContent = `${this.refs.to.length.toLocaleString()} references. Most referenced targets below; click one, or type a symbol or address.`;
            return;
        }
        const r = this.resolve(q);
        if (!r) { this.xrefTable.setRows([]); info.textContent = `"${q}" is neither a symbol nor an address`; return; }
        const rows = [];
        let lo, hi, what;
        if (r.addr !== null && r.addr !== undefined && !(r.sym && r.sym.shndx === 0 && !r.label)) {
            lo = r.addr;
            const size = r.label && r.label.size && r.label.sym && r.label.sym.type === 1 ? r.label.size : 1;
            hi = lo + size;
            for (const i of this.refsTo(lo, hi)) if (kinds.has(this.refs.kind[i]) && this.refShown(i)) rows.push(this.xrefRow(i));
            const ts = this.symbolize(lo);
            what = (ts ? ts.text + ' ' : '') + this.fmt0x(lo) + (size > 1 ? ` … +${size}` : '');
        }
        // imports: calls through their PLT stub and relocations naming them
        const symName = r.sym ? r.sym.name : (r.label ? r.label.name : null);
        if (symName) {
            const pl = (this.pltLabels || []).find(l => l.name === symName + '@plt');
            if (pl && pl.addr !== lo) for (const i of this.refsTo(pl.addr)) if (kinds.has(this.refs.kind[i])) rows.push(this.xrefRow(i));
            for (const rel of this.relocsForSymbol(symName)) {
                if (rows.some(x => x.from === rel.offset)) continue;
                const fs = this.symbolize(rel.offset), fr = this.regionTag(rel.offset);
                rows.push({ from: rel.offset, to: r.addr || 0, fn: fs ? fs.text : '', freg: fr.text, fregKind: fr.kind, cls: 'reloc ' + rel.typeName.replace(/^R_\w+?_/, ''), toText: this.dname(symName), treg: '' });
            }
            what = what || this.dname(symName);
        }
        rows.sort((a, b) => a.from - b.from);
        this.xrefTable.setRows(rows);
        const reg = r.addr !== null && r.addr !== undefined ? this.regionTag(r.addr) : null;
        info.textContent = `${rows.length} reference${rows.length === 1 ? '' : 's'} to ${what}${reg && reg.text ? ' [' + reg.text + ']' : ''}`;
    }

    // ---------------------------------------------------------------- Memory map
    renderMemMap() {
        const p = this.panels.memmap;
        const isArm = this.elf.header.machine === 40;
        p.innerHTML = `<div class="elfv-tool">
<button class="x-mmadd">+ Add region</button>
<button class="x-mmreset" title="Forget the edits: regions from the LOAD segments again">Reset to segments</button>
<button class="x-mmcm" title="The Cortex-M architectural map: code, SRAM, peripherals (MMIO), external RAM/devices, system (PPB)"${isArm ? '' : ' hidden'}>Add Cortex-M map</button>
<button class="x-mmexp">Export JSON</button>
<label class="elfv-imp" style="cursor:pointer"><span style="border:1px solid #ccc;border-radius:4px;padding:2px 8px;background:#fff;color:#333">Import JSON</span><input type="file" accept=".json,application/json" class="x-mmimp" hidden></label>
<span class="info x-mminfo"></span></div>
<div class="elfv-scroll"><div class="elfv-pad">
<p class="muted" style="margin:0 0 8px">Say which memory is what: references into these ranges are named and classed by them (RAM read, MMIO write, …) in the disassembly and the xrefs. The most specific (smallest) region wins, so peripherals can sit inside a larger MMIO range. Kept for this file in the browser.</p>
<table class="t elfv-mm"><thead><tr><th>Name</th><th>Start</th><th>Size</th><th>End</th><th>Kind</th><th>Perms</th><th>Refs</th><th></th></tr></thead><tbody></tbody></table>
</div></div>`;
        this.mmBody = p.querySelector('tbody');
        p.querySelector('.x-mmadd').onclick = () => {
            const list = this.currentRegionList();
            list.push({ name: 'region' + (list.length + 1), start: '0x0', size: '0x1000', kind: 'other', perms: 'rw' });
            this.setRegions(list);
            const last = this.mmBody.querySelector('tr:last-child input[data-f="name"]');
            if (last) { last.focus(); last.select(); }
        };
        p.querySelector('.x-mmreset').onclick = () => { this.settings.regions = null; this.saveSettings(); this.normalizeRegions(); this.fillMemMap(); this.afterRegionsChanged(); };
        p.querySelector('.x-mmcm').onclick = () => {
            const list = this.currentRegionList();
            for (const r of CORTEX_M_MAP) if (!list.some(x => x.name === r.name)) list.push({ ...r });
            this.setRegions(list);
        };
        p.querySelector('.x-mmexp').onclick = () => {
            const data = JSON.stringify({ file: this.name, isa: this.settings.isa, endian: this.settings.endian, armMode: this.settings.armMode, regions: this.currentRegionList() }, null, 2);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
            a.download = (this.name || 'elf') + '.memmap.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        };
        p.querySelector('.x-mmimp').onchange = async (ev) => {
            const f = ev.target.files[0];
            ev.target.value = '';
            if (!f) return;
            try {
                const j = JSON.parse(await f.text());
                const regions = Array.isArray(j) ? j : j.regions;
                if (!Array.isArray(regions)) throw new Error('no "regions" array');
                const clean = regions.map((r, i) => ({ name: String(r.name ?? 'region' + (i + 1)), start: String(r.start ?? '0'), size: String(r.size ?? '0'), kind: r.kind in REGION_KINDS ? r.kind : 'other', perms: String(r.perms ?? '') }));
                let retarget = false;
                if (!Array.isArray(j)) {
                    if (j.isa && (j.isa === 'auto' || ISA_BY_ID[j.isa])) { retarget = retarget || j.isa !== this.settings.isa; this.settings.isa = j.isa; this.$('.x-isa').value = j.isa; }
                    if (['auto', 'little', 'big'].includes(j.endian)) { retarget = retarget || j.endian !== this.settings.endian; this.settings.endian = j.endian; this.$('.x-endian').value = j.endian; }
                    if (['auto', 'arm', 'thumb'].includes(j.armMode)) { retarget = retarget || j.armMode !== this.settings.armMode; this.settings.armMode = j.armMode; this.$('.x-arm').value = j.armMode; }
                }
                this.setRegions(clean);
                if (retarget) this.applyTarget();
                this.mmInfo(`Imported ${clean.length} regions from ${f.name}`);
            } catch (err) {
                this.mmInfo('Import failed: ' + err.message, true);
            }
        };
        this.mmBody.addEventListener('change', (ev) => this.onMemMapEdit(ev));
        this.mmBody.addEventListener('click', (ev) => {
            const del = ev.target.closest('[data-del]');
            if (del) {
                const list = this.currentRegionList();
                list.splice(+del.dataset.del, 1);
                this.setRegions(list);
                return;
            }
            const x = ev.target.closest('[data-mmx]');
            if (x) { const r = this.memRegions[+x.dataset.mmx]; if (r) this.showXrefsRange(r); }
        });
        this.fillMemMap();
    }

    mmInfo(text, err) {
        const el = this.panels.memmap.querySelector('.x-mminfo');
        el.textContent = text;
        el.className = 'info x-mminfo' + (err ? ' err' : '');
    }

    currentRegionList() {
        return (this.settings.regions || this.defaultRegions()).map(r => ({ ...r }));
    }

    setRegions(list) {
        this.settings.regions = list;
        this.saveSettings();
        this.normalizeRegions();
        this.fillMemMap();
        this.afterRegionsChanged();
    }

    onMemMapEdit(ev) {
        const el = ev.target;
        const tr = el.closest('tr[data-r]');
        if (!tr) return;
        const list = this.currentRegionList();
        const r = list[+tr.dataset.r];
        if (!r) return;
        const f = el.dataset.f;
        if (f === 'perm') {
            r.perms = ['r', 'w', 'x'].filter(c => tr.querySelector(`input[data-p="${c}"]`).checked).join('');
        } else if (f === 'start' || f === 'size' || f === 'end') {
            const v = parseHexOrDec(el.value);
            if (v === null) { el.style.outline = '1px solid #cf222e'; this.mmInfo(`"${el.value}" is not a number (hex, with or without 0x)`, true); return; }
            el.style.outline = '';
            if (f === 'end') {
                const s = parseHexOrDec(r.start);
                if (s === null || v <= s) { el.style.outline = '1px solid #cf222e'; this.mmInfo('The end must be after the start', true); return; }
                r.size = '0x' + (v - s).toString(16);
            } else r[f] = '0x' + v.toString(16);
        } else r[f] = el.value;
        this.mmInfo('');
        this.setRegions(list);
    }

    fillMemMap() {
        if (!this.mmBody) return;
        const list = this.currentRegionList();
        this.mmBody.innerHTML = list.map((r, i) => {
            const s = parseHexOrDec(String(r.start)), z = parseHexOrDec(String(r.size));
            const end = s !== null && z !== null ? '0x' + (s + z).toString(16) : '';
            const reg = this.memRegions.find(x => x.name === r.name && x.start === r.start && x.size === r.size);
            const idx = reg ? this.memRegions.indexOf(reg) : -1;
            const n = reg && this.refs ? this.refsTo(reg.startN, reg.startN + reg.sizeN).filter(k => this.refShown(k)).length : null;
            return `<tr data-r="${i}">
<td><input type="text" data-f="name" value="${esc(r.name)}" style="width:22ch"></td>
<td><input type="text" data-f="start" value="${esc(r.start)}" style="width:${this.elf.addrWidth + 5}ch"></td>
<td><input type="text" data-f="size" value="${esc(r.size)}" style="width:${this.elf.addrWidth + 5}ch"></td>
<td><input type="text" data-f="end" value="${esc(end)}" title="Edit to change the size" style="width:${this.elf.addrWidth + 5}ch"></td>
<td><select data-f="kind">${Object.entries(REGION_KINDS).map(([k, l]) => `<option value="${k}"${r.kind === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
<td class="perm">${['r', 'w', 'x'].map(c => `<label><input type="checkbox" data-f="perm" data-p="${c}"${(r.perms || '').includes(c) ? ' checked' : ''}>${c}</label>`).join('')}</td>
<td>${n === null ? '' : n ? `<a class="go" data-mmx="${idx}">${n}</a>` : '<span class="muted">0</span>'}</td>
<td><button data-del="${i}" title="Delete this region">✕</button></td></tr>`;
        }).join('') || '<tr><td colspan="8" class="muted">No regions</td></tr>';
        this.setCount('memmap', list.length);
    }

    showXrefsRange(r) {
        const rows = [];
        for (const i of this.refsTo(r.startN, r.startN + r.sizeN)) if (this.refShown(i)) rows.push(this.xrefRow(i));
        this.showTab('xrefs');
        const p = this.panels.xrefs;
        p.querySelector('.x-xq').value = '';
        this.xrefTable.setRows(rows);
        p.querySelector('.x-xinfo').textContent = `${rows.length} references into ${r.name} (${r.start} … +${r.size}, ${REGION_KINDS[r.kind] || r.kind})`;
    }

    afterRegionsChanged() {
        this._topTargets = null;
        if (this.disList) this.disList.draw();
        this.renderXrefResults();
    }

    // ---------------------------------------------------------------- Disassembly
    renderDisasmPanel() {
        const p = this.panels.disasm;
        p.innerHTML = `<div class="elfv-tool"><button class="x-back" title="Back to where you were before the last jump">← Back</button>
<select class="x-dsec" title="Jump to a code section"></select>
<span class="info x-dinfo">Click an address for its references, a target to follow it.</span></div>
<div class="x-dmsg" hidden></div>`;
        this.disList = new VList(p, {
            className: 'elfv-dis',
            render: (i) => this.renderDisRow(i),
            onClick: (ev, i) => {
                if (ev.target.closest('[data-go],[data-xref]')) return;
                if (ev.target.classList.contains('a')) { const a = this.addrOfRow(i); if (a !== null) this.showXrefs(a); }
                else this.selectRow(i);
            },
        });
        this.disList.el.style.setProperty('--aw', this.elf.addrWidth);
        this.disList.el.addEventListener('scroll', () => {
            if (!this.disRows) return;
            const i = Math.min(this.disRowCount - 1, this.disList.firstVisible() + 2);
            if (i < 0) return;
            const r = this.plan.regions[this.disRows.region[i]];
            const sel = this.panels.disasm.querySelector('.x-dsec');
            if (r && sel.value !== r.id) sel.value = r.id;
        });
        this.lists.push(this.disList);
        p.querySelector('.x-back').onclick = () => {
            const a = this.history.pop();
            if (a !== undefined) this.goto(a, { noHistory: true });
            else this.flash('Nothing to go back to');
        };
        const sel = p.querySelector('.x-dsec');
        sel.onchange = () => { const r = this.plan.regions.find(x => x.id === sel.value); if (r) this.goto(r.addr); };
    }

    showDisasmMessage(text) {
        const m = this.panels.disasm.querySelector('.x-dmsg');
        m.hidden = false;
        m.className = 'x-dmsg elfv-msg';
        m.textContent = text;
        this.disRowCount = 0;
        if (this.disList) this.disList.setCount(0);
    }

    buildDisasmRows() {
        const regions = this.plan.regions;
        const sel = this.panels.disasm.querySelector('.x-dsec');
        sel.innerHTML = regions.map(r => `<option value="${r.id}">${esc(r.name)} (${this.fmt0x(r.addr)}, ${r.size.toLocaleString()} bytes)</option>`).join('');
        this.panels.disasm.querySelector('.x-dmsg').hidden = true;
        // global rows: per region a header row, then per instruction its labels and itself
        // labels per region: [offset, count] at instruction starts, in address order
        const labelAddrs = [...this.labelsAt.keys()].sort((a, b) => a - b);
        const perRegion = regions.map(r => {
            const starts = this.rows[r.id];
            const out = [];
            for (let k = lowerBound(labelAddrs, r.addr, x => x); k < labelAddrs.length && labelAddrs[k] < r.addr + r.size; k++) {
                const off = labelAddrs[k] - r.addr;
                const i = lowerBound(starts, off, x => x);
                if (i < starts.length && starts[i] === off) out.push(i, this.labelsAt.get(labelAddrs[k]).length);
            }
            return out;
        });
        let total = 0;
        regions.forEach((r, ri) => { total += 1 + this.rows[r.id].length; for (let k = 1; k < perRegion[ri].length; k += 2) total += perRegion[ri][k]; });
        const rType = new Uint8Array(total), rRegion = new Uint16Array(total), rIdx = new Int32Array(total);
        this.insnRow = {};
        let g = 0;
        regions.forEach((r, ri) => {
            const starts = this.rows[r.id];
            const n = starts.length;
            const map = new Int32Array(n);
            const L = perRegion[ri];
            rRegion.fill(ri, g, g + n + 1 + L.reduce((a, v, k) => k & 1 ? a + v : a, 0));
            rType[g] = 0; rIdx[g] = 0; g++;
            let li = 0;
            for (let i = 0; i < n; i++) {
                if (li < L.length && L[li] === i) {
                    for (let k = 0; k < L[li + 1]; k++) { rType[g] = 1; rIdx[g] = i * 16 + k; g++; }
                    li += 2;
                }
                map[i] = g;
                rType[g] = 2; rIdx[g] = i; g++;
            }
            this.insnRow[r.id] = map;
        });
        this.disRows = { type: rType, region: rRegion, idx: rIdx };
        this.disRowCount = total;
        this.disList.setCount(total);
    }

    addrOfRow(i) {
        if (!this.disRows || i < 0 || i >= this.disRowCount) return null;
        const r = this.plan.regions[this.disRows.region[i]];
        const t = this.disRows.type[i];
        if (t === 0) return r.addr;
        const insn = t === 1 ? this.disRows.idx[i] >> 4 : this.disRows.idx[i];
        return r.addr + this.rows[r.id][insn];
    }

    // the row of the instruction at (or containing) an address
    rowOfAddr(addr) {
        const r = this.codeRegionAt(addr);
        if (!r || !this.rows) return -1;
        const starts = this.rows[r.id];
        const off = addr - r.addr;
        let i = lowerBound(starts, off + 1, x => x) - 1;
        if (i < 0) i = 0;
        let row = this.insnRow[r.id][i];
        // show the labels above it when it starts a function
        if (starts[i] === off) while (row > 0 && this.disRows.type[row - 1] === 1) row--;
        return row;
    }

    scrollDisasmTo(addr, align) {
        const row = this.rowOfAddr(addr);
        if (row < 0) return;
        this.selectedAddr = addr;
        this.disList.scrollTo(row, align);
    }

    selectRow(i) {
        const a = this.addrOfRow(i);
        if (a === null) return;
        this.selectedAddr = a;
        this.disList.draw();
    }

    requestRows(regionIdx, insnIdx) {
        if (!this.rows) return;
        const r = this.plan.regions[regionIdx];
        const key = r.id + ':' + insnIdx;
        if (this.pending.has(key)) return;
        if (!this._batch) { this._batch = new Map(); queueMicrotask(() => this.flushBatch()); }
        let b = this._batch.get(r.id);
        if (!b) { b = []; this._batch.set(r.id, b); }
        b.push(insnIdx);
        this.pending.add(key);
    }

    flushBatch() {
        const batch = this._batch;
        this._batch = null;
        if (!this.worker || !batch || !this.rows) return;
        for (const [regionId, idxs] of batch) {
            const starts = this.rows[regionId];
            this.worker.postMessage({ type: 'render', id: ++this.reqId, regionId, idxs, offsets: idxs.map(i => starts[i]) });
            this._inflight = this._inflight || new Map();
            this._inflight.set(this.reqId, idxs);
        }
    }

    onRows(m) {
        const idxs = this._inflight && this._inflight.get(m.id);
        if (!idxs) return;
        this._inflight.delete(m.id);
        if (this.rowCache.size > 50000) this.rowCache.clear();
        m.rows.forEach((row, k) => { const key = m.regionId + ':' + idxs[k]; this.rowCache.set(key, row); this.pending.delete(key); });
        this.disList.schedule();
    }

    renderDisRow(i) {
        const D = this.disRows;
        if (!D) return '';
        const ri = D.region[i], t = D.type[i];
        const r = this.plan.regions[ri];
        if (t === 0) {
            const runs = r.runs.length > 1 ? `, ${r.runs.length} runs (${[...new Set(r.runs.map(x => x.mode || this.isa.label))].join('/')})` : '';
            return `<div class="r hdr" data-i="${i}">; section ${esc(r.name)}  ${this.fmt0x(r.addr)} – ${this.fmt0x(r.addr + r.size)}  (${this.rows[r.id].length.toLocaleString()} rows${runs})</div>`;
        }
        if (t === 1) {
            const insn = D.idx[i] >> 4, k = D.idx[i] & 15;
            const a = r.addr + this.rows[r.id][insn];
            const l = this.labelsAt.get(a)[k];
            const nref = this.refs ? this.refsTo(a).length : 0;
            const tag = l.kind === 'detected' ? ` <span class="tag det" title="${esc('not a symbol of the file: ' + l.why)}">detected · ${esc(l.why)}</span>` : l.kind === 'plt' ? ' <span class="tag plt">PLT stub</span>' : '';
            return `<div class="r lbl" data-i="${i}">${this.fmt(a)} &lt;${esc(this.dname(l.name))}&gt;:${tag}<span class="x">${nref ? `<a class="go" data-xref="${a}">${nref} xref${nref === 1 ? '' : 's'}</a>` : ''}</span></div>`;
        }
        const insn = D.idx[i];
        const off = this.rows[r.id][insn];
        const a = r.addr + off;
        const row = this.rowCache.get(r.id + ':' + insn);
        const reg = this.regionAt(a);
        const regHtml = `<span class="rg" title="${reg ? esc(reg.name + ' (' + (REGION_KINDS[reg.kind] || reg.kind) + ')') : ''}">${reg ? esc(reg.name) : ''}</span>`;
        const sel = this.selectedAddr === a ? ' sel' : '';
        if (!row) {
            this.requestRows(ri, insn);
            return `<div class="r ld${sel}" data-i="${i}"><span class="a">${this.fmt(a)}</span>${regHtml}<span class="b">…</span></div>`;
        }
        // operands: targets as links
        const refIdx = this.refs ? this.refsFrom(a) : [];
        let ops = esc(row.ops);
        const targets = new Map();
        for (const k of refIdx) targets.set(this.refs.to[k], k);
        ops = ops.replace(/(#?)(-?0x[0-9a-f]+|\b\d+\b)/g, (m0, hash, num) => {
            let v;
            try { v = this.fromAbs(BigInt(num.replace(/^-/, '')) * (num[0] === '-' ? -1n : 1n)); } catch (e) { return m0; }
            const k = targets.get(v);
            if (k === undefined || (this.refs.kind[k] !== REF_KIND.call && this.refs.kind[k] !== REF_KIND.jump && this.refs.kind[k] !== REF_KIND.addr)) return m0;
            if (!this.codeRegionAt(v) && !this.sectionAt(v)) return m0;
            const s = this.symbolize(v);
            return `${hash}<a class="go" data-go="${v}">${num}</a>${s && (this.refs.kind[k] !== REF_KIND.addr) ? ' &lt;' + esc(s.text) + '&gt;' : ''}`;
        });
        // comments: where the references go
        const notes = [];
        for (const k of refIdx) {
            const kind = this.refs.kind[k];
            const tgt = this.refs.to[k];
            if (kind === REF_KIND.call || kind === REF_KIND.jump) {
                if (ops.includes(`data-go="${tgt}"`)) continue;
            }
            if (!this.refShown(k)) continue;
            const s = this.symbolize(tgt);
            const rr = this.regionAt(tgt);
            const str = (kind === REF_KIND.addr || kind === REF_KIND.read || kind === REF_KIND.ptr) ? this.stringAt(tgt) : null;
            const name = s ? esc(s.text) : this.fmt0x(tgt);
            let n = `${esc(this.refClass(k))} <a class="go" data-go="${tgt}">${name}</a>`;
            if (rr) n += ` <span class="tag ${rr.kind in KIND_SHORT ? rr.kind : 'other'}">${esc(rr.name)}</span>`;
            if (str !== null) n += ` <span class="str">${esc(JSON.stringify(str))}</span>`;
            notes.push(n);
        }
        // relocations applying to this instruction (object files, text relocations)
        if (this.codeRelocs && this.codeRelocs.length) {
            let j = lowerBound(this.codeRelocs, a, x => x.offset);
            for (; j < this.codeRelocs.length && this.codeRelocs[j].offset < a + row.size; j++) {
                const rel = this.codeRelocs[j];
                const ad = rel.addend ? (rel.addend < 0n ? '-0x' + (-rel.addend).toString(16) : '+0x' + rel.addend.toString(16)) : '';
                notes.push(`<span class="rl">${esc(rel.typeName)} ${esc(this.dname(rel.symName))}${ad}</span>`);
            }
        }
        const cls = row.data ? ' data' : row.bad ? ' bad' : '';
        return `<div class="r${cls}${sel}" data-i="${i}"><span class="a" title="References to ${this.fmt0x(a)}">${this.fmt(a)}</span>${regHtml}<span class="b" title="${esc(row.bytes)}">${esc(row.bytes)}</span><span class="m">${esc(row.mn)}</span><span class="o">${ops}</span>${notes.length ? `<span class="c">; ${notes.join(' · ')}</span>` : ''}</div>`;
    }

    // a printable C string at an address in a data section (for comments), or null
    stringAt(addr) {
        const s = this.sectionAt(addr);
        if (!s || !s.hasData || s.exec) return null;
        const b = this.elf.bytes;
        let o = s.offset + (addr - s.addr);
        const end = Math.min(s.offset + s.size, o + 64);
        let str = '';
        for (; o < end; o++) {
            const c = b[o];
            if (c === 0) break;
            if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) str += String.fromCharCode(c); else return null;
        }
        if (str.length < 3 || (o < end && b[o] !== 0 && str.length < 64)) return str.length >= 3 && o >= end ? str + '…' : null;
        return str;
    }

    // ---------------------------------------------------------------- Hex
    renderHexPanel() {
        const p = this.panels.hex;
        const elf = this.elf;
        const opts = ['<option value="file">Whole file</option>']
            .concat(elf.sections.filter(s => s.hasData && s.size).map(s => `<option value="s${s.index}">${esc(s.name || '[' + s.index + ']')} (section, ${s.size.toLocaleString()} bytes)</option>`))
            .concat(elf.segments.filter(g => g.filesz && g.offset + g.filesz <= elf.bytes.length).map(g => `<option value="p${g.index}">${esc(g.typeName)}[${g.index}] (segment, ${g.filesz.toLocaleString()} bytes)</option>`));
        p.innerHTML = `<div class="elfv-tool"><select class="x-hsrc">${opts.join('')}</select><span class="info x-hinfo"></span></div>`;
        this.hexList = new VList(p, { className: 'elfv-hexv', render: (i) => this.renderHexRow(i) });
        this.lists.push(this.hexList);
        const sel = p.querySelector('.x-hsrc');
        sel.onchange = () => this.showHex(sel.value);
        this.setHexSource('file');
    }

    setHexSource(key) {
        const elf = this.elf;
        let src;
        if (key === 'file') src = { off: 0, size: elf.bytes.length, addr: null, name: 'file' };
        else if (key[0] === 's') { const s = elf.sections[+key.slice(1)]; src = { off: s.offset, size: s.size, addr: s.alloc ? s.addr : null, name: s.name }; }
        else { const g = elf.segments[+key.slice(1)]; src = { off: g.offset, size: Math.min(g.filesz, elf.bytes.length - g.offset), addr: g.vaddr, name: g.typeName }; }
        src.key = key;
        this.hexSrc = src;
        this.panels.hex.querySelector('.x-hsrc').value = key;
        this.panels.hex.querySelector('.x-hinfo').textContent = `${src.size.toLocaleString()} bytes at file offset ${this.hexN(src.off)}` + (src.addr !== null ? `, address ${this.fmt0x(src.addr)}` : '');
        this.hexList.setCount(Math.ceil(src.size / 16));
    }

    showHex(key, addr) {
        this.showTab('hex');
        this.setHexSource(key);
        this.hexHl = null;
        if (addr !== undefined && this.hexSrc.addr !== null) {
            const rel = addr - this.hexSrc.addr;
            this.hexHl = [rel, rel + 1];
            const s = this.symbolize(addr);
            if (s && s.label.size) this.hexHl = [rel, rel + s.label.size];
            this.hexList.scrollTo(Math.floor(rel / 16));
        } else this.hexList.scrollTo(0, 'top');
    }

    renderHexRow(i) {
        const src = this.hexSrc;
        const b = this.elf.bytes;
        const start = i * 16;
        const n = Math.min(16, src.size - start);
        let hx = '', as = '';
        const hl = this.hexHl;
        for (let k = 0; k < 16; k++) {
            if (k < n) {
                const c = b[src.off + start + k];
                const h = (c < 16 ? '0' : '') + c.toString(16);
                const on = hl && start + k >= hl[0] && start + k < hl[1];
                hx += (on ? `<span class="hl">${h}</span>` : h) + (k === 7 ? '  ' : ' ');
                const ch = c >= 32 && c < 127 ? esc(String.fromCharCode(c)) : '.';
                as += on ? `<span class="hl">${ch}</span>` : ch;
            } else hx += k === 7 ? '    ' : '   ';
        }
        const where = src.addr !== null ? this.fmt(src.addr + start) : (src.off + start).toString(16).padStart(8, '0');
        return `<div class="r"><span class="ad">${where}</span>  <span class="hx">${hx}</span> <span class="as">${as}</span></div>`;
    }

    resize() { for (const l of this.lists) l.schedule(); }

    destroy() {
        if (this.worker) { this.worker.terminate(); this.worker = null; }
        for (const l of this.lists) l.destroy();
        this.root.remove();
    }
}

// The architectural memory map of ARMv7-M / ARMv8-M
const CORTEX_M_MAP = [
    { name: 'Code (Cortex-M)', start: '0x0', size: '0x20000000', kind: 'rom', perms: 'rx' },
    { name: 'SRAM (Cortex-M)', start: '0x20000000', size: '0x20000000', kind: 'ram', perms: 'rwx' },
    { name: 'Peripherals', start: '0x40000000', size: '0x20000000', kind: 'mmio', perms: 'rw' },
    { name: 'External RAM', start: '0x60000000', size: '0x40000000', kind: 'ram', perms: 'rwx' },
    { name: 'External device', start: '0xa0000000', size: '0x40000000', kind: 'mmio', perms: 'rw' },
    { name: 'System (PPB)', start: '0xe0000000', size: '0x20000000', kind: 'mmio', perms: 'rw' },
];

function flagsText(h) {
    const f = h.flags;
    if (h.machine === 40) {
        const parts = [`EABI v${f >>> 24}`];
        if (f & 0x400) parts.push('hard-float ABI');
        if (f & 0x200) parts.push('soft-float ABI');
        if (f & 0x800000) parts.push('BE8');
        return parts.join(', ');
    }
    if (h.machine === 243) {
        const fl = ['soft', 'single', 'double', 'quad'][(f >> 1) & 3];
        return [(f & 1) ? 'RVC' : '', `${fl}-float ABI`, (f & 8) ? 'RVE' : '', (f & 0x10) ? 'TSO' : ''].filter(Boolean).join(', ');
    }
    if (h.machine === 8) {
        const parts = [];
        if (f & 0x02000000) parts.push('microMIPS');
        if (f & 4) parts.push('PIC');
        if (f & 2) parts.push('CPIC');
        return parts.join(', ');
    }
    return '';
}

export function mountElfViewer(host, opts) {
    const v = new ElfViewer(host, opts);
    return {
        viewer: v,
        info: v.elf ? { machine: v.elf.header.machineName, type: v.elf.header.typeName, class: v.elf.header.class } : null,
        resize: () => v.resize && v.resize(),
        destroy: () => v.destroy && v.destroy(),
    };
}
