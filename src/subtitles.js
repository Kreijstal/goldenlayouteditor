// --- Subtitles for the video player ---
// Browsers show WebVTT given as a <track>, and nothing else: not SubRip, not
// SubStation Alpha, and (except Safari) not the subtitle tracks inside MP4 or
// Matroska files. So here, for a <video>:
// - subtitle files beside it (movie.srt, movie.en.vtt, movie.de.ass, …) and
//   ones opened by hand
// - subtitle tracks inside the file: MP4/MOV 3GPP timed text (tx3g, mov_text)
//   and WebVTT (wvtt), read from just their samples with Range requests;
//   Matroska/WebM S_TEXT/UTF8 (SubRip), S_TEXT/WEBVTT and S_TEXT/ASS/SSA,
//   read in one pass over the file, with the fonts attached to it
// SubRip, WebVTT and timed text become WebVTT <track>s; ASS/SSA is drawn by
// JASSUB (libass as WebAssembly, from a CDN) over the video, styled as meant,
// with the file's fonts. A CC menu over the video picks among them.
const { createLogger } = require('./debug');

const log = createLogger('Subtitles');

const JASSUB_VERSION = '2.5.16';
const JASSUB_URL = `https://esm.sh/jassub@${JASSUB_VERSION}`;
const JASSUB_WORKER_URL = `https://esm.sh/jassub@${JASSUB_VERSION}/dist/worker/worker.js`;
const JASSUB_FILES = `https://cdn.jsdelivr.net/npm/jassub@${JASSUB_VERSION}/dist`;
const SUB_RE = /\.(srt|vtt|ass|ssa)$/i;
const MAX_TRACK_TEXT = 32 * 1024 * 1024;

// --- Text formats ---

// "01:02:03,456" / "02:03.456" → seconds
function parseTime(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim());
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

function vttTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

// Cue text for WebVTT: its markup kept where WebVTT has it (<b> <i> <u>),
// everything else escaped; SubRip's <font> and {\an8}-style ASS tags dropped
function cueText(text) {
    return text
        .replace(/\r/g, '')
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/<\/?font[^>]*>/gi, '')
        .replace(/&(?!(amp|lt|gt|nbsp|lrm|rlm);)/g, '&amp;')
        .replace(/<(?!\/?[biu]>)/gi, '&lt;')
        .replace(/-->/g, '--&gt;')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

function cuesToVtt(cues) {
    let out = 'WEBVTT\n\n';
    for (const c of cues) {
        // Cues that are WebVTT already keep all of its markup (<c>, <v>, <ruby>, …)
        const text = c.vtt ? c.text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim() : cueText(c.text);
        if (!text || !(c.end > c.start)) continue;
        out += `${vttTime(c.start)} --> ${vttTime(c.end)}${c.settings ? ' ' + c.settings : ''}\n${text}\n\n`;
    }
    return out;
}

function parseSrt(text) {
    const cues = [];
    for (const block of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
        const lines = block.split('\n');
        const i = lines.findIndex(l => l.includes('-->'));
        if (i < 0) continue;
        const [a, b] = lines[i].split('-->');
        const start = parseTime(a), end = parseTime((b || '').trim().split(/\s+/)[0] || '');
        if (start === null || end === null) continue;
        cues.push({ start, end, text: lines.slice(i + 1).join('\n') });
    }
    return cues;
}

// ASS/SSA as plain cues, for when JASSUB can't run: the dialogue text without its styling
function parseAssPlain(text) {
    const cues = [];
    let format = null;
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const m = /^(Format|Dialogue):\s*(.*)$/.exec(line);
        if (!m) continue;
        if (m[1] === 'Format') { format = m[2].split(',').map(s => s.trim().toLowerCase()); continue; }
        if (!format) continue;
        const parts = m[2].split(',');
        const fields = parts.slice(0, format.length - 1).concat(parts.slice(format.length - 1).join(','));
        const get = k => fields[format.indexOf(k)];
        const start = parseTime(get('start') || ''), end = parseTime(get('end') || '');
        if (start === null || end === null) continue;
        cues.push({ start, end, text: (get('text') || '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ') });
    }
    return cues.sort((a, b) => a.start - b.start);
}

// A subtitle file's text → { kind: 'vtt', vtt } or { kind: 'ass', ass }
function fromFile(name, text) {
    text = text.replace(/^﻿/, '');
    if (/\.(ass|ssa)$/i.test(name) || /^\s*\[Script Info\]/i.test(text)) return { kind: 'ass', ass: text };
    if (/^WEBVTT/.test(text)) return { kind: 'vtt', vtt: text };
    return { kind: 'vtt', vtt: cuesToVtt(parseSrt(text)) };
}

