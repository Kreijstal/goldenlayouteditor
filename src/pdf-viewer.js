// --- PDF viewer ---
// pdf.js draws the pages. Pages can be turned (one, or all of them) or deleted,
// and the PDF saved with that written into it (pdf-lib sets each page's /Rotate
// and drops the deleted ones, the content is untouched), over the file or as a
// new one beside it. Selected pages can be exported, as they are shown: one page
// as an image (PNG, JPEG, WebP), SVG (mupdf), text or a PDF of its own; several
// as a PDF, a zip of images or text. Saving goes through /upload-file, so it
// lands wherever the file is: the server, the browser's storage, a folder from
// this computer, the shell's files. Inside an archive nothing is saved over;
// exports are downloaded instead. Inspect opens the file's structure beside
// the pages (src/pdf-inspect.js).
const { createLogger } = require('./debug');
const { insideArchive } = require('./browse-mode');
const { createInspector } = require('./pdf-inspect');
const { playFlash } = require('./pdf-flash');
const { createForms } = require('./pdf-forms');

const log = createLogger('PDF');
const PDFJS = 'https://esm.sh/pdfjs-dist@4.9.155/build/';
const PDF_LIB = 'https://esm.sh/pdf-lib@1.17.1';
const JSZIP = 'https://esm.sh/jszip@3.10.1';
// jsDelivr, not esm.sh: it finds its .wasm beside itself (import.meta.url)
const MUPDF = 'https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js';
const SCALE = 1.5;
const MAX_SIDE = 16384; // a canvas larger than this stays blank

const FORMATS = {
    png: { label: 'PNG image', ext: 'png', mime: 'image/png', raster: true },
    jpeg: { label: 'JPEG image', ext: 'jpg', mime: 'image/jpeg', raster: true },
    webp: { label: 'WebP image', ext: 'webp', mime: 'image/webp', raster: true },
    svg: { label: 'SVG (vector)', ext: 'svg', mime: 'image/svg+xml' },
    pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
    txt: { label: 'Text', ext: 'txt', mime: 'text/plain' },
    zippng: { label: 'PNG images (zip)', ext: 'zip', mime: 'application/zip', raster: true, inner: 'png' },
    zipjpeg: { label: 'JPEG images (zip)', ext: 'zip', mime: 'application/zip', raster: true, inner: 'jpeg' },
};
const SINGLE = ['png', 'jpeg', 'webp', 'svg', 'pdf', 'txt'];
const MULTI = ['pdf', 'zippng', 'zipjpeg', 'txt'];

