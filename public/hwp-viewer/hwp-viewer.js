// Hangul Word Processor document viewer (.hwp 5.0, .hwp 3.x, .hwpx), loaded on
// demand by src/hwp-plugin.js. The engine is rhwp (github.com/edwardkim/rhwp,
// MIT; what @rhwp/core and nextcloud-hwp use), built to WebAssembly by
// ~/git/rhwp-wasm/build.sh and loaded from @kreijstal/rhwp-wasm on jsDelivr: it parses the document,
// lays it out as Hancom does and draws each page as SVG. Pages are shown one
// under the other, drawn when they scroll into view; with page navigation, zoom
// and a password prompt for encrypted documents. Read-only.
//
// rhwp's SVG names the Hancom fonts and then open replacements (Noto Sans KR,
// Noto Serif KR, Nanum Gothic, Nanum Myeongjo); those come from Google Fonts so
// Korean text has glyphs on machines without Korean fonts.

const ENGINE_JS = 'https://cdn.jsdelivr.net/npm/@kreijstal/rhwp-wasm@0.8.6-build.1/rhwp.js';
const ENGINE_WASM = 'https://cdn.jsdelivr.net/npm/@kreijstal/rhwp-wasm@0.8.6-build.1/rhwp_bg.wasm';
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&family=Noto+Serif+KR:wght@400;700&family=Nanum+Gothic:wght@400;700&family=Nanum+Myeongjo:wght@400;700&display=swap';
const FONT_FAMILIES = ['Noto Sans KR', 'Noto Serif KR', 'Nanum Gothic', 'Nanum Myeongjo'];
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const PAGE_GAP = 12;
// Pages kept drawn around the ones in view; further ones are dropped again
const KEEP_DRAWN = 6;

let _enginePromise = null;

function loadEngine() {
    if (!_enginePromise) {
        _enginePromise = import(ENGINE_JS).then(async (mod) => {
            await mod.default({ module_or_path: ENGINE_WASM });
            return mod;
        }).catch((err) => { _enginePromise = null; throw err; });
    }
    return _enginePromise;
}

// The Korean web fonts: the stylesheet once, then the faces the pages use (Hangul and Latin subsets)
let _fontsPromise = null;
function loadFonts() {
    if (!_fontsPromise) {
        if (!document.getElementById('hwp-viewer-fonts')) {
            const link = document.createElement('link');
            link.id = 'hwp-viewer-fonts';
            link.rel = 'stylesheet';
            link.href = FONTS_CSS;
            document.head.appendChild(link);
            _fontsPromise = new Promise((resolve) => { link.onload = link.onerror = resolve; })
                .then(() => Promise.all(FONT_FAMILIES.flatMap(f => ['400', '700'].map(w =>
                    document.fonts.load(`${w} 16px "${f}"`, '한글 Hangul').catch(() => null)))))
                .then(() => {}, () => {});
        } else {
            _fontsPromise = Promise.resolve();
        }
    }
    return _fontsPromise;
}

