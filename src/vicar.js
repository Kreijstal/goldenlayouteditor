// --- VICAR, JPL's image format (.vic, .vicar; an .img that starts "LBLSIZE=") ---
// The Video Image Communication And Retrieval format of JPL's Multimission Image
// Processing Laboratory: Voyager, Galileo, Cassini, the Mars rovers' images, in
// the PDS too (an .img beside a detached .lbl, or after a PDS label). A text
// label ("LBLSIZE=n  FORMAT='HALF'  ...  NL=  NS=  NB= ...", keyword=value
// pairs, 'strings', (lists), PROPERTY='...' and TASK='...' groups after the
// system items) padded to LBLSIZE bytes, NLB binary header records, then the
// image's records of RECSIZE bytes, each NBB bytes of binary prefix and N1
// values; maybe an end-of-dataset label after them (EOL=1). Read here: BYTE,
// HALF, FULL, REAL, DOUB and COMP (complex) values, either INTFMT (HIGH, LOW)
// and REALFMT (IEEE, RIEEE, VAX), the BSQ, BIL and BIP organizations, and the
// BASIC and BASIC2 compressions (records coded one by one, as VICAR's
// basic_compression.c and GDAL's VICAR driver have it). No browser shows it:
// a band is drawn to a PNG for the image viewer, the preview and the
// thumbnails; three bands are a color picture, or pages as the others are.
// Scientific data being high dynamic range, the picture is windowed with FITS's
// intervals and stretches (src/fits.js), the interval taken over all bands so
// they compare, or the window given by hand; bytes are shown as they are by
// default. The label, the end-of-dataset one too, is in a panel that opens.
const { createLogger } = require('./debug');
const { INTERVALS, STRETCHES, fitsLimits, fitsLevels, rgbaToPng } = require('./fits');

const log = createLogger('VICAR');
const VICAR_RE = /\.(vic|vicar)$/i;
// The PDS's name for its images, a disk image's too: VICAR only if it starts "LBLSIZE="
const VICAR_MAYBE_RE = /\.img$/i;
const files = new Map(); // URL -> Promise<file>
const drawn = new Map(); // URL + view -> Promise<{ url, ... }>

function isVicarName(name) {
    return VICAR_RE.test(name || '');
}

function isVicarMaybeName(name) {
    return VICAR_MAYBE_RE.test(name || '');
}

// Bytes that start a VICAR label: "LBLSIZE=" (spaces around the = too, as some write it)
function isVicar(bytes) {
    return /^LBLSIZE *=/.test(String.fromCharCode(...bytes.subarray(0, 16)));
}

// Whether the file at url is a VICAR image (for an .img)
async function isVicarUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isVicar(value);
}

// --- Label ---

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eEdD][+-]?\d+)?$/;

// A label's text (to its first NUL): [{ key, value (a number, a string, or a list of
// them), raw (the value as written) }], in order
function parseLabel(text) {
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const items = [];
    const n = text.length;
    let i = 0;
    const white = () => { while (i < n && /\s/.test(text[i])) i++; };
    const scalar = inList => {
        if (text[i] === "'") {
            let s = '';
            for (i++; i < n; i++) {
                if (text[i] !== "'") s += text[i];
                else if (text[i + 1] === "'") { s += "'"; i++; }
                else { i++; break; }
            }
            return s;
        }
        const start = i;
        while (i < n && !/\s/.test(text[i]) && !(inList && (text[i] === ',' || text[i] === ')'))) i++;
        const word = text.slice(start, i);
        return NUMBER_RE.test(word) ? Number(word.replace(/[dD]/, 'e')) : word;
    };
    for (;;) {
        white();
        if (i >= n) break;
        const eq = text.indexOf('=', i);
        const key = eq < 0 ? '' : text.slice(i, eq).trim();
        // what is no "keyword=" ends the label
        if (!key || /\s/.test(key)) break;
        i = eq + 1;
        white();
        const start = i;
        let value;
        if (text[i] === '(') {
            value = [];
            for (i++; i < n;) {
                white();
                value.push(scalar(true));
                white();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === ')') i++;
                break;
            }
        } else value = scalar(false);
        items.push({ key: key.toUpperCase(), value, raw: text.slice(start, i) });
    }
    return items;
}

