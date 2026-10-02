// LZX decompression for the MSCompressed section of .chm files, loaded with
// chm-parse.js. A JavaScript port of the LZX decoder in libmspack's lzxd.c
// (Stuart Caie, LGPL 2.1) with the frame handling of chmlib's lzx.c: the
// section is a run of 32 KB frames, each starting at the compressed offset
// the reset table gives, and the decoder state is reset every reset interval,
// so any interval can be decoded on its own. Errors in the data throw; reading
// past the end of the input is allowed only by a few bytes (the bit buffer
// reads ahead), never looped on.

export const FRAME_SIZE = 0x8000;

const NUM_CHARS = 256;
const MIN_MATCH = 2;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const PRETREE_NUM_ELEMENTS = 20;
const ALIGNED_NUM_ELEMENTS = 8;
const BLOCKTYPE_VERBATIM = 1;
const BLOCKTYPE_ALIGNED = 2;
const BLOCKTYPE_UNCOMPRESSED = 3;
const MAX_CODE_LEN = 16;

const EXTRA_BITS = new Uint8Array(52);
const POSITION_BASE = new Uint32Array(52);
for (let i = 0, j = 0; i < 52; i += 2) {
    EXTRA_BITS[i] = j;
    EXTRA_BITS[i + 1] = j;
    if (i !== 0 && j < 17) j++;
}
for (let i = 0, j = 0; i < 52; i++) {
    POSITION_BASE[i] = j;
    j += 1 << EXTRA_BITS[i];
}

// Position slots for each window size (2^15 .. 2^21)
const POSITION_SLOTS = { 15: 30, 16: 32, 17: 34, 18: 36, 19: 38, 20: 42, 21: 50 };

// A canonical Huffman decoding table: a direct lookup on the first `bits`
// bits, and for longer codes a search by code length.
class HuffTable {
    constructor(numSymbols, bits) {
        this.numSymbols = numSymbols;
        this.bits = bits;
        this.lens = new Uint8Array(numSymbols + 32); // slack: run-length writes may overshoot
        this.fast = new Int32Array(1 << bits);       // (symbol << 5) | length, or -1
        this.limit = new Int32Array(MAX_CODE_LEN + 2); // first 16-bit-aligned code past each length
        this.base = new Int32Array(MAX_CODE_LEN + 2);  // index in `sorted` minus the first code, per length
        this.sorted = new Uint16Array(numSymbols);
        this.empty = true;
    }

    build() {
        const { lens, numSymbols, bits } = this;
        const count = new Uint16Array(MAX_CODE_LEN + 1);
        for (let s = 0; s < numSymbols; s++) count[lens[s]]++;
        count[0] = 0;
        this.empty = true;
        for (let l = 1; l <= MAX_CODE_LEN; l++) if (count[l]) { this.empty = false; break; }
        this.fast.fill(-1);
        if (this.empty) return;
        // Over-subscribed code lengths are an error; an incomplete code only fails if a missing code is read
        let left = 1;
        for (let l = 1; l <= MAX_CODE_LEN; l++) {
            left = (left << 1) - count[l];
            if (left < 0) throw new Error('LZX: invalid Huffman table');
        }
        const offs = new Uint16Array(MAX_CODE_LEN + 2);
        for (let l = 1; l <= MAX_CODE_LEN; l++) offs[l + 1] = offs[l] + count[l];
        const next = offs.slice();
        for (let s = 0; s < numSymbols; s++) if (lens[s]) this.sorted[next[lens[s]]++] = s;
        let code = 0;
        for (let l = 1; l <= MAX_CODE_LEN; l++) {
            // codes of length l are code .. code+count[l]-1
            this.base[l] = offs[l] - code;
            const end = code + count[l];
            this.limit[l] = end << (MAX_CODE_LEN - l);
            if (l <= bits) {
                for (let c = code; c < end; c++) {
                    const sym = this.sorted[offs[l] + c - code];
                    const shift = bits - l;
                    const from = c << shift;
                    const v = (sym << 5) | l;
                    for (let k = 0; k < (1 << shift); k++) this.fast[from + k] = v;
                }
            }
            code = end << 1;
        }
    }
}

