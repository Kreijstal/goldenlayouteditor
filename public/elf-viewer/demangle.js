// A small Itanium C++ ABI demangler (_Z… names, as g++ and clang emit them):
// nested and local names, constructors/destructors, operators, templates and
// template parameters, substitutions, function/pointer/reference/array types,
// cv-qualifiers, ABI tags, literals, vtables/typeinfo/thunks/guard variables.
// Anything it does not understand leaves the name as it was (demangle returns
// null), so it is never wrong in a confusing way, only sometimes absent.

const BUILTIN = {
    v: 'void', w: 'wchar_t', b: 'bool', c: 'char', a: 'signed char', h: 'unsigned char', s: 'short', t: 'unsigned short',
    i: 'int', j: 'unsigned int', l: 'long', m: 'unsigned long', x: 'long long', y: 'unsigned long long', n: '__int128',
    o: 'unsigned __int128', f: 'float', d: 'double', e: 'long double', g: '__float128', z: '...',
};
const BUILTIN_D = { d: 'decimal64', e: 'decimal128', f: 'decimal32', h: 'half', i: 'char32_t', s: 'char16_t', u: 'char8_t', a: 'auto', c: 'decltype(auto)', n: 'decltype(nullptr)' };
const OPERATORS = {
    nw: 'new', na: 'new[]', dl: 'delete', da: 'delete[]', ps: '+', ng: '-', ad: '&', de: '*', co: '~', pl: '+', mi: '-', ml: '*',
    dv: '/', rm: '%', an: '&', or: '|', eo: '^', aS: '=', pL: '+=', mI: '-=', mL: '*=', dV: '/=', rM: '%=', aN: '&=', oR: '|=',
    eO: '^=', ls: '<<', rs: '>>', lS: '<<=', rS: '>>=', eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=', ss: '<=>',
    nt: '!', aa: '&&', oo: '||', pp: '++', mm: '--', cm: ',', pm: '->*', pt: '->', cl: '()', ix: '[]', qu: '?',
};
const STD_SUBS = {
    t: 'std', a: 'std::allocator', b: 'std::basic_string', s: 'std::string', i: 'std::istream', o: 'std::ostream', d: 'std::iostream',
};

const STD_SUBS_FULL = {
    s: 'std::basic_string<char, std::char_traits<char>, std::allocator<char> >',
    i: 'std::basic_istream<char, std::char_traits<char> >',
    o: 'std::basic_ostream<char, std::char_traits<char> >',
    d: 'std::basic_iostream<char, std::char_traits<char> >',
};

class Fail extends Error {}

export function demangle(name) {
    if (typeof name !== 'string' || !name.startsWith('_Z')) return null;
    // versioned symbols (foo@GLIBCXX_3.4) and clone suffixes (.cold, .isra.0)
    let suffix = '';
    const at = name.indexOf('@');
    if (at > 0) { suffix = name.slice(at); name = name.slice(0, at); }
    try {
        const p = new Parser(name);
        let out = p.encodingTop();
        if (p.i < p.s.length) {
            const rest = p.s.slice(p.i);
            if (/^(\.[A-Za-z_][\w]*(\.\d+)*)+$/.test(rest)) out += ' [clone ' + rest + ']';
            else return null;
        }
        return out + suffix;
    } catch (err) {
        if (err instanceof Fail || err instanceof RangeError) return null;
        throw err;
    }
}

class Parser {
    constructor(s) {
        this.s = s;
        this.i = 2;
        this.subs = [];
        this.tmpl = [];       // the innermost template args, for T_
        this.depth = 0;
    }
    peek(n = 0) { return this.s[this.i + n]; }
    eat(str) { if (this.s.startsWith(str, this.i)) { this.i += str.length; return true; } return false; }
    need(str) { if (!this.eat(str)) throw new Fail(); }
    num() {
        const m = /^n?\d+/.exec(this.s.slice(this.i));
        if (!m) throw new Fail();
        this.i += m[0].length;
        return m[0][0] === 'n' ? -parseInt(m[0].slice(1), 10) : parseInt(m[0], 10);
    }
    seqId() { // [0-9A-Z]* _
        let v = 0, any = false;
        while (/[0-9A-Z]/.test(this.peek() || '')) { v = v * 36 + parseInt(this.peek(), 36); this.i++; any = true; }
        this.need('_');
        return any ? v + 1 : 0;
    }

