// --- DjVu reader ---
// The pages one under another, drawn as they come into view by djvu-rs
// (WebAssembly, in a worker of its own so a large scan doesn't stop the page),
// at the resolution the zoom needs. Over each page its hidden text (the OCR
// layer, to select and copy) and its links; the outline beside; search in the
// text. The structure (pages, outline, links) is read by djvu-format.js.

const { readDjvu, resolveLink } = require('./djvu-format');
const { createLogger } = require('./debug');

const log = createLogger('DjVu');
const DJVU_RS = 'https://cdn.jsdelivr.net/npm/djvu-rs@0.41.0/djvu_rs.js';
const CSS_DPI = 96;
const MAX_ZOOM = 8, MIN_ZOOM = 0.1;
const MAX_PIXELS = 40e6; // a page drawn larger than this is drawn smaller

const WORKER = `
import init, * as djvu from ${JSON.stringify(DJVU_RS)};
let doc = null;
const reply = (id, value, error, transfer) => postMessage({ id, value, error }, transfer || []);
onmessage = async (e) => {
    const m = e.data;
    let page = null;
    try {
        if (m.type === 'open') {
            await init();
            doc = djvu.WasmDocument.from_bytes(m.bytes);
            return reply(m.id, { pages: doc.page_count() });
        }
        page = doc.page(m.page);
        if (m.type === 'render') {
            // drawn at the scan's own resolution and made smaller here: djvu-rs
            // 0.41 draws a bilevel layer smaller than that a few percent too tall
            const own = page.dpi(), dpi = Math.min(m.dpi, own);
            const W = page.width_at(own), H = page.height_at(own);
            const w = page.width_at(dpi), h = page.height_at(dpi);
            const full = new ImageData(page.render(own), W, H);
            const bitmap = await createImageBitmap(full, w === W && h === H ? {} : { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
            return reply(m.id, { bitmap, w, h }, null, [bitmap]);
        }
        if (m.type === 'zones') {
            const json = page.text_zones_json(m.dpi);
            return reply(m.id, json ? JSON.parse(json) : null);
        }
        throw new Error('unknown request ' + m.type);
    } catch (err) {
        reply(m.id, null, String((err && err.message) || err));
    } finally {
        if (page) page.free();
    }
};
postMessage({ ready: true });
`;

