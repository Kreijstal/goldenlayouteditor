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
  'bundle', 'usd', 'usda', 'usdc', 'usdz', 'fbx', 'pcd', 'vtk', 'vtp', 'xyz',
  'idml', 'xmind', 'fb2',
  'pdf', 'ai',
  'djvu', 'djv',
  'vsd', 'vsdx',
  'swf',
  'epub',
  'psd', 'psb', // Photoshop documents, Large Documents
  'kra', 'krz',
  'pdn',
  'pspimage', 'psptube', 'pspframe', 'pspmask', 'pspbrush', 'pspshape', 'pspselection', // not .psp/.tub/.pfr (PSP_MAYBE_RE)
  'clip',
  'sai2', // not .sai: SAIL programs and BWA indexes too (SAI_MAYBE_RE)
  'xlsx', 'xlsm', 'xlsb', 'xls', 'ods',
  'odg', 'otg', 'fodg', // OpenDocument drawings (a .fodg is XML, but shown drawn)
  'xps', 'oxps',
  'jb2', 'jbig2', // standalone JBIG2 files
  'sqlite', 'sqlite3', 'db',
  'glb', 'gltf', 'stl', 'obj', 'gcode', 'gco', 'blend',
  'dae', 'wrl', 'vrml', '3ds', '3dm', 'skp', // not .ply or .amf: other files' too (shown as models by their first bytes)
  'zgl', // zlib-compressed XGL (a .xgl stays text)
  '3dxml', // Dassault Systèmes 3D XML (a ZIP)
  'x3dz', 'x3dvz', // gzipped X3D (.x3d, .x3dv, .x3dj stay text)
  'dwg', // AutoCAD drawings (a .dxf stays text, unless it is binary DXF)
  'dgn', // MicroStation drawings
  'dwf', 'dwfx', // Autodesk DWF (an R14 ASCII DWF too) and DWFx
  'fzz',
  'lottie', // dotLottie (a zip); Lottie's .json stays text
  'fst', 'ghw',
  'wasm',
  'fla', 'xfl',
  'png', 'apng', 'jxl', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'cur', 'ani', 'icns', 'dds', 'exr', 'jls', 'webp', 'avif', 'svg', 'tvg', 'hvif', 'tif', 'tiff',
  'jp2', 'j2k', 'j2c', 'jpc', 'jpf', 'jpx', 'jph', 'jhc',
  'heic', 'heif', 'hif',
  'pbm', 'pgm', 'ppm', 'pnm', 'pam',
  'hdr', 'rgbe', 'xyze', 'pic', // .pic: shown as a picture only if Radiance's, QuickDraw PICT's or PICtor's (PC Paint's)
  'pict', 'pct',
  'cals', 'ct1', // not .cal: calendars and others too (CAL_MAYBE_RE)
  'dpx', // not .cin: input methods' tables too (CIN_MAYBE_RE)
  'jng', // not .mng: Ott's text too (MNG_MAYBE_RE)
  'miff', 'wbmp', 'xwd', // not .xbm/.xpm: C source (text), drawn by src/xpm-plugin.js
  'wmf', 'emf', 'wmz', 'emz',
  'mpo', 'jps', 'pns', // stereo pictures (an MPO's first JPEG, a side-by-side JPEG or PNG as it is)
  'tga', 'tpic', 'icb', 'vda', 'vst', // .icb/.vda/.vst: only if a TGA (.vst is a Visio template too)
  'qoi',
  'pcx', 'dcx',
  'sgi', // not .rgb/.rgba/.bw/.int/.inta: raw dumps and other things too (SGI_MAYBE_RE)
  'ras', 'sun', 'im1', 'im8', 'im24', 'im32', // not .rs: Rust far more often (SUN_MAYBE_RE)
  'ilbm', 'lbm', 'ham', 'ham8', 'deep', 'anim', 'anm', // not .iff: sound, animations... too (IFF_MAYBE_RE)
  'fli', 'flc', 'flx', // Autodesk Animator's FLIC animations
  'fits', 'fit', 'fts', // not .fz: Fritzing's sketches too (FZ_MAYBE_RE)
  'jxr', // not .wdp/.hdp: WinDev and Dylan projects too (JXR_MAYBE_RE)
  'bpg', 'flif',
  'nrrd', 'nhdr', // an .nhdr is text, but the picture is what one wants of it
  'vic', 'vicar', // not .img: disk images and other pictures too (VICAR_MAYBE_RE)
  'xisf', 'xish', // an .xish is text, but the picture is what one wants of it
  'ecw',
  'ximg', 'timg', // not .img: disk images and VICAR's too (GEM_MAYBE_RE)
  // camera raws (LibRaw's); not .raw: raw dumps of anything far more often, nor Kodak's .dcr (Shockwave's too)
  'dng', 'crw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'raf', 'pef', 'srw', '3fr', 'fff', 'erf', 'kdc', 'mrw', 'mos', 'iiq', 'rwl', 'mef',
  // not 'ts': that is TypeScript far more often than MPEG transport stream
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'm2ts', '3gp',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
]);

