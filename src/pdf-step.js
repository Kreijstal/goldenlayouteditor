// --- Stepping through a page's drawing ---
// As PDFBug's Stepper (pdf.js's own debugger): the page's drawing operators as
// pdf.js runs them (after it has parsed the content: fonts loaded, paths
// gathered, forms and images resolved), and the page drawn up to any of them.
// pdf.js pauses its own drawing where asked (the StepperManager hook it keeps
// for PDFBug, on documents opened with pdfBug), so a step is one operator more
// of the same drawing, not the page drawn again. What each step changed is
// outlined on the page.

const ROW = 18;          // px per row in the list
const IMAGE_DIFF = 4e6;  // canvases larger than this many pixels aren't compared

// pdf.js asks for a stepper as each drawing of a document opened with pdfBug
// starts; the drawing we start gets ours, any other none
let pending = null;      // { page: PDFPageProxy, stepper }
const manager = {
    get enabled() { return !!pending; },
    create(pageIndex) {
        if (pending && pending.page._pageIndex === pageIndex) {
            const s = pending.stepper;
            pending = null;
            return s;
        }
        return { init() {}, updateOperatorList() {}, getNextBreakPoint: () => null, breakIt() {} };
    },
};
if (typeof globalThis !== 'undefined' && !globalThis.StepperManager) globalThis.StepperManager = manager;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

const fmt = (n) => Number.isInteger(n) ? String(n) : String(+n.toFixed(3));

