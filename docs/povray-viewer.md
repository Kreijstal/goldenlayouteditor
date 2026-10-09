# POV-Ray scene rendering

`.pov` files open in a POV-Ray viewer. **Render** reads the current editor source;
**Open** loads a local scene. Choose 320×240, 640×480, or 1280×960. **Stop**
terminates the render worker; closing the tab also terminates it and releases
the output image URL. Rendering stays off the main UI thread.

This is real POV-Ray 3.8 rendering, using [povrayst](https://github.com/bernsteining/povrayst)
0.1.0's published WASM module with a JavaScript implementation of its
wasm-minimal-protocol imports. Typst is not required. Each render gets a fresh
module instance. The module returns a PNG or a parser/render error; errors are
shown in the status bar and propagated to the caller.

The module has a filesystem-less scene interface. Standard include libraries,
workspace `.inc` files, image maps and other external file resources are not
provided by this viewer. Use self-contained scenes. This is a rendered image
viewer, not a scene-to-mesh importer.

## Setup

```sh
npm install
npm run fetch:povray
npm run build
npm start
```

The downloader verifies SHA-256
`35d2605e7b543a73db472d9d4f7ed8e4bbba91b156d628608819bec89ab80acb`
before writing the module. The generated `public/povray-viewer/povray.wasm` is
ignored by Git and must be included in the deployed public directory.

The published artifact comes from [Typst packages / povrayst 0.1.0](https://github.com/typst/packages/tree/main/packages/preview/povrayst/0.1.0).
Its source and build instructions are in the [upstream repository](https://github.com/bernsteining/povrayst);
the AGPL-3.0 license is included at `public/povray-viewer/LICENSE`.
The JavaScript host does not modify the WASM module.

Browser integration check: `npm run test:povray` (Playwright Chromium required; `TEST_CHROMIUM_PATH` can select an installed browser). Checks rendered pixels, edits, parser errors and cancellation.
