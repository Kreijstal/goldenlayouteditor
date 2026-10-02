// --- Mathematica notebook rendering ---
// Turns a notebook read by wl-parse.js into HTML: cells in their styles (Title,
// Section, Text, Input, Output, ...) with In/Out labels and group brackets
// that fold, typeset boxes (RowBox, FractionBox, SqrtBox, GridBox, ...), 2D
// graphics as SVG (plots with their axes, frames and ticks), and 3D graphics
// as a projected, depth-sorted SVG that can be turned with the mouse.
//
// renderNotebook(expr, env) returns { html, scenes }: each 3D scene's SVG is in
// an element with data-scene=<index>, and drawScene(scenes[i], view) draws it
// again from another view. env.rasterUrl(width, height, rgba) makes an image
// URL of pixels (RasterBox); without it images are left out.
const { LS, parseWLPrefix, decodeStringLiteral, headName, isSym, isList, sym, mk, list } = require('./wl-parse');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function opts(args) {
    const m = new Map();
    const add = (e) => {
        if (isList(e)) { e.a.forEach(add); return; }
        const h = headName(e);
        if (h === 'Rule' || h === 'RuleDelayed') {
            const k = e.a[0];
            const name = typeof k === 'string' ? k : k && k.s;
            if (name && !m.has(name)) m.set(name, e.a[1]);
        }
    };
    args.forEach(add);
    return m;
}

function isRule(e) { const h = headName(e); return h === 'Rule' || h === 'RuleDelayed'; }
function num(e) {
    if (typeof e === 'number') return e;
    const h = headName(e);
    if (h === 'NCache') return num(e.a[1]);
    if (h === 'Times' || h === 'Plus') {
        const v = e.a.map(num);
        if (v.some(x => x === null)) return null;
        return h === 'Times' ? v.reduce((p, x) => p * x, 1) : v.reduce((p, x) => p + x, 0);
    }
    if (h === 'Power') { const b = num(e.a[0]), x = num(e.a[1]); return b === null || x === null ? null : Math.pow(b, x); }
    if (h === 'Rational') return e.a[0] / e.a[1];
    if (h === 'Scaled' || h === 'ImageScaled') return null;
    if (e && e.s === 'Pi') return Math.PI;
    if (e && e.s === 'E') return Math.E;
    if (e && e.s === 'GoldenRatio') return (1 + Math.sqrt(5)) / 2;
    if (e && e.s === 'Degree') return Math.PI / 180;
    return null;
}
function isNumList(e, n) { return isList(e) && (n === undefined || e.a.length === n) && e.a.every(x => num(x) !== null); }
const fmt = x => +x.toFixed(2);

// --- Colors ---
const NAMED_COLORS = {
    Red: [1, 0, 0], Green: [0, 1, 0], Blue: [0, 0, 1], Black: [0, 0, 0], White: [1, 1, 1],
    Gray: [0.5, 0.5, 0.5], LightGray: [0.85, 0.85, 0.85], Cyan: [0, 1, 1], Magenta: [1, 0, 1],
    Yellow: [1, 1, 0], Brown: [0.6, 0.4, 0.2], Orange: [1, 0.5, 0], Pink: [1, 0.5, 0.5],
    Purple: [0.5, 0, 0.5], LightBlue: [0.87, 0.94, 1], LightRed: [1, 0.85, 0.85],
    LightGreen: [0.88, 1, 0.88], LightYellow: [1, 1, 0.85], LightOrange: [1, 0.9, 0.8],
    LightPurple: [0.94, 0.88, 0.94], LightCyan: [0.9, 1, 1], LightMagenta: [1, 0.9, 1],
    LightBrown: [0.94, 0.91, 0.88], LightPink: [1, 0.925, 0.925], Transparent: [0, 0, 0, 0],
};

function hsb(h, s, v, a) {
    h = ((h % 1) + 1) % 1 * 6;
    const i = Math.floor(h), f = h - i;
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return [...rgb, a];
}

function toColor(e) {
    if (!e) return null;
    if (e.s && NAMED_COLORS[e.s]) { const c = NAMED_COLORS[e.s]; return [c[0], c[1], c[2], c[3] === undefined ? 1 : c[3]]; }
    const h = headName(e);
    if (!h) return null;
    let a = e.a.map(num);
    if (e.a.length === 1 && isList(e.a[0])) a = e.a[0].a.map(num);
    if (a.some(x => x === null)) {
        if ((h === 'Darker' || h === 'Lighter') && e.a[0]) {
            const c = toColor(e.a[0]);
            if (!c) return null;
            const f = e.a.length > 1 ? num(e.a[1]) || 1 / 3 : 1 / 3;
            return h === 'Darker' ? [c[0] * (1 - f), c[1] * (1 - f), c[2] * (1 - f), c[3]] : [c[0] + (1 - c[0]) * f, c[1] + (1 - c[1]) * f, c[2] + (1 - c[2]) * f, c[3]];
        }
        return null;
    }
    switch (h) {
        case 'RGBColor': return [a[0], a[1], a[2], a[3] === undefined ? 1 : a[3]];
        case 'GrayLevel': return [a[0], a[0], a[0], a[1] === undefined ? 1 : a[1]];
        case 'Hue': return a.length === 1 ? hsb(a[0], 1, 1, 1) : hsb(a[0], a[1], a[2], a[3] === undefined ? 1 : a[3]);
        case 'CMYKColor': return [(1 - a[0]) * (1 - a[3]), (1 - a[1]) * (1 - a[3]), (1 - a[2]) * (1 - a[3]), a[4] === undefined ? 1 : a[4]];
    }
    return null;
}
function css(c, opacity = 1) {
    if (!c) return 'none';
    const k = v => Math.round(Math.max(0, Math.min(1, v)) * 255);
    const a = c[3] * opacity;
    return a >= 1 ? `rgb(${k(c[0])},${k(c[1])},${k(c[2])})` : `rgba(${k(c[0])},${k(c[1])},${k(c[2])},${+a.toFixed(3)})`;
}

// --- Strings in boxes ---
const OPERATORS = new Set(['=', ':=', '==', '===', '=!=', '!=', '->', ':>', '→', '⧴', '+', '-', '−', '*', '/', '<', '>', '≤', '≥', '≠', '<=', '>=', '&&', '||', '∧', '∨', '/.', '//.', '//', '/@', '@@', '@@@', '+=', '-=', '*=', '/=', '^=', '^:=', '×', '↦', '∈', '<>', '|', '/;', '⩵', '≈', '≡', '⟹', '⇒', '∘', '⊗', '⊕', '.', ';;']);
const NO_SPACE = new Set(['.', ';;']);

function renderLinear(text, cx) {
    // \!\( ... \) inside the text: boxes in linear syntax
    let out = '';
    let i = 0;
    const open = LS + '!' + LS + '(';
    for (;;) {
        const k = text.indexOf(open, i);
        if (k < 0) break;
        out += plainText(text.slice(i, k), cx);
        let depth = 1, j = k + open.length;
        while (j < text.length && depth) {
            if (text[j] === LS && text[j + 1] === '(') depth++;
            else if (text[j] === LS && text[j + 1] === ')') depth--;
            j += text[j] === LS ? 2 : 1;
        }
        const inner = text.slice(k + open.length, depth ? j : j - 2);
        try {
            out += renderBox(linearToBox(inner), { ...cx, text: false });
        } catch {
            out += esc(inner.replace(new RegExp(LS, 'g'), '\\'));
        }
        i = j;
    }
    return out + plainText(text.slice(i), cx);
}

function linearToBox(s) {
    const items = [];
    let i = 0;
    while (i < s.length) {
        if (s[i] === LS) {
            const c = s[i + 1];
            i += 2;
            if (c === '*') {
                const { expr, end } = parseWLPrefix(s, i);
                items.push(expr);
                i = end;
            } else if (c === '(') {
                let depth = 1, j = i;
                while (j < s.length && depth) {
                    if (s[j] === LS && s[j + 1] === '(') depth++;
                    else if (s[j] === LS && s[j + 1] === ')') depth--;
                    j += s[j] === LS ? 2 : 1;
                }
                items.push(linearToBox(s.slice(i, depth ? j : j - 2)));
                i = j;
            } else if ('^_/@%&+'.includes(c)) {
                items.push({ op: c });
            } else if (c === ' ') {
                items.push(' ');
            } else if (c === '`') {
                while (i < s.length && s[i] !== ' ' && s[i] !== LS) i++;
            }
        } else {
            let j = i;
            while (j < s.length && s[j] !== LS) j++;
            const re = /[A-Za-z0-9.$\u0080-￿]+|\s+|./g;
            let m;
            const chunk = s.slice(i, j);
            while ((m = re.exec(chunk))) items.push(m[0]);
            i = j;
        }
    }
    const out = [];
    for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (!it || !it.op) { out.push(it); continue; }
        const next = items[++k] === undefined ? '' : items[k];
        if (it.op === '@') { out.push(mk('SqrtBox', [next])); continue; }
        const prev = out.length ? out.pop() : '';
        if (it.op === '^') {
            if (headName(prev) === 'SubscriptBox') out.push(mk('SubsuperscriptBox', [prev.a[0], prev.a[1], next]));
            else out.push(mk('SuperscriptBox', [prev, next]));
        } else if (it.op === '_') out.push(mk('SubscriptBox', [prev, next]));
        else if (it.op === '/') out.push(mk('FractionBox', [prev, next]));
        else if (it.op === '%') {
            if (headName(prev) === 'SubscriptBox') out.push(mk('SubsuperscriptBox', [prev.a[0], prev.a[1], next]));
            else out.push(mk('SuperscriptBox', [prev, next]));
        } else if (it.op === '&') out.push(mk('OverscriptBox', [prev, next]));
        else if (it.op === '+') out.push(mk('UnderscriptBox', [prev, next]));
    }
    return out.length === 1 ? out[0] : mk('RowBox', [list(out)]);
}

function plainText(s, cx) {
    s = s.replace(new RegExp(LS + '(.)', 'g'), (_, c) => (c === ' ' ? ' ' : ''));
    return esc(s);
}

function renderString(s, cx) {
    if (s.includes(LS + '!')) return renderLinear(s, cx);
    if (cx.text) return plainText(s, cx);
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
        if (!cx.showStr) {
            // A string in the boxes is a string token: its escapes apply now
            const v = s.includes('\\') ? decodeStringLiteral(s) : s.slice(1, -1);
            if (v === null) return plainText(s.slice(1, -1), cx);
            return v.includes(LS + '!') ? renderLinear(v, cx) : plainText(v, cx);
        }
        return '<span class="nb-str">' + plainText(s, cx) + '</span>';
    }
    if (OPERATORS.has(s) && !cx.text) return `<span class="nb-op${NO_SPACE.has(s) ? ' tight' : ''}">${esc(s === '->' ? '→' : s === ':>' ? '⧴' : s === '-' ? '−' : s)}</span>`;
    if (s === ',') return '<span class="nb-comma">,</span>';
    if (cx.trad && /^[A-Za-zα-ωϑϕϵ]$/.test(s)) return '<i>' + esc(s) + '</i>';
    if (s === '\n') return '<br>';
    // Output numbers hide their precision marks and show six digits
    if (!cx.showStr) {
        const m = /^(-?)(\d+\.\d*)`{1,2}[\d.]*(?:\*\^(-?\d+))?$/.exec(s);
        if (m) {
            const digits = esc(String(+(+m[2]).toPrecision(6)).replace(/^(\d+)$/, '$1.'));
            return m[1] + digits + (m[3] ? '×10<sup class="nb-sup">' + m[3].replace('-', '−') + '</sup>' : '');
        }
    }
    return plainText(s, cx);
}

// --- Boxes ---
function slotSubst(e, args) {
    if (!e || typeof e !== 'object') return e;
    const h = headName(e);
    if (h === 'Slot' || h === 'TemplateSlot') {
        const n = e.a[0];
        return typeof n === 'number' ? (args[n - 1] === undefined ? '' : args[n - 1]) : e;
    }
    if (h === 'Function') return e;
    if (!e.a) return e;
    const a = [];
    for (const x of e.a) {
        const hx = headName(x);
        if (hx === 'SlotSequence' || hx === 'TemplateSlotSequence') {
            const from = typeof x.a[0] === 'number' ? x.a[0] : isList(x.a[0]) ? x.a[0].a[0] : 1;
            const rest = args.slice(from - 1);
            const sep = x.a[1];
            rest.forEach((r, k) => { if (k && sep !== undefined) a.push(sep); a.push(r); });
        } else a.push(slotSubst(x, args));
    }
    return { h: slotSubst(e.h, args), a };
}

function applyPure(f, args) {
    if (headName(f) !== 'Function') return null;
    if (f.a.length === 1) return slotSubst(f.a[0], args);
    const params = isList(f.a[0]) ? f.a[0].a : [f.a[0]];
    let body = f.a[1];
    const subst = (e) => {
        if (e && e.s) { const k = params.findIndex(p => p.s === e.s); return k >= 0 ? args[k] : e; }
        if (!e || !e.a) return e;
        return { h: subst(e.h), a: e.a.map(subst) };
    };
    return subst(body);
}

function styleCss(args, cx) {
    let style = '';
    let cls = '';
    const next = { ...cx };
    for (const s of args) {
        if (typeof s === 'string') {
            if (s === 'TI') style += 'font-style:italic;';
            else if (s === 'TB' || s === 'SB') style += 'font-weight:bold;';
            else if (s === 'TR') style += 'font-style:normal;';
            else if (s === 'Input' || s === 'InlineInput' || s === 'InlineCode' || s === 'Code') { cls += ' nb-inline-input'; next.showStr = true; next.text = false; }
            else if (s === 'Output') { cls += ' nb-inline-output'; next.showStr = false; }
            else if (s === 'Hyperlink' || s === 'Link') cls += ' nb-link';
            else if (s === 'Program' || s === 'InlineCodeText') cls += ' nb-mono';
            continue;
        }
        const color = toColor(s);
        if (color) { style += `color:${css(color)};`; continue; }
        if (!isRule(s)) continue;
        const k = s.a[0].s || s.a[0];
        const v = s.a[1];
        const vs = typeof v === 'string' ? v : v && v.s;
        switch (k) {
            case 'FontWeight': style += `font-weight:${/bold|heavy|black|semibold/i.test(vs) ? 'bold' : /plain|normal/i.test(vs) ? 'normal' : vs};`; break;
            case 'FontSlant': style += `font-style:${/italic|oblique/i.test(vs) ? 'italic' : 'normal'};`; break;
            case 'FontColor': { const c = toColor(v); if (c) style += `color:${css(c)};`; break; }
            case 'Background': { const c = toColor(v); if (c) style += `background:${css(c)};`; break; }
            case 'FontSize': { const n = num(v); if (n) style += `font-size:${n}px;`; break; }
            case 'FontFamily': if (vs) style += `font-family:"${vs.replace(/"/g, '')}",sans-serif;`; break;
            case 'FontVariations':
                if (isList(v)) for (const r of v.a) {
                    if (isRule(r) && r.a[0] === 'Underline' && isSym(r.a[1], 'True')) style += 'text-decoration:underline;';
                    if (isRule(r) && r.a[0] === 'StrikeThrough' && isSym(r.a[1], 'True')) style += 'text-decoration:line-through;';
                    if (isRule(r) && r.a[0] === 'CapsType' && /SmallCaps/.test(r.a[1])) style += 'font-variant:small-caps;';
                }
                break;
            case 'ShowStringCharacters': next.showStr = isSym(v, 'True'); break;
            case 'SingleLetterItalics': if (isSym(v, 'False')) next.trad = false; break;
        }
    }
    return { style, cls, cx: next };
}

