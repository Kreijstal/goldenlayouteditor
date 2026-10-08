// --- FITS (.fits, .fit, .fts; an .fz that is one) ---
// No browser shows FITS, astronomy's format: 2880-byte blocks of 80-character
// header cards, each HDU's data after its header, big-endian. Read here: the
// primary HDU and IMAGE extensions, BITPIX 8, 16, 32, 64, -32 and -64, BZERO and
// BSCALE (so unsigned 16 and 32-bit too), BLANK (and NaN) shown transparent.
// Every image HDU is a page; a cube (NAXIS3, and any axes after) has a page per
// plane, and one of three planes is also shown as RGB, first. Tile-compressed
// images (a BINTABLE with ZIMAGE = T, what fpack writes into an .fz) are read
// too, ported from CFITSIO: RICE_1, GZIP_1, GZIP_2 (inflated by the browser's
// DecompressionStream), HCOMPRESS_1 (smoothing included) and PLIO_1, floats
// quantized to integers (NO_DITHER, SUBTRACTIVE_DITHER_1 and _2, with CFITSIO's
// random sequence) or stored losslessly; tables and random groups are no pages.
// The data is high dynamic range, so a page is drawn with an interval (zscale,
// IRAF's and astropy's by default; min/max; 99.5% or 99% of the pixels) and a
// stretch (linear, sqrt, log, asinh, astropy's), row 1 at the bottom, as
// astropy (origin='lower') and DS9 show it. The image viewer has a choice of
// both, page buttons, and the header cards in a panel that opens. .fz is also
// Fritzing's sketch (XML): one is a FITS file only if it starts "SIMPLE  =".
const { createLogger } = require('./debug');

const log = createLogger('FITS');
const FITS_RE = /\.(fits|fit|fts)$/i;
const FZ_RE = /\.fz$/i;
const BLOCK = 2880;

const files = new Map(); // source URL -> Promise<{ bytes, hdus, pages }>
const drawn = new Map(); // source URL + '#' + page + interval + stretch -> Promise<{ url, pages, page }>

function isFitsName(name) {
    return FITS_RE.test(name || '');
}

function isFzName(name) {
    return FZ_RE.test(name || '');
}

// Bytes that start a FITS file
function isFits(bytes) {
    return bytes.length >= 9 && new TextDecoder('latin1').decode(bytes.subarray(0, 9)) === 'SIMPLE  =';
}

// --- Headers ---

// A card's value: a string ('' is a quote), true/false, a number, or null
function cardValue(card) {
    if (card.slice(8, 10) !== '= ') return null;
    const s = card.slice(10).trimStart();
    if (s[0] === "'") {
        let v = '';
        for (let i = 1; i < s.length; i++) {
            if (s[i] === "'") {
                if (s[i + 1] === "'") { v += "'"; i++; } else break;
            } else v += s[i];
        }
        return v.trimEnd();
    }
    const t = s.split('/')[0].trim();
    if (t === 'T') return true;
    if (t === 'F') return false;
    const n = Number(t.replace(/[dD]/, 'E'));
    return t && !Number.isNaN(n) ? n : null;
}

// The header at pos: { cards, keys (keyword -> value, the first of each), data (where its data starts) }
function readHeader(bytes, pos) {
    const cards = [];
    const keys = new Map();
    const dec = new TextDecoder('latin1');
    for (let p = pos; ; p += 80) {
        if (p + 80 > bytes.length) throw new Error('FITS header has no END');
        const card = dec.decode(bytes.subarray(p, p + 80));
        cards.push(card.trimEnd());
        const key = card.slice(0, 8).trim();
        if (key === 'END') return { cards, keys, data: pos + Math.ceil((p + 80 - pos) / BLOCK) * BLOCK };
        if (key && !keys.has(key)) keys.set(key, cardValue(card));
    }
}

// The file's HDUs: [{ cards, keys, data, size, kind ('image', 'compressed',
// 'table', 'groups'), dims, bitpix, name }]
function fitsHdus(bytes) {
    if (!isFits(bytes)) throw new Error('not a FITS file');
    const hdus = [];
    for (let pos = 0; pos + 80 <= bytes.length;) {
        const first = new TextDecoder('latin1').decode(bytes.subarray(pos, pos + 8));
        if (first !== (hdus.length ? 'XTENSION' : 'SIMPLE  ')) break; // padding, or something after the FITS data
        let h;
        try { h = readHeader(bytes, pos); } catch (err) { if (hdus.length) break; throw err; }
        const k = h.keys;
        const naxis = k.get('NAXIS') || 0;
        const dims = [];
        for (let i = 1; i <= naxis; i++) dims.push(k.get('NAXIS' + i) || 0);
        const groups = !hdus.length && k.get('GROUPS') === true && dims[0] === 0;
        const count = !naxis ? 0 : (groups ? dims.slice(1) : dims).reduce((a, b) => a * b, 1);
        h.bitpix = k.get('BITPIX');
        h.size = Math.abs(h.bitpix) / 8 * (k.get('GCOUNT') || 1) * ((k.get('PCOUNT') || 0) + count);
        const xt = String(k.get('XTENSION') || '').trim();
        h.name = String(k.get('EXTNAME') || '').trim();
        if (groups) h.kind = 'groups';
        else if (!hdus.length || xt === 'IMAGE' || xt === 'IUEIMAGE') h.kind = 'image';
        else if (xt === 'BINTABLE' && k.get('ZIMAGE') === true) {
            h.kind = 'compressed';
            h.bitpix = k.get('ZBITPIX');
            dims.length = 0;
            for (let i = 1; i <= (k.get('ZNAXIS') || 0); i++) dims.push(k.get('ZNAXIS' + i) || 0);
        } else h.kind = 'table';
        h.dims = dims;
        hdus.push(h);
        pos = h.data + Math.ceil(h.size / BLOCK) * BLOCK;
    }
    return hdus;
}

// Pages: [{ hdu, plane (-1: planes 0..2 as RGB), width, height, label }]
function fitsPages(hdus) {
    const pages = [];
    hdus.forEach((h, i) => {
        if ((h.kind !== 'image' && h.kind !== 'compressed') || h.dims.length < 2 || h.dims.some(d => d <= 0)) return;
        const [width, height] = h.dims;
        const planes = h.dims.slice(2).reduce((a, b) => a * b, 1);
        const base = `HDU ${i}${h.name ? ' ' + h.name : ''}, BITPIX ${h.bitpix}`
            + (h.kind === 'compressed' ? `, ${String(h.keys.get('ZCMPTYPE') || '').trim()} tiles` : '');
        if (planes === 3 && h.dims.length === 3) pages.push({ hdu: i, plane: -1, width, height, label: `${base}, planes 1-3 as RGB` });
        for (let p = 0; p < planes; p++) {
            pages.push({ hdu: i, plane: p, width, height, label: base + (planes > 1 ? `, plane ${p + 1} of ${planes}` : '') });
        }
    });
    return pages;
}

