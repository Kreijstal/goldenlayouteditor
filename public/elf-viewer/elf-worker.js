// The ELF viewer's Web Worker (a module worker): runs the Capstone linear sweep
// of the code (engine.js) off the page's thread, reporting progress, then
// disassembles the rows the page scrolls to.
//
// in:  { type: 'init', bytes (ArrayBuffer), setup }      -> progress…, then 'swept' or 'error'
//      { type: 'render', id, regionId, offsets }         -> { type: 'rows', id, regionId, rows }
import createCapstone from 'https://cdn.jsdelivr.net/npm/@kreijstal/capstone-wasm@6.0.0-alpha.11.build.1/capstone.mjs';
import { loadCapstone } from './capstone.js';
import { Engine } from './engine.js';

let engine = null;
let csPromise = null;

function capstone() {
    if (!csPromise) csPromise = loadCapstone(createCapstone);
    return csPromise;
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
        if (msg.type === 'init') {
            const cs = await capstone();
            const setup = { ...msg.setup, bytes: new Uint8Array(msg.bytes), bias: BigInt(msg.setup.bias) };
            engine = new Engine(cs, setup);
            self.postMessage({ type: 'ready', version: cs.version });
            let last = 0;
            const res = await engine.sweep((frac, where) => {
                const now = Date.now();
                if (now - last > 100 || frac === 1) { last = now; self.postMessage({ type: 'progress', frac, where }); }
            });
            const transfer = [res.refs.from.buffer, res.refs.to.buffer, res.refs.kind.buffer, res.refs.byFrom.buffer, res.refs.byTo.buffer, ...Object.values(res.rows).map(a => a.buffer)];
            self.postMessage({ type: 'swept', rows: res.rows, refs: res.refs, funcs: res.funcs }, transfer);
        } else if (msg.type === 'render') {
            if (!engine) throw new Error('not initialised');
            self.postMessage({ type: 'rows', id: msg.id, regionId: msg.regionId, rows: engine.render(msg.regionId, msg.offsets) });
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
    }
};