// The system items: those before the first PROPERTY or TASK
function systemItems(items) {
    const sys = {};
    for (const it of items) {
        if (it.key === 'PROPERTY' || it.key === 'TASK') break;
        if (!(it.key in sys)) sys[it.key] = it.value;
    }
    return sys;
}

// The label for its panel: a line an item, a blank line and the group's items
// indented under each PROPERTY and TASK; the end-of-dataset label after a rule
function labelText(items, eolItems) {
    const lines = [];
    const add = list => {
        let grouped = false;
        for (const it of list) {
            if (it.key === 'PROPERTY' || it.key === 'TASK') {
                lines.push('', `${it.key}=${it.raw}`);
                grouped = true;
            } else lines.push(`${grouped ? '  ' : ''}${it.key}=${it.raw}`);
        }
    };
    add(items);
    if (eolItems) {
        lines.push('', '--- end-of-dataset label ---');
        add(eolItems);
    }
    return lines.join('\n');
}

// --- Data ---

// Each FORMAT's bytes per value, components (two for complex) and typed array
const FORMATS = {
    BYTE: { name: 'BYTE', size: 1, comps: 1, Array: Uint8Array, int: true },
    HALF: { name: 'HALF', size: 2, comps: 1, Array: Int16Array, int: true },
    FULL: { name: 'FULL', size: 4, comps: 1, Array: Int32Array, int: true },
    REAL: { name: 'REAL', size: 4, comps: 1, Array: Float32Array, int: false },
    DOUB: { name: 'DOUB', size: 8, comps: 1, Array: Float64Array, int: false },
    COMP: { name: 'COMP', size: 8, comps: 2, Array: Float32Array, int: false },
};
// Old spellings
FORMATS.WORD = FORMATS.HALF;
FORMATS.LONG = FORMATS.FULL;
FORMATS.COMPLEX = FORMATS.COMP;
// The values an integer format holds (bytes are shown as they are)
const FORMAT_RANGE = { BYTE: [0, 255], HALF: [-32768, 32767], FULL: [-2147483648, 2147483647] };

// What the system label says of the image
function describe(sys) {
    const word = (k, d) => String(sys[k] === undefined ? d : sys[k]).trim().toUpperCase();
    const int = (k, d = 0) => (Number.isInteger(sys[k]) ? sys[k] : d);
    const format = FORMATS[word('FORMAT', 'BYTE')];
    if (!format) throw new Error(`FORMAT '${sys.FORMAT}' is not read here`);
    const org = word('ORG', 'BSQ');
    if (!['BSQ', 'BIL', 'BIP'].includes(org)) throw new Error(`ORG '${sys.ORG}' is not read here`);
    // N1 the fastest: samples, bands or lines as the organization has them
    const n1 = int('N1'), n2 = int('N2'), n3 = int('N3', 1);
    const ns = int('NS', org === 'BIP' ? n2 : n1);
    const nl = int('NL', org === 'BSQ' ? n2 : n3);
    const nb = int('NB', org === 'BSQ' ? n3 : org === 'BIL' ? n2 : n1) || 1;
    if (!(ns > 0 && nl > 0)) throw new Error(`NS=${sys.NS} NL=${sys.NL}: no picture`);
    const dims = { BSQ: [ns, nl, nb], BIL: [ns, nb, nl], BIP: [nb, ns, nl] }[org];
    const nbb = int('NBB'), nlb = int('NLB');
    const recsize = int('RECSIZE', nbb + dims[0] * format.size);
    if (recsize < nbb + dims[0] * format.size) throw new Error(`RECSIZE=${recsize} is too short for NBB=${nbb} and ${dims[0]} values`);
    const intfmt = word('INTFMT', 'LOW'), realfmt = word('REALFMT', 'VAX');
    if (format.int ? !['LOW', 'HIGH'].includes(intfmt) : !['IEEE', 'RIEEE', 'VAX'].includes(realfmt)) {
        throw new Error(format.int ? `INTFMT '${sys.INTFMT}' is not read here` : `REALFMT '${sys.REALFMT}' is not read here`);
    }
    const compress = word('COMPRESS', 'NONE');
    if (!['NONE', 'BASIC', 'BASIC2'].includes(compress)) throw new Error(`COMPRESS '${sys.COMPRESS}' is not read here`);
    return {
        format, org, ns, nl, nb, dims, nbb, nlb, recsize, compress,
        lblsize: int('LBLSIZE'),
        // the byte order: ints HIGH or LOW, reals IEEE (big-endian), RIEEE (little) or VAX's
        little: format.int ? intfmt === 'LOW' : realfmt === 'RIEEE',
        vax: !format.int && realfmt === 'VAX',
        intfmt, realfmt,
        eol: int('EOL') === 1,
        // where the end-of-dataset label is in a compressed file
        eoci: int('EOCI2') * 2 ** 32 + int('EOCI1'),
        records: dims[1] * dims[2],
        type: word('TYPE', 'IMAGE'),
    };
}