function installStyles() {
    if (document.getElementById('hwp-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'hwp-viewer-style';
    style.textContent = `
.hwpv{height:100%;display:flex;flex-direction:column;background:#e8eaed;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",sans-serif;min-height:0}
.hwpv-bar[hidden]{display:none}
.hwpv-bar{display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid #d0d7de;background:#f6f8fa;flex-shrink:0;flex-wrap:wrap}
.hwpv-bar button,.hwpv-bar select{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 9px;font:inherit;cursor:pointer;color:#333;min-height:26px}
.hwpv-bar button:disabled{opacity:.45;cursor:default}
.hwpv-bar input{font:inherit;width:4em;padding:2px 4px;border:1px solid #ccc;border-radius:4px;text-align:right}
.hwpv-bar .hwpv-sep{width:1px;align-self:stretch;background:#d0d7de;margin:0 2px}
.hwpv-scroll{flex:1;min-height:0;overflow:auto;position:relative}
.hwpv-pages{display:flex;flex-direction:column;align-items:center;gap:${PAGE_GAP}px;padding:${PAGE_GAP}px;width:max-content;min-width:100%;box-sizing:border-box}
.hwpv-page{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);position:relative;flex-shrink:0}
.hwpv-page .hwpv-pending{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:12px}
.hwpv-msg{margin:24px auto;max-width:560px;padding:14px 18px;background:#fff;border:1px solid #d0d7de;border-radius:6px;line-height:1.5}
.hwpv-msg.err{border-color:#ff8182;background:#ffebe9;color:#82071e}
.hwpv-msg .hwpv-detail{margin-top:6px;font-size:12px;color:#6e7781;word-break:break-word}
.hwpv-msg form{display:flex;gap:6px;margin-top:10px}
.hwpv-msg input{flex:1;font:inherit;padding:4px 6px;border:1px solid #ccc;border-radius:4px;min-width:0}
.hwpv-msg button{font:inherit;padding:4px 12px;border:1px solid #2d333b;background:#2d333b;color:#fff;border-radius:4px;cursor:pointer}
.hwpv-msg .hwpv-pwerr{color:#cf222e;font-size:12px;margin-top:6px}
`;
    document.head.appendChild(style);
}

// rhwp reports errors in Korean; the kind of failure, in English, with its message as the detail
function describeError(err) {
    const msg = String((err && err.message) || err);
    if (/비밀번호가 필요|암호 문서/.test(msg)) return { password: true, text: 'This document is password-protected.', detail: msg };
    if (/비밀번호가 일치하지 않/.test(msg)) return { password: true, wrong: true, text: 'The password is wrong.', detail: msg };
    if (/DRM/i.test(msg)) return { text: 'This document is DRM-protected and cannot be opened.', detail: msg };
    if (/UNSUPPORTED_FILE_FORMAT|알 수 없는 파일 형식/.test(msg)) return { text: 'This is not a Hangul (HWP/HWPX) document, or a kind rhwp does not read (it reads HWP 5.0, HWPX, HWP 3.0 and HWPML).', detail: msg };
    if (/지원하지 않는 포맷/.test(msg)) return { text: 'This kind of Hangul document is not supported.', detail: msg };
    if (/CFB|헤더 오류|FileHeader|DocInfo|BodyText|HWPX 오류|HWP 3\.0 오류|HML 오류|zip|압축|inflate|유효하지 않은 파일/i.test(msg)) return { text: 'The document is damaged and cannot be read.', detail: msg };
    if (/unreachable|RuntimeError|panicked/i.test(msg)) return { text: 'The document could not be read: the renderer failed on it (it may be damaged).', detail: msg };
    return { text: 'The document could not be opened.', detail: msg };
}

// Most of rhwp's font lists already end in the open Korean fonts; some (form controls: '맑은 고딕',sans-serif)
// go straight to the generic family, which has no Hangul where no Korean font is installed
function withKoreanFallback(svg) {
    return svg.replace(/font-family="([^"]*)"/g, (all, list) => {
        if (/Noto (Sans|Serif) KR|Nanum/.test(list)) return all;
        const serif = /(^|,)\s*serif\s*$/.test(list);
        const face = serif ? '&apos;Noto Serif KR&apos;' : '&apos;Noto Sans KR&apos;';
        return `font-family="${list.replace(/,?\s*(sans-serif|serif|monospace)\s*$/, '')},${face},${serif ? 'serif' : 'sans-serif'}"`;
    });
}

function formatName(bytes, info) {
    // by the file's signature: info.hwp3Variant is also set on HWP 5.0 files converted from 3.0
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'HWPX';
    if (bytes[0] === 0x48 && bytes[1] === 0x57 && bytes[2] === 0x50) return 'HWP 3.0';
    if (bytes[0] === 0x3c) return 'HWPML';
    return info && info.version ? `HWP ${info.version}` : 'HWP';
}

