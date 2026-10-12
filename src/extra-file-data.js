const { parseXml } = require('./shared-preview-data');

function isAbcText(text) { return /^X:\s*\d+/m.test(text || '') && /^K:\s*\S+/m.test(text || ''); }
function isAcfText(text) { return /^\uFEFF?\s*(?:\/\/[^\n]*\n\s*)*"?AppState"?\s*\{/.test(text || ''); }
function isAbletonText(text) { return /^\uFEFF?\s*(?:<\?xml[^]*?\?>\s*)?<Ableton[\s>]/.test(text || ''); }
function textHead(file) { return file.content || (file.head && new TextDecoder().decode(file.head)) || ''; }
function isExtraTextFile(file) {
    const text = textHead(file);
    if (/\.abc$/i.test(file.name)) return isAbcText(text);
    if (/\.acf$/i.test(file.name)) return isAcfText(text);
    if (/\.als$/i.test(file.name)) {
        const b = file.head || file.bytes;
        return isAbletonText(text) || (!!b && b[0] === 0x1f && b[1] === 0x8b) || (!text && !!file.viewType);
    }
    return false;
}

// Valve KeyValues: preserve duplicate keys as entries instead of silently
// overwriting them. Do not interpret or execute any values.
function parseKeyValues(text) {
    let p = 0, count = 0;
    const token = () => {
        for (;;) {
            while (/\s/.test(text[p] || '') && p < text.length) p++;
            if (text.slice(p, p + 2) !== '//') break;
            const end = text.indexOf('\n', p); p = end < 0 ? text.length : end + 1;
        }
        if (p >= text.length) return null;
        const c = text[p++];
        if (c === '{' || c === '}') return { brace: c };
        if (c === '"') {
            let value = '';
            while (p < text.length) {
                const ch = text[p++];
                if (ch === '"') return { value };
                if (ch === '\\') {
                    if (p >= text.length) break;
                    const next = text[p++]; value += ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[next] || '\\' + next;
                } else value += ch;
            }
            throw new Error('Unterminated KeyValues string.');
        }
        let value = c;
        while (p < text.length && !/[\s{}]/.test(text[p])) value += text[p++];
        return { value };
    };
    const entries = (nested, depth = 0) => {
        if (depth > 64) throw new Error('KeyValues nesting exceeds 64 levels.');
        const result = [];
        for (;;) {
            const key = token();
            if (!key) { if (nested) throw new Error('Unclosed KeyValues block.'); return result; }
            if (key.brace === '}') { if (!nested) throw new Error('Unexpected closing brace.'); return result; }
            if (key.value == null) throw new Error('Expected a KeyValues key.');
            const value = token();
            if (!value || value.brace === '}') throw new Error(`Missing value for ${key.value}.`);
            if (++count > 20000) throw new Error('KeyValues preview exceeds 20,000 entries.');
            result.push({ key: key.value, value: value.brace === '{' ? entries(true, depth + 1) : value.value });
        }
    };
    const tree = entries(false);
    const app = tree.find(e => e.key === 'AppState');
    if (!app || !Array.isArray(app.value)) throw new Error('Not a Steam AppState manifest.');
    const value = key => { const item = app.value.find(e => e.key.toLowerCase() === key.toLowerCase()); return item ? item.value : ''; };
    return { tree, summary: Object.fromEntries(['appid', 'name', 'installdir', 'StateFlags', 'buildid', 'SizeOnDisk', 'LastUpdated', 'LastPlayed'].map(key => [key, value(key)])) };
}

function summarizeAbleton(text) {
    const doc = parseXml(text), root = doc.documentElement;
    if (root.localName !== 'Ableton' || !root.querySelector('LiveSet')) throw new Error('Not an Ableton Live Set.');
    const val = (el, selector) => { const e = el.querySelector(selector); return e ? e.getAttribute('Value') || e.textContent.trim() : ''; };
    const tracks = [...root.querySelectorAll('Tracks > MidiTrack, Tracks > AudioTrack, Tracks > GroupTrack, Tracks > ReturnTrack')].map(t => ({
        type: t.localName, name: val(t, 'Name > EffectiveName') || val(t, 'Name > UserName'),
        clips: [...t.querySelectorAll('MidiClip,AudioClip')].map(c => ({ type: c.localName, name: val(c, 'Name'), start: val(c, 'CurrentStart'), end: val(c, 'CurrentEnd') })),
        devices: [...t.querySelectorAll('DeviceChain > Devices > *')].map(d => d.localName),
    }));
    return {
        creator: root.getAttribute('Creator') || '', version: root.getAttribute('MajorVersion') || '',
        tempo: val(root, 'Tempo > Manual'), timeSignature: val(root, 'TimeSignature > Manual'),
        tracks, samples: [...root.querySelectorAll('FileRef > Path')].map(e => e.getAttribute('Value') || e.textContent),
    };
}

function protobufFields(bytes) {
    let p = 0;
    const fields = [];
    const varint = () => {
        let value = 0, shift = 0;
        for (let i = 0; i < 10; i++) {
            if (p >= bytes.length) throw new Error('Truncated protobuf value.');
            const b = bytes[p++]; value += (b & 127) * 2 ** shift;
            if (!(b & 128)) { if (!Number.isSafeInteger(value)) return String(value); return value; }
            shift += 7;
        }
        throw new Error('Invalid protobuf varint.');
    };
    while (p < bytes.length) {
        if (fields.length >= 100000) throw new Error('Protobuf field limit exceeded.');
        const tag = varint();
        if (typeof tag !== 'number' || tag < 8) throw new Error('Invalid protobuf field tag.');
        const field = Math.floor(tag / 8), wire = tag & 7;
        let value;
        if (wire === 0) value = varint();
        else if (wire === 2 || wire === 1 || wire === 5) {
            const size = wire === 2 ? varint() : wire === 1 ? 8 : 4;
            if (typeof size !== 'number' || size < 0 || p + size > bytes.length) throw new Error('Truncated protobuf field.');
            value = bytes.subarray(p, p + size); p += size;
        } else throw new Error(`Unsupported protobuf wire type ${wire}.`);
        fields.push({ field, wire, value });
    }
    return fields;
}

function parseAndroidManifest(bytes) {
    const string = (fields, id) => { const f = fields.find(e => e.field === id && e.wire === 2); return f ? new TextDecoder().decode(f.value) : ''; };
    const compiledValue = fields => {
        const compiled = fields.find(f => f.field === 6 && f.wire === 2);
        if (!compiled) return '';
        const item = protobufFields(compiled.value);
        const text = item.find(f => [2,3,4].includes(f.field) && f.wire === 2);
        if (text) return string(protobufFields(text.value), 1);
        const primitive = item.find(f => f.field === 7 && f.wire === 2);
        if (primitive) {
            const values = protobufFields(primitive.value);
            const value = values.find(f => [6,7,8].includes(f.field) && f.wire === 0);
            if (value) return value.field === 8 ? String(value.value !== 0) : String(value.value);
        }
        const ref = item.find(f => f.field === 1 && f.wire === 2);
        return ref ? '@' + (string(protobufFields(ref.value), 3) || 'resource') : '';
    };
    let budget = 5000;
    const node = (bytes, depth = 0) => {
        if (--budget < 0 || depth > 32) throw new Error('Android manifest preview limit exceeded.');
        const fields = protobufFields(bytes), element = fields.find(f => f.field === 1 && f.wire === 2);
        if (!element) return { text: string(fields, 2) };
        const el = protobufFields(element.value);
        return {
            name: string(el, 3), namespace: string(el, 2),
            attributes: el.filter(f => f.field === 4 && f.wire === 2).map(f => { const a = protobufFields(f.value); return { name: string(a, 2), value: string(a, 3) || compiledValue(a), namespace: string(a, 1) }; }),
            children: el.filter(f => f.field === 5 && f.wire === 2).map(f => node(f.value, depth + 1)),
        };
    };
    const manifest = node(bytes);
    if (manifest.name !== 'manifest') throw new Error('AAB manifest is not an AAPT2 protobuf XML manifest.');
    const attr = (el, name) => (el.attributes.find(a => a.name === name) || {}).value || '';
    return { tree: manifest, package: attr(manifest, 'package'), versionName: attr(manifest, 'versionName'), versionCode: attr(manifest, 'versionCode'),
        permissions: manifest.children.filter(c => c.name === 'uses-permission').map(c => attr(c, 'name')) };
}

module.exports = { isAbcText, isAcfText, isAbletonText, isExtraTextFile, parseKeyValues, summarizeAbleton, protobufFields, parseAndroidManifest };
