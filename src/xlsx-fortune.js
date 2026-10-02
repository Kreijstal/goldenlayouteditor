// --- xlsx <-> fortune-sheet ---
// Converts an ExcelJS workbook to fortune-sheet's sheet data and writes edits
// back. Saving goes into the workbook the file was read into, so what the grid
// doesn't model (number format details, data validation, conditional formats,
// images, defined names…) survives; only what the grid shows is rewritten:
// values, formulas, fonts, fills, alignment, borders, merges, sizes, frozen panes.

// Excel column widths are in characters, row heights in points; the grid uses pixels
const colPx = w => Math.round(w * 7 + 5);
const pxCol = px => Math.round(((px - 5) / 7) * 100) / 100;
const rowPx = pt => Math.round(pt * 4 / 3);
const pxRow = px => Math.round(px * 0.75 * 100) / 100;

const BORDER_STYLES = ['none', 'thin', 'hair', 'dotted', 'dashed', 'dashDot', 'dashDotDot', 'double',
    'medium', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot', 'thick'];
// Excel's default body font; cells without their own font are drawn in it
const DEFAULT_FONT = 'Calibri';

const H_ALIGN = { center: 0, centerContinuous: 0, left: 1, right: 2 };
const V_ALIGN = { middle: 0, top: 1, bottom: 2 };

// Serial day number of a date, as Excel counts (1900 system)
function dateSerial(d) {
    return d.getTime() / 86400000 + 25569;
}

function serialDate(n) {
    return new Date(Math.round((n - 25569) * 86400000));
}

// ExcelJS argb ("FF112233") -> "#112233"; theme and indexed colours aren't resolved
function argbCss(color) {
    if (!color || typeof color.argb !== 'string' || color.argb.length < 6) return null;
    return '#' + color.argb.slice(-6).toLowerCase();
}

function cssArgb(css) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(css || '').trim());
    if (m) return 'FF' + m[1].toUpperCase();
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(css || ''));
    if (rgb) return 'FF' + rgb.slice(1, 4).map(n => (+n).toString(16).padStart(2, '0')).join('').toUpperCase();
    return null;
}

function richTextString(v) {
    return v.richText.map(r => r.text).join('');
}

// Value, formula and type of an ExcelJS cell, as the grid holds them
function cellContent(cell) {
    let v = cell.value;
    let f = null;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('formula' in v || 'sharedFormula' in v) {
            f = cell.formula ? '=' + cell.formula : null;
            v = v.result;
            if (v && typeof v === 'object' && 'error' in v) v = v.error;
        } else if (v.richText) v = richTextString(v);
        else if ('hyperlink' in v) v = v.text && v.text.richText ? richTextString(v.text) : v.text;
        else if ('error' in v) v = v.error;
        else v = null;
    }
    if (v instanceof Date) return { v: dateSerial(v), f, t: 'd' };
    if (typeof v === 'boolean') return { v: v ? 'TRUE' : 'FALSE', f, t: 'b' };
    if (typeof v === 'number') return { v, f, t: 'n' };
    if (v === null || v === undefined) return { v: null, f, t: 'g' };
    return { v: String(v), f, t: 's' };
}

function cellStyle(cell, out) {
    const font = cell.font || {};
    if (font.bold) out.bl = 1;
    if (font.italic) out.it = 1;
    if (font.strike) out.cl = 1;
    if (font.underline) out.un = 1;
    if (font.size) out.fs = font.size;
    out.ff = font.name || DEFAULT_FONT;
    const fc = argbCss(font.color);
    if (fc) out.fc = fc;
    const fill = cell.fill;
    if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
        const bg = argbCss(fill.fgColor);
        if (bg) out.bg = bg;
    }
    const al = cell.alignment || {};
    if (al.horizontal in H_ALIGN) out.ht = H_ALIGN[al.horizontal];
    if (al.vertical in V_ALIGN) out.vt = V_ALIGN[al.vertical];
    if (al.wrapText) out.tb = '2';
}

// Rows and cells that exist in the file, styled empty ones included. ExcelJS's
// includeEmpty walks (and creates) every row up to the last one, which a
// sheet formatted down to row 1048576 makes endless.
function eachRow(ws, fn) {
    (ws._rows || []).forEach(row => { if (row) fn(row, row.number); });
}

