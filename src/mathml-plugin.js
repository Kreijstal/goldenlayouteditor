// --- MathML viewer ---
// MathML documents (.mml, .mathml; a .xml only when its root is <math>), each
// <math> in them typeset by MathJax (its MathML-to-SVG build, loaded from
// jsDelivr on first use), or, as a choice, drawn by the browser itself (MathML
// Core). The formulas follow the file's text as it is edited; + / − (or ctrl
// and the wheel) sizes them. Also draws thumbnails in the file browser's grid:
// the first formula.
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');

const LIB = 'https://cdn.jsdelivr.net/npm/mathjax@4.1.3/mml-svg.js';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

// Names only MathML documents have; .xml (anything) only when the root is <math>
const MATHML_NAME_RE = /\.(mml|mathml|xml)$/i;
const SHARED_NAME_RE = /\.xml$/i;

// The first element, after any XML declaration, comments, processing instructions and doctype, is <math> (prefixed or not)
function looksLikeMathml(text) {
    return /^﻿?(?:\s+|<\?[^]*?\?>|<!--[^]*?-->|<!DOCTYPE[^>[]*(?:\[[^]*?\])?\s*>)*<(?:[\w.-]+:)?math[\s>/]/.test(text.slice(0, 4096));
}

// A MathML document's name, and (once read) its text if it is MathML
function isMathmlFile(f) {
    if (!MATHML_NAME_RE.test(f.name) || f.viewType) return false;
    if (typeof f.content !== 'string') return !SHARED_NAME_RE.test(f.name);
    return !SHARED_NAME_RE.test(f.name) || looksLikeMathml(f.content);
}

const MIN_SIZE = 6, MAX_SIZE = 400, DEFAULT_SIZE = 24;
let _ctx = null;
let _lib = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load ' + src));
        document.head.appendChild(s);
    });
}

// MathJax, set up to typeset only when asked, each SVG with its own glyphs
// (so one can be moved anywhere, a thumbnail too)
function ensureLib() {
    if (!_lib) {
        _lib = (async () => {
            if (!window.MathJax || !window.MathJax.startup) {
                window.MathJax = {
                    startup: { typeset: false },
                    svg: { fontCache: 'local' },
                };
                await loadScript(LIB);
            }
            await window.MathJax.startup.promise;
            if (typeof window.MathJax.mathml2svgPromise !== 'function') throw new Error('MathJax did not load');
            return window.MathJax;
        })();
        _lib.catch(() => { _lib = null; });
    }
    return _lib;
}

function workspaceUrl(rel) {
    return resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + rel));
}

