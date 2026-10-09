# InDesign IDML viewer

The first implementation from the difficult-format backlog is `.idml`: InDesign's XML document package. It uses Flyfish's page renderer and the pinned `@paged-media/introspect-wasm` CPU rendering engine, with local assets and a terminable module worker. This is rendered page output rather than a ZIP listing or metadata-only preview.

Open IDML from the Plugins menu, a workspace-file viewer menu, the viewer's file picker, or a project-file drop. The panel offers page navigation, zoom and fit. Reopening a document reuses its downloaded viewer chunk; each document's worker and page cache are released on close. Closing during loading aborts and terminates the worker. Package and render errors propagate to the viewer boundary.

## Build

`npm run build:idml` compiles the copied TypeScript into the CommonJS viewer module consumed by Browserify, bundles the browser module worker and copies the installed runtime's WASM locally. `npm run build` runs this before building the lazy viewer chunks. `npm run watch` observes JavaScript and TypeScript, excluding the generated viewer module to avoid rebuild loops. Generated JS and WASM are ignored by Git; deployment builds produce them from source and pinned dependencies.

The core startup bundle contains only IDML registration metadata. The viewer chunk is downloaded when opened; its worker and approximately 9.1 MiB WASM are then loaded from the same app origin. URLs resolve relative to the application bundle, including GitHub Pages repository subdirectories. The IDML implementation uses no external conversion service or public CDN.

## Scope

- The engine renders IDML pages; it does not read native `.indd` or `.indt` layout databases or provide InDesign editing.
- The engine and copied parser retain upstream limits and supported object behavior. Rendering is not guaranteed to match InDesign's typography, effects, color management or all object types.
- Missing linked assets are not fetched from a workstation or remote host. A page may therefore contain placeholders where the document references resources outside its package.
- The upstream object tree reports TextFrame and Rectangle objects; that inventory is not a complete account of every object contributing rendered pixels.
- ZIP64, encrypted or unsupported packages reject explicitly. Page switching does not turn a render failure into a metadata preview.

Provenance, modifications and complete dependency notices are recorded under `public/licenses/imported-viewers/IDML-NOTICES.md`. The Flyfish source is Apache-2.0; the unmodified runtime is used under its MPL-2.0 option.

## Verification

```sh
npm run build
TEST_CHROMIUM_PATH=/path/to/chromium npm run test:idml
# Include a full editor drop test using a local Ace 1.43.6 distribution:
TEST_CHROMIUM_PATH=/path/to/chromium TEST_ACE_DIR=/path/to/src-min-noconflict npm run test:idml
npm run test:lazy-viewers
npm run test:imported-viewers
```

The IDML test uses the actual WASM runtime, not a mocked renderer. Its generated two-page IDML fixture has no third-party assets: exact red/blue pixels verify rendered geometry, page navigation, zoom, fit, file-picker loading and full-editor drop routing. It also verifies malformed-package errors, worker cleanup, cancellation during WASM loading, startup laziness and subdirectory asset URLs. A separate smoke check exercised Flyfish's real IDML example without redistributing it.

Next difficult candidates are the USD family and native CAD. Their upstream filename claims must be checked against real geometry decoding: some CAD adapters expose only structural summaries or hooks for an external engine.
