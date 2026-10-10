# Shared host for modular upstream readers

The shared host initially enables BSON, CBOR and MessagePack (`.msgpack`, `.mpk`). These bounded readers inspect native structured values. They retain the upstream depth/item caps and unsupported-type labels; 64-bit values decoded through JavaScript Numbers can lose precision. This is an inspection preview, not an unlimited serialization engine.

Source is the MIT-licensed jdeworks/file-viewer commit f3934e9a75fe01d6fd74830e996a0111a7dc4fc2. `scripts/build-upstream.js` checks out that exact public commit, validates its ID, and copies the unmodified core/type/vendor/assets folders into the ignored local runtime directory. Native examples and the original application shell are not copied. Existing vendor license and notice files remain next to their assets. The project license is also retained under public/licenses/imported-viewers. To build from an existing checkout, set GOLDENLAYOUT_UPSTREAM_SOURCE; the same revision check still applies. Corresponding source and asset provenance are available at https://github.com/jdeworks/file-viewer/tree/f3934e9a75fe01d6fd74830e996a0111a7dc4fc2.

The GoldenLayout panel and a small trusted frame host replace the upstream app shell. Detector metadata loads only when that panel opens; each renderer and its vendor libraries still load individually through the original lazy imports. Input source previews retain the upstream opaque-origin sandbox. User scripts stay disabled. The trusted outer frame needs the same origin for local ESM/asset loading and uses a nonce plus checked origin/source for its host messages. CSP blocks off-origin dependencies.

The bridge uses an explicit ready handshake, rather than sending bytes on an initial about:blank load. It corrects CBOR's binary/text sniff collision for explicitly named structured binary formats and validates BSON document length/terminator before rendering. Host input is capped at 64 MiB, initialization at 15 seconds and rendering at 60 seconds. Tab removal, picker replacement and iframe disposal use the upstream cleanup/abort contracts. Decoder errors are reported, not replaced with a generic hex view.

The runtime contains other upstream modules for future batches, but their extensions are not counted as supported until enabled and tested. `npm run test:upstream` covers native map/record values, both MessagePack aliases, safe sandboxed output, picker replacement, zero startup/imported-runtime requests, local subdirectory assets, readiness cancellation, tab cleanup and invalid BSON. Inputs are generated from original synthetic data in scripts/upstream-fixtures.js.

## Native containers and binary inspection

The next batch enables `.f3d`, `.f3z`, `.sketch`, `.procreate`, `.mat`, `.dbf`, `.exe`, `.dll`, `.dylib`, `.macho`, `.class`, `.pyc`, `.pyo`, `.lnk` and `.torrent`.

| Family | Decoded preview | Limits |
| --- | --- | --- |
| Fusion | Thumbnail, manifest fields, archive entries | No reconstructed geometry |
| Sketch | Saved preview, page/artboard names and metadata | Upstream partial-support notice retained; no vector reconstruction |
| Procreate | Saved thumbnail pixels | No layers or full-resolution canvas |
| MATLAB | Uncompressed MAT v5 variable names, classes and dimensions | No array values, compressed matrices or v7.3 |
| DBF | Fields and first 20 records | No external memo-file contents |
| PE / Mach-O | Architecture, format, header fields, hash | No execution, disassembly or imported symbol reconstruction |
| Java class | Native class/constant-pool inspection | No Java execution |
| Python bytecode | Version, validation mode and header fields | Header inspection only; no disassembly |
| Windows links | Target strings, flags, sizes and timestamps | Links are not launched |
| Torrent | Bencoded file metadata | No tracker contact or downloads |

Original test generators in `scripts/upstream-native-fixtures.js` construct these native records. Tests check decoded fields and pixels, executable/class signature separation, lazy loading, picker changes and cancellation. Blob thumbnail bytes are embedded as data URLs before crossing into the opaque preview frame. The host revokes reader-created object URLs on replacement as well as tab close. Both virtual and server byte-routing tables are checked against all new viewer routes, with an Amiga IFF signature regression check.

## Mail, books and LMMS

`.eml` renders MIME headers and sanitized HTML/plain bodies; `.mbox` renders a message list with headers and text snippets. `.msg` reads Outlook compound-file properties and message bodies; attachment content and RTF bodies are explicitly unsupported. Its body additionally passes DOMPurify and a no-network CSP before display. Input scripts remain disabled.

