# Lazy viewer loading

`npm run build` produces the application bundle and 130 separately named viewer/decoder modules in `public/viewer-chunks/`. The generated files are ignored by Git and included by the existing Pages deployment. `npm run watch` rebuilds both the startup bundle and its chunks when JavaScript sources change.

The application bundle contains plugin IDs, component names, menu labels, defaults, and synchronous filename/header predicates. A panel constructor, menu action, new-file generator, or visible thumbnail renderer loads its implementation on demand. Restored panels use the same lazy constructors. Each module request is cached, so concurrent tabs and later reopens share the download. A tab closed during download never constructs its viewer. A loading failure rejects the panel's `ready` promise and displays the error in the tab.

PDF and image decoders use the same boundary. Name/header checks remain synchronous; decoding and URL-based checks return promises. Native browser image, audio, video, text, and HTML views use the built-in editor code. Third-party scripts, workers and WASM retain their existing loading behavior inside the requested viewer.

## Build and runtime

- `scripts/viewer-interface.js` extracts metadata and its declaration dependencies from the original plugin registration. Constructors and effectful callbacks are replaced in the startup interface; their real definitions remain in the viewer chunk. This avoids a second, manually maintained format/menu catalog.
- `scripts/build-viewers.js` builds the interfaces and per-module chunks. Chunk filenames include a content hash, and the startup bundle embeds the matching manifest. URLs resolve relative to the application bundle, including under a repository subdirectory.
- `src/lazy-viewers.js` caches requests, supplies lazy component constructors, and dispatches effectful callbacks to the real plugin. `init(ctx)` captures the application context without loading the viewer; the real initializer runs when its implementation registers.
- Shared modules resolve through the application's Browserify module registry. In-memory files, VFS, plugin registrations, and logging therefore retain one identity across chunks.

Add a plugin in `src/*-plugin.js` and require it alongside the other plugins in `src/main.js`. The build discovers it automatically. Keep metadata and `canHandle` predicates free of DOM/network side effects. Put viewer setup in constructors, effectful callbacks or `init`. Cross-plugin runtime dependencies should use `loadModule()` rather than importing another viewer implementation. Small shared utilities can live in ordinary modules, as `zip-entry.js` does for Krita and OpenRaster.

Built-in image modules are discovered through the image dispatcher's imports and the editor's format imports. Export synchronous detection helpers with `is…`, `has…`, `mayBe…`, or `looksLike…` names; a helper ending in `Url` is deferred because it reads the file asynchronously. Other decoder exports are asynchronous at the application boundary. Decoder-internal calls retain their original synchronous contracts.

## Verification

After `npm run build`, run:

```sh
npm run test:lazy-viewers
npm run test:imported-viewers
npm run test:cd5
npm run test:legacy-art
```

`TEST_CHROMIUM_PATH` can select a local Chromium executable. The lazy-loading test uses the production bundle, checks zero startup viewer requests, loads every chunk, compares all plugin menus/components/predicates against the real registrations, checks shared memory-file access, renders concurrent CD5 panels, and tests cancellation and script-load errors. It serves the bundle under a subdirectory to check chunk URL resolution.
