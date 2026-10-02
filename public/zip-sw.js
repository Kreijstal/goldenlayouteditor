// --- Read-only zip browsing inside the service worker ---
// Imported by worker.js (or loaded by the page, see below). Paths may run *through* an archive:
//   /workspace-file?path=/home/me/a.zip/docs/readme.txt
// is answered from entry "docs/readme.txt" of /home/me/a.zip, so every viewer
// (img/video src, fetch, iframes) works on zip contents unchanged.
//   /zip-list?path=/home/me/a.zip/docs   → JSON listing of that folder
// Archives nest: /home/me/a.zip/lib/b.jar/META-INF/MANIFEST.MF reads b.jar out
// of a.zip, then the manifest out of b.jar.
// The outermost archive is read with HTTP Range requests on /workspace-file, so
// only its central directory and the requested entry cross the network. A nested
// archive is read in place if stored, or inflated into memory if deflated.
// Stored and deflated entries and zip64 are supported; inflating uses DecompressionStream.
// Tar archives (.tar, .tar.gz/.tgz, .tar.zst/.tzst) work the same way, but have no
// index: they are streamed through the decompressor (gzip by DecompressionStream,
// zstd by fzstd) and parsed on the fly; see the Tar section.
// A lone .gz or .zst file opens like an archive holding one file, itself without
// the suffix (log.txt.gz → log.txt), so it gets the viewer its real type calls for.
// Disc images (.iso) are read in place, like a stored zip: ISO 9660 with Joliet or
// Rock Ridge names, or UDF when the disc has it (DVDs, Windows install images,
// whose ISO 9660 side only holds a README); see the Disc images section.

// Also runs in the page itself when there is no service worker (see
// src/archive-fallback.js); the page loads fzstd with a script tag then.
if (typeof importScripts === 'function') importScripts('https://esm.sh/fzstd@0.1.1/umd/index.js?raw');
// The network fetch, taken before the page (in fallback mode) routes its own
// fetch() through handleZipFetch
const netFetch = self.fetch.bind(self);

const ZIP_EXTENSIONS = new Set(['zip', 'jar', 'war', 'ear', 'aar', 'apk', 'xapk', 'ipa', 'whl', 'nupkg', 'cbz', 'xpi', 'vsix', 'crx', 'kmz', '3mf']);
const ZIP_CD_TTL_MS = 15000;
const zipDirs = new Map();   // source key -> { at, entries }
const zipNested = new Map(); // source key -> { at, bytes } for inflated nested archives
const ZIP_NESTED_BUDGET = 256 * 1024 * 1024;
const TAR_RE = /\.(tar|tgz|tar\.gz|tzst|tar\.zst)$/i;
const tarIndexes = new Map(); // source key -> { at, entries, kept, size }
const SINGLE_RE = /\.(gz|zst)$/i;
const ISO_RE = /\.iso$/i;
const DISK_RE = /\.(img|ima|vfd|flp)$/i;
const QCOW_RE = /\.qcow2?$/i;
const isoIndexes = new Map(); // source key -> { at, entries }

// 'zip', 'tar', 'single', 'iso' or null, by file name
function archiveKind(name) {
    if (ZIP_EXTENSIONS.has(zipExt(name))) return 'zip';
    if (TAR_RE.test(name)) return 'tar';
    if (ISO_RE.test(name)) return 'iso';
    if (DISK_RE.test(name)) return 'disk';
    if (QCOW_RE.test(name)) return 'qcow2';
    if (SINGLE_RE.test(name)) return 'single';
    return null;
}

// Keep a cache map of { at, bytes } under the shared memory budget, oldest first
function trimToBudget(map, keep) {
    let total = 0;
    const sizeOf = v => v.size !== undefined ? v.size : v.bytes.length;
    for (const v of map.values()) total += sizeOf(v);
    for (const k of map.keys()) {
        if (total <= ZIP_NESTED_BUDGET || k === keep) break;
        total -= sizeOf(map.get(k));
        map.delete(k);
    }
}

function zipExt(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

// --- Byte sources: range(start, endInclusive) → { buf }; range(n) alone = last n bytes ---

// The outermost archive, read from the server with Range requests
function httpSource(zipPath) {
    return {
        key: zipPath,
        kind: archiveKind(zipPath),
        async *stream(signal) {
            const resp = await netFetch('/workspace-file?path=' + encodeURIComponent(zipPath), { signal });
            if (!resp.ok) throw zipError(resp.status === 404 ? 404 : 502, `Cannot read ${zipPath} (HTTP ${resp.status})`);
            const reader = resp.body.getReader();
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    yield value;
                }
            } finally {
                reader.cancel().catch(() => {});
            }
        },
        async all() {
            const resp = await netFetch('/workspace-file?path=' + encodeURIComponent(zipPath));
            if (!resp.ok) throw zipError(resp.status === 404 ? 404 : 502, `Cannot read ${zipPath} (HTTP ${resp.status})`);
            return new Uint8Array(await resp.arrayBuffer());
        },
        async range(start, endInclusive) {
            const range = endInclusive === undefined ? `bytes=-${start}` : `bytes=${start}-${endInclusive}`;
            const url = '/workspace-file?path=' + encodeURIComponent(zipPath);
            let resp = await netFetch(url, { headers: { Range: range } });
            // A tail range longer than the file is unsatisfiable (the server reports it as 404):
            // small archives are simply fetched whole
            if (!resp.ok && endInclusive === undefined) resp = await netFetch(url);
            if (resp.status !== 206 && resp.status !== 200) throw zipError(resp.status === 404 ? 404 : 502, `Cannot read ${zipPath} (HTTP ${resp.status})`);
            const buf = new Uint8Array(await resp.arrayBuffer());
            // A server ignoring Range sends the whole file: slice what was asked for
            if (resp.status === 200) {
                const s = endInclusive === undefined ? Math.max(0, buf.length - start) : start;
                const e = endInclusive === undefined ? buf.length : Math.min(buf.length, endInclusive + 1);
                return { buf: buf.subarray(s, e) };
            }
            return { buf };
        },
    };
}

// A nested archive inflated into memory
function memorySource(key, bytes) {
    return {
        key,
        kind: archiveKind(key),
        async all() { return bytes; },
        async range(start, endInclusive) {
            if (endInclusive === undefined) return { buf: bytes.subarray(Math.max(0, bytes.length - start)) };
            return { buf: bytes.subarray(start, endInclusive + 1) };
        },
    };
}

// A nested archive stored uncompressed: a window onto its parent, no copying
function sliceSource(key, parent, base, size) {
    return {
        key,
        kind: archiveKind(key),
        async all() { return size ? (await parent.range(base, base + size - 1)).buf : new Uint8Array(0); },
        async range(start, endInclusive) {
            if (endInclusive === undefined) {
                const s = Math.max(0, size - start);
                return size ? parent.range(base + s, base + size - 1) : { buf: new Uint8Array(0) };
            }
            return parent.range(base + start, base + Math.min(endInclusive, size - 1));
        },
    };
}

function zipRange(src, start, endInclusive) {
    return src.range(start, endInclusive);
}

async function zipEntryDataStart(src, e) {
    const head = await zipRange(src, e.offset, e.offset + 29);
    const hv = new DataView(head.buf.buffer, head.buf.byteOffset, head.buf.byteLength);
    if (head.buf.length < 30 || hv.getUint32(0, true) !== 0x04034b50) throw zipError(415, 'Corrupt local file header');
    return e.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
}

async function nestedSource(parent, e) {
    const key = parent.key + '/' + e.name;
    // A file stored in one piece in a disc or disk image: read in place
    if ((parent.kind === 'iso' || parent.kind === 'disk' || parent.kind === 'qcow2') && !e.inline && !e.reader && e.extents.length === 1 && !e.extents[0][2]) {
        return sliceSource(key, e.src || parent, e.extents[0][0], e.size);
    }
    if (parent.kind !== 'zip') return memorySource(key, await archiveRead(parent, e.name));
    if (e.encrypted) throw zipError(415, `${e.name} is encrypted`);
    if (e.method === 0) return sliceSource(key, parent, await zipEntryDataStart(parent, e), e.size);
    const hit = zipNested.get(key);
    if (hit && Date.now() - hit.at < ZIP_CD_TTL_MS) return memorySource(key, hit.bytes);
    const bytes = await zipReadEntry(parent, e.name);
    zipNested.set(key, { at: Date.now(), bytes });
    trimToBudget(zipNested, key);
    return memorySource(key, bytes);
}

// Resolve an absolute path through any number of archives.
// Returns { src, inner } (inner = path inside the innermost archive), or null
// when the path doesn't go through an archive.
// allowRoot: a path ending at an archive opens it (listings); for file reads the
// archive itself is returned as bytes instead.
async function zipResolve(absPath, allowRoot) {
    const parts = absPath.split('/');
    let i = 1;
    while (i < parts.length && !archiveKind(parts[i])) i++;
    if (i >= parts.length) return null;
    let rest = parts.slice(i + 1).filter(Boolean);
    if (!rest.length && !allowRoot) return null;
    let src = httpSource(parts.slice(0, i + 1).join('/'));
    for (let j = 0; j < rest.length; j++) {
        if (!archiveKind(rest[j])) continue;
        if (j === rest.length - 1 && !allowRoot) break;
        const name = rest.slice(0, j + 1).join('/');
        const e = (await archiveEntries(src)).get(name);
        if (!e) continue; // a folder that merely looks like an archive
        src = await nestedSource(src, e);
        rest = rest.slice(j + 1);
        j = -1;
    }
    return { src, inner: rest.join('/') };
}

function zipError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function u64(view, off) {
    return Number(view.getBigUint64(off, true));
}

function dosDateToMs(date, time) {
    const d = new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f,
        (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
    return isNaN(d) ? 0 : d.getTime();
}

async function zipCentralDirectory(src) {
    const hit = zipDirs.get(src.key);
    if (hit && Date.now() - hit.at < ZIP_CD_TTL_MS) return hit.entries;

    const tail = await zipRange(src, 65557);
    const t = new DataView(tail.buf.buffer, tail.buf.byteOffset, tail.buf.byteLength);
    let eocd = -1;
    for (let i = tail.buf.length - 22; i >= 0; i--) {
        if (t.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw zipError(415, 'Not a zip archive');
    let count = t.getUint16(eocd + 10, true);
    let cdSize = t.getUint32(eocd + 12, true);
    let cdOffset = t.getUint32(eocd + 16, true);
    if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && eocd >= 20
        && t.getUint32(eocd - 20, true) === 0x07064b50) {
        const z64Pos = u64(t, eocd - 20 + 8);
        const z = await zipRange(src, z64Pos, z64Pos + 55);
        const zv = new DataView(z.buf.buffer, z.buf.byteOffset, z.buf.byteLength);
        if (zv.getUint32(0, true) !== 0x06064b50) throw zipError(415, 'Bad zip64 record');
        count = u64(zv, 32);
        cdSize = u64(zv, 40);
        cdOffset = u64(zv, 48);
    }

    const cdBuf = cdSize ? (await zipRange(src, cdOffset, cdOffset + cdSize - 1)).buf : new Uint8Array(0);
    const cd = new DataView(cdBuf.buffer, cdBuf.byteOffset, cdBuf.byteLength);
    const utf8 = new TextDecoder('utf-8');
    const latin1 = new TextDecoder('latin1');
    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cdBuf.length; n++) {
        if (cd.getUint32(p, true) !== 0x02014b50) throw zipError(415, 'Corrupt zip central directory');
        const flags = cd.getUint16(p + 8, true);
        const method = cd.getUint16(p + 10, true);
        const time = cd.getUint16(p + 12, true), date = cd.getUint16(p + 14, true);
        let compSize = cd.getUint32(p + 20, true);
        let size = cd.getUint32(p + 24, true);
        const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
        let offset = cd.getUint32(p + 42, true);
        const rawName = cdBuf.subarray(p + 46, p + 46 + nameLen);
        const name = ((flags & 0x800) ? utf8 : latin1).decode(rawName).replace(/\\/g, '/').replace(/^\/+/, '');
        let x = p + 46 + nameLen;
        const xEnd = x + extraLen;
        while (x + 4 <= xEnd) {
            const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
            if (id === 0x0001) { // zip64 sizes/offset, only for fields that overflowed
                let q = x + 4;
                if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
                if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
                if (offset === 0xffffffff) { offset = u64(cd, q); }
            }
            x += 4 + len;
        }
        if (name) entries.set(name, { name, method, compSize, size, offset, encrypted: !!(flags & 1), mtimeMs: dosDateToMs(date, time) });
        p += 46 + nameLen + extraLen + commentLen;
    }
    zipDirs.set(src.key, { at: Date.now(), entries });
    if (zipDirs.size > 4) zipDirs.delete(zipDirs.keys().next().value);
    return entries;
}

// --- Tar ---
// Tar has no index and is usually compressed as one stream, so it is read as a
// stream: download → decompress → parse, without holding the whole archive. The
// first pass records every entry (and keeps small files); a larger file is read by
// a second pass that stops once it has the file.

const TAR_KEEP_FILE = 1024 * 1024;       // files up to this size are kept from the index pass
const TAR_KEEP_TOTAL = 64 * 1024 * 1024; // ... up to this much per archive
const TAR_INDEX_TTL_MS = 5 * 60 * 1000;

function tarString(bytes, start, len) {
    let end = start;
    while (end < start + len && bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(start, end));
}

function tarNumber(bytes, start, len) {
    if (bytes[start] & 0x80) { // GNU base-256 for large values
        let n = 0;
        for (let i = start + 1; i < start + len; i++) n = n * 256 + bytes[i];
        return n;
    }
    const s = tarString(bytes, start, len).trim();
    return s ? parseInt(s, 8) || 0 : 0;
}

// Compressed bytes of an archive, as chunks
async function* sourceChunks(src, signal) {
    if (src.stream) { yield* src.stream(signal); return; }
    yield await src.all();
}

async function* gunzipChunks(chunks) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const pump = (async () => {
        for await (const c of chunks) await writer.write(c);
        await writer.close();
    })().catch(err => writer.abort(err).catch(() => {}));
    const reader = ds.readable.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            yield value;
        }
        await pump;
    } finally {
        reader.cancel().catch(() => {});
    }
}

