// What the ELF viewer learns from each disassembled instruction: references
// (call and branch targets, PC-relative and absolute data accesses, addresses
// built in registers: x86 RIP-relative, ARM literal pools and movw/movt,
// AArch64 adrp+add, RISC-V lui/auipc+addi, MIPS lui+addiu/ori, PowerPC lis+addi)
// and function prologues (for stripped binaries). Runs in the worker over
// Capstone's text output, so it is mostly per-ISA string matching.
//
// A reference is { from, to, kind } with kind one of REF_KINDS.

export const REF_KINDS = ['call', 'jump', 'read', 'write', 'addr', 'ptr'];
export const REF_KIND = Object.fromEntries(REF_KINDS.map((k, i) => [k, i]));

const F_JUMP = 1, F_CALL = 2, F_RET = 4, F_INT = 8, F_BAD = 128;

function parseNum(s) {
    if (s === undefined || s === null) return null;
    s = s.trim().replace(/^#/, '');
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); }
    let v;
    if (/^0x[0-9a-f]+$/i.test(s)) v = BigInt(s);
    else if (/^\d+$/.test(s)) v = BigInt(s);
    else return null;
    return neg ? -v : v;
}

function splitOps(ops) {
    // split at commas outside brackets/parentheses/braces
    if (ops.indexOf(',') < 0) return ops ? [ops] : [];
    if (!/[[({]/.test(ops)) return ops.split(', ');
    const out = [];
    let depth = 0, cur = '';
    for (const ch of ops) {
        if (ch === '[' || ch === '(' || ch === '{') depth++;
        else if (ch === ']' || ch === ')' || ch === '}') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

// family: which rules apply
function familyOf(isa) {
    switch (isa.arch) {
        case 'X86': return 'x86';
        case 'ARM': return 'arm';
        case 'AARCH64': return 'a64';
        case 'RISCV': return 'rv';
        case 'MIPS': return 'mips';
        case 'PPC': return 'ppc';
        case 'SPARC': return 'sparc';
        case 'XTENSA': return 'xtensa';
        default: return 'generic';
    }
}

// opts: { isa, bias (BigInt), is64, readWord(addr, size) -> Number|null, onRef(from, to, kind), onFunc(addr, why) }
export function makeAnalyzer(opts) {
    const fam = familyOf(opts.isa);
    const bias = opts.bias || 0n;
    const mask = opts.is64 ? 0xffffffffffffffffn : 0xffffffffn;
    const toAddr = (big) => Number(BigInt.asUintN(64, (big & mask) - bias));
    const regs = new Map();      // register -> known value (BigInt, absolute)
    let prev = null, prev2 = null;
    let boundary = true;        // the previous instruction ended a block (or the run started)
    let sinceFunc = 99;         // instructions since the last detected function start
    const ref = (from, toBig, kind) => opts.onRef(from, toAddr(toBig), REF_KIND[kind]);
    const func = (addr, why) => {
        if (sinceFunc < 4 && !boundary) return;
        opts.onFunc(addr, why);
        sinceFunc = 0;
    };
    const sx32 = (v) => BigInt.asIntN(32, v);
    const abs = (addr) => BigInt(addr) + bias;   // viewer address (Number) -> absolute BigInt

    function reset() { regs.clear(); prev = prev2 = null; boundary = true; sinceFunc = 99; }

    // the target of a direct branch: the last operand when it is a number
    function branchTarget(ops) {
        const parts = splitOps(ops);
        if (!parts.length) return null;
        return parseNum(parts[parts.length - 1]);
    }

    function step(insn) {
        const { addr, size, flags, mn, ops } = insn;
        sinceFunc++;
        if (flags & F_BAD) { regs.clear(); prev2 = prev; prev = insn; boundary = true; return; }
        const isBranch = flags & (F_JUMP | F_CALL);
        if (isBranch) {
            const t = branchTarget(ops);
            if (t !== null && !(fam === 'x86' && /\[/.test(ops))) ref(addr, t, flags & F_CALL ? 'call' : 'jump');
        }
        switch (fam) {
            case 'x86': x86(insn); break;
            case 'arm': arm(insn); break;
            case 'a64': a64(insn); break;
            case 'rv': rv(insn); break;
            case 'mips': mips(insn); break;
            case 'ppc': ppc(insn); break;
            case 'sparc': if (mn === 'save' && /^%sp, -/.test(ops)) func(addr, 'save %sp, -N, %sp'); break;
            case 'xtensa': xtensa(insn); break;
        }
        const uncond = (flags & F_RET) || (flags & F_JUMP && isUncondJump(mn, ops));
        if (isBranch || flags & F_RET) regs.clear();
        prev2 = prev; prev = insn;
        boundary = !!(uncond || isPadding(mn));
    }

    function isUncondJump(mn, ops) {
        switch (fam) {
            case 'x86': return mn === 'jmp' || mn === 'ljmp';
            case 'arm': return mn === 'b' || mn === 'b.w' || mn === 'bx' || (/^(pop|pop\.w|ldm|ldmia|ldm\.w)$/.test(mn) && /\bpc\b/.test(ops)) || (mn === 'mov' && ops.startsWith('pc,'));
            case 'a64': return mn === 'b' || mn === 'br';
            case 'rv': return mn === 'j' || mn === 'jr' || mn === 'c.j' || mn === 'c.jr';
            case 'mips': return mn === 'j' || mn === 'jr' || mn === 'b';
            case 'ppc': return mn === 'b' || mn === 'bctr' || mn === 'ba';
            default: return /^(j|jmp|b|br|ba|bra)$/.test(mn);
        }
    }

    function isPadding(mn) {
        return mn === 'nop' || mn === 'int3' || mn === 'hlt' || mn === 'ud2' || mn === 'udf' || mn === 'c.nop' || mn === 'xchg ax, ax';
    }

    // a memory operand's access: write when it is the destination
    function x86(insn) {
        const { addr, size, mn, ops } = insn;
        if (mn === 'endbr64' || mn === 'endbr32') func(addr, mn);
        else if (mn === 'mov' && (ops === 'rbp, rsp' || ops === 'ebp, esp') && prev && prev.mn === 'push' && (prev.ops === 'rbp' || prev.ops === 'ebp')) {
            if (!(prev2 && /^endbr/.test(prev2.mn))) func(prev.addr, `push ${prev.ops}; mov ${ops}`);
        } else if (boundary && mn === 'sub' && /^(rsp|esp), (0x[0-9a-f]+|\d+)$/.test(ops)) func(addr, 'sub ' + ops.split(',')[0] + ', imm');
        else if (boundary && mn === 'push' && /^(rbp|rbx|r12|r13|r14|r15|ebp|ebx|esi|edi)$/.test(ops)) func(addr, 'push ' + ops + ' after a block end');
        if (ops.length < 7 && ops.indexOf('[') < 0) return;  // "rax, rbx": no address in it
        const parts = splitOps(ops);
        const memAt = parts.findIndex(p => p.includes('['));
        if (memAt >= 0) {
            const m = parts[memAt];
            let t = null;
            const rip = /\[(?:rip|eip) ([+-]) (0x[0-9a-f]+|\d+)\]/.exec(m);
            if (rip) t = BigInt(addr) + bias + BigInt(size) + (rip[1] === '-' ? -BigInt(rip[2]) : BigInt(rip[2]));
            else {
                const a = /(?<![fg]s:)\[(0x[0-9a-f]+)\]/.exec(m);
                if (a) t = BigInt(a[1]);
            }
            if (t !== null) {
                let kind;
                if (mn === 'lea') kind = 'addr';
                else if (insn.flags & (F_JUMP | F_CALL)) kind = 'read';
                else if (memAt === 0 && parts.length > 1 && !/^(cmp|test|push|bt|ucomis|comis)/.test(mn)) kind = 'write';
                else if (memAt === 0 && parts.length === 1 && /^(inc|dec|not|neg|pop|set)/.test(mn)) kind = 'write';
                else kind = 'read';
                ref(addr, t, kind);
            }
        } else if (!(insn.flags & (F_JUMP | F_CALL)) && parts.length === 2 && /^(mov|movabs|push|cmp)$/.test(mn)) {
            const v = parseNum(parts[1]);
            if (v !== null && v >= 0x1000n) ref(addr, v, 'addr');
        } else if (mn === 'push' && parts.length === 1) {
            const v = parseNum(parts[0]);
            if (v !== null && v >= 0x1000n) ref(addr, v, 'addr');
        }
    }

    function arm(insn) {
        const { addr, mn, ops } = insn;
        const thumb = insn.thumb;
        const parts = splitOps(ops);
        const base = mn.replace(/\.(w|n)$/, '');
        // prologues: push {..., lr} / stmdb sp!, {..., lr}
        if ((base === 'push' && /\blr\b/.test(ops)) || (/^stm(db|fd)$/.test(base) && /^sp!/.test(ops) && /\blr\b/.test(ops))) func(addr, 'push {…, lr}');
        const pc = BigInt(addr) + bias + (thumb ? 4n : 8n);
        // literal pool load: ldr rX, [pc, #off]
        const lit = /^\[pc(?:, #(-?(?:0x[0-9a-f]+|\d+)))?\]$/.exec(parts[1] || '');
        if (/^ldr/.test(base) && lit) {
            const t = (pc & ~3n) + (lit[1] ? parseNum(lit[1]) : 0n);
            ref(addr, t, 'read');
            const val = opts.readWord(toAddr(t), base === 'ldrd' ? 4 : 4);
            if (val !== null && base === 'ldr') {
                regs.set(parts[0], BigInt(val));
                if (val >= 0x100) ref(addr, BigInt(val), 'ptr');
            } else regs.delete(parts[0]);
            return;
        }
        if (base === 'adr') {
            const v = parseNum(parts[1]);
            if (v !== null) { const t = (pc & ~3n) + v; regs.set(parts[0], t); ref(addr, t, 'addr'); }
            return;
        }
        if (base === 'movw' || ((base === 'mov' || base === 'movs') && parts.length === 2 && /^#/.test(parts[1]))) {
            const v = parseNum(parts[1]);
            if (v !== null) { regs.set(parts[0], v & 0xffffffffn); return; }
        }
        if (base === 'movt') {
            const v = parseNum(parts[1]), lo = regs.get(parts[0]);
            if (v !== null && lo !== undefined) {
                const val = ((v & 0xffffn) << 16n) | (lo & 0xffffn);
                regs.set(parts[0], val);
                ref(addr, val, 'addr');
            } else regs.delete(parts[0]);
            return;
        }
        // add rX, pc[, rY]  (position-independent literal)
        if (base === 'add' && parts[1] === 'pc') {
            const src = parts.length === 3 ? parts[2] : parts[0];
            const v = regs.get(src);
            if (v !== undefined) { const t = (v + pc) & 0xffffffffn; regs.set(parts[0], t); ref(addr, t, 'addr'); }
            else regs.delete(parts[0]);
            return;
        }
        if ((base === 'add' || base === 'adds' || base === 'sub' || base === 'subs') && parts.length === 3 && /^#/.test(parts[2])) {
            const v = regs.get(parts[1]), imm = parseNum(parts[2]);
            if (v !== undefined && imm !== null) { regs.set(parts[0], (base[0] === 'a' ? v + imm : v - imm) & 0xffffffffn); return; }
        }
        // loads/stores through a register with a known value
        const ls = /^(ldr|str)(b|h|sb|sh|d|ex|exb|exh)?$/.exec(base);
        if (ls) {
            const m = /^\[(\w+)(?:, #(-?(?:0x[0-9a-f]+|\d+)))?\]!?$/.exec(parts[1] || '');
            if (m && regs.has(m[1])) {
                const t = (regs.get(m[1]) + (m[2] ? parseNum(m[2]) : 0n)) & 0xffffffffn;
                ref(addr, t, ls[1] === 'str' ? 'write' : 'read');
            }
            if (ls[1] === 'ldr') regs.delete(parts[0]);
            return;
        }
        if (parts.length && /^(r\d+|ip|lr|sb|sl|fp)$/.test(parts[0]) && !/^(cmp|cmn|tst|teq|b|bl|bx|blx|cbz|cbnz|it|push|stm|str)/.test(base)) {
            if (base === 'mov' && parts.length === 2 && regs.has(parts[1])) regs.set(parts[0], regs.get(parts[1]));
            else regs.delete(parts[0]);
        }
    }

    function a64(insn) {
        const { addr, mn, ops } = insn;
        const parts = splitOps(ops);
        if (mn === 'stp' && /^x29, x30, \[sp, #-(0x[0-9a-f]+|\d+)\]!$/.test(ops)) func(addr, 'stp x29, x30, [sp, #-N]!');
        else if (mn === 'paciasp' || mn === 'pacibsp' || (mn === 'hint' && (ops === '#0x19' || ops === '#0x1b'))) func(addr, 'paciasp');
        else if (boundary && mn === 'bti' && ops === 'c') func(addr, 'bti c after a block end');
        else if (boundary && mn === 'sub' && /^sp, sp, #/.test(ops)) func(addr, 'sub sp, sp, #N after a block end');
        if (mn === 'adrp' || mn === 'adr') {
            const v = parseNum(parts[1]);
            if (v !== null) { regs.set(parts[0].replace(/^w/, 'x'), v); if (mn === 'adr') ref(addr, v, 'addr'); }
            return;
        }
        if (mn === 'add' && parts.length === 3 && /^#/.test(parts[2])) {
            const v = regs.get(parts[1].replace(/^w/, 'x')), imm = parseNum(parts[2]);
            if (v !== undefined && imm !== null) { const t = v + imm; regs.set(parts[0].replace(/^w/, 'x'), t); ref(addr, t, 'addr'); return; }
        }
        if (/^ldr/.test(mn) && parts.length === 2 && /^#?(0x[0-9a-f]+|\d+)$/.test(parts[1])) {
            const t = parseNum(parts[1]);
            ref(addr, t, 'read');
            regs.delete(parts[0].replace(/^w/, 'x'));
            return;
        }
        const ls = /^(ld|st)(r|ur|p|xr|lr|ar|nr|tr)?(b|h|sb|sh|sw)?$/.exec(mn);
        if (ls) {
            const memOp = parts.find(p => p.startsWith('['));
            const m = memOp && /^\[(x\d+|sp)(?:, #(-?(?:0x[0-9a-f]+|\d+)))?\]!?$/.exec(memOp);
            if (m && regs.has(m[1])) ref(addr, regs.get(m[1]) + (m[2] ? parseNum(m[2]) : 0n), ls[1] === 'st' ? 'write' : 'read');
            if (ls[1] === 'ld') for (const p of parts) if (!p.startsWith('[')) regs.delete(p.replace(/^w/, 'x'));
            return;
        }
        if (parts.length && /^[wx]\d+$/.test(parts[0]) && !/^(cmp|cmn|tst|b|cb|tb|st|ccmp|ccmn)/.test(mn)) {
            if (mn === 'mov' && parts.length === 2 && regs.has(parts[1].replace(/^w/, 'x'))) regs.set(parts[0].replace(/^w/, 'x'), regs.get(parts[1].replace(/^w/, 'x')));
            else regs.delete(parts[0].replace(/^w/, 'x'));
        }
    }

    // lui/auipc + addi / load / store
    function rv(insn) {
        const { addr, mn, ops } = insn;
        const parts = splitOps(ops);
        const m0 = mn.replace(/^c\./, '');
        if ((m0 === 'addi' || m0 === 'addi16sp') && /^sp, (sp, )?-/.test(ops)) func(addr, 'addi sp, sp, -N');
        if (m0 === 'lui' || m0 === 'auipc') {
            const v = parseNum(parts[1]);
            if (v !== null) {
                let val = BigInt.asIntN(32, (v & 0xfffffn) << 12n);
                if (m0 === 'auipc') val += BigInt(addr) + bias;
                else if (!opts.is64) val = BigInt.asUintN(32, val);
                regs.set(parts[0], opts.is64 ? val : BigInt.asUintN(32, val));
            }
            return;
        }
        if (m0 === 'li' && parts.length === 2) { const v = parseNum(parts[1]); if (v !== null) regs.set(parts[0], v); else regs.delete(parts[0]); return; }
        if (m0 === 'mv' && parts.length === 2) { if (regs.has(parts[1])) regs.set(parts[0], regs.get(parts[1])); else regs.delete(parts[0]); return; }
        if ((m0 === 'addi' || m0 === 'addiw') && parts.length === 3) {
            const v = regs.get(parts[1]), imm = parseNum(parts[2]);
            if (v !== undefined && imm !== null) {
                let t = v + imm;
                if (!opts.is64 || m0 === 'addiw') t = BigInt.asUintN(32, t);
                regs.set(parts[0], t);
                ref(addr, t, 'addr');
                return;
            }
        }
        const mem = parts.length >= 2 && /^(-?(?:0x[0-9a-f]+|\d+))\((\w+)\)$/.exec(parts[parts.length - 1]);
        if (mem) {
            const store = /^(s[bhwd]|fs[whdq]|sc\.[wd])$/.test(m0) || /^c\.(s[wd]|fs[wd])(sp)?$/.test(mn);
            if (regs.has(mem[2])) {
                let t = regs.get(mem[2]) + parseNum(mem[1]);
                if (!opts.is64) t = BigInt.asUintN(32, t);
                ref(addr, t, store ? 'write' : 'read');
            }
            if (!store) regs.delete(parts[0]);
            return;
        }
        if (parts.length && /^(zero|ra|sp|gp|tp|t\d|s\d+|a\d|x\d+|fp)$/.test(parts[0]) && !/^(b|j|c\.b|c\.j)/.test(mn)) regs.delete(parts[0]);
    }

    function mips(insn) {
        const { addr, mn, ops } = insn;
        const parts = splitOps(ops);
        if ((mn === 'addiu' || mn === 'daddiu') && /^\$sp, \$sp, -/.test(ops)) func(addr, 'addiu $sp, $sp, -N');
        if (mn === 'lui') { const v = parseNum(parts[1]); if (v !== null) regs.set(parts[0], BigInt.asUintN(32, (v & 0xffffn) << 16n)); return; }
        if ((mn === 'addiu' || mn === 'ori' || mn === 'daddiu' || mn === 'addi') && parts.length === 3) {
            const v = regs.get(parts[1]), imm = parseNum(parts[2]);
            if (v !== undefined && imm !== null) {
                const t = BigInt.asUintN(32, mn === 'ori' ? (v | (imm & 0xffffn)) : v + imm);
                regs.set(parts[0], t);
                ref(addr, t, 'addr');
                return;
            }
        }
        const mem = parts.length >= 2 && /^(-?(?:0x[0-9a-f]+|\d+))\((\$\w+)\)$/.exec(parts[parts.length - 1]);
        if (mem) {
            const store = /^(s[bhwd]|sw[lrc]1?|sdc1|swc1|sc|scd|sd[lr])$/.test(mn);
            if (regs.has(mem[2])) ref(addr, BigInt.asUintN(32, regs.get(mem[2]) + parseNum(mem[1])), store ? 'write' : 'read');
            if (!store) regs.delete(parts[0]);
            return;
        }
        if (mn === 'move' && parts.length === 2) { if (regs.has(parts[1])) regs.set(parts[0], regs.get(parts[1])); else regs.delete(parts[0]); return; }
        if (parts.length && /^\$/.test(parts[0]) && !/^(b|j|t[a-z]+$|mt)/.test(mn)) regs.delete(parts[0]);
    }

    function ppc(insn) {
        const { addr, mn, ops } = insn;
        const parts = splitOps(ops);
        if ((mn === 'stwu' || mn === 'stdu') && /^r1, -(0x[0-9a-f]+|\d+)\(r1\)$/.test(ops)) func(prev && prev.mn === 'mflr' ? prev.addr : addr, mn + ' r1, -N(r1)');
        else if (mn === 'mflr' && ops === 'r0' && boundary) func(addr, 'mflr r0');
        if (mn === 'lis') { const v = parseNum(parts[1]); if (v !== null) regs.set(parts[0], BigInt.asUintN(32, sx32((v & 0xffffn) << 16n))); return; }
        if (mn === 'li') { const v = parseNum(parts[1]); if (v !== null) regs.set(parts[0], BigInt.asUintN(32, BigInt.asIntN(16, v))); return; }
        if ((mn === 'addi' || mn === 'ori' || mn === 'la') && parts.length === 3) {
            const v = regs.get(parts[1]), imm = parseNum(parts[2]);
            if (v !== undefined && imm !== null) {
                const t = BigInt.asUintN(32, mn === 'ori' ? (v | (imm & 0xffffn)) : v + BigInt.asIntN(16, imm & 0xffffn));
                regs.set(parts[0], t);
                ref(addr, t, 'addr');
                return;
            }
        }
        const mem = parts.length >= 2 && /^(-?(?:0x[0-9a-f]+|\d+))\((r\d+)\)$/.exec(parts[parts.length - 1]);
        if (mem) {
            const store = /^st/.test(mn);
            if (regs.has(mem[2]) && mem[2] !== 'r1') ref(addr, BigInt.asUintN(32, regs.get(mem[2]) + parseNum(mem[1])), store ? 'write' : 'read');
            if (!store) regs.delete(parts[0]);
            return;
        }
        if (mn === 'mr' && parts.length === 2) { if (regs.has(parts[1])) regs.set(parts[0], regs.get(parts[1])); else regs.delete(parts[0]); return; }
        if (parts.length && /^r\d+$/.test(parts[0]) && !/^(b|cmp|st|mt|tw|td)/.test(mn)) regs.delete(parts[0]);
    }

    function xtensa(insn) {
        const { addr, mn, ops } = insn;
        const parts = splitOps(ops);
        if (mn === 'entry' && /^a1, /.test(ops)) func(addr, 'entry a1, N');
        if (mn === 'l32r' && parts.length === 2) {
            const t = parseNum(parts[1]);
            if (t !== null) {
                ref(addr, t, 'read');
                const val = opts.readWord(toAddr(t), 4);
                if (val !== null && val >= 0x100) ref(addr, BigInt(val), 'ptr');
            }
        }
        if (!(insn.flags & (F_JUMP | F_CALL)) && /^(call|j)/.test(mn)) {
            const t = branchTarget(ops);
            if (t !== null) ref(addr, t, mn[0] === 'c' ? 'call' : 'jump');
        }
    }

    return { step, reset, abs };
}
