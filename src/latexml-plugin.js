// --- LaTeX with LaTeXML ---
// .tex files open in a LaTeX workspace, Overleaf-like: the source on the left,
// the document on the right, rebuilt as you type. The conversion is LaTeXML
// (github.com/brucemiller/LaTeXML) running in the browser, Perl compiled to
// WebAssembly (public/latexml-worker.js), producing HTML5 with MathML. The same
// conversion also backs the preview panel for .tex files in project mode.
//
// A document is its folder: the TeX sources, bibliographies and images in it
// go along, with what is open in editors in place of what is saved. Editing a
// chapter builds the file in the folder that has \documentclass and includes it.
const { registerPlugin } = require('./plugins');
const { registerHandler } = require('./handlers');
const { insideArchive } = require('./browse-mode');
const { createLogger } = require('./debug');
const log = createLogger('LaTeXML');

// zeroperl.wasm.gz and latexml-lib.pack.gz: built from source (~/git/zeroperl-latexml),
// published to npm and served by jsDelivr
const LATEXML_BASE = 'https://cdn.jsdelivr.net/npm/@kreijstal/zeroperl-latexml@0.8.8-build.1/';
const TEX_RE = /\.(tex|ltx|latex)$/i;
const SOURCE_RE = /\.(tex|ltx|latex|bib|sty|cls|bst|bbl|def|cfg|clo|fd|ltxml|txt|csv|dat)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg)$/i;
const MAX_FILES = 300, MAX_DIRS = 40, MAX_FILE_SIZE = 8 * 1024 * 1024;
const STATUS_TEXT = ['no problems', 'warnings', 'errors', 'fatal error'];
const BUILD_DELAY = 800;

let ctx = null;

// ---- the worker ----
let worker = null, ready = null, nextId = 1;
const pendingResults = new Map();
const progressListeners = new Set();

function startWorker() {
    if (ready) return ready;
    worker = new Worker('latexml-worker.js', { type: 'module' });
    ready = new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
            if (data.type === 'progress') progressListeners.forEach(fn => fn(data.text));
            else if (data.type === 'ready') resolve();
            else if (data.type === 'error') reject(new Error(data.message));
            else if (data.type === 'result') {
                const done = pendingResults.get(data.id);
                pendingResults.delete(data.id);
                if (done) done.resolve(data);
            }
        };
        worker.onerror = e => reject(new Error(e.message || 'LaTeXML worker failed to start'));
    });
    ready.catch(() => stopWorker());
    worker.postMessage({ type: 'init', base: new URL(LATEXML_BASE, location.href).href });
    return ready;
}

// Ends the worker (and a conversion in it); the next conversion starts a new one
function stopWorker() {
    if (worker) worker.terminate();
    worker = null;
    ready = null;
    for (const p of pendingResults.values()) p.reject(new Error('stopped'));
    pendingResults.clear();
}

// One conversion at a time in the worker
let queue = Promise.resolve();
function convert(files, main) {
    const run = queue.then(async () => {
        await startWorker();
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pendingResults.set(id, { resolve, reject });
            worker.postMessage({ type: 'convert', id, files, main, options: ['--format=html5'] });
        });
    });
    queue = run.catch(() => {});
    return run;
}

// ---- the document's files ----
const fileCache = new Map(); // absolute path -> { mtimeMs, size, data }
const decoder = new TextDecoder();
const asText = data => (typeof data === 'string' ? data : decoder.decode(data));

async function listTree(dir) {
    const found = [];
    const queue = [[dir, '']];
    let dirs = 0;
    while (queue.length && found.length < MAX_FILES && dirs < MAX_DIRS) {
        const [abs, rel] = queue.shift();
        dirs++;
        const res = await ctx.wsClient.wsRequest({ type: 'browseDir', path: abs });
        if (res.error) continue;
        for (const item of res.items || []) {
            if (item.type === 'directory') {
                if (!/^(node_modules|__pycache__)$/.test(item.name)) queue.push([abs + '/' + item.name, rel + item.name + '/']);
            } else if ((SOURCE_RE.test(item.name) || IMAGE_RE.test(item.name)) && item.size <= MAX_FILE_SIZE) {
                found.push({ abs: abs + '/' + item.name, rel: rel + item.name, mtimeMs: item.mtimeMs, size: item.size });
            }
        }
    }
    return found;
}

