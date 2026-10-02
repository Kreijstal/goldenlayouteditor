// --- Emulator Plugin ---
// Runs game ROMs (.nes, .sfc, .gb, .gba, .md, ...) with EmulatorJS: its own UI
// for controls, save states, fullscreen and gamepads, a libretro core per
// system. Each tab runs EmulatorJS in its own srcdoc iframe, since it is driven
// by window.EJS_* globals and one emulator per page; the ROM goes in as a
// blob: URL made from the file's bytes. Disc images and other files that could
// be for several systems run as the system picked in the tab (or the context
// menu's "Run in emulator as ...").
const { registerPlugin } = require('./plugins');
const { resolveFileUrl } = require('./archive-fallback');
const { createLogger } = require('./debug');

const log = createLogger('Emulator');
// EmulatorJS's data/ folder (loader.js, emulator.min.js, cores/): @kreijstal/emulatorjs on jsDelivr
const EMULATORJS_DATA = 'https://cdn.jsdelivr.net/npm/@kreijstal/emulatorjs@4.2.3-build.1/';

// EmulatorJS system ids (EJS_core) and their names
const SYSTEMS = {
    nes: 'NES / Famicom',
    snes: 'Super Nintendo',
    n64: 'Nintendo 64',
    gb: 'Game Boy / Color',
    gba: 'Game Boy Advance',
    nds: 'Nintendo DS',
    vb: 'Virtual Boy',
    segaMS: 'Master System / SG-1000',
    segaMD: 'Mega Drive / Genesis',
    segaGG: 'Game Gear',
    sega32x: 'Sega 32X',
    segaSaturn: 'Sega Saturn',
    psx: 'PlayStation',
    pce: 'PC Engine / TurboGrafx-16',
    ngp: 'Neo Geo Pocket / Color',
    ws: 'WonderSwan / Color',
    lynx: 'Atari Lynx',
    jaguar: 'Atari Jaguar',
    atari2600: 'Atari 2600',
    atari7800: 'Atari 7800',
    coleco: 'ColecoVision',
};

// Extensions that say which system a file is for
const ROM_SYSTEMS = {
    nes: 'nes', unf: 'nes', unif: 'nes',
    sfc: 'snes', smc: 'snes', fig: 'snes', swc: 'snes',
    n64: 'n64', z64: 'n64', v64: 'n64',
    gb: 'gb', gbc: 'gb',
    gba: 'gba', agb: 'gba',
    nds: 'nds',
    vb: 'vb', vboy: 'vb',
    sms: 'segaMS', sg: 'segaMS',
    md: 'segaMD', gen: 'segaMD', smd: 'segaMD',
    gg: 'segaGG',
    '32x': 'sega32x',
    pbp: 'psx',
    pce: 'pce',
    ngp: 'ngp', ngc: 'ngp',
    ws: 'ws', wsc: 'ws',
    lnx: 'lynx',
    j64: 'jaguar', jag: 'jaguar',
    a26: 'atari2600',
    a78: 'atari7800',
    col: 'coleco',
};

// Extensions shared by several systems (disc images, raw dumps): run as the one picked.
// Only systems whose cores start without a BIOS file are offered.
const AMBIGUOUS = {
    iso: ['psx', 'segaSaturn'],
    chd: ['psx', 'segaSaturn'],
    img: ['psx'],
    bin: ['psx', 'segaSaturn', 'segaMD', 'atari2600', 'atari7800'],
};

const extOf = (name) => ((name || '').match(/\.([^./]+)$/) || [, ''])[1].toLowerCase();
let _ctx = null;

