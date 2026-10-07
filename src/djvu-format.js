// --- DjVu's structure, read in JavaScript ---
// What the WebAssembly decoder (djvu-rs) doesn't hand to the browser: the
// document's pages and their names (DIRM), its outline (NAVM), each page's
// size, resolution and turn (INFO) and its links (ANTa/ANTz), as the DjVu v3
// specification lays them out. The BZZ decompressor these need is a port of
// djvu-bzz and djvu-zp (from djvu-rs, MIT, by Kirill Matyushkin).

// ---- ZP coder tables (DjVu v3 specification) ----
const PROB = new Uint16Array([
    0x8000, 0x8000, 0x8000, 0x6bbd, 0x6bbd, 0x5d45, 0x5d45, 0x51b9, 0x51b9, 0x4813, 0x4813, 0x3fd5,
    0x3fd5, 0x38b1, 0x38b1, 0x3275, 0x3275, 0x2cfd, 0x2cfd, 0x2825, 0x2825, 0x23ab, 0x23ab, 0x1f87,
    0x1f87, 0x1bbb, 0x1bbb, 0x1845, 0x1845, 0x1523, 0x1523, 0x1253, 0x1253, 0x0fcf, 0x0fcf, 0x0d95,
    0x0d95, 0x0b9d, 0x0b9d, 0x09e3, 0x09e3, 0x0861, 0x0861, 0x0711, 0x0711, 0x05f1, 0x05f1, 0x04f9,
    0x04f9, 0x0425, 0x0425, 0x0371, 0x0371, 0x02d9, 0x02d9, 0x0259, 0x0259, 0x01ed, 0x01ed, 0x0193,
    0x0193, 0x0149, 0x0149, 0x010b, 0x010b, 0x00d5, 0x00d5, 0x00a5, 0x00a5, 0x007b, 0x007b, 0x0057,
    0x0057, 0x003b, 0x003b, 0x0023, 0x0023, 0x0013, 0x0013, 0x0007, 0x0007, 0x0001, 0x0001, 0x5695,
    0x24ee, 0x8000, 0x0d30, 0x481a, 0x0481, 0x3579, 0x017a, 0x24ef, 0x007b, 0x1978, 0x0028, 0x10ca,
    0x000d, 0x0b5d, 0x0034, 0x078a, 0x00a0, 0x050f, 0x0117, 0x0358, 0x01ea, 0x0234, 0x0144, 0x0173,
    0x0234, 0x00f5, 0x0353, 0x00a1, 0x05c5, 0x011a, 0x03cf, 0x01aa, 0x0285, 0x0286, 0x01ab, 0x03d3,
    0x011a, 0x05c5, 0x00ba, 0x08ad, 0x007a, 0x0ccc, 0x01eb, 0x1302, 0x02e6, 0x1b81, 0x045e, 0x24ef,
    0x0690, 0x2865, 0x09de, 0x3987, 0x0dc8, 0x2c99, 0x10ca, 0x3b5f, 0x0b5d, 0x5695, 0x078a, 0x8000,
    0x050f, 0x24ee, 0x0358, 0x0d30, 0x0234, 0x0481, 0x0173, 0x017a, 0x00f5, 0x007b, 0x00a1, 0x0028,
    0x011a, 0x000d, 0x01aa, 0x0034, 0x0286, 0x00a0, 0x03d3, 0x0117, 0x05c5, 0x01ea, 0x08ad, 0x0144,
    0x0ccc, 0x0234, 0x1302, 0x0353, 0x1b81, 0x05c5, 0x24ef, 0x03cf, 0x2b74, 0x0285, 0x201d, 0x01ab,
    0x1715, 0x011a, 0x0fb7, 0x00ba, 0x0a67, 0x01eb, 0x06e7, 0x02e6, 0x0496, 0x045e, 0x030d, 0x0690,
    0x0206, 0x09de, 0x0155, 0x0dc8, 0x00e1, 0x2b74, 0x0094, 0x201d, 0x0188, 0x1715, 0x0252, 0x0fb7,
    0x0383, 0x0a67, 0x0547, 0x06e7, 0x07e2, 0x0496, 0x0bc0, 0x030d, 0x1178, 0x0206, 0x19da, 0x0155,
    0x24ef, 0x00e1, 0x320e, 0x0094, 0x432a, 0x0188, 0x447d, 0x0252, 0x5ece, 0x0383, 0x8000, 0x0547,
    0x481a, 0x07e2, 0x3579, 0x0bc0, 0x24ef, 0x1178, 0x1978, 0x19da, 0x2865, 0x24ef, 0x3987, 0x320e,
    0x2c99, 0x432a, 0x3b5f, 0x447d, 0x5695, 0x5ece, 0x8000, 0x8000, 0x5695, 0x481a, 0x481a,
    0x8000, 0x8000, 0x8000, 0x8000, 0x8000,
]);
const THRESHOLD = new Uint16Array(256);
[0x0000, 0x0000, 0x0000, 0x10a5, 0x10a5, 0x1f28, 0x1f28, 0x2bd3, 0x2bd3, 0x36e3, 0x36e3, 0x408c,
    0x408c, 0x48fd, 0x48fd, 0x505d, 0x505d, 0x56d0, 0x56d0, 0x5c71, 0x5c71, 0x615b, 0x615b, 0x65a5,
    0x65a5, 0x6962, 0x6962, 0x6ca2, 0x6ca2, 0x6f74, 0x6f74, 0x71e6, 0x71e6, 0x7404, 0x7404, 0x75d6,
    0x75d6, 0x7768, 0x7768, 0x78c2, 0x78c2, 0x79ea, 0x79ea, 0x7ae7, 0x7ae7, 0x7bbe, 0x7bbe, 0x7c75,
    0x7c75, 0x7d0f, 0x7d0f, 0x7d91, 0x7d91, 0x7dfe, 0x7dfe, 0x7e5a, 0x7e5a, 0x7ea6, 0x7ea6, 0x7ee6,
    0x7ee6, 0x7f1a, 0x7f1a, 0x7f45, 0x7f45, 0x7f6b, 0x7f6b, 0x7f8d, 0x7f8d, 0x7faa, 0x7faa, 0x7fc3,
    0x7fc3, 0x7fd7, 0x7fd7, 0x7fe7, 0x7fe7, 0x7ff2, 0x7ff2, 0x7ffa, 0x7ffa, 0x7fff, 0x7fff].forEach((v, i) => { THRESHOLD[i] = v; });
