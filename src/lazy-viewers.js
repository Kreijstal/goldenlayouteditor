// One cached request per viewer module. The build supplies URLs with content hashes.
const { registerPlugin, getPlugins } = require('./plugins');
const requests = new Map();
const modules = new Map();
let manifest;
const assetBase = typeof document !== 'undefined' && document.currentScript
    ? new URL('.', document.currentScript.src) : null;
function resolveAssetUrl(path) {
    if (!assetBase) throw new Error('Application asset base is unavailable.');
    return new URL(path, assetBase).href;
}
function setManifest(value) { manifest = value; }
function getLoadedModule(name) { return modules.get(name); }
function defineModule(name, exports) { modules.set(name, exports); }
function loadModule(name) {
    if (modules.has(name)) return Promise.resolve(modules.get(name));
    if (!requests.has(name)) {
        requests.set(name, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            if (!manifest?.[name]) { reject(new Error('Unknown viewer module: ' + name)); return; }
            script.src = new URL(manifest[name], assetBase || document.baseURI).href;
            script.onload = () => {
                script.remove();
                if (!modules.has(name)) { reject(new Error('Viewer did not register: ' + name)); return; }
                resolve(modules.get(name));
            };
            script.onerror = () => { script.remove(); reject(new Error('Failed to load viewer: ' + name)); };
            document.head.appendChild(script);
        }));
    }
    return requests.get(name);
}
function registerLazyPlugin(metadata, moduleName) {
    let implementation;
    let context;
    const load = async () => {
        await loadModule(moduleName);
        if (!implementation) throw new Error('Plugin did not register: ' + metadata.id);
        return implementation;
    };
    // Keep predicates synchronous; defer all effectful hooks, including thumbnails.
    function wrap(value, path = []) {
        if (Array.isArray(value)) return value.map((v, i) => wrap(v, [...path, i]));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v, [...path, k])]));
        if (typeof value === 'function' && ['render', 'action', 'onclick', 'content'].includes(path.at(-1))) {
            return async (...args) => {
                let parent = await load();
                for (const key of path.slice(0, -1)) parent = parent[key];
                return parent[path.at(-1)](...args);
            };
        }
        return value;
    }
    const plugin = wrap(metadata);
    plugin.acceptImplementation = real => {
        if (implementation) return;
        implementation = real;
        if (context && real.init) real.init(context);
    };
    plugin.init = ctx => { context = ctx; if (implementation?.init) implementation.init(ctx); };
    if (metadata.components) {
        plugin.components = Object.fromEntries(Object.keys(metadata.components).map(type => [type, class LazyViewer {
            constructor(container, state) {
                let destroyed = false;
                let instance;
                container.on('destroy', () => { destroyed = true; });
                const host = container.element || container.getElement();
                const message = document.createElement('div');
                message.textContent = 'Loading ' + metadata.name + '…';
                message.style.cssText = 'padding:16px;color:#aaa;';
                host.appendChild(message);
                this.ready = load().then(real => {
                    if (destroyed) return;
                    message.remove();
                    instance = new real.components[type](container, state);
                    return instance.ready;
                });
                // This is the UI error boundary; callers can still await/reject ready.
                this.ready.catch(error => {
                    if (!destroyed) { message.textContent = error.message; message.style.color = '#f88'; host.appendChild(message); }
                });
                return new Proxy(this, { get(target, key) {
                    if (key in target) return target[key];
                    const value = instance?.[key];
                    return typeof value === 'function' ? value.bind(instance) : value;
                } });
            }
        }]));
    }
    registerPlugin(plugin);
}
module.exports = { resolveAssetUrl, setManifest, defineModule, loadModule, getLoadedModule, registerLazyPlugin };
