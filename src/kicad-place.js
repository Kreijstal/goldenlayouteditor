// --- Placing a symbol in a KiCad schematic ---
// Writes what eeschema writes when a symbol is placed: the library symbol into
// the schematic's lib_symbols (once), and an instance with its own properties,
// pin UUIDs and annotation. Coordinates are millimetres, y pointing down; a
// library symbol's y points up.
const S = require('./kicad-sexpr');

const GRID = 1.27;       // eeschema's default grid: pins land on it
const LINE = 2.54;       // spacing of stacked fields

function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
}

const num = n => String(Math.round(n * 10000) / 10000);
const snap = n => Math.round(n / GRID) * GRID;

// A library point (y up) as an offset from the symbol's position, for a
// symbol rotated counterclockwise by angle degrees
function transform(x, y, angle) {
    switch (((angle % 360) + 360) % 360) {
        case 90: return [-y, -x];
        case 180: return [-x, y];
        case 270: return [y, x];
        default: return [x, -y];
    }
}

// "R_2_1" -> { unit: 2, style: 1 }
function unitOf(sub) {
    const m = /_(\d+)_(\d+)$/.exec(S.unquote(sub[1]));
    return m ? { unit: +m[1], style: +m[2] } : { unit: 0, style: 0 };
}

// Graphics and pins drawn for one unit (shared parts included), first body style
function unitItems(sym, unit) {
    const items = [];
    for (const sub of S.all(sym, 'symbol')) {
        const u = unitOf(sub);
        if ((u.unit === 0 || u.unit === unit) && u.style <= 1) items.push(...sub.slice(2).filter(Array.isArray));
    }
    return items;
}

function unitCount(sym) {
    return Math.max(1, ...S.all(sym, 'symbol').map(s => unitOf(s).unit));
}

// Library points of the drawing: outline corners and pin ends
function outlinePoints(items) {
    const pts = [];
    const xy = n => n && [+n[1], +n[2]];
    for (const it of items) {
        switch (it[0]) {
            case 'rectangle': pts.push(xy(S.first(it, 'start')), xy(S.first(it, 'end'))); break;
            case 'polyline': case 'bezier': {
                const p = S.first(it, 'pts');
                if (p) for (const q of S.all(p, 'xy')) pts.push(xy(q));
                break;
            }
            case 'arc': pts.push(xy(S.first(it, 'start')), xy(S.first(it, 'mid')), xy(S.first(it, 'end'))); break;
            case 'circle': {
                const c = xy(S.first(it, 'center')), r = +(S.first(it, 'radius') || [0, 0])[1];
                if (c) pts.push([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]);
                break;
            }
            case 'pin': {
                const at = S.first(it, 'at'), len = +(S.first(it, 'length') || [0, 0])[1];
                if (!at) break;
                const a = (+at[3] || 0) * Math.PI / 180;
                pts.push([+at[1], +at[2]], [+at[1] + len * Math.cos(a), +at[2] + len * Math.sin(a)]);
                break;
            }
        }
    }
    return pts.filter(Boolean);
}

function bounds(points, angle) {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const [x, y] of points) {
        const [sx, sy] = transform(x, y, angle);
        b.minX = Math.min(b.minX, sx); b.maxX = Math.max(b.maxX, sx);
        b.minY = Math.min(b.minY, sy); b.maxY = Math.max(b.maxY, sy);
    }
    if (!isFinite(b.minX)) return { minX: -GRID, minY: -GRID, maxX: GRID, maxY: GRID };
    return b;
}

function isHidden(p) {
    const hide = S.first(p, 'hide');
    if (hide) return hide[1] !== 'no';
    const effects = S.first(p, 'effects');
    if (!effects) return false;
    const h = S.first(effects, 'hide');
    return effects.includes('hide') || (!!h && h[1] !== 'no');
}

