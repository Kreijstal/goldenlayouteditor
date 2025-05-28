const { GoldenLayout, Stack } = require('golden-layout'); // Import Stack
const ace = require('ace-builds/src-min-noconflict/ace');

require('ace-builds/src-min-noconflict/mode-html');
require('ace-builds/src-min-noconflict/theme-github');
require('ace-builds/src-min-noconflict/ext-language_tools');
require('ace-builds/src-min-noconflict/mode-css');
require('ace-builds/src-min-noconflict/mode-javascript');

// --- Central Application State ---
let projectFiles = {
    "htmlFile": {
        id: "htmlFile",
        name: "index.html",
        type: "html",
        content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>My Page</title>
    <link rel="stylesheet" href="style.css"> <!-- Placeholder for style.css -->
</head>
<body>
    <h1>Hello, World!</h1>
    <p>Edit this HTML content, and see style.css and script.js in action.</p>
    <script src="script.js" defer></script> <!-- Placeholder for script.js -->
</body>
</html>`,
        cursor: { row: 0, column: 0 },
        selection: null
    },
    "cssFile": {
        id: "cssFile",
        name: "style.css",
        type: "css",
        content: `body {
    font-family: sans-serif;
    background-color: #f0f0f0;
    padding: 20px;
    margin: 0;
}
h1 {
    color: navy;
    text-align: center;
}`,
        cursor: { row: 0, column: 0 },
        selection: null
    },
    "jsFile": {
        id: "jsFile",
        name: "script.js",
        type: "javascript",
        content: `console.log('Script loaded via placeholder replacement!');
document.addEventListener('DOMContentLoaded', () => {
    const h1 = document.querySelector('h1');
    if (h1) {
        h1.addEventListener('click', () => {
            alert('H1 clicked! Event from script.js');
        });
    }
});`,
        cursor: { row: 0, column: 0 },
        selection: null
    }
};

let previewFrame;
let goldenLayoutInstance;
let projectFilesComponentInstance; // To access its methods
let activeEditorFileId = null; // To track the currently active file in the editor

// Helper to generate unique IDs for new files
function generateUniqueFileId() {
    return 'file-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// Helper to determine file type for Ace mode
function getFileTypeFromExtension(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    switch (extension) {
        case 'html':
        case 'htm':
            return 'html';
        case 'css':
            return 'css';
        case 'js':
            return 'javascript';
        default:
            return 'text'; // Default to plain text if unknown
    }
}

// --- Preview Rendering ---
function renderPreviewFromState() {
    if (previewFrame && previewFrame.contentWindow) {
        console.log('[RenderPreview] Attempting to update preview.');
        let htmlTemplate = projectFiles.htmlFile.content;
        const cssContent = projectFiles.cssFile.content;
        const jsContent = projectFiles.jsFile.content;

        // Replace CSS placeholder
        const cssPlaceholderRegex = /<link\s+.*?href="style\.css".*?>/i;
        if (htmlTemplate.match(cssPlaceholderRegex)) {
            htmlTemplate = htmlTemplate.replace(cssPlaceholderRegex, `<style>\n${cssContent}\n</style>`);
            console.log('[RenderPreview] CSS placeholder replaced.');
        } else {
            console.warn('[RenderPreview] CSS placeholder not found. Attempting fallback injection.');
            const headEndTag = '</head>';
            if (htmlTemplate.includes(headEndTag)) {
                htmlTemplate = htmlTemplate.replace(headEndTag, `<style>\n${cssContent}\n</style>\n${headEndTag}`);
            } else {
                htmlTemplate = `<style>\n${cssContent}\n</style>\n${htmlTemplate}`;
            }
        }

        // Replace JS placeholder
        const jsPlaceholderRegex = /<script\s+.*?src="script\.js".*?><\/script>/i;
        if (htmlTemplate.match(jsPlaceholderRegex)) {
            htmlTemplate = htmlTemplate.replace(jsPlaceholderRegex, `<script defer>\n${jsContent}\n</script>`);
            console.log('[RenderPreview] JS placeholder replaced.');
        } else {
            console.warn('[RenderPreview] JS placeholder not found. Attempting fallback injection.');
            const bodyEndTag = '</body>';
            if (htmlTemplate.includes(bodyEndTag)) {
                htmlTemplate = htmlTemplate.replace(bodyEndTag, `<script defer>\n${jsContent}\n</script>\n${bodyEndTag}`);
            } else {
                htmlTemplate += `\n<script defer>\n${jsContent}\n</script>`;
            }
        }

        previewFrame.contentWindow.document.open();
        previewFrame.contentWindow.document.write(htmlTemplate);
        previewFrame.contentWindow.document.close();
        console.log('[RenderPreview] Preview update complete.');
    } else {
        console.warn('[RenderPreview] Preview frame or contentWindow not available for update.');
    }
}

// --- Editor Component ---
class EditorComponent {
    constructor(container, state) {
        this.rootElement = container.element;
        this.rootElement.classList.add('editor-container');
        this.fileId = state.fileId;

        if (!this.fileId || !projectFiles[this.fileId]) {
            this.rootElement.innerHTML = `Error: File ID '${this.fileId}' not provided or invalid.`;
            console.error('[EditorComponent] Invalid fileId:', this.fileId, 'Available file IDs:', Object.keys(projectFiles));
            return;
        }

        const fileData = projectFiles[this.fileId];
        console.log('[EditorComponent] Initializing for fileId:', this.fileId, 'Name:', fileData.name);

        this.editor = ace.edit(this.rootElement);
        this.editor.setTheme("ace/theme/github");
        this.editor.session.setMode(`ace/mode/${fileData.type}`);
        this.editor.setOptions({
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            enableSnippets: true
        });

        this.editor.setValue(fileData.content, -1);
        if (fileData.cursor) {
            this.editor.moveCursorTo(fileData.cursor.row, fileData.cursor.column);
        }
        this.editor.focus();

        this.editor.session.on('change', () => {
            projectFiles[this.fileId].content = this.editor.getValue();
            console.log(`[EditorComponent] Content changed for ${fileData.name}, triggering preview render.`);
            renderPreviewFromState();
        });

        this.editor.on('changeSelection', () => {
            const cursor = this.editor.getCursorPosition();
            projectFiles[this.fileId].cursor = { row: cursor.row, column: cursor.column };
            // console.log(`[EditorComponent] Cursor updated for ${fileData.name}:`, projectFiles[this.fileId].cursor);
        });

        container.on('resize', () => this.editor.resize());
        container.on('destroy', () => {
            console.log(`[EditorComponent] Destroying editor for ${fileData.name}`);
            this.editor.destroy();
        });
    }
}

// --- Preview Component ---
class PreviewComponent {
    constructor(container) {
        this.rootElement = container.element;
        previewFrame = document.createElement('iframe');
        previewFrame.classList.add('preview-iframe');
        this.rootElement.appendChild(previewFrame);
        console.log('[PreviewComponent] Initializing, scheduling initial renderPreviewFromState.');
        // Delay initial render slightly to ensure iframe is ready
        setTimeout(() => {
            console.log('[PreviewComponent] Executing delayed initial renderPreviewFromState.');
            renderPreviewFromState();
        }, 100); // 100ms delay, can be adjusted
    }
}

// --- Project Files Component ---
class ProjectFilesComponent {
    constructor(container) {
        this.rootElement = container.element;
        this.rootElement.style.padding = '10px';
        this.rootElement.style.overflowY = 'auto';
        this.rootElement.classList.add('project-files-container'); // For styling drag-over

        this.ul = document.createElement('ul');
        this.ul.style.listStyleType = 'none';
        this.ul.style.padding = '0';
        this.rootElement.appendChild(this.ul);

        this.updateFileListDisplay(); // Initial display
        console.log('[ProjectFilesComponent] Initialized.');

        // Drag and Drop event listeners
        this.rootElement.addEventListener('dragover', this.handleDragOver.bind(this));
        this.rootElement.addEventListener('dragleave', this.handleDragLeave.bind(this));
        this.rootElement.addEventListener('drop', this.handleDrop.bind(this));
        
        projectFilesComponentInstance = this; // Make instance accessible
    }

    updateFileListDisplay() {
        this.ul.innerHTML = ''; // Clear existing list
        Object.values(projectFiles).forEach(file => {
            const li = document.createElement('li');
            li.style.padding = '5px 0';
            li.style.display = 'flex';
            li.style.alignItems = 'center';
            if (file.id === activeEditorFileId) {
                li.classList.add('active-file');
            }

            const nameSpan = document.createElement('span');
            nameSpan.textContent = file.name;
            nameSpan.style.cursor = 'pointer';
            nameSpan.style.flexGrow = '1'; // Allow span to take available space
            nameSpan.setAttribute('data-file-id', file.id);
            
            nameSpan.onclick = () => { // Click to open/focus editor
                console.log(`[ProjectFilesComponent] Clicked on file: ${file.name} (ID: ${file.id}) to open/focus.`);
                this.openOrFocusEditor(file.id);
            };
            nameSpan.ondblclick = () => { // Double click to rename
                console.log(`[ProjectFilesComponent] Double-clicked on file: ${file.name} (ID: ${file.id}) to rename.`);
                this.enterRenameMode(file.id, nameSpan, li);
            };
            li.appendChild(nameSpan);
            this.ul.appendChild(li);
        });
        console.log('[ProjectFilesComponent] File list display updated. Active file ID:', activeEditorFileId);
    }

    enterRenameMode(fileId, nameSpanElement, listItemElement) {
        const currentName = projectFiles[fileId].name;
        nameSpanElement.style.display = 'none'; // Hide the span

        const inputElement = document.createElement('input');
        inputElement.type = 'text';
        inputElement.value = currentName;
        inputElement.style.width = 'calc(100% - 10px)'; // Adjust width as needed
        inputElement.style.padding = '2px';
        inputElement.style.border = '1px solid #ccc';
        inputElement.style.fontFamily = 'sans-serif'; // Match font

        const commit = () => {
            this.commitRename(fileId, inputElement.value, nameSpanElement, inputElement);
        };

        const cancel = () => {
            nameSpanElement.style.display = ''; // Show the span again
            inputElement.remove();
            console.log('[ProjectFilesComponent] Rename cancelled.');
        };

        inputElement.onblur = commit;
        inputElement.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        };

        // Insert input before the span (or replace, then re-add span on commit/cancel)
        listItemElement.insertBefore(inputElement, nameSpanElement);
        inputElement.focus();
        inputElement.select();
    }

    commitRename(fileId, newName, originalNameSpan, inputElement) {
        originalNameSpan.style.display = ''; // Show the span again
        inputElement.remove();

        const currentFile = projectFiles[fileId];
        if (!currentFile) {
            console.error(`[ProjectFilesComponent] File with ID ${fileId} not found for committing rename.`);
            return;
        }

        const trimmedNewName = newName.trim();
        if (trimmedNewName && trimmedNewName !== currentFile.name) {
            console.log(`[ProjectFilesComponent] Committing rename for file ${currentFile.name} to ${trimmedNewName}`);
            currentFile.name = trimmedNewName;
            const oldType = currentFile.type;
            currentFile.type = getFileTypeFromExtension(currentFile.name);

            this.updateFileListDisplay(); // Refresh the file list

            const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
            if (editorStack) {
                const openTab = editorStack.contentItems.find(item => {
                    const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
                    return state && state.fileId === fileId;
                });
                if (openTab) {
                    openTab.setTitle(currentFile.name);
                    console.log(`[ProjectFilesComponent] Tab title updated for fileId "${fileId}" to "${currentFile.name}".`);
                    
                    if (oldType !== currentFile.type) {
                        const editorComponent = openTab.container.componentReference; // componentReference should still point to our EditorComponent instance
                        if (editorComponent && editorComponent.editor) {
                            editorComponent.editor.session.setMode(`ace/mode/${currentFile.type}`);
                            console.log(`[ProjectFilesComponent] Editor mode updated for fileId "${fileId}" to ${currentFile.type}.`);
                        } else {
                             console.warn(`[ProjectFilesComponent] Could not directly access editor instance via componentReference to update mode for fileId "${fileId}".`);
                        }
                    }
                }
            }
            renderPreviewFromState();
        } else {
            console.log('[ProjectFilesComponent] Rename not committed (name unchanged or empty).');
            // No need to call updateFileListDisplay if name didn't change, originalNameSpan is already correct.
        }
    }
    
    // Removed old window.prompt based renameFile method

    handleDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        this.rootElement.classList.add('drag-over-active'); // Visual cue
        event.dataTransfer.dropEffect = 'copy';
    }

    handleDragLeave(event) {
        event.preventDefault();
        event.stopPropagation();
        this.rootElement.classList.remove('drag-over-active');
    }

    handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        this.rootElement.classList.remove('drag-over-active');

        const files = event.dataTransfer.files;
        if (files.length > 0) {
            console.log(`[ProjectFilesComponent] Dropped ${files.length} file(s).`);
            Array.from(files).forEach(file => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const fileContent = e.target.result;
                    const fileName = file.name;
                    const fileType = getFileTypeFromExtension(fileName);
                    const newFileId = generateUniqueFileId();

                    projectFiles[newFileId] = {
                        id: newFileId,
                        name: fileName,
                        type: fileType,
                        content: fileContent,
                        cursor: { row: 0, column: 0 },
                        selection: null
                    };
                    console.log(`[ProjectFilesComponent] File "${fileName}" read and added with ID: ${newFileId}`);
                    this.updateFileListDisplay();
                    // Optionally open the first dropped file
                    if (Array.from(files).indexOf(file) === 0) {
                        this.openOrFocusEditor(newFileId);
                    }
                };
                reader.onerror = (err) => {
                    console.error(`[ProjectFilesComponent] Error reading file ${file.name}:`, err);
                };
                reader.readAsText(file);
            });
        }
    }

    openOrFocusEditor(fileId) {
        console.log('[ProjectFilesComponent] openOrFocusEditor called with fileId:', fileId);
        if (!goldenLayoutInstance) {
            console.error('[ProjectFilesComponent] goldenLayoutInstance is not available.');
            return;
        }

        // Attempt to find stack using getAllStacks() and filtering by ID
        const allStacks = goldenLayoutInstance.getAllStacks();
        if (!allStacks || allStacks.length === 0) {
            console.error('[ProjectFilesComponent] No stacks found using getAllStacks().');
            return;
        }

        const editorStack = allStacks.find(stack => stack.id === 'editorStack');
        
        if (!editorStack) {
            console.error('[ProjectFilesComponent] Editor stack with ID "editorStack" not found among all stacks.');
            console.log('[ProjectFilesComponent] Available stack IDs:', allStacks.map(s => s.id));
            return;
        }
        
        if (typeof editorStack.setActiveContentItem !== 'function') {
             console.error('[ProjectFilesComponent] Found item with ID "editorStack" is not a valid Stack object (missing setActiveContentItem).', editorStack);
             return;
        }
        console.log('[ProjectFilesComponent] Editor stack retrieved by getAllStacks() and filtering by ID:', editorStack.id);
        
        editorStack.contentItems.forEach((item, index) => {
            const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
            const stateFileId = state && state.fileId ? state.fileId : 'undefined';
            console.log(`[ProjectFilesComponent] Stack item ${index} - Title: ${item.title}, container.getState().fileId: ${stateFileId}, GL item.id: ${item.id || '<none>'}`);
        });

        const existingItem = editorStack.contentItems.find(item => {
            const state = item.container && typeof item.container.getState === 'function' ? item.container.getState() : null;
            return state && state.fileId === fileId;
        });

        if (existingItem) {
            console.log(`[ProjectFilesComponent] Activating existing item for fileId "${fileId}", Title: ${existingItem.title}`);
            editorStack.setActiveContentItem(existingItem);
        } else {
            if (!projectFiles[fileId]) {
                console.error(`[ProjectFilesComponent] No file data found for fileId: "${fileId}"`);
                return;
            }
            const newTitle = projectFiles[fileId].name;
            const contentItemId = 'editor-' + fileId;
            console.log(`[ProjectFilesComponent] Adding new component for fileId: "${fileId}", title: "${newTitle}", contentItemId: "${contentItemId}"`);
            // Pass { fileId: fileId } as componentState. EditorComponent constructor will use this.
            // GoldenLayout should make this state retrievable via item.container.getState().
            editorStack.addComponent('editor', { fileId: fileId }, newTitle, contentItemId);
        }
    }
}

// --- GoldenLayout Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('[DOMContentLoaded] Initializing GoldenLayout.');
    const layoutContainer = document.getElementById('layoutContainer');
    if (!layoutContainer) {
        console.error('[DOMContentLoaded] Layout container #layoutContainer not found!');
        return;
    }

    goldenLayoutInstance = new GoldenLayout(layoutContainer);

    goldenLayoutInstance.registerComponentConstructor('editor', EditorComponent);
    goldenLayoutInstance.registerComponentConstructor('preview', PreviewComponent);
    goldenLayoutInstance.registerComponentConstructor('projectFiles', ProjectFilesComponent);

    const layoutConfig = {
        root: {
            type: 'row',
            content: [
                {
                    type: 'column',
                    width: 20, // Adjusted width
                    content: [
                        {
                            type: 'component',
                            componentType: 'projectFiles',
                            title: 'Project Files'
                        }
                    ]
                },
                {
                    type: 'column',
                    width: 80, // Adjusted width
                    content: [
                        {
                            type: 'stack',
                            id: 'editorStack',
                            content: [
                                {
                                    type: 'component',
                                    id: 'editor-' + projectFiles.htmlFile.id, // Assign an ID to the content item
                                    componentType: 'editor',
                                    title: projectFiles.htmlFile.name, // Initial tab title
                                    componentState: { fileId: projectFiles.htmlFile.id }
                                }
                            ]
                        },
                        {
                            type: 'component',
                            componentType: 'preview',
                            title: 'Preview'
                        }
                    ]
                }
            ]
        },
        settings: {
            showPopoutIcon: false,
            showMaximiseIcon: true,
            showCloseIcon: true,
        },
        dimensions: {
            borderWidth: 5,
            minItemHeight: 10,
            minItemWidth: 10,
            headerHeight: 25,
        }
    };

    goldenLayoutInstance.loadLayout(layoutConfig);
    console.log('[DOMContentLoaded] GoldenLayout loaded.');

    // Set initial active file ID
    if (projectFiles.htmlFile) { // Check if htmlFile exists
        activeEditorFileId = projectFiles.htmlFile.id;
        if (projectFilesComponentInstance) {
            projectFilesComponentInstance.updateFileListDisplay(); // Update highlight
        }
    }
    
    // Listen for active tab changes to update highlight
    const editorStack = goldenLayoutInstance.getAllStacks().find(stack => stack.id === 'editorStack');
    if (editorStack) {
        const initialActiveItem = editorStack.getActiveContentItem();
        if (initialActiveItem) {
            const state = initialActiveItem.container && typeof initialActiveItem.container.getState === 'function' ? initialActiveItem.container.getState() : null;
            if (state && state.fileId) {
                activeEditorFileId = state.fileId;
                console.log('[DOMContentLoaded] Initial active file ID (from container.getState()):', activeEditorFileId);
            } else if (initialActiveItem.isComponent && initialActiveItem.componentState && initialActiveItem.componentState.fileId) {
                 // Fallback for initial item from layout config if getState() isn't populated yet (less likely but safe)
                activeEditorFileId = initialActiveItem.componentState.fileId;
                console.log('[DOMContentLoaded] Initial active file ID (from componentState directly):', activeEditorFileId);
            }
            if (activeEditorFileId && projectFilesComponentInstance) {
                 projectFilesComponentInstance.updateFileListDisplay();
            }
        }

        editorStack.on('activeContentItemChanged', (activeContentItem) => {
            if (activeContentItem && activeContentItem.container && typeof activeContentItem.container.getState === 'function') {
                const state = activeContentItem.container.getState();
                if (state && state.fileId) {
                    activeEditorFileId = state.fileId;
                    console.log('[GoldenLayout] Active tab changed. New active file ID (from container.getState()):', activeEditorFileId);
                } else {
                    activeEditorFileId = null;
                    console.warn('[GoldenLayout] Active tab is an editor, but fileId is missing in container.getState().', activeContentItem);
                }
            } else {
                activeEditorFileId = null;
                if (activeContentItem && activeContentItem.isComponent && activeContentItem.componentType === 'editor') {
                     console.warn('[GoldenLayout] Active tab is an editor, but its container or getState is unavailable.', activeContentItem);
                } else {
                    console.log('[GoldenLayout] Active tab changed. Not an editor or container/getState unavailable.');
                }
            }
            if (projectFilesComponentInstance) {
                projectFilesComponentInstance.updateFileListDisplay();
            }
        });
    } else {
        console.warn('[DOMContentLoaded] Could not find editorStack to attach activeContentItemChanged listener.');
    }

    window.addEventListener('resize', () => {
        if (goldenLayoutInstance) {
            goldenLayoutInstance.updateSize();
        }
    });
});