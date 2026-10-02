// --- Wolfram Language reader ---
// Reads the text of a Mathematica notebook (.nb): one Wolfram Language
// expression, Notebook[{Cell[...], ...}, options], mostly in FullForm but with
// operators in option values (->, :>, #, &, ^, ...). Expressions come out as:
//   string                      a String (escapes decoded, see below)
//   number                      an Integer or Real
//   { s: 'Name' }               a Symbol
//   { h: head, a: [args] }      a normal expression; lists have head List
// In strings, \[Name] becomes its character; the box escapes of linear syntax
// (\!, \(, \), \*, \^, \_, \/, \@, \%, \&, \+, \`) are kept as LS followed by
// the character, so a renderer can tell them from text.
//
// CompressedData["1:..."] is base64 of zlib data holding an expression in
// Mathematica's binary dump format ("!boR"); decodeCompressedData reads it
// (packed arrays of reals, integers and bytes, and the general forms).

const LS = '';

// --- Named characters ---
const GREEK = {
    Alpha: 'α', Beta: 'β', Gamma: 'γ', Delta: 'δ', Epsilon: 'ϵ', CurlyEpsilon: 'ε', Zeta: 'ζ', Eta: 'η',
    Theta: 'θ', CurlyTheta: 'ϑ', Iota: 'ι', Kappa: 'κ', CurlyKappa: 'ϰ', Lambda: 'λ', Mu: 'μ', Nu: 'ν',
    Xi: 'ξ', Omicron: 'ο', Pi: 'π', CurlyPi: 'ϖ', Rho: 'ρ', CurlyRho: 'ϱ', Sigma: 'σ', FinalSigma: 'ς',
    Tau: 'τ', Upsilon: 'υ', Phi: 'ϕ', CurlyPhi: 'φ', Chi: 'χ', Psi: 'ψ', Omega: 'ω', Digamma: 'ϝ',
    Koppa: 'ϟ', Stigma: 'ϛ', Sampi: 'ϡ',
    CapitalAlpha: 'Α', CapitalBeta: 'Β', CapitalGamma: 'Γ', CapitalDelta: 'Δ', CapitalEpsilon: 'Ε',
    CapitalZeta: 'Ζ', CapitalEta: 'Η', CapitalTheta: 'Θ', CapitalIota: 'Ι', CapitalKappa: 'Κ',
    CapitalLambda: 'Λ', CapitalMu: 'Μ', CapitalNu: 'Ν', CapitalXi: 'Ξ', CapitalOmicron: 'Ο',
    CapitalPi: 'Π', CapitalRho: 'Ρ', CapitalSigma: 'Σ', CapitalTau: 'Τ', CapitalUpsilon: 'Υ',
    CurlyCapitalUpsilon: 'ϒ', CapitalPhi: 'Φ', CapitalChi: 'Χ', CapitalPsi: 'Ψ', CapitalOmega: 'Ω',
    CapitalDigamma: 'Ϝ', CapitalKoppa: 'Ϟ', CapitalStigma: 'Ϛ', CapitalSampi: 'Ϡ',
};

