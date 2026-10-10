# Viewer format audit

Generated from registered source claims, not README examples. This compares filename extensions; it does not prove renderer fidelity. A generic text/hex view does not count as a format-specific viewer. The upstream snapshots retain owners and source locations.

Our explicit viewer/native/archive handling: **902** suffixes. Upstream non-generic claims: **515**. Shared: **508**. Missing suffixes: **7**.

## Missing extensions

| Extension | Upstream handlers |
| --- | --- |
| `.azw3` | jdeworks: ebook/mobi |
| `.dra` | flyfish: eda |
| `.lrf` | jdeworks: ebook/lrf |
| `.lrx` | jdeworks: ebook/lrf |
| `.olb` | flyfish: eda |
| `.sldasm` | open-file-viewer: cad |
| `.sldprt` | open-file-viewer: cad |

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
