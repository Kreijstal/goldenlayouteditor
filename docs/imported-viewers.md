# Imported document viewers

Four browser-only viewers reuse MIT-licensed parsers/renderers and load on demand through the normal lazy plugin build. No conversion service or CDN is needed. Open them from the Plugins menu, their workspace-file viewer menu, or by dropping a matching file. Contacts and calendars have search; FictionBook has text-size controls; XMind has sheet tabs, pan, zoom and fit.

| Viewer | Upstream source, pinned revision | Local adaptation |
| --- | --- | --- |
| vCard (`.vcf`, `.vcard`) | [jdeworks/file-viewer](https://github.com/jdeworks/file-viewer/tree/f3934e9a75fe01d6fd74830e996a0111a7dc4fc2), `docs/types/vcard/vcardlib.js` | CommonJS parser, UTF-8 quoted-printable decoding and soft-line continuations, searchable contact cards using text nodes |
| iCalendar (`.ics`, `.ical`) | Same revision, `docs/types/ics/ics.js` | CommonJS parser, nested alarm isolation, explicit UTC/TZID/floating labels, searchable event cards |
| FictionBook (`.fb2`) | Same revision, `docs/types/ebook/fb2/renderer.js` | XML encoding detection, DOMPurify sanitization, raster-only embedded images, internal footnotes, sandboxed reader |
| XMind (`.xmind`) | [xushanpei/open-file-viewer](https://github.com/xushanpei/open-file-viewer/tree/6d85f230f0cf62320ffea146c2de6f15feb6cecb), `packages/core/src/plugins/xmind.ts` and its stylesheet | JavaScript renderer and scoped CSS, GoldenLayout host adapter, English controls, local JSZip, embedded-image cleanup and explicit parse failures |

Original copyright and full MIT notices are retained under `public/licenses/imported-viewers/`. JSZip 3.10.1 is used under its MIT option; DOMPurify 3.3.3 is used under its Apache-2.0 option. Their full upstream license files are retained there too.

## Scope

- vCard extracts common names, organizations, email, telephone, address, URL, birthday and notes. Contact photos and complete RFC semantics are not implemented.
- iCalendar lists VEVENT records. Recurrence rules are shown without expanding occurrences. TZID wall times are labeled, without VTIMEZONE interpretation or timezone conversion. All-day end dates are labeled exclusive. Calendar sniffing requires `BEGIN:VCALENDAR`, so `.ics` image files are not automatically routed here; `.vcf` requires `BEGIN:VCARD` to avoid genomic VCF files.
- FictionBook renders book bodies, headings, emphasis, poetry, tables, notes and embedded raster images. External links are displayed as text. ZIP-compressed `.fb2.zip` is not included.
- XMind reads modern `content.json` and legacy `content.xml` ZIP workbooks. It renders a tree diagram rather than reproducing every native layout/theme or relationship. The upstream topic/depth limits (2,000 topics, 128 levels) and resource limit (256 images) remain. Remote images are not fetched. Embedded image URLs are released when a file/tab closes or parsing fails.

Run `npm run build`, then `TEST_CHROMIUM_PATH=/path/to/chromium npm run test:imported-viewers`. The browser test exercises the production chunks, encoding and nested-component fixes, safe rendering, modern/legacy maps, controls, malformed input and URL cleanup. `npm run test:lazy-viewers` additionally checks startup requests and metadata parity for all 130 chunks.
