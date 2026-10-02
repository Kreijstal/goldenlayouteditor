// What to disassemble and how: the code regions of an ELF (executable sections,
// else executable PT_LOAD segments) split into runs of one mode each. ARM
// files switch between ARM, Thumb and data at their mapping symbols ($a, $t,
// $d; AArch64 $x, $d), else at function symbols (odd address = Thumb).
import { ISA_BY_ID } from './elf-parse.js';

export function isMappingSymbol(name) {
    return /^\$[atdx](\.|$)/.test(name);
}

// The symbols as the viewer shows them: code addresses without the Thumb bit
export function symbolAddress(elf, sym) {
    if (elf.header.machine === 40 && sym.type === 2 && (sym.value & 1)) return sym.value - 1;
    return sym.value;
}

// armMode: 'auto' | 'arm' | 'thumb'
export function buildPlan(elf, isaId, armMode = 'auto') {
    const isa = ISA_BY_ID[isaId];
    const h = elf.header;
    // ARM BE8 (e_flags EF_ARM_BE8): code is little endian in a big-endian file
    const codeLe = h.le || (h.machine === 40 && !!(h.flags & 0x00800000));
    const regions = [];
    const execSecs = elf.sections.filter(s => s.exec && s.type !== 8 && s.hasData && s.size > 0);
    if (execSecs.length) {
        for (const s of execSecs) regions.push({ id: 's' + s.index, name: s.name, addr: s.addr, offset: s.offset, size: s.size, secIndex: s.index });
    } else {
        for (const p of elf.segments) {
            // a truncated file (a partial dump): what is there of the segment
            const size = Math.min(p.filesz, elf.bytes.length - p.offset);
            if (p.type === 1 && (p.flags & 1) && size > 0) {
                regions.push({ id: 'p' + p.index, name: `LOAD[${p.index}]`, addr: p.vaddr, offset: p.offset, size, segIndex: p.index });
            }
        }
    }
    const armFamily = isa && isa.armFamily;
    const a64 = isa && isa.arch === 'AARCH64';
    const defaultArm = !armFamily ? null : armMode === 'arm' ? 'arm' : armMode === 'thumb' ? 'thumb' : (isa.modes.includes('THUMB') ? 'thumb' : 'arm');
    for (const r of regions) {
        let marks = [];
        if (armFamily || a64) {
            for (const s of elf.symbols) {
                if (s.table !== 'symtab' || !isMappingSymbol(s.name)) continue;
                const inRegion = r.secIndex !== undefined ? s.shndx === r.secIndex : (s.value >= r.addr && s.value < r.addr + r.size);
                if (!inRegion) continue;
                const k = s.name[1];
                const mode = k === 'd' ? 'data' : armFamily ? (k === 't' ? 'thumb' : 'arm') : null;
                marks.push({ at: s.value - r.addr, mode });
            }
            if (!marks.length && armFamily && armMode === 'auto') {
                for (const s of elf.symbols) {
                    if (s.type !== 2) continue;
                    const a = symbolAddress(elf, s);
                    if (a < r.addr || a >= r.addr + r.size) continue;
                    marks.push({ at: a - r.addr, mode: (s.value & 1) ? 'thumb' : 'arm' });
                }
            }
        }
        marks = marks.filter(m => m.at >= 0 && m.at < r.size).sort((a, b) => a.at - b.at);
        // forced ARM/Thumb: only data stays data
        if (armFamily && armMode !== 'auto') for (const m of marks) if (m.mode !== 'data') m.mode = defaultArm;
        const runs = [];
        let cur = { start: 0, mode: armFamily ? defaultArm : null };
        for (const m of marks) {
            if (m.at === cur.start) { cur.mode = m.mode; continue; }
            if (m.mode === cur.mode) continue;
            runs.push({ start: cur.start, end: m.at, mode: cur.mode });
            cur = { start: m.at, mode: m.mode };
        }
        runs.push({ start: cur.start, end: r.size, mode: cur.mode });
        r.runs = runs.filter(x => x.end > x.start);
    }
    const memory = elf.sections.filter(s => s.alloc && s.hasData && s.size).map(s => ({ addr: s.addr, size: s.size, offset: s.offset }));
    if (!memory.length) {
        for (const p of elf.segments) if (p.type === 1 && p.filesz && p.offset < elf.bytes.length) memory.push({ addr: p.vaddr, size: Math.min(p.filesz, elf.bytes.length - p.offset), offset: p.offset });
    }
    return { regions, memory, codeLe };
}
