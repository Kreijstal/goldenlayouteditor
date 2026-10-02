// The big prebuilt web apps the editor embeds, under /office, /fritzing, /mogan and
// /rubrc (and JupyterLite's site, see jupyterlite.js), without serving their bytes
// (but for Rubrc's host.js, below): each file comes from jsDelivr, either from one of our
// npm packages (@kreijstal/..., built from source and staged by
// ~/git/npm-publish/stage-*.sh; stage-office.sh splits its tree by the table below) or
// from upstream's own repository where a file is used unchanged.
// A request is answered with a redirect to that URL, except pages, worker scripts and
// same-origin-mode fetches: those must come from this origin, and jsDelivr serves HTML as text/plain,
// so the server fetches them (they are small) and serves them itself.
const path = require('path');

const NPM = process.env.CDN_NPM || 'https://cdn.jsdelivr.net/npm/';
const RAW = 'https://raw.githubusercontent.com/';

// Per app: path prefix -> where files under it live. Longest prefix wins. An npm
// package holds its files at their full path in the app (fonts/000 is
// @kreijstal/eurooffice-fonts-1/fonts/000).
const EO = '9.3.5-rc.1.build.1';
const APPS = {
    office: {
        '': { npm: '@kreijstal/eurooffice', version: EO },
        'sdkjs/common/': { npm: '@kreijstal/eurooffice-sdkjs-common', version: EO },
        'sdkjs/pdf/': { npm: '@kreijstal/eurooffice-sdkjs-common', version: EO },
        'web-apps/': { npm: '@kreijstal/eurooffice-web-apps-1', version: EO },
        'web-apps/apps/spreadsheeteditor/': { npm: '@kreijstal/eurooffice-web-apps-2', version: EO },
        'web-apps/apps/documenteditor/': { npm: '@kreijstal/eurooffice-web-apps-2', version: EO },
        // The fonts, unchanged from Ranuts/document at the commit the site is built from
        'fonts/': { url: RAW + 'Ranuts/document/1301bb8bdac9092c4eb88a6f2f4ff5080cec68bd/public/fonts/', strip: 'fonts/' },
        // Spell-check dictionaries, unchanged from ONLYOFFICE's repository (tr_TR.dic is
        // over jsDelivr's 20 MB limit for GitHub files, so GitHub serves them)
        'dictionaries/': { url: RAW + 'ONLYOFFICE/dictionaries/d3223bbb777883db66ac3cd249f71c6ebdc992c7/', strip: 'dictionaries/' },
    },
    fritzing: {
        '': { npm: '@kreijstal/fritzing-wasm', version: '2026.7.28-build.1' },
    },
    mogan: {
        '': { npm: '@kreijstal/mogan-wasm', version: '2026.3.7-build.1' },
    },
    // Rubrc's live site, unpinned (host.js and the worker entry points: see rubrcFile)
    rubrc: {
        '': { url: 'https://rubrc.pages.dev/assets/' },
    },
    // Not pinned: whatever was published last
    jupyterlite: {
        '': { npm: '@kreijstal/jupyterlite-site', version: 'latest' },
    },
};
// Served under a path of their own by another module
const ELSEWHERE = new Set(['jupyterlite']);
const PAGE_TTL_MS = 3600 * 1000;

// Files a package carries in addition to its own, where its stylesheets reach them by
// relative URL (resolved on jsDelivr, so they must sit in the same package); requests
// for them from the page still go to the package the table above names
const COPIES = {
    office: {
        '@kreijstal/eurooffice-web-apps-2': ['web-apps/apps/common/'],
        '@kreijstal/eurooffice-web-apps-1': ['sdkjs/common/Images/themes_thumbnail'],
    },
};

// x2t, the office converter, is published uncompressed (jsDelivr compresses it on the
// way); the editor asks for the brotli file it ships with
const RENAMES = { office: { 'sdkjs/common/wasm/x2t/x2t.wasm.br': 'sdkjs/common/wasm/x2t/x2t.wasm' } };

function sourceOf(app, rel) {
    let best = '';
    for (const prefix of Object.keys(APPS[app])) {
        if (rel.startsWith(prefix) && prefix.length >= best.length) best = prefix;
    }
    return APPS[app][best];
}

function urlOf(app, rel) {
    rel = (RENAMES[app] || {})[rel] || rel;
    const src = sourceOf(app, rel);
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    if (src.url) return src.url + encoded.slice(src.strip ? src.strip.length : 0);
    return `${NPM}${src.npm}@${src.version}/${encoded}`;
}

