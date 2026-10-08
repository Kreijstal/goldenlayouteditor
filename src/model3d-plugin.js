// --- 3D Model Plugin ---
// Lazy-loads Three.js and loaders when a 3D model is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { parseGcode } = require('./gcode-parse');

const log = createLogger('Model3D');
const THREE_VERSION = '0.164.1';
const THREE_URL = `https://esm.sh/three@${THREE_VERSION}`;
const GLTF_LOADER_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/GLTFLoader.js`;
const STL_LOADER_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/STLLoader.js`;
const OBJ_LOADER_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/OBJLoader.js`;
// .blend parser (Blender 5+ files only), loaded when a .blend is opened
const JSBLENDER_URL = 'https://esm.sh/jsblender@0.0.4';
const SVG_LOADER_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/SVGLoader.js`;
// three's loaders for the other formats, each imported when a file of its kind is opened
const LOADERS_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/`;
const EXTRA_LOADERS = {
    amf: ['AMFLoader', 'AMFLoader'],
    dae: ['ColladaLoader', 'ColladaLoader'],
    wrl: ['VRMLLoader', 'VRMLLoader'],
    vrml: ['VRMLLoader', 'VRMLLoader'],
    ply: ['PLYLoader', 'PLYLoader'],
    '3ds': ['TDSLoader', 'TDSLoader'],
    '3dm': ['3DMLoader', 'Rhino3dmLoader'],
};
// Rhino's openNURBS (WebAssembly) for .3dm, the version three's 3DMLoader comes with
const RHINO3DM_PATH = 'https://cdn.jsdelivr.net/npm/rhino3dm@8.4.0/';
// STEP, IGES and OpenCASCADE BREP are read by occt-import-js in a worker (public/occt-worker.js)
const OCCT_WORKER_URL = 'occt-worker.js';
const CAD_FORMATS = { step: 'step', stp: 'step', p21: 'step', iges: 'iges', igs: 'iges', brep: 'brep' };
// Formats three.js has no loader for, converted to GLB by assimpjs (Assimp as WebAssembly, from jsDelivr).
// On the page itself: Assimp's OpenGEX parser recurses deeper than a worker's stack allows
const ASSIMPJS_PATH = 'https://cdn.jsdelivr.net/npm/assimpjs@0.0.10/dist/';
const ASSIMP_FORMATS = { ogex: 'OpenGEX' };
// OpenSCAD renders in a worker (public/openscad-worker.js), which loads the WebAssembly build
const OPENSCAD_WORKER_URL = 'openscad-worker.js';
const { parseParameters, toScad } = require('./scad-params');
const { pageReadsArchives, resolveFileUrl } = require('./archive-fallback');
const PARAM_RENDER_DELAY_MS = 350;
// Parameters with a play button: sliders, and numbers named like a time or frame
const ANIMATED_PARAM_RE = /(^|_)(t|time|anim|animation|frame|phase)(_|$)/i;
const PLAY_FRAME_MS = 1000 / 12;   // fastest playback; usually rendering is slower
const PLAY_DEFAULT_STEP = 0.25;    // per frame, for a number without a range
const FRAME_CACHE_SIZE = 80;       // rendered results kept, keyed by parameter values
// OpenSCAD's default colour for parts without color()
const OPENSCAD_DEFAULT_COLOR = [0xf9 / 255, 0xd7 / 255, 0x2c / 255];
const MODEL_RE = /\.(glb|gltf|stl|obj|gcode|gco|blend|scad|csg|amf|dae|wrl|vrml|ply|3ds|3dm|step|stp|p21|iges|igs|brep|ogex)$/i;
// Formats read from the file alone (by a three.js loader, OpenCASCADE or Assimp): these get thumbnails too
const LOADER_MODEL_RE = /\.(glb|gltf|stl|obj|amf|dae|wrl|vrml|ply|3ds|3dm|step|stp|p21|iges|igs|brep|ogex)$/i;
// Names other files have too: a .ply, .amf or .stp only when it starts as a PLY, AMF or STEP file
const SHARED_NAME_RE = /\.(ply|amf|stp)$/i;
const THUMB_SIZE = 256;
const THUMB_CACHE_LIMIT = 64;

let _threePromise = null;

async function ensureThreeLoaded() {
    if (!_threePromise) {
        _threePromise = (async () => {
            const [THREE, gltfMod, stlMod, objMod] = await Promise.all([
                import(THREE_URL),
                import(GLTF_LOADER_URL),
                import(STL_LOADER_URL),
                import(OBJ_LOADER_URL),
            ]);
            return {
                THREE,
                GLTFLoader: gltfMod.GLTFLoader,
                STLLoader: stlMod.STLLoader,
                OBJLoader: objMod.OBJLoader,
            };
        })();
    }
    return _threePromise;
}

const _loaderModules = {};

function importLoader(ext) {
    const [file, name] = EXTRA_LOADERS[ext];
    if (!_loaderModules[file]) {
        _loaderModules[file] = import(LOADERS_URL + file + '.js').then(mod => mod[name]);
        _loaderModules[file].catch(() => { delete _loaderModules[file]; });
    }
    return _loaderModules[file];
}

// PLY starts with a "ply" line, then its format; AMF is XML whose root is <amf>, or that zipped
function looksLikePly(head) {
    return /^ply\r?\n/.test(head) && /\nformat (ascii|binary_little_endian|binary_big_endian) /.test(head);
}

function looksLikeAmf(head) {
    return head.startsWith('PK\x03\x04') || /^\uFEFF?\s*(<\?xml[^]*?\?>\s*)?(<!--[^]*?-->\s*)*<amf[\s>]/.test(head);
}

// A STEP file (ISO 10303-21, "Part 21") starts with its "ISO-10303-21;" line
function looksLikeStep(head) {
    return /^\uFEFF?\s*ISO-10303-21;/.test(head);
}

function headText(bytes) {
    return new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
}

function isSharedModel(name, head) {
    if (/\.stp$/i.test(name)) return looksLikeStep(head);
    return /\.ply$/i.test(name) ? looksLikePly(head) : looksLikeAmf(head);
}

// A .ply / .amf file (once read) that is a PLY or AMF model; one not read yet, or read as binary
// without its first bytes, is offered and the viewer tells
function isModel3dFile(f) {
    if (!SHARED_NAME_RE.test(f.name)) return MODEL_RE.test(f.name);
    if (typeof f.content === 'string' && f.content) return isSharedModel(f.name, f.content.slice(0, 1024));
    const bytes = f.head || f.bytes;
    return !bytes || isSharedModel(f.name, headText(bytes));
}

// Textures and other files a model names, looked up next to it in the workspace.
// settled(): a promise for when the ones asked for so far have loaded (or failed)
function resourceManager(THREE, dir) {
    const manager = new THREE.LoadingManager();
    let loading = false, waiting = [];
    manager.onStart = () => { loading = true; };
    manager.onLoad = () => {
        loading = false;
        waiting.forEach(resolve => resolve());
        waiting = [];
    };
    manager.settled = () => loading ? new Promise(resolve => waiting.push(resolve)) : Promise.resolve();
    if (dir) {
        manager.setURLModifier(url => {
            if (/^(data|blob|https?):/i.test(url)) return url;
            const parts = (dir + '/' + url.replace(/\\/g, '/').replace(/^file:\/+/i, '')).split('/');
            const out = [];
            for (const p of parts) {
                if (p === '..') out.pop();
                else if (p !== '.' && p !== '') out.push(p);
            }
            return '/workspace-file?path=' + encodeURIComponent('/' + out.join('/'));
        });
    }
    return manager;
}

// Textures that could not be read (not next to the model) are left off, not drawn black
function dropMissingTextures(object) {
    object.traverse(child => {
        for (const material of child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : []) {
            for (const [key, value] of Object.entries(material)) {
                if (value && value.isTexture && !value.image) {
                    material[key] = null;
                    material.needsUpdate = true;
                }
            }
        }
    });
}

async function gunzipIfNeeded(buffer) {
    const b = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
    if (b[0] !== 0x1f || b[1] !== 0x8b) return buffer;
    return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

let _rhinoLoader = null;

// --- STEP, IGES, BREP (OpenCASCADE) ---
// One worker reads them, one file at a time
let _occtWorker = null;
let _occtNextId = 1;
const _occtPending = new Map();

function occtRead(format, buffer) {
    if (!_occtWorker) {
        const worker = _occtWorker = new Worker(new URL(OCCT_WORKER_URL, document.baseURI));
        const failAll = message => {
            for (const p of _occtPending.values()) p.reject(new Error(message));
            _occtPending.clear();
            if (_occtWorker === worker) _occtWorker = null;
            worker.terminate();
        };
        worker.onmessage = ({ data }) => {
            const p = _occtPending.get(data.id);
            _occtPending.delete(data.id);
            if (data.error && data.fatal) failAll(data.error); // OpenCASCADE aborted: a new worker next time
            if (!p) return;
            if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
        };
        worker.onerror = e => failAll(e.message || 'OpenCASCADE failed to load');
    }
    const id = _occtNextId++;
    const bytes = buffer.slice(0);
    return new Promise((resolve, reject) => {
        _occtPending.set(id, { resolve, reject });
        _occtWorker.postMessage({ id, format, bytes }, [bytes]);
    });
}

// --- Assimp (OpenGEX) ---
let _assimp = null;

function ensureAssimp() {
    if (!_assimp) {
        _assimp = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = ASSIMPJS_PATH + 'assimpjs.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Could not load assimpjs'));
            document.head.appendChild(script);
        }).then(() => window.assimpjs({ locateFile: file => ASSIMPJS_PATH + file }));
        _assimp.catch(() => { _assimp = null; });
    }
    return _assimp;
}

// The file as binary glTF; the name's extension picks Assimp's importer
async function assimpToGlb(name, buffer) {
    const ajs = await ensureAssimp();
    const files = new ajs.FileList();
    files.AddFile(name, new Uint8Array(buffer));
    let result;
    try {
        result = ajs.ConvertFileList(files, 'glb2');
    } catch (err) {
        _assimp = null; // a WebAssembly trap leaves the module unusable: a new one next time
        throw new Error(`Assimp could not read this file (${err && err.message || err})`);
    }
    if (!result.IsSuccess() || result.FileCount() === 0) throw new Error(`Assimp could not read this file (${result.GetErrorCode()})`);
    return result.GetFile(0).GetContent().slice().buffer;
}

// OpenGEX's up axis, from its Metric (key = "up") structure; "z" when it has none (the spec's default)
function ogexUpAxis(buffer) {
    const m = /Metric\s*\(\s*key\s*=\s*"up"\s*\)\s*\{\s*string\s*\{\s*"([yz])"/.exec(new TextDecoder().decode(buffer));
    return m ? m[1] : 'z';
}

const CAD_DEFAULT_COLOR = 0x9ad0ff;

// The assembly tree OpenCASCADE read, as groups of meshes (one per body, its B-rep faces
// a material group each when they have colours of their own). Z-up, as CAD is.
function buildCadObject(THREE, result) {
    const materials = new Map(); // colour -> material, shared
    const material = rgb => {
        const key = rgb ? rgb.join(',') : '';
        if (!materials.has(key)) {
            const color = rgb ? new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace) : new THREE.Color(CAD_DEFAULT_COLOR);
            // DoubleSide: an IGES file's surfaces need not face outwards
            materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }));
        }
        return materials.get(key);
    };
    const stats = { bodies: result.meshes.length, faces: 0 };
    const meshObject = m => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
        if (m.normal && m.normal.length === m.position.length) geometry.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
        else geometry.computeVertexNormals();
        geometry.setIndex(new THREE.BufferAttribute(m.index, 1));
        stats.faces += m.faces.length;
        let mat;
        if (m.faces.some(f => f.color)) {
            const used = [];
            for (const f of m.faces) {
                const fm = material(f.color || m.color);
                let at = used.indexOf(fm);
                if (at < 0) at = used.push(fm) - 1;
                geometry.addGroup(f.first * 3, (f.last - f.first + 1) * 3, at);
            }
            mat = used;
        } else {
            mat = material(m.color);
        }
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.name = m.name || '';
        return mesh;
    };
    const node = n => {
        const group = new THREE.Group();
        group.name = n.name || '';
        for (const i of n.meshes || []) group.add(meshObject(result.meshes[i]));
        for (const child of n.children || []) group.add(node(child));
        return group;
    };
    const object = node(result.root);
    if (!stats.bodies) throw new Error('no surfaces or solids to draw (curves and points are not drawn)');
    object.rotation.x = -Math.PI / 2; // CAD is Z-up
    object.userData.cadStats = stats;
    return object;
}

// A model read by one of three's loaders, Y-up as the viewer shows it.
// manager: a resourceManager, for the textures (and glTF buffers) it names
async function parseModel(libs, ext, buffer, manager) {
    const THREE = libs.THREE;
    let object;
    if (ext === 'glb' || ext === 'gltf') {
        object = await parseGltf(new libs.GLTFLoader(manager), buffer, '', ext === 'glb');
    } else if (ext === 'stl') {
        const geometry = new libs.STLLoader().parse(buffer);
        const material = new THREE.MeshStandardMaterial({ color: 0x9ad0ff, roughness: 0.55, metalness: 0.05 });
        object = new THREE.Mesh(geometry, material);
        object.rotation.x = -Math.PI / 2; // STL is Z-up (slicer/CAD convention)
    } else if (ext === 'obj') {
        object = new libs.OBJLoader().parse(new TextDecoder().decode(buffer));
    } else if (ext === 'ply') {
        if (!looksLikePly(headText(new Uint8Array(buffer)))) throw new Error('not a PLY model');
        const PLYLoader = await importLoader(ext);
        const geometry = new PLYLoader(manager).parse(buffer);
        const vertexColors = !!geometry.getAttribute('color');
        if (geometry.index) {
            if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
            object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: vertexColors ? 0xffffff : 0x9ad0ff, vertexColors, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide }));
        } else {
            // vertices only: a point cloud
            object = new THREE.Points(geometry, new THREE.PointsMaterial({ color: vertexColors ? 0xffffff : 0x9ad0ff, vertexColors, size: 2, sizeAttenuation: false }));
        }
    } else if (ext === 'amf') {
        if (!looksLikeAmf(headText(new Uint8Array(buffer)))) throw new Error('not an AMF model');
        const AMFLoader = await importLoader(ext);
        object = new AMFLoader(manager).parse(buffer);
        object.rotation.x = -Math.PI / 2; // AMF is Z-up (3D printing)
    } else if (ext === 'dae') {
        const ColladaLoader = await importLoader(ext);
        const collada = new ColladaLoader(manager).parse(new TextDecoder().decode(buffer), '');
        if (!collada) throw new Error('not a COLLADA document');
        object = collada.scene; // turned Y-up by the loader, as its <up_axis> says
    } else if (ext === 'wrl' || ext === 'vrml') {
        const text = new TextDecoder().decode(await gunzipIfNeeded(buffer));
        if (!/^#VRML V2\.0/.test(text)) throw new Error(/^#VRML V1\.0/.test(text) ? 'VRML 1.0 is not supported, only VRML 97 (2.0)' : 'not a VRML 97 file');
        const VRMLLoader = await importLoader(ext);
        object = new VRMLLoader(manager).parse(text, '');
        // A Background is a sky sphere 10000 across, drawn first: left out, so the model itself is framed
        const backgrounds = [];
        object.traverse(child => { if (child.renderOrder === -Infinity) backgrounds.push(child); });
        for (const child of backgrounds) {
            child.removeFromParent();
            disposeObject(THREE, child);
        }
    } else if (ext === '3ds') {
        const TDSLoader = await importLoader(ext);
        object = new TDSLoader(manager).parse(buffer, '');
        object.rotation.x = -Math.PI / 2; // 3ds Max is Z-up
    } else if (ext === '3dm') {
        if (!_rhinoLoader) {
            const Rhino3dmLoader = await importLoader(ext);
            _rhinoLoader = new Rhino3dmLoader();
            _rhinoLoader.setLibraryPath(RHINO3DM_PATH);
        }
        object = await new Promise((resolve, reject) => _rhinoLoader.parse(buffer, resolve, reject));
        object.rotation.x = -Math.PI / 2; // Rhino is Z-up
    } else if (CAD_FORMATS[ext]) {
        const format = CAD_FORMATS[ext];
        if (format === 'step' && !looksLikeStep(headText(new Uint8Array(buffer)))) throw new Error('not a STEP file (no ISO-10303-21 header)');
        object = buildCadObject(THREE, await occtRead(format, buffer));
    } else if (ASSIMP_FORMATS[ext]) {
        // Assimp keeps the file's axes: a Z-up scene is turned Y-up here
        object = await parseGltf(new libs.GLTFLoader(manager), await assimpToGlb('model.' + ext, buffer), '', true);
        if (ext === 'ogex' && ogexUpAxis(buffer) === 'z') object.rotation.x = -Math.PI / 2;
    } else {
        throw new Error(`Unsupported model format: ${ext}`);
    }
    return object;
}

// OFF as written by OpenSCAD: "OFF nv nf 0", vertices, then "n i0 .. i(n-1) [r g b [a]]"
// per face. Faces are fanned into triangles; per-face colours become vertex colours,
// and translucent faces go into a second, transparent mesh.
function srgbToLinear(c) {
    return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

function buildOffObject(THREE, text) {
    const lines = text.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
    let i = 0;
    let head = lines[i++].split(/\s+/);
    if (head[0].endsWith('OFF')) head = head.length > 1 ? head.slice(1) : lines[i++].split(/\s+/);
    const nv = +head[0], nf = +head[1];
    const verts = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
        const t = lines[i++].split(/\s+/);
        verts[v * 3] = +t[0]; verts[v * 3 + 1] = +t[1]; verts[v * 3 + 2] = +t[2];
    }
    const buckets = { opaque: { pos: [], col: [] }, clear: { pos: [], col: [] } };
    for (let f = 0; f < nf; f++) {
        const t = lines[i++].split(/\s+/).map(Number);
        const n = t[0];
        let rgba = OPENSCAD_DEFAULT_COLOR.concat(1);
        if (t.length >= n + 4) {
            const c = t.slice(n + 1, n + 5);
            const scale = c.some(x => x > 1) ? 255 : 1;
            rgba = [c[0] / scale, c[1] / scale, c[2] / scale, c.length > 3 ? c[3] / scale : 1];
        }
        const bucket = rgba[3] < 0.999 ? buckets.clear : buckets.opaque;
        for (let k = 2; k < n; k++) {
            for (const idx of [t[1], t[k], t[k + 1]]) {
                bucket.pos.push(verts[idx * 3], verts[idx * 3 + 1], verts[idx * 3 + 2]);
                bucket.col.push(rgba[0], rgba[1], rgba[2], rgba[3]);
            }
        }
    }
    const group = new THREE.Group();
    for (const [name, b] of Object.entries(buckets)) {
        if (!b.pos.length) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        // OFF colours are sRGB; vertex colours are linear
        const col = new Float32Array(b.col);
        for (let k = 0; k < col.length; k++) if (k % 4 !== 3) col[k] = srgbToLinear(col[k]);
        geometry.setAttribute('color', new THREE.BufferAttribute(col, 4));
        geometry.computeVertexNormals(); // non-indexed → flat facets, like OpenSCAD
        const clear = name === 'clear';
        const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05, transparent: clear, depthWrite: !clear, side: clear ? THREE.DoubleSide : THREE.FrontSide });
        group.add(new THREE.Mesh(geometry, material));
    }
    return group;
}

function makeButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title || label;
    btn.addEventListener('click', onClick);
    return btn;
}

function parseGltf(loader, data, path, isBinary) {
    return new Promise((resolve, reject) => {
        loader.parse(isBinary ? data : new TextDecoder().decode(data), path || '', gltf => resolve(gltf.scene), reject);
    });
}

function disposeObject(THREE, object) {
    object.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        const materials = child.material ? (Array.isArray(child.material) ? child.material : [child.material]) : [];
        for (const material of materials) {
            for (const value of Object.values(material)) {
                if (value && value.isTexture) value.dispose();
            }
            material.dispose();
        }
    });
}

function collectStats(object) {
    const stats = { objects: 0, meshes: 0, vertices: 0, triangles: 0, materials: 0 };
    const materials = new Set();
    object.traverse(child => {
        stats.objects++;
        if (child.isMesh) {
            stats.meshes++;
            const geom = child.geometry;
            if (geom && geom.attributes && geom.attributes.position) {
                stats.vertices += geom.attributes.position.count;
                stats.triangles += geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
            }
            if (child.material) {
                if (Array.isArray(child.material)) child.material.forEach(m => materials.add(m));
                else materials.add(child.material);
            }
        }
    });
    stats.materials = materials.size;
    stats.triangles = Math.round(stats.triangles);
    return stats;
}

// Step for a number field: 1 for whole numbers, else as fine as the most precise value
function stepFor(values) {
    let decimals = 0;
    for (const v of values) {
        if (typeof v !== 'number' || !isFinite(v)) continue;
        const s = String(v);
        const d = s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] || '').length;
        decimals = Math.max(decimals, d);
    }
    return decimals ? Math.pow(10, -Math.min(decimals, 6)) : 1;
}

function numberInput(step) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    return input;
}

class Model3dComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = Model3dComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'model.glb';
        this.THREE = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.model = null;
        this.animationId = 0;
        this.yaw = 0;
        this.pitch = 0.25;
        this.distance = 4;
        this.isDragging = false;

        this.root = container.element;
        this.root.classList.add('model3d-plugin-root');
        this._installStyles();
        this._buildUI();
        if (container.on) {
            container.on('resize', () => this._resize());
            container.on('destroy', () => this._destroy());
        }
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (Model3dComponent._styleInstalled) return;
        Model3dComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.model3d-plugin-root{height:100%;background:#181a1f;color:#e8eaed;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.model3d-shell{display:flex;flex-direction:column;height:100%}
.model3d-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2b2d31;border-bottom:1px solid #3c4043;white-space:nowrap;overflow:auto}
.model3d-toolbar button{background:#3c4043;color:#e8eaed;border:1px solid #5f6368;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.model3d-toolbar button:hover{background:#4a4d52}
.model3d-title{font-weight:600;min-width:120px;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.model3d-status{margin-left:auto;color:#bdc1c6;font-size:12px}
.model3d-main{display:grid;grid-template-columns:1fr 300px;min-height:0;flex:1}
.model3d-stage{position:relative;min-width:0;min-height:0;background:#111317;overflow:hidden}
.model3d-stage canvas{display:block;width:100%;height:100%}
.model3d-side{min-height:0;border-left:1px solid #3c4043;background:#202124;display:flex;flex-direction:column}
.model3d-params{display:flex;flex-direction:column;min-height:0;max-height:65%;flex-shrink:0;border-bottom:1px solid #3c4043}
.model3d-params[hidden]{display:none}
.model3d-main:not(.params-open) .model3d-params{display:none}
.model3d-params h3{display:flex;align-items:center;gap:6px}
.model3d-params h3 button{margin-left:auto;background:#3c4043;color:#e8eaed;border:1px solid #5f6368;border-radius:4px;padding:1px 7px;font:12px inherit;text-transform:none;cursor:pointer}
.model3d-param-list{overflow:auto;padding:2px 10px 8px}
.model3d-param-section{font-size:11px;color:#8ab4f8;margin:10px 0 2px;font-weight:600}
.model3d-param{padding:5px 0;border-bottom:1px solid #303134}
.model3d-param-head{display:flex;align-items:center;gap:6px;min-height:20px}
.model3d-param-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,"Cascadia Code",monospace;font-size:12px}
.model3d-param.changed .model3d-param-name{color:#fcd34d}
.model3d-param-reset{background:none;border:none;color:#bdc1c6;cursor:pointer;font-size:14px;padding:0 2px}
.model3d-param-reset[hidden]{display:none}
.model3d-param-desc{font-size:11px;color:#9aa0a6;margin:1px 0 3px}
.model3d-param-ctl{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.model3d-param-ctl input[type=range]{flex:1;min-width:80px}
.model3d-param-ctl input[type=number],.model3d-param-ctl input[type=text],.model3d-param-ctl select{background:#2b2d31;color:#e8eaed;border:1px solid #5f6368;border-radius:4px;padding:3px 5px;font:12px inherit;min-width:0}
.model3d-param-ctl input[type=number]{width:74px}
.model3d-param-ctl input[type=text],.model3d-param-ctl select{flex:1}
.model3d-param-ctl .model3d-param-play{background:#3c4043;color:#e8eaed;border:1px solid #5f6368;border-radius:4px;min-width:30px;height:26px;cursor:pointer;font-size:13px}
.model3d-param-ctl .model3d-param-play.on{background:#1a73e8;border-color:#1a73e8}
.model3d-param-steplabel{font-size:11px;color:#9aa0a6}
.model3d-param-ctl input.model3d-param-step{width:56px}
.model3d-param-ctl input[type=checkbox]{width:16px;height:16px;accent-color:#8ab4f8}
.model3d-side .model3d-stats{flex:1;min-height:0}
.model3d-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#bdc1c6;margin:0;padding:8px 10px;border-bottom:1px solid #3c4043}
.model3d-stats{overflow:auto;padding:10px}
.model3d-stat{display:grid;grid-template-columns:1fr auto;gap:8px;padding:6px 0;border-bottom:1px solid #303134}
.model3d-stat span:first-child{color:#bdc1c6}
.model3d-message,.model3d-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#bdc1c6}
.model3d-error{color:#fecaca}
@media (max-width:800px){.model3d-main{grid-template-columns:1fr}.model3d-side{display:none}.model3d-title{display:none}.model3d-toolbar{padding:5px 6px;gap:4px}
.model3d-main{position:relative}
.model3d-main.params-open .model3d-side{display:flex;position:absolute;top:0;right:0;bottom:0;width:min(320px,88%);z-index:2;box-shadow:-6px 0 18px rgba(0,0,0,.5)}
.model3d-main.params-open .model3d-params{max-height:100%;flex:1;border-bottom:none}
.model3d-main.params-open .model3d-side>h3,.model3d-main.params-open .model3d-stats{display:none}}
.model3d-stage{touch-action:none}
.model3d-layers{display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2b2d31;border-bottom:1px solid #3c4043;white-space:nowrap}
.model3d-layers[hidden]{display:none}
.model3d-layers input[type=range]{flex:1;min-width:0}
.model3d-layers label{display:flex;align-items:center;gap:4px;color:#bdc1c6}
.model3d-toolbar button[hidden]{display:none}
.model3d-console{background:#202124;border-bottom:1px solid #3c4043;font-size:12px}
.model3d-console[hidden]{display:none}
.model3d-console summary{padding:4px 10px;color:#bdc1c6;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.model3d-console pre{margin:0;padding:4px 10px 8px;max-height:30vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px ui-monospace,"Cascadia Code",monospace;color:#d1d5db}
.model3d-console .warn{color:#fcd34d}
.model3d-console .err{color:#fca5a5}
.model3d-console .echo{color:#93c5fd}
.model3d-layer-info{color:#bdc1c6;font-size:12px;min-width:92px;text-align:right}
.model3d-parts{display:flex;flex-direction:column;min-height:0;max-height:55%;flex-shrink:0;border-bottom:1px solid #3c4043}
.model3d-parts[hidden]{display:none}
.model3d-part-list{overflow:auto;padding:4px 6px 6px}
.model3d-part{display:flex;align-items:center;gap:5px;padding:2px 0;white-space:nowrap;font-size:12px}
.model3d-part input{margin:0;accent-color:#8ab4f8}
.model3d-part-swatch{width:10px;height:10px;border-radius:2px;flex-shrink:0;border:1px solid #5f6368}
.model3d-part-name{overflow:hidden;text-overflow:ellipsis}
.model3d-part.group .model3d-part-name{color:#8ab4f8}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        this.root.innerHTML = '';
        this.shell = document.createElement('div');
        this.shell.className = 'model3d-shell';
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'model3d-toolbar';

        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.glb,.gltf,.stl,.obj,.gcode,.gco,.blend,.scad,.csg,.amf,.dae,.wrl,.vrml,.ply,.3ds,.3dm,.step,.stp,.p21,.iges,.igs,.brep';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', e => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local 3D model', () => this.fileInput.click()));
        this.toolbar.appendChild(makeButton('Reset', 'Reset camera', () => this._frameModel()));
        this.wireframeBtn = makeButton('Wireframe', 'Show the edges of the triangles', () => {
            this.wireframe = !this.wireframe;
            this._applyWireframe();
        });
        this.toolbar.appendChild(this.wireframeBtn);
        this.renderBtn = makeButton('Render', 'Render the OpenSCAD file again (after editing it)', () => this._rerender());
        this.renderBtn.hidden = true;
        this.toolbar.appendChild(this.renderBtn);
        this.paramsBtn = makeButton('Parameters', 'Show or hide the OpenSCAD parameters', () => this._toggleParams());
        this.paramsBtn.hidden = true;
        this.toolbar.appendChild(this.paramsBtn);
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'model3d-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'model3d-status';
        this.toolbar.appendChild(this.statusEl);

        // G-code only: layer slider and travel toggle
        this.layersBar = document.createElement('div');
        this.layersBar.className = 'model3d-layers';
        this.layersBar.hidden = true;
        this.layersBar.innerHTML = '<input type="range" min="1" max="1" value="1"><span class="model3d-layer-info"></span><label><input type="checkbox"> travel</label>';
        this.layerRange = this.layersBar.querySelector('input[type=range]');
        this.layerInfo = this.layersBar.querySelector('.model3d-layer-info');
        this.travelToggle = this.layersBar.querySelector('input[type=checkbox]');
        this.layerRange.addEventListener('input', () => this._showLayers(+this.layerRange.value));
        this.travelToggle.addEventListener('change', () => this._showLayers(+this.layerRange.value));

        // OpenSCAD only: echo/warning/error output
        this.consoleEl = document.createElement('details');
        this.consoleEl.className = 'model3d-console';
        this.consoleEl.hidden = true;
        this.consoleEl.innerHTML = '<summary></summary><pre></pre>';

        this.main = document.createElement('div');
        this.main.className = 'model3d-main';
        this.stage = document.createElement('div');
        this.stage.className = 'model3d-stage';
        this.side = document.createElement('div');
        this.side.className = 'model3d-side';
        this.side.innerHTML = '<div class="model3d-params" hidden><h3>Parameters <button type="button" title="Back to the values in the file">Reset all</button></h3><div class="model3d-param-list"></div></div>'
            + '<div class="model3d-parts" hidden><h3>Parts</h3><div class="model3d-part-list"></div></div><h3>Model Stats</h3><div class="model3d-stats"></div>';
        this.statsEl = this.side.querySelector('.model3d-stats');
        this.paramsEl = this.side.querySelector('.model3d-params');
        this.paramListEl = this.side.querySelector('.model3d-param-list');
        this.partsEl = this.side.querySelector('.model3d-parts');
        this.partListEl = this.side.querySelector('.model3d-part-list');
        this.paramsEl.querySelector('h3 button').onclick = () => this._resetParams();
        this.main.appendChild(this.stage);
        this.main.appendChild(this.side);
        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.layersBar);
        this.shell.appendChild(this.consoleEl);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open a GLB, glTF, STL, OBJ, PLY, AMF, COLLADA, VRML, 3DS, Rhino 3DM, STEP, IGES, BREP or G-code file to view it.');

        this.stage.addEventListener('mousedown', e => this._startDrag(e));
        this.stage.addEventListener('wheel', e => this._onWheel(e), { passive: false });
        this._moveHandler = e => this._moveDrag(e);
        this._upHandler = () => this._endDrag();
        window.addEventListener('mousemove', this._moveHandler);
        window.addEventListener('mouseup', this._upHandler);
        this._wireTouch();
    }

    // One finger orbits, two fingers pinch-zoom.
    _wireTouch() {
        let last = null;
        const snap = (e) => {
            const t = e.touches;
            if (t.length === 1) return { x: t[0].clientX, y: t[0].clientY, d: 0 };
            if (t.length >= 2) return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) };
            return null;
        };
        this.stage.addEventListener('touchstart', e => { last = snap(e); }, { passive: true });
        this.stage.addEventListener('touchmove', e => {
            const cur = snap(e);
            if (!cur || !last) { last = cur; return; }
            e.preventDefault();
            if (cur.d && last.d) {
                this.distance = Math.max(0.1, this.distance * last.d / cur.d);
            } else if (!cur.d && !last.d) {
                this.yaw -= (cur.x - last.x) * 0.008;
                this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + (cur.y - last.y) * 0.008));
            }
            last = cur;
            this._updateCamera();
        }, { passive: false });
        const end = e => { last = snap(e); };
        this.stage.addEventListener('touchend', end, { passive: true });
        this.stage.addEventListener('touchcancel', end, { passive: true });
    }

    async _init() {
        if (this.fileData) await this._loadProjectFile();
        else this.statusEl.textContent = 'Three.js loads when a model is opened';
    }

    async _loadProjectFile() {
        try {
            if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) {
                this._showMessage('Workspace-backed model loading requires the server workspace.');
                return;
            }
            const relPath = this.ctx.getRelativePath(this.fileId);
            this.sourcePath = this.ctx.currentWorkspacePath + '/' + relPath;
            const url = '/workspace-file?path=' + encodeURIComponent(this.sourcePath);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._loadBuffer(await resp.arrayBuffer(), this.fileData.name, '');
        } catch (err) {
            this._showError(err.message);
        }
    }

    async _loadFileObject(file) {
        this.sourcePath = '/local/' + file.name; // a local file can't pull in includes
        this.localFile = file;
        await this._loadBuffer(await file.arrayBuffer(), file.name, '');
    }

    async _loadBuffer(buffer, name, basePath) {
        this.fileName = name || this.fileName;
        this.titleEl.textContent = this.fileName;
        this.statusEl.textContent = 'Loading Three.js...';
        const ext = (this.fileName.split('.').pop() || '').toLowerCase();
        try {
            const libs = await ensureThreeLoaded();
            this.THREE = libs.THREE;
            this._ensureScene();
            this.statusEl.textContent = 'Parsing model...';
            let object;
            this.gcode = null;
            this.extraStats = null;
            this.layersBar.hidden = true;
            this.consoleEl.hidden = true;
            this.partsEl.hidden = true;
            // .csg is OpenSCAD's flattened CSG tree, in OpenSCAD syntax
            const isScad = ext === 'scad' || ext === 'csg';
            this.renderBtn.hidden = !isScad;
            if (!isScad) this._setParams([]);
            if (isScad) {
                this.scadText = new TextDecoder().decode(buffer);
                this.frameCache = new Map();
                this._setParams(parseParameters(this.scadText));
                object = await this._buildScad(this.scadText);
            } else if (ext === 'blend') {
                object = await this._buildBlend(buffer);
            } else if (ext === 'gcode' || ext === 'gco') {
                object = this._buildGcode(new TextDecoder().decode(buffer));
            } else {
                // a local file can't pull in its textures
                const dir = this.localFile ? '' : (this.sourcePath || '').replace(/\/[^/]*$/, '');
                const manager = resourceManager(this.THREE, dir);
                if (CAD_FORMATS[ext]) this.statusEl.textContent = 'Reading with OpenCASCADE...';
                if (ASSIMP_FORMATS[ext]) this.statusEl.textContent = 'Reading with Assimp...';
                object = await parseModel(libs, ext, buffer, manager);
                manager.settled().then(() => dropMissingTextures(object));
                if (CAD_FORMATS[ext]) this._showCadParts(object, ext, buffer);
                if (ASSIMP_FORMATS[ext]) this.extraStats = { format: ASSIMP_FORMATS[ext], reader: 'assimpjs 0.0.10 (Assimp)' };
            }
            this._setModel(object);
        } catch (err) {
            if (err.cancelled) return; // a parameter change started a newer render
            log.error('Failed to open 3D model:', err);
            this._showError(ext === 'scad' || ext === 'csg' ? err.message : `Failed to open 3D model: ${err.message}`);
        }
    }

    // Render a .scad with OpenSCAD in a worker. Colours from color() come through the
    // OFF export; a 2D top-level object comes back as SVG and is drawn flat on the grid.
    async _buildScad(text) {
        return this._scadObject(await this._renderScad(text, this._paramDefines()));
    }

    async _scadObject(result) {
        const THREE = this.THREE;
        if (result.cancelled) {
            const err = new Error('Render cancelled');
            err.cancelled = true;
            throw err;
        }
        if (result.cache) this.scadCache = result.cache;
        this._setConsole(result.log || [], !result.ok);
        if (!result.ok) {
            const err = new Error(result.error);
            err.scadLog = result.log;
            throw err;
        }
        const warnings = (result.log || []).filter(l => /WARNING/.test(l)).length;
        this.extraStats = {
            renderer: 'OpenSCAD 2026.07.26 (WebAssembly)',
            'render time': (result.ms / 1000).toFixed(1) + ' s',
            'files read': result.files,
            ...(warnings ? { warnings } : {}),
        };
        let object;
        if (result.kind === '2d') {
            const { SVGLoader } = await import(SVG_LOADER_URL);
            const data = new SVGLoader().parse(result.svg);
            const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(...OPENSCAD_DEFAULT_COLOR), side: THREE.DoubleSide, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }); // drawn over the grid it lies on
            const shapes = data.paths.flatMap(path => SVGLoader.createShapes(path));
            object = new THREE.Mesh(new THREE.ShapeGeometry(shapes), material);
            object.scale.y = -1; // SVG is Y-down
            const wrap = new THREE.Group();
            wrap.add(object);
            wrap.rotation.x = -Math.PI / 2; // lie flat on the grid, as OpenSCAD shows 2D
            this.extraStats.kind = '2D (shown flat)';
            return wrap;
        }
        object = buildOffObject(THREE, result.off);
        object.rotation.x = -Math.PI / 2; // OpenSCAD is Z-up
        return object;
    }

    // --- Customizer parameters ---
    // Keeps values the user changed when the file is rendered again, as long as the
    // parameter still exists with the same default
    _setParams(params) {
        this._stopPlay();
        const old = new Map((this.params || []).map(p => [p.name, p]));
        const values = {};
        for (const p of params) {
            const prev = old.get(p.name);
            const kept = prev && JSON.stringify(prev.value) === JSON.stringify(p.value) && this.paramValues && p.name in this.paramValues;
            values[p.name] = kept ? this.paramValues[p.name] : p.value;
        }
        this.params = params;
        this.paramValues = values;
        this.paramsBtn.hidden = !params.length;
        this.paramsEl.hidden = !params.length;
        if (params.length && this.paramsOpen === undefined) this._toggleParams(this.root.clientWidth > 800);
        this._renderParamList();
    }

    _toggleParams(open = !this.paramsOpen) {
        this.paramsOpen = open;
        this.main.classList.toggle('params-open', open);
        this.paramsBtn.classList.toggle('on', open);
        this.paramsBtn.style.background = open ? '#1a73e8' : '';
    }

    _paramDefines(values = this.paramValues) {
        return (this.params || []).filter(p => JSON.stringify(values[p.name]) !== JSON.stringify(p.value))
            .map(p => `${p.name}=${toScad(values[p.name])}`);
    }

    _resetParams() {
        this._stopPlay();
        for (const p of this.params || []) this.paramValues[p.name] = p.value;
        this._renderParamList();
        this._scheduleParamRender(0);
    }

    _renderParamList() {
        const list = this.paramListEl;
        list.innerHTML = '';
        this.paramSetters = {};
        this.playButtons = {};
        let section = null;
        for (const p of this.params || []) {
            if (p.section !== section) {
                section = p.section;
                if (section) {
                    const h = document.createElement('div');
                    h.className = 'model3d-param-section';
                    h.textContent = section;
                    list.appendChild(h);
                }
            }
            list.appendChild(this._paramRow(p));
        }
    }

    _paramRow(p) {
        const row = document.createElement('div');
        row.className = 'model3d-param';
        const head = document.createElement('div');
        head.className = 'model3d-param-head';
        const name = document.createElement('span');
        name.className = 'model3d-param-name';
        name.textContent = p.name;
        name.title = p.name + (p.description ? '\n' + p.description : '') + '\nIn the file: ' + toScad(p.value);
        const reset = document.createElement('button');
        reset.className = 'model3d-param-reset';
        reset.textContent = '\u21BA';
        reset.title = 'Back to ' + toScad(p.value);
        head.append(name, reset);
        row.appendChild(head);
        if (p.description) {
            const desc = document.createElement('div');
            desc.className = 'model3d-param-desc';
            desc.textContent = p.description;
            row.appendChild(desc);
        }
        const ctl = document.createElement('div');
        ctl.className = 'model3d-param-ctl';
        row.appendChild(ctl);

        const setters = [];
        const refresh = () => {
            const changed = JSON.stringify(this.paramValues[p.name]) !== JSON.stringify(p.value);
            row.classList.toggle('changed', changed);
            reset.hidden = !changed;
        };
        this.paramSetters[p.name] = (value) => {
            setters.forEach(s => s(value));
            refresh();
        };
        const commit = (value, delay = PARAM_RENDER_DELAY_MS) => {
            this.paramValues[p.name] = value;
            setters.forEach(s => s(value));
            refresh();
            if (this.play && this.play.name === p.name) this._stopPlay();
            if (this.play) this._restartPlayFrames(); // frames ahead used the old value
            else this._scheduleParamRender(delay);
        };
        reset.onclick = () => commit(p.value, 0);
        const value = this.paramValues[p.name];
        const c = p.constraint;

        if (c && c.kind === 'options') {
            const select = document.createElement('select');
            c.options.forEach((o, i) => {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = o.label;
                select.appendChild(opt);
            });
            const sync = v => { select.value = String(c.options.findIndex(o => o.value === v)); };
            select.onchange = () => commit(c.options[+select.value].value, 0);
            setters.push(sync);
            sync(value);
            ctl.appendChild(select);
        } else if (typeof p.value === 'boolean') {
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = value;
            box.onchange = () => commit(box.checked, 0);
            setters.push(v => { box.checked = v; });
            ctl.appendChild(box);
        } else if (typeof p.value === 'string') {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = value;
            input.onchange = () => commit(input.value, 0);
            setters.push(v => { input.value = v; });
            ctl.appendChild(input);
        } else if (typeof p.value === 'number') {
            const step = c && c.step ? c.step : stepFor([p.value, c && c.min, c && c.max]);
            const num = numberInput(step);
            num.value = value;
            if (c && c.kind === 'range') {
                const range = document.createElement('input');
                range.type = 'range';
                range.min = c.min;
                range.max = c.max;
                range.step = step;
                range.value = value;
                range.oninput = () => commit(Number(range.value));
                setters.push(v => { range.value = v; });
                ctl.appendChild(range);
            }
            num.onchange = () => { if (num.value !== '' && !isNaN(num.valueAsNumber)) commit(num.valueAsNumber); };
            setters.push(v => { if (num.valueAsNumber !== v) num.value = v; });
            ctl.appendChild(num);
            if ((c && c.kind === 'range') || ANIMATED_PARAM_RE.test(p.name)) this._addPlayControls(p, ctl);
        } else if (Array.isArray(p.value)) {
            const step = stepFor(p.value);
            const inputs = p.value.map((_, i) => {
                const num = numberInput(step);
                num.value = value[i];
                num.onchange = () => {
                    if (num.value === '' || isNaN(num.valueAsNumber)) return;
                    const next = this.paramValues[p.name].slice();
                    next[i] = num.valueAsNumber;
                    commit(next);
                };
                ctl.appendChild(num);
                return num;
            });
            setters.push(v => inputs.forEach((num, i) => { num.value = v[i]; }));
        }
        refresh();
        return row;
    }

    // --- Playing a parameter ---
    // ▶ steps the value by "step" per frame (a slider's range wraps around). Frames
    // are rendered ahead by a few workers in parallel and shown in order.
    _addPlayControls(p, ctl) {
        const c = p.constraint && p.constraint.kind === 'range' ? p.constraint : null;
        this.playSteps = this.playSteps || {};
        if (!(p.name in this.playSteps)) this.playSteps[p.name] = c ? (c.step || +((c.max - c.min) / 30).toPrecision(3)) : PLAY_DEFAULT_STEP;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'model3d-param-play';
        btn.onclick = () => (this.play && this.play.name === p.name ? this._stopPlay() : this._startPlay(p));
        const step = numberInput('any');
        step.className = 'model3d-param-step';
        step.title = 'Change per frame';
        step.value = this.playSteps[p.name];
        step.onchange = () => {
            if (step.value === '' || isNaN(step.valueAsNumber) || step.valueAsNumber === 0) { step.value = this.playSteps[p.name]; return; }
            this.playSteps[p.name] = step.valueAsNumber;
            if (this.play && this.play.name === p.name) this._restartPlayFrames();
        };
        const label = document.createElement('span');
        label.className = 'model3d-param-steplabel';
        label.textContent = 'step';
        ctl.append(btn, label, step);
        this.playButtons[p.name] = btn;
        this._updatePlayButtons();
    }

    _updatePlayButtons() {
        for (const [name, btn] of Object.entries(this.playButtons || {})) {
            const on = !!this.play && this.play.name === name;
            btn.textContent = on ? '\u23F8' : '\u25B6';
            btn.title = on ? 'Pause' : 'Play: step this value and render each frame';
            btn.classList.toggle('on', on);
        }
    }

    _startPlay(p) {
        this._stopPlay();
        clearTimeout(this.paramTimer);
        if (this.scadCancel) this.scadCancel();
        const c = p.constraint && p.constraint.kind === 'range' ? p.constraint : null;
        const advance = (v) => {
            let next = +(v + this.playSteps[p.name]).toPrecision(12);
            if (c && next > c.max + 1e-9) next = c.min;
            if (c && next < c.min - 1e-9) next = c.max;
            return next;
        };
        const workers = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
        const play = this.play = { name: p.name, jobs: [], advance, next: advance(this.paramValues[p.name]) };
        this._updatePlayButtons();
        const running = () => this.play === play;
        (async () => {
            let lastShown = 0;
            while (running()) {
                while (play.jobs.length < workers) {
                    const value = play.next;
                    play.next = advance(value);
                    const defines = this._paramDefines({ ...this.paramValues, [p.name]: value });
                    play.jobs.push({ value, job: this._scadJob(this.scadText, defines) });
                }
                const head = play.jobs[0];
                const result = await head.job.promise;
                if (!running()) return;
                if (play.jobs[0] !== head) continue; // frames were restarted meanwhile
                play.jobs.shift();
                if (!result.ok) {
                    this._stopPlay();
                    this._setConsole(result.log || [], true);
                    this.statusEl.textContent = 'Error: ' + result.error;
                    return;
                }
                const wait = PLAY_FRAME_MS - (performance.now() - lastShown);
                if (wait > 0) await new Promise(r => setTimeout(r, wait));
                if (!running()) return;
                let object;
                try { object = await this._scadObject(result); } catch (_) { continue; }
                if (!running()) { disposeObject(this.THREE, object); return; }
                this.paramValues[p.name] = head.value;
                if (this.paramSetters[p.name]) this.paramSetters[p.name](head.value);
                this._setModel(object, { keepView: true });
                lastShown = performance.now();
            }
        })();
    }

    // Drop the frames rendered ahead (another value or the step changed) and go on
    // from the value on screen
    _restartPlayFrames() {
        const play = this.play;
        if (!play) return;
        for (const { job } of play.jobs) job.cancel();
        play.jobs = [];
        play.next = play.advance(this.paramValues[play.name]);
    }

    _stopPlay() {
        const play = this.play;
        if (!play) return;
        this.play = null;
        for (const { job } of play.jobs) job.cancel();
        play.jobs = [];
        this._updatePlayButtons();
    }

    _scheduleParamRender(delay) {
        clearTimeout(this.paramTimer);
        this.paramTimer = setTimeout(() => this._renderWithParams(), delay);
    }

    // Render again with the current parameter values, keeping the camera where it is.
    // A failed render leaves the last good model up; the console shows why.
    async _renderWithParams() {
        if (!this.scadText || !this.THREE) return;
        const token = this.paramRenderToken = (this.paramRenderToken || 0) + 1;
        let object;
        try {
            object = await this._buildScad(this.scadText);
        } catch (err) {
            if (token !== this.paramRenderToken) return;
            if (!this.model) this._showError(err.message);
            else this.statusEl.textContent = 'Error: ' + err.message;
            return;
        }
        if (token !== this.paramRenderToken) return;
        this._setModel(object, { keepView: true });
    }

    // One render at a time: a new one cancels the one still running
    _renderScad(source, defines = []) {
        if (this.scadCancel) this.scadCancel();
        this.statusEl.textContent = 'Loading OpenSCAD...';
        const job = this._scadJob(source, defines, true);
        this.scadCancel = job.cancel;
        return job.promise.then(result => {
            if (this.scadCancel === job.cancel) this.scadCancel = null;
            return result;
        });
    }

    // Render in a worker of its own. Results for parameter values rendered before
    // come from the cache. cancel() resolves the promise with { cancelled: true }.
    _scadJob(source, defines, showProgress = false) {
        const key = defines.join('\n');
        if (this.frameCache && this.frameCache.has(key)) {
            const hit = this.frameCache.get(key);
            this.frameCache.delete(key);
            this.frameCache.set(key, hit); // most recently used last
            return { promise: Promise.resolve(hit), cancel() {} };
        }
        const worker = new Worker(new URL(OPENSCAD_WORKER_URL, document.baseURI), { type: 'module' });
        this.scadWorkers = this.scadWorkers || new Set();
        this.scadWorkers.add(worker);
        let settle;
        const promise = new Promise((resolve) => {
            settle = (result) => {
                if (!settle) return;
                settle = null;
                worker.terminate();
                this.scadWorkers.delete(worker);
                resolve(result);
            };
            worker.onmessage = (e) => {
                if (e.data.read) { this._readForWorker(worker, e.data); return; }
                if (e.data.progress) { if (showProgress) this.statusEl.textContent = e.data.progress; return; }
                const result = e.data;
                if (result.ok && this.frameCache) {
                    this.frameCache.set(key, result);
                    if (this.frameCache.size > FRAME_CACHE_SIZE) this.frameCache.delete(this.frameCache.keys().next().value);
                }
                if (settle) settle(result);
            };
            worker.onerror = (e) => {
                if (settle) settle({ ok: false, error: 'OpenSCAD failed to load: ' + (e.message || 'network error'), log: [] });
            };
            worker.postMessage({ path: this.sourcePath || '/model.scad', source, defines, cache: this.scadCache || [], readViaPage: pageReadsArchives() });
        });
        return { promise, cancel: () => { if (settle) settle({ ok: false, cancelled: true, log: [] }); } };
    }

    // A file the worker asked for (the page reads archives itself, see archive-fallback.js)
    async _readForWorker(worker, { read, rid }) {
        let bytes = null;
        try {
            const resp = await fetch('/workspace-file?path=' + encodeURIComponent(read));
            if (resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
        } catch (_) { /* treated as missing */ }
        worker.postMessage({ type: 'read-result', rid, bytes }, bytes ? [bytes.buffer] : []);
    }

    _setConsole(lines, open) {
        const pre = this.consoleEl.querySelector('pre');
        pre.innerHTML = '';
        let echo = 0, warn = 0, err = 0;
        for (const line of lines) {
            const span = document.createElement('span');
            if (/^ECHO/.test(line)) { span.className = 'echo'; echo++; }
            else if (/WARNING/.test(line)) { span.className = 'warn'; warn++; }
            else if (/ERROR|Can't parse/.test(line)) { span.className = 'err'; err++; }
            span.textContent = line + '\n';
            pre.appendChild(span);
        }
        const parts = [];
        if (err) parts.push(`${err} error${err > 1 ? 's' : ''}`);
        if (warn) parts.push(`${warn} warning${warn > 1 ? 's' : ''}`);
        if (echo) parts.push(`${echo} echo`);
        this.consoleEl.querySelector('summary').textContent = 'Console' + (parts.length ? ' — ' + parts.join(', ') : '');
        this.consoleEl.hidden = !lines.length;
        this.consoleEl.open = !!open;
    }

    _rerender() {
        this._stopPlay();
        this.scadCache = null; // included files may have changed too
        if (this.localFile) this._loadFileObject(this.localFile);
        else this._loadProjectFile();
    }

    // Build meshes from a .blend: modifier-evaluated geometry (jsblender applies Mirror
    // and Array), world transforms, and one material group per Blender material slot
    async _buildBlend(buffer) {
        const THREE = this.THREE;
        this.statusEl.textContent = 'Loading .blend parser...';
        const jb = await import(JSBLENDER_URL);
        const blend = jb.parseBlend(new Uint8Array(buffer));
        if (blend.header.version < 5) {
            throw new Error(`saved by Blender ${blend.header.version.toFixed(2)}; this viewer reads Blender 5+ files (re-save it in Blender 5)`);
        }
        const materials = new Map();
        for (const m of jb.extractMaterials(blend)) {
            const p = m.shader && m.shader.principled;
            const c = p ? p.baseColor : m.diffuse;
            const alpha = p ? p.alpha : c[3];
            // Blender colours are linear, which is three's working colour space
            materials.set(m.name, new THREE.MeshStandardMaterial({
                color: new THREE.Color().setRGB(c[0], c[1], c[2]),
                metalness: p ? p.metallic : m.metallic,
                roughness: p ? p.roughness : m.roughness,
                transparent: alpha < 1,
                opacity: alpha,
                side: THREE.DoubleSide,
            }));
        }
        const fallback = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, side: THREE.DoubleSide });

        const evaluated = jb.evaluateAllMeshes(blend);
        const root = new THREE.Group();
        root.rotation.x = -Math.PI / 2; // Blender is Z-up
        const typeNames = Object.fromEntries(Object.entries(jb.OB_TYPE).map(([k, v]) => [v, k.toLowerCase()]));
        const skipped = {};
        let meshObjects = 0;
        for (const o of jb.extractObjects(blend)) {
            const mesh = o.type === jb.OB_TYPE.MESH ? evaluated.get(o.name) : null;
            if (!mesh || !mesh.triangles.length) {
                const t = typeNames[o.type] || `type ${o.type}`;
                skipped[t] = (skipped[t] || 0) + 1;
                continue;
            }
            const slots = mesh.materialSlotNames.length ? mesh.materialSlotNames : [null];
            const obj = new THREE.Mesh(this._blendGeometry(jb, blend, mesh, slots.length),
                slots.map(name => (name && materials.get(name)) || fallback));
            obj.name = o.name;
            obj.matrixAutoUpdate = false;
            obj.matrix.fromArray(o.worldMatrix); // column-major, like three
            root.add(obj);
            meshObjects++;
        }
        if (!meshObjects) throw new Error('no mesh objects in this .blend');
        this.extraStats = {
            blender: blend.header.version.toFixed(2),
            'mesh objects': meshObjects,
            ...(Object.keys(skipped).length ? { 'not shown': Object.entries(skipped).map(([t, n]) => `${n} ${t}`).join(', ') } : {}),
        };
        return root;
    }

    // Triangles regrouped by material slot; flat or smooth shading from Blender's sharp_face
    _blendGeometry(jb, blend, mesh, slotCount) {
        const THREE = this.THREE;
        const tris = mesh.triangles, offsets = mesh.faceOffsets, matIdx = mesh.materialIndices;
        const buckets = Array.from({ length: slotCount }, () => []);
        let t = 0;
        for (let f = 0; f + 1 < offsets.length; f++) {
            const slot = Math.min(matIdx[f] || 0, slotCount - 1);
            // jsblender fans each n-gon from its first corner: n - 2 triangles, in face order
            for (let k = 0; k < offsets[f + 1] - offsets[f] - 2; k++, t++) {
                buckets[slot].push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
            }
        }
        let index;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
        if (t * 3 === tris.length) {
            index = new Uint32Array(tris.length);
            let at = 0;
            buckets.forEach((b, slot) => {
                index.set(b, at);
                geom.addGroup(at, b.length, slot);
                at += b.length;
            });
        } else {
            index = tris; // unexpected triangulation: one material for the whole mesh
            geom.addGroup(0, tris.length, 0);
        }
        geom.setIndex(new THREE.BufferAttribute(index, 1));

        const sharpAttr = mesh.attributes && mesh.attributes.sharp_face;
        const sharp = sharpAttr ? jb.readAttributeAsUint8(blend.reader, sharpAttr) : null;
        let sharpCount = 0;
        if (sharp) for (const v of sharp) sharpCount += v ? 1 : 0;
        if (sharp && sharpCount * 2 > sharp.length) {
            const flat = geom.toNonIndexed(); // keeps groups
            flat.computeVertexNormals();
            geom.dispose();
            return flat;
        }
        geom.setAttribute('normal', new THREE.BufferAttribute(mesh.vertexNormals, 3));
        return geom;
    }

    // STEP / IGES / BREP: the assembly tree, each part and body with a check box to show or hide it
    _showCadParts(object, ext, buffer) {
        const format = CAD_FORMATS[ext];
        const { bodies, faces } = object.userData.cadStats;
        let parts = 0;
        object.traverse(child => { if (child.isGroup && child !== object) parts++; });
        // the application protocol a STEP file says it follows (AP203, AP214, AP242...)
        const schema = format === 'step' && /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536))));
        this.extraStats = {
            format: { step: 'STEP', iges: 'IGES', brep: 'OpenCASCADE BREP' }[format],
            ...(schema ? { schema: schema[1].split(/\s/)[0] } : {}),
            reader: 'occt-import-js 0.0.23 (OpenCASCADE)',
            ...(format !== 'brep' ? { units: 'mm' } : {}),
            ...(parts ? { parts } : {}),
            bodies,
            'B-rep faces': faces,
        };
        const list = this.partListEl;
        list.innerHTML = '';
        const row = (obj, depth, label, isGroup) => {
            const el = document.createElement('label');
            el.className = 'model3d-part' + (isGroup ? ' group' : '');
            el.style.paddingLeft = (depth * 14) + 'px';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = true;
            box.onchange = () => { obj.visible = box.checked; };
            el.appendChild(box);
            if (!isGroup) {
                const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
                const swatch = document.createElement('span');
                swatch.className = 'model3d-part-swatch';
                swatch.style.background = '#' + m.color.getHexString(this.THREE.SRGBColorSpace);
                el.appendChild(swatch);
            }
            const name = document.createElement('span');
            name.className = 'model3d-part-name';
            name.textContent = label;
            name.title = label;
            el.appendChild(name);
            list.appendChild(el);
        };
        let unnamed = 0;
        const walk = (obj, depth) => {
            for (const child of obj.children) {
                const isGroup = child.isGroup;
                row(child, depth, child.name || (isGroup ? 'part' : 'body ' + (++unnamed)), isGroup);
                if (isGroup) walk(child, depth + 1);
            }
        };
        // the root is the file itself unless it has a name
        if (object.name) {
            row(object, 0, object.name, true);
            walk(object, 1);
        } else {
            walk(object, 0);
        }
        this.partsEl.hidden = list.childElementCount < 2;
    }

    // Build line geometry for a G-code toolpath: extrusion colored by height, travel dimmed
    _buildGcode(text) {
        const THREE = this.THREE;
        const g = parseGcode(text);
        if (!g.extrusion.length) throw new Error('No extrusion moves found in G-code');
        const group = new THREE.Group();
        group.rotation.x = -Math.PI / 2; // machine frame is Z-up

        const extGeom = new THREE.BufferGeometry();
        extGeom.setAttribute('position', new THREE.BufferAttribute(g.extrusion, 3));
        const colors = new Float32Array(g.extrusion.length);
        const zMin = g.bounds.min[2], zSpan = Math.max(1e-6, g.bounds.max[2] - zMin);
        const c = new THREE.Color();
        for (let i = 0; i < g.extrusion.length; i += 3) {
            c.setHSL(0.66 - 0.66 * (g.extrusion[i + 2] - zMin) / zSpan, 0.85, 0.55);
            colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
        }
        extGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const extLines = new THREE.LineSegments(extGeom, new THREE.LineBasicMaterial({ vertexColors: true }));
        group.add(extLines);

        const travGeom = new THREE.BufferGeometry();
        travGeom.setAttribute('position', new THREE.BufferAttribute(g.travel, 3));
        const travLines = new THREE.LineSegments(travGeom, new THREE.LineBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.35 }));
        travLines.visible = false;
        group.add(travLines);

        this.gcode = { data: g, extLines, travLines };
        this.layerRange.max = String(g.layerZ.length);
        this.layerRange.value = String(g.layerZ.length);
        this.travelToggle.checked = false;
        this.layersBar.hidden = false;
        this._showLayers(g.layerZ.length);
        this._resize();
        return group;
    }

    _showLayers(count) {
        if (!this.gcode) return;
        const g = this.gcode.data;
        const n = Math.max(1, Math.min(count, g.layerZ.length));
        this.gcode.extLines.geometry.setDrawRange(0, g.layerEnd[n - 1] * 2);
        this.gcode.travLines.geometry.setDrawRange(0, g.travelEnd[n - 1] * 2);
        this.gcode.travLines.visible = this.travelToggle.checked;
        this.layerInfo.textContent = `${n}/${g.layerZ.length} · Z ${g.layerZ[n - 1].toFixed(2)}`;
    }

    _ensureScene() {
        const THREE = this.THREE;
        if (this.scene) {
            // An error message replaced the canvas; put it back
            if (this.renderer.domElement.parentNode !== this.stage) {
                this.stage.innerHTML = '';
                this.stage.appendChild(this.renderer.domElement);
                this._resize();
            }
            return;
        }
        this.stage.innerHTML = '';
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x111317);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.stage.appendChild(this.renderer.domElement);
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x293241, 2.1));
        const light = new THREE.DirectionalLight(0xffffff, 1.7);
        light.position.set(5, 7, 4);
        this.scene.add(light);
        const grid = new THREE.GridHelper(10, 20, 0x4b5563, 0x2d333b);
        grid.name = 'Grid';
        this.scene.add(grid);
        this._resize();
        this._animate();
    }

    _setModel(object, opts = {}) {
        const keepView = opts.keepView && this.model;
        if (this.model) {
            if (keepView) object.position.copy(this.model.position); // same centring, so nothing jumps
            this.scene.remove(this.model);
            disposeObject(this.THREE, this.model);
        }
        this.model = object;
        this.scene.add(object);
        this._applyWireframe();
        if (!keepView) this._frameModel();
        else {
            const size = new this.THREE.Box3().setFromObject(object).getSize(new this.THREE.Vector3());
            this.statusEl.textContent = `${this.fileName} | bounds ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`;
        }
        if (this.gcode) {
            const { data } = this.gcode, b = data.bounds;
            this._renderStats({
                layers: data.layerZ.length,
                'size (mm)': `${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} × ${(b.max[2] - b.min[2]).toFixed(1)}`,
                'extrusion segments': data.extrusion.length / 6,
                'travel segments': data.travel.length / 6,
                'filament (m)': (data.stats.filamentMm / 1000).toFixed(2),
                lines: data.stats.lines,
            });
        } else {
            this._renderStats({ ...(this.extraStats || {}), ...collectStats(object) });
        }
    }

    _applyWireframe() {
        this.wireframeBtn.style.background = this.wireframe ? '#1a73e8' : '';
        if (!this.model) return;
        this.model.traverse(child => {
            if (!child.isMesh) return;
            for (const m of Array.isArray(child.material) ? child.material : [child.material]) {
                if (m && 'wireframe' in m) m.wireframe = !!this.wireframe;
            }
        });
    }

    _frameModel() {
        if (!this.THREE || !this.model) return;
        const THREE = this.THREE;
        this.model.position.set(0, 0, 0);
        this.model.updateMatrixWorld(true);
        let box;
        if (this.gcode) {
            // Frame the printed part only (not travel or purge lines); machine Z-up → scene Y-up
            const f = this.gcode.data.frame;
            box = new THREE.Box3(new THREE.Vector3(f.min[0], f.min[2], -f.max[1]), new THREE.Vector3(f.max[0], f.max[2], -f.min[1]));
        } else {
            box = new THREE.Box3().setFromObject(this.model);
        }
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        this.model.position.sub(center);
        // Distance so the bounding sphere fits both the vertical and horizontal field of view
        const radius = Math.max(size.length() / 2, 1e-3);
        const vfov = this.camera.fov * Math.PI / 180;
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
        this.distance = radius * 1.1 / Math.sin(Math.min(vfov, hfov) / 2);
        const grid = this.scene.getObjectByName('Grid');
        if (grid) {
            grid.scale.setScalar(Math.max(size.x, size.z) * 1.5 / 10);
            grid.position.y = -size.y / 2;
        }
        this.yaw = 0.65;
        this.pitch = 0.35;
        this.statusEl.textContent = `${this.fileName} | bounds ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`;
        this._updateCamera();
    }

    _updateCamera() {
        if (!this.camera) return;
        const x = Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance;
        const y = Math.sin(this.pitch) * this.distance;
        const z = Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance;
        this.camera.position.set(x, y, z);
        this.camera.lookAt(0, 0, 0);
    }

    _renderStats(stats) {
        this.statsEl.innerHTML = '';
        for (const [label, value] of Object.entries(stats)) {
            const row = document.createElement('div');
            row.className = 'model3d-stat';
            row.innerHTML = '<span></span><strong></strong>';
            row.querySelector('span').textContent = label;
            row.querySelector('strong').textContent = String(value);
            this.statsEl.appendChild(row);
        }
    }

    _resize() {
        if (!this.renderer || !this.camera) return;
        const rect = this.stage.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    _animate() {
        if (!this.renderer || !this.scene || !this.camera) return;
        this.animationId = requestAnimationFrame(() => this._animate());
        this.renderer.render(this.scene, this.camera);
    }

    _startDrag(e) {
        this.isDragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
    }

    _moveDrag(e) {
        if (!this.isDragging) return;
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.008));
        this._updateCamera();
    }

    _endDrag() {
        this.isDragging = false;
    }

    _onWheel(e) {
        e.preventDefault();
        this.distance = Math.max(0.1, this.distance * (e.deltaY > 0 ? 1.12 : 0.88));
        this._updateCamera();
    }

    _showMessage(message) {
        this.stage.innerHTML = `<div class="model3d-message"></div>`;
        this.stage.firstChild.textContent = message;
    }

    _showError(message) {
        this.stage.innerHTML = `<div class="model3d-error"></div>`;
        this.stage.firstChild.textContent = message;
        this.statusEl.textContent = 'Error';
    }

    _destroy() {
        this._stopPlay();
        for (const worker of this.scadWorkers || []) worker.terminate();
        window.removeEventListener('mousemove', this._moveHandler);
        window.removeEventListener('mouseup', this._upHandler);
        if (this.animationId) cancelAnimationFrame(this.animationId);
        if (this.model && this.THREE) disposeObject(this.THREE, this.model);
        if (this.renderer) this.renderer.dispose();
    }
}

// --- Thumbnails ---
// One offscreen renderer draws them all (a page gets only a few WebGL contexts), one at a time
let _thumbRenderer = null;
let _thumbQueue = Promise.resolve();
const _thumbCache = new Map(); // absolute path -> data URL
const THUMB_TEXTURE_WAIT_MS = 5000;

async function drawThumbnail(path, name) {
    const libs = await ensureThreeLoaded();
    const THREE = libs.THREE;
    const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(path)));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const manager = resourceManager(THREE, path.replace(/\/[^/]*$/, ''));
    const object = await parseModel(libs, (name.split('.').pop() || '').toLowerCase(), await resp.arrayBuffer(), manager);
    try {
        await Promise.race([manager.settled(), new Promise(resolve => setTimeout(resolve, THUMB_TEXTURE_WAIT_MS))]);
        dropMissingTextures(object);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x111317);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x293241, 2.1));
        const light = new THREE.DirectionalLight(0xffffff, 1.7);
        light.position.set(5, 7, 4);
        scene.add(light);
        scene.add(object);
        object.updateMatrixWorld(true);
        // framed as the viewer frames it
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) throw new Error('nothing to draw');
        object.position.sub(box.getCenter(new THREE.Vector3()));
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
        const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
        const distance = radius * 1.05 / Math.sin(camera.fov * Math.PI / 360);
        const yaw = 0.65, pitch = 0.35;
        camera.position.set(Math.sin(yaw) * Math.cos(pitch) * distance, Math.sin(pitch) * distance, Math.cos(yaw) * Math.cos(pitch) * distance);
        camera.lookAt(0, 0, 0);
        if (!_thumbRenderer) {
            _thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
            _thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
        }
        _thumbRenderer.render(scene, camera);
        return _thumbRenderer.domElement.toDataURL('image/png');
    } finally {
        disposeObject(THREE, object);
    }
}

const modelThumbnails = {
    canHandle(file) {
        if (file.type !== 'file' || !LOADER_MODEL_RE.test(file.name)) return false;
        // (browse mode hasn't read any yet: its content is '')
        return !SHARED_NAME_RE.test(file.name) || typeof file.content !== 'string' || !file.content
            || isSharedModel(file.name, file.content.slice(0, 1024));
    },
    async render(file, container) {
        const ctx = Model3dComponent._ctx;
        if (!ctx || !ctx.currentWorkspacePath) return;
        const rel = ctx.getRelativePath(file.id);
        if (!rel) return;
        const path = ctx.currentWorkspacePath + '/' + rel;
        try {
            let url = _thumbCache.get(path);
            if (!url) {
                const job = _thumbQueue.then(() => drawThumbnail(path, file.name));
                _thumbQueue = job.catch(() => {});
                url = await job;
                _thumbCache.set(path, url);
                if (_thumbCache.size > THUMB_CACHE_LIMIT) _thumbCache.delete(_thumbCache.keys().next().value);
            }
            container.textContent = '';
            container.style.fontSize = '';
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;display:block;';
            container.appendChild(img);
        } catch (_) { /* keeps its icon */ }
    },
};

registerPlugin({
    id: 'model3d',
    name: '3D Model',
    components: {
        model3dViewer: Model3dComponent,
    },
    newFileTypes: [{ label: 'OpenSCAD model', ext: 'scad', content: () => '// OpenSCAD model\ncube(10, center = true);\n' }],
    toolbarButtons: [
        { label: '3D', title: 'Open 3D Model Viewer' },
    ],
    thumbnailRenderers: [modelThumbnails],
    contextMenuItems: [{
        label: 'Open 3D Model Viewer',
        canHandle: (fileName) => MODEL_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = Model3dComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('model3dViewer', { fileId }, `${file.name} [3d]`, 'model3d-' + fileId);
        },
    }],
    init(ctx) {
        Model3dComponent._ctx = ctx;
    },
});

module.exports = { isModel3dFile };
