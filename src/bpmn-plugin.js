// --- BPMN Plugin ---
// Edits BPMN 2.0 diagrams (.bpmn, .bpmn20.xml) in the bpmn-js Modeler
// (bpmn.io), loaded with its stylesheets from esm.sh on first use. The file is
// BPMN XML; saving writes the modeler's XML back over the WebSocket save the
// other editors use (or into the in-memory file when there is no workspace).
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');
const { insideArchive } = require('./browse-mode');

const log = createLogger('BPMN');
const BPMN_VERSION = '18.31.0';
const BPMN_BASE = `https://esm.sh/bpmn-js@${BPMN_VERSION}`;
const BPMN_RE = /\.(bpmn|bpmn20\.xml)$/i;

let _modelerPromise = null;

// The Modeler class; the stylesheets go in once
function loadModeler() {
    if (!_modelerPromise) {
        for (const css of ['diagram-js.css', 'bpmn-js.css', 'bpmn-font/css/bpmn-embedded.css']) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `${BPMN_BASE}/dist/assets/${css}`;
            document.head.appendChild(link);
        }
        _modelerPromise = import(`${BPMN_BASE}/lib/Modeler`).then(mod => mod.default)
            .catch(err => { _modelerPromise = null; throw err; });
    }
    return _modelerPromise;
}