const STYLE = `
.djv{display:flex;flex-direction:column;height:100%;overflow:hidden;background:#525659;}
.djv-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 10px;background:#323639;color:#ddd;font:13px sans-serif;border-bottom:1px solid #222;}
.djv-bar button{background:#4a4e52;color:#eee;border:1px solid #5c6064;border-radius:4px;padding:3px 9px;font:13px sans-serif;cursor:pointer;}
.djv-bar button:hover:not(:disabled){background:#5c6064;}
.djv-bar button:disabled{opacity:.45;cursor:default;}
.djv-bar button.on{background:#264f78;border-color:#4a9eff;}
.djv-bar input{background:#1e1f21;color:#eee;border:1px solid #5c6064;border-radius:4px;padding:3px 6px;font:13px sans-serif;}
.djv-num{width:4em;text-align:right;}
.djv-find{width:12em;}
.djv-sep{width:1px;height:18px;background:#5c6064;margin:0 2px;}
.djv-zoom{min-width:3.5em;text-align:center;}
.djv-status{margin-left:auto;color:#bbb;}
.djv-status.error{color:#f88;}
.djv-body{flex:1;min-height:0;display:flex;}
.djv-side{flex:0 0 260px;max-width:45%;overflow:auto;background:#2b2d30;color:#ddd;font:13px sans-serif;padding:6px 0;border-right:1px solid #222;}
.djv-side[hidden]{display:none;}
.djv-item{display:flex;align-items:baseline;gap:4px;padding:2px 8px 2px 0;cursor:pointer;}
.djv-item:hover{background:#3a3d41;}
.djv-item.cur{background:#264f78;}
.djv-tw{flex:none;width:14px;text-align:center;color:#999;}
.djv-kids{padding-left:12px;}
.djv-kids[hidden]{display:none;}
.djv-scroll{flex:1;min-width:0;overflow:auto;position:relative;}
.djv-pages{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;width:max-content;min-width:100%;box-sizing:border-box;}
.djv-page{position:relative;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35);flex:none;}
.djv-page canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
.djv-page .djv-wait{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#999;font:13px sans-serif;}
.djv-text{position:absolute;inset:0;overflow:hidden;line-height:1;z-index:1;}
.djv-text>span{position:absolute;color:transparent;white-space:pre;transform-origin:0 0;font-family:sans-serif;cursor:text;}
.djv-text span::selection{background:rgba(0,90,255,.3);color:transparent;}
.djv-gap{display:inline-block;width:0;}
.djv-link{position:absolute;cursor:pointer;z-index:2;}
.djv-link:hover{background:rgba(74,158,255,.18);outline:1px solid rgba(74,158,255,.6);}
.djv-hit{position:absolute;background:rgba(255,210,0,.35);pointer-events:none;z-index:3;}
.djv-hit.cur{background:rgba(255,120,0,.45);outline:2px solid #f60;}
.djv-msg{padding:24px;color:#eee;font:14px sans-serif;}
`;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// The decoder, in its worker; requests one at a time, the newest first
function startDecoder() {
    const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    URL.revokeObjectURL(url);
    let next = 0, busy = null;
    const waiting = new Map(), queue = [];
    let ready;
    const readyP = new Promise((res, rej) => {
        ready = res;
        worker.onerror = (e) => rej(new Error(e.message || 'the DjVu decoder did not start'));
    });
    worker.onmessage = (e) => {
        const m = e.data;
        if (m.ready) return ready();
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        busy = null;
        if (w) m.error ? w.rej(new Error(m.error)) : w.res(m.value);
        pump();
    };
    function pump() {
        if (busy || !queue.length) return;
        const job = queue.pop(); // the latest asked: what is in view now
        if (job.cancelled) { job.rej(Object.assign(new Error('cancelled'), { cancelled: true })); return pump(); }
        busy = job;
        waiting.set(job.msg.id, job);
        worker.postMessage(job.msg, job.transfer || []);
    }
    return {
        ready: readyP,
        ask(msg, transfer) {
            const job = { msg: { ...msg, id: ++next }, transfer };
            const p = new Promise((res, rej) => { job.res = res; job.rej = rej; });
            p.job = job;
            queue.push(job);
            readyP.then(pump, (err) => job.rej(err));
            return p;
        },
        cancel(p) { if (p && p.job && p.job !== busy) p.job.cancelled = true; },
        destroy() { worker.terminate(); queue.forEach(j => j.rej(new Error('closed'))); },
    };
}

/**
 * Show a DjVu document in `host`.
 * @param {HTMLElement} host
 * @param {{bytes: Uint8Array, name?: string}} o
 */
