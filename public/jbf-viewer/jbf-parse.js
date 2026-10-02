// Reader for Jasc browser thumbnail caches (pspbrwse.jbf), written by the file
// browser of Paint Shop Pro 3+ and Animation Shop. A port of jbfinspect
// (https://github.com/0x09/jbfinspect, public domain): the same steps, checks
// and error messages, so the entries listed here are the ones it lists.
// No DOM: runs in the browser (jbf-viewer.js) and in Node.
//
// 1024 byte header: "JASC BROWS FILE", version (2 BE uint16), image count,
// 256 byte path, 32 byte volume label, then padding. Then one entry per image:
// v1.x (PSP 3-5): name, [v1.0-1.1: reversed extension], width, height, depth,
//   file size, UNIX time, index, BITMAPINFOHEADER and an 8-bit RLE bitmap with
//   an implicit palette; v1.0-1.1 and v1.3 use different RLE schemes.
// v2.x (PSP 6+): name, FILETIME, type code, width, height, depth, an unknown
//   (~ w*h*channels), file size, then a 12 byte signature and a JFIF thumbnail,
//   or a single zero word when the entry has no thumbnail.

const MAGIC = 'JASC BROWS FILE';
const HEADER_SIZE = 1024;
const BMP_HEADER_SIZE = 14 + 40 + 1024;

// Implicit palette of v1 thumbnails (B, G, R per entry; jbfinspect's table)
const PALETTE_HEX =
    '000000ffffff0000ff00fe00fe000000ffffff00ffffff000f0f0f1717171f1f1f2727273838384040404848484f4f4f' +
    '606060686868707070808080979797a0a0a0b0b0b0b8b8b8bfbfbfc8c8c8d9d9d9e0e0e0e8e8e8f0f0f00000c0060617' +
    '0605270b0b400f0f501717681717801b1b98201fa02423b82827c82b2be02f2ff14040ff5050fe6060ff6f70ff7f80ff' +
    '9898ffa0a0ffb0b0ffc0c0fed0d0ffe0e0fff0f0ff00c0000517060527060b400a0f500f176717177f171b971b20a01f' +
    '24b72427c8272be02c2ff03040ff4050ff5060ff6070ff7080ff8098ff98a0ff9fb0ffb0c0fec0d1fed0e1ffe0f0fff0' +
    'c000001706062806053f0b0a4f0e0f681717801717981b1ca02020b82423c82827e02b2bf02f2fff4040ff5050ff5f60' +
    'ff706fff8080fe9797ffa09fffafb0ffc0c0ffd0d0fee0e0fff0f000c1c00617170527280b40400f504f176768178080' +
    '1b98971fa0a024b8b827c8c82be0e130f0f03fffff50ffff60fffe6fffff80ffff98ffffa0feffb1fefec0ffffd0ffff' +
    'e0fffef0ffffc000c01705172705273f0a40500f506817687f1780981b989f1fa0b823b8c827c9e12be0f12ff0fe40ff' +
    'fe50ffff5fffff70ffff7fffff98feffa0feffb0ffffc0fffecfffffdffffff0ffc0c00027270640400a504f0f686818' +
    '80801798981ba0a01fb8b823c8c827dfe02cf0f030ffff40ffff4fffff60feff70feff80feff97ffffa0ffffafffffc1' +
    'ffffcffffff1050f170517270a1f400f27501738671740801b48981f50a02360b82868c82b70e02f80f04088f85098f4' +
    '6097f470a0f880b0f898b8f8a0bef9b1c8fac0d9ffd0e0ffe0e8fff0f0ff0f17281723401f2f4f28406730487f385498' +
    '40609f486cb85080c85c84d96897e0739cdf80a8e497b7e898c0e9a4ccefb0d8efbce4f8c8f0f9d4f8f8e1f4fff0f7ff' +
    '7f5050885f5f976868986f70a08080b08888be9897c89898d9a0a0e0b0b0e8b8b84f805060875f68986770986f80a07f' +
    '87b08898be9898c8989fd8a0b0e1b0b8e8b8f07f0080f000f0007f00f0780080f18000f03700c18090a8486860607888';let _palette = null;