// A process with only a start event, as the bpmn.io demo starts
function emptyDiagram(stem) {
    const id = 'Process_' + Math.random().toString(36).slice(2, 9);
    const name = String(stem || 'Process').replace(/[<&"]/g, '');
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${id}" name="${name}" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${id}">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="152" y="102" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

class BpmnComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = BpmnComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.dirty = false;
        // Bumped on every change, so a save knows whether edits came in meanwhile
        this.changes = 0;

        this.root = container.element;
        this.root.classList.add('bpmn-plugin-root');
        this._installStyles();
        this.root.innerHTML = `
<div class="bpmn-shell">
  <div class="bpmn-toolbar">
    <span class="bpmn-title"></span>
    <button type="button" class="bpmn-save" disabled title="Save (Ctrl+S)">Save</button>
    <button type="button" class="bpmn-fit" title="Fit the diagram to the view">Fit</button>
    <span class="bpmn-status"></span>
  </div>
  <div class="bpmn-host"><div class="bpmn-message">Loading…</div></div>
</div>`;
        this.titleEl = this.root.querySelector('.bpmn-title');
        this.saveBtn = this.root.querySelector('.bpmn-save');
        this.statusEl = this.root.querySelector('.bpmn-status');
        this.host = this.root.querySelector('.bpmn-host');
        this.titleEl.textContent = (this.fileData && this.fileData.name) || '';
        this.saveBtn.onclick = () => this._save();
        this.root.querySelector('.bpmn-fit').onclick = () => this._fit();
        this.root.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                e.stopPropagation();
                this._save();
            }
        }, true);
        this._resizeObserver = new ResizeObserver(() => {
            if (this.modeler) this.modeler.get('canvas').resized();
        });
        this._resizeObserver.observe(this.host);
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (BpmnComponent._styleInstalled) return;
        BpmnComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.bpmn-plugin-root{height:100%;background:#fff;overflow:hidden}
.bpmn-shell{display:flex;flex-direction:column;height:100%}
.bpmn-toolbar{display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2d333b;color:#e6edf3;border-bottom:1px solid #444c56;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden}
.bpmn-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.bpmn-toolbar button{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 10px;font:inherit;cursor:pointer}
.bpmn-toolbar button:hover:not(:disabled){background:#444c56}
.bpmn-toolbar button:disabled{opacity:.5;cursor:default}
.bpmn-status{margin-left:auto;color:#adbac7;font-size:12px;overflow:hidden;text-overflow:ellipsis}
.bpmn-status.error{color:#ffb4ab}
.bpmn-host{position:relative;flex:1;min-height:0;color:#000}
.bpmn-canvas{position:absolute;inset:0}
.bpmn-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#57606a;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.bpmn-message.error{color:#b42318}
`;
        document.head.appendChild(style);
    }

    _path() {
        if (!this.ctx || !this.fileData || !this.ctx.currentWorkspacePath) return null;
        return this.ctx.currentWorkspacePath + '/' + this.ctx.getRelativePath(this.fileId);
    }

    async _text() {
        const file = this.fileData;
        if (typeof file.content === 'string' && file.content.length) return file.content;
        const path = this._path();
        if (!path) return '';
        const resp = await fetch(await resolveFileUrl('/workspace-file?path=' + encodeURIComponent(path)));
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        return resp.text();
    }

    async _init() {
        if (!this.fileData) return this._fail('No BPMN file selected.');
        const path = this._path();
        // Inside an archive the file can be read but not written
        this.readOnly = !!path && insideArchive(path);
        let Modeler, xml;
        try {
            [Modeler, xml] = await Promise.all([loadModeler(), this._text()]);
        } catch (err) {
            log.error('Load failed:', err);
            return this._fail('Could not open the diagram: ' + err.message);
        }
        // An empty file starts as a new diagram
        const fresh = !xml.trim();
        if (fresh) xml = emptyDiagram(this.fileData.name.replace(BPMN_RE, ''));
        this.host.textContent = '';
        const el = document.createElement('div');
        el.className = 'bpmn-canvas';
        this.host.appendChild(el);
        this.modeler = new Modeler({ container: el });
        try {
            const { warnings } = await this.modeler.importXML(xml);
            if (warnings.length) log.warn(`${warnings.length} import warning(s):`, warnings);
        } catch (err) {
            log.error('Import failed:', err);
            this.modeler.destroy();
            this.modeler = null;
            return this._fail('Could not read the diagram: ' + err.message);
        }
        this._fit();
        this.modeler.on('commandStack.changed', () => this._onChange());
        this.saveBtn.hidden = this.readOnly;
        if (fresh && !this.readOnly) this._onChange();
        else this._status(this.readOnly ? 'Read-only (inside an archive)' : '');
        log.log(`Opened ${path || this.fileData.name}`);
    }

    _fit() {
        if (this.modeler) this.modeler.get('canvas').zoom('fit-viewport', 'auto');
    }

    _onChange() {
        if (this.readOnly) return;
        this.changes++;
        this.dirty = true;
        this.saveBtn.disabled = false;
        this._status('Unsaved changes');
    }

    async _save() {
        if (!this.modeler || this.readOnly || this._saving || !this.dirty) return;
        const ctx = this.ctx;
        const path = this._path();
        const changes = this.changes;
        this._saving = true;
        this.saveBtn.disabled = true;
        this._status('Saving…');
        try {
            const { xml } = await this.modeler.saveXML({ format: true });
            if (path) {
                if (!ctx.wsClient || !ctx.wsClient.isConnected()) throw new Error('not connected to the server');
                const slash = path.lastIndexOf('/');
                const result = await ctx.wsClient.wsRequest({
                    type: 'saveFile',
                    workspacePath: path.slice(0, slash) || '/',
                    relativePath: path.slice(slash + 1),
                    content: xml,
                });
                if (!result || !result.success) throw new Error((result && result.error) || 'save failed');
                // Keep the in-memory copy (and an open text editor) current
                ctx.setFileContent(this.fileId, xml);
                if (ctx.clearDirty) ctx.clearDirty(this.fileId);
            } else {
                // In-memory project: the file is saved with the project
                ctx.setFileContent(this.fileId, xml);
                if (ctx.markDirty) ctx.markDirty(this.fileId);
            }
            if (this.changes === changes) this.dirty = false;
            this.saveBtn.disabled = !this.dirty;
            this._status(`Saved ${new Date().toLocaleTimeString()}`);
            log.log(`Saved ${path || this.fileData.name} (${xml.length} chars)`);
        } catch (err) {
            log.error('Save failed:', err);
            this.saveBtn.disabled = false;
            this._status('Could not save: ' + err.message, true);
        } finally {
            this._saving = false;
        }
    }

    _status(text, isError) {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('error', !!isError);
    }

    _fail(message) {
        this.host.innerHTML = '<div class="bpmn-message error"></div>';
        this.host.firstChild.textContent = message;
    }

    _destroy() {
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this.modeler) this.modeler.destroy();
        this.modeler = null;
    }
}

registerPlugin({
    id: 'bpmn',
    name: 'BPMN (bpmn-js)',
    components: {
        bpmnEditor: BpmnComponent,
    },
    newFileTypes: [{ label: 'BPMN diagram', ext: 'bpmn', content: stem => emptyDiagram(stem) }],
    contextMenuItems: [{
        label: 'Open as BPMN diagram',
        canHandle: (fileName) => BPMN_RE.test(fileName || ''),
        action: (fileId) => {
            const ctx = BpmnComponent._ctx;
            const file = ctx && ctx.projectFiles[fileId];
            if (!file) return;
            ctx.openEditorTab('bpmnEditor', { fileId }, `${file.name} [bpmn]`, 'bpmn-' + fileId);
        },
    }],
    init(ctx) {
        BpmnComponent._ctx = ctx;
    },
});