// Names an SGI image shares with other files: one only if its magic number is SGI's
const SGI_MAYBE_RE = /\.(rgba?|bw|inta?)$/i;
// The name a Sun raster shares with Rust: one only if its magic number is 0x59a66a95
const SUN_MAYBE_RE = /\.rs$/i;
// IFF's name for anything: an Amiga picture only if its FORM is ILBM, PBM, ACBM, DEEP or TVPP
// (an animation if ANIM)
const IFF_MAYBE_RE = /\.iff$/i;
const IFF_PICTURE_TYPES = ['ILBM', 'PBM ', 'ACBM', 'DEEP', 'TVPP', 'ANIM'];
// fpack's FITS shares .fz with Fritzing's sketch (XML): FITS only if it starts as FITS does
const FZ_MAYBE_RE = /\.fz$/i;
// HD Photo's names, which WinDev and Dylan projects have too: JPEG XR only if it starts "II", 0xBC
const JXR_MAYBE_RE = /\.(wdp|hdp)$/i;
// The PDS's name for its images, a disk image's too: VICAR only if it starts "LBLSIZE="
const VICAR_MAYBE_RE = /\.img$/i;
// PGF/TikZ's pictures (TeX) have the Progressive Graphics File's name: a PGF image only if it starts "PGF" and a version
const PGF_MAYBE_RE = /\.pgf$/i;
// Pro/ENGINEER's, Caddie's and PWDraw's drawings have Micrografx Draw's name: one only if it starts 01 FF 02 04 03
const DRW_MAYBE_RE = /\.drw$/i;
// ...and a GEM raster image's: GEM only if its header holds up and the file's size fits it (src/gem.js)
const GEM_MAYBE_RE = /\.img$/i;
const { isGem } = require('./src/gem');
const { isSai } = require('./public/sai-vfs.js');
// ...and ERDAS IMAGINE's: one only if it starts "EHFA_HEADER_TAG"
const HFA_MAYBE_RE = /\.img$/i;
// PlayStation Portable makefiles', TrueDoc fonts' and others' names Paint Shop Pro gives its images,
// tubes and frames too: one only if it starts "Paint Shop Pro Image File"
const PSP_MAYBE_RE = /\.(psp|tub|pfr)$/i;
// Developer Studio projects', GROMACS parameter files' and MicroDesign pages' name MediBang Paint and
// FireAlpaca give their files too: one only if it starts "mdipack"
const MDP_MAYBE_RE = /\.mdp$/i;
// SAIL programs' and BWA alignment indexes' name PaintTool SAI gives its documents too: one only if
// its first page deciphers as PaintTool SAI's
const SAI_MAYBE_RE = /\.sai$/i;
// Compact Pro archives' and others' name Corel PHOTO-PAINT gives its images too: one only if it starts
// "CPT7FILE", "CPT8FILE" or "CPT9FILE", or is a TIFF (PHOTO-PAINT 6's)
const CPT_MAYBE_RE = /\.cpt$/i;
const CPT_MAGIC_RE = /^(CPT[789]FILE|II\*\0|MM\0\*)/;
// EPS is text, but a DOS EPS (C5 D0 D3 C6, its PostScript after a TIFF or WMF preview) is binary
const EPS_MAYBE_RE = /\.(eps|epsf|epsi|ps)$/i;
// Calendars' and others' name CALS rasters have too: one only if it starts with a CALS header's first record
const CAL_MAYBE_RE = /\.cal$/i;
const CAL_MAGIC_RE = /^(version: MIL-STD-1840|srcdocid:|rorient:)/;
// Input methods' tables' name Cineon film scans have too: one only if it starts 802A5FD7 (D75F2A80 little-endian)
const CIN_MAYBE_RE = /\.cin$/i;
// Ott's name (text) MNG animations have too: one only if it starts with MNG's signature, 8A "MNG" 0D 0A 1A 0A
const MNG_MAYBE_RE = /\.mng$/i;
// Oracle's configuration files' name (text) OpenRaster images have too: one only if it is a ZIP
const ORA_MAYBE_RE = /\.ora$/i;

