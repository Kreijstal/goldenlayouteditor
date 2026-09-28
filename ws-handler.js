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
  'vsd', 'vsdx',
  'swf',
  'epub',
  'psd',
  'xlsx', 'xlsm', 'xlsb', 'xls', 'ods',
  'sqlite', 'sqlite3', 'db',
  'glb', 'gltf', 'stl', 'obj',
  'wasm',
  'fla', 'xfl',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'svg',
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
]);

// Maximum file size to read and send over WebSocket (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_RANGE_READ_SIZE = 8 * 1024 * 1024;

function resolveWorkspaceFile(workspacePath, relativePath) {
  if (!workspacePath || !relativePath) throw new Error('Missing required fields');
  const workspaceRoot = path.resolve(workspacePath);
  const filePath = path.resolve(workspaceRoot, path.normalize(relativePath));
  if (!filePath.startsWith(workspaceRoot + path.sep) && filePath !== workspaceRoot) {
    throw new Error('Path traversal blocked');
  }
  return { workspaceRoot, filePath };
}

/**
 * Attach WebSocket message handlers to a client socket.
 * @param {WebSocket} ws - The client WebSocket connection.
 * @param {Map} previewFiles - Shared in-memory preview file store.
 */
// --- RPC relay state ---
// Any connected client can send a `clientAction` / `clientEval` request and
// the server forwards it to all OTHER connected clients. The first client
// to reply with `clientActionResult` / `clientEvalResult` wins; the server
// routes the response back to the original requester by id.
const connectedClients = new Set();
const rpcRequests = new Map(); // id -> { origin: ws, timeout: handle }
const RPC_TIMEOUT_MS = 30_000;

function relayRpcRequest(ws, msg) {
  if (!msg.id) return;
  // Register origin and set a cleanup timeout
  const timeout = setTimeout(() => {
    if (rpcRequests.has(msg.id)) {
      rpcRequests.delete(msg.id);
      try {
        ws.send(JSON.stringify({
          type: msg.type + 'Result',
          id: msg.id,
          error: 'RPC timeout — no client responded',
        }));
      } catch (_) { /* socket may be gone */ }
    }
  }, RPC_TIMEOUT_MS);
  rpcRequests.set(msg.id, { origin: ws, timeout });

  const payload = JSON.stringify(msg);
  let delivered = 0;
  for (const client of connectedClients) {
    if (client === ws) continue;
    if (client.readyState !== 1 /* OPEN */) continue;
    try { client.send(payload); delivered++; } catch (_) { /* ignore */ }
  }
  if (delivered === 0) {
    clearTimeout(timeout);
    rpcRequests.delete(msg.id);
    try {
      ws.send(JSON.stringify({
        type: msg.type + 'Result',
        id: msg.id,
        error: 'No other clients connected to handle RPC',
      }));
    } catch (_) { /* ignore */ }
  }
}

function relayRpcResult(ws, msg) {
  if (!msg.id) return;
  const entry = rpcRequests.get(msg.id);
  if (!entry) return; // late or unknown
  clearTimeout(entry.timeout);
  rpcRequests.delete(msg.id);
  try { entry.origin.send(JSON.stringify(msg)); } catch (_) { /* ignore */ }
}

function handleConnection(ws, previewFiles) {
  log('Client connected');
  connectedClients.add(ws);

  // Send server config to client on connect
  const config = { type: 'serverConfig', debug: process.env.NODE_ENV !== 'production' };
  ws.send(JSON.stringify(config));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      // RPC relay: requests go out to peers, results come back to origin
      if (msg.type === 'clientAction' || msg.type === 'clientEval') {
        log(`<- ${msg.type}`, msg.id ? `id=${msg.id}` : '', msg.method || '');
        relayRpcRequest(ws, msg);
        return;
      }
      if (msg.type === 'clientActionResult' || msg.type === 'clientEvalResult') {
        relayRpcResult(ws, msg);
        return;
      }

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
    connectedClients.delete(ws);
    // Fail any in-flight RPC requests that originated here
    for (const [id, entry] of rpcRequests) {
      if (entry.origin === ws) {
        clearTimeout(entry.timeout);
        rpcRequests.delete(id);
      }
    }
    // Clean up any PTY sessions for this client
    for (const [id, proc] of ptyProcesses) {
      if (proc._ws === ws) {
        proc.kill();
        ptyProcesses.delete(id);
        log('PTY session killed:', id);
      }
    }
    // Clean up file watchers
    stopWatching(ws);
  });
}