function short(v, depth = 0) {
    if (v == null) return String(v);
    if (typeof v === 'number') return fmt(v);
    if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
    if (typeof v === 'boolean') return String(v);
    if (ArrayBuffer.isView(v)) return v.length > 8 ? `[${Array.from(v.slice(0, 6), fmt).join(' ')} … ${v.length} values]` : `[${Array.from(v, fmt).join(' ')}]`;
    if (Array.isArray(v)) {
        if (depth > 1) return `[${v.length}]`;
        return v.length > 8 ? `[${v.slice(0, 6).map(x => short(x, depth + 1)).join(' ')} … ${v.length}]` : `[${v.map(x => short(x, depth + 1)).join(' ')}]`;
    }
    if (typeof v === 'object') {
        if (typeof v.unicode === 'string') return JSON.stringify(v.unicode);
        const keys = Object.keys(v);
        return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`;
    }
    return String(v);
}

/**
 * The stepper for one page of the viewer, shown in `panel`.
 * @param {object} o
 * @param {object} o.pdfjs  the pdf.js module
 * @param {object} o.p  the viewer's page ({page, wrap, canvas, extra})
 * @param {number} o.number  the page's number, for the title
 * @param {HTMLElement} o.panel  where the list and its controls go
 */
function createStepper({ pdfjs, p, number, panel }) {
    const NAMES = [];
    for (const [name, id] of Object.entries(pdfjs.OPS)) NAMES[id] = name;
    const PATH = { moveTo: 'm', lineTo: 'l', curveTo: 'c', curveTo2: 'v', curveTo3: 'y', closePath: 'h', rectangle: 're' };
    const PATH_ARGS = { m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4 };
    const mode = pdfjs.AnnotationMode.ENABLE; // as the page is drawn: its annotations' appearances too

    // What an operator was given, in a line
    function argsText(fn, args) {
        const name = NAMES[fn];
        if (!args || !args.length) return '';
        if (name === 'showText' || name === 'showSpacedText') {
            const glyphs = args[0] || [];
            let s = '';
            for (const g of glyphs) {
                if (g == null) s += ' ';
                else if (typeof g === 'object' && typeof g.unicode === 'string') s += g.unicode;
            }
            return JSON.stringify(s.length > 80 ? s.slice(0, 80) + '…' : s) + `  (${glyphs.filter(g => g && typeof g === 'object').length} glyphs)`;
        }
        if (name === 'constructPath') {
            const [ops, coords] = args;
            const parts = [];
            let k = 0;
            for (const o of ops || []) {
                const letter = PATH[NAMES[o]] || NAMES[o];
                const n = PATH_ARGS[letter] || 0;
                parts.push([...Array.from((coords || []).slice(k, k + n), fmt), letter].join(' '));
                k += n;
                if (parts.join(' ').length > 120) { parts.push('…'); break; }
            }
            return parts.join(' ');
        }
        if (name === 'dependency') return args.join(' ');
        return args.map(a => short(a)).join(' ');
    }
    const colorOf = (fn, args) => /^set(Fill|Stroke)RGBColor$/.test(NAMES[fn]) && args && args.length === 3 ? `rgb(${args.join(',')})` : null;

    // ---- The view ----
    panel.textContent = '';
    panel.appendChild(el('h3', null, `Step through page ${number}`));
    const meta = el('div', 'pi-meta', 'Reading the operators…');
    panel.appendChild(meta);
    const bar = el('div', 'pi-tabs pi-step-bar');
    const btn = (text, title) => { const b = el('button', null, text); b.title = title; bar.appendChild(b); return b; };
    const toStart = btn('⏮', 'Nothing drawn (Home)');
    const back = btn('◀', 'One operator back (↑)');
    const fwd = btn('▶', 'One operator more (↓)');
    const cont = btn('⏩', 'On to the next breakpoint (F8)');
    const toEnd = btn('⏭', 'All drawn (End)');
    const where = el('span', 'pi-step-at');
    bar.appendChild(where);
    panel.appendChild(bar);
    const list = el('div', 'pi-steps');
    list.tabIndex = 0;
    const sizer = el('div');
    list.appendChild(sizer);
    panel.appendChild(list);
    panel.appendChild(el('div', 'pi-meta', 'Click an operator to draw the page up to it; click its dot for a breakpoint.'));
    const info = el('pre', 'pi-step-info');
    panel.appendChild(info);

    // ---- The drawing ----
    const unit = p.page.getViewport({ scale: 1, rotation: (p.page.rotate + p.extra) % 360 });
    const viewport = p.page.getViewport({ scale: p.canvas.width / unit.width, rotation: (p.page.rotate + p.extra) % 360 });
    const canvas = el('canvas', 'pi-step-canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    p.canvas.after(canvas);
    p.wrap.classList.add('pi-stepping');
    const changedBox = el('div', 'pi-step-hl');
    changedBox.hidden = true;
    p.wrap.appendChild(changedBox);

    let ops = null;            // { fnArray, argsArray }
    let total = 0;
    let at = 0;                // operators drawn
    let task = null, stepper = null, resume = null, done = false;
    let gone = false;
    const breaks = new Set();
    // the drawing stops: at a breakpoint, at the end, or failing
    const stopped = () => new Promise(r => { stepper.onStop = r; });

    function draw(target) {
        if (task) task.cancel();
        resume = null;
        done = false;
        at = 0;
        const me = stepper = {
            nextBreakPoint: target,
            onStop: null,
            init() {}, updateOperatorList() {},
            getNextBreakPoint: () => me.nextBreakPoint,
            breakIt(i, go) { if (stepper !== me) return; at = i; resume = go; me.onStop(); },
        };
        const wait = stopped();
        pending = { page: p.page, stepper: me };
        const t = task = p.page.render({ canvasContext: ctx, viewport, annotationMode: mode });
        t.promise.then(() => {
            if (task !== t) return;
            done = true;
            at = total;
            me.onStop();
        }, (err) => {
            if (task !== t || (err && err.name === 'RenderingCancelledException')) return;
            meta.textContent = 'Drawing failed: ' + err.message;
            done = true;
            me.onStop();
        });
        return wait;
    }

    let busy = Promise.resolve();
    let want = null;
    // Draw up to `n` operators: on from where it stopped, or again from the
    // start to go back (in order; the latest asked wins)
    function goTo(n) {
        want = Math.max(0, Math.min(total, n));
        busy = busy.then(async () => {
            if (gone || want == null) return;
            const n = want;
            want = null;
            if (n === at && task) return;
            const before = snapshot();
            if (!task || n < at || done || !resume) await draw(n);
            else {
                stepper.nextBreakPoint = n;
                const go = resume, wait = stopped();
                resume = null;
                go();
                await wait;
            }
            if (gone) return;
            outline(before);
            show();
        }).catch(() => {});
        return busy;
    }

    function snapshot() {
        if (canvas.width * canvas.height > IMAGE_DIFF || !task) return null;
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    // What the step changed, outlined
    function outline(before) {
        changedBox.hidden = true;
        if (!before) return;
        const now = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const w = canvas.width;
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        const a = new Uint32Array(before.buffer), b = new Uint32Array(now.buffer);
        for (let i = 0; i < a.length; i++) {
            if (a[i] === b[i]) continue;
            const x = i % w, y = (i - x) / w;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
        if (x1 < 0) return;
        changedBox.style.left = (100 * x0 / w) + '%';
        changedBox.style.top = (100 * y0 / canvas.height) + '%';
        changedBox.style.width = `max(${100 * (x1 - x0 + 1) / w}%, 3px)`;
        changedBox.style.height = `max(${100 * (y1 - y0 + 1) / canvas.height}%, 3px)`;
        changedBox.hidden = false;
    }

    // ---- The list (only the rows in sight are made) ----
    let shownKey = '';
    function rows(force) {
        if (!ops) return;
        const top = list.scrollTop, h = list.clientHeight || 300;
        const first = Math.max(0, Math.floor(top / ROW) - 20), last = Math.min(total, Math.ceil((top + h) / ROW) + 20);
        // the rows in sight are there already (keep them: one may be under the mouse)
        const key = `${Math.floor(first / 10)},${at}`;
        if (!force && key === shownKey) return;
        shownKey = key;
        list.querySelectorAll('.pi-step-row').forEach(r => r.remove());
        for (let i = first; i < last; i++) {
            const fn = ops.fnArray[i], args = ops.argsArray[i];
            const r = el('div', 'pi-step-row' + (i === at - 1 ? ' sel' : '') + (i >= at ? ' todo' : ''));
            r.style.top = (i * ROW) + 'px';
            r.dataset.i = i;
            const dot = el('span', 'pi-step-dot' + (breaks.has(i) ? ' on' : ''), breaks.has(i) ? '●' : '○');
            dot.title = 'Breakpoint: stop before this operator';
            dot.dataset.dot = '1';
            r.appendChild(dot);
            r.appendChild(el('span', 'pi-step-num', String(i)));
            r.appendChild(el('span', 'pi-step-next', i === at ? '▸' : ''));
            r.appendChild(el('span', 'pi-op', NAMES[fn] || String(fn)));
            const c = colorOf(fn, args);
            if (c) { const sw = el('span', 'pi-step-sw'); sw.style.background = c; r.appendChild(sw); }
            r.appendChild(el('span', 'pi-sub', argsText(fn, args)));
            list.appendChild(r);
        }
    }
    list.onscroll = () => rows();
    list.onclick = (e) => {
        const r = e.target.closest('.pi-step-row');
        if (!r) return;
        const i = +r.dataset.i;
        if (e.target.dataset.dot) { breaks.has(i) ? breaks.delete(i) : breaks.add(i); rows(true); return; }
        goTo(i + 1);
    };
    function reveal() {
        const y = Math.max(0, at - 1) * ROW;
        if (y < list.scrollTop || y + ROW > list.scrollTop + list.clientHeight) list.scrollTop = y - list.clientHeight / 2;
    }
    function show() {
        where.textContent = `${at} / ${total} drawn`;
        back.disabled = toStart.disabled = at === 0;
        fwd.disabled = toEnd.disabled = at >= total;
        cont.disabled = at >= total;
        reveal();
        rows(true);
        const i = at - 1;
        if (i < 0) { info.textContent = 'Nothing drawn yet.'; return; }
        const fn = ops.fnArray[i], args = ops.argsArray[i];
        let text = `#${i} ${NAMES[fn] || fn}\n`;
        (args || []).forEach((a, k) => { text += `  [${k}] ${short(a)}\n`; });
        const line = argsText(fn, args);
        if (line) text += `\n${line}`;
        if (NAMES[fn] === 'dependency') text += '\n(waits for these fonts or images to be ready)';
        info.textContent = text;
    }
    const next = () => {
        for (let i = at + 1; i < total; i++) if (breaks.has(i)) return i;
        return total;
    };
    toStart.onclick = () => goTo(0);
    back.onclick = () => goTo(at - 1);
    fwd.onclick = () => goTo(at + 1);
    cont.onclick = () => goTo(next());
    toEnd.onclick = () => goTo(total);
    list.onkeydown = (e) => {
        const k = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: total, PageDown: at + 20, PageUp: at - 20, F8: next() }[e.key];
        if (k == null) return;
        e.preventDefault();
        goTo(k);
    };

    (async () => {
        try {
            ops = await p.page.getOperatorList({ annotationMode: mode });
        } catch (err) {
            meta.textContent = 'Could not read the operators: ' + err.message;
            return;
        }
        if (gone) return;
        total = ops.fnArray.length;
        sizer.style.height = (total * ROW) + 'px';
        meta.textContent = `${total} operators, as pdf.js draws them (fonts, images and forms already resolved; paths gathered into constructPath).`;
        await goTo(0);
        list.focus({ preventScroll: true });
    })();

    return {
        page: p,
        goTo,
        get at() { return at; },
        get total() { return total; },
        destroy() {
            gone = true;
            if (pending && pending.stepper === stepper) pending = null;
            if (task) task.cancel();
            canvas.remove();
            changedBox.remove();
            p.wrap.classList.remove('pi-stepping');
        },
    };
}

