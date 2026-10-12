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

## Shared suffix previews

`FILE_VIEWERS` in `src/main.js` chooses previews using content checks as well as
filenames. The source editor remains available in the viewer selector. JSON/XML
structure previews are additional choices after the editor and existing Lottie,
MathML and MusicXML choices remain available.

| Suffix | Added preview | Recognition and limits |
| --- | --- | --- |
| `.3mf` | Orbitable manufacturing model, wireframe and mesh statistics | Three.js `ThreeMFLoader`; core meshes, components and base materials, with the loader's partial material-extension support. ZIP browsing remains available. |
| `.kmz`, `.kml` | KML map, placemark table, polygon holes and gx tracks | KMZ reads `doc.kml` or the first KML document. Network links and ground overlays are counted, not fetched/rendered. Embedded COLLADA models have a separate Three.js preview; this does not place a complete 3D scene geographically. |
| `.hdr`, `.img`, `.nii` | NIfTI-1 / ANALYZE 7.5 header and scalar-volume slices | A validated 348-byte header, or an `.img` companion `.hdr`, selects the viewer. Supports little/big endian uint8/int8, uint16/int16, uint32/int32, float32/float64, scaling, time/higher-volume indices, axis/slice and intensity-window controls. Complex/RGB/other datatypes retain header inspection with an explicit unsupported-rendering message. Uses stored voxel axes; no anatomical reorientation, NIfTI-2 or gzip decoding. |
| `.md`, `.markdown`, `.mdown` | Rendered Markdown | Text files only; binary `.md` retains the emulator choice. Marked HTML is sanitized by DOMPurify and displayed in a sandbox without scripts. Refresh reads current edited text. Relative workspace images are not resolved. |
| `.vcf` | Genomic variant table, sample/header metadata, chromosome and filter counts | Requires the `##fileformat=VCFv…` header and valid tab-separated columns. vCards retain their existing handling. Filtering examines the first 5,000 records, with up to 250 table rows displayed; totals cover the parsed document. |
| `.asc`, `.gpg`, `.pgp` | OpenPGP signature/certificate inspection and verification | Armored and binary detached signatures, cleartext signatures, signed/literal containers and certificates. Verification requires supplied public keys and, for detached signatures, the exact original file. Encrypted messages retain decryption and can inspect/verify inner signatures afterward. Payloads are labeled unverified until verification; valid signatures do not establish identity trust. |
| `.json` | Expandable structure and schema summaries | GeoJSON, OpenAPI, JSON Schema, npm packages, Jupyter notebooks and HTTP Archives; generic JSON fallback. Summary recognition is descriptive, not schema validation. |
| `.xml` | Expandable structure and domain summaries | RSS, Atom, SVG, KML, GPX, Maven POM, JUnit and sitemaps; generic XML fallback. Does not claim the upstream filename/schema catalog. |
| `.numbers` | Apple Numbers table preview | Validates `Index/Document.iwa`, then reads Numbers 3+ table data with SheetJS CE 0.20.3. Each table is selectable, with formatted cell values and a 200-row × 100-column display limit. Older XML-based Numbers, charts and Numbers canvas layout are not reproduced. |
| `.odt`, `.odp` | Document / presentation pages | Validates the ZIP's OpenDocument mimetype, `content.xml` and encryption status, then converts to PDF in the existing LibreOffice WASM worker. This is a read-only converted preview, not native OpenDocument editing; the source is not overwritten. Encrypted packages are rejected. |
| `.oas`, `.oasis` | Semiconductor IC layout canvas | Requires `%SEMI-OASIS` magic. fatamorgana 0.14 runs in a disposable Pyodide 0.28.3 worker and reads compressed/uncompressed records and modal state. Supports cell selection, hierarchical placements, rotation, reflection, magnification, repetitions, rectangles, polygons, paths, trapezoids, compact trapezoids, circles (64-segment approximation), text, layer toggles, zoom and pan. Input limit: 64 MB; preview expansion: 25,000 shapes/instances and 64 hierarchy levels. Truncation, missing cells and unsupported geometry produce visible warnings. |
| `.3g2` | Video playback and conversion | Validates the 3GPP2 `ftyp` brand, offers native playback and an explicit FFmpeg WASM conversion to H.264/AAC MP4 when needed. Conversion input limit: 256 MB; source remains unchanged. Metadata inspection is a separate viewer choice. |
| `.aif`, `.aifc`, `.aiff`, `.amr` | Decoded audio playback | Validates AIFF/AIFC or AMR/AMR-WB magic, then decodes to an in-memory PCM WAV with FFmpeg WASM. Input limit: 64 MB; operation timeout: 120 seconds. Does not imply editing or support for every possible codec. |
| `.7z` | Read-only entry browser and contained-file previews | Full 7-Zip 24.09 via `7z-wasm` 1.2.0 in a disposable worker, including password-assisted extraction. Shows up to 1,000 filtered entry rows; regular files are extracted on demand and opened with their own viewer. Input limit: 256 MB; entry limit: 64 MB; operation timeout: 120 seconds. Directory traversal, absolute paths and control-character paths are rejected. Symlinks/hardlinks are omitted; dependent files are not automatically extracted together. |
| `.aab` | Android App Bundle inspector | Requires a ZIP with `BundleConfig.pb` and a base AAPT2 protobuf manifest. Shows modules, package/version values, manifests, permission claims, DEX/file counts and ABIs, plus contained-file previews. Manifest/config limit: 4 MB each. Signature entry names are inventoried; signatures are not verified, and the bundle is not installed or converted to APKs. |
| `.abc` | ABC sheet music | Requires `X:` and `K:` notation headers; abcjs 6.7.1 renders SVG notation with tune selection. Binary Alembic/ActionScript files remain in their existing fallback. This viewer does not synthesize playback or edit notation. |
| `.acf` | Steam manifest summary and KeyValues structure | Requires an `AppState` root. Preserves nested and duplicate keys; reports app ID, name, install directory, build/state flags and size/timestamps. Other ACF uses remain in the editor. |
| `.aco` | Adobe color swatch gallery | ACO versions 1/2, including UTF-16 names and RGB/HSV/CMYK/Lab/grayscale values. CMYK/Lab display is an approximation without the original color profile; unsupported color spaces retain their numeric values. |
| `.abr` | Photoshop sampled brush-tip gallery | Versions 1/2 and 6.1/6.2, raw and PackBits, 8/16-bit masks. Limits: 500 tips, 16 megapixels per tip and 64 megapixels total. Computed brushes, patterns and descriptor dynamics are not rendered; unsupported versions produce an explicit message. |
| `.ait` | PDF-compatible Illustrator template pages | Uses the existing Illustrator/PDF viewer and validates the PDF header. The original template cannot be overwritten by the PDF viewer. Older PostScript-based templates are not supported by this path. |
| `.als` | Ableton Live Set summary | Recognizes Ableton XML, decompressing gzip when needed. Shows creator/version, tempo, tracks, clips, device types and referenced sample paths. Does not run plug-ins or play the session; Alloy source and other ALS text remain in the editor. |