const decodeText = bytes => {
    if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))) {
        return new TextDecoder(bytes[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(bytes.subarray(2));
    }
    return new TextDecoder().decode(bytes);
};

// --- Reading the video file ---

// Byte ranges of a URL (Range requests; a server without them sends it all once)
function rangeReader(url) {
    let whole = null, size = null;
    const read = async (start, end) => {
        if (whole) return whole.subarray(start, Math.min(end, whole.length));
        const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (resp.status !== 206) { whole = buf; size = buf.length; return buf.subarray(start, Math.min(end, buf.length)); }
        const cr = /\/(\d+)$/.exec(resp.headers.get('Content-Range') || '');
        if (cr) size = +cr[1];
        return buf;
    };
    return { read, size: () => size };
}

// --- MP4 / MOV ---

const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u64 = (b, p) => u32(b, p) * 2 ** 32 + u32(b, p + 4);

// The boxes in b[start, end): [{ type, start (of content), end }]
function boxes(b, start = 0, end = b.length) {
    const out = [];
    for (let p = start; p + 8 <= end;) {
        let size = u32(b, p), head = 8;
        const type = fourcc(b, p + 4);
        if (size === 1) { size = u64(b, p + 8); head = 16; } else if (size === 0) size = end - p;
        if (size < head) break;
        out.push({ type, start: p + head, end: Math.min(end, p + size) });
        p += size;
    }
    return out;
}
const child = (b, box, type) => boxes(b, box.start, box.end).find(x => x.type === type);
const path = (b, box, ...types) => types.reduce((x, t) => x && child(b, x, t), box);

const MP4_TEXT = { tx3g: 'tx3g', text: 'tx3g', wvtt: 'wvtt' };

// Subtitle tracks of an MP4, each with its samples ({ offset, size, time, duration } in seconds)
async function mp4Tracks(reader) {
    // Top-level boxes: the movie box, and fragments' headers
    const top = [];
    for (let p = 0; ;) {
        const h = await reader.read(p, p + 16);
        if (h.length < 8) break;
        let size = u32(h, 0), head = 8;
        if (size === 1) { size = u64(h, 8); head = 16; }
        const type = fourcc(h, 4);
        if (size === 0) size = (reader.size() || p + head) - p;
        if (size < head) break;
        top.push({ type, offset: p, size });
        p += size;
        if (reader.size() !== null && p >= reader.size()) break;
    }
    const moovBox = top.find(x => x.type === 'moov');
    if (!moovBox) return [];
    const moov = await reader.read(moovBox.offset, moovBox.offset + moovBox.size);
    const root = { start: 8, end: moov.length };

    const tracks = [];
    for (const trak of boxes(moov, root.start, root.end).filter(x => x.type === 'trak')) {
        const b = moov;
        const tkhd = child(b, trak, 'tkhd');
        const id = tkhd ? u32(b, tkhd.start + (b[tkhd.start] === 1 ? 20 : 12)) : 0;
        const mdia = child(b, trak, 'mdia');
        const hdlr = mdia && child(b, mdia, 'hdlr');
        const handler = hdlr ? fourcc(b, hdlr.start + 8) : '';
        if (!['text', 'sbtl', 'subt'].includes(handler)) continue;
        const mdhd = child(b, mdia, 'mdhd');
        const v1 = b[mdhd.start] === 1;
        const timescale = u32(b, mdhd.start + (v1 ? 20 : 12));
        const langBits = (b[mdhd.start + (v1 ? 32 : 20)] << 8) | b[mdhd.start + (v1 ? 33 : 21)];
        const language = langBits && langBits !== 0x7fff
            ? String.fromCharCode(((langBits >> 10) & 31) + 96, ((langBits >> 5) & 31) + 96, (langBits & 31) + 96) : '';
        const stbl = path(b, mdia, 'minf', 'stbl');
        const stsd = stbl && child(b, stbl, 'stsd');
        const format = stsd ? fourcc(b, stsd.start + 12) : '';
        const name = hdlr ? new TextDecoder().decode(b.subarray(hdlr.start + 24, hdlr.end)).replace(/\0.*$/s, '').trim() : '';
        const track = { id, language, format: MP4_TEXT[format] || null, codec: format, timescale, name, samples: [] };
        tracks.push(track);
        if (!stbl) continue;

        // Sample table: sizes, chunks and their offsets, and decode times
        const sizes = [];
        const stsz = child(b, stbl, 'stsz');
        if (stsz) {
            const fixed = u32(b, stsz.start + 4), count = u32(b, stsz.start + 8);
            for (let i = 0; i < count; i++) sizes.push(fixed || u32(b, stsz.start + 12 + 4 * i));
        }
        const chunkOffsets = [];
        const stco = child(b, stbl, 'stco'), co64 = child(b, stbl, 'co64');
        if (stco) for (let i = 0, n = u32(b, stco.start + 4); i < n; i++) chunkOffsets.push(u32(b, stco.start + 8 + 4 * i));
        if (co64) for (let i = 0, n = u32(b, co64.start + 4); i < n; i++) chunkOffsets.push(u64(b, co64.start + 8 + 8 * i));
        const stsc = child(b, stbl, 'stsc');
        const runs = [];
        if (stsc) for (let i = 0, n = u32(b, stsc.start + 4); i < n; i++) runs.push({ first: u32(b, stsc.start + 8 + 12 * i), per: u32(b, stsc.start + 12 + 12 * i) });
        const durations = [];
        const stts = child(b, stbl, 'stts');
        if (stts) for (let i = 0, n = u32(b, stts.start + 4); i < n; i++) {
            const count = u32(b, stts.start + 8 + 8 * i), delta = u32(b, stts.start + 12 + 8 * i);
            for (let k = 0; k < count; k++) durations.push(delta);
        }
        let s = 0, t = 0;
        for (let c = 0; c < chunkOffsets.length; c++) {
            let per = 0;
            for (const r of runs) if (r.first <= c + 1) per = r.per;
            let off = chunkOffsets[c];
            for (let k = 0; k < per && s < sizes.length; k++, s++) {
                const d = durations[s] || 0;
                track.samples.push({ offset: off, size: sizes[s], time: t / timescale, duration: d / timescale });
                off += sizes[s];
                t += d;
            }
        }
    }
    if (!tracks.length) return tracks;

    // Fragments (moof): each track's samples in its track fragment runs
    const trex = {};
    const mvex = child(moov, root, 'mvex');
    if (mvex) for (const x of boxes(moov, mvex.start, mvex.end).filter(x => x.type === 'trex')) {
        trex[u32(moov, x.start + 4)] = { duration: u32(moov, x.start + 12), size: u32(moov, x.start + 16) };
    }
    const byId = Object.fromEntries(tracks.map(t => [t.id, t]));
    const decodeTime = {};
    for (const mf of top.filter(x => x.type === 'moof')) {
        const b = await reader.read(mf.offset, mf.offset + mf.size);
        for (const traf of boxes(b, 8, b.length).filter(x => x.type === 'traf')) {
            const tfhd = child(b, traf, 'tfhd');
            const flags = u32(b, tfhd.start) & 0xffffff;
            const id = u32(b, tfhd.start + 4);
            const track = byId[id];
            if (!track) continue;
            let p = tfhd.start + 8;
            let base = mf.offset; // default-base-is-moof, or the moof when nothing is said
            if (flags & 1) { base = u64(b, p); p += 8; }
            if (flags & 2) p += 4;
            let defDuration = (trex[id] || {}).duration || 0, defSize = (trex[id] || {}).size || 0;
            if (flags & 8) { defDuration = u32(b, p); p += 4; }
            if (flags & 0x10) { defSize = u32(b, p); p += 4; }
            const tfdt = child(b, traf, 'tfdt');
            let t = tfdt ? (b[tfdt.start] === 1 ? u64(b, tfdt.start + 4) : u32(b, tfdt.start + 4)) : (decodeTime[id] || 0);
            for (const trun of boxes(b, traf.start, traf.end).filter(x => x.type === 'trun')) {
                const tf = u32(b, trun.start) & 0xffffff;
                const count = u32(b, trun.start + 4);
                let q = trun.start + 8;
                let off = base;
                if (tf & 1) { off = base + (u32(b, q) | 0); q += 4; }
                if (tf & 4) q += 4;
                for (let i = 0; i < count; i++) {
                    let d = defDuration, sz = defSize;
                    if (tf & 0x100) { d = u32(b, q); q += 4; }
                    if (tf & 0x200) { sz = u32(b, q); q += 4; }
                    if (tf & 0x400) q += 4;
                    if (tf & 0x800) q += 4;
                    track.samples.push({ offset: off, size: sz, time: t / track.timescale, duration: d / track.timescale });
                    off += sz;
                    t += d;
                }
            }
            decodeTime[id] = t;
        }
    }
    return tracks;
}

// The cues of an MP4 text track, reading its samples (nearby ones together)
async function mp4Cues(reader, track) {
    const samples = track.samples.filter(s => s.size > 2).sort((a, b) => a.offset - b.offset);
    const groups = [];
    for (const s of samples) {
        const g = groups[groups.length - 1];
        if (g && s.offset - g.end < 65536 && s.offset + s.size - g.start < 4 * 1024 * 1024) { g.end = Math.max(g.end, s.offset + s.size); g.samples.push(s); } else groups.push({ start: s.offset, end: s.offset + s.size, samples: [s] });
    }
    const cues = [];
    for (const g of groups) {
        const buf = await reader.read(g.start, g.end);
        for (const s of g.samples) {
            const data = buf.subarray(s.offset - g.start, s.offset - g.start + s.size);
            const start = s.time, end = s.time + s.duration;
            if (track.format === 'tx3g') {
                // 3GPP timed text (3GPP TS 26.245): a 16-bit length, the text (UTF-8, or
                // UTF-16 with a BOM), then boxes; styl gives bold/italic/underline by character range
                const len = (data[0] << 8) | data[1];
                if (!len) continue;
                const chars = Array.from(decodeText(data.subarray(2, 2 + len)));
                const styl = boxes(data, 2 + len).find(x => x.type === 'styl');
                if (styl) {
                    const open = chars.map(() => ''), close = chars.map(() => '');
                    const n = (data[styl.start] << 8) | data[styl.start + 1];
                    for (let i = 0; i < n; i++) {
                        const q = styl.start + 2 + 12 * i;
                        if (q + 12 > styl.end) break;
                        const from = (data[q] << 8) | data[q + 1], to = Math.min(chars.length, (data[q + 2] << 8) | data[q + 3]);
                        const face = data[q + 6];
                        if (from >= to) continue;
                        const tags = ['b', 'i', 'u'].filter((_, k) => face & (1 << k));
                        for (const t of tags) { open[from] += `<${t}>`; close[to - 1] = `</${t}>` + close[to - 1]; }
                    }
                    cues.push({ start, end, text: chars.map((c, i) => open[i] + c + close[i]).join('') });
                } else cues.push({ start, end, text: chars.join('') });
            } else {
                // WebVTT in MP4 (ISO/IEC 14496-30): vttc boxes, each a cue: text (payl), settings (sttg)
                for (const c of boxes(data).filter(x => x.type === 'vttc')) {
                    const payl = child(data, c, 'payl'), sttg = child(data, c, 'sttg');
                    if (!payl) continue;
                    cues.push({
                        start, end, vtt: true,
                        text: new TextDecoder().decode(data.subarray(payl.start, payl.end)),
                        settings: sttg ? new TextDecoder().decode(data.subarray(sttg.start, sttg.end)).trim() : '',
                    });
                }
            }
        }
    }
    return cues.sort((a, b) => a.start - b.start);
}

// --- Matroska / WebM ---

const MKV = {
    EBML: 0x1a45dfa3, Segment: 0x18538067, Cluster: 0x1f43b675, Timestamp: 0xe7, BlockGroup: 0xa0, Block: 0xa1,
    SimpleBlock: 0xa3, BlockDuration: 0x9b, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Tracks: 0x1654ae6b,
    TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Language: 0x22b59c,
    LanguageBCP47: 0x22b59d, Name: 0x536e, FlagDefault: 0x88, FlagForced: 0x55aa, DefaultDuration: 0x23e383,
    Attachments: 0x1941a469, AttachedFile: 0x61a7, FileName: 0x466e, FileMimeType: 0x4660, FileData: 0x465c,
    Cues: 0x1c53bb6b, Tags: 0x1254c367, Chapters: 0x1043a770, BlockAdditions: 0x75a1, BlockMore: 0xa6,
    BlockAdditional: 0xa5,
};
const MKV_TEXT = {
    'S_TEXT/UTF8': 'srt', 'S_TEXT/ASCII': 'srt', 'S_TEXT/WEBVTT': 'vtt', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ass',
    // WebM's WebVTT
    'D_WEBVTT/SUBTITLES': 'vtt', 'D_WEBVTT/CAPTIONS': 'vtt', 'D_WEBVTT/DESCRIPTIONS': 'vtt',
};

// The children of an element's content: [{ id, data }]
function ebmlChildren(b) {
    const out = [];
    for (let p = 0; p < b.length;) {
        const id = vint(b, p, true);
        if (!id) break;
        const size = vint(b, p + id.len, false);
        if (!size) break;
        const start = p + id.len + size.len;
        const end = size.unknown ? b.length : Math.min(b.length, start + size.value);
        out.push({ id: id.value, data: b.subarray(start, end) });
        p = end;
    }
    return out;
}

// An EBML variable-length integer at b[p]: { value, len, unknown }; an ID keeps its marker bit
function vint(b, p, keepMarker) {
    if (p >= b.length) return null;
    const first = b[p];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || p + len > b.length) return null;
    let value = keepMarker ? first : first & (0xff >> len);
    let allOnes = value === (0xff >> len);
    for (let i = 1; i < len; i++) {
        value = value * 256 + b[p + i];
        if (b[p + i] !== 0xff) allOnes = false;
    }
    return { value, len, unknown: !keepMarker && allOnes };
}

