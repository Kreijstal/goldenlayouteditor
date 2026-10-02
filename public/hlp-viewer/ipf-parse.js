// OS/2 Information Presentation Facility help (.hlp/.inf, magic "HSP"), read
// as text: the title, the table of contents (topics and their levels), the
// index, and each topic's words from the global and local dictionaries with
// paragraphs, line breaks, examples (monospace), margins, emphasis, colours
// and cross references. Bitmaps (LZW-packed OS/2 bitmaps) are placeholders.
// Written from "OS/2 2.0 Information Presentation Facility (IPF) Data Format"
// (inf03.txt, by Carl Hauser, Marcus Groeber and Peter Childs).

// Code page 850, the usual one for western OS/2 documents
const CP850_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
const CP437_LOW = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼';
function cp850(bytes) {
    let s = '';
    for (const b of bytes) s += b >= 128 ? CP850_HIGH[b - 128] : b < 32 && b ? CP437_LOW[b] : String.fromCharCode(b);
    return s;
}

const COLORS = { 1: '#0000c0', 2: '#c00000', 3: '#c000c0', 4: '#008000', 5: '#008080', 6: '#a08000', 7: '#606060' };
const HP_COLORS = { 1: '#0060ff', 2: '#c00000', 3: '#c000c0' };

class IpfError extends Error {}
const fail = m => { throw new IpfError(m); };