`.mobi` and `.azw` render native MOBI/PalmDOC book text, with uncompressed and PalmDOC compression tested separately. DRM, HUFF/CDIC and KF8/AZW3 are unsupported; `.azw3` remains in the audit remainder. Reader settings remain available. MOBI text is sanitized before mounting.

`.mmp` and `.mmpz` inspect LMMS song metadata, tempo and track names without executing plugins or playing samples. Native MMPZ is Qt qCompress (a big-endian expanded-size prefix followed by zlib), as used in LMMS `src/core/DataFile.cpp`: https://github.com/LMMS/lmms/blob/master/src/core/DataFile.cpp. The host adapter decodes this exact wrapper with a 64 MiB expanded-size cap and verifies the declared size, then passes the native XML to the upstream renderer. The incorrect upstream gzip assumption is not used for native MMPZ.

`upstream-document-fixtures.js` authors native PalmDB/MOBI records, Outlook CFB properties, RFC822/MIME messages, mbox envelopes and Qt-compressed LMMS XML. Tests assert actual book/message/project contents, compression paths and script removal. All additional readers and codecs remain lazy.

## Structured text and binary property lists

Added `.ini`, `.cfg`, `.conf`, `.properties`, `.env`, `.toml`, `.yaml`, `.yml`, `.jsonc`, `.json5`, `.jsonl`, `.ndjson`, `.ldjson`, `.xsd`, `.xsl`, `.xslt`, `.wsdl`, `.pom`, `.csproj`, `.props`, `.targets`, `.resx`, `.rss`, `.atom`, `.plist`, `.stringsdict` and `.strings`. Config/JSON/YAML/TOML readers show parsed data; XML-family files show document structure without schema validation or transformation execution. Apple localization files show their native entries/structure. Application projects, environment values and stylesheet code are not executed.

JSON5 uses the real JSON5 2.2.3 parser, compiled to a separate local lazy module with its MIT notice retained. Single quotes, unquoted keys, trailing commas, NaN and infinities are tested. The last two display as named strings with a visible notice; comments are omitted from the parsed tree. Arbitrary JavaScript expressions are rejected, never evaluated.

The upstream plist reader supports XML only. A separate native binary-plist reader now decodes `bplist00` trailer/offset/reference tables, dictionaries, arrays/sets, null/bool, integers, reals, ASCII/UTF-16/UTF-8 strings, dates, data and UID. Its view uses explicit type tags for dates, UID, non-finite reals and integers outside JavaScript's exact range. Data shows at most the first 1024 bytes with its true size and truncation marker. It caps objects/collection lengths at 100,000, depth at 128 and strings at 4 MiB. Invalid offsets, cyclic references, duplicate dictionary keys and unsupported markers produce errors rather than printable-string approximations. The binary format/object markers are documented in Apple's CFBinaryPList.c; the MIT node-bplist-parser reader was also consulted, but its integer parser is not used.

`npm run test:upstream-text` uses original native text and Python plistlib-generated binary data, checking decoded values, nested references, Unicode, signed/large integers, dates, data, floats, JSON5 syntax, corrupt binary bounds and rejection of JavaScript expressions. The binary/native parsers remain lazy. Source syntax, values and schema-specific rendering are distinct: these extensions are counted as readable, while separate schema enhancements remain in the audit's enhancement list.

## Databases, sequence data and annotations

`.db3`, `.s3db` and `.sl3` use the native SQLite WASM reader, including in-memory SQL queries. `.gpkg` exposes GeoPackage tables and attributes through the same reader; geometry BLOBs are not mapped. `.mbtiles` shows archive metadata and zoom/tile counts only; raster/vector tiles are not decoded. Input databases are never mutated externally.

`.fa`, `.fasta`, `.fna`, `.faa`, `.ffn`, `.frn`, `.fsa` and `.mpfa` show FASTA sequence records; `.fq` and `.fastq` show FASTQ reads and Phred summaries. `.bed` shows genomic intervals. These use the upstream 2000-record preview cap. `.gff`, `.gff2`, `.gff3` and `.gtf` show feature counts and an added native nine-column feature table, capped at 1000 rows; malformed records are rejected. `.hl7`, `.hl7v2` and `.msh` show HL7 v2 message segments and fields. Here `.msh` means an HL7 MSH message, not Gmsh meshes.

