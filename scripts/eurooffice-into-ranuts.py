#!/usr/bin/env python3
"""Puts Euro-Office's editors (github.com/Euro-Office, plain AGPL-3.0) into a
Ranuts/document checkout in place of the OnlyOffice build it ships.

Ranuts' public/ holds a third-party "offline" build of OnlyOffice 9.3: stock
sdkjs/web-apps plus two self-contained additions that make the editors run
with no Document Server:
  - sdkjs/<app>/sdk-all-min.js ends with an IIFE (window.isOffline = true) that
    answers the editor's server protocol in the page;
  - web-apps/apps/<app>/main/app.js carries an Offline controller that wraps
    Main.loadDocument to fake the license/auth handshake and load the file
    through x2t.
This takes Euro-Office's built sdkjs/web-apps (from its Document Server
package), carries those two additions over from the Ranuts tree, and keeps
Ranuts' own files (the x2t loader and worker, the font catalog and its
thumbnails).

Usage: eurooffice-into-ranuts.py EUROOFFICE_DOCUMENTSERVER_DIR RANUTS_CHECKOUT
  EUROOFFICE_DOCUMENTSERVER_DIR: var/www/euro-office/documentserver from the .deb
  RANUTS_CHECKOUT: its public/ still holding the OnlyOffice build
"""
import os, re, shutil, sys

EO, RANUTS = map(os.path.abspath, sys.argv[1:3])
PUB = os.path.join(RANUTS, 'public')
SDK_APPS = ['word', 'cell', 'slide', 'visio']
WEB_APPS = {'documenteditor': 'DE', 'spreadsheeteditor': 'SSE', 'presentationeditor': 'PE'}
SDK_GLUE = '\n(function(){window.isOffline=!0;'


def read(p):
    return open(p, encoding='utf-8').read()


def call_end(s, i):
    """Index just past the call starting at s[i] ("define(...)"), strings respected."""
    k, depth, quote = s.index('(', i), 0, None
    while k < len(s):
        c = s[k]
        if quote:
            if c == '\\':
                k += 2
                continue
            if c == quote:
                quote = None
        elif c in '"\'`':
            quote = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
            if depth == 0:
                return k + 1
        k += 1
    raise ValueError('unbalanced')


# 1. The glue, from the OnlyOffice build still in place
if not os.path.isfile(os.path.join(PUB, 'sdkjs/word/sdk-all-min.js')) or SDK_GLUE not in read(os.path.join(PUB, 'sdkjs/word/sdk-all-min.js')):
    sys.exit('public/ does not hold the OnlyOffice offline build (already converted?)')
sdk_glue = {}
for app in SDK_APPS:
    s = read(os.path.join(PUB, f'sdkjs/{app}/sdk-all-min.js'))
    sdk_glue[app] = s[s.index(SDK_GLUE):]
web_glue = {}
for app in WEB_APPS:
    s = read(os.path.join(PUB, f'web-apps/apps/{app}/main/app.js'))
    i = s.index(f'define("{app}/main/app/controller/Offline"')
    web_glue[app] = s[i:call_end(s, i)]

# 2. Ranuts' own files
keep = {}
# (themes.js: an empty presentation theme catalog standing in for the one a
# Document Server generates on install)
for rel in ['sdkjs/common/wasm', 'sdkjs/common/AllFonts.js', 'sdkjs/slide/themes/themes.js']:
    keep[rel] = os.path.join(PUB, rel)
thumbs = [f for f in os.listdir(os.path.join(PUB, 'sdkjs/common/Images')) if re.match(r'(fonts|themes)_thumbnail', f)]
stash = os.path.join(RANUTS, '.eurooffice-keep')
shutil.rmtree(stash, ignore_errors=True)
os.makedirs(os.path.join(stash, 'Images'))
for rel, p in keep.items():
    dst = os.path.join(stash, os.path.basename(rel))
    (shutil.copytree if os.path.isdir(p) else shutil.copy2)(p, dst)
for f in thumbs:
    shutil.copy2(os.path.join(PUB, 'sdkjs/common/Images', f), os.path.join(stash, 'Images', f))

