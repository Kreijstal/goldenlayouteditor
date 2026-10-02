// VRM avatar viewer (.vrm, VRM 0.x and 1.0), loaded on demand by
// src/vrm-plugin.js. vrm-glb.js checks the file and reads its metadata; the
// model is drawn with three.js and @pixiv/three-vrm (MToon materials, spring
// bones, expressions, look-at), loaded from esm.sh when the first avatar opens.
// Orbit camera framed on the avatar, idle / A-pose / T-pose, expression
// sliders, eyes (and in the idle pose the head) following the cursor, and a
// panel with the title, authors, usage permissions, thumbnail and counts.
// Read-only. Modelled on nextcloud-vrm-viewer (chimonakiko, MIT).
import { inspectVrm, describeMeta, VrmFileError } from './vrm-glb.js';

// three.js is the build src/model3d-plugin.js loads (THREE_VERSION there; keep
// them the same) so a page showing both shares one copy; three-vrm 3.x needs
// three >= 0.137 and esm.sh builds it against that same three (?deps=)
export const VERSIONS = { three: '0.164.1', threeVrm: '3.5.5' };
const T = VERSIONS.three;
export const URLS = {
    three: `https://esm.sh/three@${T}`,
    gltfLoader: `https://esm.sh/three@${T}/examples/jsm/loaders/GLTFLoader.js`,
    orbitControls: `https://esm.sh/three@${T}/examples/jsm/controls/OrbitControls.js`,
    threeVrm: `https://esm.sh/@pixiv/three-vrm@${VERSIONS.threeVrm}?deps=three@${T}`,
};

let _libsPromise = null;
function loadLibs() {
    if (!_libsPromise) {
        _libsPromise = Promise.all([import(URLS.three), import(URLS.gltfLoader), import(URLS.orbitControls), import(URLS.threeVrm)])
            .then(([THREE, gltf, orbit, vrm]) => ({ THREE, GLTFLoader: gltf.GLTFLoader, OrbitControls: orbit.OrbitControls, ...vrm }))
            .catch(err => { _libsPromise = null; throw err; });
    }
    return _libsPromise;
}

const CAMERA_FOV = 30;
const BACKGROUND = 0x2a2f38;
const MAX_DELTA = 1 / 30;           // longer frames are clamped so spring bones don't fly off
// Expressions the look-at drives itself (VRM 1.0 names; three-vrm maps VRM 0.x presets to them)
const LOOK_EXPRESSIONS = new Set(['lookUp', 'lookDown', 'lookLeft', 'lookRight']);
const PRESET_ORDER = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'neutral'];

