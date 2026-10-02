// --- OpenPGP (GnuPG) Plugin ---
// Opens OpenPGP-encrypted files (.gpg, .pgp, and .asc holding an armored
// message): asks for the passphrase in the tab, decrypts with OpenPGP.js (from
// esm.sh, loaded when such a tab opens; it also undoes the ZIP/ZLIB/BZip2
// compression inside), and shows the contents in the viewer for the inner file
// (the name in the literal data packet, else this file's name without .gpg):
// notes.md.gpg in the editor, track.gpx.gpg on the GPX map. Above it, how the
// file was encrypted: cipher, compression, integrity protection, the inner
// name and date. Messages encrypted to a public key say which keys can open
// them and take a pasted private key instead.
// The decrypted contents stay in this tab's memory: an in-memory file the
// viewers read through the page (archive-fallback.js), never sent to the
// server or saved. Passphrases are only read from the fields, never logged or kept.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { detectEncoding, decodeBytes } = require('./text-encoding');
const { SERVED_EXTENSIONS, MAX_TEXT_SIZE } = require('./browse-mode');

const log = createLogger('GPG');
const OPENPGP_VERSION = '6.3.2';
const OPENPGP_URL = `https://esm.sh/openpgp@${OPENPGP_VERSION}`;
const GPG_RE = /\.(gpg|pgp|asc)$/i;
// Packet tags (RFC 9580)
const TAG = { PKESK: 1, SKESK: 3, SED: 9, SEIPD: 18, AEAD: 20 };
const CIPHER_NAMES = {
    aes128: 'AES-128', aes192: 'AES-192', aes256: 'AES-256', cast5: 'CAST5', tripledes: 'TripleDES', idea: 'IDEA',
    blowfish: 'Blowfish', twofish: 'Twofish', camellia128: 'Camellia-128', camellia192: 'Camellia-192', camellia256: 'Camellia-256',
};
const COMPRESSION_NAMES = { uncompressed: 'none', zip: 'ZIP (deflate)', zlib: 'ZLIB', bzip2: 'BZip2' };
const AEAD_NAMES = { eax: 'EAX', ocb: 'OCB', gcm: 'GCM', experimentalGCM: 'GCM' };
let _ctx = null;

let _openpgpPromise = null;
function loadOpenpgp() {
    if (!_openpgpPromise) _openpgpPromise = import(OPENPGP_URL).catch(err => { _openpgpPromise = null; throw err; });
    return _openpgpPromise;
}