const STEP_STYLE = `
.pi-step-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;box-shadow:0 2px 8px rgba(0,0,0,.3);background:#fff;}
.pi-stepping .annotationLayer,.pi-stepping .pdfv-media,.pi-stepping .pdfv-exec{visibility:hidden;}
.pi-step-hl{position:absolute;pointer-events:none;border:2px solid #3ddc84;background:rgba(61,220,132,.15);box-sizing:border-box;z-index:1;}
.pi-step-bar{align-items:center;position:sticky;top:-8px;background:#1e1f21;z-index:1;padding:4px 0;margin:4px 0!important;}
.pi-step-at{color:#8a9199;font-family:sans-serif;margin-left:6px;}
.pi-steps{position:relative;height:max(140px,28vh);overflow:auto;background:#151617;border-radius:3px;outline:none;margin:4px 0;}
.pi-steps:focus{box-shadow:0 0 0 1px #4a9eff;}
.pi-steps>div:first-child{width:1px;}
.pi-step-row{position:absolute;left:0;right:0;height:${ROW}px;line-height:${ROW}px;display:flex;gap:6px;padding:0 6px 0 2px;white-space:nowrap;cursor:pointer;}
.pi-step-row:hover{background:#2c3138;}
.pi-step-row.sel{background:#264f78;}
.pi-step-row.todo{opacity:.6;}
.pi-step-dot{color:#555;width:12px;text-align:center;flex:none;}
.pi-step-dot.on{color:#f14c4c;}
.pi-step-num{color:#6a7179;min-width:4ch;text-align:right;flex:none;}
.pi-step-next{color:#3ddc84;width:8px;flex:none;}
.pi-step-sw{display:inline-block;width:10px;height:10px;align-self:center;border:1px solid #888;flex:none;}
.pi-step-info{max-height:22vh;overflow:auto;}
`;

module.exports = { createStepper, STEP_STYLE };
