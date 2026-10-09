const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const browserify = require('browserify');
const { makeInterface } = require('./viewer-interface');
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const output = path.join(root, 'public/viewer-chunks');
const main = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
const relativeRequires = text => [...text.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)].map(m => m[1]);
const plugins = relativeRequires(main.slice(0, main.indexOf('// Add default files')))
    .filter(name => name.endsWith('-plugin') || name === 'terminal');
// The dispatcher's dependencies each keep their own synchronous name detection.
const formats = relativeRequires(fs.readFileSync(path.join(src, 'jxl.js'), 'utf8')).filter(name => name !== 'debug');
const builtin = relativeRequires(main.slice(main.indexOf('const wsClient'), main.indexOf('class EditorComponent')))
    .filter(name => !['ws-client', 'archive-fallback', 'jxl'].includes(name));
const names = [...new Set([...plugins, ...formats, ...builtin, 'pdf-viewer', 'handlers/typst-handler'])].filter(name => fs.existsSync(path.join(src, name + '.js')));
const lazyFiles = new Set(names.map(name => path.join(src, name + '.js')));
function replacement(text) {
    let code = '';
    return new Transform({ transform(chunk, enc, cb) { code += chunk; cb(); }, flush(cb) { this.push(text(code)); cb(); } });
}
const interfaces = new Map();
for (const file of lazyFiles) {
    // Typst registers a handler on import; it has no component/decoder to defer.
    if (file.endsWith('/typst-plugin.js')) continue;
    interfaces.set(file, makeInterface(fs.readFileSync(file, 'utf8'), path.relative(src, file).replace(/\\/g, '/').replace(/\.js$/, '')));
}
const shared = new Set();
const sharedId = file => "shared:" + path.relative(root, file).split(path.sep).join("/");
async function bundle(b) {
    return new Promise((resolve, reject) => b.bundle((error, buffer) => error ? reject(error) : resolve(buffer)));
}
function coreBundle(expose = false) {
    const b = browserify(path.join(src, 'main.js'));
    b.transform(file => replacement(code => interfaces.get(file) || code));
    b.pipeline.get('deps').push(new Transform({ objectMode: true, transform(row, enc, cb) {
        if (!lazyFiles.has(row.file) && row.file !== path.join(src, 'main.js')) shared.add(row.file);
        cb(null, row);
    } }));
    if (expose) for (const file of shared) b.require(file, { expose: sharedId(file) });
    return b;
}
async function build() {
    fs.mkdirSync(output, { recursive: true });
    await bundle(coreBundle()); // collect modules which must preserve application state
    const core = await bundle(coreBundle(true));
    const manifest = {};
    let index = 0;
    const jobs = Array.from({ length: 4 }, async () => {
        while (index < names.length) {
            const name = names[index++];
            if (name === 'typst-plugin') continue;
            const file = path.join(src, name + '.js');
            const entry = `require('./lazy-viewers').defineModule(${JSON.stringify(name)}, require('./${name}'));`;
            const b = browserify(Readable.from([entry]), { basedir: src });
            b.transform(moduleFile => replacement(code => shared.has(moduleFile)
                ? 'module.exports = window.__gleViewerRequire(' + JSON.stringify(sharedId(moduleFile)) + ');'
                : (name === 'thumbnails-plugin' && interfaces.has(moduleFile) && moduleFile !== file ? interfaces.get(moduleFile) : code)), { global: true });
            const bytes = await bundle(b);
            const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
            const filename = name.replace(/\//g, '-') + '.' + hash + '.js';
            fs.writeFileSync(path.join(output, filename), bytes);
            manifest[name] = 'viewer-chunks/' + filename;
        }
    });
    await Promise.all(jobs);
    const initialize = `\nwindow.__gleViewerRequire('shared:src/lazy-viewers.js').setManifest(${JSON.stringify(manifest)});\n`;
    fs.writeFileSync(path.join(root, 'public/bundle.js'), 'window.__gleViewerRequire = ' + core.toString() + initialize);
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('Built ' + Object.keys(manifest).length + ' lazy viewer modules; startup bundle ' + core.length + ' bytes.');
}
build().catch(error => { console.error(error); process.exitCode = 1; });
