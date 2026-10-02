// --- KiCad symbol libraries ---
// Finds the symbol libraries KiCad installed (and a project's own, through its
// sym-lib-table), indexes their symbols once, and hands out a symbol ready to
// embed in a schematic. Serves the "Add symbol" picker of the KiCanvas viewer.
const fs = require('fs');
const path = require('path');
const { childSpans, serialize, embedSymbol, unquote } = require('./src/kicad-sexpr');

const SYSTEM_DIRS = ['/usr/share/kicad/symbols', '/usr/local/share/kicad/symbols',
  '/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols', 'C:\\Program Files\\KiCad\\share\\kicad\\symbols'];

// Newest KICADn_SYMBOL_DIR first, then the usual install places
function systemDirs() {
  const fromEnv = Object.keys(process.env).filter(k => /^KICAD\d*_SYMBOL_DIR$/.test(k))
    .sort((a, b) => (parseInt(b.slice(5)) || 0) - (parseInt(a.slice(5)) || 0)).map(k => process.env[k]);
  return [...new Set([...fromEnv, ...SYSTEM_DIRS])].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch (_) { return false; }
  });
}

// nickname -> file, for the first install found and a project's sym-lib-table
function libraries(projectDir) {
  const libs = new Map();
  const dir = systemDirs()[0];
  if (dir) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.kicad_sym')) libs.set(f.slice(0, -10), path.join(dir, f));
  }
  if (projectDir) {
    let table = '';
    try { table = fs.readFileSync(path.join(projectDir, 'sym-lib-table'), 'utf8'); } catch (_) { /* none */ }
    for (const m of table.matchAll(/\(lib\s+\(name\s+("(?:[^"\\]|\\.)*"|[^\s()]+)\)[^]*?\(uri\s+("(?:[^"\\]|\\.)*"|[^\s()]+)\)/g)) {
      const uri = unquote(m[2]).replace(/\$\{(\w+)\}/g, (_, v) => v === 'KIPRJMOD' ? projectDir : (process.env[v] || (/SYMBOL_DIR$/.test(v) ? dir || '' : '')));
      if (uri.endsWith('.kicad_sym')) libs.set(unquote(m[1]), path.resolve(projectDir, uri));
    }
  }
  return libs;
}

const indexCache = new Map(); // file -> { mtime, symbols }

function prop(text, name) {
  const m = new RegExp(`\\(property\\s+"${name}"\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}

async function indexLibrary(file) {
  const mtime = (await fs.promises.stat(file)).mtimeMs;
  const cached = indexCache.get(file);
  if (cached && cached.mtime === mtime) return cached.symbols;
  const text = await fs.promises.readFile(file, 'utf8');
  const symbols = [];
  for (const span of childSpans(text)) {
    if (span.head !== 'symbol' || !span.name) continue;
    const body = text.slice(span.start, span.end);
    // Settings and properties come before the units' graphics
    const head = body.slice(0, body.search(/\(symbol\s+"[^"]*_\d+_\d+"/) >>> 0);
    const ext = /\(extends\s+"((?:[^"\\]|\\.)*)"/.exec(head);
    symbols.push({
      name: span.name, start: span.start, end: span.end,
      extends: ext ? ext[1] : null,
      desc: prop(head, 'Description') || prop(head, 'ki_description'),
      keywords: prop(head, 'ki_keywords'),
      power: /\(power\b/.test(head),
    });
  }
  indexCache.set(file, { mtime, symbols });
  return symbols;
}

// Symbols matching every word of the query, best matches first
async function search(query, projectDir, limit = 200) {
  const libs = libraries(projectDir);
  let q = String(query || '').trim().toLowerCase();
  let libFilter = null;
  const colon = q.indexOf(':');
  if (colon > 0) { libFilter = q.slice(0, colon); q = q.slice(colon + 1); }
  const words = q.split(/\s+/).filter(Boolean);
  const results = [];
  await Promise.all([...libs].map(async ([lib, file]) => {
    if (libFilter && !lib.toLowerCase().startsWith(libFilter)) return;
    let symbols;
    try { symbols = await indexLibrary(file); } catch (_) { return; }
    for (const s of symbols) {
      const name = s.name.toLowerCase();
      const hay = name + ' ' + lib.toLowerCase() + ' ' + s.keywords.toLowerCase() + ' ' + s.desc.toLowerCase();
      if (!words.every(w => hay.includes(w))) continue;
      const w0 = words[0] || '';
      const score = !w0 ? 3 : name === w0 ? 0 : name.startsWith(w0) ? 1 : name.includes(w0) ? 2 : 3;
      results.push({ lib, name: s.name, desc: s.desc, power: s.power, score });
    }
  }));
  // Device and power first among equals: they hold the everyday parts
  const libRank = l => l === 'Device' ? 0 : l === 'power' ? 1 : 2;
  results.sort((a, b) => a.score - b.score || libRank(a.lib) - libRank(b.lib) || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return { total: results.length, libraries: libs.size, results: results.slice(0, limit).map(({ score, ...r }) => r) };
}

// A symbol as a schematic's lib_symbols holds it, named "lib:name"
async function symbolText(lib, name, projectDir) {
  const file = libraries(projectDir).get(lib);
  if (!file) throw new Error(`No symbol library named ${lib}`);
  const symbols = await indexLibrary(file);
  const text = await fs.promises.readFile(file, 'utf8');
  const find = n => symbols.find(s => s.name === n);
  const sym = find(name);
  if (!sym) throw new Error(`${lib} has no symbol ${name}`);
  const parent = sym.extends ? find(sym.extends) : null;
  const slice = s => s && text.slice(s.start, s.end);
  return serialize(embedSymbol(slice(sym), lib, slice(parent)));
}

function register(app) {
  app.get('/kicad-symbols', async (req, res) => {
    try {
      res.json(await search(req.query.q, req.query.project));
    } catch (err) {
      res.status(500).send(err.message);
    }
  });
  app.get('/kicad-symbol', async (req, res) => {
    try {
      res.type('text/plain').send(await symbolText(req.query.lib, req.query.name, req.query.project));
    } catch (err) {
      res.status(404).send(err.message);
    }
  });
}

module.exports = { register, search, symbolText };