function eachCell(row, fn) {
    (row._cells || []).forEach((cell, i) => { if (cell) fn(cell, i + 1); });
}

const SIDES = { l: 'left', r: 'right', t: 'top', b: 'bottom' };

// An ExcelJS border as the grid's sides: {l, r, t, b} of {style, color}
function gridBorder(border) {
    const out = {};
    for (const [k, name] of Object.entries(SIDES)) {
        const s = border && border[name];
        const style = s && s.style ? BORDER_STYLES.indexOf(s.style) : -1;
        out[k] = style > 0 ? { style, color: argbCss(s.color) || '#000000' } : undefined;
    }
    return out;
}

const sameSide = (a, b) => (!a && !b) || (!!a && !!b && +a.style === +b.style && String(a.color).toLowerCase() === String(b.color).toLowerCase());

// fortune-sheet sheets for a workbook. format(fa, v) renders a value the way
// the grid does (fortune-sheet's update()), for the cells' display text.
function workbookToSheets(wb, format) {
    const sheets = [];
    wb.eachSheet((ws) => {
        const celldata = [];
        const borderInfo = [];
        const merge = {};
        let maxR = 0, maxC = 0;
        // Empty cells too: a border or fill needs no value
        eachRow(ws, (row, rn) => {
            eachCell(row, (cell, cn) => {
                const r = rn - 1, c = cn - 1;
                const bv = gridBorder(cell.border);
                if (bv.l || bv.r || bv.t || bv.b) borderInfo.push({ rangeType: 'cell', value: { row_index: r, col_index: c, ...bv } });
                if (cell.isMerged && cell.master !== cell) return; // the master holds the content
                const { v, f, t } = cellContent(cell);
                const fa = cell.numFmt || (t === 'd' ? 'yyyy-mm-dd' : 'General');
                const out = {};
                if (v !== null) {
                    out.v = v;
                    out.ct = { fa, t: t === 'b' ? 'b' : t === 's' ? 's' : t === 'd' ? 'd' : 'n' };
                    let m = typeof v === 'number' ? String(v) : v;
                    if (typeof v === 'number' && format) {
                        try { m = format(fa, v); } catch (_) { /* keep the plain number */ }
                    }
                    out.m = m;
                } else if (cell.numFmt) out.ct = { fa: cell.numFmt, t: 'n' };
                if (f) out.f = f;
                cellStyle(cell, out);
                if (Object.keys(out).some(k => k !== 'ff')) {
                    celldata.push({ r, c, v: out });
                    maxR = Math.max(maxR, r);
                    maxC = Math.max(maxC, c);
                }
            });
        });
        // Merged ranges: "A1:C2"
        for (const range of Object.values(ws._merges || {})) {
            const m = range.model || range;
            const r = m.top - 1, c = m.left - 1, rs = m.bottom - m.top + 1, cs = m.right - m.left + 1;
            merge[`${r}_${c}`] = { r, c, rs, cs };
            maxR = Math.max(maxR, r + rs - 1);
            maxC = Math.max(maxC, c + cs - 1);
            const master = celldata.find(x => x.r === r && x.c === c);
            const mc = { r, c, rs, cs };
            if (master) master.v.mc = mc;
            else celldata.push({ r, c, v: { mc } });
            for (let i = r; i < r + rs; i++) {
                for (let j = c; j < c + cs; j++) if (i !== r || j !== c) celldata.push({ r: i, c: j, v: { mc: { r, c } } });
            }
        }
        const columnlen = {}, rowlen = {}, colhidden = {}, rowhidden = {};
        (ws.columns || []).forEach((col, i) => {
            if (!col) return;
            if (col.width) columnlen[i] = colPx(col.width);
            if (col.hidden) colhidden[i] = 0;
        });
        eachRow(ws, (row, rn) => {
            if (row.height) rowlen[rn - 1] = rowPx(row.height);
            if (row.hidden) rowhidden[rn - 1] = 0;
        });
        const config = { merge, columnlen, rowlen, borderInfo, colhidden, rowhidden };
        const sheet = {
            name: ws.name,
            id: 'ws' + ws.id,
            order: sheets.length,
            celldata,
            config,
            row: Math.max(100, maxR + 21),
            column: Math.max(26, maxC + 6),
            status: sheets.length === 0 ? 1 : 0,
        };
        if (ws.state === 'hidden' || ws.state === 'veryHidden') sheet.hide = 1;
        const tab = ws.properties && ws.properties.tabColor;
        if (tab && argbCss(tab)) sheet.color = argbCss(tab);
        const view = (ws.views || [])[0];
        if (view && view.state === 'frozen' && (view.xSplit || view.ySplit)) {
            sheet.frozen = { type: 'rangeBoth', range: { row_focus: (view.ySplit || 0) - 1, column_focus: (view.xSplit || 0) - 1 } };
        }
        if (view && view.showGridLines === false) sheet.showGridLines = 0;
        sheets.push(sheet);
    });
    if (!sheets.length) sheets.push({ name: 'Sheet1', id: 'new1', order: 0, celldata: [], status: 1 });
    return sheets;
}