    encodingTop() {
        // special names
        if (this.eat('TV')) return 'vtable for ' + this.type().str;
        if (this.eat('TT')) return 'VTT for ' + this.type().str;
        if (this.eat('TI')) return 'typeinfo for ' + this.type().str;
        if (this.eat('TS')) return 'typeinfo name for ' + this.type().str;
        if (this.eat('GV')) return 'guard variable for ' + this.name().str;
        if (this.eat('GR')) { const n = this.name().str; while (this.i < this.s.length && this.peek() !== '.') this.i++; return 'reference temporary for ' + n; }
        if (this.eat('Th')) { this.num(); this.need('_'); return 'non-virtual thunk to ' + this.encoding(); }
        if (this.eat('Tv')) { this.num(); this.need('_'); this.num(); this.need('_'); return 'virtual thunk to ' + this.encoding(); }
        if (this.eat('Tc')) { this.callOffset(); this.callOffset(); return 'covariant return thunk to ' + this.encoding(); }
        if (this.eat('TH')) return 'TLS init function for ' + this.name().str;
        if (this.eat('TW')) return 'TLS wrapper function for ' + this.name().str;
        return this.encoding();
    }
    callOffset() {
        if (this.eat('h')) { this.num(); this.need('_'); }
        else if (this.eat('v')) { this.num(); this.need('_'); this.num(); this.need('_'); }
        else throw new Fail();
    }

    encoding() {
        if (++this.depth > 200) throw new Fail();
        const n = this.name();
        this.depth--;
        if (this.i >= this.s.length || this.peek() === 'E' || this.peek() === '.') return n.str;
        // function: return type first when templated (and not ctor/dtor/conversion)
        // T_ in the signature: the function's own template arguments
        const fnArgs = n.templated ? this.tmpl : null;
        let ret = '';
        if (n.templated && !n.ctor) ret = this.type().str + ' ';
        const params = this.bareFunctionType(fnArgs);
        return ret + n.str + params + n.quals;
    }
    bareFunctionType(fnArgs) {
        const ps = [];
        while (this.i < this.s.length && this.peek() !== 'E' && this.peek() !== '.') {
            if (fnArgs) this.tmpl = fnArgs;
            ps.push(this.type().str);
        }
        if (ps.length === 1 && ps[0] === 'void') return '()';
        return '(' + ps.join(', ') + ')';
    }

    // returns { str, templated, ctor, quals }
    name() {
        const c = this.peek();
        if (c === 'N') return this.nestedName();
        if (c === 'Z') return this.localName();
        if (this.eat('St')) {
            const u = this.unqualified(null);
            let str = 'std::' + u.str;
            if (this.peek() === 'I') { this.subs.push(str); const a = this.templateArgs(); str += a; return { str, templated: true, ctor: u.ctor, quals: '' }; }
            return { str, templated: false, ctor: u.ctor, quals: '' };
        }
        if (c === 'S') {
            const sub = this.substitution();
            if (this.peek() === 'I') { const a = this.templateArgs(); const str = sub + a; this.subs.push(str); return { str, templated: true, ctor: false, quals: '' }; }
            return { str: sub, templated: false, ctor: false, quals: '' };
        }
        const u = this.unqualified(null);
        let str = u.str;
        if (this.peek() === 'I') {
            this.subs.push(str);
            str += this.templateArgs();
            return { str, templated: true, ctor: u.ctor, quals: '' };
        }
        return { str, templated: false, ctor: u.ctor, quals: '' };
    }

