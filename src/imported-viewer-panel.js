// Shared panel lifecycle for the imported document viewers.
const { resolveFileUrl } = require('./archive-fallback');
async function readBytes(file, ctx) {
    if (file.bytes instanceof Uint8Array) return file.bytes;
    if (file.bytes instanceof ArrayBuffer) return new Uint8Array(file.bytes);
    if (typeof file.content === 'string' && !file.lazy && !file.viewType) return new TextEncoder().encode(file.content);
    const rel = ctx.currentWorkspacePath && ctx.getRelativePath(file.id);
    if (!rel) throw new Error('No contents available for ' + file.name);
    const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + rel));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not read ${file.name}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}
function text(bytes) { return new TextDecoder().decode(bytes); }
function element(tag, value, parent) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (parent) parent.appendChild(node);
    return node;
}
function details(parent, label, value) {
    if (!value) return;
    const row = element('div', undefined, parent);
    row.style.cssText = 'margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere';
    element('strong', label + ': ', row);
    element('span', value, row);
}
function card(parent, title) {
    const node = element('article', undefined, parent);
    node.style.cssText = 'padding:16px;margin:12px;background:#2b3038;border:1px solid #49505c;border-radius:8px';
    element('h2', title, node).style.cssText = 'font-size:19px;margin:0 0 12px';
    return node;
}
class ImportedViewerPanel {
    constructor(container, state, ctx, options) {
        this.root = container.element;
        this.options = options;
        this.ctx = ctx;
        this.sequence = 0;
        this.destroyed = false;
        this.root.style.cssText += ';height:100%;display:flex;flex-direction:column;background:#20242a;color:#eee;font:14px system-ui;overflow:hidden';
        this.bar = element('div');
        this.bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px;flex-wrap:wrap';
        this.open = element('button', 'Open', this.bar);
        this.input = element('input', undefined, this.bar);
        this.input.type = 'file'; this.input.accept = options.accept; this.input.hidden = true;
        this.open.onclick = () => this.input.click();
        this.input.onchange = async () => {
            const file = this.input.files[0];
            if (file) await this.show(new Uint8Array(await file.arrayBuffer()), file.name);
        };
        if (options.search) {
            this.search = element('input', undefined, this.bar);
            this.search.type = 'search'; this.search.placeholder = options.search;
            this.search.setAttribute('aria-label', options.search);
            this.search.oninput = () => this.filter();
        }
        this.label = element('span', 'Choose a file', this.bar);
        this.host = element('div'); this.host.style.cssText = 'flex:1;min-height:0;overflow:auto';
        this.root.replaceChildren(this.bar, this.host);
        container.on('resize', () => this.view?.resize?.());
        container.on('destroy', () => {
            this.destroyed = true; ++this.sequence;
            this.release(); this.host.replaceChildren();
        });
        this.ready = this.init(state || {});
    }
    async init(state) {
        if (!state.fileId) return;
        const file = this.ctx.projectFiles[state.fileId];
        if (!file) throw new Error('File no longer exists: ' + state.fileId);
        await this.show(await readBytes(file, this.ctx), file.name);
    }
    release() {
        this.view?.destroy?.(); this.view = null;
        this.model?.release?.(); this.model = null;
    }
    filter() {
        const query = this.search.value.toLocaleLowerCase();
        for (const node of this.host.children) node.hidden = !node.textContent.toLocaleLowerCase().includes(query);
    }
    async show(bytes, name) {
        if (this.destroyed) return;
        const sequence = ++this.sequence;
        this.release(); this.host.replaceChildren();
        this.label.textContent = name + ' · reading…';
        const model = await this.options.parse(bytes);
        if (this.destroyed || sequence !== this.sequence) { model.release?.(); return; }
        this.model = model;
        this.view = this.options.render(model, this.host, this.bar);
        this.label.textContent = name + ' · ' + model.summary;
        if (this.search) this.filter();
    }
}
module.exports = { ImportedViewerPanel, text, element, details, card };
