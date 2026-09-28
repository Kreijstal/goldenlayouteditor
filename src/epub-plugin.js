// --- EPUB Plugin ---
// Lazy-loads epub.js from esm.sh when an EPUB is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('EPUB');
const EPUBJS_URL = 'https://esm.sh/epubjs@0.3.93';

let _epubPromise = null;

async function ensureEpubLoaded() {
    if (!_epubPromise) {
        _epubPromise = (async () => {
            const mod = await import(EPUBJS_URL);
            const epub = mod.default || mod.ePub || mod;
            if (typeof epub !== 'function') throw new Error('epub.js did not export a reader factory');
            return epub;
        })();
    }
    return _epubPromise;
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

class EpubReaderComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = EpubReaderComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'book.epub';
        this.book = null;
        this.rendition = null;
        this.objectUrl = null;
        this.locationsReady = false;

        this.root = container.element;
        this.root.classList.add('epub-plugin-root');
        this._installStyles();
        this._buildUI();

        if (container.on) {
            container.on('resize', () => this._resize());
            container.on('destroy', () => this._destroy());
        }

        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (EpubReaderComponent._styleInstalled) return;
        EpubReaderComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.epub-plugin-root{height:100%;background:#f7f5ef;color:#24211c;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.epub-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.epub-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2f3437;color:#f3f4f6;border-bottom:1px solid #1f2326;white-space:nowrap;overflow:auto}
.epub-toolbar button,.epub-toolbar select{background:#454b50;color:#f3f4f6;border:1px solid #626a70;border-radius:4px;padding:4px 9px;font:inherit}
.epub-toolbar button{cursor:pointer}
.epub-toolbar button:hover{background:#565e64}
.epub-toolbar button:disabled{opacity:.45;cursor:not-allowed}
.epub-toolbar select{max-width:320px}
.epub-title{font-weight:600;min-width:80px;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.epub-status{margin-left:auto;color:#cbd5e1;font-size:12px}
.epub-stage{min-height:0;background:#f7f5ef;position:relative}
.epub-reader{position:absolute;inset:0}
.epub-message,.epub-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#6b6258}
.epub-error{color:#9f1239}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'epub-shell';

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'epub-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.epub,application/epub+zip';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local EPUB file', () => this.fileInput.click()));
        this.prevBtn = makeButton('Prev', 'Previous page', () => this._prev());
        this.nextBtn = makeButton('Next', 'Next page', () => this._next());
        this.toolbar.appendChild(this.prevBtn);
        this.toolbar.appendChild(this.nextBtn);

        this.chapterSelect = document.createElement('select');
        this.chapterSelect.title = 'Chapter';
        this.chapterSelect.disabled = true;
        this.chapterSelect.addEventListener('change', () => {
            if (this.rendition && this.chapterSelect.value) this.rendition.display(this.chapterSelect.value);
        });
        this.toolbar.appendChild(this.chapterSelect);

        this.titleEl = document.createElement('span');
        this.titleEl.className = 'epub-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);

        this.statusEl = document.createElement('span');
        this.statusEl.className = 'epub-status';
        this.toolbar.appendChild(this.statusEl);

        this.stage = document.createElement('div');
        this.stage.className = 'epub-stage';
        this.readerEl = document.createElement('div');
        this.readerEl.className = 'epub-reader';
        this.stage.appendChild(this.readerEl);

        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.stage);
        this.root.appendChild(this.shell);
        this._showMessage('Open an EPUB file to read it.');
    }

    async _init() {
        if (this.fileData) {
            await this._loadProjectFile();
        } else {
            this.statusEl.textContent = 'epub.js loads when an EPUB is opened';
        }
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed EPUB loading requires the server workspace.');
                return;
            }
            const relPath = this.ctx.getRelativePath(this.fileId);
            const url = '/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + relPath);
            await this._loadUrl(url, this.fileData.name);
        } catch (err) {
            this._showError(err.message);
        }
    }

    async _loadFileObject(file) {
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = URL.createObjectURL(file);
        this.fileId = null;
        this.fileData = null;
        await this._loadUrl(this.objectUrl, file.name);
    }

    async _loadUrl(url, name) {
        this._destroyBook();
        this.fileName = name || this.fileName;
        this.titleEl.textContent = this.fileName;
        this.statusEl.textContent = 'Loading epub.js...';
        this.readerEl.innerHTML = '';

        try {
            const ePub = await ensureEpubLoaded();
            this.statusEl.textContent = 'Opening EPUB...';
            this.book = ePub(url);
            this.book.opened.catch(err => this._showError(`Failed to open EPUB: ${err.message}`));
            await this.book.ready;

            this._populateChapters();
            this.rendition = this.book.renderTo(this.readerEl, {
                width: '100%',
                height: '100%',
                spread: 'auto',
                flow: 'paginated',
            });
            this.rendition.themes.default({
                body: {
                    color: '#24211c',
                    'font-family': 'Georgia, serif',
                    'line-height': '1.55',
                },
            });
            this.rendition.on('relocated', location => this._updateLocation(location));
            await this.rendition.display();
            this.statusEl.textContent = 'Ready';
        } catch (err) {
            this._showError(`Failed to open EPUB: ${err.message}`);
        }
    }

    _populateChapters() {
        this.chapterSelect.innerHTML = '';
        const nav = this.book && this.book.navigation;
        const toc = nav && Array.isArray(nav.toc) ? nav.toc : [];
        if (!toc.length) {
            this.chapterSelect.disabled = true;
            return;
        }

        const addItem = (item, depth = 0) => {
            const option = document.createElement('option');
            option.value = item.href || '';
            option.textContent = `${depth ? '  '.repeat(depth) : ''}${item.label || item.href || 'Chapter'}`;
            this.chapterSelect.appendChild(option);
            for (const child of item.subitems || []) addItem(child, depth + 1);
        };
        for (const item of toc) addItem(item);
        this.chapterSelect.disabled = false;
    }

    _updateLocation(location) {
        if (location && location.start && location.start.href) {
            const href = location.start.href;
            for (const option of this.chapterSelect.options) {
                if (option.value && href.includes(option.value.split('#')[0])) {
                    this.chapterSelect.value = option.value;
                    break;
                }
            }
        }
        const page = location && location.start && location.start.displayed
            ? `${location.start.displayed.page}/${location.start.displayed.total}`
            : '';
        const percent = location && location.start && typeof location.start.percentage === 'number'
            ? `${Math.round(location.start.percentage * 100)}%`
            : '';
        this.statusEl.textContent = [page, percent].filter(Boolean).join(' | ') || 'Ready';
    }

    async _prev() {
        if (!this.rendition) return;
        try { await this.rendition.prev(); } catch (err) { this._showError(err.message); }
    }

    async _next() {
        if (!this.rendition) return;
        try { await this.rendition.next(); } catch (err) { this._showError(err.message); }
    }

    _showMessage(message) {
        this.readerEl.innerHTML = `<div class="epub-message">${message}</div>`;
    }

    _showError(message) {
        log.error(message);
        this.readerEl.innerHTML = `<div class="epub-error">${message}</div>`;
        this.statusEl.textContent = 'Error';
    }

    _resize() {
        if (this.rendition && typeof this.rendition.resize === 'function') {
            this.rendition.resize(this.readerEl.clientWidth, this.readerEl.clientHeight);
        }
    }

    _destroyBook() {
        if (this.rendition && typeof this.rendition.destroy === 'function') {
            try { this.rendition.destroy(); } catch (_) { /* ignore */ }
        }
        this.rendition = null;
        if (this.book && typeof this.book.destroy === 'function') {
            try { this.book.destroy(); } catch (_) { /* ignore */ }
        }
        this.book = null;
        this.readerEl.innerHTML = '';
    }

    _destroy() {
        this._destroyBook();
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}

registerPlugin({
    id: 'epub',
    name: 'EPUB',
    components: {
        epubReader: EpubReaderComponent,
    },
    toolbarButtons: [
        { label: 'EPUB', title: 'Open EPUB Reader' },
    ],
    contextMenuItems: [{
        label: 'Open EPUB Reader',
        canHandle: (fileName) => /\.epub$/i.test(fileName || ''),
        action: (fileId) => {
            const ctx = EpubReaderComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab(
                'epubReader',
                { fileId },
                `${file.name} [epub]`,
                'epub-' + fileId
            );
        },
    }],
    init(ctx) {
        EpubReaderComponent._ctx = ctx;
    },
});