// --- Uncompressed images ---

// Pixel values of plane `plane` of an image HDU: BZERO + BSCALE * stored, NaN where BLANK
function imagePlane(bytes, h, plane) {
    const k = h.keys;
    const n = h.dims[0] * h.dims[1];
    const bpp = Math.abs(h.bitpix) / 8;
    const start = h.data + plane * n * bpp;
    if (start + n * bpp > bytes.length) throw new Error('FITS data is cut short');
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, n * bpp);
    const zero = k.get('BZERO') || 0, scale = k.has('BSCALE') ? k.get('BSCALE') : 1;
    const blank = h.bitpix > 0 && k.has('BLANK') ? k.get('BLANK') : null;
    const out = new Float32Array(n);
    const read = {
        8: i => view.getUint8(i),
        16: i => view.getInt16(i * 2),
        32: i => view.getInt32(i * 4),
        64: i => Number(view.getBigInt64(i * 8)),
        '-32': i => view.getFloat32(i * 4),
        '-64': i => view.getFloat64(i * 8),
    }[h.bitpix];
    if (!read) throw new Error(`BITPIX ${h.bitpix} isn't supported`);
    for (let i = 0; i < n; i++) {
        const v = read(i);
        out[i] = v === blank ? NaN : v * scale + zero;
    }
    return out;
}

// --- Tile-compressed images (ported from CFITSIO) ---

const SIZES = { L: 1, B: 1, A: 1, I: 2, J: 4, K: 8, E: 4, D: 8, C: 8, M: 16 };

// A binary table's columns by name: { offset, type, repeat, pointer ('P', 'Q' or '') }
function tableColumns(h) {
    const k = h.keys;
    const cols = new Map();
    let offset = 0;
    for (let i = 1; i <= (k.get('TFIELDS') || 0); i++) {
        const m = /^\s*(\d*)([PQ]?)([LXBIJKAEDCM])/.exec(String(k.get('TFORM' + i) || ''));
        if (!m) throw new Error(`TFORM${i} isn't understood`);
        const repeat = m[1] === '' ? 1 : +m[1];
        const pointer = m[2], type = m[3];
        const name = String(k.get('TTYPE' + i) || '').trim().toUpperCase();
        if (name) cols.set(name, { offset, type, repeat, pointer });
        offset += pointer === 'P' ? 8 * repeat : pointer === 'Q' ? 16 * repeat : type === 'X' ? Math.ceil(repeat / 8) : repeat * SIZES[type];
    }
    return cols;
}

// The value of a scalar column in row (0-based)
function cellValue(view, rowStart, col) {
    const p = rowStart + col.offset;
    switch (col.type) {
        case 'B': return view.getUint8(p);
        case 'I': return view.getInt16(p);
        case 'J': return view.getInt32(p);
        case 'K': return Number(view.getBigInt64(p));
        case 'E': return view.getFloat32(p);
        case 'D': return view.getFloat64(p);
        default: throw new Error(`a ${col.type} column isn't read`);
    }
}

// A variable-length array column's [count, offset in the heap] in row
function cellArray(view, rowStart, col) {
    const p = rowStart + col.offset;
    if (col.pointer === 'Q') return [Number(view.getBigInt64(p)), Number(view.getBigInt64(p + 8))];
    return [view.getInt32(p), view.getInt32(p + 4)];
}

async function inflate(bytes) {
    const ds = new DecompressionStream(bytes[0] === 0x1f && bytes[1] === 0x8b ? 'gzip' : 'deflate');
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}

// GZIP_2 stores the most significant bytes of every value first, then the next...
function unshuffleBytes(bytes, size) {
    const n = bytes.length / size;
    const out = new Uint8Array(bytes.length);
    for (let j = 0; j < size; j++) for (let i = 0; i < n; i++) out[i * size + j] = bytes[j * n + i];
    return out;
}

// Big-endian values of `size` bytes (float: IEEE floats) as numbers
function bigEndianValues(bytes, size, float) {
    const n = bytes.length / size;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = size === 1 ? bytes[i] : size === 2 ? view.getInt16(i * 2)
            : size === 4 ? (float ? view.getFloat32(i * 4) : view.getInt32(i * 4))
            : float ? view.getFloat64(i * 8) : Number(view.getBigInt64(i * 8));
    }
    return out;
}

// Rice: blocks of `nblock` differences, each block's FS (fsbits) then the
// values split in a unary high part and FS low bits (fits_rdecomp and its
// _short/_byte forms: bytepix 4, 2 or 1)
function riceDecode(c, n, nblock, bytepix) {
    const fsbits = bytepix === 1 ? 3 : bytepix === 2 ? 4 : 5;
    const fsmax = bytepix === 1 ? 6 : bytepix === 2 ? 14 : 25;
    const bbits = 8 * bytepix;
    const mod = 2 ** bbits;
    const out = new Float64Array(n);
    if (c.length < bytepix) throw new Error('Rice tile is cut short');
    let lastpix = 0;
    for (let i = 0; i < bytepix; i++) lastpix = lastpix * 256 + c[i];
    let pos = bytepix, bit = 0; // the next bit: c[pos], from the top (bit 0)
    const readBit = () => {
        if (pos >= c.length) throw new Error('Rice tile is cut short');
        const v = (c[pos] >> (7 - bit)) & 1;
        if (++bit === 8) { bit = 0; pos++; }
        return v;
    };
    const readBits = k => {
        let v = 0;
        for (; k > 0 && bit; k--) v = v * 2 + readBit();
        for (; k >= 8; k -= 8) {
            if (pos >= c.length) throw new Error('Rice tile is cut short');
            v = v * 256 + c[pos++];
        }
        for (; k > 0; k--) v = v * 2 + readBit();
        return v;
    };
    for (let i = 0; i < n;) {
        const fs = readBits(fsbits) - 1;
        const imax = Math.min(i + nblock, n);
        if (fs < 0) {
            for (; i < imax; i++) out[i] = lastpix;
            continue;
        }
        for (; i < imax; i++) {
            let diff;
            if (fs === fsmax) diff = readBits(bbits);
            else {
                let nzero = 0;
                while (!readBit()) nzero++;
                diff = nzero * 2 ** fs + readBits(fs);
            }
            // undo the mapping of signed differences to unsigned, then the differencing
            const d = diff % 2 === 0 ? diff / 2 : -(diff + 1) / 2;
            lastpix = ((lastpix + d) % mod + mod) % mod;
            out[i] = lastpix;
        }
    }
    // the stored values: unsigned bytes, signed 16 and 32-bit integers
    if (bytepix > 1) for (let i = 0; i < n; i++) if (out[i] >= mod / 2) out[i] -= mod;
    return out;
}