const MPS_NEXT = new Uint8Array([
    84, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
    51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74,
    75, 76, 77, 78, 79, 80, 81, 82, 81, 82, 9, 86, 5, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 82,
    99, 76, 101, 70, 103, 66, 105, 106, 107, 66, 109, 60, 111, 56, 69, 114, 65, 116, 61, 118, 57,
    120, 53, 122, 49, 124, 43, 72, 39, 60, 33, 56, 29, 52, 23, 48, 23, 42, 137, 38, 21, 140, 15,
    142, 9, 144, 141, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 70, 157, 66, 81, 62, 75,
    58, 69, 54, 65, 50, 167, 44, 65, 40, 59, 34, 55, 30, 175, 24, 177, 178, 179, 180, 181, 182,
    183, 184, 69, 186, 59, 188, 55, 190, 51, 192, 47, 194, 41, 196, 37, 198, 199, 72, 201, 62, 203,
    58, 205, 54, 207, 50, 209, 46, 211, 40, 213, 36, 215, 30, 217, 26, 219, 20, 71, 14, 61, 14, 57,
    8, 53, 228, 49, 230, 45, 232, 39, 234, 35, 138, 29, 24, 25, 240, 19, 22, 13, 16, 13, 10, 7,
    244, 249, 10, 89, 230, 0, 0, 0, 0, 0,
]);
const LPS_NEXT = new Uint8Array([
    145, 4, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
    48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71,
    72, 73, 74, 75, 76, 77, 78, 79, 80, 85, 226, 6, 176, 143, 138, 141, 112, 135, 104, 133, 100,
    129, 98, 127, 72, 125, 102, 123, 60, 121, 110, 119, 108, 117, 54, 115, 48, 113, 134, 59, 132,
    55, 130, 51, 128, 47, 126, 41, 62, 37, 66, 31, 54, 25, 50, 131, 46, 17, 40, 15, 136, 7, 32,
    139, 172, 9, 170, 85, 168, 248, 166, 247, 164, 197, 162, 95, 160, 173, 158, 165, 156, 161, 60,
    159, 56, 71, 52, 163, 48, 59, 42, 171, 38, 169, 32, 53, 26, 47, 174, 193, 18, 191, 222, 189,
    218, 187, 216, 185, 214, 61, 212, 53, 210, 49, 208, 45, 206, 39, 204, 195, 202, 31, 200, 243,
    64, 239, 56, 237, 52, 235, 48, 233, 44, 231, 38, 229, 34, 227, 28, 225, 22, 223, 16, 221, 220,
    63, 8, 55, 224, 51, 2, 47, 87, 43, 246, 37, 244, 33, 238, 27, 236, 21, 16, 15, 8, 241, 242, 7,
    10, 245, 2, 1, 83, 250, 2, 143, 246, 0, 0, 0, 0, 0,
]);