// fzstd's one-shot decompress() rejects frames without a recorded size (as made by
// streaming compressors, e.g. makepkg), so always use its streaming decoder
async function* unzstdChunks(chunks) {
    const out = [];
    const d = new fzstd.Decompress((chunk) => out.push(chunk.slice()));
    let prev = null;
    for await (const c of chunks) {
        if (prev) d.push(prev);
        prev = c;
        while (out.length) yield out.shift();
    }
    d.push(prev || new Uint8Array(0), true);
    while (out.length) yield out.shift();
}

function tarChunks(src, signal) {
    const raw = sourceChunks(src, signal);
    if (/\.(tgz|gz)$/i.test(src.key)) return gunzipChunks(raw);
    if (/\.(tzst|zst)$/i.test(src.key)) return unzstdChunks(raw);
    return raw;
}

// Walk the archive. onEntry(meta) → true to receive the file's bytes in onData(meta, bytes);
// onData returning true stops the walk. Entries are keyed like the zip central
// directory: files by path, folders as "path/".
async function tarWalk(src, onEntry, onData) {
    const ctl = new AbortController();
    const hdr = new Uint8Array(512);
    let hfill = 0, remain = 0, pad = 0, meta = null, collect = null, cpos = 0, offset = 0, ended = false;
    let longName = null, paxPath = null;

    const finish = () => {
        const data = collect;
        const m = meta;
        collect = null; meta = null;
        if (m.special === 'L') longName = tarString(data, 0, data.length);
        else if (m.special === 'x') {
            const found = new TextDecoder().decode(data).match(/^\d+ path=(.*)$/m);
            if (found) paxPath = found[1];
        } else if (data && onData(m, data)) ended = true;
    };

    const header = () => {
        if (hdr.every(b => b === 0)) { ended = true; return; }
        const size = tarNumber(hdr, 124, 12);
        const type = String.fromCharCode(hdr[156] || 48);
        remain = size;
        pad = (512 - (size % 512)) % 512;
        if (type === 'L' || type === 'x') {
            meta = { special: type };
            collect = new Uint8Array(size); cpos = 0;
        } else if (type === 'g' || type === 'K') {
            meta = { special: type };
        } else {
            const prefix = tarString(hdr, 257, 6).startsWith('ustar') ? tarString(hdr, 345, 155) : '';
            let name = paxPath || longName || (prefix ? prefix + '/' : '') + tarString(hdr, 0, 100);
            longName = paxPath = null;
            name = name.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
            const isDir = type === '5' || name.endsWith('/');
            name = name.replace(/\/+$/, '');
            meta = { name, size, offset, mtimeMs: tarNumber(hdr, 136, 12) * 1000, type,
                isDir, link: type === '1' ? tarString(hdr, 157, 100).replace(/^(\.\/)+/, '') : null };
            const content = !isDir && (type === '0' || type === '7' || type === '\0');
            if (name && onEntry(meta) && content) { collect = new Uint8Array(size); cpos = 0; }
        }
        if (remain === 0 && collect) finish();
        else if (remain === 0) meta = null;
    };

    try {
        for await (const chunk of tarChunks(src, ctl.signal)) {
            let i = 0;
            while (i < chunk.length && !ended) {
                if (remain > 0) {
                    const n = Math.min(remain, chunk.length - i);
                    if (collect) { collect.set(chunk.subarray(i, i + n), cpos); cpos += n; }
                    i += n; remain -= n; offset += n;
                    if (remain === 0) { if (collect) finish(); else meta = null; }
                } else if (pad > 0) {
                    const n = Math.min(pad, chunk.length - i);
                    i += n; pad -= n; offset += n;
                } else {
                    const n = Math.min(512 - hfill, chunk.length - i);
                    hdr.set(chunk.subarray(i, i + n), hfill);
                    hfill += n; i += n; offset += n;
                    if (hfill === 512) { hfill = 0; header(); }
                }
            }
            if (ended) break;
        }
    } catch (err) {
        if (!err.status) throw zipError(415, `Cannot read ${src.key.split('/').pop()}: ${err.message}`);
        throw err;
    } finally {
        ctl.abort();
    }
}

async function tarIndex(src) {
    const hit = tarIndexes.get(src.key);
    if (hit && Date.now() - hit.at < TAR_INDEX_TTL_MS) return hit;
    const entries = new Map();
    const kept = new Map();
    let keptBytes = 0;
    await tarWalk(src, (m) => {
        const segs = m.name.split('/');
        for (let i = 1; i < segs.length; i++) {
            const dir = segs.slice(0, i).join('/') + '/';
            if (!entries.has(dir)) entries.set(dir, { name: dir, size: 0, mtimeMs: m.mtimeMs, dir: true });
        }
        if (m.isDir) entries.set(m.name + '/', { name: m.name + '/', size: 0, mtimeMs: m.mtimeMs, dir: true });
        else if (m.link) entries.set(m.name, { name: m.name, size: 0, mtimeMs: m.mtimeMs, link: m.link });
        else if (m.type === '0' || m.type === '7' || m.type === '\0') entries.set(m.name, { name: m.name, size: m.size, mtimeMs: m.mtimeMs });
        // symlinks, devices and fifos have no content to show
        return m.size <= TAR_KEEP_FILE && keptBytes + m.size <= TAR_KEEP_TOTAL;
    }, (m, data) => {
        kept.set(m.name, data);
        keptBytes += data.length;
        return false;
    });
    const index = { at: Date.now(), entries, kept, size: keptBytes };
    tarIndexes.set(src.key, index);
    trimToBudget(tarIndexes, src.key);
    return index;
}

async function tarRead(src, inner) {
    const { entries, kept } = await tarIndex(src);
    let e = entries.get(inner);
    if (e && e.link) e = entries.get(e.link); // hard link: the content lives under the target's name
    if (!e || e.dir) throw zipError(404, `No file ${inner} in archive`);
    if (kept.has(e.name)) return kept.get(e.name);
    let found = null;
    await tarWalk(src, (m) => m.name === e.name, (m, data) => { found = data; return true; });
    if (!found) throw zipError(404, `No file ${inner} in archive`);
    return found;
}

// --- Single compressed file (.gz, .zst) ---

function singleName(key) {
    return key.split('/').pop().replace(SINGLE_RE, '') || 'data';
}

// The one entry, with its uncompressed size when the file records it: gzip's
// trailer (mod 4 GiB, fine for a listing), zstd's frame header if present
async function singleEntries(src) {
    const name = singleName(src.key);
    let size = 0;
    try {
        if (/\.gz$/i.test(src.key)) {
            const { buf } = await src.range(4);
            if (buf.length === 4) size = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
        } else {
            const { buf: h } = await src.range(0, 17);
            if (h.length >= 6 && h[0] === 0x28 && h[1] === 0xb5 && h[2] === 0x2f && h[3] === 0xfd) {
                const fhd = h[4], fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, didFlag = fhd & 3;
                const pos = 5 + (single ? 0 : 1) + [0, 1, 2, 4][didFlag];
                const fcsLen = [single ? 1 : 0, 2, 4, 8][fcsFlag];
                const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
                if (fcsLen && pos + fcsLen <= h.length) {
                    size = fcsLen === 1 ? h[pos] : fcsLen === 2 ? v.getUint16(pos, true) + 256
                        : fcsLen === 4 ? v.getUint32(pos, true) : Number(v.getBigUint64(pos, true));
                }
            }
        }
    } catch (_) { /* size stays unknown */ }
    return new Map([[name, { name, size, mtimeMs: 0 }]]);
}

async function singleRead(src, inner) {
    if (inner !== singleName(src.key)) throw zipError(404, `No file ${inner} in archive`);
    const key = src.key + '/' + inner;
    const hit = zipNested.get(key);
    if (hit && Date.now() - hit.at < ZIP_CD_TTL_MS) return hit.bytes;
    const parts = [];
    let total = 0;
    try {
        for await (const c of tarChunks(src)) { parts.push(c); total += c.length; }
    } catch (err) {
        throw zipError(415, `Cannot decompress ${src.key.split('/').pop()}: ${err.message}`);
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of parts) { bytes.set(c, off); off += c.length; }
    zipNested.set(key, { at: Date.now(), bytes });
    trimToBudget(zipNested, key);
    return bytes;
}

// --- Disc images ---
// Entries are keyed like tar's (folders as "path/"); a file is { size, extents:
// [[byte offset, length]] } (a file may be in pieces), or { inline } for UDF
// files small enough to live in their file entry.

const ISO_SECTOR = 2048;
const ISO_MAX_ENTRIES = 500000;

async function isoSectors(src, lba, count = 1) {
    return (await src.range(lba * ISO_SECTOR, (lba + count) * ISO_SECTOR - 1)).buf;
}

function isoView(b) {
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

// The bytes of a list of extents (a directory, or a file)
async function isoReadExtents(src, extents, size) {
    const out = new Uint8Array(size);
    let at = 0;
    for (const [off, len, unrecorded] of extents) {
        const n = Math.min(len, size - at);
        if (n <= 0) break;
        if (!unrecorded) out.set((await src.range(off, off + n - 1)).buf.subarray(0, n), at);
        at += n;
    }
    return out;
}

function isoAddEntry(entries, name, e) {
    if (entries.size >= ISO_MAX_ENTRIES) throw zipError(415, 'Too many files in disc image');
    const segs = name.split('/');
    for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/') + '/';
        if (!entries.has(dir)) entries.set(dir, { name: dir, size: 0, mtimeMs: e.mtimeMs, dir: true });
    }
    entries.set(e.dir ? name + '/' : name, { ...e, name: e.dir ? name + '/' : name });
}

// ISO 9660 recording date: years since 1900, month, day, h, m, s, offset in 15 minutes
function isoDate(b, p) {
    const t = Date.UTC(1900 + b[p], b[p + 1] - 1, b[p + 2], b[p + 3], b[p + 4], b[p + 5]);
    return isNaN(t) ? 0 : t - ((b[p + 6] << 24) >> 24) * 15 * 60000;
}

