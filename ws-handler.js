const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

function log(...args) { console.log('[WS]', ...args); }
function warn(...args) { console.warn('[WS]', ...args); }

// Active PTY sessions keyed by session ID
const ptyProcesses = new Map();

// Active file watchers keyed by WebSocket
const fileWatchers = new Map();

// Files served via HTTP with specialized viewers (not loaded into memory as text)
const SERVED_EXTENSIONS = new Set([
  'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'svg',
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac',
]);

/**
 * Attach WebSocket message handlers to a client socket.
 * @param {WebSocket} ws - The client WebSocket connection.
 * @param {Map} previewFiles - Shared in-memory preview file store.
 */
function handleConnection(ws, previewFiles) {
  log('Client connected');

  // Send server config to client on connect
  const config = { type: 'serverConfig', debug: process.env.NODE_ENV !== 'production' };
  ws.send(JSON.stringify(config));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      const handler = messageHandlers[msg.type];
      if (handler) {
        if (msg.type !== 'clientLog' && msg.type !== 'termInput' && msg.type !== 'termResize') {
          log(`<- ${msg.type}`, msg.id ? `id=${msg.id}` : '', msg.path || '');
        }
        await handler(ws, msg, previewFiles);
      } else {
        warn('Unknown message type:', msg.type);
      }
    } catch (err) {
      console.error('[WS] Error handling message:', err);
      // Try to send error back if we can parse the id
      try {
        const msg = JSON.parse(data);
        if (msg.id) {
          ws.send(JSON.stringify({ type: 'error', error: err.message, id: msg.id }));
        }
      } catch (_) {}
    }
  });

  ws.on('close', () => {
    log('Client disconnected');
    // Clean up any PTY sessions for this client
    for (const [id, proc] of ptyProcesses) {
      if (proc._ws === ws) {
        proc.kill();
        ptyProcesses.delete(id);
        log('PTY session killed:', id);
      }
    }
    // Clean up file watcher
    const watcher = fileWatchers.get(ws);
    if (watcher) {
      watcher.close();
      fileWatchers.delete(ws);
      log('File watcher closed');
    }
  });
}

function reply(ws, msg) {
  log(`-> ${msg.type}`, msg.id ? `id=${msg.id}` : '', msg.error ? `ERROR: ${msg.error}` : '');
  ws.send(JSON.stringify(msg));
}

function startWatching(ws, workspacePath) {
  // Close any existing watcher for this client
  const existing = fileWatchers.get(ws);
  if (existing) {
    existing.close();
    fileWatchers.delete(ws);
  }

  try {
    // Debounce: batch changes over 300ms
    let pendingChanges = new Map(); // relativePath -> eventType
    let debounceTimer = null;

    const flush = () => {
      if (pendingChanges.size === 0) return;
      const changes = [];
      for (const [filePath, eventType] of pendingChanges) {
        changes.push({ path: filePath, event: eventType });
      }
      pendingChanges.clear();
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify({ type: 'fsChanges', workspacePath, changes }));
      }
    };

    const watcher = fs.watch(workspacePath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Skip dot-files and common noise
      if (filename.split(path.sep).some(part => part.startsWith('.'))) return;
      if (filename.includes('node_modules')) return;

      pendingChanges.set(filename, eventType);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, 300);
    });

    watcher.on('error', (err) => {
      warn('File watcher error:', err.message);
      watcher.close();
      fileWatchers.delete(ws);
    });

    fileWatchers.set(ws, watcher);
    log(`Watching workspace: ${workspacePath}`);
  } catch (err) {
    warn('Failed to start file watcher:', err.message);
  }
}

