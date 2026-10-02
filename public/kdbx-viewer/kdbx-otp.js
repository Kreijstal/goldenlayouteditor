// One-time passwords stored in KeePass entries, computed with WebCrypto HMAC
// (RFC 4226 / RFC 6238). Reads the ways they are kept:
//  - KeePassXC: an "otp" field holding an otpauth:// URI (Steam via encoder=steam),
//    or the older "TOTP Seed" + "TOTP Settings" ("30;6", "30;S" for Steam);
//  - KeePass 2.47+: TimeOtp-Secret(-Hex/-Base32/-Base64), TimeOtp-Length,
//    TimeOtp-Period, TimeOtp-Algorithm; HmacOtp-Secret* + HmacOtp-Counter for HOTP.

const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';
const ALGOS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export function base32Decode(s) {
    const clean = s.toUpperCase().replace(/[\s=-]/g, '');
    const out = [];
    let bits = 0, value = 0;
    for (const ch of clean) {
        const v = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
        if (v < 0) throw new Error('invalid Base32 secret');
        value = (value << 5) | v;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

function normAlgo(a) {
    const k = String(a || 'SHA1').toUpperCase().replace(/^HMAC-?/, '').replace(/-/g, '');
    if (!ALGOS[k]) throw new Error('unsupported OTP algorithm ' + a);
    return k;
}

function secretFrom(get, prefix) {
    let v;
    if ((v = get(prefix + 'Secret'))) return new TextEncoder().encode(v);
    if ((v = get(prefix + 'Secret-Hex'))) return Uint8Array.from(v.replace(/\s+/g, '').match(/../g) || [], h => parseInt(h, 16));
    if ((v = get(prefix + 'Secret-Base32'))) return base32Decode(v);
    if ((v = get(prefix + 'Secret-Base64'))) return Uint8Array.from(atob(v.replace(/\s+/g, '')), c => c.charCodeAt(0));
    return null;
}

// The OTP settings of an entry, or null. get(name) returns a field's text.
export function parseOtp(get) {
    const uri = get('otp');
    if (uri && /^otpauth:\/\//i.test(uri.trim())) {
        const u = new URL(uri.trim());
        const type = u.host.toLowerCase();
        const q = u.searchParams;
        const secret = q.get('secret');
        if (!secret) throw new Error('otpauth URI without a secret');
        const steam = (q.get('encoder') || '').toLowerCase() === 'steam' || /^steam/i.test(q.get('issuer') || '');
        const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
        return {
            type: type === 'hotp' ? 'hotp' : 'totp', key: base32Decode(secret), algorithm: normAlgo(q.get('algorithm')),
            digits: steam ? 5 : +(q.get('digits') || 6), period: +(q.get('period') || 30), counter: +(q.get('counter') || 0),
            steam, label, issuer: q.get('issuer') || '', source: 'otp field',
        };
    }
    const seed = get('TOTP Seed');
    if (seed) {
        const [period, digits] = (get('TOTP Settings') || '30;6').split(';');
        const steam = digits === 'S';
        return { type: 'totp', key: base32Decode(seed), algorithm: 'SHA1', digits: steam ? 5 : +digits || 6, period: +period || 30, steam, label: '', issuer: '', source: 'TOTP Seed field' };
    }
    const tKey = secretFrom(get, 'TimeOtp-');
    if (tKey) {
        return {
            type: 'totp', key: tKey, algorithm: normAlgo(get('TimeOtp-Algorithm')), digits: +(get('TimeOtp-Length') || 6),
            period: +(get('TimeOtp-Period') || 30), steam: false, label: '', issuer: '', source: 'TimeOtp fields',
        };
    }
    const hKey = secretFrom(get, 'HmacOtp-');
    if (hKey) {
        return { type: 'hotp', key: hKey, algorithm: 'SHA1', digits: 6, counter: +(get('HmacOtp-Counter') || 0), steam: false, label: '', issuer: '', source: 'HmacOtp fields' };
    }
    return null;
}

export async function hotp(key, counter, digits, algorithm, steam) {
    const msg = new Uint8Array(8);
    let c = BigInt(counter);
    for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 255n); c >>= 8n; }
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: ALGOS[algorithm] }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
    const off = mac[mac.length - 1] & 15;
    let bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
    if (steam) {
        let s = '';
        for (let i = 0; i < 5; i++) { s += STEAM_CHARS[bin % STEAM_CHARS.length]; bin = Math.floor(bin / STEAM_CHARS.length); }
        return s;
    }
    return String(bin % 10 ** digits).padStart(digits, '0');
}

// { code, remaining (seconds), period } for a TOTP at time now (ms); HOTP at its stored counter
export async function otpCode(otp, now = Date.now()) {
    if (otp.type === 'hotp') return { code: await hotp(otp.key, otp.counter, otp.digits, otp.algorithm, otp.steam), counter: otp.counter };
    const t = Math.floor(now / 1000);
    return {
        code: await hotp(otp.key, Math.floor(t / otp.period), otp.digits, otp.algorithm, otp.steam),
        remaining: otp.period - (t % otp.period), period: otp.period,
    };
}
