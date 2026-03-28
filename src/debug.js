// --- Gated debug logging ---
// Enable via ?debug in URL, localStorage.setItem('debug', '1'), or server config

let ENABLED = (typeof window !== 'undefined') &&
    (new URLSearchParams(window.location.search).has('debug') ||
     (typeof localStorage !== 'undefined' && localStorage.getItem('debug')));

// Optional WS forwarding — set by ws-client once connected
let _wsSend = null;

function setWsSender(fn) {
    _wsSend = fn;
}

function setEnabled(val) {
    ENABLED = !!val;
}

function _forward(level, tag, args) {
    if (_wsSend) {
        try {
            _wsSend({ type: 'clientLog', level, message: `[${tag}] ${args.map(String).join(' ')}` });
        } catch (_) {}
    }
}

function createLogger(tag) {
    return {
        log(...args) {
            if (ENABLED) console.log(`[${tag}]`, ...args);
            _forward('log', tag, args);
        },
        warn(...args) {
            if (ENABLED) console.warn(`[${tag}]`, ...args);
            _forward('warn', tag, args);
        },
        error(...args) {
            // errors always print locally
            console.error(`[${tag}]`, ...args);
            _forward('error', tag, args);
        },
        get enabled() { return ENABLED; },
    };
}

module.exports = { createLogger, setWsSender, setEnabled };
