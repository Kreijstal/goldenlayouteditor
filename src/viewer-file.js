// Read edited text, dropped bytes, or workspace/archive/in-memory references.
const { resolveFileUrl } = require('./archive-fallback');

async function readViewerFile(ctx, fileId, siblingName, raw = false) {
    const file = ctx.projectFiles[fileId];
    if (!file) throw new Error('No file selected.');
    let target = file;
    const relative = ctx.getRelativePath(fileId);
    if (siblingName) {
        const path = relative.replace(/[^/]+$/, siblingName);
        target = Object.values(ctx.projectFiles).find(f => ctx.getRelativePath(f.id).toLowerCase() === path.toLowerCase());
    }
    if (target) {
        if (!raw && typeof target.content === 'string' && !target.viewType && !target.lazy) return new TextEncoder().encode(target.content);
        if (target.bytes instanceof Uint8Array) return target.bytes;
    }
    if (!ctx.currentWorkspacePath) throw new Error(siblingName ? `Open the companion ${siblingName} in the same folder.` : 'File bytes are unavailable.');
    const path = target ? ctx.getRelativePath(target.id) : siblingName ? relative.replace(/[^/]+$/, siblingName) : relative;
    const response = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(ctx.currentWorkspacePath + '/' + path)));
    if (!response.ok) throw new Error(`Could not read ${siblingName || file.name} (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
}

function element(tag, text, parent) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (parent) parent.appendChild(el);
    return el;
}

function table(parent, columns, rows) {
    const tableEl = element('table', null, parent);
    tableEl.style.cssText = 'border-collapse:collapse;font:12px ui-monospace,monospace;width:100%';
    const head = element('tr', null, element('thead', null, tableEl));
    columns.forEach(c => element('th', c, head));
    const body = element('tbody', null, tableEl);
    rows.forEach(row => {
        const tr = element('tr', null, body);
        row.forEach(c => element('td', c, tr));
    });
    tableEl.querySelectorAll('th,td').forEach(cell => { cell.style.cssText = 'padding:5px 8px;border:1px solid #ddd;text-align:left;vertical-align:top;overflow-wrap:anywhere'; });
    return tableEl;
}

module.exports = { readViewerFile, element, table };