function paclet(target) {
    const m = /^paclet:(ref\/)?(.*)$/.exec(target);
    if (!m) return null;
    return 'https://reference.wolfram.com/language/' + (m[1] ? 'ref/' + m[2] : m[2]) + '.html';
}

function link(label, href) {
    return href ? `<a class="nb-link" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : `<span class="nb-link">${label}</span>`;
}

function urlOf(e) {
    if (typeof e === 'string') return /^(https?|mailto|ftp):/i.test(e) ? e : paclet(e);
    if (headName(e) === 'URL') return e.a[0];
    if (isList(e)) return urlOf(e.a[0]);
    return null;
}

function rowItems(items, cx) {
    let out = '';
    for (const x of items) out += renderBox(x, cx);
    return out;
}

function renderGrid(b, cx) {
    const rows = isList(b.a[0]) ? b.a[0].a : [];
    const o = opts(b.a.slice(1));
    let align = [];
    const gba = o.get('GridBoxAlignment');
    const colAlign = gba && isList(gba) ? opts([gba]).get('Columns') : o.get('ColumnAlignments');
    const alignOf = (e) => (e && e.s ? e.s.toLowerCase() : typeof e === 'string' ? e.toLowerCase() : '');
    if (colAlign) {
        if (isList(colAlign)) {
            const flat = [];
            for (const x of colAlign.a) {
                if (isList(x)) flat.push({ repeat: x.a.map(alignOf) });
                else flat.push(alignOf(x));
            }
            align = flat;
        } else align = [{ repeat: [alignOf(colAlign)] }];
    }
    const alignAt = (j) => {
        let k = 0;
        for (const a of align) {
            if (typeof a === 'string') { if (k === j) return a; k++; }
            else return a.repeat[(j - k) % a.repeat.length];
        }
        return '';
    };
    const div = o.get('GridBoxDividers');
    let lines = false;
    if (div && isList(div)) {
        const d = opts([div]);
        const has = (v) => !!v && (isSym(v, 'True') || (isList(v) && v.a.some(has)) || toColor(v) !== null || headName(v) === 'Directive');
        lines = has(d.get('Columns')) || has(d.get('Rows'));
    }
    const frame = o.get('GridFrame') || o.get('FrameStyle');
    let html = `<span class="nb-grid${lines || (frame && !isSym(frame, 'None')) ? ' lined' : ''}"><table>`;
    for (const r of rows) {
        html += '<tr>';
        const cells = isList(r) ? r.a : [r];
        cells.forEach((c, j) => {
            if (typeof c === 'string' && /^\\\[Span/.test(c)) return;
            const a = alignAt(j);
            const ta = a === 'left' ? 'left' : a === 'right' ? 'right' : a === 'center' ? 'center' : '';
            html += `<td${ta ? ` style="text-align:${ta}"` : ''}>${renderBox(c, cx)}</td>`;
        });
        html += '</tr>';
    }
    return html + '</table></span>';
}

const TEMPLATES = {
    Spacer1: () => ' ', Spacer2: () => ' ',
    RowDefault: (a, cx) => rowItems(a, cx),
    RowWithSeparators: (a, cx) => a.slice(2).map(x => renderBox(x, cx)).join(renderBox(a[0], cx) + ' '),
    RowWithSeparator: (a, cx) => a.slice(2).map(x => renderBox(x, cx)).join(renderBox(a[0], cx) + ' '),
    Ket: (a, cx) => '|' + rowItems(a, cx) + '⟩',
    Bra: (a, cx) => '⟨' + rowItems(a, cx) + '|',
    BraKet: (a, cx) => '⟨' + renderBox(a[0], cx) + '|' + renderBox(a[1], cx) + '⟩',
    Conjugate: (a, cx) => renderBox(a[0], cx) + '<sup class="nb-sup">*</sup>',
    Transpose: (a, cx) => renderBox(a[0], cx) + '<sup class="nb-sup">T</sup>',
    ConjugateTranspose: (a, cx) => renderBox(a[0], cx) + '<sup class="nb-sup">†</sup>',
    Abs: (a, cx) => '|' + renderBox(a[0], cx) + '|',
    Norm: (a, cx) => '‖' + renderBox(a[0], cx) + '‖',
    Floor: (a, cx) => '⌊' + renderBox(a[0], cx) + '⌋',
    Ceiling: (a, cx) => '⌈' + renderBox(a[0], cx) + '⌉',
    Binomial: (a, cx) => '<span class="nb-paren">(</span><span class="nb-frac nb-binom"><span>' + renderBox(a[0], cx) + '</span><span>' + renderBox(a[1], cx) + '</span></span><span class="nb-paren">)</span>',
    Quantity: (a, cx) => renderBox(a[0], cx) + ' ' + renderBox(a[1], cx),
    QuantityPostfix: (a, cx) => renderBox(a[0], cx) + renderBox(a[1], cx),
    QuantityUnit: (a, cx) => renderBox(a[0], cx),
    DateObject: (a, cx) => '<span class="nb-summary">' + renderBox(a[0], cx) + '</span>',
    SummaryPanel: (a, cx) => '<span class="nb-summary">' + renderBox(a[0], cx) + '</span>',
    Labeled: (a, cx) => '<span class="nb-labeled"><span>' + renderBox(a[0], cx) + '</span><span>' + renderBox(a[1], cx) + '</span></span>',
    HyperlinkTemplate: (a, cx) => link(renderBox(a[0], cx), urlOf(a[1]) || urlOf(a[2])),
    HyperlinkURL: (a, cx) => link(renderBox(a[0], cx), urlOf(a[1])),
    RefLink: (a, cx) => link(renderBox(a[0], { ...cx, showStr: false }), urlOf(a[1])),
    RefLinkPlain: (a, cx) => link(renderBox(a[0], { ...cx, showStr: false }), urlOf(a[1])),
    OrderlessPatternSequence: (a, cx) => rowItems(a, cx),
    // Messages: General::munfl: text
    MessageTemplate: (a, cx) => '<span class="nb-msgname">' + esc(boxText(a[0])) + '::' + esc(boxText(a[1])) + '</span>: ' + renderBox(a[2], cx),
    MessageTemplate2: (a, cx) => '<span class="nb-msgname">' + esc(boxText(a[0])) + '::' + esc(boxText(a[1])) + '</span>: ' + renderBox(a[2], cx),
};

function renderBox(b, cx) {
    if (typeof b === 'string') return renderString(b, cx);
    if (typeof b === 'number') return esc(String(b));
    if (!b) return '';
    if (b.s !== undefined) return b.s === 'Null' || b.s === 'None' ? '' : esc(b.s);
    const h = headName(b);
    const a = b.a;
    switch (h) {
        case 'List': return rowItems(a, cx);
        case 'RowBox': {
            const items = isList(a[0]) ? a[0].a : [a[0]];
            if (!cx.text && items[0] === '(*' && items[items.length - 1] === '*)') return '<span class="nb-comment">' + rowItems(items, { ...cx, comment: true }) + '</span>';
            return '<span class="nb-row">' + rowItems(items, cx) + '</span>';
        }
        case 'SuperscriptBox': return '<span class="nb-row">' + renderBox(a[0], cx) + '<sup class="nb-sup">' + renderBox(a[1], cx) + '</sup></span>';
        case 'SubscriptBox': return '<span class="nb-row">' + renderBox(a[0], cx) + '<sub class="nb-sub">' + renderBox(a[1], cx) + '</sub></span>';
        case 'SubsuperscriptBox': return '<span class="nb-row">' + renderBox(a[0], cx) + '<span class="nb-subsup"><span>' + renderBox(a[2], cx) + '</span><span>' + renderBox(a[1], cx) + '</span></span></span>';
        case 'FractionBox': return '<span class="nb-frac"><span>' + renderBox(a[0], cx) + '</span><span>' + renderBox(a[1], cx) + '</span></span>';
        case 'SqrtBox': return '<span class="nb-sqrt"><span class="nb-radical">√</span><span class="nb-radicand">' + renderBox(a[0], cx) + '</span></span>';
        case 'RadicalBox': return '<span class="nb-sqrt"><sup class="nb-index">' + renderBox(a[1], cx) + '</sup><span class="nb-radical">√</span><span class="nb-radicand">' + renderBox(a[0], cx) + '</span></span>';
        case 'OverscriptBox': return '<span class="nb-stack"><span class="nb-small">' + renderBox(a[1], cx) + '</span><span>' + renderBox(a[0], cx) + '</span></span>';
        case 'UnderscriptBox': return '<span class="nb-stack under"><span>' + renderBox(a[0], cx) + '</span><span class="nb-small">' + renderBox(a[1], cx) + '</span></span>';
        case 'UnderoverscriptBox': return '<span class="nb-stack"><span class="nb-small">' + renderBox(a[2], cx) + '</span><span>' + renderBox(a[0], cx) + '</span><span class="nb-small">' + renderBox(a[1], cx) + '</span></span>';
        case 'GridBox': return renderGrid(b, cx);
        case 'StyleBox': {
            const s = styleCss(a.slice(1), cx);
            return `<span class="nb-style${s.cls}"${s.style ? ` style="${s.style}"` : ''}>${renderBox(a[0], s.cx)}</span>`;
        }
        case 'FormBox': {
            const form = a[1] && a[1].s;
            return renderBox(a[0], { ...cx, trad: form === 'TraditionalForm' ? true : cx.trad });
        }
        case 'TagBox': case 'InterpretationBox': case 'ItemBox': case 'AdjustmentBox': case 'PaneBox':
        case 'DynamicModuleBox': case 'LocatorPaneBox': case 'ActionMenuBox': case 'AnimatorBox':
        case 'TableViewBox': case 'NamespaceBox': case 'Annotation':
            if (h === 'DynamicModuleBox' || h === 'LocatorPaneBox') return renderBox(a[1], cx);
            if (h === 'TagBox' && a[1] === 'Placeholder') return '<span class="nb-placeholder">⬚</span>';
            return renderBox(a[0], cx);
        case 'TooltipBox': return `<span title="${esc(boxText(a[1]))}">${renderBox(a[0], cx)}</span>`;
        case 'FrameBox': return '<span class="nb-frame">' + renderBox(a[0], cx) + '</span>';
        case 'PanelBox': return '<span class="nb-panel">' + renderBox(a[0], cx) + '</span>';
        case 'ErrorBox': return '<span class="nb-error">' + renderBox(a[0], cx) + '</span>';
        case 'OverlayBox': return '<span class="nb-overlay">' + (isList(a[0]) ? a[0].a.map(x => '<span>' + renderBox(x, cx) + '</span>').join('') : '') + '</span>';
        case 'RotationBox': {
            const o = opts(a.slice(1));
            const ang = num(o.get('BoxRotation')) || 0;
            return `<span class="nb-rotate" style="transform:rotate(${-ang}rad)">${renderBox(a[0], cx)}</span>`;
        }
        case 'ButtonBox': {
            const o = opts(a.slice(1));
            const label = renderBox(a[0], { ...cx, showStr: false });
            const base = o.get('BaseStyle');
            const data = o.get('ButtonData');
            const href = urlOf(data);
            if (href || base === 'Hyperlink' || base === 'Link' || (isList(base) && base.a.includes('Link'))) return link(label, href);
            return '<span class="nb-button">' + label + '</span>';
        }
        case 'TemplateBox': {
            const name = typeof a[1] === 'string' ? a[1] : '';
            if (headName(a[0]) === 'Association') {
                // <|"boxes" -> ..., ...|> (TeXAssistantTemplate and the like)
                const boxes = opts(a[0].a).get('boxes');
                if (boxes !== undefined) return renderBox(boxes, cx);
            }
            const args = isList(a[0]) ? a[0].a : [];
            const o = opts(a.slice(2));
            const df = o.get('DisplayFunction');
            if (df) {
                const body = applyPure(df, args);
                if (body) return renderBox(body, cx);
            }
            if (TEMPLATES[name]) return TEMPLATES[name](args, cx);
            return args.map(x => renderBox(x, cx)).join(' ');
        }
        case 'PaneSelectorBox': {
            const choices = isList(a[0]) ? a[0].a : [];
            const cur = a[1];
            const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
            const hit = choices.find(r => isRule(r) && same(r.a[0], cur)) || choices.find(r => isRule(r));
            return hit ? renderBox(hit.a[1], cx) : '';
        }
        case 'TogglerBox': {
            const choices = isList(a[1]) ? a[1].a : [];
            const hit = choices.find(r => isRule(r) && JSON.stringify(r.a[0]) === JSON.stringify(a[0])) || choices[0];
            return hit && isRule(hit) ? renderBox(hit.a[1], cx) : '';
        }
        case 'OpenerBox': return isSym(a[0], 'True') ? '▾' : '▸';
        case 'CheckboxBox': return isSym(a[0], 'True') ? '☑' : '☐';
        case 'RadioButtonBox': return '◉';
        case 'SliderBox': case 'Slider2DBox': case 'ProgressIndicatorBox': return '<span class="nb-slider"></span>';
        case 'InputFieldBox': return '<span class="nb-input-field">' + esc(boxText(a[0])) + '</span>';
        case 'PopupMenuBox': return '<span class="nb-button">' + esc(boxText(a[0])) + ' ▾</span>';
        case 'SetterBox': return '<span class="nb-button">' + renderBox(a[2], cx) + '</span>';
        case 'DynamicBox': case 'DynamicWrapperBox': return h === 'DynamicWrapperBox' ? renderBox(a[0], cx) : '<span class="nb-dynamic" title="Dynamic content">⟳</span>';
        case 'CounterBox': return '#';
        case 'ValueBox': return '';
        case 'Cell': return renderInlineCell(b, cx);
        case 'GraphicsBox': return renderGraphics(b, cx);
        case 'Graphics3DBox': return render3D(b, cx);
        case 'TextData': return renderTextData(a[0], cx);
        case 'BoxData': return renderBox(a[0], cx);
        case 'Rule': case 'RuleDelayed': return '';
    }
    // Something else in box position: show its head and arguments plainly
    return esc(boxText(b));
}

// The text of a box, without layout (tooltips, input fields, simple labels)
function boxText(b) {
    if (typeof b === 'string') return b.replace(/^"(.*)"$/s, '$1').replace(new RegExp(LS + '.', 'g'), '');
    if (typeof b === 'number') return String(b);
    if (!b) return '';
    if (b.s !== undefined) return b.s === 'Null' || b.s === 'None' ? '' : b.s;
    const h = headName(b);
    if (h === 'List') return b.a.map(boxText).join('');
    if (h === 'RowBox') return boxText(b.a[0]);
    if (h === 'SuperscriptBox') return boxText(b.a[0]) + '^' + boxText(b.a[1]);
    if (h === 'SubscriptBox') return boxText(b.a[0]) + '_' + boxText(b.a[1]);
    if (h === 'FractionBox') return boxText(b.a[0]) + '/' + boxText(b.a[1]);
    if (h && /Box$|^(TextData|BoxData|Cell)$/.test(h)) return b.a.length ? boxText(b.a[0]) : '';
    return (h || '') + '[' + b.a.map(boxText).join(', ') + ']';
}

function renderTextData(t, cx) {
    const tcx = { ...cx, text: true, showStr: false };
    if (typeof t === 'string') return renderString(t, tcx);
    if (isList(t)) return t.a.map(x => renderTextData(x, cx)).join('');
    const h = headName(t);
    if (h === 'StyleBox') {
        const s = styleCss(t.a.slice(1), tcx);
        return `<span class="nb-style${s.cls}"${s.style ? ` style="${s.style}"` : ''}>${renderTextData(t.a[0], s.cx)}</span>`;
    }
    if (h === 'ButtonBox') return renderBox(t, tcx);
    return renderBox(t, tcx);
}

function renderInlineCell(c, cx) {
    const content = c.a[0];
    const styles = c.a.slice(1).filter(x => typeof x === 'string');
    const o = opts(c.a.slice(1));
    const style = cellStyleCss(o);
    const mono = styles.some(s => /Input|Code/.test(s));
    const icx = { ...cx, text: false, showStr: mono, trad: cx.trad };
    let html;
    if (typeof content === 'string') html = renderString(content, { ...icx, text: true });
    else if (headName(content) === 'TextData') html = renderTextData(content.a[0], icx);
    else if (headName(content) === 'BoxData') html = renderBox(content.a[0], icx);
    else html = renderBox(content, icx);
    return `<span class="nb-inline${mono ? ' nb-inline-input' : ''}"${style ? ` style="${style}"` : ''}>${html}</span>`;
}

// --- Graphics ---
const DEFAULT_STYLE = {
    color: [0, 0, 0, 1], face: null, edge: null, thick: { abs: 1 }, dash: null, opacity: 1,
    pointSize: { rel: 0.008 }, arrow: { rel: 0.04 }, cap: null,
};

function applyDirective(st, d) {
    if (isList(d)) { for (const x of d.a) applyDirective(st, x); return true; }
    const c = toColor(d);
    if (c) { st.color = c; return true; }
    const h = headName(d) || (d && d.s);
    const n = d && d.a ? num(d.a[0]) : null;
    switch (h) {
        case 'Directive': for (const x of d.a) applyDirective(st, x); return true;
        case 'Opacity': st.opacity = n === null ? 1 : n; if (d.a[1]) { const cc = toColor(d.a[1]); if (cc) st.color = cc; } return true;
        case 'Thickness': st.thick = n !== null ? { rel: n } : { abs: ({ Tiny: 0.5, Small: 1, Medium: 2, Large: 3 })[d.a[0] && d.a[0].s] || 1 }; return true;
        case 'AbsoluteThickness': st.thick = { abs: n !== null ? n : ({ Tiny: 0.25, Small: 0.5, Medium: 1, Large: 2 })[d.a[0] && d.a[0].s] || 1 }; return true;
        case 'Thick': st.thick = { abs: 2 }; return true;
        case 'Thin': st.thick = { abs: 0.5 }; return true;
        case 'PointSize': st.pointSize = n !== null ? { rel: n } : { abs: ({ Tiny: 2, Small: 3, Medium: 5, Large: 8 })[d.a[0] && d.a[0].s] || 3 }; return true;
        case 'AbsolutePointSize': st.pointSize = { abs: n !== null ? n : 3 }; return true;
        case 'Dashing': {
            const v = d.a[0];
            if (isList(v)) st.dash = v.a.length ? { rel: v.a.map(num).filter(x => x !== null) } : null;
            else if (n !== null) st.dash = { rel: [n, n] };
            else st.dash = { abs: ({ Tiny: [1, 2], Small: [2, 3], Medium: [4, 4], Large: [8, 6] })[v && v.s] || [4, 4] };
            return true;
        }
        case 'AbsoluteDashing': {
            const v = d.a[0];
            st.dash = isList(v) ? (v.a.length ? { abs: v.a.map(num).filter(x => x !== null) } : null) : n !== null ? { abs: [n, n] } : null;
            return true;
        }
        case 'Dashed': st.dash = { abs: [6, 4] }; return true;
        case 'Dotted': st.dash = { abs: [1, 3] }; return true;
        case 'DotDashed': st.dash = { abs: [1, 3, 6, 3] }; return true;
        case 'EdgeForm': {
            if (!d.a.length || isSym(d.a[0], 'None')) { st.edge = null; return true; }
            const e = { ...DEFAULT_STYLE, thick: { abs: 1 } };
            applyDirective(e, d.a[0]);
            st.edge = e;
            return true;
        }
        case 'FaceForm': {
            if (!d.a.length || isSym(d.a[0], 'None')) { st.face = 'none'; return true; }
            const f = { color: st.color, opacity: st.opacity };
            applyDirective(f, d.a[0]);
            st.face = f;
            return true;
        }
        case 'Arrowheads': {
            let v = d.a[0];
            if (isList(v) && v.a.length && isList(v.a[0])) v = v.a[0].a[0];
            else if (isList(v)) v = v.a[v.a.length - 1];
            const s = num(v);
            st.arrow = s !== null ? { rel: s } : { rel: ({ Tiny: 0.015, Small: 0.03, Medium: 0.05, Large: 0.08 })[v && v.s] || 0.04 };
            return true;
        }
        case 'CapForm': case 'JoinForm': case 'Specularity': case 'Glow': case 'Lighting': case 'FontSize': case 'FontFamily':
        case 'FontWeight': case 'FontSlant': case 'FontColor': case 'Antialiasing': case 'StrokeForm': case 'BaseStyle':
            if (h === 'CapForm' && d.a[0]) st.cap = String(d.a[0].s || d.a[0]).toLowerCase();
            return true;
    }
    return false;
}

// Points: [x, y] in data coordinates, or { scaled: [sx, sy] }, { off: [dx, dy], base }
function point(e, g) {
    if (typeof e === 'number' && g.verts) return g.verts[e - 1] && g.tf(g.verts[e - 1]);
    if (isList(e) && e.a.length >= 2) {
        const x = num(e.a[0]), y = num(e.a[1]);
        if (x !== null && y !== null) return g.tf([x, y]);
        return null;
    }
    const h = headName(e);
    if (h === 'Scaled' || h === 'ImageScaled') {
        const v = e.a[0];
        if (isNumList(v, 2)) return { scaled: [num(v.a[0]), num(v.a[1])], image: h === 'ImageScaled' };
    }
    if (h === 'Offset') {
        const off = isNumList(e.a[0], 2) ? [num(e.a[0].a[0]), num(e.a[0].a[1])] : [0, 0];
        return { off, base: e.a[1] ? point(e.a[1], g) : [0, 0] };
    }
    return null;
}

// A list of points, or of lists of them (several lines/polygons): lists of points
function pointLists(e, g) {
    if (!isList(e) || !e.a.length) return [];
    const first = e.a[0];
    if (g.verts) {
        if (typeof first === 'number') return [e.a.map(i => point(i, g)).filter(Boolean)];
        if (isList(first) && typeof first.a[0] === 'number' && !isList(first.a[0])) return e.a.map(l => (isList(l) ? l.a.map(i => point(i, g)).filter(Boolean) : []));
    }
    if (isNumList(first) || headName(first) === 'Scaled' || headName(first) === 'Offset') return [e.a.map(p => point(p, g)).filter(Boolean)];
    if (isList(first)) return e.a.flatMap(l => pointLists(l, g));
    return [];
}

function sampleBezier(pts, degree = 3) {
    if (pts.length < 2) return pts;
    const out = [pts[0]];
    for (let i = 0; i + degree < pts.length + 0; i += degree) {
        const seg = pts.slice(i, i + degree + 1);
        if (seg.length < degree + 1) break;
        for (let k = 1; k <= 16; k++) {
            const t = k / 16;
            let p = seg.map(q => q.slice());
            while (p.length > 1) p = p.slice(1).map((q, j) => q.map((v, d) => p[j][d] * (1 - t) + v * t));
            out.push(p[0]);
        }
    }
    return out;
}

function sampleBSpline(pts, degree = 3, closed = false) {
    if (closed) pts = pts.concat(pts.slice(0, degree));
    const n = pts.length - 1;
    const d = Math.min(degree, n);
    if (d < 1) return pts;
    const knots = [];
    if (closed) for (let i = 0; i <= n + d + 1; i++) knots.push(i);
    else {
        for (let i = 0; i <= d; i++) knots.push(0);
        for (let i = 1; i <= n - d; i++) knots.push(i);
        for (let i = 0; i <= d; i++) knots.push(n - d + 1);
    }
    const lo = knots[d], hi = knots[n + 1];
    const out = [];
    const steps = Math.max(32, pts.length * 8);
    for (let s = 0; s <= steps; s++) {
        const t = lo + (hi - lo) * Math.min(s / steps, 1 - 1e-9);
        let k = d;
        while (k < n && t >= knots[k + 1]) k++;
        const p = [];
        for (let j = 0; j <= d; j++) p.push(pts[k - d + j].slice());
        for (let r = 1; r <= d; r++) {
            for (let j = d; j >= r; j--) {
                const i = k - d + j;
                const a = (t - knots[i]) / (knots[i + d - r + 1] - knots[i]);
                p[j] = p[j].map((v, q) => (1 - a) * p[j - 1][q] + a * v);
            }
        }
        out.push(p[d]);
    }
    return out;
}

function affine(m, v) {
    // [a b; c d] and translation (e, f): (x, y) -> (a x + b y + e, c x + d y + f)
    return [m[0][0], m[0][1], m[1][0], m[1][1], v[0], v[1]];
}
function compose(t, u) {
    // t after u
    return [t[0] * u[0] + t[1] * u[2], t[0] * u[1] + t[1] * u[3], t[2] * u[0] + t[3] * u[2], t[2] * u[1] + t[3] * u[3], t[0] * u[4] + t[1] * u[5] + t[4], t[2] * u[4] + t[3] * u[5] + t[5]];
}
function transforms(spec) {
    const mat = (e) => isList(e) && e.a.length === 2 && e.a.every(r => isNumList(r, 2)) ? e.a.map(r => r.a.map(num)) : null;
    const vec = (e) => isNumList(e, 2) ? e.a.map(num) : null;
    const one = (e) => {
        const m = mat(e);
        if (m) return affine(m, [0, 0]);
        const v = vec(e);
        if (v) return [1, 0, 0, 1, v[0], v[1]];
        if (isList(e) && e.a.length === 2) {
            const m2 = mat(e.a[0]), v2 = vec(e.a[1]);
            if (m2 && v2) return affine(m2, v2);
        }
        if (headName(e) === 'TransformationFunction' && isList(e.a[0])) {
            const r = e.a[0].a.map(row => row.a.map(num));
            return [r[0][0], r[0][1], r[1][0], r[1][1], r[0][2], r[1][2]];
        }
        return null;
    };
    const t = one(spec);
    if (t) return [t];
    if (isList(spec)) return spec.a.map(one).filter(Boolean);
    return [];
}

class Scene2D {
    constructor() {
        this.items = [];
        this.bounds = [Infinity, -Infinity, Infinity, -Infinity];
    }
    grow(p) {
        if (!Array.isArray(p)) return;
        if (!isFinite(p[0]) || !isFinite(p[1])) return;
        const b = this.bounds;
        if (p[0] < b[0]) b[0] = p[0];
        if (p[0] > b[1]) b[1] = p[0];
        if (p[1] < b[2]) b[2] = p[1];
        if (p[1] > b[3]) b[3] = p[1];
    }
    add(item) {
        this.items.push(item);
        for (const p of item.pts || []) this.grow(p);
    }
}

function walk2D(e, st, g, scene, cx) {
    if (!e || typeof e !== 'object') return;
    if (isList(e)) {
        const local = { ...st };
        for (const x of e.a) {
            if (!isList(x) && applyDirective(local, x)) continue;
            walk2D(x, local, g, scene, cx);
        }
        return;
    }
    const h = headName(e);
    const a = e.a || [];
    const o = () => opts(a.filter(isRule));
    switch (h) {
        case 'LineBox': case 'Line': {
            if (headName(a[0]) === 'BezierCurveBox' || headName(a[0]) === 'BSplineCurveBox') { walk2D(a[0], st, g, scene, cx); return; }
            for (const pts of pointLists(a[0], g)) scene.add({ k: 'line', pts, st });
            return;
        }
        case 'ArrowBox': case 'Arrow': {
            let inner = a[0];
            let pts;
            if (headName(inner) === 'BezierCurveBox') pts = sampleBezier(pointLists(inner.a[0], g)[0] || []);
            else if (headName(inner) === 'BSplineCurveBox') pts = sampleBSpline(pointLists(inner.a[0], g)[0] || []);
            if (pts) { scene.add({ k: 'line', pts, st, arrow: true }); return; }
            for (const p of pointLists(inner, g)) scene.add({ k: 'line', pts: p, st, arrow: true });
            return;
        }
        case 'BezierCurveBox': {
            const deg = num(o().get('SplineDegree')) || 3;
            for (const pts of pointLists(a[0], g)) scene.add({ k: 'line', pts: sampleBezier(pts.filter(Array.isArray), deg), st });
            return;
        }
        case 'BSplineCurveBox': {
            const op = o();
            const deg = num(op.get('SplineDegree')) || 3;
            for (const pts of pointLists(a[0], g)) scene.add({ k: 'line', pts: sampleBSpline(pts.filter(Array.isArray), deg, isSym(op.get('SplineClosed'), 'True')), st });
            return;
        }
        case 'JoinedCurveBox': case 'FilledCurveBox': {
            const src = a.length > 1 && isList(a[1]) ? a[1] : a[0];
            const lists = pointLists(src, g);
            for (const pts of lists) scene.add({ k: h === 'FilledCurveBox' ? 'polygon' : 'line', pts, st });
            return;
        }
        case 'PolygonBox': case 'Polygon': {
            const op = o();
            let src = a[0];
            if (headName(src) === 'Rule') src = src.a[0];
            const vc = op.get('VertexColors') || g.vertexColors;
            const lists = pointLists(src, g);
            const idx = g.verts && isList(src) ? (typeof src.a[0] === 'number' ? [src.a] : src.a.map(l => (isList(l) ? l.a : []))) : null;
            lists.forEach((pts, k) => {
                let pst = st;
                if (vc && isList(vc)) {
                    const cols = idx && g.vertexColors === vc ? idx[k].map(i => toColor(vc.a[i - 1])) : (op.get('VertexColors') ? vc.a.map(toColor) : []);
                    const ok = cols.filter(Boolean);
                    if (ok.length) {
                        const avg = [0, 1, 2, 3].map(d => ok.reduce((s, c) => s + c[d], 0) / ok.length);
                        pst = { ...st, face: { color: avg, opacity: st.opacity } };
                    }
                }
                scene.add({ k: 'polygon', pts, st: pst });
            });
            return;
        }
        case 'PointBox': case 'Point': {
            const src = a[0];
            let pts;
            if (typeof src === 'number' && g.verts) pts = [point(src, g)];
            else if (isNumList(src, 2) || headName(src) === 'Scaled') pts = [point(src, g)];
            else pts = pointLists(src, g)[0] || [];
            const lists = isList(src) && isList(src.a[0]) && isList(src.a[0].a[0]) ? pointLists(src, g) : [pts];
            for (const l of lists) scene.add({ k: 'points', pts: l.filter(Boolean), st });
            return;
        }
        case 'DiskBox': case 'CircleBox': case 'Disk': case 'Circle': {
            const c = point(a[0] || list([0, 0]), g) || [0, 0];
            let r = [1, 1];
            if (a[1] !== undefined && !isRule(a[1])) {
                if (isNumList(a[1], 2)) r = a[1].a.map(num);
                else if (num(a[1]) !== null) r = [num(a[1]), num(a[1])];
            }
            const ang = a[2] && isNumList(a[2], 2) ? a[2].a.map(num) : null;
            const s = g.scale;
            const item = { k: h.startsWith('Disk') ? 'disk' : 'circle', c, r: [r[0] * s[0], r[1] * s[1]], ang, st };
            scene.add(item);
            if (Array.isArray(c)) { scene.grow([c[0] - item.r[0], c[1] - item.r[1]]); scene.grow([c[0] + item.r[0], c[1] + item.r[1]]); }
            return;
        }
        case 'RectangleBox': case 'Rectangle': {
            const p1 = point(a[0] || list([0, 0]), g) || [0, 0];
            const p2 = a[1] && !isRule(a[1]) ? point(a[1], g) : Array.isArray(p1) ? [p1[0] + 1, p1[1] + 1] : null;
            if (!Array.isArray(p1) || !Array.isArray(p2)) return;
            scene.add({ k: 'polygon', pts: [p1, [p2[0], p1[1]], p2, [p1[0], p2[1]]], st });
            return;
        }
        case 'InsetBox': case 'Inset': case 'Text': case 'TextBox': {
            const pos = a[1] !== undefined && !isRule(a[1]) ? point(a[1], g) : [0, 0];
            if (headName(a[0]) === 'GraphicsBox' || headName(a[0]) === 'Graphics3DBox') {
                // Graphics placed in graphics: sized in these coordinates
                let size = null;
                if (isNumList(a[3], 2)) size = a[3].a.map(num);
                else if (num(a[3]) !== null) size = [num(a[3]), null];
                const inner = opts(a[0].a.slice(1)).get('PlotRange');
                let align = [0.5, 0.5];
                if (isNumList(a[2], 2) && isList(inner) && inner.a.length === 2 && inner.a.every(r => isNumList(r, 2))) {
                    const r = inner.a.map(x => x.a.map(num));
                    align = [(num(a[2].a[0]) - r[0][0]) / (r[0][1] - r[0][0]), (num(a[2].a[1]) - r[1][0]) / (r[1][1] - r[1][0])];
                } else if (headName(a[2]) === 'ImageScaled' && isNumList(a[2].a[0], 2)) align = a[2].a[0].a.map(num);
                scene.items.push({ k: 'ginset', pos, box: a[0], size, align, cx });
                if (Array.isArray(pos)) {
                    scene.grow(pos);
                    if (size) {
                        const h = size[1] === null ? size[0] : size[1];
                        scene.grow([pos[0] - size[0] * align[0], pos[1] - h * align[1]]);
                        scene.grow([pos[0] + size[0] * (1 - align[0]), pos[1] + h * (1 - align[1])]);
                    }
                }
                return;
            }
            let align = [0.5, 0.5];
            const off = a[2];
            if (isNumList(off, 2)) align = [(num(off.a[0]) + 1) / 2, (num(off.a[1]) + 1) / 2];
            else if (headName(off) === 'ImageScaled' && isNumList(off.a[0], 2)) align = off.a[0].a.map(num);
            else if (headName(off) === 'Scaled' && isNumList(off.a[0], 2)) align = off.a[0].a.map(num);
            const item = { k: 'inset', pos, box: a[0], align, st, cx };
            if (Array.isArray(pos)) scene.grow(pos);
            scene.items.push(item);
            return;
        }
        case 'RasterBox': case 'Raster': {
            const data = a[0];
            if (!isList(data) || !data.a.length || !isList(data.a[0])) return;
            const rows = data.a.length, cols = data.a[0].a.length;
            let rect = [[0, 0], [cols, rows]];
            if (isList(a[1]) && a[1].a.length === 2 && a[1].a.every(p => isNumList(p, 2))) rect = a[1].a.map(p => p.a.map(num));
            let range = null;
            if (isNumList(a[2], 2)) range = a[2].a.map(num);
            const op = o();
            const cf = op.get('ColorFunction');
            scene.add({ k: 'raster', data, rect, range, cf, st, pts: [g.tf(rect[0]), g.tf(rect[1])] });
            return;
        }
        case 'GraphicsComplexBox': case 'GraphicsComplex': {
            const verts = isList(a[0]) ? a[0].a.map(p => (isList(p) ? [num(p.a[0]), num(p.a[1])] : [0, 0])) : [];
            const op = opts(a.slice(2));
            const g2 = { ...g, verts, vertexColors: op.get('VertexColors') || null };
            walk2D(a[1], st, g2, scene, cx);
            return;
        }
        case 'GeometricTransformationBox': case 'GeometricTransformation': {
            for (const t of transforms(a[1])) {
                const tf0 = g.tf;
                const total = t;
                const g2 = { ...g, tf: (p) => tf0([total[0] * p[0] + total[1] * p[1] + total[4], total[2] * p[0] + total[3] * p[1] + total[5]]), scale: [g.scale[0] * Math.hypot(t[0], t[2]), g.scale[1] * Math.hypot(t[1], t[3])] };
                if (g.verts) g2.verts = g.verts;
                walk2D(a[0], st, g2, scene, cx);
            }
            return;
        }
        case 'StyleBox': case 'Style': {
            const local = { ...st };
            for (const d of a.slice(1)) applyDirective(local, d);
            walk2D(a[0], local, g, scene, cx);
            return;
        }
        case 'GraphicsGroupBox': case 'GraphicsGroup': case 'TagBox': case 'TooltipBox': case 'Tooltip': case 'AnnotationBox':
        case 'Annotation': case 'InterpretationBox': case 'DynamicModuleBox': case 'Hyperlink': case 'ButtonBox': case 'EventHandler':
        case 'StatusArea': case 'MouseAppearance': case 'PaneSelectorBox': case 'LocatorPaneBox':
            if (h === 'DynamicModuleBox' || h === 'LocatorPaneBox') walk2D(a[1], st, g, scene, cx);
            else if (h === 'PaneSelectorBox') { const r = isList(a[0]) && a[0].a.find(isRule); if (r) walk2D(r.a[1], st, g, scene, cx); }
            else walk2D(a[0], st, g, scene, cx);
            return;
        case 'GraphicsBox': {
            // Graphics inside graphics: drawn in place, in the same coordinates
            walk2D(a[0], st, g, scene, cx);
            return;
        }
    }
}

function niceStep(range, count) {
    const raw = range / Math.max(count, 1);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

function autoTicks(lo, hi, count) {
    if (!(hi > lo) || !isFinite(lo) || !isFinite(hi) || (hi - lo) < 1e-9 * Math.max(Math.abs(lo), Math.abs(hi))) return { major: [], minor: [] };
    count = Math.min(Math.max(count, 1), 50);
    const step = niceStep(hi - lo, count);
    const major = [];
    const start = Math.ceil(lo / step - 1e-9);
    for (let k = start; k * step <= hi + step * 1e-9; k++) major.push(+(k * step).toPrecision(12));
    const sub = String(step / Math.pow(10, Math.floor(Math.log10(step))))[0] === '2' ? 4 : 5;
    const minor = [];
    const ms = step / sub;
    for (let k = Math.ceil(lo / ms - 1e-9); k * ms <= hi + ms * 1e-9; k++) {
        const v = +(k * ms).toPrecision(12);
        if (Math.abs(v / step - Math.round(v / step)) > 1e-6) minor.push(v);
    }
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    return { major: major.map(v => ({ v, label: tickLabel(v, decimals, step) })), minor };
}

function tickLabel(v, decimals, step) {
    if (Math.abs(v) < step * 1e-9) v = 0;
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-4)) {
        const e = Math.floor(Math.log10(a));
        const m = +(v / Math.pow(10, e)).toPrecision(3);
        return { html: `${m === 1 ? '' : m === -1 ? '−' : String(m).replace('-', '−') + '×'}10<sup>${e}</sup>` };
    }
    let s = v.toFixed(decimals);
    if (decimals > 0 && Number.isInteger(step * Math.pow(10, decimals - 1)) === false) { /* keep */ }
    return { text: s.replace('-', '−') };
}

// Explicit tick specs: {{x, label, ...}, x, ...}
function explicitTicks(spec, cx) {
    if (!isList(spec)) return null;
    const major = [];
    const minor = [];
    for (const t of spec.a) {
        const v = num(t);
        if (v !== null) { major.push({ v, label: { text: String(+v.toPrecision(6)) } }); continue; }
        if (isList(t) && t.a.length) {
            const pos = num(t.a[0]);
            if (pos === null) continue;
            const lab = t.a[1];
            const len = t.a[2];
            const isMinor = isList(len) && len.a.length && num(len.a[0]) !== null && num(len.a[0]) < 0.006 && (lab === '' || lab === undefined || isSym(lab, 'None') || (headName(lab) === 'StyleBox' && lab.a[0] === ''));
            if (isMinor) { minor.push(pos); continue; }
            const empty = lab === undefined || isSym(lab, 'None') || lab === '' || lab === '""';
            major.push({ v: pos, label: empty ? null : { html: renderBox(lab, { ...cx, showStr: false }) } });
        }
    }
    return { major, minor };
}

function tickSpec(spec, lo, hi, count, cx, labelled = true) {
    if (spec === undefined || isSym(spec, 'Automatic') || isSym(spec, 'True') || (spec && !isList(spec) && !isSym(spec, 'None') && !isSym(spec, 'False'))) {
        const t = autoTicks(lo, hi, count);
        if (!labelled) t.major.forEach(m => { m.label = null; });
        return t;
    }
    if (isSym(spec, 'None') || isSym(spec, 'False')) return null;
    if (isSym(spec, 'All')) return autoTicks(lo, hi, count);
    const t = explicitTicks(spec, cx);
    if (t) t.major = t.major.filter(m => m.v >= lo - (hi - lo) * 1e-9 && m.v <= hi + (hi - lo) * 1e-9);
    if (t) t.minor = t.minor.filter(v => v >= lo && v <= hi);
    return t;
}

function pair(e) {
    if (isList(e) && e.a.length === 2) return [e.a[0], e.a[1]];
    return [e, e];
}

function padding(spec, lo, hi) {
    const one = (p) => {
        if (p === undefined || isSym(p, 'Automatic')) return (hi - lo) * 0.02;
        if (isSym(p, 'None')) return 0;
        if (headName(p) === 'Scaled') return (num(p.a[0]) || 0) * (hi - lo);
        const n = num(p);
        return n === null ? 0 : n;
    };
    const [a, b] = pair(spec);
    return [one(a), one(b)];
}

function resolveRange(spec, lo, hi) {
    if (isNumList(spec, 2)) {
        const r = spec.a.map(num);
        if (r[1] > r[0]) return r;
    }
    if (isList(spec) && spec.a.length === 2) {
        const a = num(spec.a[0]), b = num(spec.a[1]);
        if (a !== null && b === null) return [a, hi];
        if (a === null && b !== null) return [lo, b];
    }
    return [lo, hi];
}

const IMAGE_SIZES = { Tiny: 100, Small: 180, Medium: 360, Large: 576, Full: 640 };
function imageSizeOf(o, dflt) {
    const s = o.get('ImageSize');
    const one = (e) => {
        const n = num(e);
        if (n !== null) return n;
        if (e && e.s && IMAGE_SIZES[e.s]) return IMAGE_SIZES[e.s];
        if (isList(e) && e.a.length === 1) return one(e.a[0]);
        return null;
    };
    if (s === undefined) return { w: dflt, h: null };
    if (isList(s) && s.a.length === 2) return { w: one(s.a[0]), h: one(s.a[1]) };
    return { w: one(s) || dflt, h: null };
}

function strokeAttrs(st, W, sw = st.thick) {
    const width = sw.abs !== undefined ? sw.abs : sw.rel * W;
    let s = ` stroke="${css(st.color, st.opacity)}" stroke-width="${fmt(Math.max(width, 0.3))}"`;
    if (st.dash) {
        const d = st.dash.abs || st.dash.rel.map(v => v * W);
        if (d.length && d.some(v => v > 0)) s += ` stroke-dasharray="${d.map(fmt).join(' ')}"`;
    }
    if (st.cap) s += ` stroke-linecap="${st.cap === 'butt' ? 'butt' : st.cap}"`;
    return s;
}

function rasterImage(item, env) {
    if (!env.rasterUrl) return null;
    const rowsL = item.data.a;
    const rows = rowsL.length;
    const cols = rowsL[0].a.length;
    const sample = rowsL[0].a[0];
    const channels = isList(sample) ? sample.a.length : 1;
    let [lo, hi] = item.range || [0, 1];
    if (!item.range) {
        // Bytes come with their range; reals without one are 0..1
        let max = -Infinity;
        for (let r = 0; r < Math.min(rows, 4); r++) for (const v of rowsL[r].a) { const x = isList(v) ? v.a[0] : v; if (x > max) max = x; }
        if (max > 1.5) hi = 255;
    }
    const cfName = item.cf && (item.cf.s || headName(item.cf));
    const flip = item.rect[1][1] > item.rect[0][1];
    const px = new Uint8ClampedArray(rows * cols * 4);
    const k = (v) => Math.round(Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 255);
    for (let r = 0; r < rows; r++) {
        const row = rowsL[r].a;
        const y = flip ? rows - 1 - r : r;
        for (let c = 0; c < cols; c++) {
            const v = row[c];
            const o = (y * cols + c) * 4;
            if (channels === 1) {
                const x = typeof v === 'number' ? v : 0;
                if (cfName === 'Hue') {
                    const rgb = hsb((x - lo) / (hi - lo), 1, 1, 1);
                    px[o] = rgb[0] * 255; px[o + 1] = rgb[1] * 255; px[o + 2] = rgb[2] * 255;
                } else {
                    px[o] = px[o + 1] = px[o + 2] = k(x);
                }
                px[o + 3] = 255;
            } else {
                const a = v.a;
                if (cfName === 'Hue') {
                    const rgb = hsb((a[0] - lo) / (hi - lo), (a[1] - lo) / (hi - lo), (a[2] - lo) / (hi - lo), 1);
                    px[o] = rgb[0] * 255; px[o + 1] = rgb[1] * 255; px[o + 2] = rgb[2] * 255;
                } else if (channels === 2) {
                    px[o] = px[o + 1] = px[o + 2] = k(a[0]);
                } else {
                    px[o] = k(a[0]); px[o + 1] = k(a[1]); px[o + 2] = k(a[2]);
                }
                px[o + 3] = channels === 4 || channels === 2 ? k(a[channels - 1]) : 255;
            }
        }
    }
    return env.rasterUrl(cols, rows, px);
}

function renderGraphics(b, cx, fit) {
    let prims = b.a[0];
    let optArgs = b.a.slice(1);
    while (headName(prims) === 'GraphicsBox') { optArgs = [...optArgs, ...prims.a.slice(1)]; prims = prims.a[0]; }
    const o = opts(optArgs);
    const scene = new Scene2D();
    const g = { tf: p => p, scale: [1, 1], verts: null };
    walk2D(prims, { ...DEFAULT_STYLE }, g, scene, cx);

    let [x0, x1, y0, y1] = scene.bounds;
    if (!(x1 >= x0)) { x0 = -1; x1 = 1; }
    if (!(y1 >= y0)) { y0 = -1; y1 = 1; }
    const pr = o.get('PlotRange');
    let xr = [x0, x1], yr = [y0, y1];
    if (pr !== undefined) {
        const n = num(pr);
        if (n !== null) { xr = [-n, n]; yr = [-n, n]; }
        else if (isNumList(pr, 2)) yr = pr.a.map(num);
        else if (isList(pr) && pr.a.length === 2) { xr = resolveRange(pr.a[0], x0, x1); yr = resolveRange(pr.a[1], y0, y1); }
    }
    const widen = (r) => {
        // Rounding error is no range (a constant plotted: 100 - 1e-14 .. 100)
        if (r[1] - r[0] > 1e-9 * Math.max(Math.abs(r[0]), Math.abs(r[1]))) return r;
        const d = Math.abs(r[0]) * 0.1 || 1;
        return [r[0] - d, r[1] + d];
    };
    xr = widen(xr); yr = widen(yr);
    const prp = o.get('PlotRangePadding');
    let px = [(xr[1] - xr[0]) * 0.02, (xr[1] - xr[0]) * 0.02], py = [(yr[1] - yr[0]) * 0.02, (yr[1] - yr[0]) * 0.02];
    if (prp !== undefined) {
        if (isList(prp) && prp.a.length === 2) { px = padding(prp.a[0], xr[0], xr[1]); py = padding(prp.a[1], yr[0], yr[1]); }
        else { px = padding(prp, xr[0], xr[1]); py = padding(prp, yr[0], yr[1]); }
    }
    xr = [xr[0] - px[0], xr[1] + px[1]];
    yr = [yr[0] - py[0], yr[1] + py[1]];

    // Axes, frame, labels
    const axesOpt = o.get('Axes');
    const [axX, axY] = pair(axesOpt).map(v => isSym(v, 'True'));
    const frameOpt = o.get('Frame');
    let frame = [false, false, false, false]; // left, right, bottom, top
    if (isSym(frameOpt, 'True')) frame = [true, true, true, true];
    else if (isList(frameOpt) && frameOpt.a.length === 2 && isList(frameOpt.a[0])) {
        frame = [isSym(frameOpt.a[0].a[0], 'True'), isSym(frameOpt.a[0].a[1], 'True'), isSym(frameOpt.a[1].a[0], 'True'), isSym(frameOpt.a[1].a[1], 'True')];
    } else if (isList(frameOpt) && frameOpt.a.length === 4) {
        frame = [frameOpt.a[1], frameOpt.a[3], frameOpt.a[0], frameOpt.a[2]].map(v => isSym(v, 'True'));
    }
    const anyFrame = frame.some(Boolean);
    const labelCx = { ...cx, showStr: false, trad: true, text: false };
    const labelHtml = (e) => (e === undefined || isSym(e, 'None') || e === '' ? '' : renderBox(e, labelCx));

    let aspect = num(o.get('AspectRatio'));
    if (aspect === null) {
        const ar = o.get('AspectRatio');
        aspect = isSym(ar, 'Full') ? 0.618 : (yr[1] - yr[0]) / (xr[1] - xr[0]);
    }
    if (!isFinite(aspect) || aspect <= 0) aspect = 0.618;
    aspect = Math.min(Math.max(aspect, 0.02), 50);
    const size = fit && (fit.w || fit.h) ? { w: fit.w, h: fit.h } : imageSizeOf(o, 360);
    const plotLabel = labelHtml(o.get('PlotLabel'));
    const axesLabel = o.get('AxesLabel');
    const [axLabX, axLabY] = axesLabel ? pair(axesLabel).map(labelHtml) : ['', ''];
    const frameLabel = o.get('FrameLabel');
    let fl = ['', '', '', ''];
    if (isList(frameLabel)) {
        if (frameLabel.a.length === 2 && isList(frameLabel.a[0]) && isList(frameLabel.a[1])) fl = [frameLabel.a[0].a[0], frameLabel.a[0].a[1], frameLabel.a[1].a[0], frameLabel.a[1].a[1]].map(labelHtml);
        else fl = [frameLabel.a[1], frameLabel.a[3], frameLabel.a[0], frameLabel.a[2]].map(labelHtml);
    }

    // Margins for what is drawn around the plot area
    const m = { l: 2, r: 2, t: 2, b: 2 };
    const ap = o.get('AxesOrigin');
    let origin = isNumList(ap, 2) ? ap.a.map(num) : [xr[0] <= 0 && xr[1] >= 0 ? 0 : xr[0], yr[0] <= 0 && yr[1] >= 0 ? 0 : yr[0]];
    const nearLeft = (origin[0] - xr[0]) / (xr[1] - xr[0]) < 0.08;
    const nearBottom = (origin[1] - yr[0]) / (yr[1] - yr[0]) < 0.12;
    if (axY) { m.l = Math.max(m.l, nearLeft ? 34 : 8); m.t = Math.max(m.t, axLabY ? 20 : 8); }
    if (axX) { m.b = Math.max(m.b, nearBottom ? 18 : 8); m.r = Math.max(m.r, axLabX ? 14 + Math.min(80, boxText(axesLabel && pair(axesLabel)[0]).length * 7) : 10); }
    if (anyFrame) {
        m.l = Math.max(m.l, 40 + (fl[0] ? 18 : 0));
        m.b = Math.max(m.b, 20 + (fl[2] ? 18 : 0));
        m.t = Math.max(m.t, 8 + (fl[3] ? 18 : 0));
        m.r = Math.max(m.r, 10 + (fl[1] ? 18 : 0));
    }
    if (plotLabel) m.t += 22;
    const ipad = o.get('ImagePadding');
    const ipn = num(ipad);
    if (ipn !== null) { m.l = m.r = m.t = m.b = ipn; }
    else if (isList(ipad) && ipad.a.length === 2 && isList(ipad.a[0])) {
        const v = [ipad.a[0].a[0], ipad.a[0].a[1], ipad.a[1].a[0], ipad.a[1].a[1]].map(num);
        if (v.every(x => x !== null)) [m.l, m.r, m.b, m.t] = v;
    }
    let W = size.w || 360;
    let pw = Math.max(W - m.l - m.r, 10);
    let ph = pw * aspect;
    if (size.h && !size.w) { ph = Math.max(size.h - m.t - m.b, 10); pw = ph / aspect; W = pw + m.l + m.r; }
    else if (size.h && size.w) {
        // Fit inside both
        const maxH = Math.max(size.h - m.t - m.b, 10);
        if (ph > maxH) { ph = maxH; pw = ph / aspect; }
    }
    const H = ph + m.t + m.b;
    const sx = (x) => m.l + (x - xr[0]) / (xr[1] - xr[0]) * pw;
    const sy = (y) => m.t + (yr[1] - y) / (yr[1] - yr[0]) * ph;
    const scr = (p) => {
        if (Array.isArray(p)) return [sx(p[0]), sy(p[1])];
        if (p && p.scaled) return p.image ? [p.scaled[0] * W, H - p.scaled[1] * H] : [m.l + p.scaled[0] * pw, m.t + (1 - p.scaled[1]) * ph];
        if (p && p.off) { const b = scr(p.base); return b && [b[0] + p.off[0], b[1] - p.off[1]]; }
        return null;
    };

    let svg = '';
    const overlays = [];
    const bg = toColor(o.get('Background'));
    if (bg) svg += `<rect x="0" y="0" width="${fmt(W)}" height="${fmt(H)}" fill="${css(bg)}"/>`;

    // Grid lines
    const glOpt = o.get('GridLines');
    if (glOpt && !isSym(glOpt, 'None')) {
        const gst = { ...DEFAULT_STYLE, color: [0.5, 0.5, 0.5, 0.4], thick: { abs: 0.5 } };
        applyDirective(gst, o.get('GridLinesStyle'));
        const [gx, gy] = pair(glOpt);
        const lines = (spec, lo, hi, count) => {
            if (isSym(spec, 'Automatic')) return autoTicks(lo, hi, count).major.map(t => t.v);
            if (isList(spec)) return spec.a.map(t => num(isList(t) ? t.a[0] : t)).filter(v => v !== null);
            return [];
        };
        for (const v of lines(gx, xr[0], xr[1], pw / 70)) svg += `<line x1="${fmt(sx(v))}" y1="${fmt(m.t)}" x2="${fmt(sx(v))}" y2="${fmt(m.t + ph)}"${strokeAttrs(gst, pw)}/>`;
        for (const v of lines(gy, yr[0], yr[1], ph / 45)) svg += `<line x1="${fmt(m.l)}" y1="${fmt(sy(v))}" x2="${fmt(m.l + pw)}" y2="${fmt(sy(v))}"${strokeAttrs(gst, pw)}/>`;
    }

    // Primitives
    const clip = !isSym(o.get('PlotRangeClipping'), 'False') && o.get('PlotRangeClipping') !== undefined;
    const clipId = 'nbclip' + Math.random().toString(36).slice(2, 9);
    let body = '';
    for (const it of scene.items) {
        const st = it.st;
        if (it.k === 'line') {
            const pts = it.pts.map(scr).filter(Boolean);
            if (pts.length < 2) continue;
            body += `<polyline fill="none" points="${pts.map(p => fmt(p[0]) + ',' + fmt(p[1])).join(' ')}"${strokeAttrs(st, pw)} stroke-linejoin="round"/>`;
            if (it.arrow) {
                const [p, q] = [pts[pts.length - 2], pts[pts.length - 1]];
                const len = (st.arrow.abs || st.arrow.rel * pw);
                const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
                const w = len * 0.35;
                const tip = q, bx = q[0] - len * Math.cos(ang), by = q[1] - len * Math.sin(ang);
                body += `<polygon points="${fmt(tip[0])},${fmt(tip[1])} ${fmt(bx + w * Math.sin(ang))},${fmt(by - w * Math.cos(ang))} ${fmt(bx - w * Math.sin(ang))},${fmt(by + w * Math.cos(ang))}" fill="${css(st.color, st.opacity)}"/>`;
            }
        } else if (it.k === 'polygon') {
            const pts = it.pts.map(scr).filter(Boolean);
            if (pts.length < 2) continue;
            const face = st.face === 'none' ? null : st.face || { color: st.color, opacity: st.opacity };
            const edge = st.edge ? strokeAttrs({ ...st.edge, opacity: st.edge.opacity * 1 }, pw) : ' stroke="none"';
            body += `<polygon points="${pts.map(p => fmt(p[0]) + ',' + fmt(p[1])).join(' ')}" fill="${face ? css(face.color, face.opacity) : 'none'}"${edge}/>`;
        } else if (it.k === 'points') {
            const d = st.pointSize.abs !== undefined ? st.pointSize.abs : st.pointSize.rel * pw;
            const fill = css(st.color, st.opacity);
            for (const p0 of it.pts) {
                const p = scr(p0);
                if (p) body += `<circle cx="${fmt(p[0])}" cy="${fmt(p[1])}" r="${fmt(Math.max(d / 2, 0.75))}" fill="${fill}"/>`;
            }
        } else if (it.k === 'disk' || it.k === 'circle') {
            const c = scr(it.c);
            if (!c) continue;
            const rx = it.r[0] / (xr[1] - xr[0]) * pw, ry = it.r[1] / (yr[1] - yr[0]) * ph;
            const face = it.k === 'disk' ? (st.face === 'none' ? null : st.face || { color: st.color, opacity: st.opacity }) : null;
            const paint = it.k === 'disk' ? `fill="${face ? css(face.color, face.opacity) : 'none'}"${st.edge ? strokeAttrs(st.edge, pw) : ''}` : `fill="none"${strokeAttrs(st, pw)}`;
            if (it.ang) {
                const [t0, t1] = it.ang;
                const steps = Math.max(8, Math.ceil(Math.abs(t1 - t0) / 0.05));
                const pts = [];
                for (let k = 0; k <= steps; k++) { const t = t0 + (t1 - t0) * k / steps; pts.push([c[0] + rx * Math.cos(t), c[1] - ry * Math.sin(t)]); }
                if (it.k === 'disk') pts.unshift(c), pts.push(c);
                body += `<${it.k === 'disk' ? 'polygon' : 'polyline'} points="${pts.map(p => fmt(p[0]) + ',' + fmt(p[1])).join(' ')}" ${paint}/>`;
            } else {
                body += `<ellipse cx="${fmt(c[0])}" cy="${fmt(c[1])}" rx="${fmt(Math.abs(rx))}" ry="${fmt(Math.abs(ry))}" ${paint}/>`;
            }
        } else if (it.k === 'raster') {
            const url = rasterImage(it, cx.env || {});
            if (!url) continue;
            const a = scr(it.pts[0]), c = scr(it.pts[1]);
            const x = Math.min(a[0], c[0]), y = Math.min(a[1], c[1]);
            const w = Math.abs(c[0] - a[0]), h = Math.abs(c[1] - a[1]);
            const pixelated = it.data.a.length < w / 2;
            body += `<image href="${url}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="none"${pixelated ? ' style="image-rendering:pixelated"' : ''}/>`;
        } else if (it.k === 'ginset') {
            const p = scr(it.pos);
            if (!p) continue;
            const w = it.size ? it.size[0] / (xr[1] - xr[0]) * pw : null;
            const h = it.size && it.size[1] !== null ? it.size[1] / (yr[1] - yr[0]) * ph : null;
            const html = headName(it.box) === 'GraphicsBox' ? renderGraphics(it.box, { ...it.cx, env: cx.env }, { w, h }) : renderBox(it.box, { ...it.cx, env: cx.env });
            overlays.push(`<span class="nb-gtext" style="left:${fmt(p[0])}px;top:${fmt(p[1])}px;transform:translate(${fmt(-it.align[0] * 100)}%,${fmt(-(1 - it.align[1]) * 100)}%)">${html}</span>`);
        } else if (it.k === 'inset') {
            const p = scr(it.pos);
            if (!p) continue;
            const color = st.color && (st.color[0] || st.color[1] || st.color[2]) ? `color:${css(st.color, st.opacity)};` : '';
            overlays.push(`<span class="nb-gtext" style="left:${fmt(p[0])}px;top:${fmt(p[1])}px;transform:translate(${fmt(-it.align[0] * 100)}%,${fmt(-(1 - it.align[1]) * 100)}%);${color}">${renderBox(it.box, { ...labelCx, ...{ env: cx.env } })}</span>`);
        }
    }
    if (clip) svg += `<defs><clipPath id="${clipId}"><rect x="${fmt(m.l)}" y="${fmt(m.t)}" width="${fmt(pw)}" height="${fmt(ph)}"/></clipPath></defs><g clip-path="url(#${clipId})">${body}</g>`;
    else svg += body;

    // Axes
    const axesStyle = { ...DEFAULT_STYLE, color: [0.45, 0.45, 0.45, 1], thick: { abs: 1 } };
    const [axSx, axSy] = pair(o.get('AxesStyle'));
    const axStX = { ...axesStyle }, axStY = { ...axesStyle };
    if (axSx) applyDirective(axStX, axSx);
    if (axSy) applyDirective(axStY, axSy);
    const tickText = (lab, x, y, ax, ay) => {
        if (!lab) return;
        const content = lab.html !== undefined ? lab.html : esc(lab.text);
        overlays.push(`<span class="nb-tick" style="left:${fmt(x)}px;top:${fmt(y)}px;transform:translate(${ax}%,${ay}%)">${content}</span>`);
    };
    const ticksOpt = o.get('Ticks');
    const [tX, tY] = ticksOpt === undefined ? [undefined, undefined] : pair(ticksOpt);
    if (axX) {
        const yPos = sy(Math.min(Math.max(origin[1], yr[0]), yr[1]));
        svg += `<line x1="${fmt(m.l)}" y1="${fmt(yPos)}" x2="${fmt(m.l + pw)}" y2="${fmt(yPos)}"${strokeAttrs(axStX, pw)}/>`;
        const t = tickSpec(tX, xr[0], xr[1], pw / 70, cx);
        if (t) {
            for (const v of t.minor) svg += `<line x1="${fmt(sx(v))}" y1="${fmt(yPos)}" x2="${fmt(sx(v))}" y2="${fmt(yPos - 2.5)}"${strokeAttrs({ ...axStX, thick: { abs: 0.6 } }, pw)}/>`;
            for (const tk of t.major) {
                svg += `<line x1="${fmt(sx(tk.v))}" y1="${fmt(yPos)}" x2="${fmt(sx(tk.v))}" y2="${fmt(yPos - 4.5)}"${strokeAttrs(axStX, pw)}/>`;
                if (axY && Math.abs(tk.v - origin[0]) < (xr[1] - xr[0]) * 1e-9) continue;
                tickText(tk.label, sx(tk.v), yPos + 2, -50, 0);
            }
        }
        if (axLabX) overlays.push(`<span class="nb-axlabel" style="left:${fmt(m.l + pw + 4)}px;top:${fmt(yPos)}px;transform:translate(0,-50%)">${axLabX}</span>`);
    }
    if (axY) {
        const xPos = sx(Math.min(Math.max(origin[0], xr[0]), xr[1]));
        svg += `<line x1="${fmt(xPos)}" y1="${fmt(m.t)}" x2="${fmt(xPos)}" y2="${fmt(m.t + ph)}"${strokeAttrs(axStY, pw)}/>`;
        const t = tickSpec(tY, yr[0], yr[1], ph / 45, cx);
        if (t) {
            for (const v of t.minor) svg += `<line x1="${fmt(xPos)}" y1="${fmt(sy(v))}" x2="${fmt(xPos + 2.5)}" y2="${fmt(sy(v))}"${strokeAttrs({ ...axStY, thick: { abs: 0.6 } }, pw)}/>`;
            for (const tk of t.major) {
                svg += `<line x1="${fmt(xPos)}" y1="${fmt(sy(tk.v))}" x2="${fmt(xPos + 4.5)}" y2="${fmt(sy(tk.v))}"${strokeAttrs(axStY, pw)}/>`;
                if (axX && Math.abs(tk.v - origin[1]) < (yr[1] - yr[0]) * 1e-9) continue;
                tickText(tk.label, xPos - 3, sy(tk.v), -100, -50);
            }
        }
        if (axLabY) overlays.push(`<span class="nb-axlabel" style="left:${fmt(xPos)}px;top:${fmt(m.t - 3)}px;transform:translate(-50%,-100%)">${axLabY}</span>`);
    }

    // Frame
    if (anyFrame) {
        const fst = { ...DEFAULT_STYLE, color: [0.45, 0.45, 0.45, 1], thick: { abs: 1 } };
        if (o.get('FrameStyle')) applyDirective(fst, o.get('FrameStyle'));
        const ft = o.get('FrameTicks');
        let fts = [undefined, undefined, undefined, undefined];
        if (isList(ft) && ft.a.length === 2 && isList(ft.a[0]) && isList(ft.a[1]) && ft.a[0].a.length === 2) fts = [ft.a[0].a[0], ft.a[0].a[1], ft.a[1].a[0], ft.a[1].a[1]];
        else if (isList(ft) && ft.a.length === 4) fts = [ft.a[1], ft.a[3], ft.a[0], ft.a[2]];
        else if (ft !== undefined && !isList(ft)) fts = [ft, ft, ft, ft];
        const sides = [
            { on: frame[0], x1: m.l, y1: m.t, x2: m.l, y2: m.t + ph, vertical: true, out: -1, spec: fts[0], label: true },
            { on: frame[1], x1: m.l + pw, y1: m.t, x2: m.l + pw, y2: m.t + ph, vertical: true, out: 1, spec: fts[1], label: false },
            { on: frame[2], x1: m.l, y1: m.t + ph, x2: m.l + pw, y2: m.t + ph, vertical: false, out: 1, spec: fts[2], label: true },
            { on: frame[3], x1: m.l, y1: m.t, x2: m.l + pw, y2: m.t, vertical: false, out: -1, spec: fts[3], label: false },
        ];
        for (const s of sides) {
            if (!s.on) continue;
            svg += `<line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"${strokeAttrs(fst, pw)}/>`;
            const explicitSpec = s.spec !== undefined && isList(s.spec);
            const t = tickSpec(s.spec, s.vertical ? yr[0] : xr[0], s.vertical ? yr[1] : xr[1], s.vertical ? ph / 45 : pw / 70, cx, s.label || explicitSpec);
            if (!t) continue;
            const draw = (v, len) => {
                if (s.vertical) { const y = sy(v); svg += `<line x1="${fmt(s.x1)}" y1="${fmt(y)}" x2="${fmt(s.x1 - s.out * len)}" y2="${fmt(y)}"${strokeAttrs({ ...fst, thick: { abs: len > 3 ? 1 : 0.6 } }, pw)}/>`; }
                else { const x = sx(v); svg += `<line x1="${fmt(x)}" y1="${fmt(s.y1)}" x2="${fmt(x)}" y2="${fmt(s.y1 - s.out * len)}"${strokeAttrs({ ...fst, thick: { abs: len > 3 ? 1 : 0.6 } }, pw)}/>`; }
            };
            for (const v of t.minor) draw(v, 2.5);
            for (const tk of t.major) {
                draw(tk.v, 4.5);
                if (s.vertical) tickText(tk.label, s.out < 0 ? s.x1 - 4 : s.x1 + 4, sy(tk.v), s.out < 0 ? -100 : 0, -50);
                else tickText(tk.label, sx(tk.v), s.out > 0 ? s.y1 + 3 : s.y1 - 3, -50, s.out > 0 ? 0 : -100);
            }
        }
        if (fl[2]) overlays.push(`<span class="nb-axlabel" style="left:${fmt(m.l + pw / 2)}px;top:${fmt(m.t + ph + 20)}px;transform:translate(-50%,0)">${fl[2]}</span>`);
        if (fl[0]) overlays.push(`<span class="nb-axlabel" style="left:${fmt(m.l - 38)}px;top:${fmt(m.t + ph / 2)}px;transform:translate(-100%,-50%) rotate(-90deg);transform-origin:100% 50%">${fl[0]}</span>`);
        if (fl[3]) overlays.push(`<span class="nb-axlabel" style="left:${fmt(m.l + pw / 2)}px;top:${fmt(m.t - 4)}px;transform:translate(-50%,-100%)">${fl[3]}</span>`);
        if (fl[1]) overlays.push(`<span class="nb-axlabel" style="left:${fmt(m.l + pw + 8)}px;top:${fmt(m.t + ph / 2)}px;transform:translate(0,-50%) rotate(90deg);transform-origin:0 50%">${fl[1]}</span>`);
    }
    if (plotLabel) overlays.push(`<span class="nb-plotlabel" style="left:${fmt(m.l + pw / 2)}px;top:2px;transform:translate(-50%,0)">${plotLabel}</span>`);

    return `<span class="nb-gfx" style="width:${fmt(W)}px;height:${fmt(H)}px"><svg width="${fmt(W)}" height="${fmt(H)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">${svg}</svg>${overlays.join('')}</span>`;
}

