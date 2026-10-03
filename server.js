const express = require('express');
const http = require('http');
const path = require('path');
const { realPath } = require('./virtual-path');
const fs = require('fs');
const archiver = require('archiver');
const { WebSocketServer } = require('ws');
const wsHandler = require('./ws-handler');

const app = express();
const port = process.env.PORT || 3000;

// Cross-origin isolation, for SharedArrayBuffer (WebAssembly threads: the Rust
// toolchain, WASI programs in Wanix). credentialless rather than require-corp,
// so CDN scripts and images that send no CORP header still load (without
// cookies). Workers and same-origin frames need it as well as the page.
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

// In-memory store for preview files (shared with WS handler)
const previewFiles = new Map();

function getMimeType(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  const types = {
    html: 'text/html', htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
  };
  return types[ext] || 'text/plain';
}

// DEFAULT_MODE=browse: a bare / opens the file browser; /?project opens project mode
if (process.env.DEFAULT_MODE === 'browse') {
  app.get('/', (req, res, next) => {
    if (Object.keys(req.query).length) return next();
    res.redirect('/?browse');
  });
}

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve preview files from in-memory store
app.get('/preview-output/*filePath', (req, res) => {
  const filePath = req.params.filePath[0] || 'preview.html';
  if (previewFiles.has(filePath)) {
    res.set('Content-Type', getMimeType(filePath));
    res.set('Cache-Control', 'no-cache');
    res.send(previewFiles.get(filePath));
  } else {
    res.status(404).send('Not found');
  }
});

// Surfer waveform viewer (VCD/FST/GHW): the web build is only published as the
// hosted app, so it is passed through from there and runs same-origin with the
// editor (it can then read /workspace-file URLs, zip entries included).
const SURFER_ORIGIN = 'https://app.surfer-project.org';
app.get(/^\/surfer(\/.*)?$/, async (req, res) => {
  const sub = req.params[0] || '/';
  if (sub === '/' && !req.path.endsWith('/')) return res.redirect(301, '/surfer/');
  if (sub.includes('..')) return res.status(400).send('Bad path');
  try {
    const headers = {};
    if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match'];
    const upstream = await fetch(SURFER_ORIGIN + (sub === '/' ? '/index.html' : sub), { headers });
    res.status(upstream.status);
    for (const h of ['content-type', 'cache-control', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    if (upstream.status === 304) return res.end();
    let body = Buffer.from(await upstream.arrayBuffer());
    if (sub === '/' || sub === '/index.html') {
      // Surfer's own service worker would take over /surfer/ from ours (zip support)
      body = Buffer.from(body.toString('utf8').replace(/navigator\.serviceWorker\.register\([^)]*\)/g, 'Promise.resolve()'));
      res.removeHeader('etag');
    }
    res.send(body);
  } catch (err) {
    res.status(502).send('Could not reach ' + SURFER_ORIGIN + ': ' + err.message);
  }
});

// git in the in-browser shell (src/wanix-git.js) reaches remotes through here, as
// isomorphic-git's CORS proxy does: /cors-proxy/<host>/<repo path>/info/refs?…,
// …/git-upload-pack and …/git-receive-pack (git's smart HTTP), nothing else
const GIT_PATH_RE = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_HEADERS = ['accept', 'content-type', 'authorization', 'git-protocol', 'user-agent'];
app.options(/^\/cors-proxy\//, (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': GIT_HEADERS.join(', '),
  });
  res.sendStatus(204);
});
app.all(/^\/cors-proxy\/([^/]+)(\/.*)$/, async (req, res) => {
  const [host, rest] = [req.params[0], req.params[1]];
  const service = req.query.service;
  const ok = GIT_PATH_RE.test(rest) && (!rest.endsWith('/info/refs') || /^git-(upload|receive)-pack$/.test(service))
    && (req.method === 'GET' || req.method === 'POST') && /^[\w.-]+(:\d+)?$/.test(host);
  if (!ok) return res.status(403).send('Only git smart HTTP requests are passed on');
  try {
    const headers = {};
    for (const h of GIT_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
    if (!headers['user-agent']) headers['user-agent'] = 'git/isomorphic-git';
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const upstream = await fetch(`https://${host}${rest}${query}`, { method: req.method, headers, body });
    res.status(upstream.status);
    res.set('Access-Control-Allow-Origin', '*');
    for (const h of ['content-type', 'cache-control', 'www-authenticate']) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`Could not reach ${host}: ${err.message}`);
    else res.end();
  }
});

