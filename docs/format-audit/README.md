# Viewer format audit

Generated from registered source claims, not README examples. This compares filename extensions; it does not prove renderer fidelity. A generic text/hex view does not count as a format-specific viewer. The upstream snapshots retain owners and source locations.

Our explicit viewer/native/archive handling: **796** suffixes. Upstream non-generic claims: **515**. Shared: **402**. Missing suffixes: **113**.

## Missing extensions

| Extension | Upstream handlers |
| --- | --- |
| `.abc` | jdeworks: text/abc |
| `.acf` | jdeworks: text/acf |
| `.ait` | flyfish: illustrator-pdf-design |
| `.als` | jdeworks: text/als |
| `.ans` | jdeworks: text/asciiart |
| `.asice` | flyfish: signature |
| `.asics` | flyfish: signature |
| `.azw3` | jdeworks: ebook/mobi |
| `.blend1` | jdeworks: binary/blend |
| `.blend2` | jdeworks: binary/blend |
| `.bsp` | jdeworks: binary/bsp |
| `.cer` | jdeworks: text/pem |
| `.cms` | flyfish: signature |
| `.cmsc` | flyfish: signature |
| `.crash` | jdeworks: text/crash |
| `.crt` | jdeworks: text/pem |
| `.der` | jdeworks: text/pem |
| `.dio` | flyfish: drawing, open-file-viewer: drawing |
| `.diz` | jdeworks: text/asciiart |
| `.dmp` | jdeworks: binary/dmp |
| `.dps` | open-file-viewer: office |
| `.dra` | flyfish: eda |
| `.drawio` | flyfish: drawing, open-file-viewer: drawing |
| `.eot` | open-file-viewer: asset |
| `.ers` | flyfish: signature |
| `.et` | open-file-viewer: office |
| `.excalidraw` | flyfish: drawing, open-file-viewer: drawing |
| `.fodp` | jdeworks: office/odf, open-file-viewer: office |
| `.fods` | flyfish: spreadsheet-openxml, open-file-viewer: office |
| `.fodt` | jdeworks: office/odf, open-file-viewer: office |
| `.gc` | jdeworks: text/gcode |
| `.h2drumkit` | jdeworks: text/hydrogen |
| `.h2pattern` | jdeworks: text/hydrogen |
| `.h2song` | jdeworks: text/hydrogen |
| `.hex` | flyfish: binary-inspector |
| `.icalendar` | jdeworks: ics |
| `.ifb` | jdeworks: ics |
| `.ips` | jdeworks: text/crash |
| `.jfif` | open-file-viewer: image |
| `.jws` | flyfish: signature |
| `.kicad_dru` | jdeworks: text/kicad |
| `.kicad_mod` | jdeworks: text/kicad |
| `.kicad_prl` | jdeworks: text/kicad |
| `.kicad_pro` | jdeworks: text/kicad |
| `.kicad_sym` | jdeworks: text/kicad |
| `.kicad_wks` | jdeworks: text/kicad |
| `.lot` | jdeworks: text/json |
| `.lrc` | flyfish: code |
| `.lrf` | jdeworks: ebook/lrf |
| `.lrx` | jdeworks: ebook/lrf |
| `.m3u8` | flyfish: video, open-file-viewer: video |
| `.markdown` | flyfish: markdown, jdeworks: markdown |
| `.mdmp` | jdeworks: binary/dmp |
| `.mdown` | jdeworks: markdown |
| `.mermaid` | flyfish: drawing |
| `.mkd` | jdeworks: markdown |
| `.mmd` | flyfish: drawing |
| `.nfo` | jdeworks: text/asciiart |
| `.nii` | jdeworks: binary/nifti |
| `.oas` | flyfish: eda, open-file-viewer: cad |
| `.oasis` | flyfish: eda, open-file-viewer: cad |
| `.odp` | flyfish: open-document, jdeworks: office/odf, open-file-viewer: office |
| `.odt` | flyfish: open-document, jdeworks: office/odf, open-file-viewer: office |
| `.ofc` | jdeworks: text/ofx |
| `.ofd` | flyfish: ofd, open-file-viewer: ofd |
| `.ogv` | jdeworks: VIDEO, open-file-viewer: video |
| `.olb` | flyfish: eda |
| `.p7b` | flyfish: signature, jdeworks: text/pem |
| `.p7c` | flyfish: signature, jdeworks: text/pem |
| `.p7m` | flyfish: signature |
| `.p7s` | flyfish: signature |
| `.pdd` | flyfish: photoshop-design |
| `.pem` | jdeworks: text/pem |
| `.pjpe` | open-file-viewer: image |
| `.pjpeg` | open-file-viewer: image |
| `.pkcs7` | flyfish: signature |
| `.plantuml` | flyfish: drawing |
| `.potm` | flyfish: office-presentation, open-file-viewer: office |
| `.ppsm` | flyfish: office-presentation, open-file-viewer: office |
| `.prproj` | jdeworks: text/prproj |
| `.psdt` | flyfish: photoshop-design |
| `.puml` | flyfish: drawing |
| `.sab` | open-file-viewer: cad |
| `.sat` | open-file-viewer: cad |
| `.sce` | flyfish: signature |
| `.scs` | flyfish: signature |
| `.shp` | flyfish: geo, jdeworks: binary/shapefile, open-file-viewer: gis |
| `.sig` | flyfish: signature |
| `.sldasm` | open-file-viewer: cad |
| `.sldprt` | open-file-viewer: cad |
| `.svgz` | jdeworks: image/svg |
| `.tab` | jdeworks: text/csv |
| `.text` | jdeworks: text/yaml |
| `.tldraw` | open-file-viewer: drawing |
| `.tsd` | flyfish: signature |
| `.tsq` | flyfish: signature |
| `.tsr` | flyfish: signature |
| `.tst` | flyfish: signature |
| `.txt` | jdeworks: text/chat, jdeworks: text/yaml |
| `.typst` | flyfish: typst |
| `.umd` | flyfish: umd |
| `.vhd` | jdeworks: emulator/v86 |
| `.wad` | jdeworks: binary/wad |
| `.webarchive` | flyfish: data-asset, open-file-viewer: asset |
| `.wps` | open-file-viewer: office |
| `.x_b` | open-file-viewer: cad |
| `.x_t` | open-file-viewer: cad |
| `.xhtml` | jdeworks: html |
| `.xla` | flyfish: spreadsheet-openxml |
| `.xlam` | flyfish: spreadsheet-openxml |
| `.xlt` | flyfish: spreadsheet-openxml, open-file-viewer: office |
| `.xltm` | flyfish: spreadsheet-openxml, open-file-viewer: office |
| `.xltx` | flyfish: spreadsheet-openxml, open-file-viewer: office |

