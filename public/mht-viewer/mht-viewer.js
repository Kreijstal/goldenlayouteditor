// MHTML web archive viewer (.mht, .mhtml), loaded on demand by
// src/mht-plugin.js. mht-parse.js reads the archive; here the saved page is
// rebuilt from its parts and shown in a sandboxed iframe: every reference in
// the HTML and CSS (src, srcset, stylesheets, url(), @import, style
// attributes, frames, cid:) points at the matching part. The page runs no
// scripts (sandbox without allow-scripts or allow-same-origin) and loads
// nothing from the network unless "Load remote content" is switched on (a CSP
// in each document). Links open in a new tab, never in the app. Beside it, the
// list of parts with their type, location, size and encoding; each one can be
// viewed or saved. Read-only.
//
// The sandboxed page has an opaque origin, and Chrome refuses blob: URLs from
// such a document ("Not allowed to load local resource", also for a link to
// "#section" in a page loaded from a blob: URL), so the page is the frame's
// srcdoc (as are the archived iframes in it) and the parts inside it are
// data: URLs. Parts saved from the list are blob: URLs, revoked when the tab
// closes.
import { parseMht, decodePartText, resolveUrl } from './mht-parse.js';

const MAX_FRAME_DEPTH = 8;
const EXT_BY_TYPE = {
    'text/html': 'html', 'application/xhtml+xml': 'xhtml', 'text/css': 'css', 'text/plain': 'txt', 'text/xml': 'xml', 'application/xml': 'xml',
    'application/javascript': 'js', 'text/javascript': 'js', 'application/x-javascript': 'js', 'application/json': 'json',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp', 'font/woff': 'woff', 'font/woff2': 'woff2',
    'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff': 'woff', 'application/x-font-woff': 'woff', 'application/pdf': 'pdf',
    'video/mp4': 'mp4', 'audio/mpeg': 'mp3',
};

