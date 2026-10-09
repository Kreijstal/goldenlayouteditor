// Rebuild both startup metadata and hashed chunks after source changes.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
let timer, running = false, pending = false;
function build() {
    if (running) { pending = true; return; }
    running = true;
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
    child.on('exit', () => {
        running = false;
        if (pending) { pending = false; build(); }
    });
}
for (const directory of ['src', 'scripts']) fs.watch(path.join(root, directory), { recursive: true }, (_, filename) => {
    if (!filename || !/\.(js|ts|mjs)$/.test(filename) || /imported-(idml|bundle)\/viewer\.js$/.test(filename.replaceAll('\\','/'))) return;
    clearTimeout(timer);
    timer = setTimeout(build, 150);
});
build();
