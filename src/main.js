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
            li.style.display = 'flex'; // For aligning name and button
            li.style.justifyContent = 'space-between'; // Space them out
            li.style.alignItems = 'center';
            li.style.padding = '5px 0';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = file.name;
            nameSpan.style.cursor = 'pointer';
            nameSpan.setAttribute('data-file-id', file.id);
            nameSpan.onclick = () => {
                console.log(`[ProjectFilesComponent] Clicked on file: ${file.name} (ID: ${file.id})`);
                this.openOrFocusEditor(file.id);
            };
            li.appendChild(nameSpan);

            const renameButton = document.createElement('button');
            renameButton.textContent = 'Rename';
            renameButton.style.marginLeft = '10px';
            renameButton.style.padding = '2px 5px';
            renameButton.style.fontSize = '0.8em';
            renameButton.onclick = (e) => {
                e.stopPropagation(); // Prevent li click event
                this.renameFile(file.id);
            };
            li.appendChild(renameButton);

            this.ul.appendChild(li);
        });
        console.log('[ProjectFilesComponent] File list display updated.');
    }

    renameFile(fileId) {
        const currentFile = projectFiles[fileId];
        if (!currentFile) {
            console.error(`[ProjectFilesComponent] File with ID ${fileId} not found for renaming.`);
            return;
        }

        const newName = window.prompt("Enter new file name:", currentFile.name);
        if (newName && newName.trim() !== "" && newName !== currentFile.name) {
            console.log(`[ProjectFilesComponent] Renaming file ${currentFile.name} to ${newName}`);
            currentFile.name = newName.trim();
            currentFile.type = getFileTypeFromExtension(currentFile.name); // Update type based on new extension

            this.updateFileListDisplay(); // Refresh the file list

            // Update tab title and editor mode if the file is open
            const itemIdentifier = 'editor-' + fileId;
            const allStacks = goldenLayoutInstance.getAllStacks();
            const editorStack = allStacks.find(stack => stack.id === 'editorStack');
            if (editorStack) {
                const openTab = editorStack.contentItems.find(item => item.id === itemIdentifier);
                if (openTab) {
                    openTab.setTitle(currentFile.name);
                    // Find the Ace editor instance associated with this tab to update its mode
                    // This is a bit indirect. The EditorComponent instance itself holds the editor.
                    // We might need a way to access the component instance from the GoldenLayout item.
                    // For now, if the tab is re-created or focused, EditorComponent's constructor will set the mode.
                    // A more direct update would require a map of fileId to EditorComponent instance or similar.
                    console.log(`[ProjectFilesComponent] Tab title updated for ${itemIdentifier}. Mode will update if tab is re-focused or re-created.`);
                    // If the editor component instance is accessible, we could do:
                    // openTab.component.editor.session.setMode(`ace/mode/${currentFile.type}`);
                }
            }
            renderPreviewFromState(); // Re-render preview if a relevant file was renamed (e.g. index.html)
        } else if (newName === currentFile.name) {
            console.log('[ProjectFilesComponent] New name is the same as the old name. No change.');
        } else {
            console.log('[ProjectFilesComponent] Rename cancelled or invalid name provided.');
        }
    }

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

        const itemIdentifier = 'editor-' + fileId; // Unique ID for the content item
        console.log('[ProjectFilesComponent] Looking for item with ID:', itemIdentifier);
        
        // Log all item IDs in the stack for debugging
        editorStack.contentItems.forEach(item => console.log('[ProjectFilesComponent] Stack item ID:', item.id, 'Title:', item.title, 'ComponentState:', item.componentState));

        const existingItem = editorStack.contentItems.find(item => item.id === itemIdentifier);

        if (existingItem) {
            console.log('[ProjectFilesComponent] Activating existing item by ID:', existingItem.id, 'Title:', existingItem.title);
            editorStack.setActiveContentItem(existingItem);
        } else {
            if (!projectFiles[fileId]) {
                console.error(`[ProjectFilesComponent] No file data found for fileId: "${fileId}"`);
                return;
            }
            const newTitle = projectFiles[fileId].name;
            console.log(`[ProjectFilesComponent] Adding new component for fileId: "${fileId}", title: "${newTitle}", item ID: "${itemIdentifier}"`);
            // Pass the itemIdentifier as the fourth argument to addComponent (componentId)
            // The arguments for addComponent are: componentType, componentState, title, componentId
            editorStack.addComponent('editor', { fileId: fileId }, newTitle, itemIdentifier);
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

    window.addEventListener('resize', () => {
        if (goldenLayoutInstance) {
            goldenLayoutInstance.updateSize();
        }
    });
});