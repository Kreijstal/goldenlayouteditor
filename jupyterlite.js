// JupyterLite (jupyter.org/jupyterlite) for .ipynb files: the static site built by
// `jupyter lite build` (see scripts/build-jupyterlite.sh), published to npm as
// @kreijstal/jupyterlite-site and served from jsDelivr (cdn-apps.js) once per
// workspace folder under /jupyterlite/r/<folder, base64url>/ with that folder as its file tree.
// JupyterLite reads a folder listing from api/contents/<dir>/all.json and a file
// from files/<path>, so both are answered from disk here; the page writes saves
// back through the editor's own saveFile.
const fs = require('fs');
const path = require('path');
const { realPath } = require('./virtual-path');
const cdn = require('./cdn-apps');
const { rejoinLines } = require('./src/notebook-lines');


const MIME = {
    '.ipynb': 'application/x-ipynb+json', '.json': 'application/json', '.md': 'text/markdown',
    '.py': 'text/x-python', '.txt': 'text/plain', '.csv': 'text/csv', '.yml': 'application/x-yaml',
    '.yaml': 'application/x-yaml', '.toml': 'application/toml', '.html': 'text/html', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf',
};

function decodeRoot(token) {
    try {
        const root = realPath(Buffer.from(token, 'base64url').toString('utf8'));
        return path.isAbsolute(root) ? path.resolve(root) : null;
    } catch {
        return null;
    }
}

// A path below root, or null when it would leave it
function inside(root, rel) {
    const abs = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

// A Jupyter contents model without content
function model(abs, rel, st) {
    const name = path.basename(abs);
    const ext = path.extname(name).toLowerCase();
    const time = st.mtime.toISOString();
    const dir = st.isDirectory();
    return {
        name,
        path: rel,
        type: dir ? 'directory' : ext === '.ipynb' ? 'notebook' : 'file',
        mimetype: dir ? null : MIME[ext] || null,
        format: null,
        content: null,
        size: dir ? null : st.size,
        writable: true,
        created: (st.birthtime || st.mtime).toISOString(),
        last_modified: time,
    };
}

function listing(root, rel, res) {
    const abs = inside(root, rel);
    if (!abs) return res.status(403).end();
    fs.readdir(abs, { withFileTypes: true }, (err, entries) => {
        if (err) return res.status(404).json({ message: err.message });
        const content = [];
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            try {
                const st = fs.statSync(path.join(abs, e.name));
                if (st.isFile() || st.isDirectory()) content.push(model(path.join(abs, e.name), rel ? rel + '/' + e.name : e.name, st));
            } catch { /* dangling link */ }
        }
        const dir = model(abs, rel, fs.statSync(abs));
        res.set('Cache-Control', 'no-store').json({ ...dir, name: rel ? dir.name : '', format: 'json', content });
    });
}

// --- Books ---
// A notebook's book: the nearest folder (up to `stop`) with a Jupyter Book table of
// contents (_toc.yml, or the toc in a Jupyter Book 2 / MyST myst.yml), else the
// notebooks next to it. Chapters are absolute paths in reading order.
const BOOK_EXTS = ['.ipynb', '.md', '.myst', '.rst', '.py'];

