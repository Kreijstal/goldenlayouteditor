// --- OpenSCAD Customizer parameters ---
// Reads a .scad file's parameters the way OpenSCAD's Customizer does: top-level
// assignments of literal values (number, string, boolean, vector) in the main
// file, up to the first module or function definition. Comments shape them:
//   /* [Section] */            groups what follows; [Hidden] hides it
//   // Description            on the line above the assignment
//   x = 5; // [0:10]           slider (min:max, or min:step:max)
//   s = "a"; // [a, b, c]      drop-down (value:Label pairs also work)
// A string parameter without a list gets one from the values the file compares
// it with (view == "cutaway"), so scene switches still come out as a drop-down.
// Values go back to OpenSCAD as -D name=value overrides.

// Next token of OpenSCAD source that matters for finding top-level statements.
function* tokens(src) {
    const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*|-?\d*\.?\d+(?:[eE][-+]?\d+)?|\S/g;
    let m;
    while ((m = re.exec(src))) yield { text: m[0], index: m.index };
}

function lineOf(src, index) {
    let line = 0;
    for (let i = src.indexOf('\n'); i !== -1 && i < index; i = src.indexOf('\n', i + 1)) line++;
    return line;
}

// Literal value of an expression, or undefined when it is not a plain literal
function parseLiteral(text) {
    const s = text.trim();
    if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^"(?:[^"\\]|\\.)*"$/.test(s)) {
        try { return JSON.parse(s); } catch (_) { return undefined; }
    }
    if (s.startsWith('[') && s.endsWith(']')) {
        const inner = s.slice(1, -1).trim();
        if (!inner) return undefined;
        const parts = inner.split(',');
        const values = parts.map(parseLiteral);
        if (values.some(v => v === undefined || Array.isArray(v))) return undefined;
        if (values.length > 4 || !values.every(v => typeof v === 'number')) return undefined;
        return values;
    }
    return undefined;
}

// "[0:10]", "[0:0.5:10]", "[a, b]", "[1:One, 2:Two]" -> constraint
function parseConstraint(comment, value) {
    const m = comment.match(/^\s*\[(.*)\]\s*$/);
    if (!m) return null;
    const body = m[1].trim();
    if (!Array.isArray(value) && typeof value === 'number') {
        const range = body.split(':').map(s => s.trim());
        if (range.length >= 2 && range.length <= 3 && range.every(s => s !== '' && !isNaN(Number(s)))) {
            const [min, step, max] = range.length === 3 ? range.map(Number) : [Number(range[0]), null, Number(range[1])];
            return { kind: 'range', min, max, step: step || null };
        }
        if (range.length === 1 && body !== '' && !isNaN(Number(body)) && !body.includes(',')) {
            return { kind: 'range', min: 0, max: Number(body), step: null };
        }
    }
    if (Array.isArray(value)) return null;
    const options = body.split(',').map(s => s.trim()).filter(Boolean).map(item => {
        const i = item.indexOf(':');
        const raw = i > 0 ? item.slice(0, i).trim() : item;
        const label = i > 0 ? item.slice(i + 1).trim() : raw;
        const unq = raw.replace(/^"(.*)"$/, '$1');
        return { value: typeof value === 'number' ? Number(unq) : unq, label };
    });
    if (!options.length || (typeof value === 'number' && options.some(o => isNaN(o.value)))) return null;
    return { kind: 'options', options };
}

// Places where the source compares a variable with a string literal
function comparedStrings(src, name) {
    const found = new Set();
    const esc = name.replace(/\$/g, '\\$');
    const re = new RegExp(`\\b${esc}\\s*[!=]=\\s*"((?:[^"\\\\]|\\\\.)*)"|"((?:[^"\\\\]|\\\\.)*)"\\s*[!=]=\\s*${esc}\\b`, 'g');
    for (const m of src.matchAll(re)) found.add(m[1] !== undefined ? m[1] : m[2]);
    return [...found];
}

function parseParameters(src) {
    const lines = src.split('\n');
    const params = [];
    let section = '';
    let depth = 0;
    let statementStart = true;
    const it = tokens(src);
    for (let step = it.next(); !step.done; step = it.next()) {
        const tok = step.value;
        const t = tok.text;
        if (t.startsWith('/*')) {
            const sec = t.match(/^\/\*\s*\[([^\]]*)\]\s*\*\/$/);
            if (sec && depth === 0) section = sec[1].trim();
            continue;
        }
        if (t.startsWith('//')) continue;
        if (depth === 0 && statementStart && (t === 'module' || t === 'function')) break;
        if ('([{'.includes(t)) { depth++; statementStart = false; continue; }
        if (')]}'.includes(t)) {
            depth = Math.max(0, depth - 1);
            if (t === '}' && depth === 0) statementStart = true;
            continue;
        }
        if (t === ';') { if (depth === 0) statementStart = true; continue; }
        if (depth === 0 && statementStart && (t === 'include' || t === 'use')) {
            // include <file> has no semicolon
            for (let s2 = it.next(); !s2.done && s2.value.text !== '>'; s2 = it.next());
            continue;
        }
        if (depth === 0 && statementStart && /^[A-Za-z_$][\w$]*$/.test(t)) {
            statementStart = false;
            // name = expr ;
            const eq = it.next();
            if (eq.done || eq.value.text !== '=') {
                if (!eq.done && '([{'.includes(eq.value.text)) depth++;
                if (!eq.done && eq.value.text === ';') statementStart = true;
                continue;
            }
            const exprStart = eq.value.index + 1;
            let d = 0, end = -1;
            for (let s2 = it.next(); !s2.done; s2 = it.next()) {
                const x = s2.value.text;
                if (x.startsWith('//') || x.startsWith('/*')) continue;
                if ('([{'.includes(x)) d++;
                else if (')]}'.includes(x)) d--;
                else if (x === ';' && d === 0) { end = s2.value.index; break; }
            }
            statementStart = true;
            if (end < 0) break;
            if (t.startsWith('$') || /^hidden$/i.test(section)) continue;
            const value = parseLiteral(src.slice(exprStart, end));
            if (value === undefined) continue;
            const line = lineOf(src, end);
            const after = lines[line].slice(end - (src.lastIndexOf('\n', end - 1) + 1) + 1);
            const trailing = (after.match(/^\s*\/\/(.*)$/) || [, ''])[1].trim();
            const nameLine = lineOf(src, tok.index);
            const above = nameLine > 0 ? (lines[nameLine - 1].match(/^\s*\/\/(.*)$/) || [, ''])[1].trim() : '';
            let constraint = parseConstraint(trailing, value);
            if (!constraint && typeof value === 'string') {
                const seen = comparedStrings(src, t);
                if (seen.length) {
                    const all = seen.includes(value) ? seen : [value, ...seen];
                    constraint = { kind: 'options', options: all.map(v => ({ value: v, label: v })), inferred: true };
                }
            }
            const description = [above, constraint ? '' : trailing].filter(Boolean).join(' — ');
            const existing = params.findIndex(p => p.name === t);
            if (existing >= 0) params.splice(existing, 1); // the last assignment wins
            params.push({ name: t, value, section, description, constraint });
            continue;
        }
        statementStart = false;
    }
    return params;
}

// A value as OpenSCAD source, for -D name=value
function toScad(value) {
    if (Array.isArray(value)) return '[' + value.map(toScad).join(',') + ']';
    if (typeof value === 'string') return JSON.stringify(value);
    return String(value);
}

module.exports = { parseParameters, toScad };