// Fritzing (github.com/Kreijstal/fritzing-app, wasm branch), Mogan STEM (TeXmacs
// fork, github.com/MoganLab/mogan), the office editor for .docx/.pptx (Euro-Office's
// editors with x2t as WebAssembly, scripts/build-eurooffice.sh) and the Rust
// toolchain (Rubrc, from its own site) are served from npm through jsDelivr or from
// upstream at /fritzing, /mogan, /office and /rubrc; see cdn-apps.js
require('./cdn-apps').register(app);

// EmulatorJS, webmscore, rhwp, the DICOM codecs, Capstone and OpenSCAD are built from
// source with the system emscripten (~/git/<name>/build.sh), published to npm as
// @kreijstal/<name> and loaded by the viewers from jsDelivr at pinned versions;
// ~/git/npm-publish/stage.sh packages them

// Serve raw files from the workspace directory
app.get('/workspace-file', (req, res) => {
  const filePath = realPath(req.query.path);
  if (!filePath) return res.status(400).send('Missing path parameter');

  const resolved = path.resolve(filePath);
  res.sendFile(resolved, (err) => {
    // also called when the client aborts mid-transfer; answering then would throw
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

// Upload a file: the request body, streamed to disk. Folders on the way are
// created (folder uploads); an existing file is kept unless overwrite=1
app.put('/upload-file', (req, res) => {
  const filePath = realPath(req.query.path);
  if (!filePath || !path.isAbsolute(filePath)) return res.status(400).json({ error: 'Missing or relative path' });
  const resolved = path.resolve(filePath);
  if (!req.query.overwrite && fs.existsSync(resolved)) return res.status(409).json({ error: 'already exists' });
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  // Into a temporary file first, so a broken upload leaves nothing half written
  const tmp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.upload-${process.pid}-${Date.now()}`);
  const out = fs.createWriteStream(tmp);
  const fail = (err) => {
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    if (!res.headersSent) res.status(500).json({ error: err.message });
  };
  req.on('aborted', () => fail(new Error('upload aborted')));
  out.on('error', fail);
  out.on('finish', () => {
    fs.rename(tmp, resolved, (err) => {
      if (err) return fail(err);
      res.json({ success: true, size: fs.statSync(resolved).size });
    });
  });
  req.pipe(out);
});

// Download a single file
app.get('/download-file', (req, res) => {
  const filePath = realPath(req.query.path);
  if (!filePath) return res.status(400).send('Missing path parameter');
  const resolved = path.resolve(filePath);
  res.download(resolved, path.basename(resolved), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

// Download a directory as a zip
app.get('/download-dir', (req, res) => {
  const dirPath = realPath(req.query.path);
  if (!dirPath) return res.status(400).send('Missing path parameter');
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(404).send('Directory not found');
  }
  const zipName = path.basename(resolved) + '.zip';
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName}"`);
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    if (!res.headersSent) res.status(500).send('Archive error');
  });
  archive.pipe(res);
  archive.directory(resolved, path.basename(resolved));
  archive.finalize();
});

// Symbol libraries for the KiCad viewer's "Add symbol"
require('./kicad-symbols').register(app);
require('./jupyterlite').register(app);

app.get('/ping', (req, res) => {
  res.send('pong');
});

// Create HTTP server and attach WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => wsHandler.handleConnection(ws, previewFiles));

server.listen(port, '0.0.0.0', () => {
  console.log(`Server listening at http://0.0.0.0:${port}`);
});