// --- 3D graphics ---
function point3(e, g) {
    if (typeof e === 'number' && g.verts) return g.verts[e - 1] && g.tf(g.verts[e - 1]);
    if (isList(e) && e.a.length === 3) {
        const p = e.a.map(num);
        if (p.every(x => x !== null)) return g.tf(p);
    }
    return null;
}
function pointLists3(e, g) {
    if (!isList(e) || !e.a.length) return [];
    const first = e.a[0];
    if (g.verts) {
        if (typeof first === 'number') return [e.a.map(i => point3(i, g)).filter(Boolean)];
        if (isList(first) && typeof first.a[0] === 'number' && !(first.a.length === 3 && !Number.isInteger(first.a[0]))) {
            return e.a.map(l => (isList(l) ? (isList(l.a[0]) ? l.a.flatMap(x => (isList(x) ? x.a : [])) : l.a).map(i => point3(i, g)).filter(Boolean) : []));
        }
    }
    if (isNumList(first, 3)) return [e.a.map(p => point3(p, g)).filter(Boolean)];
    if (isList(first)) return e.a.flatMap(l => pointLists3(l, g));
    return [];
}

function walk3D(e, st, g, sc, cx) {
    if (!e || typeof e !== 'object') return;
    if (isList(e)) {
        const local = { ...st };
        for (const x of e.a) {
            if (!isList(x) && applyDirective(local, x)) continue;
            walk3D(x, local, g, sc, cx);
        }
        return;
    }
    const h = headName(e);
    const a = e.a || [];
    switch (h) {
        case 'Polygon3DBox': case 'PolygonBox': case 'Polygon': {
            let src = a[0];
            if (headName(src) === 'Rule') src = src.a[0];
            const op = opts(a.filter(isRule));
            const vc = op.get('VertexColors') || g.vertexColors;
            const idx = g.verts && isList(src) ? (typeof src.a[0] === 'number' ? [src.a] : src.a.map(l => (isList(l) ? l.a : []))) : null;
            pointLists3(src, g).forEach((pts, k) => {
                let face = null;
                if (vc && isList(vc) && idx && g.vertexColors === vc && idx[k]) {
                    const cols = idx[k].map(i => toColor(vc.a[i - 1])).filter(Boolean);
                    if (cols.length) face = [0, 1, 2, 3].map(d => cols.reduce((s, c) => s + c[d], 0) / cols.length);
                }
                if (pts.length >= 3) sc.polys.push({ pts, st, face });
            });
            return;
        }
        case 'Line3DBox': case 'LineBox': case 'Line': case 'Arrow3DBox': case 'ArrowBox': {
            let src = a[0];
            if (headName(src) === 'Tube3DBox' || headName(src) === 'TubeBox') src = src.a[0];
            for (const pts of pointLists3(src, g)) sc.lines.push({ pts, st, arrow: h.startsWith('Arrow') });
            return;
        }
        case 'Tube3DBox': case 'TubeBox': {
            for (const pts of pointLists3(a[0], g)) sc.lines.push({ pts, st: { ...st, thick: { abs: 3 } } });
            return;
        }
        case 'Point3DBox': case 'PointBox': case 'Point': {
            const src = a[0];
            const pts = typeof src === 'number' ? [point3(src, g)] : isNumList(src, 3) ? [point3(src, g)] : (pointLists3(src, g)[0] || []);
            for (const p of pts) if (p) sc.points.push({ p, st });
            return;
        }
        case 'SphereBox': case 'Sphere': {
            const r = num(a[1]) !== null ? num(a[1]) : 1;
            const centers = isNumList(a[0], 3) ? [point3(a[0], g)] : (pointLists3(a[0], g)[0] || []);
            for (const c of centers) if (c) sc.spheres.push({ c, r, st });
            return;
        }
        case 'CuboidBox': case 'Cuboid': {
            const p = point3(a[0], g) || [0, 0, 0];
            const q = a[1] ? point3(a[1], g) : [p[0] + 1, p[1] + 1, p[2] + 1];
            if (!q) return;
            const v = (i, j, k) => [i ? q[0] : p[0], j ? q[1] : p[1], k ? q[2] : p[2]];
            const faces = [[v(0,0,0), v(1,0,0), v(1,1,0), v(0,1,0)], [v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1)], [v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1)], [v(0,1,0), v(1,1,0), v(1,1,1), v(0,1,1)], [v(0,0,0), v(0,1,0), v(0,1,1), v(0,0,1)], [v(1,0,0), v(1,1,0), v(1,1,1), v(1,0,1)]];
            for (const pts of faces) sc.polys.push({ pts, st });
            return;
        }
        case 'CylinderBox': case 'ConeBox': case 'Cylinder': case 'Cone': {
            const ends = isList(a[0]) ? a[0].a.map(p => point3(p, g)) : [];
            if (ends.length !== 2 || !ends[0] || !ends[1]) return;
            const r = num(a[1]) !== null ? num(a[1]) : 1;
            const [p, q] = ends;
            const ax = q.map((v, i) => v - p[i]);
            const len = Math.hypot(...ax) || 1;
            const n = ax.map(v => v / len);
            const t = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
            let u = cross(n, t); const ul = Math.hypot(...u); u = u.map(v => v / ul);
            const w = cross(n, u);
            const N = 24;
            const ring = (c, rr) => Array.from({ length: N }, (_, k) => { const th = 2 * Math.PI * k / N; return c.map((v, i) => v + rr * (Math.cos(th) * u[i] + Math.sin(th) * w[i])); });
            const bottom = ring(p, r), top = h.startsWith('Cone') ? ring(q, 0) : ring(q, r);
            for (let k = 0; k < N; k++) sc.polys.push({ pts: [bottom[k], bottom[(k + 1) % N], top[(k + 1) % N], top[k]], st: { ...st, edge: null } });
            sc.polys.push({ pts: bottom, st: { ...st, edge: null } });
            if (!h.startsWith('Cone')) sc.polys.push({ pts: top, st: { ...st, edge: null } });
            return;
        }
        case 'Text3DBox': case 'InsetBox': case 'Inset': case 'Text': {
            const pos = a[1] !== undefined ? point3(a[1], g) : null;
            if (pos) sc.texts.push({ p: pos, box: a[0], st });
            return;
        }
        case 'GraphicsComplex3DBox': case 'GraphicsComplexBox': case 'GraphicsComplex': {
            const verts = isList(a[0]) ? a[0].a.map(p => (isList(p) ? p.a.map(num) : [0, 0, 0])) : [];
            const op = opts(a.slice(2));
            walk3D(a[1], st, { ...g, verts, vertexColors: op.get('VertexColors') || null }, sc, cx);
            return;
        }
        case 'StyleBox': case 'Style': {
            const local = { ...st };
            for (const d of a.slice(1)) applyDirective(local, d);
            walk3D(a[0], local, g, sc, cx);
            return;
        }
        case 'GeometricTransformation3DBox': case 'GeometricTransformationBox': {
            const spec = a[1];
            const mat3 = (m) => isList(m) && m.a.length === 3 && m.a.every(r => isNumList(r, 3)) ? m.a.map(r => r.a.map(num)) : null;
            let M = null, v = [0, 0, 0];
            if (mat3(spec)) M = mat3(spec);
            else if (isNumList(spec, 3)) v = spec.a.map(num);
            else if (isList(spec) && spec.a.length === 2 && mat3(spec.a[0]) && isNumList(spec.a[1], 3)) { M = mat3(spec.a[0]); v = spec.a[1].a.map(num); }
            const tf0 = g.tf;
            const tf = (p) => tf0(M ? [0, 1, 2].map(i => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + v[i]) : p.map((x, i) => x + v[i]));
            walk3D(a[0], st, { ...g, tf }, sc, cx);
            return;
        }
        case 'GraphicsGroup3DBox': case 'GraphicsGroupBox': case 'TagBox': case 'TooltipBox': case 'Tooltip': case 'Annotation':
        case 'AnnotationBox': case 'InterpretationBox': case 'Hyperlink': case 'StatusArea':
            walk3D(a[0], st, g, sc, cx);
            return;
        case 'DynamicModuleBox':
            walk3D(a[1], st, g, sc, cx);
            return;
    }
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function render3D(b, cx) {
    const o = opts(b.a.slice(1));
    const sc = { polys: [], lines: [], points: [], spheres: [], texts: [] };
    walk3D(b.a[0], { ...DEFAULT_STYLE, color: [1, 1, 1, 1], edge: { ...DEFAULT_STYLE, color: [0, 0, 0, 0.35], thick: { abs: 0.5 } } }, { tf: p => p, verts: null }, sc, cx);
    // Bounds and the box
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const grow = (p) => { for (let i = 0; i < 3; i++) { if (isFinite(p[i])) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i]; } } };
    sc.polys.forEach(q => q.pts.forEach(grow));
    sc.lines.forEach(q => q.pts.forEach(grow));
    sc.points.forEach(q => grow(q.p));
    sc.spheres.forEach(s => { grow(s.c.map(v => v - s.r)); grow(s.c.map(v => v + s.r)); });
    for (let i = 0; i < 3; i++) if (!(hi[i] >= lo[i])) { lo[i] = -1; hi[i] = 1; }
    const pr = o.get('PlotRange');
    if (isList(pr) && pr.a.length === 3) pr.a.forEach((r, i) => { if (isNumList(r, 2)) { lo[i] = num(r.a[0]); hi[i] = num(r.a[1]); } });
    else if (isNumList(pr, 2)) { lo[2] = num(pr.a[0]); hi[2] = num(pr.a[1]); }
    for (let i = 0; i < 3; i++) if (hi[i] <= lo[i]) { hi[i] = lo[i] + 1; lo[i] -= 0; }
    let ratios = hi.map((v, i) => v - lo[i]);
    const br = o.get('BoxRatios');
    if (isNumList(br, 3)) ratios = br.a.map(num);
    const rmax = Math.max(...ratios);
    ratios = ratios.map(r => r / rmax);
    const vp = o.get('ViewPoint');
    let viewPoint = isNumList(vp, 3) ? vp.a.map(num) : [1.3, -2.4, 2];
    if (isSym(vp, 'Front')) viewPoint = [0, -2, 0];
    else if (isSym(vp, 'Above')) viewPoint = [0, 0, 2];
    const vv = o.get('ViewVertical');
    const axesOpt = o.get('Axes');
    const axes = isSym(axesOpt, 'True') ? [true, true, true] : isList(axesOpt) ? axesOpt.a.map(v => isSym(v, 'True')) : [false, false, false];
    const lighting = o.get('Lighting');
    const size = imageSizeOf(o, 360);
    return registerScene({
        sc, lo, hi, ratios, viewPoint, viewVertical: isNumList(vv, 3) ? vv.a.map(num) : [0, 0, 1],
        boxed: !isSym(o.get('Boxed'), 'False'), axes, axesLabel: o.get('AxesLabel'), width: size.w || 360,
        flat: isSym(lighting, 'None') || lighting === 'Neutral', cx: { ...cx, showStr: false, trad: true, text: false },
        background: toColor(o.get('Background')), plotLabel: o.get('PlotLabel'),
    }, cx);
}

