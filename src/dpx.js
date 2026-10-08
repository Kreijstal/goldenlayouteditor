// --- Kodak Cineon (.cin; a .cin that is one) and SMPTE DPX (.dpx) to PNG ---
// Film scans and the frames of digital intermediates: a header (the file's,
// the image's elements, the film's edge code and frame, the television's time
// code...), then the pixels, mostly 10-bit RGB packed three to a 32-bit word,
// big- or little-endian, as printing density (logarithmic, Cineon's always),
// or linear. DPX (SMPTE 268M) grew out of Cineon and takes 1 to 16 bits, gray,
// RGB, RGBA. No browser shows either; here ImageMagick (magick-wasm, the copy
// src/pict.js loads) reads them and writes a PNG, a logarithmic one turned
// linear by ImageMagick's own Cineon curve (reference black 95, white 685,
// film gamma 0.6, the defaults it reads from the "reference-black",
// "reference-white" and "film-gamma" properties): the viewer's exposure moves
// the reference white, a stop 0.6 / 0.002 × log10 2 ≈ 90 codes, or shows the
// codes as stored. Not FFmpeg's (src/iffanim.js has it loaded): it has no
// Cineon decoder and gives a DPX's codes as they are. This ImageMagick holds 8
// bits a sample, so a logarithmic image's codes are rounded to 8 bits before
// the curve (a few levels off the 16-bit ImageMagick's in the highlights).
// Only the first image element is read. .cin is also an input method's table
// (text, xcin's / gcin's): a .cin is Cineon only if its bytes say so.
const { createLogger } = require('./debug');
const { magick } = require('./pict');

const log = createLogger('DPX');
const DPX_RE = /\.dpx$/i;
const CIN_RE = /\.cin$/i;
// ImageMagick's Cineon curve: a stop in 10-bit codes at its film gamma (0.6), 0.002 density a code
const CODES_PER_STOP = 0.6 / 0.002 * Math.LOG10E * Math.LN2;
const REFERENCE_WHITE = 685;

const files = new Map(); // source URL -> Promise<Uint8Array>
const converted = new Map(); // source URL + how -> Promise<{ url, width, height, log, label, header }>

function isDpxName(name) {
    return DPX_RE.test(name || '');
}

// A name Cineon shares with input methods' tables (a .cin is one only once its bytes say so)
function isCinName(name) {
    return CIN_RE.test(name || '');
}

// Which of the two the bytes start: 'dpx' ("SDPX", "XPDS" little-endian),
// 'cin' (802A5FD7, D75F2A80 little-endian) or ''
function dpxKind(bytes) {
    if (bytes.length < 4) return '';
    const m = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (m === 'SDPX' || m === 'XPDS') return 'dpx';
    const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    if (n === 0x802a5fd7 || n === 0xd75f2a80) return 'cin';
    return '';
}

// Bytes that start a Cineon file
function isCineon(bytes) {
    return dpxKind(bytes) === 'cin';
}

// Whether the file at url is a Cineon file (for a .cin)
async function isCineonUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isCineon(value);
}