function installStyles() {
    if (document.getElementById('mht-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'mht-viewer-style';
    style.textContent = `
.mhtv{height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0}
.mhtv-meta{display:flex;flex-wrap:wrap;gap:4px 14px;padding:5px 10px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a;flex-shrink:0}
.mhtv-meta b{color:#24292f;font-weight:600}
.mhtv-meta .mhtv-url{font-family:ui-monospace,monospace;color:#0969da;word-break:break-all}
.mhtv-warn{padding:6px 10px;background:#fff8c5;border-bottom:1px solid #d4a72c;color:#6f4e00;font-size:12px;flex-shrink:0;max-height:80px;overflow:auto}
.mhtv-warn div{white-space:pre-wrap}
.mhtv-bar{display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid #ddd;background:#fafafa;flex-shrink:0;flex-wrap:wrap}
.mhtv-bar button{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 10px;font:inherit;cursor:pointer;color:#333}
.mhtv-bar button.active{background:#2d333b;color:#fff;border-color:#2d333b}
.mhtv-bar button.mhtv-remote.active{background:#9a6700;border-color:#9a6700}
.mhtv-bar .mhtv-showing{color:#666;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.mhtv-main{flex:1;min-height:0;display:flex}
.mhtv-page{flex:1;min-width:0;display:flex;background:#fff}
.mhtv-page iframe{flex:1;border:none;background:#fff;width:100%;height:100%}
.mhtv-parts{width:min(46%,520px);flex-shrink:0;border-left:1px solid #d0d7de;overflow:auto;background:#fff}
.mhtv-parts[hidden]{display:none}
.mhtv-table{border-collapse:collapse;font-size:12px;width:100%}
.mhtv-table th,.mhtv-table td{padding:3px 6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.mhtv-table th{position:sticky;top:0;background:#f6f8fa;font-weight:600;z-index:1}
.mhtv-table tr.sel td{background:#ddf4ff}
.mhtv-table td.mhtv-loc{font-family:ui-monospace,monospace;word-break:break-all;color:#24292f}
.mhtv-table td.mhtv-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.mhtv-table td.mhtv-type{white-space:nowrap}
.mhtv-table td.mhtv-act{white-space:nowrap}
.mhtv-table td.mhtv-act button{border:1px solid #ccc;background:#fff;border-radius:4px;padding:0 6px;font:inherit;cursor:pointer;margin-right:3px}
.mhtv-root{color:#1a7f37;font-weight:600}
.mhtv-error{padding:20px;color:#a33;white-space:pre-wrap}
@media (max-width:700px){.mhtv-main{flex-direction:column}.mhtv-parts{width:auto;height:45%;border-left:none;border-top:1px solid #d0d7de}}
`;
    document.head.appendChild(style);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function textDataUrl(text, type) {
    return `data:${type};charset=utf-8;base64,` + bytesToBase64(new TextEncoder().encode(text));
}

function escapeHtml(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function isHtml(part) {
    return part.type === 'text/html' || part.type === 'application/xhtml+xml';
}

function isTextual(part) {
    return /^text\//.test(part.type) || /(json|javascript|ecmascript|xml)$/.test(part.type);
}

// The name a saved part gets: the last segment of its location, else part-N plus the type's extension
function partFileName(part) {
    let name = part.name || '';
    if (!name && part.location && !/^cid:/i.test(part.location)) {
        const path = (resolveUrl(part.location, part.base || 'http://x/') || part.location).replace(/[?#].*$/, '');
        name = path.slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1).replace(/\/+$/, '');
        try { name = decodeURIComponent(name); } catch (e) { /* keep */ }
    }
    name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    const ext = EXT_BY_TYPE[part.type];
    if (!name) name = `part-${part.index + 1}` + (ext ? '.' + ext : '');
    else if (ext && !/\.[A-Za-z0-9]{1,5}$/.test(name)) name += '.' + ext;
    return name;
}

function saveBlobUrl(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// "a.png 1x, b.png 2x" → [{ url, descriptor }]
function parseSrcset(value) {
    const out = [];
    let i = 0;
    while (i < value.length) {
        while (i < value.length && /[\s,]/.test(value[i])) i++;
        if (i >= value.length) break;
        let j = i;
        while (j < value.length && !/\s/.test(value[j])) j++;
        let url = value.slice(i, j);
        let descriptor = '';
        if (url.endsWith(',')) {
            url = url.replace(/,+$/, '');
        } else {
            let k = j;
            let depth = 0;
            while (k < value.length && (value[k] !== ',' || depth)) {
                if (value[k] === '(') depth++;
                else if (value[k] === ')') depth--;
                k++;
            }
            descriptor = value.slice(j, k).trim();
            j = k + 1;
        }
        out.push({ url, descriptor });
        i = j;
    }
    return out;
}

// Rebuilds documents and stylesheets from the archive's parts
class Rebuilder {
    constructor(archive) {
        this.archive = archive;
        this.remote = false;
        this.reset();
    }

    reset() {
        this.dataUrls = new Map();  // part → data: URL (raw parts, and rewritten stylesheets)
        this.htmlUrls = new Map();  // part → data: URL of a rewritten document (<frame>s, links to other saved pages)
        this.srcdocs = new Map();   // part → rewritten document for an <iframe srcdoc>
        this.remoteRefs = new Set();
        this.missing = new Set();
    }

    csp() {
        const r = this.remote ? ' http: https:' : '';
        return `default-src 'none'; img-src data:${r}; style-src data: 'unsafe-inline'${r}; font-src data:${r}; media-src data:${r}; `
            + `frame-src data:${r}; child-src data:${r}; script-src 'none'; object-src 'none'; form-action 'none'`;
    }

    // What a reference becomes in the rebuilt page: a part's data: URL, a remote URL (left to the CSP), or nothing
    ref(ref, base, stack, kind) {
        if (ref == null) return ref;
        const raw = ref.trim();
        if (!raw || raw[0] === '#' || /^(data|about|javascript):/i.test(raw)) return raw;
        const part = this.archive.lookup(raw, base);
        if (part) {
            // A stylesheet by its type, or by how it is used (whatever type it was saved with)
            if (part.type === 'text/css' || (kind === 'stylesheet' && !/^(image|font|audio|video)\//.test(part.type))) return this.cssUrl(part, stack, base);
            if (isHtml(part) && kind === 'frame') return this.htmlUrl(part, stack);
            return this.rawUrl(part);
        }
        const abs = resolveUrl(raw, base);
        if (abs && /^https?:/i.test(abs)) {
            this.remoteRefs.add(abs);
            return abs;
        }
        this.missing.add(abs || raw);
        return 'about:invalid';
    }

    rawUrl(part) {
        let url = this.dataUrls.get(part);
        if (!url) {
            url = `data:${part.type || 'application/octet-stream'};base64,` + bytesToBase64(part.bytes);
            this.dataUrls.set(part, url);
        }
        return url;
    }

    // A stylesheet part, its references resolved against its own location; one with a cid: location
    // (Chrome's saved <style> elements) against the document that uses it
    cssUrl(part, stack = [], refBase = null) {
        if (this.dataUrls.has(part)) return this.dataUrls.get(part);
        if (stack.includes(part)) return 'about:invalid'; // an @import cycle
        const base = part.url && /^(https?|file|ftp):/i.test(part.url) ? part.url : refBase || part.base;
        const text = this.css(decodePartText(part, this.archive.warnings).replace(/^@charset\s+"[^"]*"\s*;?/i, ''), base, [...stack, part]);
        const url = textDataUrl(text, 'text/css');
        this.dataUrls.set(part, url);
        return url;
    }

    // url(...) and @import "..." in a stylesheet, resolved against `base`
    css(text, base, stack = []) {
        return text
            .replace(/@import\s+(?:url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)"'\s]*))\s*\)|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/gi, (m, a, b, c, d, e) => {
                const ref = [a, b, c, d, e].find(x => x != null).replace(/\\(.)/g, '$1');
                return `@import url("${this.ref(ref, base, stack, 'stylesheet')}")`;
            })
            .replace(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)"'\s]*))\s*\)/gi, (m, a, b, c) => {
                const ref = (a != null ? a : b != null ? b : c).replace(/\\(.)/g, '$1');
                if (!ref || ref[0] === '#') return m;
                return `url("${this.ref(ref, base, stack, 'res').replace(/["\\\n]/g, ch => '\\' + ch.charCodeAt(0).toString(16) + ' ')}")`;
            });
    }

    htmlUrl(part, stack = []) {
        if (this.htmlUrls.has(part)) return this.htmlUrls.get(part);
        if (stack.includes(part) || stack.length >= MAX_FRAME_DEPTH) return 'about:blank';
        const url = textDataUrl(this.html(part, stack), 'text/html');
        this.htmlUrls.set(part, url);
        return url;
    }

    srcdoc(part, stack = []) {
        if (this.srcdocs.has(part)) return this.srcdocs.get(part);
        if (stack.includes(part) || stack.length >= MAX_FRAME_DEPTH) return '';
        const html = this.html(part, stack, { srcdoc: true });
        this.srcdocs.set(part, html);
        return html;
    }

    // A document with its references rewritten, a CSP and links that open in a new tab.
    // As a srcdoc, its base is about:srcdoc: "#section" links then stay in it (instead of resolving against the app)
    html(part, stack = [], opts = {}) {
        stack = [...stack, part];
        const doc = new DOMParser().parseFromString(decodePartText(part, this.archive.warnings), part.type === 'application/xhtml+xml' ? 'application/xhtml+xml' : 'text/html');
        if (doc.querySelector('parsererror') && part.type !== 'text/html') return this.html({ ...part, type: 'text/html' }, stack.slice(0, -1), opts);
        const docUrl = part.url || part.base || this.archive.root.url;
        let base = docUrl;
        const baseEl = doc.querySelector('base[href]');
        if (baseEl) base = resolveUrl(baseEl.getAttribute('href'), docUrl) || docUrl;
        for (const e of doc.querySelectorAll('base')) e.remove();
        // Things that would navigate or reach the network on their own
        for (const e of doc.querySelectorAll('meta[http-equiv]')) {
            if (/^(refresh|set-cookie)$/i.test(e.getAttribute('http-equiv').trim())) e.remove();
        }
        for (const e of doc.querySelectorAll('link[rel]')) {
            if (/\b(dns-prefetch|preconnect|prefetch|prerender|preload|modulepreload|manifest|serviceworker)\b/i.test(e.getAttribute('rel'))) e.remove();
        }

        const ref = (v, kind) => this.ref(v, base, stack, kind);
        const setAttr = (e, name, kind) => {
            const v = e.getAttribute(name);
            if (v != null && v.trim() !== '') e.setAttribute(name, ref(v, kind));
        };
        for (const e of doc.querySelectorAll('[style]')) e.setAttribute('style', this.css(e.getAttribute('style'), base, stack));
        for (const e of doc.querySelectorAll('style')) e.textContent = this.css(e.textContent, base, stack);
        for (const e of doc.querySelectorAll('link[href]')) setAttr(e, 'href', /stylesheet/i.test(e.getAttribute('rel') || '') ? 'stylesheet' : 'res');
        for (const e of doc.querySelectorAll('img, source, video, audio, track, embed, input, script')) setAttr(e, 'src', 'res');
        for (const e of doc.querySelectorAll('img[lowsrc], img[dynsrc]')) { setAttr(e, 'lowsrc', 'res'); setAttr(e, 'dynsrc', 'res'); }
        for (const e of doc.querySelectorAll('[srcset]')) {
            e.setAttribute('srcset', parseSrcset(e.getAttribute('srcset')).map(c => ref(c.url, 'res') + (c.descriptor ? ' ' + c.descriptor : '')).join(', '));
        }
        for (const e of doc.querySelectorAll('[background]')) setAttr(e, 'background', 'res');
        for (const e of doc.querySelectorAll('video[poster]')) setAttr(e, 'poster', 'res');
        for (const e of doc.querySelectorAll('object[data]')) setAttr(e, 'data', 'res');
        // Archived iframes become srcdoc frames; <frame> has no srcdoc, so a data: URL
        for (const e of doc.querySelectorAll('iframe, frame')) {
            e.removeAttribute('srcdoc');
            const src = e.getAttribute('src');
            const target = src && this.archive.lookup(src, base);
            if (target && isHtml(target) && e.localName === 'iframe') {
                e.setAttribute('srcdoc', this.srcdoc(target, stack));
                e.removeAttribute('src');
            } else setAttr(e, 'src', 'frame');
        }
        // SVG <image>, <use>, <feImage>
        for (const e of doc.querySelectorAll('image, use, feImage, feimage')) {
            for (const name of ['href', 'xlink:href']) setAttr(e, name, 'res');
        }
        // Links: within the page they stay in the frame; anything else opens in a new tab
        for (const a of doc.querySelectorAll('a[href], area[href]')) {
            const href = a.getAttribute('href').trim();
            if (/^javascript:/i.test(href)) { a.removeAttribute('href'); continue; }
            const abs = href[0] === '#' ? null : resolveUrl(href, base);
            const hash = href[0] === '#' ? href : abs && abs.includes('#') && docUrl && abs.split('#')[0] === docUrl.split('#')[0] ? '#' + abs.split('#').slice(1).join('#') : null;
            if (hash) {
                a.setAttribute('href', hash);
                a.setAttribute('target', '_self');
                continue;
            }
            const target = this.archive.lookup(href, base);
            if (target && isHtml(target) && target !== part && stack.length < 3) {
                // Another page saved in the archive: shown in this frame
                a.setAttribute('href', this.htmlUrl(target, stack));
                a.setAttribute('target', '_self');
                continue;
            }
            if (abs) a.setAttribute('href', abs);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        }
        for (const f of doc.querySelectorAll('form')) f.removeAttribute('action');

        // Security policy and link target first in <head>, before anything that loads
        let head = doc.head;
        if (!head) {
            head = doc.createElement('head');
            doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
        }
        const meta = doc.createElement('meta');
        meta.setAttribute('http-equiv', 'Content-Security-Policy');
        meta.setAttribute('content', this.csp());
        const noPrefetch = doc.createElement('meta');
        noPrefetch.setAttribute('http-equiv', 'x-dns-prefetch-control');
        noPrefetch.setAttribute('content', 'off');
        const baseTarget = doc.createElement('base');
        if (opts.srcdoc) baseTarget.setAttribute('href', 'about:srcdoc');
        baseTarget.setAttribute('target', '_blank');
        head.prepend(meta, noPrefetch, baseTarget);

        const dt = doc.doctype;
        const doctype = dt ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? `${dt.publicId ? '' : ' SYSTEM'} "${dt.systemId}"` : ''}>\n` : '';
        return doctype + doc.documentElement.outerHTML;
    }
}

class MhtViewer {
    constructor(host, { bytes, name }) {
        installStyles();
        this.host = host;
        this.name = name || '';
        this.blobUrls = [];
        this.archive = parseMht(bytes); // throws on data that is not MHTML: the plugin shows the message
        this.root = el('div', 'mhtv');
        host.appendChild(this.root);
        this.rebuilder = new Rebuilder(this.archive);
        this.current = this.archive.root;
        this._render();
        this.show(this.archive.root);
    }

    get info() {
        const a = this.archive;
        return { parts: a.parts.length, root: a.root.index, subject: a.subject, snapshotUrl: a.snapshotUrl, warnings: a.warnings.slice(),
            remoteBlocked: this.rebuilder.remote ? 0 : this.rebuilder.remoteRefs.size, remote: this.rebuilder.remote, showing: this.current.index };
    }

    _blobUrl(data, type) {
        const url = URL.createObjectURL(new Blob([data], { type }));
        this.blobUrls.push(url);
        return url;
    }

    _render() {
        const a = this.archive;
        const meta = el('div', 'mhtv-meta');
        const field = (label, value, cls) => {
            if (!value) return;
            const span = el('span');
            span.append(el('b', null, label + ' '), el('span', cls, value));
            meta.appendChild(span);
        };
        field('Subject', a.subject);
        if (a.date) {
            const d = new Date(a.date);
            field('Date', isNaN(d) ? a.date : d.toLocaleString());
        }
        if (a.snapshotUrl) {
            const span = el('span');
            const link = el('a', 'mhtv-url', a.snapshotUrl);
            if (/^https?:/i.test(a.snapshotUrl)) {
                link.href = a.snapshotUrl;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            span.append(el('b', null, 'Saved from '), link);
            meta.appendChild(span);
        }
        field('Saved by', a.from && a.from.replace(/^[<"]\s*|\s*[>"]$/g, '').replace(/^Saved by\s+/i, ''));
        const total = a.parts.reduce((n, p) => n + p.bytes.length, 0);
        field('Parts', `${a.parts.length} · ${fmtSize(total)}`);
        this.root.appendChild(meta);

        this.warnEl = el('div', 'mhtv-warn');
        this.warnEl.hidden = true;
        this.root.appendChild(this.warnEl);

        const bar = el('div', 'mhtv-bar');
        this.pageBtn = el('button', null, 'Page');
        this.pageBtn.title = 'Show the saved page';
        this.pageBtn.onclick = () => this.show(a.root);
        this.remoteBtn = el('button', 'mhtv-remote', 'Load remote content');
        this.remoteBtn.title = 'Let the page load what the archive does not hold from the web';
        this.remoteBtn.hidden = true;
        this.remoteBtn.onclick = () => this.setRemote(!this.rebuilder.remote);
        this.showingEl = el('span', 'mhtv-showing');
        this.partsBtn = el('button', null, `Parts (${a.parts.length})`);
        this.partsBtn.title = 'List the archive\'s parts';
        this.partsBtn.onclick = () => this._toggleParts();
        bar.append(this.pageBtn, this.remoteBtn, this.showingEl, this.partsBtn);
        this.root.appendChild(bar);

        const main = el('div', 'mhtv-main');
        this.pageEl = el('div', 'mhtv-page');
        this.partsEl = el('div', 'mhtv-parts');
        main.append(this.pageEl, this.partsEl);
        this.root.appendChild(main);
        this._renderParts();
        this.partsEl.hidden = (this.host.clientWidth || window.innerWidth) < 900;
        this.partsBtn.classList.toggle('active', !this.partsEl.hidden);
    }

    _renderParts() {
        const table = el('table', 'mhtv-table');
        const head = table.createTHead().insertRow();
        for (const h of ['#', 'Type', 'Location', 'Size', 'Encoding', '']) head.appendChild(el('th', null, h));
        const body = table.createTBody();
        this.rows = new Map();
        for (const p of this.archive.parts) {
            const tr = body.insertRow();
            this.rows.set(p, tr);
            const num = tr.insertCell();
            num.textContent = String(p.index + 1);
            if (p.isRoot) {
                num.className = 'mhtv-root';
                num.title = 'The page (root part)';
                num.textContent += ' ★';
            }
            const type = tr.insertCell();
            type.className = 'mhtv-type';
            type.textContent = p.type + (p.charset ? `; ${p.charset}` : '');
            if (p.declaredType !== p.type) type.title = `Saved as ${p.declaredType}; ${p.type} by its name`;
            const loc = tr.insertCell();
            loc.className = 'mhtv-loc';
            loc.textContent = p.location || (p.cid ? 'cid:' + p.cid : '—');
            if (p.cid && p.location) loc.title = 'Content-ID: ' + p.cid;
            const size = tr.insertCell();
            size.className = 'mhtv-num';
            size.textContent = fmtSize(p.bytes.length);
            size.title = `${p.bytes.length.toLocaleString()} bytes decoded, ${p.encodedSize.toLocaleString()} in the archive`;
            tr.insertCell().textContent = p.encoding;
            const act = tr.insertCell();
            act.className = 'mhtv-act';
            const view = el('button', null, 'View');
            view.title = 'Show this part';
            view.onclick = () => this.show(p);
            const save = el('button', null, 'Save');
            save.title = 'Save as ' + partFileName(p);
            save.onclick = () => this.save(p);
            act.append(view, save);
        }
        this.partsEl.appendChild(table);
    }

    _toggleParts() {
        this.partsEl.hidden = !this.partsEl.hidden;
        this.partsBtn.classList.toggle('active', !this.partsEl.hidden);
    }

    setRemote(on) {
        this.rebuilder.remote = !!on;
        this.show(this.current);
    }

    save(part) {
        // A Blob of the decoded part, as the archive holds it (not rewritten)
        saveBlobUrl(this._blobUrl(part.bytes, part.type || 'application/octet-stream'), partFileName(part));
    }

    // Shows a part in the frame: a page rebuilt from the archive, an image, text, or what it is
    show(part) {
        this.current = part;
        const rb = this.rebuilder;
        rb.reset();
        let html;
        try {
            if (isHtml(part)) html = rb.html(part, [], { srcdoc: true });
            else html = this._partPage(part);
        } catch (err) {
            html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><pre style="color:#a33;white-space:pre-wrap">Could not show part ${part.index + 1}: ${escapeHtml(String(err.message))}</pre>`;
        }
        const frame = document.createElement('iframe');
        // No allow-scripts, no allow-same-origin: an opaque origin that runs nothing; links may open (as new tabs) only
        frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = 'Archived page';
        frame.srcdoc = html;
        this.pageEl.replaceChildren(frame);
        this.frame = frame;

        for (const [p, tr] of this.rows) tr.classList.toggle('sel', p === part);
        this.pageBtn.classList.toggle('active', part === this.archive.root);
        this.showingEl.textContent = part === this.archive.root ? '' : `Part ${part.index + 1}: ${part.location || part.cid || part.type}`;
        const blocked = rb.remoteRefs.size;
        this.remoteBtn.hidden = !blocked && !rb.remote;
        this.remoteBtn.classList.toggle('active', rb.remote);
        this.remoteBtn.textContent = rb.remote ? `Remote content on (${blocked})` : `Load remote content (${blocked} blocked)`;
        this.remoteBtn.title = rb.remote
            ? 'Remote content is loaded from the web; click to block it again'
            : 'References not in the archive, blocked:\n' + [...rb.remoteRefs].slice(0, 15).join('\n') + (blocked > 15 ? `\n… and ${blocked - 15} more` : '');
        this._showWarnings();
    }

    _showWarnings() {
        const list = [...new Set(this.archive.warnings)];
        this.warnEl.replaceChildren(...list.map(w => el('div', null, '⚠ ' + w)));
        this.warnEl.hidden = !list.length;
    }

    // A page for a part that is not HTML: images and media shown, text as text, anything else described
    _partPage(part) {
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'">`;
        const style = '<style>body{margin:0;font:13px ui-monospace,monospace;background:#fff;color:#222}pre{margin:0;padding:10px;white-space:pre-wrap;word-break:break-all}.c{display:flex;align-items:center;justify-content:center;min-height:100vh;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}.c img,.c video{max-width:100%;max-height:100vh}.i{padding:20px;font-family:system-ui,sans-serif}</style>';
        const url = this.rebuilder.rawUrl(part);
        let body;
        if (/^image\//.test(part.type)) body = `<div class="c"><img src="${url}" alt=""></div>`;
        else if (/^video\//.test(part.type)) body = `<div class="c"><video controls src="${url}"></video></div>`;
        else if (/^audio\//.test(part.type)) body = `<div class="c"><audio controls src="${url}"></audio></div>`;
        else if (isTextual(part)) body = `<pre>${escapeHtml(decodePartText(part, this.archive.warnings))}</pre>`;
        else body = `<div class="i">${escapeHtml(part.type)}, ${part.bytes.length.toLocaleString()} bytes: no preview. Use Save to keep it.</div>`;
        return `<!doctype html><html><head><meta charset="utf-8">${csp}${style}</head><body>${body}</body></html>`;
    }

    destroy() {
        for (const url of this.blobUrls) URL.revokeObjectURL(url);
        this.blobUrls = [];
        if (this.frame) this.frame.srcdoc = '';
        this.root.remove();
    }
}

export function mountMhtViewer(host, opts) {
    return new MhtViewer(host, opts);
}