// A bit reader of BASIC's codes, the most significant bit first
function bitReader(code) {
    let pos = 0, bit = 0;
    return nbit => {
        let v = 0;
        for (let k = 0; k < nbit; k++) {
            if (pos >= code.length) throw new Error('a compressed record ends early');
            v = (v << 1) | ((code[pos] >> (7 - bit)) & 1);
            if (++bit === 8) { bit = 0; pos++; }
        }
        return v;
    };
}

const DELTAS = [-3, -2, -1, 0, 1, 2, 3];

// One record of BASIC (or BASIC2) compression decoded to `out` (n values of `wid`
// bytes): each byte of a value, the first of all values, then the second...,
// as differences from the one before (3 bits), runs of one, or literal bytes
function basicDecode(code, out, n, wid) {
    const grab = bitReader(code);
    let run = -3, nval = 0, old = 0;
    const top = n * wid;
    for (let iw = 0; iw < wid; iw++) {
        for (let ip = iw; ip < top; ip += wid) {
            if (run > -3) { out[ip] = nval; run--; continue; }
            let v = grab(3);
            if (v < 7) {
                nval = (old + DELTAS[v]) & 0xff;
                out[ip] = old = nval;
                continue;
            }
            if (grab(1)) {
                let c = grab(4);
                if (c === 15) {
                    c = grab(8);
                    if (c === 255) {
                        const a = grab(8), b = grab(8), d = grab(8);
                        run = a | (b << 8) | (d << 16);
                    } else run = c + 15;
                } else run = c;
                v = grab(3);
                nval = v < 7 ? (old + DELTAS[v]) & 0xff : grab(8);
                out[ip] = old = nval;
            } else {
                out[ip] = old = grab(8);
            }
        }
    }
    return out;
}

// A VAX F float (4 bytes, 16-bit words little-endian, the sign/exponent word first)
function vaxF(b, o) {
    const w0 = b[o] | (b[o + 1] << 8), w1 = b[o + 2] | (b[o + 3] << 8);
    const e = (w0 >> 7) & 0xff;
    if (!e) return 0;
    const m = ((w0 & 0x7f) | 0x80) * 65536 + w1;
    return (w0 & 0x8000 ? -1 : 1) * m * 2 ** (e - 128 - 24);
}

