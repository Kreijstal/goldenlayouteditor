# Plugin System

The editor supports plugins that can add panels, toolbar buttons, and integrate with the WebSocket server.

## Quick Start

Create a file in `src/`, call `registerPlugin()`, and add a `require()` in `src/main.js`.

```js
// src/my-plugin.js
const { registerPlugin } = require('./plugins');

class MyPanel {
    constructor(container, state) {
        container.element.innerHTML = '<h1>Hello from my plugin</h1>';
    }
}

registerPlugin({
    id: 'my-plugin',
    name: 'My Plugin',
    components: { myPanel: MyPanel },
    toolbarButtons: [
        { label: 'MP', title: 'Open My Panel' },
    ],
});
```

```js
// src/main.js — add this line alongside other plugin requires
require('./my-plugin');
```

Build with `npm run build` and the button appears in the file browser toolbar. Viewer implementations are loaded on demand; see [Lazy viewer loading](lazy-viewers.md).

## Plugin Interface

```js
registerPlugin({
    // Required
    id: string,         // Unique identifier (e.g. 'terminal', 'git-panel')
    name: string,       // Display name

    // Optional
    components: {
        componentType: ComponentClass,
        // ComponentClass receives (container, state) from GoldenLayout.
        // container.element is the DOM element to render into.
        // container.on('resize', ...) and container.on('destroy', ...) for lifecycle.
    },

    toolbarButtons: [
        {
            label: string,      // Button text (short, e.g. '>_', 'Git')
            title: string,      // Tooltip
            style: string,      // Optional inline CSS to append
            onclick: Function,  // Optional custom handler.
                                // If omitted, clicking opens the first component
                                // from this plugin as a new panel.
        },
    ],

    contextMenuItems: [
        {
            label: string,                              // Menu entry label
            canHandle: (fileName) => boolean,           // Optional filter
            action: (fileId, projectFiles) => void,     // Invoked on click
        },
    ],

    thumbnailRenderers: [
        {
            canHandle: (file) => boolean,
            // file: { id, name, type: 'file', viewType?, … }
            render: (file, container) => void | Promise<void>,
            // Populate `container` (a ~56x56 div) with the thumbnail.
            // Called lazily via IntersectionObserver when the card scrolls
            // into view in the file browser's icon (grid) mode. For workspace
            // files, build a URL with `ctx.currentWorkspacePath` +
            // `ctx.getRelativePath(file.id)` and fetch via
            // `/workspace-file?path=…`. If no renderer matches, the grid
            // falls back to the default emoji icon.
        },
    ],

    init(ctx): void,
    // Context is captured after GoldenLayout is initialized.
    // The real init hook runs when this plugin is first loaded.
    // ctx provides:
    //   ctx.wsClient              - WebSocket client
    //   ctx.goldenLayoutInstance  - The GoldenLayout instance
    //   ctx.projectFiles          - Current project files object (live)
    //   ctx.currentWorkspacePath  - Absolute path of open workspace, or null
    //   ctx.getRelativePath(id)   - Workspace-relative path for a file id
    //   ctx.markDirty(id)         - Mark a file as having unsaved changes
    //   ctx.openEditorTab(type, state, title, contentItemId) - Add a tab
    //   ctx.openPluginPanel(type, title, state) - Add a panel to main column
    //   ctx.createFile(name, content) - Create an in-memory file
    //   ctx.log                   - App logger
});
```

## Lifecycle

1. The build extracts lightweight registration metadata from the plugin.
2. Startup registers lazy constructors, menus and synchronous predicates.
3. GoldenLayout supplies the application context without loading the implementation.
4. Opening a panel, invoking an action or rendering a visible thumbnail loads the plugin chunk.
5. The real `init(ctx)` hook runs, then the requested operation executes.

## WebSocket Integration

Plugins that need server communication can use `ctx.wsClient`:

```js
init(ctx) {
    this.ws = ctx.wsClient;
},

// In your component:
// Request/response (with ID tracking):
const result = await this.ws.wsRequest({ type: 'myAction', data: '...' });

// Fire-and-forget:
this.ws.wsRawSend({ type: 'myEvent', data: '...' });

// Listen for server messages:
this.ws.addMessageListener((msg) => {
    if (msg.type === 'myResponse') { /* ... */ }
});

// Check connection:
if (this.ws.isConnected()) { /* ... */ }
```

Server-side handlers go in `ws-handler.js`:

```js
const messageHandlers = {
    // ... existing handlers ...
    myAction(ws, msg, previewFiles) {
        reply(ws, { type: 'myResult', data: '...', id: msg.id });
    },
};
```

## Example: Terminal Plugin

See `src/terminal.js` for a full example that:

- Loads dependencies from esm.sh at runtime (no bundling needed)
- Spawns a server-side PTY via WebSocket
- Falls back to a client-side JS REPL when offline
- Handles resize, cleanup on destroy
- Uses `addMessageListener` for streaming data

## Loading External Dependencies

Use dynamic `import()` from esm.sh to avoid bundling large dependencies:

```js
const [myLib] = await Promise.all([
    import('https://esm.sh/some-lib@1.0.0'),
]);
```

For CSS:
```js
const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = 'https://esm.sh/some-lib@1.0.0/dist/style.css';
document.head.appendChild(link);
```