function reply(ws, msg) {
  log(`-> ${msg.type}`, msg.id ? `id=${msg.id}` : '', msg.error ? `ERROR: ${msg.error}` : '');
  ws.send(JSON.stringify(msg));
}

/**
 * Recursively collect all subdirectories for individual inotify watches.
 * fs.watch({recursive: true}) is unreliable on Linux, so we watch each
 * directory individually for proper inotify coverage.
 */
async function collectDirectories(dir) {
  const dirs = [dir];
  async function walk(current) {
    try {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const fullPath = path.join(current, entry.name);
          dirs.push(fullPath);
          await walk(fullPath);
        }
      }
    } catch (err) {
      warn('Error collecting directories:', err.message);
    }
  }
  await walk(dir);
  return dirs;
}

function startWatching(ws, workspacePath) {
  // Close any existing watcher for this client
  stopWatching(ws);

  try {
    const resolvedWorkspace = path.resolve(workspacePath);
    // Debounce: batch changes over 300ms
    let pendingChanges = new Map(); // relativePath -> { eventType, content? }
    let debounceTimer = null;

    const flush = async () => {
      if (pendingChanges.size === 0) return;
      const changes = [];
      for (const [relativePath, changeInfo] of pendingChanges) {
        const entry = { path: relativePath, event: changeInfo.eventType };

        // For modified/created files, read and include content
        if ((changeInfo.eventType === 'change' || changeInfo.eventType === 'rename') && changeInfo.shouldReadContent) {
          const fullPath = path.join(resolvedWorkspace, relativePath);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
              const ext = relativePath.split('.').pop().toLowerCase();
              if (!SERVED_EXTENSIONS.has(ext)) {
                entry.content = await fs.promises.readFile(fullPath, 'utf-8');
              }
            }
          } catch (err) {
            // File might have been deleted between event and read
            warn('Failed to read changed file:', relativePath, err.message);
          }
        }

        changes.push(entry);
      }
      pendingChanges.clear();
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify({ type: 'fsChanges', workspacePath: resolvedWorkspace, changes }));
      }
    };

    // Track all individual inotify watchers for cleanup
    const watchers = [];

    const addWatcher = (dirPath) => {
      try {
        const watcher = fs.watch(dirPath, (eventType, filename) => {
          if (!filename) return;
          // Skip dot-files and common noise
          if (filename.startsWith('.')) return;
          if (filename.includes('node_modules')) return;

          const fullPath = path.join(dirPath, filename);
          const relativePath = path.relative(resolvedWorkspace, fullPath);

          // Determine if we should read the content
          let shouldReadContent = false;
          if (eventType === 'change') {
            shouldReadContent = true;
          } else if (eventType === 'rename') {
            // Check if file exists (created) or doesn't (deleted)
            try {
              fs.accessSync(fullPath);
              shouldReadContent = true; // File exists = created
            } catch {
              shouldReadContent = false; // File doesn't exist = deleted
            }
          }

          pendingChanges.set(relativePath, { eventType, shouldReadContent });
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(flush, 300);
        });

        watcher.on('error', (err) => {
          warn('Watcher error on', dirPath, ':', err.message);
        });

        watchers.push(watcher);
      } catch (err) {
        warn('Failed to watch directory:', dirPath, err.message);
      }
    };

    // Watch all directories individually for proper inotify coverage
    collectDirectories(resolvedWorkspace).then((dirs) => {
      dirs.forEach(addWatcher);
      log(`Watching workspace: ${resolvedWorkspace} (${dirs.length} directories)`);
    });

    // Store watchers for cleanup
    fileWatchers.set(ws, { watchers, flush, debounceTimer });
  } catch (err) {
    warn('Failed to start file watcher:', err.message);
  }
}