function installStyles() {
    if (document.getElementById('emu-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'emu-viewer-style';
    style.textContent = `
.emu-root{height:100%;display:flex;flex-direction:column;background:#111;color:#e5e7eb;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.emu-toolbar{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#1f2937;border-bottom:1px solid #374151;white-space:nowrap;overflow:auto}
.emu-toolbar button,.emu-toolbar select{background:#374151;color:#e5e7eb;border:1px solid #4b5563;border-radius:4px;padding:3px 8px;font:inherit;cursor:pointer}
.emu-toolbar button:hover{background:#4b5563}
.emu-title{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.emu-status{margin-left:auto;color:#9ca3af;font-size:12px}
.emu-stage{flex:1;min-height:0;position:relative;background:#000}
.emu-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.emu-message{padding:20px;color:#9ca3af;text-align:center}
.emu-message.error{color:#fecaca}
`;
    document.head.appendChild(style);
}

// The page inside the iframe: EmulatorJS's loader, configured through EJS_* globals
function emulatorPage(config) {
    const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    const data = new URL(EMULATORJS_DATA, location.href).href;
    return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#game{width:100%;height:100%}</style>
</head><body><div id="game"></div><script>
window.EJS_player = '#game';
window.EJS_pathtodata = ${json(data)};
window.EJS_core = ${json(config.system)};
window.EJS_gameUrl = ${json(config.gameUrl)};
window.EJS_gameName = ${json(config.gameName)};
window.EJS_color = '#2f6fde';
</script><script src="${data}loader.js"></script></body></html>`;
}

class EmulatorViewer {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId || null;
        this.file = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.file && this.file.name) || 'game';
        const ext = extOf(this.fileName);
        this.system = this.state.system || ROM_SYSTEMS[ext] || null;
        this.choices = AMBIGUOUS[ext] || Object.keys(SYSTEMS);
        this.bytes = null;
        this.frame = null;
        this.gameUrl = null;

        installStyles();
        this.root = container.element;
        this.root.classList.add('emu-root');
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    _buildUI() {
        this.root.innerHTML = '';
        const bar = document.createElement('div');
        bar.className = 'emu-toolbar';
        const title = document.createElement('span');
        title.className = 'emu-title';
        title.textContent = this.fileName;
        // The system: fixed by the extension, or chosen for disc images and the like
        this.systemSelect = document.createElement('select');
        this.systemSelect.title = 'System to run the file as';
        if (!this.system) this.systemSelect.appendChild(new Option('Run as…', ''));
        const ids = this.choices.includes(this.system) || !this.system ? this.choices : [this.system, ...this.choices];
        for (const id of ids) this.systemSelect.appendChild(new Option(SYSTEMS[id] || id, id));
        this.systemSelect.value = this.system || '';
        this.systemSelect.addEventListener('change', () => {
            this.system = this.systemSelect.value || null;
            this._start();
        });
        const restart = document.createElement('button');
        restart.type = 'button';
        restart.textContent = 'Restart';
        restart.title = 'Reload the emulator with this file';
        restart.addEventListener('click', () => this._start());
        this.statusEl = document.createElement('span');
        this.statusEl.className = 'emu-status';
        bar.append(title, this.systemSelect, restart, this.statusEl);
        this.stage = document.createElement('div');
        this.stage.className = 'emu-stage';
        this.root.append(bar, this.stage);
    }

    _message(text, isError) {
        this._stop();
        this.stage.innerHTML = `<div class="emu-message${isError ? ' error' : ''}"></div>`;
        this.stage.firstChild.textContent = text;
    }

    // The ROM's bytes: kept by browse mode for files read as text, otherwise from the workspace
    async _readBytes() {
        if (!this.file) throw new Error('no file selected');
        if (this.file.bytes) return this.file.bytes;
        if (!_ctx.currentWorkspacePath) throw new Error('reading a project file needs the server workspace');
        const url = await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + _ctx.getRelativePath(this.fileId)));
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        try {
            this.statusEl.textContent = 'Reading the file…';
            this.bytes = await this._readBytes();
            this.statusEl.textContent = `${(this.bytes.length / 1024).toFixed(0)} KiB`;
            this._start();
        } catch (err) {
            log.error(err);
            this._message(`Could not read ${this.fileName}: ${err.message}`, true);
        }
    }

    _start() {
        if (!this.bytes) return;
        if (!this.system) {
            this._message('This kind of file is used by several systems: pick the one to run it as above.');
            return;
        }
        this._stop();
        this.stage.innerHTML = '';
        // EmulatorJS revokes the URL once it has read it, so a new one for each start
        this.gameUrl = URL.createObjectURL(new Blob([this.bytes]));
        this.frame = document.createElement('iframe');
        this.frame.allow = 'fullscreen; gamepad; autoplay; screen-wake-lock';
        this.frame.allowFullscreen = true;
        this.frame.title = `${this.fileName} (${SYSTEMS[this.system] || this.system})`;
        // The file name, extension included, is the name the core is given the ROM under
        // (some cores go by the extension) and the name save states are kept under
        this.frame.srcdoc = emulatorPage({ system: this.system, gameUrl: this.gameUrl, gameName: this.fileName });
        this.stage.appendChild(this.frame);
    }

    _stop() {
        if (this.frame) {
            // Write the game's battery saves to EmulatorJS's storage before the frame goes
            try {
                const emu = this.frame.contentWindow && this.frame.contentWindow.EJS_emulator;
                if (emu && emu.started) emu.gameManager.saveSaveFiles();
            } catch (_) { /* ignore */ }
            this.frame.remove();
            this.frame = null;
        }
        if (this.gameUrl) {
            URL.revokeObjectURL(this.gameUrl);
            this.gameUrl = null;
        }
    }

    _destroy() {
        this._stop();
        this.bytes = null;
    }
}

function openEmulator(fileId, system) {
    const file = _ctx && _ctx.projectFiles[fileId];
    if (!file) return;
    const tag = system ? `${SYSTEMS[system]}` : 'emulator';
    _ctx.openEditorTab('emulatorViewer', system ? { fileId, system } : { fileId }, `${file.name} [${tag}]`,
        system ? `emu-${system}-${fileId}` : 'emu-' + fileId);
}

// "Run in emulator as <system>" for each system a disc image or the like could be for
const systemChoices = [...new Set(Object.values(AMBIGUOUS).flat())].map(system => ({
    label: `Run in emulator as ${SYSTEMS[system]}`,
    canHandle: (fileName) => (AMBIGUOUS[extOf(fileName)] || []).includes(system),
    action: (fileId) => openEmulator(fileId, system),
}));

registerPlugin({
    id: 'emulator',
    name: 'Game emulator (EmulatorJS)',
    components: {
        emulatorViewer: EmulatorViewer,
    },
    contextMenuItems: [{
        label: 'Run in emulator',
        canHandle: (fileName) => !!ROM_SYSTEMS[extOf(fileName)],
        action: (fileId) => openEmulator(fileId),
    }, ...systemChoices],
    init(ctx) {
        _ctx = ctx;
    },
});