// PLIO: IRAF's line list of runs (pl_l2pi)
function plioDecode(bytes, npix) {
    const count = bytes.length >> 1;
    const ll = new Int16Array(count + 1); // 1-based, as the Fortran it came from
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let i = 0; i < count; i++) ll[i + 1] = view.getInt16(i * 2);
    const px = new Float64Array(npix + 1);
    let lllen, llfirt;
    if (ll[3] > 0) { lllen = ll[3]; llfirt = 4; } else { lllen = (ll[5] << 15) + ll[4]; llfirt = ll[2] + 1; }
    const xs = 1, xe = xs + npix - 1;
    let op = 1, x1 = 1, pv = 1, skipwd = false;
    for (let ip = llfirt; ip <= lllen; ip++) {
        if (skipwd) { skipwd = false; continue; }
        if (ip < 1 || ip > count) throw new Error('PLIO tile is cut short');
        const opcode = Math.trunc(ll[ip] / 4096);
        const data = ll[ip] & 4095;
        switch (opcode) {
            case 0: case 4: case 5: {
                const x2 = x1 + data - 1;
                const i1 = Math.max(x1, xs), i2 = Math.min(x2, xe);
                const np = i2 - i1 + 1;
                if (np > 0) {
                    const otop = op + np - 1;
                    for (let i = op; i <= otop; i++) px[i] = opcode === 4 ? pv : 0;
                    if (opcode === 5 && i2 === x2) px[otop] = pv;
                    op = otop + 1;
                }
                x1 = x2 + 1;
                break;
            }
            case 1:
                if (ip + 1 > count) throw new Error('PLIO tile is cut short');
                pv = (ll[ip + 1] << 12) + data;
                skipwd = true;
                break;
            case 2: pv += data; break;
            case 3: pv -= data; break;
            case 6: case 7:
                pv += opcode === 6 ? data : -data;
                if (x1 >= xs && x1 <= xe) px[op++] = pv;
                x1++;
                break;
        }
        if (x1 > xe) break;
    }
    return px.subarray(1);
}

// H-compress (fits_hdecompress, fits_hdecompress64): quadtree-coded bit planes
// of an H-transform, scaled, then inverted, smoothed if asked. Values are
// doubles here, so the 64-bit form and the 32-bit one are the same code; the
// C's shifts and masks on (negative) integers become floors.
const floorTo = (x, b) => Math.floor(x / b) * b;           // x & -b
const bitOf = (x, b) => ((Math.floor(x / b) % 2) + 2) % 2; // (x & b) != 0, two's complement

function hdecompress(c, smooth, wide) {
    let pos = 0, buffer = 0, bitsToGo = 0;
    const byte = () => {
        if (pos >= c.length) throw new Error('HCOMPRESS tile is cut short');
        return c[pos++];
    };
    const inputBit = () => {
        if (bitsToGo === 0) { buffer = byte(); bitsToGo = 8; }
        return (buffer >> --bitsToGo) & 1;
    };
    const inputNbits = n => {
        if (bitsToGo < n) { buffer = ((buffer << 8) | byte()) & 0xffff; bitsToGo += 8; }
        bitsToGo -= n;
        return (buffer >> bitsToGo) & ((1 << n) - 1);
    };
    const inputNybble = () => inputNbits(4);
    const inputHuffman = () => {
        let v = inputNbits(3);
        if (v < 4) return 1 << v;
        v = inputBit() | (v << 1);
        if (v < 13) return [3, 5, 10, 12, 15][v - 8];
        v = inputBit() | (v << 1);
        if (v < 31) return [6, 7, 9, 11, 13][v - 26];
        v = inputBit() | (v << 1);
        return v === 62 ? 0 : 14;
    };
    const readInt = () => ((byte() << 24) | (byte() << 16) | (byte() << 8) | byte());

    if (c[0] !== 0xdd || c[1] !== 0x99) throw new Error('not an HCOMPRESS tile');
    pos = 2;
    const nx = readInt(), ny = readInt(), scale = readInt();
    let sumall = 0n;
    for (let i = 0; i < 8; i++) sumall = (sumall << 8n) | BigInt(byte());
    sumall = BigInt.asIntN(64, sumall);
    const nbitplanes = [byte(), byte(), byte()];
    const a = new Float64Array(nx * ny);

    // copy 4-bit values from s[(nx+1)/2, (ny+1)/2] to b[nx, ny] (rows of n), each to a 2x2 block
    const qtreeCopy = (s, nx, ny, b, n) => {
        const nx2 = (nx + 1) >> 1, ny2 = (ny + 1) >> 1;
        let k = ny2 * (nx2 - 1) + ny2 - 1;
        for (let i = nx2 - 1; i >= 0; i--) {
            let s00 = 2 * (n * i + ny2 - 1);
            for (let j = ny2 - 1; j >= 0; j--, k--, s00 -= 2) b[s00] = s[k];
        }
        let i = 0;
        for (; i < nx - 1; i += 2) {
            let s00 = n * i, s10 = s00 + n, j = 0;
            for (; j < ny - 1; j += 2, s00 += 2, s10 += 2) {
                const v = b[s00];
                b[s10 + 1] = v & 1; b[s10] = (v >> 1) & 1; b[s00 + 1] = (v >> 2) & 1; b[s00] = (v >> 3) & 1;
            }
            if (j < ny) { b[s10] = (b[s00] >> 1) & 1; b[s00] = (b[s00] >> 3) & 1; }
        }
        if (i < nx) {
            let s00 = n * i, j = 0;
            for (; j < ny - 1; j += 2, s00 += 2) { b[s00 + 1] = (b[s00] >> 2) & 1; b[s00] = (b[s00] >> 3) & 1; }
            if (j < ny) b[s00] = (b[s00] >> 3) & 1;
        }
    };
    // the same 2x2 expansion, into bit plane `bit` of a (from off, rows of n)
    const qtreeBitins = (s, nx, ny, off, n, bit) => {
        const pv = 2 ** bit;
        let k = 0, i = 0;
        for (; i < nx - 1; i += 2) {
            let s00 = off + n * i, j = 0;
            for (; j < ny - 1; j += 2, s00 += 2, k++) {
                const v = s[k];
                if (v & 1) a[s00 + n + 1] += pv;
                if (v & 2) a[s00 + n] += pv;
                if (v & 4) a[s00 + 1] += pv;
                if (v & 8) a[s00] += pv;
            }
            if (j < ny) {
                const v = s[k++];
                if (v & 2) a[s00 + n] += pv;
                if (v & 8) a[s00] += pv;
            }
        }
        if (i < nx) {
            let s00 = off + n * i, j = 0;
            for (; j < ny - 1; j += 2, s00 += 2, k++) {
                const v = s[k];
                if (v & 4) a[s00 + 1] += pv;
                if (v & 8) a[s00] += pv;
            }
            if (j < ny && (s[k] & 8)) a[s00] += pv;
        }
    };
    const log2Up = n => {
        let l = Math.trunc(Math.log(Math.max(n, 1)) / Math.log(2) + 0.5);
        if (n > (1 << l)) l++;
        return l;
    };
    const qtreeDecode = (off, n, nqx, nqy, planes) => {
        const log2n = log2Up(Math.max(nqx, nqy));
        const nqx2 = (nqx + 1) >> 1, nqy2 = (nqy + 1) >> 1;
        const scratch = new Uint8Array(Math.max(1, nqx2 * nqy2));
        for (let bit = planes - 1; bit >= 0; bit--) {
            const b = inputNybble();
            if (b === 0) {
                // the bit map written directly, 4 pixels a nybble
                for (let i = 0; i < nqx2 * nqy2; i++) scratch[i] = inputNybble();
            } else if (b !== 0xf) throw new Error('HCOMPRESS tile has a bad format code');
            else {
                scratch[0] = inputHuffman();
                let nx = 1, ny = 1, nfx = nqx, nfy = nqy, cc = 1 << log2n;
                for (let k = 1; k < log2n; k++) {
                    cc >>= 1;
                    nx <<= 1;
                    ny <<= 1;
                    if (nfx <= cc) nx--; else nfx -= cc;
                    if (nfy <= cc) ny--; else nfy -= cc;
                    qtreeCopy(scratch, nx, ny, scratch, ny);
                    for (let i = nx * ny - 1; i >= 0; i--) if (scratch[i]) scratch[i] = inputHuffman();
                }
            }
            qtreeBitins(scratch, nqx, nqy, off, n, bit);
        }
    };

    // the four quadrants' bit planes, then the signs
    const nx2 = (nx + 1) >> 1, ny2 = (ny + 1) >> 1;
    qtreeDecode(0, ny, nx2, ny2, nbitplanes[0]);
    qtreeDecode(ny2, ny, nx2, ny >> 1, nbitplanes[1]);
    qtreeDecode(ny * nx2, ny, nx >> 1, ny2, nbitplanes[1]);
    qtreeDecode(ny * nx2 + ny2, ny, nx >> 1, ny >> 1, nbitplanes[2]);
    if (inputNybble() !== 0) throw new Error('HCOMPRESS tile has bad bit plane values');
    bitsToGo = 0;
    for (let i = 0; i < a.length; i++) if (a[i] && inputBit()) a[i] = -a[i];
    a[0] = Number(wide ? sumall : BigInt.asIntN(32, sumall));

    // undigitize
    if (scale > 1) for (let i = 0; i < a.length; i++) a[i] *= scale;
    hinv(a, nx, ny, smooth, scale, log2Up(Math.max(nx, ny)));
    return { values: a, nx, ny };
}

