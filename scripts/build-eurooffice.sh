#!/bin/sh
# Builds the office editor the .docx/.pptx tabs load (served at /office): Euro-Office's
# editors (github.com/Euro-Office, a fork of OnlyOffice under plain AGPL-3.0) running
# entirely in the browser, in the shell of github.com/Ranuts/document (AGPL-3.0):
#   1. Ranuts/document at a tested commit, with ranuts-document.patch (saves made in
#      the editor go to the embedding page; the site works under any path);
#   2. its OnlyOffice build swapped for Euro-Office's, from the Document Server
#      package, by eurooffice-into-ranuts.py (which carries the serverless glue over);
#   3. x2t, the converter, built from Euro-Office's core by build-x2t-eurooffice.sh.
# Output: $OFFICE_SRC/dist (default ~/git/ranuts-document-eo/dist)
set -e
here=$(cd "$(dirname "$0")" && pwd)
src=${OFFICE_SRC:-$HOME/git/ranuts-document-eo}
eo_version=${EUROOFFICE_VERSION:-v9.3.5-rc.1}
eo_deb_dir=${EUROOFFICE_DEB_DIR:-$HOME/git/eurooffice-web}
x2t_dir=${X2T_DIR:-${X2T_WORK:-$HOME/git/x2t-eurooffice-build}/stages/build/core/build/bin/linux_64}
ranuts_commit=1301bb8

[ -f "$x2t_dir/x2t.wasm" ] || { echo "No x2t build in $x2t_dir: run build-x2t-eurooffice.sh first" >&2; exit 1; }

# 1. Ranuts/document, clean, at the tested commit
[ -d "$src/.git" ] || [ -f "$src/.git" ] || git clone https://github.com/Ranuts/document "$src"
cd "$src"
git checkout -q -- . && git clean -fdq public
git checkout -q "$ranuts_commit" 2>/dev/null || git -c advice.detachedHead=false checkout -q "$ranuts_commit"
git apply "$here/ranuts-document.patch"

# 2. Euro-Office's editors from its Document Server package
mkdir -p "$eo_deb_dir" && cd "$eo_deb_dir"
deb=$(ls euro-office-documentserver_*_amd64.deb 2>/dev/null | head -1)
if [ -z "$deb" ]; then
    gh release download "$eo_version" -R euro-office/DocumentServer -p 'euro-office-documentserver_*_amd64.deb'
    deb=$(ls euro-office-documentserver_*_amd64.deb | head -1)
fi
if [ ! -d deb/var/www/euro-office/documentserver/web-apps ]; then
    ar x "$deb" data.tar.xz && mkdir -p deb
    tar -xf data.tar.xz -C deb ./var/www/euro-office/documentserver/sdkjs \
        ./var/www/euro-office/documentserver/web-apps ./var/www/euro-office/documentserver/dictionaries
fi
python3 "$here/eurooffice-into-ranuts.py" "$eo_deb_dir/deb/var/www/euro-office/documentserver" "$src"

# 3. x2t built from Euro-Office's core (Ranuts' loader and worker stay)
cd "$src"
cp "$x2t_dir/x2t.js" public/sdkjs/common/wasm/x2t/x2t.js
brotli -f -q 11 -o public/sdkjs/common/wasm/x2t/x2t.wasm.br "$x2t_dir/x2t.wasm"

pnpm install --frozen-lockfile
(cd packages/shared && npx tsc -p tsconfig.json) # the patched BASE_PATH
pnpm run build