function registerScene(scene, cx) {
    const env = cx.env || {};
    if (!env.scenes) env.scenes = [];
    const id = env.scenes.length;
    env.scenes.push(scene);
    const { html, w, h } = drawScene(scene, null);
    return `<span class="nb-g3d" data-scene="${id}" style="width:${fmt(w)}px;height:${fmt(h)}px" title="Drag to turn">${html}</span>`;
}

// Draws a 3D scene from its view point (or view: { viewPoint }) as SVG
function drawScene(scene, view) {
    const { sc, lo, hi, ratios } = scene;
    const vpt = (view && view.viewPoint) || scene.viewPoint;
    const center = [0.5, 0.5, 0.5].map((c, i) => (lo[i] + hi[i]) / 2);
    // Box coordinates: centred, scaled to the box ratios (largest side 1)
    const toBox = (p) => [0, 1, 2].map(i => (p[i] - center[i]) / (hi[i] - lo[i]) * ratios[i]);
    const e = norm(vpt);
    const dist = Math.hypot(...vpt);
    let up = scene.viewVertical;
    up = up.map((v, i) => v - dot(up, e) * e[i]);
    if (Math.hypot(...up) < 1e-6) up = Math.abs(e[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    up = norm(up);
    const right = cross(up, e);
    const proj = (p) => {
        const q = toBox(p);
        const depth = dot(q, e);
        const f = dist / Math.max(dist - depth, 0.1);
        return [dot(q, right) * f, dot(q, up) * f, depth];
    };
    // Fit the box corners
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
    const pc = corners.map(proj);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pc) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    const W = scene.width;
    const pad = 28;
    // The scale and height of the first view are kept while turning
    if (!scene.fit) {
        const span = Math.max(maxX - minX, (maxY - minY) * 0.8, 1e-9);
        const k0 = (W - 2 * pad) / span;
        scene.fit = { k: k0, H: Math.min(Math.max((maxY - minY) * k0 + 2 * pad, 120), W * 1.4) };
    }
    const { k, H } = scene.fit;
    const cxp = (minX + maxX) / 2, cyp = (minY + maxY) / 2;
    const scr = (p) => [W / 2 + (p[0] - cxp) * k, H / 2 - (p[1] - cyp) * k, p[2]];
    const light = norm([e[0] + up[0] * 0.6 + right[0] * 0.4, e[1] + up[1] * 0.6 + right[1] * 0.4, e[2] + up[2] * 0.6 + right[2] * 0.4]);
    const items = [];
    for (const poly of sc.polys) {
        const s = poly.pts.map(p => scr(proj(p)));
        const depth = s.reduce((t, p) => t + p[2], 0) / s.length;
        const q = poly.pts.map(toBox);
        let n = [0, 0, 0];
        for (let i = 0; i < q.length; i++) { const a = q[i], c = q[(i + 1) % q.length]; n[0] += (a[1] - c[1]) * (a[2] + c[2]); n[1] += (a[2] - c[2]) * (a[0] + c[0]); n[2] += (a[0] - c[0]) * (a[1] + c[1]); }
        n = norm(n);
        const st = poly.st;
        const base = poly.face || (st.face && st.face !== 'none' ? st.face.color : st.color);
        const op = st.face && st.face !== 'none' && st.face.opacity !== undefined ? st.face.opacity : st.opacity;
        const lum = scene.flat ? 1 : 0.38 + 0.62 * Math.abs(dot(n, light));
        // Mathematica's default lights tint white surfaces warm and cool
        const tint = !poly.face && base[0] === 1 && base[1] === 1 && base[2] === 1 && !scene.flat ? [1, 0.93, 0.82] : [1, 1, 1];
        const col = [base[0] * lum * tint[0], base[1] * lum * tint[1], base[2] * lum * tint[2], base[3]];
        const fill = st.face === 'none' ? 'none' : css(col, op);
        const edge = st.edge ? `${strokeAttrs(st.edge, W)}` : ` stroke="${fill}" stroke-width="0.4"`;
        items.push({ d: depth, svg: `<polygon points="${s.map(p => fmt(p[0]) + ',' + fmt(p[1])).join(' ')}" fill="${fill}"${edge} stroke-linejoin="round"/>` });
    }
    for (const line of sc.lines) {
        const s = line.pts.map(p => scr(proj(p)));
        for (let i = 0; i + 1 < s.length; i++) {
            items.push({ d: (s[i][2] + s[i + 1][2]) / 2 + 0.002, svg: `<line x1="${fmt(s[i][0])}" y1="${fmt(s[i][1])}" x2="${fmt(s[i + 1][0])}" y2="${fmt(s[i + 1][1])}"${strokeAttrs(line.st, W)} stroke-linecap="round"/>` });
        }
    }
    for (const pt of sc.points) {
        const s = scr(proj(pt.p));
        const d = pt.st.pointSize.abs !== undefined ? pt.st.pointSize.abs : pt.st.pointSize.rel * W;
        items.push({ d: s[2] + 0.003, svg: `<circle cx="${fmt(s[0])}" cy="${fmt(s[1])}" r="${fmt(Math.max(d / 2, 1))}" fill="${css(pt.st.color, pt.st.opacity)}"/>` });
    }
    const gradients = [];
    for (const sp of sc.spheres) {
        const s = scr(proj(sp.c));
        const edgeP = scr(proj(sp.c.map((v, i) => v + sp.r * right[i] * (hi[i] - lo[i]) / ratios[i] / ((hi[0] - lo[0]) / ratios[0]))));
        const r = Math.max(Math.hypot(edgeP[0] - s[0], edgeP[1] - s[1]), 1);
        const id = 'nbsph' + gradients.length + Math.random().toString(36).slice(2, 6);
        const c = sp.st.color;
        gradients.push(`<radialGradient id="${id}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="${css([Math.min(1, c[0] * 0.5 + 0.5), Math.min(1, c[1] * 0.5 + 0.5), Math.min(1, c[2] * 0.5 + 0.5), 1])}"/><stop offset="1" stop-color="${css([c[0] * 0.45, c[1] * 0.45, c[2] * 0.45, 1])}"/></radialGradient>`);
        items.push({ d: s[2], svg: `<circle cx="${fmt(s[0])}" cy="${fmt(s[1])}" r="${fmt(r)}" fill="url(#${id})"${sp.st.opacity < 1 ? ` fill-opacity="${sp.st.opacity}"` : ''}/>` });
    }
    // Box edges
    const boxEdges = [];
    if (scene.boxed) {
        for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) boxEdges.push([i, i | bit]);
        for (const [i, j] of boxEdges) {
            const a = scr(pc[i]), c = scr(pc[j]);
            items.push({ d: (a[2] + c[2]) / 2 - 0.001, svg: `<line x1="${fmt(a[0])}" y1="${fmt(a[1])}" x2="${fmt(c[0])}" y2="${fmt(c[1])}" stroke="rgba(0,0,0,0.45)" stroke-width="0.8"/>` });
        }
    }
    items.sort((p, q) => p.d - q.d);
    let svg = (scene.background ? `<rect width="${fmt(W)}" height="${fmt(H)}" fill="${css(scene.background)}"/>` : '') + (gradients.length ? `<defs>${gradients.join('')}</defs>` : '') + items.map(i => i.svg).join('');
    const overlays = [];
    // Axes along box edges: for each axis, the edge nearest the viewer among the lower ones
    const labels = isList(scene.axesLabel) ? scene.axesLabel.a : [];
    [0, 1, 2].forEach(axis => {
        if (!scene.axes[axis]) return;
        const bit = 1 << axis;
        let best = null;
        for (let i = 0; i < 8; i++) {
            if (i & bit) continue;
            const a = scr(pc[i]), c = scr(pc[i | bit]);
            const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
            // x and y axes along the bottom, toward the viewer; z on the left
            const score = axis === 2 ? -mid[0] + mid[2] * 0.01 : mid[1] + mid[2] * 40;
            if (!best || score > best.score) best = { score, i, a, c };
        }
        if (!best) return;
        const center2 = [W / 2, H / 2];
        const { a, c } = best;
        const mid = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
        let out = [mid[0] - center2[0], mid[1] - center2[1]];
        const ol = Math.hypot(...out) || 1;
        out = [out[0] / ol, out[1] / ol];
        const t = autoTicks(lo[axis], hi[axis], Math.max(2, Math.hypot(c[0] - a[0], c[1] - a[1]) / 60));
        for (const tk of t.major) {
            const f = (tk.v - lo[axis]) / (hi[axis] - lo[axis]);
            const x = a[0] + (c[0] - a[0]) * f, y = a[1] + (c[1] - a[1]) * f;
            svg += `<line x1="${fmt(x)}" y1="${fmt(y)}" x2="${fmt(x + out[0] * 5)}" y2="${fmt(y + out[1] * 5)}" stroke="#666" stroke-width="0.8"/>`;
            const tx = x + out[0] * 9, ty = y + out[1] * 9;
            overlays.push(`<span class="nb-tick" style="left:${fmt(tx)}px;top:${fmt(ty)}px;transform:translate(${fmt(out[0] < -0.3 ? -100 : out[0] > 0.3 ? 0 : -50)}%,${fmt(out[1] < -0.3 ? -100 : out[1] > 0.3 ? 0 : -50)}%)">${tk.label.html !== undefined ? tk.label.html : esc(tk.label.text)}</span>`);
        }
        const lab = labels[axis];
        if (lab !== undefined && !isSym(lab, 'None')) {
            overlays.push(`<span class="nb-axlabel" style="left:${fmt(mid[0] + out[0] * 26)}px;top:${fmt(mid[1] + out[1] * 26)}px;transform:translate(-50%,-50%)">${renderBox(lab, scene.cx)}</span>`);
        }
    });
    for (const t of sc.texts) {
        const s = scr(proj(t.p));
        overlays.push(`<span class="nb-gtext" style="left:${fmt(s[0])}px;top:${fmt(s[1])}px;transform:translate(-50%,-50%)">${renderBox(t.box, scene.cx)}</span>`);
    }
    if (scene.plotLabel !== undefined && !isSym(scene.plotLabel, 'None')) {
        overlays.push(`<span class="nb-plotlabel" style="left:${fmt(W / 2)}px;top:2px;transform:translate(-50%,0)">${renderBox(scene.plotLabel, scene.cx)}</span>`);
    }
    return { html: `<svg width="${fmt(W)}" height="${fmt(H)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">${svg}</svg>${overlays.join('')}`, w: W, h: H };
}