// ---- ZP decoder ----
class ZP {
    constructor(data) {
        if (data.length < 2) throw new Error('ZP data too short');
        this.data = data;
        this.pos = 0;
        this.a = 0;
        this.buf = 0;   // bits not yet shifted into c
        this.count = 0; // how many
        this.c = (this.byte() << 8) | this.byte();
        this.refill();
        this.fence = Math.min(this.c, 0x7fff);
    }
    byte() { return this.pos < this.data.length ? this.data[this.pos++] : (this.pos++, 0xff); }
    refill() {
        while (this.count <= 24) { this.buf = ((this.buf << 8) | this.byte()) >>> 0; this.count += 8; }
    }
    // shift in one bit, or as many as a's leading ones
    shift(n) {
        this.count -= n;
        this.a = (this.a << n) & 0xffff;
        this.c = ((this.c << n) | ((this.buf >>> this.count) & ((1 << n) - 1))) & 0xffff;
        if (this.count < 16) this.refill();
        this.fence = Math.min(this.c, 0x7fff);
    }
    renorm() {
        let n = 0;
        while (n < 16 && (this.a << n) & 0x8000) n++;
        this.shift(n);
    }
    bit(ctx, i) {
        const state = ctx[i];
        const mps = state & 1;
        const z = this.a + PROB[state];
        if (z <= this.fence) { this.a = z; return mps; }
        const zc = Math.min(z, 0x6000 + ((this.a + z) >> 2));
        if (zc > this.c) {
            const d = 0x10000 - zc;
            this.a = (this.a + d) & 0xffff;
            this.c = (this.c + d) & 0xffff;
            ctx[i] = LPS_NEXT[state];
            this.renorm();
            return 1 - mps;
        }
        if (this.a >= THRESHOLD[state]) ctx[i] = MPS_NEXT[state];
        this.a = zc;
        this.shift(1);
        return mps;
    }
    passthrough() {
        const z = (0x8000 + (this.a >> 1)) & 0xffff;
        if (z > this.c) {
            const d = 0x10000 - z;
            this.a = (this.a + d) & 0xffff;
            this.c = (this.c + d) & 0xffff;
            this.renorm();
            return 1;
        }
        this.a = z;
        this.shift(1);
        return 0;
    }
}

// ---- BZZ: ZP-coded move-to-front, then the inverse Burrows-Wheeler transform ----
const MAX_BLOCK = 4 << 20;
const MAX_OUTPUT = 256 << 20;
function bzz(data) {
    const zp = new ZP(data);
    const ctx = new Uint8Array(300);
    const out = [];
    let total = 0;
    for (;;) {
        let size = 1;
        while (size < (1 << 24)) size = (size << 1) | zp.passthrough();
        size -= 1 << 24;
        if (!size) break;
        if (size > MAX_BLOCK || (total += size) > MAX_OUTPUT) throw new Error('BZZ block too large');
        out.push(block(zp, ctx, size));
    }
    const all = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
    let k = 0;
    for (const b of out) { all.set(b, k); k += b.length; }
    return all;
}

