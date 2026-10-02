// --- Text encodings for the file browser's text viewer ---
// Decoding uses the browser's TextDecoder (WHATWG encodings, no library).
// Guessing a legacy encoding uses jschardet, loaded from cdnjs only when a
// file is neither UTF-8 nor marked by a byte-order mark.

const JSCHARDET_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jschardet/3.1.4/jschardet.min.js';

// [label, description]; filtered to what this browser's TextDecoder supports
const ENCODINGS = [
    ['utf-8', 'Unicode (UTF-8)'],
    ['utf-16le', 'Unicode (UTF-16 LE)'],
    ['utf-16be', 'Unicode (UTF-16 BE)'],
    ['windows-1252', 'Western (Windows-1252 / Latin-1)'],
    ['iso-8859-15', 'Western (ISO-8859-15)'],
    ['macintosh', 'Western (Mac Roman)'],
    ['windows-1250', 'Central European (Windows-1250)'],
    ['iso-8859-2', 'Central European (ISO-8859-2)'],
    ['windows-1251', 'Cyrillic (Windows-1251)'],
    ['koi8-r', 'Cyrillic (KOI8-R)'],
    ['koi8-u', 'Cyrillic (KOI8-U)'],
    ['ibm866', 'Cyrillic (DOS 866)'],
    ['iso-8859-5', 'Cyrillic (ISO-8859-5)'],
    ['x-mac-cyrillic', 'Cyrillic (Mac)'],
    ['windows-1253', 'Greek (Windows-1253)'],
    ['iso-8859-7', 'Greek (ISO-8859-7)'],
    ['windows-1254', 'Turkish (Windows-1254)'],
    ['windows-1257', 'Baltic (Windows-1257)'],
    ['iso-8859-4', 'Baltic (ISO-8859-4)'],
    ['iso-8859-13', 'Baltic (ISO-8859-13)'],
    ['windows-1255', 'Hebrew (Windows-1255)'],
    ['iso-8859-8', 'Hebrew (ISO-8859-8)'],
    ['windows-1256', 'Arabic (Windows-1256)'],
    ['iso-8859-6', 'Arabic (ISO-8859-6)'],
    ['windows-874', 'Thai (Windows-874)'],
    ['windows-1258', 'Vietnamese (Windows-1258)'],
    ['shift_jis', 'Japanese (Shift_JIS)'],
    ['euc-jp', 'Japanese (EUC-JP)'],
    ['iso-2022-jp', 'Japanese (ISO-2022-JP)'],
    ['gb18030', 'Chinese Simplified (GB18030)'],
    ['gbk', 'Chinese Simplified (GBK)'],
    ['big5', 'Chinese Traditional (Big5)'],
    ['euc-kr', 'Korean (EUC-KR)'],
].filter(([label]) => {
    try { new TextDecoder(label); return true; } catch (_) { return false; }
});

// jschardet names that TextDecoder doesn't take as labels
const CHARDET_ALIASES = { ascii: 'utf-8', maccyrillic: 'x-mac-cyrillic', 'tis-620': 'windows-874', 'iso-8859-1': 'windows-1252' };

// Single-byte encodings jschardet confuses; its guess is re-checked against all of
// them. Ties go to the guess's family, most common code page first.
const FAMILIES = [
    ['windows-1252', 'iso-8859-15', 'windows-1250', 'iso-8859-2', 'macintosh', 'windows-1257', 'iso-8859-4', 'iso-8859-13', 'windows-1254'],
    ['windows-1251', 'koi8-r', 'koi8-u', 'ibm866', 'iso-8859-5', 'x-mac-cyrillic'],
    ['windows-1253', 'iso-8859-7'],
    ['windows-1255', 'iso-8859-8'],
    ['windows-1256', 'iso-8859-6'],
];