// --- writing back ---

// The ExcelJS value for a grid cell
function valueOf(c) {
    const ct = (c.ct && c.ct.t) || '';
    let v = c.v;
    if (v === undefined || v === null || v === '') v = null;
    if (v !== null && ct === 'd' && typeof v === 'number') v = serialDate(v);
    else if (v !== null && ct === 'b') v = v === true || String(v).toUpperCase() === 'TRUE';
    else if (typeof v === 'string' && ct !== 's' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
    if (c.f) {
        const formula = String(c.f).replace(/^=/, '');
        return { formula, result: v === null ? undefined : v };
    }
    return v;
}

// Writes the grid's sheets into wb (the workbook as read from the file, or a
// new one): cell contents and the styles the grid shows, merges, sizes, panes.
function sheetsIntoWorkbook(wb, sheets) {
    const byId = new Map();
    wb.eachSheet(ws => byId.set('ws' + ws.id, ws));
    const kept = new Set();
    const ordered = [...sheets].sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const sheet of ordered) {
        let ws = byId.get(sheet.id);
        if (ws && ws.name !== sheet.name) ws.name = sheet.name;
        if (!ws) ws = wb.addWorksheet(sheet.name);
        kept.add(ws);
        writeSheet(ws, sheet);
    }
    // Sheets deleted in the grid
    for (const ws of [...byId.values()]) if (!kept.has(ws)) wb.removeWorksheet(ws.id);
    // Cached formula results may be stale: have Excel/LibreOffice recalculate
    wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
    // Tab order as in the grid
    ordered.forEach((sheet, i) => {
        const ws = [...kept].find(w => w.name === sheet.name);
        if (ws) ws.orderNo = i;
    });
    return wb;
}