export class LzxDecoder {
    // windowBits: 15..21
    constructor(windowBits) {
        const slots = POSITION_SLOTS[windowBits];
        if (!slots) throw new Error(`LZX: unsupported window size 2^${windowBits}`);
        this.windowSize = 1 << windowBits;
        this.posnSlots = slots;
        this.pretree = new HuffTable(PRETREE_NUM_ELEMENTS, 6);
        this.maintree = new HuffTable(NUM_CHARS + slots * 8, 12);
        this.lengthtree = new HuffTable(NUM_SECONDARY_LENGTHS, 12);
        this.alignedtree = new HuffTable(ALIGNED_NUM_ELEMENTS, 7);
    }

    _resetState() {
        this.R0 = this.R1 = this.R2 = 1;
        this.headerRead = false;
        this.blockRemaining = 0;
        this.blockLength = 0;
        this.blockType = 0;
        this.intelFilesize = 0;
        this.intelStarted = false;
        this.framesRead = 0;
        this.maintree.lens.fill(0);
        this.lengthtree.lens.fill(0);
    }

    // --- bit input: 16-bit little-endian words, read most significant bit first ---
    _seek(pos) {
        this.ip = pos;
        this.bitbuf = 0;
        this.bitsLeft = 0;
    }

    _ensure(n) {
        while (this.bitsLeft < n) {
            const ip = this.ip;
            const inp = this.input;
            let w;
            if (ip + 1 < this.inEnd) w = inp[ip] | (inp[ip + 1] << 8);
            else {
                // Past the end: zeros, a little (the buffer reads ahead); more means the data is cut short
                if (ip >= this.inEnd + 8) throw new Error('LZX: compressed data ends early (truncated file?)');
                w = ip < this.inEnd ? inp[ip] : 0;
            }
            this.ip = ip + 2;
            this.bitbuf = (this.bitbuf | (w << (16 - this.bitsLeft))) >>> 0;
            this.bitsLeft += 16;
        }
    }

    _read(n) {
        if (n === 0) return 0;
        this._ensure(n);
        const v = this.bitbuf >>> (32 - n);
        this.bitbuf = (this.bitbuf << n) >>> 0;
        this.bitsLeft -= n;
        return v;
    }

    _sym(t) {
        this._ensure(MAX_CODE_LEN);
        const v = t.fast[this.bitbuf >>> (32 - t.bits)];
        let sym, len;
        if (v >= 0) {
            sym = v >>> 5;
            len = v & 31;
        } else {
            const peek = this.bitbuf >>> 16;
            len = t.bits + 1;
            while (len <= MAX_CODE_LEN && peek >= t.limit[len]) len++;
            if (len > MAX_CODE_LEN) throw new Error('LZX: invalid Huffman code');
            sym = t.sorted[t.base[len] + (peek >>> (MAX_CODE_LEN - len))];
        }
        this.bitbuf = (this.bitbuf << len) >>> 0;
        this.bitsLeft -= len;
        return sym;
    }

    // Code lengths lens[first..last), as deltas coded with the pretree
    _readLens(lens, first, last) {
        const pre = this.pretree;
        for (let x = 0; x < PRETREE_NUM_ELEMENTS; x++) pre.lens[x] = this._read(4);
        pre.build();
        if (pre.empty) throw new Error('LZX: empty pretree');
        for (let x = first; x < last;) {
            let z = this._sym(pre);
            if (z === 17) {
                let y = this._read(4) + 4;
                while (y-- && x < lens.length) lens[x++] = 0;
            } else if (z === 18) {
                let y = this._read(5) + 20;
                while (y-- && x < lens.length) lens[x++] = 0;
            } else if (z === 19) {
                let y = this._read(1) + 4;
                z = this._sym(pre);
                if (z > 16) throw new Error('LZX: invalid code length');
                z = lens[x] - z;
                if (z < 0) z += 17;
                while (y-- && x < lens.length) lens[x++] = z;
            } else {
                z = lens[x] - z;
                if (z < 0) z += 17;
                lens[x++] = z;
            }
        }
    }

