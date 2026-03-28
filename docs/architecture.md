# Architecture

## Overview

A browser-based code editor built on GoldenLayout (panel management), Ace Editor (code editing), and an optional Express/WebSocket server for enhanced features.

```
┌─────────────────────────────────────────────────────┐
│ Browser                                             │
│  ┌──────────┬───────────────────────────────────┐   │
│  │ Project  │  Editor Tabs (Ace)                │   │
│  │ Files    │  ┌─────────┬─────────┬─────────┐  │   │
│  │          │  │ file.html│ style.css│ app.js  │  │   │
│  │ Tree/Grid│  └─────────┴─────────┴─────────┘  │   │
│  │ browser  │                                    │   │
│  │          ├────────────────────────────────────┤   │
│  │          │  Preview (iframe/custom render)    │   │
│  │          ├────────────────────────────────────┤   │
│  │          │  Terminal (xterm.js plugin)         │   │
│  └──────────┴────────────────────────────────────┘   │
│                                                      │
│  Service Worker (offline preview) ←→ esm.sh (deps)  │
└──────────────────┬───────────────────────────────────┘
                   │ WebSocket (optional)
┌──────────────────┴───────────────────────────────────┐
│ Server (Express + WS)                                │
│  - Static file serving                               │
│  - In-memory preview files                           │
│  - Workspace file system access                      │
│  - PTY shell sessions                                │
│  - Client log forwarding                             │
└──────────────────────────────────────────────────────┘
```

## Offline-First Design

The app works without a server:

- **Preview**: Service Worker intercepts `/preview/` requests, serves from in-memory file map
- **Editing**: Ace Editor runs entirely client-side
- **Typst**: WASM compiler loaded from esm.sh/jsdelivr
- **Terminal**: Falls back to JS REPL

When a server is available (WebSocket connects):

- Preview files stored server-side, served via `/preview-output/`
- File system browsing and workspace loading
- PTY terminal sessions
- Debug log forwarding to server console

## Key Files

### Client (`src/`)

| File | Purpose |
|------|---------|
| `main.js` | App entry point. GoldenLayout setup, EditorComponent, PreviewComponent, ProjectFilesComponent, session persistence |
| `ws-client.js` | WebSocket client. Auto-connects, request/response with ID tracking, workspace selector dialog, message listeners |
| `debug.js` | Gated logging. Enabled via `?debug` URL param, localStorage, or server config. Forwards logs to server via WS |
| `plugins.js` | Plugin registry. Plugins register components, toolbar buttons, init hooks |
| `terminal.js` | Terminal plugin. xterm.js from esm.sh, server PTY or client JS REPL |
| `handlers/index.js` | Handler registry for file type preview/rendering |
| `handlers/web-handler.js` | Preview for HTML, CSS, JS, JSON, Markdown (with KaTeX) |
| `handlers/typst-handler.js` | Typst WASM compilation and SVG rendering |

### Server

| File | Purpose |
|------|---------|
| `server.js` | Express HTTP server. Static files, preview-output route, workspace-file route, Ace worker proxying |
| `ws-handler.js` | WebSocket message handlers. File updates, directory listing, workspace loading, file saving, PTY management |

### Other

| File | Purpose |
|------|---------|
| `public/worker.js` | Service Worker for offline preview |
| `public/index.html` | App shell |
| `public/bundle.js` | Browserify output (gitignored) |

## Data Flow

### Preview Update
```
Editor change → generatePreviewContent() → sendPreviewFiles(files)
  ├─ WS connected: POST to server memory → iframe loads /preview-output/preview.html
  └─ Offline: postMessage to Service Worker → iframe loads /preview/preview.html
```

### Workspace Loading
```
User opens workspace selector → listDir WS requests → browse directories
  → openWorkspace WS request → server reads directory tree recursively
  → client receives file tree → mapWorkspaceTree() → updateProjectFilesCache()
  → text files: content loaded, binary files: viewType reference
  → media files served via /workspace-file?path=... HTTP route
```

### Session Persistence
```
State changes → debouncedSave() → localStorage['gl-editor-session']
  Saves: layout config, workspace path, open tabs (by filePath), cursor positions

Page load → loadSessionState() → prompt "Restore / Start Fresh"
  Restore: re-open workspace via WS → remap fileIds → loadLayout(rewritten config)
```

## File Types

| viewType | Editor | Preview |
|----------|--------|---------|
| (none) | Ace Editor | Web preview (HTML/CSS/JS/JSON/MD) or custom (Typst) |
| `pdf` | iframe (browser PDF viewer) | iframe |
| `png/jpg/gif/...` | `<img>` with zoom/pan | `<img>` with zoom buttons |
| `mp4/webm/ogg` | `<video>` with controls | `<video>` |
| `mp3/wav/flac` | `<audio>` with controls | `<audio>` |
| `binary` | Hex viewer (first 64KB) | N/A |

## Plugin System

See [plugins.md](plugins.md) for the plugin API. Plugins can add:

- GoldenLayout panel components
- Toolbar buttons in the file browser
- WebSocket message handlers (server-side)

External dependencies are loaded from esm.sh at runtime to keep the bundle small.

## Debug Logging

When `NODE_ENV !== 'production'`, the server sends `{ type: 'serverConfig', debug: true }` on WS connect. The client enables console logging and forwards all logs back to the server terminal via WS `clientLog` messages.

Enable manually: add `?debug` to the URL or `localStorage.setItem('debug', '1')`.