const STYLE = `
.pdfv-bar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 10px;background:#323639;color:#ddd;font:13px sans-serif;border-bottom:1px solid #222;}
.pdfv-bar button,.pdfv-bar select{background:#4a4e52;color:#eee;border:1px solid #5c6064;border-radius:4px;padding:3px 9px;font:13px sans-serif;cursor:pointer;}
.pdfv-bar button:hover:not(:disabled){background:#5c6064;}
.pdfv-bar button:disabled{opacity:.45;cursor:default;}
.pdfv-sep{width:1px;height:18px;background:#5c6064;margin:0 2px;}
.pdfv-status{margin-left:auto;color:#bbb;}
.pdfv-status.error{color:#f88;}
.pdfv-export{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding-top:4px;}
.pdfv-export[hidden]{display:none;}
.pdfv-body{flex:1;min-height:0;display:flex;}
.pdfv-scroll{flex:1;min-width:0;overflow:auto;}
.pdfv-side{flex:0 0 42%;max-width:80%;min-width:180px;}
.pdfv-split{flex:0 0 5px;cursor:col-resize;background:#2a2c2e;}
.pdfv-split:hover{background:#4a9eff;}
@media (max-width:700px){.pdfv-body{flex-direction:column;}.pdfv-side{flex-basis:45%;max-width:none;min-width:0;min-height:120px;}.pdfv-split{display:none;}}
.pdfv-inspecting .pdfv-page canvas{cursor:crosshair;}
.pdfv-bar button.on{background:#264f78;border-color:#4a9eff;}
.pdfv-pages{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;}
.pdfv-page{position:relative;max-width:100%;outline:3px solid transparent;outline-offset:2px;}
.pdfv-page.selected{outline-color:#4a9eff;}
.pdfv-page canvas{display:block;max-width:100%;height:auto;box-shadow:0 2px 8px rgba(0,0,0,.3);background:#fff;}
.pdfv-turn{position:absolute;top:6px;right:6px;display:flex;gap:4px;opacity:.35;transition:opacity .15s;}
.pdfv-page:hover .pdfv-turn,.pdfv-turn:focus-within{opacity:1;}
.pdfv-turn button,.pdfv-num{background:rgba(0,0,0,.65);color:#fff;border:none;border-radius:4px;padding:3px 8px;font:13px sans-serif;cursor:pointer;}
.pdfv-num{position:absolute;bottom:6px;right:6px;cursor:default;opacity:.7;}
.pdfv-pick{position:absolute;top:6px;left:6px;display:flex;align-items:center;gap:4px;background:rgba(0,0,0,.65);color:#fff;border-radius:4px;padding:3px 7px;font:13px sans-serif;cursor:pointer;opacity:.5;}
.pdfv-page:hover .pdfv-pick,.pdfv-page.selected .pdfv-pick{opacity:1;}
.pdfv-pick input{margin:0;cursor:pointer;}
.pdfv-page.deleted canvas{opacity:.25;filter:grayscale(1);}
.pdfv-page.deleted .pdfv-turn{opacity:1;}
.pdfv-page.deleted .pdfv-turn button:not(.pdfv-del),.pdfv-page.deleted .pdfv-pick{display:none;}
.pdfv-gone{position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#c00;font:bold 20px sans-serif;pointer-events:none;}
.pdfv-page.deleted .pdfv-gone{display:flex;}
.pdfv-media{position:absolute;display:flex;align-items:center;justify-content:center;outline:1px dashed rgba(74,158,255,.8);}
.pdfv-media>button{background:rgba(0,0,0,.7);color:#fff;border:none;border-radius:4px;padding:5px 10px;font:13px sans-serif;cursor:pointer;}
.pdfv-media iframe{width:100%;height:100%;display:block;}
.pdfv-media .pdfv-media-close{position:absolute;top:-24px;right:0;padding:2px 7px;}
.pdfv-page .annotationLayer{z-index:0;} /* its fields stack inside it, under what follows */
.pdfv-exec{position:absolute;cursor:pointer;}
.pdfv-exec:hover{outline:1px dashed rgba(74,158,255,.8);}
.pdfv-page.deleted :is(.pdfv-media,.pdfv-exec){display:none;}
.pdfv-page.deleted .annotationLayer{display:none;}
.pdfv-inspecting .annotationLayer,.pdfv-inspecting .annotationLayer *{pointer-events:none!important;}
`;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// 1,2,3,5 -> "1-3_5"
function ranges(nums) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
        i = j;
    }
    return out.join('_');
}