    nestedName() {
        this.need('N');
        let quals = '';
        const q = this.cvQuals();
        if (q) quals = ' ' + q;
        if (this.eat('R')) quals += ' &';
        else if (this.eat('O')) quals += ' &&';
        let prefix = null, last = null, templated = false, ctor = false;
        while (!this.eat('E')) {
            if (this.i >= this.s.length) throw new Fail();
            const c = this.peek();
            if (c === 'I') {
                if (prefix === null) throw new Fail();
                prefix += this.templateArgs();
                templated = true;
                if (this.peek() !== 'E') this.subs.push(prefix);
                continue;
            }
            if (c === 'S' && prefix === null) {
                if (this.eat('St')) { prefix = 'std'; continue; }
                prefix = this.substitution(true);
                continue;
            }
            if (c === 'T') { prefix = (prefix ? prefix + '::' : '') + this.templateParam(); this.subs.push(prefix); continue; }
            if (c === 'D' && (this.peek(1) === 't' || this.peek(1) === 'T')) { prefix = this.type().str; continue; }
            if (c === 'M') { this.i++; continue; } // data-member-prefix
            const u = this.unqualified(prefix ? prefix.replace(/<.*>$/, '').split('::').pop() : null);
            last = u;
            templated = false;
            ctor = u.ctor;
            prefix = prefix ? prefix + '::' + u.str : u.str;
            if (this.peek() !== 'E') this.subs.push(prefix);
        }
        return { str: prefix, templated, ctor, quals };
    }

    localName() {
        this.need('Z');
        const enc = this.encoding();
        this.need('E');
        if (this.eat('s')) { this.discriminator(); return { str: enc + '::string literal', templated: false, ctor: false, quals: '' }; }
        if (this.eat('d')) { if (this.peek() !== '_') this.num(); this.need('_'); }
        const n = this.name();
        this.discriminator();
        return { str: enc + '::' + n.str, templated: n.templated, ctor: n.ctor, quals: n.quals };
    }
    discriminator() {
        if (this.eat('__')) { this.num(); this.need('_'); }
        else if (this.eat('_')) this.num();
    }

    unqualified(enclosing) {
        const c = this.peek();
        let r;
        if (/[0-9]/.test(c)) r = { str: this.sourceName(), ctor: false };
        else if (c === 'C' && /[1-5I]/.test(this.peek(1) || '')) {
            this.i += 2;
            if (this.s[this.i - 1] === 'I') { this.i++; this.type(); }
            if (!enclosing) throw new Fail();
            r = { str: enclosing, ctor: true };
        } else if (c === 'D' && /[0-5]/.test(this.peek(1) || '')) {
            this.i += 2;
            if (!enclosing) throw new Fail();
            r = { str: '~' + enclosing, ctor: true };
        } else if (c === 'U' && this.peek(1) === 't') {
            this.i += 2;
            const n = this.peek() === '_' ? 1 : this.num() + 2;
            this.need('_');
            r = { str: `{unnamed type#${n}}`, ctor: false };
        } else if (c === 'U' && this.peek(1) === 'l') {
            this.i += 2;
            const ps = [];
            while (!this.eat('E')) ps.push(this.type().str);
            const n = this.peek() === '_' ? 1 : this.num() + 2;
            this.need('_');
            r = { str: `{lambda(${ps.length === 1 && ps[0] === 'void' ? '' : ps.join(', ')})#${n}}`, ctor: false };
        } else if (c === 'L') { this.i++; r = { str: this.sourceName(), ctor: false }; this.discriminator(); }
        else r = { str: this.operatorName(), ctor: false };
        while (this.eat('B')) r.str += '[abi:' + this.sourceName() + ']';
        return r;
    }
    sourceName() {
        const n = this.num();
        if (n <= 0 || this.i + n > this.s.length) throw new Fail();
        const id = this.s.substr(this.i, n);
        this.i += n;
        return /^_GLOBAL__N/.test(id) ? '(anonymous namespace)' : id;
    }
    operatorName() {
        const two = this.s.substr(this.i, 2);
        if (two === 'cv') { this.i += 2; return 'operator ' + this.type().str; }
        if (two === 'li') { this.i += 2; return 'operator"" ' + this.sourceName(); }
        if (OPERATORS[two]) { this.i += 2; const o = OPERATORS[two]; return 'operator' + (/^[a-z]/.test(o) ? ' ' : '') + o; }
        if (two[0] === 'v' && /[0-9]/.test(two[1])) { this.i += 2; return 'operator ' + this.sourceName(); }
        throw new Fail();
    }

