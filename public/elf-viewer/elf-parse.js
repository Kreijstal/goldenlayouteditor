// ELF parsing in plain JS: ELF32/ELF64, little and big endian. Header, section
// headers, program headers, symbol tables (.symtab, .dynsym), relocations
// (.rel*, .rela*), the dynamic section, notes and ARM build attributes.
// No DOM; used by the ELF viewer's page and its worker (and tests under node).
//
// Addresses are BigInts while parsing; parseElf() then picks a bias (0 unless
// addresses exceed 2^53, as in 64-bit kernels) and gives every address also as
// a Number relative to it (`addr`), which is what the rest of the viewer uses.

export const ET_NAMES = { 0: 'NONE', 1: 'REL (relocatable object)', 2: 'EXEC (executable)', 3: 'DYN (shared object / PIE)', 4: 'CORE (core dump)' };

export const EM_NAMES = {
    0: 'None', 1: 'AT&T WE 32100', 2: 'SPARC', 3: 'Intel 80386', 4: 'Motorola 68000', 5: 'Motorola 88000', 6: 'Intel MCU',
    7: 'Intel 80860', 8: 'MIPS', 9: 'IBM System/370', 10: 'MIPS RS3000 LE', 15: 'HP PA-RISC', 18: 'SPARC32PLUS', 20: 'PowerPC',
    21: 'PowerPC64', 22: 'IBM S/390', 23: 'Cell SPU', 36: 'NEC V800', 38: 'Fujitsu FR20', 39: 'TRW RH-32', 40: 'ARM', 41: 'DEC Alpha (old)',
    42: 'Hitachi SH', 43: 'SPARC v9', 44: 'Siemens TriCore', 45: 'Argonaut RISC Core', 46: 'Hitachi H8/300', 50: 'Intel IA-64',
    51: 'Stanford MIPS-X', 52: 'Motorola ColdFire', 53: 'Motorola M68HC12', 62: 'AMD x86-64', 66: 'Siemens FX66', 67: 'ST9+',
    68: 'ST7', 69: 'Motorola MC68HC16', 70: 'Motorola MC68HC11', 71: 'Motorola MC68HC08', 72: 'Motorola MC68HC05', 75: 'DEC VAX',
    76: 'Axis CRIS', 83: 'Atmel AVR', 84: 'Fujitsu FR30', 85: 'Mitsubishi D10V', 86: 'Mitsubishi D30V', 87: 'NEC v850',
    88: 'Mitsubishi M32R', 89: 'Matsushita MN10300', 90: 'Matsushita MN10200', 92: 'OpenRISC', 93: 'ARC Compact',
    94: 'Tensilica Xtensa', 105: 'TI MSP430', 106: 'Analog Devices Blackfin', 113: 'Altera Nios II', 140: 'TI TMS320C6000',
    164: 'Qualcomm Hexagon', 183: 'AArch64', 186: 'STM8', 188: 'Tilera TILEPro', 189: 'Xilinx MicroBlaze', 190: 'NVIDIA CUDA',
    191: 'Tilera TILE-Gx', 195: 'ARC Compact2 (ARCv2)', 203: 'XMOS xCORE', 220: 'Zilog Z80', 224: 'AMD GPU', 243: 'RISC-V',
    247: 'Linux BPF', 252: 'C-SKY', 258: 'LoongArch', 0x9026: 'DEC Alpha', 0x9080: 'Cygnus v850',
};

export const OSABI_NAMES = { 0: 'UNIX System V', 1: 'HP-UX', 2: 'NetBSD', 3: 'GNU/Linux', 6: 'Solaris', 7: 'AIX', 8: 'IRIX', 9: 'FreeBSD',
    10: 'Tru64', 11: 'Novell Modesto', 12: 'OpenBSD', 13: 'OpenVMS', 64: 'ARM EABI', 97: 'ARM', 255: 'Standalone' };

export const SHT_NAMES = {
    0: 'NULL', 1: 'PROGBITS', 2: 'SYMTAB', 3: 'STRTAB', 4: 'RELA', 5: 'HASH', 6: 'DYNAMIC', 7: 'NOTE', 8: 'NOBITS', 9: 'REL',
    10: 'SHLIB', 11: 'DYNSYM', 14: 'INIT_ARRAY', 15: 'FINI_ARRAY', 16: 'PREINIT_ARRAY', 17: 'GROUP', 18: 'SYMTAB_SHNDX',
    19: 'RELR', 0x6ffffff5: 'GNU_ATTRIBUTES', 0x6ffffff6: 'GNU_HASH', 0x6ffffff7: 'GNU_LIBLIST', 0x6ffffffd: 'GNU_verdef',
    0x6ffffffe: 'GNU_verneed', 0x6fffffff: 'GNU_versym', 0x6fff4c00: 'LLVM_ODRTAB', 0x6fff4c01: 'LLVM_LINKER_OPTIONS',
    0x6fff4c03: 'LLVM_ADDRSIG', 0x6fff4c04: 'LLVM_DEPENDENT_LIBRARIES', 0x6fff4c05: 'LLVM_SYMPART', 0x6fff4c09: 'LLVM_BB_ADDR_MAP',
    0x70000001: 'PROC_1 (ARM_EXIDX / X86_64_UNWIND / MIPS_…)', 0x70000003: 'ARM_ATTRIBUTES', 0x70000006: 'MIPS_REGINFO',
    0x7000000d: 'MIPS_OPTIONS', 0x7000002a: 'MIPS_ABIFLAGS',
};