function download(blob, name) {
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// root: the element to fill; url: the file's bytes; path: where it is saved to
// (null: nowhere, e.g. a decrypted file only in memory: nothing is written out);
// illustrator: an Adobe Illustrator file, shown and exported but never saved over
async function mountPdfViewer(root, { url, path, illustrator }) {
    if (!document.getElementById('pdfv-style')) {
        const style = el('style');
        style.id = 'pdfv-style';
        style.textContent = STYLE;
        document.head.appendChild(style);
    }
    root.style.cssText += 'overflow:hidden;display:flex;flex-direction:column;background:#525659;';
    const bar = el('div', 'pdfv-bar');
    const btn = (label, title, parent = bar) => { const b = el('button', null, label); b.title = title; parent.appendChild(b); return b; };
    const saveBtn = btn('Save', 'Save the changes into this file');
    const saveAsBtn = btn('Save as…', 'Save as a new PDF beside this one');
    const sep2 = el('span', 'pdfv-sep');
    bar.appendChild(sep2);
    const selectAllBtn = btn('Select all', 'Select every page (Shift-click a page\'s box for a range)');
    const selLeft = btn('↺', 'Turn the selected pages a quarter left');
    const selRight = btn('↻', 'Turn the selected pages a quarter right');
    const exportBtn = btn('Export…', 'Export the selected pages');
    bar.appendChild(el('span', 'pdfv-sep'));
    const inspectBtn = btn('Inspect', 'The file\'s objects and what each draws (a debug view)');
    const qdfBtn = btn('Readable copy…', 'Save a copy with every stream decompressed and every object written out on its own, indented (as qpdf\'s QDF mode)');
    qdfBtn.hidden = true;
    const scriptsBtn = btn('Run scripts', 'Run the PDF\'s JavaScript (form calculations and checks, buttons, page and open actions) in pdf.js\'s sandbox');
    scriptsBtn.hidden = true;
    const status = el('span', 'pdfv-status');
    bar.appendChild(status);

    // Export choices, under the bar
    const exportRow = el('div', 'pdfv-export');
    exportRow.hidden = true;
    const exportWhat = el('span');
    const formatSel = el('select');
    const dpiSel = el('select');
    for (const dpi of [72, 150, 300, 600]) dpiSel.appendChild(Object.assign(el('option', null, `${dpi} dpi`), { value: String(dpi) }));
    dpiSel.value = '150';
    exportRow.append(exportWhat, formatSel, dpiSel);
    const exportGo = btn('Export', 'Export the selected pages in this format', exportRow);
    const exportCancel = btn('Cancel', 'Close', exportRow);
    bar.appendChild(exportRow);

    const pagesEl = el('div', 'pdfv-pages');
    const body = el('div', 'pdfv-body');
    const scroller = el('div', 'pdfv-scroll');
    scroller.appendChild(pagesEl);
    body.appendChild(scroller);
    root.append(bar, body);

    const writable = !!path && !insideArchive(path);
    if (!writable) saveBtn.hidden = saveAsBtn.hidden = true;
    // Illustrator keeps its own copy of the artwork beside the PDF one: a rewritten
    // PDF would leave the two out of step, so changes go to a new PDF only
    if (illustrator) saveBtn.hidden = true;
    // a file only in memory (decrypted) is never written out, exports included
    if (!path) sep2.hidden = selectAllBtn.hidden = selLeft.hidden = selRight.hidden = exportBtn.hidden = true;
    const setStatus = (text, isError) => { status.textContent = text; status.classList.toggle('error', !!isError); };

    let pdfjs, bytes, doc, pages = [], libDoc = null, forms = null;
    let busy = false, lastPicked = null;
    const plural = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const kept = () => pages.filter(p => !p.deleted);
    const selected = () => kept().filter(p => p.selected);
    const refresh = () => {
        const turned = pages.filter(p => p.extra && !p.deleted).length;
        const deleted = pages.length - kept().length;
        const nKept = kept().length, nSel = selected().length;
        const filled = !!(forms && forms.changed);
        saveBtn.disabled = busy || !(turned || deleted || filled) || !nKept;
        saveAsBtn.disabled = busy || !nKept;
        selLeft.disabled = selRight.disabled = busy || !nSel;
        selectAllBtn.disabled = busy || !nKept;
        selectAllBtn.textContent = nKept && nSel === nKept ? 'Select none' : 'Select all';
        exportBtn.disabled = busy || !nSel;
        exportGo.disabled = busy || !nSel;
        if (!exportRow.hidden) {
            if (!nSel) exportRow.hidden = true;
            else fillFormats();
        }
        if (busy) return;
        const changes = [turned && `${plural(turned, 'page')} turned`, deleted && `${plural(deleted, 'page')} deleted`, filled && 'form filled in'].filter(Boolean);
        if (!nKept) setStatus('Every page is deleted: a PDF needs at least one', true);
        else setStatus([changes.length ? changes.join(', ') + ', not saved' : plural(pages.length, 'page'), nSel && `${nSel} selected`].filter(Boolean).join(' · '));
    };

    // The format list fits the selection: one page has more ways out than several
    function fillFormats() {
        const n = selected().length;
        const list = n === 1 ? SINGLE : MULTI;
        const key = list.join();
        if (formatSel.dataset.list !== key) {
            const prev = formatSel.value;
            formatSel.textContent = '';
            for (const f of list) formatSel.appendChild(Object.assign(el('option', null, FORMATS[f].label), { value: f }));
            formatSel.dataset.list = key;
            if (list.includes(prev)) formatSel.value = prev;
        }
        dpiSel.hidden = !FORMATS[formatSel.value].raster;
        exportWhat.textContent = n === 1 ? `Page ${selected()[0].num} as` : `${n} pages as`;
    }

    const rotation = (p) => (p.page.rotate + p.extra) % 360;

    async function draw(p) {
        const viewport = p.page.getViewport({ scale: SCALE, rotation: rotation(p) });
        const canvas = el('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        if (p.task) p.task.cancel();
        if (inspector) inspector.pageDrawn(p);
        // fields are drawn by the form layer above, live
        const annotationMode = forms && forms.hasFields ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE;
        p.task = p.page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationMode });
        try {
            await p.task.promise;
        } catch (err) {
            if (err && err.name === 'RenderingCancelledException') return;
            throw err;
        }
        p.canvas.replaceWith(canvas);
        p.canvas = canvas;
        placeMedia(p, viewport);
        if (forms) await forms.layer(p, viewport).catch(err => log.error('Form layer failed:', err));
    }

    // Flash in the PDF (RichMedia annotations, as LaTeX's media9 makes):
    // played by Ruffle where the annotation sits, on a click, or as the page
    // opens or shows when the file says so; and the buttons that command a
    // movie (RichMediaExecute: media9's \mediabutton) command it here too
    const movies = new Map(); // annotation id (pdf.js's "12R") → its movie
    async function findMedia(p) {
        const annots = await p.page.getAnnotations().catch(() => []);
        p.media = annots.filter(a => a.subtype === 'RichMedia' && a.rect).map(a => {
            const box = el('div', 'pdfv-media');
            const play = el('button', null, '▶ Flash');
            play.title = 'Play the Flash (SWF) in this annotation with Ruffle';
            box.appendChild(play);
            const m = { id: a.id, rect: a.rect, box, play };
            play.onclick = () => startMovie(m).catch(() => {});
            p.wrap.appendChild(box);
            movies.set(a.id, m);
            return m;
        });
    }

    function placeMedia(p, viewport) {
        for (const m of p.media || []) {
            const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(m.rect);
            Object.assign(m.box.style, {
                left: Math.min(x1, x2) / viewport.width * 100 + '%', top: Math.min(y1, y2) / viewport.height * 100 + '%',
                width: Math.abs(x2 - x1) / viewport.width * 100 + '%', height: Math.abs(y2 - y1) / viewport.height * 100 + '%',
            });
        }
    }

    function startMovie(m) {
        if (m.starting) return m.starting;
        m.play.disabled = true;
        m.play.textContent = 'Loading…';
        m.starting = (async () => {
            const movie = await swfOf(m.id);
            m.play.hidden = true;
            m.handle = await playFlash(m.box, movie);
            m.close = el('button', 'pdfv-media-close', '✕');
            m.close.title = 'Stop';
            m.close.onclick = () => stopMovie(m);
            m.box.appendChild(m.close);
            return m.handle;
        })();
        m.starting.catch(err => {
            log.error('Flash failed:', err);
            stopMovie(m);
            setStatus('Could not play the Flash: ' + err.message, true);
        });
        return m.starting;
    }

    function stopMovie(m) {
        if (m.handle) m.handle.destroy();
        if (m.close) m.close.remove();
        m.handle = m.close = m.starting = null;
        m.play.hidden = false;
        m.play.disabled = false;
        m.play.textContent = '▶ Flash';
    }

    // The file read by pdf-lib (for what pdf.js leaves out), and its helpers
    async function libOf() {
        const lib = await import(PDF_LIB);
        const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFString, PDFHexString, decodePDFRawStream } = lib;
        if (!libDoc || libDoc.bytes !== bytes) libDoc = { bytes, doc: await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }) };
        const look = (d, k) => (d instanceof PDFDict ? d.lookup(PDFName.of(k)) : undefined);
        const items = (a) => (a instanceof PDFArray ? a.asArray().map((_, i) => a.lookup(i)) : []);
        const text = (v) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : v instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(v).decode()) : undefined);
        const name = (v) => (v instanceof PDFName ? v.decodeText() : undefined);
        // a PDF value as JavaScript's
        const value = (v) => v instanceof PDFArray ? items(v).map(value) : text(v) ?? name(v)
            ?? (typeof v?.asNumber === 'function' ? v.asNumber() : typeof v?.asBoolean === 'function' ? v.asBoolean() : null);
        const idOf = (ref) => `${ref.objectNumber}R${ref.generationNumber || ''}`;
        return { lib, doc: libDoc.doc, look, items, text, name, value, idOf };
    }

    // After the pages: when each movie starts, and the buttons commanding them
    async function findControls() {
        if (!movies.size) return;
        const { lib, doc: ldoc, look, items, name, value, idOf } = await libOf();
        const { PDFName, PDFDict, PDFArray, PDFRef } = lib;
        for (const m of movies.values()) {
            const r = /^(\d+)R(\d*)$/.exec(m.id);
            const annot = r && ldoc.context.lookup(PDFRef.of(+r[1], +(r[2] || 0)));
            const when = name(look(look(look(annot, 'RichMediaSettings'), 'Activation'), 'Condition'));
            if (when === 'PO' || when === 'PV') startWhenShown(m);
        }
        ldoc.getPages().forEach((page, i) => {
            const p = pages[i];
            if (!p) return;
            for (const annot of items(page.node.lookup(PDFName.of('Annots')))) {
                const commands = [];
                const walk = (action, depth) => {
                    if (action instanceof PDFArray) return items(action).forEach(a => walk(a, depth + 1));
                    if (!(action instanceof PDFDict) || depth > 32) return;
                    if (name(look(action, 'S')) === 'RichMediaExecute') {
                        const target = action.get(PDFName.of('TA'));
                        const cmd = look(action, 'CMD');
                        const args = cmd instanceof PDFDict ? value(look(cmd, 'A')) : null;
                        commands.push({
                            target: target instanceof PDFRef ? idOf(target) : null,
                            call: cmd instanceof PDFDict ? value(look(cmd, 'C')) : null,
                            args: args == null ? [] : Array.isArray(args) ? args : [args],
                        });
                    }
                    walk(look(action, 'Next'), depth + 1);
                };
                walk(look(annot, 'A'), 0);
                const aa = look(annot, 'AA');
                if (aa instanceof PDFDict) ['U', 'D'].forEach(k => walk(look(aa, k), 0));
                const live = commands.filter(c => c.call && movies.has(c.target));
                const rect = items(look(annot, 'Rect')).map(value);
                if (!live.length || rect.length !== 4) continue;
                const box = el('div', 'pdfv-exec');
                box.title = 'Movie: ' + live.map(c => c.call).join(', ');
                box.onclick = () => command(live);
                p.wrap.appendChild(box);
                p.media.push({ rect, box });
            }
            if (p.canvas.width) placeMedia(p, p.page.getViewport({ scale: SCALE, rotation: rotation(p) }));
        });
    }

    async function command(list) {
        for (const c of list) {
            const m = movies.get(c.target);
            try {
                const handle = await startMovie(m);
                // a movie just started offers its functions a moment later
                for (let tries = 0; ; tries++) {
                    try { await handle.call(c.call, c.args); break; } catch (err) {
                        if (!/offers no/.test(err.message) || tries > 30) throw err;
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            } catch (err) {
                setStatus(`The movie's ${c.call} failed: ${err.message}`, true);
            }
        }
    }

    function startWhenShown(m) {
        const seen = new IntersectionObserver((entries) => {
            if (!entries.some(e => e.isIntersecting)) return;
            seen.disconnect();
            if (!m.box.closest('.pdfv-page.deleted')) startMovie(m).catch(() => {});
        }, { root: scroller, threshold: 0.1 });
        seen.observe(m.box);
    }

    // The SWF of a RichMedia annotation (pdf.js names it "12R"): its Flash
    // instance's asset, else the first SWF among the assets; with its FlashVars
    async function swfOf(id) {
        const m = /^(\d+)R(\d*)$/.exec(id || '');
        if (!m) throw new Error('the annotation is not an object of its own');
        const { lib, look, items, text } = await libOf();
        const { PDFRef, PDFRawStream, decodePDFRawStream } = lib;
        const fileOf = (spec) => {
            const ef = look(spec, 'EF');
            const stream = look(ef, 'F') || look(ef, 'UF');
            if (!stream) return null;
            const data = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
            return { data, name: text(look(spec, 'UF')) || text(look(spec, 'F')) || 'movie.swf' };
        };
        const isSwf = (f) => f && /^[FCZ]WS/.test(String.fromCharCode(f.data[0], f.data[1], f.data[2]));
        const annot = libDoc.doc.context.lookup(PDFRef.of(+m[1], +(m[2] || 0)));
        const content = look(annot, 'RichMediaContent');
        // the annotation's files by name: what the movie loads (media9's
        // VPlayer.swf plays its video so) is looked up among them
        const named = [];
        const walk = (node, depth) => {
            const names = items(look(node, 'Names'));
            for (let i = 1; i < names.length; i += 2) named.push([text(names[i - 1]), names[i]]);
            if (depth < 8) items(look(node, 'Kids')).forEach(k => walk(k, depth + 1));
        };
        walk(look(content, 'Assets'), 0);
        const assets = () => named.map(([key, spec]) => ({ key, file: fileOf(spec) })).filter(a => a.key && a.file)
            .map(a => ({ name: a.key, data: a.file.data }));
        for (const config of items(look(content, 'Configurations'))) {
            for (const inst of items(look(config, 'Instances'))) {
                const f = fileOf(look(inst, 'Asset'));
                if (isSwf(f)) return { ...f, flashVars: text(look(look(inst, 'Params'), 'FlashVars')) || '', assets: assets() };
            }
        }
        for (const [, spec] of named) {
            const f = fileOf(spec);
            if (isSwf(f)) return { ...f, flashVars: '', assets: assets() };
        }
        throw new Error('no SWF in this annotation');
    }

    function remove(p, del) {
        p.deleted = del;
        p.wrap.classList.toggle('deleted', del);
        p.delBtn.textContent = del ? 'Undo' : '✕';
        p.delBtn.title = del ? `Keep page ${p.num}` : `Delete page ${p.num}`;
        refresh();
    }

    function turn(p, by) {
        p.extra = (p.extra + by + 360) % 360;
        refresh();
        draw(p).catch(err => log.error('Draw failed:', err));
    }

    function pick(p, on) {
        p.selected = on;
        p.box.checked = on;
        p.wrap.classList.toggle('selected', on);
    }

    async function load(data) {
        const wasRunning = !!(forms && forms.running);
        if (forms) await forms.destroy();
        forms = null;
        movies.forEach(stopMovie);
        movies.clear();
        if (doc) doc.destroy();
        pagesEl.textContent = '';
        pages = [];
        lastPicked = null;
        // pdf.js takes the buffer away from us (to its worker): give it a copy
        doc = await pdfjs.getDocument({ data: data.slice(), pdfBug: true }).promise; // pdfBug: so Inspect can step through a page's drawing
        forms = await createForms({
            pdfjs, sandboxSrc: PDFJS + 'pdf.sandbox.mjs', doc, root, pages: () => pages,
            goToPage: (i) => { if (pages[i]) pages[i].wrap.scrollIntoView({ block: 'start' }); },
            onChange: () => refresh(),
            say: (text) => setStatus(text, true),
        }).catch(err => { log.error('Forms failed:', err); return null; });
        scriptsBtn.hidden = !(forms && forms.hasScripts);
        scriptsBtn.classList.remove('on');
        scriptsBtn.textContent = 'Run scripts';
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const p = { page, num: i, extra: 0, deleted: false, selected: false, wrap: el('div', 'pdfv-page'), canvas: el('canvas') };
            const tools = el('div', 'pdfv-turn');
            const left = el('button', null, '↺');
            left.title = `Turn page ${i} a quarter left`;
            left.onclick = () => turn(p, -90);
            const right = el('button', null, '↻');
            right.title = `Turn page ${i} a quarter right`;
            right.onclick = () => turn(p, 90);
            p.delBtn = el('button', 'pdfv-del', '✕');
            p.delBtn.title = `Delete page ${i}`;
            p.delBtn.onclick = () => { if (!p.deleted) pick(p, false); remove(p, !p.deleted); };
            tools.append(left, right, p.delBtn);
            const pickLabel = el('label', 'pdfv-pick');
            p.box = el('input');
            p.box.type = 'checkbox';
            p.box.title = `Select page ${i} (Shift: the pages from the last one picked)`;
            p.box.onclick = (e) => {
                const on = p.box.checked;
                if (e.shiftKey && lastPicked && lastPicked !== p) {
                    const [a, b] = [pages.indexOf(lastPicked), pages.indexOf(p)].sort((x, y) => x - y);
                    pages.slice(a, b + 1).filter(q => !q.deleted).forEach(q => pick(q, on));
                } else pick(p, on);
                lastPicked = p;
                refresh();
            };
            pickLabel.append(p.box, document.createTextNode(String(i)));
            if (!path) pickLabel.hidden = true;
            p.wrap.append(p.canvas, el('div', 'pdfv-gone', 'Deleted'), pickLabel, tools, el('span', 'pdfv-num', String(i)));
            // Inspecting: a click on the page finds what is drawn there
            p.wrap.addEventListener('click', (e) => {
                if (!inspector || e.target.tagName !== 'CANVAS') return;
                const r = p.canvas.getBoundingClientRect();
                inspector.pickAt(pages.indexOf(p), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
            });
            pagesEl.appendChild(p.wrap);
            pages.push(p);
            await findMedia(p);
            await draw(p);
        }
        refresh();
        await findControls().catch(err => log.error('Media controls:', err));
        if (wasRunning && forms && forms.hasScripts) await setScripts(true);
    }

    // A PDF of some of the pages (all those kept, by default) as they are shown
    async function pdfOf(list = kept()) {
        const { PDFDocument, degrees } = await import(PDF_LIB);
        // with the fields as filled in
        const base = forms && forms.changed ? await forms.bytes() : bytes;
        const src = await PDFDocument.load(base, { updateMetadata: false });
        const turn = (page, extra) => { if (extra) page.setRotation(degrees((page.getRotation().angle + extra + 360) % 360)); };
        let out;
        if (list.length === kept().length && list.every((p, i) => p === kept()[i])) {
            // the whole file less the deleted pages: keeps what pages share (outline,
            // forms). Turned first: pdf-lib's page list isn't renewed by removePage
            out = src;
            out.getPages().forEach((page, i) => turn(page, pages[i].extra));
            for (let i = pages.length - 1; i >= 0; i--) if (pages[i].deleted) out.removePage(i);
        } else {
            out = await PDFDocument.create();
            const copies = await out.copyPages(src, list.map(p => p.num - 1));
            copies.forEach((c, i) => { turn(c, list[i].extra); out.addPage(c); });
        }
        return out.save();
    }

    async function imageOf(p, format, dpi) {
        let scale = dpi / 72;
        const base = p.page.getViewport({ scale: 1, rotation: rotation(p) });
        scale = Math.min(scale, MAX_SIDE / base.width, MAX_SIDE / base.height);
        const viewport = p.page.getViewport({ scale, rotation: rotation(p) });
        const canvas = el('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // JPEG has no transparency, and a PDF page is paper
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await p.page.render({ canvasContext: ctx, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
        const mime = FORMATS[format].mime;
        const blob = await new Promise(res => canvas.toBlob(res, mime, 0.92));
        if (!blob || blob.type !== mime) throw new Error(`this browser can't write ${FORMATS[format].label}`);
        canvas.width = canvas.height = 0;
        return blob;
    }

    async function textOf(p) {
        const tc = await p.page.getTextContent();
        return tc.items.map(t => t.str + (t.hasEOL ? '\n' : '')).join('').trim();
    }

    async function svgOf(p) {
        const mupdf = await import(MUPDF);
        const one = mupdf.Document.openDocument(await pdfOf([p]), 'application/pdf');
        const page = one.loadPage(0);
        const buf = new mupdf.Buffer();
        const writer = new mupdf.DocumentWriter(buf, 'svg', '');
        const dev = writer.beginPage(page.getBounds());
        page.run(dev, mupdf.Matrix.identity);
        writer.endPage();
        writer.close();
        const svg = buf.asUint8Array().slice();
        [buf, writer, page, one].forEach(o => o.destroy && o.destroy());
        return svg;
    }

    async function exportBlob(list, format, dpi) {
        const f = FORMATS[format];
        if (format === 'pdf') return new Blob([await pdfOf(list)], { type: f.mime });
        if (format === 'svg') return new Blob([await svgOf(list[0])], { type: f.mime });
        if (format === 'txt') {
            const texts = [];
            for (const p of list) texts.push(await textOf(p));
            return new Blob([texts.join('\n\n') + '\n'], { type: f.mime });
        }
        if (f.inner) {
            const JSZip = (m => m.default || m)(await import(JSZIP));
            const zip = new JSZip();
            for (const [i, p] of list.entries()) {
                setStatus(`Exporting page ${p.num} (${i + 1} of ${list.length})…`);
                zip.file(`page-${String(p.num).padStart(String(pages.length).length, '0')}.${FORMATS[f.inner].ext}`, await imageOf(p, f.inner, dpi));
            }
            return zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: f.mime });
        }
        return imageOf(list[0], format, dpi);
    }

    // Writes a file: 'ok', 'exists' (and overwrite not asked for) or throws
    async function put(target, blob, overwrite) {
        const r = await fetch('/upload-file?' + (overwrite ? 'overwrite=1&' : '') + 'path=' + encodeURIComponent(target), { method: 'PUT', body: blob });
        if (r.status === 409) return 'exists';
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        log.log(`Saved ${target} (${blob.size} bytes)`);
        return 'ok';
    }

    // Runs a job with the buttons off; its message, or the error, in the status
    async function job(working, fn) {
        busy = true;
        refresh();
        setStatus(working);
        let done;
        try {
            done = await fn();
        } catch (err) {
            log.error('Failed:', err);
            busy = false;
            refresh();
            setStatus('Could not do it: ' + (/encrypt/i.test(err.message) ? 'the PDF is encrypted' : err.message), true);
            return;
        }
        busy = false;
        refresh();
        if (done) setStatus(done);
    }

    // Asks for a name beside the file and writes the blob there (or downloads it,
    // when the file is somewhere nothing is written: inside an archive)
    async function saveBeside(suggested, ext, makeBlob, working) {
        const dir = path.slice(0, path.lastIndexOf('/') + 1);
        let name = prompt(writable ? 'Save as (in the same folder):' : 'Download as:', suggested);
        if (!name || !(name = name.trim())) return;
        if (name.includes('/')) return setStatus('A name, not a path', true);
        if (!name.toLowerCase().endsWith('.' + ext)) name += '.' + ext;
        await job(working, async () => {
            const blob = await makeBlob();
            if (!writable) {
                download(blob, name);
                return `Downloaded ${name}`;
            }
            if (await put(dir + name, blob, false) === 'exists') {
                if (!confirm(`${name} already exists. Replace it?`)) return 'Not saved';
                await put(dir + name, blob, true);
            }
            return `Saved ${name} ${new Date().toLocaleTimeString()}`;
        });
    }

    const baseName = () => path.slice(path.lastIndexOf('/') + 1).replace(/\.(pdf|ai)$/i, '');

    selLeft.onclick = () => selected().forEach(p => turn(p, -90));
    selRight.onclick = () => selected().forEach(p => turn(p, 90));
    saveBtn.onclick = () => job('Saving…', async () => {
        const data = await pdfOf();
        await put(path, new Blob([data], { type: 'application/pdf' }), true);
        // what is on screen is now the file: start again from it
        bytes = data;
        busy = false;
        await load(bytes);
        if (inspector) inspector.reload();
        return `Saved ${baseName()}.pdf ${new Date().toLocaleTimeString()}`;
    });
    saveAsBtn.onclick = () => saveBeside(`${baseName()}-edited.pdf`, 'pdf',
        async () => new Blob([await pdfOf()], { type: 'application/pdf' }), 'Saving…');
    // ---- Inspect ----
    let inspector = null, side = null, split = null;
    inspectBtn.onclick = () => {
        if (inspector) {
            inspector.destroy();
            inspector = null;
            side.remove();
            split.remove();
            inspectBtn.classList.remove('on');
            root.classList.remove('pdfv-inspecting');
            qdfBtn.hidden = true;
            return;
        }
        side = el('div', 'pdfv-side');
        split = el('div', 'pdfv-split');
        body.insertBefore(split, scroller);
        body.insertBefore(side, split);
        // drag the divider to share the width
        split.onpointerdown = (e) => {
            split.setPointerCapture(e.pointerId);
            const left = body.getBoundingClientRect().left;
            split.onpointermove = (m) => { side.style.flexBasis = Math.max(180, m.clientX - left) + 'px'; };
            split.onpointerup = () => { split.onpointermove = null; };
        };
        inspectBtn.classList.add('on');
        root.classList.add('pdfv-inspecting');
        qdfBtn.hidden = !path;
        inspector = createInspector({
            panel: side,
            pages: () => pages,
            getBytes: () => bytes,
            pdfjs,
            saveBeside: path ? (name, ext, make, working) => saveBeside(`${baseName()}-${name}`, ext, make, working) : null,
        });
    };
    async function setScripts(on) {
        scriptsBtn.disabled = true;
        try {
            if (on) setStatus('Starting the scripts…');
            await forms.setRunning(on);
            scriptsBtn.classList.toggle('on', forms.running);
            scriptsBtn.textContent = forms.running ? 'Stop scripts' : 'Run scripts';
            refresh();
        } catch (err) {
            log.error('Scripts failed:', err);
            setStatus('Could not run the scripts: ' + err.message, true);
        } finally {
            scriptsBtn.disabled = false;
        }
    }
    scriptsBtn.onclick = () => setScripts(!forms.running);
    qdfBtn.onclick = () => saveBeside(`${baseName()}-qdf.pdf`, 'pdf', () => inspector.readableCopy(), 'Writing…');

    selectAllBtn.onclick = () => {
        const all = selected().length !== kept().length;
        kept().forEach(p => pick(p, all));
        refresh();
    };
    exportBtn.onclick = () => {
        exportRow.hidden = !exportRow.hidden;
        if (!exportRow.hidden) fillFormats();
    };
    formatSel.onchange = fillFormats;
    exportCancel.onclick = () => { exportRow.hidden = true; };
    exportGo.onclick = () => {
        const list = selected();
        const format = formatSel.value, dpi = +dpiSel.value;
        const ext = FORMATS[format].ext;
        const which = list.length === 1 ? `p${list[0].num}` : `p${ranges(list.map(p => p.num))}`;
        saveBeside(`${baseName()}-${which}.${ext}`, ext, () => exportBlob(list, format, dpi), 'Exporting…');
    };

    try {
        setStatus('Loading…');
        pdfjs = await import(PDFJS + 'pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.mjs';
        bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        if (illustrator) checkIllustrator(bytes);
        await load(bytes);
    } catch (err) {
        log.error('Load failed:', err);
        pagesEl.innerHTML = '';
        pagesEl.appendChild(el('div', null, 'Failed to load PDF: ' + err.message)).style.cssText = 'color:#f88;padding:20px;';
        setStatus('');
        [selLeft, selRight, saveBtn, saveAsBtn, selectAllBtn, exportBtn, inspectBtn].forEach(b => { b.disabled = true; });
    }
    return { destroy() { if (inspector) inspector.destroy(); movies.forEach(stopMovie); if (forms) forms.destroy(); if (doc) doc.destroy(); } };
}

// An Illustrator file before version 9 is PostScript, not PDF
function checkIllustrator(bytes) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    if (head.includes('%PDF-')) return;
    if (head.startsWith('%!PS')) throw new Error('this is an Illustrator 8 (or older) file: PostScript, which this viewer does not read. Illustrator 9 and later save it as PDF.');
    throw new Error('this is not an Illustrator file this viewer reads (it is not PDF-based)');
}

module.exports = { mountPdfViewer };
