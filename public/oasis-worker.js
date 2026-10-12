// Parsing runs in a dedicated, disposable Python/WASM worker.
const INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
const WHEEL = 'https://files.pythonhosted.org/packages/df/74/3dcb008d0c35a119333325c07697127953ac45a2e5f32faa0dfc5d5175d8/fatamorgana-0.14-py3-none-any.whl';
let ready;
async function initialize() {
    importScripts(INDEX + 'pyodide.js');
    const py = await loadPyodide({ indexURL: INDEX });
    await py.loadPackage('micropip');
    const micropip = py.pyimport('micropip');
    try { await micropip.install(WHEEL); } finally { micropip.destroy(); }
    const response = await fetch('py/oasis_preview.py');
    if (!response.ok) throw new Error(`Could not load the OASIS adapter (HTTP ${response.status}).`);
    py.FS.writeFile('/home/pyodide/oasis_preview.py', await response.text());
    return { py, adapter: py.pyimport('oasis_preview') };
}
self.onmessage = async ({ data }) => {
    try {
        if (!ready) ready = initialize();
        const { py, adapter } = await ready;
        const input = py.toPy(new Uint8Array(data.bytes));
        try { self.postMessage({ result: JSON.parse(adapter.parse_json(input)) }); }
        finally { input.destroy(); }
    } catch (err) { self.postMessage({ error: err.message }); }
};
