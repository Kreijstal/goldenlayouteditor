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
