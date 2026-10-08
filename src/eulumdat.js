// --- Photometry (EULUMDAT .ldt, IES .ies), read and drawn by eulumdat-rs ---
// github.com/holg/eulumdat-rs, the library gldf-rs uses, built to WebAssembly
// outside this repo (~/git/eulumdat-rs-wasm/build.sh: a small wasm-bindgen API
// over its eulumdat crate) and loaded from @kreijstal/eulumdat-wasm on jsDelivr
// when a photometry is first shown. It draws its own diagrams as SVG.
const EULUMDAT_BASE = 'https://cdn.jsdelivr.net/npm/@kreijstal/eulumdat-wasm@0.7.1-build.1/';

// The diagrams eulumdat draws, in the order they are offered: [kind, label, width, height]
const PHOTOMETRY_DIAGRAMS = [
    ['polar', 'Polar', 500, 500],
    ['cartesian', 'Cartesian', 640, 440],
    ['heatmap', 'Heatmap', 640, 440],
    ['butterfly', 'Butterfly (3D)', 560, 480],
    ['cone', 'Cone', 560, 440],
    ['isocandela', 'Isocandela', 560, 480],
    ['bug', 'BUG rating', 640, 440],
];

let _libPromise = null;

function loadEulumdat() {
    if (!_libPromise) {
        _libPromise = import(EULUMDAT_BASE + 'eulumdat_wasm.js')
            .then(async lib => {
                await lib.default({ module_or_path: EULUMDAT_BASE + 'eulumdat_wasm_bg.wasm' });
                return lib;
            })
            .catch(err => { _libPromise = null; throw err; });
    }
    return _libPromise;
}

// LDT and IES files are plain text, UTF-8 or (mostly, for LDT) Windows-1252
function decodePhotometryText(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder('windows-1252').decode(bytes);
    }
}

// One diagram of a photometry as an SVG blob URL (shown as an <img>, so nothing in it runs).
// The caller revokes it.
async function photometryDiagramUrl(text, kind, dark = false) {
    const lib = await loadEulumdat();
    const spec = PHOTOMETRY_DIAGRAMS.find(d => d[0] === kind) || PHOTOMETRY_DIAGRAMS[0];
    const svg = lib.photometryDiagram(text, spec[0], spec[2], spec[3], dark);
    return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}

// The file's header and key figures (flux, LOR, efficacy, beam and field angles...)
async function photometrySummary(text) {
    return (await loadEulumdat()).photometrySummary(text);
}

// The file's header as eulumdat reads it, its lamp sets and what eulumdat's validation finds:
// { format: 'LDT' | 'IES', rows: [[label, value]], lampSets, warnings }
async function photometryHeader(text) {
    return (await loadEulumdat()).photometryHeader(text);
}

module.exports = { PHOTOMETRY_DIAGRAMS, loadEulumdat, decodePhotometryText, photometryDiagramUrl, photometrySummary, photometryHeader };