# 3. Euro-Office's editors in their place (help pages and the develop tree left out)
for d in ['sdkjs', 'web-apps']:
    shutil.rmtree(os.path.join(PUB, d))
    shutil.copytree(os.path.join(EO, d), os.path.join(PUB, d), symlinks=True,
                    ignore=shutil.ignore_patterns('help') if d == 'web-apps' else shutil.ignore_patterns('develop'))
for rel in keep:
    dst = os.path.join(PUB, rel)
    src = os.path.join(stash, os.path.basename(rel))
    (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, dst)
for f in thumbs:
    shutil.copy2(os.path.join(stash, 'Images', f), os.path.join(PUB, 'sdkjs/common/Images', f))
shutil.rmtree(stash)

# Spell-check dictionaries (the offline OnlyOffice build had none)
if os.path.isdir(os.path.join(EO, 'dictionaries')):
    shutil.rmtree(os.path.join(PUB, 'dictionaries'), ignore_errors=True)
    shutil.copytree(os.path.join(EO, 'dictionaries'), os.path.join(PUB, 'dictionaries'))

# 4. The glue into them
# The glue patches DocsCoApi (the WebSocket client), which the offline build
# exported and a stock build keeps private; CDocsCoApi makes one on construction
EXPORT_DOCSCOAPI = ('\n;(function(){var C=window.AscCommon;if(C&&!C.DocsCoApi&&C.CDocsCoApi)'
                    'C.DocsCoApi=new C.CDocsCoApi()._CoAuthoringApi.constructor})();')
for app, glue in sdk_glue.items():
    with open(os.path.join(PUB, f'sdkjs/{app}/sdk-all-min.js'), 'a', encoding='utf-8') as f:
        f.write(EXPORT_DOCSCOAPI + glue)
for app, ns in WEB_APPS.items():
    # Euro-Office bundles web-apps with webpack, so there is no global AMD define.
    # The module wraps Main.prototype.loadDocument, which Main binds as it
    # launches: its body runs right after Main is defined, with a define() that
    # just calls it
    p = os.path.join(PUB, f'web-apps/apps/{app}/main/app.js')
    s = read(p)
    key = f'{ns}.Controllers.Main=Backbone.Controller.extend('
    i = s.index(key)
    end = call_end(s, i + len(key) - 1)
    glue = ';(function(define){' + web_glue[app] + '})(function(name,deps,body){body()});'
    open(p, 'w', encoding='utf-8').write(s[:end] + glue + s[end:])

# 5. What the Document Server would do on install: api.js from its template (the
# cache-tag placeholder left in makes it skip the tag), and the loader script
# path that its build leaves for an inlining step
api = os.path.join(PUB, 'web-apps/apps/api/documents/api.js')
shutil.copy2(api + '.tpl', api)
for dirpath, _, files in os.walk(os.path.join(PUB, 'web-apps/apps')):
    for f in files:
        if f.endswith('.html'):
            p = os.path.join(dirpath, f)
            s = read(p)
            t = s.replace('../../../../../../sdkjs/common/device_scale.js?__inline=true', '../../../../sdkjs/common/device_scale.js')
            # The x2t loader (AscCommon.x2t, which the Offline controller converts
            # with) loads ahead of the sdk, as the offline build's RequireJS config has it
            t = re.sub(r'(allfonts:\s*"\.\./\.\./sdkjs/common/AllFonts",)',
                       r'\1\n                x2t:           "../../sdkjs/common/wasm/x2t/x2t_helper",', t)
            t = re.sub(r'(sdk:\s*\{\s*deps:\s*\[[^\]]*"socketio")(\s*\])', r'\1, "x2t"\2', t)
            if t != s:
                open(p, 'w', encoding='utf-8').write(t)
# Euro-Office's spell checker (hunspell, emscripten with assertions) sets its
# runtime hook from the engine's constructor, after startup has consumed it: the
# assignment aborts and the editor falls back to the asm.js engine. Call the
# hook directly when the runtime is already up
spell = os.path.join(PUB, 'sdkjs/common/spell/spell/spell.js')
late = 'Module.onRuntimeInitialized=function(){self.onEngineInit()}'
s = read(spell)
if late in s:
    open(spell, 'w', encoding='utf-8').write(s.replace(late,
        'Module.calledRun?setTimeout(function(){self.onEngineInit()}):(' + late + ')'))

print('Euro-Office editors in place:', ', '.join(sorted(os.listdir(os.path.join(PUB, 'web-apps/apps')))))