// Rock Ridge name (SUSP "NM" entries) from a directory record's system use area
function rockRidgeName(b, start, end) {
    let name = null;
    for (let p = start; p + 4 <= end;) {
        const len = b[p + 2];
        if (len < 4) break;
        if (b[p] === 0x4e && b[p + 1] === 0x4d) { // NM
            const flags = b[p + 4];
            if (!(flags & 6)) name = (name || '') + new TextDecoder().decode(b.subarray(p + 5, p + len));
        }
        p += len;
    }
    return name;
}

async function iso9660Entries(src, vd, joliet) {
    const entries = new Map();
    const seen = new Set();
    const utf16be = new TextDecoder('utf-16be');
    const latin1 = new TextDecoder('latin1');
    const walk = async (lba, size, prefix) => {
        if (seen.has(lba) || !size) return;
        seen.add(lba);
        const b = await isoReadExtents(src, [[lba * ISO_SECTOR, size]], size);
        const pending = new Map(); // name -> entry, for files recorded in several extents
        const subdirs = [];
        for (let p = 0; p < b.length;) {
            const len = b[p];
            if (!len) { p = (Math.floor(p / ISO_SECTOR) + 1) * ISO_SECTOR; continue; }
            if (p + len > b.length || len < 34) break;
            const v = isoView(b.subarray(p, p + len));
            const ext = v.getUint32(2, true), dataLen = v.getUint32(10, true);
            const flags = b[p + 25], nameLen = b[p + 32];
            const raw = b.subarray(p + 33, p + 33 + nameLen);
            if (!(nameLen === 1 && raw[0] <= 1)) { // not "." or ".."
                let name = joliet ? utf16be.decode(raw) : null;
                if (!joliet) {
                    const su = p + 33 + nameLen + (nameLen % 2 ? 0 : 1);
                    name = rockRidgeName(b, su, p + len) || latin1.decode(raw).replace(/;\d+$/, '').replace(/\.$/, '');
                }
                name = name.replace(/;\d+$/, '').replace(/\//g, '_');
                const full = prefix + name;
                const mtimeMs = isoDate(b, p + 18);
                if (flags & 2) {
                    subdirs.push([ext, dataLen, full + '/']);
                    isoAddEntry(entries, full, { size: 0, mtimeMs, dir: true });
                } else {
                    let e = pending.get(full);
                    if (!e) { e = { size: 0, mtimeMs, extents: [] }; pending.set(full, e); }
                    e.extents.push([ext * ISO_SECTOR, dataLen]);
                    e.size += dataLen;
                    if (!(flags & 0x80)) isoAddEntry(entries, full, e); // last (or only) extent
                }
            }
            p += len;
        }
        for (const [ext, len, pre] of subdirs) await walk(ext, len, pre);
    };
    const root = vd.subarray(156, 156 + 34);
    const rv = isoView(root);
    await walk(rv.getUint32(2, true), rv.getUint32(10, true), '');
    return entries;
}

// --- UDF (ECMA-167 / OSTA UDF, plain partition maps) ---

function udfTime(b, p) {
    const v = isoView(b);
    const tz = v.getUint16(p, true) & 0xfff;
    const off = tz === 0xfff ? 0 : (tz << 20) >> 20; // minutes, signed 12 bits
    const t = Date.UTC(v.getInt16(p + 2, true), b[p + 4] - 1, b[p + 5], b[p + 6], b[p + 7], b[p + 8]);
    return isNaN(t) ? 0 : t - off * 60000;
}

// A dstring: compression id, characters, and its used length in the last byte
function udfDString(b, at, size) {
    const len = b[at + size - 1];
    return len ? udfName(b.subarray(at, at + Math.min(len, size - 1))).replace(/\0+$/, '') : '';
}

// An entity identifier (regid): flags, then 23 bytes of name
function udfRegid(b, at) {
    return new TextDecoder('latin1').decode(b.subarray(at + 1, at + 24)).replace(/\0+$/, '').trim();
}

function udfName(b) {
    if (!b.length) return '';
    if (b[0] === 16) return new TextDecoder('utf-16be').decode(b.subarray(1));
    return new TextDecoder('latin1').decode(b.subarray(1));
}

async function udfEntries(src, info = {}) {
    const avdp = await isoSectors(src, 256);
    const av = isoView(avdp);
    if (av.getUint16(0, true) !== 2) throw zipError(415, 'No UDF anchor');
    const vdsLen = av.getUint32(16, true), vdsLoc = av.getUint32(20, true);
    const vds = await isoSectors(src, vdsLoc, Math.min(64, Math.ceil(vdsLen / ISO_SECTOR)));
    const parts = new Map(); // partition number -> start sector
    let lvd = null;
    for (let s = 0; s * ISO_SECTOR < vds.length; s++) {
        const d = vds.subarray(s * ISO_SECTOR, (s + 1) * ISO_SECTOR);
        const dv = isoView(d);
        const tag = dv.getUint16(0, true);
        if (tag === 5) {
            parts.set(dv.getUint16(22, true), dv.getUint32(188, true));
            info.partitions = (info.partitions || []).concat([{ number: dv.getUint16(22, true), start: dv.getUint32(188, true), length: dv.getUint32(192, true) }]);
        } else if (tag === 1 && !info.pvd) {
            info.pvd = {
                volumeId: udfDString(d, 24, 32), volumeSetId: udfDString(d, 72, 128),
                application: udfRegid(d, 344), recorded: udfTime(d, 376), implementation: udfRegid(d, 388),
            };
        } else if (tag === 6 && !lvd) lvd = d;
        else if (tag === 8) break;
    }
    if (!lvd) throw zipError(415, 'No UDF logical volume');
    const lv = isoView(lvd);
    // UDF revision: the domain identifier's suffix, e.g. 0x0102 = 1.02
    const rev = lv.getUint16(216 + 24, true);
    info.lvd = {
        volumeId: udfDString(lvd, 84, 128), domain: udfRegid(lvd, 216),
        revision: rev ? `${rev >> 8}.${(rev & 0xff).toString(16).padStart(2, '0')}` : '', implementation: udfRegid(lvd, 272),
        maps: [],
    };
    for (let i = 0, p = 440; i < lv.getUint32(268, true) && p < lvd.length; i++) {
        info.lvd.maps.push(lvd[p] === 1 ? 'type 1 (physical)' : `type ${lvd[p]} (${udfRegid(lvd, p + 4) || '?'})`);
        p += lvd[p + 1] || 6;
    }
    if (lv.getUint32(212, true) !== ISO_SECTOR) throw zipError(415, 'Unsupported UDF block size');
    // Partition maps: only type 1 (a plain partition); others (metadata, virtual, sparable) are not read
    const maps = [];
    for (let i = 0, p = 440; i < lv.getUint32(268, true); i++) {
        const type = lvd[p], len = lvd[p + 1];
        if (type !== 1) throw zipError(415, 'Unsupported UDF partition map');
        maps.push(parts.get(lv.getUint16(p + 4, true)));
        p += len;
    }
    const sector = (ref, lbn) => {
        const start = maps[ref];
        if (start === undefined) throw zipError(415, 'Bad UDF partition reference');
        return start + lbn;
    };
    const fsd = await isoSectors(src, sector(lv.getUint16(256, true), lv.getUint32(252, true)));
    const fv = isoView(fsd);
    if (fv.getUint16(0, true) !== 256) throw zipError(415, 'No UDF file set');

    // A file entry: its type, size, time and where its data is
    const readEntry = async (ref, lbn) => {
        const fe = await isoSectors(src, sector(ref, lbn));
        const v = isoView(fe);
        const tag = v.getUint16(0, true);
        if (tag !== 261 && tag !== 266) throw zipError(415, 'Bad UDF file entry');
        const ext = tag === 266;
        const fileType = fe[27];
        const adType = v.getUint16(34, true) & 7;
        const size = Number(v.getBigUint64(56, true));
        const mtimeMs = udfTime(fe, ext ? 92 : 84);
        const lEA = v.getUint32(ext ? 208 : 168, true), lAD = v.getUint32(ext ? 212 : 172, true);
        const ad = (ext ? 216 : 176) + lEA;
        const e = { fileType, size, mtimeMs, extents: [] };
        if (adType === 3) { e.inline = fe.slice(ad, ad + Math.min(lAD, size)); return e; }
        const step = adType === 0 ? 8 : adType === 1 ? 16 : 0;
        if (!step) throw zipError(415, 'Unsupported UDF allocation');
        for (let p = ad; p + step <= ad + lAD && p + step <= fe.length; p += step) {
            const raw = v.getUint32(p, true);
            const len = raw & 0x3fffffff, kind = raw >>> 30;
            if (!len) break;
            if (kind === 3) break; // continuation of the descriptors elsewhere: not followed
            const pos = v.getUint32(p + 4, true);
            const pref = step === 16 ? v.getUint16(p + 8, true) : ref;
            e.extents.push([sector(pref, pos) * ISO_SECTOR, len, kind !== 0]);
        }
        return e;
    };

    const entries = new Map();
    const seen = new Set();
    const walk = async (ref, lbn, prefix) => {
        const key = ref + ':' + lbn;
        if (seen.has(key)) return;
        seen.add(key);
        const dir = await readEntry(ref, lbn);
        const b = dir.inline || await isoReadExtents(src, dir.extents, dir.size);
        const v = isoView(b);
        const subdirs = [];
        for (let p = 0; p + 38 <= b.length;) {
            if (v.getUint16(p, true) !== 257) break;
            const chars = b[p + 18], lFI = b[p + 19], lIU = v.getUint16(p + 36, true);
            const icbLbn = v.getUint32(p + 24, true), icbRef = v.getUint16(p + 28, true);
            const name = udfName(b.subarray(p + 38 + lIU, p + 38 + lIU + lFI)).replace(/\//g, '_');
            p += (38 + lIU + lFI + 3) & ~3;
            if (chars & 0x0c || !name) continue; // deleted, or the parent
            const full = prefix + name;
            if (chars & 0x02) {
                subdirs.push([icbRef, icbLbn, full + '/']);
                isoAddEntry(entries, full, { size: 0, mtimeMs: 0, dir: true });
            } else {
                const e = await readEntry(icbRef, icbLbn);
                if (e.fileType === 12) continue; // symlink
                isoAddEntry(entries, full, { size: e.size, mtimeMs: e.mtimeMs, extents: e.extents, inline: e.inline });
            }
        }
        for (const [r, l, pre] of subdirs) await walk(r, l, pre);
    };
    await walk(fv.getUint16(408, true), fv.getUint32(404, true), '');
    return entries;
}

async function isoEntries(src) {
    const hit = isoIndexes.get(src.key);
    if (hit && Date.now() - hit.at < ZIP_CD_TTL_MS * 20) return hit.entries;
    // Volume descriptors from sector 16; UDF announces itself there too (NSR02/NSR03)
    const vds = await isoSectors(src, 16, 16);
    let pvd = null, joliet = null, udf = false, boot = null;
    const descriptors = [];
    for (let s = 0; (s + 1) * ISO_SECTOR <= vds.length; s++) {
        const d = vds.subarray(s * ISO_SECTOR, (s + 1) * ISO_SECTOR);
        const id = String.fromCharCode(...d.subarray(1, 6));
        if (id === 'CD001') {
            descriptors.push({ sector: 16 + s, type: d[0] });
            if (d[0] === 1 && !pvd) pvd = d;
            else if (d[0] === 0 && !boot) boot = d;
            else if (d[0] === 2 && d[88] === 0x25 && d[89] === 0x2f && [0x40, 0x43, 0x45].includes(d[90])) joliet = d;
        } else if (id === 'NSR02' || id === 'NSR03') { udf = id; descriptors.push({ sector: 16 + s, id }); }
        else if (/^(BEA01|TEA01|BOOT2|CDW02)$/.test(id)) descriptors.push({ sector: 16 + s, id });
        else break;
    }
    let entries = null, used = null;
    const udfInfo = {};
    if (udf) {
        try {
            entries = await udfEntries(src, udfInfo);
            used = 'UDF';
        } catch (err) {
            if (!pvd) throw err;
            udfInfo.error = err.message; // UDF we can't read: the ISO 9660 side
            entries = null;
        }
    }
    if (!entries) {
        if (!pvd) throw zipError(415, 'Not a disc image (no ISO 9660 or UDF volume)');
        entries = await iso9660Entries(src, joliet || pvd, !!joliet);
        used = joliet ? 'Joliet' : 'ISO 9660';
    }
    try {
        await isoAddMetadata(src, entries, { pvd, joliet, boot, udf, udfInfo, used, descriptors });
    } catch (err) {
        entries.set('[INFO].txt', { name: '[INFO].txt', size: 0, mtimeMs: 0, inline: new TextEncoder().encode(`Could not read the disc's metadata: ${err.message}\n`) });
    }
    isoIndexes.set(src.key, { at: Date.now(), entries });
    if (isoIndexes.size > 4) isoIndexes.delete(isoIndexes.keys().next().value);
    return entries;
}

// --- What a disc image holds besides its files ---
// [INFO].txt: volume descriptors, file systems, El Torito boot catalog and the
// partition tables of hybrid images (bootable from USB too); [BOOT]/: the El
// Torito boot images; [PARTITIONS]/: the partitions of those tables, as files

const ELTORITO_PLATFORMS = { 0: 'x86 (BIOS)', 1: 'PowerPC', 2: 'Mac', 0xef: 'UEFI' };
const ELTORITO_MEDIA = ['no emulation', '1.2 MB floppy', '1.44 MB floppy', '2.88 MB floppy', 'hard disk'];
const FLOPPY_SIZES = [0, 1228800, 1474560, 2949120];
const MBR_TYPES = {
    0x00: 'empty', 0x01: 'FAT12', 0x04: 'FAT16 <32M', 0x06: 'FAT16', 0x07: 'NTFS/exFAT', 0x0b: 'FAT32', 0x0c: 'FAT32 LBA',
    0x0e: 'FAT16 LBA', 0x17: 'hidden NTFS (isohybrid)', 0x82: 'Linux swap', 0x83: 'Linux', 0x96: 'ISO 9660 (CHRP)',
    0xa5: 'FreeBSD', 0xa6: 'OpenBSD', 0xa9: 'NetBSD', 0xaf: 'HFS/HFS+', 0xcd: 'ISO 9660 (isohybrid)', 0xee: 'GPT protective', 0xef: 'EFI system',
};
const GPT_TYPES = {
    'c12a7328-f81f-11d2-ba4b-00a0c93ec93b': 'EFI system', 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7': 'Basic data',
    '0fc63daf-8483-4772-8e79-3d69d8477de4': 'Linux filesystem', '21686148-6449-6e6f-744e-656564454649': 'BIOS boot',
    '48465300-0000-11aa-aa11-00306543ecac': 'Apple HFS+', 'e3c9e316-0b5c-4db8-817d-f92df00215ae': 'Microsoft reserved',
    'de94bba4-06d1-4d40-a16a-bfd50179d6ac': 'Windows recovery', '024dee41-33e7-11d3-9d69-0008c781f39f': 'MBR partition scheme',
};

function isoText(b, at, len, utf16) {
    // UCS-2 in Joliet: an odd-sized field's last byte is padding
    const s = new TextDecoder(utf16 ? 'utf-16be' : 'latin1').decode(b.subarray(at, at + (utf16 ? len & ~1 : len)));
    return s.replace(/[\0 ]+$/, '');
}

// ISO 9660 descriptor date: "YYYYMMDDHHMMSScc" digits, then the offset in 15 minutes
function isoLongDate(b, at) {
    const s = new TextDecoder('latin1').decode(b.subarray(at, at + 16));
    if (!/^\d{16}$/.test(s) || /^0+$/.test(s)) return '';
    const off = (b[at + 16] << 24) >> 24;
    const t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14), +s.slice(14, 16) * 10) - off * 15 * 60000;
    return isNaN(t) ? s : new Date(t).toISOString().replace('.000Z', 'Z');
}