// --- Cells ---
function cellStyleCss(o) {
    let s = '';
    const bg = toColor(o.get('Background'));
    if (bg) s += `background:${css(bg)};`;
    const fc = toColor(o.get('FontColor'));
    if (fc) s += `color:${css(fc)};`;
    const fs = num(o.get('FontSize'));
    if (fs) s += `font-size:${fs}px;`;
    const fw = o.get('FontWeight');
    if (fw) s += `font-weight:${/bold/i.test(fw.s || fw) ? 'bold' : 'normal'};`;
    const fsl = o.get('FontSlant');
    if (fsl) s += `font-style:${/italic/i.test(fsl.s || fsl) ? 'italic' : 'normal'};`;
    const ff = o.get('FontFamily');
    if (typeof ff === 'string') s += `font-family:"${ff.replace(/"/g, '')}",sans-serif;`;
    const ta = o.get('TextAlignment');
    if (ta && ta.s) s += `text-align:${ta.s.toLowerCase() === 'center' ? 'center' : ta.s.toLowerCase() === 'right' ? 'right' : 'left'};`;
    const frame = o.get('CellFrame');
    if (frame && !isSym(frame, 'False') && !isSym(frame, 'None') && !(num(frame) === 0)) s += 'border:1px solid #aaa;padding:4px 8px;';
    return s;
}

