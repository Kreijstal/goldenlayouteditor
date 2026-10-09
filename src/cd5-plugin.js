const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
let ctx;
class Cd5Panel {
    constructor(container, state = {}) {
        this.root = container.element;
        this.workerUrl = state.workerUrl || '/cd5-viewer/worker.js';
        this.pending = new Map(); this.requestId = 0; this.generation = 0;
        this.root.style.cssText += ';height:100%;display:flex;flex-direction:column;background:#20242a;color:#eee;font:13px system-ui';
        this.root.innerHTML = `<div style="display:flex;gap:8px;padding:10px;align-items:center;flex-wrap:wrap">
<button data-open>Open CD5</button><input type="file" accept=".cd5" hidden>
<select aria-label="CD5 layer" disabled></select>
<select aria-label="Zoom"><option value="fit">Fit</option><option value="1">100%</option><option value="2">200%</option><option value="4">400%</option></select>
<button data-export disabled>Export PNG</button></div>
<div data-status role="status" style="padding:0 10px 10px;overflow-wrap:anywhere">Choose a CD5 file</div>
<div data-host style="flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;background-color:#ddd;background-image:conic-gradient(#bbb 25%,transparent 0 50%,#bbb 0 75%,transparent 0);background-size:24px 24px">
<canvas aria-label="CD5 layer pixels" hidden style="image-rendering:pixelated"></canvas></div>
<div style="padding:8px;color:#bbc2cc">Individual layers · composition, linked layers and animation playback are not rendered</div>`;
        this.status = this.root.querySelector('[data-status]');
        this.selector = this.root.querySelector('[aria-label="CD5 layer"]');
        this.zoom = this.root.querySelector('[aria-label="Zoom"]');
        this.canvas = this.root.querySelector('canvas'); this.exportButton = this.root.querySelector('[data-export]');
        const input = this.root.querySelector('input');
        this.root.querySelector('[data-open]').onclick = () => input.click();
        input.onchange = () => { const file = input.files[0]; input.value = ''; if (file) return this.openFile(file); };
        this.root.ondragover = event => { event.preventDefault(); event.stopPropagation(); };
        this.root.ondrop = event => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer.files[0]) return this.openFile(event.dataTransfer.files[0]); };
        this.selector.onchange = () => this.selectLayer(Number(this.selector.value));
        this.zoom.onchange = () => this.resize();
        this.exportButton.onclick = () => this.exportPng();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.root.querySelector('[data-host]'));
        container.on('destroy', () => { this.destroyed = true; this.generation++; this.stop(); this.resizeObserver.disconnect(); });
        this.ready = this.init(state);
    }
    async openFile(file) {
        const read = this.readSequence = (this.readSequence || 0) + 1;
        this.generation++; this.stop(); this.canvas.hidden = true; this.exportButton.disabled = true; this.selector.disabled = true;
        this.status.textContent = file.name + ' · reading…';
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!this.destroyed && read === this.readSequence) await this.open(bytes, file.name);
    }
    async init(state) {
        if (!state.fileId) return;
        const file = ctx.projectFiles[state.fileId];
        if (file.bytes instanceof Uint8Array) return this.open(file.bytes, file.name);
        const rel = ctx.getRelativePath(file.id);
        if (!ctx.currentWorkspacePath || !rel) throw new Error('CD5: no binary bytes available for ' + file.name);
        const generation = this.generation;
        const response = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + rel)));
        if (!response.ok) throw new Error(`CD5: could not read ${file.name}: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!this.destroyed && generation === this.generation) return this.open(bytes, file.name);
    }
    stop() {
        if (this.worker) this.worker.terminate(); this.worker = null;
        for (const {resolve} of this.pending.values()) resolve(null);
        this.pending.clear();
    }
    request(type, values) {
        const id = ++this.requestId;
        return new Promise((resolve, reject) => { this.pending.set(id,{resolve,reject}); this.worker.postMessage({id,type,...values}, type === 'open' ? [values.buffer] : []); });
    }
    async open(bytes, name) {
        if (this.destroyed) return;
        this.readSequence = (this.readSequence || 0) + 1;
        const generation = ++this.generation; this.stop();
        this.name = name; this.canvas.hidden = true; this.exportButton.disabled = true; this.selector.disabled = true;
        this.selector.replaceChildren(); this.status.textContent = name + ' · reading…';
        const worker = this.worker = new Worker(this.workerUrl);
        worker.onmessage = ({data}) => { const pending = this.pending.get(data.id); if (pending) { this.pending.delete(data.id); pending.resolve(data); } };
        // Report actual decoding errors at the worker boundary; propagate them to the caller.
        worker.onerror = event => {
            if (this.worker !== worker) return;
            event.preventDefault();
            this.status.textContent = event.message;
            this.canvas.hidden = true; this.exportButton.disabled = true; this.selector.disabled = true;
            for (const {reject} of this.pending.values()) reject(new Error(event.message));
            this.pending.clear(); worker.terminate(); this.worker = null;
        };
        const info = await this.request('open', {buffer:bytes.slice().buffer});
        if (!info || this.destroyed || generation !== this.generation) return;
        this.info = info;
        info.layers.forEach((layer,index) => {
            const option = new Option(`${index+1}. ${layer.name || 'Untitled'} · ${layer.width} × ${layer.height}${layer.pixelSize?'':' · linked'}`, index);
            option.disabled = !layer.pixelSize; this.selector.add(option);
        });
        const first = info.layers.findIndex(layer => layer.pixelSize > 0);
        if (first < 0) throw new Error('CD5: document has no independent raster layers');
        this.selector.disabled = false; this.selector.value = String(first); await this.selectLayer(first);
    }
    async selectLayer(index) {
        const generation = this.generation, selection = this.selection = (this.selection || 0) + 1;
        this.exportButton.disabled = true; this.canvas.hidden = true; this.status.textContent = `${this.name} · decoding layer ${index+1}…`;
        const pixels = await this.request('layer',{index});
        if (!pixels || this.destroyed || generation !== this.generation || selection !== this.selection) return;
        this.canvas.width = pixels.width; this.canvas.height = pixels.height;
        this.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.rgba), pixels.width, pixels.height),0,0);
        this.canvas.hidden = false; this.exportButton.disabled = false;
        this.status.textContent = `${this.name} · CD5 ${this.info.version} · ${this.info.layers.length} layers · ${pixels.width} × ${pixels.height}`;
        this.resize();
    }
    resize() {
        if (this.canvas.hidden) return;
        const host = this.root.querySelector('[data-host]');
        const scale = this.zoom.value === 'fit' ? Math.min((host.clientWidth-24)/this.canvas.width,(host.clientHeight-24)/this.canvas.height,1) : Number(this.zoom.value);
        this.canvas.style.width = Math.max(1,this.canvas.width*scale)+'px'; this.canvas.style.height = Math.max(1,this.canvas.height*scale)+'px';
        host.style.alignItems = this.canvas.height*scale > host.clientHeight ? 'flex-start' : 'center';
        host.style.justifyContent = this.canvas.width*scale > host.clientWidth ? 'flex-start' : 'center';
    }
    exportPng() {
        this.canvas.toBlob(blob => {
            if (!blob) throw new Error('CD5: PNG export failed');
            const url = URL.createObjectURL(blob), link = document.createElement('a');
            link.href=url; link.download=this.name.replace(/\.cd5$/i,'')+`-layer-${Number(this.selector.value)+1}.png`;
            link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
        },'image/png');
    }
}
registerPlugin({id:'cd5',name:'CD5 raster layers',components:{cd5Viewer:Cd5Panel},init(context){ctx=context;}});
module.exports = { Cd5Panel };