    substitution(asPrefix) {
        this.need('S');
        const c = this.peek();
        if (asPrefix && STD_SUBS_FULL[c]) { this.i++; return STD_SUBS_FULL[c]; }
        if (STD_SUBS[c]) { this.i++; return STD_SUBS[c]; }
        const id = this.seqId();
        if (id >= this.subs.length) throw new Fail();
        return this.subs[id];
    }

    templateParam() {
        this.need('T');
        const id = this.seqId();
        if (id >= this.tmpl.length) return 'T' + (id || '');
        return this.tmpl[id];
    }

    templateArgs() {
        this.need('I');
        const args = [];
        while (!this.eat('E')) {
            if (this.i >= this.s.length) throw new Fail();
            args.push(this.templateArg());
        }
        this.tmpl = args;
        const body = args.join(', ');
        return '<' + body + (body.endsWith('>') ? ' >' : '>');
    }
    templateArg() {
        const c = this.peek();
        if (c === 'L') return this.literal();
        if (c === 'X') { this.i++; const e = this.expression(); this.need('E'); return e; }
        if (c === 'J') { this.i++; const a = []; while (!this.eat('E')) a.push(this.templateArg()); return a.join(', '); }
        return this.type().str;
    }
    literal() {
        this.need('L');
        if (this.eat('_Z')) { const e = this.encoding(); this.need('E'); return e; }
        const t = this.type().str;
        let neg = this.eat('n');
        let v = '';
        while (this.peek() !== 'E') { if (this.i >= this.s.length) throw new Fail(); v += this.peek(); this.i++; }
        this.need('E');
        if (t === 'bool') return v === '0' ? 'false' : 'true';
        const sfx = { int: '', 'unsigned int': 'u', long: 'l', 'unsigned long': 'ul', 'long long': 'll', 'unsigned long long': 'ull' }[t];
        if (sfx !== undefined) return (neg ? '-' : '') + v + sfx;
        return '(' + t + ')' + (neg ? '-' : '') + v;
    }
    expression() {
        // just enough for common non-type template args
        if (this.peek() === 'L') return this.literal();
        if (this.peek() === 'T') return this.templateParam();
        if (this.eat('sr')) { const t = this.type().str; return t + '::' + this.unqualified(null).str; }
        if (this.eat('fp')) { this.cvQuals(); if (this.peek() !== '_') this.num(); this.need('_'); return 'fp'; }
        const two = this.s.substr(this.i, 2);
        if (OPERATORS[two]) {
            this.i += 2;
            const a = this.expression();
            if (/^(ps|ng|ad|de|co|nt|pp|mm)$/.test(two)) return OPERATORS[two] + a;
            const b = this.expression();
            return '(' + a + ')' + OPERATORS[two] + '(' + b + ')';
        }
        throw new Fail();
    }

    cvQuals() {
        const q = [];
        if (this.eat('r')) q.push('restrict');
        if (this.eat('V')) q.push('volatile');
        if (this.eat('K')) q.push('const');
        return q.reverse().join(' ');
    }