function guidString(b, at) {
    const h = i => b[at + i].toString(16).padStart(2, '0');
    return [3, 2, 1, 0].map(h).join('') + '-' + [5, 4].map(h).join('') + '-' + [7, 6].map(h).join('') + '-'
        + [8, 9].map(h).join('') + '-' + [10, 11, 12, 13, 14, 15].map(h).join('');
}

const mib = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} bytes`;

async function isoAddMetadata(src, entries, { pvd, joliet, boot, udf, udfInfo, used, descriptors }) {
    const lines = [];
    const out = (...l) => lines.push(...l);
    const field = (label, value) => { if (value !== '' && value !== undefined && value !== null) out(`  ${(label ? label + ':' : '').padEnd(24)} ${value}`); };
    const virtual = []; // [name, entry]
    // Files by where their data starts, to name what a boot entry or partition points at
    const byStart = new Map();
    for (const e of entries.values()) if (e.extents && e.extents.length) byStart.set(e.extents[0][0], e);
    const fileAt = off => { const e = byStart.get(off); return e ? ` \u2192 ${e.name} (${mib(e.size)})` : ''; };

    out(`Disc image: ${src.key.split('/').pop()}`, '');
    out('File systems');
    const fs = [];
    let rr = null;
    if (pvd) {
        fs.push('ISO 9660');
        if (joliet) fs.push(`Joliet (level ${{ 0x40: 1, 0x43: 2, 0x45: 3 }[joliet[90]]})`);
        rr = await rockRidgeInfo(src, pvd);
        if (rr) fs.push(`Rock Ridge${rr.id ? ` (${rr.id})` : ''}`);
    }
    if (udf) fs.push(`UDF${udfInfo.lvd && udfInfo.lvd.revision ? ' ' + udfInfo.lvd.revision : ''} (${udf})`);
    field('Present', fs.join(', '));
    field('Files listed from', used);
    if (udfInfo.error) field('UDF not read', udfInfo.error);
    field('Volume descriptors', descriptors.map(d => `${d.sector}: ${d.id || (d.type === 255 ? 'terminator' : ['boot record', 'primary', 'supplementary', 'partition'][d.type] || 'type ' + d.type)}`).join(', '));

    let totalSize = 0;
    const describe = (d, utf16) => {
        const v = isoView(d);
        const block = v.getUint16(128, true), blocks = v.getUint32(80, true);
        return [
            ['System', isoText(d, 8, 32, utf16)],
            ['Volume', isoText(d, 40, 32, utf16)],
            ['Size', `${blocks} blocks of ${block} bytes (${mib(block * blocks)})`],
            ['Volume set', isoText(d, 190, 128, utf16)],
            ['Publisher', isoText(d, 318, 128, utf16)],
            ['Data preparer', isoText(d, 446, 128, utf16)],
            ['Application', isoText(d, 574, 128, utf16)],
            ['Copyright file', isoText(d, 702, 37, utf16)],
            ['Abstract file', isoText(d, 739, 37, utf16)],
            ['Bibliographic file', isoText(d, 776, 37, utf16)],
            ['Created', isoLongDate(d, 813)],
            ['Modified', isoLongDate(d, 830)],
            ['Expires', isoLongDate(d, 847)],
            ['Effective', isoLongDate(d, 864)],
        ];
    };
    if (pvd) {
        totalSize = isoView(pvd).getUint16(128, true) * isoView(pvd).getUint32(80, true);
        out('', 'Primary volume descriptor (ISO 9660)');
        for (const [k, v] of describe(pvd, false)) field(k, v);
    }
    if (joliet) {
        // Only what differs from the primary descriptor (Joliet's volume name is Unicode, but at most 16 characters)
        const primary = pvd ? new Map(describe(pvd, false)) : new Map();
        const diff = describe(joliet, true).filter(([k, v]) => v && v !== primary.get(k) && !(primary.get(k) || '').startsWith(v));
        out('', 'Joliet volume descriptor' + (diff.length ? '' : ': same as the primary'));
        for (const [k, v] of diff) field(k, v);
    }
    if (udfInfo.pvd || udfInfo.lvd) {
        out('', 'UDF volume');
        if (udfInfo.pvd) {
            field('Volume', udfInfo.pvd.volumeId);
            field('Volume set', udfInfo.pvd.volumeSetId);
            field('Recorded', udfInfo.pvd.recorded ? new Date(udfInfo.pvd.recorded).toISOString().replace('.000Z', 'Z') : '');
            field('Application', udfInfo.pvd.application);
            field('Made by', udfInfo.pvd.implementation);
        }
        if (udfInfo.lvd) {
            field('Logical volume', udfInfo.lvd.volumeId);
            field('Domain', udfInfo.lvd.domain + (udfInfo.lvd.revision ? `, UDF ${udfInfo.lvd.revision}` : ''));
            field('Partition maps', udfInfo.lvd.maps.join(', '));
        }
        for (const p of udfInfo.partitions || []) field(`Partition ${p.number}`, `sectors ${p.start}\u2013${p.start + p.length - 1} (${mib(p.length * ISO_SECTOR)})`);
    }

    // El Torito
    if (boot && isoText(boot, 7, 32) === 'EL TORITO SPECIFICATION') {
        const catLba = isoView(boot).getUint32(71, true);
        out('', `El Torito boot catalog (sector ${catLba})`);
        const cat = await isoSectors(src, catLba);
        const cv = isoView(cat);
        if (cat[0] !== 1 || cat[30] !== 0x55 || cat[31] !== 0xaa) {
            out('  (the validation entry is not valid)');
        } else {
            let platform = cat[1];
            field('Validation entry', `platform ${ELTORITO_PLATFORMS[platform] || '0x' + platform.toString(16)}${isoText(cat, 4, 24) ? `, "${isoText(cat, 4, 24)}"` : ''}`);
            let n = 0;
            const entry = (p, label) => {
                const media = cat[p + 1] & 0x0f;
                const count = cv.getUint16(p + 6, true), rba = cv.getUint32(p + 8, true);
                const target = byStart.get(rba * ISO_SECTOR);
                // As 7-Zip does: the loaded sectors; a floppy image its whole size; a
                // no-emulation entry loading 0 or 1 sector (big EFI images) the file there
                let size = count * 512;
                if (media >= 1 && media <= 3) size = FLOPPY_SIZES[media];
                else if (count <= 1 && target) size = target.size;
                size = size || ISO_SECTOR;
                n++;
                const pname = { 0: 'BIOS', 0xef: 'UEFI', 1: 'PPC', 2: 'Mac' }[platform] || 'platform' + platform;
                const name = `${n}-${pname}-${['NoEmul', 'Floppy1.2M', 'Floppy1.44M', 'Floppy2.88M', 'HardDisk'][media] || 'media' + media}.img`;
                field(label, `${cat[p] === 0x88 ? 'bootable' : 'not bootable'}, ${ELTORITO_PLATFORMS[platform] || 'platform 0x' + platform.toString(16)}, ${ELTORITO_MEDIA[media] || 'media ' + media}`
                    + `, load segment 0x${(cv.getUint16(p + 2, true) || 0x7c0).toString(16).padStart(4, '0')}, ${count} \u00D7 512 bytes from sector ${rba}${fileAt(rba * ISO_SECTOR)}`);
                field('', `\u2192 [BOOT]/${name} (${mib(size)})`);
                virtual.push([`[BOOT]/${name}`, { size, mtimeMs: 0, extents: [[rba * ISO_SECTOR, size]] }]);
            };
            entry(32, 'Default entry');
            for (let p = 64; p + 32 <= cat.length;) {
                const hdr = cat[p];
                if (hdr !== 0x90 && hdr !== 0x91) break;
                platform = cat[p + 1];
                const count = cv.getUint16(p + 2, true);
                field('Section', `${ELTORITO_PLATFORMS[platform] || 'platform 0x' + platform.toString(16)}, ${count} entr${count === 1 ? 'y' : 'ies'}${isoText(cat, p + 4, 28) ? `, "${isoText(cat, p + 4, 28)}"` : ''}`);
                p += 32;
                for (let i = 0; i < count && p + 32 <= cat.length; i++) {
                    if (cat[p] === 0x44) { p += 32; i--; continue; } // extension record of the entry before
                    entry(p, '  Entry');
                    p += 32;
                }
                if (hdr === 0x91) break;
            }
        }
    }

    // Partition tables of hybrid images (the system area, the first 32 KB)
    const sys = (await src.range(0, 32767)).buf;
    const table = await partitionTables(src, sys, fileAt, ' (hybrid: also boots from a USB stick)');
    for (const pt of table.parts) {
        if (!pt.offset || !pt.size || (totalSize && pt.offset >= totalSize)) continue;
        const name = `[PARTITIONS]/${pt.id}-${pt.label.replace(/[^\w+.-]+/g, '_')}.img`;
        virtual.push([name, { size: pt.size, mtimeMs: 0, extents: [[pt.offset, pt.size]] }]);
        pt.line.text += ` \u2192 ${name}`;
    }
    out(...table.lines.map(l => typeof l === 'string' ? l : l.text));
    if (!sys.some(b => b)) out('', 'System area (first 32 KB): empty');

    out('');
    const text = new TextEncoder().encode(lines.join('\n'));
    isoAddEntry(entries, '[INFO].txt', { size: text.length, mtimeMs: 0, inline: text });
    for (const [name, e] of virtual) isoAddEntry(entries, name, e);
}

// MBR, GPT and Apple partition maps from the first 32 KB of a disk. Returns
// report lines (partition lines as { text } so the caller can add to them) and
// the partitions: { id, label, type, offset, size, line }
async function partitionTables(src, sys, fileAt = () => '', mbrNote = '') {
    const lines = [], parts = [];
    const sv = isoView(sys);
    const add = (id, label, type, offset, size, text) => {
        const line = { text };
        lines.push(line);
        parts.push({ id, label, type, offset, size, line });
    };
    let gptProtective = false;
    if (sys.length >= 512 && sys[510] === 0x55 && sys[511] === 0xaa) {
        const found = [];
        for (let i = 0; i < 4; i++) {
            const p = 446 + 16 * i;
            const type = sys[p + 4], start = sv.getUint32(p + 8, true), count = sv.getUint32(p + 12, true);
            if (!type && !count) continue;
            if (sys[p] !== 0 && sys[p] !== 0x80) return { lines: [], parts: [] }; // not a partition table (a FAT/NTFS boot sector, say)
            found.push([i, type, start, count, sys[p] & 0x80]);
        }
        if (found.length) lines.push('', 'MBR partition table' + mbrNote);
        for (const [i, type, start, count, active] of found) {
            const text = `  ${i + 1}: ${active ? 'active, ' : ''}type 0x${type.toString(16).padStart(2, '0')} ${MBR_TYPES[type] || ''}, sectors ${start}\u2013${start + count - 1} (${mib(count * 512)})${fileAt(start * 512)}`;
            if (type === 0xee) { gptProtective = true; lines.push(text); continue; }
            add(`${i + 1}`, MBR_TYPES[type] || 'type' + type.toString(16), 'mbr', start * 512, count * 512, text);
        }
        const bootCode = sys.subarray(0, 440).some(b => b);
        if (bootCode && found.length) lines.push(`  Boot code present (${/ISOLINUX|isolinux/.test(new TextDecoder('latin1').decode(sys.subarray(0, 440))) ? 'isohybrid' : 'MBR boot code'})`);
    }
    if (sys.length >= 1024 && isoText(sys, 512, 8) === 'EFI PART') {
        // A GPT replaces the MBR's partitions (which only mirror it on hybrid discs)
        if (gptProtective || parts.length) {
            parts.splice(0);
        }
        const entLba = Number(sv.getBigUint64(512 + 72, true)), num = sv.getUint32(512 + 80, true), esz = sv.getUint32(512 + 84, true);
        lines.push('', 'GPT partition table', `  Disk GUID:               ${guidString(sys, 512 + 56)}`);
        const tbl = entLba * 512 + num * esz <= sys.length ? sys.subarray(entLba * 512) : (await src.range(entLba * 512, entLba * 512 + Math.min(num, 256) * esz - 1)).buf;
        const tv = isoView(tbl);
        for (let i = 0; i < Math.min(num, 256) && (i + 1) * esz <= tbl.length; i++) {
            const p = i * esz;
            const type = guidString(tbl, p);
            if (type === '00000000-0000-0000-0000-000000000000') continue;
            const first = Number(tv.getBigUint64(p + 32, true)), last = Number(tv.getBigUint64(p + 40, true));
            const name = new TextDecoder('utf-16le').decode(tbl.subarray(p + 56, p + 128)).replace(/\0+$/, '');
            const kind = GPT_TYPES[type] || type;
            add(`${i + 1}`, name || kind, 'gpt', first * 512, (last - first + 1) * 512,
                `  ${i + 1}: ${kind}${name ? ` "${name}"` : ''}, sectors ${first}\u2013${last} (${mib((last - first + 1) * 512)})${fileAt(first * 512)}`);
        }
    }
    if (sys.length >= 1024 && sys[0] === 0x45 && sys[1] === 0x52 && sys[512] === 0x50 && sys[513] === 0x4d) {
        lines.push('', 'Apple partition map');
        for (let i = 1; i <= 16 && (i + 1) * 512 <= sys.length; i++) {
            const p = i * 512;
            if (sys[p] !== 0x50 || sys[p + 1] !== 0x4d) break;
            const bs = sv.getUint16(2, false) || 512;
            const start = sv.getUint32(p + 8, false), count = sv.getUint32(p + 12, false);
            const name = isoText(sys, p + 16, 32), type = isoText(sys, p + 48, 32);
            const text = `  ${i}: ${type}${name ? ` "${name}"` : ''}, blocks ${start}\u2013${start + count - 1} of ${bs} bytes (${mib(count * bs)})`;
            if (/Apple_partition_map|Apple_Free/.test(type)) lines.push(text);
            else add(`apm${i}`, name || type, 'apm', start * bs, count * bs, text);
        }
    }
    return { lines, parts };
}

// Rock Ridge: the SUSP "SP" entry in the root's "." record, and the extension
// ("ER") it names, there or in a continuation area ("CE")
async function rockRidgeInfo(src, pvd) {
    const root = isoView(pvd.subarray(156, 190));
    const dir = await isoSectors(src, root.getUint32(2, true));
    const len = dir[0];
    if (len < 34) return null;
    const su = 33 + dir[32] + (dir[32] % 2 ? 0 : 1);
    let area = dir.subarray(su, len);
    if (!(area[0] === 0x53 && area[1] === 0x50 && area[4] === 0xbe && area[5] === 0xef)) return null;
    const info = { id: '' };
    for (let hops = 0; hops < 4 && area; hops++) {
        let next = null;
        for (let p = 0; p + 4 <= area.length;) {
            const l = area[p + 2];
            if (l < 4) break;
            const sig = String.fromCharCode(area[p], area[p + 1]);
            if (sig === 'ER') info.id = new TextDecoder('latin1').decode(area.subarray(p + 8, p + 8 + area[p + 4]));
            if (sig === 'CE') {
                const v = isoView(area.subarray(p, p + l));
                next = [v.getUint32(4, true), v.getUint32(12, true), v.getUint32(20, true)];
            }
            if (sig === 'ST') break;
            p += l;
        }
        if (info.id || !next) break;
        const [block, off, clen] = next;
        area = (await src.range(block * ISO_SECTOR + off, block * ISO_SECTOR + off + clen - 1)).buf;
    }
    return info;
}

async function isoRead(src, inner) {
    return imageRead(src, await isoEntries(src), inner);
}

// A file of a disc or disk image: in its entry, in extents of its source, or
// made by its reader (compressed NTFS files)
async function imageRead(src, entries, inner) {
    const e = entries.get(inner);
    if (!e || e.dir) throw zipError(404, `No file ${inner} in image`);
    if (e.inline) return e.inline;
    if (e.reader) return e.reader();
    return isoReadExtents(e.src || src, e.extents, e.size);
}

// --- Disk images (.img): FAT, NTFS, or partitioned (MBR/GPT) ---
// Written after ReactOS's drivers (drivers/filesystems/vfatfs and ntfs). Files
// are listed with where their data is on the disk, so reading one reads just it.

// Adds extents, joining one to the last when they touch
function pushExtent(list, off, len, sparse) {
    const last = list[list.length - 1];
    if (last && !!last[2] === !!sparse && (sparse || last[0] + last[1] === off)) last[1] += len;
    else list.push(sparse ? [0, len, true] : [off, len]);
}

// Extents cut to a length; past `valid` bytes they read as zeros (NTFS initialized size)
function clipExtents(extents, size, valid = size) {
    const out = [];
    let at = 0;
    for (const [off, len, sparse] of extents) {
        if (at >= size) break;
        let n = Math.min(len, size - at);
        let o = off;
        if (!sparse && at < valid && at + n > valid) {
            const k = valid - at;
            pushExtent(out, o, k, false);
            at += k; n -= k; o += k;
        }
        if (n > 0) pushExtent(out, o, n, sparse || at >= valid);
        at += n;
    }
    return out;
}

// --- FAT12/16/32 ---

// The boot sector's BIOS parameter block, checked as vfatfs does (fsctl.c)
function fatBoot(b) {
    if (b.length < 512 || b[510] !== 0x55 || b[511] !== 0xaa) return null;
    const v = isoView(b);
    const bps = v.getUint16(11, true), spc = b[13], reserved = v.getUint16(14, true), fats = b[16];
    const rootEntries = v.getUint16(17, true), media = b[21];
    if (![512, 1024, 2048, 4096].includes(bps) || (fats !== 1 && fats !== 2) || !(media === 0xf0 || media >= 0xf8)
        || !spc || (spc & (spc - 1)) || bps * spc > 65536 || !reserved) return null;
    const fatSectors = v.getUint16(22, true) || v.getUint32(36, true);
    const sectors = v.getUint16(19, true) || v.getUint32(32, true);
    if (!fatSectors || !sectors) return null;
    const rootSectors = Math.ceil(rootEntries * 32 / bps);
    const dataStart = reserved + fats * fatSectors + rootSectors;
    if (dataStart >= sectors) return null;
    const clusters = Math.floor((sectors - dataStart) / spc);
    const type = clusters < 4085 ? 12 : clusters >= 65525 ? 32 : 16;
    const ext = type === 32 ? 64 : 36; // extended BPB: drive, flags, signature, serial, label, type
    const hasExt = b[ext + 2] === 0x29 || b[ext + 2] === 0x28;
    return {
        type, bps, spc, reserved, fats, rootEntries, fatSectors, sectors, rootSectors, dataStart, clusters,
        clusterSize: bps * spc, rootCluster: type === 32 ? v.getUint32(44, true) : 0,
        oem: isoText(b, 3, 8), media,
        serial: hasExt ? v.getUint32(ext + 3, true).toString(16).toUpperCase().padStart(8, '0').replace(/^(.{4})/, '$1-') : '',
        label: hasExt && b[ext + 2] === 0x29 ? isoText(b, ext + 7, 11) : '',
        fsType: hasExt && b[ext + 2] === 0x29 ? isoText(b, ext + 18, 8) : '',
    };
}

async function fatAdd(src, bs, prefix, entries, info) {
    const { type, bps, clusters, clusterSize } = bs;
    const fat = (await src.range(bs.reserved * bps, (bs.reserved + bs.fatSectors) * bps - 1)).buf;
    const fv = isoView(fat);
    const dataOff = bs.dataStart * bps;
    const eoc = type === 12 ? 0xff8 : type === 16 ? 0xfff8 : 0x0ffffff8;
    // fat.c: FAT12 packs two 12-bit entries in three bytes
    const next = c => {
        if (type === 12) {
            const o = c + (c >> 1);
            if (o + 1 >= fat.length) return eoc;
            const w = fat[o] | (fat[o + 1] << 8);
            return c & 1 ? w >> 4 : w & 0xfff;
        }
        if (type === 16) return c * 2 + 2 <= fat.length ? fv.getUint16(c * 2, true) : eoc;
        return c * 4 + 4 <= fat.length ? fv.getUint32(c * 4, true) & 0x0fffffff : eoc;
    };
    const chain = (start, limit = Infinity) => {
        const out = [];
        let c = start, bytes = 0;
        for (let n = 0; c >= 2 && c < clusters + 2 && n <= clusters && bytes < limit; n++) {
            pushExtent(out, dataOff + (c - 2) * clusterSize, clusterSize, false);
            bytes += clusterSize;
            const nx = next(c);
            if (nx >= eoc || nx < 2) break;
            c = nx;
        }
        return out;
    };
    const latin1 = new TextDecoder('latin1');
    const seen = new Set();
    let label = bs.label;
    const walk = async (extents, path, depth) => {
        const size = extents.reduce((n, e) => n + e[1], 0);
        const b = await isoReadExtents(src, extents, size);
        const v = isoView(b);
        let lfn = [], lfnSum = -1;
        const subdirs = [];
        for (let p = 0; p + 32 <= b.length; p += 32) {
            const first = b[p];
            if (first === 0) break;
            if (first === 0xe5) { lfn = []; continue; }
            const attr = b[p + 11];
            if ((attr & 0x3f) === 0x0f) { // long name piece: 13 UTF-16 characters
                const seq = first & 0x3f;
                if (first & 0x40) { lfn = []; lfnSum = b[p + 13]; }
                if (seq >= 1 && seq <= 20) {
                    const u = new Uint8Array(26);
                    u.set(b.subarray(p + 1, p + 11), 0);
                    u.set(b.subarray(p + 14, p + 26), 10);
                    u.set(b.subarray(p + 28, p + 32), 22);
                    lfn[seq - 1] = new TextDecoder('utf-16le').decode(u);
                }
                continue;
            }
            const raw = b.slice(p, p + 11);
            if (attr & 0x08) { // volume label
                if (!path && !(attr & 0x10)) label = latin1.decode(raw).trimEnd();
                lfn = [];
                continue;
            }
            let sum = 0;
            for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) | ((sum & 0xfe) >> 1)) + raw[i] & 0xff;
            if (raw[0] === 0x05) raw[0] = 0xe5;
            const lower = b[p + 12];
            let base = latin1.decode(raw.subarray(0, 8)).trimEnd(), ext = latin1.decode(raw.subarray(8, 11)).trimEnd();
            if (lower & 0x08) base = base.toLowerCase();
            if (lower & 0x10) ext = ext.toLowerCase();
            let name = ext ? `${base}.${ext}` : base;
            if (lfn.length && sum === lfnSum && lfn.every(Boolean)) {
                const long = lfn.join('').replace(/\0[\s\S]*$/, '').replace(/\uffff+$/, '');
                if (long) name = long;
            }
            lfn = [];
            if (name === '.' || name === '..') continue;
            name = name.replace(/\//g, '_');
            const cluster = v.getUint16(p + 26, true) | (type === 32 ? v.getUint16(p + 20, true) << 16 : 0);
            const fileSize = v.getUint32(p + 28, true);
            const mtimeMs = dosDateToMs(v.getUint16(p + 24, true), v.getUint16(p + 22, true));
            const full = path + name;
            if (attr & 0x10) {
                isoAddEntry(entries, prefix + full, { size: 0, mtimeMs, dir: true });
                if (cluster >= 2 && !seen.has(cluster) && depth < 64) {
                    seen.add(cluster);
                    subdirs.push([chain(cluster), full + '/']);
                }
            } else {
                isoAddEntry(entries, prefix + full, { size: fileSize, mtimeMs, src, extents: fileSize ? clipExtents(chain(cluster, fileSize), fileSize) : [] });
            }
        }
        for (const [ext, pre] of subdirs) await walk(ext, pre, depth + 1);
    };
    const root = type === 32 ? chain(bs.rootCluster) : [[(bs.reserved + bs.fats * bs.fatSectors) * bps, bs.rootSectors * bps]];
    if (type === 32) seen.add(bs.rootCluster);
    await walk(root, '', 0);
    info.push(`FAT${type} file system${prefix ? ` (${prefix.replace(/\/$/, '')})` : ''}`,
        `  Label:                   ${label || '(none)'}`,
        ...(bs.serial ? [`  Serial number:           ${bs.serial}`] : []),
        `  Made by (OEM name):      ${bs.oem}`,
        `  Size:                    ${mib(bs.sectors * bps)} (${bs.sectors} sectors of ${bps} bytes)`,
        `  Clusters:                ${clusters} of ${clusterSize} bytes`,
        `  FATs:                    ${bs.fats} \u00D7 ${bs.fatSectors} sectors${bs.fsType ? `, type field "${bs.fsType}"` : ''}`, '');
}

// --- NTFS ---

function ntfsBoot(b) {
    if (b.length < 512 || isoText(b, 3, 8) !== 'NTFS') return null;
    const v = isoView(b);
    const bps = v.getUint16(11, true);
    const spcRaw = b[13];
    const spc = spcRaw > 128 ? 2 ** (256 - spcRaw) : spcRaw;
    const clusterSize = bps * spc;
    const size = raw => { const n = (raw << 24) >> 24; return n < 0 ? 2 ** -n : n * clusterSize; };
    if (!bps || !spc) return null;
    return {
        bps, clusterSize, sectors: Number(v.getBigUint64(0x28, true)),
        mftLcn: Number(v.getBigUint64(0x30, true)), mirrLcn: Number(v.getBigUint64(0x38, true)),
        recordSize: size(b[0x40]), indexSize: size(b[0x44]),
        serial: v.getBigUint64(0x48, true).toString(16).toUpperCase().padStart(16, '0'),
    };
}

// Update sequence fixups (mft.c FixupUpdateSequenceArray): the last two bytes of
// every 512-byte stride were swapped for the sequence number when written
function ntfsFixup(rec) {
    const v = isoView(rec);
    const magic = v.getUint32(0, true);
    if (magic !== 0x454c4946 && magic !== 0x58444e49) return false; // FILE, INDX
    const usaOff = v.getUint16(4, true), usaCount = v.getUint16(6, true);
    if (usaCount < 2 || usaOff + usaCount * 2 > rec.length) return false;
    const usn = v.getUint16(usaOff, true);
    for (let i = 1; i < usaCount; i++) {
        const pos = i * 512 - 2;
        if (pos + 2 > rec.length) break;
        if (v.getUint16(pos, true) !== usn) return false;
        rec[pos] = rec[usaOff + i * 2];
        rec[pos + 1] = rec[usaOff + i * 2 + 1];
    }
    return true;
}

// Data runs (attrib.c DecodeRun): a header byte of two sizes, the run length,
// and a signed delta from the previous run's cluster; no delta = sparse
function ntfsRuns(b, p, end) {
    const runs = [];
    let lcn = 0;
    while (p < end && b[p]) {
        const h = b[p++], ls = h & 15, os = h >> 4;
        let len = 0;
        for (let i = 0; i < ls; i++) len += b[p++] * 2 ** (8 * i);
        if (os) {
            let d = 0;
            for (let i = 0; i < os; i++) d += b[p + i] * 2 ** (8 * i);
            if (b[p + os - 1] & 0x80) d -= 2 ** (8 * os);
            p += os;
            lcn += d;
            runs.push({ lcn, len });
        } else {
            runs.push({ lcn: null, len });
        }
    }
    return runs;
}

function ntfsAttrs(rec) {
    const v = isoView(rec);
    const out = [];
    for (let off = v.getUint16(20, true); off + 16 <= rec.length;) {
        const type = v.getUint32(off, true);
        if (type === 0xffffffff) break;
        const len = v.getUint32(off + 4, true);
        if (len < 16 || off + len > rec.length) break;
        const nameLen = rec[off + 9], nameOff = v.getUint16(off + 10, true);
        const a = {
            type, nonResident: !!rec[off + 8], flags: v.getUint16(off + 12, true),
            name: nameLen ? new TextDecoder('utf-16le').decode(rec.subarray(off + nameOff, off + nameOff + nameLen * 2)) : '',
        };
        if (!a.nonResident) {
            const vlen = v.getUint32(off + 16, true), voff = v.getUint16(off + 20, true);
            a.value = rec.slice(off + voff, off + voff + vlen);
        } else {
            a.lowVcn = Number(v.getBigUint64(off + 16, true));
            a.cu = rec[off + 34];
            a.allocSize = Number(v.getBigUint64(off + 40, true));
            a.dataSize = Number(v.getBigUint64(off + 48, true));
            a.initSize = Number(v.getBigUint64(off + 56, true));
            a.runs = ntfsRuns(rec, off + v.getUint16(off + 32, true), off + len);
        }
        out.push(a);
        off += len;
    }
    return out;
}

const ntfsRef = (v, at) => v.getUint32(at, true) + v.getUint16(at + 4, true) * 2 ** 32;
const filetimeMs = (v, at) => { const t = Number(v.getBigUint64(at, true)); return t ? t / 10000 - 11644473600000 : 0; };

// Runs (of one or more attribute pieces, in VCN order) as byte extents
function ntfsExtents(runs, clusterSize) {
    const out = [];
    for (const r of runs) pushExtent(out, r.lcn === null ? 0 : r.lcn * clusterSize, r.len * clusterSize, r.lcn === null);
    return out;
}

// LZNT1 (lznt1.c): 4 KB chunks, each with a 2-byte header (bit 15: compressed,
// low 12 bits: length - 1); compressed chunks are flag bytes over 8 tokens, a
// literal or a back-reference whose offset/length split grows with the position
function lznt1(input, out) {
    let ip = 0, op = 0;
    while (ip + 2 <= input.length) {
        const header = input[ip] | (input[ip + 1] << 8);
        ip += 2;
        if (!header) break;
        const len = (header & 0x0fff) + 1;
        if (ip + len > input.length) break;
        const chunkStart = op;
        if (!(header & 0x8000)) {
            out.set(input.subarray(ip, ip + Math.min(len, out.length - op)), op);
            ip += len;
            op += len;
            continue;
        }
        const end = ip + len;
        while (ip < end) {
            const flags = input[ip++];
            for (let bit = 0; bit < 8 && ip < end; bit++) {
                if (!(flags & (1 << bit))) {
                    if (op >= out.length) return op;
                    out[op++] = input[ip++];
                    continue;
                }
                const token = input[ip] | (input[ip + 1] << 8);
                ip += 2;
                const pos = op - chunkStart;
                let offBits = 4;
                for (let limit = 16; offBits < 12 && limit < pos; limit <<= 1) offBits++;
                const lenBits = 16 - offBits;
                const mlen = (token & ((1 << lenBits) - 1)) + 3, moff = (token >> lenBits) + 1;
                if (moff > pos) return op;
                for (let i = 0; i < mlen && op < out.length; i++, op++) out[op] = out[op - moff];
            }
        }
    }
    return op;
}

// A compressed stream (compress.c): compression units of 2^cu clusters, each
// stored raw (all clusters there), compressed (fewer, then a sparse tail) or
// sparse (none)
async function ntfsReadCompressed(src, runs, clusterSize, cu, size) {
    const cuClusters = 2 ** cu, cuBytes = cuClusters * clusterSize;
    const out = new Uint8Array(size);
    // VCN → LCN (or null), one entry per run
    const map = [];
    let vcn = 0;
    for (const r of runs) { map.push({ vcn, lcn: r.lcn, len: r.len }); vcn += r.len; }
    for (let unit = 0; unit * cuBytes < size; unit++) {
        const v0 = unit * cuClusters, v1 = v0 + cuClusters;
        const pieces = [];
        let mapped = 0;
        for (const m of map) {
            const a = Math.max(v0, m.vcn), b = Math.min(v1, m.vcn + m.len);
            if (a >= b || m.lcn === null) continue;
            pieces.push([(m.lcn + a - m.vcn) * clusterSize, (b - a) * clusterSize]);
            mapped += b - a;
        }
        if (!mapped) continue; // sparse: zeros
        const data = await isoReadExtents(src, pieces, mapped * clusterSize);
        const at = unit * cuBytes, n = Math.min(cuBytes, size - at);
        if (mapped >= cuClusters) { out.set(data.subarray(0, n), at); continue; }
        const unitOut = new Uint8Array(cuBytes);
        lznt1(data, unitOut);
        out.set(unitOut.subarray(0, n), at);
    }
    return out;
}

async function ntfsAdd(src, bs, prefix, entries, info) {
    const { clusterSize, recordSize } = bs;
    const readRecordAt = async off => {
        const rec = (await src.range(off, off + recordSize - 1)).buf.slice();
        return rec.length === recordSize && ntfsFixup(rec) ? rec : null;
    };
    // $MFT itself: record 0, whose $DATA says where the rest is
    const rec0 = await readRecordAt(bs.mftLcn * clusterSize);
    if (!rec0) throw zipError(415, 'NTFS: the MFT\'s first record is unreadable');
    let attrs0 = ntfsAttrs(rec0);
    let mftData = attrs0.filter(a => a.type === 0x80 && !a.name);
    let mftExtents = ntfsExtents(mftData.flatMap(a => a.runs || []), clusterSize);
    const recordOffset = n => {
        let at = n * recordSize;
        for (const [off, len, sparse] of mftExtents) {
            if (at < len) return sparse ? null : off + at;
            at -= len;
        }
        return null;
    };
    // A fragmented $MFT lists the rest of its $DATA in other records ($ATTRIBUTE_LIST)
    const list0 = attrs0.find(a => a.type === 0x20);
    if (list0 && list0.value) {
        const lv = isoView(list0.value);
        for (let p = 0; p + 26 <= list0.value.length;) {
            const len = lv.getUint16(p + 4, true);
            if (!len) break;
            const ref = ntfsRef(lv, p + 16);
            if (lv.getUint32(p, true) === 0x80 && ref !== 0) {
                const off = recordOffset(ref);
                const rec = off !== null ? await readRecordAt(off) : null;
                if (rec) mftData.push(...ntfsAttrs(rec).filter(a => a.type === 0x80 && !a.name));
            }
            p += len;
        }
        mftData.sort((a, b) => a.lowVcn - b.lowVcn);
        mftExtents = ntfsExtents(mftData.flatMap(a => a.runs || []), clusterSize);
    }
    const mftSize = (mftData[0] && mftData[0].dataSize) || 0;
    const count = Math.min(Math.floor(mftSize / recordSize), ISO_MAX_ENTRIES * 2);

    // Every record: in use, directory, base record, attributes
    const records = new Map();
    const extra = [];
    const CHUNK = 4 * 1024 * 1024;
    let number = 0;
    for (const [off, len, sparse] of clipExtents(mftExtents, count * recordSize)) {
        for (let at = 0; at < len; at += CHUNK) {
            const n = Math.min(CHUNK, len - at);
            const buf = sparse ? null : (await src.range(off + at, off + at + n - 1)).buf;
            for (let r = 0; r + recordSize <= n; r += recordSize, number++) {
                if (!buf) continue;
                const rec = buf.slice(r, r + recordSize);
                const v = isoView(rec);
                if (!ntfsFixup(rec) || !(v.getUint16(22, true) & 1)) continue;
                const base = ntfsRef(v, 32);
                const attrs = ntfsAttrs(rec);
                if (base) extra.push([base, attrs]);
                else records.set(number, { dir: !!(v.getUint16(22, true) & 2), attrs });
            }
        }
    }
    for (const [base, attrs] of extra) {
        const r = records.get(base);
        if (r) r.attrs.push(...attrs);
    }

    // Names: $FILE_NAME (parent reference, namespace); DOS short names only when there is no other
    const names = new Map();
    for (const [num, r] of records) {
        const all = [];
        for (const a of r.attrs) {
            if (a.type !== 0x30 || !a.value || a.value.length < 66) continue;
            const v = isoView(a.value);
            const len = a.value[64], ns = a.value[65];
            all.push({ parent: ntfsRef(v, 0), ns, name: new TextDecoder('utf-16le').decode(a.value.subarray(66, 66 + len * 2)) });
        }
        const long = all.filter(n => n.ns !== 2);
        const chosen = (long.length ? long : all).filter((n, i, arr) => arr.findIndex(m => m.parent === n.parent && m.name === n.name) === i);
        if (chosen.length) names.set(num, chosen);
    }
    const ROOT = 5;
    const paths = new Map([[ROOT, '']]);
    const pathOf = (num, depth = 0) => {
        if (paths.has(num)) return paths.get(num);
        const n = names.get(num);
        let p = null;
        if (n && depth < 256) {
            const parent = pathOf(n[0].parent, depth + 1);
            if (parent !== null) p = parent + n[0].name.replace(/\//g, '_') + '/';
        }
        paths.set(num, p);
        return p;
    };
    let volumeLabel = '', version = '';
    const vol = records.get(3);
    if (vol) {
        const vn = vol.attrs.find(a => a.type === 0x60 && a.value);
        if (vn) volumeLabel = new TextDecoder('utf-16le').decode(vn.value);
        const vi = vol.attrs.find(a => a.type === 0x70 && a.value && a.value.length >= 10);
        if (vi) version = `${vi.value[8]}.${vi.value[9]}`;
    }
    let files = 0, dirs = 0, hidden = 0;
    const extendPath = pathOf(11);
    for (const [num, r] of records) {
        if (num === ROOT || !names.has(num)) continue;
        for (const n of names.get(num)) {
            const parent = pathOf(n.parent);
            // Metadata files ($MFT, $LogFile, … and what's under $Extend) are left out
            if (parent === null || (num < 24 && n.parent === ROOT && n.name.startsWith('$')) || (extendPath && parent.startsWith(extendPath))) { hidden++; continue; }
            const full = prefix + parent + n.name.replace(/\//g, '_');
            const si = r.attrs.find(a => a.type === 0x10 && a.value && a.value.length >= 16);
            const mtimeMs = si ? filetimeMs(isoView(si.value), 8) : 0;
            if (r.dir) {
                dirs++;
                isoAddEntry(entries, full, { size: 0, mtimeMs, dir: true });
                continue;
            }
            files++;
            const data = r.attrs.filter(a => a.type === 0x80 && !a.name).sort((a, b) => (a.lowVcn || 0) - (b.lowVcn || 0));
            if (!data.length) { isoAddEntry(entries, full, { size: 0, mtimeMs, inline: new Uint8Array(0) }); continue; }
            if (!data[0].nonResident) { isoAddEntry(entries, full, { size: data[0].value.length, mtimeMs, inline: data[0].value }); continue; }
            const first = data[0];
            const size = first.dataSize, runs = data.flatMap(a => a.runs);
            if (first.flags & 0x4000) {
                isoAddEntry(entries, full, { size, mtimeMs, reader: async () => { throw zipError(415, `${n.name} is encrypted (EFS)`); } });
            } else if ((first.flags & 0x00ff) && first.cu) {
                isoAddEntry(entries, full, { size, mtimeMs, reader: () => ntfsReadCompressed(src, runs, clusterSize, first.cu, size) });
            } else {
                isoAddEntry(entries, full, { size, mtimeMs, src, extents: clipExtents(ntfsExtents(runs, clusterSize), size, first.initSize) });
            }
        }
    }
    info.push(`NTFS file system${prefix ? ` (${prefix.replace(/\/$/, '')})` : ''}`,
        `  Label:                   ${volumeLabel || '(none)'}`,
        ...(version ? [`  NTFS version:            ${version}`] : []),
        `  Serial number:           ${bs.serial}`,
        `  Size:                    ${mib(bs.sectors * bs.bps)} (${bs.sectors} sectors of ${bs.bps} bytes)`,
        `  Cluster size:            ${clusterSize} bytes`,
        `  MFT:                     cluster ${bs.mftLcn}, ${number} records of ${recordSize} bytes (mirror at cluster ${bs.mirrLcn})`,
        `  Listed:                  ${files} files, ${dirs} folders (${hidden} metadata or unreachable entries left out)`, '');
}

// --- QEMU disk images (qcow2) ---
// A virtual disk in clusters, found through a two-level table: L1 entries point
// at L2 tables, whose entries give each cluster's place in the file, or say it
// is zero, unallocated (then from the backing file, if any, else zero) or
// compressed (deflate, or zstd). With extended L2 entries a cluster is 32
// subclusters, each allocated or zero on its own. The result is a byte source
// like any other, so the disk image code above reads what is inside.

const qcowSources = new Map(); // key -> Promise<source>
const QCOW_CACHE = 64;         // L2 tables and decompressed clusters kept

async function qcowInflate(data, size, zstd) {
    if (zstd) {
        const out = [];
        let got = 0;
        try {
            const d = new fzstd.Decompress(chunk => { out.push(chunk.slice()); got += chunk.length; });
            d.push(data, true);
        } catch (err) {
            if (got < size) throw zipError(415, 'qcow2: bad zstd cluster: ' + err.message);
        }
        const buf = new Uint8Array(size);
        let at = 0;
        for (const c of out) { if (at >= size) break; buf.set(c.subarray(0, size - at), at); at += c.length; }
        return buf;
    }
    // Raw deflate; the stored length is rounded up to sectors, so stop once the
    // cluster is complete instead of reading (and choking on) the padding
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const buf = new Uint8Array(size);
    let at = 0;
    try {
        while (at < size) {
            const { value, done } = await reader.read();
            if (done) break;
            buf.set(value.subarray(0, size - at), at);
            at += value.length;
        }
    } catch (err) {
        if (at < size) throw zipError(415, 'qcow2: bad compressed cluster: ' + err.message);
    }
    reader.cancel().catch(() => {});
    return buf;
}

function qcowSource(src) {
    let p = qcowSources.get(src.key);
    if (!p) {
        p = qcowOpen(src);
        qcowSources.set(src.key, p);
        p.catch(() => qcowSources.delete(src.key));
        if (qcowSources.size > 8) qcowSources.delete(qcowSources.keys().next().value);
    }
    return p;
}

async function qcowOpen(src, depth = 0) {
    const h = (await src.range(0, 1023)).buf;
    const v = isoView(h);
    if (h.length < 72 || v.getUint32(0) !== 0x514649fb) throw zipError(415, 'Not a qcow2 image');
    const version = v.getUint32(4);
    if (version < 2 || version > 3) throw zipError(415, `qcow version ${version} is not supported`);
    const num = at => Number(v.getBigUint64(at));
    const backingOffset = num(8), backingSize = v.getUint32(16);
    const clusterBits = v.getUint32(20), size = num(24), crypt = v.getUint32(32);
    const l1Size = v.getUint32(36), l1Offset = num(40), snapshots = v.getUint32(60);
    if (crypt) throw zipError(415, 'qcow2: encrypted images are not supported');
    const incompatible = version >= 3 ? v.getBigUint64(72) : 0n;
    const headerLength = version >= 3 ? v.getUint32(100) : 72;
    if (incompatible & 4n) throw zipError(415, 'qcow2: images with an external data file are not supported');
    const extendedL2 = !!(incompatible & 16n);
    const zstd = !!(incompatible & 8n) && headerLength > 104 && h[104] === 1;
    const cs = 2 ** clusterBits;
    const entrySize = extendedL2 ? 16 : 8;
    const perL2 = cs / entrySize;
    const unit = extendedL2 ? cs / 32 : cs;
    const l1 = l1Size ? (await src.range(l1Offset, l1Offset + l1Size * 8 - 1)).buf : new Uint8Array(0);
    const l1v = isoView(l1);
    const OFFSET_MASK = 0x00fffffffffffe00n;

    let backing = null, backingName = '';
    if (backingOffset && backingSize) {
        backingName = new TextDecoder().decode((await src.range(backingOffset, backingOffset + backingSize - 1)).buf);
        // Relative to the image's folder; only for images read from the workspace
        const dir = src.key.replace(/\/[^/]*$/, '');
        const path = backingName.startsWith('/') ? backingName : dir + '/' + backingName;
        if (depth < 8 && src.stream) {
            const b = httpSource(path);
            b.kind = null;
            const head = (await b.range(0, 3)).buf;
            backing = head.length === 4 && isoView(head).getUint32(0) === 0x514649fb ? await qcowOpen(b, depth + 1) : b;
        }
    }

    const l2Cache = new Map(), clusterCache = new Map();
    const cached = async (map, key, load) => {
        let p = map.get(key);
        if (p) { map.delete(key); map.set(key, p); return p; }
        p = load();
        map.set(key, p);
        p.catch(() => map.delete(key));
        if (map.size > QCOW_CACHE) map.delete(map.keys().next().value);
        return p;
    };
    // Where a unit of the virtual disk is: { host } | { zero } | { unallocated } | { compressed: [offset, length], cluster }
    const locate = async u => {
        const c = Math.floor(u * unit / cs);
        const l1i = Math.floor(c / perL2), l2i = c % perL2;
        if (l1i >= l1Size) return { unallocated: true };
        const l2Offset = Number(l1v.getBigUint64(l1i * 8) & OFFSET_MASK);
        if (!l2Offset) return { unallocated: true };
        const l2 = await cached(l2Cache, l2Offset, async () => (await src.range(l2Offset, l2Offset + cs - 1)).buf);
        const ev = isoView(l2);
        const entry = ev.getBigUint64(l2i * entrySize);
        if (entry & (1n << 62n)) {
            const x = 62n - BigInt(clusterBits - 8);
            const host = Number(entry & ((1n << x) - 1n));
            const sectors = Number((entry >> x) & ((1n << BigInt(clusterBits - 8)) - 1n)) + 1;
            return { compressed: [host, sectors * 512 - (host & 511)], cluster: c };
        }
        const host = Number(entry & OFFSET_MASK);
        if (extendedL2) {
            const bitmap = ev.getBigUint64(l2i * entrySize + 8);
            const sub = BigInt(u - c * 32);
            if (bitmap & (1n << (32n + sub))) return { zero: true };
            if (!(bitmap & (1n << sub))) return { unallocated: true };
            return { host: host + Number(sub) * unit };
        }
        if (entry & 1n) return { zero: true };
        return host ? { host } : { unallocated: true };
    };

    const info = [
        `QEMU qcow2 image, version ${version}`,
        `  Virtual size:            ${mib(size)} (${size} bytes)`,
        `  Cluster size:            ${cs} bytes${extendedL2 ? ', extended L2 (32 subclusters)' : ''}`,
        `  Compression:             ${zstd ? 'zstd' : 'deflate'} (for clusters written compressed)`,
        ...(backingName ? [`  Backing file:            ${backingName}${backing ? '' : ' (not found or not readable here: its clusters read as zeros)'}`] : []),
        ...(snapshots ? [`  Snapshots:               ${snapshots} (the current state is shown)`] : []),
        '',
    ];
    return {
        key: src.key + '#qcow2',
        label: src.key.split('/').pop(),
        kind: 'disk',
        size,
        info,
        async range(start, endInclusive) {
            if (endInclusive === undefined) { const n = start; start = Math.max(0, size - n); endInclusive = size - 1; }
            const end = Math.min(endInclusive, size - 1);
            if (start > end) return { buf: new Uint8Array(0) };
            const out = new Uint8Array(end - start + 1);
            const reads = []; // [outOffset, host, length], adjacent ones joined
            for (let pos = start; pos <= end;) {
                const u = Math.floor(pos / unit), within = pos - u * unit;
                const n = Math.min(unit - within, end - pos + 1);
                const m = await locate(u);
                const at = pos - start;
                if (m.host !== undefined) {
                    const last = reads[reads.length - 1];
                    if (last && last[0] + last[2] === at && last[1] + last[2] === m.host + within) last[2] += n;
                    else reads.push([at, m.host + within, n]);
                } else if (m.compressed) {
                    const data = await cached(clusterCache, m.cluster, async () => {
                        const [off, len] = m.compressed;
                        return qcowInflate((await src.range(off, off + len - 1)).buf, cs, zstd);
                    });
                    const inCluster = pos - m.cluster * cs;
                    out.set(data.subarray(inCluster, inCluster + n), at);
                } else if (m.unallocated && backing) {
                    out.set((await backing.range(pos, pos + n - 1)).buf, at);
                }
                pos += n;
            }
            for (const [at, host, len] of reads) out.set((await src.range(host, host + len - 1)).buf.subarray(0, len), at);
            return { buf: out };
        },
    };
}

// What file system (if any) begins a source
async function detectFs(src) {
    const b = (await src.range(0, 4095)).buf;
    if (b.length >= 512 && isoText(b, 3, 8) === 'NTFS') return { kind: 'ntfs', boot: ntfsBoot(b) };
    if (b.length >= 512 && isoText(b, 3, 8) === 'EXFAT') return { kind: 'exfat' };
    const fat = fatBoot(b);
    if (fat) return { kind: 'fat', boot: fat };
    const iso = (await src.range(32769, 32773)).buf;
    if (iso.length === 5 && String.fromCharCode(...iso) === 'CD001') return { kind: 'iso' };
    return null;
}

async function fsAdd(src, fs, prefix, entries, info) {
    if (fs.kind === 'fat') return fatAdd(src, fs.boot, prefix, entries, info);
    if (fs.kind === 'ntfs' && fs.boot) return ntfsAdd(src, fs.boot, prefix, entries, info);
    if (fs.kind === 'iso') {
        for (const e of (await isoEntries(src)).values()) {
            if (e.dir) isoAddEntry(entries, prefix + e.name.replace(/\/$/, ''), { ...e });
            else isoAddEntry(entries, prefix + e.name, { ...e, src: e.src || src });
        }
        info.push(`ISO 9660 / UDF file system${prefix ? ` (${prefix.replace(/\/$/, '')})` : ''}: see its [INFO].txt`, '');
        return;
    }
    throw zipError(415, `${fs.kind === 'exfat' ? 'exFAT' : fs.kind} is not supported`);
}

async function diskEntries(src, head = []) {
    const hit = isoIndexes.get(src.key);
    if (hit && Date.now() - hit.at < ZIP_CD_TTL_MS * 20) return hit.entries;
    const entries = new Map();
    const info = [`Disk image: ${src.label || src.key.split('/').pop()}`, '', ...head];
    const fs = await detectFs(src);
    if (fs) {
        await fsAdd(src, fs, '', entries, info);
    } else {
        const sys = (await src.range(0, 32767)).buf;
        const table = await partitionTables(src, sys);
        if (!table.parts.length) throw zipError(415, 'Not a recognized disk image (no FAT, NTFS or ISO 9660 file system, nor a partition table)');
        const tl = table.lines.map(l => typeof l === 'string' ? l : l.text);
        if (tl[0] === '') tl.shift();
        info.push(...tl, '');
        for (const pt of table.parts) {
            const folder = `${pt.id}-${pt.label}`.replace(/[\/\0]/g, '_');
            const psrc = sliceSource(`${src.key}#${pt.type}${pt.id}`, src, pt.offset, pt.size);
            let pfs = null;
            try { pfs = await detectFs(psrc); } catch { /* past the end of the image */ }
            try {
                if (!pfs) throw zipError(415, 'no file system recognized');
                await fsAdd(psrc, pfs, folder + '/', entries, info);
            } catch (err) {
                // What can't be read is offered raw
                info.push(`Partition ${folder}: ${err.message}; its raw bytes are ${folder}.bin`, '');
                isoAddEntry(entries, folder + '.bin', { size: pt.size, mtimeMs: 0, src, extents: [[pt.offset, pt.size]] });
            }
        }
    }
    const text = new TextEncoder().encode(info.join('\n'));
    isoAddEntry(entries, '[INFO].txt', { size: text.length, mtimeMs: 0, inline: text });
    isoIndexes.set(src.key, { at: Date.now(), entries });
    if (isoIndexes.size > 4) isoIndexes.delete(isoIndexes.keys().next().value);
    return entries;
}