export const PT_NAMES = {
    0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 5: 'SHLIB', 6: 'PHDR', 7: 'TLS',
    0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO', 0x6474e553: 'GNU_PROPERTY',
    0x65a3dbe6: 'OPENBSD_RANDOMIZE', 0x70000000: 'PROC_0 (MIPS_REGINFO)', 0x70000001: 'ARM_EXIDX / MIPS_RTPROC', 0x70000003: 'MIPS_ABIFLAGS / RISCV_ATTRIBUTES',
};

export const STT_NAMES = { 0: 'NOTYPE', 1: 'OBJECT', 2: 'FUNC', 3: 'SECTION', 4: 'FILE', 5: 'COMMON', 6: 'TLS', 10: 'IFUNC' };
export const STB_NAMES = { 0: 'LOCAL', 1: 'GLOBAL', 2: 'WEAK', 10: 'UNIQUE' };
export const STV_NAMES = ['DEFAULT', 'INTERNAL', 'HIDDEN', 'PROTECTED'];

export const DT_NAMES = {
    0: 'NULL', 1: 'NEEDED', 2: 'PLTRELSZ', 3: 'PLTGOT', 4: 'HASH', 5: 'STRTAB', 6: 'SYMTAB', 7: 'RELA', 8: 'RELASZ', 9: 'RELAENT',
    10: 'STRSZ', 11: 'SYMENT', 12: 'INIT', 13: 'FINI', 14: 'SONAME', 15: 'RPATH', 16: 'SYMBOLIC', 17: 'REL', 18: 'RELSZ',
    19: 'RELENT', 20: 'PLTREL', 21: 'DEBUG', 22: 'TEXTREL', 23: 'JMPREL', 24: 'BIND_NOW', 25: 'INIT_ARRAY', 26: 'FINI_ARRAY',
    27: 'INIT_ARRAYSZ', 28: 'FINI_ARRAYSZ', 29: 'RUNPATH', 30: 'FLAGS', 32: 'PREINIT_ARRAY', 33: 'PREINIT_ARRAYSZ', 35: 'RELRSZ',
    36: 'RELR', 37: 'RELRENT', 0x6ffffef5: 'GNU_HASH', 0x6ffffff0: 'VERSYM', 0x6ffffff9: 'RELACOUNT', 0x6ffffffa: 'RELCOUNT',
    0x6ffffffb: 'FLAGS_1', 0x6ffffffc: 'VERDEF', 0x6ffffffd: 'VERDEFNUM', 0x6ffffffe: 'VERNEED', 0x6fffffff: 'VERNEEDNUM',
};
const DT_STRING_TAGS = new Set([1, 14, 15, 29]);

// Relocation type names for the common machines (the rest show as numbers)
const R_X86_64 = ['NONE', '64', 'PC32', 'GOT32', 'PLT32', 'COPY', 'GLOB_DAT', 'JUMP_SLOT', 'RELATIVE', 'GOTPCREL', '32', '32S', '16',
    'PC16', '8', 'PC8', 'DTPMOD64', 'DTPOFF64', 'TPOFF64', 'TLSGD', 'TLSLD', 'DTPOFF32', 'GOTTPOFF', 'TPOFF32', 'PC64', 'GOTOFF64',
    'GOTPC32', 'GOT64', 'GOTPCREL64', 'GOTPC64', 'GOTPLT64', 'PLTOFF64', 'SIZE32', 'SIZE64', 'GOTPC32_TLSDESC', 'TLSDESC_CALL',
    'TLSDESC', 'IRELATIVE', 'RELATIVE64', '', '', 'GOTPCRELX', 'REX_GOTPCRELX'];
const R_386 = ['NONE', '32', 'PC32', 'GOT32', 'PLT32', 'COPY', 'GLOB_DAT', 'JMP_SLOT', 'RELATIVE', 'GOTOFF', 'GOTPC', '32PLT'];
R_386[14] = 'TLS_TPOFF'; R_386[35] = 'TLS_DTPMOD32'; R_386[36] = 'TLS_DTPOFF32'; R_386[42] = 'IRELATIVE'; R_386[43] = 'GOT32X';
const R_ARM = { 0: 'NONE', 1: 'PC24', 2: 'ABS32', 3: 'REL32', 10: 'THM_CALL', 17: 'TLS_DTPMOD32', 18: 'TLS_DTPOFF32', 19: 'TLS_TPOFF32',
    20: 'COPY', 21: 'GLOB_DAT', 22: 'JUMP_SLOT', 23: 'RELATIVE', 24: 'GOTOFF32', 25: 'BASE_PREL', 26: 'GOT_BREL', 27: 'PLT32', 28: 'CALL',
    29: 'JUMP24', 30: 'THM_JUMP24', 38: 'TARGET1', 40: 'V4BX', 41: 'TARGET2', 42: 'PREL31', 43: 'MOVW_ABS_NC', 44: 'MOVT_ABS',
    45: 'MOVW_PREL_NC', 46: 'MOVT_PREL', 47: 'THM_MOVW_ABS_NC', 48: 'THM_MOVT_ABS', 51: 'THM_JUMP19', 96: 'GOT_PREL', 102: 'THM_JUMP11',
    103: 'THM_JUMP8', 160: 'IRELATIVE' };
