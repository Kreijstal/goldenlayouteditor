// Reads the glTF-binary container of a VRM avatar (.vrm) without three.js:
// checks the header and chunks, parses the JSON and pulls out what the
// viewer's metadata panel shows (VRM 0.x `VRM.meta` or VRM 1.0
// `VRMC_vrm.meta`, the embedded thumbnail, mesh/material/bone counts).
// Damaged and non-VRM files fail here with a message saying what is wrong,
// before the 3D libraries are involved. No DOM: runs in the browser and in Node.

const GLB_MAGIC = 0x46546c67;      // 'glTF'
const CHUNK_JSON = 0x4e4f534a;     // 'JSON'
const CHUNK_BIN = 0x004e4942;      // 'BIN\0'

export class VrmFileError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VrmFileError';
    }
}

function fail(message) {
    throw new VrmFileError(message);
}

// The JSON and BIN chunks of a GLB; throws on anything that is not a whole, valid GLB
export function readGlb(bytes) {
    if (bytes.byteLength < 12) fail(`The file is too short to be a VRM (${bytes.byteLength} bytes).`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) {
        const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
        if (head.startsWith('{')) fail('This is a text glTF (.gltf JSON), not a VRM: a VRM is a binary glTF (GLB) file.');
        fail('Not a VRM: the file does not start with the glTF-binary signature "glTF".');
    }
    const version = view.getUint32(4, true);
    if (version !== 2) fail(`Unsupported glTF-binary version ${version} (VRM needs glTF 2.0).`);
    const declared = view.getUint32(8, true);
    if (declared > bytes.byteLength) {
        fail(`The file is truncated: its header says ${declared} bytes, but only ${bytes.byteLength} are present.`);
    }
    let json = null, bin = null;
    for (let offset = 12; offset + 8 <= declared;) {
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        const start = offset + 8;
        if (start + length > declared) fail(`A glTF chunk at byte ${offset} runs past the end of the file; the file is damaged.`);
        if (type === CHUNK_JSON && !json) json = bytes.subarray(start, start + length);
        else if (type === CHUNK_BIN && !bin) bin = bytes.subarray(start, start + length);
        offset = start + length;
    }
    if (!json) fail('The glTF-binary file has no JSON chunk; the file is damaged.');
    let gltf;
    try {
        gltf = JSON.parse(new TextDecoder().decode(json).replace(/[\0\s]+$/, ''));
    } catch (err) {
        fail('The glTF JSON chunk is not valid JSON: ' + err.message);
    }
    if (!gltf || typeof gltf !== 'object') fail('The glTF JSON chunk is not an object.');
    return { gltf, bin };
}

// Bytes and MIME type of glTF image `index`, if it is stored in the file
function imageBytes(gltf, bin, index) {
    const image = gltf.images && gltf.images[index];
    if (!image) return null;
    if (typeof image.uri === 'string') {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(image.uri);
        if (!m || !m[2]) return null;
        const raw = atob(m[3]);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return { bytes: out, mimeType: m[1] || image.mimeType || 'image/png' };
    }
    const bv = gltf.bufferViews && gltf.bufferViews[image.bufferView];
    if (!bv || !bin || (bv.buffer || 0) !== 0) return null;
    const start = bv.byteOffset || 0;
    if (start + bv.byteLength > bin.byteLength) return null;
    return { bytes: bin.subarray(start, start + bv.byteLength), mimeType: image.mimeType || 'image/png' };
}

// Everything the viewer shows that comes straight from the file
export function inspectVrm(bytes) {
    const { gltf, bin } = readGlb(bytes);
    const ext = gltf.extensions || {};
    const used = gltf.extensionsUsed || [];
    let kind, meta, thumbnailImage = null;
    if (ext.VRMC_vrm) {
        kind = 1;
        meta = ext.VRMC_vrm.meta || {};
        if (Number.isInteger(meta.thumbnailImage)) thumbnailImage = meta.thumbnailImage;
    } else if (ext.VRM) {
        kind = 0;
        meta = ext.VRM.meta || {};
        const tex = Number.isInteger(meta.texture) && meta.texture >= 0 && gltf.textures && gltf.textures[meta.texture];
        if (tex && Number.isInteger(tex.source)) thumbnailImage = tex.source;
    } else if (used.includes('VRMC_vrm') || used.includes('VRM')) {
        fail('The file lists the VRM extension as used but contains no VRM data; it is damaged.');
    } else {
        const what = gltf.extensionsUsed && gltf.extensionsUsed.includes('VRMC_vrm_animation') ? 'a VRM animation (.vrma)' : 'a plain glTF model';
        fail(`This is ${what}, not a VRM avatar: it has no VRM extension (VRM 0.x "VRM" or VRM 1.0 "VRMC_vrm").`);
    }
    // The BIN chunk must hold every buffer view the model refers to, or three.js fails half way
    const buffers = gltf.buffers || [];
    for (let i = 0; i < buffers.length; i++) {
        const b = buffers[i];
        if (b.uri && !/^data:/.test(b.uri)) fail(`The VRM refers to an external file (${b.uri}); only self-contained .vrm files can be shown.`);
        if (!b.uri && i === 0 && (!bin || bin.byteLength < b.byteLength)) {
            fail(`The binary data is incomplete: ${b.byteLength} bytes expected, ${bin ? bin.byteLength : 0} present. The file is truncated or damaged.`);
        }
    }
    for (const img of gltf.images || []) {
        if (img.uri && !/^data:/.test(img.uri)) fail(`The VRM refers to an external image (${img.uri}); only self-contained .vrm files can be shown.`);
    }

    const skins = gltf.skins || [];
    const joints = new Set();
    for (const s of skins) for (const j of s.joints || []) joints.add(j);
    let primitives = 0, morphTargets = 0;
    for (const m of gltf.meshes || []) {
        for (const p of m.primitives || []) {
            primitives++;
            morphTargets = Math.max(morphTargets, (p.targets || []).length);
        }
    }
    const springs = kind === 1
        ? (ext.VRMC_springBone && ext.VRMC_springBone.springs || []).reduce((n, s) => n + (s.joints || []).length, 0)
        : (ext.VRM.secondaryAnimation && ext.VRM.secondaryAnimation.boneGroups || []).reduce((n, g) => n + (g.bones || []).length, 0);
    return {
        kind,
        specVersion: kind === 1 ? (ext.VRMC_vrm.specVersion || '1.0') : (ext.VRM.specVersion || '0.0'),
        exporter: kind === 0 ? (ext.VRM.exporterVersion || '') : '',
        generator: (gltf.asset && gltf.asset.generator) || '',
        meta,
        thumbnail: thumbnailImage === null ? null : imageBytes(gltf, bin, thumbnailImage),
        extensions: used.slice(),
        counts: {
            meshes: (gltf.meshes || []).length,
            primitives,
            materials: (gltf.materials || []).length,
            textures: (gltf.textures || []).length,
            nodes: (gltf.nodes || []).length,
            bones: joints.size,
            maxMorphTargets: morphTargets,
            springJoints: springs,
        },
    };
}

