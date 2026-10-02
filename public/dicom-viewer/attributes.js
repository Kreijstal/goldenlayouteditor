// DICOM attribute dump: a dicom-parser DataSet as a tree of
// { tag, vr, name, value, length, items } rows, sequences nested, names from
// the data dictionary. The counterpart of dicomviewer's getDICOMAttributes.js,
// but it shows every element (private ones, the file meta group, sequences)
// with its VR, and decodes text in the file's character set.
import { TAGS, REPEATERS, UIDS } from './dictionary.js';

const MAX_TEXT = 256;
const MAX_VALUES = 24;

const TEXT_VRS = new Set(['SH', 'LO', 'ST', 'LT', 'UC', 'UT', 'PN']);
const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
const NUMBER_VRS = { US: [2, 'uint16'], SS: [2, 'int16'], UL: [4, 'uint32'], SL: [4, 'int32'], FL: [4, 'float'], FD: [8, 'double'] };

// (0008,0005) Specific Character Set -> TextDecoder labels
const CHARSETS = {
    '': 'windows-1252', 'ISO_IR 6': 'windows-1252', 'ISO 2022 IR 6': 'windows-1252',
    'ISO_IR 100': 'windows-1252', 'ISO 2022 IR 100': 'windows-1252',
    'ISO_IR 101': 'iso-8859-2', 'ISO 2022 IR 101': 'iso-8859-2',
    'ISO_IR 109': 'iso-8859-3', 'ISO 2022 IR 109': 'iso-8859-3',
    'ISO_IR 110': 'iso-8859-4', 'ISO 2022 IR 110': 'iso-8859-4',
    'ISO_IR 144': 'iso-8859-5', 'ISO 2022 IR 144': 'iso-8859-5',
    'ISO_IR 127': 'iso-8859-6', 'ISO 2022 IR 127': 'iso-8859-6',
    'ISO_IR 126': 'iso-8859-7', 'ISO 2022 IR 126': 'iso-8859-7',
    'ISO_IR 138': 'iso-8859-8', 'ISO 2022 IR 138': 'iso-8859-8',
    'ISO_IR 148': 'iso-8859-9', 'ISO 2022 IR 148': 'iso-8859-9',
    'ISO_IR 203': 'iso-8859-15', 'ISO 2022 IR 203': 'iso-8859-15',
    'ISO_IR 13': 'shift_jis', 'ISO 2022 IR 13': 'shift_jis',
    'ISO_IR 166': 'windows-874', 'ISO 2022 IR 166': 'windows-874',
    'ISO 2022 IR 87': 'iso-2022-jp', 'ISO 2022 IR 159': 'iso-2022-jp',
    'ISO 2022 IR 149': 'euc-kr', 'ISO 2022 IR 58': 'gb18030',
    'ISO_IR 192': 'utf-8', 'GB18030': 'gb18030', 'GBK': 'gbk',
};

export function tagKey(tag) {
    // dicom-parser's 'x0010 0010'-style property name -> '00100010'
    return tag.slice(1).toUpperCase();
}

export function formatTag(key) {
    return `(${key.slice(0, 4)},${key.slice(4)})`;
}

function repeaterEntry(key) {
    for (const mask in REPEATERS) {
        let ok = true;
        for (let i = 0; i < 8 && ok; i++) ok = mask[i] === 'X' || mask[i] === key[i];
        if (ok) return REPEATERS[mask];
    }
    return null;
}

// [vr, keyword] from the dictionary, or null
export function lookup(key) {
    const entry = TAGS[key] || repeaterEntry(key);
    if (!entry) return null;
    const bar = entry.indexOf('|');
    return [entry.slice(0, bar), entry.slice(bar + 1)];
}

export function uidName(uid) {
    return UIDS[uid] || '';
}

// VR for elements of implicit-VR data sets: what dicom-parser needs to find sequences in them
export function vrCallback(tag) {
    const e = lookup(tagKey(tag));
    return e ? e[0].split('/')[0] : undefined;
}

function isPrivate(key) {
    return parseInt(key.slice(3, 4), 16) % 2 === 1;
}

export function decoderFor(dataSet) {
    const raw = dataSet.string('x00080005') || '';
    // multi-valued (code extensions): the first value that is not plain ASCII decides
    const values = raw.split('\\').map(s => s.trim());
    const label = CHARSETS[values.find(v => v && v !== 'ISO 2022 IR 6') || values[0] || ''] || 'windows-1252';
    try {
        return new TextDecoder(label);
    } catch (_) {
        return new TextDecoder('windows-1252');
    }
}

function clip(s) {
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `… (${s.length} characters)` : s;
}

function hex(bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
}

function textValue(dataSet, element, decoder) {
    const bytes = dataSet.byteArray.subarray(element.dataOffset, element.dataOffset + element.length);
    return decoder.decode(bytes).replace(/[\0 ]+$/, '');
}

function numberValues(dataSet, prop, element, vr) {
    const [size, fn] = NUMBER_VRS[vr];
    const n = Math.floor(element.length / size);
    const out = [];
    for (let i = 0; i < Math.min(n, MAX_VALUES); i++) out.push(dataSet[fn](prop, i));
    return out.join('\\') + (n > MAX_VALUES ? `\\… (${n} values)` : '');
}

function binaryValue(dataSet, element, vr) {
    if (element.encapsulatedPixelData || (element.fragments && element.fragments.length)) {
        const frames = element.basicOffsetTable && element.basicOffsetTable.length;
        return `encapsulated, ${element.fragments.length} fragment${element.fragments.length === 1 ? '' : 's'}`
            + (frames ? `, ${frames} frame offsets` : '');
    }
    if (element.length <= 16) {
        return hex(dataSet.byteArray.subarray(element.dataOffset, element.dataOffset + element.length));
    }
    return `${element.length} bytes of ${vr || 'binary'} data`;
}