function fileBytes(url) {
    let p = files.get(url);
    if (!p) {
        p = (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return new Uint8Array(await resp.arrayBuffer());
        })();
        files.set(url, p);
        p.catch(() => files.delete(url));
        // a film frame is big: few kept (for the exposure to move)
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// { png: Uint8Array, width, height, log (whether its codes are logarithmic), label,
//   header: [[name, value]] (ImageMagick's dpx:... properties, the file's header fields) }
// ev: the exposure, in stops; stored: the codes as stored, not turned linear
async function dpxDecode(bytes, ev = 0, stored = false) {
    const kind = dpxKind(bytes);
    if (!kind) throw new Error('not a DPX or Cineon file');
    const { ImageMagick, MagickFormat, ColorSpace } = await magick();
    return ImageMagick.read(bytes, kind === 'cin' ? MagickFormat.Cin : MagickFormat.Dpx, image => {
        const { width, height, depth, hasAlpha } = image;
        const logCodes = image.colorSpace === ColorSpace.Log;
        const gray = image.colorSpace === ColorSpace.Gray;
        const prop = n => image.getAttribute(n) || '';
        // the header's fields, as ImageMagick names them (not its own date: ones, of reading the file)
        const header = image.attributeNames.filter(n => !/^date:/.test(n)).map(n => [n.replace(/^dpx:/, ''), prop(n)]).filter(([, v]) => v !== '');
        if (logCodes && stored) image.setAttribute('colorspace', 'sRGB'); // the codes as they are (ImageMagick's -set colorspace)
        else if (logCodes && ev) image.setAttribute('reference-white', String(REFERENCE_WHITE - ev * CODES_PER_STOP));
        const png = image.write(MagickFormat.Png, data => data.slice());
        const transfer = prop('dpx:image.element[0].transfer-characteristic');
        const version = prop('dpx:file.version');
        const label = [
            `${kind === 'cin' ? 'Kodak Cineon' : 'DPX'}${version ? ' ' + version : ''}, ${width}×${height}`,
            `${depth}-bit ${gray ? 'gray' : 'RGB'}${hasAlpha ? ' and alpha' : ''}`,
            logCodes ? `logarithmic${transfer && transfer !== 'Logarithmic' ? ` (${transfer})` : ''}` : transfer && !/UserDefined|Unspecified/.test(transfer) ? transfer : '',
            bytes[0] === 0x58 || bytes[0] === 0xd7 ? 'little-endian' : '',
            prop('dpx:file.creator') || prop('dpx:origination.model'),
        ].filter(Boolean).join(', ');
        return { png, width, height, log: logCodes, label, header };
    });
}

// The DPX or Cineon file at url as a PNG: { url (a blob: URL), width, height, log, label, header };
// ev and stored as dpxDecode's
function dpxImage(url, ev = 0, stored = false) {
    const key = `${url}#${stored ? 'stored' : ev}`;
    let p = converted.get(key);
    if (!p) {
        p = (async () => {
            const r = await dpxDecode(await fileBytes(url), ev, stored);
            return { ...r, url: URL.createObjectURL(new Blob([r.png], { type: 'image/png' })), png: undefined };
        })();
        converted.set(key, p);
        p.catch(err => { converted.delete(key); log.warn('DPX / Cineon decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (converted.size > 64) {
            const [oldKey, old] = converted.entries().next().value;
            converted.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the DPX or Cineon file at url (root is the
// viewer's element, positioned): a logarithmic one's exposure, or its codes
// as stored; the header's fields in a panel that opens
function addDpxControls(root, img, url) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center;z-index:1;'
        + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const label = document.createElement('span');
    label.textContent = 'Exposure';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-6';
    slider.max = '6';
    slider.step = '0.25';
    slider.value = '0';
    slider.title = 'Exposure, in stops: ImageMagick\'s reference white moved (double-click: 0)';
    slider.style.cssText = 'width:120px;';
    const value = document.createElement('span');
    value.style.cssText = 'min-width:3.5em;font-variant-numeric:tabular-nums;';
    const mode = document.createElement('select');
    mode.title = 'Log to linear, by ImageMagick\'s Cineon curve, or the codes as stored';
    mode.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
    for (const [v, t] of [['linear', 'Linear'], ['stored', 'As stored (log)']]) mode.add(new Option(t, v));
    bar.append(label, slider, value, mode);
    bar.hidden = true;

    const header = document.createElement('details');
    header.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1;max-width:calc(100% - 16px);'
        + 'background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const summary = document.createElement('summary');
    summary.textContent = 'Header';
    summary.style.cssText = 'cursor:pointer;';
    const fields = document.createElement('div');
    fields.style.cssText = 'max-height:60vh;overflow:auto;margin-top:4px;font:12px monospace;white-space:pre;user-select:text;';
    header.append(summary, fields);
    header.hidden = true;

    let turn = 0;
    let timer = null;
    const show = () => {
        const ev = +slider.value;
        const stored = mode.value === 'stored';
        value.textContent = (ev > 0 ? '+' : '') + ev + ' EV';
        slider.disabled = stored;
        const mine = ++turn;
        clearTimeout(timer);
        // while the slider moves, once it rests for a moment
        timer = setTimeout(async () => {
            try {
                const d = await dpxImage(url, ev, stored);
                if (mine === turn) img.src = d.url;
            } catch (err) {
                if (mine === turn) value.textContent = err.message;
            }
        }, 60);
    };
    slider.oninput = show;
    slider.ondblclick = () => { slider.value = '0'; show(); };
    mode.onchange = show;
    dpxImage(url).then(d => {
        img.title = d.label;
        bar.title = d.label;
        // only a logarithmic image has an exposure to move
        bar.hidden = !d.log;
        fields.textContent = d.header.map(([n, v]) => `${n}: ${v}`).join('\n');
        summary.textContent = `Header (${d.header.length} fields)`;
        header.hidden = !d.header.length;
    }).catch(err => { img.title = err.message; });
    value.textContent = '0 EV';
    root.append(bar, header);
    return bar;
}

module.exports = { isDpxName, isCinName, dpxKind, isCineon, isCineonUrl, dpxDecode, dpxImage, addDpxControls };
