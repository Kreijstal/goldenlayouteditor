import SevenZip from 'https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.es6.js';
import './sevenzip-list.js';
let modulePromise, engine, password = '', lines = [];
function run(args) {
    lines = [];
    const code = engine.callMain(args);
    if (code !== 0) throw new Error(lines.filter(s => /error|wrong password|encrypted|cannot/i.test(s)).pop() || `7-Zip failed (${code}).`);
    return lines.join('\n');
}
function removeOutput() {
    const remove = path => {
        const stat = engine.FS.lstat(path);
        if (engine.FS.isDir(stat.mode)) { engine.FS.readdir(path).filter(n => n !== '.' && n !== '..').forEach(n => remove(path + '/' + n)); engine.FS.rmdir(path); }
        else engine.FS.unlink(path);
    };
    try { remove('/out'); } catch (_) { /* Not created yet. */ }
}
let queue = Promise.resolve();
async function handle(data) {
    if (!modulePromise) modulePromise = SevenZip({ noInitialRun: true, stdin: () => null, print: s => lines.push(s), printErr: s => lines.push(s) });
    engine = await modulePromise;
    if (data.op === 'open') {
        password = data.password || '';
        engine.FS.writeFile('/input.7z', new Uint8Array(data.bytes));
        const text = run(['l', '-slt', '-ba', '-bsp0', '-p' + password, '--', '/input.7z']);
        return { entries: self.parseSevenZipList(text) };
    }
    if (data.op === 'extract') {
        const path = String(data.path).replace(/\\/g, '/');
        if (/^[/\\]|^[A-Za-z]:/.test(path) || path.split('/').some(p => p === '..' || p === '.' || /[\x00-\x1f]/.test(p))) throw new Error('Unsafe 7z entry path.');
        removeOutput();
        run(['x', '-y', '-spd', '-bsp0', '-o/out', '-p' + password, '--', '/input.7z', path]);
        const bytes = engine.FS.readFile('/out/' + path);
        if (bytes.length > 64 * 1024 * 1024) throw new Error('Entry preview is limited to 64 MB.');
        removeOutput();
        return { bytes };
    }
    throw new Error('Unknown 7z operation.');
}
self.onmessage = ({ data }) => {
    queue = queue.then(() => handle(data)).then(result => self.postMessage({ id: data.id, ...result }, result.bytes ? [result.bytes.buffer] : []), err => self.postMessage({ id: data.id, error: err.message }));
};
