# Binary Word documents and templates

The lazy `.doc`/`.dot` reader decodes the Compound File Binary container and MS-DOC document structures, then renders paragraphs, inline formatting, tables, embedded assets and tracked insertion/deletion marks. The review selector switches between all changes, accepted text and original text. Graphviz `.dot` files are preserved through CFB signature sniffing. Macros and OLE objects are not executed.

The reader is imported from the MIT-licensed Flyfish renderer-doc at e03662c883cdd089814d2d21e4c805b9d7320e0f. Core, MS-DOC parser, HTML renderer and types are retained; host-specific viewer code is replaced. Helpers that swallowed decoding errors have been adapted to propagate them. Structural parser warnings are displayed. Unsupported Word features, legacy versions, encrypted documents, unavailable fonts and best-effort layout remain reader limits; successful preview is not full Microsoft Word compatibility.

Parsing and generation of the three review views run in a local module worker with a 60-second deadline and 128 MiB source bound. DOMPurify sanitizes markup before a sandboxed iframe displays it. CSP allows inline generated styles and embedded data images, while blocking network resources and script execution. The original reader also blocks external links/resources by default. Workers terminate on completion, new picker loads and tab closure.

`npm run test:doc-binary` uses a native Word 97–2004 fixture with independent Word-saved original/final references. It checks actual table and revision markup, accepted/original text, both suffixes, Graphviz collision, local lazy loading, cancellation, malformed data and cleanup. Fixture provenance and MIT notices are retained.
