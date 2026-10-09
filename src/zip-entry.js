// Read a named ZIP entry without loading a paint viewer.
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// A range of the file at url ("start-end" or "-length" from its end, as HTTP has
// them), or the whole file when the server sends all of it
async function fetchRange(url, range) {
    let resp = await fetch(url, { headers: { Range: 'bytes=' + range } });
    // a file shorter than the range asked from its end is refused (416): all of it, then
    if (!resp.ok && resp.headers.get('content-range')) resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (resp.status !== 206) return { bytes, start: 0, whole: true };
    const m = /bytes (\d+)-/.exec(resp.headers.get('content-range') || '');
    return { bytes, start: m ? +m[1] : 0, whole: false };
}

async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The bytes of the first of `names` the ZIP at url holds (an empty one is not there), or null
async function zipEntry(url, names) {
    // the end of central directory record is in the last 64 KB (and 22 bytes)
    const tail = await fetchRange(url, '-65558');
    const all = tail.whole ? tail.bytes : null;
    const b = tail.bytes;
    let eocd = -1;
    for (let i = b.length - 22; i >= 0; i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const cdSize = u32(b, eocd + 12), cdOffset = u32(b, eocd + 16);
    const cd = all ? all.subarray(cdOffset, cdOffset + cdSize)
        : cdOffset >= tail.start ? b.subarray(cdOffset - tail.start, cdOffset - tail.start + cdSize)
            : (await fetchRange(url, `${cdOffset}-${cdOffset + cdSize - 1}`)).bytes;
    const found = {};
    for (let p = 0; p + 46 <= cd.length && u32(cd, p) === 0x02014b50;) {
        const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
        const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
        if (names.includes(name) && u32(cd, p + 24)) found[name] = { method: u16(cd, p + 10), compSize: u32(cd, p + 20), offset: u32(cd, p + 42) };
        p += 46 + nameLen + extraLen + commentLen;
    }
    const name = names.find(n => found[n]);
    if (!name) return null;
    const e = found[name];
    let local;
    if (all) local = all.subarray(e.offset);
    else {
        // the local header's extra field may differ from the central one's: some room for it
        const r = await fetchRange(url, `${e.offset}-${e.offset + 30 + 1024 + e.compSize - 1}`);
        local = r.whole ? r.bytes.subarray(e.offset) : r.bytes;
    }
    const dataStart = 30 + u16(local, 26) + u16(local, 28);
    const data = local.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    return null;
}

module.exports = { zipEntry };