class HwpViewer {
    constructor(host, opts) {
        installStyles();
        this.host = host;
        this.bytes = opts.bytes;
        this.name = opts.name || '';
        this.onStatus = opts.onStatus || (() => {});
        this.doc = null;
        this.pages = [];       // { w, h, el, drawn }
        this.zoom = 1;
        this.fit = 'width';    // 'width' | 'page' | null (a fixed zoom)
        this.current = 0;
        this.destroyed = false;
        this.root = document.createElement('div');
        this.root.className = 'hwpv';
        this.root.innerHTML = `
<div class="hwpv-bar" hidden>
  <button class="hwpv-prev" title="Previous page (PageUp)">◀</button>
  <input class="hwpv-pageno" type="text" inputmode="numeric" aria-label="Page"> <span class="hwpv-count"></span>
  <button class="hwpv-next" title="Next page (PageDown)">▶</button>
  <span class="hwpv-sep"></span>
  <button class="hwpv-zout" title="Zoom out (Ctrl -)">−</button>
  <select class="hwpv-zoom" aria-label="Zoom"></select>
  <button class="hwpv-zin" title="Zoom in (Ctrl +)">+</button>
</div>
<div class="hwpv-scroll" tabindex="0"><div class="hwpv-msg">Loading the HWP engine…</div></div>`;
        host.appendChild(this.root);
        this.bar = this.root.querySelector('.hwpv-bar');
        this.scroller = this.root.querySelector('.hwpv-scroll');
        this.pageInput = this.root.querySelector('.hwpv-pageno');
        this.zoomSel = this.root.querySelector('.hwpv-zoom');
        this._wire();
        this._open(null);
    }

