// KeePass database viewer (.kdbx: KDBX 3.1 and 4.x), loaded on demand by
// src/kdbx-plugin.js. Read-only. The outer header (format, cipher, key
// derivation) is read here (kdbx-header.js) and shown before anything is asked;
// then the password and/or key file unlock it with kdbxweb (esm.sh, loaded when
// such a tab opens). KDBX 4's Argon2 runs in a worker (kdbx-argon2-worker.js,
// hash-wasm's clang-built wasm). Shows the group tree, the entries, one entry's
// fields (protected ones masked until revealed), its TOTP code (kdbx-otp.js),
// attachments to save, and a search over title, username, URL and notes.
//
// The decrypted database lives only in this module's memory for this tab: it is
// never sent to the server, written to localStorage/sessionStorage or saved, and
// it is dropped when the tab closes, when "Lock" is pressed, or after a while
// without activity. The password and key file are read from the inputs and not kept.
import { readKdbxHeader } from './kdbx-header.js';
import { parseOtp, otpCode } from './kdbx-otp.js';

const KDBXWEB_VERSION = '2.1.1';
const KDBXWEB_URL = `https://esm.sh/kdbxweb@${KDBXWEB_VERSION}?deps=@xmldom/xmldom@0.7.13`;
const ARGON2_URL = 'https://esm.sh/hash-wasm@4.12.0/dist/argon2.umd.min.js';
const AUTO_LOCK_CHOICES = [0, 1, 5, 10, 15, 30, 60]; // minutes, 0 = never
const AUTO_LOCK_DEFAULT = 10;
const MASK = '••••••••';
const STANDARD_FIELDS = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes']);

let _libPromise = null;
function loadKdbxweb() {
    if (!_libPromise) {
        _libPromise = import(KDBXWEB_URL).then((mod) => {
            const kdbxweb = mod.default && mod.default.Kdbx ? mod.default : mod;
            kdbxweb.CryptoEngine.setArgon2Impl(argon2);
            return kdbxweb;
        }).catch((err) => { _libPromise = null; throw err; });
    }
    return _libPromise;
}

// Argon2 in a worker, one per derivation; on the page itself if workers can't load
function argon2(password, salt, memory, iterations, length, parallelism, type, version) {
    if (version !== 0x13) return Promise.reject(new Error(`Argon2 version 0x${version.toString(16)} is not supported`));
    const job = { password: password.slice(0), salt: salt.slice(0), memory, iterations, length, parallelism, type };
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(new URL('./kdbx-argon2-worker.js', import.meta.url), { type: 'module' });
        } catch (err) {
            return resolve(argon2OnPage(job));
        }
        let answered = false;
        worker.onmessage = (e) => {
            answered = true;
            worker.terminate();
            if (e.data.error) reject(new Error('Argon2: ' + e.data.error));
            else resolve(e.data.hash.buffer.slice(e.data.hash.byteOffset, e.data.hash.byteOffset + e.data.hash.byteLength));
        };
        worker.onerror = (e) => {
            worker.terminate();
            if (!answered) resolve(argon2OnPage(job));
            if (e.preventDefault) e.preventDefault();
        };
        worker.postMessage(job);
    });
}

async function argon2OnPage(job) {
    const { argon2d, argon2id } = await import(ARGON2_URL);
    const fn = job.type === 2 ? argon2id : argon2d;
    const hash = await fn({
        password: new Uint8Array(job.password), salt: new Uint8Array(job.salt),
        memorySize: job.memory, iterations: job.iterations, parallelism: job.parallelism, hashLength: job.length, outputType: 'binary',
    });
    return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
}

