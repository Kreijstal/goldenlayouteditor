// Loads cornerstone3D (core, tools, DICOM image loader) and dicom-parser from
// esm.sh, once, and sets them up the way dicomviewer's configureCodecs.js and
// cornerstonejs.js set up their cornerstone-core/WADO loader.
//
// The image loader decodes in web workers. Its own worker URL is relative to
// the CDN module and a page can't start a worker from another origin, so the
// worker is a blob-URL module: esm.sh's worker module, its imports made
// absolute, except the emscripten codecs (charls, openjpeg, libjpeg-turbo,
// openjph, libjxl), which import from @kreijstal/dicom-codecs-wasm instead -- built from
// source with the system emscripten by ~/git/dicom-codecs-wasm/build.sh, glue
// and wasm together. The loader finds each .wasm relative to its own module
// (a URL esm.sh does not serve); the worker's fetches for them go to
// that package too.

export const VERSIONS = {
    cornerstone: '5.11.3',
    dicomParser: '1.8.21',
};
const CS = VERSIONS.cornerstone;
// tools and the loader bundled (fewer requests); both keep importing esm.sh's core module, so
// there is one cornerstone core
export const URLS = {
    core: `https://esm.sh/@cornerstonejs/core@${CS}`,
    tools: `https://esm.sh/@cornerstonejs/tools@${CS}?bundle`,
    loader: `https://esm.sh/@cornerstonejs/dicom-image-loader@${CS}?bundle`,
    worker: `https://esm.sh/@cornerstonejs/dicom-image-loader@${CS}/es2022/dist/esm/decodeImageFrameWorker.mjs`,
    dicomParser: `https://esm.sh/dicom-parser@${VERSIONS.dicomParser}`,
};
// The codec builds the image loader depends on (its package.json): package -> its decode
// module, in @kreijstal/dicom-codecs-wasm (jsDelivr) as <package>/<module>.{mjs,wasm}
const CODECS_PATH = 'https://cdn.jsdelivr.net/npm/@kreijstal/dicom-codecs-wasm@1.0.0-build.1';
export const CODECS = {
    'codec-charls': 'charlswasm_decode',                       // 1.2.7, JPEG-LS
    'codec-openjpeg': 'openjpegwasm_decode',                   // 1.3.6, JPEG 2000
    'codec-libjpeg-turbo-8bit': 'libjpegturbowasm_decode',     // 1.2.7, JPEG baseline 8-bit
    'codec-openjph': 'openjphjs',                              // 2.4.11, HTJ2K
    'codec-libjxl': 'jpegxlwasm_decode',                       // 1.1.1, JPEG XL
};

// esm.sh's worker module with its imports absolute and the codecs' from @kreijstal/dicom-codecs-wasm
async function workerSource() {
    const res = await fetch(URLS.worker);
    if (!res.ok) throw new Error(`DICOM decode worker: ${URLS.worker}: HTTP ${res.status}`);
    const base = new URL(CODECS_PATH + '/', location.href).href;
    const wasm = {}, found = new Set();
    for (const name in CODECS) wasm[name] = `${base}${name}/${CODECS[name]}.wasm`;
    const code = (await res.text())
        .replace(/(\b(?:from|import)\s*\(?\s*)(["'])([^"']+)\2/g, (m, pre, q, spec) => {
            const codec = /^\/@cornerstonejs\/(codec-[\w-]+)@/.exec(spec);
            if (codec) {
                if (!CODECS[codec[1]]) throw new Error(`DICOM decode worker: no local build of ${codec[1]}`);
                found.add(codec[1]);
                return pre + q + `${base}${codec[1]}/${CODECS[codec[1]]}.mjs` + q;
            }
            return /^(\/|\.\.?\/)/.test(spec) ? pre + q + new URL(spec, URLS.worker).href + q : m;
        })
        .replace(/\bimport\.meta\.url\b/g, JSON.stringify(URLS.worker));
    for (const name in CODECS) {
        if (!found.has(name)) throw new Error(`DICOM decode worker: ${URLS.worker} no longer imports ${name}`);
    }
    // In a block: the worker module's own top-level names stay its own
    return `{
const WASM = ${JSON.stringify(wasm)};
const realFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const name in WASM) {
        if (url.includes('/@cornerstonejs/' + name + '/') || url.endsWith(WASM[name].slice(WASM[name].lastIndexOf('/')))) {
            return realFetch(WASM[name], init);
        }
    }
    return realFetch(input, init);
};
}
${code}`;
}

let _promise = null;

export function loadCornerstone() {
    if (!_promise) _promise = setup().catch(err => { _promise = null; throw err; });
    return _promise;
}

// Only dicom-parser (the attribute dump, the series scan): much smaller
let _parserPromise = null;
export function loadDicomParser() {
    if (!_parserPromise) {
        _parserPromise = import(URLS.dicomParser).then(m => m.default || m)
            .catch(err => { _parserPromise = null; throw err; });
    }
    return _parserPromise;
}

async function setup() {
    const [core, tools, loaderModule, dicomParser, worker] = await Promise.all([
        import(URLS.core), import(URLS.tools), import(URLS.loader), loadDicomParser(), workerSource(),
    ]);
    const loader = loaderModule.default || loaderModule;
    core.init();
    const workerUrl = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
    const maxWebWorkers = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
    // Registered first, so the loader's init keeps it instead of starting its own (cross-origin) worker
    core.getWebWorkerManager().registerWorker('dicomImageLoader',
        () => new Worker(workerUrl, { type: 'module', name: 'dicom-decode' }),
        { maxWorkerInstances: maxWebWorkers, autoTerminateOnIdle: { enabled: true, idleTimeThreshold: 60000 } });
    loader.init({ maxWebWorkers });
    // A pixel spacing of 0 (some CR files have "0.000\0.000") makes the camera NaN: treat it as
    // absent, which cornerstone handles (1 × 1, measurements in pixels)
    let inner = false;
    core.metaData.addProvider((type, imageId) => {
        if (inner || type !== 'imagePlaneModule') return undefined;
        let plane;
        inner = true;
        try { plane = core.metaData.get(type, imageId); } finally { inner = false; }
        if (!plane || (plane.rowPixelSpacing > 0 && plane.columnPixelSpacing > 0)) return undefined;
        return { ...plane, rowPixelSpacing: 1, columnPixelSpacing: 1, pixelSpacing: [1, 1], usingDefaultValues: true };
    }, 100000);
    tools.init();
    for (const T of [tools.WindowLevelTool, tools.PanTool, tools.ZoomTool, tools.StackScrollTool, tools.LengthTool, tools.AngleTool]) {
        tools.addTool(T);
    }
    return { core, tools, loader, dicomParser };
}