const R_AARCH64 = { 0: 'NONE', 257: 'ABS64', 258: 'ABS32', 259: 'ABS16', 260: 'PREL64', 261: 'PREL32', 262: 'PREL16',
    263: 'MOVW_UABS_G0', 264: 'MOVW_UABS_G0_NC', 265: 'MOVW_UABS_G1', 266: 'MOVW_UABS_G1_NC', 267: 'MOVW_UABS_G2', 268: 'MOVW_UABS_G2_NC',
    269: 'MOVW_UABS_G3', 273: 'LD_PREL_LO19', 274: 'ADR_PREL_LO21', 275: 'ADR_PREL_PG_HI21', 276: 'ADR_PREL_PG_HI21_NC',
    277: 'ADD_ABS_LO12_NC', 278: 'LDST8_ABS_LO12_NC', 279: 'TSTBR14', 280: 'CONDBR19', 282: 'JUMP26', 283: 'CALL26',
    284: 'LDST16_ABS_LO12_NC', 285: 'LDST32_ABS_LO12_NC', 286: 'LDST64_ABS_LO12_NC', 299: 'LDST128_ABS_LO12_NC', 311: 'ADR_GOT_PAGE',
    312: 'LD64_GOT_LO12_NC', 1024: 'COPY', 1025: 'GLOB_DAT', 1026: 'JUMP_SLOT', 1027: 'RELATIVE', 1028: 'TLS_DTPMOD',
    1029: 'TLS_DTPREL', 1030: 'TLS_TPREL', 1031: 'TLSDESC', 1032: 'IRELATIVE' };
const R_RISCV = { 0: 'NONE', 1: '32', 2: '64', 3: 'RELATIVE', 4: 'COPY', 5: 'JUMP_SLOT', 6: 'TLS_DTPMOD32', 7: 'TLS_DTPMOD64',
    8: 'TLS_DTPREL32', 9: 'TLS_DTPREL64', 10: 'TLS_TPREL32', 11: 'TLS_TPREL64', 16: 'BRANCH', 17: 'JAL', 18: 'CALL', 19: 'CALL_PLT',
    20: 'GOT_HI20', 21: 'TLS_GOT_HI20', 22: 'TLS_GD_HI20', 23: 'PCREL_HI20', 24: 'PCREL_LO12_I', 25: 'PCREL_LO12_S', 26: 'HI20',
    27: 'LO12_I', 28: 'LO12_S', 29: 'TPREL_HI20', 30: 'TPREL_LO12_I', 31: 'TPREL_LO12_S', 32: 'TPREL_ADD', 33: 'ADD8', 34: 'ADD16',
    35: 'ADD32', 36: 'ADD64', 37: 'SUB8', 38: 'SUB16', 39: 'SUB32', 40: 'SUB64', 43: 'ALIGN', 44: 'RVC_BRANCH', 45: 'RVC_JUMP',
    51: 'RELAX', 52: 'SUB6', 53: 'SET6', 54: 'SET8', 55: 'SET16', 56: 'SET32', 57: '32_PCREL', 58: 'IRELATIVE', 60: 'SET_ULEB128', 61: 'SUB_ULEB128' };
const R_MIPS = ['NONE', '16', '32', 'REL32', '26', 'HI16', 'LO16', 'GPREL16', 'LITERAL', 'GOT16', 'PC16', 'CALL16', 'GPREL32'];
Object.assign(R_MIPS, { 18: '64', 19: 'GOT_DISP', 20: 'GOT_PAGE', 21: 'GOT_OFST', 22: 'GOT_HI16', 23: 'GOT_LO16', 37: 'JALR', 126: 'COPY', 127: 'JUMP_SLOT' });
const R_PPC = { 0: 'NONE', 1: 'ADDR32', 2: 'ADDR24', 3: 'ADDR16', 4: 'ADDR16_LO', 5: 'ADDR16_HI', 6: 'ADDR16_HA', 10: 'REL24', 11: 'REL14',
    18: 'PLTREL24', 19: 'COPY', 20: 'GLOB_DAT', 21: 'JMP_SLOT', 22: 'RELATIVE', 26: 'REL32', 38: 'ADDR64', 51: 'TOC16', 109: 'REL16', 249: 'REL16_LO', 250: 'REL16_HI', 251: 'REL16_HA' };
const RELOC_NAMES = { 62: ['R_X86_64_', R_X86_64], 3: ['R_386_', R_386], 40: ['R_ARM_', R_ARM], 183: ['R_AARCH64_', R_AARCH64],
    243: ['R_RISCV_', R_RISCV], 8: ['R_MIPS_', R_MIPS], 20: ['R_PPC_', R_PPC], 21: ['R_PPC64_', R_PPC] };

// Relocation types that bind a PLT/GOT slot to an imported function (for naming PLT stubs)
export const JUMP_SLOT_TYPES = { 62: [7, 6], 3: [7, 6], 40: [22, 21], 183: [1026, 1025], 243: [5], 20: [21], 21: [21], 8: [127] };

export function relocTypeName(machine, type) {
    const t = RELOC_NAMES[machine];
    if (t && t[1][type]) return t[0] + t[1][type];
    return 'R_' + type;
}

// Section flags as readelf letters
export function shFlagsString(f) {
    const n = Number(f & 0xffffffffn);
    let s = '';
    if (n & 0x1) s += 'W';
    if (n & 0x2) s += 'A';
    if (n & 0x4) s += 'X';
    if (n & 0x10) s += 'M';
    if (n & 0x20) s += 'S';
    if (n & 0x40) s += 'I';
    if (n & 0x80) s += 'L';
    if (n & 0x100) s += 'O';
    if (n & 0x200) s += 'G';
    if (n & 0x400) s += 'T';
    if (n & 0x800) s += 'C';
    if (n & 0x0ff00000) s += 'o';
    if (n & 0xf0000000) s += 'p';
    return s;
}

export function phFlagsString(f) {
    return (f & 4 ? 'R' : '-') + (f & 2 ? 'W' : '-') + (f & 1 ? 'X' : '-');
}