function unshuffle(a, off, n, n2, tmp) {
    const nhalf = (n + 1) >> 1;
    for (let i = nhalf, p = off + n2 * nhalf, t = 0; i < n; i++, p += n2) tmp[t++] = a[p];
    for (let i = nhalf - 1, p2 = off + n2 * i, p1 = off + 2 * n2 * i; i >= 0; i--, p2 -= n2, p1 -= 2 * n2) a[p1] = a[p2];
    for (let i = 1, p = off + n2, t = 0; i < n; i += 2, p += 2 * n2) a[p] = tmp[t++];
}

// Adjust the H-transform coefficients toward interpolated values (hsmooth)
function hsmooth(a, nxtop, nytop, ny, scale) {
    const smax = scale >> 1;
    if (smax <= 0) return;
    const ny2 = ny << 1;
    const clampS = s => Math.max(Math.min(s, smax), -smax);
    for (let i = 2; i < nxtop - 2; i += 2) {
        let s00 = ny * i, s10 = s00 + ny;
        for (let j = 0; j < nytop; j += 2, s00 += 2, s10 += 2) {
            const hm = a[s00 - ny2], h0 = a[s00], hp = a[s00 + ny2];
            let diff = hp - hm;
            const dmax = Math.max(Math.min(hp - h0, h0 - hm), 0) * 4;
            const dmin = Math.min(Math.max(hp - h0, h0 - hm), 0) * 4;
            if (dmin < dmax) {
                diff = Math.max(Math.min(diff, dmax), dmin);
                const s = diff - a[s10] * 8;
                a[s10] += clampS(s >= 0 ? Math.floor(s / 8) : Math.floor((s + 7) / 8));
            }
        }
    }
    for (let i = 0; i < nxtop; i += 2) {
        let s00 = ny * i + 2;
        for (let j = 2; j < nytop - 2; j += 2, s00 += 2) {
            const hm = a[s00 - 2], h0 = a[s00], hp = a[s00 + 2];
            let diff = hp - hm;
            const dmax = Math.max(Math.min(hp - h0, h0 - hm), 0) * 4;
            const dmin = Math.min(Math.max(hp - h0, h0 - hm), 0) * 4;
            if (dmin < dmax) {
                diff = Math.max(Math.min(diff, dmax), dmin);
                const s = diff - a[s00 + 1] * 8;
                a[s00 + 1] += clampS(s >= 0 ? Math.floor(s / 8) : Math.floor((s + 7) / 8));
            }
        }
    }
    for (let i = 2; i < nxtop - 2; i += 2) {
        let s00 = ny * i + 2, s10 = s00 + ny;
        for (let j = 2; j < nytop - 2; j += 2, s00 += 2, s10 += 2) {
            const hmm = a[s00 - ny2 - 2], hpm = a[s00 + ny2 - 2], hmp = a[s00 - ny2 + 2], hpp = a[s00 + ny2 + 2], h0 = a[s00];
            let diff = hpp + hmm - hmp - hpm;
            const hx2 = a[s10] * 2, hy2 = a[s00 + 1] * 2;
            let m1 = Math.min(Math.max(hpp - h0, 0) - hx2 - hy2, Math.max(h0 - hpm, 0) + hx2 - hy2);
            let m2 = Math.min(Math.max(h0 - hmp, 0) - hx2 + hy2, Math.max(hmm - h0, 0) + hx2 + hy2);
            const dmax = Math.min(m1, m2) * 16;
            m1 = Math.max(Math.min(hpp - h0, 0) - hx2 - hy2, Math.min(h0 - hpm, 0) + hx2 - hy2);
            m2 = Math.max(Math.min(h0 - hmp, 0) - hx2 + hy2, Math.min(hmm - h0, 0) + hx2 + hy2);
            const dmin = Math.max(m1, m2) * 16;
            if (dmin < dmax) {
                diff = Math.max(Math.min(diff, dmax), dmin);
                const s = diff - a[s10 + 1] * 64;
                a[s10 + 1] += clampS(s >= 0 ? Math.floor(s / 64) : Math.floor((s + 63) / 64));
            }
        }
    }
}

