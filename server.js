const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware for parsing JSON requests  
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// API to write files to disk
app.post('/api/writeFiles', (req, res) => {
  const { htmlContent, cssContent, jsContent } = req.body;
  
  try {
    // Create preview directory if it doesn't exist
    const previewDir = path.join(__dirname, 'public', 'preview');
    if (!fs.existsSync(previewDir)) {
      fs.mkdirSync(previewDir, { recursive: true });
    }
    
    // Write files to preview directory
    if (htmlContent !== undefined) {
      fs.writeFileSync(path.join(previewDir, 'index.html'), htmlContent);
    }
    if (cssContent !== undefined) {
      fs.writeFileSync(path.join(previewDir, 'style.css'), cssContent);  
    }
    if (jsContent !== undefined) {
      fs.writeFileSync(path.join(previewDir, 'script.js'), jsContent);
    }
    
    console.log('Files written to preview directory');
    res.json({ success: true });
  } catch (error) {
    console.error('Error writing files:', error);
    res.status(500).json({ success: false, error: error.message });
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

// Optional: A simple route to confirm the server is running
app.get('/ping', (req, res) => {
  res.send('pong');
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});