// A VAX D float (8 bytes, four words as an F float's)
function vaxD(b, o) {
    const w = k => b[o + 2 * k] | (b[o + 2 * k + 1] << 8);
    const w0 = w(0);
    const e = (w0 >> 7) & 0xff;
    if (!e) return 0;
    const m = ((w0 & 0x7f) | 0x80) * 2 ** 48 + w(1) * 2 ** 32 + w(2) * 65536 + w(3);
    return (w0 & 0x8000 ? -1 : 1) * m * 2 ** (e - 128 - 56);
}

// The records' bytes: record r's N1 values (the prefix skipped), from the file
// or, compressed, decoded one by one. BASIC: each record after its size (a
// little-endian uint32, the size counted in); BASIC2: all the sizes first
function recordReader(bytes, d) {
    const start = d.lblsize + d.nlb * d.recsize;
    const len = d.dims[0] * d.format.size;
    if (d.compress === 'NONE') {
        const need = start + d.records * d.recsize - (d.recsize - d.nbb - len);
        if (bytes.length < need) throw new Error(`${bytes.length} bytes, ${need} wanted (NL=${d.nl}, NS=${d.ns}, NB=${d.nb})`);
        return r => bytes.subarray(start + r * d.recsize + d.nbb, start + r * d.recsize + d.nbb + len);
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = at => {
        if (at + 4 > bytes.length) throw new Error('the compressed records end early');
        return dv.getUint32(at, true);
    };
    const out = new Uint8Array(len);
    let next = 0, at = d.compress === 'BASIC' ? start : start + 4 * d.records;
    // the records are read in order; the offset of each found as it comes
    return r => {
        if (r !== next) throw new Error('compressed records are read in order');
        next++;
        let size;
        if (d.compress === 'BASIC') {
            size = u32(at) - 4;
            at += 4;
        } else size = u32(start + 4 * r);
        if (!(size > 0) || at + size > bytes.length) throw new Error(`record ${r + 1}: a size of ${size}`);
        basicDecode(bytes.subarray(at, at + size), out.fill(0), d.dims[0], d.format.size);
        at += size;
        return out;
    };
}

// Where the end-of-dataset label starts
function eolOffset(d) {
    if (d.compress !== 'NONE' && d.eoci) return d.eoci;
    return d.lblsize + (d.nlb + d.records) * d.recsize;
}

// The bands' values, band by band (row by row), a typed array of the format's
// each (complex values as real and imaginary pairs)
function readBands(bytes, d) {
    const { format, ns, nl, nb, org } = d;
    const comps = format.comps, csize = format.size / comps;
    const bands = [];
    for (let b = 0; b < nb; b++) bands.push(new format.Array(ns * nl * comps));
    const record = recordReader(bytes, d);
    // `count` values (components) of a record into out, from byte `from` on, `step` bytes apart
    const method = { HALF: 'getInt16', FULL: 'getInt32', REAL: 'getFloat32', DOUB: 'getFloat64', COMP: 'getFloat32' }[format.name];
    const copy = (rec, out, at, count, stride, from = 0, step = csize) => {
        if (format.name === 'BYTE') {
            for (let k = 0, o = from; k < count; k++, o += step) out[at + k * stride] = rec[o];
        } else if (d.vax) {
            const vax = csize === 4 ? vaxF : vaxD;
            for (let k = 0, o = from; k < count; k++, o += step) out[at + k * stride] = vax(rec, o);
        } else {
            const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
            for (let k = 0, o = from; k < count; k++, o += step) out[at + k * stride] = dv[method](o, d.little);
        }
    };
    // the records in the file's order: BSQ a band's line, BIL a line's band, BIP a pixel's bands
    const line = ns * comps;
    if (org === 'BSQ') {
        for (let b = 0, r = 0; b < nb; b++) for (let y = 0; y < nl; y++, r++) copy(record(r), bands[b], y * line, line, 1);
    } else if (org === 'BIL') {
        for (let y = 0, r = 0; y < nl; y++) for (let b = 0; b < nb; b++, r++) copy(record(r), bands[b], y * line, line, 1);
    } else {
        // BIP: a record is a pixel, its bands' values in turn
        for (let p = 0; p < ns * nl; p++) {
            const rec = record(p);
            for (let b = 0; b < nb; b++) copy(rec, bands[b], p * comps, comps, 1, b * format.size);
        }
    }
    return bands;
}

// The whole file: { items, eolItems, sys, d (describe's), bands, label (text) }
function readVicar(bytes) {
    if (!isVicar(bytes)) throw new Error('not a VICAR file (no LBLSIZE= at its start)');
    const latin1 = b => new TextDecoder('latin1').decode(b);
    // LBLSIZE: the label's bytes
    const lblsize = head => parseInt(latin1(head.subarray(0, 40)).replace(/^LBLSIZE *= */, ''), 10);
    const size = lblsize(bytes);
    if (!(size > 0)) throw new Error('LBLSIZE is no number');
    const items = parseLabel(latin1(bytes.subarray(0, Math.min(size, bytes.length))));
    const sys = systemItems(items);
    const d = describe(sys);
    let eolItems = null;
    if (d.eol) {
        // the end-of-dataset label: items more (properties, history) after the image
        const at = eolOffset(d);
        const head = bytes.subarray(at, at + 40);
        if (!isVicar(head)) throw new Error('EOL=1, but no end-of-dataset label after the image');
        const eolSize = lblsize(head);
        eolItems = parseLabel(latin1(bytes.subarray(at, at + eolSize))).slice(1);
    }
    const bands = readBands(bytes, d);
    return { items, eolItems, sys, d, bands, label: labelText(items, eolItems) };
}

// --- Pictures of it ---

// The parts of a complex value one can look at
const PARTS = [['magnitude', 'magnitude'], ['real', 'real part'], ['imaginary', 'imaginary part'], ['phase', 'phase']];

// The values of band b (its part, of complex values), row by row
function bandValues(file, b, part = 'magnitude') {
    const band = file.bands[b];
    if (file.d.format.comps === 1) return band;
    const out = new Float64Array(band.length / 2);
    for (let i = 0; i < out.length; i++) {
        const re = band[2 * i], im = band[2 * i + 1];
        out[i] = part === 'real' ? re : part === 'imaginary' ? im : part === 'phase' ? Math.atan2(im, re) : Math.hypot(re, im);
    }
    return out;
}

// Up to a million of the values of all bands, for an interval they share
function allSample(file, part) {
    const n = file.d.ns * file.d.nl;
    const step = Math.max(1, Math.floor(n * file.d.nb / 1e6));
    const out = [];
    for (let b = 0; b < file.d.nb; b++) {
        const v = bandValues(file, b, part);
        for (let i = b % step; i < n; i += step) out.push(v[i]);
    }
    return Float64Array.from(out);
}

// [vmin, vmax] of an interval: FITS's (zscale, min/max, 99.5%, 99%) over all
// bands, the format's range ('type'), or [min, max] given by hand
function vicarLimits(file, interval, part = 'magnitude') {
    if (Array.isArray(interval)) return interval;
    const key = `${part}#${interval}`;
    file.limits = file.limits || new Map();
    if (!file.limits.has(key)) {
        const range = FORMAT_RANGE[file.d.format.name];
        file.limits.set(key, interval === 'type' && range ? range : fitsLimits(allSample(file, part), interval === 'type' ? 'minmax' : interval));
    }
    return file.limits.get(key);
}

// The interval a file is first shown with: bytes as they are, else 99.5% of the values
function defaultInterval(d) {
    return d.format.name === 'BYTE' ? 'type' : '99.5';
}

// Whether a file is first shown as a color picture: three bands
function defaultRgb(d) {
    return d.nb === 3;
}

// RGBA of band `page`, gray, or of the first three bands as red, green and blue
function vicarRgba(file, page, rgb, interval, stretch, part) {
    const limits = vicarLimits(file, interval, part);
    const bands = rgb ? [0, 1, 2] : [page];
    const levels = bands.map(b => fitsLevels(bandValues(file, b, part), limits, stretch));
    const n = file.d.ns * file.d.nl;
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
        const r = levels[0][i], g = levels[rgb ? 1 : 0][i], b = levels[rgb ? 2 : 0][i];
        out[o] = Math.max(r, 0);
        out[o + 1] = Math.max(g, 0);
        out[o + 2] = Math.max(b, 0);
        // NaN: see-through
        out[o + 3] = r < 0 && g < 0 && b < 0 ? 0 : 255;
    }
    return out;
}