function writeSheet(ws, sheet) {
    const data = sheet.data || [];
    const config = sheet.config || {};
    // Shared formulas become each cell's own, so changing one can't break the others
    ws.eachRow({ includeEmpty: false }, row => {
        row.eachCell({ includeEmpty: false }, xc => {
            const val = xc.value;
            if (val && typeof val === 'object' && 'sharedFormula' in val) xc.value = { formula: xc.formula, result: val.result };
            else if (val && typeof val === 'object' && val.shareType) xc.value = { formula: val.formula, result: val.result };
        });
    });
    // Merges first: ExcelJS refuses values in merged-away cells. Only changed
    // ones: merging copies the first cell's style over the range
    const rangeKey = m => `${m.r}_${m.c}_${m.rs}_${m.cs}`;
    const wanted = new Map(Object.values(config.merge || {}).filter(m => m.rs > 1 || m.cs > 1).map(m => [rangeKey(m), m]));
    for (const [key, range] of Object.entries(ws._merges || {})) {
        const m = range.model || range;
        const k = rangeKey({ r: m.top - 1, c: m.left - 1, rs: m.bottom - m.top + 1, cs: m.right - m.left + 1 });
        if (wanted.has(k)) wanted.delete(k);
        else ws.unMergeCells(key);
    }
    const seen = new Set();
    for (let r = 0; r < data.length; r++) {
        const row = data[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            if (!cell) continue;
            seen.add(r + ':' + c);
            if (cell.mc && (cell.mc.r !== r || cell.mc.c !== c)) continue;
            writeCell(ws.getCell(r + 1, c + 1), cell);
        }
    }
    // Cells the grid emptied
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
        row.eachCell({ includeEmpty: false }, (xc, cn) => {
            if (!seen.has((rn - 1) + ':' + (cn - 1))) {
                xc.value = null;
                if (xc.fill && xc.fill.type === 'pattern' && xc.fill.pattern === 'solid') ownStyle(xc).fill = { type: 'pattern', pattern: 'none' };
            }
        });
    });
    for (const m of wanted.values()) ws.mergeCells(m.r + 1, m.c + 1, m.r + m.rs, m.c + m.cs);
    // Borders: the grid's per-cell and range borders, as sides per cell
    const sides = new Map(); // "r:c" -> {l, r, t, b}
    const put = (r, c, side, b) => {
        const k = r + ':' + c;
        if (!sides.has(k)) sides.set(k, {});
        sides.get(k)[side] = b && +b.style ? { style: +b.style, color: b.color || '#000000' } : undefined;
    };
    for (const info of config.borderInfo || []) {
        if (info.rangeType === 'cell') {
            const v = info.value;
            for (const k of Object.keys(SIDES)) put(v.row_index, v.col_index, k, v[k]);
        } else if (info.rangeType === 'range') {
            const b = { style: +info.style, color: info.color };
            const t = info.borderType;
            const none = t === 'border-none';
            const bb = none ? null : b;
            for (const rg of info.range || []) {
                const [r1, r2] = rg.row, [c1, c2] = rg.column;
                for (let r = r1; r <= r2; r++) {
                    for (let c = c1; c <= c2; c++) {
                        const all = t === 'border-all' || none;
                        const out = t === 'border-outside';
                        const inner = t === 'border-inside';
                        if (all || ((out || t === 'border-left') && c === c1) || ((inner || t === 'border-vertical') && c > c1)) put(r, c, 'l', bb);
                        if (all || ((out || t === 'border-right') && c === c2) || ((inner || t === 'border-vertical') && c < c2)) put(r, c, 'r', bb);
                        if (all || ((out || t === 'border-top') && r === r1) || ((inner || t === 'border-horizontal') && r > r1)) put(r, c, 't', bb);
                        if (all || ((out || t === 'border-bottom') && r === r2) || ((inner || t === 'border-horizontal') && r < r2)) put(r, c, 'b', bb);
                    }
                }
            }
        }
    }
    // Only sides that differ from the file are rewritten (keeps diagonals, theme colours…)
    const bordered = new Set(sides.keys());
    eachRow(ws, (row, rn) => {
        eachCell(row, (xc, cn) => {
            if (xc.border && Object.keys(xc.border).length) bordered.add((rn - 1) + ':' + (cn - 1));
        });
    });
    for (const k of bordered) {
        const [r, c] = k.split(':').map(Number);
        const xc = ws.getCell(r + 1, c + 1);
        const had = gridBorder(xc.border);
        const want = sides.get(k) || {};
        const changed = Object.keys(SIDES).filter(s => !sameSide(had[s], want[s]));
        if (!changed.length) continue;
        ownStyle(xc);
        const border = { ...(xc.border || {}) };
        for (const s of changed) {
            if (want[s]) border[SIDES[s]] = { style: BORDER_STYLES[want[s].style] || 'thin', color: { argb: cssArgb(want[s].color) || 'FF000000' } };
            else delete border[SIDES[s]];
        }
        xc.border = border;
    }
    // Sizes
    // (as pixels, so what the file had is kept unless the grid resized it)
    for (const [c, px] of Object.entries(config.columnlen || {})) {
        const col = ws.getColumn(+c + 1);
        if (!col.width || colPx(col.width) !== Math.round(px)) col.width = pxCol(px);
    }
    for (const [r, px] of Object.entries(config.rowlen || {})) {
        const row = ws.getRow(+r + 1);
        if (!row.height || rowPx(row.height) !== Math.round(px)) row.height = pxRow(px);
    }
    (ws._columns || []).forEach((col, i) => { if (col) col.hidden = !!(config.colhidden && i in config.colhidden); });
    for (const c of Object.keys(config.colhidden || {})) ws.getColumn(+c + 1).hidden = true;
    eachRow(ws, (row, rn) => { row.hidden = !!(config.rowhidden && (rn - 1) in config.rowhidden); });
    for (const r of Object.keys(config.rowhidden || {})) ws.getRow(+r + 1).hidden = true;
    // Frozen panes
    const fr = sheet.frozen;
    const view = { ...((ws.views || [])[0] || {}) };
    if (fr && fr.type !== 'cancel') {
        const range = fr.range || { row_focus: 0, column_focus: 0 };
        const ySplit = fr.type === 'row' ? 1 : fr.type === 'column' ? 0 : fr.type === 'both' ? 1 : fr.type === 'rangeColumn' ? 0 : range.row_focus + 1;
        const xSplit = fr.type === 'column' ? 1 : fr.type === 'row' ? 0 : fr.type === 'both' ? 1 : fr.type === 'rangeRow' ? 0 : range.column_focus + 1;
        ws.views = [{ ...view, state: 'frozen', xSplit, ySplit }];
    } else if (view.state === 'frozen') {
        ws.views = [{ ...view, state: 'normal', xSplit: undefined, ySplit: undefined }];
    }
    ws.state = sheet.hide ? 'hidden' : 'visible';
    if (sheet.color && cssArgb(sheet.color)) ws.properties.tabColor = { argb: cssArgb(sheet.color) };
}