// Properties an instance carries (the ki_ ones are the library's own)
function instanceProps(sym) {
    return S.all(sym, 'property').filter(p => !/^"ki_/.test(p[1]));
}

// A property of the instance: at a position given as an offset from the
// symbol, text angle and horizontal justification as given
function instanceProp(libProp, value, x, y, textAngle, justify, hidden) {
    const effects = (S.first(libProp, 'effects') || ['effects', ['font', ['size', '1.27', '1.27']]])
        .filter(e => !(Array.isArray(e) && (e[0] === 'justify' || e[0] === 'hide')) && e !== 'hide');
    const vertical = (S.first(S.first(libProp, 'effects') || [], 'justify') || []).filter(j => j === 'top' || j === 'bottom');
    const just = [justify, ...vertical].filter(Boolean);
    if (just.length) effects.push(['justify', ...just]);
    // Both spellings of hidden: KiCad 9+ reads either, older readers the inner one
    if (hidden) effects.push(['hide', 'yes']);
    const out = ['property', libProp[1], S.quote(value), ['at', num(x), num(y), String(textAngle)]];
    for (const e of libProp.slice(3)) if (Array.isArray(e) && ['show_name', 'do_not_autoplace'].includes(e[0])) out.push(e);
    if (hidden) out.push(['hide', 'yes']);
    out.push(effects);
    return out;
}

// The symbol instance to insert: sym is the embedded library symbol
function makeInstance(sym, o) {
    const angle = o.angle || 0;
    const unit = o.unit || 1;
    const quarter = angle % 180 !== 0;
    const libProps = instanceProps(sym);
    const valueOf = p => {
        const name = S.unquote(p[1]);
        if (name === 'Reference') return o.reference;
        if (name === 'Value' && o.value) return o.value;
        return S.unquote(p[2]);
    };
    const visible = libProps.filter(p => !isHidden(p) && valueOf(p) !== '');
    const power = !!S.first(sym, 'power');
    // Keep the library's layout when it already reads horizontally (ICs, power
    // symbols); otherwise stack the fields beside or above the body like
    // eeschema's autoplace
    const libHorizontal = visible.every(p => (+(S.first(p, 'at') || [])[3] || 0) % 180 === 0);
    const keep = power || (libHorizontal && angle === 0);
    const box = bounds(outlinePoints(unitItems(sym, unit)), angle);
    const tall = box.maxY - box.minY >= box.maxX - box.minX;
    const props = [];
    let row = 0;
    for (const p of libProps) {
        const at = S.first(p, 'at') || ['at', '0', '0', '0'];
        const hidden = isHidden(p) || valueOf(p) === '';
        if (keep || hidden) {
            const [dx, dy] = transform(+at[1], +at[2], angle);
            const j = (S.first(S.first(p, 'effects') || [], 'justify') || []).find(v => v === 'left' || v === 'right');
            props.push(instanceProp(p, valueOf(p), o.x + dx, o.y + dy, +at[3] || 0, j, hidden));
            continue;
        }
        // Readable left to right: stored angles are relative to the symbol,
        // whose quarter turns swap horizontal and vertical text
        const textAngle = quarter ? 90 : 0;
        let dx, dy, justify;
        if (tall) {
            dx = Math.ceil((box.maxX + GRID / 2) / GRID) * GRID;
            dy = snap((box.minY + box.maxY) / 2) + (row - (visible.length - 1) / 2) * LINE;
            // KiCad mirrors a justification when the symbol is turned upside down
            justify = angle === 180 || angle === 90 ? 'right' : 'left';
        } else {
            dx = snap((box.minX + box.maxX) / 2);
            dy = Math.floor((box.minY - GRID / 2) / GRID) * GRID - (visible.length - 1 - row) * LINE;
            justify = null;
        }
        row++;
        props.push(instanceProp(p, valueOf(p), o.x + dx, o.y + dy, textAngle, justify, false));
    }
    const pins = [...new Set(unitItems(sym, unit).filter(i => i[0] === 'pin')
        .map(i => S.first(i, 'number')).filter(Boolean).map(n => n[1]))];
    const flag = (name, dflt) => { const f = S.first(sym, name); return [name, f ? f[1] : dflt]; };
    const inst = ['symbol', ['lib_id', sym[1]], ['at', num(o.x), num(o.y), String(angle)], ['unit', String(unit)],
        flag('exclude_from_sim', 'no'), flag('in_bom', 'yes'), flag('on_board', 'yes'), ['dnp', 'no'],
        ...(keep ? [] : [['fields_autoplaced', 'yes']]),
        ['uuid', S.quote(uuid())], ...props,
        ...pins.map(n => ['pin', n, ['uuid', S.quote(uuid())]])];
    if (o.instance) {
        inst.push(['instances', ['project', S.quote(o.instance.project),
            ['path', S.quote(o.instance.path), ['reference', S.quote(o.reference)], ['unit', String(unit)]]]]);
    }
    return inst;
}

// The embedded definition of lib:name, if the schematic has one
function embeddedSymbol(schText, libId) {
    const span = S.childSpans(schText).find(s => s.head === 'lib_symbols');
    if (!span) return null;
    const body = schText.slice(span.start, span.end);
    const inner = S.childSpans(body).find(s => s.head === 'symbol' && s.name === libId);
    return inner ? S.parse(body.slice(inner.start, inner.end)) : null;
}

function indentBlock(text, indent) {
    return text.split('\n').map(l => indent + l).join('\n');
}

// Schematic text with the symbol placed. libSymText is the library symbol as
// /kicad-symbol serves it (named "lib:name"); an embedded copy wins, as in KiCad.
// Options: x, y, angle, unit, reference, value, instance {project, path}.
function placeSymbol(schText, libSymText, o) {
    const libSym = S.parse(libSymText);
    const libId = S.unquote(libSym[1]);
    const embedded = embeddedSymbol(schText, libId);
    const sym = embedded || libSym;
    let text = schText;
    if (!embedded) {
        const block = indentBlock(S.serialize(libSym, ''), '\t\t');
        const span = S.childSpans(text).find(s => s.head === 'lib_symbols');
        if (span) {
            const close = span.end - 1;
            text = text.slice(0, close).replace(/\s*$/, '') + '\n' + block + '\n\t)' + text.slice(close + 1);
        } else {
            // After the header lists (version, uuid, paper, title_block)
            const spans = S.childSpans(text);
            const after = [...spans].reverse().find(s => ['version', 'generator', 'generator_version', 'uuid', 'paper', 'title_block'].includes(s.head));
            const at = after ? after.end : text.indexOf('(', 1);
            text = text.slice(0, at) + '\n\t(lib_symbols\n' + block + '\n\t)' + text.slice(at);
        }
    }
    const inst = indentBlock(S.serialize(makeInstance(sym, o), ''), '\t');
    // Before the sheet_instances/embedded_fonts trailer, else at the end
    const spans = S.childSpans(text);
    const trailer = spans.find(s => ['sheet_instances', 'symbol_instances', 'embedded_fonts'].includes(s.head));
    const at = trailer ? trailer.start : S.rootEnd(text);
    const before = text.slice(0, at).replace(/\s*$/, '');
    return before + '\n' + inst + '\n' + (trailer ? '\t' : '') + text.slice(at);
}

// Next free reference for a prefix ("R" -> "R4"), over every schematic of the project
function nextReference(texts, prefix) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
    const re = new RegExp(`\\((?:reference|property\\s+"Reference")\\s+"${esc}(\\d+)"`, 'g');
    let max = 0;
    for (const t of texts) for (const m of t.matchAll(re)) max = Math.max(max, +m[1]);
    const n = max + 1;
    return prefix + (prefix.startsWith('#') ? String(n).padStart(2, '0') : n);
}

