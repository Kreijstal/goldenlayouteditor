// Microsoft Compiled HTML Help (.chm) reader for the .chm viewer, after the
// format notes of chmlib (Jed Wing) and libmspack's chmd.c (Stuart Caie): the
// ITSF header, the ITSP directory (PMGL listing chunks of ENCINT-coded
// entries), section 0 (stored) and section 1 (MSCompressed: LZX with a reset
// table, chm-lzx.js). Section 1 is decoded one reset interval at a time, only
// for the files that are read, and the decoded intervals are cached. Also
// reads #SYSTEM (title, default topic, contents and index files, language),
// #TOPICS/#STRINGS/#URLTBL/#URLSTR (topic titles) and the .hhc/.hhk sitemap
// files. Read-only.
import { LzxDecoder, FRAME_SIZE } from './chm-lzx.js';

const CONTENT = '::DataSpace/Storage/MSCompressed/Content';
const CONTROL = '::DataSpace/Storage/MSCompressed/ControlData';
const RESET_TABLE = '::DataSpace/Storage/MSCompressed/Transform/{7FC28940-9D31-11D0-9B27-00A0C91E9C7C}/InstanceData/ResetTable';
const SPANINFO = '::DataSpace/Storage/MSCompressed/SpanInfo';
const CACHE_BYTES = 48 * 1024 * 1024;

function u16(b, p) { return b[p] | (b[p + 1] << 8); }
function u32(b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
function i32(b, p) { return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); }
function u64(b, p) {
    const hi = u32(b, p + 4);
    if (hi > 0x1fffff) throw new Error('Offset too large');
    return hi * 0x100000000 + u32(b, p);
}

// ANSI code page of a Windows language id (the code page CHM text is in when the page doesn't say)
export function codepageForLcid(lcid) {
    const lang = lcid & 0x3ff;
    switch (lang) {
    case 0x04: return (lcid === 0x0404 || lcid === 0x0c04 || lcid === 0x1404) ? 'big5' : 'gbk';
    case 0x11: return 'shift_jis';
    case 0x12: return 'euc-kr';
    case 0x1e: return 'windows-874';
    case 0x2a: return 'windows-1258';
    case 0x0d: return 'windows-1255';
    case 0x01: case 0x29: case 0x20: return 'windows-1256';
    case 0x08: return 'windows-1253';
    case 0x1f: case 0x2c: return 'windows-1254';
    case 0x25: case 0x26: case 0x27: return 'windows-1257';
    case 0x19: case 0x22: case 0x23: case 0x02: case 0x2f: case 0x3f: case 0x40: case 0x44: case 0x50: return 'windows-1251';
    case 0x1a: return lcid === 0x0c1a || lcid === 0x1c1a ? 'windows-1251' : 'windows-1250';
    case 0x05: case 0x15: case 0x0e: case 0x1b: case 0x24: case 0x18: case 0x1c: return 'windows-1250';
    default: return 'windows-1252';
    }
}

export function decoderFor(label) {
    try { return new TextDecoder(label || 'windows-1252'); } catch (e) { return new TextDecoder('windows-1252'); }
}

// The charset an HTML file declares: a BOM, else a <meta> in its first bytes
export function sniffCharset(bytes) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_:.-]+)/i);
    if (m) {
        try { new TextDecoder(m[1]); return m[1].toLowerCase(); } catch (e) { /* unknown label */ }
    }
    return null;
}

function readCString(bytes, pos, decoder) {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(pos, end));
}

class Encint {
    constructor(bytes, pos, end) { this.b = bytes; this.p = pos; this.end = end; }
    next() {
        let v = 0;
        for (let i = 0; i < 9; i++) {
            if (this.p >= this.end) throw new Error('Directory entry runs past its chunk');
            const c = this.b[this.p++];
            v = v * 128 + (c & 0x7f);
            if (!(c & 0x80)) return v;
        }
        throw new Error('Bad number in the directory');
    }
}

