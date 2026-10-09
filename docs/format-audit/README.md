# Viewer format audit

Generated from registered source claims, not README examples. This compares filename extensions; it does not prove renderer fidelity. A generic text/hex view does not count as a format-specific viewer. The upstream snapshots retain owners and source locations.

Our explicit viewer/native/archive handling: **637** suffixes. Upstream non-generic claims: **515**. Shared: **243**. Missing suffixes: **272**.

## Missing extensions

| Extension | Upstream handlers |
| --- | --- |
| `.3g2` | open-file-viewer: video |
| `.abc` | jdeworks: text/abc |
| `.acf` | jdeworks: text/acf |
| `.aif` | open-file-viewer: audio |
| `.aifc` | open-file-viewer: audio |
| `.aiff` | open-file-viewer: audio |
| `.ait` | flyfish: illustrator-pdf-design |
| `.als` | jdeworks: text/als |
| `.amr` | open-file-viewer: audio |
| `.ans` | jdeworks: text/asciiart |
| `.arrow` | jdeworks: binary/arrow |
| `.asf` | jdeworks: VIDEO |
| `.asice` | flyfish: signature |
| `.asics` | flyfish: signature |
| `.atom` | jdeworks: text/xml |
| `.au` | open-file-viewer: audio |
| `.avro` | flyfish: data-asset, jdeworks: binary/avro, open-file-viewer: asset |
| `.azw` | jdeworks: ebook/mobi |
| `.azw3` | jdeworks: ebook/mobi |
| `.bcf` | jdeworks: text/bio |
| `.bed` | jdeworks: text/bio |
| `.blend1` | jdeworks: binary/blend |
| `.blend2` | jdeworks: binary/blend |
| `.bson` | jdeworks: binary/bson |
| `.bsp` | jdeworks: binary/bsp |
| `.caf` | open-file-viewer: audio |
| `.cbor` | jdeworks: binary/cbor |
| `.cer` | jdeworks: text/pem |
| `.cfg` | jdeworks: text/ini |
| `.cif` | jdeworks: text/cif |
| `.cif2` | jdeworks: text/cif |
| `.class` | flyfish: binary-inspector, jdeworks: binary/class |
| `.cms` | flyfish: signature |
| `.cmsc` | flyfish: signature |
| `.conf` | jdeworks: text/ini |
| `.crash` | jdeworks: text/crash |
| `.crt` | jdeworks: text/pem |
| `.csproj` | jdeworks: text/xml |
| `.db3` | jdeworks: sqlite |
| `.dbf` | flyfish: spreadsheet-dbf, jdeworks: binary/dbf |
| `.der` | jdeworks: text/pem |
| `.diff` | jdeworks: text/patch |
| `.dio` | flyfish: drawing, open-file-viewer: drawing |
| `.divx` | jdeworks: VIDEO |
| `.diz` | jdeworks: text/asciiart |
| `.dll` | flyfish: binary-inspector, jdeworks: binary/exe |
| `.dmp` | jdeworks: binary/dmp |
| `.doc` | flyfish: office-word-binary, open-file-viewer: office |
| `.dockerfile` | jdeworks: text/dockerfile |
| `.dockerignore` | jdeworks: text/gitignore |
| `.dot` | flyfish: office-word-binary, open-file-viewer: office |
| `.dps` | open-file-viewer: office |
| `.dra` | flyfish: eda |
| `.drawio` | flyfish: drawing, open-file-viewer: drawing |
| `.dylib` | jdeworks: binary/exe |
| `.eml` | flyfish: email, jdeworks: eml, open-file-viewer: email |
| `.ent` | jdeworks: text/pdb |
| `.env` | jdeworks: text/env, jdeworks: text/ini |
| `.eot` | open-file-viewer: asset |
| `.ers` | flyfish: signature |
| `.eslintignore` | jdeworks: text/gitignore |
| `.et` | open-file-viewer: office |
| `.excalidraw` | flyfish: drawing, open-file-viewer: drawing |
| `.exe` | flyfish: binary-inspector, jdeworks: binary/exe |
| `.f3d` | jdeworks: binary/f3d |
| `.f3z` | jdeworks: binary/f3d |
| `.f4v` | jdeworks: VIDEO |
| `.fa` | jdeworks: text/bio |
| `.faa` | jdeworks: text/bio |
| `.fasta` | jdeworks: text/bio |
| `.fastq` | jdeworks: text/bio |
| `.feather` | jdeworks: binary/arrow |
| `.ffn` | jdeworks: text/bio |
| `.flv` | jdeworks: VIDEO, open-file-viewer: video |
| `.fna` | jdeworks: text/bio |
| `.fodp` | jdeworks: office/odf, open-file-viewer: office |
| `.fods` | flyfish: spreadsheet-openxml, open-file-viewer: office |
| `.fodt` | jdeworks: office/odf, open-file-viewer: office |
| `.fq` | jdeworks: text/bio |
| `.frn` | jdeworks: text/bio |
| `.fsa` | jdeworks: text/bio |
| `.gc` | jdeworks: text/gcode |
| `.gds` | flyfish: eda, open-file-viewer: cad |
| `.gdsii` | open-file-viewer: cad |
| `.geojson` | flyfish: geo, jdeworks: geo, jdeworks: text/geojson, jdeworks: text/json, open-file-viewer: gis |
| `.gff` | jdeworks: text/bio, jdeworks: text/gff |
| `.gff2` | jdeworks: text/gff |
| `.gff3` | jdeworks: text/bio, jdeworks: text/gff |
| `.gitignore` | jdeworks: text/gitignore |
| `.gpkg` | jdeworks: sqlite |
| `.gtf` | jdeworks: text/bio, jdeworks: text/gff |
| `.h2drumkit` | jdeworks: text/hydrogen |
| `.h2pattern` | jdeworks: text/hydrogen |
| `.h2song` | jdeworks: text/hydrogen |
| `.har` | jdeworks: text/har |
| `.hex` | flyfish: binary-inspector |
| `.hgignore` | jdeworks: text/gitignore |
| `.hl7` | jdeworks: text/hl7 |
| `.hl7v2` | jdeworks: text/hl7 |
| `.icalendar` | jdeworks: ics |
| `.ifb` | jdeworks: ics |
| `.ini` | jdeworks: text/ini |
| `.ipc` | jdeworks: binary/arrow |
| `.ips` | jdeworks: text/crash |
| `.jfif` | open-file-viewer: image |
| `.json5` | jdeworks: text/json |
| `.jsonc` | jdeworks: text/json |
| `.jsonl` | jdeworks: text/jsonl |
| `.jws` | flyfish: signature |
| `.key` | flyfish: apple-keynote, jdeworks: text/pem, open-file-viewer: office |
| `.kicad_dru` | jdeworks: text/kicad |
| `.kicad_mod` | jdeworks: text/kicad |
| `.kicad_prl` | jdeworks: text/kicad |
| `.kicad_pro` | jdeworks: text/kicad |
| `.kicad_sym` | jdeworks: text/kicad |
| `.kicad_wks` | jdeworks: text/kicad |
| `.kml` | flyfish: geo, jdeworks: text/kml, open-file-viewer: gis |
| `.kube` | jdeworks: text/kubeconfig |
| `.kubeconfig` | jdeworks: text/kubeconfig |
| `.ldjson` | jdeworks: text/jsonl |
| `.lnk` | jdeworks: binary/lnk |
| `.lot` | jdeworks: text/json |
| `.lrc` | flyfish: code |
| `.lrf` | jdeworks: ebook/lrf |
| `.lrx` | jdeworks: ebook/lrf |
| `.m2v` | jdeworks: VIDEO |
| `.m3u8` | flyfish: video, open-file-viewer: video |
| `.m4b` | jdeworks: AUDIO |
| `.macho` | flyfish: binary-inspector |
| `.markdown` | flyfish: markdown, jdeworks: markdown |
| `.mat` | jdeworks: binary/mat |
| `.mbox` | flyfish: email, jdeworks: mbox, open-file-viewer: email |
| `.mbtiles` | jdeworks: binary/mbtiles |
| `.mdmp` | jdeworks: binary/dmp |
| `.mdown` | jdeworks: markdown |
| `.mermaid` | flyfish: drawing |
| `.mkd` | jdeworks: markdown |
| `.mmcif` | jdeworks: text/cif |
| `.mmd` | flyfish: drawing |
| `.mmp` | jdeworks: binary/lmms |
| `.mmpz` | jdeworks: binary/lmms |
| `.mobi` | jdeworks: ebook/mobi |
| `.mol` | jdeworks: text/sdf |
| `.mpe` | open-file-viewer: video |
| `.mpfa` | jdeworks: text/bio |
| `.mpk` | jdeworks: binary/msgpack |
| `.mpv` | open-file-viewer: video |
| `.msg` | flyfish: email, jdeworks: binary/msg, open-file-viewer: email |
| `.msgpack` | jdeworks: binary/msgpack |
| `.msh` | jdeworks: text/hl7 |
| `.mt` | jdeworks: text/mt940 |
| `.mt940` | jdeworks: text/mt940 |
| `.mt942` | jdeworks: text/mt940 |
| `.ndjson` | jdeworks: text/jsonl |
| `.nfo` | jdeworks: text/asciiart |
| `.nii` | jdeworks: binary/nifti |
| `.npmignore` | jdeworks: text/gitignore |
| `.numbers` | flyfish: apple-numbers, open-file-viewer: office |
| `.oas` | flyfish: eda, open-file-viewer: cad |
| `.oasis` | flyfish: eda, open-file-viewer: cad |
| `.odp` | flyfish: open-document, jdeworks: office/odf, open-file-viewer: office |
| `.odt` | flyfish: open-document, jdeworks: office/odf, open-file-viewer: office |
| `.ofc` | jdeworks: text/ofx |
| `.ofd` | flyfish: ofd, open-file-viewer: ofd |
| `.ofx` | jdeworks: text/ofx |
| `.oga` | flyfish: audio, jdeworks: AUDIO, open-file-viewer: audio |
| `.ogv` | jdeworks: VIDEO, open-file-viewer: video |
| `.olb` | flyfish: eda |
| `.p7b` | flyfish: signature, jdeworks: text/pem |
| `.p7c` | flyfish: signature, jdeworks: text/pem |
| `.p7m` | flyfish: signature |
| `.p7s` | flyfish: signature |
| `.pages` | flyfish: apple-pages |
| `.parquet` | flyfish: data-asset, jdeworks: binary/parquet, open-file-viewer: asset |
| `.patch` | jdeworks: text/patch |
| `.pdb` | jdeworks: text/pdb |
| `.pdd` | flyfish: photoshop-design |
| `.pem` | jdeworks: text/pem |
| `.pjpe` | open-file-viewer: image |
| `.pjpeg` | open-file-viewer: image |
| `.pkcs7` | flyfish: signature |
| `.plantuml` | flyfish: drawing |
| `.plist` | jdeworks: text/plist |
| `.pom` | jdeworks: text/xml |
| `.pot` | flyfish: office-presentation-binary |
| `.potm` | flyfish: office-presentation, open-file-viewer: office |
| `.pps` | open-file-viewer: office |
| `.ppsm` | flyfish: office-presentation, open-file-viewer: office |
| `.ppt` | flyfish: office-presentation-binary, open-file-viewer: office |
| `.prettierignore` | jdeworks: text/gitignore |
| `.procreate` | jdeworks: image/procreate |
| `.properties` | jdeworks: text/ini |
| `.props` | jdeworks: text/xml |
| `.proto` | jdeworks: text/proto |
| `.prproj` | jdeworks: text/prproj |
| `.psdt` | flyfish: photoshop-design |
| `.puml` | flyfish: drawing |
| `.pyc` | jdeworks: binary/pyc |
| `.pyo` | jdeworks: binary/pyc |
| `.qfx` | jdeworks: text/ofx, jdeworks: text/qif |
| `.qif` | jdeworks: text/qif |
| `.rdp` | jdeworks: text/rdp |
| `.reg` | jdeworks: text/reg |
| `.resx` | jdeworks: text/xml |
| `.rm` | jdeworks: AUDIO |
| `.rmvb` | jdeworks: AUDIO |
| `.rss` | jdeworks: text/xml |
| `.rtf` | flyfish: open-document, jdeworks: text/rtf, open-file-viewer: office |
| `.s3db` | jdeworks: sqlite |
| `.sab` | open-file-viewer: cad |
| `.sarif` | jdeworks: text/sarif |
| `.sat` | open-file-viewer: cad |
| `.sce` | flyfish: signature |
| `.scs` | flyfish: signature |
| `.sd` | jdeworks: text/sdf |
| `.sdf` | jdeworks: text/sdf |
| `.shp` | flyfish: geo, jdeworks: binary/shapefile, open-file-viewer: gis |
| `.sig` | flyfish: signature |
| `.sketch` | jdeworks: image/sketch |
| `.sl3` | jdeworks: sqlite |
| `.sldasm` | open-file-viewer: cad |
| `.sldprt` | open-file-viewer: cad |
| `.snd` | open-file-viewer: audio |
| `.srt` | jdeworks: text/subtitle |
| `.ssh-config` | jdeworks: text/ssh-config |
| `.sta` | jdeworks: text/mt940 |
| `.strings` | jdeworks: text/strings |
| `.stringsdict` | jdeworks: text/strings |
| `.svgz` | jdeworks: image/svg |
| `.tab` | jdeworks: text/csv |
| `.targets` | jdeworks: text/xml |
| `.text` | jdeworks: text/yaml |
| `.thrift` | jdeworks: text/thrift |
| `.tldraw` | open-file-viewer: drawing |
| `.toml` | jdeworks: text/toml |
| `.topojson` | jdeworks: text/geojson, open-file-viewer: gis |
| `.torrent` | jdeworks: binary/torrent |
| `.tsd` | flyfish: signature |
| `.tsq` | flyfish: signature |
| `.tsr` | flyfish: signature |
| `.tst` | flyfish: signature |
| `.txt` | jdeworks: text/chat, jdeworks: text/yaml |
| `.typst` | flyfish: typst |
| `.umd` | flyfish: umd |
| `.url` | jdeworks: text/url |
| `.vhd` | jdeworks: emulator/v86 |
| `.vob` | jdeworks: VIDEO |
| `.vtt` | jdeworks: text/subtitle |
| `.wad` | jdeworks: binary/wad |
| `.weba` | flyfish: audio, jdeworks: AUDIO, open-file-viewer: audio |
| `.webarchive` | flyfish: data-asset, open-file-viewer: asset |
| `.webloc` | jdeworks: text/url |
| `.wma` | jdeworks: AUDIO, open-file-viewer: audio |
| `.wp` | flyfish: office-wordperfect |
| `.wp5` | flyfish: office-wordperfect |
| `.wp6` | flyfish: office-wordperfect |
| `.wpd` | flyfish: office-wordperfect |
| `.wps` | open-file-viewer: office |
| `.wsdl` | jdeworks: text/xml |
| `.x_b` | open-file-viewer: cad |
| `.x_t` | open-file-viewer: cad |
| `.xhtml` | jdeworks: html |
| `.xla` | flyfish: spreadsheet-openxml |
| `.xlam` | flyfish: spreadsheet-openxml |
| `.xlt` | flyfish: spreadsheet-openxml, open-file-viewer: office |
| `.xltm` | flyfish: spreadsheet-openxml, open-file-viewer: office |
| `.xltx` | flyfish: spreadsheet-openxml, open-file-viewer: office |
| `.xsd` | jdeworks: text/xml |
| `.xsl` | jdeworks: text/xml |
| `.xslt` | jdeworks: text/xml |
| `.yaml` | jdeworks: text/yaml |
| `.yml` | jdeworks: text/yaml |

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