async function mountDjvuViewer(host, { bytes, name }) {
    if (!document.getElementById('djv-style')) {
        const style = el('style');
        style.id = 'djv-style';
        style.textContent = STYLE;
        document.head.appendChild(style);
    }
    const root = el('div', 'djv');
    host.appendChild(root);
    const bar = el('div', 'djv-bar');
    const btn = (label, title) => { const b = el('button', null, label); b.title = title; bar.appendChild(b); return b; };
    const sep = () => bar.appendChild(el('span', 'djv-sep'));
    const outlineBtn = btn('☰', 'Contents');
    outlineBtn.hidden = true;
    const prevBtn = btn('◀', 'Previous page');
    const num = el('input', 'djv-num');
    num.title = 'Page (Enter to go)';
    bar.appendChild(num);
    const of = el('span', null, '');
    bar.appendChild(of);
    const nextBtn = btn('▶', 'Next page');
    sep();
    const outBtn = btn('−', 'Zoom out');
    const zoomText = el('span', 'djv-zoom', '');
    bar.appendChild(zoomText);
    const inBtn = btn('+', 'Zoom in');
    const widthBtn = btn('Fit width', 'The page as wide as the view');
    const pageBtn = btn('Fit page', 'The whole page in view');
    const realBtn = btn('1:1', 'Actual size (by the page\'s resolution)');
    sep();
    const find = el('input', 'djv-find');
    find.placeholder = 'Find in text';
    find.title = 'Find in the pages\' text (Enter: next, Shift+Enter: previous)';
    bar.appendChild(find);
    const findPrev = btn('↑', 'Previous match');
    const findNext = btn('↓', 'Next match');
    const findInfo = el('span', null, '');
    bar.appendChild(findInfo);
    const status = el('span', 'djv-status', 'Opening…');
    bar.appendChild(status);
    const body = el('div', 'djv-body');
    const side = el('div', 'djv-side');
    side.hidden = true;
    const scroller = el('div', 'djv-scroll');
    const pagesEl = el('div', 'djv-pages');
    scroller.appendChild(pagesEl);
    body.append(side, scroller);
    root.append(bar, body);
    const say = (text, error) => { status.textContent = text; status.classList.toggle('error', !!error); };
    const fail = (text) => { say(text, true); scroller.textContent = ''; scroller.appendChild(el('div', 'djv-msg', text)); };

    let doc;
    try {
        doc = readDjvu(bytes);
    } catch (err) {
        fail('Could not read ' + (name || 'the file') + ': ' + err.message);
        return { info: { error: err.message }, destroy() { root.remove(); } };
    }
    if (doc.indirect) {
        fail(`This is an indirect DjVu document: its ${doc.files.filter(f => f.kind === 1).length} pages are separate files beside it. Open a bundled copy (djvm -c).`);
        return { info: { error: 'indirect' }, destroy() { root.remove(); } };
    }

    const decoder = startDecoder();
    let gone = false;
    try {
        const r = await decoder.ask({ type: 'open', bytes: bytes.slice() });
        if (r.pages !== doc.pages.length) log.warn(`pages: ${r.pages} decoded, ${doc.pages.length} in the directory`);
    } catch (err) {
        decoder.destroy();
        fail('Could not open the document: ' + err.message);
        return { info: { error: err.message }, destroy() { root.remove(); } };
    }

    // ---- The pages ----
    const dpr = () => window.devicePixelRatio || 1;
    let zoom = 1, fit = 'width';
    const pages = doc.pages.map((info, i) => {
        const wrap = el('div', 'djv-page');
        wrap.dataset.page = i + 1;
        wrap.appendChild(el('div', 'djv-wait', String(i + 1)));
        pagesEl.appendChild(wrap);
        return { i, info, wrap, canvas: null, dpi: 0, task: null, zones: undefined, textEl: null, shown: false };
    });
    // a page's size on screen at zoom 1: its size in inches, at the screen's 96 per inch
    const inches = (p) => [p.info.width / p.info.dpi, p.info.height / p.info.dpi];
    function layout() {
        for (const p of pages) {
            const [w, h] = inches(p);
            p.cssW = Math.max(1, Math.round(w * CSS_DPI * zoom));
            p.cssH = Math.max(1, Math.round(h * CSS_DPI * zoom));
            p.wrap.style.width = p.cssW + 'px';
            p.wrap.style.height = p.cssH + 'px';
            p.wrap.style.setProperty('--s', String(p.cssW / p.info.width));
        }
        zoomText.textContent = Math.round(zoom * 100) + '%';
    }
    function fitZoom() {
        const availW = scroller.clientWidth - 32 - 2, availH = scroller.clientHeight - 32;
        if (availW <= 0) return zoom;
        const cur = pages[current()] || pages[0];
        const [w, h] = inches(cur);
        if (fit === 'width') return Math.min(MAX_ZOOM, availW / (w * CSS_DPI));
        if (fit === 'page') return Math.min(MAX_ZOOM, availW / (w * CSS_DPI), availH / (h * CSS_DPI));
        return zoom;
    }
    function setZoom(z, keep = true) {
        z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
        // keep the same point of the same page in view
        const at = keep ? anchor() : null;
        zoom = z;
        layout();
        if (at) restore(at);
        widthBtn.classList.toggle('on', fit === 'width');
        pageBtn.classList.toggle('on', fit === 'page');
        redrawSoon();
    }
    function anchor() {
        const i = current();
        const p = pages[i];
        if (!p) return null;
        return { i, f: (scroller.scrollTop - (p.wrap.offsetTop - 16)) / p.wrap.offsetHeight };
    }
    function restore({ i, f }) {
        const p = pages[i];
        scroller.scrollTop = p.wrap.offsetTop - 16 + f * p.wrap.offsetHeight;
    }

    // the page most in view
    function current() {
        const top = scroller.scrollTop, mid = top + scroller.clientHeight / 3;
        let lo = 0, hi = pages.length - 1;
        while (lo < hi) {
            const m = (lo + hi + 1) >> 1;
            if (pages[m].wrap.offsetTop <= mid) lo = m; else hi = m - 1;
        }
        return lo;
    }
    function goTo(i, frac = 0) {
        const p = pages[Math.max(0, Math.min(pages.length - 1, i))];
        scroller.scrollTop = p.wrap.offsetTop - 16 + frac * p.wrap.offsetHeight;
        showNum();
    }
    function showNum() {
        const i = current();
        if (document.activeElement !== num) num.value = String(i + 1);
        prevBtn.disabled = i <= 0;
        nextBtn.disabled = i >= pages.length - 1;
        markOutline(i);
    }

    // ---- Drawing, as pages come into view ----
    const seen = new IntersectionObserver((entries) => {
        for (const e of entries) {
            const p = pages[+e.target.dataset.page - 1];
            p.shown = e.isIntersecting;
            if (p.shown) draw(p);
            else drop(p);
        }
    }, { root: scroller, rootMargin: '100% 0px' });
    pages.forEach(p => seen.observe(p.wrap));

    const wantDpi = (p) => {
        let dpi = p.info.dpi * Math.min(1, (p.cssW * dpr()) / p.info.width);
        const px = (p.info.width * dpi / p.info.dpi) * (p.info.height * dpi / p.info.dpi);
        if (px > MAX_PIXELS) dpi *= Math.sqrt(MAX_PIXELS / px);
        return Math.max(1, Math.round(dpi));
    };
    async function draw(p) {
        const dpi = wantDpi(p);
        // drawn well enough already (or on its way)
        if (p.dpi && p.dpi >= dpi * 0.9 && p.dpi <= dpi * 2.2) return;
        if (p.task && p.task.dpi === dpi) return;
        if (p.task) decoder.cancel(p.task);
        const task = p.task = decoder.ask({ type: 'render', page: p.i, dpi });
        task.dpi = dpi;
        let r;
        try {
            r = await task;
        } catch (err) {
            if (p.task === task) p.task = null;
            if (!err.cancelled && !gone) {
                log.error(`Page ${p.i + 1}:`, err);
                const w = p.wrap.querySelector('.djv-wait');
                if (w) w.textContent = `Page ${p.i + 1} could not be drawn: ${err.message}`;
            }
            return;
        }
        if (p.task !== task || gone) { r.bitmap.close(); return; }
        p.task = null;
        if (!p.shown) { r.bitmap.close(); return; }
        const canvas = el('canvas');
        canvas.width = r.w;
        canvas.height = r.h;
        canvas.getContext('2d').drawImage(r.bitmap, 0, 0);
        r.bitmap.close();
        if (p.canvas) p.canvas.replaceWith(canvas); else p.wrap.prepend(canvas);
        p.canvas = canvas;
        p.dpi = dpi;
        const w = p.wrap.querySelector('.djv-wait');
        if (w) w.remove();
        textLayer(p);
        linkLayer(p);
    }
    function drop(p) {
        if (p.task) { decoder.cancel(p.task); p.task = null; }
        if (!p.canvas) return;
        p.canvas.width = p.canvas.height = 0;
        p.canvas.remove();
        p.canvas = null;
        p.dpi = 0;
        if (!p.wrap.querySelector('.djv-wait')) p.wrap.prepend(el('div', 'djv-wait', String(p.i + 1)));
    }
    let redrawTimer = null;
    function redrawSoon() {
        clearTimeout(redrawTimer);
        redrawTimer = setTimeout(() => pages.forEach(p => { if (p.shown) draw(p); }), 150);
    }

    // ---- Text, to select and copy (and to search) ----
    function zonesOf(p) {
        if (p.zones === undefined) {
            p.zones = decoder.ask({ type: 'zones', page: p.i, dpi: p.info.dpi })
                .then(z => (p.zones = z || null), (err) => { log.warn(`text of page ${p.i + 1}:`, err.message); return (p.zones = null); });
        }
        return Promise.resolve(p.zones);
    }
    const measure = document.createElement('canvas').getContext('2d');
    async function textLayer(p) {
        if (p.textEl) return;
        const zones = await zonesOf(p);
        if (!zones || !zones.length || p.textEl || gone) return;
        const layer = el('div', 'djv-text');
        zones.forEach((z, k) => {
            if (!z.t) return;
            const s = el('span');
            const next = zones[k + 1];
            // a space after a word, a new line after a line's last
            const brk = !next ? '' : (next.y > z.y + z.h * 0.6 || next.x + next.w <= z.x) ? '\n' : ' ';
            s.textContent = z.t;
            // the space or line break: copied with the word, taking no room on the page
            if (brk) s.appendChild(el('span', 'djv-gap', brk));
            const h = z.h * 0.88;
            s.style.left = z.x + 'px';
            s.style.top = z.y + 'px';
            s.style.fontSize = h + 'px';
            measure.font = `${h}px sans-serif`;
            const tw = measure.measureText(z.t).width;
            if (tw > 0) s.style.transform = `scaleX(${z.w / tw})`;
            layer.appendChild(s);
        });
        // in the page's pixels, scaled to the page as shown
        layer.style.width = p.info.width + 'px';
        layer.style.height = p.info.height + 'px';
        layer.style.inset = 'auto';
        layer.style.left = layer.style.top = '0';
        layer.style.transformOrigin = '0 0';
        layer.style.transform = 'scale(var(--s))';
        p.wrap.appendChild(layer);
        p.textEl = layer;
        if (hits.length) showHits(p);
    }

    // ---- Links ----
    function linkLayer(p) {
        if (p.linksDone) return;
        p.linksDone = true;
        const { width: W, height: H } = p.info;
        for (const l of p.info.links) {
            const to = resolveLink(l.href, doc, p.i);
            if (!to) continue;
            const a = el('a', 'djv-link');
            const [x0, y0, x1, y1] = l.box;
            Object.assign(a.style, { left: (100 * x0 / W) + '%', top: (100 * y0 / H) + '%', width: (100 * (x1 - x0) / W) + '%', height: (100 * (y1 - y0) / H) + '%' });
            a.title = l.comment || (to.url ? to.url : `Page ${to.page + 1}`);
            if (to.url) { a.href = to.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
            else { a.href = '#'; a.onclick = (e) => { e.preventDefault(); goTo(to.page); }; }
            p.wrap.appendChild(a);
        }
    }

    // ---- Outline ----
    const outlineItems = [];
    if (doc.outline.length) {
        outlineBtn.hidden = false;
        const tree = (list, parent, depth) => {
            for (const b of list) {
                const item = el('div', 'djv-item');
                item.style.paddingLeft = (4 + depth * 0) + 'px';
                const tw = el('span', 'djv-tw', b.kids.length ? '▸' : '');
                item.append(tw, el('span', null, b.title || b.url));
                parent.appendChild(item);
                let kids = null;
                if (b.kids.length) {
                    kids = el('div', 'djv-kids');
                    kids.hidden = true;
                    tree(b.kids, kids, depth + 1);
                    parent.appendChild(kids);
                }
                const to = resolveLink(b.url, doc, 0);
                if (to && to.page != null) outlineItems.push({ page: to.page, item });
                item.onclick = (e) => {
                    if (kids && (e.target === tw || !to)) { kids.hidden = !kids.hidden; tw.textContent = kids.hidden ? '▸' : '▾'; return; }
                    if (kids && kids.hidden) { kids.hidden = false; tw.textContent = '▾'; }
                    if (to && to.page != null) goTo(to.page);
                    else if (to && to.url) window.open(to.url, '_blank', 'noopener');
                };
            }
        };
        tree(doc.outline.length === 1 && !doc.outline[0].url && doc.outline[0].kids.length ? doc.outline[0].kids : doc.outline, side, 0);
        side.hidden = false;
        outlineBtn.classList.add('on');
    }
    let marked = null;
    function markOutline(i) {
        let best = null;
        for (const o of outlineItems) if (o.page <= i && (!best || o.page >= best.page)) best = o;
        if (marked === best) return;
        if (marked) marked.item.classList.remove('cur');
        marked = best;
        if (best) best.item.classList.add('cur');
    }
    outlineBtn.onclick = () => {
        side.hidden = !side.hidden;
        outlineBtn.classList.toggle('on', !side.hidden);
        if (fit !== 'free') setZoom(fitZoom());
    };

    // ---- Search ----
    let hits = [], hitAt = -1, searched = '', searching = 0;
    async function search(q) {
        const run = ++searching;
        hits = [];
        hitAt = -1;
        pages.forEach(p => p.wrap.querySelectorAll('.djv-hit').forEach(h => h.remove()));
        searched = q;
        if (!q) { findInfo.textContent = ''; return; }
        const needle = q.toLowerCase().replace(/\s+/g, ' ');
        let anyText = false;
        for (const p of pages) {
            if (run !== searching || gone) return;
            if (p.i % 10 === 0) findInfo.textContent = `Page ${p.i + 1}…`;
            const zones = await zonesOf(p);
            if (!zones || !zones.length) continue;
            anyText = true;
            // the zones' text in a row, each zone's place in it
            let all = '';
            const at = [];
            zones.forEach(z => { at.push(all.length); all += (z.t || '').toLowerCase() + ' '; });
            for (let k = all.indexOf(needle); k >= 0; k = all.indexOf(needle, k + 1)) {
                const end = k + needle.length;
                const boxes = [];
                zones.forEach((z, j) => { if (at[j] < end && at[j] + (z.t || '').length > k) boxes.push(z); });
                hits.push({ page: p.i, boxes });
            }
        }
        if (run !== searching) return;
        findInfo.textContent = !anyText ? 'No text in this document' : hits.length ? `${hits.length} found` : 'Not found';
        pages.forEach(showHits);
        if (hits.length) {
            const from = current();
            const k = hits.findIndex(h => h.page >= from);
            goHit(k >= 0 ? k : 0);
        }
    }
    function showHits(p) {
        p.wrap.querySelectorAll('.djv-hit').forEach(h => h.remove());
        const { width: W, height: H } = p.info;
        hits.forEach((h, k) => {
            if (h.page !== p.i) return;
            for (const z of h.boxes) {
                const d = el('div', 'djv-hit' + (k === hitAt ? ' cur' : ''));
                Object.assign(d.style, { left: (100 * z.x / W) + '%', top: (100 * z.y / H) + '%', width: (100 * z.w / W) + '%', height: (100 * z.h / H) + '%' });
                p.wrap.appendChild(d);
            }
        });
    }
    function goHit(k) {
        if (!hits.length) return;
        const was = hits[hitAt];
        hitAt = (k + hits.length) % hits.length;
        const h = hits[hitAt];
        if (was && was.page !== h.page) showHits(pages[was.page]);
        showHits(pages[h.page]);
        const z = h.boxes[0];
        const p = pages[h.page];
        if (z) {
            const y = p.wrap.offsetTop + (z.y / p.info.height) * p.cssH;
            if (y < scroller.scrollTop + 20 || y > scroller.scrollTop + scroller.clientHeight - 40) scroller.scrollTop = y - scroller.clientHeight / 3;
            const x = p.wrap.offsetLeft + (z.x / p.info.width) * p.cssW;
            if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = x - 40;
        } else goTo(h.page);
        findInfo.textContent = `${hitAt + 1} of ${hits.length}`;
        showNum();
    }
    find.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const q = find.value.trim();
        if (q !== searched) search(q);
        else goHit(hitAt + (e.shiftKey ? -1 : 1));
    };
    findNext.onclick = () => { if (find.value.trim() !== searched) search(find.value.trim()); else goHit(hitAt + 1); };
    findPrev.onclick = () => { if (find.value.trim() !== searched) search(find.value.trim()); else goHit(hitAt - 1); };

    // ---- Controls ----
    prevBtn.onclick = () => goTo(current() - 1);
    nextBtn.onclick = () => goTo(current() + 1);
    num.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const n = parseInt(num.value, 10);
        if (n >= 1) goTo(Math.min(n, pages.length) - 1);
        num.blur();
    };
    num.onblur = showNum;
    outBtn.onclick = () => { fit = 'free'; setZoom(zoom / 1.25); };
    inBtn.onclick = () => { fit = 'free'; setZoom(zoom * 1.25); };
    widthBtn.onclick = () => { fit = 'width'; setZoom(fitZoom()); };
    pageBtn.onclick = () => { fit = 'page'; setZoom(fitZoom()); };
    realBtn.onclick = () => { fit = 'free'; setZoom(1); };
    scroller.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        fit = 'free';
        setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    scroller.addEventListener('scroll', showNum, { passive: true });
    const resized = new ResizeObserver(() => { if (fit !== 'free') setZoom(fitZoom()); });
    resized.observe(scroller);

    of.textContent = `/ ${pages.length}`;
    zoom = fitZoom();
    setZoom(zoom, false);
    showNum();
    const dpis = [...new Set(doc.pages.map(p => p.dpi))];
    say(`${pages.length} page${pages.length === 1 ? '' : 's'} · ${dpis.length === 1 ? dpis[0] + ' dpi' : 'mixed dpi'}${doc.outline.length ? ' · contents' : ''}`);
    log.log(`Opened ${name || 'a DjVu file'}: ${pages.length} pages`);

    return {
        info: { pages: pages.length, outline: doc.outline.length > 0 },
        goTo,
        destroy() {
            gone = true;
            seen.disconnect();
            resized.disconnect();
            clearTimeout(redrawTimer);
            decoder.destroy();
            pages.forEach(drop);
            root.remove();
        },
    };
}

module.exports = { mountDjvuViewer };
