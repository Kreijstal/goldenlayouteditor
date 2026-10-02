// Module worker running LaTeXML (see latexml-core.js), so a conversion never
// blocks the page and a runaway one can be ended with terminate().
//   → { type: 'init', base }            base: URL holding zeroperl.wasm.gz and latexml-lib.pack.gz
//   ← { type: 'progress', text } … { type: 'ready' } | { type: 'error', message }
//   → { type: 'convert', id, files, main, options }
//   ← { type: 'result', id, status, html, files, log, messages, ms }
import * as shim from 'https://esm.sh/@bjorn3/browser_wasi_shim@0.4.2';
import { createLatexml } from './latexml-core.js';

let latexml = null;

async function download(url, label) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        self.postMessage({ type: 'progress', text: `Downloading ${label}… ${(got / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB` });
    }
    return new Blob(parts);
}

async function init(base) {
    const [wasmGz, pack] = await Promise.all([
        download(new URL('zeroperl.wasm.gz', base), 'Perl'),
        download(new URL('latexml-lib.pack.gz', base), 'LaTeXML'),
    ]);
    self.postMessage({ type: 'progress', text: 'Starting Perl…' });
    const wasm = await new Response(wasmGz.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    latexml = await createLatexml({ shim, wasm, pack: new Uint8Array(await pack.arrayBuffer()) });
}

self.onmessage = async ({ data }) => {
    if (data.type === 'init') {
        try {
            await init(data.base);
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
    } else if (data.type === 'convert') {
        try {
            const r = await latexml.convert(data);
            self.postMessage({ type: 'result', id: data.id, ...r }, Object.values(r.files).map(f => f.buffer));
        } catch (err) {
            self.postMessage({ type: 'result', id: data.id, status: 3, html: null, files: {}, log: '', messages: err.message || String(err) });
        }
    }
};