// Requests the browser needs same-origin answers for
const SAME_ORIGIN_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object', 'worker', 'sharedworker', 'serviceworker']);

// Rubrc (rustc and cargo as WebAssembly): host.js, the page side, is ours
// (scripts/build-rubrc.sh builds it into ~/git/rubrc-site); the rest is whatever
// rubrc.pages.dev serves now. Its file names carry content hashes, so the two worker
// entry points host.js starts by fixed name are made here, pointing at the current
// ones, found from the site's page as build-rubrc.sh does (looked up hourly)
const RUBRC_SITE = 'https://rubrc.pages.dev/';
const RUBRC_HOST = process.env.RUBRC_HOST || path.join(require('os').homedir(), 'git/rubrc-site/host.js');
let rubrcEntries = null, rubrcEntriesAt = 0;
async function rubrcEntryNames() {
    if (rubrcEntries && Date.now() - rubrcEntriesAt < PAGE_TTL_MS) return rubrcEntries;
    const text = async name => {
        const r = await fetch(new URL(name, RUBRC_SITE));
        if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
        return r.text();
    };
    const index = await text('assets/' + (await text('')).match(/assets\/(index-[\w-]+\.js)/)[1]);
    const app = await text('assets/' + index.match(/\.\/(App-[\w-]+\.js)/)[1]);
    // worker-*.js there only exports the real worker's URL
    const workerUrlModule = await text('assets/' + index.match(/import\(`\.\/(worker-[\w-]+\.js)`\)/)[1]);
    rubrcEntries = {
        'worker.js': workerUrlModule.match(/`(worker-[\w-]+\.js)`/)[1],
        'child_process_worker.js': app.match(/`(child_process_worker-[\w-]+\.js)`/)[1],
    };
    rubrcEntriesAt = Date.now();
    return rubrcEntries;
}

// Answers host.js and the worker entry points; false for Rubrc's own files
async function rubrcFile(rel, res) {
    if (rel === 'host.js') {
        res.set('Cache-Control', 'no-cache').type('js').sendFile(RUBRC_HOST);
        return true;
    }
    if (rel !== 'worker.js' && rel !== 'child_process_worker.js') return false;
    const entries = await rubrcEntryNames();
    res.set('Cache-Control', 'no-cache').type('js').send(`import "./${entries[rel]}";\n`);
    return true;
}

// Middleware answering for app `name` at the path it is mounted on
function serve(name) {
    const pages = new Map(); // rel -> { at, type, body }, kept an hour
    return async (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let rel;
        try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch { return res.status(400).end(); }
        if (rel.split('/').includes('..')) return res.status(400).end();
        if (name === 'rubrc') {
            try {
                if (await rubrcFile(rel, res)) return;
            } catch (err) {
                return res.status(502).send(`Rubrc's site: ${err.message}`);
            }
        }
        const dest = req.get('Sec-Fetch-Dest') || '';
        const page = /^(document|iframe|frame)$/.test(dest);
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        else if (page && !path.posix.extname(rel)) rel += '.html'; // links leave the .html out (/office/editor)
        // A same-origin-mode fetch can't follow a redirect elsewhere (JupyterLite's kernel
        // fetches its worker script that way)
        const sameOriginMode = req.get('Sec-Fetch-Mode') === 'same-origin';
        if (!SAME_ORIGIN_DESTS.has(dest) && !sameOriginMode && !rel.endsWith('.html')) {
            res.set('Cache-Control', 'public, max-age=3600');
            return res.redirect(302, urlOf(name, rel));
        }
        let entry = pages.get(rel);
        if (!entry || Date.now() - entry.at > PAGE_TTL_MS) {
            try {
                const upstream = await fetch(urlOf(name, rel));
                if (!upstream.ok) return res.status(upstream.status).end();
                entry = { at: Date.now(), type: path.posix.extname(rel) || 'application/octet-stream', body: Buffer.from(await upstream.arrayBuffer()) };
            } catch (err) {
                return res.status(502).send(`Could not fetch ${rel}: ${err.message}`);
            }
            pages.set(rel, entry);
        }
        res.set('Cache-Control', 'public, max-age=3600').type(entry.type).send(entry.body);
    };
}

function register(app) {
    for (const name of Object.keys(APPS)) {
        if (!ELSEWHERE.has(name)) app.use('/' + name, serve(name));
    }
}

module.exports = { register, serve, APPS, COPIES, RENAMES, urlOf };