// Maximum file size to read and send over WebSocket (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_RANGE_READ_SIZE = 8 * 1024 * 1024;

// Whether p is root or below it (root may be / itself)
function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function resolveWorkspaceFile(workspacePath, relativePath) {
  if (!workspacePath || !relativePath) throw new Error('Missing required fields');
  const workspaceRoot = path.resolve(workspacePath);
  const filePath = path.resolve(workspaceRoot, path.normalize(relativePath));
  if (!isInside(workspaceRoot, filePath)) {
    throw new Error('Path traversal blocked');
  }
  return { workspaceRoot, filePath };
}

// --- File browser action helpers ---

async function exists(p) {
  try { await fs.promises.lstat(p); return true; } catch { return false; }
}

// "name.ext" -> first of "name.ext", "name (2).ext", ... that is free in dir
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = path.join(dir, name);
  for (let i = 2; await exists(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

// XDG_TEMPLATES_DIR from ~/.config/user-dirs.dirs, else ~/Templates
async function templatesDir() {
  const home = process.env.HOME || '/';
  if (process.env.XDG_TEMPLATES_DIR) return process.env.XDG_TEMPLATES_DIR;
  try {
    const conf = await fs.promises.readFile(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs'), 'utf-8');
    const m = conf.match(/^XDG_TEMPLATES_DIR="([^"]*)"/m);
    if (m) return m[1].replace(/^\$HOME/, home);
  } catch { /* not configured */ }
  return path.join(home, 'Templates');
}

// rename, falling back to copy+delete across filesystems
async function movePath(src, dest) {
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.promises.rm(src, { recursive: true });
  }
}

// FreeDesktop.org trash in ~/.local/share/Trash, restorable from file managers
async function moveToTrash(src) {
  const trash = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share'), 'Trash');
  const filesDir = path.join(trash, 'files');
  const infoDir = path.join(trash, 'info');
  await fs.promises.mkdir(filesDir, { recursive: true });
  await fs.promises.mkdir(infoDir, { recursive: true });
  const dest = await freeName(filesDir, path.basename(src));
  const name = path.basename(dest);
  const now = new Date();
  const date = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19); // local time, per spec
  await fs.promises.writeFile(path.join(infoDir, name + '.trashinfo'),
    `[Trash Info]\nPath=${encodeURI(src)}\nDeletionDate=${date}\n`);
  await movePath(src, dest);
}