function installStyles() {
    if (document.getElementById('vrm-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'vrm-viewer-style';
    style.textContent = `
.vrmv{height:100%;display:flex;flex-direction:column;background:#1e1e1e;color:#d4d4d4;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0}
.vrmv-bar{display:flex;align-items:center;gap:6px 10px;padding:4px 10px;background:#252526;border-bottom:1px solid #3c3c3c;flex-shrink:0;flex-wrap:wrap}
.vrmv-bar label{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;color:#bbb}
.vrmv-bar select,.vrmv-bar button{font:inherit;background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:2px 8px}
.vrmv-bar button{cursor:pointer}
.vrmv-bar button:hover{background:#3c3c3c}
.vrmv-bar .vrmv-spacer{flex:1}
.vrmv-main{flex:1;min-height:0;display:flex}
.vrmv.narrow .vrmv-main{flex-direction:column}
.vrmv-stage{flex:1;min-width:0;min-height:0;position:relative;background:#2a2f38}
.vrmv.narrow .vrmv-stage{min-height:55%}
.vrmv-stage canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}
.vrmv-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#aaa}
.vrmv-error{position:absolute;inset:0;padding:24px;color:#ffb4ab;background:#2a1d1d;white-space:pre-wrap;overflow:auto}
.vrmv-error b{display:block;color:#fff;margin-bottom:6px;font-size:14px}
.vrmv-side{width:300px;flex-shrink:0;border-left:1px solid #3c3c3c;overflow:auto;background:#1e1e1e}
.vrmv.narrow .vrmv-side{width:auto;border-left:none;border-top:1px solid #3c3c3c;flex:1}
.vrmv [hidden]{display:none!important}
.vrmv-sec{padding:8px 12px;border-bottom:1px solid #333}
.vrmv-sec h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8b949e;font-weight:600;display:flex;align-items:center;gap:6px}
.vrmv-sec h4 button{margin-left:auto;font:11px inherit;background:#333;color:#ccc;border:1px solid #555;border-radius:3px;padding:0 6px;cursor:pointer;text-transform:none;letter-spacing:0}
.vrmv-head{display:flex;gap:10px;align-items:flex-start}
.vrmv-thumb{width:96px;height:96px;flex-shrink:0;border-radius:4px;background:#2d2d2d;object-fit:cover}
.vrmv-title{font-size:15px;font-weight:600;color:#fff;word-break:break-word}
.vrmv-badge{display:inline-block;margin-top:4px;font-size:11px;padding:1px 6px;border-radius:3px;background:#0e639c;color:#fff}
.vrmv-sub{font-size:11px;color:#8b949e;margin-top:4px;word-break:break-word}
.vrmv-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 10px;font-size:12px;margin-top:6px}
.vrmv-kv span:nth-child(odd){color:#8b949e}
.vrmv-kv span:nth-child(even){word-break:break-word;color:#ddd}
.vrmv-kv a{color:#4fc1ff;word-break:break-all}
.vrmv-yes{color:#7ee787!important}
.vrmv-no{color:#ff7b72!important}
.vrmv-expr{display:grid;grid-template-columns:76px minmax(0,1fr) 32px;gap:2px 6px;align-items:center;font-size:12px}
.vrmv-expr span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#bbb}
.vrmv-expr input{width:100%;margin:0}
.vrmv-expr output{text-align:right;color:#8b949e;font-variant-numeric:tabular-nums}
.vrmv-note{font-size:11px;color:#8b949e;margin-top:4px}
`;
    document.head.appendChild(style);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function kv(rows) {
    const box = el('div', 'vrmv-kv');
    for (const [label, value, verdict] of rows) {
        box.appendChild(el('span', '', label));
        const v = el('span', verdict === 'yes' ? 'vrmv-yes' : verdict === 'no' ? 'vrmv-no' : '');
        if (/^https?:\/\//.test(String(value))) {
            const a = el('a', '', value);
            a.href = value;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            v.appendChild(a);
        } else {
            v.textContent = String(value);
        }
        box.appendChild(v);
    }
    return box;
}

function section(title) {
    const sec = el('div', 'vrmv-sec');
    const h = el('h4');
    h.appendChild(el('span', '', title));
    sec.appendChild(h);
    return sec;
}

class VrmViewer {
    constructor(host, opts) {
        installStyles();
        this.host = host;
        this.bytes = opts.bytes;
        this.name = opts.name || 'avatar.vrm';
        this.onStatus = opts.onStatus || (() => {});
        this.destroyed = false;
        this.pose = 'idle';
        this.lookMode = 'cursor';
        this.autoBlink = true;
        this.springs = true;
        this.cursor = null;          // normalized device coords while the pointer is over the canvas
        this.exprValues = new Map();
        this.blinkTimer = 2;
        this.time = 0;
        this.info = { kind: null };
        this._buildDom();
        this.ready = this._load();
    }

    _buildDom() {
        this.root = el('div', 'vrmv');
        this.root.innerHTML = `
<div class="vrmv-bar">
  <label>Pose <select class="vrmv-pose"><option value="idle">Idle</option><option value="a">A-pose</option><option value="t">T-pose</option></select></label>
  <label>Look at <select class="vrmv-look"><option value="cursor">Cursor</option><option value="camera">Camera</option><option value="off">Ahead</option></select></label>
  <label><input type="checkbox" class="vrmv-blink" checked> Auto blink</label>
  <label><input type="checkbox" class="vrmv-springs" checked> Spring bones</label>
  <span class="vrmv-spacer"></span>
  <button class="vrmv-face" title="Frame the face">Face</button>
  <button class="vrmv-reset" title="Frame the whole avatar">Reset view</button>
  <button class="vrmv-panel" title="Show or hide the details panel">Details</button>
</div>
<div class="vrmv-main"><div class="vrmv-stage"><div class="vrmv-msg">Reading the file…</div></div><div class="vrmv-side"></div></div>`;
        this.host.appendChild(this.root);
        const q = s => this.root.querySelector(s);
        this.stage = q('.vrmv-stage');
        this.side = q('.vrmv-side');
        this.bar = q('.vrmv-bar');
        q('.vrmv-pose').onchange = e => { this.pose = e.target.value; };
        q('.vrmv-look').onchange = e => { this.lookMode = e.target.value; };
        this.blinkBox = q('.vrmv-blink');
        this.blinkBox.onchange = e => {
            this.autoBlink = e.target.checked;
            if (!this.autoBlink) this._setExpression('blink', this.exprValues.get('blink') || 0);
        };
        q('.vrmv-springs').onchange = e => {
            this.springs = e.target.checked;
            if (this.springs && this.vrm && this.vrm.springBoneManager) this.vrm.springBoneManager.reset();
        };
        q('.vrmv-reset').onclick = () => this._frame();
        q('.vrmv-face').onclick = () => this._frameFace();
        q('.vrmv-panel').onclick = () => { this.side.hidden = !this.side.hidden; };
        this.sizeObserver = new ResizeObserver(() => {
            this.root.classList.toggle('narrow', this.root.clientWidth < 640);
            this._resize();
        });
        this.sizeObserver.observe(this.root);
    }

    _message(text) {
        this.stage.querySelectorAll('.vrmv-msg').forEach(m => m.remove());
        if (text) this.stage.appendChild(el('div', 'vrmv-msg', text));
    }

    _error(title, detail) {
        this._message('');
        this.stage.querySelectorAll('.vrmv-error').forEach(m => m.remove());
        const box = el('div', 'vrmv-error');
        box.appendChild(el('b', '', title));
        box.appendChild(document.createTextNode(detail));
        this.stage.appendChild(box);
        // No avatar to pose or frame: keep only the details toggle when there are details
        this.bar.querySelectorAll('label,button:not(.vrmv-panel)').forEach(c => { c.hidden = true; });
        if (this.side.hidden || !this.side.childElementCount) this.bar.hidden = true;
    }

    async _load() {
        // 1. The container and metadata: damaged and non-VRM files stop here
        let info;
        try {
            info = this.info = inspectVrm(this.bytes);
        } catch (err) {
            this.info = { kind: null, error: err.message };
            this.side.hidden = true;
            this._error('This file cannot be shown as a VRM avatar.', err.message);
            this.onStatus('Not a VRM file', true);
            if (!(err instanceof VrmFileError)) throw err;
            return;
        }
        this.meta = describeMeta(info);
        this._renderInfo();
        this.onStatus(`VRM ${info.kind === 1 ? '1.0' : '0.x'} · loading three.js…`);

        // 2. The libraries
        this._message('Loading three.js and three-vrm…');
        let libs;
        try {
            libs = this.libs = await loadLibs();
        } catch (err) {
            this._error('Could not load the 3D libraries.', `${err.message}\n\nthree.js ${VERSIONS.three} and @pixiv/three-vrm ${VERSIONS.threeVrm} come from esm.sh.`);
            this.onStatus('Library load failed', true);
            return;
        }
        if (this.destroyed) return;

        // 3. The model
        this._message('Building the avatar…');
        let gltf;
        try {
            const loader = new libs.GLTFLoader();
            loader.register(parser => new libs.VRMLoaderPlugin(parser));
            const b = this.bytes;
            const buffer = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer;
            gltf = await loader.parseAsync(buffer, '');
        } catch (err) {
            this._error('The VRM could not be read.', String(err && err.message || err));
            this.onStatus('Damaged VRM', true);
            return;
        }
        const vrm = gltf.userData.vrm;
        if (this.destroyed) { if (vrm) libs.VRMUtils.deepDispose(vrm.scene); return; }
        if (!vrm) {
            this._error('The VRM could not be read.', 'three-vrm found no VRM data in the file.');
            this.onStatus('Damaged VRM', true);
            return;
        }
        this.vrm = vrm;
        libs.VRMUtils.removeUnnecessaryVertices(gltf.scene);
        libs.VRMUtils.combineSkeletons(gltf.scene);
        libs.VRMUtils.rotateVRM0(vrm);     // VRM 0.x faces -Z; turn it to face the camera like 1.0
        vrm.scene.traverse(o => { o.frustumCulled = false; });

        // 4. The scene
        try {
            this._createScene();
        } catch (err) {
            this._error('WebGL is not available.', err.message);
            this.onStatus('No WebGL', true);
            return;
        }
        this._message('');
        this._applyPose();
        vrm.update(0);
        this._frame();
        this._renderRuntime();
        this._renderExpressions();
        this.onStatus(`VRM ${info.kind === 1 ? '1.0' : '0.x'} · ${this.meta.title || this.name} · read-only`);
        this.clock = new libs.THREE.Clock();
        this._tick();
    }

    _createScene() {
        const { THREE, OrbitControls } = this.libs;
        const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.setClearColor(BACKGROUND, 1);
        renderer.domElement.setAttribute('aria-label', 'VRM avatar, drag to rotate');
        this.stage.appendChild(renderer.domElement);
        const scene = this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.01, 1000);
        // A key light as in three-vrm's examples, a weak fill from behind and some ambient for the shade side
        const key = new THREE.DirectionalLight(0xffffff, Math.PI);
        key.position.set(1, 1.2, 1.4).normalize();
        scene.add(key);
        const rim = new THREE.DirectionalLight(0xffffff, 0.6);
        rim.position.set(-1, 1, -1.5).normalize();
        scene.add(rim);
        scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        scene.add(this.vrm.scene);
        this.lookTarget = new THREE.Object3D();
        scene.add(this.lookTarget);
        if (this.vrm.lookAt) this.vrm.lookAt.target = this.lookTarget;

        this.controls = new OrbitControls(this.camera, renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.screenSpacePanning = true;
        this.raycaster = new THREE.Raycaster();
        this._onPointerMove = e => {
            const r = renderer.domElement.getBoundingClientRect();
            this.cursor = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
        };
        this._onPointerLeave = () => { this.cursor = null; };
        renderer.domElement.addEventListener('pointermove', this._onPointerMove);
        renderer.domElement.addEventListener('pointerleave', this._onPointerLeave);
        this._resize();
    }

    _resize() {
        if (!this.renderer) return;
        const w = this.stage.clientWidth, h = this.stage.clientHeight;
        if (!w || !h) return;   // a hidden tab
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    // The whole avatar from the front (three-vrm turns every avatar to face +Z)
    _frame() {
        if (!this.vrm) return;
        const { THREE } = this.libs;
        this.vrm.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.vrm.scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const vfov = THREE.MathUtils.degToRad(CAMERA_FOV);
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(this.camera.aspect, 0.1));
        const dist = Math.max(size.y / (2 * Math.tan(vfov / 2)), size.x / (2 * Math.tan(hfov / 2)), 0.3) * 1.15 + size.z / 2;
        const extent = Math.max(size.x, size.y, size.z, 0.1);
        this.camera.near = extent / 500;
        this.camera.far = extent * 100;
        this.camera.position.set(center.x, center.y + size.y * 0.05, box.max.z + dist);
        this.camera.updateProjectionMatrix();
        this.controls.target.copy(center);
        this.controls.minDistance = extent * 0.05;
        this.controls.maxDistance = extent * 20;
        this.controls.update();
        if (!this.grid) {
            this.grid = new THREE.GridHelper(1, 20, 0x5a6372, 0x3b424e);
            this.scene.add(this.grid);
        }
        this.grid.scale.setScalar(Math.max(size.x, size.z, size.y * 0.5) * 3);
        this.grid.position.set(center.x, box.min.y, center.z);
    }

    _frameFace() {
        if (!this.vrm) return;
        const { THREE } = this.libs;
        const head = this.vrm.humanoid.getNormalizedBoneNode('head');
        if (!head) return this._frame();
        const p = head.getWorldPosition(new THREE.Vector3());
        p.y += 0.06;
        this.controls.target.copy(p);
        this.camera.position.set(p.x, p.y, p.z + 0.75);
        this.controls.update();
    }

    // Normalized-bone pose: T-pose is the VRM rest pose; A-pose and idle lower the arms
    _applyPose() {
        const vrm = this.vrm, h = vrm.humanoid;
        h.resetNormalizedPose();
        if (this.pose === 't') return;
        const { THREE } = this.libs;
        const v0 = vrm.meta.metaVersion === '0';
        // Normalized bones keep the file's axes: VRM 0.x has the left arm on -X, 1.0 on +X
        const dir = v0 ? 1 : -1;
        const t = this.time;
        const idle = this.pose === 'idle';
        const arm = THREE.MathUtils.degToRad(idle ? 65 + 2 * Math.sin(t * 1.4) : 50);
        const elbow = THREE.MathUtils.degToRad(idle ? 12 : 0);
        const e = new THREE.Euler();
        const set = (name, x, y, z) => {
            const node = h.getNormalizedBoneNode(name);
            if (node) node.quaternion.setFromEuler(e.set(x, y, z, 'YXZ'));
        };
        set('leftUpperArm', 0, 0, arm * dir);
        set('rightUpperArm', 0, 0, -arm * dir);
        set('leftLowerArm', 0, -elbow, 0);
        set('rightLowerArm', 0, elbow, 0);
        if (!idle) return;
        const breath = Math.sin(t * 1.7);
        set('spine', 0.015 * breath, 0, 0);
        set('chest', 0.02 * breath, 0, 0);
        set('hips', 0, 0.03 * Math.sin(t * 0.45), 0.01 * Math.sin(t * 0.9));
        // The head turns part of the way to what the eyes look at
        if (this.lookMode !== 'off') {
            const neck = h.getNormalizedBoneNode('neck') || h.getNormalizedBoneNode('head');
            if (neck) {
                const d = this.lookTarget.position.clone().sub(neck.getWorldPosition(new THREE.Vector3()));
                d.applyQuaternion(vrm.scene.getWorldQuaternion(new THREE.Quaternion()).invert());
                const front = v0 ? -1 : 1;     // VRM 0.x faces -Z in its own axes
                const yaw = Math.atan2(d.x * front, d.z * front);
                const pitch = Math.atan2(-d.y * front, Math.hypot(d.x, d.z));
                const clamp = (a, m) => Math.max(-m, Math.min(m, a));
                neck.quaternion.setFromEuler(e.set(clamp(pitch * 0.4, 0.35), clamp(yaw * 0.4, 0.6), 0, 'YXZ'));
            }
        }
    }

    _updateLookTarget() {
        const { THREE } = this.libs;
        const lookAt = this.vrm.lookAt;
        if (!lookAt) return;
        if (this.lookMode === 'off') {
            if (lookAt.target) { lookAt.target = null; lookAt.reset(); }
            return;
        }
        lookAt.target = this.lookTarget;
        if (this.lookMode === 'cursor' && this.cursor) {
            // The point under the cursor on the plane through the head facing the camera
            const head = this.vrm.humanoid.getNormalizedBoneNode('head');
            const headPos = head ? head.getWorldPosition(new THREE.Vector3()) : this.controls.target.clone();
            const normal = this.camera.getWorldDirection(new THREE.Vector3());
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, headPos);
            this.raycaster.setFromCamera(this.cursor, this.camera);
            if (this.raycaster.ray.intersectPlane(plane, this.lookTarget.position)) return;
        }
        this.lookTarget.position.copy(this.camera.position);
    }

    _updateBlink(delta) {
        if (!this.autoBlink || !this.vrm.expressionManager || !this.vrm.expressionManager.getExpression('blink')) return;
        this.blinkTimer -= delta;
        let v = 0;
        if (this.blinkTimer < 0) {
            const p = -this.blinkTimer / 0.16;     // a 0.16 s blink
            if (p >= 1) this.blinkTimer = 2 + Math.random() * 3;
            else v = Math.sin(p * Math.PI);
        }
        this.vrm.expressionManager.setValue('blink', v);
    }

    _tick() {
        if (this.destroyed) return;
        this.frameId = requestAnimationFrame(() => this._tick());
        const delta = Math.min(this.clock.getDelta(), MAX_DELTA);
        if (!this.stage.clientWidth) return;     // hidden tab
        this.time += delta;
        const vrm = this.vrm;
        this.controls.update();
        this._applyPose();
        this._updateLookTarget();
        this._updateBlink(delta);
        if (this.springs) {
            vrm.update(delta);
        } else {
            // VRM.update without the spring bones
            vrm.humanoid.update();
            if (vrm.lookAt) vrm.lookAt.update(delta);
            if (vrm.expressionManager) vrm.expressionManager.update();
            if (vrm.nodeConstraintManager) vrm.nodeConstraintManager.update();
            if (vrm.materials) vrm.materials.forEach(m => m.update && m.update(delta));
        }
        this.renderer.render(this.scene, this.camera);
    }

    _setExpression(name, value) {
        this.exprValues.set(name, value);
        if (this.vrm && this.vrm.expressionManager) this.vrm.expressionManager.setValue(name, value);
    }

    // --- Panel ---
    _renderInfo() {
        const info = this.info, meta = this.meta;
        this.side.textContent = '';
        const head = section('Avatar');
        const row = el('div', 'vrmv-head');
        if (info.thumbnail) {
            const img = el('img', 'vrmv-thumb');
            this.thumbUrl = URL.createObjectURL(new Blob([info.thumbnail.bytes], { type: info.thumbnail.mimeType }));
            img.src = this.thumbUrl;
            img.alt = 'Thumbnail';
            row.appendChild(img);
        }
        const text = el('div');
        text.appendChild(el('div', 'vrmv-title', meta.title || this.name));
        text.appendChild(el('span', 'vrmv-badge', info.kind === 1 ? `VRM 1.0 (spec ${info.specVersion})` : `VRM 0.x (spec ${info.specVersion})`));
        const made = [info.exporter, info.generator].filter((s, i, a) => s && a.indexOf(s) === i).join(' · ');
        if (made) text.appendChild(el('div', 'vrmv-sub', made));
        row.appendChild(text);
        head.appendChild(row);
        if (meta.fields.length) head.appendChild(kv(meta.fields));
        this.side.appendChild(head);

        const perm = section(info.kind === 1 ? 'License & usage (VRMC_vrm.meta)' : 'License & usage (VRM.meta)');
        perm.appendChild(kv([...meta.permissions, ...meta.links]));
        this.side.appendChild(perm);

        const c = info.counts;
        this.countsSec = section('Model');
        this.countsSec.appendChild(kv([
            ['Meshes', `${c.meshes} (${c.primitives} primitives)`], ['Materials', c.materials], ['Textures', c.textures],
            ['Nodes', c.nodes], ['Skin bones', c.bones], ['Spring joints', c.springJoints], ['Blend shapes', c.maxMorphTargets],
            ['File size', `${(this.bytes.byteLength / 1048576).toFixed(2)} MB`],
        ]));
        this.side.appendChild(this.countsSec);
    }

    // Counts that need the loaded model
    _renderRuntime() {
        const vrm = this.vrm;
        let tris = 0, mtoon = 0;
        const mats = new Set();
        vrm.scene.traverse(o => {
            if (!o.isMesh) return;
            const g = o.geometry;
            tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
            for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
        });
        for (const m of mats) if (m.isMToonMaterial && !m.isOutline) mtoon++;
        const humanBones = this.libs.VRMHumanBoneName ? Object.values(this.libs.VRMHumanBoneName).filter(n => vrm.humanoid.getRawBoneNode(n)).length : 0;
        const exprs = vrm.expressionManager ? vrm.expressionManager.expressions.length : 0;
        this.countsSec.appendChild(kv([
            ['Triangles', Math.round(tris).toLocaleString()], ['MToon materials', mtoon], ['Humanoid bones', humanBones],
            ['Expressions', exprs], ['Look-at', vrm.lookAt ? (vrm.lookAt.applier && vrm.lookAt.applier.constructor.type === 'expression' ? 'expressions' : 'eye bones') : 'none'],
            ['Constraints', vrm.nodeConstraintManager ? vrm.nodeConstraintManager.constraints.size : 0],
        ]));
    }

    _renderExpressions() {
        const mgr = this.vrm.expressionManager;
        if (!mgr) return;
        const names = mgr.expressions.map(x => x.expressionName).filter(n => !LOOK_EXPRESSIONS.has(n));
        const rank = n => { const i = PRESET_ORDER.indexOf(n); return i < 0 ? PRESET_ORDER.length : i; };
        names.sort((a, b) => rank(a) - rank(b));
        const sec = section('Expressions');
        const reset = el('button', '', 'Reset');
        sec.querySelector('h4').appendChild(reset);
        const grid = el('div', 'vrmv-expr');
        const inputs = [];
        for (const name of names) {
            const label = el('span', '', name);
            label.title = name;
            const input = el('input');
            input.type = 'range';
            input.min = '0';
            input.max = '1';
            input.step = '0.01';
            input.value = '0';
            input.dataset.expression = name;
            const out = el('output', '', '0');
            input.oninput = () => {
                const v = Number(input.value);
                out.textContent = v.toFixed(2);
                if (name === 'blink' && this.autoBlink) { this.autoBlink = false; this.blinkBox.checked = false; }
                this._setExpression(name, v);
            };
            inputs.push(input);
            grid.append(label, input, out);
        }
        reset.onclick = () => { for (const i of inputs) { i.value = '0'; i.oninput(); } };
        sec.appendChild(grid);
        sec.appendChild(el('div', 'vrmv-note', names.length ? 'lookUp/Down/Left/Right are driven by the look-at.' : 'This avatar has no expressions.'));
        this.side.appendChild(sec);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.frameId) cancelAnimationFrame(this.frameId);
        this.sizeObserver.disconnect();
        if (this.renderer) {
            this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
            this.renderer.domElement.removeEventListener('pointerleave', this._onPointerLeave);
        }
        if (this.controls) this.controls.dispose();
        if (this.vrm) this.libs.VRMUtils.deepDispose(this.vrm.scene);
        if (this.grid) { this.grid.geometry.dispose(); this.grid.material.dispose(); }
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.forceContextLoss();
            this.renderer.domElement.remove();
        }
        if (this.thumbUrl) URL.revokeObjectURL(this.thumbUrl);
        this.vrm = this.scene = this.renderer = null;
        this.root.remove();
    }
}

export function mountVrmViewer(host, opts) {
    return new VrmViewer(host, opts);
}
