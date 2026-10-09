# IDML viewer notices

The TypeScript files under `src/imported-idml/idml*.ts` are adapted from
[Flyfish File Viewer](https://github.com/flyfish-dev/file-viewer/tree/e03662c883cdd089814d2d21e4c805b9d7320e0f/packages/renderers/design/src),
revision `e03662c883cdd089814d2d21e4c805b9d7320e0f`.
Copyright 2026 Flyfish Viewer. Apache-2.0; full notice: `Flyfish-Apache-2.0.txt`.
The original page renderer, document worker, ZIP/XML preflight, PNG decoder,
page geometry and tree parser are retained. Changes replace the host framework,
require explicit local worker URLs, and propagate page-render failures.

The runtime is **@paged-media/introspect-wasm 0.63.0**. Its package declares
`MPL-2.0 OR LicenseRef-PMEL`; this project selects **MPL-2.0**.
The complete license is in `MPL-2.0.txt`.
Corresponding runtime source: <https://github.com/paged-media/core/tree/v0.63.0>.
The runtime package is unmodified; the build bundles its JavaScript glue into the
module worker and copies its WASM to `public/idml-viewer/introspect.wasm`.
Generated worker/WASM assets are not tracked in Git.

**saxes 6.0.0**: ISC, full upstream notice in `saxes-ISC.txt`.
Source: <https://github.com/lddubeau/saxes/tree/v6.0.0>.
**xmlchars 2.2.0** (transitive): MIT, full upstream notice in `xmlchars-MIT.txt`.
Source: <https://github.com/lddubeau/xmlchars/tree/v2.2.0>.

All these notices are served alongside the app under `licenses/imported-viewers/`.
No Adobe application, SDK, proprietary fonts or upstream demo document is redistributed.