function block(zp, ctx, size) {
    let shiftF = 0;
    if (zp.passthrough()) { shiftF++; if (zp.passthrough()) shiftF++; }
    const mtf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) mtf[i] = i;
    const freq = new Uint32Array(4);
    let fadd = 4, last = 3, marker = -1;
    const bwt = new Uint8Array(size);
    const bits = (base, n) => {
        let v = 1;
        while (v < (1 << n)) v = (v << 1) | zp.bit(ctx, base - 1 + v);
        return v - (1 << n);
    };
    for (let i = 0; i < size; i++) {
        if ((i & 4095) === 0 && zp.pos - zp.data.length > 16) throw new Error('BZZ data truncated');
        const cid = Math.min(last, 2);
        let pos, off = 0;
        if (zp.bit(ctx, off + cid)) pos = 0;
        else if (off += 3, zp.bit(ctx, off + cid)) pos = 1;
        else {
            off += 3;
            pos = 256;
            for (let n = 1, base = 2; n <= 7; n++, base <<= 1) {
                if (zp.bit(ctx, off)) { pos = base + bits(off + 1, n); break; }
                off += base;
            }
        }
        last = pos;
        if (pos === 256) { bwt[i] = 0; marker = i; continue; }
        const sym = mtf[pos];
        bwt[i] = sym;
        fadd = (fadd + (fadd >>> shiftF)) >>> 0;
        if (fadd > 0x10000000) {
            fadd >>>= 24;
            for (let f = 0; f < 4; f++) freq[f] >>>= 24;
        }
        let fc = fadd;
        if (pos < 4) fc = Math.min(fc + freq[pos], 0xffffffff);
        let at = pos;
        if (at >= 4) { mtf.copyWithin(4, 3, at); at = 3; }
        while (at > 0 && fc >= freq[at - 1]) {
            mtf[at] = mtf[at - 1];
            freq[at] = freq[at - 1];
            at--;
        }
        mtf[at] = sym;
        freq[at] = fc;
    }
    if (marker < 0) throw new Error('BZZ block has no marker');
    // inverse BWT
    const count = new Uint32Array(256);
    const rank = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        if (i === marker) continue;
        const b = bwt[i];
        rank[i] = ((b << 24) | (count[b] & 0xffffff)) >>> 0;
        count[b]++;
    }
    const start = new Uint32Array(256);
    for (let b = 0, run = 1; b < 256; b++) { start[b] = run; run += count[b]; }
    const out = new Uint8Array(size - 1);
    for (let k = size - 1, f = 0; k > 0;) {
        const r = rank[f];
        const b = r >>> 24;
        out[--k] = b;
        f = start[b] + (r & 0xffffff);
    }
    return out;
}

// ---- IFF ----
const ascii = (d, at, n) => String.fromCharCode(...d.subarray(at, at + n));
const be32 = (d, at) => ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;

// The chunks in d[from, to): { id, start (of its data), size, kind (a FORM's), kids (a FORM's chunks) }
function chunks(d, from, to) {
    const out = [];
    let at = from;
    while (at + 8 <= to) {
        const id = ascii(d, at, 4), size = be32(d, at + 4), start = at + 8;
        if (start + size > to) break;
        const c = { id, start, size, at };
        if (id === 'FORM' && size >= 4) {
            c.kind = ascii(d, start, 4);
            c.kids = chunks(d, start + 4, start + size);
        }
        out.push(c);
        at = start + size + (size & 1);
    }
    return out;
}
const dataOf = (d, c) => d.subarray(c.start, c.start + c.size);

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');
function text(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { return latin1.decode(bytes); }
}

// ---- INFO: size, resolution, turn ----
const TURNS = { 1: 0, 6: 90, 2: 180, 5: 270 }; // counter-clockwise
function info(bytes) {
    if (bytes.length < 5) return null;
    return {
        width: (bytes[0] << 8) | bytes[1],
        height: (bytes[2] << 8) | bytes[3],
        dpi: bytes.length >= 8 ? (bytes[6] | (bytes[7] << 8)) || 300 : 300,
        turn: bytes.length >= 10 ? TURNS[bytes[9] & 7] || 0 : 0,
    };
}

