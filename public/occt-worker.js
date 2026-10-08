// --- OpenCASCADE import worker ---
// Reads STEP, IGES and OpenCASCADE BREP files off the main thread with occt-import-js
// (OpenCASCADE's data exchange and mesher as WebAssembly, from jsDelivr), for the 3D
// model viewer (src/model3d-plugin.js). OCCT reads the B-rep, puts its units in
// millimetres (not a BREP, which has none) and triangulates each face.
// Request:  { id, format: 'step'|'iges'|'brep', bytes }
// Response: { id, result: { root, meshes } } or { id, error }
//   root: { name, meshes: [index], children: [node] }, the assembly tree
//   meshes: [{ name, color?, faces: [{ first, last, color? }] (triangle ranges, one per
//             B-rep face), position: Float32Array, normal?: Float32Array, index: Uint32Array }]

const OCCT_PATH = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/';

importScripts(OCCT_PATH + 'occt-import-js.js');

let occtPromise = null;

onmessage = async ({ data }) => {
    const { id, format, bytes } = data;
    try {
        if (!occtPromise) occtPromise = occtimportjs({ locateFile: name => OCCT_PATH + name });
        const occt = await occtPromise;
        const r = occt.ReadFile(format, new Uint8Array(bytes), null);
        if (!r || !r.success) throw new Error(`OpenCASCADE could not read this ${format.toUpperCase()} file`);
        const transfer = [];
        const meshes = r.meshes.map(m => {
            const position = new Float32Array(m.attributes.position.array);
            const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
            const index = new Uint32Array(m.index.array);
            transfer.push(position.buffer, index.buffer);
            if (normal) transfer.push(normal.buffer);
            return { name: m.name, color: m.color || null, faces: m.brep_faces || [], position, normal, index };
        });
        postMessage({ id, result: { root: r.root, meshes } }, transfer);
    } catch (err) {
        // an abort leaves the module unusable: the page starts a new worker
        postMessage({ id, error: String(err && err.message || err), fatal: !(err instanceof Error) || /abort|memory/i.test(err.message) });
    }
};
