# Git bundle viewer

`.bundle` now has a lazy, local reader instead of an extension-only registration. It displays refs, prerequisites, commit history, each commit's file tree, and text blob previews. Buttons select commits and files; font zoom controls work independently in each panel. Text is inserted through DOM text nodes.

The Apache-2.0 parser and UI come from Flyfish `packages/renderers/text/src/gitBundle.ts` at commit `e03662c883cdd089814d2d21e4c805b9d7320e0f`. We provide a small English/zoom host adapter and pinned `pako 2.1.0`. Our changes correct SHA-256 tree entry widths and reject packs above 2,500 objects instead of silently truncating them. Pack versions 2 and 3, SHA-1 and SHA-256 object IDs, and common OFS_DELTA/REF_DELTA chains are handled. English messages retain the upstream license.

Limits: previews stop at 12,000 bytes per text blob; binary blobs show byte counts. Trees are followed to 24 levels. Prerequisites are listed, not fetched, so thin bundles can have unresolved objects. This is a reader, not a Git checkout/import operation; it does not validate the pack trailer checksum or signature trust.

`npm run build:bundle` creates the ignored CJS implementation consumed by the hashed viewer chunk. `npm run build` includes this step. Startup only includes synchronous routing metadata. Dropped bytes, local picker, workspace and archive-backed reads use the common viewer lifecycle; unmount clears the view and controls.

`npm run test:bundle` creates real Git SHA-1 and SHA-256 repositories with two commits and delta-compressed blobs. It tests refs, history navigation, nested trees, blob content, HTML escaping, zoom, malformed input, disposal, cached chunk downloads and zero startup viewer requests.

Licenses: [Flyfish Apache-2.0](../public/licenses/imported-viewers/Flyfish-Apache-2.0.txt) and [pako MIT](../public/licenses/imported-viewers/pako-MIT.txt).