`.bcf` uses an original worker decoder for native BCF 2.2, including individual BGZF blocks, typed INFO/FORMAT values, explicit header dictionaries, missing values and phased genotypes. It shows site fields and sample values without converting binaries to guessed text. BCF 1/2.1, indexing and writing are unsupported. Limits: 64 MiB input/expanded data, 4 MiB header, 1000 samples, 100000 elements per vector, at most 2000 rows and 200000 table cells. The preview explicitly identifies truncated rows. The specification is https://samtools.github.io/hts-specs/VCFv4.3.pdf, section 6.

`npm run test:upstream-data` creates original native databases (including a complete PNG tile), protein/nucleotide sequences, annotations, synthetic HL7 messages and a BGZF BCF fixture. It checks decoded fields, live SQL arithmetic, malformed BCF rejection, lazy loading and cleanup. The authored BCF fixture was independently accepted by HTSlib/pysam 0.23.3, and the decoder was also checked against an independently generated HTSlib BCF. No patient or external specimen data is included.

## Molecular structures

`.cif`, `.cif2`, `.mmcif`, `.pdb`, `.ent`, `.mol`, `.sd` and `.sdf` show native metadata plus an opt-in 3Dmol coordinate preview. Metadata loads no 3Dmol library; clicking Load 3D structure loads the local BSD-3-Clause vendor. `.pdb`/`.ent` mean Protein Data Bank, not Microsoft debug files. CIF2 support is limited to CIF1-compatible scalar/loop data; CIF2 containers and triple-quoted strings are unsupported and labeled. SDF/MOL supports V2000/V3000 summaries, up to five molecule metadata records and the first molecule's coordinate view; it does not generate a 2D chemical depiction.

The build patches the pinned `core/molview.js` only for lifecycle cleanup: replacing/closing a file stops spinning, loses the WebGL context, and prevents an in-flight library load from mounting after disposal. Native parsers and representation controls remain upstream. `npm run test:upstream-molecules` checks original coordinates and elements through the native 3Dmol parser, actual molecular canvas pixels, all eight routes, local assets and cleanup.

## Specialist text formats

The next 33 extensions are `.srt`, `.vtt`, `.diff`, `.patch`, `.gitignore`, `.dockerignore`, `.npmignore`, `.eslintignore`, `.prettierignore`, `.hgignore`, `.ssh-config`, `.proto`, `.thrift`, `.reg`, `.rdp`, `.kube`, `.kubeconfig`, `.har`, `.sarif`, `.geojson`, `.topojson`, `.kml`, `.mt`, `.mt940`, `.mt942`, `.sta`, `.ofx`, `.qfx`, `.qif`, `.rtf`, `.dockerfile`, `.url` and `.webloc`.

These show parsed cues, changes, ignore patterns, SSH/RDP/Kubernetes settings, schema declarations, registry values, HTTP entries, security findings and financial transactions. GeoJSON draws local SVG geometry without map tiles; TopoJSON and KML currently show structure/coordinate summaries only, explicitly labeled. Proto/Thrift show declarations without import resolution or full-language validation. RTF shows text and basic formatting; its existing partial-layout notice remains visible. Financial numbers use upstream JavaScript Number parsing and display precision, not an accounting engine. Links, connection settings, container instructions and registry entries are inspected without executing or contacting their targets.

URL shortcuts now extract the actual URL from InternetShortcut INI or XML Webloc, rather than interpreting the complete container as a URL. Binary Webloc is not yet supported. Two pinned parser patches correct real edge cases: SWIFT's final field must match JavaScript end of input (not the non-JavaScript `\Z`), and the final Thrift field can omit a delimiter. Build anchors fail if the pinned source changes. `npm run test:upstream-specialists` verifies original native input across all 33 extensions, parsed closing balances and schema field IDs, registry values, Unicode/basic RTF formatting, actual GeoJSON SVG geometry, zero off-origin requests and disposal.

## Signatures and evidence containers