// The inverse H-transform, log2n expansions (hinv)
function hinv(a, nx, ny, smooth, scale, log2n) {
    const nmax = Math.max(nx, ny);
    const tmp = new Float64Array((nmax + 1) >> 1);
    let shift = 1;
    let bit0 = 2 ** (log2n - 1), bit1 = bit0 * 2, bit2 = bit0 * 4;
    let prnd0 = Math.floor(bit0 / 2), prnd1 = Math.floor(bit1 / 2), prnd2 = Math.floor(bit2 / 2);
    let nrnd0 = prnd0 - 1, nrnd1 = prnd1 - 1;
    const nrnd2 = prnd2 - 1;
    a[0] = floorTo(a[0] + (a[0] >= 0 ? prnd2 : nrnd2), bit2);
    let nxtop = 1, nytop = 1, nxf = nx, nyf = ny, c = 2 ** log2n;
    for (let k = log2n - 1; k >= 0; k--) {
        c /= 2;
        nxtop <<= 1;
        nytop <<= 1;
        if (nxf <= c) nxtop--; else nxf -= c;
        if (nyf <= c) nytop--; else nyf -= c;
        if (k === 0) { nrnd0 = 0; shift = 2; }
        const div = 2 ** shift;
        for (let i = 0; i < nxtop; i++) unshuffle(a, ny * i, nytop, 1, tmp);
        for (let j = 0; j < nytop; j++) unshuffle(a, j, nxtop, ny, tmp);
        if (smooth) hsmooth(a, nxtop, nytop, ny, scale);
        const oddx = nxtop % 2, oddy = nytop % 2;
        let i = 0;
        for (; i < nxtop - oddx; i += 2) {
            let s00 = ny * i, s10 = s00 + ny, j = 0;
            for (; j < nytop - oddy; j += 2, s00 += 2, s10 += 2) {
                let h0 = a[s00], hx = a[s10], hy = a[s00 + 1], hc = a[s10 + 1];
                // round hx and hy to multiples of bit1, hc to a multiple of bit0
                hx = floorTo(hx + (hx >= 0 ? prnd1 : nrnd1), bit1);
                hy = floorTo(hy + (hy >= 0 ? prnd1 : nrnd1), bit1);
                hc = floorTo(hc + (hc >= 0 ? prnd0 : nrnd0), bit0);
                // propagate bit0 of hc to hx, hy; bits 0 and 1 of hc, hx, hy to h0
                const lowbit0 = bitOf(hc, bit0) * bit0;
                hx = hx >= 0 ? hx - lowbit0 : hx + lowbit0;
                hy = hy >= 0 ? hy - lowbit0 : hy + lowbit0;
                const lowbit1 = ((bitOf(hc, bit1) + bitOf(hx, bit1) + bitOf(hy, bit1)) % 2) * bit1;
                h0 = h0 >= 0 ? h0 + lowbit0 - lowbit1 : h0 + (lowbit0 === 0 ? lowbit1 : lowbit0 - lowbit1);
                a[s10 + 1] = Math.floor((h0 + hx + hy + hc) / div);
                a[s10] = Math.floor((h0 + hx - hy - hc) / div);
                a[s00 + 1] = Math.floor((h0 - hx + hy - hc) / div);
                a[s00] = Math.floor((h0 - hx - hy + hc) / div);
            }
            if (oddy) {
                let h0 = a[s00], hx = a[s10];
                hx = floorTo(hx + (hx >= 0 ? prnd1 : nrnd1), bit1);
                const lowbit1 = bitOf(hx, bit1) * bit1;
                h0 = h0 >= 0 ? h0 - lowbit1 : h0 + lowbit1;
                a[s10] = Math.floor((h0 + hx) / div);
                a[s00] = Math.floor((h0 - hx) / div);
            }
        }
        if (oddx) {
            let s00 = ny * i, j = 0;
            for (; j < nytop - oddy; j += 2, s00 += 2) {
                let h0 = a[s00], hy = a[s00 + 1];
                hy = floorTo(hy + (hy >= 0 ? prnd1 : nrnd1), bit1);
                const lowbit1 = bitOf(hy, bit1) * bit1;
                h0 = h0 >= 0 ? h0 - lowbit1 : h0 + lowbit1;
                a[s00 + 1] = Math.floor((h0 + hy) / div);
                a[s00] = Math.floor((h0 - hy) / div);
            }
            if (oddy) a[s00] = Math.floor(a[s00] / div);
        }
        // halve the masks and rounding values
        bit2 = bit1;
        bit1 = bit0;
        bit0 = Math.floor(bit0 / 2);
        prnd1 = prnd0;
        prnd0 = Math.floor(prnd0 / 2);
        nrnd1 = nrnd0;
        nrnd0 = prnd0 - 1;
    }
}

// CFITSIO's 10000 random numbers for subtractive dithering (fits_init_randoms)
let randoms = null;
function ditherRandoms() {
    if (!randoms) {
        randoms = new Float32Array(10000);
        let seed = 1;
        for (let i = 0; i < 10000; i++) {
            const temp = 16807 * seed;
            seed = temp - 2147483647 * Math.trunc(temp / 2147483647);
            randoms[i] = seed / 2147483647;
        }
    }
    return randoms;
}

const ZERO_VALUE = -2147483646; // SUBTRACTIVE_DITHER_2's zero