    // returns { str }; types are added to the substitution table as they are read
    type() {
        if (++this.depth > 300) throw new Fail();
        try { return this._type(); } finally { this.depth--; }
    }
    _type() {
        const c = this.peek();
        if (c === undefined) throw new Fail();
        if (BUILTIN[c]) { this.i++; return { str: BUILTIN[c] }; }
        if (c === 'u') { this.i++; const s = { str: this.sourceName() }; this.subs.push(s.str); return s; }
        if (c === 'D') {
            const d = this.peek(1);
            if (BUILTIN_D[d]) { this.i += 2; return { str: BUILTIN_D[d] }; }
            if (d === 'p') { this.i += 2; const t = this.type().str + '...'; this.subs.push(t); return { str: t }; }
            if (d === 't' || d === 'T') { this.i += 2; const e = this.expression(); this.need('E'); const t = 'decltype(' + e + ')'; this.subs.push(t); return { str: t }; }
            if (d === 'v') { this.i += 2; const n = this.num(); this.need('_'); const t = this.type().str + ' __vector(' + n + ')'; this.subs.push(t); return { str: t }; }
            if (d === 'F') { this.i += 2; const n = this.num(); this.eat('_'); return { str: '_Float' + n }; }
            if (d === 'x' || d === 'o' || d === 'O' || d === 'w') { // exception specs before a function type
                this.i += 2;
                if (d === 'O') { this.expression(); this.need('E'); }
                else if (d === 'w') { while (!this.eat('E')) this.type(); }
                return this.type();
            }
            throw new Fail();
        }
        if (c === 'r' || c === 'V' || c === 'K') {
            const q = this.cvQuals();
            const inner = this.peek() === 'F';
            const t = this.type().str;
            const s = inner ? t + ' ' + q : (/[*&]$/.test(t) ? t + ' ' + q : t + ' ' + q);
            this.subs.push(s);
            return { str: s };
        }
        if (c === 'P' || c === 'R' || c === 'O') {
            this.i++;
            const sym = c === 'P' ? '*' : c === 'R' ? '&' : '&&';
            const inner = this.type().str;
            let s;
            if (inner.includes('(*)') || inner.includes('(&)')) s = inner; // already a function pointer
            const fm = /^(.*?) ?\((.*)\)( const| volatile| &&?)*$/.exec(inner);
            if (this._lastWasFunction && fm) { s = inner.replace(/^(.*?)\(/, (m0, ret) => ret.trimEnd() + ' (' + sym + ')('); this._lastWasFunction = false; }
            else if (/\[\d*\]$/.test(inner) && this._lastWasArray) { s = inner.replace(/ ?(\[\d*\])$/, ' (' + sym + ')$1'); this._lastWasArray = false; }
            else s = inner + sym;
            this.subs.push(s);
            return { str: s };
        }
        if (c === 'F') {
            this.i++;
            this.eat('Y');
            const ret = this.type().str;
            const params = this.bareFunctionTypeUntilE();
            let q = '';
            if (this.eat('R')) q = ' &'; else if (this.eat('O')) q = ' &&';
            this.need('E');
            const s = ret + ' ' + params + q;
            this.subs.push(s);
            this._lastWasFunction = true;
            return { str: s };
        }
        if (c === 'A') {
            this.i++;
            let dim = '';
            if (/[0-9]/.test(this.peek())) dim = String(this.num());
            else if (this.peek() !== '_') dim = this.expression();
            this.need('_');
            const t = this.type().str + ' [' + dim + ']';
            this.subs.push(t);
            this._lastWasArray = true;
            return { str: t };
        }
        if (c === 'M') {
            this.i++;
            const cls = this.type().str;
            const mem = this.type().str;
            const s = this._lastWasFunction ? mem.replace(/^(.*?)\(/, (m0, ret) => ret.trimEnd() + ' (' + cls + '::*)(') : mem + ' ' + cls + '::*';
            this._lastWasFunction = false;
            this.subs.push(s);
            return { str: s };
        }
        if (c === 'T') {
            let t = this.templateParam();
            this.subs.push(t);
            if (this.peek() === 'I') { t += this.templateArgs(); this.subs.push(t); }
            return { str: t };
        }
        if (c === 'S') {
            if (this.peek(1) === 't') {
                this.i += 2;
                let t = 'std::' + this.unqualified(null).str;
                this.subs.push(t);
                if (this.peek() === 'I') { t += this.templateArgs(); this.subs.push(t); }
                return { str: t };
            }
            let t = this.substitution();
            if (this.peek() === 'I') { t += this.templateArgs(); this.subs.push(t); }
            return { str: t };
        }
        if (c === 'N' || c === 'Z' || /[0-9]/.test(c)) {
            const n = this.name();
            this.subs.push(n.str);
            return { str: n.str };
        }
        throw new Fail();
    }
    bareFunctionTypeUntilE() {
        const ps = [];
        while (this.peek() !== 'E' && !(this.peek() === 'R' && this.peek(1) === 'E') && !(this.peek() === 'O' && this.peek(1) === 'E')) {
            if (this.i >= this.s.length) throw new Fail();
            ps.push(this.type().str);
        }
        if (ps.length === 1 && ps[0] === 'void') return '()';
        return '(' + ps.join(', ') + ')';
    }
}