async function readText(file) {
    // (a file the browser lists but hasn't read yet holds '' until then)
    if (typeof file.content === 'string' && !file.lazy) return file.content;
    if (!_ctx || !_ctx.currentWorkspacePath) throw new Error('opening a project file needs the server workspace');
    const resp = await fetch(await workspaceUrl(_ctx.getRelativePath(file.id)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
}

// The document's <math> elements, as MathML text with its namespace, and
// whether each is inline; a document that isn't well-formed XML throws
function mathElements(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const bad = doc.getElementsByTagName('parsererror')[0];
    if (bad) {
        // (Chromium wraps the parser's message in a sentence for pages)
        const msg = bad.textContent.replace(/\s+/g, ' ').replace(/^This page contains the following errors: ?/, '').replace(/ ?Below is a rendering of the page up to the first error\.?$/, '');
        throw new Error('not well-formed XML: ' + msg.trim().slice(0, 200));
    }
    const root = doc.documentElement;
    const found = [];
    const walk = el => {
        if (el.localName === 'math' && (el.namespaceURI === MATHML_NS || !el.namespaceURI)) { found.push(el); return; }
        for (const c of el.children) walk(c);
    };
    walk(root);
    const ser = new XMLSerializer();
    return found.map(el => {
        // (MathJax and the browser only know <math> in the MathML namespace, unprefixed)
        let copy = el;
        if (el.namespaceURI !== MATHML_NS || el.prefix) {
            const html = document.implementation.createDocument(MATHML_NS, 'math', null);
            const rename = n => {
                if (n.nodeType !== 1) return html.importNode(n, true);
                const out = html.createElementNS(MATHML_NS, n.localName);
                for (const a of n.attributes) if (!/^xmlns(:|$)/.test(a.name)) out.setAttributeNS(a.namespaceURI, a.name, a.value);
                for (const c of n.childNodes) out.appendChild(rename(c));
                return out;
            };
            copy = rename(el);
        }
        // A formula on its own is set as a display (MathJax takes that from the attribute, not its option)
        const inline = el.getAttribute('display') === 'inline';
        if (!inline) copy.setAttribute('display', 'block');
        return { source: ser.serializeToString(copy), inline };
    });
}

// One formula as MathJax's SVG (in an <mjx-container>); MathML MathJax can't
// read is drawn as an error in it, and counted
async function typeset(item) {
    const MathJax = await ensureLib();
    const node = await MathJax.mathml2svgPromise(item.source, { display: !item.inline });
    return { node, errors: node.querySelectorAll('[data-mjx-error], [data-mml-node="merror"]').length };
}

class MathmlComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.fileName = (this.fileId && _ctx && _ctx.projectFiles[this.fileId] || {}).name || 'formula.mml';
        this.renderer = this.state.renderer === 'browser' ? 'browser' : 'mathjax';
        this.size = DEFAULT_SIZE;
        this.source = null;
        this.shown = false;
        this.root = container.element;
        this.root.classList.add('mathml-root');
        MathmlComponent._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _installStyles() {
        if (MathmlComponent._styled) return;
        MathmlComponent._styled = true;
        const style = document.createElement('style');
        style.textContent = `
.mathml-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.mathml-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.mathml-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.mathml-root button,.mathml-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.mathml-root button:hover{background:#444c56}
.mathml-title{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mathml-zoom{min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
.mathml-stage{overflow:auto;min-height:0;background:#ffffff;color:#000000;outline:none}
.mathml-page{padding:24px;display:flex;flex-direction:column;align-items:center;gap:1.2em;min-width:min-content}
.mathml-formula{max-width:100%}
.mathml-formula math{font-family:"STIX Two Math","Latin Modern Math","Cambria Math",math}
.mathml-status{display:flex;gap:14px;padding:3px 8px;background:#22272e;border-top:1px solid #444c56;color:#adbac7;white-space:nowrap;overflow:hidden}
.mathml-status .mathml-warn{color:#e3b341;overflow:hidden;text-overflow:ellipsis}
.mathml-message{padding:20px;color:#57606a;text-align:center}
.mathml-error{padding:20px;color:#cf222e;text-align:center;white-space:pre-wrap}
`;
        document.head.appendChild(style);
    }

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    _button(label, title, onClick) {
        const b = this._el('button', null, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _buildUI() {
        const shell = this._el('div', 'mathml-shell');
        const bar = this._el('div', 'mathml-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.mml,.mathml,.xml';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            this.fileId = null;
            this.fileName = f.name;
            this._show(await f.text());
        });
        this.titleEl = this._el('span', 'mathml-title', this.fileName);
        this.rendererEl = this._el('select');
        this.rendererEl.title = 'Who draws the formulas';
        for (const [value, label] of [['mathjax', 'MathJax'], ['browser', 'Browser (MathML Core)']]) {
            const o = this._el('option', null, label);
            o.value = value;
            this.rendererEl.appendChild(o);
        }
        this.rendererEl.value = this.renderer;
        this.rendererEl.addEventListener('change', () => {
            this.renderer = this.rendererEl.value;
            if (this.source !== null) this._show(this.source);
        });
        this.zoomEl = this._el('span', 'mathml-zoom', '');
        bar.append(
            this.fileInput,
            this._button('Open', 'Open a MathML file from this computer', () => this.fileInput.click()),
            this.titleEl,
            this.rendererEl,
            this._button('−', 'Smaller (−)', () => this._zoomBy(1 / 1.25)),
            this.zoomEl,
            this._button('+', 'Larger (+)', () => this._zoomBy(1.25)),
            this._button('1:1', 'Usual size (0)', () => this._setSize(DEFAULT_SIZE)),
        );
        this.stage = this._el('div', 'mathml-stage');
        this.stage.tabIndex = 0;
        this.stage.appendChild(this._el('div', 'mathml-message', 'Open a MathML document.'));
        this.page = this._el('div', 'mathml-page');
        const status = this._el('div', 'mathml-status');
        this.infoEl = this._el('span', null, '');
        this.warnEl = this._el('span', 'mathml-warn', '');
        status.append(this.infoEl, this.warnEl);
        shell.append(bar, this.stage, status);
        this.root.appendChild(shell);
        this._setSize(this.size);
        this.stage.addEventListener('wheel', e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            this._zoomBy(2 ** (-e.deltaY * 0.002));
        }, { passive: false });
        this.stage.addEventListener('keydown', e => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const keys = { '+': 1.25, '=': 1.25, '-': 1 / 1.25 };
            if (keys[e.key]) { e.preventDefault(); this._zoomBy(keys[e.key]); }
            else if (e.key === '0') { e.preventDefault(); this._setSize(DEFAULT_SIZE); }
        });
    }

    _zoomBy(factor) {
        this._setSize(this.size * factor);
    }

    // Formulas are sized by the page's font size (MathJax's SVG is in ex)
    _setSize(px) {
        this.size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, px));
        this.page.style.fontSize = this.size + 'px';
        this.zoomEl.textContent = Math.round(this.size / DEFAULT_SIZE * 100) + '%';
    }

    async _init() {
        if (!this.fileId || !_ctx) return;
        const file = _ctx.projectFiles[this.fileId];
        if (!file) return;
        try {
            await this._show(await readText(file));
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
            return;
        }
        // Follow edits made in the file's editor tab
        this.watch = setInterval(() => {
            const f = _ctx.projectFiles[this.fileId];
            if (f && typeof f.content === 'string' && f.content !== this.source) this._show(f.content);
        }, 400);
    }

    async _show(text) {
        this.source = text;
        const seq = this.seq = (this.seq || 0) + 1;
        this.titleEl.textContent = this.fileName;
        const renderer = this.renderer;
        let items, nodes, errors = 0;
        try {
            items = mathElements(text);
            if (!items.length) throw new Error('no <math> element');
            if (renderer === 'mathjax') {
                nodes = [];
                for (const item of items) {
                    const r = await typeset(item);
                    nodes.push(r.node);
                    errors += r.errors;
                }
            } else {
                // The HTML parser puts <math> in the MathML namespace for the browser to draw
                nodes = items.map(item => {
                    const holder = document.createElement('div');
                    holder.innerHTML = item.source;
                    return holder.firstElementChild;
                });
            }
        } catch (err) {
            if (seq !== this.seq) return;
            // While the file is being edited, keep the last formulas and say what is wrong
            if (this.shown) { this.warnEl.textContent = `Not updated: ${err.message}`; return; }
            this._error(`Could not show ${this.fileName}: ${err.message}`);
            return;
        }
        if (seq !== this.seq) return;
        this.page.innerHTML = '';
        for (const n of nodes) {
            const box = this._el('div', 'mathml-formula');
            box.appendChild(n);
            this.page.appendChild(box);
        }
        if (!this.page.isConnected) { this.stage.innerHTML = ''; this.stage.appendChild(this.page); }
        this.shown = true;
        this.infoEl.textContent = `${items.length} formula${items.length === 1 ? '' : 's'} · ${renderer === 'mathjax' ? 'MathJax' : 'drawn by the browser'}`;
        this.warnEl.textContent = errors ? `${errors} part${errors === 1 ? '' : 's'} MathJax could not read (in red)` : '';
    }

    _error(msg) {
        this.shown = false;
        this.stage.innerHTML = '';
        this.stage.appendChild(this._el('div', 'mathml-error', msg));
    }

    _destroy() {
        clearInterval(this.watch);
    }
}

registerPlugin({
    id: 'mathml',
    name: 'MathML documents',
    components: {
        mathmlViewer: MathmlComponent,
    },
    toolbarButtons: [
        { label: 'MathML', title: 'Open the MathML viewer', menuLabel: 'MathML formulas (.mml)' },
    ],
    thumbnailRenderers: [{
        canHandle: file => MATHML_NAME_RE.test(file.name) && !file.viewType,
        async render(file, container) {
            const text = await readText(file);
            // .xml: the file's icon stays unless the root is <math>
            if (SHARED_NAME_RE.test(file.name) && !looksLikeMathml(text)) throw new Error('not a MathML document');
            const items = mathElements(text);
            if (!items.length) throw new Error('no <math> element');
            const svg = (await typeset(items[0])).node.querySelector('svg');
            if (!svg) throw new Error('nothing typeset');
            // Fitted to the tile, with its own proportions
            svg.removeAttribute('width');
            svg.removeAttribute('height');
            svg.removeAttribute('style');
            svg.style.cssText = 'width:88%;height:88%;color:#000000';
            const tile = document.createElement('div');
            tile.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#ffffff';
            tile.appendChild(svg);
            container.innerHTML = '';
            container.appendChild(tile);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { isMathmlFile };