function palette() {
    if (_palette) return _palette;
    _palette = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
        for (let c = 0; c < 3; c++) _palette[i * 4 + c] = parseInt(PALETTE_HEX.substr(i * 6 + c * 2, 2), 16);
    }
    return _palette;
}

// File types as Paint Shop Pro reports them (v2 type codes)
const TYPE_NAMES = {
    0x00: 'none', 0x01: 'bmp', 0x02: 'unknown', 0x03: 'clp', 0x04: 'cut', 0x05: 'dcx', 0x06: 'dib', 0x07: 'emf',
    0x08: 'eps', 0x09: 'fpx', 0x0a: 'gif', 0x0b: 'iff', 0x0c: 'img', 0x0e: 'cgm', 0x0f: 'pic', 0x10: 'unknown',
    0x11: 'jpeg', 0x12: 'kdc', 0x13: 'lbm', 0x14: 'mac', 0x15: 'msp', 0x16: 'pbm', 0x17: 'pcd', 0x18: 'pcx',
    0x19: 'pgm', 0x1a: 'pic', 0x1b: 'pct', 0x1c: 'png', 0x1d: 'ppm', 0x1e: 'psd', 0x1f: 'psp', 0x20: 'ras',
    0x21: 'rle', 0x22: 'sct', 0x23: 'targa', 0x24: 'tiff', 0x25: 'wmf', 0x26: 'wpg', 0x27: 'rgb', 0x28: 'afx',
    0x29: 'brk', 0x2a: 'cal', 0x2b: 'cur', 0x2c: 'dgn', 0x2d: 'dwg', 0x2e: 'ico', 0x2f: 'jp2', 0x30: 'kfx',
    0x31: 'lv', 0x32: 'ncr', 0x33: 'pdf', 0x34: 'svg', 0x35: 'txt', 0x36: 'wbmp', 0x37: 'xbm', 0x38: 'xpm',
    0x39: 'xwd', 0x3a: 'psp', 0x64: 'avi', 0x67: 'raw', 0x68: 'flc', 0x69: 'fli', 0x6a: 'mng', 0x6d: 'ani',
    0x1f4: 'cdr', 0x1f5: 'unknown', 0x1f6: 'drw', 0x1f7: 'dxf', 0x1f8: 'gem', 0x1f9: 'hgl', 0x1fa: 'unknown',
    0x1fb: 'wpg', 0x1fc: 'cmx',
};

export function typeName(code) {
    if (Object.prototype.hasOwnProperty.call(TYPE_NAMES, code)) return TYPE_NAMES[code];
    return ('0x' + code.toString(16).padStart(4, '0')).slice(0, 6); // snprintf(7, "%#06x")
}

// The Paint Shop Pro version that writes a JBF version
export function pspVersion(major, minor) {
    if (major === 1) return ({ 0: '3', 1: '4', 3: '5' })[minor] || '???';
    if (major === 2 && (minor === 0 || minor === 1)) return '6+';
    return '???';
}

export class JbfError extends Error {}

