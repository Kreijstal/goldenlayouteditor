// Keep synchronous detection and registration metadata in the application bundle.
// Everything reachable only from a viewer constructor/action goes in its chunk.
const acorn = require('acorn');
const walk = require('acorn-walk');
const path = require('path');

function parse(source) { return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }); }
function identifiers(node) {
    const names = new Set();
    walk.full(node, n => { if (n.type === 'Identifier') names.add(n.name); });
    return names;
}
function bindings(node) {
    if (node.type === 'Identifier') return [node.name];
    if (node.type === 'ObjectPattern') return node.properties.flatMap(p => bindings(p.value || p.argument));
    if (node.type === 'ArrayPattern') return node.elements.filter(Boolean).flatMap(bindings);
    if (node.type === 'AssignmentPattern') return bindings(node.left);
    if (node.type === 'RestElement') return bindings(node.argument);
    return [];
}
function closure(source, roots) {
    const ast = parse(source);
    const definitions = new Map();
    for (const stmt of ast.body) {
        if (stmt.type === 'VariableDeclaration') {
            for (const decl of stmt.declarations) {
                for (const name of bindings(decl.id)) definitions.set(name, { node: decl, kind: stmt.kind });
            }
        } else if (stmt.id) definitions.set(stmt.id.name, { node: stmt });
    }
    const selected = new Map();
    const pending = [...roots];
    while (pending.length) {
        const name = pending.pop();
        const def = definitions.get(name);
        if (!def || selected.has(def.node.start)) continue;
        selected.set(def.node.start, def);
        pending.push(...identifiers(def.node));
        // Some catalogs are filled by a top-level loop (draw.io imports).
        for (const stmt of ast.body) {
            if (stmt.type !== 'ForOfStatement' || !identifiers(stmt).has(name)) continue;
            if (selected.has(stmt.start)) continue;
            selected.set(stmt.start, { node: stmt });
            pending.push(...identifiers(stmt));
        }
    }
    return [...selected.values()].sort((a, b) => a.node.start - b.node.start)
        .map(({ node, kind }) => (kind ? kind + ' ' : '') + source.slice(node.start, node.end) + (kind ? ';' : '')).join('\n');
}
function exported(ast) {
    return ast.body.find(s => s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression'
        && s.expression.left.type === 'MemberExpression' && s.expression.left.object.name === 'module'
        && s.expression.left.property.name === 'exports')?.expression.right;
}
function makeInterface(source, file, options = {}) {
    const ast = parse(source);
    const registration = ast.body.find(s => s.type === 'ExpressionStatement'
        && s.expression.type === 'CallExpression' && s.expression.callee.name === 'registerPlugin');
    const exportNode = exported(ast);
    const exports = exportNode?.type === 'ObjectExpression' ? exportNode.properties : [];
    const sync = name => /^(is|has|mayBe|looksLike)/.test(name) && !/Url$/.test(name)
        || ['applyPixelAspect', 'canHandle', 'generatePreview', 'getAceMode', 'getFileType', 'initializeAceMode'].includes(name) || /^[A-Z][A-Z0-9_]*$/.test(name);
    const edits = [];
    if (registration) {
        walk.full(ast, node => {
            if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
                edits.push({ start: node.start, end: node.end, text: 'class ' + (node.id?.name || '') + ' {}' });
            }
            if (node.type === 'Property' && (['init', 'render', 'action', 'onclick'].includes(node.key.name)
                || node.key.name === 'content' && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value.type))) {
                edits.push({ start: node.start, end: node.end, text: node.key.name + ': function() {}' });
            }
        });
    }
    // Drop edits inside an already replaced class/property.
    const outer = edits.filter(e => !edits.some(p => p !== e && p.start <= e.start && p.end >= e.end));
    let stripped = source;
    for (const e of outer.sort((a, b) => b.start - a.start)) stripped = stripped.slice(0, e.start) + e.text + stripped.slice(e.end);
    const changed = parse(stripped);
    const reg = changed.body.find(s => s.type === 'ExpressionStatement' && s.expression.callee?.name === 'registerPlugin');
    const rootNames = new Set(reg ? identifiers(reg.expression.arguments[0]) : []);
    const exportLines = [];
    for (const prop of exports) {
        const name = prop.key.name;
        if (options.exports && !options.exports.includes(name)) continue;
        if (sync(name)) {
            rootNames.add(prop.value.name);
            exportLines.push(JSON.stringify(name) + ': ' + prop.value.name);
        } else {
            exportLines.push(JSON.stringify(name) + ': (...args) => lazy.loadModule(' + JSON.stringify(file) + ').then(m => m[' + JSON.stringify(name) + '](...args))');
        }
    }
    // registerPlugin's destructured import is not needed in the metadata chunk.
    rootNames.delete('registerPlugin');
    const body = closure(stripped, rootNames);
    const metadata = reg ? 'lazy.registerLazyPlugin(' + stripped.slice(reg.expression.arguments[0].start, reg.expression.arguments[0].end) + ', ' + JSON.stringify(file) + ');' : '';
    const runtime = path.posix.relative(path.posix.dirname(file), "lazy-viewers");
    return "const lazy = require(" + JSON.stringify(runtime.startsWith(".") ? runtime : "./" + runtime) + ");\n" + body + '\n' + metadata + '\nmodule.exports = {' + exportLines.join(',\n') + '};\n';
}
module.exports = { makeInterface, parse };
