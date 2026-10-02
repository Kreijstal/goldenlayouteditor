// --- JupyterLite Plugin ---
// Opens .ipynb notebooks in JupyterLite (jupyter.org/jupyterlite: JupyterLab and
// Notebook in the browser, Python through Pyodide). The server (jupyterlite.js)
// serves the site with the workspace as its file tree, so a notebook sees the
// files next to it; saves made in JupyterLite are written back here. A notebook
// that belongs to a book (Jupyter Book _toc.yml / myst.yml, or a folder of
// notebooks) gets a chapter list with previous/next to read it in order.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { ensureArchiveAccess } = require('./archive-fallback');
const { rejoinLines } = require('./notebook-lines');
const { attachShell, noteWrite } = require('./wanix-plugin');

const log = createLogger('JupyterLite');
const NOTEBOOK_RE = /\.ipynb$/i;
const TOC_RE = /^(_toc|myst)\.yml$/i; // a Jupyter Book's table of contents

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function base64url(text) {
    return bytesToBase64(new TextEncoder().encode(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Notebook JSON as Jupyter writes it (nbformat.writes: indent 1, sorted keys,
// multi-line strings as lists of lines, trailing newline), so saving an unchanged
// notebook leaves the file as it was ---

function splitLines(text) {
    return typeof text === 'string' ? text.match(/[^\n]*\n|[^\n]+$/g) || [] : text;
}

function splitBundle(bundle) {
    if (!bundle) return;
    for (const key of Object.keys(bundle)) {
        if (key.startsWith('text/') || key === 'application/javascript' || key === 'image/svg+xml') bundle[key] = splitLines(bundle[key]);
    }
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
}

function notebookText(nb) {
    nb = JSON.parse(JSON.stringify(nb));
    // What the Jupyter server drops before writing (nbformat strip_transient)
    if (nb.metadata) for (const k of ['orig_nbformat', 'orig_nbformat_minor', 'signature']) delete nb.metadata[k];
    for (const cell of nb.cells || []) {
        if (cell.metadata) delete cell.metadata.trusted;
        cell.source = splitLines(cell.source);
        if (cell.attachments) for (const a of Object.values(cell.attachments)) splitBundle(a);
        for (const out of cell.outputs || []) {
            if (out.output_type === 'stream') out.text = splitLines(out.text);
            else splitBundle(out.data);
        }
    }
    return JSON.stringify(sortKeys(nb), null, 1) + '\n';
}

class JupyterLiteComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = JupyterLiteComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.ui = this.state.ui || 'notebooks';

        this.root = container.element;
        this.root.classList.add('jlite-plugin-root');
        this._installStyles();
        this.root.innerHTML = `
<div class="jlite-shell">
  <div class="jlite-toolbar">
    <span class="jlite-book" hidden>
      <button type="button" class="jlite-prev" title="Previous chapter">‹</button>
      <select class="jlite-chapters" title="Chapters"></select>
      <button type="button" class="jlite-next" title="Next chapter">›</button>
    </span>
    <span class="jlite-title"></span>
    <span class="jlite-status"></span>
    <span class="jlite-ui" role="group" title="JupyterLite interface">
      <button type="button" data-ui="notebooks">Notebook</button><button type="button" data-ui="lab">Lab</button>
    </span>
  </div>
  <div class="jlite-host"><iframe class="jlite-frame" title="JupyterLite"></iframe><div class="jlite-message">Loading JupyterLite…</div></div>
</div>`;
        this.frame = this.root.querySelector('iframe');
        this.message = this.root.querySelector('.jlite-message');
        this.statusEl = this.root.querySelector('.jlite-status');
        this.titleEl = this.root.querySelector('.jlite-title');
        this.bookEl = this.root.querySelector('.jlite-book');
        this.select = this.root.querySelector('.jlite-chapters');
        this.root.querySelector('.jlite-prev').onclick = () => this._step(-1);
        this.root.querySelector('.jlite-next').onclick = () => this._step(1);
        this.select.onchange = () => this._openChapter(this.chapters[+this.select.value]);
        for (const b of this.root.querySelectorAll('.jlite-ui button')) {
            b.onclick = () => {
                if (b.dataset.ui === this.ui) return;
                this.ui = b.dataset.ui;
                this.state.ui = this.ui;
                if (this.container.setState) this.container.setState(this.state);
                this._load(this.current);
            };
        }
        this.frame.addEventListener('load', () => this._attach());
        if (container.on) container.on('destroy', () => { this._destroyed = true; });
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (JupyterLiteComponent._styleInstalled) return;
        JupyterLiteComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.jlite-plugin-root{height:100%;background:#fff;overflow:hidden}
.jlite-shell{display:flex;flex-direction:column;height:100%}
.jlite-toolbar{display:flex;align-items:center;gap:8px;padding:4px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden}
.jlite-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 9px;font:inherit;cursor:pointer}
.jlite-toolbar button:hover:not(:disabled){background:#444c56}
.jlite-toolbar button:disabled{opacity:.45;cursor:default}
.jlite-book{display:flex;align-items:center;gap:4px;min-width:0;flex:0 1 auto}
.jlite-book[hidden]{display:none}
.jlite-chapters{background:#22272e;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 4px;font:inherit;max-width:40vw;min-width:0}
.jlite-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.jlite-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis;min-width:0}
.jlite-status.error{color:#ffb4ab}
.jlite-ui{display:flex}
.jlite-ui[hidden]{display:none}
.jlite-ui button{border-radius:0}
.jlite-ui button:first-child{border-radius:4px 0 0 4px}
.jlite-ui button:last-child{border-radius:0 4px 4px 0;border-left:0}
.jlite-ui button.active{background:#539bf5;border-color:#539bf5;color:#fff}
.jlite-host{position:relative;flex:1;min-height:0}
.jlite-frame{display:block;width:100%;height:100%;border:0}
.jlite-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;background:#fff;color:#57606a;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.jlite-message[hidden]{display:none}
.jlite-message.error{color:#b42318}
`;
        document.head.appendChild(style);
    }

    async _init() {
        const ctx = this.ctx;
        if (!ctx || !this.fileData || !ctx.currentWorkspacePath) return this._fail('Notebooks need the server workspace.');
        const workspace = ctx.currentWorkspacePath.replace(/\/+$/, '') || '/';
        this.path = workspace.replace(/\/$/, '') + '/' + ctx.getRelativePath(this.fileId);
        this.titleEl.textContent = this.fileData.name;
        let info = {};
        try {
            const r = await fetch(`/jupyterlite-book?path=${encodeURIComponent(this.path)}&stop=${encodeURIComponent(workspace)}`);
            if (r.ok) info = await r.json();
        } catch (err) {
            log.warn('Book lookup failed:', err);
        }
        // Inside an archive there is no folder on disk: the notebook is handed to
        // JupyterLite directly and can be read and run, but not saved
        this.readOnly = info.onDisk === false;
        if (this.readOnly) {
            this.liteRoot = this.path.slice(0, this.path.lastIndexOf('/'));
            this._status('Read-only (inside an archive)');
            this.root.querySelector('.jlite-ui').hidden = true;
        } else {
            this.liteRoot = workspace;
            if (info.book) this._showBook(info.book);
            // A book's table of contents opens the book at its first chapter
            if (TOC_RE.test(this.fileData.name)) {
                if (!this.chapters || !this.chapters.length) return this._fail('No chapters found in ' + this.fileData.name);
                return this._load(this.chapters[0].path);
            }
        }
        this._load(this.path);
    }

    // The JupyterLite path of a workspace file
    _rel(abs) {
        return this.liteRoot === '/' ? abs.slice(1) : abs.slice(this.liteRoot.length + 1);
    }

    _load(abs) {
        this.current = abs;
        for (const b of this.root.querySelectorAll('.jlite-ui button')) b.classList.toggle('active', b.dataset.ui === this.uiFor(abs));
        this.titleEl.textContent = abs.slice(abs.lastIndexOf('/') + 1);
        // Lab, already running, opens the next chapter itself
        if (this.app && this.appUi === 'lab' && this.uiFor(abs) === 'lab') {
            this._syncBook();
            return this._openInApp(abs);
        }
        this.app = null;
        const base = new URL(`jupyterlite/r/${base64url(this.liteRoot)}/`, document.baseURI);
        const ui = this.uiFor(abs);
        const url = new URL(`${ui}/index.html`, base);
        this.appUi = ui;
        // Lab would restore the tabs of its last visit
        if (ui === 'lab') url.searchParams.set('reset', '');
        // Other files are opened once the app is up (_attach): only notebooks can go in the URL
        if (!this.readOnly && NOTEBOOK_RE.test(abs)) url.searchParams.set('path', this._rel(abs));
        this.pendingOpen = this.readOnly || !NOTEBOOK_RE.test(abs) ? abs : null;
        this.message.hidden = false;
        this.message.classList.remove('error');
        this.message.textContent = 'Loading JupyterLite…';
        this.frame.src = url.href;
        this._syncBook();
    }

    // Book chapters that aren't notebooks (MyST markdown) read best as a preview in
    // Lab; Lab also takes a notebook from an archive (the Notebook app needs a path)
    uiFor(abs) {
        return NOTEBOOK_RE.test(abs) && !this.readOnly ? this.ui : 'lab';
    }

    // Once the page inside is up: open what the URL couldn't, and write saves back
    async _attach() {
        let win, app;
        try {
            win = this.frame.contentWindow;
            if (!win || !/\/jupyterlite\//.test(win.location.pathname)) return;
        } catch {
            return;
        }
        const token = this.frame.src;
        for (let i = 0; i < 600 && !(app = win.jupyterapp); i++) await new Promise(r => setTimeout(r, 50));
        if (!app || this._destroyed || this.frame.src !== token) {
            if (!app) this._fail('JupyterLite did not start. Is it built? (scripts/build-jupyterlite.sh)');
            return;
        }
        await app.restored;
        if (app === this._attached) return; // the page loaded again (Lab's ?reset redirect)
        this._attached = app;
        this.message.hidden = true;
        const contents = app.serviceManager.contents;
        this.app = app;
        this._bridgeTerminals(app);
        if (this.pendingOpen) {
            const abs = this.pendingOpen;
            this.pendingOpen = null;
            await this._openInApp(abs);
        }
        if (!this.readOnly) contents.fileChanged.connect((_, change) => {
            if (change.type === 'save' && change.newValue && change.newValue.path) this._writeBack(contents, change.newValue.path);
        });
    }

    // JupyterLite's terminals (jupyterlite-terminal) run cockle, a shell of their
    // own. Instead, each terminal opened there becomes a session of the editor's
    // in-browser shell (src/wanix-plugin.js: rc, with cargo/rustc, clang and
    // .wasm programs), on the same files. The terminal client makes its shells
    // through createShell; headless ones (commands run for extensions) stay cockle.
    _bridgeTerminals(app) {
        const terminals = app.serviceManager.terminals;
        const client = terminals && [terminals._terminalAPIClient, terminals.terminalAPIClient]
            .find(c => c && typeof c.createShell === 'function');
        if (!client || client.__editorShell) return;
        client.__editorShell = true;
        const original = client.createShell.bind(client);
        client.createShell = async options => (/^\d+$/.test(options.shellId || '') ? this._editorShell(options) : original(options));
    }

    // An object doing what cockle's shell does for the terminal client: input,
    // size, start, dispose; output goes to options.outputCallback
    _editorShell(options) {
        const disposedListeners = new Set();
        let onData = null, detach = null, done = false;
        const decoder = new TextDecoder();
        const term = {
            cols: 80,
            rows: 24,
            write(data) {
                const text = typeof data === 'string' ? data : decoder.decode(data, { stream: true });
                if (text && !done) options.outputCallback(text);
            },
            writeln(text) { this.write(text + '\r\n'); },
            onData(fn) {
                onData = fn;
                return { dispose() { if (onData === fn) onData = null; } };
            },
        };
        // /drive is liteRoot; the shell's project/ is the workspace
        const workspace = (this.ctx.currentWorkspacePath || '').replace(/\/+$/, '');
        const lite = this.liteRoot.replace(/\/+$/, '');
        const inWorkspace = workspace && (lite === workspace || lite.startsWith(workspace + '/'));
        const sub = [inWorkspace ? lite.slice(workspace.length + 1) : '', (options.cwd || '').replace(/^\/+|\/+$/g, '')].filter(Boolean).join('/');
        const shell = {
            shellId: options.shellId,
            socket: undefined,
            isDisposed: false,
            ready: Promise.resolve(),
            disposed: {
                connect(fn) { disposedListeners.add(fn); return true; },
                disconnect(fn) { return disposedListeners.delete(fn); },
            },
            async start() {
                try {
                    detach = await attachShell(term, undefined, { dir: sub, onExit: () => shell.dispose() });
                    if (done) detach();
                } catch (err) {
                    log.warn('Shell failed:', err);
                    term.writeln(`\x1b[31mThe shell did not start: ${err.message || err}\x1b[0m`);
                }
            },
            async input(text) { if (onData) onData(text); },
            async setSize({ rows, columns }) { term.rows = rows; term.cols = columns; },
            themeChange() {},
            dispose() {
                if (done) return;
                done = true;
                shell.isDisposed = true;
                if (detach) detach();
                for (const fn of disposedListeners) fn(shell);
            },
        };
        return shell;
    }

    async _openInApp(abs) {
        const app = this.app;
        try {
            let path = this._rel(abs);
            if (this.readOnly) {
                await ensureArchiveAccess();
                const r = await fetch('/workspace-file?path=' + encodeURIComponent(abs));
                if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
                path = abs.slice(abs.lastIndexOf('/') + 1);
                await app.serviceManager.contents.save(path, { type: 'notebook', format: 'json', content: rejoinLines(JSON.parse(await r.text())) });
            }
            // One chapter at a time: close the others unless they have unsaved changes
            const chapters = new Set((this.chapters || []).map(c => this._rel(c.path)));
            for (const w of Array.from(app.shell.widgets('main'))) {
                const ctx = w.context;
                if (ctx && ctx.path !== path && chapters.has(ctx.path) && !(ctx.model && ctx.model.dirty)) w.close();
            }
            const markdown = /\.(md|markdown|myst)$/i.test(path);
            await app.commands.execute('docmanager:open', markdown ? { path, factory: 'Markdown Preview' } : { path });
        } catch (err) {
            log.error('Open failed:', err);
            this._status('Could not open: ' + err.message, true);
        }
    }

    async _writeBack(contents, rel) {
        const ctx = this.ctx;
        const abs = (this.liteRoot === '/' ? '' : this.liteRoot) + '/' + rel;
        const slash = abs.lastIndexOf('/');
        const name = abs.slice(slash + 1);
        try {
            if (!ctx.wsClient || !ctx.wsClient.isConnected()) throw new Error('not connected to the server');
            const m = await contents.get(rel, { content: true });
            let content, encoding;
            if (m.type === 'notebook') content = notebookText(await this._keepKernel(abs, m.content));
            else if (m.format === 'base64') { content = m.content; encoding = 'base64'; }
            else if (m.format === 'json') content = JSON.stringify(m.content, null, 2) + '\n';
            else content = m.content;
            // Saves come also when nothing changed: the terminal's shell writes back
            // every file it opens, even to read. Skip those, comparing with the file as
            // JupyterLite read it (a text file not in UTF-8 would be mangled otherwise)
            if (await this._unchanged(abs, content, encoding)) return;
            const result = await ctx.wsClient.wsRequest({
                type: 'saveFile',
                workspacePath: abs.slice(0, slash) || '/',
                relativePath: name,
                content,
                ...(encoding ? { encoding } : {}),
            });
            if (!result || !result.success) throw new Error((result && result.error) || 'save failed');
            // Keep open text editors of the file in step
            if (!encoding) for (const [id, f] of Object.entries(ctx.projectFiles)) {
                if (f && typeof f.content === 'string' && ctx.currentWorkspacePath.replace(/\/+$/, '') + '/' + ctx.getRelativePath(id) === abs) f.content = content;
            }
            log.log(`Saved ${abs}`);
            // The editor's shell has its own copy of the project: bring it up to date
            noteWrite(abs, encoding ? Uint8Array.from(atob(content.replace(/\s+/g, '')), c => c.charCodeAt(0)) : content);
            this._status(`Saved ${name} ${new Date().toLocaleTimeString()}`);
        } catch (err) {
            log.error('Save failed:', err);
            this._status(`Could not save ${name}: ${err.message}`, true);
        }
    }

    async _unchanged(abs, content, encoding) {
        try {
            const r = await fetch('/workspace-file?path=' + encodeURIComponent(abs), { cache: 'no-store' });
            if (!r.ok) return false;
            const bytes = new Uint8Array(await r.arrayBuffer());
            return encoding === 'base64' ? bytesToBase64(bytes) === content.replace(/\s+/g, '') : new TextDecoder().decode(bytes) === content;
        } catch {
            return false;
        }
    }

    // JupyterLite runs every notebook on its own Python kernel (Pyodide) and records
    // that in the notebook; the file keeps the kernel it had, for desktop Jupyter
    async _keepKernel(abs, nb) {
        try {
            const r = await fetch('/workspace-file?path=' + encodeURIComponent(abs), { cache: 'no-store' });
            const old = r.ok ? JSON.parse(await r.text()) : null;
            const spec = old && old.metadata && old.metadata.kernelspec;
            if (spec && nb.metadata) nb = { ...nb, metadata: { ...nb.metadata, kernelspec: spec } };
        } catch { /* a new file */ }
        return nb;
    }

    // --- Books ---

    _showBook(book) {
        this.book = book;
        // A book is its own file tree: its links from the book's folder then work
        if (book.kind === 'book') this.liteRoot = book.root;
        this.chapters = book.chapters.filter(c => c.path && c.path.startsWith(this.liteRoot === '/' ? '/' : this.liteRoot + '/'));
        if (this.chapters.length < (TOC_RE.test(this.fileData.name) ? 1 : 2)) return;
        this.select.textContent = '';
        let group = this.select;
        for (const c of book.chapters) {
            if (!c.path) {
                group = document.createElement('optgroup');
                group.label = c.caption;
                this.select.appendChild(group);
                continue;
            }
            const i = this.chapters.indexOf(c);
            if (i < 0) continue;
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = '\u2003'.repeat(Math.min(c.level, 4)) + c.title;
            group.appendChild(opt);
        }
        this.select.title = `${book.title || 'Book'}: ${this.chapters.length} chapters`;
        this.bookEl.hidden = false;
        this._syncBook();
    }

    _syncBook() {
        if (!this.chapters || this.bookEl.hidden) return;
        const i = this.chapters.findIndex(c => c.path === this.current);
        if (i >= 0) this.select.value = i;
        this.root.querySelector('.jlite-prev').disabled = i <= 0;
        this.root.querySelector('.jlite-next').disabled = i < 0 || i >= this.chapters.length - 1;
    }

    _step(delta) {
        const i = this.chapters.findIndex(c => c.path === this.current);
        const next = this.chapters[i + delta];
        if (next) this._openChapter(next);
    }

    _openChapter(chapter) {
        if (chapter && chapter.path !== this.current) this._load(chapter.path);
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(message) {
        this.message.hidden = false;
        this.message.classList.add('error');
        this.message.textContent = message;
    }
}

const EMPTY_NOTEBOOK = {
    cells: [{ cell_type: 'code', execution_count: null, id: 'c0de0001', metadata: {}, outputs: [], source: '' }],
    metadata: {
        kernelspec: { display_name: 'Python (Pyodide)', language: 'python', name: 'python' },
        language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
};

registerPlugin({
    id: 'jupyterlite',
    name: 'JupyterLite',
    components: {
        jupyterLite: JupyterLiteComponent,
    },
    newFileTypes: [{ label: 'Jupyter notebook', ext: 'ipynb', content: () => notebookText(EMPTY_NOTEBOOK) }],
    contextMenuItems: [{
        label: 'Open in JupyterLite',
        canHandle: (fileName) => NOTEBOOK_RE.test(fileName || '') || TOC_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = JupyterLiteComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('jupyterLite', { fileId }, `${file.name} [jupyter]`, 'jupyter-' + fileId);
        },
    }],
    init(ctx) {
        JupyterLiteComponent._ctx = ctx;
    },
});

module.exports = { notebookText };
