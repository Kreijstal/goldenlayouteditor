const { registerPlugin } = require('./plugins');
const { readViewerFile, element, table } = require('./viewer-file');
const { parseVolumeHeader, isVolumeHeader, volumeValues } = require('./volume-data');
let ctx;

function isVolumeFile(file) {
    if (/\.nii$/i.test(file.name)) return true;
    if (/\.img$/i.test(file.name)) return !!file.volumeHeader;
    const bytes = file.head || file.bytes || (typeof file.content === 'string' && new TextEncoder().encode(file.content));
    return /\.hdr$/i.test(file.name) && isVolumeHeader(bytes);
}

class VolumeViewer {
    constructor(container, state) {
        this.fileId = state.fileId;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;overflow:auto;padding:12px;box-sizing:border-box;background:#fff;color:#222;font:13px system-ui';
        container.on('destroy', () => { this.destroyed = true; });
        this.load();
    }

    async load() {
        this.root.textContent = 'Reading volume…';
        try {
            const file = ctx.projectFiles[this.fileId];
            const img = /\.img$/i.test(file.name);
            const headerBytes = await readViewerFile(ctx, this.fileId, img ? file.name.replace(/\.img$/i, '.hdr') : null);
            const h = parseVolumeHeader(headerBytes);
            if (this.destroyed) return;
            this.root.replaceChildren();
            element('h3', `${h.format} volume`, this.root);
            table(this.root, ['Field', 'Value'], Object.entries({
                dimensions: h.dims.join(' × '), spacing: h.spacing.join(' × '), datatype: h.datatype,
                bitDepth: h.bitpix, byteOrder: h.le ? 'little endian' : 'big endian', voxelOffset: h.offset,
                scaling: `${h.slope} × value + ${h.intercept}`, description: h.description,
                qform: h.qform, sform: h.sform,
            }));
            element('p', 'Slices follow stored voxel axes; anatomical reorientation is not applied.', this.root);
            const stage = element('div', null, this.root);
            try {
                const bytes = h.single ? headerBytes : await readViewerFile(ctx, this.fileId, img ? null : file.name.replace(/\.hdr$/i, '.img'));
                if (this.destroyed) return;
                this.render(stage, h, volumeValues(h, bytes));
            } catch (err) { element('p', err.message, stage); }
        } catch (err) { if (!this.destroyed) this.root.textContent = err.message; }
    }

    render(stage, h, values) {
        const dims = [h.dims[0], h.dims[1] || 1, h.dims[2] || 1];
        const frameSize = dims.reduce((a, b) => a * b, 1);
        const frames = values.count / frameSize;
        const controls = element('div', null, stage);
        const axis = element('select', null, controls);
        ['X', 'Y', 'Z'].forEach((label, i) => { const opt = element('option', `${label} axis`, axis); opt.value = i; });
        axis.value = '2';
        const slice = element('input', null, controls);
        slice.type = 'range'; slice.min = 0;
        const frame = element('input', null, controls);
        frame.type = 'number'; frame.min = 0; frame.max = frames - 1; frame.value = 0;
        frame.title = 'Volume index across time and higher dimensions (zero based)';
        frame.style.width = '65px';
        const label = element('span', '', controls);
        const low = element('input', null, controls), high = element('input', null, controls);
        low.type = high.type = 'number'; low.step = high.step = 'any';
        low.title = 'Window minimum'; high.title = 'Window maximum';
        low.style.width = high.style.width = '90px';
        let min = Infinity, max = -Infinity;
        // Sample at most 200k voxels to initialize the window on large volumes.
        const stride = Math.max(1, Math.ceil(values.count / 200000));
        for (let i = 0; i < values.count; i += stride) {
            const v = values.get(i);
            if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
        }
        low.value = Number.isFinite(min) ? min : 0;
        high.value = Number.isFinite(max) && max > min ? max : +low.value + 1;
        const canvas = element('canvas', null, stage);
        canvas.style.cssText = 'display:block;max-width:100%;max-height:70vh;image-rendering:pixelated;background:#000;margin:10px auto';
        const draw = () => {
            const a = +axis.value, s = +slice.value;
            const f = Math.min(frames - 1, Math.max(0, Math.floor(+frame.value || 0)));
            const axes = [0, 1, 2].filter(i => i !== a);
            const w = dims[axes[0]], ht = dims[axes[1]];
            if (w * ht > 16000000) { label.textContent = 'Slice exceeds the 16 megapixel preview limit.'; return; }
            canvas.width = w; canvas.height = ht;
            const context = canvas.getContext('2d'), image = context.createImageData(w, ht);
            const range = +high.value - +low.value;
            for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) {
                const coord = [0, 0, 0]; coord[a] = s; coord[axes[0]] = x; coord[axes[1]] = ht - y - 1;
                const v = values.get(f * frameSize + coord[0] + dims[0] * (coord[1] + dims[1] * coord[2]));
                const c = Number.isFinite(v) && range > 0 ? Math.round(Math.max(0, Math.min(1, (v - +low.value) / range)) * 255) : 0;
                const i = (x + y * w) * 4;
                image.data[i] = image.data[i + 1] = image.data[i + 2] = c; image.data[i + 3] = 255;
            }
            context.putImageData(image, 0, 0);
            label.textContent = ` Slice ${s + 1}/${dims[a]} · volume ${f + 1}/${frames} · ${values.name} `;
        };
        const changeAxis = () => { slice.max = dims[+axis.value] - 1; slice.value = Math.floor(+slice.max / 2); draw(); };
        axis.onchange = changeAxis;
        [slice, frame, low, high].forEach(input => { input.oninput = draw; });
        changeAxis();
    }
}

registerPlugin({ id: 'volume', name: 'NIfTI / ANALYZE volumes', components: { volumeViewer: VolumeViewer }, init(context) { ctx = context; } });
module.exports = { isVolumeFile };
