# Client API

The editor exposes a programmatic API at `window.app` so scripts, the DevTools
console, or plugins can drive the editor without reaching into internal state.

The API is available after the main layout finishes initializing — look for the
log line `Init: Client API exposed at window.app (v1.0).`.

```js
window.app.version                 // "1.0"
window.app.files                   // file operations
window.app.tabs                    // tab / editor pane operations
window.app.workspace               // workspace operations
window.app.layout                  // GoldenLayout operations
```

All methods are synchronous unless marked `async`. Methods that take a
`fileIdOrPath` argument accept either the internal `id` (`item-…`) or a
workspace-relative path (e.g. `"src/main.js"`).

A `FileInfo` object has the shape:

```ts
{
  id: string;           // internal id
  name: string;
  path: string | null;  // workspace-relative path, null for in-memory files
  type: string;         // node type, usually "file"
  viewType: string | null;  // set for media/binary files ("pdf", "png", "binary", …)
  dirty: boolean;       // has unsaved changes
}
```

A `TabInfo` object has the shape:

```ts
{
  tabId: string | null;     // contentItemId assigned at creation
  componentType: string;    // "editor" | "hexEditor" | "preview" | plugin component
  title: string;
  fileId: string | null;    // file backing this tab, if any
  stackId: string | null;   // parent stack id
  active: boolean;          // currently focused tab in its stack
}
```

---

## `app.files`

### `list(): FileInfo[]`
Returns every file in the project tree.

### `get(fileIdOrPath): FileInfo | null`
Looks up a file. Returns `null` if not found.

### `getContent(fileIdOrPath): string | null`
Returns the in-memory content of the file. For files not yet loaded, returns
an empty string. Returns `null` if the file is not found.

### `setContent(fileIdOrPath, content): boolean`
Replaces the file's in-memory content and marks it dirty. If an editor tab is
open for the file, its Ace editor is updated in place (cursor position is
preserved as best-effort).

### `create(name, content?, parentPath?): string | null`
Creates a new in-memory file with the given `name`. `parentPath` is a
workspace-relative directory path; defaults to the workspace root. Returns the
new file's id, or `null` if creation failed (missing name, missing parent,
name collision).

In `auto` persistence mode, the file is flushed to disk on the usual cadence;
in `draft` mode it stays dirty until `save()` or `saveAll()` is called.

### `rename(fileIdOrPath, newName): Promise<boolean>`
Renames the file. For workspace files, also renames on disk via the
`renameFile` WebSocket message. Updates any open tab titles. Returns `false`
on failure (not found, collision, server rejected).

### `delete(fileIdOrPath): boolean`
Closes any open tabs for the file, removes it from the project tree, and
clears its dirty state. **This does not delete the file from disk.** Use the
right-click context menu's Delete for disk deletion (which also removes the
file server-side).

### `save(fileIdOrPath): Promise<boolean>`
Flushes a single dirty file to disk. Returns `false` if there is no workspace
or the file is not found.

### `saveAll(): Promise<void>`
Flushes every dirty file to disk.

---

## `app.tabs`

### `open(fileIdOrPath, opts?): TabInfo | null`
Opens (or focuses, if already open) a tab for the given file.

```js
app.tabs.open('src/main.js');                  // normal editor tab
app.tabs.open('src/main.js', { mode: 'hex' }); // hex editor tab
```

### `close(fileIdOrTabId): boolean`
Closes a tab. You can pass a `tabId` (as returned from `open()` or `list()`)
or a file id/path — the first tab found whose `fileId` matches is closed.

### `focus(fileIdOrTabId): boolean`
Activates a tab within its stack.

### `list(): TabInfo[]`
Every component tab currently in the layout (editors, hex editors, previews,
plugin panels, terminals).

### `getActive(): TabInfo | null`
Returns the first stack's active tab, or `null` if no component is active.

### `move(fileIdOrTabId, target?): boolean`
Moves a tab to a different stack. `target` is an object:

```js
app.tabs.move('src/main.js', { stackId: 'editorStack' });
```