// The whole image of a compressed HDU, tile by tile: Float32Array of values, NaN where null
async function compressedImage(bytes, h) {
    const k = h.keys;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const cols = tableColumns(h);
    const rowLen = k.get('NAXIS1'), rows = k.get('NAXIS2');
    const heap = h.data + (k.get('THEAP') || rowLen * rows);
    const ctype = String(k.get('ZCMPTYPE') || '').trim().replace('RICE_ONE', 'RICE_1');
    const zbitpix = h.bitpix;
    const dims = h.dims;
    const tile = dims.map((d, i) => k.get('ZTILE' + (i + 1)) || (i ? 1 : d));
    const cdata = cols.get('COMPRESSED_DATA'), gzdata = cols.get('GZIP_COMPRESSED_DATA'), rawdata = cols.get('UNCOMPRESSED_DATA');
    if (!cdata) throw new Error('compressed image has no COMPRESSED_DATA column');
    if (!['RICE_1', 'GZIP_1', 'GZIP_2', 'HCOMPRESS_1', 'PLIO_1'].includes(ctype)) throw new Error(`${ctype || 'this'} compression isn't supported`);

    // algorithm parameters, as CFITSIO reads them
    let blocksize = k.get('ZVAL1') || 32, bytepix = k.get('ZVAL2') || 4;
    if (ctype === 'RICE_1') {
        if (String(k.get('ZNAME2') || '').trim() === 'NOISEBIT' || !k.has('ZVAL2')) bytepix = 4;
        if (blocksize < 16 && bytepix > 8) [blocksize, bytepix] = [bytepix, blocksize];
    }
    const smooth = ctype === 'HCOMPRESS_1' ? k.get('ZVAL2') || 0 : 0;
    // quantized floats
    const zscaleCol = cols.get('ZSCALE'), zzeroCol = cols.get('ZZERO'), zblankCol = cols.get('ZBLANK');
    const quantize = zbitpix < 0 ? (zscaleCol || zzeroCol ? String(k.has('ZQUANTIZ') ? k.get('ZQUANTIZ') : 'NO_DITHER').trim() : 'NONE') : null;
    const ditherSeed = k.has('ZDITHER0') ? k.get('ZDITHER0') : 1;
    const bscaleKey = k.has('BSCALE') ? k.get('BSCALE') : 1, bzeroKey = k.get('BZERO') || 0;
    const zblankKey = k.has('ZBLANK') ? k.get('ZBLANK') : k.has('BLANK') ? k.get('BLANK') : null;
    const plioUnsigned = ctype === 'PLIO_1' && bzeroKey === 32768;

    const total = dims.reduce((a, b) => a * b, 1);
    const out = new Float32Array(total).fill(NaN);
    const ntiles = dims.map((d, i) => Math.ceil(d / tile[i]));
    const strides = dims.map((d, i) => dims.slice(0, i).reduce((a, b) => a * b, 1));
    const rnd = ditherRandoms();
    for (let row = 0; row < rows; row++) {
        // the tile's corner and size
        const origin = [];
        let t = row;
        for (let i = 0; i < dims.length; i++) { origin.push((t % ntiles[i]) * tile[i]); t = Math.floor(t / ntiles[i]); }
        const tdims = dims.map((d, i) => Math.min(tile[i], d - origin[i]));
        const n = tdims.reduce((a, b) => a * b, 1);
        const rowStart = h.data + row * rowLen;
        const [count, offset] = cellArray(view, rowStart, cdata);
        let values; // what the tile holds: integers, or floats when `floats`
        let floats = false;
        if (count === 0) {
            // not compressed normally: the floats gzipped, or (before 2011) as they are
            const col = gzdata || rawdata;
            if (!col) throw new Error(`tile ${row + 1} is empty`);
            const [c2, o2] = cellArray(view, rowStart, col);
            const size = col === gzdata ? 1 : SIZES[col.type];
            const raw = bytes.subarray(heap + o2, heap + o2 + c2 * size);
            const data = col === gzdata ? await inflate(raw) : raw;
            values = bigEndianValues(data, col === gzdata ? data.length / n : size, col === gzdata || col.type === 'E' || col.type === 'D');
            floats = true;
        } else {
            const size = SIZES[cdata.type] || 1;
            const data = bytes.subarray(heap + offset, heap + offset + count * size);
            if (heap + offset + count * size > bytes.length) throw new Error('FITS data is cut short');
            if (ctype === 'RICE_1') values = riceDecode(data, n, blocksize, bytepix);
            else if (ctype === 'PLIO_1') values = plioDecode(data, n);
            else if (ctype === 'HCOMPRESS_1') {
                values = hdecompress(data, smooth, zbitpix !== 8 && zbitpix !== 16).values;
                // what CFITSIO clips to when it reads them as bytes or shorts
                if (zbitpix === 8) for (let i = 0; i < n; i++) values[i] = Math.max(0, Math.min(255, values[i]));
                if (zbitpix === 16) for (let i = 0; i < n; i++) values[i] = Math.max(-32768, Math.min(32767, values[i]));
            } else {
                let raw = await inflate(data);
                const size = raw.length / n;
                if (![1, 2, 4, 8].includes(size)) throw new Error(`tile ${row + 1} has the wrong size`);
                if (ctype === 'GZIP_2' && size > 1) raw = unshuffleBytes(raw, size);
                floats = zbitpix < 0 && quantize === 'NONE';
                values = bigEndianValues(raw, size, floats);
            }
            if (values.length < n) throw new Error(`tile ${row + 1} is short`);
        }
        // to values: scaled, dithered back, nulls NaN
        let scale = 1, zero = 0;
        if (zscaleCol) {
            scale = cellValue(view, rowStart, zscaleCol);
            zero = zzeroCol ? cellValue(view, rowStart, zzeroCol) : 0;
            if (zbitpix < 0 && (bscaleKey !== 1 || bzeroKey !== 0)) { zero = zero * bscaleKey + bzeroKey; scale *= bscaleKey; }
        } else if (k.has('ZSCALE')) {
            scale = k.get('ZSCALE');
            zero = k.get('ZZERO') || 0;
        }
        if (scale === 1 && zero === 0) { scale = bscaleKey; zero = bzeroKey; }
        if (plioUnsigned) zero -= 32768;
        const blank = floats ? null : zblankCol ? cellValue(view, rowStart, zblankCol) : zblankKey;
        const tileValues = new Float32Array(n);
        if (!floats && (quantize === 'SUBTRACTIVE_DITHER_1' || quantize === 'SUBTRACTIVE_DITHER_2')) {
            const two = quantize === 'SUBTRACTIVE_DITHER_2';
            let iseed = (((row + 1 + ditherSeed - 1) - 1) % 10000 + 10000) % 10000;
            let next = Math.trunc(rnd[iseed] * 500);
            for (let i = 0; i < n; i++) {
                const v = values[i];
                tileValues[i] = v === blank ? NaN : two && v === ZERO_VALUE ? 0 : (v - rnd[next] + 0.5) * scale + zero;
                if (++next === 10000) {
                    if (++iseed === 10000) iseed = 0;
                    next = Math.trunc(rnd[iseed] * 500);
                }
            }
        } else {
            for (let i = 0; i < n; i++) tileValues[i] = values[i] === blank ? NaN : values[i] * scale + zero;
        }
        // into place, a row of the tile at a time
        const w = tdims[0];
        for (let r = 0; r < n / w; r++) {
            let dest = origin[0], q = r;
            for (let i = 1; i < dims.length; i++) {
                dest += (origin[i] + (q % tdims[i])) * strides[i];
                q = Math.floor(q / tdims[i]);
            }
            out.set(tileValues.subarray(r * w, (r + 1) * w), dest);
        }
    }
    return out;
}

