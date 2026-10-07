// --- Animated PNG (APNG) frames ---
// Browsers play APNG in an <img>; this shows what's inside: every frame as
// displayed (composited per the APNG spec: each frame's region, blend and
// dispose operations), stepped or played at its own delays, the frame table,
// the file's chunks, and a frame saved as a PNG of its own. Also opens plain
// PNGs (as a single image with its chunks), since animated PNGs are often
// named .png. JPEG XL files open too, decoded to PNG/APNG (src/jxl.js), and
// BPG files, an animated one's frames (src/bpg.js).
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { isJxl, jxlDecode } = require('./jxl');
const { isBpg, bpgDecode } = require('./bpg');

const log = createLogger('APNG');
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const DISPOSE = ['none', 'background', 'previous'];
const BLEND = ['source', 'over'];
const COLOR_TYPES = { 0: 'greyscale', 2: 'RGB', 3: 'palette', 4: 'greyscale + alpha', 6: 'RGBA' };
// Chunks a frame needs besides its data to decode as a PNG of its own
const SHARED = new Set(['PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'cICP', 'mDCv', 'cLLi']);
const MAX_FRAMES = 5000;

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

// The file's chunks: { type, data (a view), offset, crcOk }
function readChunks(bytes) {
    if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG file (no PNG signature)');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    for (let p = 8; p + 12 <= bytes.length;) {
        const len = v.getUint32(p);
        const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
        if (p + 12 + len > bytes.length) { chunks.push({ type, offset: p, length: len, truncated: true, data: bytes.subarray(p + 8) }); break; }
        const data = bytes.subarray(p + 8, p + 8 + len);
        chunks.push({ type, offset: p, length: len, data, crcOk: v.getUint32(p + 8 + len) === crc32(bytes.subarray(p + 4, p + 8 + len)) });
        p += 12 + len;
        if (type === 'IEND') break;
    }
    return chunks;
}

// The animation: the frames' controls and data, in order
function parseApng(chunks) {
    const ihdr = chunks.find(c => c.type === 'IHDR');
    if (!ihdr || ihdr.data.length < 13) throw new Error('no IHDR chunk');
    const hv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
    const info = {
        width: hv.getUint32(0), height: hv.getUint32(4), bitDepth: ihdr.data[8], colorType: ihdr.data[9],
        interlace: ihdr.data[12], ihdr: ihdr.data, shared: [], frames: [], plays: 0, animated: false, defaultIsFrame: false,
    };
    const actl = chunks.find(c => c.type === 'acTL');
    if (actl && actl.data.length >= 8) {
        const av = new DataView(actl.data.buffer, actl.data.byteOffset, 8);
        info.animated = true;
        info.declaredFrames = av.getUint32(0);
        info.plays = av.getUint32(4);
    }
    let current = null, seenIdat = false;
    for (const c of chunks) {
        if (SHARED.has(c.type) && !seenIdat) info.shared.push(c);
        if (c.type === 'fcTL' && c.data.length >= 26) {
            const v = new DataView(c.data.buffer, c.data.byteOffset, 26);
            const delayDen = v.getUint16(22) || 100;
            current = {
                seq: v.getUint32(0), width: v.getUint32(4), height: v.getUint32(8), x: v.getUint32(12), y: v.getUint32(16),
                delayNum: v.getUint16(20), delayDen, delayMs: 1000 * v.getUint16(20) / delayDen,
                dispose: c.data[24], blend: c.data[25], data: [], isDefault: !seenIdat,
            };
            if (info.frames.length < MAX_FRAMES) info.frames.push(current);
        } else if (c.type === 'IDAT') {
            if (!seenIdat && current && current.isDefault) info.defaultIsFrame = true;
            seenIdat = true;
            if (current && current.isDefault) current.data.push(c.data);
            if (!info.defaultData) info.defaultData = [];
            info.defaultData.push(c.data);
        } else if (c.type === 'fdAT' && current) {
            current.data.push(c.data.subarray(4)); // after its sequence number
        }
    }
    if (!info.animated) info.frames = [];
    return info;
}

// A frame as a PNG of its own: the IHDR at the frame's size, shared chunks, its data
function framePng(info, width, height, parts) {
    const ihdr = info.ihdr.slice();
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    const idat = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { idat.set(p, at); at += p.length; }
    return new Blob([new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), ...info.shared.map(c => chunk(c.type, c.data)),
        chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}

// Every frame as it appears, composited on a canvas the size of the image
async function composeFrames(info, onProgress) {
    const canvas = document.createElement('canvas');
    canvas.width = info.width;
    canvas.height = info.height;
    const ctx = canvas.getContext('2d');
    const out = [];
    for (let i = 0; i < info.frames.length; i++) {
        const f = info.frames[i];
        const bitmap = await createImageBitmap(framePng(info, f.width, f.height, f.data));
        const dispose = i === 0 && f.dispose === 2 ? 1 : f.dispose;
        const before = dispose === 2 ? ctx.getImageData(f.x, f.y, f.width, f.height) : null;
        if (f.blend === 0) ctx.clearRect(f.x, f.y, f.width, f.height);
        ctx.drawImage(bitmap, f.x, f.y);
        bitmap.close();
        out.push(await createImageBitmap(canvas));
        if (dispose === 1) ctx.clearRect(f.x, f.y, f.width, f.height);
        else if (dispose === 2) ctx.putImageData(before, f.x, f.y);
        if (onProgress && i % 10 === 0) onProgress(i, info.frames.length);
    }
    return out;
}

class ApngComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = ApngComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'image.png';
        this.frames = [];
        this.index = 0;
        this.playing = false;
        this.timer = null;
        this.speed = 1;
        this.loop = 0;
        this.zoom = 'fit';
        this.generation = 0;
        this.root = container.element;
        this.root.classList.add('apng-root');
        this._installStyles();
        this._buildUI();
        if (container.on) {
            container.on('destroy', () => this._destroy());
            container.on('resize', () => this._draw());
        }
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (ApngComponent._styleInstalled) return;
        ApngComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.apng-root{height:100%;background:#1f2328;color:#e6edf3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.apng-shell{display:grid;grid-template-rows:auto 1fr auto;height:100%}
.apng-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#2d333b;border-bottom:1px solid #444c56;flex-wrap:wrap}
.apng-root button,.apng-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.apng-root button:hover{background:#444c56}
.apng-root button:disabled{opacity:.4;cursor:default}
.apng-title{font-weight:600;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apng-pos{font-variant-numeric:tabular-nums;min-width:120px}
.apng-scrub{flex:1;min-width:120px}
.apng-status{color:#adbac7;margin-left:auto}
.apng-main{display:grid;grid-template-columns:1fr 320px;min-height:0}
.apng-stage{overflow:auto;display:flex;align-items:center;justify-content:center;min-width:0;min-height:0}
.apng-stage.checker{background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/16px 16px}
.apng-stage.dark{background:#111}.apng-stage.light{background:#fff}
.apng-stage canvas{image-rendering:pixelated;flex:none}
.apng-side{border-left:1px solid #444c56;overflow:auto;background:#22272e}
.apng-side h3{font-size:11px;text-transform:uppercase;color:#adbac7;margin:0;padding:8px 10px 4px}
.apng-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:0 10px 6px}
.apng-kv span:nth-child(odd){color:#adbac7}
.apng-table{border-collapse:collapse;width:100%;font:11px ui-monospace,SFMono-Regular,Consolas,monospace}
.apng-table th{position:sticky;top:0;background:#2d333b;color:#adbac7;text-align:left;font-weight:600}
.apng-table th,.apng-table td{padding:2px 6px;border-bottom:1px solid #2d333b;white-space:nowrap}
.apng-table tr.frame{cursor:pointer}
.apng-table tr.frame:hover td{background:#2d333b}
.apng-table tr.on td{background:#303b49}
.apng-table td.bad{color:#ff938a}
.apng-strip{display:flex;gap:4px;overflow-x:auto;padding:6px;background:#22272e;border-top:1px solid #444c56;min-height:0}
.apng-strip canvas{flex:none;height:56px;border:2px solid transparent;cursor:pointer;background:repeating-conic-gradient(#3a3f46 0 25%,#2a2e34 0 50%) 0 0/8px 8px}
.apng-strip canvas.on{border-color:#4184e4}
.apng-message{padding:20px;color:#adbac7;text-align:center}
.apng-error{padding:20px;color:#ffb4ab;text-align:center}
@media (max-width:800px){.apng-main{grid-template-columns:1fr;grid-template-rows:1fr 40%}.apng-side{border-left:none;border-top:1px solid #444c56}}
`;
        document.head.appendChild(style);
    }

    _el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    _button(label, title, onClick) {
        const b = this._el('button', null, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _select(title, options, value, onChange) {
        const s = this._el('select');
        s.title = title;
        for (const [v, label] of options) s.appendChild(Object.assign(this._el('option', null, label), { value: v }));
        s.value = value;
        s.addEventListener('change', () => onChange(s.value));
        return s;
    }

    _buildUI() {
        this.root.innerHTML = '';
        const shell = this._el('div', 'apng-shell');
        const bar = this._el('div', 'apng-toolbar');
        this.fileInput = this._el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.png,.apng,.jxl,.bpg,image/png,image/apng,image/jxl';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, new Uint8Array(await f.arrayBuffer()));
        });
        this.titleEl = this._el('span', 'apng-title', this.fileName);
        this.firstBtn = this._button('⏮', 'First frame', () => this._show(0));
        this.prevBtn = this._button('◀', 'Previous frame (←)', () => this._step(-1));
        this.playBtn = this._button('▶', 'Play / pause (space)', () => this._toggle());
        this.nextBtn = this._button('▶|', 'Next frame (→)', () => this._step(1));
        this.lastBtn = this._button('⏭', 'Last frame', () => this._show(this.frames.length - 1));
        this.posEl = this._el('span', 'apng-pos');
        this.scrub = this._el('input', 'apng-scrub');
        this.scrub.type = 'range';
        this.scrub.min = 0;
        this.scrub.addEventListener('input', () => { this._pause(); this._show(+this.scrub.value); });
        const speed = this._select('Playback speed', [['0.25', '¼×'], ['0.5', '½×'], ['1', '1×'], ['2', '2×'], ['4', '4×']], '1', v => { this.speed = +v; });
        const zoom = this._select('Zoom', [['fit', 'Fit'], ['1', '100%'], ['2', '200%'], ['4', '400%'], ['8', '800%']], 'fit', v => { this.zoom = v; this._draw(); });
        const bg = this._select('Background', [['checker', 'Checker'], ['dark', 'Dark'], ['light', 'Light']], 'checker', v => { this.stage.className = 'apng-stage ' + v; });
        this.saveBtn = this._button('Save frame', 'Save the frame shown as a PNG', () => this._saveFrame());
        this.statusEl = this._el('span', 'apng-status');
        bar.append(this.fileInput, this._button('Open', 'Open a PNG or APNG from this computer', () => this.fileInput.click()), this.titleEl,
            this.firstBtn, this.prevBtn, this.playBtn, this.nextBtn, this.lastBtn, this.posEl, this.scrub, speed, zoom, bg, this.saveBtn, this.statusEl);

        const main = this._el('div', 'apng-main');
        this.stage = this._el('div', 'apng-stage checker');
        this.canvas = this._el('canvas');
        this.stage.appendChild(this.canvas);
        this.side = this._el('div', 'apng-side');
        main.append(this.stage, this.side);
        this.strip = this._el('div', 'apng-strip');
        shell.append(bar, main, this.strip);
        this.root.appendChild(shell);
        this.root.tabIndex = 0;
        this.root.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (e.key === 'ArrowRight') { this._step(1); e.preventDefault(); }
            else if (e.key === 'ArrowLeft') { this._step(-1); e.preventDefault(); }
            else if (e.key === ' ') { this._toggle(); e.preventDefault(); }
        });
        this._controls(false);
        this.stage.appendChild(this._el('div', 'apng-message', 'Open a PNG or APNG.'));
    }

    _controls(on) {
        for (const b of [this.firstBtn, this.prevBtn, this.playBtn, this.nextBtn, this.lastBtn]) b.disabled = !on;
        this.scrub.disabled = !on;
    }

    async _init() {
        if (!this.fileData) return;
        if (!this.ctx || !this.ctx.currentWorkspacePath) {
            this._error('Opening a project file needs the server workspace; use Open.');
            return;
        }
        try {
            const rel = this.ctx.getRelativePath(this.fileId);
            const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + rel));
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._open(this.fileData.name, new Uint8Array(await resp.arrayBuffer()));
        } catch (err) {
            this._error(`Could not read ${this.fileName}: ${err.message}`);
        }
    }

    async _open(name, bytes) {
        const gen = ++this.generation;
        this._pause();
        for (const f of this.frames) f.close && f.close();
        this.frames = [];
        this.fileName = name;
        this.titleEl.textContent = name;
        this.statusEl.textContent = 'Reading…';
        try {
            // JPEG XL and BPG: decoded to PNG (APNG for animations) first
            this.jxl = null;
            this.bpg = null;
            if (isJxl(bytes)) {
                this.statusEl.textContent = 'Decoding JPEG XL…';
                this.jxl = { size: bytes.length };
                bytes = (await jxlDecode(bytes)).png;
                if (gen !== this.generation) return;
            } else if (isBpg(bytes)) {
                this.statusEl.textContent = 'Decoding BPG…';
                const r = await bpgDecode(bytes);
                if (gen !== this.generation) return;
                this.bpg = { size: bytes.length, label: r.label };
                bytes = r.png;
            }
            const chunks = readChunks(bytes);
            const info = parseApng(chunks);
            this.info = info;
            this.chunks = chunks;
            this.fileSize = bytes.length;
            let frames;
            if (info.frames.length) {
                frames = await composeFrames(info, (i, n) => { if (gen === this.generation) this.statusEl.textContent = `Composing frame ${i + 1} of ${n}…`; });
            } else {
                frames = [await createImageBitmap(new Blob([bytes], { type: 'image/png' }))];
            }
            if (gen !== this.generation) { frames.forEach(f => f.close()); return; }
            this.frames = frames;
            this.loop = 0;
            this.scrub.max = frames.length - 1;
            this._controls(frames.length > 1);
            this._renderSide();
            this._renderStrip();
            this._show(0);
            const total = info.frames.reduce((n, f) => n + f.delayMs, 0);
            this.statusEl.textContent = info.frames.length
                ? `${info.frames.length} frames · ${(total / 1000).toFixed(2)} s · ${info.plays ? `plays ${info.plays}×` : 'loops forever'}`
                : 'Not animated (a plain PNG)';
            if (frames.length > 1) this._play();
        } catch (err) {
            if (gen !== this.generation) return;
            log.error('Open failed:', err);
            this._error(`Could not read ${name}: ${err.message}`);
        }
    }

    _renderSide() {
        const info = this.info;
        this.side.innerHTML = '';
        const kv = (title, rows) => {
            this.side.appendChild(this._el('h3', null, title));
            const box = this._el('div', 'apng-kv');
            for (const [k, v] of rows) if (v !== undefined && v !== '') box.append(this._el('span', null, k), this._el('span', null, String(v)));
            this.side.appendChild(box);
        };
        const total = info.frames.reduce((n, f) => n + f.delayMs, 0);
        kv('Image', [
            ['Size', `${info.width} × ${info.height}`],
            ['Colour', `${COLOR_TYPES[info.colorType] || 'type ' + info.colorType}, ${info.bitDepth}-bit${info.interlace ? ', interlaced' : ''}`],
            ['File', this.jxl ? `JPEG XL, ${this.jxl.size.toLocaleString()} bytes (decoded by jxl-oxide; the chunks below are of the decoded PNG)`
                : this.bpg ? `${this.bpg.label}, ${this.bpg.size.toLocaleString()} bytes (decoded by libbpg; the chunks below are of the decoded PNG)`
                : `${this.fileSize.toLocaleString()} bytes`],
            ...(info.animated ? [
                ['Frames', info.declaredFrames === info.frames.length ? info.frames.length : `${info.frames.length} (acTL says ${info.declaredFrames})`],
                ['Plays', info.plays ? `${info.plays} time${info.plays > 1 ? 's' : ''}` : 'forever'],
                ['Duration', `${(total / 1000).toFixed(3)} s per play`],
                ['Default image', info.defaultIsFrame ? 'is the first frame' : 'not part of the animation (shown by viewers without APNG)'],
            ] : [['Animated', 'no']]),
        ]);
        if (info.frames.length) {
            this.side.appendChild(this._el('h3', null, 'Frames'));
            const t = this._el('table', 'apng-table');
            const hr = t.createTHead().insertRow();
            for (const h of ['#', 'Delay', 'Region', 'Dispose', 'Blend']) hr.appendChild(this._el('th', null, h));
            const tb = t.createTBody();
            this.frameRows = info.frames.map((f, i) => {
                const tr = tb.insertRow();
                tr.className = 'frame';
                const cells = [i + 1, `${Math.round(f.delayMs)} ms`, `${f.width}×${f.height}+${f.x}+${f.y}`, DISPOSE[f.dispose] || f.dispose, BLEND[f.blend] || f.blend];
                for (const c of cells) tr.insertCell().textContent = c;
                tr.title = `delay ${f.delayNum}/${f.delayDen} s, sequence ${f.seq}${f.isDefault ? ', the default image' : ''}`;
                tr.addEventListener('click', () => { this._pause(); this._show(i); });
                return tr;
            });
            this.side.appendChild(t);
        }
        this.side.appendChild(this._el('h3', null, 'Chunks'));
        const t = this._el('table', 'apng-table');
        const hr = t.createTHead().insertRow();
        for (const h of ['Type', 'Offset', 'Length', 'CRC']) hr.appendChild(this._el('th', null, h));
        const tb = t.createTBody();
        // Runs of the same chunk type (IDAT, fdAT) are folded into one row
        const rows = [];
        for (const c of this.chunks) {
            const last = rows[rows.length - 1];
            if (last && last.type === c.type && /^(IDAT|fdAT)$/.test(c.type)) { last.count++; last.length += c.length; last.bad += c.crcOk === false ? 1 : 0; }
            else rows.push({ type: c.type, offset: c.offset, length: c.length, count: 1, bad: c.crcOk === false ? 1 : 0, truncated: c.truncated });
        }
        for (const r of rows) {
            const tr = tb.insertRow();
            tr.insertCell().textContent = r.count > 1 ? `${r.type} ×${r.count}` : r.type;
            tr.insertCell().textContent = r.offset;
            tr.insertCell().textContent = r.length.toLocaleString();
            const crc = tr.insertCell();
            crc.textContent = r.truncated ? 'truncated' : r.bad ? `${r.bad} bad` : 'ok';
            if (r.bad || r.truncated) crc.className = 'bad';
        }
        this.side.appendChild(t);
    }

    _renderStrip() {
        this.strip.innerHTML = '';
        this.thumbs = [];
        this.strip.style.display = this.frames.length > 1 ? '' : 'none';
        if (this.frames.length < 2) return;
        const h = 56;
        const w = Math.max(1, Math.round(h * this.info.width / this.info.height));
        this.frames.slice(0, 500).forEach((f, i) => {
            const c = this._el('canvas');
            c.width = Math.min(w * 2, this.info.width);
            c.height = Math.round(c.width * this.info.height / this.info.width);
            c.style.width = w + 'px';
            c.getContext('2d').drawImage(f, 0, 0, c.width, c.height);
            c.title = `Frame ${i + 1}`;
            c.addEventListener('click', () => { this._pause(); this._show(i); });
            this.strip.appendChild(c);
            this.thumbs.push(c);
        });
    }

    _draw() {
        const f = this.frames[this.index];
        if (!f) return;
        const msg = this.stage.querySelector('.apng-message, .apng-error');
        if (msg) msg.remove();
        if (this.canvas.width !== f.width || this.canvas.height !== f.height) {
            this.canvas.width = f.width;
            this.canvas.height = f.height;
        }
        const c = this.canvas.getContext('2d');
        c.clearRect(0, 0, f.width, f.height);
        c.drawImage(f, 0, 0);
        let scale = +this.zoom;
        if (this.zoom === 'fit') {
            const r = this.stage.getBoundingClientRect();
            scale = Math.min(1, (r.width - 16) / f.width, (r.height - 16) / f.height) || 1;
            if (scale > 1) scale = 1;
            // Small images: scale up to fill, in whole steps so pixels stay square
            if (f.width * 2 <= r.width - 16 && f.height * 2 <= r.height - 16) scale = Math.max(1, Math.floor(Math.min((r.width - 16) / f.width, (r.height - 16) / f.height)));
        }
        this.canvas.style.width = Math.round(f.width * scale) + 'px';
        this.canvas.style.height = Math.round(f.height * scale) + 'px';
    }

    _show(i) {
        if (!this.frames.length) return;
        this.index = Math.max(0, Math.min(this.frames.length - 1, i));
        this._draw();
        this.scrub.value = this.index;
        const f = this.info.frames[this.index];
        this.posEl.textContent = this.frames.length > 1 ? `${this.index + 1} / ${this.frames.length}${f ? ` · ${Math.round(f.delayMs)} ms` : ''}` : '';
        (this.frameRows || []).forEach((r, k) => r.classList.toggle('on', k === this.index));
        (this.thumbs || []).forEach((t, k) => t.classList.toggle('on', k === this.index));
        const row = this.frameRows && this.frameRows[this.index];
        if (row && this.playing) row.scrollIntoView({ block: 'nearest' });
        const thumb = this.thumbs && this.thumbs[this.index];
        if (thumb) thumb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    _step(d) {
        this._pause();
        this._show((this.index + d + this.frames.length) % this.frames.length);
    }

    _toggle() {
        if (this.playing) this._pause(); else this._play();
    }

    _play() {
        if (this.frames.length < 2) return;
        this.playing = true;
        this.playBtn.textContent = '⏸';
        const tick = () => {
            if (!this.playing) return;
            const f = this.info.frames[this.index];
            // As browsers do (like GIF), a delay of 10 ms or less plays as 100 ms
            const delay = (f.delayMs <= 10 ? 100 : f.delayMs) / this.speed;
            this.timer = setTimeout(() => {
                if (!this.playing) return;
                let next = this.index + 1;
                if (next >= this.frames.length) {
                    this.loop++;
                    if (this.info.plays && this.loop >= this.info.plays) { this._pause(); return; }
                    next = 0;
                }
                this._show(next);
                tick();
            }, delay);
        };
        tick();
    }

    _pause() {
        this.playing = false;
        clearTimeout(this.timer);
        if (this.playBtn) this.playBtn.textContent = '▶';
    }

    _saveFrame() {
        const f = this.frames[this.index];
        if (!f) return;
        const c = document.createElement('canvas');
        c.width = f.width;
        c.height = f.height;
        c.getContext('2d').drawImage(f, 0, 0);
        c.toBlob(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${this.fileName.replace(/\.a?png$/i, '')}-frame${String(this.index + 1).padStart(3, '0')}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }, 'image/png');
    }

    _error(message) {
        this.statusEl.textContent = 'Error';
        this.stage.querySelectorAll('.apng-message, .apng-error').forEach(e => e.remove());
        this.stage.appendChild(this._el('div', 'apng-error', message));
    }

    _destroy() {
        this.generation++;
        this._pause();
        for (const f of this.frames) f.close && f.close();
        this.frames = [];
    }
}

registerPlugin({
    id: 'apng',
    name: 'Animated PNG',
    components: {
        apngViewer: ApngComponent,
    },
    toolbarButtons: [
        { label: 'APNG', title: 'Open the animated PNG frame viewer', menuLabel: 'Animated PNG frames' },
    ],
    init(ctx) {
        ApngComponent._ctx = ctx;
    },
});

module.exports = { readChunks, parseApng };
