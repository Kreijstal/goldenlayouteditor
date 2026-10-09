const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
const { extractAffinityPreviews } = require('./affinity-preview');

let ctx;

async function readBytes(file) {
    if (file.bytes instanceof Uint8Array) return file.bytes;
    const rel = ctx.currentWorkspacePath && ctx.getRelativePath(file.id);
    if (rel) {
        const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + rel));
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not read ${file.name}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
    }
    if (typeof file.content === 'string' && !file.lazy && !file.viewType) return new TextEncoder().encode(file.content);
    throw new Error(`No bytes available for ${file.name}`);
}

class ArtPanel {
    constructor(container, state, format) {
        this.root = container.element;
        this.format = format;
        this.destroyed = false;
        this.urls = [];
        this.root.style.cssText += ';height:100%;display:flex;flex-direction:column;background:#20242a;color:#eee;overflow:hidden';
        this.bar = document.createElement('div');
        this.bar.style.cssText = 'padding:8px;display:flex;gap:10px;align-items:center;font:13px system-ui;flex-wrap:wrap';
        const open = document.createElement('button');
        open.textContent = 'Open';
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = format === 'affinity' ? '.afphoto,.afdesign,.afpub' : format === 'rip' ? '.rip' : '.nap,.naplps';
        input.hidden = true;
        open.onclick = () => input.click();
        input.onchange = async () => {
            const file = input.files[0];
            if (file) await this.show(new Uint8Array(await file.arrayBuffer()), file.name);
        };
        this.label = document.createElement('span');
        this.label.textContent = 'Choose a file';
        this.bar.append(open, input, this.label);
        this.host = document.createElement('div');
        this.host.style.cssText = 'flex:1;min-height:0;overflow:auto';
        this.root.replaceChildren(this.bar, this.host);
        container.on('destroy', () => {
            this.destroyed = true;
            this.sequence = (this.sequence || 0) + 1;
            this.release();
            this.host.replaceChildren();
        });
        this.ready = this.init(state);
    }

    async init(state) {
        const file = state && state.fileId && ctx.projectFiles[state.fileId];
        if (file) await this.show(await readBytes(file), file.name);
    }

    release() {
        this.urls.forEach(url => URL.revokeObjectURL(url));
        this.urls = [];
        if (this.selector) this.selector.remove();
        this.selector = null;
    }

    async show(bytes, name) {
        if (this.destroyed) return;
        const sequence = this.sequence = (this.sequence || 0) + 1;
        this.release();
        this.host.replaceChildren();
        this.label.textContent = name;
        if (this.format === 'affinity') {
            const previews = extractAffinityPreviews(bytes);
            const img = document.createElement('img');
            img.alt = `Embedded preview of ${name}`;
            img.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
            this.selector = document.createElement('select');
            this.selector.setAttribute('aria-label', 'Embedded preview');
            previews.forEach((preview, index) => {
                this.urls.push(URL.createObjectURL(new Blob([preview.bytes], { type: 'image/png' })));
                this.selector.add(new Option(`${preview.width} × ${preview.height}`, index));
            });
            this.selector.onchange = () => { img.src = this.urls[Number(this.selector.value)]; };
            this.bar.appendChild(this.selector);
            img.src = this.urls[0];
            this.label.textContent = `${name} · embedded PNG preview only`;
            this.host.appendChild(img);
            return;
        }
        // Each frame isolates legacy globals, drawing state and timers between tabs.
        const frame = document.createElement('iframe');
        frame.title = this.format === 'rip' ? 'RIPscrip viewer' : 'NAPLPS viewer';
        frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
        const loaded = new Promise(resolve => frame.onload = resolve);
        frame.src = `/legacy-art/${this.format}.html`;
        this.host.appendChild(frame);
        await loaded;
        if (this.destroyed || sequence !== this.sequence) return;
        const info = await frame.contentWindow.renderArt(bytes, name);
        if (!this.destroyed && sequence === this.sequence) this.label.textContent = `${name} · ${info}`;
    }
}

registerPlugin({
    id: 'legacy-art',
    name: 'Affinity previews, RIPscrip and NAPLPS',
    components: {
        affinityPreview: class extends ArtPanel { constructor(c, s) { super(c, s, 'affinity'); } },
        ripViewer: class extends ArtPanel { constructor(c, s) { super(c, s, 'rip'); } },
        naplpsViewer: class extends ArtPanel { constructor(c, s) { super(c, s, 'naplps'); } },
    },
    init(context) { ctx = context; },
});
