#!/bin/sh
# Builds the in-browser shell's Go programs (src/wanix-plugin.js) into public/:
#   wanix-rc.wasm        Wanix's rc shell, from its sources with scripts/wanix-rc.patch
#                        (a program it starts writes to the shell's own terminal; as
#                        released, the shell stalls once the program ends)
#   wanix-command.wasm   scripts/wanix-command: /bin/<name> for the commands the page runs
# Needs git and Go. WANIX_SRC (default: a checkout under node_modules/.cache) is the checkout used.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../public"
src=${WANIX_SRC:-$here/../node_modules/.cache/wanix-src}
rev=6594fe3763eb8712e81914f78b79243bb403f5cc # main, after 0.4.0-rc2 (whose kernel the page loads)

[ -d "$src/.git" ] || git clone -q --filter=blob:none https://github.com/tractordev/wanix.git "$src"
git -C "$src" fetch -q --depth 1 origin "$rev"
git -C "$src" -c advice.detachedHead=false checkout -q -f "$rev"
git -C "$src" apply "$here/wanix-rc.patch"
(cd "$src/rc" && GOWORK=off GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/wanix-rc.wasm" ./cmd/rc)
git -C "$src" checkout -q -- .

(cd "$here/wanix-command" && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/wanix-command.wasm" .)