const ebmlUint = b => { let v = 0; for (const x of b) v = v * 256 + x; return v; };
const ebmlString = b => new TextDecoder().decode(b).replace(/\0+$/, '');

// Reads a stream sequentially, a piece at a time
function streamReader(body) {
    const reader = body.getReader();
    let buf = new Uint8Array(0), done = false, pos = 0; // pos: file offset of buf[0]
    // Reads until n bytes are buffered, joining the pieces once
    const fill = async n => {
        if (buf.length >= n || done) return buf.length >= n;
        const pieces = [buf];
        let total = buf.length;
        while (total < n) {
            const { value, done: d } = await reader.read();
            if (d) { done = true; break; }
            pieces.push(value);
            total += value.length;
        }
        buf = new Uint8Array(total);
        let at = 0;
        for (const x of pieces) { buf.set(x, at); at += x.length; }
        return buf.length >= n;
    };
    return {
        get pos() { return pos; },
        async peek(n) { await fill(n); return buf.subarray(0, Math.min(n, buf.length)); },
        async take(n) { await fill(n); const out = buf.slice(0, n); buf = buf.subarray(Math.min(n, buf.length)); pos += out.length; return out; },
        async skip(n) {
            while (n > 0) {
                if (!buf.length && !(await fill(1))) return;
                const k = Math.min(n, buf.length);
                buf = buf.subarray(k); pos += k; n -= k;
            }
        },
        cancel() { reader.cancel().catch(() => {}); },
    };
}

