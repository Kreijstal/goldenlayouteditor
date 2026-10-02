// --- ELF files (executables, shared objects, object files, kernel modules, firmware) ---
// Header, sections, segments, symbols (demangled), relocations and dynamic
// imports; Capstone disassembly of the code (for the ISA e_machine names, or one
// chosen by hand) with cross references; function detection for stripped
// binaries; and a memory map the user edits (ROM/flash, RAM, MMIO, …) that
// classifies the references, for bare-metal firmware. Read-only. Only this shell
// is in the bundle: the viewer (public/elf-viewer/) and Capstone (built to
// WebAssembly by ~/git/capstone-wasm/build.sh, from @kreijstal/capstone-wasm on jsDelivr) are loaded
// when a file is opened.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('ELF');
let _ctx = null;
let _viewerPromise = null;

function loadViewer() {
    if (!_viewerPromise) _viewerPromise = import('/elf-viewer/elf-viewer.js').catch(err => { _viewerPromise = null; throw err; });
    return _viewerPromise;
}

// Whether a file starts with \x7fELF: from its first bytes when browse mode kept them (file.head),
// else from its text (0x7f is ASCII, so a file read as text keeps it). Unknown -> null
function elfMagic(file) {
    if (!file) return null;
    const head = file.head || file.bytes;
    if (head instanceof Uint8Array) return head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    if (typeof file.content === 'string' && file.content.length) return file.content.startsWith('\x7fELF');
    return null;
}

// Extensionless files, .bin, .out: only when they are ELF
function hasElfMagic(file) {
    return elfMagic(file) === true;
}

// .elf, .so, .o, .ko, .axf: unless their bytes say otherwise (a file not read yet is given the benefit of the doubt)
function mayBeElf(file) {
    return elfMagic(file) !== false;
}

class ElfComponent {
    constructor(container, state) {
        this.container = container;
        this.fileId = (state && state.fileId) || null;
        this.fileData = this.fileId && _ctx ? _ctx.projectFiles[this.fileId] : null;
        this.root = container.element;
        this.root.style.cssText += 'height:100%;display:flex;flex-direction:column;overflow:hidden;background:#fff';
        this.root.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;flex-shrink:0">
  <span class="elf-title" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0"></span>
  <span class="elf-status" style="margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis"></span>
</div>
<div class="elf-host" style="flex:1;min-height:0;overflow:hidden"><div style="padding:20px;color:#555;font:13px sans-serif">Loading…</div></div>`;
        this.statusEl = this.root.querySelector('.elf-status');
        this.host = this.root.querySelector('.elf-host');
        this.root.querySelector('.elf-title').textContent = (this.fileData && this.fileData.name) || '';
        if (container.on) {
            container.on('destroy', () => { this.destroyed = true; if (this.viewer) this.viewer.destroy(); });
            container.on('resize', () => { if (this.viewer) this.viewer.resize(); });
        }
        this._init();
    }

    _relPath() {
        return _ctx.currentWorkspacePath && _ctx.getRelativePath ? _ctx.getRelativePath(this.fileId) : null;
    }

    // The file's bytes: kept in memory (browse mode, an in-memory file), else from the workspace
    async _readBytes() {
        const file = this.fileData;
        if (file.bytes instanceof Uint8Array) return file.bytes;
        const path = this._relPath();
        if (!path) throw new Error('ELF files need the server workspace');
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(_ctx.currentWorkspacePath + '/' + path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
    }

    async _init() {
        if (!this.fileData) return this._fail('No file selected.');
        try {
            const [mod, bytes] = await Promise.all([loadViewer(), this._readBytes()]);
            if (this.destroyed) return;
            this.host.textContent = '';
            const rel = this._relPath();
            this.viewer = mod.mountElfViewer(this.host, {
                bytes,
                name: this.fileData.name,
                // the memory map and ISA choice are kept per file: by its path, else its name and size
                storageKey: rel ? _ctx.currentWorkspacePath + '/' + rel : this.fileData.name + ':' + bytes.length,
                onStatus: (text, isError) => this._status(text, isError),
            });
            if (this.viewer.info) log.log(`Opened ${this.fileData.name}: ${this.viewer.info.class} ${this.viewer.info.machine} ${this.viewer.info.type}`);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the ELF file: ' + err.message);
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.title = text;
        this.statusEl.style.color = isError ? '#ffb4ab' : '#adbac7';
    }

    _fail(message) {
        this.host.innerHTML = '<div style="padding:20px;color:#a33;font:13px sans-serif;white-space:pre-wrap"></div>';
        this.host.firstChild.textContent = message;
        this._status('error', true);
    }
}

registerPlugin({
    id: 'elf',
    name: 'ELF viewer',
    components: {
        elfViewer: ElfComponent,
    },
    init(ctx) {
        _ctx = ctx;
    },
});

module.exports = { hasElfMagic, mayBeElf };
