# GDSII mask layouts

The lazy `.gds` and `.gdsii` panel reads the GDSII record stream and draws boundary polygons, paths and text in their database coordinates. It offers cell selection and zoom/reset; database units and cell names remain visible. Cell/array references are markers, not recursively expanded instances. Rotations, magnification, box/node records and other unsupported transforms are reported when encountered. This is a limited mask-layout preview, not a complete fabrication editor.

The Apache-2.0 parser is copied from Flyfish renderer-eda-layout at e03662c883cdd089814d2d21e4c805b9d7320e0f. Its 2500-element preview limit is retained and visibly labeled. Invalid record lengths now throw. The host validates HEADER/ENDLIB, even record alignment and XY lengths before parsing. Input is capped at 128 MiB and 250000 records; parsing runs in a local worker with timeout, completion cleanup, picker replacement and tab-close cancellation. No external renderer assets are loaded.

`npm run test:layout` builds an original GDSII record stream and verifies exact polygon/path coordinates, escaped labels, layer/cell selection, zoom, both aliases, lazy loading, worker cancellation and malformed headers.

## Native OASIS

`.oas` and `.oasis` now use the MIT open-file-viewer parser at 6d85f230f0cf62320ffea146c2de6f15feb6cecb, adapted to walk native records sequentially rather than scan for apparent compressed-block bytes. Both ordinary and CBLOCK raw-deflate record streams are parsed; headers, offset-table flag, block lengths and END placement/size are validated. Errors propagate instead of returning guessed geometry. Bounded inflation checks the declared block length and a 64 MiB cumulative expanded limit before collecting output.

The partial geometry preview draws rectangles, polygons, paths and labels, and places reference markers. References and their transforms are not expanded. Circles, trapezoids, nested compressed blocks and unknown records are rejected. END checksum/signature validation is not implemented. Limits are 64 MiB input/expanded CBLOCK data, 250000 records, 12000 elements/repetitions, 100000 points per list, 200000 stored shape points and 1 MiB per string. The view reports these scope limits.

`npm run test:oasis` checks exact native coordinates, labels, SVG pixels, cell selection/zoom, compressed/uncompressed aliases, invalid END/header, lazy loading and worker cancellation. `python scripts/test-oasis-oracle.py` optionally uses gdstk 0.9.61 to independently read both authored native fixtures and generate a separate compressed rectangle/path/label file checked by this decoder. External fixture binaries are not committed. Parser/license provenance is retained under public/licenses/imported-viewers.