If no `stackId` is supplied (or the stack doesn't exist), the tab is moved to
the main editor stack (created if needed). **Note:** GoldenLayout v2 does not
expose a clean reorder-within-stack API, so `target.index` is currently
ignored — moved tabs land at the end of the destination stack.

### `maximize(fileIdOrTabId?): boolean`
Maximizes the tab's stack. With no argument, maximizes whichever stack
currently holds the active tab. Does nothing if the stack is already
maximized. Call `unmaximize()` to restore.

### `unmaximize(): boolean`
Restores whichever stack is currently maximized. Returns `false` if nothing is
maximized.

---

## `app.workspace`

### `path: string | null` (getter)
The absolute path of the currently open workspace, or `null` for in-memory
mode.

### `open(path): Promise<boolean>` (async)
Opens a workspace at the given absolute path. Equivalent to choosing
**File → Open Workspace…** in the UI. Throws if the WebSocket is not
connected or the server rejects the path.

---

## `app.layout`

### `save(): object | null`
Returns the serialized GoldenLayout config for the current layout. Useful for
persistence.

### `load(config): boolean`
Replaces the current layout with `config`. The config must be a valid
GoldenLayout `LayoutConfig`. Editor tabs that reference missing files are
silently dropped on reload (see `rewriteLayoutConfig` in `src/main.js`).

### `reset(): boolean`
Loads the default layout, discarding any custom arrangement.

### `stacks(): { id, itemCount, maximized }[]`
Lists every stack in the current layout. Useful for discovering `stackId`
values to pass to `tabs.move()`.

### `addPanel(componentType, state?, title?, contentItemId?): TabInfo | null`
Adds a component panel as a new tab in the main editor stack. Use this to
open plugin panels programmatically:

```js
app.layout.addPanel('terminal', {}, 'Terminal');
app.layout.addPanel('pandocConvert', { fileId: someId }, 'Pandoc');
```

---

## Examples

Open a file and replace its content:
```js
await app.tabs.open('README.md');
app.files.setContent('README.md', '# Hello\n');
await app.files.save('README.md');
```

Open a binary in the hex editor:
```js
app.tabs.open('assets/icon.png', { mode: 'hex' });
```

Move a file's tab into the same stack as the preview:
```js
const previewStack = app.layout.stacks().find(s => s.id !== 'editorStack');
app.tabs.move('index.html', { stackId: previewStack.id });
```

Maximize the editor and then restore:
```js
app.tabs.maximize();
// … later
app.tabs.unmaximize();
```

Rename a file and close every tab for it:
```js
await app.files.rename('old-name.js', 'new-name.js');
```

List tabs and close every hex editor:
```js
for (const t of app.tabs.list()) {
    if (t.componentType === 'hexEditor') app.tabs.close(t.tabId);
}
```

Script-create a file and open it:
```js
const id = app.files.create('scratch.ts', 'export const x = 1;\n');
app.tabs.open(id);
```

---

## Notes and limitations

- `tabs.move(id, { index })` is not implemented (GoldenLayout v2 has no stable
  reorder API for items within a stack).
- `files.delete()` only removes the file from the client tree; it does not
  delete from disk. Use the right-click **Delete** context menu action for
  disk deletion.
- `files.rename()` requires a WebSocket connection for workspace files. For
  in-memory files the rename is purely client-side.
- The legacy `window.__$goldenviewerEditor` debug interface is still exposed
  for backward compatibility but new code should use `window.app`.
- Plugins receive a similar context object via `plugin.init(ctx)` that
  includes `openEditorTab`, `openPluginPanel`, `getRelativePath`, `markDirty`,
  and the `projectFiles` getter. See `docs/plugins.md`.

---

## Driving the editor from outside the browser (WebSocket RPC)

`window.app` only exists inside the browser tab running the editor. To let an
external agent (Claude Code, an MCP server, a test script, another tab, etc.)
drive the editor, the WebSocket exposes a relay: the agent sends a request,
the server forwards it to every other connected WS client, the browser tab's
dispatcher resolves it against `window.app` and replies, and the server
routes the reply back to the original requester by `id`.

**Endpoint:** `ws://HOST:PORT/ws`

### `clientAction` — safe method dispatch on `window.app`

Request (agent → server → browser):

```json
{
  "type": "clientAction",
  "id": 42,
  "method": "tabs.open",
  "args": ["README.md", { "mode": "hex" }]
}
```

Response (browser → server → agent):

```json
{ "type": "clientActionResult", "id": 42, "result": { "tabId": "hex-item-…", "componentType": "hexEditor", "title": "README.md [hex]", "fileId": "item-…", "stackId": "editorStack", "active": true } }
```

- `method` is a dot-path (`"files.getContent"`, `"layout.stacks"`, …) resolved
  against `window.app`.
- `args` is an array; if omitted it's treated as `[]`.
- Return values are JSON-cleaned before sending: functions, DOM nodes,
  `Map`s and `Set`s are converted to string markers or plain data, so results
  are always serializable.
- Async methods (e.g. `files.save`, `files.rename`, `workspace.open`) are
  awaited before replying.

Error response:

```json
{ "type": "clientActionResult", "id": 42, "error": "Unknown method: tabs.foo" }
```

### `clientEval` — arbitrary JS escape hatch

For cases where `window.app` doesn't cover a need, send raw JavaScript. The
code is wrapped in `(async () => { … })()` so you can use `await` and bare
`return`:

```json
{
  "type": "clientEval",
  "id": 43,
  "code": "return document.title;"
}
```

```json
{ "type": "clientEvalResult", "id": 43, "result": "HTML Editor & Preview" }
```

A `const app = window.app` alias is passed in as the first argument to the
wrapper, so `app.tabs.list()` works inside `code` without `window.`. Errors
include both `error` (message) and `stack`.

```json
{
  "type": "clientEval",
  "id": 44,
  "code": "const tabs = app.tabs.list(); return tabs.filter(t => t.componentType === 'hexEditor').map(t => t.title);"
}
```

### Relay semantics

- Every request is broadcast to all other connected WebSocket clients. In
  practice there's typically one browser tab, so the first (and only) reply
  wins.
- If no other client is connected, the server replies immediately with
  `error: "No other clients connected to handle RPC"`.
- If a browser doesn't reply within 30 seconds, the server replies with
  `error: "RPC timeout — no client responded"`.
- If the originating client disconnects before a reply arrives, the pending
  request is dropped silently.
- Multiple browser tabs will both respond. The server forwards only the
  first reply; subsequent replies for the same `id` are discarded. If you
  have multi-tab setups, open only one and close the others.

### CLI helper: `scripts/rpc.js`

A tiny CLI wrapper ships with the repo so agents can shell out without
writing any WebSocket code:

```bash
node scripts/rpc.js call workspace.path
node scripts/rpc.js call tabs.open '"README.md"'
node scripts/rpc.js call tabs.open '"assets/icon.png"' '{"mode":"hex"}'
node scripts/rpc.js eval 'return app.tabs.list().map(t => t.title);'
node scripts/rpc.js list                 # shortcut for tabs.list
```

Each positional arg to `call` is a JSON literal — use `'"…"'` for strings,
`42` for numbers, `'{"k":"v"}'` for objects. Override the endpoint with
`RPC_URL=ws://host:port/ws`. Exits 0 on success and prints the result; exits
non-zero and prints the error on failure.

### Minimal Node agent example

```js
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000/ws');
let nextId = 1;
const pending = new Map();

function call(type, payload) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type, id, ...payload }));
    });
}

ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'clientActionResult' || msg.type === 'clientEvalResult') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
    }
});

ws.on('open', async () => {
    console.log(await call('clientAction', { method: 'workspace.path' }));
    console.log(await call('clientAction', { method: 'files.list' }));
    await call('clientAction', { method: 'tabs.open', args: ['README.md'] });
    console.log(await call('clientEval', { code: 'return app.tabs.list().map(t => t.title);' }));
});
```

### Security

There is **no authentication** on `/ws`. Anyone who can reach the endpoint
can drive the editor and execute arbitrary JavaScript in the browser tab via
`clientEval` (and arbitrary shell via the existing `termSpawn` handler).
This is fine for a local dev tool but **do not expose the port to a
network**. If you need to, put the server behind an auth proxy or bind it to
`127.0.0.1` only.
