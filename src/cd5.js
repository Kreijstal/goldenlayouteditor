// Independent CD5 v4 reader. Codec grammar transcribed from Chasys Photo 5.42.01.
// No vendor code or executable is bundled. See docs/cd5-viewer.md.
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_PIXELS = 32 * 1024 * 1024;
function check(ok, message) { if (!ok) throw new Error('CD5: ' + message); }
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
class Reader {
    constructor(bytes) { this.bytes = bytes; this.pos = 0; this.view = view(bytes); }
    need(n) { check(n >= 0 && n <= this.bytes.length - this.pos, 'truncated stream'); }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    u32() { this.need(4); const n = this.view.getUint32(this.pos, true); this.pos += 4; return n; }
    peek32() { this.need(4); return this.view.getUint32(this.pos, true); }
    take(n) { this.need(n); const b = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}
class Bits {
    constructor(bytes, pos = 0) { this.bytes = bytes; this.pos = pos; }
    read(n) {
        check(n >= 1 && n <= 16 && this.pos + n <= this.bytes.length * 8, 'truncated bit stream');
        let value = 0;
        for (let bit = 0; bit < n; bit++, this.pos++) value |= ((this.bytes[this.pos >>> 3] >>> (this.pos & 7)) & 1) << bit;
        return value;
    }
}
function decodeKernel(id, src, capacity, mode = 0) {
    check(capacity > 0 && capacity <= MAX_BYTES, 'excessive kernel output');
    const r = new Reader(src), out = new Uint8Array(capacity); let o = 0;
    const room = n => check(Number.isSafeInteger(n) && n >= 0 && n <= capacity - o, 'kernel output exceeds capacity');
    if (id === 1 || id === 2) {
        while (r.pos < src.length) {
            const b = r.u8(); if (!b) break;
            let n = (b & 127) + 1;
            if (b === 128) n = r.u32();
            if (b < 128 && b === 1 && mode === 0 && r.peek32() < 0x1000000) n = r.u32();
            room(n);
            if (b < 128) { out.set(r.take(n), o); o += n; }
            else if (id === 1) { out.fill(r.u8(), o, o + n); o += n; }
            else {
                check(n > 0, 'zero gradient run');
                let v = r.u8(); out[o++] = v;
                const deltas = r.take(n >>> 1);
                for (let j = 0; j < n - 1; j++) { v = (v + ((deltas[j >>> 1] >>> ((j & 1) * 4)) & 15) - 7) & 255; out[o++] = v; }
            }
        }
    } else if (id === 8) {
        while (r.pos < src.length) {
            const b = r.u8(); if (!b) break;
            if (b < 128) { room(b); out.set(r.take(b), o); o += b; }
            else {
                let n = (b >>> 3) & 7, offset = b & 7, ns = 3, os = 3;
                if (b & 64) {
                    let e;
                    do {
                        e = r.u8();
                        check(ns <= 30 && os <= 28, 'LZ extension overflow');
                        n += ((e >>> 4) & 7) * 2 ** ns; offset += (e & 15) * 2 ** os;
                        ns += 3; os += 4;
                    } while (e & 128);
                }
                n += 2; room(n);
                const distance = offset + n;
                check(distance <= o, 'LZ reference before output');
                out.set(out.subarray(o - distance, o - distance + n), o); o += n;
            }
        }
    } else if (id === 7) {
        const fill = r.u8(), size = r.u32(); room(size);
        while (o < size) {
            const mask = r.u8();
            for (let bit = 0; bit < 8 && o < size; bit++) out[o++] = mask & (1 << bit) ? r.u8() : fill;
        }
    } else if (id === 6) {
        const table = r.take(256), size = r.u32(), group = r.u8() + 1; room(size);
        const bits = new Bits(src, 261 * 8);
        while (o < size) {
            const width = bits.read(3) + 1;
            for (let j = 0; j < group && o < size; j++) out[o++] = table[bits.read(width)];
        }
    } else { throw new Error(`CD5: unsupported compression kernel ${id}`); }
    return out.subarray(0, o);
}
function decodeBand(bytes) {
    check(bytes.length >= 32, 'short band header');
    const v = view(bytes), encoded = v.getUint32(4, true), size = v.getUint32(8, true);
    check(encoded === bytes.length - 32 && size > 0 && size <= MAX_BYTES - 65536, 'invalid band sizes');
    const cap = Math.ceil(size / 4) * 4 + 65536;
    let data = bytes.subarray(32);
    for (let i = 31; i >= 16; i--) {
        const id = bytes[i]; if (!id) continue;
        data = decodeKernel(id, data, cap);
    }
    check(data.length >= size && data.length <= size + 3, `band decoded to ${data.length} bytes, expected ${size} (up to 3 padding bytes)`);
    return { bytes: data.subarray(0, size), last: (v.getUint32(12, true) & 1) !== 0 };
}
function parseCd5(bytes) {
    check(bytes instanceof Uint8Array && bytes.length >= 32 && bytes.length <= MAX_BYTES, 'invalid file size');
    const r = new Reader(bytes);
    check(r.u32() === 0x3544435f && r.u32() === 32, 'invalid magic or header size');
    const version = r.u32(), revision = r.u32(), declaredLayers = r.u32(); r.take(12);
    check((version >>> 16) === 4 && (version & 65535) <= 11, 'only CD5 versions 4.0–4.11 are supported');
    check([1, 2, 3, 4].includes(revision & 255), 'unsupported encoding mode (or encrypted document)');
    const layers = [], previewBands = []; let current = null, creator = '', attributes = null, end = false;
    while (r.pos < bytes.length) {
        const tag = r.u32(), length = r.u32(), data = r.take(length), v = view(data);
        if (tag === 254) creator = new TextDecoder().decode(data).replace(/\0.*$/, '').trim();
        else if (tag === 3) attributes = data;
        else if (tag === 1) {
            check(length === 128 && layers.length < 1024, 'invalid layer descriptor');
            current = {
                x:v.getInt32(8,true), y:v.getInt32(12,true), width:v.getUint32(16,true), height:v.getUint32(20,true),
                profile:data[24], channels:data[25], relation:data[26], group:data[27],
                pixelSize:v.getUint32(32,true), metadataSize:v.getUint32(36,true), options:v.getUint32(40,true),
                name:new TextDecoder('utf-16le').decode(data.subarray(64,128)).replace(/\0.*$/, ''), bands:[],
            };
            check(current.width > 0 && current.height > 0 && current.width * current.height <= MAX_PIXELS, 'excessive layer dimensions');
            check(current.pixelSize + current.metadataSize <= MAX_BYTES, 'excessive layer data');
            layers.push(current);
        } else if (tag === 2) { (current ? current.bands : previewBands).push(data); }
        else if (tag === 255) { check(length === 0 && r.pos === bytes.length, 'invalid terminator or trailing bytes'); end = true; break; }
    }
    check(end && layers.length > 0 && declaredLayers === layers.length, 'missing terminator or layer-count mismatch');
    return { version:`${version >>> 16}.${version & 65535}`, revision, creator, attributes, previewBands, layers };
}
function decodeLayer(layer) {
    const data = new Uint8Array(layer.pixelSize + layer.metadataSize); let pos = 0;
    for (let i = 0; i < layer.bands.length; i++) {
        const decoded = decodeBand(layer.bands[i]);
        check(decoded.bytes.length <= data.length - pos, 'band exceeds layer data size');
        check(decoded.last === (i === layer.bands.length - 1), 'invalid last-band flag');
        data.set(decoded.bytes, pos); pos += decoded.bytes.length;
    }
    check(pos === data.length, 'incomplete layer');
    return { pixels:data.subarray(0,layer.pixelSize), metadata:data.subarray(layer.pixelSize) };
}
function layerRgba(layer, pixels) {
    const n = layer.width * layer.height, rgba = new Uint8ClampedArray(n * 4), c = layer.channels;
    let pos = 0;
    const pixel = (i,b,g,r,a) => { rgba[i*4]=r; rgba[i*4+1]=g; rgba[i*4+2]=b; rgba[i*4+3]=a; };
    if (layer.profile === 0) {
        check(c === 3 || c === 4, 'unsupported colour channel count'); check(pixels.length === n*c, 'invalid planar colour length');
        for (let i=0;i<n;i++) pixel(i,pixels[i],pixels[n+i],pixels[2*n+i],c===4?pixels[3*n+i]:255);
    } else if (layer.profile === 1) {
        check(c === 1 || c === 2, 'unsupported grayscale channel count'); check(pixels.length === n*c, 'invalid grayscale length');
        for (let i=0;i<n;i++) pixel(i,pixels[i],pixels[i],pixels[i],c===2?pixels[n+i]:255);
    } else if (layer.profile === 2 || layer.profile === 3) {
        let count = 256, bits;
        if (layer.profile === 3) { const header=view(pixels).getUint32(0,true); bits=(header&15)+1; count=((header>>>4)&65535)+1; pos=4; }
        check(count <= 256 && pixels.length >= pos+count*4, 'invalid palette');
        const palette=pixels.subarray(pos,pos+count*4); pos+=count*4;
        const br = layer.profile === 3 ? new Bits(pixels,pos*8) : null;
        for (let i=0;i<n;i++) { const index=br?br.read(bits):pixels[pos++]; check(index<count,'palette index outside table'); const k=index*4;pixel(i,palette[k],palette[k+1],palette[k+2],palette[k+3]); }
        check(br?Math.ceil(br.pos/8)===pixels.length:pos===pixels.length,'invalid indexed pixel length');
    } else if (layer.profile === 4) {
        check(pixels.length===4,'invalid solid colour length'); for(let i=0;i<n;i++) pixel(i,...pixels);
    } else if (layer.profile === 5) {
        check(c === 3 || c === 4, 'unsupported decorrelated channel count'); check(pixels.length === n*c, 'invalid decorrelated colour length');
        for(let i=0;i<n;i++) { const g=pixels[i];pixel(i,(g+pixels[n+i]-128)&255,g,(g+pixels[2*n+i]-128)&255,c===4?pixels[3*n+i]:255); }
    } else { throw new Error(`CD5: unsupported colour profile ${layer.profile}`); }
    return rgba;
}
module.exports = { parseCd5, decodeBand, decodeKernel, decodeLayer, layerRgba };
