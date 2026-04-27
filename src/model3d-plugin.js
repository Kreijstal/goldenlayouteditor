// --- 3D Model Plugin ---
// Lazy-loads Three.js and loaders when a 3D model is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');

const log = createLogger('Model3D');
const THREE_VERSION = '0.164.1';
const THREE_URL = `https://esm.sh/three@${THREE_VERSION}`;
const GLTF_LOADER_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/GLTFLoader.js`;
const STL_LOADER_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/STLLoader.js`;
const OBJ_LOADER_URL = `https://esm.sh/three@${THREE_VERSION}/examples/jsm/loaders/OBJLoader.js`;
const MODEL_RE = /\.(glb|gltf|stl|obj)$/i;

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
.model3d-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.model3d-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2b2d31;border-bottom:1px solid #3c4043;white-space:nowrap;overflow:auto}
.model3d-toolbar button{background:#3c4043;color:#e8eaed;border:1px solid #5f6368;border-radius:4px;padding:4px 9px;font:inherit;cursor:pointer}
.model3d-toolbar button:hover{background:#4a4d52}
.model3d-title{font-weight:600;min-width:120px;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.model3d-status{margin-left:auto;color:#bdc1c6;font-size:12px}
.model3d-main{display:grid;grid-template-columns:1fr 300px;min-height:0}
.model3d-stage{position:relative;min-width:0;min-height:0;background:#111317;overflow:hidden}
.model3d-stage canvas{display:block;width:100%;height:100%}
.model3d-side{min-height:0;border-left:1px solid #3c4043;background:#202124;display:grid;grid-template-rows:auto 1fr}
.model3d-side h3{font-size:12px;letter-spacing:0;text-transform:uppercase;color:#bdc1c6;margin:0;padding:8px 10px;border-bottom:1px solid #3c4043}
.model3d-stats{overflow:auto;padding:10px}
.model3d-stat{display:grid;grid-template-columns:1fr auto;gap:8px;padding:6px 0;border-bottom:1px solid #303134}
.model3d-stat span:first-child{color:#bdc1c6}
.model3d-message,.model3d-error{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px;color:#bdc1c6}
.model3d-error{color:#fecaca}
@media (max-width:800px){.model3d-main{grid-template-columns:1fr}.model3d-side{display:none}}
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
        this.fileInput.accept = '.glb,.gltf,.stl,.obj';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', e => {
            if (e.target.files && e.target.files[0]) this._loadFileObject(e.target.files[0]);
        });
        this.toolbar.appendChild(this.fileInput);
        this.toolbar.appendChild(makeButton('Open', 'Open local 3D model', () => this.fileInput.click()));
        this.toolbar.appendChild(makeButton('Reset', 'Reset camera', () => this._frameModel()));
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'model3d-title';
        this.titleEl.textContent = this.fileName;
        this.toolbar.appendChild(this.titleEl);
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'model3d-status';
        this.toolbar.appendChild(this.statusEl);

        this.main = document.createElement('div');
        this.main.className = 'model3d-main';
        this.stage = document.createElement('div');
        this.stage.className = 'model3d-stage';
        this.side = document.createElement('div');
        this.side.className = 'model3d-side';
        this.side.innerHTML = '<h3>Model Stats</h3><div class="model3d-stats"></div>';
        this.statsEl = this.side.querySelector('.model3d-stats');
        this.main.appendChild(this.stage);
        this.main.appendChild(this.side);
        this.shell.appendChild(this.toolbar);
        this.shell.appendChild(this.main);
        this.root.appendChild(this.shell);
        this._showMessage('Open a GLB, glTF, STL, or OBJ model to view it.');

        this.stage.addEventListener('mousedown', e => this._startDrag(e));
        this.stage.addEventListener('wheel', e => this._onWheel(e), { passive: false });
        this._moveHandler = e => this._moveDrag(e);
        this._upHandler = () => this._endDrag();
        window.addEventListener('mousemove', this._moveHandler);
        window.addEventListener('mouseup', this._upHandler);
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
            const url = '/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + relPath);
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            await this._loadBuffer(await resp.arrayBuffer(), this.fileData.name, '');
        } catch (err) {
            this._showError(err.message);
        }
    }

    async _loadFileObject(file) {
        await this._loadBuffer(await file.arrayBuffer(), file.name, '');
    }

    async _loadBuffer(buffer, name, basePath) {
        this.fileName = name || this.fileName;
        this.titleEl.textContent = this.fileName;
        this.statusEl.textContent = 'Loading Three.js...';
        try {
            const libs = await ensureThreeLoaded();
            this.THREE = libs.THREE;
            this._ensureScene();
            this.statusEl.textContent = 'Parsing model...';
            const ext = (this.fileName.split('.').pop() || '').toLowerCase();
            let object;
            if (ext === 'glb' || ext === 'gltf') {
                object = await parseGltf(new libs.GLTFLoader(), buffer, basePath, ext === 'glb');
            } else if (ext === 'stl') {
                const geometry = new libs.STLLoader().parse(buffer);
                const material = new this.THREE.MeshStandardMaterial({ color: 0x9ad0ff, roughness: 0.55, metalness: 0.05 });
                object = new this.THREE.Mesh(geometry, material);
            } else if (ext === 'obj') {
                object = new libs.OBJLoader().parse(new TextDecoder().decode(buffer));
            } else {
                throw new Error(`Unsupported model format: ${ext}`);
            }
            this._setModel(object);
        } catch (err) {
            log.error('Failed to open 3D model:', err);
            this._showError(`Failed to open 3D model: ${err.message}`);
        }
    }

    _ensureScene() {
        const THREE = this.THREE;
        if (this.scene) return;
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

    _setModel(object) {
        if (this.model) {
            this.scene.remove(this.model);
            disposeObject(this.THREE, this.model);
        }
        this.model = object;
        this.scene.add(object);
        this._frameModel();
        this._renderStats(collectStats(object));
    }

    _frameModel() {
        if (!this.THREE || !this.model) return;
        const box = new this.THREE.Box3().setFromObject(this.model);
        const size = box.getSize(new this.THREE.Vector3());
        const center = box.getCenter(new this.THREE.Vector3());
        this.model.position.sub(center);
        const radius = Math.max(size.x, size.y, size.z, 1);
        this.distance = radius * 1.8;
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
        window.removeEventListener('mousemove', this._moveHandler);
        window.removeEventListener('mouseup', this._upHandler);
        if (this.animationId) cancelAnimationFrame(this.animationId);
        if (this.model && this.THREE) disposeObject(this.THREE, this.model);
        if (this.renderer) this.renderer.dispose();
    }
}

registerPlugin({
    id: 'model3d',
    name: '3D Model',
    components: {
        model3dViewer: Model3dComponent,
    },
    toolbarButtons: [
        { label: '3D', title: 'Open 3D Model Viewer' },
    ],
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
