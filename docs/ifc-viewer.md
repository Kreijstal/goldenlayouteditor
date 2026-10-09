# IFC geometry viewer

`.ifc` uses pinned **web-ifc 0.0.77** (MPL-2.0) in a local single-threaded WASM worker. It streams tessellated geometry, copies native vertex/normal/index buffers, retains placement matrices, colors and IFC express IDs, and closes the native model. The existing 3D viewer supplies orbit/zoom/reset/wireframe, mesh statistics and hierarchy controls.

This displays IFC geometry supported by web-ifc. It is not a BIM authoring or property-set editing application. Coordinates are rebased to the model origin for rendering. Inputs over 128 MiB, geometry over 256 MiB, more than 100,000 mesh placements or loads exceeding 60 seconds report explicit errors. Files without renderable geometry report an error. Closing the panel aborts and terminates the worker.

`npm run build:ifc` emits the ignored local worker and copies `web-ifc.wasm`; it is part of `npm run build`. Workers and WASM load only when IFC is opened. The binary and API are unmodified. Corresponding source: https://github.com/ThatOpen/engine_web-ifc/tree/f26c4beef0a668ebdb180d2b95a94097a1e21cef (the package's published gitHead). The complete MPL license is at `public/licenses/imported-viewers/web-ifc-MPL-2.0.txt`.

`npm run test:models` includes an authored IFC2X3 swept rectangular wall fixture and checks tessellation, exact model bounds, actual WebGL rendering, controls and disposal, alongside the other model readers. Optional `TEST_FBX_PATH` adds an external FBX example.
