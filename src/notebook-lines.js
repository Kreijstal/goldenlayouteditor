// Notebook JSON helpers shared by the server (jupyterlite.js) and the page

// A notebook with its multi-line strings as single strings, as the Jupyter server
// hands them out (nbformat rejoin_lines); JupyterLab's model expects that and turns
// a stream output's list of lines into one string joined by commas
function rejoinLines(nb) {
    const join = v => Array.isArray(v) ? v.join('') : v;
    const bundle = b => { if (b && typeof b === 'object') for (const k of Object.keys(b)) if (!/json$/.test(k)) b[k] = join(b[k]); };
    for (const cell of (nb && nb.cells) || []) {
        cell.source = join(cell.source);
        if (cell.attachments) for (const a of Object.values(cell.attachments)) bundle(a);
        for (const out of cell.outputs || []) {
            if (out.output_type === 'stream') out.text = join(out.text);
            else bundle(out.data);
        }
    }
    return nb;
}

module.exports = { rejoinLines };