function readYaml(file) {
    try {
        return require('js-yaml').load(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

// A toc entry's file, which usually leaves out the extension
function tocFile(dir, file) {
    const abs = path.resolve(dir, String(file));
    if (path.extname(abs) && fs.existsSync(abs)) return abs;
    for (const ext of BOOK_EXTS) if (fs.existsSync(abs + ext)) return abs + ext;
    return null;
}

// Jupyter Book 1 (_toc.yml: root, chapters/parts/sections) and MyST (project.toc:
// file, children) entries, depth first
function walkToc(dir, entries, level, out) {
    for (const e of entries || []) {
        if (!e || typeof e !== 'object') continue;
        const file = e.file ? tocFile(dir, e.file) : null;
        if (file) out.push({ path: file, level, title: e.title || null });
        else if (e.caption || e.title) out.push({ caption: e.caption || e.title, level });
        walkToc(dir, e.parts, level, out);
        walkToc(dir, e.chapters, file ? level + 1 : level, out);
        walkToc(dir, e.sections, level + 1, out);
        walkToc(dir, e.children, file ? level + 1 : level, out);
    }
}

function bookToc(dir) {
    let toc = readYaml(path.join(dir, '_toc.yml'));
    if (toc && typeof toc === 'object') {
        const out = [];
        const root = toc.root ? tocFile(dir, toc.root) : null;
        if (root) out.push({ path: root, level: 0, title: null });
        walkToc(dir, [].concat(toc.parts || [], toc.chapters || [], toc.sections || []), root ? 1 : 0, out);
        const config = readYaml(path.join(dir, '_config.yml'));
        return { title: (config && config.title) || null, chapters: out };
    }
    const myst = readYaml(path.join(dir, 'myst.yml'));
    if (myst && myst.project && Array.isArray(myst.project.toc)) {
        const out = [];
        walkToc(dir, myst.project.toc, 0, out);
        return { title: myst.project.title || (myst.site && myst.site.title) || null, chapters: out };
    }
    return null;
}

// A chapter's title: its first markdown heading
function chapterTitle(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        let md = text;
        if (file.endsWith('.ipynb')) {
            const nb = JSON.parse(text);
            md = (nb.cells || []).filter(c => c.cell_type === 'markdown')
                .map(c => Array.isArray(c.source) ? c.source.join('') : c.source || '').join('\n');
        }
        const m = md.replace(/^---\n[\s\S]*?\n---\n/, '').match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
        return m ? m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '') : null;
    } catch {
        return null;
    }
}

const TOC_RE = /^(_toc|myst)\.yml$/;

function book(file, stop) {
    const nbDir = path.dirname(file);
    let result = null;
    // The table of contents itself: the book it describes
    if (TOC_RE.test(path.basename(file))) {
        const toc = bookToc(nbDir);
        if (toc) result = { root: nbDir, kind: 'book', ...toc };
    }
    for (let dir = nbDir; !result; dir = path.dirname(dir)) {
        const toc = bookToc(dir);
        if (toc && toc.chapters.some(c => c.path === file)) {
            result = { root: dir, kind: 'book', ...toc };
            break;
        }
        if (dir === stop || !dir.startsWith(stop + path.sep) || dir === path.dirname(dir)) break;
    }
    if (!result) {
        let names = [];
        try { names = fs.readdirSync(nbDir).filter(n => n.endsWith('.ipynb') && !n.startsWith('.')); } catch { /* gone */ }
        if (names.length < 2) return null;
        names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        result = { root: nbDir, kind: 'folder', title: path.basename(nbDir), chapters: names.map(n => ({ path: path.join(nbDir, n), level: 0, title: null })) };
    }
    for (const c of result.chapters) if (c.path && !c.title) c.title = chapterTitle(c.path) || path.basename(c.path).replace(/\.[^.]+$/, '');
    return result;
}

let _config = null, _configAt = 0;
// The site's jupyter-lite.json, with what this server changes in it; fetched again hourly
async function config() {
    if (!_config || Date.now() - _configAt > 3600 * 1000) {
        const r = await fetch(cdn.urlOf('jupyterlite', 'jupyter-lite.json'));
        if (!r.ok) throw new Error(`jupyter-lite.json: HTTP ${r.status}`);
        const json = await r.json();
        Object.assign(json['jupyter-config-data'], {
            // Folders and files come from disk (above); edits stay in memory until the
            // page saves them back, so a reload always shows the file as it is on disk
            contentsAllJsonFile: 'all.json',
            enableMemoryStorage: true,
            exposeAppInBrowser: 'true', // window.jupyterapp, which the editor uses to open files and see saves
        });
        _config = JSON.stringify(json, null, 2);
        _configAt = Date.now();
    }
    return _config;
}

function register(app) {
    app.get('/jupyterlite-book', (req, res) => {
        const file = req.query.path && path.resolve(realPath(req.query.path));
        const stop = req.query.stop ? path.resolve(realPath(req.query.stop)) : path.parse(file || '/').root;
        if (!file) return res.status(400).send('Missing path parameter');
        // Not on disk: inside an archive, which JupyterLite can't see as a folder
        const onDisk = fs.existsSync(file);
        res.set('Cache-Control', 'no-store').json({ onDisk, book: onDisk ? book(file, stop) : null });
    });
    // Root-relative links in a book's markdown (/_static/logo.png, the Jupyter Book
    // way to say "from the book's folder") reach the server as they are: answered
    // from the folder of the JupyterLite page asking for them
    app.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/jupyterlite/')) return next();
        const m = (req.get('referer') || '').match(/\/jupyterlite\/r\/([A-Za-z0-9_-]+)\//);
        const root = m && decodeRoot(m[1]);
        const abs = root && inside(root, decodeURIComponent(req.path));
        if (!abs) return next();
        fs.stat(abs, (err, st) => (err || !st.isFile() ? next() : res.sendFile(abs)));
    });
    const statics = cdn.serve('jupyterlite');
    app.use('/jupyterlite/r/:root', (req, res, next) => {
        const root = decodeRoot(req.params.root);
        if (!root) return res.status(400).send('Bad folder');
        const url = decodeURIComponent(req.path);
        if (url === '/jupyter-lite.json') {
            return config().then(c => res.type('json').set('Cache-Control', 'no-store').send(c),
                err => res.status(502).send(err.message));
        }
        let m = url.match(/^\/api\/contents\/(?:(.*)\/)?all\.json$/);
        if (m) return listing(root, m[1] || '', res);
        m = url.match(/^\/files\/(.+)$/);
        if (m) {
            const abs = inside(root, m[1]);
            if (!abs) return res.status(403).end();
            if (/\.ipynb$/i.test(abs)) {
                return fs.readFile(abs, 'utf8', (err, text) => {
                    if (err) return res.status(404).send('Not found');
                    let nb;
                    try { nb = rejoinLines(JSON.parse(text)); } catch { return res.type('json').send(text); }
                    res.set('Cache-Control', 'no-store').type('application/x-ipynb+json').send(JSON.stringify(nb));
                });
            }
            return res.sendFile(abs, { headers: { 'Cache-Control': 'no-store' } }, err => {
                if (err && !res.headersSent) res.status(404).send('Not found');
            });
        }
        statics(req, res, next);
    });
}

module.exports = { register };