// Lower is more plausible. Penalises: symbols, controls and replacement chars
// outside ASCII; capitals inside lowercase words ("ещЄ", "ьЯ"); words mixing Latin
// with another script ("Pшнliє", "Grφίe"); and words that are mostly accented
// Latin, which is how Cyrillic or Greek look in a Latin code page ("Ïðèâåò").
function implausibility(text) {
    let score = 0;
    const sample = text.slice(0, 20000);
    for (const ch of sample) {
        const code = ch.codePointAt(0);
        if (code < 0x80) continue;
        if (ch === '\ufffd' || (code >= 0x80 && code < 0xa0)) score += 5;
        else if (!/\p{L}/u.test(ch)) score += 2;
    }
    const midCaps = sample.match(/\p{Ll}\p{Lu}/gu);
    if (midCaps) score += midCaps.length * 3;
    for (const word of sample.match(/\p{L}+/gu) || []) {
        const ascii = /[A-Za-z]/.test(word);
        if (ascii && /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Arabic}]/u.test(word)) score += 4;
        if (word.length >= 3) {
            const accented = (word.match(/[\u00c0-\u024f]/g) || []).length;
            if (accented * 2 > word.length) score += 1;
        }
    }
    return score;
}

function mostPlausible(bytes, guess) {
    const family = FAMILIES.find(f => f.includes(guess));
    if (!family) return guess; // multi-byte (Shift_JIS, GBK...): trust jschardet
    const order = [...new Set([...family, ...FAMILIES.flat()])];
    let best = guess, bestScore = Infinity;
    for (const label of order) {
        let text;
        try { text = decodeBytes(bytes.subarray(0, 65536), label); } catch (_) { continue; }
        const score = implausibility(text);
        if (score < bestScore) { best = label; bestScore = score; }
    }
    return best;
}

let _chardetPromise = null;
function loadChardet() {
    if (window.jschardet) return Promise.resolve(window.jschardet);
    if (!_chardetPromise) {
        _chardetPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = JSCHARDET_URL;
            script.onload = () => resolve(window.jschardet);
            script.onerror = () => { _chardetPromise = null; reject(new Error('Could not load jschardet')); };
            document.head.appendChild(script);
        });
    }
    return _chardetPromise;
}

function decodeBytes(bytes, encoding) {
    // TextDecoder strips a matching BOM itself
    return new TextDecoder(encoding).decode(bytes);
}

function isUtf8(bytes) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch (_) { return false; }
}

// UTF-16 without a BOM: ASCII-heavy text has NULs in every other byte
function guessUtf16(bytes) {
    const n = Math.min(bytes.length & ~1, 4096);
    if (n < 4) return null;
    let evenZero = 0, oddZero = 0;
    for (let i = 0; i < n; i += 2) {
        if (bytes[i] === 0) evenZero++;
        if (bytes[i + 1] === 0) oddZero++;
    }
    const half = n / 2;
    if (oddZero > half * 0.3 && evenZero < half * 0.05) return 'utf-16le';
    if (evenZero > half * 0.3 && oddZero < half * 0.05) return 'utf-16be';
    return null;
}

/**
 * Work out how to show bytes as text.
 * @returns {Promise<{ encoding: string|null, binary: boolean, confidence?: number }>}
 */
async function detectEncoding(bytes) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', binary: false };
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', binary: false };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', binary: false };
    const utf16 = guessUtf16(bytes);
    if (utf16) return { encoding: utf16, binary: false };
    if (bytes.subarray(0, 65536).includes(0)) return { encoding: null, binary: true };
    if (isUtf8(bytes)) return { encoding: 'utf-8', binary: false };
    try {
        const chardet = await loadChardet();
        const sample = bytes.subarray(0, 65536);
        let str = '';
        for (let i = 0; i < sample.length; i += 8192) str += String.fromCharCode.apply(null, sample.subarray(i, i + 8192));
        const guess = chardet.detect(str);
        let label = guess && guess.encoding ? guess.encoding.toLowerCase() : '';
        label = CHARDET_ALIASES[label] || label;
        if (label) {
            new TextDecoder(label); // throws if unsupported
            return { encoding: mostPlausible(bytes, label), binary: false, confidence: guess.confidence };
        }
    } catch (_) { /* fall back below */ }
    return { encoding: 'windows-1252', binary: false };
}

module.exports = { ENCODINGS, decodeBytes, detectEncoding };
