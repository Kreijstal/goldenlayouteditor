const { element, table } = require('./viewer-file');
const ENCRYPTED_TAGS = [1, 3, 9, 18, 20];

async function inspectPgp(pgp, bytes) {
    const text = new TextDecoder().decode(bytes).replace(/^\uFEFF?\s*/, '');
    if (/^-----BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK-----/.test(text)) {
        return { kind: 'certificate', keys: await pgp.readKeys({ armoredKeys: text }) };
    }
    if (/^-----BEGIN PGP SIGNATURE-----/.test(text)) return { kind: 'detached signature', signature: await pgp.readSignature({ armoredSignature: text }) };
    if (/^-----BEGIN PGP SIGNED MESSAGE-----/.test(text)) return { kind: 'cleartext signed message', message: await pgp.readCleartextMessage({ cleartextMessage: text }) };
    try {
        const message = await pgp.readMessage({
            ...(/^-----BEGIN PGP MESSAGE-----/.test(text) ? { armoredMessage: text } : { binaryMessage: bytes }),
            config: { enableParsingV5Entities: true },
        });
        if (message.packets.some(p => ENCRYPTED_TAGS.includes(p.constructor.tag))) return { kind: 'encrypted message', message };
        // ReadMessage expands compressed packets through the Message accessors.
        if (message.getLiteralData() != null) return { kind: 'signed / literal container', message };
    } catch (_) { /* Binary keys and detached signatures are not messages. */ }
    try { return { kind: 'detached signature', signature: await pgp.readSignature({ binarySignature: bytes }) }; } catch (_) { /* Try a certificate next. */ }
    try { return { kind: 'certificate', keys: await pgp.readKeys({ binaryKeys: bytes }) }; } catch (_) { throw new Error('Not a supported OpenPGP message, signature or certificate.'); }
}

async function verifyPgp(pgp, inspection, armoredKeys, detachedBytes) {
    const keys = await pgp.readKeys({ armoredKeys });
    if (!keys.length) throw new Error('No verification keys found.');
    const options = { verificationKeys: keys, expectSigned: true, format: inspection.kind === 'cleartext signed message' ? 'utf8' : 'binary' };
    if (inspection.signature) {
        if (!detachedBytes) throw new Error('Choose the original signed file for this detached signature.');
        options.message = await pgp.createMessage({ binary: detachedBytes });
        options.signature = inspection.signature;
    } else options.message = inspection.message;
    const result = await pgp.verify(options);
    return Promise.all(result.signatures.map(async s => {
        try { await s.verified; return { keyID: s.keyID.toHex(), verified: true }; }
        catch (err) { return { keyID: s.keyID.toHex(), verified: false, error: err.message }; }
    }));
}

async function mountPgpInspection(parent, pgp, inspection, isDestroyed = () => false) {
    if (isDestroyed()) return;
    parent.replaceChildren();
    const box = element('div', null, parent);
    box.style.cssText = 'padding:16px;overflow:auto';
    element('h3', `OpenPGP ${inspection.kind}`, box);
    if (inspection.keys) {
        for (const key of inspection.keys) {
            const expiry = await key.getExpirationTime().catch(() => null);
            if (isDestroyed()) return;
            const algo = key.getAlgorithmInfo();
            table(box, ['Certificate field', 'Value'], [
                ['Fingerprint', key.getFingerprint()], ['Key ID', key.getKeyID().toHex()],
                ['User IDs (untrusted claims)', key.getUserIDs().join('\n')],
                ['Created', key.getCreationTime().toISOString()],
                ['Expires', expiry instanceof Date ? expiry.toISOString() : expiry === Infinity ? 'Never' : 'Unknown / invalid'],
                ['Algorithm', JSON.stringify(algo)], ['Secret key material', key.isPrivate() ? 'Present (not unlocked)' : 'Absent'],
                ['Subkeys', key.subkeys.map(s => s.getFingerprint()).join('\n')],
            ]);
        }
        element('p', 'Certificate metadata does not establish identity or trust.', box);
        return;
    }
    const packets = inspection.signature ? inspection.signature.packets : inspection.message.packets || inspection.message.signature.packets;
    table(box, ['Packet tag', 'Created', 'Issuer key ID'], packets.map(p => [p.constructor.tag, p.created instanceof Date ? p.created.toISOString() : '', p.issuerKeyID ? p.issuerKeyID.toHex() : '']));
    if (inspection.message) {
        const message = inspection.message;
        const content = typeof message.getText === 'function' ? message.getText() : message.getLiteralData();
        const pre = element('pre', content instanceof Uint8Array ? new TextDecoder().decode(content.subarray(0, 200000)) : String(content || '').slice(0, 200000), box);
        pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;background:#f6f8fa;padding:10px';
        element('p', 'Payload preview is unverified. Display is limited to 200,000 characters/bytes.', box);
    }
    element('label', 'Verification public key(s), ASCII armored', box);
    const keys = element('textarea', null, box);
    keys.style.cssText = 'display:block;width:100%;box-sizing:border-box;height:110px;font:12px monospace';
    keys.placeholder = '-----BEGIN PGP PUBLIC KEY BLOCK-----';
    let original;
    if (inspection.signature) {
        element('label', 'Original signed file (exact bytes)', box);
        original = element('input', null, box); original.type = 'file';
    }
    const button = element('button', 'Verify signature', box);
    const status = element('p', 'Signature has not been verified.', box);
    button.onclick = async () => {
        button.disabled = true; status.textContent = 'Verifying…';
        try {
            const bytes = original && original.files[0] ? new Uint8Array(await original.files[0].arrayBuffer()) : null;
            const results = await verifyPgp(pgp, inspection, keys.value, bytes);
            if (isDestroyed()) return;
            status.textContent = results.map(s => `${s.keyID}: ${s.verified ? 'Valid signature for the supplied key' : 'Verification failed — ' + s.error}`).join('\n');
            status.style.color = results.length && results.every(s => s.verified) ? '#1a7f37' : '#cf222e';
        } catch (err) {
            if (!isDestroyed()) { status.textContent = 'Verification failed: ' + err.message; status.style.color = '#cf222e'; }
        } finally { if (!isDestroyed()) button.disabled = false; }
    };
}

module.exports = { inspectPgp, verifyPgp, mountPgpInspection };
