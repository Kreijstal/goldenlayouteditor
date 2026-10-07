// --- Fonts, as pdf.js has them ---
// As PDFBug's Font Inspector: each font pdf.js loaded for the pages (what it
// made of the PDF's font: the OpenType font the browser draws with, or the
// system font standing in for one not embedded), where its text is on the
// pages, the glyphs drawn with it, and the font file to save.

// pdf.js lets go of a font's file once the browser has it; it shows each font
// to PDFBug's Font Inspector first (on documents opened with pdfBug), so keep
// the file then, for as long as the font is kept
const fileOf = new WeakMap();
if (typeof globalThis !== 'undefined' && !globalThis.FontInspector) {
    globalThis.FontInspector = { enabled: true, fontAdded(font) { if (font && font.data) fileOf.set(font, font.data); } };
}
const dataOf = (f) => f.data || fileOf.get(f) || null;

const fmt = (n) => Number.isInteger(n) ? String(n) : String(+n.toFixed(3));

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

/**
 * The fonts a page draws with: loadedName → { name, font, glyphs: Map(fontChar → {unicode, count}), shows }.
 * Its fonts are loaded as its operators are read.
 */
async function pageFonts(pdfjs, page) {
    const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
    const O = pdfjs.OPS;
    const out = new Map();
    let cur = null;
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], args = ops.argsArray[i];
        if (fn === O.save) stack.push(cur);
        else if (fn === O.restore) cur = stack.length ? stack.pop() : cur;
        else if (fn === O.setFont) {
            const name = args[0];
            if (!out.has(name)) {
                const font = page.commonObjs.has(name) ? page.commonObjs.get(name) : null;
                out.set(name, { name, font, glyphs: new Map(), shows: 0 });
            }
            cur = out.get(name);
        } else if ((fn === O.showText || fn === O.showSpacedText) && cur) {
            cur.shows++;
            for (const g of args[0] || []) {
                if (!g || typeof g !== 'object') continue;
                const key = g.fontChar != null ? g.fontChar : g.unicode;
                const had = cur.glyphs.get(key);
                if (had) had.count++;
                else cur.glyphs.set(key, { fontChar: g.fontChar, unicode: g.unicode, count: 1 });
            }
        }
    }
    return out;
}