function installStyles() {
    if (document.getElementById('gpg-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'gpg-viewer-style';
    style.textContent = `
.gpg-root{height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.gpg-toolbar{display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;white-space:nowrap;overflow:hidden;flex-shrink:0}
.gpg-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.gpg-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.gpg-toolbar select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:2px 4px;font:inherit}
.gpg-meta{display:flex;flex-wrap:wrap;gap:4px 14px;padding:5px 10px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a;flex-shrink:0}
.gpg-meta b{color:#24292f;font-weight:600}
.gpg-warn{padding:6px 10px;background:#fff8c5;border-bottom:1px solid #d4a72c;color:#6f4e00;font-size:12px;flex-shrink:0}
.gpg-body{flex:1;min-height:0;overflow:auto;position:relative}
.gpg-host{position:absolute;inset:0;overflow:hidden}
.gpg-card{max-width:440px;margin:40px auto;padding:20px 22px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa}
.gpg-card h3{margin:0 0 6px;font-size:15px}
.gpg-card p{margin:6px 0;color:#57606a;line-height:1.45}
.gpg-row{display:flex;gap:6px;margin-top:10px}
.gpg-card input[type=password]{flex:1;min-width:0;padding:6px 8px;border:1px solid #afb8c1;border-radius:5px;font:inherit}
.gpg-card textarea{width:100%;box-sizing:border-box;height:110px;margin-top:8px;padding:6px;border:1px solid #afb8c1;border-radius:5px;font:11px ui-monospace,monospace}
.gpg-card button{padding:6px 14px;border:1px solid #1a7f37;border-radius:5px;background:#1f883d;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.gpg-card button:disabled{opacity:.6;cursor:default}
.gpg-error{color:#cf222e;margin-top:8px;min-height:1em}
.gpg-keyids{font:12px ui-monospace,monospace;color:#24292f}
.gpg-card details{margin-top:12px}
.gpg-card summary{cursor:pointer;color:#0969da}
.gpg-fail{padding:20px;color:#a33}
`;
    document.head.appendChild(style);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function randomToken() {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(36) + a[1].toString(36);
}

function looksArmored(bytes) {
    return /-----BEGIN PGP MESSAGE-----/.test(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)));
}

// The inner file's name: the literal packet's, without any folders; else this file's minus .gpg/.pgp/.asc
function innerName(literalName, outerName) {
    const name = (literalName || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (name && name !== '_CONSOLE' && name !== '.' && name !== '..') return name;
    return outerName.replace(GPG_RE, '') || 'decrypted';
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

class GpgViewer {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.inner = null;      // { container, instance } of the viewer showing the contents
        this.memoryId = null;   // the in-memory file holding the contents
        installStyles();
        this.root = container.element;
        this.root.classList.add('gpg-root');
        this.root.innerHTML = `
<div class="gpg-toolbar"><span class="gpg-title"></span><select class="gpg-viewas" title="View as" hidden></select><span class="gpg-status"></span></div>
<div class="gpg-info"></div>
<div class="gpg-body"><div class="gpg-fail" style="color:#555">Loading OpenPGP.js…</div></div>`;
        this.root.querySelector('.gpg-title').textContent = (this.fileData && this.fileData.name) || '';
        this.statusEl = this.root.querySelector('.gpg-status');
        this.infoEl = this.root.querySelector('.gpg-info');
        this.body = this.root.querySelector('.gpg-body');
        this.viewAs = this.root.querySelector('.gpg-viewas');
        this.viewAs.onchange = () => this._mount(+this.viewAs.value);
        if (container.on) {
            container.on('resize', () => { if (this.inner) this.inner.container.emit('resize'); });
            container.on('show', () => { if (this.inner) this.inner.container.emit('show'); });
            container.on('destroy', () => this._destroy());
        }
        this._init();
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this.body.innerHTML = '<div class="gpg-fail"></div>';
        this.body.firstChild.textContent = message;
    }

    // The encrypted file's bytes
    async _readEncrypted() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes; // kept by browse mode (or an in-memory file)
        const path = _ctx.currentWorkspacePath && _ctx.getRelativePath(this.fileId);
        if (!path) {
            // A file dropped into an in-memory project is read as text: only an armored message survives that
            if (typeof file.content === 'string' && /-----BEGIN PGP MESSAGE-----/.test(file.content)) return new TextEncoder().encode(file.content);
            throw new Error('encrypted files need the server workspace');
        }
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    // A fresh Message each time: decrypting uses up the encrypted packet
    _readMessage() {
        const pgp = this.pgp;
        return this.armored
            ? pgp.readMessage({ armoredMessage: new TextDecoder().decode(this.encrypted), config: this.config })
            : pgp.readMessage({ binaryMessage: this.encrypted, config: this.config });
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const [pgp, bytes] = await Promise.all([loadOpenpgp(), this._readEncrypted()]);
            this.pgp = pgp;
            this.encrypted = bytes;
            this.armored = looksArmored(bytes);
            // Old messages without integrity protection are opened too, with a warning
            this.config = { ...pgp.config, allowUnauthenticatedMessages: true, enableParsingV5Entities: true };
            const message = await this._readMessage();
            const tags = message.packets.map(p => p.constructor.tag);
            this.skesk = message.packets.filter(p => p.constructor.tag === TAG.SKESK);
            this.recipients = message.getEncryptionKeyIDs().map(k => k.isWildcard() ? 'anonymous recipient' : '0x' + k.toHex().toUpperCase());
            if (!tags.some(t => t === TAG.SED || t === TAG.SEIPD || t === TAG.AEAD)) {
                return this._fail('This is OpenPGP data, but not an encrypted message (a key or a signature?).');
            }
        } catch (err) {
            log.error('Load failed:', err.message);
            return this._fail('Could not read the encrypted file: ' + err.message);
        }
        this._status(this.armored ? 'ASCII-armored · read-only' : 'read-only');
        this._showPrompt();
    }

    _showPrompt() {
        const card = el('div', 'gpg-card');
        const name = this.fileData.name;
        const busyEls = [];
        const run = async (button, errorEl, fn) => {
            busyEls.forEach(e => { e.disabled = true; });
            const label = button.textContent;
            button.textContent = 'Decrypting…';
            errorEl.textContent = '';
            try {
                await fn();
            } catch (err) {
                errorEl.textContent = err.message;
                busyEls.forEach(e => { e.disabled = false; });
                button.textContent = label;
                return false;
            }
            return true;
        };

        if (this.skesk.length) {
            const s2k = this.skesk[0];
            let cipher = s2k.sessionKeyAlgorithm;
            if (typeof cipher === 'number') { try { cipher = this.pgp.enums.read(this.pgp.enums.symmetric, cipher); } catch (err) { cipher = null; } }
            cipher = cipher ? (CIPHER_NAMES[cipher] || String(cipher).toUpperCase()) : null;
            card.appendChild(el('h3', null, '🔒 Passphrase required'));
            card.appendChild(el('p', null, `${name} is encrypted with a passphrase${cipher ? ` (${cipher})` : ''}.`));
            const row = el('div', 'gpg-row');
            const input = el('input');
            input.type = 'password';
            input.placeholder = 'Passphrase';
            input.autocomplete = 'off';
            input.spellcheck = false;
            const button = el('button', null, 'Decrypt');
            button.type = 'button';
            row.append(input, button);
            const error = el('div', 'gpg-error');
            card.append(row, error);
            busyEls.push(input, button);
            const submit = async () => {
                if (button.disabled) return;
                if (!input.value) { error.textContent = 'Enter the passphrase.'; input.focus(); return; }
                const ok = await run(button, error, () => this._decrypt({ passwords: [input.value] }));
                if (!ok) { input.focus(); input.select(); }
            };
            button.onclick = submit;
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
            requestAnimationFrame(() => input.focus());
        }

        if (this.recipients.length) {
            const box = this.skesk.length ? el('details') : card;
            if (this.skesk.length) {
                box.appendChild(el('summary', null, 'Or decrypt with a private key'));
                card.appendChild(box);
            } else {
                card.appendChild(el('h3', null, '🔑 Encrypted to a public key'));
                card.appendChild(el('p', null, `${name} was encrypted to a public key, so a passphrase alone can't open it. It needs the private key for one of:`));
            }
            const ids = el('p', 'gpg-keyids', this.recipients.join(', '));
            box.appendChild(ids);
            const inner = this.skesk.length ? box : el('details');
            if (!this.skesk.length) {
                inner.appendChild(el('summary', null, 'Decrypt with a pasted private key'));
                card.appendChild(inner);
            }
            const keyText = el('textarea');
            keyText.placeholder = '-----BEGIN PGP PRIVATE KEY BLOCK-----';
            keyText.spellcheck = false;
            const row = el('div', 'gpg-row');
            const keyPass = el('input');
            keyPass.type = 'password';
            keyPass.placeholder = 'Key passphrase (if any)';
            keyPass.autocomplete = 'off';
            const button = el('button', null, 'Decrypt');
            button.type = 'button';
            row.append(keyPass, button);
            const error = el('div', 'gpg-error');
            inner.append(keyText, row, error);
            busyEls.push(keyText, keyPass, button);
            const submit = async () => {
                if (button.disabled) return;
                if (!keyText.value.trim()) { error.textContent = 'Paste an armored private key.'; return; }
                const ok = await run(button, error, async () => {
                    let key;
                    try {
                        key = await this.pgp.readPrivateKey({ armoredKey: keyText.value });
                    } catch (err) {
                        throw new Error('Not a private key: ' + err.message);
                    }
                    if (!key.isDecrypted()) {
                        try {
                            key = await this.pgp.decryptKey({ privateKey: key, passphrase: keyPass.value });
                        } catch (err) {
                            throw new Error('Wrong key passphrase.');
                        }
                    }
                    await this._decrypt({ decryptionKeys: [key] });
                });
                if (!ok) { keyPass.focus(); keyPass.select(); }
            };
            button.onclick = submit;
            keyPass.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        }

        this.body.textContent = '';
        this.body.appendChild(card);
    }

    async _decrypt({ passwords, decryptionKeys }) {
        const pgp = this.pgp;
        const enums = pgp.enums;
        let sessionKeys;
        try {
            sessionKeys = await (await this._readMessage()).decryptSessionKeys(decryptionKeys, passwords, undefined, this.config);
        } catch (err) {
            throw new Error(decryptionKeys ? 'This key can’t decrypt the message.' : 'Wrong passphrase.');
        }
        let result = null;
        for (const sessionKey of sessionKeys) {
            const message = await this._readMessage();
            const enc = message.packets.find(p => [TAG.SED, TAG.SEIPD, TAG.AEAD].includes(p.constructor.tag));
            const encInfo = { tag: enc.constructor.tag, version: enc.version, cipherAlgorithm: enc.cipherAlgorithm, aeadAlgorithm: enc.aeadAlgorithm };
            try {
                result = { decrypted: await message.decrypt(undefined, undefined, [sessionKey], undefined, this.config), sessionKey, encInfo };
                break;
            } catch (err) {
                // A wrong passphrase shows up as a failed integrity check or garbage packets
            }
        }
        if (!result) throw new Error(decryptionKeys ? 'This key can’t decrypt the message.' : 'Wrong passphrase (or the file is damaged).');

        const { decrypted, sessionKey, encInfo } = result;
        const compressed = decrypted.packets.findPacket(enums.packet.compressedData);
        const plain = decrypted.unwrapCompressed();
        const literal = plain.packets.findPacket(enums.packet.literalData);
        if (!literal) throw new Error('The decrypted message holds no data.');
        const data = plain.getLiteralData();
        if (!(data instanceof Uint8Array)) throw new Error('Unexpected streamed data.');

        const read = (type, value) => { try { return enums.read(type, value); } catch (err) { return String(value); } };
        const cipherKey = encInfo.cipherAlgorithm != null ? read(enums.symmetric, encInfo.cipherAlgorithm) : sessionKey.algorithm;
        const aead = encInfo.aeadAlgorithm != null ? read(enums.aead, encInfo.aeadAlgorithm) : null;
        const aeadName = aead && (AEAD_NAMES[aead] || aead.toUpperCase());
        const compression = compressed ? read(enums.compression, compressed.algorithm) : 'uncompressed';
        let integrity;
        if (encInfo.tag === TAG.SED) integrity = null;
        else if (encInfo.tag === TAG.AEAD) integrity = `AEAD ${aeadName} (GnuPG v5 packet)`;
        else if (encInfo.version === 2) integrity = `AEAD ${aeadName} (SEIPD v2)`;
        else integrity = 'MDC (SEIPD v1)';
        this.meta = {
            cipher: CIPHER_NAMES[cipherKey] || String(cipherKey || '?').toUpperCase(),
            compression: COMPRESSION_NAMES[compression] || compression,
            integrity,
            filename: literal.filename || '',
            date: literal.date && literal.date.getTime() ? literal.date : null,
            format: literal.format != null ? read(enums.literal, literal.format) : null,
            method: decryptionKeys ? 'private key' : 'passphrase',
            signers: plain.getSigningKeyIDs().map(k => '0x' + k.toHex().toUpperCase()),
            size: data.length,
        };
        await this._showContents(data);
        log.log(`Decrypted ${this.fileData.name} (${data.length} bytes, in memory)`);
    }

    async _showContents(bytes) {
        const name = innerName(this.meta.filename, this.fileData.name);
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        // Like a workspace file of that name: a served type, text, or binary
        const file = { name, type: 'file', content: '', bytes, cursor: { row: 0, column: 0 }, selection: null };
        const detected = await detectEncoding(bytes);
        if (!detected.binary && bytes.length <= MAX_TEXT_SIZE) {
            file.encoding = file.detectedEncoding = detected.encoding;
            file.content = decodeBytes(bytes, detected.encoding);
        }
        if (SERVED_EXTENSIONS.has(ext)) file.viewType = ext;
        else if (detected.binary || bytes.length > MAX_TEXT_SIZE) file.viewType = 'binary';
        this.isBinary = !!detected.binary;

        const ownPath = _ctx.getRelativePath(this.fileId) || this.fileData.name;
        const dir = ownPath.includes('/') ? ownPath.slice(0, ownPath.lastIndexOf('/') + 1) : '';
        this.memoryId = _ctx.addMemoryFile(file, `${dir}.in-memory-${randomToken()}/${name}`, bytes);

        this.viewers = _ctx.viewersForFile(this.memoryId).filter(v => _ctx.getComponent && _ctx.getComponent(v.componentType));
        this.viewAs.textContent = '';
        this.viewers.forEach((v, i) => {
            const label = v.componentType === 'editor'
                ? (file.viewType === 'binary' ? 'Hex' : file.viewType ? 'View' : 'Text')
                : (v.title.match(/\[(.+)\]$/) || [, v.componentType])[1];
            const o = el('option', null, label);
            o.value = String(i);
            this.viewAs.appendChild(o);
        });
        this.viewAs.hidden = this.viewers.length < 2;
        this._renderMeta(name);
        this._status(`${name} · ${fmtSize(bytes.length)} · in memory, read-only`);
        this.body.textContent = '';
        this._mount(0);
    }

    _renderMeta(name) {
        const m = this.meta;
        const items = [
            ['Cipher', m.cipher],
            ['Compression', m.compression],
            ['Integrity', m.integrity || 'none'],
            ['Inner file', m.filename ? m.filename + (m.filename !== name ? ` (shown as ${name})` : '') : `(no name; shown as ${name})`],
            ['Date', m.date ? m.date.toLocaleString() : '—'],
            ['Format', m.format || '?'],
            ['Opened with', m.method],
        ];
        if (m.signers.length) items.push(['Signed by', m.signers.join(', ') + ' (not verified)']);
        if (this.isBinary) items.push(['Data', `binary, ${fmtSize(m.size)}`]);
        this.infoEl.textContent = '';
        const meta = el('div', 'gpg-meta');
        for (const [k, v] of items) {
            const span = el('span', null, k + ': ');
            span.appendChild(el('b', null, v));
            meta.appendChild(span);
        }
        this.infoEl.appendChild(meta);
        if (!m.integrity) {
            this.infoEl.appendChild(el('div', 'gpg-warn', '⚠ This message is not integrity-protected (no MDC or AEAD): '
                + 'the contents could have been altered without it being noticed.'));
        }
    }

    // Show the contents with viewer i (one of this.viewers), in a container of its own inside this tab
    _mount(i) {
        this._unmountInner();
        const v = this.viewers[i];
        if (!v) return this._fail('No viewer for the decrypted contents.');
        const host = el('div', 'gpg-host');
        this.body.textContent = '';
        this.body.appendChild(host);
        const listeners = {};
        const container = {
            element: host,
            on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); },
            emit(event, ...args) { (listeners[event] || []).forEach(cb => cb(...args)); },
            getState() { return v.state; },
            setState() {},
            setTitle() {},
        };
        try {
            const Comp = _ctx.getComponent(v.componentType);
            const instance = new Comp(container, v.state);
            container.componentReference = instance;
            // Read-only: nothing to save the decrypted text to
            if (instance && instance.editor && instance.editor.setReadOnly) instance.editor.setReadOnly(true);
            this.inner = { container, instance };
        } catch (err) {
            log.error('Viewer failed:', err.message);
            return this._fail('Could not show the contents: ' + err.message);
        }
        requestAnimationFrame(() => { if (this.inner) { container.emit('show'); container.emit('resize'); } });
    }

    _unmountInner() {
        if (!this.inner) return;
        try { this.inner.container.emit('destroy'); } catch (err) { log.warn('Viewer destroy failed:', err.message); }
        this.inner = null;
    }

    _destroy() {
        this._unmountInner();
        if (this.memoryId) _ctx.removeMemoryFile(this.memoryId);
        this.memoryId = null;
        this.encrypted = null;
        this.meta = null;
    }
}

registerPlugin({
    id: 'gpg',
    name: 'OpenPGP encrypted files',
    components: {
        gpgViewer: GpgViewer,
    },
    contextMenuItems: [{
        label: 'Decrypt (OpenPGP)',
        canHandle: (fileName) => GPG_RE.test(fileName || ''),
        action: (fileId) => {
            const file = _ctx && _ctx.projectFiles[fileId];
            if (file) _ctx.openEditorTab('gpgViewer', { fileId }, `${file.name} [decrypt]`, 'gpg-' + fileId);
        },
    }],
    init(ctx) {
        _ctx = ctx;
    },
});
