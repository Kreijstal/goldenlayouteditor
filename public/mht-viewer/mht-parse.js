// MHTML (RFC 2557) reader for the .mht/.mhtml viewer: MIME multipart/related
// (nested multiparts flattened), a single-part archive, or a message/rfc822
// wrapper. Bodies are decoded from base64, quoted-printable, 7bit/8bit/binary;
// header values from RFC 2047 encoded-words; text from its charset. Parts are
// found by Content-ID (cid:) and by Content-Location, absolute or relative to
// the part's base (Content-Base, else the enclosing multipart's base, else
// the root document's location). Read-only: nothing is written back.

// The whole file as a "binary string" (one char per byte, offsets shared with the bytes)
function binaryString(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return s;
}

function bytesOf(bin) {
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
}

// A decoder for a charset label; unknown labels fall back to windows-1252 (as browsers do for Latin text)
export function decoderFor(label, warnings) {
    if (label) {
        try { return new TextDecoder(label.trim().replace(/^["']|["']$/g, '')); } catch (e) {
            if (warnings) warnings.push(`Unknown charset "${label}", read as windows-1252`);
        }
    }
    return new TextDecoder('windows-1252');
}

// 8-bit header text that is not an encoded-word: UTF-8 if it is valid, else windows-1252
function decodeRawHeader(bin) {
    if (!/[\x80-\xff]/.test(bin)) return bin;
    const bytes = bytesOf(bin);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
}

// RFC 2047 encoded-words (=?charset?B|Q?text?=); whitespace between adjacent words is dropped
export function decodeEncodedWords(bin) {
    const re = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
    let out = '';
    let last = 0;
    let prevWasWord = false;
    let m;
    while ((m = re.exec(bin))) {
        const gap = bin.slice(last, m.index);
        if (!(prevWasWord && /^\s*$/.test(gap))) out += decodeRawHeader(gap);
        const charset = m[1].replace(/\*.*$/, ''); // RFC 2231 language suffix
        let raw;
        if (m[2].toUpperCase() === 'B') {
            try { raw = binaryString(decodeBase64(m[3])); } catch (e) { raw = m[0]; }
        } else {
            raw = m[3].replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        }
        out += decoderFor(charset).decode(bytesOf(raw));
        last = re.lastIndex;
        prevWasWord = true;
    }
    return out + decodeRawHeader(bin.slice(last));
}

// Header block → [{ name, value }] (unfolded, value still raw 8-bit text)
function parseHeaderBlock(text) {
    const headers = [];
    for (const line of text.split(/\r?\n/)) {
        if (/^[ \t]/.test(line) && headers.length) {
            headers[headers.length - 1].value += ' ' + line.trim();
            continue;
        }
        const i = line.indexOf(':');
        if (i <= 0) continue;
        headers.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
    return headers;
}

// Whether a block of text starts like MIME headers ("Name: value" on the first line)
function looksLikeHeaders(text) {
    return /^[!-9;-~]+:/.test(text);
}

// "type/sub; a=1; b="x y"" → { value: 'type/sub', params: { a: '1', b: 'x y' } }
export function parseParams(value) {
    const params = {};
    const re = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
    const semi = value.indexOf(';');
    const head = (semi < 0 ? value : value.slice(0, semi)).trim();
    if (semi >= 0) {
        re.lastIndex = semi;
        let m;
        while ((m = re.exec(value))) {
            let name = m[1].toLowerCase();
            let v = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3].trim();
            if (name.endsWith('*')) { // RFC 2231: charset'lang'percent-encoded
                name = name.slice(0, -1);
                const mm = /^([^']*)'[^']*'(.*)$/.exec(v);
                if (mm) {
                    try { v = decoderFor(mm[1] || 'utf-8').decode(bytesOf(unescape(mm[2]))); } catch (e) { /* keep as is */ }
                }
            }
            params[name] = v;
        }
    }
    return { value: head, params };
}

function getHeader(headers, name) {
    name = name.toLowerCase();
    const h = headers.find(x => x.name.toLowerCase() === name);
    return h ? h.value : null;
}

function decodeBase64(bin) {
    let clean = bin.replace(/[^A-Za-z0-9+/]/g, '');
    const rem = clean.length % 4;
    if (rem === 1) clean = clean.slice(0, -1); // a truncated last group: drop the lone char
    else if (rem) clean += '='.repeat(4 - rem);
    return bytesOf(atob(clean));
}

function decodeQuotedPrintable(bin) {
    const out = new Uint8Array(bin.length);
    let n = 0;
    for (let i = 0; i < bin.length; i++) {
        const c = bin.charCodeAt(i);
        if (c === 0x3d) { // '='
            if (bin[i + 1] === '\r' && bin[i + 2] === '\n') { i += 2; continue; }
            if (bin[i + 1] === '\n') { i += 1; continue; }
            const hex = bin.substr(i + 1, 2);
            if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out[n++] = parseInt(hex, 16); i += 2; continue; }
            // "=" followed by trailing whitespace, then a line break: also a soft break
            const ws = /^[ \t]+(\r?\n)/.exec(bin.substr(i + 1, 80));
            if (ws) { i += ws[0].length; continue; }
        }
        out[n++] = c & 0xff;
    }
    return out.subarray(0, n);
}

function decodeBody(bin, encoding) {
    switch (encoding) {
        case 'base64': return decodeBase64(bin);
        case 'quoted-printable': return decodeQuotedPrintable(bin);
        default: return bytesOf(bin); // 7bit, 8bit, binary, none
    }
}

// The charset a text part declares in itself: a BOM, <meta charset>, or CSS @charset
export function sniffCharset(bytes, mime) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    const head = binaryString(bytes.subarray(0, 2048));
    if (/html|xml/.test(mime)) {
        const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
        if (m) return m[1];
    }
    if (mime === 'text/css') {
        const m = /^@charset\s+"([^"]+)"/.exec(head);
        if (m) return m[1];
    }
    return null;
}

// A text part's characters: the declared charset, else its own declaration, else UTF-8 when valid, else windows-1252
export function decodePartText(part, warnings) {
    const label = part.charset || sniffCharset(part.bytes, part.type);
    if (label) {
        // A page saved as UTF-16 is still ASCII in the archive when the header says so; trust a BOM over the header
        return decoderFor(label, warnings).decode(part.bytes);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(part.bytes); } catch (e) { return new TextDecoder('windows-1252').decode(part.bytes); }
}

// Types for parts saved as application/octet-stream (IE does so for stylesheets and scripts), by extension
const TYPE_BY_EXT = {
    css: 'text/css', js: 'text/javascript', htm: 'text/html', html: 'text/html', xhtml: 'application/xhtml+xml', txt: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

function guessType(location) {
    const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(location || '');
    return m ? TYPE_BY_EXT[m[1].toLowerCase()] || null : null;
}

function stripAngles(id) {
    return id.trim().replace(/^<|>$/g, '').trim();
}

// An absolute URL for a reference, or null when it can't be made one
export function resolveUrl(ref, base) {
    try { return new URL(ref, base || undefined).href; } catch (e) { return null; }
}

function withoutFragment(url) {
    const i = url.indexOf('#');
    return i < 0 ? url : url.slice(0, i);
}

// The keys a Content-Location or a reference is looked up under
function locationKeys(url) {
    const keys = [];
    const add = k => { if (k && !keys.includes(k)) keys.push(k); };
    const u = withoutFragment(url);
    add(u);
    try { add(decodeURI(u)); } catch (e) { /* malformed escapes */ }
    if (/^file:/i.test(u)) { // Windows paths are case-insensitive, and some writers use backslashes
        for (const k of keys.slice()) add(k.toLowerCase().replace(/\\/g, '/'));
    }
    return keys;
}

/**
 * Parses an MHTML archive.
 * Returns { headers, subject, date, from, snapshotUrl, type, parts, root, warnings, lookup(ref, base) }.
 * Each part: { index, type, charset, encoding, location, url, cid, headers, bytes, encodedSize, isRoot }.
 * Throws an Error with a readable message when the data is not MHTML at all.
 */
export function parseMht(bytes) {
    const s = binaryString(bytes);
    const warnings = [];
    const parts = [];

    // Leading blank lines (and a UTF-8 BOM) before the headers
    let start = 0;
    if (s.startsWith('\xef\xbb\xbf')) start = 3;
    while (start < s.length && (s[start] === '\r' || s[start] === '\n' || s[start] === ' ' || s[start] === '\t')) start++;
    if (start >= s.length) throw new Error('The file is empty.');
    if (!looksLikeHeaders(s.slice(start, start + 200))) {
        throw new Error('This is not an MHTML archive: it does not start with MIME headers'
            + (/^\s*</.test(s.slice(start, start + 200)) ? ' (it looks like a plain HTML or XML file).' : '.'));
    }

    // One MIME entity between [from, to): its headers and the offsets of its body
    function readEntity(from, to) {
        let headerEnd = -1;
        let bodyStart = to;
        const re = /\r?\n\r?\n/g;
        re.lastIndex = from;
        // A part that starts right away with a blank line has no headers
        if (s[from] === '\n') { headerEnd = from; bodyStart = from + 1; }
        else if (s[from] === '\r' && s[from + 1] === '\n') { headerEnd = from; bodyStart = from + 2; }
        else {
            const m = re.exec(s);
            if (m && m.index < to) { headerEnd = m.index; bodyStart = m.index + m[0].length; }
            else headerEnd = to;
        }
        const raw = parseHeaderBlock(s.slice(from, headerEnd));
        const headers = raw.map(h => ({ name: h.name, raw: h.value, value: decodeEncodedWords(h.value) }));
        return { headers, bodyStart: Math.min(bodyStart, to), bodyEnd: to };
    }

    // Splits a multipart body; returns the [from, to) of each part
    function splitMultipart(from, to, boundary) {
        const delim = '--' + boundary;
        const spans = [];
        let pos = from;
        let partStart = -1;
        let closed = false;
        for (;;) {
            const i = s.indexOf(delim, pos);
            if (i < 0 || i >= to) break;
            const atLineStart = i === from || s[i - 1] === '\n';
            const after = s.slice(i + delim.length, i + delim.length + 2);
            pos = i + delim.length;
            const isClose = after === '--';
            if (!isClose && after && !/^[\s]/.test(after)) continue; // a longer boundary that merely starts the same
            // Mid-line delimiters only when the line ends there (WebKit's "binary" parts have no line break before them)
            if (!atLineStart && !isClose && !/^[\r\n]/.test(after)) continue;
            if (partStart >= 0) {
                let end = i;
                if (atLineStart && s[end - 1] === '\n') end--;
                if (atLineStart && s[end - 1] === '\r') end--;
                spans.push([partStart, Math.max(partStart, end)]);
            }
            if (isClose) { closed = true; break; }
            // The rest of the delimiter line (transport padding)
            const eol = s.indexOf('\n', pos);
            partStart = eol < 0 || eol >= to ? to : eol + 1;
        }
        if (!closed) {
            if (partStart < 0) return null;
            spans.push([partStart, to]);
            warnings.push('The archive is truncated: its closing boundary is missing, so the last part may be incomplete.');
        }
        return spans;
    }

    // Walks one entity; leaf parts are added to `parts`. `base` is the enclosing base URL.
    function walk(from, to, base, depth, outerHeaders) {
        const ent = readEntity(from, to);
        const headers = outerHeaders || ent.headers;
        const ctype = parseParams(getHeader(headers, 'Content-Type') || '');
        let type = ctype.value.toLowerCase();
        const location = getHeader(headers, 'Content-Location');
        const contentBase = getHeader(headers, 'Content-Base');
        const ownBase = contentBase ? resolveUrl(contentBase, base) || base : base;

        if (type.startsWith('multipart/') && depth < 8) {
            const boundary = ctype.params.boundary;
            if (!boundary) throw new Error(`The ${type} section has no boundary parameter, so its parts can't be found.`);
            const spans = splitMultipart(ent.bodyStart, ent.bodyEnd, boundary);
            if (!spans) throw new Error(`No parts found: the boundary "${boundary}" never appears in the file (is it truncated, or not MHTML?).`);
            // Children resolve against this multipart's Content-Base, else its Content-Location
            const childBase = contentBase ? ownBase : (location && resolveUrl(location, base)) || base;
            for (const [a, b] of spans) walk(a, b, childBase, depth + 1, null);
            return { type, params: ctype.params };
        }
        if (type === 'message/rfc822' && depth < 8) {
            const inner = readEntity(ent.bodyStart, ent.bodyEnd);
            return walk(ent.bodyStart, ent.bodyEnd, ownBase, depth + 1, inner.headers.length ? null : headers);
        }

        const encoding = (getHeader(headers, 'Content-Transfer-Encoding') || '7bit').toLowerCase().trim();
        if (!['base64', 'quoted-printable', '7bit', '8bit', 'binary', 'none', ''].includes(encoding)) {
            warnings.push(`Part ${parts.length + 1}: unknown transfer encoding "${encoding}", read as is`);
        }
        const body = s.slice(ent.bodyStart, ent.bodyEnd);
        let partBytes;
        try {
            partBytes = decodeBody(body, encoding);
        } catch (e) {
            warnings.push(`Part ${parts.length + 1}: could not decode its ${encoding} body (${e.message})`);
            partBytes = bytesOf(body);
        }
        if (!type) type = /^\s*<(!doctype|html|head|body)/i.test(body.slice(0, 200)) ? 'text/html' : 'text/plain';
        const declaredType = type;
        if (type === 'application/octet-stream' || type === 'application/x-unknown-content-type') type = guessType(location) || type;
        const cid = getHeader(headers, 'Content-ID');
        const part = {
            index: parts.length,
            type,
            declaredType,
            charset: ctype.params.charset || null,
            name: ctype.params.name || null,
            encoding: encoding || '7bit',
            location: location || null,
            url: location ? resolveUrl(location.trim(), ownBase) : null,
            relativeLocation: !!(location && !/^[a-z][a-z0-9+.-]*:/i.test(location.trim())),
            base: ownBase,
            cid: cid ? stripAngles(cid) : null,
            headers,
            bytes: partBytes,
            encodedSize: ent.bodyEnd - ent.bodyStart,
            isRoot: false,
        };
        const disp = getHeader(headers, 'Content-Disposition');
        if (disp && !part.name) part.name = parseParams(disp).params.filename || null;
        parts.push(part);
        return null;
    }

    const top = readEntity(start, s.length);
    if (!getHeader(top.headers, 'Content-Type') && !getHeader(top.headers, 'MIME-Version')) {
        throw new Error('This is not an MHTML archive: the headers have no Content-Type or MIME-Version.');
    }
    const topType = parseParams(getHeader(top.headers, 'Content-Type') || '');
    const topLocation = getHeader(top.headers, 'Content-Location');
    const snapshot = getHeader(top.headers, 'Snapshot-Content-Location');
    const topBase = resolveUrl(getHeader(top.headers, 'Content-Base') || topLocation || snapshot || '', undefined);
    walk(start, s.length, topBase, 0, null);
    if (!parts.length) throw new Error('No parts found: the archive is empty or its boundaries are malformed.');

    // The root: the start parameter (a Content-ID or a Content-Location), else the declared type, else the first HTML part
    let root = null;
    const startParam = topType.params.start;
    if (startParam) {
        const id = stripAngles(startParam);
        root = parts.find(p => p.cid === id) || parts.find(p => p.location === startParam || p.url === resolveUrl(startParam, topBase));
        if (!root) warnings.push(`The start part "${startParam}" is not in the archive`);
    }
    const declared = (topType.params.type || '').toLowerCase();
    if (!root && declared) root = parts.find(p => p.type === declared);
    if (!root) root = parts.find(p => p.type === 'text/html' || p.type === 'application/xhtml+xml');
    if (!root) root = parts[0];
    root.isRoot = true;

    // Relative locations with nothing to resolve against: relative to the root document
    for (const p of parts) {
        if (p.location && !p.url && root.url) p.url = resolveUrl(p.location.trim(), root.url);
    }

    // Lookup tables
    const byCid = new Map();
    const byLocation = new Map();
    for (const p of parts) {
        if (p.cid) {
            if (!byCid.has(p.cid)) byCid.set(p.cid, p);
            if (!byCid.has(p.cid.toLowerCase())) byCid.set(p.cid.toLowerCase(), p);
        }
        for (const loc of [p.url, p.location && p.location.trim()]) {
            if (!loc) continue;
            for (const k of locationKeys(loc)) if (!byLocation.has(k)) byLocation.set(k, p);
        }
    }

    // The part a reference in a document (or stylesheet) at `base` points to, or null
    function lookup(ref, base) {
        if (!ref) return null;
        ref = ref.trim();
        if (/^cid:/i.test(ref)) {
            let id = ref.slice(4);
            try { id = decodeURIComponent(id); } catch (e) { /* keep */ }
            id = stripAngles(id);
            return byCid.get(id) || byCid.get(id.toLowerCase()) || byLocation.get(ref) || null;
        }
        if (/^(data|blob|about|javascript|mailto):/i.test(ref)) return null;
        const candidates = [];
        const abs = resolveUrl(ref, base);
        if (abs) candidates.push(...locationKeys(abs));
        candidates.push(...locationKeys(ref));
        for (const k of candidates) {
            const p = byLocation.get(k);
            if (p) return p;
        }
        return null;
    }

    const headerValue = name => getHeader(top.headers, name);
    return {
        headers: top.headers,
        subject: headerValue('Subject'),
        date: headerValue('Date'),
        from: headerValue('From'),
        snapshotUrl: snapshot || topLocation || (root.url && /^https?:/i.test(root.url) ? root.url : null) || root.location,
        type: topType.value.toLowerCase(),
        parts,
        root,
        warnings,
        lookup,
    };
}
