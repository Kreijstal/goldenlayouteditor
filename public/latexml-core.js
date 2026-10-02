// LaTeXML (github.com/brucemiller/LaTeXML) on zeroperl, Perl 5 as WebAssembly
// (github.com/6over3/zeroperl) built with XML::LibXML/LibXSLT, POSIX and
// Storable linked in. One Perl interpreter is kept, so after the first
// conversion the TeX engine and packages it loaded stay loaded.
//
// The file system is in memory (browser_wasi_shim, passed in as `shim`):
//   /image/lib   LaTeXML and the Perl modules it needs, from the pack file
//   /work/src    the project's files, written before each conversion
//   /work/out    what a conversion writes: the HTML, its CSS, images, log
// Works in a worker or in Node, which is how it is tested.

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A pack is a 4-byte length, a JSON index [[path, size], ...], then the bytes
function unpack(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(0, true);
    const index = JSON.parse(decoder.decode(bytes.subarray(4, 4 + len)));
    const files = [];
    let at = 4 + len;
    for (const [path, size] of index) {
        files.push([path, bytes.subarray(at, at + size)]);
        at += size;
    }
    return files;
}

function makeFs(shim) {
    const { Directory, File } = shim;
    const dir = () => new Directory(new Map());
    function mkdirs(root, parts) {
        let d = root;
        for (const p of parts) {
            let next = d.contents.get(p);
            if (!next) { next = dir(); next.parent = d; d.contents.set(p, next); }
            d = next;
        }
        return d;
    }
    function write(root, path, data) {
        const parts = path.split('/').filter(Boolean);
        const name = parts.pop();
        mkdirs(root, parts).contents.set(name, new File(typeof data === 'string' ? encoder.encode(data) : data));
    }
    function list(d, prefix = '', out = {}) {
        for (const [name, e] of d.contents) {
            if (e instanceof Directory) list(e, prefix + name + '/', out);
            else out[prefix + name] = e.data;
        }
        return out;
    }
    return { dir, mkdirs, write, list };
}

// { shim, wasm: BufferSource (zeroperl.wasm), pack: BufferSource (the .pack.gz),
//   onStdout/onStderr: line callbacks }
export async function createLatexml({ shim, wasm, pack, onStdout = () => {}, onStderr = () => {} }) {
    const { WASI, OpenFile, File, ConsoleStdout, PreopenDirectory } = shim;
    const fs = makeFs(shim);
    const root = fs.dir();
    const lib = fs.mkdirs(root, ['image', 'lib']);
    for (const [path, data] of unpack(await gunzip(pack))) fs.write(lib, path, data);
    const work = fs.mkdirs(root, ['work']);
    fs.mkdirs(root, ['tmp']);
    fs.write(root, 'dev/null', new Uint8Array(0));

    // Each conversion's messages, for its result
    let stderr = [];
    const wasi = new WASI(['perl'], ['PERL5LIB=/image/lib', 'HOME=/work', 'TMPDIR=/tmp'], [
        new OpenFile(new File(new Uint8Array(0))),
        ConsoleStdout.lineBuffered(line => onStdout(line)),
        ConsoleStdout.lineBuffered(line => { stderr.push(line); onStderr(line); }),
        new PreopenDirectory('/', root.contents),
    ], { debug: false });
    const { instance } = await WebAssembly.instantiate(wasm, {
        wasi_snapshot_preview1: wasi.wasiImport,
        env: { call_host_function: () => 0 },
    });
    const ex = instance.exports;
    wasi.initialize(instance);

    const mem = () => new Uint8Array(ex.memory.buffer);
    const cstr = s => {
        const b = encoder.encode(s + '\0');
        const p = ex.malloc(b.length);
        mem().set(b, p);
        return p;
    };
    const readCstr = p => {
        const m = mem();
        let e = p;
        while (m[e]) e++;
        return decoder.decode(m.subarray(p, e));
    };
    function evalPerl(code, args = []) {
        const ptrs = [cstr(code)];
        const argv = ex.malloc(4 * Math.max(1, args.length));
        args.forEach((a, i) => {
            const p = cstr(a);
            ptrs.push(p);
            new DataView(ex.memory.buffer).setUint32(argv + 4 * i, p, true);
        });
        const r = ex.zeroperl_eval(ptrs[0], 0, args.length, argv);
        ex.zeroperl_flush();
        const err = r ? readCstr(ex.zeroperl_last_error()) : null;
        for (const p of ptrs) ex.free(p);
        ex.free(argv);
        if (r) throw new Error(err || `Perl failed (${r})`);
    }

    if (ex.zeroperl_init()) throw new Error('Perl did not start: ' + readCstr(ex.zeroperl_last_error()));
    evalPerl('require LaTeXMLWasm;');

    // files: { 'relative/path': string | Uint8Array } (the project), main: one of
    // those paths; options: latexmlc options such as '--format=html5'.
    // Resolves to { status (0 ok .. 3 fatal), html, files: { path: Uint8Array }, log, messages }
    async function convert({ files, main, options = [] }) {
        work.contents.clear();
        const src = fs.mkdirs(work, ['src']);
        for (const [path, data] of Object.entries(files)) fs.write(src, path, data);
        fs.mkdirs(work, ['out']);
        const base = main.replace(/^.*\//, '').replace(/\.[^.]*$/, '');
        const dest = `/work/out/${base}.html`;
        stderr = [];
        const t = Date.now();
        try {
            evalPerl('my ($s, $d, @o) = @ARGV; my $code = lx_convert($s, $d, @o);'
                + ' open(my $fh, ">", "/work/status") or die $!; print $fh $code; close $fh;',
                [`/work/src/${main}`, dest, ...options]);
        } catch (err) {
            stderr.push(err.message);
        }
        const out = fs.list(work.contents.get('out'));
        const statusFile = work.contents.get('status');
        const status = statusFile ? parseInt(decoder.decode(statusFile.data), 10) : 3;
        const html = out[`${base}.html`];
        const log = out[`${base}.html.log`];
        delete out[`${base}.html`];
        delete out[`${base}.html.log`];
        delete out['LaTeXML.cache']; // (post-processing's own)
        return {
            status,
            html: html ? decoder.decode(html) : null,
            files: out,
            log: log ? decoder.decode(log) : '',
            messages: stderr.join('\n'),
            ms: Date.now() - t,
        };
    }
    return { convert, evalPerl };
}
