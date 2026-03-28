// --- Shared Tree Renderer ---
// Renders a list of items as an expandable tree into a container.
// Used by both the project file explorer and the workspace directory browser.
//
// Options:
//   items:       Array of { name, type: 'directory'|'file', collapsed?, children?, ... }
//   container:   DOM element (ul) to render into
//   depth:       Current nesting depth (for indentation)
//   onToggleDir(item, expanded): Called when a directory is toggled
//   onClickDir(item, li):        Called when a directory row is clicked (after toggle)
//   onClickFile(item, li):       Called when a file row is clicked
//   onDblClickFile(item, li):    Called on double-click of file
//   onContextMenu(e, item, nameSpan, li): Called on right-click
//   renderFileExtras(item, li):  Called to append extra elements to file rows (dirty dots, hover actions)
//   renderDirExtras(item, li):   Called to append extra elements to dir rows
//   getFileIcon(fileName):       Returns icon string for a file (default: 📄)
//   fileIdAttr:                  If set, nameSpan gets data-file-id attribute
//   activeFileId:                Highlight this file as active
//   darkMode:                    true for dark theme (default), false for light

function renderTree(opts) {
    const {
        items, container, depth = 0,
        onToggleDir, onClickDir, onClickFile, onDblClickFile,
        onContextMenu, renderFileExtras, renderDirExtras,
        getFileIcon, activeFileId, darkMode = true,
    } = opts;

    const hoverBg = darkMode ? 'rgba(255,255,255,0.08)' : '#f0f0f0';

    items.forEach(item => {
        const li = document.createElement('li');
        li.style.cssText = `padding:2px 4px;padding-left:${depth * 16 + 8}px;display:flex;align-items:center;user-select:none;border-radius:3px;cursor:pointer;`;
        li.onmouseenter = () => { if (!li.classList.contains('active-file') && !li.classList.contains('selected-dir')) li.style.background = hoverBg; };
        li.onmouseleave = () => { if (!li.classList.contains('active-file') && !li.classList.contains('selected-dir')) li.style.background = ''; };

        if (item.type === 'directory') {
            const collapsed = item.collapsed !== false; // default collapsed for items without the property
            const toggle = document.createElement('span');
            toggle.textContent = collapsed ? '\u25B6' : '\u25BC';
            toggle.style.cssText = 'cursor:pointer;width:14px;font-size:9px;flex-shrink:0;';

            const icon = document.createElement('span');
            icon.textContent = collapsed ? '\uD83D\uDCC1' : '\uD83D\uDCC2';
            icon.style.cssText = 'margin-right:4px;font-size:13px;flex-shrink:0;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = item.name;
            nameSpan.style.cssText = 'cursor:pointer;font-weight:bold;flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            const childUl = document.createElement('ul');
            childUl.style.cssText = 'list-style:none;padding:0;margin:0;';
            childUl.style.display = collapsed ? 'none' : 'block';

            const doToggle = () => {
                const nowCollapsed = childUl.style.display !== 'none';
                toggle.textContent = nowCollapsed ? '\u25B6' : '\u25BC';
                icon.textContent = nowCollapsed ? '\uD83D\uDCC1' : '\uD83D\uDCC2';
                childUl.style.display = nowCollapsed ? 'none' : 'block';
                if (onToggleDir) onToggleDir(item, !nowCollapsed, childUl);
            };

            toggle.onclick = (e) => { e.stopPropagation(); doToggle(); };
            nameSpan.onclick = (e) => { e.stopPropagation(); doToggle(); if (onClickDir) onClickDir(item, li); };
            icon.onclick = (e) => { e.stopPropagation(); doToggle(); if (onClickDir) onClickDir(item, li); };
            li.onclick = () => { doToggle(); if (onClickDir) onClickDir(item, li); };

            if (onContextMenu) {
                li.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onContextMenu(e, item, nameSpan, li);
                };
            }

            li.appendChild(toggle);
            li.appendChild(icon);
            li.appendChild(nameSpan);
            if (renderDirExtras) renderDirExtras(item, li);
            container.appendChild(li);

            if (item.id || item.name) {
                childUl.setAttribute('data-dir-id', item.id || item.name);
            }
            // Recursively render existing children
            if (item.children && item.children.length > 0) {
                renderTree({
                    ...opts,
                    items: item.children,
                    container: childUl,
                    depth: depth + 1,
                });
            }
            container.appendChild(childUl);
        } else {
            // File
            if (activeFileId && item.id === activeFileId) {
                li.classList.add('active-file');
            }

            const iconText = getFileIcon ? getFileIcon(item.name) : '\uD83D\uDCC4';
            const icon = document.createElement('span');
            icon.textContent = iconText;
            icon.style.cssText = 'margin-right:4px;font-size:13px;flex-shrink:0;width:18px;text-align:center;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = item.name;
            nameSpan.style.cssText = 'cursor:pointer;flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            if (item.id) nameSpan.setAttribute('data-file-id', item.id);

            if (onClickFile) {
                li.onclick = () => onClickFile(item, li);
            }
            if (onDblClickFile) {
                li.ondblclick = () => onDblClickFile(item, li);
            }
            if (onContextMenu) {
                li.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onContextMenu(e, item, nameSpan, li);
                };
            }

            li.appendChild(icon);
            li.appendChild(nameSpan);
            if (renderFileExtras) renderFileExtras(item, li);
            if (item.id) li.setAttribute('data-tree-file-id', item.id);
            container.appendChild(li);
        }
    });
}

module.exports = { renderTree };