const SYMBOLS = {
    Rule: '→', RuleDelayed: '⧴', TwoWayRule: '<->', Equal: '==', LongEqual: '=', NotEqual: '≠',
    LessEqual: '≤', GreaterEqual: '≥', LessLess: '≪', GreaterGreater: '≫', LessTilde: '≲',
    GreaterTilde: '≳', Element: '∈', NotElement: '∉', ReverseElement: '∋', Subset: '⊂',
    SubsetEqual: '⊆', Superset: '⊃', SupersetEqual: '⊇', NotSubset: '⊄', Union: '⋃', Intersection: '⋂',
    Infinity: '∞', ExponentialE: 'ⅇ', ImaginaryI: 'ⅈ', ImaginaryJ: 'ⅉ', DifferentialD: 'ⅆ',
    CapitalDifferentialD: 'ⅅ', PartialD: '∂', Integral: '∫', ContourIntegral: '∮',
    DoubleContourIntegral: '∯', Sum: '∑', Product: '∏', Coproduct: '∐', Degree: '°', Times: '×',
    Divide: '÷', PlusMinus: '±', MinusPlus: '∓', Cross: '×', CenterDot: '·', Bullet: '•',
    Ellipsis: '…', CenterEllipsis: '⋯', VerticalEllipsis: '⋮', AscendingEllipsis: '⋰',
    DescendingEllipsis: '⋱', Del: '∇', Square: '□', And: '∧', Or: '∨', Nand: '⊼', Nor: '⊽', Xor: '⊻',
    Not: '¬', Implies: '⟹', Equivalent: '⧦', ForAll: '∀', Exists: '∃', NotExists: '∄', EmptySet: '∅',
    RightArrow: '→', LeftArrow: '←', LeftRightArrow: '↔', UpArrow: '↑', DownArrow: '↓',
    UpDownArrow: '↕', DoubleRightArrow: '⇒', DoubleLeftArrow: '⇐', DoubleLeftRightArrow: '⇔',
    Rightarrow: '⇒', Leftarrow: '⇐', LongRightArrow: '⟶', LongLeftArrow: '⟵',
    LongLeftRightArrow: '⟷', RightVector: '⇀', LeftVector: '↼', UpperRightArrow: '↗',
    LowerRightArrow: '↘', Function: '↦', Proportional: '∝', Tilde: '∼', TildeEqual: '≃',
    TildeFullEqual: '≅', TildeTilde: '≈', NotTilde: '≁', Congruent: '≡', NotCongruent: '≢',
    Prime: '′', DoublePrime: '″', ReversePrime: '‵', Dagger: '†', DoubleDagger: '‡',
    Transpose: 'ᵀ', ConjugateTranspose: '†', HermitianConjugate: '†', Conjugate: '*', Hacek: 'ˇ',
    Breve: '˘', Micro: 'µ', Angstrom: 'Å', HBar: 'ℏ', Euro: '€', Sterling: '£', Yen: '¥', Cent: '¢',
    Copyright: '©', RegisteredTrademark: '®', Trademark: '™', Section: '§', Paragraph: '¶',
    Dash: '–', LongDash: '—', LeftGuillemet: '«', RightGuillemet: '»', OpenCurlyQuote: '‘',
    CloseCurlyQuote: '’', OpenCurlyDoubleQuote: '“', CloseCurlyDoubleQuote: '”',
    InvisibleTimes: '', InvisibleSpace: '', InvisibleComma: '', InvisibleApplication: '',
    InvisiblePrefixScriptBase: '', InvisiblePostfixScriptBase: '', NoBreak: '', Null: '',
    ZeroWidthSpace: '', AlignmentMarker: '', AutoSpace: ' ', IndentingNewLine: '\n', NewLine: '\n',
    LineSeparator: '\n', ParagraphSeparator: '\n\n', ThinSpace: ' ', VeryThinSpace: ' ',
    MediumSpace: ' ', ThickSpace: ' ', NegativeVeryThinSpace: '', NegativeThinSpace: '',
    NegativeMediumSpace: '', NegativeThickSpace: '', NonBreakingSpace: ' ', SpaceIndicator: '␣',
    ReturnIndicator: '↵', EnterKey: '⏎', EscapeKey: 'esc', Placeholder: '⬚',
    SelectionPlaceholder: '⬚', LeftDoubleBracket: '〚', RightDoubleBracket: '〛',
    LeftAngleBracket: '〈', RightAngleBracket: '〉', LeftFloor: '⌊', RightFloor: '⌋',
    LeftCeiling: '⌈', RightCeiling: '⌉', LeftAssociation: '<|', RightAssociation: '|>',
    VerticalSeparator: '|', LeftBracketingBar: '|', RightBracketingBar: '|',
    LeftDoubleBracketingBar: '‖', RightDoubleBracketingBar: '‖', VerticalBar: '|',
    DoubleVerticalBar: '‖', NotDoubleVerticalBar: '∦', Checkmark: '✓', FilledSquare: '■',
    EmptySquare: '□', FilledSmallSquare: '▪', EmptySmallSquare: '▫', FilledCircle: '●',
    EmptyCircle: '○', FilledSmallCircle: '•', EmptySmallCircle: '◦', FilledDiamond: '◆',
    EmptyDiamond: '◇', FilledUpTriangle: '▲', EmptyUpTriangle: '△', FilledDownTriangle: '▼',
    EmptyDownTriangle: '▽', Star: '⋆', FivePointedStar: '★', SixPointedStar: '✶', WarningSign: '⚠',
    Aleph: 'ℵ', Beth: 'ℶ', Gimel: 'ℷ', Dalet: 'ℸ', Mho: '℧', Angle: '∠', RightAngle: '∟',
    MeasuredAngle: '∡', Perpendicular: '⟂', Therefore: '∴', Because: '∵', SmallCircle: '∘',
    Composition: '∘', CircleTimes: '⊗', CirclePlus: '⊕', CircleDot: '⊙', CircleMinus: '⊖',
    Wedge: '⋀', Vee: '⋁', Diamond: '⋄', Backslash: '∖', Colon: '∶', Precedes: '≺', Succeeds: '≻',
    SquareSubset: '⊏', SquareSuperset: '⊐', SquareUnion: '⊔', SquareIntersection: '⊓',
    Sqrt: '√', OverBrace: '⏞', UnderBrace: '⏟', OverBracket: '⎴', UnderBracket: '⎵',
    OverParenthesis: '⏜', UnderParenthesis: '⏝', HorizontalLine: '─', VerticalLine: '│',
    DownExclamation: '¡', DownQuestion: '¿', Ohm: 'Ω', DotlessI: 'ı', DotlessJ: 'ȷ', AE: 'æ',
    CapitalAE: 'Æ', SZ: 'ß', OSlash: 'ø', CapitalOSlash: 'Ø', Thorn: 'þ', CapitalThorn: 'Þ',
    Eth: 'ð', CapitalEth: 'Ð', LSlash: 'ł', CapitalLSlash: 'Ł', Mod1Key: 'alt', Mod2Key: 'opt',
    CommandKey: '⌘', ControlKey: 'ctrl', ShiftKey: 'shift', ReturnKey: '↩', TabKey: 'tab',
    DeleteKey: 'del', KeyBar: '|', Minus: '−', Hyphen: '‐', Integers: 'ℤ', Reals: 'ℝ',
    DirectedEdge: '→', UndirectedEdge: '↔', Distributed: '~', Conditioned: '|', Application: '@',
    Continuation: '⋯', SkeletonIndicator: '⁃', Shah: 'Ш', Wolf: '🐺', FreakedSmiley: '😱',
    HappySmiley: '☺', SadSmiley: '☹', NeutralSmiley: '😐', Flat: '♭', Natural: '♮', Sharp: '♯',
    SpadeSuit: '♠', HeartSuit: '♡', DiamondSuit: '♢', ClubSuit: '♣', Earth: '♁', Sun: '☉',
    Mercury: '☿', Venus: '♀', Mars: '♂', Jupiter: '♃', Saturn: '♄', Uranus: '♅', Neptune: '♆',
    Pluto: '♇', Moon: '☾', MathematicaIcon: '✱', VectorGreater: '≻', VectorLess: '≺',
    PermutationProduct: '∘', TensorProduct: '⊗', TensorWedge: '⋀', Cap: '⌢', Cup: '⌣',
    CupCap: '≍', DotEqual: '≐', HumpEqual: '≏', HumpDownHump: '≎', NotEqualTilde: '≂̸',
    Piecewise: '{', Diameter: '⌀', Implicit: '', Vee: '⋁',
};