// What the label says the file is, in a few words
function summary(d) {
    return [d.format.name, `${d.ns}×${d.nl}`, `${d.nb} band${d.nb > 1 ? 's' : ''}`, d.org,
        d.compress !== 'NONE' ? `${d.compress} compressed` : '',
        d.format.size > 1 ? (d.format.int ? `INTFMT ${d.intfmt}` : `REALFMT ${d.realfmt}`) : '',
        d.nlb ? `${d.nlb} binary header record${d.nlb > 1 ? 's' : ''}` : '',
        d.nbb ? `${d.nbb}-byte binary prefixes` : '', d.eol ? 'EOL label' : ''].filter(Boolean).join(', ');
}

// --- In the browser ---

async function fetchBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
}

function vicarFile(url) {
    let p = files.get(url);
    if (!p) {
        p = fetchBytes(url).then(readVicar);
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: another band or window reads the values again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// Band `page` of the VICAR file at url (or its three bands in color), drawn:
// { url (a blob: URL of its PNG), page, pages, rgb, label, width, height, limits }.
// opts: rgb (default: for three bands), interval (or [min, max]), stretch, part (of complex values)
function vicarPage(url, page = 0, opts = {}) {
    const key = `${url}#${page}#${opts.rgb}#${opts.interval}#${opts.stretch}#${opts.part}`;
    let p = drawn.get(key);
    if (!p) {
        p = (async () => {
            const file = await vicarFile(url);
            const { d } = file;
            const rgb = d.nb >= 3 && (opts.rgb === undefined ? defaultRgb(d) : opts.rgb);
            const n = Math.max(0, Math.min(d.nb - 1, page));
            const interval = opts.interval || defaultInterval(d);
            const part = opts.part || 'magnitude';
            const png = await rgbaToPng(vicarRgba(file, n, rgb, interval, opts.stretch || 'linear', part), d.ns, d.nl);
            return { url: URL.createObjectURL(png), page: n, pages: d.nb, rgb, width: d.ns, height: d.nl,
                label: rgb ? 'bands 1, 2, 3 as red, green, blue' : `band ${n + 1} of ${d.nb}`, limits: vicarLimits(file, interval, part) };
        })();
        drawn.set(key, p);
        p.catch(err => { drawn.delete(key); log.warn('VICAR decode failed:', err); });
        // as many as a folder's thumbnails (an evicted one's blob: URL is revoked)
        if (drawn.size > 64) {
            const [oldKey, old] = drawn.entries().next().value;
            drawn.delete(oldKey);
            old.then(r => URL.revokeObjectURL(r.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the VICAR file at url (root is the viewer's
// element, positioned): band buttons, color or one band (of three), the part of
// complex values, the interval (or a window typed in) and the stretch; the
// label in a panel that opens
function addVicarControls(root, img, url) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;z-index:1;'
        + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;max-width:calc(100% - 120px);';
    const button = (text, title) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText = 'background:none;color:inherit;border:none;font:inherit;font-size:14px;cursor:pointer;padding:2px 6px;';
        return b;
    };
    const select = (options, title) => {
        const s = document.createElement('select');
        s.title = title;
        s.style.cssText = 'background:#333;color:#fff;border:none;font:inherit;';
        for (const [v, t] of options) s.add(new Option(t, v));
        return s;
    };
    const number = title => {
        const i = document.createElement('input');
        i.type = 'number';
        i.step = 'any';
        i.title = title;
        i.style.cssText = 'width:6em;background:#333;color:#fff;border:none;font:inherit;';
        return i;
    };
    const prev = button('‹', 'Previous band');
    const info = document.createElement('span');
    const next = button('›', 'Next band');
    const color = select([['rgb', 'color (bands 1-3)'], ['band', 'one band']], 'Bands 1, 2 and 3 as red, green and blue, or a band at a time');
    const part = select(PARTS, 'The part of the complex values shown');
    const interval = select([['type', "type's range"], ...INTERVALS, ['custom', 'window']], 'Interval: the values shown black to white (over all bands)');
    const lo = number('Shown black (and below)');
    const hi = number('Shown white (and above)');
    const stretch = select(STRETCHES, 'Stretch');
    bar.append(prev, info, next, color, part, interval, lo, hi, stretch);

    const header = document.createElement('details');
    header.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1;max-width:calc(100% - 16px);'
        + 'background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const sum = document.createElement('summary');
    sum.textContent = 'Label';
    sum.style.cssText = 'cursor:pointer;';
    const text = document.createElement('div');
    text.style.cssText = 'max-height:60vh;overflow:auto;margin-top:4px;font:12px monospace;white-space:pre;user-select:text;';
    header.append(sum, text);

    let page = 0, pages = 0, turn = 0;
    const opts = () => ({
        rgb: color.value === 'rgb',
        interval: interval.value === 'custom' ? [Number(lo.value), Number(hi.value)] : interval.value,
        stretch: stretch.value,
        part: part.value,
    });
    const show = async n => {
        const mine = ++turn;
        try {
            const d = await vicarPage(url, n, opts());
            if (mine !== turn) return;
            img.src = d.url;
            page = d.page;
            pages = d.pages;
            info.textContent = d.rgb ? 'RGB' : `${page + 1} / ${pages}`;
            info.title = `${d.label}, ${d.width}×${d.height}`;
            img.title = info.title;
            info.hidden = pages < 2;
            prev.hidden = next.hidden = pages < 2 || d.rgb;
            prev.disabled = page === 0;
            next.disabled = page === pages - 1;
            if (interval.value !== 'custom') {
                const round = x => Number(x.toPrecision(6));
                lo.value = round(d.limits[0]);
                hi.value = round(d.limits[1]);
            }
        } catch (err) {
            if (mine === turn) info.textContent = err.message;
        }
    };
    prev.onclick = () => show(page - 1);
    next.onclick = () => show(page + 1);
    color.onchange = () => show(page);
    part.onchange = () => show(page);
    interval.onchange = () => show(page);
    lo.onchange = hi.onchange = () => { interval.value = 'custom'; show(page); };
    stretch.onchange = () => show(page);
    root.tabIndex = root.tabIndex >= 0 ? root.tabIndex : 0;
    root.addEventListener('keydown', e => {
        if (e.target.closest && e.target.closest('select, input, details')) return;
        if (color.value === 'rgb' && !color.hidden) return;
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { show(page + 1); e.preventDefault(); }
        else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { show(page - 1); e.preventDefault(); }
    });
    vicarFile(url).then(file => {
        const { d } = file;
        color.hidden = d.nb < 3;
        color.value = defaultRgb(d) ? 'rgb' : 'band';
        part.hidden = d.format.comps === 1;
        if (!FORMAT_RANGE[d.format.name]) interval.remove(0);
        interval.value = defaultInterval(d);
        text.textContent = file.label;
        sum.textContent = `Label (${summary(d)})`;
        show(0);
    }).catch(err => { info.textContent = err.message; });
    root.append(bar, header);
    return bar;
}

module.exports = {
    isVicarName, isVicarMaybeName, isVicar, isVicarUrl, parseLabel, systemItems, describe, basicDecode, vaxF, vaxD,
    readVicar, bandValues, vicarLimits, vicarRgba, vicarFile, vicarPage, addVicarControls,
};