// --- Any kind ---

async function archiveEntries(src) {
    if (src.kind === 'tar') return (await tarIndex(src)).entries;
    if (src.kind === 'single') return singleEntries(src);
    if (src.kind === 'iso') return isoEntries(src);
    if (src.kind === 'disk') return diskEntries(src);
    if (src.kind === 'qcow2') { const v = await qcowSource(src); return diskEntries(v, v.info); }
    return zipCentralDirectory(src);
}

async function archiveRead(src, inner) {
    if (src.kind === 'tar') return tarRead(src, inner);
    if (src.kind === 'single') return singleRead(src, inner);
    if (src.kind === 'iso') return isoRead(src, inner);
    if (src.kind === 'disk') return imageRead(src, await diskEntries(src), inner);
    if (src.kind === 'qcow2') { const v = await qcowSource(src); return imageRead(v, await diskEntries(v, v.info), inner); }
    return zipReadEntry(src, inner);
}

async function zipListDir(src, inner) {
    const entries = await archiveEntries(src);
    const prefix = inner ? inner + '/' : '';
    const children = new Map();
    for (const e of entries.values()) {
        if (!e.name.startsWith(prefix) || e.name === prefix) continue;
        const rest = e.name.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash >= 0) {
            const name = rest.slice(0, slash);
            if (name && !(children.get(name) || {}).dir) children.set(name, { name, type: 'directory', size: 0, mtimeMs: e.mtimeMs, dir: true });
        } else if (!children.has(rest)) {
            children.set(rest, { name: rest, type: 'file', size: e.size, mtimeMs: e.mtimeMs, encrypted: e.encrypted });
        }
    }
    if (inner && !children.size && !entries.has(prefix)) throw zipError(404, `No folder ${inner} in archive`);
    return [...children.values()].map(({ dir, ...item }) => item);
}