// Subtitle tracks, their blocks and the attached fonts of a Matroska file,
// in one pass: only subtitle blocks are kept, the rest is skipped over
async function mkvScan(url, onTracks) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const r = streamReader(resp.body);
    let scale = 1000000;
    const tracks = {};
    const fonts = [];
    let clusterTime = 0;
    let wanted = null; // track numbers to keep, once Tracks is read
    const containers = new Set([MKV.Segment, MKV.Cluster, MKV.BlockGroup]);
    const stack = []; // ends of the containers we are in: { id, end }
    let group = null;
    const addBlock = (data, duration, additional) => {
        const tn = vint(data, 0, false);
        const track = tn && tracks[tn.value];
        if (!track) return;
        const rel = ((data[tn.len] << 8) | data[tn.len + 1]) << 16 >> 16;
        const start = (clusterTime + rel) * scale / 1e9;
        const dur = duration !== null ? duration * scale / 1e9 : track.defaultDuration ? track.defaultDuration / 1e9 : null;
        track.blocks.push({ start, end: dur !== null ? start + dur : null, payload: data.subarray(tn.len + 3), additional });
    };
    const finishGroup = () => {
        if (group && group.block) addBlock(group.block, group.duration, group.additional);
        group = null;
    };
    try {
        for (;;) {
            while (stack.length && r.pos >= stack[stack.length - 1].end) {
                if (stack.pop().id === MKV.BlockGroup) finishGroup();
            }
            const head = await r.peek(12);
            if (head.length < 2) break;
            const id = vint(head, 0, true), size = id && vint(head, id.len, false);
            if (!id || !size) break;
            await r.skip(id.len + size.len);
            const len = size.unknown ? Infinity : size.value;
            if (containers.has(id.value)) {
                if (id.value === MKV.Cluster) {
                    // A cluster closes whatever cluster was open (they may have unknown sizes)
                    while (stack.length && stack[stack.length - 1].id !== MKV.Segment) stack.pop();
                    if (wanted && !wanted.size) break; // no subtitles, and fonts come before clusters
                }
                if (id.value === MKV.BlockGroup) group = { block: null, duration: null, additional: null };
                stack.push({ id: id.value, end: r.pos + len });
                continue;
            }
            const keep = [MKV.Info, MKV.Tracks, MKV.Attachments, MKV.Timestamp, MKV.BlockDuration].includes(id.value)
                || (id.value === MKV.BlockAdditions && group && group.block)
                || ((id.value === MKV.SimpleBlock || id.value === MKV.Block) && wanted && wanted.size);
            if (!keep || len === Infinity) { if (len !== Infinity) await r.skip(len); continue; }
            if (id.value === MKV.SimpleBlock || id.value === MKV.Block) {
                // The track number first: skip other tracks' blocks unread
                const tn = vint(await r.peek(8), 0, false);
                if (!tn || !wanted.has(tn.value)) { await r.skip(len); continue; }
            }
            const data = await r.take(len);
            switch (id.value) {
                case MKV.Timestamp: clusterTime = ebmlUint(data); break;
                case MKV.BlockDuration: if (group) group.duration = ebmlUint(data); break;
                case MKV.SimpleBlock: addBlock(data, null); break;
                case MKV.Block: if (group) group.block = data; break;
                case MKV.BlockAdditions:
                    // WebM WebVTT: the cue settings, a line feed, the cue's identifier
                    for (const m of ebmlChildren(data).filter(c => c.id === MKV.BlockMore)) {
                        const a = ebmlChildren(m.data).find(c => c.id === MKV.BlockAdditional);
                        if (a) group.additional = ebmlString(a.data);
                    }
                    break;
                case MKV.Info:
                    for (const c of ebmlChildren(data)) if (c.id === MKV.TimestampScale) scale = ebmlUint(c.data);
                    break;
                case MKV.Tracks:
                    for (const e of ebmlChildren(data).filter(c => c.id === MKV.TrackEntry)) {
                        const f = {};
                        for (const c of ebmlChildren(e.data)) f[c.id] = c.data;
                        const codec = f[MKV.CodecID] ? ebmlString(f[MKV.CodecID]) : '';
                        if (!f[MKV.TrackType] || ebmlUint(f[MKV.TrackType]) !== 0x11) continue; // subtitle
                        const n = ebmlUint(f[MKV.TrackNumber]);
                        tracks[n] = {
                            number: n, codec, format: MKV_TEXT[codec] || null,
                            language: f[MKV.LanguageBCP47] ? ebmlString(f[MKV.LanguageBCP47]) : f[MKV.Language] ? ebmlString(f[MKV.Language]) : 'eng',
                            name: f[MKV.Name] ? ebmlString(f[MKV.Name]) : '',
                            isDefault: f[MKV.FlagDefault] ? !!ebmlUint(f[MKV.FlagDefault]) : true,
                            forced: f[MKV.FlagForced] ? !!ebmlUint(f[MKV.FlagForced]) : false,
                            codecPrivate: f[MKV.CodecPrivate] ? ebmlString(f[MKV.CodecPrivate]) : '',
                            defaultDuration: f[MKV.DefaultDuration] ? ebmlUint(f[MKV.DefaultDuration]) : 0,
                            blocks: [],
                        };
                    }
                    wanted = new Set(Object.values(tracks).filter(t => t.format).map(t => t.number));
                    onTracks(Object.values(tracks));
                    break;
                case MKV.Attachments:
                    for (const a of ebmlChildren(data).filter(c => c.id === MKV.AttachedFile)) {
                        const f = {};
                        for (const c of ebmlChildren(a.data)) f[c.id] = c.data;
                        const fname = f[MKV.FileName] ? ebmlString(f[MKV.FileName]) : '';
                        const mime = f[MKV.FileMimeType] ? ebmlString(f[MKV.FileMimeType]) : '';
                        if (f[MKV.FileData] && (/font|truetype|opentype|sfnt|woff/i.test(mime) || /\.(ttf|otf|ttc|woff2?)$/i.test(fname))) {
                            fonts.push({ name: fname, data: new Uint8Array(f[MKV.FileData]) });
                        }
                    }
                    break;
            }
        }
        finishGroup();
    } finally {
        r.cancel();
    }
    return { tracks: Object.values(tracks), fonts };
}