export class ChmFile {
    constructor(bytes) {
        this.bytes = bytes;
        this.warnings = [];
        this._cache = new Map(); // reset interval -> decoded bytes
        this._cacheSize = 0;
        this._parseHeader();
        this._parseDirectory();
        this._setupCompressed();
        this._parseSystem();
        let end = 0;
        for (const f of this.files) if (f.section === 0) end = Math.max(end, this.contentOffset + f.offset + f.length);
        if (end > bytes.length) {
            this.warnings.unshift(`The file is truncated: ${bytes.length} of at least ${end} bytes. Pages past the end cannot be read.`);
        }
    }

    _parseHeader() {
        const b = this.bytes;
        if (b.length < 0x58) throw new Error('Not a CHM file (too short)');
        if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'ITSF') throw new Error('Not a CHM file (no ITSF signature)');
        this.version = u32(b, 4);
        const headerLen = u32(b, 8);
        this.headerLcid = u32(b, 0x14);
        const dirOffset = u64(b, 0x48);
        const dirLen = u64(b, 0x50);
        this.contentOffset = this.version >= 3 && headerLen >= 0x60 ? u64(b, 0x58) : dirOffset + dirLen;
        this.dirOffset = dirOffset;
        this.dirLen = dirLen;
        if (dirOffset + 0x54 > b.length) throw new Error('The file is truncated (the directory is missing)');
    }

    _parseDirectory() {
        const b = this.bytes;
        const d = this.dirOffset;
        if (String.fromCharCode(b[d], b[d + 1], b[d + 2], b[d + 3]) !== 'ITSP') throw new Error('Damaged CHM file (no ITSP directory header)');
        const headerLen = u32(b, d + 8);
        const chunkSize = u32(b, d + 0x10);
        const numChunks = u32(b, d + 0x2c);
        this.dirInfo = { chunkSize, numChunks, depth: u32(b, d + 0x18), firstPmgl: i32(b, d + 0x20), lastPmgl: i32(b, d + 0x24), lcid: u32(b, d + 0x30) };
        if (chunkSize < 0x20 || chunkSize > 0x100000) throw new Error('Damaged CHM file (bad directory chunk size)');
        const files = [];
        const chunksStart = d + headerLen;
        let truncated = false;
        for (let c = 0; c < numChunks; c++) {
            const p = chunksStart + c * chunkSize;
            if (p + chunkSize > b.length) { truncated = true; break; }
            if (String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]) !== 'PMGL') continue;
            const free = u32(b, p + 4);
            const end = p + chunkSize - Math.min(free, chunkSize - 0x14);
            const r = new Encint(b, p + 0x14, end);
            const utf8 = new TextDecoder('utf-8');
            while (r.p < end) {
                const nameLen = r.next();
                if (r.p + nameLen > end) throw new Error('Damaged CHM file (directory entry runs past its chunk)');
                const name = utf8.decode(b.subarray(r.p, r.p + nameLen));
                r.p += nameLen;
                const section = r.next();
                const offset = r.next();
                const length = r.next();
                files.push({ name, section, offset, length });
            }
        }
        if (truncated) this.warnings.push('The file is truncated: part of the directory is missing.');
        if (!files.length) throw new Error(truncated ? 'The file is truncated (the directory is missing)' : 'Damaged CHM file (empty directory)');
        this.files = files;
        this.byName = new Map();
        for (const f of files) this.byName.set(f.name.toLowerCase(), f);
    }

    _setupCompressed() {
        this.lzx = null;
        const content = this.entry(CONTENT);
        if (!content) return;
        try {
            const ctl = this.read(CONTROL);
            if (ctl.length < 24 || String.fromCharCode(ctl[4], ctl[5], ctl[6], ctl[7]) !== 'LZXC') throw new Error('unknown compression (no LZXC control data)');
            const version = u32(ctl, 8);
            let resetInterval = u32(ctl, 12);
            let windowSize = u32(ctl, 16);
            if (version === 2) { resetInterval *= FRAME_SIZE; windowSize *= FRAME_SIZE; }
            const windowBits = Math.log2(windowSize);
            if (!Number.isInteger(windowBits) || windowBits < 15 || windowBits > 21) throw new Error(`unsupported LZX window size ${windowSize}`);
            if (!resetInterval || resetInterval % FRAME_SIZE) throw new Error(`unsupported reset interval ${resetInterval}`);
            const rt = this.read(RESET_TABLE);
            const numEntries = u32(rt, 4);
            const tableOffset = u32(rt, 12);
            let uncompressedLen = u64(rt, 16);
            const compressedLen = u64(rt, 24);
            const blockLen = u64(rt, 32);
            const spanEntry = this.entry(SPANINFO);
            if (spanEntry && spanEntry.length >= 8) {
                const span = this.read(SPANINFO);
                const spanLen = u64(span, 0);
                if (spanLen !== uncompressedLen) this.warnings.push(`SpanInfo (${spanLen}) and the reset table (${uncompressedLen}) disagree on the size of the compressed section`);
            }
            if (blockLen !== FRAME_SIZE) throw new Error(`unsupported reset table block size ${blockLen}`);
            const offsets = [];
            for (let i = 0; i < numEntries && tableOffset + i * 8 + 8 <= rt.length; i++) offsets.push(u64(rt, tableOffset + i * 8));
            const contentStart = this.contentOffset + content.offset;
            this.lzx = {
                version, resetInterval, windowSize, windowBits, windowsPerReset: u32(ctl, 20),
                framesPerReset: resetInterval / FRAME_SIZE,
                uncompressedLen, compressedLen: Math.min(compressedLen, content.length),
                offsets, contentStart, numEntries,
            };
            this.lzxDecoder = new LzxDecoder(windowBits);
        } catch (err) {
            this.lzxError = err.message;
            this.warnings.push('The compressed section cannot be read: ' + err.message);
        }
    }

    entry(name) {
        return this.byName.get(name.toLowerCase()) || null;
    }

    // The bytes of a file (by entry or name)
    read(e) {
        if (typeof e === 'string') {
            const found = this.entry(e);
            if (!found) throw new Error(`${e}: no such file in the archive`);
            e = found;
        }
        if (e.length === 0) return new Uint8Array(0);
        if (e.section === 0) {
            const start = this.contentOffset + e.offset;
            if (start + e.length > this.bytes.length) throw new Error(`${e.name}: the file is truncated`);
            return this.bytes.subarray(start, start + e.length);
        }
        if (e.section !== 1) throw new Error(`${e.name}: unknown section ${e.section}`);
        if (!this.lzx) throw new Error(`${e.name}: ${this.lzxError || 'the archive has no compressed section'}`);
        return this._readCompressed(e.offset, e.length, e.name);
    }

    _readCompressed(offset, length, name) {
        const L = this.lzx;
        if (offset + length > L.uncompressedLen) throw new Error(`${name}: lies past the end of the compressed section`);
        const intervalLen = L.resetInterval;
        const out = new Uint8Array(length);
        let done = 0;
        while (done < length) {
            const pos = offset + done;
            const k = Math.floor(pos / intervalLen);
            const data = this._interval(k);
            const at = pos - k * intervalLen;
            const n = Math.min(length - done, data.length - at);
            if (n <= 0) throw new Error(`${name}: the compressed section ends early`);
            out.set(data.subarray(at, at + n), done);
            done += n;
        }
        return out;
    }

    // Decoded reset interval k (cached)
    _interval(k) {
        const cached = this._cache.get(k);
        if (cached) {
            this._cache.delete(k);
            this._cache.set(k, cached);
            return cached;
        }
        const L = this.lzx;
        const firstFrame = k * L.framesPerReset;
        const start = k * L.resetInterval;
        const length = Math.min(L.resetInterval, L.uncompressedLen - start);
        const frames = Math.ceil(length / FRAME_SIZE);
        const frameOffsets = [];
        for (let f = 0; f < frames; f++) {
            const o = L.offsets[firstFrame + f];
            frameOffsets.push(o == null ? null : L.contentStart + o);
        }
        if (frameOffsets[0] == null) throw new Error('The reset table is incomplete');
        const end = Math.min(this.bytes.length, L.contentStart + L.compressedLen);
        let data;
        try {
            data = this.lzxDecoder.decodeInterval(this.bytes, frameOffsets[0], end, frameOffsets, length, start);
        } catch (err) {
            if (L.contentStart + L.compressedLen > this.bytes.length) throw new Error(err.message + ' — the file is truncated');
            throw err;
        }
        this._cache.set(k, data);
        this._cacheSize += data.length;
        for (const [key, v] of this._cache) {
            if (this._cacheSize <= CACHE_BYTES || key === k) break;
            this._cache.delete(key);
            this._cacheSize -= v.length;
        }
        return data;
    }

    _parseSystem() {
        const sys = {};
        this.system = sys;
        let raw = null;
        try { raw = this.entry('/#SYSTEM') && this.read('/#SYSTEM'); } catch (err) { this.warnings.push('#SYSTEM: ' + err.message); }
        const strings = {};
        if (raw && raw.length >= 4) {
            sys.version = u32(raw, 0);
            let p = 4;
            while (p + 4 <= raw.length) {
                const code = u16(raw, p);
                const len = u16(raw, p + 2);
                p += 4;
                if (p + len > raw.length) break;
                const data = raw.subarray(p, p + len);
                p += len;
                if (code === 4 && len >= 4) {
                    sys.lcid = u32(data, 0);
                    if (len >= 8) sys.dbcs = u32(data, 4);
                    if (len >= 12) sys.fullTextSearch = u32(data, 8);
                } else if (code === 10 && len >= 4) {
                    sys.timestamp = u32(data, 0);
                } else if ([0, 1, 2, 3, 5, 6, 9, 16].includes(code)) {
                    let end = data.indexOf(0);
                    if (end < 0) end = data.length;
                    strings[code] = data.subarray(0, end);
                }
            }
        }
        this.lcid = sys.lcid || this.dirInfo.lcid || this.headerLcid || 0x409;
        this.codepage = codepageForLcid(this.lcid);
        const dec = decoderFor(this.codepage);
        const str = code => strings[code] ? dec.decode(strings[code]) : '';
        sys.contentsFile = str(0);
        sys.indexFile = str(1);
        sys.defaultTopic = str(2);
        sys.title = str(3);
        sys.defaultWindow = str(5);
        sys.compiledFile = str(6);
        sys.compiler = str(9);
        sys.defaultFont = str(16);
        // The font's character set (e.g. "Arial,8,0") can name the code page better than the language
        const charsetByFont = { 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250', 163: 'windows-1258' };
        const fontCharset = +(sys.defaultFont.split(',')[2] || 0);
        if (charsetByFont[fontCharset] && this.codepage === 'windows-1252') this.codepage = charsetByFont[fontCharset];

        const findByExt = re => {
            const f = this.files.find(x => re.test(x.name) && !x.name.startsWith('::') && x.length > 0);
            return f ? f.name : '';
        };
        this.contentsFile = this._existing(sys.contentsFile) || findByExt(/\.hhc$/i);
        this.indexFile = this._existing(sys.indexFile) || findByExt(/\.hhk$/i);
        this.title = sys.title || '';
    }

    // The archive path of a name from #SYSTEM or a sitemap ("foo.hhc", "/foo.hhc"), if the file exists
    _existing(name) {
        if (!name) return '';
        const p = '/' + name.replace(/\\/g, '/').replace(/^\/+/, '');
        const e = this.entry(p);
        return e ? e.name : '';
    }

    // Topic titles and paths from #TOPICS (with #STRINGS, #URLTBL, #URLSTR)
    topics() {
        if (this._topics) return this._topics;
        this._topics = [];
        try {
            if (!this.entry('/#TOPICS') || !this.entry('/#URLTBL') || !this.entry('/#URLSTR')) return this._topics;
            const t = this.read('/#TOPICS');
            const urltbl = this.read('/#URLTBL');
            const urlstr = this.read('/#URLSTR');
            const strs = this.entry('/#STRINGS') ? this.read('/#STRINGS') : new Uint8Array(0);
            const dec = decoderFor(this.codepage);
            for (let p = 0; p + 16 <= t.length; p += 16) {
                const strOff = u32(t, p + 4);
                const urlOff = u32(t, p + 8);
                const flags = u16(t, p + 12);
                const title = strOff !== 0xffffffff && strOff < strs.length ? readCString(strs, strOff, dec) : '';
                let local = '';
                if (urlOff + 12 <= urltbl.length) {
                    const so = u32(urltbl, urlOff + 8);
                    if (so + 8 < urlstr.length) local = readCString(urlstr, so + 8, dec);
                }
                this._topics.push({ title, local, inContents: flags !== 0 });
            }
        } catch (err) {
            this.warnings.push('#TOPICS: ' + err.message);
        }
        return this._topics;
    }

    // Decode an HTML-ish file of the archive: its own charset, else the archive's code page
    decodeText(bytes) {
        return decoderFor(sniffCharset(bytes) || this.codepage).decode(bytes);
    }
}

