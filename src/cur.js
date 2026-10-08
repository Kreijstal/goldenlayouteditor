// --- Windows cursors (.cur, animated .ani) and an icon's sizes (.ico) ---
// A .cur is an icon file (a directory of images, BMP or PNG, of several sizes)
// whose entries also hold a hotspot, the pixel that points. Browsers show an
// .ico but not a .cur, and never an animated cursor: a RIFF "ACON" file whose
// frames are icons or cursors, shown for so many jiffies (1/60 s) each, in the
// order its "seq " chunk gives. Both are read by existing libraries, loaded
// from esm.sh when one is first shown: decode-ico (Linus Unnebäck) reads an
// icon or cursor's images and hotspots, ani-cursor's parser (Jordan Eldredge,
// Webamp's) an animated cursor's frames, rates and sequence. Each image
// becomes a PNG any <img> shows; the image viewer turns a cursor's (or an
// icon's) sizes, marks the hotspot and plays an animated cursor with its own
// timing. A .cur that is a RIFF file (Winamp skins name theirs so) is animated.
const { createLogger } = require('./debug');
const { addTiffPager } = require('./tiff');

const log = createLogger('CUR');
const DECODE_ICO = 'https://esm.sh/decode-ico@0.4.1';
const ANI_PARSER = 'https://esm.sh/ani-cursor@2.3.1/dist/parser.js';
const CURSOR_RE = /\.(cur|ani)$/i;
const ICO_RE = /\.ico$/i;
const JIFFY_MS = 1000 / 60;
// the size a cursor is blown up to in the viewer, pixels kept square
const VIEW_SIZE = 256;

let icoPromise = null;
let aniPromise = null;
const decoded = new Map(); // source URL -> Promise<{ frames, steps, animated, label }>
const entries = new Map(); // blob URL -> the image it shows ({ width, height, bpp, hotspot })

function isCursorName(name) {
    return CURSOR_RE.test(name || '');
}

function isIcoName(name) {
    return ICO_RE.test(name || '');
}

// "RIFF" .... "ACON": an animated cursor
function isAni(bytes) {
    return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'ACON';
}

function decodeIco() {
    if (!icoPromise) {
        icoPromise = import(DECODE_ICO).then(m => m.default || m);
        icoPromise.catch(() => { icoPromise = null; });
    }
    return icoPromise;
}

function aniParser() {
    if (!aniPromise) {
        aniPromise = import(ANI_PARSER).then(m => m.parseAni);
        aniPromise.catch(() => { aniPromise = null; });
    }
    return aniPromise;
}

// One of decode-ico's images as a PNG blob URL: a PNG entry's own bytes, a BMP's pixels drawn
async function entryUrl(img) {
    let blob;
    if (img.type === 'png') {
        blob = new Blob([img.data], { type: 'image/png' });
    } else {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
        blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed')), 'image/png'));
    }
    const url = URL.createObjectURL(blob);
    entries.set(url, { width: img.width, height: img.height, bpp: img.bpp, hotspot: img.hotspot });
    return url;
}

// An icon or cursor file's images, largest first: [{ url, width, height, bpp, hotspot }]
async function readIcon(bytes) {
    const images = (await decodeIco())(bytes);
    if (!images.length) throw new Error('The file holds no images');
    const out = [];
    for (const img of images) out.push({ url: await entryUrl(img), width: img.width, height: img.height, bpp: img.bpp, hotspot: img.hotspot });
    return out.sort((a, b) => b.width * b.height - a.width * a.height || b.bpp - a.bpp);
}

const size = e => `${e.width}×${e.height}${e.bpp ? ` ${e.bpp}-bit` : ''}`;
const hotspotText = e => e.hotspot ? `, hotspot ${e.hotspot.x},${e.hotspot.y}` : '';

// The file's frames (one for a still cursor or icon: its images), the animation's steps
// ([{ frame, ms }], null if still) and what it is
async function cursorFile(url) {
    let p = decoded.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            if (!isAni(bytes)) {
                const images = await readIcon(bytes);
                const cursor = images.some(e => e.hotspot);
                const label = `${cursor ? 'Windows cursor' : 'Icon'}: ${images.length} image${images.length > 1 ? 's' : ''} (${images.map(size).join(', ')})${hotspotText(images[0])}`;
                return { frames: [images], steps: null, animated: false, label };
            }
            const ani = (await aniParser())(bytes);
            if (!ani.images.length) throw new Error('The animated cursor holds no frames');
            const frames = [];
            for (const icon of ani.images) frames.push(await readIcon(icon));
            // the steps: the sequence's frames (else each frame once), for its rate (else the header's)
            const order = ani.seq || frames.map((_, i) => i);
            const steps = order.map((frame, i) => ({
                frame: Math.min(frame, frames.length - 1),
                ms: ((ani.rate && ani.rate[i] != null ? ani.rate[i] : ani.metadata.iDispRate) || 1) * JIFFY_MS,
            }));
            const loop = steps.reduce((t, s) => t + s.ms, 0);
            const name = [ani.title && `"${ani.title.replace(/\0+$/, '')}"`, ani.artist && `by ${ani.artist.replace(/\0+$/, '')}`].filter(Boolean).join(' ');
            const label = `Animated cursor${name ? ' ' + name : ''}: ${frames.length} frame${frames.length > 1 ? 's' : ''}, `
                + `${steps.length} step${steps.length > 1 ? 's' : ''}, ${Math.round(loop)} ms a loop, ${size(frames[0][0])}${hotspotText(frames[0][0])}`;
            return { frames, steps, animated: true, label };
        })();
        decoded.set(url, p);
        p.catch(err => { decoded.delete(url); log.warn('Cursor decode failed:', err); });
        if (decoded.size > 64) {
            const [oldUrl, old] = decoded.entries().next().value;
            decoded.delete(oldUrl);
            old.then(d => d.frames.flat().forEach(e => { entries.delete(e.url); URL.revokeObjectURL(e.url); })).catch(() => {});
        }
    }
    return p;
}

