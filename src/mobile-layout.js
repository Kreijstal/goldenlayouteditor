// --- Mobile Layout ---
// Provides a simple navigation-stack UI for mobile devices.
// Instead of GoldenLayout's drag-and-drop panels, mobile shows one
// fullscreen panel at a time with a header bar for navigation.

const { createLogger } = require('./debug');
const log = createLogger('Mobile');

/**
 * Detect if the current device should use mobile layout.
 * Uses viewport width + touch capability as heuristics.
 */
function isMobile() {
    return window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 1024);
}

/**
 * Creates a fake GoldenLayout-like container adapter for components.
 * Components expect container.element and container.on('resize'|'destroy', cb).
 */
function createContainerAdapter(element) {
    const listeners = {};
    return {
        element,
        on(event, cb) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
        },
        emit(event, ...args) {
            if (listeners[event]) listeners[event].forEach(cb => cb(...args));
        },
        getState() { return {}; },
    };
}

/**
 * MobileLayout manages the navigation stack and panel switching.
 */
class MobileLayout {
    constructor(rootElement) {
        this.root = rootElement;
        this.root.style.cssText = 'display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden;';

        // Header bar
        this.header = document.createElement('div');
        this.header.style.cssText = 'display:flex;align-items:center;padding:8px 12px;background:#1e1e1e;color:#fff;font-family:sans-serif;font-size:14px;flex-shrink:0;border-bottom:1px solid #333;gap:8px;min-height:44px;';
        this.root.appendChild(this.header);

        this.backBtn = document.createElement('button');
        this.backBtn.textContent = '\u2190';
        this.backBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:4px 8px;display:none;-webkit-tap-highlight-color:transparent;';
        this.backBtn.onclick = () => this.goBack();
        this.header.appendChild(this.backBtn);

        this.titleEl = document.createElement('span');
        this.titleEl.style.cssText = 'flex:1;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        this.header.appendChild(this.titleEl);

        this.previewBtn = document.createElement('button');
        this.previewBtn.textContent = '\u25B6 Preview';
        this.previewBtn.style.cssText = 'background:#2196F3;border:none;color:#fff;padding:6px 12px;border-radius:4px;font-size:12px;cursor:pointer;display:none;-webkit-tap-highlight-color:transparent;';
        this.previewBtn.onclick = () => this.showPreview();
        this.header.appendChild(this.previewBtn);

        // Panel container — holds all panels, only one visible at a time
        this.panelContainer = document.createElement('div');
        this.panelContainer.style.cssText = 'flex:1;position:relative;overflow:hidden;min-height:0;';
        this.root.appendChild(this.panelContainer);

        // Navigation stack
        this.navStack = []; // [{name, panelId}]
        this.panels = {}; // panelId -> {element, container, component}
        this.activePanel = null;

        // Create panels
        this._createFileTreePanel();
        this._createEditorPanel();
        this._createPreviewPanel();

        // Start with file tree
        this.showPanel('fileTree', 'Project Files');

        log.log('Mobile layout initialized');
    }

    _createPanel(id) {
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:none;overflow:hidden;';
        el.setAttribute('data-panel', id);
        this.panelContainer.appendChild(el);
        const container = createContainerAdapter(el);
        this.panels[id] = { element: el, container, component: null };
        return { element: el, container };
    }

    _createFileTreePanel() {
        this._createPanel('fileTree');
        // Component will be instantiated by init()
    }

    _createEditorPanel() {
        this._createPanel('editor');
    }

    _createPreviewPanel() {
        this._createPanel('preview');
    }

    showPanel(panelId, title, pushToStack = true) {
        // Hide current
        if (this.activePanel && this.panels[this.activePanel]) {
            this.panels[this.activePanel].element.style.display = 'none';
        }

        // Show target
        const panel = this.panels[panelId];
        if (!panel) return;
        panel.element.style.display = panel.element._displayStyle || 'block';
        this.activePanel = panelId;

        // Update header
        this.titleEl.textContent = title || panelId;
        this.backBtn.style.display = this.navStack.length > 0 ? '' : 'none';
        this.previewBtn.style.display = panelId === 'editor' ? '' : 'none';

        if (pushToStack && this.navStack.length > 0 && this.navStack[this.navStack.length - 1].panelId !== panelId) {
            // Only push if different from current top
        }
        if (pushToStack) {
            // Remove any existing entry for this panel to avoid duplicates
            const existingIdx = this.navStack.findIndex(n => n.panelId === panelId);
            if (existingIdx >= 0 && existingIdx === this.navStack.length - 1) {
                // Already on top, just update title
                this.navStack[this.navStack.length - 1].name = title;
            } else {
                this.navStack.push({ name: title, panelId });
            }
        }
        this.backBtn.style.display = this.navStack.length > 1 ? '' : 'none';

        // Notify component of resize
        panel.container.emit('resize');
    }

    goBack() {
        if (this.navStack.length <= 1) return;
        this.navStack.pop(); // Remove current
        const prev = this.navStack[this.navStack.length - 1];
        this.showPanel(prev.panelId, prev.name, false);
        this.backBtn.style.display = this.navStack.length > 1 ? '' : 'none';
    }

    showPreview() {
        this.showPanel('preview', 'Preview');
    }

    /**
     * Open a file in the editor panel.
     * Called by the file tree when a file is tapped.
     */
    openFile(fileId, fileName) {
        if (this._onOpenFile) {
            this._onOpenFile(fileId);
        }
        this.showPanel('editor', fileName);
    }

    /**
     * Trigger resize on all visible panels (e.g. on orientation change).
     */
    updateSize() {
        for (const panel of Object.values(this.panels)) {
            panel.container.emit('resize');
        }
    }
}

module.exports = { isMobile, MobileLayout, createContainerAdapter };