const RAW = {
    Space: ' ', Exclamation: '!', DoubleQuote: '"', NumberSign: '#', Dollar: '$', Percent: '%',
    Ampersand: '&', Quote: "'", LeftParenthesis: '(', RightParenthesis: ')', Star: '*', Plus: '+',
    Comma: ',', Dash: '-', Dot: '.', Slash: '/', Colon: ':', Semicolon: ';', Less: '<', Equal: '=',
    Greater: '>', Question: '?', At: '@', LeftBracket: '[', Backslash: '\\', RightBracket: ']',
    Wedge: '^', Underscore: '_', Backquote: '`', LeftBrace: '{', VerticalBar: '|', RightBrace: '}',
    Tilde: '~', Tab: '\t', Return: '\n', Escape: '',
};

const ACCENTS = {
    Acute: '́', Grave: '̀', Hat: '̂', DoubleDot: '̈', Tilde: '̃',
    Ring: '̊', Cedilla: '̧', Bar: '̄', Cup: '̆', Hacek: '̌',
    DoubleAcute: '̋', Dot: '̇',
};

// Letter families: offsets into Mathematical Alphanumeric Symbols, with the
// letters that live in Letterlike Symbols instead
const FAMILIES = {
    DoubleStruck: { upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8, x: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' } },
    Script: { upper: 0x1D49C, lower: 0x1D4B6, x: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' } },
    Gothic: { upper: 0x1D504, lower: 0x1D51E, x: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' } },
};
const DIGIT_NAMES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

const namedCache = new Map();
function namedChar(name) {
    if (namedCache.has(name)) return namedCache.get(name);
    let c = GREEK[name];
    if (c === undefined) c = SYMBOLS[name];
    if (c === undefined && name.startsWith('Raw')) c = RAW[name.slice(3)];
    if (c === undefined) {
        let m = /^(DoubleStruck|Script|Gothic)(Capital)?([A-Z]|Zero|One|Two|Three|Four|Five|Six|Seven|Eight|Nine)$/.exec(name);
        if (m) {
            const f = FAMILIES[m[1]];
            const d = DIGIT_NAMES.indexOf(m[3]);
            if (d >= 0) c = f.digit ? String.fromCodePoint(f.digit + d) : String(d);
            else {
                const letter = m[2] ? m[3] : m[3].toLowerCase();
                c = f.x[letter] || String.fromCodePoint((m[2] ? f.upper : f.lower) + letter.charCodeAt(0) - (m[2] ? 65 : 97));
            }
        } else if ((m = /^Formal(Capital)?([A-Z])$/.exec(name))) {
            c = m[1] ? m[2] : m[2].toLowerCase();
        } else if ((m = /^(Capital)?([A-Z])(Acute|Grave|Hat|DoubleDot|Tilde|Ring|Cedilla|Bar|Cup|Hacek|DoubleAcute|Dot)$/.exec(name))) {
            c = ((m[1] ? m[2] : m[2].toLowerCase()) + ACCENTS[m[3]]).normalize('NFC');
        } else {
            c = null;
        }
    }
    namedCache.set(name, c);
    return c;
}

// --- Tokens ---
const OPERATORS = [
    '^:=', '===', '=!=', '//.', '//@', '@@@', '>>>', '->', ':>', ':=', '^=', '/.', '//', '/@', '@@',
    '<>', '==', '!=', '<=', '>=', '&&', '||', ';;', '..', '/;', '+=', '-=', '*=', '/=', '++', '--',
    '::', '<|', '|>', '**', '@*', '/*', '=.', '+', '-', '*', '/', '^', '.', '=', ';', ',', '&', '|',
    '!', '?', '@', '<', '>', ':', "'", '~', '[', ']', '{', '}', '(', ')',
];

class WLSyntaxError extends Error {}

function isLetter(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '$' || c > '\u007f';
}
function isDigit(c) { return c >= '0' && c <= '9'; }

class Lexer {
    constructor(src, pos = 0) {
        this.src = src;
        this.pos = pos;
        this.peeked = null;
    }

    error(msg) {
        const before = this.src.slice(0, this.pos);
        const line = before.split('\n').length;
        throw new WLSyntaxError(`${msg} (line ${line})`);
    }

    skipSpace() {
        const s = this.src;
        for (;;) {
            const c = s[this.pos];
            if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f') { this.pos++; continue; }
            if (c === '\\' && (s[this.pos + 1] === '\n' || s[this.pos + 1] === '\r')) { this.pos += 2; continue; }
            if (c === '(' && s[this.pos + 1] === '*') {
                let depth = 1;
                this.pos += 2;
                while (depth && this.pos < s.length) {
                    if (s[this.pos] === '(' && s[this.pos + 1] === '*') { depth++; this.pos += 2; }
                    else if (s[this.pos] === '*' && s[this.pos + 1] === ')') { depth--; this.pos += 2; }
                    else this.pos++;
                }
                continue;
            }
            return;
        }
    }

    peek() {
        if (!this.peeked) this.peeked = this.read();
        return this.peeked;
    }

    next() {
        const t = this.peek();
        this.peeked = null;
        return t;
    }

    read() {
        this.skipSpace();
        const s = this.src;
        const start = this.pos;
        if (this.pos >= s.length) return { t: 'eof', start };
        const c = s[this.pos];
        if (c === '"') return { t: 'str', v: this.readString(), start };
        if (isDigit(c) || (c === '.' && isDigit(s[this.pos + 1] || ''))) return { t: 'num', v: this.readNumber(), start };
        if (isLetter(c) || c === '`' || c === '_' || (c === '\\' && s[this.pos + 1] === '[')) return { t: 'sym', v: this.readSymbol(), start };
        if (c === '#') {
            let j = this.pos + 1;
            if (s[j] === '#') j++;
            while (j < s.length && (isDigit(s[j]) || isLetter(s[j]))) j++;
            const v = s.slice(this.pos, j);
            this.pos = j;
            return { t: 'slot', v, start };
        }
        if (c === '%') {
            let j = this.pos + 1;
            while (s[j] === '%' || isDigit(s[j] || '')) j++;
            const v = s.slice(this.pos, j);
            this.pos = j;
            return { t: 'sym', v, start };
        }
        for (const op of OPERATORS) {
            if (s.startsWith(op, this.pos)) {
                this.pos += op.length;
                return { t: 'op', v: op, start };
            }
        }
        this.error(`Unexpected character ${JSON.stringify(c)}`);
    }

    readString() {
        const s = this.src;
        let i = this.pos + 1;
        let out = '';
        for (;;) {
            if (i >= s.length) this.error('Unterminated string');
            const c = s[i];
            if (c === '"') { i++; break; }
            if (c !== '\\') {
                let j = i;
                while (j < s.length && s[j] !== '"' && s[j] !== '\\') j++;
                out += s.slice(i, j);
                i = j;
                continue;
            }
            const e = s[i + 1];
            i += 2;
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'f': out += '\f'; break;
                case 'b': out += '\b'; break;
                case '\n': break;
                case '\r': if (s[i] === '\n') i++; break;
                case '<': case '>': break;
                case '[': {
                    const end = s.indexOf(']', i);
                    const name = s.slice(i, end);
                    const ch = /^[A-Za-z0-9]+$/.test(name) ? namedChar(name) : null;
                    out += ch === null ? '\\[' + name + ']' : ch;
                    i = end + 1;
                    break;
                }
                case ':': out += String.fromCharCode(parseInt(s.substr(i, 4), 16)); i += 4; break;
                case '.': out += String.fromCharCode(parseInt(s.substr(i, 2), 16)); i += 2; break;
                case '|': out += String.fromCodePoint(parseInt(s.substr(i, 6), 16)); i += 6; break;
                case '!': case '(': case ')': case '*': case '^': case '_': case '/': case '@':
                case '%': case '&': case '+': case '`': case ' ': case '#':
                    out += LS + e;
                    break;
                default:
                    if (e >= '0' && e <= '7' && s[i] >= '0' && s[i] <= '7') {
                        out += String.fromCharCode(parseInt(s.substr(i - 1, 3), 8));
                        i += 2;
                    } else {
                        out += e;
                    }
            }
        }
        this.pos = i;
        return out;
    }

    readNumber() {
        const s = this.src;
        const m = /^(\d+\^\^)?([0-9a-zA-Z]*\.?[0-9a-zA-Z]*)/.exec(s.slice(this.pos, this.pos + 400));
        let i = this.pos;
        let value;
        if (m[1]) {
            const base = parseInt(m[1], 10);
            const [ip, fp = ''] = m[2].split('.');
            value = parseInt(ip || '0', base);
            for (let k = 0; k < fp.length; k++) value += parseInt(fp[k], base) / Math.pow(base, k + 1);
            i += m[0].length;
        } else {
            let j = i;
            while (isDigit(s[j] || '')) j++;
            if (s[j] === '.' && s[j + 1] !== '.') {
                j++;
                while (isDigit(s[j] || '')) j++;
            }
            value = parseFloat(s.slice(i, j));
            i = j;
        }
        // Precision or accuracy: ` or `` and an optional number
        if (s[i] === '`') {
            i++;
            if (s[i] === '`') i++;
            if (s[i] === '-' || s[i] === '+') { if (isDigit(s[i + 1] || '')) i++; }
            while (isDigit(s[i] || '') || (s[i] === '.' && isDigit(s[i + 1] || ''))) i++;
        }
        if (s[i] === '*' && s[i + 1] === '^') {
            let j = i + 2;
            if (s[j] === '-' || s[j] === '+') j++;
            const k = j;
            while (isDigit(s[j] || '')) j++;
            if (j > k) {
                value *= Math.pow(10, parseInt(s.slice(i + 2, j), 10));
                i = j;
            }
        }
        this.pos = i;
        return value;
    }

    readSymbol() {
        const s = this.src;
        let i = this.pos;
        let name = '';
        for (;;) {
            const c = s[i];
            if (c === undefined) break;
            if (isLetter(c) || isDigit(c) || c === '`') { name += c; i++; continue; }
            if (c === '\\' && s[i + 1] === '[') {
                const end = s.indexOf(']', i);
                const ch = namedChar(s.slice(i + 2, end));
                name += ch === null ? s.slice(i, end + 1) : ch;
                i = end + 1;
                continue;
            }
            break;
        }
        // Patterns: x_, x__, x_Head, x_., _
        if (s[i] === '_') {
            while (s[i] === '_') { name += '_'; i++; }
            while (s[i] && (isLetter(s[i]) || isDigit(s[i]) || s[i] === '`')) { name += s[i]; i++; }
            if (s[i] === '.' && !isDigit(s[i + 1] || '') && s[i + 1] !== '.') { name += '.'; i++; }
        }
        this.pos = i;
        return name;
    }
}

// --- Expressions ---
const symCache = new Map();
function sym(name) {
    let s = symCache.get(name);
    if (!s) { s = { s: name }; symCache.set(name, s); }
    return s;
}
function mk(head, args) { return { h: typeof head === 'string' ? sym(head) : head, a: args }; }
function list(args) { return mk('List', args); }
// The name of a symbol, or of the head of a normal expression whose head is a symbol
function headName(e) { return e && e.h && e.h.s; }
function isSym(e, name) { return !!e && e.s === name; }
function isList(e) { return headName(e) === 'List'; }

const BINARY = {
    '::': [1010, 'MessageName'], '@': [640, null, true], '/@': [620, 'Map', true], '@@': [620, 'Apply', true],
    '@@@': [620, 'MapApply', true], '//@': [620, 'MapAll', true], '<>': [600, 'StringJoin'],
    '^': [590, 'Power', true], '**': [580, 'NonCommutativeMultiply'], '.': [490, 'Dot'],
    '/': [470, 'Divide'], '*': [400, 'Times'], '+': [310, 'Plus'], '-': [310, 'Subtract'],
    ';;': [305, 'Span'], '==': [290, 'Equal'], '!=': [290, 'Unequal'], '<': [290, 'Less'],
    '>': [290, 'Greater'], '<=': [290, 'LessEqual'], '>=': [290, 'GreaterEqual'],
    '===': [290, 'SameQ'], '=!=': [290, 'UnsameQ'], '&&': [215, 'And'], '||': [214, 'Or'],
    '|': [160, 'Alternatives'], ':': [150, 'Pattern'], '/;': [130, 'Condition'],
    '->': [120, 'Rule', true], ':>': [120, 'RuleDelayed', true], '/.': [110, 'ReplaceAll'],
    '//.': [110, 'ReplaceRepeated'], '+=': [100, 'AddTo', true], '-=': [100, 'SubtractFrom', true],
    '*=': [100, 'TimesBy', true], '/=': [100, 'DivideBy', true], '//': [70, null],
    '=': [40, 'Set', true], ':=': [40, 'SetDelayed', true], '^=': [40, 'UpSet', true],
    '^:=': [40, 'UpSetDelayed', true], '@*': [625, 'Composition'], '/*': [624, 'RightComposition'],
    '~': [630, null], '?': [1005, 'PatternTest'],
};
const POSTFIX = { '&': [90, 'Function'], "'": [670, 'Derivative'], '..': [170, 'Repeated'], '!': [610, 'Factorial'], '++': [660, 'Increment'], '--': [660, 'Decrement'], '=.': [40, 'Unset'] };
const STARTS = new Set(['num', 'str', 'sym', 'slot']);

class Parser {
    constructor(src, pos = 0) {
        this.lx = new Lexer(src, pos);
    }

    expectOp(v) {
        const t = this.lx.next();
        if (t.t !== 'op' || t.v !== v) this.lx.error(`Expected "${v}", found ${t.t === 'eof' ? 'end of file' : JSON.stringify(t.v)}`);
    }

    // Arguments up to the closing token: a, b, c (a missing one is Null)
    parseSequence(close) {
        const args = [];
        const t = this.lx.peek();
        if (t.t === 'op' && t.v === close) { this.lx.next(); return args; }
        for (;;) {
            const p = this.lx.peek();
            if (p.t === 'op' && (p.v === ',' || p.v === close)) args.push(sym('Null'));
            else args.push(this.parse(0));
            const n = this.lx.next();
            if (n.t === 'op' && n.v === ',') continue;
            if (n.t === 'op' && n.v === close) return args;
            this.lx.error(`Expected "," or "${close}", found ${n.t === 'eof' ? 'end of file' : JSON.stringify(n.v)}`);
        }
    }

    prefix() {
        const t = this.lx.next();
        switch (t.t) {
            case 'num': return t.v;
            case 'str': return t.v;
            case 'sym': return sym(t.v);
            case 'slot': {
                const rest = t.v.replace(/^##?/, '');
                const head = t.v.startsWith('##') ? 'SlotSequence' : 'Slot';
                return mk(head, [rest === '' ? 1 : /^\d+$/.test(rest) ? +rest : rest]);
            }
            case 'eof': this.lx.error('Unexpected end of file');
        }
        switch (t.v) {
            case '(': { const e = this.parse(0); this.expectOp(')'); return e; }
            case '{': return list(this.parseSequence('}'));
            case '<|': return mk('Association', this.parseSequence('|>'));
            case '-': {
                const e = this.parse(480);
                return typeof e === 'number' ? -e : mk('Times', [-1, e]);
            }
            case '+': return this.parse(480);
            case '!': return mk('Not', [this.parse(230)]);
            case '++': return mk('PreIncrement', [this.parse(660)]);
            case '--': return mk('PreDecrement', [this.parse(660)]);
            case ';;': return mk('Span', [1, this.parse(306)]);
        }
        this.lx.error(`Unexpected ${JSON.stringify(t.v)}`);
    }

    parse(rbp) {
        let left = this.prefix();
        for (;;) {
            const t = this.lx.peek();
            if (t.t === 'eof') return left;
            if (t.t !== 'op') {
                // Juxtaposition: implicit Times
                if (STARTS.has(t.t) && rbp < 400) { left = mk('Times', [left, this.parse(400)]); continue; }
                return left;
            }
            const op = t.v;
            if (op === '[') {
                if (rbp >= 1000) return left;
                this.lx.next();
                const p = this.lx.peek();
                if (p.t === 'op' && p.v === '[') {
                    this.lx.next();
                    const args = this.parseSequence(']');
                    this.expectOp(']');
                    left = mk('Part', [left, ...args]);
                } else {
                    left = mk(left, this.parseSequence(']'));
                }
                continue;
            }
            if ((op === '(' || op === '{' || op === '<|') && rbp < 400) { left = mk('Times', [left, this.parse(400)]); continue; }
            if (op === ';') {
                if (rbp >= 10) return left;
                this.lx.next();
                const items = [left];
                for (;;) {
                    const p = this.lx.peek();
                    if (p.t === 'eof' || (p.t === 'op' && (p.v === ')' || p.v === ']' || p.v === '}' || p.v === ',' || p.v === '|>'))) {
                        items.push(sym('Null'));
                        break;
                    }
                    items.push(this.parse(10));
                    const q = this.lx.peek();
                    if (q.t === 'op' && q.v === ';') { this.lx.next(); continue; }
                    break;
                }
                left = mk('CompoundExpression', items);
                continue;
            }
            const post = POSTFIX[op];
            if (post) {
                if (post[0] <= rbp) return left;
                this.lx.next();
                left = mk(post[1], [left]);
                continue;
            }
            const bin = BINARY[op];
            if (!bin) return left;
            const [bp, name, right] = bin;
            if (bp <= rbp) return left;
            this.lx.next();
            if (op === '~') {
                const f = this.parse(631);
                this.expectOp('~');
                left = mk(f, [left, this.parse(631)]);
                continue;
            }
            const rhs = this.parse(right ? bp - 1 : bp);
            if (op === '@') left = mk(left, [rhs]);
            else if (op === '//') left = mk(rhs, [left]);
            else if (op === '-') left = mk('Plus', [left, typeof rhs === 'number' ? -rhs : mk('Times', [-1, rhs])]);
            else if (op === '/') left = mk('Times', [left, mk('Power', [rhs, -1])]);
            else if (name === 'Times' || name === 'Plus' || name === 'And' || name === 'Or' || name === 'Alternatives' || name === 'StringJoin') {
                left = headName(left) === name && !left.paren ? mk(name, [...left.a, rhs]) : mk(name, [left, rhs]);
            } else left = mk(name, [left, rhs]);
        }
    }
}

// Joins lines continued with \ at their end, which can split a token anywhere
// (-\<newline>>); in strings readString does it
function joinContinuations(src) {
    if (!/\\\r?\n/.test(src)) return src;
    let out = '';
    let i = 0, from = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"') {
            i++;
            while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
            i++;
        } else if (c === '(' && src[i + 1] === '*') {
            const end = src.indexOf('*)', i + 2);
            i = end < 0 ? src.length : end + 2;
        } else if (c === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
            out += src.slice(from, i);
            i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
            from = i;
        } else i++;
    }
    return out + src.slice(from);
}

// The value of a string literal's source ("a\\"b" -> a"b)
function decodeStringLiteral(src) {
    const lx = new Lexer(src);
    try {
        const v = lx.readString();
        return lx.pos === src.length ? v : null;
    } catch {
        return null;
    }
}

// The whole text as one expression (notebooks have comments around it)
function parseWL(src) {
    const p = new Parser(joinContinuations(src));
    const e = p.parse(0);
    const t = p.lx.peek();
    if (t.t !== 'eof') p.lx.error(`Unexpected ${JSON.stringify(t.v)} after the expression`);
    return e;
}

// One expression starting at pos, and where it ends (linear syntax: \*Box[...])
function parseWLPrefix(src, pos) {
    const p = new Parser(src, pos);
    const e = p.parse(999); // Box[...] and nothing looser
    return { expr: e, end: p.lx.peeked ? p.lx.peeked.start : p.lx.pos };
}

// --- CompressedData ---
function base64Bytes(b64) {
    if (typeof atob === 'function') {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readDump(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dec = new TextDecoder();
    if (dec.decode(bytes.subarray(0, 4)) !== '!boR') throw new Error('not a Mathematica expression dump');
    let p = 4;
    const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
    const str = () => { const n = i32(); const v = dec.decode(bytes.subarray(p, p + n)); p += n; return v; };
    const packed = (size, get) => {
        const rank = i32();
        const dims = [];
        for (let k = 0; k < rank; k++) dims.push(i32());
        const build = (d) => {
            const items = [];
            if (d === rank - 1) {
                for (let k = 0; k < dims[d]; k++) { items.push(get(p)); p += size; }
            } else {
                for (let k = 0; k < dims[d]; k++) items.push(build(d + 1));
            }
            return list(items);
        };
        return build(0);
    };
    const read = () => {
        const tag = String.fromCharCode(bytes[p++]);
        switch (tag) {
            case 'f': { const n = i32(); const head = read(); const args = []; for (let k = 0; k < n; k++) args.push(read()); return mk(head, args); }
            case 's': return sym(str());
            case 'S': return str();
            case 'i': return i32();
            case 'L': { const v = Number(dv.getBigInt64(p, true)); p += 8; return v; }
            case 'r': { const v = dv.getFloat64(p, true); p += 8; return v; }
            case 'I': return Number(str());
            case 'R': return parseFloat(str().replace(/`.*$/, '').replace('*^', 'e'));
            case 'e': return packed(8, q => dv.getFloat64(q, true));
            case 'n': return packed(4, q => dv.getInt32(q, true));
            case 'b': return packed(1, q => bytes[q]);
            case 'j': return packed(2, q => dv.getInt16(q, true));
            case 'c': return packed(16, q => mk('Complex', [dv.getFloat64(q, true), dv.getFloat64(q + 8, true)]));
            default: throw new Error(`unknown tag ${JSON.stringify(tag)} in compressed data`);
        }
    };
    return read();
}

async function decodeCompressedData(text) {
    const b64 = text.replace(/[\s\\]/g, '');
    const m = /^(\d+):(.*)$/.exec(b64);
    if (!m) throw new Error('unknown compressed data format');
    return readDump(await inflate(base64Bytes(m[2])));
}

// Replaces every CompressedData["..."] in e with what it holds (in place;
// returns the new root). Undecodable ones are left as they are.
async function expandCompressedData(root) {
    const jobs = [];
    const visit = (e, parent, index) => {
        if (!e || typeof e !== 'object' || !e.a) return;
        if (headName(e) === 'CompressedData' && typeof e.a[0] === 'string') {
            jobs.push(decodeCompressedData(e.a[0]).then(v => {
                if (parent) parent.a[index] = v;
                else root = v;
            }, () => {}));
            return;
        }
        for (let i = 0; i < e.a.length; i++) visit(e.a[i], e, i);
    };
    visit(root, null, 0);
    await Promise.all(jobs);
    return root;
}

module.exports = {
    LS, parseWL, parseWLPrefix, decodeStringLiteral, namedChar, sym, mk, list, headName, isSym, isList,
    decodeCompressedData, expandCompressedData, WLSyntaxError,
};