// A Matroska subtitle track's content: WebVTT, or a whole ASS script
function mkvTrackContent(track) {
    const blocks = track.blocks.slice().sort((a, b) => a.start - b.start);
    // Blocks without a duration last until the next one
    blocks.forEach((b, i) => { if (b.end === null) b.end = i + 1 < blocks.length ? blocks[i + 1].start : b.start + 5; });
    if (track.format === 'ass') {
        // Block: ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text; the
        // header (with its [Events] Format line) is the codec private data
        const assTime = t => {
            const cs = Math.max(0, Math.round(t * 100));
            return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
        };
        const lines = blocks.map(b => {
            const text = new TextDecoder().decode(b.payload);
            const parts = text.split(',');
            const order = +parts[0];
            return { order, line: `Dialogue: ${parts[1]},${assTime(b.start)},${assTime(b.end)},${parts.slice(2).join(',')}` };
        }).sort((a, b) => a.order - b.order).map(x => x.line);
        let header = track.codecPrivate.replace(/\r\n?/g, '\n').trimEnd();
        if (!/\[Events\]/i.test(header)) header += '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
        return { kind: 'ass', ass: header + '\n' + lines.join('\n') + '\n' };
    }
    const cues = blocks.map(b => {
        const text = new TextDecoder().decode(b.payload);
        if (track.format !== 'vtt') return { start: b.start, end: b.end, text };
        // WebVTT: S_TEXT/WEBVTT blocks are "identifier\nsettings\ntext" (and so is what
        // ffmpeg writes to WebM); WebM's D_WEBVTT has the text alone, with
        // "settings\nidentifier" in a block addition
        const lines = text.split('\n');
        const settingsLine = /^\s*((line|position|size|align|region|vertical):\S+\s*)*$/;
        if (track.codec === 'S_TEXT/WEBVTT' || (!b.additional && lines.length >= 3 && settingsLine.test(lines[1]) && !lines[0].includes('-->'))) {
            return { start: b.start, end: b.end, vtt: true, settings: lines[1].trim(), text: lines.slice(2).join('\n') };
        }
        return { start: b.start, end: b.end, vtt: true, settings: b.additional ? b.additional.split('\n')[0].trim() : '', text };
    });
    return { kind: 'vtt', vtt: cuesToVtt(cues) };
}

