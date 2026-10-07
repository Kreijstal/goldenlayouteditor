// --- PDF forms and their scripts ---
// pdf.js's form layer over each page (fields to fill, links to follow), and,
// when asked, the document's JavaScript run in pdf.js's sandbox (QuickJS in
// wasm): the document's and pages' open/close actions, each field's keystroke,
// format, validate and calculate scripts, buttons' actions. As Firefox does;
// the scripts reach only what Acrobat's API gives them (fields, alerts, pages)

const { createLogger } = require('./debug');
const FORMS_CSS = require('./pdf-forms-css');

const log = createLogger('PDF forms');

// The sandbox tells the page what to change through one event on window:
// sent to the viewer whose sandbox is running (when there are several, the one
// calling into it, else the one holding the field it names)
const running = new Set();
let calling = null;
function onSandboxUpdate(e) {
    const detail = e.detail || {};
    let to = calling;
    if (!to && running.size === 1) to = running.values().next().value;
    if (!to && detail.id) to = [...running].find(f => f.holds(detail.id));
    if (to) to.update(detail);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

/**
 * @param {object} o
 * @param {object} o.pdfjs  the pdf.js module
 * @param {string} o.sandboxSrc  where pdf.sandbox.mjs is
 * @param {object} o.doc  the PDFDocumentProxy
 * @param {HTMLElement} o.root  the viewer (fields are looked up inside it)
 * @param {() => object[]} o.pages  the viewer's pages ({page, wrap, deleted})
 * @param {(index: number) => void} o.goToPage  show the page (0-based)
 * @param {() => void} o.onChange  a field's value changed
 * @param {(text: string) => void} o.say  a line for the status
 */
async function createForms({ pdfjs, sandboxSrc, doc, root, pages, goToPage, onChange, say }) {
    if (!document.getElementById('pdfv-forms-style')) {
        const style = document.createElement('style');
        style.id = 'pdfv-forms-style';
        style.textContent = FORMS_CSS;
        document.head.appendChild(style);
    }
    const [hasScripts, fieldObjects] = await Promise.all([
        doc.hasJSActions().catch(() => false),
        doc.getFieldObjects().catch(() => null),
    ]);
    const storage = doc.annotationStorage;
    let changed = false;
    storage.onSetModified = () => { changed = true; onChange(); };
    storage.onResetModified = () => { changed = false; onChange(); };

    let sandbox = null, current = -1, observer = null;
    const opened = new Map(); // page index → its open actions, sent (only the first visit runs them)
    const layers = new Map(); // page → its layer div

    const send = (event) => {
        if (!sandbox) return;
        const sb = sandbox;
        setTimeout(() => {
            calling = self;
            try { sb.dispatchEvent(event); } catch (err) { log.error('Script failed:', err); } finally { calling = null; }
        }, 0);
    };

    // What links and fields need from a viewer
    const linkService = {
        eventBus: {
            dispatch(name, payload) { if (name === 'dispatcheventinsandbox') send(payload.detail); },
            _on() {}, _off() {}, on() {}, off() {},
        },
        externalLinkEnabled: true,
        isInPresentationMode: false,
        get pagesCount() { return doc.numPages; },
        get page() { return current + 1; },
        set page(n) { goToPage(n - 1); },
        rotation: 0,
        addLinkAttributes(link, url) {
            link.href = url;
            link.title = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer nofollow';
        },
        getDestinationHash() { return '#'; },
        getAnchorUrl() { return '#'; },
        setHash() {},
        async goToDestination(dest) {
            const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : await dest;
            if (!Array.isArray(explicit)) return;
            const ref = explicit[0];
            const index = ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : Number.isInteger(ref) ? ref : null;
            if (index != null) goToPage(index);
        },
        goToPage(n) { goToPage(n - 1); },
        executeNamedAction(action) { named(action); },
        executeSetOCGState() {},
    };

    function named(action) {
        const n = doc.numPages;
        const to = { FirstPage: 0, LastPage: n - 1, NextPage: Math.min(n - 1, current + 1), PrevPage: Math.max(0, current - 1) }[action];
        if (to != null) goToPage(to);
    }

    // The page's fields and links, laid over its canvas (redrawn when turned)
    async function layer(p, viewport) {
        if (!p.annots) p.annots = await p.page.getAnnotations({ intent: 'display' }).catch(() => []);
        const old = layers.get(p);
        if (!p.annots.length) { if (old) old.remove(); return; }
        const div = el('div', 'annotationLayer');
        const al = new pdfjs.AnnotationLayer({ div, page: p.page, viewport: viewport.clone({ dontFlip: true }) });
        await al.render({
            annotations: p.annots, linkService, annotationStorage: storage, renderForms: true,
            enableScripting: !!sandbox, hasJSActions: hasScripts, fieldObjects, imageResourcesPath: '', downloadManager: null,
        });
        if (old) old.replaceWith(div); else p.canvas.after(div);
        layers.set(p, div);
        fit(p);
    }

    // The layer is sized by --scale-factor: the page's shown pixels per unit
    const sizes = new ResizeObserver(entries => entries.forEach(e => {
        const p = pages().find(q => q.wrap === e.target);
        if (p) fit(p);
    }));
    function fit(p) {
        const unit = p.page.getViewport({ scale: 1, rotation: (p.page.rotate + p.extra) % 360 });
        if (p.wrap.clientWidth) p.wrap.style.setProperty('--scale-factor', String(p.wrap.clientWidth / unit.width));
        if (!p.sized) { p.sized = true; sizes.observe(p.wrap); }
    }

    // ---- Running the scripts ----
    async function start() {
        const [{ QuickJSSandbox }, calculationOrder, actions, meta, info] = await Promise.all([
            import(sandboxSrc),
            doc.getCalculationOrderIds(),
            doc.getJSActions(),
            doc.getMetadata(),
            doc.getDownloadInfo(),
        ]);
        const sb = await QuickJSSandbox();
        sb.create({
            objects: fieldObjects || {},
            calculationOrder,
            appInfo: { platform: navigator.platform, language: navigator.language },
            docInfo: {
                ...meta.info, baseURL: '', URL: '', filesize: info.length, filename: '',
                metadata: meta.metadata?.getRaw(), authors: meta.metadata?.get('dc:creator'),
                numPages: doc.numPages, actions,
            },
        });
        sandbox = sb;
        running.add(self);
        if (running.size === 1) window.addEventListener('updatefromsandbox', onSandboxUpdate);
        await redraw();
        send({ id: 'doc', name: 'Open' });
        // the page in view opens, and each page as it comes into view
        observer = new IntersectionObserver(seen, { root: root.querySelector('.pdfv-scroll'), threshold: [0, 0.25, 0.5, 0.75, 1] });
        current = -1;
        pages().forEach(p => observer.observe(p.wrap));
    }

    const shown = new Map();
    function seen(entries) {
        for (const e of entries) shown.set(e.target, e.intersectionRatio);
        let best = -1, ratio = 0;
        pages().forEach((p, i) => { const r = shown.get(p.wrap) || 0; if (r > ratio) { ratio = r; best = i; } });
        if (best >= 0 && best !== current) pageTo(best);
    }

    async function pageTo(index) {
        const was = current;
        current = index;
        if (was >= 0 && opened.has(was)) send({ id: 'page', name: 'PageClose', pageNumber: was + 1 });
        const first = !opened.has(index);
        const p = pages()[index];
        const actions = first && p ? await p.page.getJSActions().catch(() => null) : null;
        opened.set(index, true);
        send({ id: 'page', name: 'PageOpen', pageNumber: index + 1, actions });
    }

    async function stop(again = true) {
        if (!sandbox) return;
        if (current >= 0) send({ id: 'page', name: 'PageClose', pageNumber: current + 1 });
        send({ id: 'doc', name: 'WillClose' });
        const sb = sandbox;
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        sandbox = null;
        try { sb.nukeSandbox(); } catch (_) { /* gone already */ }
        running.delete(self);
        if (!running.size) window.removeEventListener('updatefromsandbox', onSandboxUpdate);
        if (observer) observer.disconnect();
        observer = null;
        opened.clear();
        shown.clear();
        current = -1;
        if (again) await redraw();
    }

    // the fields again, made with or without scripts
    async function redraw() {
        for (const p of pages()) {
            if (!layers.has(p) && !(p.annots && p.annots.length)) continue;
            await layer(p, p.page.getViewport({ scale: 1.5, rotation: (p.page.rotate + p.extra) % 360 }));
        }
    }

    // What the scripts change: a field (or its widgets), or the viewer
    const self = {
        holds: (id) => !!root.querySelector(`[data-element-id="${CSS.escape(id)}"]`),
        update(detail) {
            const { id, siblings, command, value } = detail;
            if (!id) {
                if (command === 'println') log.info('Script:', value);
                else if (command === 'error') { log.error('Script error:', value); say('Script error: ' + value); }
                else if (command === 'page-num') goToPage(value);
                else if (['FirstPage', 'LastPage', 'NextPage', 'PrevPage'].includes(command)) named(command);
                else if (command === 'print') say('The script asked to print (not done here)');
                return;
            }
            const rest = { ...detail };
            delete rest.id;
            delete rest.siblings;
            for (const one of siblings ? [id, ...siblings] : [id]) {
                const target = root.querySelector(`[data-element-id="${CSS.escape(one)}"]`);
                if (target) target.dispatchEvent(new CustomEvent('updatefromsandbox', { detail: rest }));
                else storage.setValue(one, rest);
            }
        },
    };

    return {
        hasFields: !!fieldObjects,
        hasScripts,
        layer,
        get running() { return !!sandbox; },
        get changed() { return changed; },
        async setRunning(on) { if (on && !sandbox) await start(); else if (!on && sandbox) await stop(); },
        // the file with the fields as filled in
        async bytes() {
            if (sandbox) { send({ id: 'doc', name: 'WillSave' }); await new Promise(r => setTimeout(r, 0)); }
            return doc.saveDocument();
        },
        async destroy() {
            await stop(false).catch(() => {});
            sizes.disconnect();
            storage.onSetModified = storage.onResetModified = null;
        },
    };
}

module.exports = { createForms };