Seventeen more extensions use the Apache-2.0 Flyfish native structured parsers: `.p7m`, `.p7s`, `.p7b`, `.p7c`, `.pkcs7`, `.cms`, `.cmsc`, `.tsd`, `.tst`, `.tsq`, `.tsr`, `.asics`, `.scs`, `.asice`, `.sce`, `.ers` and `.jws`. Parser source is copied unmodified from the pinned `packages/renderers/signature/src` into `src/imported-signature`; licenses/notices identify that source and JSZip. The host adds a worker and a text-safe semantic inspection tree. Its parser modules split into individual chunks and load only when that family is opened. No OpenPGP WASM is included in this batch.

The native tree exposes CMS signers, certificate summaries, CAdES attributes, attached/detached state, timestamp message imprints and status, RFC 5544 metadata, RFC 4998 evidence chains, ASiC members and JWS headers/payload structure. Binary content shows its size and first 32 bytes. Attached CMS digest and cryptographic signature checks remain available; those checks do not establish certificate-chain trust, revocation, timestamp-policy compliance or full archival validation. ASiC signature members are listed, not automatically recursively validated; JWS has no supplied verification keys. External references and key locations are never fetched.

Input is bounded at 64 MiB; ASN.1 has the retained 25000-node/96-depth limits, and ASiC retains archive preflight, CRC, size/ratio/path limits with a lowered 64 MiB total expansion limit. Each worker has a 20-second deadline and is terminated on completion, error, replacement or tab close. `npm run test:signatures` creates original synthetic signed documents, CAdES, certificate bags, RFC 3161/5544/4998 records, ASiC and RSA JWS. OpenSSL creates ephemeral test keys, which are deleted and never committed. Tests verify semantic fields, attached CMS cryptographic checks, rejection of malformed ASN.1 and traversal archives, no off-origin requests, lazy startup and disposal.

## Certificates and native structure inspections

`.pem`, `.crt`, `.cer` and `.der` show parsed X.509 names, validity, serials and public-key fields from real certificate structures; no chain-trust claim is made. `.nii` shows NIfTI-1 header/dimension/type/spacing fields only, with the upstream no-voxel/orientation-rendering notice retained. `.shp` shows header bounds and record-type counts, without drawn geometry or DBF/PRJ sidecars. `.wad` shows native lump directories/categories, and `.bsp` shows native headers/entities, without game rendering. `.dmp`/`.mdmp` show Windows minidump streams and selected process/system fields, not a stack unwinder/full-memory dump reader. `.crash` and `.ips` parse Apple report fields and frames; no symbolication is attempted. `.acf` shows Steam AppState fields without launching or installing anything.

`npm run test:upstream-inspections` checks 13 original native fixtures: public test certificates generated by OpenSSL (ephemeral key deleted), NIfTI with actual voxel payload, a native Shapefile point, WAD lump bytes, BSP entities, minidump system/process streams, synthetic crash reports and a Valve KeyValues manifest. It checks real decoded fields plus lazy loading, no external requests and disposal. These explicit structure-only scopes count as extension readers in the comparison; they do not claim full rendering fidelity.

## Music, media projects and KiCad

Twelve more extensions are `.abc`, `.als`, `.prproj`, `.h2song`, `.h2pattern`, `.h2drumkit`, `.kicad_pro`, `.kicad_prl`, `.kicad_mod`, `.kicad_sym`, `.kicad_wks` and `.kicad_dru`. ABC renders native music notation to local SVG through the vendored MIT abcjs. Ableton/Premiere show metadata, track names and native counts, not audio/timeline playback. Their gzip streams are expanded incrementally with a 64 MiB limit and XML validation before the upstream metadata reader.

Hydrogen song/pattern data is XML, while real `.h2drumkit` is a gzip TAR archive. The added bounded TAR reader validates checksums, entry sizes and safe paths, then reads its single regular `drumkit.xml`; samples are not played. The pinned Hydrogen reader is patched to recognize modern `<drumkit>` as well as legacy `<hydrogen_drumkit>`. Only regular classic/USTAR paths are supported; GNU long-name/PAX path overrides are not interpreted. The native container distinction is documented by https://hydrogen-music.org/documentation/manual/manual_en_chunked/ch21.html.