// Where a font's text is on a page, in page units (from the page's text, by the font it is in)
const texts = new WeakMap();
async function textBoxes(page, loadedName) {
    if (!texts.has(page)) texts.set(page, page.getTextContent());
    const tc = await texts.get(page);
    const style = tc.styles[loadedName] || {};
    const asc = style.ascent != null ? style.ascent : 0.8, desc = style.descent != null ? style.descent : -0.2;
    const boxes = [];
    for (const it of tc.items) {
        if (it.fontName !== loadedName || !it.str || !it.str.trim()) continue;
        const [a, b, c, d, e, f] = it.transform;
        const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
        const dir = Math.hypot(a, b) ? [a / Math.hypot(a, b), b / Math.hypot(a, b)] : [1, 0];
        const up = [-dir[1], dir[0]];
        const w = it.width || 0;
        const xs = [], ys = [];
        for (const [x, y] of [[0, desc * size], [w, desc * size], [0, asc * size], [w, asc * size]]) {
            xs.push(e + dir[0] * x + up[0] * y);
            ys.push(f + dir[1] * x + up[1] * y);
        }
        boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
    return boxes;
}

const kindOf = (f) => !f ? 'not loaded' : f.isType3Font ? 'Type 3' : [f.type, f.subtype].filter(Boolean).join(' / ') || 'font';
const embeddedOf = (f) => !f ? '' : f.isType3Font ? 'drawn by its glyph procedures' : f.missingFile ? 'not embedded: a system font stands in' : 'embedded';
const familyOf = (f) => f.cssFontInfo ? f.cssFontInfo.fontFamily : f.loadedName;
const extOf = (f) => /truetype|ttf/i.test(f.mimetype || '') ? 'ttf' : /woff/i.test(f.mimetype || '') ? 'woff' : 'otf';

// One line about a font, for the tree
function fontSub(entry) {
    const f = entry.font;
    return `${kindOf(f)} · ${embeddedOf(f)}${entry.glyphs.size ? ` · ${entry.glyphs.size} glyphs` : ''}`;
}

/**
 * The font's details in `detail`.
 * @param {HTMLElement} detail
 * @param {{name, font, glyphs, shows}} entry  (glyphs gathered over the pages it is on)
 * @param {object} o
 * @param {number[]} o.pages  where it is used (0-based)
 * @param {function} [o.saveBeside]
 */
function showFont(detail, entry, { pages, saveBeside }) {
    const f = entry.font;
    detail.appendChild(el('h3', null, f ? f.name || entry.name : entry.name));
    detail.appendChild(el('div', 'pi-meta', `${kindOf(f)}, ${embeddedOf(f)}. Used on page${pages.length === 1 ? '' : 's'} ${pages.map(i => i + 1).join(', ')}, in ${entry.shows} text operator${entry.shows === 1 ? '' : 's'}.`));
    if (!f) { detail.appendChild(el('div', 'pi-meta', 'pdf.js has not loaded this font.')); return; }
    const rows = [
        ['Loaded as', f.loadedName],
        ['Font file', dataOf(f) ? `${f.mimetype || '?'}, ${dataOf(f).length} bytes (as pdf.js rebuilt it for the browser)` : 'none'],
        f.missingFile && ['Drawn with', f.systemFontInfo && f.systemFontInfo.src
            ? `the first this system has of ${f.systemFontInfo.src.replace(/local\(([^)]*)\)/g, '$1').replace(/,/g, ', ')}; else ${f.fallbackName || 'sans-serif'}`
            : `${f.fallbackName || 'a generic font'} (the browser's)`],
        ['Style', [f.bold && 'bold', f.italic && 'italic', f.black && 'black', f.vertical && 'vertical', f.composite && 'composite (CID)'].filter(Boolean).join(', ') || 'regular'],
        f.ascent != null && ['Ascent / descent', `${fmt(f.ascent)} / ${fmt(f.descent)}`],
        f.bbox && ['Bounding box', `[${Array.from(f.bbox, fmt).join(' ')}]`],
        f.fontMatrix && ['Font matrix', `[${Array.from(f.fontMatrix, fmt).join(' ')}]`],
        f.cssFontInfo && ['CSS', `${f.cssFontInfo.fontFamily}, weight ${f.cssFontInfo.fontWeight}${f.cssFontInfo.italicAngle ? `, italic angle ${f.cssFontInfo.italicAngle}` : ''}`],
        f.isInvalidPDFjsFont && ['Note', 'pdf.js could not use the font file and draws with a stand-in'],
    ].filter(Boolean);
    const table = el('table', 'pi-props');
    for (const [k, v] of rows) {
        const tr = el('tr');
        tr.append(el('th', null, k), el('td', null, v));
        table.appendChild(tr);
    }
    detail.appendChild(table);
    if (saveBeside && dataOf(f)) {
        const bar = el('div', 'pi-tabs');
        const ext = extOf(f);
        const save = el('button', null, `Save font (.${ext})…`);
        const base = String(f.name || entry.name).replace(/^[A-Z]{6}\+/, '').replace(/[^\w.-]+/g, '_');
        save.onclick = () => saveBeside(`${base}.${ext}`, ext, async () => new Blob([dataOf(f)], { type: f.mimetype || 'font/otf' }), 'Saving…');
        bar.appendChild(save);
        detail.appendChild(bar);
    }
    // the glyphs drawn with it: in the font as the browser has it, and what they mean
    const glyphs = [...entry.glyphs.values()].sort((a, b) => String(a.unicode).localeCompare(String(b.unicode)));
    detail.appendChild(el('div', 'pi-meta', glyphs.length ? `${glyphs.length} glyphs drawn with it (the glyph as drawn, the text it stands for):` : 'No glyphs drawn with it.'));
    const grid = el('div', 'pi-glyphs');
    const family = f.isType3Font ? null : f.missingFile ? (f.systemFontInfo ? f.systemFontInfo.css : `${f.fallbackName || 'sans-serif'}`) : `"${familyOf(f)}"`;
    for (const g of glyphs.slice(0, 2000)) {
        const cell = el('div', 'pi-glyph');
        const shape = el('div', 'pi-glyph-shape');
        if (family) {
            shape.style.fontFamily = family;
            if (f.missingFile) { if (f.bold) shape.style.fontWeight = 'bold'; if (f.italic) shape.style.fontStyle = 'italic'; }
            shape.textContent = f.missingFile ? g.unicode : g.fontChar;
        } else shape.textContent = '—';
        const cp = g.unicode ? [...g.unicode].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ') : '?';
        cell.title = `${JSON.stringify(g.unicode)} ${cp}, drawn ${g.count}×` + (g.fontChar != null && !f.missingFile ? `; in the font as U+${g.fontChar.codePointAt(0).toString(16).toUpperCase()}` : '');
        cell.append(shape, el('div', 'pi-glyph-uni', g.unicode && g.unicode.trim() ? g.unicode : cp));
        grid.appendChild(cell);
    }
    if (glyphs.length > 2000) grid.appendChild(el('div', 'pi-meta', `… ${glyphs.length - 2000} more`));
    detail.appendChild(grid);
    if (f.isType3Font) detail.appendChild(el('div', 'pi-meta', 'A Type 3 font has no font file: each glyph is drawn by its own operators.'));
}

const FONT_STYLE = `
.pi-props{border-collapse:collapse;margin:4px 0;font-family:sans-serif;}
.pi-props th{text-align:left;color:#8a9199;font-weight:normal;padding:1px 10px 1px 0;vertical-align:top;white-space:nowrap;}
.pi-props td{padding:1px 0;word-break:break-all;}
.pi-glyphs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}
.pi-glyph{width:44px;background:#f4f4f4;color:#111;border-radius:3px;text-align:center;overflow:hidden;}
.pi-glyph-shape{font-size:26px;line-height:38px;height:38px;white-space:pre;}
.pi-glyph-uni{font:10px ui-monospace,monospace;background:#ddd;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px;}
`;

module.exports = { pageFonts, textBoxes, fontSub, showFont, FONT_STYLE };