    _readBlockHeader() {
        // After an uncompressed block the input is read by bytes: start the bit buffer afresh
        if (this.blockType === BLOCKTYPE_UNCOMPRESSED) this._seek(this.ip);
        this.blockType = this._read(3);
        const hi = this._read(16);
        const lo = this._read(8);
        this.blockRemaining = this.blockLength = (hi << 8) | lo;
        switch (this.blockType) {
        case BLOCKTYPE_ALIGNED:
            for (let i = 0; i < ALIGNED_NUM_ELEMENTS; i++) this.alignedtree.lens[i] = this._read(3);
            this.alignedtree.build();
            // falls through: the rest of the header is a verbatim block's
        case BLOCKTYPE_VERBATIM: {
            const main = this.maintree;
            this._readLens(main.lens, 0, NUM_CHARS);
            this._readLens(main.lens, NUM_CHARS, NUM_CHARS + this.posnSlots * 8);
            main.build();
            if (main.empty) throw new Error('LZX: empty main tree');
            if (main.lens[0xe8] !== 0) this.intelStarted = true;
            this._readLens(this.lengthtree.lens, 0, NUM_SECONDARY_LENGTHS);
            this.lengthtree.build();
            break;
        }
        case BLOCKTYPE_UNCOMPRESSED: {
            this.intelStarted = true;
            // Align to the next 16-bit word (a whole word of padding if already aligned)
            this._ensure(16);
            if (this.bitsLeft > 16) this.ip -= 2;
            this.bitsLeft = 0;
            this.bitbuf = 0;
            const inp = this.input;
            if (this.ip + 12 > this.inEnd) throw new Error('LZX: compressed data ends early (truncated file?)');
            const rd = p => (inp[p] | (inp[p + 1] << 8) | (inp[p + 2] << 16) | (inp[p + 3] << 24)) >>> 0;
            this.R0 = rd(this.ip);
            this.R1 = rd(this.ip + 4);
            this.R2 = rd(this.ip + 8);
            this.ip += 12;
            break;
        }
        default:
            throw new Error(`LZX: invalid block type ${this.blockType}`);
        }
    }

    // Decode one reset interval: `length` bytes of output (whole frames but the last) from
    // input[start..end), frame i starting at input offset frameOffsets[i] (when not given, where the
    // previous frame ended, aligned to 16 bits). outOffset is where the interval starts in the
    // section's output, for the E8 translation.
    decodeInterval(input, start, end, frameOffsets, length, outOffset = 0) {
        this.input = input;
        this.inEnd = end;
        this._resetState();
        this._seek(start);
        // The output (also the window: references reach back into it) plus room for a final match running past the end
        const out = new Uint8Array(length + 260);
        this.out = out;
        let pos = 0;
        const e8Frames = [];
        const numFrames = Math.ceil(length / FRAME_SIZE);
        for (let f = 0; f < numFrames; f++) {
            const frameStart = f * FRAME_SIZE;
            const frameEnd = Math.min(length, frameStart + FRAME_SIZE);
            if (frameOffsets && frameOffsets[f] != null) {
                if (frameOffsets[f] > end) throw new Error('LZX: reset table points past the compressed data');
                this._seek(frameOffsets[f]);
            }
            if (!this.headerRead) {
                if (this._read(1)) {
                    const hi = this._read(16);
                    const lo = this._read(16);
                    this.intelFilesize = ((hi << 16) | lo) >>> 0;
                }
                this.headerRead = true;
            }
            while (pos < frameEnd) {
                if (this.blockRemaining === 0) this._readBlockHeader();
                const run = Math.min(this.blockRemaining, frameEnd - pos);
                const startPos = pos;
                if (this.blockType === BLOCKTYPE_UNCOMPRESSED) {
                    if (this.ip + run > end) throw new Error('LZX: compressed data ends early (truncated file?)');
                    out.set(input.subarray(this.ip, this.ip + run), pos);
                    this.ip += run;
                    pos += run;
                } else {
                    pos = this._decodeRun(pos, pos + run, this.blockType === BLOCKTYPE_ALIGNED);
                }
                const done = pos - startPos;
                if (done > this.blockRemaining) throw new Error('LZX: match runs past the end of the block');
                this.blockRemaining -= done;
                // An odd-sized uncompressed block is padded to an even length
                if (this.blockRemaining === 0 && this.blockType === BLOCKTYPE_UNCOMPRESSED && (this.blockLength & 1)) this.ip++;
            }
            // Frames end on a 16-bit boundary
            if (this.bitsLeft > 0) this._ensure(16);
            if (this.bitsLeft & 15) this._read(this.bitsLeft & 15);
            const frameNo = (outOffset + frameStart) / FRAME_SIZE;
            if (this.intelFilesize && this.intelStarted && frameEnd - frameStart > 10 && frameNo < 32768) e8Frames.push([frameStart, frameEnd]);
        }
        this.out = null;
        this.input = null;
        const result = out.subarray(0, length);
        // Undo the x86 CALL translation; on a copy, as the history the matches read is untranslated
        if (e8Frames.length) {
            const copy = result.slice();
            for (const [a, b] of e8Frames) this._e8Translate(copy, a, b, outOffset + a);
            return copy;
        }
        return result;
    }

