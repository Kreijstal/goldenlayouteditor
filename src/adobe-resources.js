// Big-endian Adobe palette / brush records. All reads stay within their block.
class Reader {
    constructor(bytes) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.pos = 0; }
    need(n) { if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.bytes.length) throw new Error('Truncated Adobe resource.'); }
    skip(n) { this.need(n); this.pos += n; }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    u16() { this.need(2); const n = this.view.getUint16(this.pos); this.pos += 2; return n; }
    i32() { this.need(4); const n = this.view.getInt32(this.pos); this.pos += 4; return n; }
    u32() { this.need(4); const n = this.view.getUint32(this.pos); this.pos += 4; return n; }
    take(n) { this.need(n); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
    text(n) { return new TextDecoder().decode(this.take(n)); }
    unicode() { const n = this.u32(); return new TextDecoder('utf-16be').decode(this.take(n * 2)).replace(/\0+$/, ''); }
}
const clamp = x => Math.max(0, Math.min(1, x));
const signed = x => x >= 32768 ? x - 65536 : x;
function labRgb(l, a, b) {
    const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const f = t => t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27);
    const x50 = f(fx) * 0.96422, y50 = f(fy), z50 = f(fz) * 0.82521;
    const x = 0.9555766*x50 - 0.0230393*y50 + 0.0631636*z50;
    const y = -0.0282895*x50 + 1.0099416*y50 + 0.0210077*z50;
    const z = 0.0122982*x50 - 0.020483*y50 + 1.3299098*z50;
    const gamma = t => t <= 0.0031308 ? 12.92*t : 1.055*t**(1/2.4)-0.055;
    return [gamma(3.2404542*x - 1.5371385*y - 0.4985314*z), gamma(-0.969266*x + 1.8760108*y + 0.041556*z), gamma(0.0556434*x - 0.2040259*y + 1.0572252*z)];
}
function swatchRgb(space, values) {
    const [a, b, c, d] = values;
    if (space === 0) return [a, b, c].map(x => x / 65535);
    if (space === 1) {
        const h = a / 65535 * 6, s = b / 65535, v = c / 65535, f = h % 1;
        const p = v * (1-s), q = v * (1-f*s), t = v * (1-(1-f)*s);
        return [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][Math.floor(h) % 6];
    }
    if (space === 2) return [a, b, c].map(x => x / 65535 * d / 65535);
    if (space === 7) return labRgb(a / 100, signed(b) / 100, signed(c) / 100);
    if (space === 8) return [a, a, a].map(x => x / 10000);
    if (space === 9) return [a, b, c].map(x => (1-x/10000) * (1-d/10000));
    return null;
}
function parseAco(bytes) {
    const r = new Reader(bytes);
    const group = () => {
        const version = r.u16(), count = r.u16();
        if (![1, 2].includes(version)) throw new Error('Not an Adobe ACO version 1/2 palette.');
        const colors = [];
        for (let i = 0; i < count; i++) {
            const space = r.u16(), values = [r.u16(), r.u16(), r.u16(), r.u16()];
            const name = version === 2 ? r.unicode() : `Color ${i + 1}`;
            const rgb = swatchRgb(space, values);
            colors.push({ name, space, values, hex: rgb ? '#' + rgb.map(x => Math.round(clamp(x) * 255).toString(16).padStart(2, '0')).join('') : null });
        }
        return { version, colors };
    };
    let result = group();
    if (result.version === 1 && r.pos < bytes.length) result = group();
    if (r.pos !== bytes.length) throw new Error('Unexpected trailing palette data.');
    return result;
}

function brushPixels(r, width, height, depth, compression) {
    if (width <= 0 || height <= 0 || width * height > 16000000) throw new Error('Brush exceeds the 16 megapixel preview limit or has invalid bounds.');
    if (![8, 16].includes(depth)) throw new Error(`Unsupported ${depth}-bit brush.`);
    const rowSize = width * (depth / 8), total = rowSize * height;
    let raw;
    if (compression === 0) raw = r.take(total);
    else if (compression === 1) {
        const sizes = Array.from({ length: height }, () => r.u16());
        raw = new Uint8Array(total);
        for (let y = 0; y < height; y++) {
            const row = new Reader(r.take(sizes[y])); let at = y * rowSize;
            const end = at + rowSize;
            while (row.pos < row.bytes.length) {
                const n = row.u8();
                if (n === 128) continue;
                const count = n < 128 ? n + 1 : 257 - n;
                if (at + count > end) throw new Error('Brush RLE row exceeds its width.');
                if (n < 128) raw.set(row.take(count), at);
                else raw.fill(row.u8(), at, at + count);
                at += count;
            }
            if (at !== end) throw new Error('Truncated brush RLE row.');
        }
    } else throw new Error(`Unsupported brush compression ${compression}.`);
    const pixels = new Uint8Array(width * height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = depth === 8 ? raw[i] : Math.round(((raw[i*2] << 8) | raw[i*2+1]) / 257);
    return pixels;
}
function sampledBrush(r, name) {
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
    const depth = r.u16(), compression = r.u8(), width = right-left, height = bottom-top;
    return { name, width, height, depth, pixels: brushPixels(r, width, height, depth, compression) };
}
function parseAbr(bytes) {
    const r = new Reader(bytes), version = r.u16(), sub = r.u16(), brushes = [], warnings = [];
    let totalPixels = 0;
    const add = fn => {
        if (brushes.length >= 500) throw new Error('Brush preview is limited to 500 tips.');
        const brush = fn(); totalPixels += brush.width * brush.height;
        if (totalPixels > 64000000) throw new Error('Brush library exceeds the 64 megapixel total preview limit.');
        brushes.push(brush);
    };
    if (version === 1 || version === 2) {
        for (let i = 0; i < sub; i++) {
            const type = r.u16(), data = new Reader(r.take(r.u32()));
            if (type === 2) add(() => {
                data.skip(4); const spacing = data.u16();
                const name = version === 2 ? data.unicode() : `Brush ${i + 1}`;
                data.skip(9); // antialias byte and four short bounds
                return { ...sampledBrush(data, name), spacing };
            });
            else warnings.push(`Brush ${i + 1}: computed / unsupported brush type ${type} has no sampled-tip preview.`);
        }
    } else if (version === 6 && [1, 2].includes(sub)) {
        while (r.pos < bytes.length) {
            if (r.text(4) !== '8BIM') throw new Error('Invalid ABR resource signature.');
            const key = r.text(4), size = r.u32(), data = new Reader(r.take(size));
            if (key === 'samp') while (data.pos < size) {
                const length = data.u32(), sample = new Reader(data.take(length));
                const identity = sample.take(37);
                const name = new TextDecoder().decode(identity.subarray(identity[0] === 36 ? 1 : 0)).replace(/\0/g, '').trim();
                sample.skip(sub === 1 ? 10 : 264);
                add(() => sampledBrush(sample, name || `Brush ${brushes.length + 1}`));
                const pad = (4 - length % 4) % 4;
                if (pad) data.skip(pad);
            }
            const pad = (4 - size % 4) % 4;
            if (pad && r.pos < bytes.length) r.skip(pad);
        }
        warnings.push('Sampled tips only; descriptor-based dynamics, computed brushes and patterns are not rendered.');
    } else throw new Error(`ABR ${version}.${sub} is not supported; sampled versions 1, 2 and 6.1/6.2 are supported.`);
    return { version, subversion: version === 6 ? sub : null, brushes, warnings };
}
module.exports = { Reader, parseAco, parseAbr, brushPixels };
