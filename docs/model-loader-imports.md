# Additional 3D readers

The existing 3D viewer now reads `.usd`, `.usda`, `.usdc`, `.usdz`, `.fbx`, `.pcd`, `.vtk`, `.vtp`, and `.xyz`. These are geometry readers, using the same orbit, zoom, wireframe, reset, statistics and thumbnail controls as other models. Dropped bytes, local file selection, workspace files and archive-backed files use the common read path.

The upstream Open File Viewer implementation uses three.js USDLoader, FBXLoader, PCDLoader, XYZLoader and VTKLoader. We reuse those MIT readers directly from **three 0.184.0**, rather than copying its UI. The runtime also contains our GLTF/STL/OBJ readers and shares one Three instance. Older optional CDN loader URLs now use the same Three version.

`npm run build:models` generates `public/model3d-runtime/loaders.js`. It is included in `npm run build`, loaded only after opening a model, cached by module import, and resolved against the initial bundle URL for subdirectory hosting. No model runtime download occurs at startup. Generated assets are not tracked.

Scope is the underlying three.js readers: USD mesh scene composition is a subset of OpenUSD, not a full DCC application; references and textures outside standalone USD layers are not automatically resolved by USDLoader. USDZ embeds its assets. FBX displays the loaded scene at its initial pose, without an animation timeline. PCD and XYZ are point clouds. VTK/VTP support polydata, not arbitrary scientific volume grids. XYZ is coordinate/color data, not molecular bonding.

`npm run test:models` checks real geometry, exact bounds, actual WebGL draw calls, wireframe/reset, disposal, malformed USD rejection, local requests, module caching and zero startup requests. The tiny USDA and USDC fixtures were authored here with OpenUSD; the USDC fixture is an actual crate file. The test creates its own USDZ archive. Set `TEST_FBX_PATH` to a real FBX fixture to exercise FBX as well; validation used the three.js r184 Stanford bunny example. OBJ/STL regressions cover the runtime upgrade. `TEST_CHROMIUM_PATH` optionally selects a local Chromium executable.

License: [three.js MIT](../public/licenses/imported-viewers/three-MIT.txt). Upstream routing inspected at Open File Viewer commit `6d85f230f0cf62320ffea146c2de6f15feb6cecb`.