Structured trees are bounded to 3,000 preview nodes, 200 children per branch and
20 levels. Volume canvases are limited to 16 megapixels per slice. Dependencies
are loaded from versioned CDN URLs when needed, matching the existing plugins.

Focused validation:

```sh
node --test scripts/tests/shared-previews.test.js
npm run build
node scripts/tests/shared-previews.browser.js
node --test scripts/tests/oasis-layout.test.js
PYTHONPATH=public/py python3 scripts/tests/oasis-preview.test.py
node scripts/tests/office-eda-previews.browser.js
node --test scripts/tests/extra-previews.test.js
node scripts/tests/extra-previews.browser.js
```

The browser check requires installed Playwright Chromium and network access to
the CDN modules. It starts its own server and removes its temporary fixtures.
The OASIS Python check requires `fatamorgana==0.14` in the chosen Python
environment. Its checked-in fixtures cover compressed and uncompressed files;
`trapezoids.oas` was independently generated with gdstk 1.0.1. The office/EDA
browser check downloads SheetJS's public `pres.numbers` fixture, uses the real
OASIS worker, and checks two-page ODT/ODP PDF previews.
The extra-preview browser check uses `ffmpeg` and `7z` to create local fixtures,
downloads a pinned public Google bundletool AAB fixture to independently check
the manifest schema, and verifies actual audio/video decoding, encrypted 7z
extraction, domain summaries and Adobe resource pixels.
