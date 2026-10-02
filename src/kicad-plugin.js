// --- KiCad Plugin ---
// Views KiCad 6+ schematics and boards with KiCanvas (https://kicanvas.org), a
// TypeScript/WebGL viewer loaded from kicanvas.org. KiCanvas names files by URL
// path, and ours are all /workspace-file?path=..., so the files are fetched here
// and handed to it as named inline sources: the opened file, the project's
// .kicad_pro/.kicad_sch/.kicad_pcb, and every sub-sheet the schematics reference.
const { insideArchive } = require('./browse-mode');
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const S = require('./kicad-sexpr');
const { placeSymbol, nextReference, referencePrefix, instanceInfo, ensureUuid, unitCount, snap } = require('./kicad-place');

const log = createLogger('KiCad');
const KICANVAS_URL = 'https://kicanvas.org/kicanvas/kicanvas.js';
const KICAD_RE = /\.(kicad_sch|kicad_pcb)$/i;
const MAX_FILES = 200;

let _kicanvasPromise = null;
function ensureKicanvasLoaded() {
    if (!_kicanvasPromise) {
        _kicanvasPromise = import(KICANVAS_URL).catch(err => {
            _kicanvasPromise = null;
            throw err;
        });
    }
    return _kicanvasPromise;
}

async function fetchText(path) {
    try {
        const resp = await fetch('/workspace-file?path=' + encodeURIComponent(path));
        return resp.ok ? await resp.text() : null;
    } catch (_) {
        return null;
    }
}

// Sheet files a schematic pulls in; paths are relative to the project folder
function sheetFiles(text) {
    const names = new Set();
    for (const m of text.matchAll(/\(property\s+"Sheet ?[Ff]ile"\s+"((?:[^"\\]|\\.)*)"/g)) names.add(m[1].replace(/\\(.)/g, '$1'));
    return [...names];
}

// Map of name (relative to the project folder) -> text
async function collectProject(dir, fileName, siblings) {
    const files = new Map();
    // A sub-sheet opened on its own belongs to the folder's project
    const projects = siblings.filter(n => n.endsWith('.kicad_pro'));
    let stem = fileName.replace(/\.[^.]+$/, '');
    if (!projects.includes(stem + '.kicad_pro') && projects.length === 1) stem = projects[0].replace(/\.kicad_pro$/, '');
    const wanted = [fileName, stem + '.kicad_pro', stem + '.kicad_sch', stem + '.kicad_pcb'];
    const tried = new Set();
    let queue = wanted;
    while (queue.length && files.size < MAX_FILES) {
        const next = [];
        await Promise.all(queue.map(async name => {
            if (tried.has(name)) return;
            tried.add(name);
            const text = await fetchText(dir + '/' + name);
            if (text === null) return;
            files.set(name, text);
            if (name.endsWith('.kicad_sch')) next.push(...sheetFiles(text));
        }));
        queue = next;
    }
    return files;
}

class KicadViewerComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = KicadViewerComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;

        this.root = container.element;
        this.root.classList.add('kicad-plugin-root');
        this._installStyles();
        this.root.innerHTML = '<div class="kicad-shell"><div class="kicad-message">Loading KiCanvas...</div></div>';
        this.shell = this.root.querySelector('.kicad-shell');
        this.message = this.root.querySelector('.kicad-message');
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (KicadViewerComponent._styleInstalled) return;
        KicadViewerComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.kicad-plugin-root{height:100%;background:#1e1e2e;overflow:hidden}
.kicad-shell{position:relative;height:100%}
.kicad-shell kicanvas-embed{display:block;position:absolute;inset:0}
.kicad-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#e8eaed;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.kicad-message[hidden]{display:none}
.kicad-message.error{color:#fecaca}
.kicad-toolbar{position:absolute;top:8px;left:8px;z-index:5;display:flex;gap:6px}
.kicad-toolbar button,.kicad-detail button{background:#313244;color:#e8eaed;border:1px solid #585b70;border-radius:4px;padding:4px 10px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.kicad-toolbar button:hover,.kicad-detail button:hover{background:#45475a}
.kicad-picker{position:absolute;top:40px;left:8px;z-index:6;width:min(420px,calc(100% - 16px));max-height:calc(100% - 56px);display:flex;flex-direction:column;background:#1e1e2e;color:#e8eaed;border:1px solid #585b70;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.5);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.kicad-picker[hidden],.kicad-detail[hidden],.kicad-banner[hidden],.kicad-toast[hidden],.kicad-unit-row[hidden]{display:none}
.kicad-picker-head{display:flex;gap:4px;padding:8px}
.kicad-picker input,.kicad-picker select{background:#11111b;color:#e8eaed;border:1px solid #585b70;border-radius:4px;padding:4px 6px;font:inherit;min-width:0}
.kicad-q{flex:1}
.kicad-close{background:none;border:none;color:#a6adc8;font-size:18px;cursor:pointer;padding:0 6px}
.kicad-results{overflow:auto;flex:1;min-height:60px;border-top:1px solid #313244;border-bottom:1px solid #313244}
.kicad-result{display:flex;gap:8px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.kicad-result:hover{background:#313244}
.kicad-result.selected{background:#45475a}
.kicad-id{font-family:ui-monospace,monospace;flex:none}
.kicad-desc{color:#a6adc8;overflow:hidden;text-overflow:ellipsis}
.kicad-detail{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px}
.kicad-chosen{flex-basis:100%;color:#cdd6f4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kicad-detail label{display:flex;align-items:center;gap:4px}
.kicad-value{width:8em}
.kicad-place{margin-left:auto;background:#1e66f5 !important;border-color:#1e66f5 !important}
.kicad-picker-status{padding:4px 8px;color:#a6adc8;font-size:12px}
.kicad-banner{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:5;background:#1e66f5;color:#fff;padding:4px 12px;border-radius:4px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;white-space:nowrap;max-width:calc(100% - 140px);overflow:hidden;text-overflow:ellipsis}
.kicad-placing kicanvas-embed{cursor:crosshair}
.kicad-toast{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);z-index:5;background:#313244;color:#e8eaed;padding:6px 12px;border-radius:4px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.kicad-toast.error{background:#7f1d1d}
`;
        document.head.appendChild(style);
    }

    async _init() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
            this._fail('KiCad viewing requires the server workspace.');
            return;
        }
        const abs = this.ctx.currentWorkspacePath + '/' + this.ctx.getRelativePath(this.fileId);
        const slash = abs.lastIndexOf('/');
        const dir = abs.slice(0, slash), name = abs.slice(slash + 1);
        let files;
        try {
            [files] = await Promise.all([collectProject(dir, name, this._siblingNames()), ensureKicanvasLoaded()]);
        } catch (err) {
            log.error('KiCanvas failed to load:', err);
            this._fail('Could not load KiCanvas from kicanvas.org: ' + err.message);
            return;
        }
        if (!files.has(name)) {
            this._fail(`Could not read ${name}.`);
            return;
        }
        const firstLine = files.get(name).trimStart().slice(0, 12);
        if (!firstLine.startsWith('(kicad_')) {
            this._fail(`${name} is not a KiCad 6+ file (KiCanvas can't read KiCad 5 and older).`);
            return;
        }
        this.dir = dir;
        this.files = files;
        this.stem = name.replace(/\.[^.]+$/, '');
        this.message.hidden = true;
        this._mountEmbed(name);
        if (name.endsWith('.kicad_sch') && !this._insideArchive(abs)) this._installSymbolTool();
        log.log(`Opened ${name} with ${files.size} project file(s)`);
    }

    // (Re)creates the viewer over this.files, on the given page; camera is a
    // view to return to ({x, y, zoom}) after a reload
    _mountEmbed(pageName, camera) {
        const old = this.embed;
        const embed = document.createElement('kicanvas-embed');
        embed.setAttribute('controls', 'full');
        embed.setAttribute('controlslist', 'nooverlay'); // no "tap to interact" veil
        // KiCanvas takes the first page it loads as the root schematic, so the
        // schematics go first (the project's own root before its sheets)
        const stem = this.stem;
        const rank = n => n === stem + '.kicad_sch' ? 0 : n.endsWith('.kicad_sch') ? 1 : n.endsWith('.kicad_pcb') ? 2 : 3;
        for (const [fileName, text] of [...this.files].sort((a, b) => rank(a[0]) - rank(b[0]))) {
            const source = document.createElement('kicanvas-source');
            source.setAttribute('name', fileName);
            source.textContent = text;
            embed.appendChild(source);
        }
        this.shell.insertBefore(embed, this.shell.firstChild);
        this.embed = embed;
        // The old viewer goes once the new one is up (KiCanvas still draws into
        // a viewer for a moment after it leaves the page)
        if (old) old.style.visibility = 'hidden';
        this._showPage(embed, pageName)
            .then(() => camera && this._restoreCamera(camera))
            .then(() => { if (old) setTimeout(() => old.remove(), 500); });
    }

    _insideArchive(abs) {
        return insideArchive(abs);
    }

    _app() {
        return this.embed && this.embed.shadowRoot && this.embed.shadowRoot.querySelector('kc-schematic-app, kc-board-app');
    }

    _viewer() {
        const app = this._app();
        return app && app.viewer;
    }

    _camera() {
        const v = this._viewer();
        const cam = v && v.viewport && v.viewport.camera;
        return cam ? { x: cam.center.x, y: cam.center.y, zoom: cam.zoom } : null;
    }

    async _restoreCamera(view) {
        for (let i = 0; i < 100; i++) {
            const v = this._viewer();
            if (v && v.loaded && v.loaded.isOpen && v.viewport) {
                v.viewport.camera.center.set(view.x, view.y);
                v.viewport.camera.zoom = view.zoom;
                v.draw();
                return;
            }
            await new Promise(r => setTimeout(r, 50));
        }
    }

    // The schematic page on screen (a sub-sheet when KiCanvas went into one)
    _activeSchematic() {
        const app = this._app();
        const page = app && app.project && app.project.active_page;
        const name = page && page.filename;
        return name && name.endsWith('.kicad_sch') && this.files.has(name) ? name : null;
    }

    // --- Adding symbols ---

    _installSymbolTool() {
        const bar = document.createElement('div');
        bar.className = 'kicad-toolbar';
        bar.innerHTML = '<button type="button" class="kicad-add" title="Add a symbol from the KiCad libraries (A)">+ Symbol</button>';
        this.shell.appendChild(bar);
        this.addBtn = bar.querySelector('.kicad-add');
        this.addBtn.onclick = () => this._openPicker();

        const picker = document.createElement('div');
        picker.className = 'kicad-picker';
        picker.hidden = true;
        picker.innerHTML = `
<div class="kicad-picker-head"><input type="search" class="kicad-q" placeholder="Search symbols: R, LED, Device:C, lm358, gnd…" spellcheck="false"><button type="button" class="kicad-close" title="Close">×</button></div>
<div class="kicad-results" role="listbox"></div>
<div class="kicad-detail" hidden>
  <div class="kicad-chosen"></div>
  <label>Value <input type="text" class="kicad-value" spellcheck="false"></label>
  <label class="kicad-unit-row">Unit <select class="kicad-unit"></select></label>
  <label>Rotation <select class="kicad-rot"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
  <button type="button" class="kicad-place">Place</button>
</div>
<div class="kicad-picker-status"></div>`;
        this.shell.appendChild(picker);
        this.picker = picker;
        const q = picker.querySelector('.kicad-q');
        q.addEventListener('input', () => {
            clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => this._search(q.value), 150);
        });
        q.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const first = this.picker.querySelector('.kicad-result');
                if (first) first.click();
                const btn = picker.querySelector('.kicad-place');
                if (!picker.querySelector('.kicad-detail').hidden) btn.focus();
            } else if (e.key === 'Escape') this._closePicker();
        });
        picker.addEventListener('keydown', e => { if (e.key === 'Escape') this._closePicker(); });
        picker.querySelector('.kicad-close').onclick = () => this._closePicker();
        picker.querySelector('.kicad-place').onclick = () => this._startPlacing();

        const banner = document.createElement('div');
        banner.className = 'kicad-banner';
        banner.hidden = true;
        this.shell.appendChild(banner);
        this.banner = banner;

        // A opens the picker, as in eeschema
        this.root.tabIndex = -1;
        this.root.addEventListener('keydown', e => {
            if (e.target.closest && e.target.closest('input, select, textarea')) return;
            if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey && !this.placing && this.picker.hidden) {
                e.preventDefault();
                this._openPicker();
            }
        });
    }

    _openPicker() {
        this.picker.hidden = false;
        const q = this.picker.querySelector('.kicad-q');
        q.focus();
        q.select();
        if (!this._searched) this._search(q.value);
    }

    _closePicker() {
        this.picker.hidden = true;
        this.root.focus();
    }

    async _search(query) {
        this._searched = true;
        const results = this.picker.querySelector('.kicad-results');
        const status = this.picker.querySelector('.kicad-picker-status');
        const seq = (this._searchSeq = (this._searchSeq || 0) + 1);
        status.textContent = 'Searching…';
        let data;
        try {
            const resp = await fetch('/kicad-symbols?' + new URLSearchParams({ q: query, project: this.dir }));
            if (!resp.ok) throw new Error(await resp.text());
            data = await resp.json();
        } catch (err) {
            if (seq === this._searchSeq) status.textContent = 'Search failed: ' + err.message;
            return;
        }
        if (seq !== this._searchSeq) return;
        results.textContent = '';
        if (!data.libraries) {
            status.textContent = 'No KiCad symbol libraries found on the server (install KiCad\'s symbols, or set KICAD_SYMBOL_DIR).';
            return;
        }
        for (const r of data.results) {
            const row = document.createElement('div');
            row.className = 'kicad-result';
            row.setAttribute('role', 'option');
            const id = document.createElement('span');
            id.className = 'kicad-id';
            id.textContent = r.lib + ':' + r.name;
            const desc = document.createElement('span');
            desc.className = 'kicad-desc';
            desc.textContent = r.desc;
            row.append(id, desc);
            row.title = r.desc;
            row.onclick = () => this._choose(r, row);
            results.appendChild(row);
        }
        status.textContent = data.total > data.results.length
            ? `${data.results.length} of ${data.total} matches in ${data.libraries} libraries`
            : `${data.total} match${data.total === 1 ? '' : 'es'} in ${data.libraries} libraries`;
    }

    async _choose(r, row) {
        for (const el of this.picker.querySelectorAll('.kicad-result.selected')) el.classList.remove('selected');
        row.classList.add('selected');
        const status = this.picker.querySelector('.kicad-picker-status');
        const detail = this.picker.querySelector('.kicad-detail');
        let text;
        try {
            const resp = await fetch('/kicad-symbol?' + new URLSearchParams({ lib: r.lib, name: r.name, project: this.dir }));
            if (!resp.ok) throw new Error(await resp.text());
            text = await resp.text();
        } catch (err) {
            status.textContent = `Could not load ${r.lib}:${r.name}: ${err.message}`;
            return;
        }
        const units = unitCount(S.parse(text));
        this.chosen = { lib: r.lib, name: r.name, text };
        detail.hidden = false;
        detail.querySelector('.kicad-chosen').textContent = `${r.lib}:${r.name}` + (r.desc ? ' — ' + r.desc : '');
        const valueMatch = /\(property\s+"Value"\s+"((?:[^"\\]|\\.)*)"/.exec(text);
        detail.querySelector('.kicad-value').value = valueMatch ? valueMatch[1].replace(/\\(.)/g, '$1') : r.name;
        const unit = detail.querySelector('.kicad-unit');
        unit.textContent = '';
        for (let u = 1; u <= units; u++) unit.add(new Option(String.fromCharCode(64 + Math.min(u, 26)) + (u > 26 ? u : ''), u));
        detail.querySelector('.kicad-unit-row').hidden = units < 2;
    }

    // target: the page to place on, when resuming after a reload (the new
    // viewer hasn't loaded a page yet)
    _startPlacing(target = this._activeSchematic()) {
        if (!this.chosen) return;
        if (!target) {
            this.picker.querySelector('.kicad-picker-status').textContent = 'Show a schematic page to place the symbol on.';
            return;
        }
        const d = this.picker.querySelector('.kicad-detail');
        this.placing = {
            ...this.chosen,
            value: d.querySelector('.kicad-value').value,
            unit: +d.querySelector('.kicad-unit').value || 1,
            angle: +d.querySelector('.kicad-rot').value || 0,
            target,
        };
        this.picker.hidden = true;
        this.shell.classList.add('kicad-placing');
        this._updateBanner();
        this.root.focus();
        const embed = this.embed;
        let down = null;
        const onDown = e => { down = { x: e.clientX, y: e.clientY }; };
        const onClick = e => {
            // A drag pans the view; only a click places
            if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
            const v = this._viewer();
            if (!v || !v.viewport) return;
            const rect = v.canvas.getBoundingClientRect();
            const p = v.viewport.camera.screen_to_world({ x: e.clientX - rect.left, y: e.clientY - rect.top });
            this._place(snap(p.x), snap(p.y));
        };
        const onKey = e => {
            if (e.key === 'Escape') this._stopPlacing();
            else if (e.key === 'r' || e.key === 'R') {
                this.placing.angle = (this.placing.angle + 90) % 360;
                this._updateBanner();
            }
        };
        embed.addEventListener('pointerdown', onDown, true);
        embed.addEventListener('click', onClick, true);
        this.root.addEventListener('keydown', onKey);
        this._placingCleanup = () => {
            embed.removeEventListener('pointerdown', onDown, true);
            embed.removeEventListener('click', onClick, true);
            this.root.removeEventListener('keydown', onKey);
        };
    }

    _updateBanner() {
        const p = this.placing;
        this.banner.textContent = `Click to place ${p.lib}:${p.name} (${p.angle}°) · R rotates · Esc stops`;
        this.banner.hidden = false;
    }

    _stopPlacing() {
        if (this._placingCleanup) this._placingCleanup();
        this._placingCleanup = null;
        this.placing = null;
        this.banner.hidden = true;
        this.shell.classList.remove('kicad-placing');
    }

    async _place(x, y) {
        const p = this.placing;
        const target = p && (this._activeSchematic() || p.target);
        if (!p || !target || this._saving) return;
        this._saving = true;
        try {
            const texts = [...this.files].filter(([n]) => n.endsWith('.kicad_sch')).map(([, t]) => t);
            const reference = nextReference(texts, referencePrefix(p.text));
            let sch = ensureUuid(this.files.get(target));
            const files = new Map(this.files).set(target, sch);
            const instance = instanceInfo(files, target, this.stem + '.kicad_sch', this.stem);
            sch = placeSymbol(sch, p.text, { x, y, angle: p.angle, unit: p.unit, value: p.value, reference, instance });
            await this._save(target, sch);
            this.files.set(target, sch);
            const camera = this._camera();
            this._mountEmbed(target, camera);
            // Re-arm placing on the new viewer: keep placing copies until Esc
            const again = { ...p };
            this._stopPlacing();
            this.chosen = again;
            this._resumePlacing({ ...again, target });
            this._toast(`Placed ${reference} at (${x}, ${y})`);
        } catch (err) {
            log.error('Placing failed:', err);
            this._toast('Could not place the symbol: ' + err.message, true);
        } finally {
            this._saving = false;
        }
    }

    _resumePlacing(p) {
        const d = this.picker.querySelector('.kicad-detail');
        d.querySelector('.kicad-value').value = p.value;
        d.querySelector('.kicad-unit').value = String(p.unit);
        d.querySelector('.kicad-rot').value = String(p.angle);
        this._startPlacing(p.target);
    }

    async _save(name, text) {
        const ctx = this.ctx;
        if (!ctx || !ctx.wsClient || !ctx.wsClient.isConnected()) throw new Error('not connected to the server');
        const result = await ctx.wsClient.wsRequest({ type: 'saveFile', workspacePath: this.dir, relativePath: name, content: text });
        if (!result || !result.success) throw new Error((result && result.error) || 'save failed');
        // An open text editor catches up through the file watcher; keep the
        // in-memory copy current for one that opens later
        const abs = this.dir + '/' + name;
        for (const [id, f] of Object.entries(ctx.projectFiles || {})) {
            if (f && typeof f.content === 'string' && ctx.currentWorkspacePath + '/' + ctx.getRelativePath(id) === abs) f.content = text;
        }
    }

    _toast(text, isError) {
        if (!this.toastEl) {
            this.toastEl = document.createElement('div');
            this.toastEl.className = 'kicad-toast';
            this.shell.appendChild(this.toastEl);
        }
        this.toastEl.textContent = text;
        this.toastEl.classList.toggle('error', !!isError);
        this.toastEl.hidden = false;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, isError ? 8000 : 2500);
    }

    // Names of the files next to the opened one (as far as the file tree knows them)
    _siblingNames() {
        const rel = this.ctx.getRelativePath(this.fileId);
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        const names = [];
        for (const id of Object.keys(this.ctx.projectFiles || {})) {
            const r = this.ctx.getRelativePath(id) || '';
            const p = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
            if (p === parent) names.push(r.slice(r.lastIndexOf('/') + 1));
        }
        return names;
    }

    // Show the opened file (KiCanvas starts on the root schematic)
    async _showPage(embed, fileName) {
        for (let i = 0; i < 200; i++) {
            const app = embed.shadowRoot && embed.shadowRoot.querySelector('kc-schematic-app, kc-board-app');
            const project = app && app.project;
            if (embed.loaded && project && project.active_page) {
                if (project.active_page.filename === fileName) return;
                const page = [...project.pages()].find(p => p.filename === fileName);
                if (page) project.set_active_page(page);
                return;
            }
            await new Promise(r => setTimeout(r, 100));
        }
    }

    _fail(message) {
        this.message.textContent = message;
        this.message.classList.add('error');
        this.message.hidden = false;
    }
}

registerPlugin({
    id: 'kicad',
    name: 'KiCad (KiCanvas)',
    components: {
        kicadViewer: KicadViewerComponent,
    },
    // Symbols can be added in the viewer; the rest is KiCad's (or a text editor's)
    newFileTypes: [
        { label: 'KiCad schematic', ext: 'kicad_sch', content: () => ensureUuid('(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")\n  (paper "A4")\n  (lib_symbols)\n)\n') },
        { label: 'KiCad board', ext: 'kicad_pcb', content: () => '(kicad_pcb (version 20240108) (generator "pcbnew") (generator_version "8.0")\n  (general (thickness 1.6))\n  (paper "A4")\n)\n' },
    ],
    contextMenuItems: [{
        label: 'Open in KiCanvas',
        canHandle: (fileName) => KICAD_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = KicadViewerComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('kicadViewer', { fileId }, `${file.name} [kicad]`, 'kicad-' + fileId);
        },
    }],
    init(ctx) {
        KicadViewerComponent._ctx = ctx;
    },
});