// Reference prefix of a library symbol: "R?" -> "R"
function referencePrefix(libSymText) {
    const m = /\(property\s+"Reference"\s+"((?:[^"\\]|\\.)*)"/.exec(libSymText);
    return (m ? m[1] : 'U').replace(/\?+$/, '') || 'U';
}

function topUuid(text) {
    const span = S.childSpans(text).find(s => s.head === 'uuid');
    return span ? S.unquote(S.parse(text.slice(span.start, span.end))[1]) : null;
}

// The schematic with a sheet UUID, which annotation paths start from
function ensureUuid(text) {
    if (topUuid(text)) return text;
    const spans = S.childSpans(text);
    const after = [...spans].reverse().find(s => ['version', 'generator', 'generator_version'].includes(s.head));
    const at = after ? after.end : text.indexOf('(', 1) - 1;
    return text.slice(0, at) + `\n\t(uuid ${S.quote(uuid())})` + text.slice(at);
}

// Where the sheet sits in the hierarchy, for the instance's annotation:
// {project, path}. files maps names (relative to the project folder) to text.
function instanceInfo(files, fileName, rootName, projectName) {
    const text = files.get(fileName) || '';
    const own = /\(instances\s+\(project\s+("(?:[^"\\]|\\.)*")\s+\(path\s+("(?:[^"\\]|\\.)*")/.exec(text);
    if (own) return { project: S.unquote(own[1]), path: S.unquote(own[2]) };
    const root = files.has(rootName) ? rootName : fileName;
    const rootUuid = topUuid(files.get(root) || '');
    if (!rootUuid) return null;
    if (root === fileName) return { project: projectName, path: '/' + rootUuid };
    // Walk down the sheets from the root until one uses this file
    const seen = new Set();
    const walk = (name, p) => {
        if (seen.has(name)) return null;
        seen.add(name);
        const t = files.get(name) || '';
        for (const span of S.childSpans(t)) {
            if (span.head !== 'sheet') continue;
            const sheet = S.parse(t.slice(span.start, span.end));
            const id = S.first(sheet, 'uuid');
            const fileProp = S.all(sheet, 'property').find(q => /^"Sheet ?[Ff]ile"$/.test(q[1]));
            if (!id || !fileProp) continue;
            const sub = S.unquote(fileProp[2]);
            const subPath = p + '/' + S.unquote(id[1]);
            if (sub === fileName) return subPath;
            const deeper = walk(sub, subPath);
            if (deeper) return deeper;
        }
        return null;
    };
    const found = walk(root, '/' + rootUuid);
    return found ? { project: projectName, path: found } : null;
}

module.exports = { placeSymbol, nextReference, referencePrefix, instanceInfo, ensureUuid, unitCount, snap, GRID, transform };