// Metadata rows for the panel: [label, value] pairs, and the usage permissions
// as [label, value, verdict] where verdict is 'yes', 'no' or '' (neutral)
const V0_USER = { OnlyAuthor: 'Only the author', ExplicitlyLicensedPerson: 'Explicitly licensed people', Everyone: 'Everyone' };
const V1_AVATAR = { onlyAuthor: 'Only the author', onlySeparatelyLicensedPerson: 'Separately licensed people', everyone: 'Everyone' };
const V1_COMMERCIAL = { personalNonProfit: 'Personal, non-profit only', personalProfit: 'Personal, including profit', corporation: 'Allowed (also corporations)' };
const V1_CREDIT = { required: 'Required', unnecessary: 'Not required' };
const V1_MODIFICATION = { prohibited: 'Prohibited', allowModification: 'Allowed, no redistribution', allowModificationRedistribution: 'Allowed, with redistribution' };
const V0_LICENSE = {
    Redistribution_Prohibited: 'Redistribution prohibited', CC0: 'CC0', CC_BY: 'CC BY', CC_BY_NC: 'CC BY-NC',
    CC_BY_SA: 'CC BY-SA', CC_BY_NC_SA: 'CC BY-NC-SA', CC_BY_ND: 'CC BY-ND', CC_BY_NC_ND: 'CC BY-NC-ND', Other: 'Other',
};

function allowDisallow(v) {
    if (v === 'Allow') return ['Allowed', 'yes'];
    if (v === 'Disallow') return ['Not allowed', 'no'];
    return [v || '—', ''];
}

function bool(v) {
    if (v === true) return ['Allowed', 'yes'];
    if (v === false) return ['Not allowed', 'no'];
    return ['—', ''];
}

export function describeMeta(info) {
    const m = info.meta;
    if (info.kind === 0) {
        return {
            title: m.title || '',
            fields: [
                ['Version', m.version], ['Author', m.author], ['Contact', m.contactInformation], ['Reference', m.reference],
            ].filter(r => r[1]),
            permissions: [
                ['Avatar use', V0_USER[m.allowedUserName] || m.allowedUserName || '—', m.allowedUserName === 'Everyone' ? 'yes' : m.allowedUserName ? 'no' : ''],
                ['Violent acts', ...allowDisallow(m.violentUssageName)],
                ['Sexual acts', ...allowDisallow(m.sexualUssageName)],
                ['Commercial use', ...allowDisallow(m.commercialUssageName)],
                ['License', V0_LICENSE[m.licenseName] || m.licenseName || '—', m.licenseName === 'Redistribution_Prohibited' ? 'no' : ''],
            ],
            links: [['Other permissions', m.otherPermissionUrl], ['Other license', m.otherLicenseUrl]].filter(r => r[1]),
        };
    }
    const commercial = m.commercialUsage;
    return {
        title: m.name || '',
        fields: [
            ['Version', m.version], ['Authors', (m.authors || []).join(', ')], ['Copyright', m.copyrightInformation],
            ['Contact', m.contactInformation], ['References', (m.references || []).join(', ')],
            ['Third-party licenses', m.thirdPartyLicenses],
        ].filter(r => r[1]),
        permissions: [
            ['Avatar use', V1_AVATAR[m.avatarPermission] || m.avatarPermission || '—', m.avatarPermission === 'everyone' ? 'yes' : m.avatarPermission ? 'no' : ''],
            ['Violent acts', ...bool(m.allowExcessivelyViolentUsage)],
            ['Sexual acts', ...bool(m.allowExcessivelySexualUsage)],
            ['Commercial use', V1_COMMERCIAL[commercial] || commercial || '—', commercial === 'corporation' ? 'yes' : commercial === 'personalNonProfit' ? 'no' : ''],
            ['Political / religious', ...bool(m.allowPoliticalOrReligiousUsage)],
            ['Antisocial / hate', ...bool(m.allowAntisocialOrHateUsage)],
            ['Credit', V1_CREDIT[m.creditNotation] || m.creditNotation || '—', ''],
            ['Redistribution', ...bool(m.allowRedistribution)],
            ['Modification', V1_MODIFICATION[m.modification] || m.modification || '—', m.modification === 'prohibited' ? 'no' : m.modification ? 'yes' : ''],
        ],
        links: [['License', m.licenseUrl], ['Other license', m.otherLicenseUrl]].filter(r => r[1]),
    };
}