The upstream KiCad reader incorrectly treats JSON project/local settings as S-expressions. Our separate native structure view parses JSON for `.kicad_pro`/`.kicad_prl`, and strict S-expressions for footprint/symbol/worksheet/rule definitions, with a 2 MiB / 25000-token / 64-level boundary. These are structure previews, not reconstructed boards or drawings. Native settings are documented at https://dev-docs.kicad.org/en/components/settings/.

`npm run test:upstream-projects` constructs original native compressed projects, a USTAR/gzip Hydrogen drumkit, native XML songs/patterns, both KiCad JSON formats and four S-expression formats. It checks decoded names/fields, actual musical-score SVG pixels, local assets and disposal.

## Text aliases, legacy art, G-code and compressed SVG

Twelve more extensions are `.markdown`, `.mdown`, `.mkd`, `.txt`, `.text`, `.lot`, `.tab`, `.ans`, `.nfo`, `.diz`, `.gc` and `.svgz`. Markdown uses the vendored local markdown-it renderer; `.lot` is the JSON alias advertised by the reference viewer, and `.tab` means TSV, not MapInfo data. Plain text opens a text-safe preview with automatic specialist detection where applicable. Legacy art explicitly decodes CP437 (or BOM-marked UTF-8) before ANSI SGR coloring; cursor positioning/terminal emulation is unsupported.

`.gc` shows G-code metadata plus an original bounded XY linear toolpath for G0/G1, G20/G21 and G90/G91. Arcs and coordinate resets/offsets are rejected, and instructions are not executed. `.svgz` expands gzip with the same 64 MiB streaming limit, validates XML, then uses the upstream SVG visual renderer and external-resource/executable-markup sanitizer.

`npm run test:upstream-textual` checks actual Markdown headings/tables, TSV cells, CP437 box glyphs and ANSI color spans, native G-code SVG paths, and red SVGZ pixels while rejecting script execution and remote SVG image fetches.

## Typst documents

`.typst` compiles native Typst source with the local Apache-2.0 Typst.ts 0.7.0 WASM compiler and renders its vector artifact as sanitized SVG pages. Compiler diagnostics are checked before rendering; an invalid source is rejected instead of producing an empty document. The compiler has a memory-only access model and no package registry; external files/packages are unavailable. Only the bundled DejaVu Sans Mono font is present. Source is limited to 2 MiB, SVG output to 32 MiB and the worker to 30 seconds; completion, cancellation and errors terminate the worker. These output limits do not constitute a strict native heap cap.

`npm run build:typst` checks package versions and the pinned Flyfish font source. Retained licenses include the exact upstream Apache-2.0 text omitted by the native npm packages and the font notices. `npm run test:typst` compiles an original document with text and a colored rectangle, checks vector paths/pixels, invalid-source rejection, lazy loading, zero external requests and disposal.

## UMD books and Mermaid diagrams

`.umd` reads native text-book sections, UTF-16 metadata/chapter titles, zlib-compressed text and chapter offsets through an adapted Apache-2.0 Flyfish parser. This profile rejects raw-deflate guesses, failed decompression, invalid section lengths/markers, inconsistent declared text lengths and invalid offsets. Comics and mixed-image UMD are unsupported. Limits: 2 MiB input, 8 MiB expanded text and a 20-second worker. Chapter strings enter the DOM through textContent.

`.mermaid` and `.mmd` render native diagrams using local MIT Mermaid 12.1.0, loaded only on request. The pinned Flyfish resource guard rejects image metadata and remote resources before rendering. Configuration directives are unavailable; Mermaid uses strict security, SVG text labels, a 64 KiB source cap and 250-edge cap. Generated SVG is sanitized, links removed and output limited to 8 MiB. Tests render actual two-node diagrams and original UMD chapters, verify literal malicious text, invalid-input errors, blocked external resources, zero startup requests and disposal.

## OpenDocument packages and flat XML

`.odt`, `.odp`, `.fodt`, `.fodp` and `.fods` have a native namespace-aware content reader. It shows text/headings, basic bold/italic spans, slide names and text, and table values with row/column repetition. It preserves literal text, spaces and line breaks. Spreadsheet formula values are cached/native values, never evaluated. Page layout, drawings, images, notes, macros, nested tables, encrypted packages and non-UTF-8 XML are unsupported; the panel reports its content-preview scope.

