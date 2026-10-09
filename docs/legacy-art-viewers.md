# Affinity previews, RIPscrip and NAPLPS

Opening `.afphoto`, `.afdesign`, `.afpub`, `.rip`, `.nap`, or `.naplps` selects
the corresponding viewer. The ordinary editor remains available as another
view. Each viewer also has an **Open** button for local files. Readers work
client-side with in-memory bytes and workspace/archive URLs through the existing
file resolver. Dependencies are served locally and loaded only when needed.

## Coverage

| Viewer | Coverage |
| --- | --- |
| Affinity | Embedded PNG images, largest pixel area selected first; a selector exposes other embedded PNGs. No layers, vector objects, effects, or JPEG previews. |
| RIPscrip | RIPtermJS v1.54 canvas rendering, including its bundled fonts. External icon resources and ANSI text windows are not displayed; upstream rendering remains experimental. Audio is disabled. |
| NAPLPS | TelidonP5's experimental geometry/color renderer, drawn immediately instead of progressively. Text, animation, and several control instructions remain incomplete. |

Legacy graphics run inside separate same-origin iframe documents so their global
variables, drawing state, and timers do not interfere with the editor or other
tabs. Closing the panel removes its frame and releases image object URLs.

The Affinity extractor is an independent implementation. It checks the Affinity
magic and walks embedded PNG chunk lengths through IEND; it does not scan for an
IEND substring in compressed pixel data. It is not derived from the
noncommercially licensed affinity-thumbnail-extractor project.

## Vendored dependencies

| Project | Revision / version | Location and license |
| --- | --- | --- |
| [RIPtermJS, Carl Gorringe](https://github.com/cgorringe/RIPtermJS) | `5bf9b4c411cdba3ae74b50ab7fee644318aa8ded` | `public/legacy-art/vendor/ripterm/`, MPL-2.0; upstream LICENSE included |
| [TelidonP5, Nick Fox-Gieg](https://github.com/n1ckfg/Telidon) | `13273487abb587247fa9c78b61534c436876a331` | `public/legacy-art/vendor/telidon/`, MIT; upstream LICENSE.txt included |
| [p5.js](https://github.com/processing/p5.js/tree/v0.6.0) | 0.6.0, as distributed with Telidon | `vendor/telidon/p5.min.js`, LGPL-2.1; p5-LICENSE.txt included; corresponding source available from the linked tag and `p5@0.6.0` npm package |

Local changes to upstream source: `NapDecoder.parseCommands()` preserves the
last instruction without a following opcode; `RIPterm.playStream()` flushes
the final RIP instruction at EOF without requiring a trailing newline.
`TelidonP5.js`, `BGI.js`, and p5.js are otherwise unchanged.

## Validation

```sh
npm install
npx playwright install chromium
npm run build
npm run test:legacy-art
```

Set `TEST_CHROMIUM_PATH` to use an already installed Chromium executable.
The browser checks generate actual PNG previews, verify selection by image
dimensions, assert rendered RIP/NAPLPS pixels, exercise EOF without delimiters,
and check tab cleanup. They use a minimal plugin harness served locally, without
loading the editor's unrelated CDN integrations.