async function zipReadEntry(src, inner) {
    const entries = await zipCentralDirectory(src);
    const e = entries.get(inner);
    if (!e) throw zipError(404, `No file ${inner} in archive`);
    if (e.encrypted) throw zipError(415, 'Entry is encrypted');
    const dataStart = await zipEntryDataStart(src, e);
    const data = e.compSize ? (await zipRange(src, dataStart, dataStart + e.compSize - 1)).buf : new Uint8Array(0);
    if (e.method === 0) return data;
    if (e.method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw zipError(415, `Unsupported compression method ${e.method}`);
}

const ZIP_MIME = {
    png: 'image/png', apng: 'image/apng', jxl: 'image/jxl', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg',
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json',
    txt: 'text/plain', md: 'text/plain', xml: 'text/xml', wasm: 'application/wasm',
};

function zipErrorResponse(err) {
    return new Response(err.message, { status: err.status || 500, headers: { 'Content-Type': 'text/plain' } });
}

// Returns a Response promise for zip-related requests, or null to let the request through.
function handleZipFetch(request) {
    if (request.method !== 'GET') return null;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return null;
    const p = url.searchParams.get('path');
    if (!p) return null;

    if (url.pathname.endsWith('/zip-list')) {
        return zipResolve(p, true).then(async (r) => {
            if (!r) throw zipError(400, 'Not an archive path');
            const items = await zipListDir(r.src, r.inner);
            const clean = p.replace(/\/+$/, '');
            return new Response(JSON.stringify({
                path: clean,
                parent: clean.replace(/\/[^/]*$/, '') || '/',
                archive: r.src.key,
                items,
            }), { headers: { 'Content-Type': 'application/json' } });
        }).catch(zipErrorResponse);
    }

    const isFile = url.pathname.endsWith('/workspace-file');
    const isDownload = url.pathname.endsWith('/download-file');
    if (!isFile && !isDownload) return null;
    // Cheap synchronous check: some archive-looking segment with more path after it
    const parts = p.split('/');
    if (!parts.slice(0, -1).some(seg => archiveKind(seg))) return null;
    return zipResolve(p, false).then(async (r) => {
        if (!r || !r.inner) return netFetch(request);
        const bytes = await archiveRead(r.src, r.inner);
        const name = r.inner.split('/').pop();
        const headers = { 'Content-Type': ZIP_MIME[zipExt(name)] || 'application/octet-stream', 'Content-Length': String(bytes.length) };
        if (isDownload) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
        return new Response(bytes, { headers });
    }).catch(err => {
        // A real directory that merely looks like an archive: let the server answer
        if (err.status === 404 && /Cannot read/.test(err.message)) return netFetch(request);
        return zipErrorResponse(err);
    });
}