ODT/ODP validate native mimetype and manifest, ZIP entry paths/ranges/counts and declared expansion sizes with the retained Apache-2.0 Flyfish ZIP preflight. A local worker extracts only mimetype, content.xml and manifest.xml; their actual deflate output is bounded before collection and their length/CRC checked. Other package members are not extracted or CRC-verified. Input/declared aggregate expansion is capped at 32 MiB, selected XML at 4 MiB, worker duration at 20 seconds, XML elements at 75000, visible paragraphs at 10000, text at 2 MiB and table cells at 30000. Tables visibly truncate after 512 rows/128 columns. Flat XML requires the matching office:document mimetype and body family; external declarations are rejected.

`npm run test:odf` creates original native ZIP and flat XML documents, then checks actual text, bold spans, repeated numeric/boolean cells, slide names, literal script text, invalid XML/ZIP and mismatched package types, lazy loading, zero external requests and disposal. Archive inflation and CRC are native readers, not guessed text extraction.

## Detached OpenPGP signatures

`.sig` parses native binary or ASCII-armored detached OpenPGP signature packets using local OpenPGP.js 6.3.2. The view shows issuer key IDs/fingerprints, creation time, packet version, signature type and hash/public-key algorithm. It explicitly reports unverified status: signed content and a verification key are not supplied. No key fetching, private-key handling, trust inference or decryption runs in the viewer. Limits are 2 MiB input, 100 packets and a 20-second worker; malformed and unsupported packets are rejected.

`npm run test:openpgp` generates original ephemeral RSA signatures in binary and armored encodings, checks packet metadata against their public key and independently checks the issuer with GnuPG. Private keys never enter fixtures or the repository. OpenPGP.js is LGPL-3.0-or-later; its exact release source/build files, GPL/LGPL texts, attribution and integration rebuild instructions accompany the local runtime. The signature panel provides a download of the source archive. Tests verify actual fields, unverified labeling, malformed-input rejection, lazy loading and disposal.

## Saved web pages, timed lyrics and playlists

`.webarchive` decodes native binary/XML Apple plists and reads the main UTF-8 HTML/plain-text resource plus resource metadata. Binary-plist data is preserved in an explicit raw-data mode instead of the inspector's 1024-byte prefix. Limits: 32 MiB archive input, 8 MiB per resource, 16 MiB combined resource data, 1000 subresources and 4 MiB HTML. Other encodings, subframes and resource reconstruction are unsupported. `.xhtml` validates the native XHTML XML namespace/root and offers the same inert content preview (4 MiB input). DOMPurify removes scripts, styles, images, frames and active resources; anchors become text. Source previews remain in the opaque upstream iframe.

`.lrc` shows native lyric cues, multiple timestamps per line, metadata and millisecond offsets; enhanced word timing and audio playback are unsupported. `.m3u8` reads native UTF-8 M3U/HLS tag values, segment durations/titles, variant attributes and URIs. No segments, keys or nested playlists are fetched. Text is capped at 2 MiB and cues/items/tags at 10000; malformed timing/duration/header and dangling URI metadata produce errors.

`npm run test:browser-text` uses original Python plistlib-generated binary/XML archives (including HTML beyond 1024 bytes), XHTML, lyrics and an HLS playlist. It checks native tail text, stored resource metadata, exact timing/duration values, literal script lyrics, inert archived content, invalid input, lazy loading, zero external requests and disposal.

## EOT fonts, VHD containers and byte inspection

`.eot` validates native EOT 1/2/2.2 headers, UTF-16 names, padding, bounds and version-2.2 RootString checksum. Uncompressed SFNT and the specified XOR profile produce a temporary read-only FontFace specimen; font tables and embedding flags are checked before loading. Compressed MicroType Express, EUDC, nonempty roots or restrictive embedding flags receive metadata-only previews. The font is removed on replacement/disposal. Native layout: https://www.w3.org/submissions/EOT/.

