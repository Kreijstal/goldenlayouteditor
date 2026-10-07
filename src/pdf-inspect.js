// --- PDF inspector ---
// The debug side of the PDF viewer: the file's objects as a tree (the trailer,
// the pages, every object, the object streams and what is packed in them), and
// each page's content stream parsed into its operators, nested as they nest
// (q…Q, BT…ET, marked content, a path and how it is painted, form XObjects).
// Hovering a node outlines on the page what it draws (an operator, a font's
// text, an image, a page, an annotation); a click shows its details: the
// dictionary with links, the stream raw and decoded (text, hex, an image), where
// it is in the file. Clicking on a page finds what is drawn there. mupdf
// (WebAssembly) reads the objects; the content streams are parsed here, with
// enough of the graphics and text state to place what they draw.
const { createLogger } = require('./debug');
const { createStepper, STEP_STYLE } = require('./pdf-step');
const { pageFonts, textBoxes, fontSub, showFont, FONT_STYLE } = require('./pdf-fonts');

const log = createLogger('PDF inspect');
// jsDelivr, not esm.sh: it finds its .wasm beside itself (import.meta.url)
const MUPDF = 'https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js';
const HEX_LIMIT = 64 * 1024;
const TEXT_LIMIT = 256 * 1024;
const CHUNK = 200; // children shown at a time

const STYLE = `
.pi-panel{display:flex;flex-direction:column;min-width:0;background:#1e1f21;color:#ddd;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;border-right:1px solid #111;}
.pi-tree{flex:1 1 55%;overflow:auto;padding:4px 0;min-height:60px;}
.pi-detail{flex:1 1 45%;overflow:auto;border-top:2px solid #111;padding:8px 10px;min-height:60px;}
.pi-row{display:flex;align-items:baseline;gap:4px;padding:1px 6px 1px 0;cursor:pointer;white-space:nowrap;}
.pi-row:hover{background:#2c3138;}
.pi-row.sel{background:#264f78;}
.pi-tw{display:inline-block;width:14px;text-align:center;color:#888;flex:none;}
.pi-label{overflow:hidden;text-overflow:ellipsis;}
.pi-sub{color:#8a9199;overflow:hidden;text-overflow:ellipsis;}
.pi-kids{padding-left:12px;}
.pi-sec>.pi-row .pi-label{color:#e8c06a;font-weight:bold;}
.pi-op{color:#c586c0;}
.pi-name{color:#9cdcfe;}
.pi-num{color:#b5cea8;}
.pi-str{color:#ce9178;}
.pi-ref{color:#4fc1ff;text-decoration:underline;cursor:pointer;}
.pi-more{color:#8a9199;font-style:italic;padding-left:20px;cursor:pointer;}
.pi-detail h3{margin:0 0 4px;font:bold 13px sans-serif;color:#eee;}
.pi-detail .pi-meta{color:#8a9199;margin-bottom:6px;font-family:sans-serif;}
.pi-detail pre{margin:4px 0;white-space:pre-wrap;word-break:break-all;background:#151617;padding:6px;border-radius:3px;}
.pi-detail .pi-tabs{display:flex;gap:4px;margin:8px 0 2px;flex-wrap:wrap;}
.pi-detail button{background:#3a3d41;color:#eee;border:1px solid #555;border-radius:3px;padding:1px 8px;font:12px sans-serif;cursor:pointer;}
.pi-detail button.on{background:#264f78;border-color:#4a9eff;}
.pi-detail img{max-width:100%;background:repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/16px 16px;margin-top:4px;}
.pi-hl{position:absolute;pointer-events:none;border:2px solid #ff3d7f;background:rgba(255,61,127,.15);box-sizing:border-box;z-index:1;}
.pi-hl.sel{border-color:#4a9eff;background:rgba(74,158,255,.15);}
.pi-busy{padding:8px 10px;color:#8a9199;font-family:sans-serif;}
`;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

const latin1 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return s;
};

