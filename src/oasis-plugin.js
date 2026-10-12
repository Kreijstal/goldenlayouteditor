const { registerPlugin } = require('./plugins');
const { readViewerFile, element } = require('./viewer-file');
const { isOasisFile, flattenLayout } = require('./oasis-layout');
let ctx;
const COLORS = ['#5bc0eb', '#fde74c', '#9bc53d', '#e55934', '#fa7921', '#bb86fc', '#ff70a6'];

class OasisViewer {
    constructor(container, state) {
        this.fileId = state.fileId;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;background:#151a20;color:#eee;font:13px system-ui;overflow:hidden';
        this.status = element('div', 'Reading OASIS layout…', this.root);
        this.status.style.padding = '8px';
        container.on('destroy', () => { this.destroyed = true; if (this.worker) this.worker.terminate(); clearTimeout(this.timeout); if (this.resize) this.resize.disconnect(); });
        this.load();
    }
    async load() {
        try {
            const file = ctx.projectFiles[this.fileId], bytes = await readViewerFile(ctx, this.fileId);
            if (this.destroyed) return;
            if (!isOasisFile({ name: file.name, bytes })) throw new Error('Not a SEMI OASIS layout file.');
            if (bytes.length > 64 * 1024 * 1024) throw new Error('OASIS preview is limited to 64 MB input files.');
            this.status.textContent = 'Loading OASIS parser…';
            const result = await new Promise((resolve, reject) => {
                this.worker = new Worker(new URL('oasis-worker.js', document.baseURI));
                this.timeout = setTimeout(() => { this.worker.terminate(); reject(new Error('OASIS parser timed out after 120 seconds.')); }, 120000);
                this.worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result);
                this.worker.onerror = e => reject(new Error(e.message || 'OASIS worker failed.'));
                const buffer = bytes.slice().buffer;
                this.worker.postMessage({ bytes: buffer }, [buffer]);
            });
            clearTimeout(this.timeout);
            this.worker.terminate(); this.worker = null;
            if (!this.destroyed) this.render(result);
        } catch (err) {
            clearTimeout(this.timeout);
            if (this.worker) this.worker.terminate();
            if (!this.destroyed) this.status.textContent = 'Could not preview OASIS: ' + err.message;
        }
    }
    render(layout) {
        this.layout = layout;
        const controls = element('div', null, this.root);
        controls.style.cssText = 'padding:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        element('label', 'Cell', controls);
        this.pick = element('select', null, controls);
        this.pick.setAttribute('aria-label', 'OASIS cell');
        layout.cells.forEach(c => { const option = element('option', c.name, this.pick); option.value = c.name; });
        const referenced = new Set(layout.cells.flatMap(c => c.placements.map(p => p.cell)));
        const top = layout.cells.find(c => !referenced.has(c.name));
        if (top) this.pick.value = top.name;
        element('button', 'Fit', controls).onclick = () => { this.fit(); this.draw(); };
        element('span', 'Wheel to zoom · drag to pan', controls);
        this.layers = element('div', null, this.root);
        this.layers.style.cssText = 'padding:6px;max-height:90px;overflow:auto;display:flex;gap:12px;flex-wrap:wrap';
        this.warn = element('div', '', this.root);
        this.warn.style.cssText = 'padding:6px;color:#ffd479;max-height:70px;overflow:auto';
        this.stage = element('div', null, this.root);
        this.stage.style.cssText = 'flex:1;min-height:100px;position:relative';
        this.canvas = element('canvas', null, this.stage);
        this.canvas.setAttribute('aria-label', 'OASIS layout canvas');
        this.canvas.style.cssText = 'width:100%;height:100%;touch-action:none;display:block';
        this.resize = new ResizeObserver(() => { this.draw(); });
        this.resize.observe(this.stage);
        this.pick.onchange = () => this.select();
        this.canvas.onwheel = e => {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
            const factor = Math.exp(-Math.max(-200, Math.min(200, e.deltaY)) * 0.003);
            const nextScale = Math.max(1e-9, Math.min(1e9, this.scale * factor));
            const ratio = nextScale / this.scale;
            this.tx = x - (x - this.tx) * ratio; this.ty = y - (y - this.ty) * ratio; this.scale = nextScale;
            this.draw();
        };
        this.canvas.onpointerdown = e => { this.drag = [e.clientX, e.clientY]; this.canvas.setPointerCapture(e.pointerId); };
        this.canvas.onpointermove = e => { if (!this.drag) return; this.tx += e.clientX - this.drag[0]; this.ty += e.clientY - this.drag[1]; this.drag = [e.clientX, e.clientY]; this.draw(); };
        this.canvas.onpointerup = this.canvas.onpointercancel = () => { this.drag = null; };
        this.select();
    }
    select() {
        const preview = flattenLayout(this.layout, this.pick.value);
        this.shapes = preview.shapes;
        this.visible = new Set(this.shapes.map(s => s.layer));
        this.colors = new Map([...this.visible].sort().map((l, i) => [l, COLORS[i % COLORS.length]]));
        this.layers.replaceChildren();
        for (const layer of this.colors.keys()) {
            const label = element('label', null, this.layers);
            label.style.color = this.colors.get(layer);
            const checkbox = element('input', null, label); checkbox.type = 'checkbox'; checkbox.checked = true;
            label.appendChild(document.createTextNode(layer));
            checkbox.onchange = () => { if (checkbox.checked) this.visible.add(layer); else this.visible.delete(layer); this.draw(); };
        }
        this.status.textContent = `OASIS ${this.layout.version} · ${this.layout.cells.length} cells · ${this.shapes.length} shapes · ${this.layout.unit} database units/µm · read-only`;
        this.warn.textContent = preview.warnings.join(' ');
        this.fit(); this.draw();
    }
    fit() {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const shape of this.shapes) for (const [x, y] of shape.points) {
            const pad = shape.width / 2 || 0;
            x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad); x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad);
        }
        if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
        const w = this.stage.clientWidth || 300, h = this.stage.clientHeight || 200;
        this.scale = Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0)) * 0.85;
        this.tx = w / 2 - (x0 + x1) / 2 * this.scale; this.ty = h / 2 + (y0 + y1) / 2 * this.scale;
    }
    draw() {
        if (!this.canvas || this.destroyed) return;
        const w = Math.max(1, this.stage.clientWidth), h = Math.max(1, this.stage.clientHeight), dpr = Math.min(devicePixelRatio || 1, 2);
        this.canvas.width = w * dpr; this.canvas.height = h * dpr;
        const c = this.canvas.getContext('2d');
        c.scale(dpr, dpr); c.fillStyle = '#151a20'; c.fillRect(0, 0, w, h);
        c.lineJoin = 'miter'; c.lineCap = 'butt';
        for (const shape of this.shapes) {
            if (!this.visible.has(shape.layer)) continue;
            c.fillStyle = c.strokeStyle = this.colors.get(shape.layer);
            if (shape.kind === 'text') {
                const [x, y] = shape.points[0]; c.font = '12px system-ui'; c.fillText(shape.text, x * this.scale + this.tx, -y * this.scale + this.ty); continue;
            }
            c.beginPath();
            shape.points.forEach(([x, y], i) => { if (i) c.lineTo(x * this.scale + this.tx, -y * this.scale + this.ty); else c.moveTo(x * this.scale + this.tx, -y * this.scale + this.ty); });
            if (shape.kind === 'path') { c.lineWidth = Math.max(0.5, shape.width * this.scale); c.stroke(); }
            else { c.closePath(); c.globalAlpha = 0.55; c.fill(); c.globalAlpha = 1; c.lineWidth = 0.6; c.stroke(); }
        }
    }
}
registerPlugin({ id: 'oasis', name: 'OASIS semiconductor layouts', components: { oasisViewer: OasisViewer }, init(context) { ctx = context; } });