export function isElf(bytes) {
    return bytes && bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

class Reader {
    constructor(bytes, le, is64) {
        this.b = bytes;
        this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.le = le;
        this.is64 = is64;
    }
    u8(o) { return this.b[o]; }
    u16(o) { return this.dv.getUint16(o, this.le); }
    u32(o) { return this.dv.getUint32(o, this.le); }
    i32(o) { return this.dv.getInt32(o, this.le); }
    u64(o) { return this.dv.getBigUint64(o, this.le); }
    i64(o) { return this.dv.getBigInt64(o, this.le); }
    // address-sized (BigInt)
    addr(o) { return this.is64 ? this.u64(o) : BigInt(this.u32(o)); }
    // address-sized, as a Number (offsets and sizes)
    word(o) { return this.is64 ? Number(this.u64(o)) : this.u32(o); }
    swordB(o) { return this.is64 ? this.i64(o) : BigInt(this.i32(o)); }
    cstr(o, max = 4096) {
        let e = o;
        const lim = Math.min(this.b.length, o + max);
        while (e < lim && this.b[e]) e++;
        return utf8(this.b.subarray(o, e));
    }
}

const _td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;
function utf8(bytes) {
    if (!bytes.length) return '';
    let ascii = true;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) { ascii = false; break; }
    if (ascii) {
        let s = '';
        for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
        return s;
    }
    return _td.decode(bytes);
}

function inFile(bytes, off, size) {
    return off >= 0 && size >= 0 && off + size <= bytes.length;
}

