// --- CSV/TSV <-> ExcelJS worksheet ---
// Reads delimited text into a one-sheet workbook for the spreadsheet grid, and
// writes the sheet back in the file's own dialect (delimiter, line ending,
// trailing newline, row widths, encoding); fields are quoted only when they must be.

// The delimiter: tab for .tsv, else whichever of , ; tab | splits the first line most
function sniffDelimiter(text, fileName) {
    if (/\.tsv$/i.test(fileName || '')) return '\t';
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') quoted = !quoted;
        else if (!quoted && (ch === '\n' || ch === '\r')) break;
        else if (!quoted && ch in counts) counts[ch]++;
    }
    let best = ',';
    for (const d of Object.keys(counts)) if (counts[d] > counts[best]) best = d;
    return best;
}

// RFC 4180 with any delimiter: quoted fields may hold delimiters, quotes ("") and newlines
function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [], field = '', i = 0, quoted = false;
    while (i < text.length) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                quoted = false;
            } else field += ch;
            i++;
        } else if (ch === '"' && field === '') { quoted = true; i++; }
        else if (ch === delimiter) { row.push(field); field = ''; i++; }
        else if (ch === '\r' || ch === '\n') {
            row.push(field); rows.push(row); row = []; field = '';
            i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
        } else { field += ch; i++; }
    }
    // The last line, unless the text ended with a newline
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// Text that reads back as exactly this number becomes one; "007", "1.50" or "1e3" stay text
function fieldValue(s) {
    if (s === '') return null;
    if (/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/.test(s) && String(Number(s)) === s) return Number(s);
    return s;
}

// Fills ws from the text; returns the dialect for writing it back
function readDelimited(ws, text, fileName) {
    const delimiter = sniffDelimiter(text, fileName);
    const rows = parseDelimited(text, delimiter);
    rows.forEach((fields, r) => {
        fields.forEach((s, c) => {
            const v = fieldValue(s);
            if (v !== null) ws.getCell(r + 1, c + 1).value = v;
        });
    });
    return {
        delimiter,
        newline: /\r\n/.test(text) ? '\r\n' : '\n',
        trailingNewline: /[\r\n]$/.test(text),
        widths: rows.map(f => f.length),
    };
}

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, '');
    if (typeof v === 'object') {
        if ('result' in v || 'formula' in v) return v.result !== undefined && v.result !== null ? cellText(v.result) : '=' + (v.formula || '');
        if (v.richText) return v.richText.map(r => r.text).join('');
        if ('text' in v) return cellText(v.text);
        if ('error' in v) return String(v.error);
    }
    return String(v);
}

function quoteField(s, delimiter) {
    return s.includes(delimiter) || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// The worksheet as delimited text, in the dialect readDelimited returned
function writeDelimited(ws, dialect) {
    const { delimiter, newline, trailingNewline, widths } = dialect;
    const grid = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
        row.eachCell({ includeEmpty: false }, (cell, c) => {
            const s = cellText(cell.value);
            if (s === '') return;
            (grid[r - 1] = grid[r - 1] || [])[c - 1] = s;
        });
    });
    const lines = [];
    const count = Math.max(grid.length, widths.length);
    for (let r = 0; r < count; r++) {
        const cells = grid[r] || [];
        const n = Math.max(cells.length, widths[r] || 0);
        const fields = [];
        for (let c = 0; c < n; c++) fields.push(quoteField(cells[c] || '', delimiter));
        lines.push(fields.join(delimiter));
    }
    return lines.join(newline) + (trailingNewline && lines.length ? newline : '');
}

// Bytes as text: UTF-8 (BOM dropped), else Windows-1252
function decodeText(bytes) {
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes), encoding: 'utf-8', bom: hasBom };
    } catch (_) {
        return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', bom: false };
    }
}

function encodeText(text, encoding, bom) {
    if (encoding === 'utf-8') {
        const body = new TextEncoder().encode(text);
        if (!bom) return body;
        const out = new Uint8Array(body.length + 3);
        out.set([0xef, 0xbb, 0xbf]);
        out.set(body, 3);
        return out;
    }
    // Windows-1252: Latin-1 plus the 0x80-0x9F block; characters outside it become ?
    const map = {};
    const dec = new TextDecoder('windows-1252');
    for (let b = 0; b < 256; b++) map[dec.decode(new Uint8Array([b]))] = b;
    return Uint8Array.from(Array.from(text, ch => (ch in map ? map[ch] : 0x3f)));
}

module.exports = { sniffDelimiter, parseDelimited, readDelimited, writeDelimited, decodeText, encodeText };
