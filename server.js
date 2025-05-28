const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

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

// Optional: A simple route to confirm the server is running
app.get('/ping', (req, res) => {
  res.send('pong');
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});