// ---- Annotations: a little Lisp ----
function sexp(src) {
    let i = 0;
    const out = [];
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    function str() {
        let s = '';
        i++;
        while (i < src.length && src[i] !== '"') {
            if (src[i] === '\\' && i + 1 < src.length) {
                const n = src[++i];
                if (/[0-7]/.test(n)) { let o = ''; while (o.length < 3 && /[0-7]/.test(src[i])) o += src[i++]; s += String.fromCharCode(parseInt(o, 8)); continue; }
                s += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07' }[n] || n;
                i++;
            } else s += src[i++];
        }
        i++;
        return { str: s };
    }
    function value(depth) {
        ws();
        if (src[i] === '(') {
            i++;
            const list = [];
            for (;;) {
                ws();
                if (i >= src.length) return list;
                if (src[i] === ')') { i++; return list; }
                if (depth > 64) throw new Error('annotations nest too deep');
                list.push(value(depth + 1));
            }
        }
        if (src[i] === '"') return str();
        let t = '';
        while (i < src.length && !/[\s()"]/.test(src[i])) t += src[i++];
        if (!t) { i++; return null; }
        return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
    }
    while (i < src.length) {
        ws();
        if (i >= src.length) break;
        const v = value(0);
        if (v != null) out.push(v);
    }
    return out;
}

// The page's links: { href, target, comment, shape, box: [x0, y0, x1, y1] } in
// pixels of the page as shown (turned, top-left origin)
function links(antSources, page) {
    const out = [];
    for (const src of antSources) {
        let forms;
        try { forms = sexp(src); } catch (_) { continue; }
        for (const f of forms) {
            if (!Array.isArray(f) || f[0] !== 'maparea') continue;
            let href = '', target = '';
            if (f[1] && f[1].str != null) href = f[1].str;
            else if (Array.isArray(f[1]) && f[1][0] === 'url') { href = (f[1][1] && f[1][1].str) || ''; target = (f[1][2] && f[1][2].str) || ''; }
            const comment = f[2] && f[2].str != null ? f[2].str : '';
            const shape = Array.isArray(f[3]) ? f[3] : null;
            if (!shape || !href) continue;
            const nums = shape.slice(1).filter(n => typeof n === 'number');
            let x0, y0, x1, y1;
            if (shape[0] === 'rect' || shape[0] === 'oval' || shape[0] === 'text') {
                if (nums.length < 4) continue;
                [x0, y0, x1, y1] = [nums[0], nums[1], nums[0] + nums[2], nums[1] + nums[3]];
            } else if (shape[0] === 'poly' || shape[0] === 'line') {
                if (nums.length < 4) continue;
                const xs = nums.filter((_, k) => !(k & 1)), ys = nums.filter((_, k) => k & 1);
                [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
            } else continue;
            out.push({ href, target, comment, shape: shape[0], box: place(page, [x0, y0, x1, y1]) });
        }
    }
    return out;
}

// From the page's own coordinates (bottom-left origin, unturned) to the page as shown
function place(page, [x0, y0, x1, y1]) {
    const { width: W, height: H, turn } = page;
    const pts = [[x0, H - y0], [x1, H - y1], [x0, H - y1], [x1, H - y0]].map(([u, v]) =>
        turn === 90 ? [v, W - u] : turn === 180 ? [W - u, H - v] : turn === 270 ? [H - v, u] : [u, v]);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ---- The document ----
/**
 * Read a DjVu file's structure.
 * @param {Uint8Array} d
 * @returns {{ pages: {id, title, width, height, dpi, turn, links}[], outline: {title, url, kids}[], bundled: boolean, indirect: boolean }}
 */
function readDjvu(d) {
    if (d.length < 16 || ascii(d, 0, 4) !== 'AT&T' || ascii(d, 4, 4) !== 'FORM') throw new Error('not a DjVu file');
    const top = chunks(d, 4, d.length)[0];
    if (!top || !top.kids) throw new Error('not a DjVu file');
    const result = { pages: [], outline: [], bundled: true, indirect: false };
    const components = new Map(); // id → FORM chunk
    let pageForms = [];
    if (top.kind === 'DJVM') {
        const dirm = top.kids.find(c => c.id === 'DIRM');
        if (!dirm) throw new Error('DjVu document without a directory');
        const dir = dataOf(d, dirm);
        const flags = dir[0], n = (dir[1] << 8) | dir[2];
        result.bundled = !!(flags & 0x80);
        let at = 3;
        const offsets = [];
        if (result.bundled) { for (let k = 0; k < n; k++, at += 4) offsets.push(be32(dir, at)); }
        const meta = bzz(dir.subarray(at));
        let m = 3 * n; // sizes first
        const fileFlags = meta.subarray(m, m + n);
        m += n;
        const zstr = () => { const e = meta.indexOf(0, m); const s = text(meta.subarray(m, e < 0 ? meta.length : e)); m = e < 0 ? meta.length : e + 1; return s; };
        const files = [];
        for (let k = 0; k < n; k++) {
            const id = zstr();
            const name = fileFlags[k] & 0x80 ? zstr() : id;
            const title = fileFlags[k] & 0x40 ? zstr() : id;
            files.push({ id, name, title, kind: fileFlags[k] & 0x3f, offset: offsets[k] });
        }
        if (!result.bundled) { result.indirect = true; result.files = files; return result; }
        for (const f of files) {
            const form = chunks(d, f.offset, d.length)[0];
            if (form && form.kids) components.set(f.id, form);
            if (f.kind === 1) pageForms.push({ id: f.id, title: f.title, form });
        }
        const navm = top.kids.find(c => c.id === 'NAVM');
        if (navm) {
            try { result.outline = outline(bzz(dataOf(d, navm))); } catch (_) { result.outline = []; }
        }
    } else if (top.kind === 'DJVU' || top.kind === 'BM44' || top.kind === 'PM44') {
        pageForms = [{ id: '', title: '', form: top }];
    } else throw new Error(`not a DjVu document (FORM:${top.kind})`);

    // each page: its size, and its links (its own annotations, and the shared ones it includes)
    for (const { id, title, form } of pageForms) {
        const page = { id, title, width: 0, height: 0, dpi: 300, turn: 0, links: [] };
        if (form && form.kids) {
            const inf = form.kids.find(c => c.id === 'INFO');
            Object.assign(page, inf && info(dataOf(d, inf)));
            const ants = [];
            const take = (kids) => {
                for (const c of kids) {
                    try {
                        if (c.id === 'ANTa') ants.push(text(dataOf(d, c)));
                        else if (c.id === 'ANTz') ants.push(text(bzz(dataOf(d, c))));
                    } catch (_) { /* damaged annotations: none */ }
                }
            };
            for (const c of form.kids) {
                if (c.id !== 'INCL') continue;
                const inc = components.get(text(dataOf(d, c)).replace(/[\s\0]+$/, ''));
                if (inc && inc.kids) take(inc.kids);
            }
            take(form.kids);
            page.links = links(ants, page);
        }
        if (page.turn === 90 || page.turn === 270) [page.width, page.height] = [page.height, page.width];
        result.pages.push(page);
    }
    return result;
}

// NAVM: a count of all bookmarks, then each: its children's count, its title, its url
function outline(b) {
    if (b.length < 2) return [];
    const total = (b[0] << 8) | b[1];
    let at = 2, seen = 0;
    const str = () => {
        if (at + 3 > b.length) throw new Error('outline truncated');
        const n = (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
        at += 3;
        const s = text(b.subarray(at, at + n));
        at += n;
        return s;
    };
    const entry = (depth) => {
        if (depth > 256 || at >= b.length) throw new Error('outline damaged');
        const n = b[at++];
        const title = str(), url = str();
        seen++;
        const kids = [];
        for (let k = 0; k < n; k++) kids.push(entry(depth + 1));
        return { title, url, kids };
    };
    const out = [];
    while (seen < total && at < b.length) out.push(entry(0));
    return out;
}

// Where a link goes: { page } (0-based) inside the document, or { url } outside it
function resolveLink(href, doc, from) {
    if (!href) return null;
    if (href[0] !== '#') return { url: href };
    const t = href.slice(1);
    if (/^[+-]\d+$/.test(t)) return { page: Math.max(0, Math.min(doc.pages.length - 1, from + Number(t))) };
    if (/^\d+$/.test(t)) return { page: Math.max(0, Math.min(doc.pages.length - 1, Number(t) - 1)) };
    const k = doc.pages.findIndex(p => p.id === t || p.title === t);
    return k >= 0 ? { page: k } : null;
}

module.exports = { readDjvu, resolveLink, bzz, sexp };