// --- ASS rendering ---

let jassubModule = null;
function loadJassub() {
    if (!jassubModule) {
        jassubModule = import(JASSUB_URL).then(m => m.default || m).catch(err => { jassubModule = null; throw err; });
    }
    return jassubModule;
}

let workerUrl = null;
function jassubWorkerUrl() {
    // Workers must come from this origin: a module worker here that imports
    // JASSUB's. Its libass starts threads as workers of their own, from a file
    // beside it (which esm.sh doesn't have); so first a shim that makes any
    // worker it asks for this origin's, importing the real file from jsDelivr.
    if (!workerUrl) {
        const shim = `const Native = globalThis.Worker;
globalThis.Worker = function (url, opts) {
    let u = new URL(String(url), self.location.href).href;
    if (/jassub-worker\\.m?js/.test(u)) u = ${JSON.stringify(`${JASSUB_FILES}/wasm/jassub-worker.js`)};
    if (!u.startsWith('blob:')) u = URL.createObjectURL(new Blob(['import ' + JSON.stringify(u) + ';'], { type: 'text/javascript' }));
    return new Native(u, opts);
};
`;
        const shimUrl = URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
        workerUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(shimUrl)};\nimport ${JSON.stringify(JASSUB_WORKER_URL)};\n`], { type: 'text/javascript' }));
    }
    return workerUrl;
}

// --- The player's subtitles ---

const LANGUAGES = {
    eng: 'English', en: 'English', deu: 'German', ger: 'German', de: 'German', fra: 'French', fre: 'French', fr: 'French',
    spa: 'Spanish', es: 'Spanish', ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese', por: 'Portuguese', pt: 'Portuguese',
    rus: 'Russian', ru: 'Russian', zho: 'Chinese', chi: 'Chinese', zh: 'Chinese', kor: 'Korean', ko: 'Korean', nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
    pol: 'Polish', pl: 'Polish', swe: 'Swedish', sv: 'Swedish', ara: 'Arabic', ar: 'Arabic', tur: 'Turkish', tr: 'Turkish',
};
const CODECS = {
    tx3g: 'timed text', text: 'timed text', wvtt: 'WebVTT', stpp: 'TTML', 'S_TEXT/UTF8': 'SRT', 'S_TEXT/ASCII': 'SRT',
    'S_TEXT/WEBVTT': 'WebVTT', 'D_WEBVTT/SUBTITLES': 'WebVTT', 'D_WEBVTT/CAPTIONS': 'WebVTT', 'D_WEBVTT/DESCRIPTIONS': 'WebVTT',
    'S_TEXT/ASS': 'ASS', 'S_TEXT/SSA': 'SSA', 'S_HDMV/PGS': 'PGS (picture)', 'S_VOBSUB': 'VobSub (picture)', 'S_DVBSUB': 'DVB (picture)',
};
const codecName = c => CODECS[c] || c;
const languageName = code => LANGUAGES[(code || '').toLowerCase()] || code || '';

let styleInstalled = false;
function installStyles() {
    if (styleInstalled) return;
    styleInstalled = true;
    const style = document.createElement('style');
    style.textContent = `
.subs-wrap{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-width:0;min-height:0}
.subs-wrap video{max-width:100%;max-height:100%;display:block}
.subs-cc{position:absolute;top:8px;right:8px;z-index:3;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.subs-cc>button{background:rgba(0,0,0,.65);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:4px;padding:3px 8px;cursor:pointer;font:inherit;opacity:.55;transition:opacity .15s}
.subs-wrap:hover .subs-cc>button,.subs-cc.open>button,.subs-cc>button.on{opacity:1}
.subs-cc>button.on{border-color:#fff}
.subs-menu{position:absolute;right:0;top:calc(100% + 4px);min-width:220px;max-width:340px;max-height:60vh;overflow:auto;background:rgba(20,22,26,.96);color:#e6edf3;border:1px solid #444c56;border-radius:6px;padding:4px 0;box-shadow:0 6px 20px rgba(0,0,0,.5)}
.subs-menu[hidden]{display:none}
.subs-menu .h{padding:6px 12px 2px;color:#8b949e;font-size:11px;text-transform:uppercase}
.subs-menu button{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;background:none;border:none;color:inherit;padding:5px 12px;cursor:pointer;font:inherit}
.subs-menu button:hover{background:#30363d}
.subs-menu button.sel::before{content:'✓';width:12px}
.subs-menu button:not(.sel)::before{content:'';width:12px}
.subs-menu button:disabled{color:#6e7681;cursor:default;background:none}
.subs-menu .meta{margin-left:auto;color:#8b949e;font-size:11px;white-space:nowrap}
.subs-note{padding:4px 12px;color:#8b949e;font-size:11px}
${['white', 'lime', 'cyan', 'red', 'yellow', 'magenta', 'blue', 'black'].map(c => `.subs-wrap video::cue(.${c}){color:${c}}.subs-wrap video::cue(.bg_${c}){background-color:${c}}`).join('')}
`;
    document.head.appendChild(style);
}

// Puts the video in a wrapper with a CC menu and finds its subtitles.
// opts: { url, name, siblings: [{ name, url: () => Promise<string> }] }
// Returns { element (the wrapper, in place of the video), destroy() }
function attachSubtitles(video, opts) {
    installStyles();
    const wrap = document.createElement('div');
    wrap.className = 'subs-wrap';
    wrap.appendChild(video);
    const cc = document.createElement('div');
    cc.className = 'subs-cc';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'CC';
    button.title = 'Subtitles';
    const menu = document.createElement('div');
    menu.className = 'subs-menu';
    menu.hidden = true;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.srt,.vtt,.ass,.ssa,text/vtt';
    fileInput.hidden = true;
    cc.append(button, menu, fileInput);
    wrap.appendChild(cc);

    const entries = []; // { id, label, meta, group, load: () => Promise<content>, content, trackEl, error }
    let selected = null, assRenderer = null, destroyed = false, scanning = null, nextId = 1, chosenByUser = false;
    const stem = opts.name.replace(/\.[^.]+$/, '');

    const render = () => {
        menu.innerHTML = '';
        const item = (label, meta, isSel, onClick, disabled) => {
            const b = document.createElement('button');
            b.type = 'button';
            if (isSel) b.className = 'sel';
            b.append(document.createTextNode(label));
            if (meta) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = meta; b.appendChild(m); }
            b.disabled = !!disabled;
            b.addEventListener('click', () => { closeMenu(); onClick(); });
            menu.appendChild(b);
        };
        item('Off', '', selected === null, () => { chosenByUser = true; select(null); });
        for (const group of ['Beside the video', 'In the video', 'Opened']) {
            const list = entries.filter(e => e.group === group);
            if (!list.length) continue;
            const h = document.createElement('div');
            h.className = 'h';
            h.textContent = group;
            menu.appendChild(h);
            for (const e of list) item(e.label, e.error ? 'failed' : e.meta, selected === e, () => { chosenByUser = true; select(e); }, !!e.unsupported);
        }
        if (scanning) {
            const n = document.createElement('div');
            n.className = 'subs-note';
            n.textContent = scanning;
            menu.appendChild(n);
        }
        item('Open subtitle file…', '.srt .vtt .ass', false, () => fileInput.click());
        button.classList.toggle('on', selected !== null);
        button.textContent = selected ? 'CC ●' : 'CC';
    };

    const add = e => {
        e.id = nextId++;
        entries.push(e);
        render();
        return e;
    };

    const drawAss = () => {
        if (!assRenderer || !video.videoWidth) return;
        assRenderer.manualRender({ mediaTime: video.currentTime, width: video.videoWidth, height: video.videoHeight, expectedDisplayTime: performance.now() })
            .catch(() => {});
    };
    video.addEventListener('seeked', drawAss);

    const clearShown = async () => {
        for (const e of entries) if (e.trackEl) e.trackEl.track.mode = 'disabled';
        if (assRenderer) {
            const r = assRenderer;
            assRenderer = null;
            try { await r.destroy(); } catch { /* already gone */ }
        }
    };

    async function select(e) {
        selected = e;
        render();
        await clearShown();
        if (!e) return;
        try {
            if (!e.content) e.content = await e.load();
            if (selected !== e || destroyed) return;
            if (e.content.kind === 'ass') {
                try {
                    const JASSUB = await loadJassub();
                    if (selected !== e || destroyed) return;
                    assRenderer = new JASSUB({
                        video,
                        subContent: e.content.ass,
                        workerUrl: jassubWorkerUrl(),
                        wasmUrl: `${JASSUB_FILES}/wasm/jassub-worker.wasm`,
                        modernWasmUrl: `${JASSUB_FILES}/wasm/jassub-worker-modern.wasm`,
                        availableFonts: { 'liberation sans': `${JASSUB_FILES}/default.woff2` },
                        fonts: (e.content.fonts || []).map(f => f.data),
                    });
                    await assRenderer.ready;
                    // JASSUB draws on each frame the video presents; a paused video
                    // that is sought may present none, so draw then too
                    drawAss();
                    return;
                } catch (err) {
                    // No libass: the words at least, as plain WebVTT
                    log.warn('JASSUB failed, showing ASS as plain text:', err);
                    e.meta = 'plain text: ' + (err.message || err);
                    e.content = { kind: 'vtt', vtt: cuesToVtt(parseAssPlain(e.content.ass)) };
                }
            }
            if (!e.trackEl) {
                const t = document.createElement('track');
                t.kind = 'subtitles';
                t.label = e.label;
                if (e.language) t.srclang = e.language;
                t.src = URL.createObjectURL(new Blob([e.content.vtt], { type: 'text/vtt' }));
                video.appendChild(t);
                e.trackEl = t;
            }
            e.trackEl.track.mode = 'showing';
        } catch (err) {
            log.warn('Subtitle track failed:', err);
            e.error = err.message || String(err);
            if (selected === e) selected = null;
        }
        render();
    }

    // The first one found, unless the viewer chose already: one beside the
    // video, else the file's default track
    const autoSelect = e => {
        if (chosenByUser || selected || e.unsupported) return;
        if (e.group === 'Beside the video' || e.isDefault) select(e);
    };

    button.addEventListener('click', ev => { ev.stopPropagation(); menu.hidden = !menu.hidden; cc.classList.toggle('open', !menu.hidden); });
    menu.addEventListener('click', ev => ev.stopPropagation());
    const closeMenu = () => { menu.hidden = true; cc.classList.remove('open'); };
    document.addEventListener('click', closeMenu);
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!f) return;
        const text = await f.text();
        chosenByUser = true;
        select(add({ label: f.name, meta: f.name.split('.').pop().toUpperCase(), group: 'Opened', load: async () => fromFile(f.name, text) }));
    });

    // Files beside the video: stem.srt, stem.en.vtt, stem.forced.de.ass, …
    for (const s of opts.siblings || []) {
        if (!SUB_RE.test(s.name) || !s.name.toLowerCase().startsWith(stem.toLowerCase() + '.')) continue;
        const middle = s.name.replace(SUB_RE, '').slice(stem.length + 1);
        const language = middle.split('.').find(p => /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(p)) || '';
        const label = middle ? `${languageName(language) || middle}${language && middle !== language ? ` (${middle})` : ''}` : s.name;
        const e = add({
            label, language, group: 'Beside the video', meta: s.name.split('.').pop().toUpperCase(),
            load: async () => {
                const resp = await fetch(await s.url());
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return fromFile(s.name, await resp.text());
            },
        });
        autoSelect(e);
    }

    // Tracks inside the file
    (async () => {
        const head = await rangeReader(opts.url).read(0, 12).catch(() => null);
        if (!head || destroyed) return;
        const isMkv = u32(head, 0) === MKV.EBML;
        const isMp4 = ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(fourcc(head, 4));
        if (!isMkv && !isMp4) return;
        scanning = 'Looking for subtitles in the file…';
        render();
        try {
            if (isMp4) {
                const reader = rangeReader(opts.url);
                const tracks = await mp4Tracks(reader);
                tracks.forEach((t, i) => {
                    const lang = t.language && t.language !== 'und' ? t.language : '';
                    const e = add({
                        label: `${languageName(lang) || `Track ${i + 1}`}${t.name && !/handler/i.test(t.name) ? ` — ${t.name}` : ''}`,
                        language: lang, group: 'In the video', meta: codecName(t.codec), isDefault: i === 0,
                        unsupported: !t.format,
                        load: async () => ({ kind: 'vtt', vtt: cuesToVtt(await mp4Cues(reader, t)) }),
                    });
                    autoSelect(e);
                });
            } else {
                const found = {};
                const scan = mkvScan(opts.url, tracks => {
                    scanning = tracks.some(t => t.format) ? 'Reading subtitles from the file…' : null;
                    tracks.forEach((t, i) => {
                        found[t.number] = add({
                            label: `${languageName(t.language) || `Track ${i + 1}`}${t.name ? ` — ${t.name}` : ''}${t.forced ? ' (forced)' : ''}`,
                            language: t.language, group: 'In the video', meta: codecName(t.codec),
                            unsupported: !t.format, isDefault: t.isDefault,
                            load: () => scan.then(r => {
                                const track = r.tracks.find(x => x.number === t.number);
                                if (track.blocks.length * 64 > MAX_TRACK_TEXT) throw new Error('too big');
                                return { ...mkvTrackContent(track), fonts: r.fonts };
                            }),
                        });
                    });
                    render();
                });
                scan.then(r => {
                    for (const t of r.tracks) if (found[t.number]) autoSelect(found[t.number]);
                }).catch(() => {});
                await scan;
            }
        } catch (err) {
            log.warn('Could not read subtitle tracks:', err);
        }
        scanning = null;
        if (!destroyed) render();
    })();

    render();
    return {
        element: wrap,
        destroy() {
            destroyed = true;
            document.removeEventListener('click', closeMenu);
            video.removeEventListener('seeked', drawAss);
            clearShown();
            for (const e of entries) if (e.trackEl) URL.revokeObjectURL(e.trackEl.src);
        },
    };
}

module.exports = { attachSubtitles, parseSrt, cuesToVtt, fromFile, parseAssPlain, mp4Tracks, mp4Cues, mkvScan, mkvTrackContent, rangeReader };
