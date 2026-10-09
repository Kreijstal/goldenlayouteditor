// --- Camera raw files (.dng, .crw, .cr2, .cr3, .nef, .arw, .orf, .rw2, .raf, .pef, .srw...) ---
// What a camera's sensor recorded, before the camera made a JPEG of it: a
// mosaic of red, green and blue samples (Bayer's, Fujifilm's X-Trans) of 12
// or 14 bits, in a TIFF (DNG, CR2, NEF, ARW, PEF...), Canon's CIFF (CRW) or
// ISO media (CR3) container, mostly with a JPEG preview the camera made. No
// browser shows them. LibRaw reads them all, in a worker (public/raw-worker.js,
// libraw-wasm from jsDelivr): the picture demosaiced and turned to sRGB as
// dcraw_emu does it (half size by default, being four times quicker; the
// camera's white balance, or LibRaw's, or daylight), or the embedded preview
// as it is; what the camera says (make, model, ISO, shutter, aperture, focal
// length, time) in the title and a panel. Thumbnails from the preview, which
// needs no decoding of the raw data (a half-size picture if there is none).
const { createLogger } = require('./debug');

const log = createLogger('RAW');
const RAW_RE = /\.(dng|crw|cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|raf|pef|srw|3fr|fff|erf|kdc|mrw|mos|iiq|rwl|mef)$/i;
// The picture first shown, and the thumbnails' long side
const DEFAULT_HOW = 'half';
const DEFAULT_WB = 'camera';
const THUMB_SIZE = 256;

let worker = null;
let nextId = 1;
const pending = new Map();
const files = new Map(); // source URL -> Promise<Uint8Array>
const decoded = new Map(); // source URL + '#' + how + '#' + wb -> Promise<{ url, width, height, label, meta, preview }>

function isRawName(name) {
    return RAW_RE.test(name || '');
}

// what: 'image' (settings: LibRaw's) or 'thumb' (its embedded preview, size: its long side at most, 0 as it is)
// → { image (PNG or JPEG bytes), type, width, height, meta }
function rawDecode(bytes, what, settings, size = 0) {
    if (!worker) {
        worker = new Worker('/raw-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => {
            const p = pending.get(data.id);
            if (!p) return;
            pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => {
            for (const p of pending.values()) p.reject(new Error(e.message || 'LibRaw failed to load'));
            pending.clear();
            worker = null;
        };
    }
    const id = nextId++;
    const copy = bytes.slice();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, bytes: copy.buffer, what, settings, size }, [copy.buffer]);
    });
}

function fileBytes(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return new Uint8Array(await resp.arrayBuffer());
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // raw files are big: the last few only (for the size or white balance to change)
        if (files.size > 3) files.delete(files.keys().next().value);
    }
    return p;
}

// LibRaw's settings for a picture: how ('half', 'full'), wb ('camera', 'auto', 'daylight')
function rawSettings(how, wb) {
    return { halfSize: how === 'half', useCameraWb: wb === 'camera', useAutoWb: wb === 'auto' };
}

// 1/250 s, 2 s...
function shutterText(s) {
    if (!(s > 0)) return '';
    return s < 1 ? `1/${Math.round(1 / s)} s` : `${Number(s.toPrecision(3))} s`;
}

// What the camera says, as [name, value] pairs (the ones it said)
function rawFields(meta) {
    const camera = [meta.camera_make, meta.camera_model].filter(Boolean).join(' ');
    const fields = [
        ['Camera', camera],
        ['ISO', meta.iso_speed > 0 ? String(Math.round(meta.iso_speed)) : ''],
        ['Shutter', shutterText(meta.shutter)],
        ['Aperture', meta.aperture > 0 ? `f/${Number(meta.aperture.toPrecision(3))}` : ''],
        ['Focal length', meta.focal_len > 0 ? `${Number(meta.focal_len.toPrecision(4))} mm` : ''],
        ['Taken', meta.timestamp > 0 ? new Date(meta.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19) : ''],
        ['Size', meta.width ? `${meta.width}×${meta.height} (sensor ${meta.raw_width}×${meta.raw_height})` : ''],
        ['Orientation', ({ 3: 'turned half a turn', 5: 'turned left', 6: 'turned right' })[meta.flip] || ''],
        ['Preview', meta.thumb_width ? `${meta.thumb_width}×${meta.thumb_height} ${meta.thumb_format === 1 ? 'JPEG' : meta.thumb_format === 2 ? 'bitmap' : ''}`.trim() : 'none'],
        ['Description', (meta.desc || '').trim()],
        ['Artist', (meta.artist || '').trim()],
    ];
    return fields.filter(([, v]) => v);
}

