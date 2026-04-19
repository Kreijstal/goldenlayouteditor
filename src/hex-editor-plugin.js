// --- Hex Editor Plugin ---
// Virtualized, editable hex viewer with address navigation.
const { registerPlugin } = require('./plugins');

const ROW_HEIGHT = 18;
const MAX_LOAD_BYTES = 256 * 1024 * 1024; // 256MB safety cap

function parseHexAddress(input, currentOffset, totalSize) {
    let str = (input || '').trim();
    if (!str) return null;
    let relative = 0;
    if (str[0] === '+') { relative = 1; str = str.slice(1).trim(); }
    else if (str[0] === '-') { relative = -1; str = str.slice(1).trim(); }

    let value;
    if (/^0x[0-9a-fA-F]+$/.test(str)) value = parseInt(str.slice(2), 16);
    else if (/^[0-9a-fA-F]+h$/i.test(str)) value = parseInt(str.slice(0, -1), 16);
    else if (/^\d+$/.test(str) && !relative) value = parseInt(str, 10);
    else if (/^[0-9a-fA-F]+$/.test(str)) value = parseInt(str, 16);
    else return null;

    if (!Number.isFinite(value)) return null;
    let target = relative ? currentOffset + relative * value : value;
    if (target < 0) target = 0;
    if (totalSize > 0 && target >= totalSize) target = totalSize - 1;
    return target;
}

function bytesToBase64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
}

function escapeAscii(b) {
    if (b < 0x20 || b > 0x7e) return '.';
    const ch = String.fromCharCode(b);
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '&') return '&amp;';
    return ch;
}

class HexEditorComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.fileId = this.state.fileId;
        this.bytesPerRow = this.state.bytesPerRow || 16;
        this.cursorOffset = this.state.cursorOffset || 0;
        this.nibbleHigh = null; // first nibble entered when editing
        this.bytes = null;
        this.dirty = false;

        const ctx = HexEditorComponent._ctx;
        this.ctx = ctx;
        this.fileData = ctx && ctx.projectFiles[this.fileId];

        this.root = container.element;
        if (!this.fileData) {
            this.root.textContent = `Hex Editor: file not found (${this.fileId})`;
            return;
        }

        this._buildUI();
        if (container.on) {
            container.on('resize', () => this._render());
            container.on('destroy', () => this._onDestroy());
        }
        this._loadBytes();
    }

    _onDestroy() {
        if (this.dirty && !confirm(`Discard unsaved hex edits to ${this.fileData.name}?`)) {
            // Can't actually cancel destroy in GoldenLayout; warn only.
        }
    }

    _buildUI() {
        this.root.style.cssText = 'display:flex;flex-direction:column;height:100%;background:#1e1e1e;color:#d4d4d4;font-family:monospace;font-size:13px;overflow:hidden;';

        // Toolbar
        const tb = document.createElement('div');
        tb.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 10px;background:#252525;border-bottom:1px solid #333;flex-shrink:0;font-family:sans-serif;font-size:12px;';

        tb.appendChild(this._label('Goto:'));
        this.gotoInput = document.createElement('input');
        this.gotoInput.type = 'text';
        this.gotoInput.placeholder = '0x100, +16, -0x20';
        this.gotoInput.title = 'Absolute: 0x100, 256, 100h   Relative: +16, -0x20';
        this.gotoInput.style.cssText = 'background:#1e1e1e;color:#ddd;border:1px solid #555;padding:3px 6px;width:160px;font-family:monospace;outline:none;';
        this.gotoInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this._handleGoto(); }
        });
        tb.appendChild(this.gotoInput);

        const gotoBtn = this._button('Go', () => this._handleGoto());
        tb.appendChild(gotoBtn);

        tb.appendChild(this._label('Bytes/row:'));
        this.bprSelect = document.createElement('select');
        this.bprSelect.style.cssText = 'background:#1e1e1e;color:#ddd;border:1px solid #555;padding:2px;';
        for (const v of [8, 16, 24, 32]) {
            const o = document.createElement('option');
            o.value = v; o.textContent = v;
            if (v === this.bytesPerRow) o.selected = true;
            this.bprSelect.appendChild(o);
        }
        this.bprSelect.onchange = () => {
            this.bytesPerRow = parseInt(this.bprSelect.value, 10);
            this._updateInnerHeight();
            this._render();
        };
        tb.appendChild(this.bprSelect);

        this.saveBtn = this._button('Save', () => this._save());
        this.saveBtn.disabled = true;
        tb.appendChild(this.saveBtn);

        const spacer = document.createElement('div');
        spacer.style.flex = '1';
        tb.appendChild(spacer);

        this.cursorEl = document.createElement('div');
        this.cursorEl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px;';
        tb.appendChild(this.cursorEl);

        this.statusEl = document.createElement('div');
        this.statusEl.style.cssText = 'color:#888;font-size:11px;min-width:100px;text-align:right;';
        tb.appendChild(this.statusEl);

        this.root.appendChild(tb);

        // Scroll container
        this.scrollEl = document.createElement('div');
        this.scrollEl.style.cssText = 'flex:1;overflow-y:auto;outline:none;position:relative;';
        this.scrollEl.tabIndex = 0;
        this.scrollEl.addEventListener('scroll', () => this._render());
        this.scrollEl.addEventListener('keydown', (e) => this._handleKey(e));
        this.scrollEl.addEventListener('click', (e) => {
            this.scrollEl.focus();
            const t = e.target.closest('[data-off]');
            if (t) {
                const off = parseInt(t.getAttribute('data-off'), 10);
                if (!isNaN(off)) {
                    this.cursorOffset = off;
                    this.nibbleHigh = null;
                    this._render();
                }
            }
        });

        this.innerEl = document.createElement('div');
        this.innerEl.style.cssText = 'position:relative;';
        this.scrollEl.appendChild(this.innerEl);

        this.root.appendChild(this.scrollEl);
    }

    _label(text) {
        const el = document.createElement('span');
        el.textContent = text;
        el.style.color = '#999';
        return el;
    }

    _button(text, onClick) {
        const b = document.createElement('button');
        b.textContent = text;
        b.style.cssText = 'background:#3a3a3a;color:#eee;border:1px solid #555;padding:3px 10px;font-size:12px;cursor:pointer;';
        b.addEventListener('click', onClick);
        return b;
    }

    async _loadBytes() {
        this.statusEl.textContent = 'Loading…';
        try {
            const workspacePath = this.ctx.currentWorkspacePath;
            const relPath = this.ctx.getRelativePath(this.fileId);
            if (workspacePath && relPath) {
                const url = '/workspace-file?path=' + encodeURIComponent(workspacePath + '/' + relPath);
                const headResp = await fetch(url, { method: 'HEAD' });
                const sizeHeader = headResp.headers.get('content-length');
                const size = sizeHeader ? parseInt(sizeHeader, 10) : null;
                if (size !== null && size > MAX_LOAD_BYTES) {
                    this.statusEl.textContent = `File too large (${size} bytes)`;
                    return;
                }
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buf = await resp.arrayBuffer();
                this.bytes = new Uint8Array(buf);
                this.loadedFromDisk = true;
            } else {
                // In-memory: encode the string content as UTF-8
                this.bytes = new TextEncoder().encode(this.fileData.content || '');
                this.loadedFromDisk = false;
            }
            if (this.cursorOffset >= this.bytes.length) {
                this.cursorOffset = Math.max(0, this.bytes.length - 1);
            }
            this._updateInnerHeight();
            this._updateStatus();
            this._render();
            this._scrollToCursor();
            this.scrollEl.focus();
        } catch (err) {
            this.statusEl.textContent = `Error: ${err.message}`;
        }
    }

    _updateInnerHeight() {
        const total = this.bytes ? this.bytes.length : 0;
        const totalRows = Math.max(1, Math.ceil(total / this.bytesPerRow));
        this.innerEl.style.height = (totalRows * ROW_HEIGHT) + 'px';
    }

    _updateStatus() {
        if (!this.bytes) return;
        const off = this.cursorOffset;
        const b = this.bytes[off];
        const bStr = b !== undefined ? `0x${b.toString(16).padStart(2, '0')} (${b})` : '—';
        this.cursorEl.textContent = `@ 0x${off.toString(16)} / ${off}  ${bStr}`;
        this.statusEl.textContent = `${this.bytes.length} bytes${this.dirty ? ' •' : ''}`;
    }

    _render() {
        if (!this.bytes) return;
        const bytes = this.bytes;
        const total = bytes.length;
        const visTop = this.scrollEl.scrollTop;
        const visHeight = this.scrollEl.clientHeight;
        const totalRows = Math.ceil(total / this.bytesPerRow);
        const startRow = Math.max(0, Math.floor(visTop / ROW_HEIGHT) - 5);
        const endRow = Math.min(totalRows, Math.ceil((visTop + visHeight) / ROW_HEIGHT) + 5);

        const offWidth = Math.max(8, (total || 1).toString(16).length);
        const frag = document.createDocumentFragment();

        for (let r = startRow; r < endRow; r++) {
            const row = document.createElement('div');
            row.style.cssText = `position:absolute;top:${r * ROW_HEIGHT}px;left:0;right:0;height:${ROW_HEIGHT}px;line-height:${ROW_HEIGHT}px;white-space:pre;padding:0 10px;`;

            const base = r * this.bytesPerRow;
            let html = `<span style="color:#666;">${base.toString(16).padStart(offWidth, '0')}</span>  `;

            for (let c = 0; c < this.bytesPerRow; c++) {
                const off = base + c;
                if (off < total) {
                    const b = bytes[off];
                    const isCur = off === this.cursorOffset;
                    const style = isCur ? 'background:#4a6a8a;color:#fff;' : '';
                    html += `<span data-off="${off}" style="${style}">${b.toString(16).padStart(2, '0')}</span>`;
                } else {
                    html += '  ';
                }
                html += (c === (this.bytesPerRow >> 1) - 1) ? '  ' : ' ';
            }

            html += ' |';
            for (let c = 0; c < this.bytesPerRow; c++) {
                const off = base + c;
                if (off < total) {
                    const b = bytes[off];
                    const isCur = off === this.cursorOffset;
                    const style = isCur ? 'background:#4a6a8a;color:#fff;' : '';
                    html += `<span data-off="${off}" style="${style}">${escapeAscii(b)}</span>`;
                } else {
                    html += ' ';
                }
            }
            html += '|';

            row.innerHTML = html;
            frag.appendChild(row);
        }

        this.innerEl.innerHTML = '';
        this.innerEl.appendChild(frag);
        this._updateStatus();
    }

    _handleKey(e) {
        if (!this.bytes) return;
        const total = this.bytes.length;
        if (total === 0) return;
        const rowSize = this.bytesPerRow;
        let handled = true;

        if (e.key === 'ArrowLeft') this._moveCursor(-1);
        else if (e.key === 'ArrowRight') this._moveCursor(1);
        else if (e.key === 'ArrowUp') this._moveCursor(-rowSize);
        else if (e.key === 'ArrowDown') this._moveCursor(rowSize);
        else if (e.key === 'PageUp') this._moveCursor(-rowSize * this._pageRows());
        else if (e.key === 'PageDown') this._moveCursor(rowSize * this._pageRows());
        else if (e.key === 'Home' && e.ctrlKey) this._setCursor(0);
        else if (e.key === 'End' && e.ctrlKey) this._setCursor(total - 1);
        else if (e.key === 'Home') this._setCursor(this.cursorOffset - (this.cursorOffset % rowSize));
        else if (e.key === 'End') this._setCursor(Math.min(total - 1, this.cursorOffset - (this.cursorOffset % rowSize) + rowSize - 1));
        else if (e.key === 'Escape') this.nibbleHigh = null;
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { this._save(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
            this.gotoInput.focus();
            this.gotoInput.select();
        }
        else if (/^[0-9a-fA-F]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
            const nibble = parseInt(e.key, 16);
            const cur = this.bytes[this.cursorOffset] || 0;
            if (this.nibbleHigh === null) {
                this.bytes[this.cursorOffset] = (nibble << 4) | (cur & 0x0f);
                this.nibbleHigh = nibble;
            } else {
                this.bytes[this.cursorOffset] = (cur & 0xf0) | nibble;
                this.nibbleHigh = null;
                if (this.cursorOffset < total - 1) this.cursorOffset++;
            }
            this._markDirty();
        } else {
            handled = false;
        }

        if (handled) {
            e.preventDefault();
            this._scrollToCursor();
            this._render();
        }
    }

    _pageRows() {
        return Math.max(1, Math.floor(this.scrollEl.clientHeight / ROW_HEIGHT) - 2);
    }

    _setCursor(off) {
        this.cursorOffset = Math.max(0, Math.min(this.bytes.length - 1, off));
        this.nibbleHigh = null;
    }

    _moveCursor(delta) {
        this._setCursor(this.cursorOffset + delta);
    }

    _scrollToCursor() {
        const row = Math.floor(this.cursorOffset / this.bytesPerRow);
        const top = row * ROW_HEIGHT;
        const visTop = this.scrollEl.scrollTop;
        const visHeight = this.scrollEl.clientHeight;
        if (top < visTop) this.scrollEl.scrollTop = top;
        else if (top + ROW_HEIGHT > visTop + visHeight) this.scrollEl.scrollTop = top + ROW_HEIGHT - visHeight;
    }

    _markDirty() {
        if (!this.dirty) {
            this.dirty = true;
            this.saveBtn.disabled = false;
        }
        this._updateStatus();
    }

    _handleGoto() {
        const target = parseHexAddress(this.gotoInput.value, this.cursorOffset, this.bytes ? this.bytes.length : 0);
        if (target === null) {
            this.statusEl.textContent = 'Invalid address';
            return;
        }
        this._setCursor(target);
        this._scrollToCursor();
        this._render();
        this.scrollEl.focus();
    }

    async _save() {
        if (!this.bytes || !this.dirty) return;
        const ctx = this.ctx;
        try {
            this.saveBtn.disabled = true;
            this.statusEl.textContent = 'Saving…';

            const workspacePath = ctx.currentWorkspacePath;
            const relPath = ctx.getRelativePath(this.fileId);

            if (workspacePath && relPath) {
                const result = await ctx.wsClient.wsRequest({
                    type: 'saveFile',
                    workspacePath,
                    relativePath: relPath,
                    content: bytesToBase64(this.bytes),
                    encoding: 'base64',
                });
                if (!result || !result.success) {
                    throw new Error((result && result.error) || 'Save failed');
                }
                // Keep in-memory content in sync for non-binary files
                if (!this.fileData.viewType) {
                    try {
                        this.fileData.content = new TextDecoder('utf-8', { fatal: false }).decode(this.bytes);
                    } catch (_) { /* ignore */ }
                }
            } else {
                // In-memory file: write bytes back as UTF-8 string
                this.fileData.content = new TextDecoder('utf-8', { fatal: false }).decode(this.bytes);
                if (ctx.markDirty) ctx.markDirty(this.fileId);
            }

            this.dirty = false;
            this._updateStatus();
        } catch (err) {
            this.saveBtn.disabled = false;
            this.statusEl.textContent = `Save failed: ${err.message}`;
        }
    }
}

registerPlugin({
    id: 'hex-editor',
    name: 'Hex Editor',
    components: {
        hexEditor: HexEditorComponent,
    },
    contextMenuItems: [{
        label: 'Open as Hex Editor',
        action: (fileId) => {
            const ctx = HexEditorComponent._ctx;
            if (!ctx) return;
            const file = ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab(
                'hexEditor',
                { fileId },
                `${file.name} [hex]`,
                'hex-' + fileId
            );
        },
    }],
    init(ctx) {
        HexEditorComponent._ctx = ctx;
    },
});

module.exports = { parseHexAddress };
