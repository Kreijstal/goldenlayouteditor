# CD5 viewer

Open a `.cd5` file in goldenlayouteditor, or visit `/cd5-viewer/` for the standalone file picker. Select an independent raster layer, choose Fit/100%/200%/400%, and export that layer as PNG. Files decode locally in a dedicated worker; the viewer does not upload them.

Build and run:

```bash
npm install
npm run build
npm start
# http://localhost:3000/cd5-viewer/
```

## Supported scope

- CD5 v4 (through minor version 11), revision modes 1–4.
- Observed ACSC kernels 1 (RLE), 2 (gradient runs), 6 (grouped table index), 7 (sparse byte mask), 8 (LZ).
- Profiles 0–5: planar BGR/BGRA, grayscale/alpha, byte-indexed palettes, bit-packed palettes, solid BGRA, and decorrelated colour/alpha.
- Independent raster layers, including layers stored in animation documents. No animation playback or flattened document composition.
- Linked/reference layers remain listed but disabled. Native effects, blend modes, layer relationships and metadata are not applied. Initial preview bands are parsed and can be decoded, but are not displayed as layers.
- Encryption and other kernel IDs are unsupported and raise errors.

The decoder checks record/stream boundaries, backreferences and allocation sizes. It currently limits files/layer data to 256 MiB and raster dimensions to 32 million pixels. Worker termination cancels decoding on reopen or tab closure.

## Validation

On the official Chasys Photo 5.42.01 shipped corpus, this reader parsed **93 files / 784 layer descriptors**, decoded **8,577 bands** (including 188 initial preview bands), and converted **698 independent raster layers** to RGBA. The remaining **86 descriptors** have no independent pixel payload and require native relationships. These corpus-wide checks establish size consistency and supported profile coverage, not whole-document visual equivalence.

Separately, **50 codec cases** (ten per observed kernel) were compared byte for byte with the original Editor x86 routines executed in Unicorn. **18 raster conversions** (three per profile) were compared with its native colour-conversion routine. Missing-alpha colour/grayscale inputs are made opaque for Canvas. The Bristle Brush image also rendered in the browser with the same appearance as the native Viewer under BoxedWine.

Run the self-contained known-answer and browser checks (after build):

```bash
npm run test:cd5
# Optional local Chromium and complete vendor corpus:
TEST_CHROMIUM_PATH=/path/to/chromium CD5_CORPUS=/path/to/Extras/Content npm run test:cd5
```

The committed `scripts/fixtures/colours.cd5` is an original generated two-layer test image. No vendor executable, asset or codec binary is redistributed.

## Format findings beyond the provisional specification

- Header offset `0x10` is the descriptor count in these files, rather than an always-one plane count.
- Descriptor `0x19` is the channel/byte count; it is not bits per pixel.
- Pixel/metadata byte lengths are at descriptor offsets `0x20`/`0x24`; `0x1C` was zero in all 784 descriptors.
- Concatenate a layer's band outputs, then split at pixel length. The band word at `0x0C` supplies a last-band flag, not a pixel/metadata type.
- Some final codec outputs include 1–3 padding bytes. The native driver copies only the declared decoded band length; the reader accepts that bounded padding and rejects short or excessive output.
- Profile 3 stores `(index_bits-1)` in the low nibble of its first word and `(palette_entries-1)` in bits 4–19. The palette has that actual entry count, not an implied `2^bits` length.
- Gradient controls use the same literal/escape families as RLE. A gradient run emits its initial byte, then adds each nibble minus 7. LZ match lengths are increased by 2; length extensions use 3-bit groups and offset extensions 4-bit groups.

Evidence image: `chp_Editor.exe`, SHA-256 `fc77911c75cbb27cb3d0141a19d16c6c43fbf2fb1f851b96a271b7b504dc34c3`.
Kernel VAs: `0x456850`, `0x456BF0`, `0x457220`, `0x456F30`, `0x457610`; colour conversion: `0x44ED00`; legacy driver output copy: `0x44E243`.

This is an independent interoperability implementation, not a complete official CD5 specification.

To reproduce the native differential check with your own Editor and corpus:

```bash
python -m pip install unicorn
node scripts/cd5-native-vectors.js /path/to/Extras/Content /tmp/cd5-vectors.ndjson
python scripts/verify-cd5-native.py /path/to/chp_Editor.exe /tmp/cd5-vectors.ndjson
```

The intermediate vectors contain portions of your local corpus; they are not committed or redistributed. Unicorn executes the original routines and their memory helpers from the supplied PE; the comparison does not substitute JavaScript output for native decoding.
