// --- Terminal Plugin ---
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const log = createLogger('Terminal');

const XTERM_VERSION = '5.5.0';
const FIT_VERSION = '0.10.0';
const IMAGE_VERSION = '0.8.0';

let Terminal = null;
let FitAddon = null;
let ImageAddon = null;
let _initPromise = null;

async function ensureXtermLoaded() {
    if (Terminal) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        log.log('Loading xterm.js from esm.sh...');

        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://esm.sh/@xterm/xterm@${XTERM_VERSION}/css/xterm.css`;
        document.head.appendChild(link);

        const [xtermMod, fitMod, imageMod] = await Promise.all([
            import(`https://esm.sh/@xterm/xterm@${XTERM_VERSION}`),
            import(`https://esm.sh/@xterm/addon-fit@${FIT_VERSION}`),
            import(`https://esm.sh/@xterm/addon-image@${IMAGE_VERSION}`).catch(() => null),
        ]);

        Terminal = xtermMod.Terminal;
        FitAddon = fitMod.FitAddon;
        if (imageMod) ImageAddon = imageMod.ImageAddon;

        log.log('xterm.js loaded:', XTERM_VERSION);
    })();

    return _initPromise;
}

class TerminalComponent {
    constructor(container, state) {
        this.rootElement = container.element;
        this.rootElement.style.cssText = 'background:#1e1e1e;padding:0;overflow:hidden;';
        this.wsClient = this.constructor._wsClient;
        this.sessionId = state.sessionId || ('pty-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5));
        this.terminal = null;
        this.fitAddon = null;
        this._msgHandler = null;

        this._init(container);
    }

    async _init(container) {
        try {
            await ensureXtermLoaded();
        } catch (err) {
            this.rootElement.innerHTML = `<div style="padding:20px;color:#f88;">Failed to load xterm.js: ${err.message}</div>`;
            return;
        }

        this.terminal = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
            theme: {
                background: '#1e1e1e',
                foreground: '#d4d4d4',
                cursor: '#aeafad',
            },
            allowProposedApi: true,
        });

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);

        if (ImageAddon) {
            try {
                this.terminal.loadAddon(new ImageAddon());
            } catch (e) {
                log.warn('Image addon failed:', e);
            }
        }

        this.terminal.open(this.rootElement);

        // Let the terminal handle Ctrl+key combos instead of the browser
        this.terminal.attachCustomKeyEventHandler((e) => {
            if (e.ctrlKey && e.type === 'keydown') {
                // Allow browser Ctrl+Shift+I (dev tools) and Ctrl+Shift+J (console)
                if (e.shiftKey && (e.key === 'I' || e.key === 'J')) return false;
                // Everything else (Ctrl+R, Ctrl+C, Ctrl+D, etc.) goes to terminal
                return true;
            }
            return true;
        });

        setTimeout(() => this.fitAddon.fit(), 50);
        container.on('resize', () => {
            if (this.fitAddon) {
                this.fitAddon.fit();
                this._sendResize();
            }
        });

        if (this.wsClient && this.wsClient.isConnected()) {
            await this._connectPTY();
        } else {
            this._startLocalMode();
        }

        container.on('destroy', () => this._destroy());
    }

    async _connectPTY() {
        const dims = this.fitAddon ? { cols: this.terminal.cols, rows: this.terminal.rows } : {};

        try {
            const result = await this.wsClient.wsRequest({
                type: 'termSpawn',
                sessionId: this.sessionId,
                ...dims,
            });

            if (result.error) {
                log.warn('PTY spawn failed:', result.error);
                this._startLocalMode();
                return;
            }

            log.log('PTY connected:', this.sessionId);

            this.terminal.onData((data) => {
                if (this.wsClient.isConnected()) {
                    this.wsClient.wsRawSend({ type: 'termInput', sessionId: this.sessionId, data });
                }
            });

            this._msgHandler = (msg) => {
                if (msg.type === 'termData' && msg.sessionId === this.sessionId) {
                    this.terminal.write(msg.data);
                }
                if (msg.type === 'termExit' && msg.sessionId === this.sessionId) {
                    this.terminal.writeln('\r\n\x1b[33m[Process exited]\x1b[0m');
                }
            };
            this.wsClient.addMessageListener(this._msgHandler);

        } catch (err) {
            log.warn('PTY connection failed:', err);
            this._startLocalMode();
        }
    }

    _startLocalMode() {
        this.terminal.writeln('Terminal (no server connection)');
        this.terminal.writeln('Type JavaScript to evaluate:\r\n');
        let line = '';
        this.terminal.write('> ');
        this.terminal.onData((data) => {
            for (const ch of data) {
                if (ch === '\r') {
                    this.terminal.writeln('');
                    if (line.trim()) {
                        try {
                            const result = eval(line); // eslint-disable-line no-eval
                            this.terminal.writeln('\x1b[32m' + String(result) + '\x1b[0m');
                        } catch (e) {
                            this.terminal.writeln('\x1b[31m' + e.message + '\x1b[0m');
                        }
                    }
                    line = '';
                    this.terminal.write('> ');
                } else if (ch === '\x7f') {
                    if (line.length > 0) {
                        line = line.slice(0, -1);
                        this.terminal.write('\b \b');
                    }
                } else if (ch >= ' ') {
                    line += ch;
                    this.terminal.write(ch);
                }
            }
        });
    }

    _sendResize() {
        if (this.wsClient && this.wsClient.isConnected() && this.terminal) {
            this.wsClient.wsRawSend({
                type: 'termResize',
                sessionId: this.sessionId,
                cols: this.terminal.cols,
                rows: this.terminal.rows,
            });
        }
    }

    _destroy() {
        if (this._msgHandler) {
            this.wsClient.removeMessageListener(this._msgHandler);
        }
        if (this.wsClient && this.wsClient.isConnected()) {
            this.wsClient.wsRawSend({ type: 'termKill', sessionId: this.sessionId });
        }
        if (this.terminal) {
            this.terminal.dispose();
        }
        log.log('Terminal destroyed:', this.sessionId);
    }
}

// Register as plugin
registerPlugin({
    id: 'terminal',
    name: 'Terminal',
    components: {
        terminal: TerminalComponent,
    },
    toolbarButtons: [
        { label: '>_', title: 'Open Terminal', style: 'font-family:monospace;font-weight:bold;' },
    ],
    init(ctx) {
        // Inject wsClient into the component class so constructor can access it
        TerminalComponent._wsClient = ctx.wsClient;
    },
});