function stopWatching(ws) {
  const watcherInfo = fileWatchers.get(ws);
  if (watcherInfo) {
    clearTimeout(watcherInfo.debounceTimer);
    watcherInfo.watchers.forEach(w => w.close());
    fileWatchers.delete(ws);
    log('File watchers closed');
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
            // Stat first — avoid slurping multi-GB files into memory
            let stat;
            try {
              stat = await fs.promises.stat(fullPath);
            } catch (statErr) {
              warn(`Skipping ${fullPath}: ${statErr.message}`);
              skipped++;
              continue;
            }
            if (stat.size > MAX_FILE_SIZE) {
              // Too large to load as text — reference-only, viewable via hex editor
              children.push({ name: entry.name, type: 'file', viewType: 'binary', content: null, size: stat.size });
              fileCount++;
              continue;
            }
            try {
              const content = await fs.promises.readFile(fullPath, 'utf-8');
              children.push({ name: entry.name, type: 'file', content });
              fileCount++;
            } catch (readErr) {
              // File can't be read as text — treat as binary, viewable via hex editor
              children.push({ name: entry.name, type: 'file', viewType: 'binary', content: null, size: stat.size });
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
    try {
      const { filePath } = resolveWorkspaceFile(msg.workspacePath, msg.relativePath);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      reply(ws, { type: 'fileContent', success: true, content, relativePath: msg.relativePath, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'fileContent', success: false, error: err.message, id: msg.id });
    }
  },

  async readFileRange(ws, msg) {
    let fileHandle = null;
    try {
      const { filePath } = resolveWorkspaceFile(msg.workspacePath, msg.relativePath);
      const offset = Number(msg.offset || 0);
      const requestedLength = Number(msg.length || 0);

      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
      if (!Number.isSafeInteger(requestedLength) || requestedLength <= 0) throw new Error('Invalid length');
      if (requestedLength > MAX_RANGE_READ_SIZE) {
        throw new Error(`Range too large; maximum is ${MAX_RANGE_READ_SIZE} bytes`);
      }

      fileHandle = await fs.promises.open(filePath, 'r');
      const stat = await fileHandle.stat();
      if (!stat.isFile()) throw new Error('Not a file');

      const readableLength = Math.max(0, Math.min(requestedLength, stat.size - offset));
      const buffer = Buffer.allocUnsafe(readableLength);
      const result = readableLength
        ? await fileHandle.read(buffer, 0, readableLength, offset)
        : { bytesRead: 0 };
      const bytes = buffer.subarray(0, result.bytesRead);

      reply(ws, {
        type: 'fileRange',
        success: true,
        relativePath: msg.relativePath,
        offset,
        requestedLength,
        length: bytes.length,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        eof: offset + bytes.length >= stat.size,
        encoding: 'base64',
        content: bytes.toString('base64'),
        id: msg.id,
      });
    } catch (err) {
      reply(ws, { type: 'fileRange', success: false, error: err.message, id: msg.id });
    } finally {
      if (fileHandle) {
        try { await fileHandle.close(); } catch (_) { /* ignore */ }
      }
    }
  },

  async statFile(ws, msg) {
    try {
      const { filePath } = resolveWorkspaceFile(msg.workspacePath, msg.relativePath);
      const stat = await fs.promises.stat(filePath);
      reply(ws, {
        type: 'fileStat',
        success: true,
        relativePath: msg.relativePath,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        id: msg.id,
      });
    } catch (err) {
      reply(ws, { type: 'fileStat', success: false, error: err.message, id: msg.id });
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
      if (msg.encoding === 'base64') {
        await fs.promises.writeFile(filePath, Buffer.from(msg.content, 'base64'));
      } else {
        await fs.promises.writeFile(filePath, msg.content, 'utf-8');
      }
      log(`Saved: ${filePath}`);
      reply(ws, { type: 'fileSaved', success: true, relativePath, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'fileSaved', success: false, error: err.message, id: msg.id });
    }
  },

  // Server-side thumbnail lookup.
  // Request:  { type: 'getThumbnail', path: <abs>, size?: <px>, id }
  // Response: { type: 'thumbnail', success: true, data: <base64>, mimeType, id }
  //       or: { type: 'thumbnail', success: false, id }
  //
  // Current implementation is a stub that always answers "not available",
  // so the client falls back to its own renderers. Plug a cache (Vinetto,
  // sidecar sqlite, imagemagick, …) in here later without touching the
  // client — just return { success: true, data, mimeType } when you have
  // a thumbnail for the given path.
  async getThumbnail(ws, msg) {
    reply(ws, { type: 'thumbnail', success: false, id: msg.id });
  },

  async renameFile(ws, msg) {
    if (!msg.workspacePath || !msg.oldRelativePath || !msg.newRelativePath) {
      reply(ws, { type: 'fileRenamed', success: false, error: 'Missing required fields', id: msg.id });
      return;
    }
    const workspaceRoot = path.resolve(msg.workspacePath);
    const oldPath = path.resolve(workspaceRoot, path.normalize(msg.oldRelativePath));
    const newPath = path.resolve(workspaceRoot, path.normalize(msg.newRelativePath));
    const inside = (p) => p === workspaceRoot || p.startsWith(workspaceRoot + path.sep);
    if (!inside(oldPath) || !inside(newPath)) {
      warn(`Path traversal blocked in rename: ${msg.oldRelativePath} -> ${msg.newRelativePath}`);
      reply(ws, { type: 'fileRenamed', success: false, error: 'Path traversal blocked', id: msg.id });
      return;
    }
    try {
      await fs.promises.access(oldPath);
      try { await fs.promises.access(newPath); return reply(ws, { type: 'fileRenamed', success: false, error: 'Destination exists', id: msg.id }); } catch (_) { /* expected */ }
      await fs.promises.mkdir(path.dirname(newPath), { recursive: true });
      await fs.promises.rename(oldPath, newPath);
      log(`Renamed: ${oldPath} -> ${newPath}`);
      reply(ws, { type: 'fileRenamed', success: true, oldRelativePath: msg.oldRelativePath, newRelativePath: msg.newRelativePath, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'fileRenamed', success: false, error: err.message, id: msg.id });
    }
  },

  async refreshWatch(ws, msg) {
    // Re-scan workspace directories and add watches for new ones
    const watcherInfo = fileWatchers.get(ws);
    if (!watcherInfo || !msg.workspacePath) {
      reply(ws, { type: 'watchRefreshed', success: false, error: 'No active watcher', id: msg.id });
      return;
    }

    const resolvedWorkspace = path.resolve(msg.workspacePath);
    const newDirs = await collectDirectories(resolvedWorkspace);
    const existingDirs = new Set(watcherInfo.watchers.map(w => w._dirPath).filter(Boolean));

    let addedCount = 0;
    for (const dir of newDirs) {
      if (!existingDirs.has(dir)) {
        // Add watcher for new directory
        try {
          const watcher = fs.watch(dir, (eventType, filename) => {
            if (!filename) return;
            if (filename.startsWith('.')) return;
            if (filename.includes('node_modules')) return;

            const fullPath = path.join(dir, filename);
            const relativePath = path.relative(resolvedWorkspace, fullPath);
            let shouldReadContent = eventType === 'change';
            if (eventType === 'rename') {
              try {
                fs.accessSync(fullPath);
                shouldReadContent = true;
              } catch {
                shouldReadContent = false;
              }
            }

            watcherInfo.pendingChanges.set(relativePath, { eventType, shouldReadContent });
            clearTimeout(watcherInfo.debounceTimer);
            watcherInfo.debounceTimer = setTimeout(watcherInfo.flush, 300);
          });
          watcher._dirPath = dir;
          watcher.on('error', (err) => {
            warn('Watcher error on', dir, ':', err.message);
          });
          watcherInfo.watchers.push(watcher);
          addedCount++;
        } catch (err) {
          warn('Failed to watch new directory:', dir, err.message);
        }
      }
    }

    log(`Watch refreshed: ${addedCount} new directories added`);
    reply(ws, { type: 'watchRefreshed', success: true, added: addedCount, total: watcherInfo.watchers.length, id: msg.id });
  },

  async refreshFile(ws, msg) {
    if (!msg.workspacePath || !msg.relativePath) {
      reply(ws, { type: 'fileRefreshed', success: false, error: 'Missing required fields', id: msg.id });
      return;
    }

    const workspaceRoot = path.resolve(msg.workspacePath);
    const filePath = path.resolve(workspaceRoot, path.normalize(msg.relativePath));

    if (!filePath.startsWith(workspaceRoot + path.sep) && filePath !== workspaceRoot) {
      reply(ws, { type: 'fileRefreshed', success: false, error: 'Path traversal blocked', id: msg.id });
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        reply(ws, { type: 'fileRefreshed', success: false, error: 'Not a file', id: msg.id });
        return;
      }
      if (stat.size > MAX_FILE_SIZE) {
        reply(ws, { type: 'fileRefreshed', success: false, error: 'File too large', id: msg.id });
        return;
      }

      const ext = msg.relativePath.split('.').pop().toLowerCase();
      if (SERVED_EXTENSIONS.has(ext)) {
        reply(ws, { type: 'fileRefreshed', success: true, relativePath: msg.relativePath, content: null, servedViaHttp: true, id: msg.id });
        return;
      }

      const content = await fs.promises.readFile(filePath, 'utf-8');
      log(`Refreshed file: ${filePath}`);
      reply(ws, { type: 'fileRefreshed', success: true, relativePath: msg.relativePath, content, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'fileRefreshed', success: false, error: err.message, id: msg.id });
    }
  },
};

module.exports = { handleConnection };
