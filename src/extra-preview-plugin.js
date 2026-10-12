const { registerPlugin } = require('./plugins');
const { readViewerFile, element, table } = require('./viewer-file');
const { isAbcText, isAbletonText, parseKeyValues, summarizeAbleton } = require('./extra-file-data');
const { parseAco, parseAbr } = require('./adobe-resources');
let ctx, abcPromise;
function loadAbc() {
    if (!abcPromise) { abcPromise = import('https://esm.sh/abcjs@6.7.1').then(m => m.default || m); abcPromise.catch(() => { abcPromise = null; }); }
    return abcPromise;
}
function details(parent, title, value) {
    const box = element('details', null, parent);
    element('summary', title, box);
    const pre = element('pre', JSON.stringify(value, null, 2).slice(0, 200000), box);
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
}
function brushCanvas(brush) {
    const canvas = element('canvas');
    const scale = Math.min(1, 256 / Math.max(brush.width, brush.height));
    canvas.width = Math.max(1, Math.round(brush.width * scale)); canvas.height = Math.max(1, Math.round(brush.height * scale));
    canvas.style.cssText = 'max-width:100%;image-rendering:auto;background:white';
    const c = canvas.getContext('2d'), image = c.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const value = brush.pixels[Math.min(brush.height - 1, Math.floor(y / scale)) * brush.width + Math.min(brush.width - 1, Math.floor(x / scale))];
        const p = (y * canvas.width + x) * 4;
        image.data[p] = image.data[p+1] = image.data[p+2] = value; image.data[p+3] = 255;
    }
    c.putImageData(image, 0, 0);
    return canvas;
}
class ExtraPreview {
    constructor(container, state) {
        this.fileId = state.fileId;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;overflow:auto;background:#fff;color:#222;font:14px system-ui;box-sizing:border-box;padding:12px';
        const bar = element('div', null, this.root);
        element('button', 'Refresh preview', bar).onclick = () => this.load();
        this.status = element('span', '', bar); this.status.style.marginLeft = '12px';
        this.body = element('div', null, this.root);
        this.generation = 0;
        container.on('destroy', () => { this.destroyed = true; this.generation++; });
        this.load();
    }
    async load() {
        const generation = ++this.generation;
        try {
            this.status.textContent = 'Reading…';
            const file = ctx.projectFiles[this.fileId], ext = file.name.split('.').pop().toLowerCase();
            let bytes = await readViewerFile(ctx, this.fileId, null, (ext === 'als' && !isAbletonText(file.content)) || ext === 'abr' || ext === 'aco');
            if (ext === 'als' && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
            if (this.destroyed || generation !== this.generation) return;
            this.body.replaceChildren();
            if (ext === 'aco') {
                const palette = parseAco(bytes);
                element('h3', `Adobe palette · ${palette.colors.length} colors`, this.body);
                element('p', 'RGB preview; CMYK and Lab conversions are approximations without the original color profile.', this.body);
                const grid = element('div', null, this.body);
                grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px';
                palette.colors.forEach(color => {
                    const card = element('div', null, grid); card.style.cssText = 'border:1px solid #ddd;padding:8px;overflow-wrap:anywhere';
                    const swatch = element('div', '', card); swatch.style.cssText = 'height:60px;border:1px solid #ccc';
                    if (color.hex) swatch.style.background = color.hex;
                    element('strong', color.name, card);
                    element('div', color.hex || 'Unsupported color space', card);
                    element('small', `Space ${color.space} · ${color.values.join(', ')}`, card);
                });
            } else if (ext === 'abr') {
                const library = parseAbr(bytes);
                element('h3', `Photoshop brushes · ${library.brushes.length} sampled tips`, this.body);
                element('p', library.warnings.join(' '), this.body);
                const grid = element('div', null, this.body);
                grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px';
                library.brushes.forEach(brush => {
                    const card = element('div', null, grid); card.style.cssText = 'border:1px solid #ddd;padding:8px;overflow-wrap:anywhere';
                    card.appendChild(brushCanvas(brush));
                    element('div', brush.name, card);
                    element('small', `${brush.width} × ${brush.height} · ${brush.depth}-bit`, card);
                });
            } else if (ext === 'acf') {
                const manifest = parseKeyValues(new TextDecoder().decode(bytes));
                element('h3', 'Steam app manifest', this.body);
                table(this.body, ['Field', 'Value'], Object.entries(manifest.summary));
                details(this.body, 'KeyValues structure', manifest.tree);
            } else if (ext === 'als') {
                const set = summarizeAbleton(new TextDecoder().decode(bytes));
                element('h3', 'Ableton Live Set', this.body);
                table(this.body, ['Field', 'Value'], [['Creator', set.creator], ['Version', set.version], ['Tempo', set.tempo], ['Time signature', set.timeSignature], ['Tracks', set.tracks.length]]);
                table(this.body, ['Track', 'Type', 'Clips', 'Devices'], set.tracks.map(t => [t.name, t.type, t.clips.length, t.devices.join(', ')]));
                details(this.body, 'Clips, devices and sample paths', set);
            } else if (ext === 'abc') {
                const text = new TextDecoder().decode(bytes);
                if (!isAbcText(text)) throw new Error('Not an ABC music notation document.');
                const abc = await loadAbc();
                if (this.destroyed || generation !== this.generation) return;
                const tunes = new abc.TuneBook(text).tunes;
                element('h3', `ABC sheet music · ${tunes.length} tunes`, this.body);
                const pick = element('select', null, this.body);
                pick.setAttribute('aria-label', 'ABC tune');
                tunes.forEach((t, i) => { const option = element('option', t.title || `Tune ${i + 1}`, pick); option.value = i; });
                const score = element('div', null, this.body);
                const show = () => { score.replaceChildren(); abc.renderAbc(score, text, { startingTune: +pick.value, responsive: 'resize' }); };
                pick.onchange = show; show();
            }
            this.status.textContent = 'Read-only preview';
        } catch (err) {
            if (!this.destroyed && generation === this.generation) { this.body.textContent = err.message; this.status.textContent = 'Could not preview'; }
        }
    }
}
registerPlugin({ id: 'extra-previews', name: 'ABC, Adobe resources, Steam and Ableton', components: { extraPreview: ExtraPreview }, init(context) { ctx = context; } });
