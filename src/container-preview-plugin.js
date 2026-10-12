const { registerPlugin } = require('./plugins');
const { readViewerFile, element, table } = require('./viewer-file');
const { parseAndroidManifest, protobufFields } = require('./extra-file-data');
const { detectEncoding, decodeBytes } = require('./text-encoding');
const { SevenZipArchive, sevenZipMagic } = require('./sevenzip');
let ctx, zipPromise;
function safeEntryPath(path) {
    const parts = String(path).replace(/\\/g, '/').split('/');
    if (!parts.length || /^[/\\]/.test(path) || /^[A-Za-z]:/.test(path) || parts.some(p => p === '..' || p === '.' || /[\x00-\x1f]/.test(p))) throw new Error('Unsafe archive entry path.');
    return parts.filter(Boolean).join('/');
}
async function readAab(bytes) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Not a ZIP-based Android App Bundle.');
    if (!zipPromise) { zipPromise = import('https://esm.sh/jszip@3.10.1').then(m => m.default || m); zipPromise.catch(() => { zipPromise = null; }); }
    const Zip = await zipPromise, zip = await Zip.loadAsync(bytes);
    if (!zip.file('BundleConfig.pb') || !zip.file('base/manifest/AndroidManifest.xml')) throw new Error('AAB needs BundleConfig.pb and a base protobuf manifest.');
    const files = Object.values(zip.files).filter(f => !f.dir);
    const entries = files.map(f => ({ path: f.name, size: f._data.uncompressedSize, extract: async () => new File([await f.async('uint8array')], f.name.split('/').pop()) }));
    const modules = [];
    for (const f of files.filter(f => /^[^/]+\/manifest\/AndroidManifest\.xml$/.test(f.name))) {
        if (f._data.uncompressedSize > 4 * 1024 * 1024) throw new Error('AAB manifest exceeds the 4 MB preview limit.');
        const name = f.name.split('/')[0], manifest = parseAndroidManifest(await f.async('uint8array'));
        const paths = files.filter(e => e.name.startsWith(name + '/')).map(e => e.name);
        modules.push({ name, manifest, files: paths.length, dex: paths.filter(p => /\/dex\/.*\.dex$/.test(p)).length, assets: paths.filter(p => p.startsWith(name + '/assets/')).length, abis: [...new Set(paths.filter(p => p.startsWith(name + '/lib/')).map(p => p.split('/')[2]))] });
    }
    const config = zip.file('BundleConfig.pb');
    if (config._data.uncompressedSize > 4 * 1024 * 1024) throw new Error('BundleConfig.pb exceeds the 4 MB preview limit.');
    const configFields = protobufFields(await config.async('uint8array')).map(f => ({ field: f.field, wire: f.wire, bytes: f.value instanceof Uint8Array ? f.value.length : f.value }));
    return { entries, modules, configFields, signatures: files.filter(f => /^META-INF\/.*\.(RSA|DSA|EC|SF)$/i.test(f.name)).map(f => f.name) };
}
class ContainerPreview {
    constructor(container, state) {
        this.container = container; this.fileId = state.fileId; this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#222;font:13px system-ui';
        const bar = element('div', null, this.root); bar.style.padding = '8px';
        this.status = element('span', 'Reading container…', bar);
        this.password = element('input', null, bar); this.password.type = 'password'; this.password.placeholder = 'Archive password'; this.password.autocomplete = 'off';
        this.retry = element('button', 'Open with password', bar); this.retry.onclick = () => this.load();
        this.info = element('div', null, this.root); this.info.style.cssText = 'padding:8px;max-height:25%;overflow:auto';
        const filter = this.filter = element('input', null, this.root); filter.placeholder = 'Filter archive entries'; filter.style.cssText = 'padding:7px;margin:6px';
        this.list = element('div', null, this.root); this.list.style.cssText = 'flex:1;min-height:70px;overflow:auto';
        this.host = element('div', null, this.root); this.host.style.cssText = 'height:50%;min-height:100px;display:none;overflow:hidden';
        filter.oninput = () => this.renderEntries();
        container.on('resize', () => { if (this.inner) this.inner.emit('resize'); });
        container.on('destroy', () => { this.destroyed = true; this.generation++; this.unmount(); if (this.archive) this.archive.close(); });
        this.generation = 0; this.load();
    }
    async load() {
        const generation = ++this.generation;
        this.retry.disabled = true;
        this.unmount();
        if (this.archive) await this.archive.close();
        this.archive = null; this.entries = null; this.info.replaceChildren(); this.list.replaceChildren();
        try {
            const file = ctx.projectFiles[this.fileId], aab = /\.aab$/i.test(file.name);
            this.password.hidden = this.retry.hidden = aab;
            this.status.textContent = 'Reading container…';
            const bytes = await readViewerFile(ctx, this.fileId, null, true);
            if (bytes.length > 256 * 1024 * 1024) throw new Error('Container preview is limited to 256 MB input files.');
            if (this.destroyed || generation !== this.generation) return;
            if (aab) {
                const bundle = await readAab(bytes);
                if (this.destroyed || generation !== this.generation) return;
                this.entries = bundle.entries;
                element('h3', `Android App Bundle · ${bundle.modules.length} modules`, this.info);
                table(this.info, ['Module', 'Package', 'Version', 'DEX', 'Files', 'ABIs'], bundle.modules.map(m => [m.name, m.manifest.package, m.manifest.versionName || m.manifest.versionCode, m.dex, m.files, m.abis.join(', ')]));
                const details = element('details', null, this.info); element('summary', 'Manifest and bundle configuration', details);
                element('pre', JSON.stringify({ modules: bundle.modules, configFields: bundle.configFields, signatureEntries: bundle.signatures }, null, 2).slice(0, 200000), details).style.whiteSpace = 'pre-wrap';
                element('p', 'Package metadata only; bundle signatures are not verified.', this.info);
            } else {
                if (!sevenZipMagic(bytes)) throw new Error('Not a 7z archive.');
                this.status.textContent = 'Loading 7z archive…';
                this.archive = new SevenZipArchive();
                this.entries = await this.archive.open(bytes, this.password.value);
                element('h3', '7z archive', this.info);
            }
            if (this.destroyed || generation !== this.generation) return;
            this.status.textContent = `${this.entries.length} entries · read-only`;
            this.renderEntries();
        } catch (err) {
            if (!this.destroyed && generation === this.generation) this.status.textContent = 'Could not open container: ' + err.message;
        } finally {
            if (!this.destroyed && generation === this.generation) this.retry.disabled = false;
        }
    }
    renderEntries() {
        if (!this.entries) return;
        const query = this.filter.value.toLowerCase(), entries = this.entries.filter(e => e.path.toLowerCase().includes(query));
        this.list.replaceChildren();
        const grid = table(this.list, ['Entry', 'Bytes', 'Preview'], entries.slice(0, 1000).map(e => [e.path, e.size, '']));
        [...grid.querySelectorAll('tbody tr')].forEach((row, i) => {
            const entry = entries[i]; element('button', 'Open entry', row.lastChild).onclick = () => this.openEntry(entry);
        });
        if (entries.length > 1000) element('p', 'Showing the first 1,000 matching entries.', this.list);
    }
    unmount() {
        if (this.inner) { this.inner.emit('destroy'); this.inner = null; }
        if (this.memoryId) { ctx.removeMemoryFile(this.memoryId); this.memoryId = null; }
        this.host.replaceChildren(); this.host.style.display = 'none';
    }
    async openEntry(entry) {
        const generation = this.generation;
        const selection = this.entryGeneration = (this.entryGeneration || 0) + 1;
        try {
            const path = safeEntryPath(entry.path);
            if (entry.size > 64 * 1024 * 1024) throw new Error('Entry preview is limited to 64 MB.');
            const file = await entry.extract(), bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length > 64 * 1024 * 1024) throw new Error('Entry preview is limited to 64 MB.');
            if (this.destroyed || generation !== this.generation || selection !== this.entryGeneration) return;
            this.unmount();
            const name = path.split('/').pop(), detected = await detectEncoding(bytes);
            if (this.destroyed || generation !== this.generation || selection !== this.entryGeneration) return;
            const model = { name, type: 'file', bytes, head: bytes.slice(0, 512), content: detected.binary ? '' : decodeBytes(bytes, detected.encoding), readOnly: true, memoryOnly: true };
            const ext = name.split('.').pop().toLowerCase();
            if (require('./browse-mode').SERVED_EXTENSIONS.has(ext)) model.viewType = ext;
            else if (detected.binary) model.viewType = 'binary';
            const token = Math.random().toString(36).slice(2);
            this.memoryId = ctx.addMemoryFile(model, `.in-memory-${token}/${path}`, bytes);
            const candidates = ctx.viewersForFile(this.memoryId).filter(v => ctx.getComponent(v.componentType));
            const v = candidates[0];
            if (!v) throw new Error('No viewer is registered for this entry.');
            this.host.style.display = 'block';
            const listeners = {}, container = { element: this.host, on: (e, cb) => { (listeners[e] = listeners[e] || []).push(cb); }, emit: e => (listeners[e] || []).forEach(cb => cb()), getState: () => v.state, setTitle: () => {} };
            this.inner = container;
            const Component = ctx.getComponent(v.componentType), instance = new Component(container, v.state);
            container.componentReference = instance;
            if (instance.editor) instance.editor.setReadOnly(true);
            this.status.textContent = `${path} · in-memory entry preview`;
            requestAnimationFrame(() => { if (this.inner === container) { container.emit('show'); container.emit('resize'); } });
        } catch (err) { if (!this.destroyed && generation === this.generation && selection === this.entryGeneration) this.status.textContent = 'Could not preview entry: ' + err.message; }
    }
}
registerPlugin({ id: 'container-previews', name: '7z and Android App Bundles', components: { containerViewer: ContainerPreview }, init(context) { ctx = context; } });
module.exports = { safeEntryPath, sevenZipMagic, readAab };