// ExcelJS shares one style object between cells read with the same style:
// give a cell its own before changing it, or the change spreads to the others
function ownStyle(xc) {
    if (!xc._ownStyle) {
        xc.style = JSON.parse(JSON.stringify(xc.style || {}));
        xc._ownStyle = true;
    }
    return xc;
}

function writeCell(xc, c) {
    // Leave the content alone when it didn't change (keeps rich text and links)
    const was = cellContent(xc);
    const f = c.f ? '=' + String(c.f).replace(/^=/, '') : null;
    const v = c.v === '' || c.v === undefined ? null : c.v;
    const same = f === was.f && (f !== null || String(v) === String(was.v) || (v !== null && was.v !== null && Number(v) === Number(was.v)));
    if (!same) xc.value = valueOf(c);
    const fa = c.ct && c.ct.fa;
    if (fa && fa !== (xc.numFmt || 'General') && !(was.t === 'd' && !xc.numFmt)) ownStyle(xc).numFmt = fa;
    // Styles: only what the grid changed, compared with how the cell was read
    const had = {};
    cellStyle(xc, had);
    const norm = {
        bl: x => !!+x, it: x => !!+x, cl: x => !!+x, un: x => !!+x,
        fs: x => (x ? +x : null), ff: x => (x ? String(x) : DEFAULT_FONT),
        fc: x => (x ? String(x).toLowerCase() : null), bg: x => (x ? String(x).toLowerCase() : null),
        ht: x => (x === undefined || x === null || x === '' ? null : +x), vt: x => (x === undefined || x === null || x === '' ? null : +x),
        tb: x => String(x) === '2',
    };
    const diff = k => norm[k](c[k]) !== norm[k](had[k]);
    if (['bl', 'it', 'cl', 'un', 'fs', 'ff', 'fc'].some(diff)) {
        ownStyle(xc);
        const font = { ...(xc.font || {}) };
        if (diff('bl')) font.bold = !!+c.bl;
        if (diff('it')) font.italic = !!+c.it;
        if (diff('cl')) font.strike = !!+c.cl;
        if (diff('un')) font.underline = !!+c.un;
        if (diff('fs') && c.fs) font.size = +c.fs;
        if (diff('ff') && c.ff) font.name = String(c.ff);
        if (diff('fc')) { if (c.fc && cssArgb(c.fc)) font.color = { argb: cssArgb(c.fc) }; else delete font.color; }
        xc.font = font;
    }
    if (diff('bg')) {
        ownStyle(xc);
        const bg = c.bg && cssArgb(c.bg);
        xc.fill = bg ? { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } } : { type: 'pattern', pattern: 'none' };
    }
    if (['ht', 'vt', 'tb'].some(diff)) {
        ownStyle(xc);
        const al = { ...(xc.alignment || {}) };
        if (diff('ht')) { const h = Object.keys(H_ALIGN).find(k => H_ALIGN[k] === norm.ht(c.ht) && k !== 'centerContinuous'); if (h) al.horizontal = h; else delete al.horizontal; }
        if (diff('vt')) { const v = Object.keys(V_ALIGN).find(k => V_ALIGN[k] === norm.vt(c.vt)); if (v) al.vertical = v; else delete al.vertical; }
        if (diff('tb')) al.wrapText = norm.tb(c.tb);
        xc.alignment = al;
    }
}

module.exports = { workbookToSheets, sheetsIntoWorkbook, dateSerial, serialDate };