// The VR to read an element by: its own (explicit VR) or the dictionary's (implicit VR)
function effectiveVr(element, entry, dataSet) {
    if (element.vr) return element.vr;
    if (!entry) return null;
    const vr = entry[0];
    if (vr === 'US/SS' || vr === 'US/SS/OW') return dataSet.uint16('x00280103') === 1 ? 'SS' : 'US';
    if (vr === 'OB/OW') return 'OW';
    return vr.split('/')[0];
}

function looksLikeText(bytes) {
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === 0 && i === bytes.length - 1) continue;
        if (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09 && b !== 0x1b) return false;
    }
    return true;
}

// Rows for one data set (the file, or a sequence item). decoder: the text decoder of the
// enclosing data set (an item can't change the character set unless it has its own (0008,0005))
export function buildAttributes(dataSet, decoder) {
    decoder = dataSet.elements.x00080005 ? decoderFor(dataSet) : (decoder || decoderFor(dataSet));
    const rows = [];
    const creators = {};
    const props = Object.keys(dataSet.elements).sort();
    for (const prop of props) {
        const element = dataSet.elements[prop];
        const key = tagKey(prop);
        // Item and sequence delimiters: structure, not attributes (dicom-parser keeps some in implicit VR)
        if (key.startsWith('FFFEE0')) continue;
        const group = key.slice(0, 4);
        const elem = parseInt(key.slice(4), 16);
        let entry = lookup(key);
        let name;
        if (elem === 0) {
            name = entry ? entry[1] : 'GroupLength';
            if (!entry) entry = ['UL', name];
        } else if (isPrivate(key)) {
            if (elem >= 0x10 && elem <= 0xff) {
                name = 'PrivateCreator';
                entry = ['LO', name];
            } else {
                const creator = creators[group + '00' + (elem >> 8).toString(16).toUpperCase().padStart(2, '0')];
                name = creator ? `Private (${creator})` : 'Private';
                entry = null;
            }
        } else {
            name = entry ? entry[1] : 'Unknown';
        }
        const vr = effectiveVr(element, entry, dataSet);
        const row = { tag: formatTag(key), key, vr: vr || '', name, length: element.length, value: '' };
        try {
            if (element.items) {
                row.vr = 'SQ';
                row.items = element.items.map((item, i) => ({
                    name: `Item ${i + 1}`,
                    rows: item.dataSet ? buildAttributes(item.dataSet, decoder) : [],
                }));
                row.value = `${element.items.length} item${element.items.length === 1 ? '' : 's'}`;
            } else if (key === '7FE00010' || key === '7FE00008' || key === '7FE00009') {
                row.value = binaryValue(dataSet, element, vr);
            } else if (element.length === 0) {
                row.value = '';
            } else if (vr && TEXT_VRS.has(vr)) {
                row.value = clip(textValue(dataSet, element, decoder));
            } else if (vr && STRING_VRS.has(vr)) {
                const s = dataSet.string(prop) || '';
                row.value = clip(s);
                if (vr === 'UI') row.uidName = uidName(s);
            } else if (vr && NUMBER_VRS[vr]) {
                row.value = numberValues(dataSet, prop, element, vr);
            } else if (vr === 'AT') {
                const n = Math.floor(element.length / 4);
                const tags = [];
                for (let i = 0; i < Math.min(n, MAX_VALUES); i++) {
                    tags.push(formatTag(dataSet.uint16(prop, 2 * i).toString(16).padStart(4, '0').toUpperCase()
                        + dataSet.uint16(prop, 2 * i + 1).toString(16).padStart(4, '0').toUpperCase()));
                }
                row.value = tags.join('\\');
            } else if (!vr || vr === 'UN') {
                // Unknown (private, implicit VR): text if it looks like text
                const bytes = dataSet.byteArray.subarray(element.dataOffset, element.dataOffset + element.length);
                row.value = element.length < 1024 && looksLikeText(bytes)
                    ? clip(decoder.decode(bytes).replace(/[\0 ]+$/, ''))
                    : binaryValue(dataSet, element, vr || 'UN');
            } else {
                row.value = binaryValue(dataSet, element, vr);
            }
        } catch (err) {
            row.value = `(unreadable: ${err.message})`;
        }
        if (row.name === 'PrivateCreator') creators[key] = row.value.trim();
        if (element.hadUndefinedLength) row.undefinedLength = true;
        rows.push(row);
    }
    return rows;
}

// The rows (and their sequence items) whose tag, name or value contains the query; ancestors of a
// match stay so the match keeps its place. Returns a pruned copy of the tree, or null.
export function filterAttributes(rows, query) {
    const q = query.trim().toUpperCase();
    if (!q) return rows;
    const qNoSpace = q.replace(/\s+/g, '');
    const hit = (r) => r.tag.includes(q) || r.key.includes(qNoSpace.replace(/[(),]/g, ''))
        || r.name.toUpperCase().includes(qNoSpace) || r.vr === q
        || (r.value && r.value.toUpperCase().includes(q)) || (r.uidName && r.uidName.toUpperCase().includes(q));
    const walk = (list) => {
        const out = [];
        for (const r of list) {
            if (hit(r)) {
                out.push(r);
                continue;
            }
            if (r.items) {
                const items = [];
                for (const item of r.items) {
                    const sub = walk(item.rows);
                    if (sub.length) items.push({ ...item, rows: sub });
                }
                if (items.length) out.push({ ...r, items, partial: true });
            }
        }
        return out;
    };
    return walk(rows);
}

export function countRows(rows) {
    let n = 0;
    for (const r of rows) {
        n++;
        if (r.items) for (const item of r.items) n += 1 + countRows(item.rows);
    }
    return n;
}
