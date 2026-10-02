// The unencrypted outer header of a KeePass file, read before any key is
// asked for: which format (KeePass 1.x .kdb, KDBX 2/3/4), the cipher, the key
// derivation and its parameters, compression. The viewer shows it above the
// password prompt and refuses the formats kdbxweb can't open with a reason.

const SIG1 = 0x9AA2D903;
const SIG2_KDB = 0xB54BFB65;   // KeePass 1.x
const SIG2_PRE = 0xB54BFB66;   // KeePass 2.x pre-release
const SIG2_KDBX = 0xB54BFB67;

// UUIDs as hex
const CIPHERS = {
    '31c1f2e6bf714350be5805216afc5aff': { name: 'AES-256', supported: true },
    'd6038a2b8b6f4cb5a524339a31dbb59a': { name: 'ChaCha20', supported: true },
    'ad68f29f576f4bb9a36ad47af965346c': { name: 'Twofish', supported: false },
    '61ab05a1946441c38d291eaa1cb6c58b': { name: 'AES-128', supported: false },
};
const KDFS = {
    'c9d9f39a628a4460bf740d08c18a4fea': 'AES-KDF',
    '7c02bb8279a74ac0927d114a00648238': 'AES-KDF',
    'ef636ddf8c29444b91f7a9a403e30a0c': 'Argon2d',
    '9e298b1956db4773b23dfc3ec6f0a1e6': 'Argon2id',
};

const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

// KDBX 4 VarDictionary: version, then (type, key, value) until type 0
function readVarDict(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = {};
    let p = 2;
    while (p < bytes.length) {
        const type = bytes[p++];
        if (!type) break;
        const klen = dv.getInt32(p, true); p += 4;
        const key = new TextDecoder().decode(bytes.subarray(p, p + klen)); p += klen;
        const vlen = dv.getInt32(p, true); p += 4;
        const v = bytes.subarray(p, p + vlen); p += vlen;
        const vdv = new DataView(v.buffer, v.byteOffset, v.byteLength);
        switch (type) {
            case 0x04: out[key] = vdv.getUint32(0, true); break;
            case 0x05: out[key] = Number(vdv.getBigUint64(0, true)); break;
            case 0x08: out[key] = !!v[0]; break;
            case 0x0C: out[key] = vdv.getInt32(0, true); break;
            case 0x0D: out[key] = Number(vdv.getBigInt64(0, true)); break;
            case 0x18: out[key] = new TextDecoder().decode(v); break;
            default: out[key] = v.slice();
        }
    }
    return out;
}

function fmtBytes(n) {
    if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return (n / 1024 / 1024) + ' MiB';
    if (n >= 1024 && n % 1024 === 0) return (n / 1024) + ' KiB';
    return n + ' B';
}