export function parseElf(bytes) {
    if (!isElf(bytes)) throw new Error('Not an ELF file (no \\x7fELF magic)');
    if (bytes.length < 52) throw new Error('Truncated ELF header');
    const cls = bytes[4], data = bytes[5];
    if (cls !== 1 && cls !== 2) throw new Error('Unknown ELF class ' + cls);
    if (data !== 1 && data !== 2) throw new Error('Unknown ELF data encoding ' + data);
    const is64 = cls === 2, le = data === 1;
    const r = new Reader(bytes, le, is64);
    const warnings = [];
    const A = is64 ? 8 : 4;
    const h = {
        class: is64 ? 'ELF64' : 'ELF32', is64, le, endian: le ? 'little' : 'big',
        version: bytes[6], osabi: bytes[7], osabiName: OSABI_NAMES[bytes[7]] || 'unknown', abiversion: bytes[8],
        type: r.u16(16), machine: r.u16(18), eversion: r.u32(20),
        entryB: r.addr(24),
        phoff: r.word(24 + A), shoff: r.word(24 + 2 * A),
    };
    let o = 24 + 3 * A;
    h.flags = r.u32(o); o += 4;
    h.ehsize = r.u16(o); h.phentsize = r.u16(o + 2); h.phnum = r.u16(o + 4);
    h.shentsize = r.u16(o + 6); h.shnum = r.u16(o + 8); h.shstrndx = r.u16(o + 10);
    h.typeName = ET_NAMES[h.type] || (h.type >= 0xfe00 ? 'OS/processor specific 0x' + h.type.toString(16) : 'unknown ' + h.type);
    h.machineName = EM_NAMES[h.machine] || 'unknown (' + h.machine + ')';

    // Extended numbering: counts in section 0
    let shnum = h.shnum, shstrndx = h.shstrndx, phnum = h.phnum;
    const shent = h.shentsize || (is64 ? 64 : 40);
    if (h.shoff && inFile(bytes, h.shoff, shent)) {
        const s0 = h.shoff;
        if (shnum === 0) shnum = r.word(s0 + (is64 ? 32 : 20));
        if (shstrndx === 0xffff) shstrndx = r.u32(s0 + (is64 ? 40 : 24));
        if (phnum === 0xffff) phnum = r.u32(s0 + (is64 ? 44 : 28));
    }

    // --- section headers
    const sections = [];
    if (h.shoff && shnum) {
        if (!inFile(bytes, h.shoff, shnum * shent)) warnings.push('Section header table runs past the end of the file');
        for (let i = 0; i < shnum; i++) {
            const so = h.shoff + i * shent;
            if (!inFile(bytes, so, is64 ? 64 : 40)) break;
            const s = is64 ? {
                nameOff: r.u32(so), type: r.u32(so + 4), flagsB: r.u64(so + 8), addrB: r.u64(so + 16), offset: Number(r.u64(so + 24)),
                size: Number(r.u64(so + 32)), link: r.u32(so + 40), info: r.u32(so + 44), addralign: Number(r.u64(so + 48)), entsize: Number(r.u64(so + 56)),
            } : {
                nameOff: r.u32(so), type: r.u32(so + 4), flagsB: BigInt(r.u32(so + 8)), addrB: BigInt(r.u32(so + 12)), offset: r.u32(so + 16),
                size: r.u32(so + 20), link: r.u32(so + 24), info: r.u32(so + 28), addralign: r.u32(so + 32), entsize: r.u32(so + 36),
            };
            s.index = i;
            s.flags = Number(s.flagsB & 0xffffffffn);
            s.typeName = SHT_NAMES[s.type] || '0x' + s.type.toString(16);
            s.flagsStr = shFlagsString(s.flagsB);
            s.alloc = !!(s.flags & 2);
            s.exec = !!(s.flags & 4);
            s.write = !!(s.flags & 1);
            s.hasData = s.type !== 8 && s.type !== 0 && inFile(bytes, s.offset, s.size);
            sections.push(s);
        }
        const strtab = sections[shstrndx];
        for (const s of sections) {
            s.name = strtab && strtab.hasData && s.nameOff < strtab.size ? r.cstr(strtab.offset + s.nameOff) : (s.index ? `[${s.index}]` : '');
        }
    }

    // --- program headers
    const segments = [];
    const phent = h.phentsize || (is64 ? 56 : 32);
    if (h.phoff && phnum) {
        for (let i = 0; i < phnum; i++) {
            const po = h.phoff + i * phent;
            if (!inFile(bytes, po, is64 ? 56 : 32)) { warnings.push('Program header table runs past the end of the file'); break; }
            const p = is64 ? {
                type: r.u32(po), flags: r.u32(po + 4), offset: Number(r.u64(po + 8)), vaddrB: r.u64(po + 16), paddrB: r.u64(po + 24),
                filesz: Number(r.u64(po + 32)), memsz: Number(r.u64(po + 40)), align: Number(r.u64(po + 48)),
            } : {
                type: r.u32(po), offset: r.u32(po + 4), vaddrB: BigInt(r.u32(po + 8)), paddrB: BigInt(r.u32(po + 12)),
                filesz: r.u32(po + 16), memsz: r.u32(po + 20), flags: r.u32(po + 24), align: r.u32(po + 28),
            };
            p.index = i;
            p.typeName = PT_NAMES[p.type] || '0x' + p.type.toString(16);
            p.flagsStr = phFlagsString(p.flags);
            if (p.type === 3 && inFile(bytes, p.offset, p.filesz)) h.interp = r.cstr(p.offset, p.filesz);
            segments.push(p);
        }
    }

    // --- relocatable objects: every section at address 0; lay the allocated ones out one after
    // the other (as a linker would) so they get distinct addresses
    let synthetic = false;
    if (h.type === 1) {
        const alloc = sections.filter(s => s.alloc && s.size);
        if (alloc.length && alloc.every(s => s.addrB === 0n)) {
            synthetic = true;
            let at = 0n;
            for (const s of alloc) {
                const al = BigInt(Math.max(1, s.addralign || 1));
                at = (at + al - 1n) / al * al;
                s.addrB = at;
                at += BigInt(s.size);
            }
        }
    }

    // --- bias: addresses as Numbers stay exact below 2^53
    let maxAddr = h.entryB, minAddr = null;
    for (const s of sections) if (s.alloc) {
        const end = s.addrB + BigInt(s.size);
        if (end > maxAddr) maxAddr = end;
        if (minAddr === null || s.addrB < minAddr) minAddr = s.addrB;
    }
    for (const p of segments) if (p.type === 1) {
        const end = p.vaddrB + BigInt(p.memsz);
        if (end > maxAddr) maxAddr = end;
        if (minAddr === null || p.vaddrB < minAddr) minAddr = p.vaddrB;
    }
    let bias = 0n;
    if (maxAddr >= (1n << 53n) && minAddr !== null) bias = minAddr & ~0xffffffffn;
    const num = (b) => Number(BigInt.asUintN(64, b - bias));
    h.entry = num(h.entryB);
    for (const s of sections) s.addr = num(s.addrB);
    for (const p of segments) { p.vaddr = num(p.vaddrB); p.paddr = num(p.paddrB); }

    // --- symbols
    const symbols = [];
    const symtabs = sections.filter(s => (s.type === 2 || s.type === 11) && s.hasData);
    const shndxSec = sections.find(s => s.type === 18 && s.hasData);
    for (const st of symtabs) {
        const ent = st.entsize || (is64 ? 24 : 16);
        const strs = sections[st.link];
        const n = Math.floor(st.size / ent);
        const dyn = st.type === 11;
        for (let i = 0; i < n; i++) {
            const so = st.offset + i * ent;
            let nameOff, info, other, shndx, valueB, size;
            if (is64) {
                nameOff = r.u32(so); info = r.u8(so + 4); other = r.u8(so + 5); shndx = r.u16(so + 6); valueB = r.u64(so + 8); size = Number(r.u64(so + 16));
            } else {
                nameOff = r.u32(so); valueB = BigInt(r.u32(so + 4)); size = r.u32(so + 8); info = r.u8(so + 12); other = r.u8(so + 13); shndx = r.u16(so + 14);
            }
            if (shndx === 0xffff && shndxSec && !dyn) shndx = r.u32(shndxSec.offset + i * 4);
            const type = info & 15, bind = info >> 4;
            let name = strs && strs.hasData && nameOff < strs.size ? r.cstr(strs.offset + nameOff) : '';
            const sec = shndx > 0 && shndx < 0xff00 ? sections[shndx] : null;
            if (!name && type === 3 && sec) name = sec.name;
            // relocatable objects: values are section offsets
            if (synthetic && sec && sec.alloc && type !== 6) valueB += sec.addrB;
            symbols.push({
                index: i, table: dyn ? 'dynsym' : 'symtab', name, valueB, value: num(valueB), size, type, bind,
                vis: other & 3, shndx, section: sec, secName: shndx === 0 ? 'UND' : shndx === 0xfff1 ? 'ABS' : shndx === 0xfff2 ? 'COMMON' : sec ? sec.name : String(shndx),
                typeName: STT_NAMES[type] || String(type), bindName: STB_NAMES[bind] || String(bind),
            });
        }
    }

    // --- relocations
    const relocs = [];
    const symIndex = { symtab: [], dynsym: [] };
    for (const s of symbols) symIndex[s.table][s.index] = s;
    for (const rs of sections) {
        if ((rs.type !== 4 && rs.type !== 9) || !rs.hasData) continue;
        const rela = rs.type === 4;
        const ent = rs.entsize || (is64 ? (rela ? 24 : 16) : (rela ? 12 : 8));
        const symtab = sections[rs.link];
        const symTable = symtab ? (symtab.type === 11 ? 'dynsym' : 'symtab') : null;
        const target = rs.info && sections[rs.info] && (rs.flags & 0x40 || h.type === 1) ? sections[rs.info] : null;
        const n = Math.floor(rs.size / ent);
        for (let i = 0; i < n; i++) {
            const ro = rs.offset + i * ent;
            let offB, type, sym, addend = null;
            if (is64) {
                offB = r.u64(ro);
                const info = r.u64(ro + 8);
                if (h.machine === 8 && le) { // MIPS64 little endian: r_info is sym(32) + 4 type bytes, byte-reversed
                    sym = Number(info & 0xffffffffn);
                    type = Number((info >> 56n) & 0xffn);
                } else {
                    sym = Number(info >> 32n);
                    type = Number(info & 0xffffffffn);
                }
                if (rela) addend = r.i64(ro + 16);
            } else {
                offB = BigInt(r.u32(ro));
                const info = r.u32(ro + 4);
                sym = info >>> 8; type = info & 0xff;
                if (rela) addend = BigInt(r.i32(ro + 8));
            }
            // in relocatable objects r_offset is an offset into the section the relocations apply to
            if (synthetic && target) offB += target.addrB;
            const symbol = sym && symTable ? symIndex[symTable][sym] || null : null;
            relocs.push({
                section: rs.name, target: target ? target.name : '', offsetB: offB, offset: num(offB), type, typeName: relocTypeName(h.machine, type),
                symIndex: sym, symbol, symName: symbol ? symbol.name : '', addend,
            });
        }
    }

    // --- dynamic section
    const dynamic = [];
    const needed = [];
    const dynSec = sections.find(s => s.type === 6 && s.hasData);
    let dynOff = dynSec ? dynSec.offset : -1, dynSize = dynSec ? dynSec.size : 0, dynStr = dynSec ? sections[dynSec.link] : null;
    if (!dynSec) {
        const pd = segments.find(p => p.type === 2);
        if (pd && inFile(bytes, pd.offset, pd.filesz)) { dynOff = pd.offset; dynSize = pd.filesz; }
    }
    if (dynOff >= 0) {
        const ent = 2 * A;
        const raw = [];
        for (let o2 = dynOff; o2 + ent <= dynOff + dynSize; o2 += ent) {
            const tag = Number(r.swordB(o2)), val = r.addr(o2 + A);
            raw.push({ tag, val });
            if (tag === 0) break;
        }
        // DT_STRTAB is an address: find its file offset through the segments
        let strOff = dynStr && dynStr.hasData ? dynStr.offset : -1;
        if (strOff < 0) {
            const t = raw.find(d => d.tag === 5);
            if (t) strOff = vaToOffset(segments, num(t.val));
        }
        for (const d of raw) {
            const e = { tag: d.tag, tagName: DT_NAMES[d.tag] || '0x' + (d.tag >>> 0).toString(16), valB: d.val, value: '0x' + d.val.toString(16) };
            if (DT_STRING_TAGS.has(d.tag) && strOff >= 0) {
                e.str = r.cstr(strOff + Number(d.val));
                e.value = e.str;
                if (d.tag === 1) needed.push(e.str);
                if (d.tag === 14) h.soname = e.str;
            }
            dynamic.push(e);
        }
    }

    // --- notes (build id, ABI tag, …)
    const notes = [];
    for (const s of sections.length ? sections.filter(s => s.type === 7 && s.hasData) : segments.filter(p => p.type === 4).map(p => ({ offset: p.offset, size: p.filesz, name: 'PT_NOTE', hasData: inFile(bytes, p.offset, p.filesz) }))) {
        if (!s.hasData) continue;
        let p = s.offset;
        const end = s.offset + s.size;
        while (p + 12 <= end) {
            const namesz = r.u32(p), descsz = r.u32(p + 4), type = r.u32(p + 8);
            const name = r.cstr(p + 12, namesz);
            const dOff = p + 12 + align4(namesz);
            if (dOff + descsz > end) break;
            const desc = bytes.subarray(dOff, dOff + descsz);
            const n = { section: s.name, owner: name, type, desc };
            if (name === 'GNU' && type === 3) { n.what = 'Build ID'; n.text = hex(desc); h.buildId = n.text; }
            else if (name === 'GNU' && type === 1 && descsz >= 16) { n.what = 'ABI tag'; n.text = ['Linux', 'Hurd', 'Solaris', 'FreeBSD'][r.u32(dOff)] + ' ' + r.u32(dOff + 4) + '.' + r.u32(dOff + 8) + '.' + r.u32(dOff + 12); }
            else if (name === 'GNU' && type === 5) { n.what = 'Property'; n.text = descsz + ' bytes'; }
            else { n.what = 'type ' + type; n.text = descsz <= 32 ? hex(desc) : descsz + ' bytes'; }
            notes.push(n);
            p = dOff + align4(descsz);
        }
    }

    // --- ARM build attributes (CPU profile: Cortex-M is Thumb only)
    let armAttrs = null;
    if (h.machine === 40) {
        const at = sections.find(s => s.type === 0x70000003 && s.hasData);
        if (at) {
            try { armAttrs = parseArmAttributes(bytes, at.offset, at.size, le); } catch (err) { warnings.push('ARM attributes: ' + err.message); }
        }
    }

    return {
        bytes, header: h, sections, segments, symbols, relocs, dynamic, needed, notes, armAttrs, warnings,
        bias, synthetic, addrWidth: (is64 && (maxAddr - bias) >= (1n << 32n)) ? 16 : 8,
    };
}