// The values of page `page`'s plane (Float32Array, NaN where blank)
async function planeValues(file, page) {
    const pg = file.pages[page];
    const h = file.hdus[pg.hdu];
    const n = pg.width * pg.height;
    if (h.kind === 'compressed') {
        if (!h.image) {
            h.image = compressedImage(file.bytes, h);
            h.image.catch(() => { h.image = null; });
        }
        const all = await h.image;
        return all.subarray(pg.plane * n, (pg.plane + 1) * n);
    }
    return imagePlane(file.bytes, h, pg.plane);
}

// --- Intervals and stretches (astropy.visualization's) ---

const INTERVALS = [['zscale', 'zscale'], ['minmax', 'min/max'], ['99.5', '99.5%'], ['99', '99%']];
const STRETCHES = [['linear', 'linear'], ['sqrt', 'sqrt'], ['log', 'log'], ['asinh', 'asinh']];

// IRAF's zscale as astropy's ZScaleInterval has it: up to 1000 samples, a line
// fitted to them sorted with k-sigma rejection, its slope / contrast around the median
function zscaleLimits(values) {
    let finite = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite++;
    if (!finite) return [0, 0];
    const stride = Math.max(1, Math.trunc(finite / 1000));
    const samples = [];
    for (let i = 0, f = 0; i < values.length && samples.length < 1000; i++) {
        if (!Number.isFinite(values[i])) continue;
        if (f++ % stride === 0) samples.push(values[i]);
    }
    const s = Float64Array.from(samples).sort();
    const npix = s.length;
    let vmin = s[0], vmax = s[npix - 1];
    const minpix = Math.max(5, Math.trunc(npix * 0.5));
    const ngrow = Math.max(1, Math.trunc(npix * 0.01));
    let bad = new Uint8Array(npix);
    let ngood = npix, last = npix + 1, slope = 0;
    for (let iter = 0; iter < 5; iter++) {
        if (ngood >= last || ngood < minpix) break;
        // least squares line through the good samples (around their means: values
        // of 1e12 and more lose nothing)
        let sw = 0, mx = 0, my = 0;
        for (let i = 0; i < npix; i++) if (!bad[i]) { sw++; mx += i; my += s[i]; }
        mx /= sw;
        my /= sw;
        let sxx = 0, sxy = 0;
        for (let i = 0; i < npix; i++) if (!bad[i]) { sxx += (i - mx) ** 2; sxy += (i - mx) * (s[i] - my); }
        slope = sxy / sxx;
        const intercept = my - slope * mx;
        // k-sigma rejection around it
        let m = 0;
        const flat = new Float64Array(npix);
        for (let i = 0; i < npix; i++) { flat[i] = s[i] - (slope * i + intercept); if (!bad[i]) m += flat[i]; }
        m /= sw;
        let v = 0;
        for (let i = 0; i < npix; i++) if (!bad[i]) v += (flat[i] - m) ** 2;
        const threshold = 2.5 * Math.sqrt(v / sw);
        for (let i = 0; i < npix; i++) if (flat[i] < -threshold || flat[i] > threshold) bad[i] = 1;
        // grown by ngrow (np.convolve(..., mode='same'))
        const grown = new Uint8Array(npix);
        const off = (ngrow - 1) >> 1;
        for (let i = 0; i < npix; i++) {
            if (!bad[i]) continue;
            for (let j = Math.max(0, i - off); j <= Math.min(npix - 1, i - off + ngrow - 1); j++) grown[j] = 1;
        }
        bad = grown;
        last = ngood;
        ngood = 0;
        for (let i = 0; i < npix; i++) if (!bad[i]) ngood++;
    }
    if (ngood >= minpix) {
        slope /= 0.25; // contrast
        const center = Math.trunc((npix - 1) / 2);
        const median = npix % 2 ? s[npix >> 1] : (s[npix / 2 - 1] + s[npix / 2]) / 2;
        vmin = Math.max(vmin, median - (center - 1) * slope);
        vmax = Math.min(vmax, median + (npix - center) * slope);
    }
    return [vmin, vmax];
}

// The interval's [vmin, vmax] for the values
function fitsLimits(values, interval = 'zscale') {
    if (interval === 'zscale') return zscaleLimits(values);
    const finite = new Float32Array(values.length);
    let n = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite[n++] = values[i];
    if (!n) return [0, 0];
    if (interval === 'minmax') {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) { if (finite[i] < lo) lo = finite[i]; if (finite[i] > hi) hi = finite[i]; }
        return [lo, hi];
    }
    // the middle `interval` percent (np.percentile, linear)
    const s = finite.subarray(0, n).sort();
    const at = p => {
        const x = p / 100 * (n - 1);
        const i = Math.floor(x), f = x - i;
        return i + 1 < n ? s[i] + (s[i + 1] - s[i]) * f : s[i];
    };
    const lower = (100 - Number(interval)) / 2;
    return [at(lower), at(100 - lower)];
}

const STRETCH_FN = {
    linear: x => x,
    sqrt: x => Math.sqrt(x),
    log: x => Math.log(1000 * x + 1) / Math.log(1001),
    asinh: x => Math.asinh(x / 0.1) / Math.asinh(1 / 0.1),
};

// 8-bit levels of the values: (v - vmin) / (vmax - vmin), clipped, stretched; -1 where NaN
function fitsLevels(values, [vmin, vmax], stretch = 'linear') {
    const fn = STRETCH_FN[stretch] || STRETCH_FN.linear;
    const range = vmax - vmin;
    const out = new Int16Array(values.length);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isNaN(v)) { out[i] = -1; continue; }
        const x = range > 0 ? Math.min(1, Math.max(0, (v - vmin) / range)) : 0;
        // to the nearest level, a tie to the even one (as numpy's round)
        const y = fn(x) * 255;
        let r = Math.round(y);
        if (r - y === 0.5 && r % 2) r--;
        out[i] = r;
    }
    return out;
}

// RGBA of page `page`, row 1 at the bottom: gray, or planes 1-3 as red, green
// and blue (each with its own interval); blank pixels transparent
async function fitsRgba(file, page, interval = 'zscale', stretch = 'linear') {
    const pg = file.pages[page];
    const { width, height } = pg;
    const planes = pg.plane < 0 ? [0, 1, 2].map(p => file.pages.findIndex(q => q.hdu === pg.hdu && q.plane === p)) : [page];
    const levels = [];
    for (const p of planes) {
        const values = await planeValues(file, p);
        levels.push(fitsLevels(values, fitsLimits(values, interval), stretch));
    }
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * width;
        for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
            const r = levels[0][src + x], g = levels[levels.length > 1 ? 1 : 0][src + x], b = levels[levels.length > 1 ? 2 : 0][src + x];
            out[o] = Math.max(r, 0);
            out[o + 1] = Math.max(g, 0);
            out[o + 2] = Math.max(b, 0);
            out[o + 3] = r < 0 && g < 0 && b < 0 ? 0 : 255;
        }
    }
    return out;
}