async function readWorkspaceFile(f) {
    const hit = fileCache.get(f.abs);
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) return hit.data;
    const res = await fetch('/workspace-file?path=' + encodeURIComponent(f.abs));
    if (!res.ok) throw new Error(`${f.rel}: HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    fileCache.set(f.abs, { mtimeMs: f.mtimeMs, size: f.size, data });
    return data;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The document to build for `file`: itself if it has \documentclass, else the
// one that \input/\include-s it, else any with \documentclass
function pickMain(files, file) {
    const isRoot = p => /^[^%\n]*\\documentclass/m.test(asText(files[p]));
    if (!files[file] || isRoot(file)) return file;
    const roots = Object.keys(files).filter(p => TEX_RE.test(p) && isRoot(p));
    const stem = escapeRe(file.replace(TEX_RE, ''));
    const includes = new RegExp(`\\\\(input|include|subfile)\\s*\\{\\s*(\\./)?${stem}(\\.tex)?\\s*\\}`);
    return roots.find(p => includes.test(asText(files[p]))) || roots[0] || file;
}

// { files: { relative path: string | Uint8Array }, main, file (the one asked for) }
async function collectFiles(fileId, projectFiles) {
    const fileData = projectFiles[fileId];
    const ws = ctx && ctx.currentWorkspacePath;
    const rel = ws && ctx.getRelativePath(fileId);
    const files = {};
    if (!ws || !rel || !ctx.wsClient || !ctx.wsClient.isConnected()) {
        // An in-memory project: its files, by name
        for (const f of Object.values(projectFiles)) {
            if (!f.lazy && typeof f.content === 'string' && SOURCE_RE.test(f.name)) files[f.name] = f.content;
        }
        files[fileData.name] = fileData.content;
        return { files, main: pickMain(files, fileData.name), file: fileData.name };
    }
    const fileAbs = ws.replace(/\/+$/, '') + '/' + rel;
    const dir = fileAbs.replace(/\/[^/]*$/, '');
    const listed = await listTree(dir);
    await Promise.all(listed.map(async f => { files[f.rel] = await readWorkspaceFile(f); }));
    // What is open in editors wins over what is saved (files browse mode has
    // listed but not read yet are `lazy`, with no content of their own)
    for (const f of Object.values(projectFiles)) {
        if (f.lazy || typeof f.content !== 'string' || !SOURCE_RE.test(f.name)) continue;
        const r = ctx.getRelativePath(f.id);
        const abs = r && ws.replace(/\/+$/, '') + '/' + r;
        if (abs && abs.startsWith(dir + '/')) files[abs.slice(dir.length + 1)] = f.content;
    }
    const file = fileAbs.slice(dir.length + 1);
    return { files, main: pickMain(files, file), file };
}

// ---- the result ----
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };

function bytesToDataUrl(name, bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// The page, self-contained: its stylesheets inlined, its images as data: URLs,
// its scripts left out (MathML is drawn by the browser)
function standaloneHtml(r) {
    const attr = s => s.replace(/&amp;/g, '&');
    return r.html
        .replace(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g, (m, href) =>
            r.files[attr(href)] ? `<style>${decoder.decode(r.files[attr(href)])}</style>` : m)
        .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*><\/script>/g, '')
        .replace(/(<img\b[^>]*\bsrc=")([^"]+)"/g, (m, pre, src) =>
            r.files[attr(src)] ? pre + bytesToDataUrl(src, r.files[attr(src)]) + '"' : m);
}

// The log's messages: { kind: warning|error, text, file, line, col }
function logMessages(logText) {
    const out = [];
    let cur = null;
    for (const line of (logText || '').split('\n')) {
        const m = /^(Warning|Error|Fatal):/.exec(line);
        if (m) {
            cur = { kind: m[1] === 'Warning' ? 'warning' : 'error', lines: [line] };
            out.push(cur);
        } else if (cur && /^\t/.test(line)) {
            const clean = line.replace(/\/work\/src\//g, '');
            cur.lines.push(clean);
            const at = /\bat ([^;]+); line (\d+) col (\d+)/.exec(clean);
            if (at && !cur.file) Object.assign(cur, { file: at[1].trim(), line: +at[2], col: +at[3] });
        } else {
            cur = null;
        }
    }
    return out.map(({ lines, ...m }) => ({ ...m, text: lines.join('\n') }));
}

// Shows a result in an iframe, keeping where it was scrolled to
function showResult(iframe, r) {
    if (!r.html) return;
    let scroll = 0;
    try { scroll = iframe.contentWindow.scrollY; } catch (e) { /* not loaded */ }
    iframe.onload = () => { try { iframe.contentWindow.scrollTo(0, scroll); } catch (e) { /* not ours */ } };
    iframe.srcdoc = standaloneHtml(r);
}

function summary(r, wasReady, main, file) {
    return `${r.html ? 'Built' : 'Failed'} in ${(r.ms / 1000).toFixed(1)} s${wasReady ? '' : ' (first build loads TeX)'}`
        + ` · ${STATUS_TEXT[r.status] || 'status ' + r.status}${main !== file ? ` · main: ${main}` : ''}`;
}

function makeFrame(cls) {
    const iframe = document.createElement('iframe');
    iframe.className = cls;
    // No scripts; same origin only so the scroll position can be kept
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups');
    iframe.title = 'LaTeXML output';
    return iframe;
}

// ---- the preview panel (project mode) ----
const previewViews = new WeakMap(); // outputDiv -> { iframe, busy, queued }

async function renderPreview(fileId, outputDiv, diagnosticsDiv, projectFiles) {
    let v = previewViews.get(outputDiv);
    if (!v) {
        outputDiv.innerHTML = '';
        v = { iframe: makeFrame('latexml-frame'), busy: false, queued: null };
        outputDiv.appendChild(v.iframe);
        previewViews.set(outputDiv, v);
    }
    const status = outputDiv.parentElement && outputDiv.parentElement.querySelector('.latexml-status');
    const setStatus = (text, cls) => {
        if (!status) return;
        status.textContent = text;
        status.className = 'latexml-status' + (cls ? ' ' + cls : '');
    };
    // Edits during a build make one more build after it
    if (v.busy) { v.queued = [fileId, outputDiv, diagnosticsDiv, projectFiles]; return; }
    v.busy = true;
    const onProgress = text => setStatus(text, 'busy');
    progressListeners.add(onProgress);
    try {
        setStatus(ready ? 'Building…' : 'Loading LaTeXML…', 'busy');
        const { files, main, file } = await collectFiles(fileId, projectFiles);
        const wasReady = !!ready;
        const r = await convert(files, main);
        showResult(v.iframe, r);
        setStatus(summary(r, wasReady, main, file), r.status >= 2 ? 'error' : r.status === 1 ? 'warn' : 'ok');
        if (diagnosticsDiv) {
            const messages = logMessages(r.log);
            const text = messages.length ? messages.map(m => m.text).join('\n\n') : (r.html ? '' : r.messages || 'No output');
            diagnosticsDiv.textContent = text;
            diagnosticsDiv.style.display = text ? 'block' : 'none';
        }
    } catch (err) {
        setStatus(err.message === 'stopped' ? 'Stopped' : 'Error', 'error');
        if (diagnosticsDiv && err.message !== 'stopped') {
            diagnosticsDiv.textContent = err.message || String(err);
            diagnosticsDiv.style.display = 'block';
        }
    } finally {
        progressListeners.delete(onProgress);
        v.busy = false;
        if (v.queued) {
            const next = v.queued;
            v.queued = null;
            renderPreview(...next);
        }
    }
}

registerHandler({
    canHandle: fileName => TEX_RE.test(fileName),
    generatePreview: () => ({ type: 'latexml', requiresCustomRender: true, previewLabel: 'LaTeXML', previewColor: '#3d6e8f' }),
    render: (fileId, outputDiv, diagnosticsDiv, projectFiles) => renderPreview(fileId, outputDiv, diagnosticsDiv, projectFiles),
    getFileType: () => 'latex',
    getAceMode: () => 'latex',
    createPreviewUI(container, preview) {
        const bar = document.createElement('div');
        bar.className = 'latexml-bar';
        const status = document.createElement('span');
        status.className = 'latexml-status';
        status.textContent = 'LaTeXML';
        const rebuild = document.createElement('button');
        rebuild.textContent = '↻ Build';
        const stop = document.createElement('button');
        stop.textContent = '■ Stop';
        stop.title = 'Stop the build (the next one restarts LaTeXML)';
        bar.append(status, rebuild, stop);
        const outputDiv = document.createElement('div');
        outputDiv.className = 'latexml-output';
        const diagnosticsDiv = document.createElement('div');
        diagnosticsDiv.className = 'latexml-diagnostics';
        diagnosticsDiv.style.display = 'none';
        container.append(bar, outputDiv, diagnosticsDiv);
        rebuild.onclick = () => { if (preview && preview.updatePreviewMode) preview.updatePreviewMode(); };
        stop.onclick = () => stopWorker();
        return { outputDiv, diagnosticsDiv, zoomDisplay: null };
    },
});

// ---- the LaTeX workspace ----
class LatexComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && ctx ? ctx.projectFiles[this.fileId] : null;
        this.dirty = false;
        this.building = false;
        this.again = false;
        this._installStyles();

        const root = this.root = document.createElement('div');
        root.className = 'lx-root';
        root.dataset.view = this.state.view || 'both';
        root.innerHTML = `
<div class="lx-toolbar">
  <span class="lx-title"></span>
  <button class="lx-save" title="Save (Ctrl+S)" disabled>Save</button>
  <button class="lx-build" title="Build now (Ctrl+Enter)">↻ Build</button>
  <button class="lx-stop" title="Stop the build (the next one restarts LaTeXML)">■</button>
  <span class="lx-views"><button data-view="source">Source</button><button data-view="both">Both</button><button data-view="preview">Document</button></span>
  <span class="lx-status"></span>
</div>
<div class="lx-body">
  <div class="lx-source"></div>
  <div class="lx-split" title="Drag to resize"></div>
  <div class="lx-doc">
    <div class="lx-frame-wrap"><div class="lx-empty">The document appears here.</div></div>
    <div class="lx-messages" hidden></div>
  </div>
</div>`;
        container.element.appendChild(root);
        const q = s => root.querySelector(s);
        this.titleEl = q('.lx-title');
        this.saveBtn = q('.lx-save');
        this.statusEl = q('.lx-status');
        this.sourceEl = q('.lx-source');
        this.frameWrap = q('.lx-frame-wrap');
        this.messagesEl = q('.lx-messages');
        this.bodyEl = q('.lx-body');
        this.titleEl.textContent = this.fileData ? this.fileData.name : 'LaTeX';
        this.saveBtn.onclick = () => this._save();
        q('.lx-build').onclick = () => this._build();
        q('.lx-stop').onclick = () => { stopWorker(); this._status('Stopped', 'error'); };
        for (const b of root.querySelectorAll('[data-view]')) b.onclick = () => this._setView(b.dataset.view);
        this._setView(root.dataset.view);
        this._bindSplit(q('.lx-split'));

        this._resizeObserver = new ResizeObserver(() => {
            root.classList.toggle('lx-narrow', root.clientWidth < 700);
            if (this.ace) this.ace.resize();
        });
        this._resizeObserver.observe(root);
        if (container.on) {
            container.on('destroy', () => {
                this._destroyed = true;
                clearTimeout(this._timer);
                this._resizeObserver.disconnect();
                progressListeners.delete(this._onProgress);
                if (this.ace) this.ace.destroy();
            });
            container.on('resize', () => this.ace && this.ace.resize());
        }
        this._onProgress = text => this._status(text, 'busy');
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (LatexComponent._styleInstalled) return;
        LatexComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.lx-root{height:100%;display:flex;flex-direction:column;background:#f6f8fa;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#24292f}
.lx-toolbar{display:flex;align-items:center;gap:6px;padding:4px 10px;background:#fff;border-bottom:1px solid #d0d7de;white-space:nowrap;overflow:hidden;flex-shrink:0}
.lx-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0;margin-right:4px}
.lx-toolbar button{background:#f6f8fa;color:#24292f;border:1px solid #d0d7de;border-radius:4px;padding:2px 8px;font:inherit;cursor:pointer}
.lx-toolbar button:disabled{opacity:.5;cursor:default}
.lx-views{display:inline-flex}
.lx-views button{border-radius:0;margin-left:-1px}
.lx-views button:first-child{border-radius:4px 0 0 4px}
.lx-views button:last-child{border-radius:0 4px 4px 0}
.lx-views button.on{background:#0969da;border-color:#0969da;color:#fff}
.lx-status{margin-left:auto;color:#57606a;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.lx-status.busy{color:#9a6700}.lx-status.ok{color:#1a7f37}.lx-status.warn{color:#9a6700}.lx-status.error{color:#cf222e}
.lx-body{flex:1;min-height:0;display:flex}
.lx-source{flex:0 0 50%;min-width:0;position:relative}
.lx-split{flex:0 0 5px;cursor:col-resize;background:#d0d7de}
.lx-doc{flex:1;min-width:0;display:flex;flex-direction:column;background:#fff}
.lx-frame-wrap{flex:1;min-height:0;display:flex;position:relative}
.lx-frame{flex:1;border:0;width:100%;background:#fff}
.lx-empty{margin:auto;color:#8c959f}
.lx-messages[hidden]{display:none}
.lx-messages{flex:0 0 auto;max-height:32%;overflow-y:auto;border-top:1px solid #d0d7de;background:#fff;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.lx-msg{padding:4px 10px;white-space:pre-wrap;border-bottom:1px solid #eaeef2;cursor:default}
.lx-msg.here{cursor:pointer}.lx-msg.here:hover{background:#f6f8fa}
.lx-msg.error{color:#cf222e}.lx-msg.warning{color:#9a6700}
.lx-root[data-view=source] .lx-doc,.lx-root[data-view=source] .lx-split{display:none}
.lx-root[data-view=source] .lx-source{flex:1}
.lx-root[data-view=preview] .lx-source,.lx-root[data-view=preview] .lx-split{display:none}
.lx-root.lx-narrow .lx-body{flex-direction:column}
.lx-root.lx-narrow .lx-source{flex-basis:45%}
.lx-root.lx-narrow .lx-split{cursor:row-resize}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!ctx || !this.fileData || !ctx.currentWorkspacePath) return null;
        const rel = ctx.getRelativePath(this.fileId);
        return rel ? ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + rel : null;
    }

    async _init() {
        if (!this.fileData) return this._status('No file', 'error');
        this.path = this._path();
        this.readOnly = !this.path || insideArchive(this.path);
        let text = this.fileData.content;
        if (typeof text !== 'string' && this.path) {
            try {
                const r = await fetch('/workspace-file?path=' + encodeURIComponent(this.path));
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                text = await r.text();
                this.fileData.content = text;
            } catch (err) {
                return this._status('Could not read the file: ' + err.message, 'error');
            }
        }
        if (this._destroyed) return;
        const editor = this.ace = ace.edit(this.sourceEl);
        editor.setTheme('ace/theme/github');
        editor.session.setMode('ace/mode/latex');
        editor.session.setUseWrapMode(true);
        editor.setOptions({ fontSize: '13px', showPrintMargin: false });
        editor.setValue(text || '', -1);
        editor.session.getUndoManager().reset();
        editor.setReadOnly(!!(this.readOnly && this.path));
        editor.commands.addCommand({ name: 'save', bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' }, exec: () => this._save() });
        editor.commands.addCommand({ name: 'build', bindKey: { win: 'Ctrl-Enter', mac: 'Cmd-Enter' }, exec: () => this._build() });
        editor.session.on('change', () => {
            if (this._settingValue) return;
            this.fileData.content = editor.getValue();
            this._setDirty(true);
            clearTimeout(this._timer);
            this._timer = setTimeout(() => this._build(), BUILD_DELAY);
        });
        this._build();
    }

    _setView(view) {
        this.root.dataset.view = view;
        this.state.view = view;
        for (const b of this.root.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === view);
        if (this.ace) setTimeout(() => this.ace.resize(), 0);
    }

    _bindSplit(split) {
        split.onpointerdown = e => {
            e.preventDefault();
            split.setPointerCapture(e.pointerId);
            const narrow = this.root.classList.contains('lx-narrow');
            const box = this.bodyEl.getBoundingClientRect();
            split.onpointermove = ev => {
                const f = narrow ? (ev.clientY - box.top) / box.height : (ev.clientX - box.left) / box.width;
                this.sourceEl.style.flexBasis = `${Math.min(85, Math.max(15, f * 100))}%`;
                if (this.ace) this.ace.resize();
            };
            split.onpointerup = () => { split.onpointermove = null; split.onpointerup = null; };
        };
    }

    _setDirty(dirty) {
        this.dirty = dirty;
        this.saveBtn.disabled = !dirty || this.readOnly;
        if (ctx && this.fileId) {
            if (dirty && ctx.markDirty) ctx.markDirty(this.fileId);
            else if (!dirty && ctx.clearDirty) ctx.clearDirty(this.fileId);
        }
    }

    async _save() {
        if (!this.dirty || this.readOnly || this._saving) return;
        this._saving = true;
        this.saveBtn.disabled = true;
        const text = this.ace.getValue();
        try {
            const r = await fetch('/upload-file?overwrite=1&path=' + encodeURIComponent(this.path),
                { method: 'PUT', body: new Blob([text], { type: 'text/x-tex' }) });
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
            if (this.ace.getValue() === text) this._setDirty(false);
            else this.saveBtn.disabled = false;
            this._status(`Saved ${new Date().toLocaleTimeString()}`, 'ok');
        } catch (err) {
            this._status('Could not save: ' + err.message, 'error');
            this.saveBtn.disabled = false;
        } finally {
            this._saving = false;
        }
    }

    async _build() {
        clearTimeout(this._timer);
        if (!this.ace || this._destroyed) return;
        // Edits during a build make one more build after it
        if (this.building) { this.again = true; return; }
        this.building = true;
        progressListeners.add(this._onProgress);
        try {
            this._status(ready ? 'Building…' : 'Loading LaTeXML…', 'busy');
            const { files, main, file } = await collectFiles(this.fileId, ctx.projectFiles);
            log.log(`Building ${main} with ${Object.keys(files).join(', ')}`);
            const wasReady = !!ready;
            const r = await convert(files, main);
            if (this._destroyed) return;
            if (r.html) {
                if (!this.iframe) {
                    this.frameWrap.innerHTML = '';
                    this.iframe = makeFrame('lx-frame');
                    this.frameWrap.appendChild(this.iframe);
                }
                showResult(this.iframe, r);
            }
            this._showMessages(logMessages(r.log), file, r);
            this._status(summary(r, wasReady, main, file), r.status >= 2 ? 'error' : r.status === 1 ? 'warn' : 'ok');
        } catch (err) {
            if (this._destroyed) return;
            if (err.message !== 'stopped') log.error('Build failed:', err);
            this._status(err.message === 'stopped' ? 'Stopped' : 'Could not build: ' + err.message, 'error');
        } finally {
            progressListeners.delete(this._onProgress);
            this.building = false;
            if (this.again && !this._destroyed) {
                this.again = false;
                this._build();
            }
        }
    }

    // The log's messages under the document, and on the editor's gutter for this file
    _showMessages(messages, file, r) {
        const here = m => m.file && (m.file === file || m.file.replace(/^\.\//, '') === file);
        this.ace.session.setAnnotations(messages.filter(here).map(m => ({
            row: m.line - 1, column: Math.max(0, m.col - 1), text: m.text, type: m.kind === 'error' ? 'error' : 'warning',
        })));
        this.messagesEl.innerHTML = '';
        const list = messages.length ? messages : (!r.html ? [{ kind: 'error', text: r.messages || 'No output' }] : []);
        for (const m of list) {
            const div = document.createElement('div');
            div.className = `lx-msg ${m.kind}${here(m) ? ' here' : ''}`;
            div.textContent = m.text;
            if (here(m)) {
                div.title = 'Go to line ' + m.line;
                div.onclick = () => {
                    this._setView(this.root.dataset.view === 'preview' ? 'both' : this.root.dataset.view);
                    this.ace.gotoLine(m.line, Math.max(0, m.col - 1), true);
                    this.ace.focus();
                };
            }
            this.messagesEl.appendChild(div);
        }
        this.messagesEl.hidden = !list.length;
    }

    _status(text, cls) {
        this.statusEl.textContent = text;
        this.statusEl.className = 'lx-status' + (cls ? ' ' + cls : '');
    }
}

registerPlugin({
    id: 'latexml',
    name: 'LaTeX (LaTeXML)',
    components: {
        latexEditor: LatexComponent,
    },
    contextMenuItems: [{
        label: 'Open in LaTeX workspace',
        canHandle: fileName => TEX_RE.test(fileName || ''),
        action: fileId => {
            const file = ctx && ctx.projectFiles[fileId];
            if (file) ctx.openEditorTab('latexEditor', { fileId }, `${file.name} [latex]`, 'latex-' + fileId);
        },
    }],
    init(c) { ctx = c; },
});

module.exports = { stopWorker, pickMain, logMessages };