function align4(n) { return (n + 3) & ~3; }

export function hex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
}

export function vaToOffset(segments, va) {
    for (const p of segments) {
        if (p.type === 1 && va >= p.vaddr && va < p.vaddr + p.filesz) return p.offset + (va - p.vaddr);
    }
    return -1;
}

// .ARM.attributes: format 'A', then vendor subsections; we read the "aeabi" file-scope tags
function parseArmAttributes(bytes, off, size, le) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = off + size;
    if (bytes[off] !== 0x41) throw new Error('unknown format');
    let p = off + 1;
    const out = {};
    const uleb = () => { let v = 0, s = 0, b; do { b = bytes[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && p < end); return v >>> 0; };
    const ntbs = () => { const s = p; while (p < end && bytes[p]) p++; const str = utf8(bytes.subarray(s, p)); p++; return str; };
    while (p + 4 <= end) {
        const len = dv.getUint32(p, le);
        const subEnd = p + len;
        p += 4;
        const vendor = ntbs();
        if (vendor !== 'aeabi') { p = subEnd; continue; }
        while (p < subEnd) {
            const tagStart = p;
            const tag = uleb();
            const tEnd = Math.min(subEnd, tagStart + dv.getUint32(p, le));
            p += 4;
            if (tag !== 1 || tEnd <= tagStart) { p = Math.max(tEnd, p); continue; }
            while (p < tEnd) {
                const t = uleb();
                if (t === 4 || t === 5 || t === 67 || (t > 32 && t & 1)) out[t] = ntbs();
                else if (t === 32) { out[t] = uleb(); ntbs(); }
                else out[t] = uleb();
            }
        }
        p = subEnd;
    }
    const PROFILES = { 0x41: 'A', 0x52: 'R', 0x4d: 'M', 0x53: 'S' };
    const ARCHS = ['pre-v4', 'v4', 'v4T', 'v5T', 'v5TE', 'v5TEJ', 'v6', 'v6KZ', 'v6T2', 'v6K', 'v7', 'v6-M', 'v6S-M', 'v7E-M', 'v8-A', 'v8-R', 'v8-M.baseline', 'v8-M.mainline', 'v8.1-A', 'v8.2-A', 'v8.3-A', 'v8.1-M.mainline', 'v9-A'];
    return {
        cpuName: out[5] || out[4] || '',
        arch: out[6] !== undefined ? (ARCHS[out[6]] || String(out[6])) : '',
        profile: PROFILES[out[7]] || '',
        thumbOnly: PROFILES[out[7]] === 'M' || out[8] === 0,
        raw: out,
    };
}

