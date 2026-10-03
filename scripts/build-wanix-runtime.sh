#!/bin/sh
# Builds Wanix itself, the runtime the in-browser shell runs in (src/wanix-plugin.js),
# from github.com/Kreijstal/wanix: Wanix with file watching (memfs implements
# fs.WatchFS; #watch streams the namespace's changes, which the editor's tree
# follows). Published as @kreijstal/wanix (~/git/npm-publish/stage-wanix.sh):
#   wanix.min.js, wanix.js, wanix.handle.js   go run buildjs.go (esbuild, as upstream)
#   wanix.debug.wasm                          the kernel built with Go (GOOS=js), as upstream's make wasm-go
#                                             but stripped (-s -w): jsDelivr serves no file over 20 MB
# Needs git, Go and npm. WANIX_OUT (default: node_modules/.cache/wanix-dist) gets the files;
# WANIX_FORK_SRC (default: a checkout under node_modules/.cache) is the checkout used.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${WANIX_OUT:-$here/../node_modules/.cache/wanix-dist}
src=${WANIX_FORK_SRC:-$here/../node_modules/.cache/wanix-fork}
rev=8161af74999434e8cc215018b5151d279cb26342 # branch watch: upstream main 6594fe3 and the watch commit

[ -d "$src/.git" ] || git clone -q --filter=blob:none https://github.com/Kreijstal/wanix.git "$src"
git -C "$src" fetch -q --depth 1 origin "$rev"
git -C "$src" -c advice.detachedHead=false checkout -q -f "$rev"
mkdir -p "$out"
cd "$src"
npm ci --no-audit --no-fund --ignore-scripts
GOWORK=off go run buildjs.go
GOWORK=off GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w -X tractor.dev/wanix.Version=$rev" -o dist/wanix.debug.wasm ./wasm
cp dist/wanix.min.js dist/wanix.js dist/wanix.handle.js dist/wanix.debug.wasm "$out/"