const MONO_STYLES = /^(Input|Code|Output|Print|Message|Echo|Program|ExternalLanguage|InputOnly|DisplayFormula|DisplayFormulaNumbered|Graphics|Picture|Usage|InlineInput)$/;

function renderCell(c, env, depth) {
    const h = headName(c);
    if (h !== 'Cell') return '';
    const content = c.a[0];
    if (headName(content) === 'CellGroupData') {
        const cells = isList(content.a[0]) ? content.a[0].a : [];
        const state = content.a[1];
        const closed = isSym(state, 'Closed');
        let inner = '';
        cells.forEach((x, k) => {
            const hidden = closed && k > 0 ? ' data-hidden="1"' : '';
            const html = renderCell(x, env, depth + 1);
            inner += hidden ? html.replace(/^<(div|section) /, `<$1${hidden} `) : html;
        });
        return `<div class="nb-group${closed ? ' closed' : ''}">${inner}<div class="nb-br nb-gbr" title="Click to open or close the group"></div></div>`;
    }
    if (headName(content) === 'StyleData') return '';
    const rest = c.a.slice(1);
    const styles = rest.filter(x => typeof x === 'string');
    const o = opts(rest);
    const style = styles[0] || '';
    const label = o.get('CellLabel');
    const showStrDefault = /^(Input|Code|InputOnly)$/.test(style);
    const cx = { env, showStr: o.has('ShowStringCharacters') ? isSym(o.get('ShowStringCharacters'), 'True') : showStrDefault, trad: false, text: false };
    let html;
    try {
        if (isSym(o.get('CellOpen'), 'False')) html = '';
        else if (typeof content === 'string') html = renderString(content, { ...cx, text: true });
        else switch (headName(content)) {
            case 'TextData': html = renderTextData(content.a[0], cx); break;
            case 'BoxData': html = renderBox(content.a[0], cx); break;
            case 'OutputFormData': html = esc(typeof content.a[1] === 'string' ? content.a[1] : content.a[0]); break;
            case 'RawData': html = esc(content.a[0]); break;
            case 'GraphicsData': html = '<span class="nb-missing">Graphics stored as PostScript (from an old Mathematica version) are not shown</span>'; break;
            default: html = renderBox(content, cx);
        }
    } catch (err) {
        html = `<span class="nb-error-msg">Could not show this cell: ${esc(err.message)}</span>`;
    }
    const cls = 'nb-cell nb-s-' + style.replace(/[^A-Za-z0-9_-]/g, '') + (MONO_STYLES.test(style) ? ' nb-mono-cell' : '');
    const lab = typeof label === 'string' ? `<span class="nb-label">${esc(label)}</span>` : '';
    const st = cellStyleCss(o);
    return `<div class="${cls}"${st ? ` style="${st}"` : ''}>${lab}<div class="nb-content">${html}</div><div class="nb-br"></div></div>`;
}