// --- ISA: what Capstone should disassemble this file's code as
// { arch (Capstone name), modes, label, skip (bytes to step over undecodable data), thumb? }
export const ISA_CHOICES = [
    { id: 'x86-64', arch: 'X86', modes: ['64'], label: 'x86-64', skip: 1 },
    { id: 'x86', arch: 'X86', modes: ['32'], label: 'x86 (32-bit)', skip: 1 },
    { id: 'x86-16', arch: 'X86', modes: ['16'], label: 'x86 (16-bit)', skip: 1 },
    { id: 'arm', arch: 'ARM', modes: ['ARM'], label: 'ARM (A32)', skip: 4, armFamily: true },
    { id: 'thumb', arch: 'ARM', modes: ['THUMB'], label: 'ARM Thumb/Thumb-2', skip: 2, armFamily: true },
    { id: 'cortex-m', arch: 'ARM', modes: ['THUMB', 'MCLASS'], label: 'ARM Cortex-M (Thumb, M-profile)', skip: 2, armFamily: true },
    { id: 'aarch64', arch: 'AARCH64', modes: [], label: 'AArch64 (ARM64)', skip: 4 },
    { id: 'riscv32', arch: 'RISCV', modes: ['RISCV32', 'RISCV_C', 'RISCV_FD', 'RISCV_A'], label: 'RISC-V RV32GC', skip: 2 },
    { id: 'riscv64', arch: 'RISCV', modes: ['RISCV64', 'RISCV_C', 'RISCV_FD', 'RISCV_A'], label: 'RISC-V RV64GC', skip: 2 },
    { id: 'mips32', arch: 'MIPS', modes: ['MIPS32'], label: 'MIPS32', skip: 4 },
    { id: 'mips32r2', arch: 'MIPS', modes: ['MIPS32', 'MIPS32R2'], label: 'MIPS32 Release 2', skip: 4 },
    { id: 'mips32r6', arch: 'MIPS', modes: ['MIPS32', 'MIPS32R6'], label: 'MIPS32 Release 6', skip: 4 },
    { id: 'mips64', arch: 'MIPS', modes: ['MIPS64'], label: 'MIPS64', skip: 4 },
    { id: 'mips64r2', arch: 'MIPS', modes: ['MIPS64', 'MIPS64R2'], label: 'MIPS64 Release 2', skip: 4 },
    { id: 'mips64r6', arch: 'MIPS', modes: ['MIPS64', 'MIPS64R6'], label: 'MIPS64 Release 6', skip: 4 },
    { id: 'micromips', arch: 'MIPS', modes: ['MIPS32', 'MICRO'], label: 'microMIPS', skip: 2 },
    { id: 'ppc32', arch: 'PPC', modes: ['32'], label: 'PowerPC 32', skip: 4 },
    { id: 'ppc64', arch: 'PPC', modes: ['64'], label: 'PowerPC 64', skip: 4 },
    { id: 'sparc', arch: 'SPARC', modes: [], label: 'SPARC', skip: 4 },
    { id: 'sparcv9', arch: 'SPARC', modes: ['V9'], label: 'SPARC v9', skip: 4 },
    { id: 'xtensa', arch: 'XTENSA', modes: ['XTENSA_ESP32'], label: 'Xtensa (ESP32)', skip: 1 },
    { id: 'xtensa-esp8266', arch: 'XTENSA', modes: ['XTENSA_ESP8266'], label: 'Xtensa (ESP8266)', skip: 1 },
    { id: 'systemz', arch: 'SYSTEMZ', modes: ['SYSTEMZ_GENERIC'], label: 'IBM SystemZ', skip: 2 },
    { id: 'm68k', arch: 'M68K', modes: ['M68K_040'], label: 'Motorola 68040', skip: 2 },
    { id: 'm6811', arch: 'M680X', modes: ['M680X_6811'], label: 'Motorola 68HC11', skip: 1 },
    { id: 'hcs08', arch: 'M680X', modes: ['M680X_HCS08'], label: 'Freescale HCS08', skip: 1 },
    { id: 'm6809', arch: 'M680X', modes: ['M680X_6809'], label: 'Motorola 6809', skip: 1 },
    { id: '6502', arch: 'MOS65XX', modes: ['MOS65XX_6502'], label: 'MOS 6502', skip: 1 },
    { id: 'tricore', arch: 'TRICORE', modes: ['TRICORE_162'], label: 'Infineon TriCore 1.6.2', skip: 2 },
    { id: 'sh4', arch: 'SH', modes: ['SH4'], label: 'SuperH SH-4', skip: 2 },
    { id: 'loongarch32', arch: 'LOONGARCH', modes: ['LOONGARCH32'], label: 'LoongArch32', skip: 4 },
    { id: 'loongarch64', arch: 'LOONGARCH', modes: ['LOONGARCH64'], label: 'LoongArch64', skip: 4 },
    { id: 'hppa11', arch: 'HPPA', modes: ['HPPA_11'], label: 'HP PA-RISC 1.1', skip: 4 },
    { id: 'hppa20w', arch: 'HPPA', modes: ['HPPA_20W'], label: 'HP PA-RISC 2.0 (wide)', skip: 4 },
    { id: 'alpha', arch: 'ALPHA', modes: [], label: 'DEC Alpha', skip: 4 },
    { id: 'arc', arch: 'ARC', modes: [], label: 'ARC', skip: 2 },
    { id: 'bpf', arch: 'BPF', modes: ['BPF_EXTENDED'], label: 'eBPF', skip: 8 },
    { id: 'xcore', arch: 'XCORE', modes: [], label: 'XMOS xCORE', skip: 2 },
    { id: 'c64x', arch: 'TMS320C64X', modes: [], label: 'TI TMS320C64x', skip: 4 },
];
export const ISA_BY_ID = Object.fromEntries(ISA_CHOICES.map(c => [c.id, c]));