// { kind: 'kdbx'|'kdb'|'unknown', version, major, minor, cipher, cipherSupported,
//   kdf, kdfParams: {...}, kdfText, compression, unsupported (a reason, or null) }
export function readKdbxHeader(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 12) return { kind: 'unknown', unsupported: 'The file is too short to be a KeePass database.' };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sig1 = dv.getUint32(0, true), sig2 = dv.getUint32(4, true);
    if (sig1 !== SIG1) return { kind: 'unknown', unsupported: 'Not a KeePass database (no KeePass signature at the start of the file).' };
    if (sig2 === SIG2_KDB) {
        const flags = dv.getUint32(8, true);
        const cipher = flags & 8 ? 'Twofish' : flags & 2 ? 'AES-256' : flags & 4 ? 'ARC4' : '?';
        const rounds = bytes.length >= 124 ? dv.getUint32(120, true) : null;
        return {
            kind: 'kdb', version: 'KeePass 1.x (.kdb)', cipher, kdf: 'AES-KDF', kdfText: rounds != null ? `AES-KDF, ${rounds.toLocaleString('en')} rounds` : 'AES-KDF',
            unsupported: 'This is a KeePass 1.x database (.kdb). Only KDBX 3.1 and 4.x files can be opened here; '
                + 'KeePassXC or KeePass 2 can import it and save it as .kdbx.',
        };
    }
    if (sig2 !== SIG2_KDBX && sig2 !== SIG2_PRE) return { kind: 'unknown', unsupported: 'Unknown KeePass file type (signature 0x' + sig2.toString(16) + ').' };
    const minor = dv.getUint16(8, true), major = dv.getUint16(10, true);
    const info = { kind: 'kdbx', major, minor, version: `KDBX ${major}.${minor}`, unsupported: null, kdfParams: {} };
    if (sig2 === SIG2_PRE || major < 3) {
        info.unsupported = `This is a ${info.version} database from an old KeePass 2 version. Only KDBX 3.1 and 4.x can be opened here; `
            + 'opening and saving it once in KeePass 2 or KeePassXC upgrades it.';
    } else if (major > 4) {
        info.unsupported = `${info.version} is newer than this viewer understands (KDBX 3.1 and 4.x).`;
    }
    // Header fields: id (1 byte), length (2 bytes in KDBX 3, 4 in KDBX 4), data
    let p = 12;
    const wide = major >= 4;
    try {
        while (p < bytes.length) {
            const id = bytes[p];
            const len = wide ? dv.getUint32(p + 1, true) : dv.getUint16(p + 1, true);
            p += wide ? 5 : 3;
            if (p + len > bytes.length) throw new Error('truncated header');
            const data = bytes.subarray(p, p + len);
            p += len;
            if (id === 0) { info.headerEnd = p; break; }
            if (id === 2) info.cipherUuid = hex(data);
            else if (id === 3 && len >= 4) info.compression = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) ? 'GZip' : 'none';
            else if (id === 6 && len >= 8) info.kdfParams.R = Number(new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true));
            else if (id === 11) info.kdfParams = readVarDict(data);
            else if (id === 12) info.publicCustomData = readVarDict(data);
        }
    } catch (err) {
        info.corrupt = 'The header is damaged or the file is truncated.';
    }
    if (info.headerEnd == null && !info.corrupt) info.corrupt = 'The header is damaged or the file is truncated.';
    const c = info.cipherUuid && CIPHERS[info.cipherUuid];
    info.cipher = c ? c.name : info.cipherUuid ? 'unknown cipher ' + info.cipherUuid : '?';
    info.cipherSupported = !!(c && c.supported);
    if (!info.unsupported && info.cipherUuid && !info.cipherSupported) {
        info.unsupported = `The database is encrypted with ${info.cipher}, which this viewer can't decrypt (AES-256 and ChaCha20 only).`;
    }
    const kp = info.kdfParams;
    if (major >= 4) {
        const uuid = kp.$UUID instanceof Uint8Array ? hex(kp.$UUID) : '';
        info.kdf = KDFS[uuid] || (uuid ? 'unknown KDF ' + uuid : '?');
    } else {
        info.kdf = 'AES-KDF';
    }
    if (info.kdf === 'AES-KDF') {
        info.kdfText = kp.R != null ? `AES-KDF, ${kp.R.toLocaleString('en')} rounds` : 'AES-KDF';
    } else if (/^Argon2/.test(info.kdf)) {
        const parts = [];
        if (kp.M != null) parts.push(fmtBytes(kp.M));
        if (kp.I != null) parts.push(`${kp.I} iteration${kp.I === 1 ? '' : 's'}`);
        if (kp.P != null) parts.push(`${kp.P} lane${kp.P === 1 ? '' : 's'}`);
        if (kp.V != null) parts.push('v' + (kp.V === 0x13 ? '1.3' : kp.V === 0x10 ? '1.0' : '0x' + kp.V.toString(16)));
        info.kdfText = `${info.kdf}, ${parts.join(', ')}`;
        if (!info.unsupported && kp.V != null && kp.V !== 0x13) info.unsupported = `Argon2 version ${kp.V === 0x10 ? '1.0' : kp.V} isn't supported (only 1.3).`;
        if (!info.unsupported && (kp.K || kp.A)) info.unsupported = 'Argon2 with a secret key or associated data isn\'t supported.';
    } else {
        info.kdfText = info.kdf;
        if (!info.unsupported && major >= 4) info.unsupported = `The key derivation (${info.kdf}) isn't supported.`;
    }
    return info;
}