function installStyles() {
    if (document.getElementById('kdbx-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'kdbx-viewer-style';
    style.textContent = `
.kdbxv{height:100%;display:flex;flex-direction:column;background:#fff;color:#222;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:0;position:relative;container-type:inline-size}
.kdbxv-meta{display:flex;flex-wrap:wrap;gap:4px 14px;padding:5px 10px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:12px;color:#57606a;flex-shrink:0}
.kdbxv-meta b{color:#24292f;font-weight:600}
.kdbxv-bar{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid #ddd;background:#fafafa;flex-shrink:0;flex-wrap:wrap}
.kdbxv-bar button,.kdbxv-btn{border:1px solid #ccc;background:#fff;border-radius:4px;padding:2px 9px;font:inherit;cursor:pointer;color:#333;white-space:nowrap}
.kdbxv-bar button:hover,.kdbxv-btn:hover{border-color:#8c959f}
.kdbxv-bar input[type=search]{font:inherit;padding:3px 7px;border:1px solid #ccc;border-radius:4px;min-width:0;flex:1 1 200px;max-width:360px}
.kdbxv-bar select{font:inherit;border:1px solid #ccc;border-radius:4px;padding:1px 2px;background:#fff}
.kdbxv-bar .kdbxv-sp{flex:1}
.kdbxv-bar label{color:#57606a;font-size:12px;display:flex;align-items:center;gap:4px}
.kdbxv-groups-btn{display:none}
.kdbxv-body{flex:1;min-height:0;display:flex;flex-direction:column}
.kdbxv-main{flex:1;min-height:0;display:flex;position:relative}
.kdbxv-tree{width:220px;flex-shrink:0;border-right:1px solid #ddd;overflow:auto;padding:4px 0;background:#fbfbfc}
.kdbxv-tree ul{list-style:none;margin:0;padding:0}
.kdbxv-tree ul ul{padding-left:14px}
.kdbxv-node{display:flex;align-items:center;gap:4px;padding:2px 8px 2px 4px;cursor:pointer;white-space:nowrap;border-radius:3px;margin:0 4px}
.kdbxv-node:hover{background:#eef1f4}
.kdbxv-node.sel{background:#ddf4ff;color:#0550ae}
.kdbxv-node .kdbxv-tw{width:12px;flex-shrink:0;color:#888;font-size:10px;text-align:center}
.kdbxv-node .kdbxv-gname{overflow:hidden;text-overflow:ellipsis;min-width:0}
.kdbxv-node .kdbxv-n{margin-left:auto;padding-left:8px;color:#888;font-size:11px}
.kdbxv-tree-sep{border-top:1px solid #e3e3e3;margin:6px 8px}
.kdbxv-bin .kdbxv-gname{color:#6e7781}
.kdbxv-list{flex:1;min-width:0;overflow:auto}
.kdbxv-table{border-collapse:collapse;font-size:12px;width:100%;table-layout:fixed}
.kdbxv-table th,.kdbxv-table td{padding:4px 8px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kdbxv-table th{position:sticky;top:0;background:#f2f2f2;font-weight:600;cursor:pointer;user-select:none;z-index:1}
.kdbxv-table th .kdbxv-arrow{color:#888;font-size:10px}
.kdbxv-table tr.kdbxv-row{cursor:pointer}
.kdbxv-table tr.kdbxv-row:hover td{background:#f6f8fa}
.kdbxv-table tr.sel td{background:#ddf4ff}
.kdbxv-table tr.expired td{color:#8c959f}
.kdbxv-table td.kdbxv-date{font-variant-numeric:tabular-nums;color:#57606a}
.kdbxv-table td.kdbxv-grp{color:#57606a}
.kdbxv-empty{padding:20px;color:#666}
.kdbxv-detail{width:380px;flex-shrink:0;border-left:1px solid #ddd;overflow:auto;background:#fff;padding:10px 12px;box-sizing:border-box}
.kdbxv-detail h3{margin:0 0 2px;font-size:15px;word-break:break-word}
.kdbxv-detail .kdbxv-path{color:#6e7781;font-size:12px;margin-bottom:10px;word-break:break-word}
.kdbxv-back{display:none}
.kdbxv-f{margin:0 0 9px}
.kdbxv-f>.kdbxv-label{color:#6e7781;font-size:11px;margin-bottom:2px;display:flex;align-items:center;gap:6px}
.kdbxv-f>.kdbxv-label .kdbxv-prot{font-size:10px;color:#9a6700;background:#fff8c5;border-radius:3px;padding:0 4px}
.kdbxv-val{display:flex;align-items:flex-start;gap:4px}
.kdbxv-val .kdbxv-text{flex:1;min-width:0;word-break:break-all;padding:3px 6px;background:#f6f8fa;border:1px solid #e5e7ea;border-radius:4px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;min-height:1.4em;user-select:text}
.kdbxv-val .kdbxv-text.masked{color:#57606a;letter-spacing:1px}
.kdbxv-val .kdbxv-text a{color:#0969da}
.kdbxv-val .kdbxv-btn{padding:2px 6px;font-size:12px;flex-shrink:0}
.kdbxv-notes{white-space:pre-wrap;word-break:break-word;padding:5px 7px;background:#f6f8fa;border:1px solid #e5e7ea;border-radius:4px;font-size:12px;max-height:240px;overflow:auto;user-select:text}
.kdbxv-otp{display:flex;align-items:center;gap:10px}
.kdbxv-otp .kdbxv-code{font:600 22px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:2px;color:#24292f}
.kdbxv-otp .kdbxv-ring{position:relative;width:26px;height:26px;flex-shrink:0}
.kdbxv-otp .kdbxv-ring span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#57606a;font-variant-numeric:tabular-nums}
.kdbxv-otp .kdbxv-sub{color:#6e7781;font-size:11px}
.kdbxv-tags{display:flex;flex-wrap:wrap;gap:4px}
.kdbxv-tag{background:#ddf4ff;color:#0550ae;border-radius:10px;padding:1px 8px;font-size:11px}
.kdbxv-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;font-size:12px}
.kdbxv-kv span:nth-child(odd){color:#6e7781}
.kdbxv-expired{color:#cf222e;font-weight:600}
.kdbxv-att{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #f0f0f0;font-size:12px}
.kdbxv-att .kdbxv-an{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kdbxv-att .kdbxv-as{color:#6e7781;font-variant-numeric:tabular-nums}
.kdbxv-detail details{font-size:12px}
.kdbxv-detail summary{cursor:pointer;color:#0969da}
.kdbxv-hist{margin:4px 0 0;padding-left:16px;color:#57606a}
.kdbxv-uuid{color:#8c959f;font:10px ui-monospace,monospace;margin-top:10px;word-break:break-all}
.kdbxv-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:#24292f;color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:5}
.kdbxv-toast.on{opacity:.95}
.kdbxv-card{max-width:460px;margin:36px auto;padding:20px 22px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa}
.kdbxv-card h3{margin:0 0 6px;font-size:15px}
.kdbxv-card p{margin:6px 0;color:#57606a;line-height:1.45}
.kdbxv-card .kdbxv-row{display:flex;gap:6px;margin-top:10px;align-items:center}
.kdbxv-card input[type=password]{flex:1;min-width:0;padding:6px 8px;border:1px solid #afb8c1;border-radius:5px;font:inherit}
.kdbxv-card .kdbxv-go{padding:6px 14px;border:1px solid #1a7f37;border-radius:5px;background:#1f883d;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.kdbxv-card .kdbxv-go:disabled,.kdbxv-card .kdbxv-btn:disabled{opacity:.6;cursor:default}
.kdbxv-card .kdbxv-kf{flex:1;min-width:0;color:#57606a;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kdbxv-card .kdbxv-error{color:#cf222e;margin-top:8px;min-height:1em;white-space:pre-wrap}
.kdbxv-card .kdbxv-note{font-size:11px;color:#6e7781;margin-top:12px}
.kdbxv-card.kdbxv-unsup{border-color:#d4a72c;background:#fff8c5}
.kdbxv-card.kdbxv-unsup p{color:#6f4e00}
/* Narrow tab (a phone, or a thin panel): groups in a drawer, the entry over the list */
@container (max-width:760px){
 .kdbxv-groups-btn{display:inline-block}
 .kdbxv-tree{position:absolute;left:0;top:0;bottom:0;z-index:3;box-shadow:2px 0 8px rgba(0,0,0,.15);display:none}
 .kdbxv.tree-open .kdbxv-tree{display:block}
 .kdbxv-detail{position:absolute;inset:0;width:auto;border-left:none;z-index:2}
 .kdbxv-back{display:inline-block;margin-bottom:8px}
 .kdbxv-table .kdbxv-c-url,.kdbxv-table .kdbxv-c-date,.kdbxv-table colgroup{display:none}
}
`;
    document.head.appendChild(style);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function button(text, title, onclick, cls = 'kdbxv-btn') {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    if (onclick) b.onclick = onclick;
    return b;
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Same as the other viewers' "save" (jbf-viewer.js): a blob: link clicked in the page
function saveBytes(bytes, name, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function safeHref(url) {
    const u = (url || '').trim();
    return /^(https?|ftp):\/\//i.test(u) ? u : null;
}

// Why an unlock failed, in words
function describeError(err, header, usedKeyFile) {
    const code = err && err.code;
    const msg = (err && err.message || String(err)).replace(/^Error [A-Za-z]+: /, '');
    if (code === 'InvalidKey') {
        let text = usedKeyFile ? 'Wrong password or key file.' : 'Wrong password.';
        text += usedKeyFile ? '\nA database that also needs a YubiKey (challenge-response) can’t be opened here.'
            : '\nIf the database also needs a key file, choose it below; one that needs a YubiKey (challenge-response) can’t be opened here.';
        if (header && header.major < 4) text += '\nA damaged file reads the same way in KDBX 3.';
        return text;
    }
    if (code === 'FileCorrupt' && /key ?file/i.test(msg)) return 'The key file is damaged: ' + msg;
    if (code === 'FileCorrupt') return 'The database is damaged or truncated (' + msg + ').';
    if (code === 'Unsupported' || code === 'InvalidVersion' || code === 'BadSignature') return 'Not supported: ' + msg;
    if (err instanceof RangeError || /out of bounds|offset/i.test(msg)) return 'The database is damaged or truncated (' + msg + ').';
    return 'Could not open the database: ' + msg;
}

export function mountKdbxViewer(host, { bytes, name, setStatus, onUnlock }) {
    installStyles();
    const header = readKdbxHeader(bytes);
    const root = el('div', 'kdbxv');
    host.appendChild(root);
    const metaEl = el('div', 'kdbxv-meta');
    const bodyEl = el('div', 'kdbxv-body');
    const toast = el('div', 'kdbxv-toast');
    root.append(metaEl, bodyEl, toast);
    const status = (text, isError) => { if (setStatus) setStatus(text, isError); };

    // Everything decrypted hangs off `state`; lock() replaces it with null
    let state = null;
    let keyFile = null;          // { name, file } — the File handle, read again on each unlock
    let autoLockMin = AUTO_LOCK_DEFAULT;
    let lastActivity = Date.now();
    let lockTimer = null;
    let otpTimer = null;
    let toastTimer = null;
    let destroyed = false;

    function showToast(text) {
        toast.textContent = text;
        toast.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('on'), 1600);
    }

    async function copy(text, what) {
        try {
            await navigator.clipboard.writeText(text);
            showToast(`Copied ${what}`);
        } catch (err) {
            showToast(`Could not copy: ${err.message}`);
        }
    }

    function renderMeta() {
        const items = [['Format', header.version || '?']];
        if (header.kind === 'kdbx' || header.kind === 'kdb') {
            items.push(['Cipher', header.cipher || '?'], ['KDF', header.kdfText || '?']);
            if (header.compression) items.push(['Compression', header.compression]);
        }
        if (state) {
            const m = state.db.meta;
            if (m.name) items.push(['Name', m.name]);
            if (m.desc) items.push(['Description', m.desc]);
            if (m.generator) items.push(['Generator', m.generator]);
            items.push(['Entries', String(state.allEntries.length)]);
            if (state.binNode) items.push(['Recycle Bin', `${state.binNode.total} entr${state.binNode.total === 1 ? 'y' : 'ies'}`]);
        }
        metaEl.textContent = '';
        for (const [k, v] of items) {
            const span = el('span', null, k + ': ');
            span.appendChild(el('b', null, v));
            metaEl.appendChild(span);
        }
    }

    // --- Locked: the prompt ---
    function showPrompt(note) {
        bodyEl.textContent = '';
        root.classList.remove('tree-open');
        const wrap = el('div', 'kdbxv-list');
        bodyEl.appendChild(wrap);
        if (header.unsupported || header.corrupt) {
            const card = el('div', 'kdbxv-card kdbxv-unsup');
            card.appendChild(el('h3', null, header.unsupported ? '⚠ Can’t open this file' : '⚠ Damaged file'));
            card.appendChild(el('p', null, header.unsupported || header.corrupt));
            wrap.appendChild(card);
            status(header.unsupported ? 'unsupported' : 'damaged', true);
            return;
        }
        const card = el('div', 'kdbxv-card');
        card.appendChild(el('h3', null, '🔐 Unlock database'));
        card.appendChild(el('p', null, `${name} is a KeePass database (${header.version}, ${header.cipher}, ${header.kdfText}).`));
        if (note) card.appendChild(el('p', null, note));
        const row = el('div', 'kdbxv-row');
        const input = el('input');
        input.type = 'password';
        input.placeholder = 'Master password';
        input.autocomplete = 'off';
        input.spellcheck = false;
        const go = button('Unlock', null, null, 'kdbxv-go');
        row.append(input, go);
        const kfRow = el('div', 'kdbxv-row');
        const kfInput = el('input');
        kfInput.type = 'file';
        kfInput.hidden = true;
        const kfPick = button('Key file…', 'Choose the key file (read here in the browser, not uploaded)');
        const kfName = el('span', 'kdbxv-kf');
        const kfClear = button('✕', 'Don’t use a key file');
        const showKf = () => {
            kfName.textContent = keyFile ? keyFile.name : 'no key file';
            kfClear.hidden = !keyFile;
        };
        kfPick.onclick = () => kfInput.click();
        kfInput.onchange = () => {
            const f = kfInput.files && kfInput.files[0];
            keyFile = f ? { name: f.name, file: f } : keyFile;
            kfInput.value = '';
            showKf();
            input.focus();
        };
        kfClear.onclick = () => { keyFile = null; showKf(); };
        showKf();
        kfRow.append(kfPick, kfName, kfClear, kfInput);
        const error = el('div', 'kdbxv-error');
        card.append(row, kfRow, error);
        card.appendChild(el('p', 'kdbxv-note', 'Decrypted entries stay in this tab’s memory only: nothing is sent to the server or saved, '
            + 'and they are dropped when the tab closes or locks. Databases that need a YubiKey (challenge-response) can’t be opened here.'));
        wrap.appendChild(card);
        const busy = [input, go, kfPick, kfClear];
        const submit = async () => {
            if (go.disabled) return;
            busy.forEach(e => { e.disabled = true; });
            error.textContent = '';
            go.textContent = /^Argon2/.test(header.kdf) ? 'Deriving key…' : 'Unlocking…';
            const password = input.value;
            try {
                await unlock(password, keyFile);
                input.value = '';
            } catch (err) {
                error.textContent = describeError(err, header, !!keyFile);
                busy.forEach(e => { e.disabled = false; });
                go.textContent = 'Unlock';
                input.focus();
                input.select();
            }
        };
        go.onclick = submit;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        requestAnimationFrame(() => input.focus());
        status(`${header.version} · locked`);
    }

    async function unlock(password, kf) {
        if (!window.isSecureContext || !crypto.subtle) throw new Error('this needs a secure page (https or localhost) for WebCrypto');
        const kdbxweb = await loadKdbxweb();
        const keyBytes = kf ? new Uint8Array(await kf.file.arrayBuffer()) : null;
        // An empty password with a key file means "no password"; some files use an empty one
        const tries = password ? [password] : keyBytes ? [null, ''] : [''];
        const t0 = performance.now();
        let db = null, lastErr = null;
        for (const pw of tries) {
            try {
                const cred = new kdbxweb.Credentials(pw == null ? null : kdbxweb.ProtectedValue.fromString(pw), keyBytes);
                db = await kdbxweb.Kdbx.load(bytes.slice().buffer, cred);
                break;
            } catch (err) {
                lastErr = err;
                if (err.code !== 'InvalidKey') break;
            }
        }
        if (keyBytes) keyBytes.fill(0);
        if (!db) throw lastErr;
        if (destroyed) return;
        const ms = Math.round(performance.now() - t0);
        state = buildState(kdbxweb, db);
        state.unlockMs = ms;
        lastActivity = Date.now();
        renderMeta();
        showDatabase();
        status(`${header.version} · unlocked in ${(ms / 1000).toFixed(1)} s · read-only, in memory`);
        if (onUnlock) onUnlock({ ms, version: header.version, kdf: header.kdf, entries: state.allEntries.length });
        armAutoLock();
    }

    function lock(reason) {
        if (!state) return;
        state = null;
        clearInterval(otpTimer);
        otpTimer = null;
        listEl = treeEl = detailEl = searchEl = null;
        renderMeta();
        showPrompt(reason || 'Locked. The decrypted entries were dropped from memory.');
    }

    function armAutoLock() {
        clearInterval(lockTimer);
        lockTimer = setInterval(() => {
            if (state && autoLockMin && Date.now() - lastActivity > autoLockMin * 60000) {
                lock(`Locked after ${autoLockMin} minute${autoLockMin === 1 ? '' : 's'} without activity. The decrypted entries were dropped from memory.`);
            }
        }, 5000);
    }
    const touch = () => { lastActivity = Date.now(); };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) root.addEventListener(ev, touch, { passive: true });

    // --- The decrypted model ---
    function buildState(kdbxweb, db) {
        const PV = kdbxweb.ProtectedValue;
        const meta = db.meta;
        const binId = meta.recycleBinEnabled !== false && meta.recycleBinUuid && !meta.recycleBinUuid.empty ? meta.recycleBinUuid.id : null;
        const allEntries = [];
        let binNode = null;
        const walk = (group, path, inBin) => {
            const isBin = !!binId && group.uuid && group.uuid.id === binId;
            const node = { group, name: group.name || '(unnamed)', path, children: [], entries: [], isBin, inBin: inBin || isBin, total: 0 };
            for (const entry of group.entries) {
                const item = { entry, node };
                node.entries.push(item);
                if (!node.inBin) allEntries.push(item);
            }
            node.total = node.entries.length;
            for (const g of group.groups) {
                const child = walk(g, path.concat(g.name || '(unnamed)'), node.inBin);
                node.total += child.total;
                if (child.isBin) binNode = child;
                else node.children.push(child);
            }
            if (isBin) node.total = countAll(node);
            return node;
        };
        const countAll = (n) => n.entries.length + n.children.reduce((s, c) => s + countAll(c), 0);
        const rootGroup = db.getDefaultGroup();
        const rootNode = walk(rootGroup, [], false);
        rootNode.total = allEntries.length;
        const text = (entry, key) => {
            const v = entry.fields.get(key);
            return v instanceof PV ? v.getText() : v == null ? '' : String(v);
        };
        return {
            kdbxweb, db, PV, rootNode, binNode, allEntries, text,
            selNode: null, selEntry: null, query: '', sort: { key: 'title', dir: 1 }, revealed: new Set(), expanded: new Set(),
        };
    }

    // --- Unlocked: tree, list, detail ---
    let listEl, treeEl, detailEl, searchEl;

    function showDatabase() {
        bodyEl.textContent = '';
        const bar = el('div', 'kdbxv-bar');
        const groupsBtn = button('☰ Groups', 'Show the groups', () => root.classList.toggle('tree-open'), 'kdbxv-groups-btn');
        searchEl = el('input');
        searchEl.type = 'search';
        searchEl.placeholder = 'Search title, username, URL, notes…';
        searchEl.spellcheck = false;
        searchEl.oninput = () => { if (!state) return; state.query = searchEl.value.trim(); renderList(); };
        const lockLabel = el('label', null, 'Auto-lock');
        const sel = el('select');
        for (const m of AUTO_LOCK_CHOICES) {
            const o = el('option', null, m ? `${m} min` : 'never');
            o.value = String(m);
            if (m === autoLockMin) o.selected = true;
            sel.appendChild(o);
        }
        sel.onchange = () => { autoLockMin = +sel.value; };
        lockLabel.appendChild(sel);
        const lockBtn = button('🔒 Lock', 'Drop the decrypted database from memory', () => lock(), null);
        bar.append(groupsBtn, searchEl, el('span', 'kdbxv-sp'), lockLabel, lockBtn);
        const main = el('div', 'kdbxv-main');
        treeEl = el('div', 'kdbxv-tree');
        listEl = el('div', 'kdbxv-list');
        detailEl = el('div', 'kdbxv-detail');
        detailEl.hidden = true;
        main.append(treeEl, listEl, detailEl);
        bodyEl.append(bar, main);
        state.selNode = 'all';
        state.expanded.add(state.rootNode);
        renderTree();
        renderList();
    }

    function renderTree() {
        treeEl.textContent = '';
        const ul = el('ul');
        const all = nodeRow({ name: 'All entries', total: state.allEntries.length, children: [], all: true }, 0);
        ul.appendChild(all);
        ul.appendChild(treeItem(state.rootNode, 0));
        treeEl.appendChild(ul);
        if (state.binNode) {
            treeEl.appendChild(el('div', 'kdbxv-tree-sep'));
            const binUl = el('ul');
            binUl.appendChild(treeItem(state.binNode, 0));
            treeEl.appendChild(binUl);
        }
    }

    function nodeRow(node, depth) {
        const li = el('li');
        const row = el('div', 'kdbxv-node' + ((node.all ? state.selNode === 'all' : state.selNode === node) ? ' sel' : '') + (node.inBin ? ' kdbxv-bin' : ''));
        const tw = el('span', 'kdbxv-tw', node.children.length ? (state.expanded.has(node) ? '▾' : '▸') : '');
        tw.onclick = (e) => {
            e.stopPropagation();
            if (!node.children.length) return;
            if (state.expanded.has(node)) state.expanded.delete(node); else state.expanded.add(node);
            renderTree();
        };
        const icon = node.all ? '🗂' : node.isBin ? '🗑' : node === state.rootNode ? '🔐' : '📁';
        row.append(tw, el('span', null, icon), el('span', 'kdbxv-gname', node.name), el('span', 'kdbxv-n', String(node.all ? node.total : node.entries.length)));
        row.title = node.all ? 'Every entry outside the Recycle Bin' : node.path && node.path.length ? node.path.join(' / ') : node.name;
        row.onclick = () => {
            state.selNode = node.all ? 'all' : node;
            if (!node.all && node.children.length) state.expanded.add(node);
            state.selEntry = null;
            if (searchEl.value) { searchEl.value = ''; state.query = ''; }
            root.classList.remove('tree-open');
            renderTree();
            renderList();
        };
        li.appendChild(row);
        return li;
    }

    function treeItem(node, depth) {
        const li = nodeRow(node, depth);
        if (node.children.length && state.expanded.has(node)) {
            const ul = el('ul');
            for (const c of node.children) ul.appendChild(treeItem(c, depth + 1));
            li.appendChild(ul);
        }
        return li;
    }

    function collect(node, out) {
        out.push(...node.entries);
        for (const c of node.children) collect(c, out);
        return out;
    }

    function visibleEntries() {
        const q = state.query.toLowerCase();
        let items;
        if (q) {
            // Search everything outside the Recycle Bin (or inside it, when it's the selected group)
            items = state.selNode && state.selNode !== 'all' && state.selNode.inBin ? collect(state.binNode, []) : state.allEntries;
            items = items.filter(({ entry }) => ['Title', 'UserName', 'URL', 'Notes'].some(k => state.text(entry, k).toLowerCase().includes(q))
                || entry.tags.some(t => t.toLowerCase().includes(q)));
        } else if (state.selNode === 'all') {
            items = state.allEntries.slice();
        } else {
            items = state.selNode.entries.slice();
        }
        const { key, dir } = state.sort;
        const val = (it) => key === 'modified' ? (it.entry.times.lastModTime || 0) - 0
            : key === 'group' ? it.node.path.join('/').toLowerCase()
            : state.text(it.entry, { title: 'Title', username: 'UserName', url: 'URL' }[key]).toLowerCase();
        items.sort((a, b) => { const x = val(a), y = val(b); return x < y ? -dir : x > y ? dir : 0; });
        return items;
    }

    function renderList() {
        if (!state) return;
        const items = visibleEntries();
        const showGroup = !!state.query || state.selNode === 'all';
        listEl.textContent = '';
        if (!items.length) {
            listEl.appendChild(el('div', 'kdbxv-empty', state.query ? `No entries match “${state.query}”.` : 'No entries in this group.'));
            return;
        }
        const table = el('table', 'kdbxv-table');
        const cols = [['title', 'Title', '34%'], ['username', 'Username', '24%'], ['url', 'URL', '24%'], ['modified', 'Modified', '18%']];
        if (showGroup) cols.splice(1, 0, ['group', 'Group', '18%']);
        const colgroup = el('colgroup');
        const thead = el('thead');
        const htr = el('tr');
        for (const [key, label, w] of cols) {
            const col = el('col');
            col.style.width = w;
            colgroup.appendChild(col);
            const th = el('th', 'kdbxv-c-' + (key === 'modified' ? 'date' : key), label);
            if (state.sort.key === key) th.appendChild(el('span', 'kdbxv-arrow', state.sort.dir > 0 ? ' ▲' : ' ▼'));
            th.onclick = () => {
                state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (key === 'modified' ? -1 : 1) };
                renderList();
            };
            htr.appendChild(th);
        }
        thead.appendChild(htr);
        const tbody = el('tbody');
        const now = new Date();
        for (const item of items) {
            const { entry, node } = item;
            const expired = entry.times.expires && entry.times.expiryTime && entry.times.expiryTime < now;
            const tr = el('tr', 'kdbxv-row' + (state.selEntry === entry ? ' sel' : '') + (expired ? ' expired' : ''));
            const title = state.text(entry, 'Title') || '(no title)';
            const tdTitle = el('td', null, (expired ? '⌛ ' : '') + title);
            tdTitle.title = title;
            tr.appendChild(tdTitle);
            if (showGroup) {
                const g = el('td', 'kdbxv-grp', node.path.join(' / ') || node.name);
                g.title = g.textContent;
                tr.appendChild(g);
            }
            const user = el('td', null, state.text(entry, 'UserName'));
            const url = el('td', 'kdbxv-c-url', state.text(entry, 'URL'));
            url.title = url.textContent;
            tr.append(user, url, el('td', 'kdbxv-date kdbxv-c-date', fmtDate(entry.times.lastModTime)));
            tr.onclick = () => {
                state.selEntry = entry;
                listEl.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
                tr.classList.add('sel');
                renderDetail(item);
            };
            tbody.appendChild(tr);
        }
        table.append(colgroup, thead, tbody);
        listEl.appendChild(table);
        if (!state.selEntry || !items.some(i => i.entry === state.selEntry)) {
            detailEl.hidden = true;
            clearInterval(otpTimer);
        }
    }

    // One field: label, value (masked when protected, until revealed), copy.
    // get() reads the value; a masked one is only read when revealed or copied,
    // so its plain text isn't held anywhere until then.
    function fieldBlock(label, get, { secret = false, link = false, protectedTag = false, copyWhat, empty } = {}) {
        const f = el('div', 'kdbxv-f');
        const lab = el('div', 'kdbxv-label', label);
        if (protectedTag) lab.appendChild(el('span', 'kdbxv-prot', 'protected'));
        const row = el('div', 'kdbxv-val');
        const text = el('div', 'kdbxv-text');
        const hasValue = secret ? !empty : !!get();
        let shown = !secret;
        const paint = () => {
            text.textContent = '';
            text.classList.toggle('masked', !shown);
            if (!shown) { text.textContent = hasValue ? MASK : ''; return; }
            const value = get();
            const href = link && safeHref(value);
            if (href) {
                const a = el('a', null, value);
                a.href = href;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                text.appendChild(a);
            } else {
                text.textContent = value;
            }
        };
        paint();
        row.appendChild(text);
        if (secret && hasValue) {
            const eye = button('👁', 'Show / hide');
            eye.classList.add('kdbxv-reveal');
            eye.onclick = () => { shown = !shown; paint(); };
            row.appendChild(eye);
        }
        if (hasValue) {
            const c = button('⧉', 'Copy to the clipboard', () => { if (state) copy(get(), copyWhat || label.toLowerCase()); });
            c.classList.add('kdbxv-copy');
            row.appendChild(c);
        }
        f.append(lab, row);
        return f;
    }

    function binaryBytes(v) {
        if (!v) return null;
        if (v instanceof ArrayBuffer) return new Uint8Array(v);
        if (v instanceof state.PV) return v.getBinary();
        if (v.value !== undefined) return binaryBytes(v.value);
        if (v.ref !== undefined) { const b = state.db.binaries.getByRef(v); return b ? binaryBytes(b.value) : null; }
        return null;
    }

    function renderDetail({ entry, node }) {
        clearInterval(otpTimer);
        otpTimer = null;
        detailEl.hidden = false;
        detailEl.textContent = '';
        detailEl.scrollTop = 0;
        const t = (k) => state.text(entry, k);
        const back = button('← Back', null, () => { detailEl.hidden = true; state.selEntry = null; clearInterval(otpTimer); });
        back.classList.add('kdbxv-back');
        detailEl.appendChild(back);
        detailEl.appendChild(el('h3', null, t('Title') || '(no title)'));
        detailEl.appendChild(el('div', 'kdbxv-path', (node.inBin ? '🗑 ' : '📁 ') + (node.path.join(' / ') || node.name)));
        const isProt = (k) => entry.fields.get(k) instanceof state.PV;
        const isEmpty = (k) => { const v = entry.fields.get(k); return !v || (v instanceof state.PV ? !v.byteLength : !String(v)); };
        const getter = (k) => () => (state ? state.text(entry, k) : '');
        detailEl.appendChild(fieldBlock('Username', getter('UserName'), { copyWhat: 'username' }));
        detailEl.appendChild(fieldBlock('Password', getter('Password'), { secret: true, empty: isEmpty('Password'), copyWhat: 'password' }));
        detailEl.appendChild(fieldBlock('URL', getter('URL'), { link: true, copyWhat: 'URL' }));

        // TOTP
        let otp = null, otpErr = null;
        try { otp = parseOtp(t); } catch (err) { otpErr = err.message; }
        if (otp || otpErr) {
            const f = el('div', 'kdbxv-f');
            f.appendChild(el('div', 'kdbxv-label', otp && otp.type === 'hotp' ? 'HOTP' : 'TOTP'));
            if (otpErr) {
                f.appendChild(el('div', 'kdbxv-sub', 'Can’t compute the one-time code: ' + otpErr));
            } else {
                const box = el('div', 'kdbxv-otp');
                const code = el('span', 'kdbxv-code', '……');
                const ring = el('div', 'kdbxv-ring');
                ring.innerHTML = '<svg viewBox="0 0 36 36" width="26" height="26"><circle cx="18" cy="18" r="15" fill="none" stroke="#e5e7ea" stroke-width="4"/><circle class="kdbxv-arc" cx="18" cy="18" r="15" fill="none" stroke="#1f883d" stroke-width="4" stroke-dasharray="94.25" stroke-dashoffset="0" transform="rotate(-90 18 18)"/></svg><span></span>';
                const secs = ring.querySelector('span');
                const arc = ring.querySelector('.kdbxv-arc');
                let current = '';
                const copyBtn = button('⧉', 'Copy the code', () => current && copy(current, 'one-time code'));
                copyBtn.classList.add('kdbxv-copy');
                const sub = el('div', 'kdbxv-sub', [otp.steam ? 'Steam' : `${otp.digits} digits`, otp.algorithm.replace('SHA', 'SHA-'),
                    otp.type === 'hotp' ? `counter ${otp.counter}` : `${otp.period} s`, otp.source].join(' · '));
                if (otp.type === 'hotp') ring.hidden = true;
                box.append(code, ring, copyBtn);
                f.append(box, sub);
                const tick = async () => {
                    if (!state || state.selEntry !== entry) return;
                    const r = await otpCode(otp);
                    current = r.code;
                    code.textContent = r.code.length >= 6 && !otp.steam ? r.code.slice(0, Math.ceil(r.code.length / 2)) + ' ' + r.code.slice(Math.ceil(r.code.length / 2)) : r.code;
                    code.dataset.code = r.code;
                    if (r.remaining != null) {
                        secs.textContent = String(r.remaining);
                        arc.setAttribute('stroke-dashoffset', String(94.25 * (1 - r.remaining / r.period)));
                        arc.setAttribute('stroke', r.remaining <= 5 ? '#cf222e' : '#1f883d');
                    }
                };
                tick().catch(err => { code.textContent = '—'; sub.textContent = 'Can’t compute the code: ' + err.message; });
                if (otp.type === 'totp') otpTimer = setInterval(() => tick().catch(() => {}), 1000);
            }
            detailEl.appendChild(f);
        }

        const notes = t('Notes');
        if (notes) {
            const f = el('div', 'kdbxv-f');
            f.append(el('div', 'kdbxv-label', 'Notes'), el('div', 'kdbxv-notes', notes));
            detailEl.appendChild(f);
        }

        const custom = [...entry.fields.keys()].filter(k => !STANDARD_FIELDS.has(k));
        if (custom.length) {
            detailEl.appendChild(el('div', 'kdbxv-label', 'Custom fields')).style.cssText = 'color:#24292f;font-weight:600;font-size:12px;margin:12px 0 6px';
            for (const k of custom) detailEl.appendChild(fieldBlock(k, getter(k), { secret: isProt(k), empty: isEmpty(k), protectedTag: isProt(k), copyWhat: k }));
        }

        if (entry.tags && entry.tags.length) {
            const f = el('div', 'kdbxv-f');
            const tags = el('div', 'kdbxv-tags');
            for (const tag of entry.tags) tags.appendChild(el('span', 'kdbxv-tag', tag));
            f.append(el('div', 'kdbxv-label', 'Tags'), tags);
            detailEl.appendChild(f);
        }

        const times = entry.times;
        const kv = el('div', 'kdbxv-kv');
        const add = (k, v, cls) => { kv.append(el('span', null, k), el('span', cls, v)); };
        add('Created', fmtDate(times.creationTime));
        add('Modified', fmtDate(times.lastModTime));
        if (times.expires && times.expiryTime) {
            const past = times.expiryTime < new Date();
            add('Expires', fmtDate(times.expiryTime) + (past ? ' (expired)' : ''), past ? 'kdbxv-expired' : null);
        } else {
            add('Expires', 'never');
        }
        const tf = el('div', 'kdbxv-f');
        tf.style.marginTop = '12px';
        tf.appendChild(kv);
        detailEl.appendChild(tf);

        if (entry.binaries && entry.binaries.size) {
            const f = el('div', 'kdbxv-f');
            f.appendChild(el('div', 'kdbxv-label', `Attachments (${entry.binaries.size})`));
            for (const [fname, v] of entry.binaries) {
                const row = el('div', 'kdbxv-att');
                const data = binaryBytes(v);
                row.append(el('span', null, '📎'), el('span', 'kdbxv-an', fname), el('span', 'kdbxv-as', data ? fmtSize(data.length) : '?'));
                const save = button('Save', 'Save this attachment (made in the browser, nothing goes to the server)', () => {
                    const b = binaryBytes(v);
                    if (b) saveBytes(b, fname.split(/[\\/]/).pop() || 'attachment');
                });
                save.classList.add('kdbxv-save');
                if (!data) save.disabled = true;
                row.appendChild(save);
                f.appendChild(row);
            }
            detailEl.appendChild(f);
        }

        const hist = entry.history || [];
        const hf = el('div', 'kdbxv-f');
        if (hist.length) {
            const det = el('details');
            det.appendChild(el('summary', null, `History: ${hist.length} older version${hist.length === 1 ? '' : 's'}`));
            const ol = el('ol', 'kdbxv-hist');
            for (const h of hist.slice().reverse()) ol.appendChild(el('li', null, `${fmtDate(h.times.lastModTime)} — ${state.text(h, 'Title') || '(no title)'}`));
            det.appendChild(ol);
            hf.appendChild(det);
        } else {
            hf.appendChild(el('div', 'kdbxv-label', 'History: none'));
        }
        detailEl.appendChild(hf);
        if (entry.uuid) detailEl.appendChild(el('div', 'kdbxv-uuid', 'UUID ' + entry.uuid.id));
    }

    renderMeta();
    showPrompt();
    // Fetch the library while the password is typed
    if (!header.unsupported && !header.corrupt) loadKdbxweb().catch((err) => status('Could not load kdbxweb: ' + err.message, true));

    return {
        header,
        isUnlocked: () => !!state,
        lock,
        destroy() {
            destroyed = true;
            state = null;
            listEl = treeEl = detailEl = searchEl = null;
            keyFile = null;
            clearInterval(otpTimer);
            clearInterval(lockTimer);
            clearTimeout(toastTimer);
            root.remove();
        },
    };
}
