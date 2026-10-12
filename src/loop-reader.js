// Fluid compact encoding reference: microsoft/FluidFramework,
// packages/drivers/odsp-driver/src/zipItDataRepresentationUtils.ts (MIT).
// This independent reader extracts a Prague optimized snapshot, not a live container.
const pako = require('pako');
const MAGIC = [0x57,0x8f,0x1c,0xd0,0xd0,0x67,0x34,0x4b,0x9f,0xfb,0x4f,0x5a,0x48,0x06,0x9e,0xc5];
const LIMIT = 64 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', {fatal:true});
function check(ok, message) { if (!ok) throw new Error('Loop: ' + message); }
function decodeCompact(bytes) {
    let pos = 0, count = 0;
    const dict = new Map();
    function take(length) {
        check(Number.isSafeInteger(length) && length >= 0 && pos + length <= bytes.length, 'truncated compact snapshot');
        const result = bytes.subarray(pos, pos + length); pos += length; return result;
    }
    function number(length, signed = false) {
        const b = take(length); let n = 0n;
        for (let i = length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
        if (signed && length && b[length - 1] & 128) n -= 1n << BigInt(length * 8);
        check(n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER), 'integer exceeds exact range');
        return Number(n);
    }
    function value(depth = 0) {
        check(depth < 128 && ++count < 1000000, 'compact snapshot is too complex');
        const code = number(1);
        if (code === 20 || code === 21) {
            const width = code === 20 ? 1 : 4, id = number(width);
            check(!dict.has(id), 'duplicate dictionary string');
            dict.set(id, utf8.decode(take(number(width))));
            return value(depth);
        }
        if (code === 49 || code === 51) {
            const end = code === 49 ? 50 : 52, values = [];
            while (bytes[pos] !== end) values.push(value(depth + 1));
            pos++;
            if (code === 49) return values;
            check(values.length % 2 === 0, 'unpaired compact properties');
            const object = Object.create(null);
            for (let i = 0; i < values.length; i += 2) {
                check(typeof values[i] === 'string' && !Object.hasOwn(object, values[i]), 'invalid compact property');
                object[values[i]] = values[i + 1];
            }
            return object;
        }
        if (code >= 17 && code <= 19) {
            const id = number([1,2,4][code - 17]); check(dict.has(id), 'unknown dictionary string'); return dict.get(id);
        }
        if (code >= 13 && code <= 16) return utf8.decode(take(number([0,1,2,4][code - 13])));
        if (code >= 32 && code <= 36) return take(number([0,1,2,4,8][code - 32]));
        if (code === 1) return 0;
        if (code >= 2 && code <= 9) return number([1,1,2,2,4,4,8,8][code - 2], code % 2 === 0);
        if (code === 11 || code === 12) return code === 11;
        throw new Error('Loop: unsupported compact marker ' + code);
    }
    const result = value(); check(pos === bytes.length, 'trailing compact snapshot data'); return result;
}
function find(bytes, needle, start = 0) {
    outer: for (let i = start; i <= bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
        return i;
    }
    return -1;
}
function utf16(s) { return Uint8Array.from([...s].flatMap(c => [c.charCodeAt(0),0])); }
function optimizedSnapshot(bytes) {
    check(bytes.length <= LIMIT && MAGIC.every((b,i) => bytes[i] === b), 'not a supported Prague .loop file');
    check(find(bytes, utf16('Microsoft.Prague 0.2.1')) !== -1, 'unsupported Prague version');
    const type = find(bytes, utf16('Microsoft.PragueOptimizedSnapshotWithOpsNode'));
    check(type !== -1, 'no optimized snapshot; this Prague profile is not supported');
    const data = find(bytes, Uint8Array.from([5,4,100,97,116,97,9,36,0,19,5,5]), type);
    check(data !== -1, 'optimized snapshot data is missing');
    const gzip = find(bytes, Uint8Array.from([31,139,8]), data + 12);
    check(gzip !== -1 && gzip - data < 32 && bytes[gzip + 3] === 0, 'unsupported optimized snapshot compression');
    // Raw DEFLATE tells us the exact member boundary. Prague records follow the gzip
    // member, so passing the entire file to ungzip would consume unrelated records.
    const inflate = new pako.Inflate({raw:true,chunkSize:65536});
    let size = 0;
    inflate.onData = chunk => { size += chunk.length; check(size <= LIMIT, 'snapshot exceeds 64 MiB'); };
    inflate.push(bytes.subarray(gzip + 10), true);
    check(!inflate.err && inflate.ended, 'invalid compressed snapshot');
    const end = gzip + 10 + inflate.strm.next_in + 8;
    check(end <= bytes.length, 'truncated gzip trailer');
    // Verify the gzip CRC and size, rather than accepting a damaged snapshot.
    const payload = pako.ungzip(bytes.subarray(gzip, end));
    check(payload.length === size, 'snapshot size mismatch');
    return {payload,offset:gzip};
}
function readLoop(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const {payload,offset} = optimizedSnapshot(bytes), compact = decodeCompact(payload);
    check(compact.mrv === '1.0' && compact.cv === '1.0', 'unsupported Fluid snapshot version');
    check(compact.snapshot && Array.isArray(compact.snapshot.treeNodes) && Array.isArray(compact.blobs), 'invalid Fluid snapshot');
    const blobs = new Map();
    for (const b of compact.blobs) {
        check(typeof b.id === 'string' && b.data instanceof Uint8Array && !blobs.has(b.id), 'invalid snapshot blob');
        blobs.set(b.id, {id:b.id,bytes:b.data,text:utf8.decode(b.data)});
    }
    const entries = [], stories = new Map();
    function walk(nodes, path = '') {
        for (const node of nodes) {
            check(typeof node.name === 'string', 'invalid snapshot tree name');
            const full = path + '/' + node.name;
            if (node.children !== undefined) { check(Array.isArray(node.children), 'invalid tree children'); walk(node.children,full); }
            if (node.value !== undefined) {
                check(blobs.has(node.value), 'snapshot references a missing blob');
                const blob = blobs.get(node.value); entries.push({path:full,id:blob.id,text:blob.text,size:blob.bytes.length});
                const json = JSON.parse(blob.text);
                if (Array.isArray(json.segmentTexts)) {
                    const group = full.slice(0,full.lastIndexOf('/'));
                    if (!stories.has(group)) stories.set(group,[]);
                    stories.get(group).push(json);
                }
            }
        }
    }
    walk(compact.snapshot.treeNodes);
    const paragraphs = [];
    for (const chunks of stories.values()) {
        chunks.sort((a,b) => a.chunkStartSegmentIndex - b.chunkStartSegmentIndex);
        let current = null, nextIndex = 0;
        for (const chunk of chunks) {
            check(chunk.chunkStartSegmentIndex === nextIndex && chunk.chunkSegmentCount === chunk.segmentTexts.length, 'incomplete or overlapping text chunks');
            nextIndex += chunk.chunkSegmentCount;
            for (const segment of chunk.segmentTexts) {
                if (segment?.marker) {
                    if (segment.props?.nodeType === 'Paragraph') { current = []; paragraphs.push(current); }
                } else {
                    const text = typeof segment === 'string' ? segment : segment?.text;
                    check(typeof text === 'string', 'unsupported SharedString segment');
                    if (!current) { current = []; paragraphs.push(current); }
                    current.push({text,props:typeof segment === 'string' ? {} : segment.props || {}});
                }
            }
        }
    }
    const warnings = ['Stored snapshot text only. Loop layout, tables, embedded components and collaboration changes are not rendered or replayed.'];
    if (compact.deltas) warnings.push('This snapshot includes pending operations; the preview shows the stored snapshot before those operations.');
    return {paragraphs,entries,warnings,sequenceNumber:compact.snapshot.sequenceNumber,offset,
        summary:`${paragraphs.length} paragraph(s) · ${entries.length} snapshot entries · read-only`,
        text:paragraphs.map(p => p.map(s => s.text).join('')).join('\n')};
}
module.exports = {readLoop,decodeCompact};