// { url (the first frame's largest image, as a PNG blob URL), label }
async function cursorImage(url) {
    const d = await cursorFile(url);
    return { url: d.frames[0][0].url, label: d.label };
}

// Page `page`: a still file's images by size, an animated cursor's frames (largest image each)
// as { url, pages: [{ width, height, label }], page }, for addTiffPager
async function cursorPage(url, page = 0) {
    const d = await cursorFile(url);
    const shown = d.animated ? d.frames.map(f => f[0]) : d.frames[0];
    const pages = shown.map((e, i) => ({
        width: e.width, height: e.height,
        label: (d.animated ? `Frame ${i + 1}: ` : '') + size(e) + hotspotText(e),
    }));
    const n = Math.max(0, Math.min(shown.length - 1, page));
    return { url: shown[n].url, pages, page: n };
}

// The viewer's <img> for a cursor or icon: its pixels blown up square, the hotspot marked;
// a still one's sizes to turn, an animated one played with its own timing (pause, step)
function addCursorControls(root, img, url) {
    root.style.position = 'relative';
    const mark = document.createElement('div');
    mark.title = 'Hotspot';
    mark.style.cssText = 'position:absolute;width:17px;height:17px;margin:-9px 0 0 -9px;pointer-events:none;display:none;z-index:1;'
        + 'background:linear-gradient(#f0f,#f0f) center/1px 100% no-repeat,linear-gradient(#f0f,#f0f) center/100% 1px no-repeat;'
        + 'border:2px solid #f0f;border-radius:50%;box-sizing:border-box;box-shadow:0 0 0 1px #fff;';
    root.appendChild(mark);
    img.style.imageRendering = 'pixelated';
    // each image shown: blown up by a whole factor, the hotspot's pixel marked
    const place = () => {
        const e = entries.get(img.src);
        if (!e || !img.naturalWidth) return;
        const k = Math.max(1, Math.floor(VIEW_SIZE / Math.max(e.width, e.height)));
        img.style.width = `${e.width * k}px`;
        img.style.height = 'auto';
        if (!e.hotspot) { mark.style.display = 'none'; return; }
        const s = img.clientWidth / e.width;
        mark.style.left = `${img.offsetLeft + (e.hotspot.x + 0.5) * s}px`;
        mark.style.top = `${img.offsetTop + (e.hotspot.y + 0.5) * s}px`;
        mark.style.display = '';
    };
    img.addEventListener('load', place);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(place).observe(root);
    place();

    cursorFile(url).then(d => {
        img.title = d.label;
        if (!d.animated) {
            // an .ico the browser showed itself: its largest image, as the pager's first page is
            if (!entries.has(img.src)) img.src = d.frames[0][0].url;
            addTiffPager(root, img, url, d.frames[0].map(e => ({ width: e.width, height: e.height, label: size(e) + hotspotText(e) })), cursorPage);
            return;
        }
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
        const prev = button('‹', 'Previous step');
        const play = button('⏸', 'Pause');
        const next = button('›', 'Next step');
        const info = document.createElement('span');
        bar.appendChild(info);
        root.appendChild(bar);
        let step = 0;
        let timer = null;
        const show = n => {
            step = (n + d.steps.length) % d.steps.length;
            const s = d.steps[step];
            img.src = d.frames[s.frame][0].url;
            info.textContent = `${step + 1} / ${d.steps.length}`;
            info.title = `Step ${step + 1}: frame ${s.frame + 1}, ${Math.round(s.ms)} ms`;
        };
        const tick = () => {
            if (!root.isConnected) { timer = null; return; }
            show(step + 1);
            timer = setTimeout(tick, d.steps[step].ms);
        };
        const pause = () => { clearTimeout(timer); timer = null; play.textContent = '▶'; play.title = 'Play'; };
        play.onclick = () => {
            if (timer) { pause(); return; }
            play.textContent = '⏸';
            play.title = 'Pause';
            timer = setTimeout(tick, d.steps[step].ms);
        };
        prev.onclick = () => { pause(); show(step - 1); };
        next.onclick = () => { pause(); show(step + 1); };
        show(0);
        if (d.steps.length > 1) timer = setTimeout(tick, d.steps[0].ms);
        else pause();
    }).catch(err => { img.title = `Could not read the cursor: ${err.message}`; });
}

module.exports = { isCursorName, isIcoName, isAni, cursorFile, cursorImage, cursorPage, addCursorControls };