// The ISA the file's header says; null when Capstone has none for this machine (AVR, MSP430, …)
export function detectIsa(elf) {
    const h = elf.header;
    const e = h.machine;
    const pick = (id, why) => ({ id, why });
    switch (e) {
        case 62: return pick('x86-64', 'e_machine EM_X86_64');
        case 3: case 6: return pick('x86', 'e_machine EM_386');
        case 40: {
            if (elf.armAttrs && elf.armAttrs.profile === 'M') return pick('cortex-m', `ARM attributes: ${elf.armAttrs.arch || ''} M-profile${elf.armAttrs.cpuName ? ' (' + elf.armAttrs.cpuName + ')' : ''}`);
            if (elf.armAttrs && elf.armAttrs.thumbOnly) return pick('thumb', 'ARM attributes: no ARM state');
            return pick((h.entry & 1) ? 'thumb' : 'arm', (h.entry & 1) ? 'entry point is Thumb (odd)' : 'e_machine EM_ARM');
        }
        case 183: return pick('aarch64', 'e_machine EM_AARCH64');
        case 243: return pick(h.is64 ? 'riscv64' : 'riscv32', 'e_machine EM_RISCV');
        case 8: case 10: {
            if (h.flags & 0x02000000) return pick('micromips', 'e_flags: microMIPS');
            // EF_MIPS_ARCH: 0-4 MIPS I-V, 5 MIPS32, 6 MIPS64, 7 MIPS32R2, 8 MIPS64R2, 9 MIPS32R6, 10 MIPS64R6
            const arch = (h.flags >>> 28) & 0xf;
            const ids = { 5: 'mips32', 6: 'mips64', 7: 'mips32r2', 8: 'mips64r2', 9: 'mips32r6', 10: 'mips64r6' };
            const names = ['MIPS I', 'MIPS II', 'MIPS III', 'MIPS IV', 'MIPS V', 'MIPS32', 'MIPS64', 'MIPS32r2', 'MIPS64r2', 'MIPS32r6', 'MIPS64r6'];
            const id = ids[arch] || (h.is64 || (arch >= 2 && arch <= 4) ? 'mips64' : 'mips32');
            return pick(id, 'e_machine EM_MIPS, e_flags ' + (names[arch] || 'arch ' + arch));
        }
        case 20: return pick('ppc32', 'e_machine EM_PPC');
        case 21: return pick('ppc64', 'e_machine EM_PPC64');
        case 2: return pick('sparc', 'e_machine EM_SPARC');
        case 18: case 43: return pick('sparcv9', 'e_machine EM_SPARCV9');
        case 94: return pick('xtensa', 'e_machine EM_XTENSA');
        case 22: return pick('systemz', 'e_machine EM_S390');
        case 4: return pick('m68k', 'e_machine EM_68K');
        case 70: return pick('m6811', 'e_machine EM_68HC11');
        case 44: return pick('tricore', 'e_machine EM_TRICORE');
        case 42: return pick('sh4', 'e_machine EM_SH');
        case 258: return pick(h.is64 ? 'loongarch64' : 'loongarch32', 'e_machine EM_LOONGARCH');
        case 15: return pick(h.is64 ? 'hppa20w' : 'hppa11', 'e_machine EM_PARISC');
        case 0x9026: return pick('alpha', 'e_machine EM_ALPHA');
        case 93: case 195: return pick('arc', 'e_machine EM_ARC');
        case 247: return pick('bpf', 'e_machine EM_BPF');
        case 203: return pick('xcore', 'e_machine EM_XCORE');
        case 140: return pick('c64x', 'e_machine EM_TI_C6000');
        default: return null;
    }
}