// --- In the browser ---

async function rgbaToPng(rgba, width, height) {
    const data = new ImageData(rgba, width, height);
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').putImageData(data, 0, 0);
        return canvas.convertToBlob({ type: 'image/png' });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(data, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
}

function fitsFile(url) {
    let p = files.get(url);
    if (!p) {
        p = fetch(url).then(async resp => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const bytes = new Uint8Array(await resp.arrayBuffer());
            const hdus = fitsHdus(bytes);
            const pages = fitsPages(hdus);
            if (!pages.length) {
                const what = h => h.kind === 'groups' ? 'random groups' : h.kind === 'table' ? 'a table' : h.dims.length ? 'a 1-D image' : 'an empty HDU';
                throw new Error(`no image in this FITS file (${hdus.map(what).join(', ')})`);
            }
            return { bytes, hdus, pages };
        });
        files.set(url, p);
        p.catch(() => files.delete(url));
        // the last few files only: another page or stretch reads the file again, not the network
        if (files.size > 4) files.delete(files.keys().next().value);
    }
    return p;
}

// Whether the file at url is a FITS file (for an .fz)
async function isFitsUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) return false;
    // the first chunk is enough
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return !!value && isFits(value);
}

// Page `page` of the FITS file at url, drawn: { url (a blob: URL of its PNG),
// pages: [{ width, height, label }], page }
function fitsPage(url, page = 0, interval = 'zscale', stretch = 'linear') {
    const key = `${url}#${page}#${interval}#${stretch}`;
    let p = drawn.get(key);
    if (!p) {
        p = (async () => {
            const file = await fitsFile(url);
            const n = Math.max(0, Math.min(file.pages.length - 1, page));
            const pg = file.pages[n];
            const png = await rgbaToPng(await fitsRgba(file, n, interval, stretch), pg.width, pg.height);
            return { url: URL.createObjectURL(png), pages: file.pages, page: n };
        })();
        drawn.set(key, p);
        p.catch(err => { drawn.delete(key); log.warn('FITS decode failed:', err); });
        if (drawn.size > 64) {
            const [oldKey, old] = drawn.entries().next().value;
            drawn.delete(oldKey);
            old.then(d => URL.revokeObjectURL(d.url)).catch(() => {});
        }
    }
    return p;
}

// Over an image viewer's <img> of the FITS file at url (root is the viewer's
// element, positioned): page buttons, the interval and the stretch; the
// header cards of every HDU in a panel that opens, the page's HDU in view
function addFitsControls(root, img, url) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:4px;align-items:center;z-index:1;'
        + 'background:rgba(0,0,0,0.6);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
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
    const prev = button('‹', 'Previous page (HDU or plane)');
    const info = document.createElement('span');
    const next = button('›', 'Next page (HDU or plane)');
    const interval = select(INTERVALS, 'Interval: the values shown black to white');
    const stretch = select(STRETCHES, 'Stretch');
    bar.append(prev, info, next, interval, stretch);

    const header = document.createElement('details');
    header.style.cssText = 'position:absolute;top:8px;left:8px;z-index:1;max-width:calc(100% - 16px);'
        + 'background:rgba(0,0,0,0.75);color:#fff;border-radius:4px;padding:2px 6px;font:12px sans-serif;';
    const summary = document.createElement('summary');
    summary.textContent = 'Header';
    summary.style.cssText = 'cursor:pointer;';
    const cards = document.createElement('div');
    cards.style.cssText = 'max-height:60vh;overflow:auto;margin-top:4px;font:12px monospace;white-space:pre;user-select:text;';
    header.append(summary, cards);

    let page = 0, pages = [], turn = 0;
    const hduBlocks = [];
    const show = async n => {
        if (!pages.length) return;
        page = Math.max(0, Math.min(pages.length - 1, n));
        const p = pages[page];
        info.textContent = `${page + 1} / ${pages.length}`;
        info.title = `${p.label}, ${p.width}×${p.height}`;
        img.title = info.title;
        prev.disabled = page === 0;
        next.disabled = page === pages.length - 1;
        for (const [i, b] of hduBlocks.entries()) b.style.background = i === p.hdu ? 'rgba(255,255,255,0.12)' : '';
        if (header.open && hduBlocks[p.hdu]) hduBlocks[p.hdu].scrollIntoView({ block: 'nearest' });
        const mine = ++turn;
        try {
            const d = await fitsPage(url, page, interval.value, stretch.value);
            if (mine === turn) img.src = d.url;
        } catch (err) {
            if (mine === turn) info.textContent = `${page + 1} / ${pages.length}: ${err.message}`;
        }
    };
    prev.onclick = () => show(page - 1);
    next.onclick = () => show(page + 1);
    interval.onchange = () => show(page);
    stretch.onchange = () => show(page);
    header.ontoggle = () => { if (header.open && pages[page] && hduBlocks[pages[page].hdu]) hduBlocks[pages[page].hdu].scrollIntoView({ block: 'nearest' }); };
    root.tabIndex = root.tabIndex >= 0 ? root.tabIndex : 0;
    root.addEventListener('keydown', e => {
        if (e.target.closest && e.target.closest('select, details')) return;
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { show(page + 1); e.preventDefault(); }
        else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { show(page - 1); e.preventDefault(); }
    });
    fitsFile(url).then(file => {
        pages = file.pages;
        file.hdus.forEach((h, i) => {
            const block = document.createElement('div');
            const title = document.createElement('div');
            title.textContent = `HDU ${i}${h.name ? ' ' + h.name : ''}: ${h.kind === 'compressed' ? 'compressed image' : h.kind === 'groups' ? 'random groups' : h.kind}`;
            title.style.cssText = 'font:bold 12px sans-serif;margin:6px 0 2px;color:#9cf;';
            const text = document.createElement('div');
            text.textContent = h.cards.join('\n');
            block.append(title, text);
            hduBlocks.push(block);
            cards.appendChild(block);
        });
        summary.textContent = `Header (${file.hdus.length} HDU${file.hdus.length > 1 ? 's' : ''})`;
        if (pages.length < 2) prev.hidden = next.hidden = info.hidden = true;
        show(0);
    }).catch(err => { info.textContent = err.message; });
    root.append(bar, header);
    return bar;
}

module.exports = {
    isFitsName, isFzName, isFits, isFitsUrl, fitsHdus, fitsPages, planeValues, INTERVALS, STRETCHES, fitsLimits, fitsLevels,
    fitsRgba, rgbaToPng, fitsPage, addFitsControls, riceDecode, hdecompress, plioDecode,
};
