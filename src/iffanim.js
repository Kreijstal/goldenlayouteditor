// --- Amiga IFF animations (.anim, .anm; an .iff that is one) ---
// No browser plays them. A FORM ANIM holds FORM ILBMs: the first a whole
// picture, each after it an ANHD (the operation, the time to show it in
// jiffies) and a DLTA, the changes from the frame two before (Amiga programs
// drew into two screens by turns). The operations: 0 (a whole ILBM body),
// 1-4, 5 (Byte Vertical, DeluxePaint III's), 7 and 8 (short and long words),
// J (Sculpt-Animate's), l... The pictures are ILBM's: planes, HAM, EHB.
// Read by FFmpeg's iff demuxer and decoder (ffmpeg.wasm's core in a worker,
// public/iffanim-worker.js, loaded from jsDelivr when one is first opened),
// which take Deluxe Paint's PC animations (.anm, LPF) too. The image viewer
// plays one with its own timing (pause, step); the preview and thumbnails show
// the first frame.
const { createLogger } = require('./debug');
const { applyPixelAspect } = require('./ilbm');

const log = createLogger('ANIM');
const WORKER_URL = '/iffanim-worker.js';
const ANIM_RE = /\.(anim|anm)$/i;
// the frames' RGBA kept at most (a frame count FFmpeg is asked for), and frames
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FRAMES = 5000;

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }
const decoded = new Map(); // source URL -> Promise<{ width, height, aspect, frames, label }>
const firsts = new Map(); // source URL -> Promise<{ url, aspect, label }>

function isAnimName(name) {
    return ANIM_RE.test(name || '');
}

const fourcc = (bytes, p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);

// Bytes that are an IFF animation: a FORM of type ANIM
function isAnim(bytes) {
    return bytes.length >= 12 && fourcc(bytes, 0) === 'FORM' && fourcc(bytes, 8) === 'ANIM';
}

// Whether the file at url starts like an IFF animation
async function isAnimUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isAnim(value);
}

function getWorker() {
    if (!worker) {
        worker = new Worker(WORKER_URL);
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error));
            else p.resolve(data);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'FFmpeg worker failed'));
            pending.clear();
            worker = null;
        };
    }
    return worker;
}

// FFmpeg's first `frames` frames of the file: { width, height, aspect, frames: [{ rgba, ms }] }
async function ffmpegFrames(bytes, frames) {
    const id = nextId++;
    const r = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, bytes, frames });
    });
    // framecrc: "#tb 0: 1/60", "#dimensions 0: 160x200", "#sar 0: 12/7", then "0, dts, pts, duration, size, crc" a frame
    const head = key => (r.times.match(new RegExp(`^#${key} 0: (\\d+)[/x](\\d+)`, 'm')) || []).slice(1).map(Number);
    const [tbNum, tbDen] = head('tb');
    const [width, height] = head('dimensions');
    const [sarNum, sarDen] = head('sar');
    if (!width || !height) throw new Error('FFmpeg found no frames');
    const tick = 1000 * (tbNum || 1) / (tbDen || 60);
    const rows = r.times.split('\n').filter(l => /^\d+,/.test(l)).map(l => l.split(',').map(s => +s.trim()));
    const size = width * height * 4;
    const n = Math.min(rows.length, Math.floor(r.raw.length / size));
    const rgba = new Uint8ClampedArray(r.raw.buffer, r.raw.byteOffset, n * size);
    const out = [];
    for (let i = 0; i < n; i++) {
        // shown until the next frame's time (the last for its own duration, else the frame before's)
        const gap = i + 1 < rows.length ? rows[i + 1][2] - rows[i][2] : (out.length ? out[out.length - 1].ticks : rows[i][3]);
        out.push({ rgba: rgba.subarray(i * size, (i + 1) * size), ticks: Math.max(1, gap), ms: Math.max(1, gap) * tick });
    }
    return { width, height, aspect: sarNum && sarDen ? sarNum / sarDen : 1, frames: out };
}

async function fetchBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

function describe(bytes, d, all) {
    const kind = isAnim(bytes) ? 'Amiga IFF animation' : 'Animation';
    if (!all) return `${kind}: ${d.width}×${d.height}`;
    const loop = d.frames.reduce((t, f) => t + f.ms, 0);
    return [
        `${kind}: ${d.width}×${d.height}, ${d.frames.length} frame${d.frames.length > 1 ? 's' : ''}, ${(loop / 1000).toFixed(2)} s a loop`,
        Math.abs(d.aspect - 1) > 0.02 ? `pixels ${d.aspect.toFixed(2)}:1` : '',
    ].filter(Boolean).join(', ');
}

