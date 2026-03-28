// --- Plugin Registry ---
// Plugins can register GoldenLayout components, toolbar buttons, and panel openers.
//
// Plugin interface:
// {
//   id: string,                    // unique plugin ID
//   name: string,                  // display name
//   components: {                  // GoldenLayout components to register
//     'componentType': ComponentClass  // class with (container, state) constructor
//   },
//   toolbarButtons: [              // buttons to add to the file browser toolbar
//     { label, title, onclick() }
//   ],
//   init(context): void,           // called after layout is loaded, context has app references
// }

const { createLogger } = require('./debug');
const log = createLogger('Plugins');

const _plugins = [];

function registerPlugin(plugin) {
    if (!plugin.id) throw new Error('Plugin must have an id');
    if (_plugins.some(p => p.id === plugin.id)) {
        log.warn('Plugin already registered:', plugin.id);
        return;
    }
    _plugins.push(plugin);
    log.log('Plugin registered:', plugin.id);
}

function getPlugins() {
    return _plugins;
}

module.exports = { registerPlugin, getPlugins };