## Shared suffixes with missing capabilities

| Suffix | Current handling | Missing capability |
| --- | --- | --- |
| `.3mf` | ZIP container browsing | 3D Manufacturing model rendering |
| `.kmz` | ZIP container browsing | KML/geospatial or embedded model preview |
| `.hdr` | Radiance/HDR image | NIfTI/ANALYZE medical-volume header |
| `.img` | disk image / game input | NIfTI/ANALYZE medical-volume image |
| `.md` | generic text / binary Mega Drive ROM | dedicated rendered Markdown preview; manual Pandoc conversion exists |
| `.vcf` | vCard contacts when BEGIN:VCARD matches | genomic Variant Call Format inspection |
| `.asc` | OpenPGP-encrypted message decryption | detached signature/certificate inspection |
| `.gpg` | OpenPGP-encrypted message decryption | signature verification and signed-container inspection |
| `.pgp` | OpenPGP-encrypted message decryption | signature verification and signed-container inspection |
| `.json` | source / Lottie | other structured data and schema-specific summaries |
| `.xml` | source / MathML / MusicXML | other XML domain-specific summaries |

This table records reviewed collisions, not a complete fidelity comparison for every shared suffix.

## Scope and collisions

- `.bundle` is a Git bundle in Flyfish. jdeworks also names `.bundle` in its Mach-O signature metadata; that detection-only catalog is retained in the snapshot but excluded from renderer claims.
- Extension equality is a first pass, not semantic equivalence. `.3mf` and `.kmz` can be browsed as ZIP containers here, but that is not a 3D/geo renderer; `.bin`, `.img`, `.md`, `.xml`, `.json`, `.vcf`, `.ics`, `.art` and other reused suffixes need header/schema checks.
- Media metadata handling is counted but does not imply playable audio/video. Imported/converted/embedded-preview support is not native editing.
- Filename regex families and content/magic detectors cannot be completely expressed as a finite extension list; their source expressions are preserved in comparison.json.
- Plain-text display is available independently of suffix, so `.txt`, `.yaml`, `.ini`, etc. in the gap list mean missing upstream structured/domain-specific views, not unreadable text.
- Upstream generic code-language suffixes are reported separately; our generic editor can display text without having a dedicated parser.
- jdeworks has **884** registered filename/schema enhancements. These are separately inventoried in comparison.json; sharing `.json`, `.yaml`, `.xml`, etc. does not mean we implement these structured summaries.
- Upstream experimental, metadata and external-tool claims are included with their original status/support limits in upstreams.json. This is a gap inventory, not an assertion that each can be copied into a browser and render faithfully.

## Reproduce

```sh
python scripts/audit-viewer-formats.py
# Refresh the upstream snapshot from sibling clones:
python scripts/audit-viewer-formats.py --upstreams ..
```

The concrete Python lists and set difference are in formats.py; comparison.json includes the full evidence and per-project differences.

## Revisions

- `jdeworks-file-viewer`: `f3934e9a75fe01d6fd74830e996a0111a7dc4fc2`
- `open-file-viewer`: `6d85f230f0cf62320ffea146c2de6f15feb6cecb`
- `flyfish-file-viewer`: `e03662c883cdd089814d2d21e4c805b9d7320e0f`
