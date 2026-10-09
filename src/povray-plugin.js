const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
let ctx;

class PovrayPanel {
    constructor(container, state) {
        this.fileId = state && state.fileId;
        this.root = container.element;
        this.root.style.cssText += ';height:100%;display:flex;flex-direction:column;background:#20242a;color:#eee';
        this.root.innerHTML = `<div style="padding:8px;display:flex;gap:8px;align-items:center;font:13px system-ui">
<button data-open>Open</button><button data-render>Render</button><button data-stop>Stop</button>
<select aria-label="Render resolution"><option value="320,240">320 × 240</option><option value="640,480" selected>640 × 480</option><option value="1280,960">1280 × 960</option></select>
<span data-status>Choose a POV-Ray scene</span><input type="file" accept=".pov" hidden></div>
<div style="flex:1;min-height:0;overflow:auto"><img alt="POV-Ray render" style="display:block;width:100%;height:100%;object-fit:contain"></div>`;
        this.status = this.root.querySelector('[data-status]');
        this.image = this.root.querySelector('img');
        const input = this.root.querySelector('input');
        this.root.querySelector('[data-open]').onclick = () => input.click();
        input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            this.fileId = null;
            this.localScene = await file.text();
            this.name = file.name;
            await this.render();
        };
        this.root.querySelector('[data-render]').onclick = () => this.render();
        this.root.querySelector('[data-stop]').onclick = () => { this.stop(); this.status.textContent = 'Stopped'; };
        container.on('destroy', () => {
            this.destroyed = true;
            this.stop();
            if (this.url) URL.revokeObjectURL(this.url);
        });
        this.ready = this.fileId ? this.render() : Promise.resolve();
    }

    stop() {
        if (this.worker) this.worker.terminate();
        this.worker = null;
        if (this.cancel) this.cancel();
        this.cancel = null;
        this.sequence = (this.sequence || 0) + 1;
    }

    async readScene() {
        if (!this.fileId) return this.localScene;
        const file = ctx.projectFiles[this.fileId];
        this.name = file.name;
        if (typeof file.content === 'string' && !file.lazy && !file.viewType) return file.content;
        if (file.bytes instanceof Uint8Array) return new TextDecoder().decode(file.bytes);
        const rel = ctx.getRelativePath(this.fileId);
        const response = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + rel)));
        if (!response.ok) throw new Error(`Could not read scene: HTTP ${response.status}`);
        return response.text();
    }

    async render() {
        this.stop();
        const sequence = this.sequence;
        const scene = await this.readScene();
        if (this.destroyed || sequence !== this.sequence) return;
        if (typeof scene !== 'string') throw new Error('Choose a POV-Ray scene first');
        const [width, height] = this.root.querySelector('select').value.split(',').map(Number);
        this.status.textContent = `${this.name} · rendering…`;
        const worker = this.worker = new Worker('/povray-viewer/worker.js');
        const output = await new Promise((resolve, reject) => {
            this.cancel = () => resolve(null);
            worker.onmessage = event => {
                if (event.data.error) {
                    this.status.textContent = event.data.error;
                    worker.terminate();
                    this.worker = null;
                    this.cancel = null;
                    reject(new Error(event.data.error));
                } else resolve(event.data);
            };
            worker.onerror = event => {
                this.status.textContent = event.message;
                worker.terminate();
                reject(new Error(event.message));
            };
            worker.postMessage({ scene, width, height });
        });
        if (!output || this.destroyed || sequence !== this.sequence) return;
        worker.terminate();
        this.worker = null;
        this.cancel = null;
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = URL.createObjectURL(new Blob([output], { type:'image/png' }));
        this.image.src = this.url;
        this.status.textContent = `${this.name} · ${width} × ${height} · POV-Ray 3.8`;
    }
}

registerPlugin({ id:'povray', name:'POV-Ray', components:{ povrayViewer:PovrayPanel }, init(context) { ctx = context; } });