// "Canon EOS 350D, ISO 400, 1/200 s, f/8, 50 mm"
function rawLabel(meta) {
    const f = new Map(rawFields(meta));
    return ['Camera', 'ISO', 'Shutter', 'Aperture', 'Focal length'].filter(k => f.has(k))
        .map(k => (k === 'ISO' ? `ISO ${f.get(k)}` : f.get(k))).join(', ') || 'Camera raw';
}

// The raw file at url as a picture: how ('half', 'full': demosaiced by LibRaw;
// 'preview': the camera's own JPEG), wb (white balance: 'camera', 'auto', 'daylight')
// → { url (a blob: URL), width, height, label, meta, preview }
function rawImage(url, how = DEFAULT_HOW, wb = DEFAULT_WB) {
    const key = `${url}#${how}#${how === 'preview' ? '' : wb}`;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            const bytes = await fileBytes(url);
            const r = how === 'preview' ? await rawDecode(bytes, 'thumb', {}) : await rawDecode(bytes, 'image', rawSettings(how, wb));
            return {
                url: URL.createObjectURL(new Blob([r.image], { type: r.type })),
                width: r.width, height: r.height, meta: r.meta, label: rawLabel(r.meta), preview: how === 'preview',
            };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('camera raw decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (decoded.size > 64) {
            const [oldKey, old] = decoded.entries().next().value;
            decoded.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// A thumbnail of the raw file at url: its embedded preview, small; a half-size picture if it has none
function rawThumbnail(url) {
    const key = `${url}#thumb`;
    let p = decoded.get(key);
    if (!p) {
        p = (async () => {
            // the file itself, not kept: thumbnails would push the open files out
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            const r = await rawDecode(bytes, 'thumb', {}, THUMB_SIZE)
                .catch(() => rawDecode(bytes, 'image', rawSettings('half', DEFAULT_WB)));
            return { url: URL.createObjectURL(new Blob([r.image], { type: r.type })), width: r.width, height: r.height, meta: r.meta, label: rawLabel(r.meta) };
        })();
        decoded.set(key, p);
        p.catch(err => { decoded.delete(key); log.warn('camera raw thumbnail failed:', err); });
        if (decoded.size > 64) {
            const [oldKey, old] = decoded.entries().next().value;
            decoded.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the raw file at url (root is the viewer's
// element): what the camera says in the title and a panel; the picture's size
// (half, full, the camera's preview) and white balance to pick
function addRawControls(root, img, url) {
    root.style.position = 'relative';
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;z-index:1;'
        + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;max-width:calc(100% - 16px);';
    const select = (title, options, value) => {
        const s = document.createElement('select');
        s.title = title;
        s.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
        for (const [v, t] of options) s.add(new Option(t, v));
        s.value = value;
        return s;
    };
    const how = select('The picture: LibRaw\'s, at half or full size, or the preview the camera made',
        [['half', 'Half size'], ['full', 'Full size'], ['preview', 'Camera preview']], DEFAULT_HOW);
    const wb = select('White balance: the camera\'s, LibRaw\'s from the picture, or daylight',
        [['camera', 'As shot'], ['auto', 'Auto'], ['daylight', 'Daylight']], DEFAULT_WB);
    const info = document.createElement('span');
    bar.append(how, wb, info);

    const panel = document.createElement('details');
    panel.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1;max-width:calc(100% - 16px);'
        + 'background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const summary = document.createElement('summary');
    summary.textContent = 'Camera';
    summary.style.cssText = 'cursor:pointer;';
    const fields = document.createElement('div');
    fields.style.cssText = 'max-height:60vh;overflow:auto;margin-top:4px;font:12px monospace;white-space:pre;user-select:text;';
    panel.append(summary, fields);
    panel.hidden = true;
    root.append(bar, panel);

    let turn = 0;
    const show = async () => {
        const mine = ++turn;
        wb.disabled = how.value === 'preview';
        info.textContent = 'decoding…';
        try {
            const d = await rawImage(url, how.value, wb.value);
            if (mine !== turn) return;
            img.src = d.url;
            img.title = `${d.label}; ${d.preview ? 'the camera\'s preview' : 'LibRaw'}, ${d.width}×${d.height}`;
            info.textContent = '';
        } catch (err) {
            if (mine === turn) info.textContent = err.message;
        }
    };
    how.onchange = wb.onchange = show;
    rawImage(url).then(d => {
        img.title = `${d.label}; LibRaw, ${d.width}×${d.height}`;
        fields.textContent = rawFields(d.meta).map(([n, v]) => `${n}: ${v}`).join('\n');
        panel.hidden = false;
        // a file without a preview has none to pick
        if (!d.meta.thumb_width) how.remove(2);
    }).catch(err => { info.textContent = err.message; });
    return bar;
}

module.exports = { isRawName, rawDecode, rawImage, rawThumbnail, rawLabel, addRawControls };