const latin = typeof TextDecoder !== 'undefined' ? new TextDecoder('windows-1252') : null;
// A C string: up to the first NUL, in the Windows ANSI code page
function cString(bytes) {
    const end = bytes.indexOf(0);
    return latin.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

const hex = n => n.toString(16); // offsets as jbfinspect prints them (+%lx)
const hex8 = n => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

// Reads like jbfinspect's stdio: a seek may go past the end, a read there fails
class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = 0;
    }
    get length() { return this.bytes.length; }
    need(n) {
        if (this.pos + n > this.length) {
            this.pos = Math.max(this.pos, this.length);
            throw new JbfError(`+${hex(this.pos)}: Unexpected EOF.`);
        }
    }
    take(n) { this.need(n); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    u16be() { this.need(2); const v = this.view.getUint16(this.pos, false); this.pos += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    u64() { this.need(8); const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return v; }
    skip(n) { this.pos += n; }
}

// The thumbnail of a v1 entry as a BMP file, as jbfinspect -d writes it:
// the stored BITMAPINFOHEADER, the implicit palette and the decoded pixels
function v1Bitmap(info, pixels, bitmapSize) {
    const out = new Uint8Array(BMP_HEADER_SIZE + pixels.length);
    const dv = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4d;
    dv.setUint32(2, BMP_HEADER_SIZE + bitmapSize, true);
    dv.setUint32(10, BMP_HEADER_SIZE, true);
    out.set(info, 14);
    out.set(palette(), 54);
    out.set(pixels, BMP_HEADER_SIZE);
    return out;
}

function bitmapInfo(b) {
    const dv = new DataView(b.buffer, b.byteOffset, 40);
    return {
        width: dv.getInt32(4, true), height: dv.getInt32(8, true), planes: dv.getUint16(12, true),
        bitCount: dv.getUint16(14, true), compression: dv.getUint32(16, true), sizeImage: dv.getUint32(20, true),
    };
}

// Parse a whole .jbf. Never throws on bad data: what could be read comes back,
// with `error` set to why reading stopped (jbfinspect's message), and
// `warnings` for entries it reads past (broken v1.3 bitmaps, cut-off thumbnails).
export function parseJbf(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const r = new Reader(bytes);
    const jbf = { size: bytes.length, version: null, psp: '', count: 0, path: '', volume: '', entries: [], warnings: [], error: null };
    try {
        r.need(MAGIC.length);
        if (latin.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) {
            throw new JbfError('Not a valid JBF (no "JASC BROWS FILE" signature).');
        }
        r.skip(MAGIC.length);
        const major = r.u16be(), minor = r.u16be();
        jbf.version = { major, minor, string: `${major}.${minor}` };
        jbf.psp = pspVersion(major, minor);
        jbf.count = r.u32();
        jbf.path = cString(r.take(256).subarray(0, 255));
        jbf.volume = cString(r.take(32).subarray(0, 31));
        r.skip(HEADER_SIZE - r.pos);
        if (major !== 1 && major !== 2) throw new JbfError(`unknown version (${major}.${minor})`);
        readEntries(r, jbf, major, minor);
        if (r.pos < r.length) throw new JbfError(`+${hex(r.pos)}: More data in file than expected.`);
    } catch (err) {
        if (!(err instanceof JbfError)) throw err;
        jbf.error = err.message;
    }
    return jbf;
}

function readEntries(r, jbf, major, minor) {
    for (let i = 0; i < jbf.count; i++) {
        const entry = { index: i, offset: r.pos };
        let nameLen;
        if (major === 1 && minor === 0) nameLen = 13;
        else nameLen = r.u32();
        if (nameLen > 255) throw new JbfError(`+${hex(r.pos - 4)}: Filename too long for image #${i} (${nameLen})`);
        entry.name = cString(r.take(nameLen));

        if (major > 1) {
            entry.filetime = r.u64();
            entry.mtime = Number(BigInt.asIntN(64, entry.filetime / 10000000n - 11644473600n));
            entry.typeCode = r.u32();
            entry.type = typeName(entry.typeCode);
        } else if (minor < 3) { // 1.3 has no type code
            const ext = r.take(4);
            entry.fourcc = latin.decode(ext);
            entry.type = cString(Uint8Array.of(ext[2], ext[1], ext[0], 0));
        } else {
            entry.type = '';
        }
        entry.width = r.u32();
        entry.height = r.u32();
        entry.depth = r.u32();
        if (major === 2) entry.pels = r.u32(); // roughly width * height * channels; purpose unknown
        entry.filesize = r.u32();
        if (major === 1) entry.mtime = r.u32();
        // Entries without a thumbnail have a zero word in place of the signature
        const thumbWord = major === 2 ? r.u32() : 1;
        entry.hasThumb = thumbWord !== 0;
        jbf.entries.push(entry);
        if (!entry.hasThumb) continue;

        if (major === 2) {
            const sig = [thumbWord, r.u32(), r.u32()];
            if (sig[0] !== 2 || sig[1] !== 1 || sig[2] !== 0xffffffff) {
                throw new JbfError(`+${hex(r.pos - 3)}: Wrong signature (${sig.map(hex8).join(' ')}); parse integrity lost.`);
            }
            const length = r.u32();
            const start = r.pos;
            const data = r.bytes.subarray(start, Math.min(start + length, r.length));
            entry.thumb = { mime: 'image/jpeg', ext: 'jpg', format: 'JFIF', bytes: data, length };
            if (data.length < length) {
                entry.thumb.truncated = true;
                jbf.warnings.push(`${entry.name}: thumbnail cut off (${data.length} of ${length} bytes)`);
            }
            r.skip(length);
        } else if (!readV1Bitmap(r, jbf, entry, minor)) {
            break;
        }
    }
}

// The RLE bitmap of a v1 entry; false when the end of the file stops the listing
function readV1Bitmap(r, jbf, entry, minor) {
    const i = entry.index;
    entry.imageIndex = r.u32();
    if (entry.imageIndex !== i) throw new JbfError(`+${hex(r.pos - 4)}: imgindex (${entry.imageIndex}) != i (${i}).`);
    const infoStart = r.pos;
    r.skip(20);
    const bitmapSize = r.u32();
    r.skip(16);
    const info = new Uint8Array(40); // zero-filled when the file ends inside it (reading the bitmap then fails)
    info.set(r.bytes.subarray(infoStart, Math.min(infoStart + 40, r.length)));
    entry.bitmap = bitmapInfo(info);
    const pixels = [];
    let count = 0;
    let stop = false;
    if (minor < 3) {
        // byte > 0xC0 ? [runlength + 0xC0], [color] : [color]
        while (count < bitmapSize) {
            const token = r.u8();
            if (token > 0xc0) {
                const run = token & 0x3f, color = r.u8();
                count += run;
                for (let k = 0; k < run; k++) pixels.push(color);
            } else {
                count++;
                pixels.push(token);
            }
        }
        if (count !== bitmapSize) throw new JbfError(`+${hex(r.pos)}: count (${count}) != bitmapsize (${bitmapSize})`);
    } else {
        // byte > 0x80 ? [runlength + 0x80], [color] : [length], [colors]...
        const oldPos = r.pos;
        while (count < bitmapSize) {
            const token = r.u8();
            if (token > 0x80) {
                const run = token & 0x7f, color = r.u8();
                count += run;
                for (let k = 0; k < run; k++) pixels.push(color);
            } else {
                count += token;
                const raw = r.bytes.subarray(r.pos, Math.min(r.pos + token, r.length));
                for (let k = 0; k < raw.length; k++) pixels.push(raw[k]);
                r.skip(token);
            }
        }
        // Some v1.3 files have broken (wrong length) RLE runs, which loses the
        // place of the next entry. jbfinspect finds it again by the next three
        // zero bytes: they never occur in the RLE, and an entry starts with a
        // name length below 256 (NN 00 00 00).
        let broken = count !== bitmapSize;
        if (!broken) {
            if (r.pos + 4 > r.length) {
                stop = true;
            } else {
                const b = r.bytes;
                const s = (x) => (x << 24) >> 24; // char is signed
                if (s(b[r.pos + 1]) + s(b[r.pos + 2]) + s(b[r.pos + 3]) !== 0) broken = true;
            }
        }
        if (broken) {
            entry.broken = true;
            jbf.warnings.push(`+${hex(Math.min(r.pos, r.length))}: Broken v1 bitmap: got ${count}, bitmapsize ${bitmapSize} (${entry.name})`);
            r.pos = oldPos;
            let zeroRun = 0;
            while (zeroRun < 3 && r.pos < r.length) zeroRun = r.bytes[r.pos++] === 0 ? zeroRun + 1 : 0;
            if (zeroRun < 3) stop = true;
            else r.pos -= 4;
        }
    }
    if (pixels.length < bitmapSize && !entry.broken) {
        entry.truncatedBitmap = true;
        jbf.warnings.push(`${entry.name}: thumbnail cut off (${pixels.length} of ${bitmapSize} pixels)`);
    }
    const data = v1Bitmap(info, Uint8Array.from(pixels), bitmapSize);
    entry.thumb = { mime: 'image/bmp', ext: 'bmp', format: `RLE ${minor < 3 ? 'v1.0' : 'v1.3'} (8-bit, implicit palette)`, bytes: data, length: data.length };
    if (stop) r.pos = r.length;
    return !stop;
}
