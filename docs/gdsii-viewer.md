# GDSII mask layouts

The lazy `.gds` and `.gdsii` panel reads the GDSII record stream and draws boundary polygons, paths and text in their database coordinates. It offers cell selection and zoom/reset; database units and cell names remain visible. Cell/array references are markers, not recursively expanded instances. Rotations, magnification, box/node records and other unsupported transforms are reported when encountered. This is a limited mask-layout preview, not a complete fabrication editor.

The Apache-2.0 parser is copied from Flyfish renderer-eda-layout at e03662c883cdd089814d2d21e4c805b9d7320e0f. Its 2500-element preview limit is retained and visibly labeled. Invalid record lengths now throw. The host validates HEADER/ENDLIB, even record alignment and XY lengths before parsing. Input is capped at 128 MiB and 250000 records; parsing runs in a local worker with timeout, completion cleanup, picker replacement and tab-close cancellation. No external renderer assets are loaded.

`npm run test:layout` builds an original GDSII record stream and verifies exact polygon/path coordinates, escaped labels, layer/cell selection, zoom, both aliases, lazy loading, worker cancellation and malformed headers. Binary OASIS is not counted as supported: the upstream layout package's text/inspection functions do not decode its binary geometry.
