// The ELF viewer's disassembly engine: a linear sweep of the code regions with
// Capstone, collecting each instruction's start (so the page can show any row
// on demand), the references and the function prologues found on the way
// (analysis.js); then single rows re-disassembled as they scroll into view.
// No DOM: elf-worker.js runs it in a Web Worker; tests run it under node.
import { makeAnalyzer } from './analysis.js';
import { ISA_BY_ID } from './elf-parse.js';

const SLICE = 16384;          // bytes handed to Capstone at a time
const YIELD_EVERY = 40000;    // instructions between progress reports

export class Engine {
    // cs: loadCapstone() result. setup: { bytes, le (data), codeLe, is64, bias (BigInt), isaId,
    //   memory: [{ addr, size, offset }] (sections with file data, for literal pools),
    //   regions: [{ id, name, addr, offset, size, runs: [{ start, end, mode }] }] (mode 'arm'|'thumb'|'data'|null) }
    constructor(cs, setup) {
        this.cs = cs;
        this.s = setup;
        this.bytes = setup.bytes;
        this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
        this.isa = ISA_BY_ID[setup.isaId];
        if (!this.isa) throw new Error('Unknown ISA ' + setup.isaId);
        if (!cs.supports(this.isa.arch)) throw new Error(`This Capstone build has no ${this.isa.arch}`);
        this.memory = (setup.memory || []).slice().sort((a, b) => a.addr - b.addr);
        // one Capstone handle per mode: Capstone 6's ARM module ORs CS_OPT_MODE into the handle's
        // mode (arch/ARM/ARMModule.c), so an option cannot switch Thumb back to ARM
        this.handles = new Map();
        this.curMode = undefined;
        this.setMode(null);
        this.regions = new Map(setup.regions.map(r => [r.id, r]));
        this.cancelled = false;
    }

    modesFor(mode) {
        let modes = this.isa.modes.slice();
        if (this.isa.armFamily && mode) {
            modes = modes.filter(m => m !== 'ARM' && m !== 'THUMB');
            modes.unshift(mode === 'thumb' ? 'THUMB' : 'ARM');
            if (mode === 'arm') modes = modes.filter(m => m !== 'MCLASS');
        }
        if (!this.s.codeLe) modes.push('BIG_ENDIAN');
        return modes;
    }

    setMode(mode) {
        if (mode === this.curMode) return;
        const modes = this.modesFor(mode);
        const key = modes.join('+');
        let h = this.handles.get(key);
        if (!h) { h = this.cs.open(this.isa.arch, modes); this.handles.set(key, h); }
        this.handle = h;
        this.curMode = mode;
    }

    skipFor(mode) {
        if (this.isa.armFamily) return mode === 'arm' ? 4 : (mode === 'thumb' ? 2 : this.isa.skip);
        return this.isa.skip;
    }

