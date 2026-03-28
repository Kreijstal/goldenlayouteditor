const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const wsHandler = require('./ws-handler');

const app = express();
const port = process.env.PORT || 3000;

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

// Serve Ace worker and snippet files with correct MIME type
app.get('/worker-html.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/ace-builds/src-min-noconflict/worker-html.js'), {
    headers: { 'Content-Type': 'application/javascript' }
  });
});

app.get('/snippets/html.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/ace-builds/src-min-noconflict/snippets/html.js'), {
    headers: { 'Content-Type': 'application/javascript' }
  });
});

app.get('/worker-css.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/ace-builds/src-min-noconflict/worker-css.js'), {
    headers: { 'Content-Type': 'application/javascript' }
  });
});

app.get('/snippets/css.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/ace-builds/src-min-noconflict/snippets/css.js'), {
    headers: { 'Content-Type': 'application/javascript' }
  });
});

app.get('/worker-javascript.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/ace-builds/src-min-noconflict/worker-javascript.js'), {
    headers: { 'Content-Type': 'application/javascript' }
  });
});

app.get('/snippets/javascript.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/ace-builds/src-min-noconflict/snippets/javascript.js'), {
    headers: { 'Content-Type': 'application/javascript' }
  });
});

// Serve raw files from the workspace directory
app.get('/workspace-file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('Missing path parameter');

  const resolved = path.resolve(filePath);
  res.sendFile(resolved, (err) => {
    if (err) res.status(404).send('Not found');
  });
});

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