export function openChm(bytes) {
    return new ChmFile(bytes);
}

// --- Sitemap (.hhc contents, .hhk index) ---

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»' };
let _entityEl = null;
export function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
        }
        const k = e.toLowerCase();
        if (ENTITIES[k] != null) return ENTITIES[k];
        if (typeof document !== 'undefined') {
            // Other named entities: the browser's table (a textarea holds no markup)
            if (!_entityEl) _entityEl = document.createElement('textarea');
            _entityEl.innerHTML = '&' + e + ';';
            return _entityEl.value;
        }
        return m;
    });
}

function parseAttrs(s) {
    const attrs = {};
    const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = decodeEntities(m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : '');
    return attrs;
}

// A sitemap's tree: [{ name, local, params, children }] (params: [[name, value]...] in order)
export function parseSitemap(text) {
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    const root = { children: [] };
    const stack = [root];
    let last = null;
    let obj = null;
    const props = {};
    let propsObj = false;
    const re = /<(\/?)([A-Za-z]+)([^>]*)>/g;
    let m;
    while ((m = re.exec(text))) {
        const close = !!m[1];
        const tag = m[2].toLowerCase();
        if (tag === 'ul') {
            if (!close) {
                stack.push(last || stack[stack.length - 1]);
                last = null;
            } else if (stack.length > 1) {
                last = stack.pop();
                if (last === stack[stack.length - 1]) last = null;
            }
        } else if (tag === 'object') {
            if (!close) {
                const type = (parseAttrs(m[3]).type || '').toLowerCase();
                if (type === 'text/sitemap') obj = { params: [] };
                else if (type === 'text/site properties') propsObj = true;
            } else {
                if (obj) {
                    const entry = { params: obj.params, children: [] };
                    const get = n => { const p = obj.params.find(x => x[0] === n); return p ? p[1] : ''; };
                    entry.name = get('name');
                    entry.local = get('local');
                    entry.url = get('url');
                    entry.image = get('imagenumber');
                    stack[stack.length - 1].children.push(entry);
                    last = entry;
                }
                obj = null;
                propsObj = false;
            }
        } else if (tag === 'param' && !close) {
            const a = parseAttrs(m[3]);
            if (obj) obj.params.push([(a.name || '').toLowerCase(), a.value || '']);
            else if (propsObj && a.name) props[a.name.toLowerCase()] = a.value || '';
        }
    }
    return { items: root.children, props };
}

// Index entries: keyword, its topics [{ title, local }] and see-also, sub-keywords as children
export function indexEntries(items) {
    return items.map(it => {
        // The keyword is the "Keyword" param (Sphinx), else the first "Name"; later names title the topics
        const kw = it.params.find(p => p[0] === 'keyword');
        let keyword = kw ? kw[1] : null;
        let lastName = null;
        const topics = [];
        let seeAlso = '';
        for (const [n, v] of it.params) {
            if (n === 'name') {
                if (keyword == null) keyword = v;
                else lastName = v;
            } else if (n === 'local') {
                topics.push({ title: lastName || '', local: v });
                lastName = null;
            } else if (n === 'see also') {
                seeAlso = v;
            }
        }
        // "See Also" naming the keyword itself only makes it a heading for its sub-keywords
        if (seeAlso === keyword) seeAlso = '';
        return { keyword: keyword || '', topics, seeAlso, children: indexEntries(it.children) };
    });
}