    _e8Translate(data, from, to, curpos) {
        const filesize = this.intelFilesize;
        const end = to - 10;
        for (let i = from; i < end;) {
            if (data[i++] !== 0xe8) { curpos++; continue; }
            const abs = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
            if (abs >= -curpos && abs < filesize) {
                const rel = abs >= 0 ? abs - curpos : abs + filesize;
                data[i] = rel & 0xff; data[i + 1] = (rel >>> 8) & 0xff; data[i + 2] = (rel >>> 16) & 0xff; data[i + 3] = (rel >>> 24) & 0xff;
            }
            i += 4;
            curpos += 5;
        }
    }

    // Decode literals and matches into out[pos..) until at least `until`; returns the new position
    _decodeRun(pos, until, aligned) {
        const out = this.out;
        const main = this.maintree;
        const lentree = this.lengthtree;
        const align = this.alignedtree;
        let R0 = this.R0, R1 = this.R1, R2 = this.R2;
        while (pos < until) {
            let el = this._sym(main);
            if (el < NUM_CHARS) {
                out[pos++] = el;
                continue;
            }
            el -= NUM_CHARS;
            let matchLength = el & NUM_PRIMARY_LENGTHS;
            if (matchLength === NUM_PRIMARY_LENGTHS) {
                if (lentree.empty) throw new Error('LZX: length tree used but empty');
                matchLength += this._sym(lentree);
            }
            matchLength += MIN_MATCH;
            let matchOffset = el >>> 3;
            if (matchOffset > 2) {
                if (aligned) {
                    let extra = matchOffset >= 36 ? 17 : EXTRA_BITS[matchOffset];
                    matchOffset = POSITION_BASE[matchOffset] - 2;
                    if (extra > 3) {
                        extra -= 3;
                        matchOffset += this._read(extra) << 3;
                        matchOffset += this._sym(align);
                    } else if (extra === 3) {
                        matchOffset += this._sym(align);
                    } else if (extra > 0) {
                        matchOffset += this._read(extra);
                    } else {
                        matchOffset = 1;
                    }
                } else if (matchOffset !== 3) {
                    const extra = EXTRA_BITS[matchOffset];
                    matchOffset = POSITION_BASE[matchOffset] - 2 + this._read(extra);
                } else {
                    matchOffset = 1;
                }
                R2 = R1; R1 = R0; R0 = matchOffset;
            } else if (matchOffset === 0) {
                matchOffset = R0;
            } else if (matchOffset === 1) {
                matchOffset = R1; R1 = R0; R0 = matchOffset;
            } else {
                matchOffset = R2; R2 = R0; R0 = matchOffset;
            }
            if (matchOffset > pos || matchOffset > this.windowSize) throw new Error('LZX: match offset out of range');
            if (pos + matchLength > out.length) throw new Error('LZX: match runs past the end of the output');
            let src = pos - matchOffset;
            for (let k = 0; k < matchLength; k++) out[pos++] = out[src++];
        }
        this.R0 = R0; this.R1 = R1; this.R2 = R2;
        return pos;
    }
}