// Apply op to each absolute path; reply with per-path errors
async function runPathOp(ws, msg, paths, op) {
  const errors = [];
  for (const p of paths || []) {
    const abs = path.resolve(String(p));
    if (abs === '/' || abs === path.resolve(process.env.HOME || '/')) {
      errors.push({ path: abs, error: 'Refusing to touch / or home' });
      continue;
    }
    try {
      await op(abs);
    } catch (err) {
      errors.push({ path: abs, error: err.message });
    }
  }
  reply(ws, { type: msg.type + 'Result', success: errors.length === 0, errors, id: msg.id });
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

  // Shallow listing for the file browser mode: one directory level, no file
  // contents. Text files are marked lazy and fetched with readFile on open.
  async browseDir(ws, msg) {
    const dirPath = path.resolve(msg.path || process.env.HOME || '/');
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const items = await Promise.all(entries
        .filter(e => msg.showHidden || !e.name.startsWith('.'))
        .map(async (e) => {
          let stat = null;
          try { stat = await fs.promises.stat(path.join(dirPath, e.name)); } catch {}
          const isDirectory = stat ? stat.isDirectory() : e.isDirectory();
          const item = {
            name: e.name,
            type: isDirectory ? 'directory' : 'file',
            size: stat ? stat.size : 0,
            mtimeMs: stat ? stat.mtimeMs : 0,
          };
          if (e.isSymbolicLink()) item.symlink = true;
          if (isDirectory) return item;
          const ext = e.name.split('.').pop().toLowerCase();
          if (!stat || !stat.isFile()) item.viewType = 'special'; // broken link, fifo, socket, device
          else if (SERVED_EXTENSIONS.has(ext)) item.viewType = ext;
          else if (stat.size > MAX_FILE_SIZE) item.viewType = 'binary';
          else item.lazy = true;
          return item;
        }));
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      reply(ws, { type: 'browseListing', path: dirPath, parent: path.dirname(dirPath), items, id: msg.id });
    } catch (err) {
      reply(ws, { type: 'browseListing', path: dirPath, parent: path.dirname(dirPath), items: [], error: err.message, id: msg.id });
    }
  },

  // --- File browser actions (absolute paths) ---

  async trashPaths(ws, msg) {
    await runPathOp(ws, msg, msg.paths, moveToTrash);
  },

  async copyPaths(ws, msg) {
    await runPathOp(ws, msg, msg.paths, async (src) => {
      const dest = await freeName(path.resolve(msg.dest), path.basename(src));
      await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    });
  },

  async movePaths(ws, msg) {
    await runPathOp(ws, msg, msg.paths, async (src) => {
      const destDir = path.resolve(msg.dest);
      if (destDir === src || destDir.startsWith(src + path.sep)) throw new Error('Cannot move a folder into itself');
      if (path.dirname(src) === destDir) return; // already here
      await movePath(src, await freeName(destDir, path.basename(src)));
    });
  },

  async renamePath(ws, msg) {
    await runPathOp(ws, msg, [msg.path], async (src) => {
      const name = String(msg.name || '');
      if (!name || name.includes('/') || name === '.' || name === '..') throw new Error('Invalid name');
      const dest = path.join(path.dirname(src), name);
      if (await exists(dest)) throw new Error(`${name} already exists`);
      await fs.promises.rename(src, dest);
    });
  },

  // New file from the browser's "New" menu: { path, content?, encoding?: 'base64', template? }.
  // template is a file name in the templates folder (see listTemplates) to copy.
  // Never overwrites.
  async createFile(ws, msg) {
    await runPathOp(ws, msg, [msg.path], async (dest) => {
      if (msg.template) {
        const name = path.basename(String(msg.template));
        await fs.promises.copyFile(path.join(await templatesDir(), name), dest, fs.constants.COPYFILE_EXCL);
        return;
      }
      const data = msg.encoding === 'base64' ? Buffer.from(String(msg.content || ''), 'base64') : String(msg.content || '');
      await fs.promises.writeFile(dest, data, { flag: 'wx' });
    });
  },

  // Files in the user's templates folder (XDG_TEMPLATES_DIR, like a desktop file manager's "New Document")
  async listTemplates(ws, msg) {
    const dir = await templatesDir();
    let items = [];
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      items = entries.filter(e => !e.name.startsWith('.') && (e.isFile() || e.isSymbolicLink())).map(e => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } catch { /* no templates folder */ }
    reply(ws, { type: 'templates', dir, items, id: msg.id });
  },

  async makeDir(ws, msg) {
    await runPathOp(ws, msg, [msg.path], async (dir) => {
      if (await exists(dir)) throw new Error(`${path.basename(dir)} already exists`);
      await fs.promises.mkdir(dir);
    });
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
              const buf = await fs.promises.readFile(fullPath);
              // an SGI image by another name (.rgb, .bw...): binary, its viewer tells by the magic number
              // (or a Sun raster by Rust's, .rs, an Amiga picture by IFF's, .iff, FITS by Fritzing's, .fz,
              // JPEG XR by HD Photo's, .wdp/.hdp, VICAR by the PDS's, .img, a PGF image by PGF/TikZ's, .pgf,
              // a Micrografx drawing by the other drawings', .drw, a GEM image by a disk image's, .img,
              // an ERDAS IMAGINE one, .img, a Paint Shop Pro image by a makefile's, .psp, .tub, .pfr, a
              // MediBang Paint / FireAlpaca file by a Developer Studio project's, .mdp, a PaintTool SAI
              // document by a SAIL program's, .sai, a Corel PHOTO-PAINT image by a Compact Pro archive's, .cpt,
              // a CALS raster by a calendar's, .cal, a Cineon film scan by an input method's table's, .cin,
              // an MNG animation by Ott's, .mng, an OpenRaster image by Oracle's, .ora, or a DOS EPS, binary
              // though EPS is text)
              if ((SGI_MAYBE_RE.test(entry.name) && buf.length >= 2 && buf.readUInt16BE(0) === 474)
                || (SUN_MAYBE_RE.test(entry.name) && buf.length >= 4 && buf.readUInt32BE(0) === 0x59a66a95)
                || (IFF_MAYBE_RE.test(entry.name) && buf.length >= 12 && buf.toString('latin1', 0, 4) === 'FORM'
                  && IFF_PICTURE_TYPES.includes(buf.toString('latin1', 8, 12)))
                || (FZ_MAYBE_RE.test(entry.name) && buf.toString('latin1', 0, 9) === 'SIMPLE  =')
                || (JXR_MAYBE_RE.test(entry.name) && buf.length >= 4 && buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0xbc && buf[3] <= 1)
                || (VICAR_MAYBE_RE.test(entry.name) && /^LBLSIZE *=/.test(buf.toString('latin1', 0, 16)))
                || (PGF_MAYBE_RE.test(entry.name) && buf.length >= 8 && buf.toString('latin1', 0, 3) === 'PGF' && (buf[3] & 2) && buf[3] < 0x80)
                || (DRW_MAYBE_RE.test(entry.name) && buf.length >= 5 && buf.toString('hex', 0, 5) === '01ff020403')
                || (GEM_MAYBE_RE.test(entry.name) && isGem(buf))
                || (HFA_MAYBE_RE.test(entry.name) && buf.toString('latin1', 0, 15) === 'EHFA_HEADER_TAG')
                || (PSP_MAYBE_RE.test(entry.name) && buf.toString('latin1', 0, 27) === 'Paint Shop Pro Image File\n\x1a')
                || (MDP_MAYBE_RE.test(entry.name) && buf.toString('latin1', 0, 8) === 'mdipack\0')
                || (SAI_MAYBE_RE.test(entry.name) && isSai(buf))
                || (CPT_MAYBE_RE.test(entry.name) && CPT_MAGIC_RE.test(buf.toString('latin1', 0, 8)))
                || (CAL_MAYBE_RE.test(entry.name) && CAL_MAGIC_RE.test(buf.toString('latin1', 0, 32)))
                || (CIN_MAYBE_RE.test(entry.name) && buf.length >= 4 && [0x802a5fd7, 0xd75f2a80].includes(buf.readUInt32BE(0)))
                || (MNG_MAYBE_RE.test(entry.name) && buf.toString('hex', 0, 8) === '8a4d4e470d0a1a0a')
                || (ORA_MAYBE_RE.test(entry.name) && buf.toString('hex', 0, 4) === '504b0304')
                || (EPS_MAYBE_RE.test(entry.name) && buf.length >= 4 && buf.readUInt32LE(0) === 0xc6d3d0c5)) {
                children.push({ name: entry.name, type: 'file', viewType: 'binary', content: null, size: stat.size });
                fileCount++;
                continue;
              }
              const content = buf.toString('utf-8');
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

    if (!isInside(workspaceRoot, filePath)) {
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
    const inside = (p) => isInside(workspaceRoot, p);
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

    if (!isInside(workspaceRoot, filePath)) {
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