// ---- Matrices: [a b c d e f], as PDF writes them ----
const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function boxOf(m, x0, y0, x1, y1) {
    const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function union(a, b) {
    if (!a) return b;
    if (!b) return a;
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
const fmt = (n) => Number.isInteger(n) ? String(n) : String(+n.toFixed(3));

// ---- Content stream tokens ----
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map(c => c.charCodeAt(0)));

// Reads the content stream s (a latin1 string) into operations:
// { op, args, start, end } (args as JS values: numbers, {name}, {str: bytes}, arrays, dicts)
function tokenize(s) {
    let i = 0;
    const n = s.length;
    const skip = () => {
        for (;;) {
            while (i < n && WS.has(s.charCodeAt(i))) i++;
            if (s[i] === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
            return;
        }
    };
    function value() {
        skip();
        if (i >= n) return undefined;
        const c = s[i];
        if (c === '/') {
            let j = ++i;
            while (j < n && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
            const name = s.slice(i, j).replace(/#([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
            i = j;
            return { name };
        }
        if (c === '(') {
            const out = [];
            let depth = 1;
            i++;
            while (i < n && depth) {
                const ch = s[i++];
                if (ch === '\\') {
                    const e = s[i++];
                    const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
                    if (e in map) out.push(map[e]);
                    else if (/[0-7]/.test(e)) {
                        let oct = e;
                        while (oct.length < 3 && /[0-7]/.test(s[i])) oct += s[i++];
                        out.push(parseInt(oct, 8) & 255);
                    } else if (e === '\r') { if (s[i] === '\n') i++; } else if (e !== '\n') out.push(e.charCodeAt(0));
                } else {
                    if (ch === '(') depth++;
                    else if (ch === ')' && --depth === 0) break;
                    out.push(ch.charCodeAt(0));
                }
            }
            return { str: out };
        }
        if (c === '<' && s[i + 1] === '<') {
            i += 2;
            const dict = {};
            for (;;) {
                skip();
                if (i >= n) break;
                if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; }
                const k = value();
                const v = value();
                if (k && k.name != null) dict[k.name] = v;
                else if (k === undefined) break;
            }
            return { dict };
        }
        if (c === '<') {
            const j = s.indexOf('>', i);
            const hex = s.slice(i + 1, j < 0 ? n : j).replace(/[^0-9a-fA-F]/g, '');
            i = j < 0 ? n : j + 1;
            const out = [];
            for (let k = 0; k < hex.length; k += 2) out.push(parseInt((hex[k] + (hex[k + 1] || '0')), 16));
            return { str: out, hex: true };
        }
        if (c === '[') {
            i++;
            const arr = [];
            for (;;) {
                skip();
                if (i >= n) break;
                if (s[i] === ']') { i++; break; }
                const v = value();
                if (v === undefined) break;
                if (v && v.op) { arr.push(v); continue; }
                arr.push(v);
            }
            return arr;
        }
        if (c === ']' || c === ')' || c === '>' || c === '{' || c === '}') { i++; return { op: c }; }
        let j = i;
        while (j < n && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
        if (j === i) j++;
        const word = s.slice(i, j);
        i = j;
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return parseFloat(word);
        if (word === 'true') return true;
        if (word === 'false') return false;
        if (word === 'null') return null;
        return { op: word };
    }
    const ops = [];
    let args = [];
    let start = -1;
    for (;;) {
        skip();
        if (i >= n) break;
        if (start < 0) start = i;
        const v = value();
        if (v === undefined) break;
        if (v && v.op !== undefined && !Array.isArray(v)) {
            if (v.op === 'BI') {
                // inline image: key value … ID <data> EI
                const dict = {};
                for (;;) {
                    skip();
                    if (i >= n) break;
                    const k = value();
                    if (!k || k.op === 'ID') break;
                    dict[k.name] = value();
                }
                i++; // the one whitespace after ID
                const re = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/g;
                re.lastIndex = i;
                const m = re.exec(s);
                const dataEnd = m ? m.index : n;
                i = m ? m.index + 3 : n;
                ops.push({ op: 'BI', args: [dict], start, end: i, dataLength: dataEnd - (start + 0) });
            } else {
                ops.push({ op: v.op, args, start, end: i });
            }
            args = [];
            start = -1;
        } else {
            args.push(v);
        }
    }
    return ops;
}

const argText = (v) => {
    if (v == null) return 'null';
    if (typeof v === 'number') return fmt(v);
    if (typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return '[' + v.map(argText).join(' ') + ']';
    if (v.name != null) return '/' + v.name;
    if (v.str) return v.hex ? '<' + v.str.map(b => b.toString(16).padStart(2, '0')).join('') + '>' : '(' + String.fromCharCode(...v.str.slice(0, 200)).replace(/[\x00-\x1f\x7f-\xff]/g, '.') + ')';
    if (v.dict) return '<<' + Object.entries(v.dict).map(([k, x]) => '/' + k + ' ' + argText(x)).join(' ') + '>>';
    return '?';
};
const opText = (o) => (o.args.map(argText).join(' ') + ' ' + o.op).trim();

const PAINT = { S: 'stroke', s: 'close, stroke', f: 'fill', F: 'fill', 'f*': 'fill (even-odd)', B: 'fill, stroke', 'B*': 'fill (even-odd), stroke', b: 'close, fill, stroke', 'b*': 'close, fill (even-odd), stroke', n: 'no paint' };
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

// Opens mupdf on bytes and reads the object table
async function openDocument(bytes) {
    const mupdf = await import(MUPDF);
    const doc = new mupdf.PDFDocument(bytes);
    const count = doc.countObjects();
    // Where each object is written (the last time, after incremental updates)
    const text = latin1(bytes);
    const offsets = new Map();
    const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) offsets.set(+m[1], m.index + m[0].length - m[0].trimStart().length);
    // What each object stream holds
    const inStream = new Map(); // objnum -> { stm, index }
    const streams = [];
    for (let num = 1; num < count; num++) {
        const ref = doc.newIndirect(num);
        try {
            if (!ref.isStream()) continue;
            const type = ref.get('Type');
            if (type.isName() && type.asName() === 'ObjStm') {
                const first = ref.get('First').asNumber(), N = ref.get('N').asNumber();
                const head = latin1(ref.readStream().asUint8Array()).slice(0, first).trim().split(/\s+/).map(Number);
                const members = [];
                for (let k = 0; k < N && 2 * k + 1 < head.length; k++) {
                    members.push(head[2 * k]);
                    if (!inStream.has(head[2 * k])) inStream.set(head[2 * k], { stm: num, index: k });
                }
                streams.push({ num, members });
            }
        } catch (err) {
            log.warn(`object ${num}:`, err.message);
        }
    }
    return { mupdf, doc, count, offsets, inStream, streams, text };
}

// A short description of an object: /Type /Subtype, sizes, filters
function summary(obj) {
    try {
        if (obj.isIndirect() && obj.resolve().isNull()) return 'free';
        const r = obj.isIndirect() ? obj.resolve() : obj;
        if (r.isDictionary() || (obj.isIndirect() && obj.isStream())) {
            const name = (k) => { const v = obj.get(k); return v.isName() ? '/' + v.asName() : null; };
            const parts = [name('Type'), name('Subtype') || name('S')].filter(Boolean);
            if (name('Subtype') === '/Image') parts.push(`${obj.get('Width').asNumber()}×${obj.get('Height').asNumber()}`);
            const bf = obj.get('BaseFont');
            if (bf.isName()) parts.push(bf.asName());
            if (obj.isIndirect() && obj.isStream()) {
                const f = obj.get('Filter');
                const filters = f.isName() ? [f.asName()] : f.isArray() ? Array.from({ length: f.length }, (_, k) => f.get(k).asName()) : [];
                parts.push(`stream ${obj.get('Length').asNumber()} B${filters.length ? ' ' + filters.join(',') : ''}`);
            }
            if (!parts.length) parts.push(`<< ${r.isDictionary() ? countKeys(r) : 0} keys >>`);
            return parts.join(' ');
        }
        if (r.isArray()) return `[ ${r.length} items ]`;
        return r.toString().slice(0, 60);
    } catch (err) {
        return '(unreadable)';
    }
}
// A /ToUnicode CMap: code -> text (bfchar and bfrange entries)
function toUnicode(cmap) {
    const map = new Map();
    const hex = (h) => parseInt(h, 16);
    const utf16 = (h) => {
        const units = [];
        for (let k = 0; k + 3 < h.length; k += 4) units.push(parseInt(h.slice(k, k + 4), 16));
        return String.fromCharCode(...units);
    };
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hex(m[1]), utf16(m[2]));
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
            const lo = hex(m[1]), hi = Math.min(hex(m[2]), hex(m[1]) + 65535);
            if (m[4] != null) {
                const base = utf16(m[4]);
                for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
            } else {
                const list = [...m[5].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => utf16(x[1]));
                list.forEach((t, k) => map.set(lo + k, t));
            }
        }
    }
    return map;
}

function countKeys(d) { let k = 0; d.forEach(() => k++); return k; }

function createInspector({ panel, pages, getBytes, saveBeside, onClose, pdfjs }) {
    if (!document.getElementById('pi-style')) {
        const style = el('style');
        style.id = 'pi-style';
        style.textContent = STYLE + STEP_STYLE + FONT_STYLE;
        document.head.appendChild(style);
    }
    panel.classList.add('pi-panel');
    panel.textContent = '';
    const tree = el('div', 'pi-tree');
    const detail = el('div', 'pi-detail');
    panel.append(tree, detail);
    tree.appendChild(el('div', 'pi-busy', 'Reading the PDF (mupdf)…'));
    detail.appendChild(el('div', 'pi-meta', 'Hover over a node to see what it draws; click one for its details. Click on a page to find what is drawn there.'));

    let info = null;           // openDocument's result
    let parsed = [];           // per page: { ops tree, all leaf nodes }
    const uses = new Map();    // objnum -> [{ page, box }]
    const fontCache = new Map();
    let selectedRow = null;
    let selectedHl = [];
    let stepping = null;       // the page being stepped through
    function stopStepping() {
        if (stepping) stepping.destroy();
        stepping = null;
    }

    // ---- Highlights on the pages ----
    function clearHl(cls) {
        for (const p of pages()) p.wrap.querySelectorAll('.pi-hl' + (cls ? '.' + cls : ':not(.sel)')).forEach(e => e.remove());
    }
    function showHl(list, cls, scroll) {
        clearHl(cls);
        let first = null;
        for (const { page, box } of list) {
            const p = pages()[page];
            if (!p || !box) continue;
            const vp = p.page.getViewport({ scale: 1, rotation: (p.page.rotate + p.extra) % 360 });
            const [x0, y0, x1, y1] = vp.convertToViewportRectangle(box);
            const l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
            const d = el('div', 'pi-hl' + (cls ? ' ' + cls : ''));
            d.style.left = (100 * l / vp.width) + '%';
            d.style.top = (100 * t / vp.height) + '%';
            d.style.width = `max(${100 * w / vp.width}%, 3px)`;
            d.style.height = `max(${100 * h / vp.height}%, 3px)`;
            p.wrap.appendChild(d);
            if (!first) first = d;
        }
        if (scroll && first) {
            const r = first.getBoundingClientRect();
            const view = first.closest('.pdfv-scroll').getBoundingClientRect();
            if (r.bottom < view.top || r.top > view.bottom || r.right < view.left || r.left > view.right) first.scrollIntoView({ block: 'center', inline: 'center' });
        }
        return list.length;
    }

    // ---- Fonts as pdf.js loaded them (the Font Inspector) ----
    const pdfFonts = new Map(); // page index → Promise of Map(loadedName → entry with its areas)
    function fontsOfPage(i) {
        if (!pdfFonts.has(i)) pdfFonts.set(i, (async () => {
            const p = pages()[i];
            const fonts = await pageFonts(pdfjs, p.page);
            for (const e of fonts.values()) e.areas = (await textBoxes(p.page, e.name)).map(box => ({ page: i, box }));
            return fonts;
        })());
        return pdfFonts.get(i);
    }
    // the fonts of all pages, each once (its glyphs and areas from every page)
    async function allFonts() {
        const all = new Map();
        for (let i = 0; i < pages().length; i++) {
            for (const e of (await fontsOfPage(i)).values()) {
                let a = all.get(e.name);
                if (!a) all.set(e.name, a = { name: e.name, font: e.font, glyphs: new Map(), shows: 0, areas: [], pages: [] });
                a.shows += e.shows;
                a.areas.push(...e.areas);
                a.pages.push(i);
                for (const [k, g] of e.glyphs) {
                    const had = a.glyphs.get(k);
                    if (had) had.count += g.count; else a.glyphs.set(k, { ...g });
                }
            }
        }
        return all;
    }
    function fontNode(e, pagesUsed) {
        return {
            label: (e.font && e.font.name) || e.name,
            sub: fontSub(e),
            hover: () => e.areas,
            select: () => showFont(detail, e, { pages: pagesUsed, saveBeside }),
        };
    }
    // a node whose children come later: "Reading…" until they do
    function later(node, load) {
        let got = null, started = false;
        node.kids = () => {
            if (got) return got;
            if (!started) {
                started = true;
                load().then(k => { got = k.length ? k : [{ label: 'None' }]; }, err => { got = [{ label: 'Could not read: ' + err.message }]; })
                    .then(() => { if (node.row && node.row.querySelector('.pi-tw').textContent === '▾') { node.collapse(); node.expand(); } });
            }
            return [{ label: 'Reading…' }];
        };
        return node;
    }

    // ---- Fonts: enough to measure text ----
    function fontInfo(ref) {
        const key = ref.isIndirect() ? ref.asIndirect() : null;
        if (key != null && fontCache.has(key)) return fontCache.get(key);
        const f = { factor: 0.001, widths: new Map(), dw: 1000, missing: 0, two: false, ascent: 0.8, descent: -0.2, name: '', unicode: null };
        try {
            const tu = ref.get('ToUnicode');
            if (tu.isIndirect() && tu.isStream()) f.unicode = toUnicode(latin1(tu.readStream().asUint8Array()));
            const sub = ref.get('Subtype').isName() ? ref.get('Subtype').asName() : '';
            f.name = ref.get('BaseFont').isName() ? ref.get('BaseFont').asName() : sub;
            let fd = ref.get('FontDescriptor');
            if (sub === 'Type0') {
                f.two = true; // Identity-H and the like: two bytes a code
                const desc = ref.get('DescendantFonts').get(0);
                fd = desc.get('FontDescriptor');
                if (desc.get('DW').isNumber()) f.dw = desc.get('DW').asNumber();
                const w = desc.get('W');
                for (let k = 0; w.isArray() && k < w.length;) {
                    const c = w.get(k).asNumber(), next = w.get(k + 1);
                    if (next.isArray()) {
                        for (let j = 0; j < next.length; j++) f.widths.set(c + j, next.get(j).asNumber());
                        k += 2;
                    } else {
                        const last = next.asNumber(), wv = w.get(k + 2).asNumber();
                        for (let j = c; j <= last && j - c < 65536; j++) f.widths.set(j, wv);
                        k += 3;
                    }
                }
            } else {
                const first = ref.get('FirstChar').isNumber() ? ref.get('FirstChar').asNumber() : 0;
                const w = ref.get('Widths');
                for (let k = 0; w.isArray() && k < w.length; k++) f.widths.set(first + k, w.get(k).asNumber());
                f.dw = 500;
                if (sub === 'Type3') {
                    const fm = ref.get('FontMatrix');
                    if (fm.isArray()) f.factor = fm.get(0).asNumber();
                }
            }
            if (fd && fd.isDictionary && !fd.isNull()) {
                if (fd.get('MissingWidth').isNumber()) f.missing = fd.get('MissingWidth').asNumber();
                if (fd.get('Ascent').isNumber() && fd.get('Ascent').asNumber()) f.ascent = fd.get('Ascent').asNumber() / 1000;
                if (fd.get('Descent').isNumber() && fd.get('Descent').asNumber()) f.descent = fd.get('Descent').asNumber() / 1000;
            }
        } catch (err) {
            log.warn('font:', err.message);
        }
        if (key != null) fontCache.set(key, f);
        return f;
    }

    // ---- Content streams: operators nested, each with what it covers ----
    function resolveRes(res, cat, name) {
        try {
            const v = res && res.get(cat).get(name);
            return v && !v.isNull() ? v : null;
        } catch (err) { return null; }
    }

    // Reads a content stream into nodes; gs carries on (forms start from the caller's state)
    function parseContent(src, res, pageIndex, ctm0, depth, seen) {
        const ops = tokenize(src);
        const root = { kind: 'root', children: [] };
        const stack = [root];
        const gsStack = [];
        let gs = { ctm: ctm0, font: null, fontRef: null, size: 1, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
        let tm = IDENTITY, tlm = IDENTITY;
        let path = null; // { node, box }
        const top = () => stack[stack.length - 1];
        const add = (node) => { node.parent = top(); node.page = pageIndex; node.src = src; top().children.push(node); return node; };
        const open = (node) => { add(node); node.children = []; stack.push(node); };
        const close = (kind) => {
            for (let k = stack.length - 1; k > 0; k--) if (stack[k].kind === kind) { const n = stack.splice(k)[0]; return n; }
            return null;
        };
        const use = (num, box) => {
            if (num == null || !box) return;
            if (!uses.has(num)) uses.set(num, []);
            uses.get(num).push({ page: pageIndex, box });
        };
        const showText = (node, str) => {
            const f = gs.font || { factor: 0.001, widths: new Map(), dw: 500, missing: 0, two: false, ascent: 0.8, descent: -0.2 };
            const bytes = str.str || [];
            let x = 0;
            const step = f.two ? 2 : 1;
            for (let k = 0; k < bytes.length; k += step) {
                const code = f.two ? (bytes[k] << 8) | (bytes[k + 1] || 0) : bytes[k];
                const w0 = f.widths.has(code) ? f.widths.get(code) : (f.two ? f.dw : (f.missing || f.dw));
                x += (w0 * f.factor * gs.size + gs.tc + (!f.two && code === 32 ? gs.tw : 0)) * gs.th;
            }
            return x;
        };
        const textBox = (x0, x1) => {
            const f = gs.font || { ascent: 0.8, descent: -0.2 };
            const trm = mul(tm, gs.ctm);
            return boxOf(trm, Math.min(x0, x1), f.descent * gs.size + gs.rise, Math.max(x0, x1), f.ascent * gs.size + gs.rise);
        };
        const preview = (strs) => {
            const f = gs.font;
            let out = '';
            for (const s of strs) {
                const b = (s.str || []).slice(0, 160);
                for (let k = 0; k < b.length; k += f && f.two ? 2 : 1) {
                    const code = f && f.two ? (b[k] << 8) | (b[k + 1] || 0) : b[k];
                    out += f && f.unicode && f.unicode.has(code) ? f.unicode.get(code) : f && f.two ? '·' : String.fromCharCode(code);
                }
            }
            return out.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
        };
        for (const o of ops) {
            const a = o.args;
            const node = { kind: 'op', op: o.op, start: o.start, end: o.end, label: opText(o) };
            switch (o.op) {
                case 'q':
                    open({ kind: 'q', op: 'q', start: o.start, end: o.end, label: 'q … Q' });
                    gsStack.push(gs);
                    gs = { ...gs };
                    continue;
                case 'Q': {
                    const g = close('q');
                    if (g) { g.end = o.end; if (gsStack.length) gs = gsStack.pop(); continue; }
                    if (gsStack.length) gs = gsStack.pop();
                    break;
                }
                case 'BT':
                    tm = tlm = IDENTITY;
                    open({ kind: 'BT', op: 'BT', start: o.start, end: o.end, label: 'Text', strs: [] });
                    continue;
                case 'ET': {
                    const g = close('BT');
                    if (g) { g.end = o.end; const t = g.strs.join(''); g.label = t ? `Text “${t.length > 60 ? t.slice(0, 60) + '…' : t}”` : 'Text'; continue; }
                    break;
                }
                case 'BMC': case 'BDC':
                    open({ kind: 'marked', op: o.op, start: o.start, end: o.end, label: `${opText(o)} … EMC` });
                    continue;
                case 'EMC': {
                    const g = close('marked');
                    if (g) { g.end = o.end; continue; }
                    break;
                }
                case 'cm':
                    if (a.length === 6) gs.ctm = mul(a, gs.ctm);
                    break;
                case 'Tf': {
                    const ref = resolveRes(res, 'Font', a[0] && a[0].name);
                    gs.font = ref ? fontInfo(ref) : null;
                    gs.fontRef = ref && ref.isIndirect() ? ref.asIndirect() : null;
                    gs.size = typeof a[1] === 'number' ? a[1] : 1;
                    break;
                }
                case 'Tc': gs.tc = a[0] || 0; break;
                case 'Tw': gs.tw = a[0] || 0; break;
                case 'Tz': gs.th = (a[0] == null ? 100 : a[0]) / 100; break;
                case 'TL': gs.tl = a[0] || 0; break;
                case 'Ts': gs.rise = a[0] || 0; break;
                case 'Td': tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm; break;
                case 'TD': gs.tl = -(a[1] || 0); tlm = mul([1, 0, 0, 1, a[0] || 0, a[1] || 0], tlm); tm = tlm; break;
                case 'Tm': if (a.length === 6) { tlm = a.slice(); tm = tlm; } break;
                case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; break;
            }
            if (SHOW_OPS.has(o.op)) {
                if (o.op === "'" || o.op === '"') {
                    if (o.op === '"') { gs.tw = a[0] || 0; gs.tc = a[1] || 0; }
                    tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm;
                }
                const strs = o.op === 'TJ' ? (Array.isArray(a[0]) ? a[0] : []) : [a[a.length - 1]].filter(Boolean);
                let box = null;
                for (const part of strs) {
                    if (typeof part === 'number') {
                        const dx = -part / 1000 * gs.size * gs.th;
                        tm = mul([1, 0, 0, 1, dx, 0], tm);
                        continue;
                    }
                    if (!part || !part.str) continue;
                    const w = showText(node, part);
                    box = union(box, textBox(0, w));
                    tm = mul([1, 0, 0, 1, w, 0], tm);
                }
                node.box = box;
                node.label = opText(o);
                const t = preview(strs.filter(x => x && x.str));
                const bt = stack.find(s => s.kind === 'BT');
                if (bt) bt.strs.push(t);
                if (t) node.label = `${o.op} “${t.length > 50 ? t.slice(0, 50) + '…' : t}”`;
                node.refs = gs.fontRef != null ? [gs.fontRef] : [];
                node.gs = { ...gs, tm };
                use(gs.fontRef, box);
                add(node);
                continue;
            }
            if (PATH_OPS.has(o.op)) {
                if (!path) {
                    path = { kind: 'path', op: 'path', start: o.start, end: o.end, children: [], box: null };
                }
                const pts = [];
                if (o.op === 're' && a.length === 4) {
                    path.box = union(path.box, boxOf(gs.ctm, a[0], a[1], a[0] + a[2], a[1] + a[3]));
                } else {
                    for (let k = 0; k + 1 < a.length; k += 2) pts.push(apply(gs.ctm, a[k], a[k + 1]));
                    for (const [x, y] of pts) path.box = union(path.box, [x, y, x, y]);
                }
                node.parent = path; node.page = pageIndex; node.src = src;
                path.children.push(node);
                path.end = o.end;
                continue;
            }
            if (o.op === 'W' || o.op === 'W*') {
                if (path) { path.clip = o.op; node.parent = path; node.page = pageIndex; node.src = src; path.children.push(node); path.end = o.end; continue; }
            }
            if (PAINT[o.op]) {
                const p = path || { kind: 'path', op: 'path', start: o.start, children: [], box: null };
                path = null;
                node.parent = p; node.page = pageIndex; node.src = src;
                p.children.push(node);
                p.end = o.end;
                const shapes = [...new Set(p.children.filter(c => PATH_OPS.has(c.op)).map(c => c.op))].join(' ');
                p.label = p.clip ? `Clip${o.op !== 'n' ? ' and ' + PAINT[o.op] : ''} (${shapes})` : `Path: ${PAINT[o.op]} (${shapes})`;
                p.paint = o.op;
                // (a stroke reaches half the line width beyond the path: near enough without it)
                if (o.op === 'n' && !p.clip) p.box = null;
                p.gs = { ...gs };
                if (p.clip && o.op === 'n') p.isClip = true;
                add(p);
                p.children.forEach(c => { c.parent = p; });
                continue;
            }
            if (o.op === 'Do') {
                const name = a[0] && a[0].name;
                const ref = resolveRes(res, 'XObject', name);
                const num = ref && ref.isIndirect() ? ref.asIndirect() : null;
                const sub = ref && ref.get('Subtype').isName() ? ref.get('Subtype').asName() : '?';
                node.refs = num != null ? [num] : [];
                if (sub === 'Image') {
                    node.box = boxOf(gs.ctm, 0, 0, 1, 1);
                    node.label = `Do /${name} → image ${num != null ? num + ' 0 R ' : ''}${ref.get('Width').asNumber()}×${ref.get('Height').asNumber()}`;
                    use(num, node.box);
                    add(node);
                } else if (sub === 'Form') {
                    const fm = ref.get('Matrix');
                    const m = fm.isArray() && fm.length === 6 ? Array.from({ length: 6 }, (_, k) => fm.get(k).asNumber()) : IDENTITY;
                    const ctm = mul(m, gs.ctm);
                    const bb = ref.get('BBox');
                    node.kind = 'form';
                    node.label = `Do /${name} → form ${num != null ? num + ' 0 R' : ''}`;
                    if (bb.isArray() && bb.length === 4) node.box = boxOf(ctm, bb.get(0).asNumber(), bb.get(1).asNumber(), bb.get(2).asNumber(), bb.get(3).asNumber());
                    node.children = [];
                    add(node);
                    use(num, node.box);
                    if (depth < 8 && num != null && !seen.has(num)) {
                        try {
                            const fres = ref.get('Resources');
                            const inner = parseContent(latin1(ref.readStream().asUint8Array()), fres.isNull() ? res : fres, pageIndex, ctm, depth + 1, new Set([...seen, num]));
                            node.children = inner.children;
                            node.children.forEach(c => { c.parent = node; });
                            node.formSrc = true;
                        } catch (err) {
                            node.label += ' (unreadable)';
                        }
                    }
                } else {
                    node.label = `Do /${name}${num != null ? ' → ' + num + ' 0 R' : ' (missing)'}`;
                    add(node);
                }
                continue;
            }
            if (o.op === 'BI') {
                const d = a[0] || {};
                node.box = boxOf(gs.ctm, 0, 0, 1, 1);
                node.label = `Inline image ${(d.W || d.Width || '?')}×${(d.H || d.Height || '?')}`;
                add(node);
                continue;
            }
            if (o.op === 'gs') {
                const ref = resolveRes(res, 'ExtGState', a[0] && a[0].name);
                node.refs = ref && ref.isIndirect() ? [ref.asIndirect()] : [];
            }
            if (o.op === 'sh') {
                const ref = resolveRes(res, 'Shading', a[0] && a[0].name);
                node.refs = ref && ref.isIndirect() ? [ref.asIndirect()] : [];
            }
            add(node);
        }
        while (stack.length > 1) stack.pop();
        // a group covers what its members draw (a clip only bounds them, so not that)
        const GROUPS = new Set(['q', 'BT', 'marked']);
        const fill = (n) => {
            let b = null;
            for (const c of n.children || []) b = union(b, fill(c));
            if (GROUPS.has(n.kind)) n.box = b;
            return n.isClip ? null : n.box;
        };
        root.children.forEach(fill);
        return root;
    }

    function parsePage(i) {
        if (parsed[i]) return parsed[i];
        const { doc } = info;
        const page = doc.findPage(i);
        const res = page.getInheritable('Resources');
        const contents = page.get('Contents');
        const parts = contents.isArray() ? Array.from({ length: contents.length }, (_, k) => contents.get(k)) : contents.isNull() ? [] : [contents];
        // the streams of /Contents make one stream: each one's place in it
        let src = '';
        const pieces = [];
        for (const c of parts) {
            const s = latin1(c.readStream().asUint8Array());
            pieces.push({ num: c.isIndirect() ? c.asIndirect() : null, start: src.length, end: src.length + s.length });
            src += s + '\n';
        }
        const root = parseContent(src, res, i, IDENTITY, 0, new Set());
        const leaves = [];
        const walk = (n) => { if (n.box && n.kind !== 'root') leaves.push(n); (n.children || []).forEach(walk); };
        root.children.forEach(walk);
        const mb = page.getInheritable('MediaBox');
        const pageBox = mb.isArray() ? [0, 1, 2, 3].map(k => mb.get(k).asNumber()) : [0, 0, 612, 792];
        parsed[i] = { root, leaves, pieces, src, pageBox: [Math.min(pageBox[0], pageBox[2]), Math.min(pageBox[1], pageBox[3]), Math.max(pageBox[0], pageBox[2]), Math.max(pageBox[1], pageBox[3])], ref: page };
        const pnum = page.isIndirect() ? page.asIndirect() : null;
        if (pnum != null) (uses.get(pnum) || uses.set(pnum, []).get(pnum)).push({ page: i, box: parsed[i].pageBox });
        for (const piece of pieces) if (piece.num != null) (uses.get(piece.num) || uses.set(piece.num, []).get(piece.num)).push({ page: i, box: parsed[i].pageBox });
        // annotations
        const annots = page.get('Annots');
        for (let k = 0; annots.isArray() && k < annots.length; k++) {
            const an = annots.get(k);
            const r = an.get('Rect');
            if (an.isIndirect() && r.isArray() && r.length === 4) {
                const b = [0, 1, 2, 3].map(j => r.get(j).asNumber());
                (uses.get(an.asIndirect()) || uses.set(an.asIndirect(), []).get(an.asIndirect())).push({ page: i, box: [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] });
            }
        }
        return parsed[i];
    }

    // What an object covers on the pages (an object stream: what its members cover)
    function areasOf(num) {
        const list = (uses.get(num) || []).slice();
        const stm = info.streams.find(s => s.num === num);
        if (stm) for (const m of stm.members) list.push(...(uses.get(m) || []));
        return list;
    }

    // ---- Tree ----
    // node: { label, sub, cls, kids(): nodes, hover(): areas, select(), ast }
    function render(node, parent) {
        const wrap = el('div', node.cls || '');
        const row = el('div', 'pi-row');
        const tw = el('span', 'pi-tw', node.kids ? '▸' : '');
        const label = el('span', 'pi-label');
        if (node.labelHtml) node.labelHtml(label); else label.textContent = node.label;
        row.append(tw, label);
        if (node.sub) row.appendChild(el('span', 'pi-sub', node.sub));
        wrap.appendChild(row);
        let kidsEl = null;
        node.row = row;
        node.expand = () => {
            if (!node.kids || kidsEl) return;
            kidsEl = el('div', 'pi-kids');
            wrap.appendChild(kidsEl);
            let kids;
            try { kids = node.kids(); } catch (err) { kids = [{ label: 'Could not read: ' + err.message }]; }
            node.kidNodes = kids;
            let shown = 0;
            const more = () => {
                const next = kids.slice(shown, shown + CHUNK);
                next.forEach(k => render(k, kidsEl));
                shown += next.length;
                const old = kidsEl.querySelector(':scope > .pi-more');
                if (old) old.remove();
                if (shown < kids.length) {
                    const m = el('div', 'pi-more', `${kids.length - shown} more…`);
                    m.onclick = (e) => { e.stopPropagation(); more(); };
                    kidsEl.appendChild(m);
                }
            };
            node.showAll = () => { while (shown < kids.length) more(); };
            more();
            tw.textContent = '▾';
        };
        node.collapse = () => {
            if (!kidsEl) return;
            kidsEl.remove();
            kidsEl = null;
            tw.textContent = '▸';
        };
        row.onclick = (e) => {
            e.stopPropagation();
            // the arrow opens and closes; a click on the row opens it too, and selects it
            if (e.target === tw) { kidsEl ? node.collapse() : node.expand(); return; }
            if (node.kids && !kidsEl) node.expand();
            select(node);
        };
        row.ondblclick = () => { if (node.kids) kidsEl ? node.collapse() : node.expand(); };
        row.onmouseenter = () => { if (node.hover) showHl(node.hover(), null, true); };
        row.onmouseleave = () => clearHl();
        parent.appendChild(wrap);
        return node;
    }

    function select(node) {
        if (selectedRow) selectedRow.classList.remove('sel');
        selectedRow = node.row;
        if (selectedRow) selectedRow.classList.add('sel');
        clearHl('sel');
        if (node.hover) showHl(node.hover(), 'sel', true);
        if (node.select) {
            stopStepping();
            detail.textContent = '';
            try { node.select(); } catch (err) { detail.appendChild(el('div', 'pi-meta', 'Could not show it: ' + err.message)); log.error(err); }
        }
    }

    // A value in a dictionary or array, as a tree node
    function valueNode(label, v) {
        if (v.isIndirect()) {
            const num = v.asIndirect();
            return objNode(num, label);
        }
        if (v.isDictionary()) return { label, sub: `<< ${countKeys(v)} keys >>`, kids: () => dictKids(v) };
        if (v.isArray()) return { label, sub: `[ ${v.length} ]`, kids: () => arrayKids(v) };
        return { label: label + ' ' + v.toString().slice(0, 200) };
    }
    function dictKids(d) {
        const out = [];
        d.forEach((v, k) => out.push(valueNode('/' + k, v)));
        return out;
    }
    function arrayKids(a) {
        return Array.from({ length: a.length }, (_, k) => valueNode(`[${k}]`, a.get(k)));
    }
    function objNode(num, label) {
        const ref = info.doc.newIndirect(num);
        const r = ref.resolve();
        const where = info.inStream.get(num);
        return {
            label: (label ? label + ' ' : '') + `${num} 0 R`,
            sub: summary(ref) + (where ? ` · in object stream ${where.stm}` : ''),
            kids: r.isDictionary() || r.isArray() ? () => {
                const kids = r.isDictionary() ? dictKids(r) : arrayKids(r);
                if (ref.isStream()) kids.push({ label: 'stream data', sub: summary(ref).replace(/^.*stream /, ''), hover: () => areasOf(num), select: () => showObject(num) });
                const stm = info.streams.find(s => s.num === num);
                if (stm) kids.push({ label: `holds ${stm.members.length} objects`, kids: () => stm.members.map(m => objNode(m)) });
                return kids;
            } : null,
            hover: () => areasOf(num),
            select: () => showObject(num),
        };
    }

    function astNode(n, page) {
        const kids = n.children && n.children.length ? () => n.children.map(c => astNode(c, page)) : null;
        const t = {
            label: n.label || n.op,
            cls: '',
            ast: n,
            labelHtml: (lab) => {
                if (n.kind === 'op') {
                    const m = /^(.*?)(\S+)$/.exec(n.label);
                    if (m && !/“/.test(n.label)) { lab.append(document.createTextNode(m[1])); lab.appendChild(el('span', 'pi-op', m[2])); return; }
                }
                lab.textContent = n.label || n.op;
            },
            sub: n.children && n.children.length ? `${n.children.length}` : '',
            kids,
            hover: () => n.box ? [{ page, box: n.box }] : [],
            select: () => showOp(n, page),
        };
        n.treeNode = t;
        return t;
    }

    function pageNode(i) {
        return {
            label: `Page ${i + 1}`,
            sub: (() => { try { const p = info.doc.findPage(i); return p.isIndirect() ? `${p.asIndirect()} 0 R` : ''; } catch (err) { return ''; } })(),
            pageIndex: i,
            kids: () => {
                const pp = parsePage(i);
                const out = [];
                if (pp.ref.isIndirect()) out.push(objNode(pp.ref.asIndirect(), 'Page object'));
                const ops = { label: 'Content', sub: `${pp.root.children.length} at top level, ${pp.src.length} B`, kids: () => pp.root.children.map(c => astNode(c, i)), hover: () => [{ page: i, box: pp.pageBox }], select: () => showContent(i), isContent: true };
                out.push(ops);
                if (pdfjs) out.push(later({ label: 'Fonts', sub: 'as pdf.js loaded them' }, async () =>
                    [...(await fontsOfPage(i)).values()].map(e => fontNode(e, [i]))));
                if (pdfjs) out.push({ label: 'Step through drawing', sub: 'as pdf.js draws it', select: () => {
                    const p = pages()[i];
                    if (!p || !p.canvas) return;
                    stepping = createStepper({ pdfjs, p, number: i + 1, panel: detail });
                } });
                const annots = pp.ref.get('Annots');
                if (annots.isArray() && annots.length) {
                    out.push({ label: 'Annotations', sub: String(annots.length), kids: () => Array.from({ length: annots.length }, (_, k) => {
                        const an = annots.get(k);
                        return an.isIndirect() ? objNode(an.asIndirect(), `[${k}]`) : valueNode(`[${k}]`, an);
                    }) });
                }
                const res = pp.ref.getInheritable('Resources');
                if (!res.isNull()) out.push(res.isIndirect() ? objNode(res.asIndirect(), 'Resources') : valueNode('Resources', res));
                return out;
            },
            hover: () => { const pp = parsePage(i); return [{ page: i, box: pp.pageBox }]; },
            select: () => { const p = info.doc.findPage(i); if (p.isIndirect()) showObject(p.asIndirect()); },
        };
    }

    // ---- Details ----
    function head(title, meta) {
        detail.appendChild(el('h3', null, title));
        if (meta) detail.appendChild(el('div', 'pi-meta', meta));
    }

    // A PDF value, written out with links to the objects it names
    function pretty(v, indent, out, depth) {
        const pad = '  '.repeat(indent);
        const text = (t, cls) => out.appendChild(cls ? el('span', cls, t) : document.createTextNode(t));
        if (v.isIndirect()) {
            const num = v.asIndirect();
            const a = el('span', 'pi-ref', `${num} 0 R`);
            a.title = summary(v);
            a.onclick = () => revealObject(num);
            a.onmouseenter = () => showHl(areasOf(num), null, true);
            a.onmouseleave = () => clearHl();
            out.appendChild(a);
            return;
        }
        if (depth > 12) return text('…');
        if (v.isDictionary()) {
            const keys = [];
            v.forEach((x, k) => keys.push([k, x]));
            if (!keys.length) return text('<< >>');
            text('<<\n');
            for (const [k, x] of keys) {
                text(pad + '  ');
                text('/' + k, 'pi-name');
                text(' ');
                pretty(x, indent + 1, out, depth + 1);
                text('\n');
            }
            text(pad + '>>');
            return;
        }
        if (v.isArray()) {
            const n = v.length;
            const simple = Array.from({ length: Math.min(n, 200) }, (_, k) => v.get(k)).every(x => !x.isDictionary() && !x.isArray());
            text('[');
            for (let k = 0; k < Math.min(n, 2000); k++) {
                text(simple ? ' ' : '\n' + pad + '  ');
                pretty(v.get(k), indent + 1, out, depth + 1);
            }
            if (n > 2000) text(` … ${n - 2000} more`);
            text(simple ? ' ]' : '\n' + pad + ']');
            return;
        }
        if (v.isName()) return text('/' + v.asName(), 'pi-name');
        if (v.isNumber()) return text(v.toString(), 'pi-num');
        if (v.isString()) return text(v.toString(), 'pi-str');
        text(v.toString());
    }

    function hexDump(bytes, limit = HEX_LIMIT) {
        const lines = [];
        const n = Math.min(bytes.length, limit);
        for (let o = 0; o < n; o += 16) {
            const row = bytes.subarray(o, Math.min(o + 16, n));
            const hex = Array.from(row, b => b.toString(16).padStart(2, '0')).join(' ');
            lines.push(o.toString(16).padStart(8, '0') + '  ' + hex.padEnd(48) + '  ' + Array.from(row, b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join(''));
        }
        if (bytes.length > n) lines.push(`… ${bytes.length - n} more bytes`);
        return lines.join('\n');
    }
    const looksText = (bytes) => {
        const n = Math.min(bytes.length, 4096);
        let bad = 0;
        for (let k = 0; k < n; k++) { const b = bytes[k]; if (b < 9 || (b > 13 && b < 32)) bad++; }
        return n === 0 || bad / n < 0.02;
    };

    function showObject(num) {
        detail.textContent = '';
        const ref = info.doc.newIndirect(num);
        const where = info.inStream.get(num);
        const off = info.offsets.get(num);
        head(`${num} 0 obj  ${summary(ref)}`, where ? `In object stream ${where.stm} 0 R, number ${where.index} in it` : off != null ? `At byte ${off} of the file` : '');
        const areas = areasOf(num);
        if (areas.length) detail.appendChild(el('div', 'pi-meta', `Drawn on page${new Set(areas.map(a => a.page)).size > 1 ? 's' : ''} ${[...new Set(areas.map(a => a.page + 1))].join(', ')}`));
        const pre = el('pre');
        pretty(ref.resolve(), 0, pre, 0);
        detail.appendChild(pre);
        if (where) {
            const a = el('span', 'pi-ref', `Show object stream ${where.stm}`);
            a.onclick = () => revealObject(where.stm);
            detail.appendChild(a);
        }
        if (!ref.isStream()) return;
        const raw = ref.readRawStream().asUint8Array();
        let decoded = null, decodeError = null;
        try { decoded = ref.readStream().asUint8Array(); } catch (err) { decodeError = err.message; }
        detail.appendChild(el('div', 'pi-meta', `Stream: ${raw.length} bytes in the file${decoded ? `, ${decoded.length} decoded` : ''}${decodeError ? ' — could not decode: ' + decodeError : ''}`));
        const tabs = el('div', 'pi-tabs');
        const body = el('div');
        detail.append(tabs, body);
        const isImage = ref.get('Subtype').isName() && ref.get('Subtype').asName() === 'Image';
        const views = [];
        if (isImage) views.push(['Image', () => {
            const img = el('img');
            try {
                const image = info.doc.loadImage(ref);
                const pix = image.toPixmap();
                const png = pix.asPNG();
                img.src = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
                body.appendChild(el('div', 'pi-meta', `${image.getWidth()}×${image.getHeight()}, ${pix.getNumberOfComponents ? pix.getNumberOfComponents() : ''} components`));
            } catch (err) { body.appendChild(el('div', 'pi-meta', 'Could not draw it: ' + err.message)); }
            body.appendChild(img);
        }]);
        if (decoded) views.push(['Decoded', () => {
            const pre = el('pre');
            pre.textContent = looksText(decoded) ? latin1(decoded.subarray(0, TEXT_LIMIT)) + (decoded.length > TEXT_LIMIT ? `\n… ${decoded.length - TEXT_LIMIT} more bytes` : '') : hexDump(decoded);
            body.appendChild(pre);
        }]);
        if (decoded) views.push(['Decoded (hex)', () => { const pre = el('pre'); pre.textContent = hexDump(decoded); body.appendChild(pre); }]);
        views.push(['Raw (hex)', () => { const pre = el('pre'); pre.textContent = hexDump(raw); body.appendChild(pre); }]);
        views.forEach(([name, show], k) => {
            const b = el('button', null, name);
            b.onclick = () => { tabs.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); body.textContent = ''; show(); };
            tabs.appendChild(b);
            if (k === 0) b.click();
        });
        if (saveBeside) {
            const ext = (() => {
                const f = ref.get('Filter');
                const last = f.isName() ? f.asName() : f.isArray() && f.length ? f.get(f.length - 1).asName() : '';
                return last;
            })();
            const save = el('button', null, 'Save decoded…');
            save.disabled = !decoded;
            // an embedded Flash movie (PDF RichMedia) is known by its first bytes
            const decExt = decoded && decoded.length > 3 && /^[FCZ]WS$/.test(String.fromCharCode(decoded[0], decoded[1], decoded[2])) ? 'swf' : 'bin';
            if (decExt === 'swf') save.textContent = 'Save as SWF…';
            save.onclick = () => saveBeside(`obj${num}.${decExt}`, decExt, async () => new Blob([decoded]), 'Saving…');
            const saveRaw = el('button', null, ext === 'DCTDecode' ? 'Save as JPEG…' : ext === 'JPXDecode' ? 'Save as JPEG 2000…' : 'Save raw…');
            const rawExt = ext === 'DCTDecode' ? 'jpg' : ext === 'JPXDecode' ? 'jp2' : 'bin';
            saveRaw.onclick = () => saveBeside(`obj${num}-raw.${rawExt}`, rawExt, async () => new Blob([raw]), 'Saving…');
            const row = el('div', 'pi-tabs');
            row.append(save, saveRaw);
            detail.appendChild(row);
        }
    }

    function showOp(n, page) {
        detail.textContent = '';
        const pp = parsePage(page);
        const piece = !n.formSrc && pp.pieces.find(p => n.start >= p.start && n.start < p.end);
        const kind = { q: 'Saved graphics state (q … Q)', BT: 'Text object (BT … ET)', marked: 'Marked content', path: 'Path', form: 'Form XObject', op: 'Operator' }[n.kind] || n.kind;
        head(n.label || n.op, `${kind} on page ${page + 1}` + (piece && piece.num != null ? `, in content stream ${piece.num} 0 R` : '') + (n.src === pp.src ? `, bytes ${n.start}–${n.end}` : ''));
        if (n.box) detail.appendChild(el('div', 'pi-meta', `Covers [${n.box.map(fmt).join(' ')}] (page units)`));
        const gs = n.gs;
        if (gs) detail.appendChild(el('div', 'pi-meta', `CTM [${gs.ctm.map(fmt).join(' ')}]` + (gs.font ? `, font ${gs.font.name} ${fmt(gs.size)}` : '') + (gs.tm ? `, text matrix [${gs.tm.map(fmt).join(' ')}]` : '')));
        for (const num of n.refs || []) {
            const a = el('span', 'pi-ref', `${num} 0 R  ${summary(info.doc.newIndirect(num))}`);
            a.onclick = () => revealObject(num);
            detail.appendChild(a);
            detail.appendChild(el('br'));
        }
        const pre = el('pre');
        const src = n.src || pp.src;
        const text = src.slice(n.start, n.end);
        pre.textContent = text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) + `\n… ${text.length - TEXT_LIMIT} more` : text;
        detail.appendChild(pre);
    }

    function showContent(i) {
        detail.textContent = '';
        const pp = parsePage(i);
        head(`Content of page ${i + 1}`, `${pp.pieces.length} stream${pp.pieces.length === 1 ? '' : 's'}: ` + pp.pieces.map(p => p.num != null ? `${p.num} 0 R` : 'direct').join(', ') + `, ${pp.src.length} bytes decoded`);
        for (const p of pp.pieces) if (p.num != null) {
            const a = el('span', 'pi-ref', `Stream ${p.num} 0 R`);
            a.onclick = () => revealObject(p.num);
            detail.append(a, document.createTextNode('  '));
        }
        const pre = el('pre');
        pre.textContent = pp.src.slice(0, TEXT_LIMIT) + (pp.src.length > TEXT_LIMIT ? `\n… ${pp.src.length - TEXT_LIMIT} more` : '');
        detail.appendChild(pre);
    }

    // ---- Finding things in the tree ----
    let sections = {};
    function revealObject(num) {
        const sec = sections.objects;
        if (info.count > 5000) { showObject(num); return; } // too many rows to put up just to find one
        sec.expand();
        sec.showAll();
        const node = sec.kidNodes.find(k => k.num === num);
        if (!node) { showObject(num); return; }
        node.row.scrollIntoView({ block: 'center' });
        select(node);
    }
    function revealAst(n) {
        const chain = [];
        for (let x = n; x && x.kind !== 'root'; x = x.parent) chain.unshift(x);
        const pagesSec = sections.pages;
        pagesSec.expand();
        pagesSec.showAll();
        const pn = pagesSec.kidNodes[n.page];
        pn.expand();
        const content = pn.kidNodes.find(k => k.isContent);
        content.expand();
        let cur = content;
        for (const x of chain) {
            cur.showAll && cur.showAll();
            const next = (cur.kidNodes || []).find(k => k.ast === x);
            if (!next) break;
            if (x !== n) next.expand();
            cur = next;
        }
        if (cur.row) { cur.row.scrollIntoView({ block: 'center' }); select(cur); }
    }

    // A click on a page: the smallest thing drawn there
    function pickAt(pageIndex, fx, fy) {
        if (!info) return;
        const p = pages()[pageIndex];
        const vp = p.page.getViewport({ scale: 1, rotation: (p.page.rotate + p.extra) % 360 });
        const [x, y] = vp.convertToPdfPoint(fx * vp.width, fy * vp.height);
        const pp = parsePage(pageIndex);
        let best = null, bestArea = Infinity;
        for (const n of pp.leaves) {
            const b = n.box;
            if (n.kind === 'q' || n.kind === 'marked' || n.kind === 'BT' || n.isClip) continue;
            if (x < b[0] - 1 || x > b[2] + 1 || y < b[1] - 1 || y > b[3] + 1) continue;
            const area = Math.max(b[2] - b[0], 0.5) * Math.max(b[3] - b[1], 0.5);
            if (area <= bestArea) { best = n; bestArea = area; }
        }
        if (best) revealAst(best);
    }

    function build() {
        tree.textContent = '';
        const { doc, count } = info;
        const trailer = doc.getTrailer();
        sections.document = render({ label: 'Document', cls: 'pi-sec', sub: `PDF ${(doc.getVersion() / 10).toFixed(1)}, ${count - 1} objects`, kids: () => {
            const out = [{ label: 'Trailer', sub: summary(trailer), kids: () => dictKids(trailer), select: () => { detail.textContent = ''; head('Trailer'); const pre = el('pre'); pretty(trailer, 0, pre, 0); detail.appendChild(pre); } }];
            const root = trailer.get('Root');
            if (root.isIndirect()) out.push(objNode(root.asIndirect(), 'Catalog'));
            const inf = trailer.get('Info');
            if (inf.isIndirect()) out.push(objNode(inf.asIndirect(), 'Info'));
            return out;
        } }, tree);
        sections.pages = render({ label: 'Pages', cls: 'pi-sec', sub: String(doc.countPages()), kids: () => Array.from({ length: doc.countPages() }, (_, i) => pageNode(i)) }, tree);
        if (pdfjs) sections.fonts = render(later({ label: 'Fonts', cls: 'pi-sec', sub: 'as pdf.js loaded them' }, async () =>
            [...(await allFonts()).values()].map(e => fontNode(e, e.pages))), tree);
        sections.objects = render({ label: 'Objects', cls: 'pi-sec', sub: String(count - 1), kids: () => Array.from({ length: count - 1 }, (_, k) => Object.assign(objNode(k + 1), { num: k + 1 })) }, tree);
        if (info.streams.length) {
            sections.objstm = render({ label: 'Object streams', cls: 'pi-sec', sub: `${info.streams.length}, holding ${info.inStream.size} objects`, kids: () => info.streams.map(s => objNode(s.num)) }, tree);
        }
        sections.pages.expand();
    }

    async function load() {
        try {
            info = await openDocument(getBytes());
            parsed = [];
            pdfFonts.clear();
            uses.clear();
            fontCache.clear();
            build();
            // everything each page draws, so objects can show where they are used
            for (let i = 0; i < info.doc.countPages(); i++) {
                try { parsePage(i); } catch (err) { log.warn(`page ${i + 1}:`, err.message); }
                if (i % 20 === 19) await new Promise(r => setTimeout(r));
            }
        } catch (err) {
            log.error('Inspect failed:', err);
            tree.textContent = '';
            tree.appendChild(el('div', 'pi-busy', 'Could not read the PDF: ' + err.message));
        }
    }

    // A readable copy, as qpdf's QDF mode: streams decompressed, objects one by one, indented
    async function readableCopy() {
        if (!info) info = await openDocument(getBytes());
        return new Blob([info.doc.saveToBuffer('decompress,pretty').asUint8Array().slice()], { type: 'application/pdf' });
    }

    load();
    return {
        pickAt,
        reload() { stopStepping(); return load(); },
        readableCopy,
        // the page is drawn again (turned): stepping through it is over
        pageDrawn(p) { if (stepping && stepping.page === p) { stopStepping(); detail.textContent = ''; } },
        destroy() { stopStepping(); clearHl('sel'); clearHl(); if (onClose) onClose(); },
    };
}

module.exports = { createInspector, tokenize, openDocument };
