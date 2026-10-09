# Adobe containers and palettes

The lazy Adobe reader handles `.indd`, `.indt`, `.xd`, `.icml`, `.idms`, `.inx`, `.ase`, and `.aco`. Its Apache-2.0 parsers are copied from Flyfish commit `e03662c883cdd089814d2d21e4c805b9d7320e0f`; the complete license is retained under `public/licenses/imported-viewers/Flyfish-Apache-2.0.txt`.

INDD/INDT validate the native master pages and contiguous objects, inspect XMP and display saved PNG/JPEG thumbnails when available. This is **embedded-preview/structure support**, not InDesign layout reconstruction. Documents without previews expose the reader's structure/status/warnings. Legacy or unsupported layouts remain explicitly labeled.

XD validates its UCF ZIP, reads the manifest and structured artboard/resource summaries, and displays a saved raster rendition. This is **embedded-preview/structure support**, not reconstruction of XD drawing/prototype behavior.

ICML and IDMS expose extracted paragraphs and character runs, with bounded font size/bold/italic/underline previews and layout-item information. INX exposes the legacy structure/text the parser can recover. These are extracted story/structure views, without native page composition, text-frame flow or linked-resource fetching. ASE and ACO display decoded color swatches, color models, components and groups.

Every parse uses a local module worker with a 60-second timeout and the upstream parser's file/node/depth/preview limits. Destroying the panel cancels pending work. Thumbnail URLs are revoked on replacement/unmount. Text, XMP and metadata are displayed using text nodes. XML does not execute scripts or fetch linked resources.

`npm run build:adobe` generates the ignored worker; `npm run build` includes it. The plugin chunk and worker stay unloaded until this viewer opens. `npm run test:adobe-containers` uses authored small fixtures for all eight suffixes, checks exact preview pixels, palettes, safe extracted text, malformed input and URL cleanup. Optional `TEST_INDD_PATH`, `TEST_INDT_PATH`, `TEST_XD_PATH`, `TEST_ICML_PATH`, `TEST_IDMS_PATH` and `TEST_INX_PATH` exercise larger real samples without redistributing them. `node scripts/test-viewer-routes.js` also verifies the default viewer route for every extension added in these batches.