// The whole animation at url: { width, height, aspect, frames: [{ rgba, ms }], label }
function animFile(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const bytes = await fetchBytes(url);
            // the size first (the first frame), then as many frames as fit
            const first = await ffmpegFrames(bytes, 1);
            const cap = Math.max(1, Math.min(MAX_FRAMES, Math.floor(MAX_BYTES / (first.width * first.height * 4))));
            const d = await ffmpegFrames(bytes, cap);
            d.label = describe(bytes, d, true) + (d.frames.length >= cap ? `, the first ${cap} frames shown` : '');
            return d;
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('Animation decode failed:', err); });
        // the frames' pixels are big: few files kept
        if (decoded.size > 4) decoded.delete(decoded.keys().next().value);
    }
    return p;
}

function framePng(frame, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), width, height), 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

// The animation's first frame: { url (a blob: URL of its PNG), aspect, label }
function animImage(url) {
    let p = firsts.get(url);
    if (!p) {
        p = (async () => {
            const bytes = await fetchBytes(url);
            const d = await ffmpegFrames(bytes, 1);
            return { url: URL.createObjectURL(await framePng(d.frames[0], d.width, d.height)), aspect: d.aspect, label: describe(bytes, d, false) };
        })();
        firsts.set(url, p);
        p.catch(err => { firsts.delete(url); log.warn('Animation decode failed:', err); });
        if (firsts.size > 64) {
            const [oldUrl, old] = firsts.entries().next().value;
            firsts.delete(oldUrl);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// The viewer's <img> (the first frame) for an animation: played on a canvas in its
// place with the file's own timing (pause, step), its pixels as wide as they were
function addAnimControls(root, img, url) {
    root.style.position = 'relative';
    animImage(url).then(d => applyPixelAspect(img, d.aspect)).catch(() => {});
    animFile(url).then(d => {
        if (!img.isConnected) return;
        const canvas = document.createElement('canvas');
        canvas.width = d.width;
        canvas.height = d.height;
        canvas.style.cssText = img.style.cssText;
        canvas.title = d.label;
        const ctx = canvas.getContext('2d');
        img.replaceWith(canvas);
        applyPixelAspect(canvas, d.aspect);

        const bar = document.createElement('div');
        bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:4px;align-items:center;z-index:2;'
            + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 4px;font:12px sans-serif;';
        const button = (text, title) => {
            const b = document.createElement('button');
            b.textContent = text;
            b.title = title;
            b.style.cssText = 'background:none;color:inherit;border:none;font:inherit;font-size:14px;cursor:pointer;padding:2px 6px;';
            bar.appendChild(b);
            return b;
        };
        const prev = button('‹', 'Previous frame');
        const play = button('⏸', 'Pause');
        const next = button('›', 'Next frame');
        const info = document.createElement('span');
        bar.appendChild(info);
        root.appendChild(bar);
        let frame = 0;
        let timer = null;
        const show = n => {
            frame = (n + d.frames.length) % d.frames.length;
            const f = d.frames[frame];
            ctx.putImageData(new ImageData(f.rgba, d.width, d.height), 0, 0);
            info.textContent = `${frame + 1} / ${d.frames.length}`;
            info.title = `Frame ${frame + 1}: ${Math.round(f.ms)} ms`;
        };
        const tick = () => {
            if (!root.isConnected) { timer = null; return; }
            show(frame + 1);
            timer = setTimeout(tick, d.frames[frame].ms);
        };
        const pause = () => { clearTimeout(timer); timer = null; play.textContent = '▶'; play.title = 'Play'; };
        play.onclick = () => {
            if (timer) { pause(); return; }
            play.textContent = '⏸';
            play.title = 'Pause';
            timer = setTimeout(tick, d.frames[frame].ms);
        };
        prev.onclick = () => { pause(); show(frame - 1); };
        next.onclick = () => { pause(); show(frame + 1); };
        show(0);
        if (d.frames.length > 1) timer = setTimeout(tick, d.frames[0].ms);
        else pause();
    }).catch(err => { img.title = `Could not play the animation: ${err.message}`; });
}

module.exports = { isAnimName, isAnim, isAnimUrl, animImage, animFile, addAnimControls };
