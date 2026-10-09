# Photoshop resource libraries

The lazy Adobe panel now reads ABR brush libraries, CSH custom shapes, PAT pattern libraries, GRD gradients, and ASL layer styles. The Apache-2.0 parsers are imported from Flyfish file-viewer at e03662c883cdd089814d2d21e4c805b9d7320e0f; ABR/CSH decoding uses the pinned MIT ag-psd 30.2.0 dependency. Notices are retained under public/licenses/imported-viewers.

Resource parsers are split module-worker imports: opening a palette or InDesign container does not download ag-psd. Closing the panel terminates its worker. Errors propagate to the panel, and invalid resources are not presented as successful previews.

| Extension | Preview | Limits |
| --- | --- | --- |
| ABR | Actual decoded brush-tip alpha, patterns, and brush descriptors | Versions 6, 7, 9, 10 with subversion 1 or 2. Legacy versions 1/2 and 16-bit RLE samples are rejected. Paint-stroke dynamics are not simulated. |
| CSH | Bezier paths as SVG, with composition metadata | Version 2. Exclude/subtract/intersect operations are labeled as incomplete composition. |
| PAT | Actual RGBA pattern tiles | Supported native pattern records and compression methods; parser rejects unsupported records. |
| GRD | Solid gradient pixels and noise-gradient approximation, definitions | Noise previews are approximate; reader limitations remain visible. |
| ASL | Layer-style descriptors and embedded pattern pixels | Effects are inspected, not applied to a document. |

Worker bounds include 128 MiB input/decoded data, 16 million aggregate resource pixels, 4096 resources, and 64 nesting levels. The UI displays at most 64 bitmap/vector resources and 256 descriptors. The suffixes CSH and GRD are signature-checked, so shell scripts and text grids are not intercepted.

`npm run test:adobe-resources` verifies alpha/pixel values, SVG paths, style descriptors, local lazy loading, picker changes, collision detection, cancellation, worker cleanup, and malformed data. Fixtures are original or license-cleared upstream fixtures with provenance in scripts/fixtures/adobe-resources. `TEST_ABR_PATH` optionally exercises an external real brush library.
