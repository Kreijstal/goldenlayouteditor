Vendored from https://github.com/lifeart/fla-viewer at commit 603f8f3fa84d0aadf0de12552072a4af5d5a355f.

The generated browser module used by the GoldenLayout plugin is:

```sh
npx esbuild vendor/fla-viewer-goldenlayout-entry.ts --bundle --format=esm --platform=browser --target=es2022 --alias:jszip=https://esm.sh/jszip@3.10.1 --alias:pako=https://esm.sh/pako@2.1.0 --outfile=public/fla-viewer/fla-viewer.js
```

The upstream parser handles ZIP/XFL-based FLA files. Older OLE Compound FLA
files are detected in the adapter and reported as unsupported.