    readWord(addr, size) {
        const m = this.memory;
        let lo = 0, hi = m.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const r = m[mid];
            if (addr < r.addr) hi = mid - 1;
            else if (addr >= r.addr + r.size) lo = mid + 1;
            else {
                const off = r.offset + (addr - r.addr);
                if (addr + size > r.addr + r.size || off + size > this.bytes.length) return null;
                return size === 8 ? Number(this.dv.getBigUint64(off, this.s.le)) : size === 2 ? this.dv.getUint16(off, this.s.le) : this.dv.getUint32(off, this.s.le);
            }
        }
        return null;
    }

    runAt(region, off) {
        const runs = region.runs;
        let lo = 0, hi = runs.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (off < runs[mid].start) hi = mid - 1;
            else if (off >= runs[mid].end) lo = mid + 1;
            else return runs[mid];
        }
        return null;
    }

    // The sweep: returns { regions: { id: Uint32Array of row offsets }, refs: { from, to, kind }, funcs: [{ addr, why }] }
    async sweep(onProgress) {
        const refFrom = [], refTo = [], refKind = [];
        const funcs = [];
        const an = makeAnalyzer({
            isa: this.isa, bias: this.s.bias, is64: this.s.is64,
            readWord: (a, n) => this.readWord(a, n),
            onRef: (from, to, kind) => { refFrom.push(from); refTo.push(to); refKind.push(kind); },
            onFunc: (addr, why) => funcs.push({ addr, why }),
        });
        const total = [...this.regions.values()].reduce((n, r) => n + r.size, 0) || 1;
        let doneBytes = 0, sinceYield = 0;
        const rows = {};
        for (const region of this.regions.values()) {
            const starts = [];
            for (const run of region.runs) {
                an.reset();
                if (run.mode === 'data') {
                    for (let o = run.start; o < run.end; o += 4) starts.push(o);
                    doneBytes += run.end - run.start;
                    continue;
                }
                this.setMode(run.mode);
                const skip = this.skipFor(run.mode);
                const thumb = run.mode === 'thumb' || (!run.mode && this.isa.modes.includes('THUMB'));
                let pos = run.start;
                while (pos < run.end) {
                    if (this.cancelled) throw new Error('cancelled');
                    const sliceEnd = Math.min(run.end, pos + SLICE);
                    let next = pos, cut = false, count = 0;
                    const base = region.addr + pos;
                    this.handle.each(this.bytes.subarray(region.offset + pos, region.offset + sliceEnd), this.s.bias + BigInt(base), Infinity, skip, (rel, size, flags, mn, ops) => {
                        if (cut) return;
                        const o = pos + rel;
                        if (sliceEnd < run.end && o + size > sliceEnd - 16 && o > pos) { cut = true; return; }  // may be cut short: redo in the next slice
                        starts.push(o);
                        an.step({ addr: base + rel, size, flags, mn, ops, thumb });
                        next = o + size;
                        count++;
                    });
                    if (next === pos) break;
                    doneBytes += next - pos;
                    sinceYield += count;
                    pos = next;
                    if (sinceYield > YIELD_EVERY) {
                        sinceYield = 0;
                        if (onProgress) onProgress(doneBytes / total, region.name);
                        await new Promise(r => setTimeout(r, 0));
                    }
                }
            }
            rows[region.id] = Uint32Array.from(starts);
        }
        if (onProgress) onProgress(1, '');
        const refs = { from: Float64Array.from(refFrom), to: Float64Array.from(refTo), kind: Uint8Array.from(refKind) };
        // the orders the page looks references up by (by source, by target), sorted here off its thread
        const n = refs.from.length;
        const byFrom = new Uint32Array(n), byTo = new Uint32Array(n);
        for (let i = 0; i < n; i++) byFrom[i] = byTo[i] = i;
        const { from, to } = refs;
        byFrom.sort((x, y) => from[x] - from[y] || x - y);
        byTo.sort((x, y) => to[x] - to[y] || from[x] - from[y]);
        refs.byFrom = byFrom;
        refs.byTo = byTo;
        return { rows, refs, funcs };
    }

    // Rows [first, first + count) of a region, given the row offsets the sweep found
    render(regionId, offsets) {
        const region = this.regions.get(regionId);
        const out = [];
        for (const off of offsets) {
            const run = this.runAt(region, off);
            const end = run ? run.end : region.size;
            const fo = region.offset + off;
            if (run && run.mode === 'data') {
                const n = Math.min(4, end - off);
                const b = this.bytes.subarray(fo, fo + n);
                let v = 0;
                if (n === 4) v = this.dv.getUint32(fo, this.s.le);
                else if (n === 2) v = this.dv.getUint16(fo, this.s.le);
                else v = b[0];
                out.push({ off, size: n, bytes: hexBytes(b), mn: n === 4 ? '.word' : n === 2 ? '.short' : '.byte', ops: '0x' + v.toString(16).padStart(n * 2, '0'), flags: 0, data: true });
                continue;
            }
            this.setMode(run ? run.mode : null);
            const n = Math.min(16, end - off);
            const recs = this.handle.disasm(this.bytes.subarray(fo, fo + n), this.s.bias + BigInt(region.addr + off), 1, this.skipFor(run ? run.mode : null));
            const r = recs[0];
            if (!r || r.bad) {
                const sz = r ? r.size : Math.max(1, n);
                const b = this.bytes.subarray(fo, fo + sz);
                out.push({ off, size: sz, bytes: hexBytes(b), mn: '.byte', ops: Array.from(b, x => '0x' + x.toString(16).padStart(2, '0')).join(', '), flags: 128, bad: true });
            } else {
                out.push({ off, size: r.size, bytes: hexBytes(this.bytes.subarray(fo, fo + r.size)), mn: r.mnemonic, ops: r.opStr, flags: r.flags, thumb: run && run.mode === 'thumb' });
            }
        }
        return out;
    }

    close() { for (const h of this.handles.values()) h.close(); this.handles.clear(); }
}

function hexBytes(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += (i ? ' ' : '') + (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
}
