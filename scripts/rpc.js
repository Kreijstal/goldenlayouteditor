#!/usr/bin/env node
// Tiny CLI to drive a running editor over the WebSocket RPC relay.
//
// Usage:
//   node scripts/rpc.js call <method> [json-args...]
//   node scripts/rpc.js eval '<js code>'
//   node scripts/rpc.js list
//
// Examples:
//   node scripts/rpc.js call workspace.path
//   node scripts/rpc.js call tabs.open '"README.md"'
//   node scripts/rpc.js call tabs.open '"README.md"' '{"mode":"hex"}'
//   node scripts/rpc.js call files.setContent '"README.md"' '"# Hi\n"'
//   node scripts/rpc.js eval 'return app.tabs.list().map(t => t.title);'
//   node scripts/rpc.js list                 # shortcut for tabs.list
//
// Environment:
//   RPC_URL   WebSocket URL (default: ws://localhost:3000/ws)
//   RPC_TIMEOUT_MS   per-call timeout (default: 30000)

const WebSocket = require('ws');

const URL = process.env.RPC_URL || 'ws://localhost:3000/ws';
const TIMEOUT = parseInt(process.env.RPC_TIMEOUT_MS || '30000', 10);

function die(msg, code = 1) {
    console.error(msg);
    process.exit(code);
}

const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === '-h' || cmd === '--help') {
    console.error(require('fs').readFileSync(__filename, 'utf8').split('\n')
        .filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
    process.exit(cmd ? 0 : 1);
}

function buildMessage() {
    if (cmd === 'call') {
        const [method, ...jsonArgs] = rest;
        if (!method) die('usage: rpc.js call <method> [json-args...]');
        let args;
        try {
            args = jsonArgs.map(s => JSON.parse(s));
        } catch (err) {
            die(`invalid JSON arg: ${err.message}`);
        }
        return { type: 'clientAction', method, args };
    }
    if (cmd === 'eval') {
        const code = rest.join(' ');
        if (!code) die('usage: rpc.js eval "<js code>"');
        return { type: 'clientEval', code };
    }
    if (cmd === 'list') {
        return { type: 'clientAction', method: 'tabs.list', args: [] };
    }
    die(`unknown command: ${cmd}`);
}

const request = buildMessage();

const ws = new WebSocket(URL);
let timer;
let done = false;

function finish(code, payload) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { ws.close(); } catch (_) { /* ignore */ }
    if (payload !== undefined) {
        const out = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        if (code === 0) console.log(out); else console.error(out);
    }
    process.exit(code);
}

ws.on('open', () => {
    request.id = 1;
    ws.send(JSON.stringify(request));
    timer = setTimeout(() => finish(2, `timeout after ${TIMEOUT}ms`), TIMEOUT);
});

ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (msg.type === 'serverConfig') return; // hello from server on connect
    const expected = request.type === 'clientAction' ? 'clientActionResult' : 'clientEvalResult';
    if (msg.type !== expected || msg.id !== request.id) return;
    if (msg.error) finish(1, msg.error);
    else finish(0, msg.result);
});

ws.on('error', (err) => finish(3, `ws error: ${err.message}`));
ws.on('close', () => {
    if (!done) finish(4, 'socket closed before reply');
});