`.vhd` checks native footer version/checksum, disk type, virtual size and fixed-image length. Dynamic/differencing containers also expose checksummed headers, block size/table entries and allocation counts, validating bounds and overlapping allocated blocks. This is container inspection, not filesystem browsing, parent reconstruction, mounting or VM execution. Limits: 64 MiB input, 32 MiB blocks and 1000000 table entries. Format/source references: https://www.microsoft.com/en-us/download/details.aspx?id=23850 and https://github.com/microsoft/azure-vhd-utils.

`.hex` matches the upstream binary-inspector meaning: raw bytes with hex offsets and ASCII, capped at 65536 displayed bytes. It does not parse Intel HEX records. `npm run test:binary-extras` creates original fixed/dynamic VHD containers and an EOT wrapper around the already licensed DejaVu font, checks actual header/allocation/checksum values, native FontFace glyph pixels and cleanup, byte values/ASCII, corrupt checksums/headers, lazy loading and zero external requests. The EOT fixture writer requires Python fontTools and the bundled Typst font from build:typst.

## Calendar aliases and free/busy interchange

`.icalendar` uses the existing lazy iCalendar event reader. `.ifb` adds native VFREEBUSY components: UID/organizer, FBTYPE, comma-separated UTC periods and explicit end times or positive RFC durations. Component nesting/end markers, real UTC dates, parameters and period ordering are checked. Events and availability stay separate; recurrence, TZID rule conversion and availability merging are not evaluated. Limits: 2 MiB UTF-8 input, 100000 lines, depth 64 and 10000 components/periods. `npm run test:calendar-extra` checks actual event/availability fields, exact duration-derived end times, malformed dates/components, lazy loading and disposal; existing imported calendar tests still pass.

## Excel add-ins and templates

`.xla`, `.xlam`, `.xlt`, `.xltm` and `.xltx` expose native worksheet cells and formula text in a local worker. BIFF compound workbooks require native Workbook/Book streams and add-in/template markers; OOXML requires the extension's actual workbook content type. Every ZIP member is inflated with an actual-output bound and checked against native length/CRC before SheetJS parses the package. XML is SAX-validated with no DTD. The reader does not execute macros/formulas or follow hyperlinks; cached values and formula strings are distinct.

Limits: 32 MiB input/declared ZIP expansion, 8 MiB entries, 4 MiB XML, 75000 XML elements, 32 sheets, 512 rows/128 columns, 30000 displayed cells and a 20-second worker. Visible truncation is labeled. Formatting, charts and embedded objects are not reconstructed. These input/output caps are not a strict JavaScript heap limit. Local Apache-2.0 SheetJS 0.18.5 matches the pinned upstream reader's version; native CFB/ZIP/XML dependencies and licenses are retained. Shared bounded ZIP extraction is also used by ODF.

`npm run test:sheetaliases` generates native BIFF add-in/template records and correct OOXML package types, checks actual cell values and literal script strings for all five aliases, rejects wrong package types and malformed containers, and verifies lazy loading/disposal/zero external requests. ODF tests passed again after the shared ZIP extraction refactor.

## Photoshop, Illustrator and JPEG aliases

`.pdd` and `.psdt` read native PSD version-1 8-bit RGB composites and layer names with MIT ag-psd 30.2.0 in a local worker. Input is capped at 64 MiB, composite at 16 megapixels, layer names at 10000/depth 64 and worker at 20 seconds. Layer pixels are not recomposited or edited. PSB, CMYK and 16/32-bit profiles are unsupported.

`.ait` renders the native PDF-compatible Illustrator template profile through local Apache-2.0 PDF.js with evaluation disabled. It previews the first 50 pages, at most 1280 pixels per page and 16 megapixels combined, and destroys the native document/worker on completion or failure. Illustrator private edit data and PostScript-only templates are unsupported. The fixture is an original PDF-compatible template preview, not a claim that private Illustrator editing structures were decoded.

`.jfif`, `.pjpe` and `.pjpeg` use native browser JPEG decoding after segment/frame/dimension checks (8-bit sequential/progressive frames, 16-megapixel cap). JFIF requires its actual APP0 marker. The decoder's bitmap is released after drawing. `npm run test:adobealiases` authors PSD composites, progressive/sequential JPEGs and a PDF-compatible template, checks actual red pixels for all six extensions, malformed headers/PDF errors, worker cleanup, lazy loading and zero external requests. These are decoded previews rather than extension-only dispatch claims.
