#!/bin/sh
# Builds the JupyterLite site the .ipynb viewer loads (served by jupyterlite.js).
# Output: $JUPYTERLITE_DIR, default ~/git/jupyterlite-site/dist
set -e
out=${JUPYTERLITE_DIR:-$HOME/git/jupyterlite-site/dist}
work=$(dirname "$out")
mkdir -p "$work"
[ -x "$work/.venv/bin/jupyter" ] || {
    python3 -m venv "$work/.venv"
    # jupyterlab-myst renders MyST markdown (Jupyter Book chapters). Not jupytext:
    # opening .md as a notebook needs its server side, which JupyterLite hasn't
    "$work/.venv/bin/pip" install -q jupyterlite-core jupyterlite-pyodide-kernel jupyterlab-myst
}
# A terminal (File > New > Terminal): a shell in WebAssembly (cockle) over the same files
"$work/.venv/bin/pip" show -q jupyterlite-terminal 2>/dev/null || "$work/.venv/bin/pip" install -q jupyterlite-terminal
cd "$work"
cat > jupyter-lite.json <<'JSON'
{
  "jupyter-lite-schema-version": 0,
  "jupyter-config-data": {
    "terminalsAvailable": true
  }
}
JSON
# No --contents: the workspace is served as the file tree at run time
"$work/.venv/bin/jupyter" lite build --output-dir "$out"
