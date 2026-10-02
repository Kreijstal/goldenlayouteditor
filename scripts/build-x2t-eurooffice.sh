#!/bin/sh
# Builds x2t (the document converter) as WebAssembly from Euro-Office's core, with
# CryptPad's recipe (github.com/cryptpad/onlyoffice-x2t-wasm: Euro-Office core
# plus the changes that let it compile with emscripten). Their Dockerfile is run
# without Docker, stage by stage in bubblewrap (dockerfile-in-bwrap.py), with the
# host's emscripten (EMSCRIPTEN, default /usr/lib/emscripten) in place of the emsdk
# version it pins.
# Output: $X2T_WORK/stages/build/core/build/bin/linux_64/x2t.{js,wasm,wasm.br}
set -e
here=$(cd "$(dirname "$0")" && pwd)
work=${X2T_WORK:-$HOME/git/x2t-eurooffice-build}
recipe=${X2T_RECIPE:-$HOME/git/cryptpad-x2t-wasm}
mkdir -p "$work/tools/qmake-features"
[ -d "$recipe/.git" ] || git clone https://github.com/cryptpad/onlyoffice-x2t-wasm "$recipe"
# The recipe's base image, from the host: qmake is Qt 6's, bzip2 stands in for
# lbzip2, and a flag newer Qt adds that emscripten's clang rejects is switched off
ln -sf "$(command -v qmake6)" "$work/tools/qmake"
printf '#!/bin/sh\nexec bzip2 "$@"\n' > "$work/tools/lbzip2"; chmod +x "$work/tools/lbzip2"
cp "$recipe/embuild.sh" "$work/tools/embuild.sh"; chmod +x "$work/tools/embuild.sh"
echo '# emscripten clang has no -mno-direct-extern-access (host Qt 6.11 adds it)' > "$work/tools/qmake-features/no_direct_extern_access.prf"
# CMake 3 as in the recipe's Ubuntu 22.04 (x265, under heif, sets policies CMake 4 removed)
[ -x "$work/cmake3/bin/cmake" ] || { python3 -m venv "$work/cmake3" && "$work/cmake3/bin/pip" install -q 'cmake>=3.22,<3.32'; }
for t in cmake ctest cpack; do ln -sf "../cmake3/bin/$t" "$work/tools/$t"; done
# A read-only copy of the sources: stages hard-link to it, so any in-place write fails loudly
if [ ! -d "$work/ctx" ]; then
    rsync -a --exclude .git "$recipe/" "$work/ctx/"
    chmod -R a-w "$work/ctx/core"; find "$work/ctx/core" -type d -exec chmod u+w {} +
fi
cp "$here/dockerfile-in-bwrap.py" "$work/run-dockerfile.py"
cd "$work" && python3 run-dockerfile.py ctx build
ls -la "$work/stages/build/core/build/bin/linux_64/"x2t*