function renderNotebook(nb, env = {}) {
    env.scenes = env.scenes || [];
    let cells = [];
    let o = new Map();
    if (headName(nb) === 'Notebook') {
        cells = isList(nb.a[0]) ? nb.a[0].a : [];
        o = opts(nb.a.slice(1));
    } else if (headName(nb) === 'Cell') {
        cells = [nb];
    } else if (isList(nb)) {
        cells = nb.a;
    } else {
        throw new Error('This is not a Mathematica notebook (no Notebook[...] in it)');
    }
    const html = cells.map(c => renderCell(c, env, 0)).join('');
    const bg = toColor(o.get('Background'));
    return { html: `<div class="nb-notebook"${bg ? ` style="background:${css(bg)}"` : ''}>${html}</div>`, scenes: env.scenes };
}

const NB_CSS = `
.nb-notebook{font:14px/1.45 "Source Sans Pro","Segoe UI",Helvetica,Arial,sans-serif;color:#1a1a1a;background:#fff;padding:18px 18px 40px 84px;max-width:1000px;margin:0 auto;box-sizing:border-box;min-height:100%}
.nb-cell{position:relative;padding:2px 12px 2px 0;margin:3px 0;white-space:pre-wrap;word-wrap:break-word}
.nb-group{position:relative;padding-right:7px}
.nb-group[data-hidden],.nb-cell[data-hidden]{display:none}
.nb-br{position:absolute;right:0;top:2px;bottom:2px;width:3px;border:1px solid #a9bbd6;border-left:0;cursor:pointer}
.nb-cell>.nb-br{right:2px}
.nb-br:hover{border-color:#3b6fc2;background:rgba(59,111,194,.08)}
.nb-group.closed>.nb-gbr{border-bottom-width:4px;border-bottom-color:#a9bbd6}
.nb-label{position:absolute;left:-80px;width:74px;text-align:right;top:4px;font:10px/1.2 "Source Sans Pro",Helvetica,Arial,sans-serif;color:#567cb8;white-space:normal;overflow-wrap:anywhere}
.nb-content{min-height:1em}
.nb-s-Title{font-size:36px;line-height:1.15;color:#a3291e;margin:26px 0 6px;font-weight:600}
.nb-s-Subtitle{font-size:22px;color:#c4572f;margin:2px 0 6px}
.nb-s-Subsubtitle{font-size:16px;color:#c4572f;margin:2px 0 6px}
.nb-s-Chapter{font-size:28px;color:#333;margin:24px 0 6px;font-weight:600}
.nb-s-Section{font-size:24px;color:#bf5221;margin:26px 0 6px;padding-top:6px;border-top:1px solid #ddd;font-weight:600}
.nb-s-Subsection{font-size:18px;color:#c4672b;margin:16px 0 4px;font-weight:600}
.nb-s-Subsubsection{font-size:15px;color:#b07040;margin:12px 0 3px;font-weight:600}
.nb-s-Author,.nb-s-Affiliation{color:#555;font-style:italic}
.nb-s-Abstract{font-size:13px;margin:8px 4em}
.nb-s-Text,.nb-s-Notes,.nb-s-Abstract{margin-top:6px;margin-bottom:6px}
.nb-s-Item,.nb-s-ItemParagraph,.nb-s-Subitem,.nb-s-SubitemParagraph,.nb-s-ItemNumbered,.nb-s-SubitemNumbered{margin:2px 0 2px 26px}
.nb-s-Subitem,.nb-s-SubitemParagraph,.nb-s-SubitemNumbered{margin-left:50px}
.nb-s-Item>.nb-content::before,.nb-s-Subitem>.nb-content::before{content:"•";position:absolute;margin-left:-14px;color:#a33}
.nb-s-ItemNumbered{counter-increment:nbitem}
.nb-cell:not(.nb-s-ItemNumbered):not(.nb-s-SubitemNumbered){counter-reset:nbitem}
.nb-s-ItemNumbered>.nb-content::before{content:counter(nbitem) ".";position:absolute;margin-left:-20px;color:#a33}
.nb-mono-cell,.nb-mono{font-family:"Source Code Pro",Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:13px}
.nb-s-Input,.nb-s-Code,.nb-s-InputOnly{font-weight:600;margin-top:10px}
.nb-s-Code{background:#f6f7f9}
.nb-s-Output,.nb-s-Print,.nb-s-Echo{margin-top:6px;margin-bottom:8px}
.nb-s-Message,.nb-s-MSG{color:#c0392b;font-size:12px}
.nb-msgname{font-weight:600}
.nb-s-Program,.nb-s-ExternalLanguage{background:#f6f7f9;padding:6px 12px 6px 6px;font-size:12.5px}
.nb-s-DisplayFormula,.nb-s-DisplayFormulaNumbered{text-align:center;margin:8px 0;font-family:inherit}
.nb-s-Usage{background:#fff9e6;padding:6px 12px 6px 6px}
.nb-s-PageBreak{border-top:1px dashed #ccc}
.nb-row{white-space:pre-wrap}
.nb-op{margin:0 .2em}
.nb-op.tight{margin:0}
.nb-comma{margin-right:.25em}
.nb-str{color:#555}
.nb-comment,.nb-comment .nb-str{color:#999;font-weight:normal}
.nb-sup{font-size:72%;vertical-align:.6em;line-height:0}
.nb-sub{font-size:72%;vertical-align:-.3em;line-height:0}
.nb-subsup{display:inline-flex;flex-direction:column;vertical-align:.45em;font-size:72%;line-height:1.05}
.nb-frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;margin:0 .1em;line-height:1.15}
.nb-frac>span:first-child{border-bottom:1px solid currentColor;padding:0 .15em}
.nb-frac>span:last-child{padding:0 .15em}
.nb-frac.nb-binom>span:first-child{border:0}
.nb-paren{font-size:150%;vertical-align:middle}
.nb-sqrt{display:inline-flex;align-items:stretch;vertical-align:middle}
.nb-radical{font-size:120%;line-height:1;padding-right:1px}
.nb-radicand{border-top:1px solid currentColor;padding:1px .15em 0}
.nb-index{font-size:60%;margin-right:-.5em}
.nb-stack{display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle;line-height:1.1}
.nb-small{font-size:72%}
.nb-grid{display:inline-block;vertical-align:middle}
.nb-grid table{border-collapse:collapse;display:inline-table}
.nb-grid td{padding:1px 6px;vertical-align:baseline;white-space:pre-wrap}
.nb-grid.lined td{border:1px solid #bbb}
.nb-frame{border:1px solid #999;padding:1px 4px;display:inline-block}
.nb-panel{border:1px solid #ccc;background:#f3f3f3;padding:4px 8px;display:inline-block;border-radius:3px}
.nb-summary{border:1px solid #ccc;background:#f7f7f7;padding:2px 6px;display:inline-block;border-radius:3px;font-size:12px}
.nb-labeled{display:inline-flex;flex-direction:column;align-items:center;vertical-align:middle}
.nb-error{border-bottom:2px wavy #d33}
.nb-overlay{display:inline-grid}
.nb-overlay>span{grid-area:1/1}
.nb-rotate{display:inline-block}
.nb-link{color:#2a5db0;text-decoration:none}
a.nb-link:hover{text-decoration:underline}
.nb-button{display:inline-block;border:1px solid #bbb;border-radius:3px;background:linear-gradient(#fff,#e9e9e9);padding:0 6px;font-size:12px;font-family:"Source Sans Pro",Helvetica,Arial,sans-serif;font-weight:normal}
.nb-input-field{display:inline-block;border:1px solid #bbb;min-width:6em;padding:0 4px;background:#fff}
.nb-slider{display:inline-block;width:120px;height:4px;background:#ccc;border-radius:2px;vertical-align:middle;position:relative}
.nb-slider::after{content:"";position:absolute;left:40%;top:-4px;width:8px;height:12px;background:#888;border-radius:2px}
.nb-dynamic{color:#999}
.nb-placeholder{color:#999}
.nb-inline{white-space:normal}
.nb-inline-input{font-family:"Source Code Pro",Menlo,Consolas,monospace;font-weight:600;font-size:92%}
.nb-gfx,.nb-g3d{display:inline-block;position:relative;vertical-align:middle;white-space:normal;font-weight:normal;line-height:1.2}
.nb-gfx>svg,.nb-g3d>svg{display:block;overflow:visible}
.nb-g3d{cursor:grab;overflow:hidden}
.nb-g3d.dragging{cursor:grabbing}
.nb-gtext,.nb-tick,.nb-axlabel,.nb-plotlabel{position:absolute;white-space:nowrap;pointer-events:none;font-family:"Source Sans Pro","Segoe UI",Helvetica,Arial,sans-serif}
.nb-gtext{font-size:12px}
.nb-tick{font-size:10.5px;color:#555}
.nb-axlabel{font-size:12px;color:#333}
.nb-plotlabel{font-size:13px;color:#222}
.nb-missing,.nb-error-msg{display:inline-block;color:#a33;background:#fdf0ef;border:1px solid #f1c6c2;padding:2px 8px;border-radius:3px;font:12px "Source Sans Pro",Helvetica,Arial,sans-serif}
`;

module.exports = { renderNotebook, renderBox, drawScene, NB_CSS };