    _wire() {
        const q = (s) => this.root.querySelector(s);
        q('.hwpv-prev').onclick = () => this.goTo(this.current - 1);
        q('.hwpv-next').onclick = () => this.goTo(this.current + 1);
        q('.hwpv-zin').onclick = () => this._stepZoom(1);
        q('.hwpv-zout').onclick = () => this._stepZoom(-1);
        this.pageInput.onchange = () => {
            const n = parseInt(this.pageInput.value, 10);
            if (n >= 1) this.goTo(n - 1); else this._updateNav();
        };
        this.pageInput.onkeydown = (e) => { if (e.key === 'Enter') this.pageInput.onchange(); };
        this.zoomSel.onchange = () => {
            const v = this.zoomSel.value;
            if (v === 'width' || v === 'page') { this.fit = v; this._applyZoom(this._fitZoom(v)); }
            else { this.fit = null; this._applyZoom(parseFloat(v)); }
        };
        this.scroller.addEventListener('scroll', () => this._onScroll(), { passive: true });
        this.scroller.addEventListener('wheel', (e) => {
            if (!e.ctrlKey || !this.pages.length) return;
            e.preventDefault();
            this._stepZoom(e.deltaY < 0 ? 1 : -1);
        }, { passive: false });
        this.scroller.addEventListener('keydown', (e) => {
            if (!this.pages.length) return;
            if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); this._stepZoom(1); }
            else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); this._stepZoom(-1); }
            else if (e.key === 'PageDown' && !e.shiftKey) { e.preventDefault(); this.goTo(this.current + 1); }
            else if (e.key === 'PageUp') { e.preventDefault(); this.goTo(this.current - 1); }
            else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); this.goTo(0); }
            else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); this.goTo(this.pages.length - 1); }
        });
    }

    _message(text, detail, isError) {
        this.bar.hidden = true;
        this.scroller.innerHTML = `<div class="hwpv-msg${isError ? ' err' : ''}"><div class="hwpv-text"></div></div>`;
        const box = this.scroller.firstChild;
        box.querySelector('.hwpv-text').textContent = text;
        if (detail) {
            const d = document.createElement('div');
            d.className = 'hwpv-detail';
            d.textContent = detail;
            box.appendChild(d);
        }
        return box;
    }

    async _open(password) {
        let mod;
        try {
            [mod] = await Promise.all([loadEngine(), loadFonts()]);
        } catch (err) {
            this._message('Could not load the HWP engine (rhwp WebAssembly from jsDelivr).', String(err.message || err), true);
            this.onStatus('Engine not available', true);
            return;
        }
        if (this.destroyed) return;
        let doc;
        try {
            doc = password == null ? new mod.HwpDocument(this.bytes) : mod.HwpDocument.openWithPassword(this.bytes, password);
        } catch (err) {
            const e = describeError(err);
            if (e.password) return this._askPassword(e.wrong);
            this._message(e.text, e.detail, true);
            this.onStatus(e.text, true);
            return;
        }
        this.mod = mod;
        this.doc = doc;
        let info = {};
        try { info = JSON.parse(doc.getDocumentInfo()); } catch (e) { /* the pages still show */ }
        this.info = info;
        const count = doc.pageCount();
        if (!count) {
            this._message('The document has no pages.', null, false);
            this.onStatus(formatName(this.bytes, info) + ' · no pages', false);
            return;
        }
        this.pages = [];
        for (let i = 0; i < count; i++) {
            let w = 793.7, h = 1122.5; // A4 at 96 dpi
            try { const p = JSON.parse(doc.getPageInfo(i)); w = p.width || w; h = p.height || h; } catch (e) { /* keep A4 */ }
            this.pages.push({ w, h, el: null, drawn: false });
        }
        this._build();
        const fmt = formatName(this.bytes, info);
        const enc = info.encrypted || password != null ? ' · encrypted' : '';
        this.onStatus(`${fmt} · ${count} page${count === 1 ? '' : 's'}${enc} · read-only`, false);
    }

    _askPassword(wrong) {
        const box = this._message('This document is password-protected. Enter its password to open it.', null, false);
        const form = document.createElement('form');
        form.innerHTML = '<input type="password" autocomplete="off" placeholder="Password" aria-label="Password"><button type="submit">Open</button>';
        box.appendChild(form);
        if (wrong) {
            const e = document.createElement('div');
            e.className = 'hwpv-pwerr';
            e.textContent = 'The password is wrong.';
            box.appendChild(e);
        }
        const input = form.querySelector('input');
        form.onsubmit = (ev) => {
            ev.preventDefault();
            if (!input.value) return;
            this._message('Decrypting…', null, false);
            // let the message paint before the (synchronous) decryption
            setTimeout(() => this._open(input.value), 20);
        };
        this.onStatus(wrong ? 'Wrong password' : 'Password required', !!wrong);
        setTimeout(() => input.focus(), 0);
    }

    _build() {
        this.bar.hidden = false;
        this.scroller.textContent = '';
        this.pagesEl = document.createElement('div');
        this.pagesEl.className = 'hwpv-pages';
        this.pages.forEach((p, i) => {
            const el = document.createElement('div');
            el.className = 'hwpv-page';
            el.dataset.page = i + 1;
            el.innerHTML = `<div class="hwpv-pending">${i + 1}</div>`;
            p.el = el;
            this.pagesEl.appendChild(el);
        });
        this.scroller.appendChild(this.pagesEl);
        this.root.querySelector('.hwpv-count').textContent = '/ ' + this.pages.length;
        this.zoom = this._fitZoom(this.fit);
        this._layout();
        this._fillZoomSelect();
        this._updateNav();
        this._drawVisible();
    }

    _fitZoom(mode) {
        const cw = Math.max(100, this.scroller.clientWidth - 2 * PAGE_GAP - 4);
        const ch = Math.max(100, this.scroller.clientHeight - 2 * PAGE_GAP);
        const p = this.pages[this.current] || this.pages[0];
        const maxW = Math.max(...this.pages.map(pg => pg.w));
        if (mode === 'width') return Math.min(4, cw / maxW);
        if (mode === 'page') return Math.min(4, cw / p.w, ch / p.h);
        return this.zoom;
    }

    _fillZoomSelect() {
        const opts = [['width', 'Fit width'], ['page', 'Fit page']];
        for (const z of ZOOMS) opts.push([String(z), Math.round(z * 100) + '%']);
        if (!this.fit && !ZOOMS.includes(this.zoom)) opts.push([String(this.zoom), Math.round(this.zoom * 100) + '%']);
        this.zoomSel.innerHTML = '';
        for (const [v, label] of opts) {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = (v === this.fit) ? `${label} (${Math.round(this.zoom * 100)}%)` : label;
            this.zoomSel.appendChild(o);
        }
        this.zoomSel.value = this.fit || String(this.zoom);
    }

    _stepZoom(dir) {
        const z = this.zoom;
        const next = dir > 0 ? ZOOMS.find(v => v > z + 0.001) : [...ZOOMS].reverse().find(v => v < z - 0.001);
        if (next == null) return;
        this.fit = null;
        this._applyZoom(next);
    }

    _applyZoom(z) {
        if (!this.pages.length) return;
        // keep the same spot of the current page in view
        const page = this.pages[this.current];
        const offset = (this.scroller.scrollTop - page.el.offsetTop) / this.zoom;
        this.zoom = z;
        this._layout();
        this.scroller.scrollTop = page.el.offsetTop + offset * z;
        this._fillZoomSelect();
        this._drawVisible();
    }

    _layout() {
        for (const p of this.pages) {
            p.el.style.width = Math.round(p.w * this.zoom) + 'px';
            p.el.style.height = Math.round(p.h * this.zoom) + 'px';
        }
    }

    // Draws one page: its SVG in a shadow root of its own, so the clip-path ids of different pages do not clash
    _draw(i) {
        const p = this.pages[i];
        if (p.drawn) return;
        p.drawn = true;
        let svg;
        try {
            svg = this.doc.renderPageSvg(i);
        } catch (err) {
            p.el.innerHTML = '<div class="hwpv-pending" style="color:#a33;padding:12px;text-align:center"></div>';
            p.el.firstChild.textContent = `Page ${i + 1} could not be drawn: ${(err && err.message) || err}`;
            return;
        }
        const shadow = p.el.shadowRoot || p.el.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<style>:host{display:block}svg{display:block;width:100%;height:100%}</style>' + withKoreanFallback(svg);
    }

    _undraw(i) {
        const p = this.pages[i];
        if (!p.drawn) return;
        p.drawn = false;
        if (p.el.shadowRoot) p.el.shadowRoot.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font:12px sans-serif">${i + 1}</div>`;
    }

    // Pages overlapping the viewport (plus one either side)
    _visibleRange() {
        const top = this.scroller.scrollTop, bottom = top + this.scroller.clientHeight;
        let first = -1, last = -1;
        for (let i = 0; i < this.pages.length; i++) {
            const el = this.pages[i].el;
            const t = el.offsetTop, b = t + el.offsetHeight;
            if (b >= top && t <= bottom) { if (first < 0) first = i; last = i; }
            else if (t > bottom) break;
        }
        if (first < 0) first = last = this.current;
        return [Math.max(0, first - 1), Math.min(this.pages.length - 1, last + 1)];
    }

    _drawVisible() {
        if (!this.pages.length || this.destroyed) return;
        const [a, b] = this._visibleRange();
        for (let i = a; i <= b; i++) this._draw(i);
        this.pages.forEach((p, i) => { if (p.drawn && (i < a - KEEP_DRAWN || i > b + KEEP_DRAWN)) this._undraw(i); });
    }

    _onScroll() {
        if (this._scrollQueued) return;
        this._scrollQueued = true;
        requestAnimationFrame(() => {
            this._scrollQueued = false;
            if (this.destroyed || !this.pages.length) return;
            // the current page: the one under the upper third of the view
            const y = this.scroller.scrollTop + this.scroller.clientHeight / 3;
            let cur = 0;
            for (let i = 0; i < this.pages.length; i++) {
                if (this.pages[i].el.offsetTop <= y) cur = i; else break;
            }
            if (cur !== this.current) { this.current = cur; this._updateNav(); }
            this._drawVisible();
        });
    }

    _updateNav() {
        this.pageInput.value = this.current + 1;
        this.root.querySelector('.hwpv-prev').disabled = this.current <= 0;
        this.root.querySelector('.hwpv-next').disabled = this.current >= this.pages.length - 1;
    }

    goTo(i) {
        if (!this.pages.length) return;
        i = Math.max(0, Math.min(this.pages.length - 1, i));
        this.current = i;
        this.scroller.scrollTop = this.pages[i].el.offsetTop - PAGE_GAP;
        this._updateNav();
        this._drawVisible();
    }

    resize() {
        if (!this.pages.length || !this.fit) return;
        const z = this._fitZoom(this.fit);
        if (Math.abs(z - this.zoom) > 0.001) this._applyZoom(z);
    }

    destroy() {
        this.destroyed = true;
        if (this.doc) { try { this.doc.free(); } catch (e) { /* already gone */ } }
        this.doc = null;
        this.root.remove();
    }
}

export function mountHwpViewer(host, opts) {
    return new HwpViewer(host, opts);
}