const messageHandlers = {
  clientLog(ws, msg) {
    const prefix = `[Client:${msg.level || 'log'}]`;
    console.log(prefix, msg.message);
  },

  updateFiles(ws, msg, previewFiles) {
    const count = Object.keys(msg.files).length;
    for (const [fileName, content] of Object.entries(msg.files)) {
      previewFiles.set(fileName, content);
    }
    log(`Updated ${count} preview files in memory`);
    reply(ws, { type: 'filesUpdated', id: msg.id });
  },

  async listDir(ws, msg) {
    const dirPath = path.resolve(msg.path || process.env.HOME || '/');
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
          return a.name.localeCompare(b.name);
        });
      log(`Listed ${dirPath}: ${items.length} entries`);
      reply(ws, { type: 'dirListing', path: dirPath, items, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'dirListing', path: dirPath, items: [], error: err.message, id: msg.id });
    }
  },

  async openWorkspace(ws, msg) {
    const dirPath = path.resolve(msg.path);
    log(`Opening workspace: ${dirPath}`);

    let fileCount = 0;
    let skipped = 0;

    async function readDir(dir) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const children = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const subChildren = await readDir(fullPath);
          children.push({ name: entry.name, type: 'directory', children: subChildren });
        } else if (entry.isFile()) {
          const ext = entry.name.split('.').pop().toLowerCase();
          if (SERVED_EXTENSIONS.has(ext)) {
            // Reference-only file — served via HTTP, not loaded into memory
            children.push({ name: entry.name, type: 'file', viewType: ext, content: null });
            fileCount++;
          } else {
            try {
              const content = await fs.promises.readFile(fullPath, 'utf-8');
              children.push({ name: entry.name, type: 'file', content });
              fileCount++;
            } catch (readErr) {
              // File can't be read as text — treat as binary, viewable via hex editor
              children.push({ name: entry.name, type: 'file', viewType: 'binary', content: null });
              fileCount++;
            }
          }
        }
      }
      // Sort: directories first, then alphabetical
      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return children;
    }

    try {
      const children = await readDir(dirPath);
      log(`Workspace loaded: ${fileCount} files, ${skipped} skipped`);
      reply(ws, { type: 'workspaceLoaded', path: dirPath, children, id: msg.id });

      // Start watching the workspace for changes
      startWatching(ws, dirPath);
    } catch (err) {
      reply(ws, { type: 'workspaceLoaded', path: dirPath, children: [], error: err.message, id: msg.id });
    }
  },

  // --- Terminal (PTY) handlers ---

  termSpawn(ws, msg) {
    const id = msg.sessionId || ('pty-' + Date.now());
    const shell = process.env.SHELL || '/bin/bash';
    const cwd = msg.cwd || process.env.HOME || '/';
    const cols = msg.cols || 80;
    const rows = msg.rows || 24;

    try {
      const proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols, rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      proc._ws = ws;
      ptyProcesses.set(id, proc);

      proc.onData((data) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'termData', sessionId: id, data }));
        }
      });

      proc.onExit(({ exitCode }) => {
        ptyProcesses.delete(id);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'termExit', sessionId: id, exitCode }));
        }
        log('PTY exited:', id, 'code:', exitCode);
      });

      log('PTY spawned:', id, shell, 'at', cwd);
      reply(ws, { type: 'termSpawned', sessionId: id, id: msg.id });
    } catch (err) {
      warn('PTY spawn failed:', err.message);
      reply(ws, { type: 'termSpawned', sessionId: id, error: err.message, id: msg.id });
    }
  },

  termInput(ws, msg) {
    const proc = ptyProcesses.get(msg.sessionId);
    if (proc) {
      proc.write(msg.data);
    }
  },

  termResize(ws, msg) {
    const proc = ptyProcesses.get(msg.sessionId);
    if (proc && msg.cols && msg.rows) {
      proc.resize(msg.cols, msg.rows);
    }
  },

  termKill(ws, msg) {
    const proc = ptyProcesses.get(msg.sessionId);
    if (proc) {
      proc.kill();
      ptyProcesses.delete(msg.sessionId);
      log('PTY killed:', msg.sessionId);
    }
    reply(ws, { type: 'termKilled', sessionId: msg.sessionId, id: msg.id });
  },

  async mkdir(ws, msg) {
    if (!msg.path) {
      reply(ws, { type: 'mkdirResult', success: false, error: 'Missing path', id: msg.id });
      return;
    }
    const dirPath = path.resolve(msg.path);
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
      log(`Created directory: ${dirPath}`);
      reply(ws, { type: 'mkdirResult', success: true, path: dirPath, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'mkdirResult', success: false, error: err.message, id: msg.id });
    }
  },

  async readFile(ws, msg) {
    if (!msg.workspacePath || !msg.relativePath) {
      reply(ws, { type: 'fileContent', success: false, error: 'Missing required fields', id: msg.id });
      return;
    }
    const workspaceRoot = path.resolve(msg.workspacePath);
    const filePath = path.resolve(workspaceRoot, path.normalize(msg.relativePath));
    if (!filePath.startsWith(workspaceRoot + path.sep) && filePath !== workspaceRoot) {
      reply(ws, { type: 'fileContent', success: false, error: 'Path traversal blocked', id: msg.id });
      return;
    }
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      reply(ws, { type: 'fileContent', success: true, content, relativePath: msg.relativePath, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'fileContent', success: false, error: err.message, id: msg.id });
    }
  },

  async saveFile(ws, msg) {
    const relativePath = msg.relativePath || msg.fileName;
    if (!msg.workspacePath || !relativePath || msg.content === undefined) {
      reply(ws, { type: 'fileSaved', success: false, error: 'Missing required fields', id: msg.id });
      return;
    }

    const workspaceRoot = path.resolve(msg.workspacePath);
    const filePath = path.resolve(workspaceRoot, path.normalize(relativePath));

    if (!filePath.startsWith(workspaceRoot + path.sep) && filePath !== workspaceRoot) {
      warn(`Path traversal blocked: ${relativePath}`);
      reply(ws, { type: 'fileSaved', success: false, error: 'Path traversal blocked', id: msg.id });
      return;
    }
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, msg.content, 'utf-8');
      log(`Saved: ${filePath}`);
      reply(ws, { type: 'fileSaved', success: true, relativePath, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'fileSaved', success: false, error: err.message, id: msg.id });
    }
  },
};

module.exports = { handleConnection };
