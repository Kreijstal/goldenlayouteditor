// --- KiCad S-expressions ---
// Just enough of KiCad's file format to copy symbols out of a .kicad_sym library
// and into a .kicad_sch schematic. A list is an array whose first item is its
// keyword; atoms stay as their source text, so strings keep their quotes and
// numbers their exact digits, and a node serializes back to what it was read as.

// Spans of the lists directly inside the outermost one: [{head, name, start, end}]
// (end is one past the closing paren). Scans without building a tree, so a
// library of several megabytes lists quickly.
function childSpans(text) {
    const spans = [];
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 34) { // "
            for (i++; i < text.length && text.charCodeAt(i) !== 34; i++) if (text.charCodeAt(i) === 92) i++;
        } else if (c === 40) { // (
            depth++;
            if (depth === 2) start = i;
        } else if (c === 41) { // )
            if (depth === 2) {
                const m = /^\(\s*([^\s()"]+)(?:\s+("(?:[^"\\]|\\.)*"))?/.exec(text.slice(start, Math.min(i + 1, start + 400)));
                spans.push({ head: m ? m[1] : '', name: m && m[2] ? unquote(m[2]) : null, start, end: i + 1 });
            }
            depth--;
        }
    }
    return spans;
}

// Index of the outermost list's closing paren
function rootEnd(text) {
    return text.lastIndexOf(')');
}

function parse(text) {
    const re = /\s*(?:(\()|(\))|("(?:[^"\\]|\\.)*")|([^\s()"]+))/y;
    const stack = [[]];
    let m;
    while (re.lastIndex < text.length && (m = re.exec(text))) {
        if (m[1]) stack.push([]);
        else if (m[2]) {
            const list = stack.pop();
            if (!stack.length) throw new Error('Unbalanced parentheses');
            stack[stack.length - 1].push(list);
        } else stack[stack.length - 1].push(m[3] || m[4]);
    }
    if (stack.length !== 1) throw new Error('Unbalanced parentheses');
    return stack[0][0];
}

function serialize(node, indent = '') {
    if (!Array.isArray(node)) return node;
    const inner = indent + '\t';
    const simple = node.every(x => !Array.isArray(x));
    if (simple) return '(' + node.join(' ') + ')';
    let out = '(';
    let first = true;
    for (const x of node) {
        if (Array.isArray(x)) out += '\n' + inner + serialize(x, inner);
        else { out += (first ? '' : ' ') + x; }
        first = false;
    }
    return out + '\n' + indent + ')';
}

function unquote(s) {
    return typeof s === 'string' && s[0] === '"' ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s;
}

function quote(s) {
    return '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';
}

// Child lists with the given keyword
function all(node, head) {
    return node.filter(x => Array.isArray(x) && x[0] === head);
}

function first(node, head) {
    return node.find(x => Array.isArray(x) && x[0] === head);
}

// A library symbol as a schematic embeds it: named "Lib:Name", with a derived
// symbol ((extends "Parent")) folded into a copy of its parent. parentText is
// the parent's source when the symbol extends one.
function embedSymbol(symText, libName, parentText) {
    const sym = parse(symText);
    const name = unquote(sym[1]);
    let out = sym;
    const ext = first(sym, 'extends');
    if (ext) {
        if (!parentText) throw new Error(`${name} extends ${unquote(ext[1])}, which is missing`);
        const parent = parse(parentText);
        const parentName = unquote(parent[1]);
        const props = all(sym, 'property');
        const own = new Set(props.map(p => p[1]));
        // The derived symbol's settings and properties over the parent's graphics and pins
        out = [parent[0], parent[1]];
        for (const x of parent.slice(2)) {
            if (!Array.isArray(x)) continue;
            if (x[0] === 'property') { if (!own.has(x[1])) out.push(x); continue; }
            if (x[0] === 'symbol') {
                const sub = x.slice();
                sub[1] = quote(name + unquote(x[1]).slice(parentName.length));
                out.push(sub);
                continue;
            }
            const mine = first(sym, x[0]);
            out.push(mine || x);
        }
        const settings = sym.slice(2).filter(x => Array.isArray(x) && !['extends', 'property', 'symbol'].includes(x[0]) && !first(parent, x[0]));
        const insertAt = out.findIndex((x, i) => i > 1 && Array.isArray(x) && x[0] === 'symbol');
        out.splice(insertAt < 0 ? out.length : insertAt, 0, ...settings, ...props);
    }
    out = out.slice();
    out[1] = quote(libName + ':' + name);
    return out;
}

module.exports = { childSpans, rootEnd, parse, serialize, unquote, quote, all, first, embedSymbol };