export function parseIpf(bytes) {
    const b = bytes;
    const u8 = o => { if (o < 0 || o >= b.length) fail(`read past the end of the file (offset ${o})`); return b[o]; };
    const u16 = o => u8(o) | (u8(o + 1) << 8);
    const u32 = o => (u16(o) | (u16(o + 2) << 16)) >>> 0;
    if (b.length < 155) fail('the file is too short for an OS/2 help header');
    if (b[0] !== 0x48 || b[1] !== 0x53 || b[2] !== 0x50) fail('not an OS/2 help file');
    const h = {
        flags: u8(3), hdrsize: u16(4), ntoc: u16(8), tocstart: u32(18), nres: u16(22), resstart: u32(24),
        nindex: u16(34), indexstart: u32(36), indexlen: u32(40), nslots: u16(62), slotsstart: u32(64),
        dictlen: u32(68), ndict: u16(72), dictstart: u32(74), imgstart: u32(78),
    };
    const warnings = [];
    const title = cp850(b.subarray(107, 155)).replace(/\0.*$/s, '').trim();

    // global dictionary: length-prefixed strings, the length counting itself
    const dict = [];
    for (let i = 0, p = h.dictstart; i < h.ndict; i++) {
        const len = u8(p);
        if (!len) { warnings.push('The dictionary is damaged.'); break; }
        dict.push(cp850(b.subarray(p + 1, Math.min(b.length, p + len))));
        p += len;
    }

    const topics = [];
    for (let i = 0; i < h.ntoc; i++) {
        let p = u32(h.tocstart + i * 4);
        const start = p;
        const len = u8(p), flags = u8(p + 1), nslots = u8(p + 2);
        p += 3;
        if (flags & 0x20) {
            const w1 = u8(p), w2 = u8(p + 1);
            p += 2;
            if (w1 & 0x1) p += 5;
            if (w1 & 0x2) p += 5;
            if (w1 & 0x8) p += 2;
            if (w2 & 0x4) p += 2;
        }
        const slots = [];
        for (let k = 0; k < nslots; k++) { slots.push(u16(p)); p += 2; }
        const end = Math.min(b.length, start + len);
        topics.push({
            index: i, level: flags & 0x0F, hasChildren: !!(flags & 0x80), visible: !(flags & 0x40),
            slots, title: p < end ? cp850(b.subarray(p, end)).trim() : '',
        });
    }
    if (!topics.length) fail('the table of contents is empty');

    const slotOffsets = [];
    for (let i = 0; i < h.nslots; i++) slotOffsets.push(u32(h.slotsstart + i * 4));

    const index = [];
    try {
        for (let i = 0, p = h.indexstart; i < h.nindex && p < b.length; i++) {
            const n = u8(p), level = u8(p + 1), toc = u16(p + 3);
            index.push({ text: cp850(b.subarray(p + 5, p + 5 + n)), level: (level & 0x3F) || 1, topic: toc });
            p += 5 + n;
        }
    } catch (err) {
        warnings.push('The index is damaged: ' + err.message);
    }

    function topicContent(topic) {
        const paras = [];
        let para = null;
        const st = { bold: false, italic: false, underline: false, color: null, mono: false, lines: false, align: 'left', indent: 0, link: null, hidden: false };
        const newPara = gap => { para = { items: [], mono: st.mono || st.lines, indent: st.indent, align: st.align, gap: !!gap }; paras.push(para); return para; };
        const cur = () => para || newPara();
        const add = s => {
            if (st.hidden || !s) return;
            const p = cur();
            const last = p.items[p.items.length - 1];
            if (st.link) {
                if (last && last.t === 'link' && last.ref === st.link) last.s += s;
                else p.items.push({ t: 'link', s, topic: st.link.topic, note: st.link.note, ref: st.link });
                return;
            }
            if (last && last.t === 'text' && last.bold === st.bold && last.italic === st.italic && last.underline === st.underline && last.color === st.color) last.s += s;
            else p.items.push({ t: 'text', s, bold: st.bold, italic: st.italic, underline: st.underline, color: st.color });
        };
        for (const slotNo of topic.slots) {
            const at = slotOffsets[slotNo];
            if (at == null) { warnings.push(`Topic ${topic.index + 1} names a missing slot ${slotNo}.`); continue; }
            const localPos = u32(at + 1), nlocal = u8(at + 5), ntext = u16(at + 6);
            const local = [];
            for (let k = 0; k < nlocal; k++) local.push(u16(localPos + k * 2));
            const t0 = at + 8, tEnd = Math.min(b.length, t0 + ntext);
            let spacing = true;
            for (let p = t0; p < tEnd;) {
                const c = b[p];
                if (c < 0xFA) {
                    if (c < local.length) add(dict[local[c]] || '');
                    if (spacing) add(' ');
                    p++;
                    continue;
                }
                p++;
                switch (c) {
                case 0xFA: newPara(true); spacing = true; break;
                case 0xFB: break;
                case 0xFC: spacing = !spacing; break;
                case 0xFD:
                    // a line break; outside examples it starts the next list item or line of a paragraph
                    if (st.mono || st.lines) cur().items.push({ t: 'br' });
                    else { newPara(); spacing = true; }
                    break;
                case 0xFE: add(' '); break;
                case 0xFF: {
                    const len = b[p], code = b[p + 1];
                    const data = b.subarray(p + 2, Math.min(tEnd, p + len));
                    p += Math.max(1, len);
                    switch (code) {
                    case 0x02: case 0x11: case 0x12: {
                        const old = st.indent;
                        st.indent = data[0] >= 255 ? 0 : Math.max(0, (data[0] || 1) - 1) * 0.6;
                        if (code === 0x11) newPara();
                        else if (para && !para.items.length) para.indent = st.indent;
                        else if (para && st.indent > old) { para.indent = st.indent; para.firstIndent = old - st.indent; } // a list item: hanging indent
                        break;
                    }
                    case 0x04: {
                        const s = data[0] || 0;
                        st.italic = s === 1 || s === 3 || s === 6;
                        st.bold = s === 2 || s === 3 || s === 7;
                        st.underline = s >= 5;
                        break;
                    }
                    case 0x05: case 0x07: {
                        const toc = data[0] | (data[1] << 8);
                        st.link = { topic: toc < topics.length ? toc : null, note: code === 0x07 ? 'Footnote' : null };
                        break;
                    }
                    case 0x0F: {
                        const toc = len >= 5 ? data[1] | (data[2] << 8) : null;
                        if (toc != null && topics[toc]) { st.link = { topic: toc }; add(topics[toc].title); st.link = null; }
                        break;
                    }
                    case 0x10: case 0x16: case 0x1F:
                        st.link = { topic: null, note: code === 0x10 ? 'Starts a program (not run)' : code === 0x16 ? 'Sends a message to the application (not run)' : 'Link into another help file (not opened)' };
                        break;
                    case 0x08: {
                        // keep the space after a link's last word out of the underline
                        const last = para && para.items[para.items.length - 1];
                        const ref = st.link;
                        st.link = null;
                        if (last && last.t === 'link' && last.ref === ref && / +$/.test(last.s)) { const sp = last.s.match(/ +$/)[0]; last.s = last.s.slice(0, -sp.length); add(sp); }
                        break;
                    }
                    case 0x0B: st.mono = true; spacing = false; newPara(); break;
                    case 0x0C: st.mono = false; spacing = true; newPara(); break;
                    case 0x0D: st.color = HP_COLORS[data[0]] || null; break;
                    case 0x13: st.color = COLORS[data[0]] || null; break;
                    case 0x17: st.hidden = true; break;
                    case 0x18: st.hidden = false; break;
                    case 0x1A: st.lines = true; spacing = false; st.align = data[0] === 2 ? 'right' : data[0] === 4 ? 'center' : 'left'; newPara(); break;
                    case 0x1B: st.lines = false; spacing = true; st.align = 'left'; newPara(); break;
                    case 0x0E: cur().items.push({ t: 'img', bitmap: { error: 'OS/2 bitmaps are not decoded' } }); break;
                    default: break;
                    }
                    break;
                }
                }
            }
        }
        return { title: topic.title, paras: paras.filter(p => p.items.some(it => it.t !== 'text' || it.s.trim())) };
    }

    return { title, header: h, topics, index, dict, warnings, topicContent, topicText: t => topicContent(t).paras.map(p => p.items.map(i => i.s || '').join('')).join('\n') };
}
