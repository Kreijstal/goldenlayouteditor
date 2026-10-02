// Wireshark in a worker, for the capture viewer (src/pcap-plugin.js): Wiregasm
// (github.com/good-tools/wiregasm), Wireshark's dissection engine compiled to
// WebAssembly with a small subset of sharkd's API. Its 69 MB .wasm is fetched
// gzipped (19 MB) from jsDelivr, which doesn't serve the plain one, and
// decompressed here. One capture per worker.
//   → { id, cmd, ...args }     ← { id, result } | { id, error }
//   ← { progress: text }       while loading
// Commands: open { name, bytes }, frames { filter, skip, limit }, frame { number },
// follow { proto, filter }, tap { taps }, download { token }, check { filter },
// complete { text }. Binary data comes back base64-encoded, as Wiregasm gives it.
const WIREGASM = 'https://cdn.jsdelivr.net/npm/@goodtools/wiregasm@1.9.1/dist/';
importScripts(WIREGASM + 'wiregasm.js');

let lib = null;
let session = null;
let loading = null;

// Embind vectors → arrays (and free the C++ side)
function arr(v, map = x => x) {
    const out = [];
    for (let i = 0; i < v.size(); i++) out.push(map(v.get(i)));
    if (v.delete) v.delete();
    return out;
}

async function gunzipFetch(file, label) {
    const resp = await fetch(WIREGASM + file);
    if (!resp.ok) throw new Error(`${file}: HTTP ${resp.status}`);
    const total = +resp.headers.get('content-length') || 0;
    let done = 0, shown = -1;
    const counted = resp.body.pipeThrough(new TransformStream({
        transform(chunk, ctl) {
            done += chunk.length;
            const pct = total ? Math.floor(100 * done / total) : 0;
            if (label && pct >= shown + 5) {
                shown = pct;
                self.postMessage({ progress: `${label}… ${pct}%` });
            }
            ctl.enqueue(chunk);
        },
    }));
    return new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function load() {
    if (!loading) {
        loading = (async () => {
            self.postMessage({ progress: 'Downloading Wireshark (19 MB the first time)…' });
            const [data, wasm] = await Promise.all([
                gunzipFetch('wiregasm.data.gz'),
                gunzipFetch('wiregasm.wasm.gz', 'Downloading Wireshark (19 MB the first time)'),
            ]);
            self.postMessage({ progress: 'Starting Wireshark…' });
            lib = await self.loadWiregasm({
                wasmBinary: wasm,
                getPreloadedPackage: () => data,
                print: () => {},
                printErr: () => {},
                handleStatus: () => {},
            });
            if (!lib.init()) throw new Error('Wireshark did not initialize');
        })();
    }
    return loading;
}

function tree(nodes) {
    return arr(nodes, n => ({
        label: n.label,
        filter: n.filter,
        start: n.start,
        length: n.length,
        source: n.data_source_idx,
        type: n.type,
        fnum: n.fnum,
        url: n.url,
        children: tree(n.tree),
    }));
}

const commands = {
    open({ name, bytes }) {
        if (session) { session.delete(); session = null; }
        const dir = lib.getUploadDirectory();
        const path = dir + '/' + name.replace(/[^\w.-]/g, '_');
        try { lib.FS.unlink(path); } catch { /* not there */ }
        lib.FS.writeFile(path, new Uint8Array(bytes));
        session = new lib.DissectSession(path);
        const r = session.load();
        if (r.code !== 0) throw new Error(r.error || `could not read the capture (code ${r.code})`);
        return { summary: { ...r.summary }, columns: arr(lib.getColumns()), version: lib.wiresharkVersion() };
    },
    frames({ filter, skip, limit }) {
        const r = session.getFrames(filter || '', skip || 0, limit || 0);
        return {
            matched: r.matched,
            frames: arr(r.frames, f => ({ number: f.number, bg: f.bg, fg: f.fg, marked: f.marked, comments: f.comments, columns: arr(f.columns) })),
        };
    },
    frame({ number }) {
        const f = session.getFrame(number);
        return {
            number: f.number,
            comments: arr(f.comments),
            sources: arr(f.data_sources, d => ({ name: d.name, data: d.data })),
            tree: tree(f.tree),
            follow: arr(f.follow, v => arr(v)),
        };
    },
    follow({ proto, filter }) {
        const f = session.follow(proto, filter);
        return {
            shost: f.shost, sport: f.sport, sbytes: f.sbytes,
            chost: f.chost, cport: f.cport, cbytes: f.cbytes,
            payloads: arr(f.payloads, p => ({ number: p.number, server: p.server, data: p.data })),
        };
    },
    tap({ taps }) {
        const args = new lib.MapInput();
        for (const [k, v] of Object.entries(taps)) args.set(k, v);
        const r = session.tap(args);
        args.delete();
        const out = arr(r.taps, t => {
            const res = { tap: t.tap, type: t.type, proto: t.proto };
            if (t.convs) res.convs = arr(t.convs, c => ({ ...c }));
            if (t.hosts) res.hosts = arr(t.hosts, h => ({ ...h }));
            if (t.objects) res.objects = arr(t.objects, o => ({ ...o }));
            if (t.delete) t.delete();
            return res;
        });
        return { error: r.error, taps: out };
    },
    download({ token }) {
        const r = session.download(token);
        if (r.error) throw new Error(r.error);
        return { ...r.download };
    },
    check({ filter }) {
        return { ...lib.checkFilter(filter) };
    },
    complete({ text }) {
        return arr(lib.completeFilter(text).fields, f => ({ field: f.field, name: f.name, type: f.type }));
    },
};

self.onmessage = async ({ data }) => {
    const { id, cmd } = data;
    try {
        await load();
        if (cmd !== 'open' && cmd !== 'check' && cmd !== 'complete' && !session) throw new Error('no capture open');
        self.postMessage({ id, result: commands[cmd](data) });
    } catch (err) {
        self.postMessage({ id, error: (err && err.message) || String(err) });
    }
};
