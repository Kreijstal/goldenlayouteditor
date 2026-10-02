// Capstone (6.0.0-Alpha11, built to WebAssembly from source with the system
// emscripten by ~/git/capstone-wasm/build.sh, @kreijstal/capstone-wasm on jsDelivr) behind a
// small JS API. The C side (cswasm.c there) writes packed instruction records;
// this reads them. Used by the ELF viewer's worker (and by tests under node).
//
//   const cs = await loadCapstone(createCapstone);
//   const h = cs.open('X86', ['MODE_64']);
//   for (const insn of h.disasm(bytes, address, maxInsns, skip)) ...

const CODE_CHUNK = 1 << 16;
const OUT_CAP = 1 << 20;

export async function loadCapstone(factory, opts = {}) {
    const m = await factory(opts);
    const strBuf = m._malloc(128);
    const constCache = new Map();
    function constant(name) {
        if (constCache.has(name)) return constCache.get(name);
        m.stringToUTF8(name, strBuf, 128);
        const v = Number(m._csw_const(strBuf));
        if (v === -1) throw new Error('Unknown Capstone constant ' + name);
        constCache.set(name, v);
        return v;
    }
    const v = m._csw_version();
    return {
        version: `${v >> 8}.${v & 255}`,
        constant,
        supports: (arch) => !!m._csw_support(constant('CS_ARCH_' + arch)),
        open(arch, modes = []) { return new Handle(m, constant, arch, modes); },
    };
}

class Handle {
    constructor(m, constant, arch, modes) {
        this.m = m;
        this.constant = constant;
        const mode = this._mode(modes);
        const h = m._csw_open(constant('CS_ARCH_' + arch), mode);
        if (h < 0) {
            const err = -(h + 1000);
            throw new Error(`Capstone cannot open ${arch} (${modes.join('+') || 'default'}): ${m.UTF8ToString(m._csw_strerror(err))}`);
        }
        this.h = h;
        this.code = m._malloc(CODE_CHUNK);
        this.out = m._malloc(OUT_CAP);
        this.res = m._malloc(8);
        this.currentMode = mode;
    }

    _mode(modes) {
        let mode = 0;
        for (const n of modes) mode = (mode | this.constant('CS_MODE_' + n)) >>> 0;
        return mode >>> 0;
    }

    // Note: Capstone 6's ARM module ORs CS_OPT_MODE into the handle's mode, so Thumb cannot be switched
    // back to ARM this way; the engine keeps a handle per mode instead.
    setModes(modes) {
        const mode = this._mode(modes);
        if (mode === this.currentMode) return;
        this.m._csw_option(this.h, this.constant('CS_OPT_MODE'), mode);
        this.currentMode = mode;
    }

    setOption(name, value) {
        this.m._csw_option(this.h, this.constant('CS_OPT_' + name), this.constant('CS_OPT_' + value));
    }

    // Disassembles bytes (a Uint8Array) as if loaded at address (a BigInt or a Number), at most
    // maxInsns instructions; undecodable bytes come back as { bad: true, size: skip }.
    // Returns an array of { address (a Number; inexact above 2^53), size, flags, mnemonic, opStr, bad }.
    disasm(bytes, address, maxInsns = Infinity, skip = 1) {
        const out = [];
        this.each(bytes, address, maxInsns, skip, (offset, size, flags, mnemonic, opStr, addrLo, addrHi) => {
            out.push({ address: addrHi * 4294967296 + addrLo, offset, size, flags, mnemonic, opStr, bad: (flags & 128) !== 0 });
        });
        return out;
    }

    // The same without building records: cb(offset in bytes, size, flags, mnemonic, opStr, addrLo, addrHi)
    // for each instruction. Returns the number of instructions.
    each(bytes, address, maxInsns, skip, cb) {
        const m = this.m;
        let total = 0;
        let addr = BigInt(address);
        let pos = 0;
        while (pos < bytes.length && total < maxInsns) {
            const n = Math.min(CODE_CHUNK, bytes.length - pos);
            m.HEAPU8.set(bytes.subarray(pos, pos + n), this.code);
            const want = Math.min(maxInsns - total, 0x7fffffff);
            const lo = Number(addr & 0xffffffffn) >>> 0, hi = Number((addr >> 32n) & 0xffffffffn) >>> 0;
            const used = m._csw_disasm(this.h, this.code, n, lo, hi, want, skip, this.out, OUT_CAP, this.res);
            const heap = m.HEAPU8;
            const count = m.HEAPU32[this.res >> 2], consumed = m.HEAPU32[(this.res >> 2) + 1];
            let o = this.out;
            const end = this.out + used;
            let off = pos;
            for (let i = 0; i < count && o < end; i++) {
                const alo = (heap[o] | heap[o + 1] << 8 | heap[o + 2] << 16 | heap[o + 3] << 24) >>> 0;
                const ahi = (heap[o + 4] | heap[o + 5] << 8 | heap[o + 6] << 16 | heap[o + 7] << 24) >>> 0;
                const size = heap[o + 8] | heap[o + 9] << 8, flags = heap[o + 10], ml = heap[o + 11], ol = heap[o + 12];
                o += 13;
                const mnemonic = ascii(heap, o, ml); o += ml;
                const opStr = ascii(heap, o, ol); o += ol;
                cb(off, size, flags, mnemonic, opStr, alo, ahi);
                off += size;
                total++;
            }
            if (!consumed) break;
            pos += consumed;
            addr += BigInt(consumed);
        }
        return total;
    }

    close() {
        const m = this.m;
        m._csw_close(this.h);
        m._free(this.code); m._free(this.out); m._free(this.res);
    }
}

function ascii(heap, o, n) {
    return n ? String.fromCharCode.apply(null, heap.subarray(o, o + n)) : '';
}

export const FLAG = { JUMP: 1, CALL: 2, RET: 4, INT: 8, IRET: 16, PRIV: 32, REL: 64, BAD: 128 };
