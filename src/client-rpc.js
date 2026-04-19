// --- Client RPC dispatcher ---
// Listens for `clientAction` and `clientEval` relay messages from the
// WebSocket and executes them against `window.app`. See docs/client-api.md
// for the protocol.

function resolveMethod(root, dotPath) {
    if (!dotPath || typeof dotPath !== 'string') return { fn: null, thisArg: null };
    const parts = dotPath.split('.');
    let cur = root;
    let parent = null;
    for (const part of parts) {
        if (cur == null) return { fn: null, thisArg: null };
        parent = cur;
        cur = cur[part];
    }
    if (typeof cur !== 'function') return { fn: null, thisArg: null };
    return { fn: cur, thisArg: parent };
}

async function handleClientAction(msg, wsClient) {
    const reply = (patch) => {
        wsClient.wsRawSend({ type: 'clientActionResult', id: msg.id, ...patch });
    };
    try {
        if (!window.app) throw new Error('window.app not ready');
        const { fn, thisArg } = resolveMethod(window.app, msg.method);
        if (!fn) throw new Error(`Unknown method: ${msg.method}`);
        const args = Array.isArray(msg.args) ? msg.args : [];
        let result = fn.apply(thisArg, args);
        if (result && typeof result.then === 'function') result = await result;
        reply({ result: safeClone(result) });
    } catch (err) {
        reply({ error: err && err.message ? err.message : String(err) });
    }
}

async function handleClientEval(msg, wsClient) {
    const reply = (patch) => {
        wsClient.wsRawSend({ type: 'clientEvalResult', id: msg.id, ...patch });
    };
    try {
        const code = msg.code;
        if (typeof code !== 'string') throw new Error('clientEval: missing code');
        // Evaluate in an async function so the code can use await and return.
        // eslint-disable-next-line no-new-func
        const fn = new Function('app', `return (async () => { ${code} })();`);
        let result = fn(window.app);
        if (result && typeof result.then === 'function') result = await result;
        reply({ result: safeClone(result) });
    } catch (err) {
        reply({ error: err && err.message ? err.message : String(err), stack: err && err.stack });
    }
}

// JSON-safe clone of an arbitrary value. Drops functions, converts circular
// references to strings, and preserves plain data.
function safeClone(value, depth = 0) {
    if (depth > 8) return '[Object too deep]';
    if (value == null) return value;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return value;
    if (t === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (t === 'symbol') return value.toString();
    if (t === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(v => safeClone(v, depth + 1));
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (t === 'object') {
        // Only plain-ish objects; drop DOM nodes, Maps, etc.
        if (value.nodeType !== undefined) return `[DOM ${value.nodeName}]`;
        if (value instanceof Map) return Object.fromEntries(Array.from(value.entries()).map(([k, v]) => [String(k), safeClone(v, depth + 1)]));
        if (value instanceof Set) return Array.from(value).map(v => safeClone(v, depth + 1));
        const out = {};
        for (const k of Object.keys(value)) {
            try { out[k] = safeClone(value[k], depth + 1); }
            catch (_) { out[k] = '[Unserializable]'; }
        }
        return out;
    }
    return String(value);
}

function installClientRpc(wsClient, log) {
    wsClient.addMessageListener((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === 'clientAction') {
            if (log) log.log('RPC clientAction:', msg.method, msg.args);
            handleClientAction(msg, wsClient);
        } else if (msg.type === 'clientEval') {
            if (log) log.log('RPC clientEval:', (msg.code || '').slice(0, 80));
            handleClientEval(msg, wsClient);
        }
    });
    if (log) log.log('Client RPC dispatcher installed.');
}

module.exports = { installClientRpc, safeClone, resolveMethod };
