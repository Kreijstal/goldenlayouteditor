const { GoldenLayout, LayoutConfig } = require('golden-layout');
const ace = require('ace-builds/src-min-noconflict/ace');

// Configure Ace Editor
require('ace-builds/src-min-noconflict/mode-html');
require('ace-builds/src-min-noconflict/theme-github'); // You can choose a different theme
require('ace-builds/src-min-noconflict/ext-language_tools');

let htmlEditor;
let previewFrame;

// Function to update the preview iframe
function updatePreview(htmlContent) {
    if (previewFrame && previewFrame.contentWindow) {
        previewFrame.contentWindow.document.open();
        previewFrame.contentWindow.document.write(htmlContent);
        previewFrame.contentWindow.document.close();
    }
}

// Component class for the Ace Editor
class EditorComponent {
    constructor(container) {
        this.rootElement = container.element;
        this.rootElement.classList.add('editor-container'); // For styling

        htmlEditor = ace.edit(this.rootElement);
        htmlEditor.setTheme("ace/theme/github");
        htmlEditor.session.setMode("ace/mode/html");
        htmlEditor.setOptions({
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: true,
            enableSnippets: true
        });

        // Initial content
        const initialHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>My Page</title>
    <style>
        body { font-family: sans-serif; background-color: #f0f0f0; padding: 20px; }
        h1 { color: navy; }
    </style>
</head>
<body>
    <h1>Hello, World!</h1>
    <p>Edit this HTML content in the editor.</p>
</body>
</html>`;
        htmlEditor.setValue(initialHtml, -1); // -1 moves cursor to the start

        htmlEditor.session.on('change', () => {
            const currentHtml = htmlEditor.getValue();
            updatePreview(currentHtml);
        });

        // Initial update
        updatePreview(initialHtml);

        container.on('resize', () => {
            if (htmlEditor) {
                htmlEditor.resize();
            }
        });
    }
}

// Component class for the HTML Preview
class PreviewComponent {
    constructor(container) {
        this.rootElement = container.element;
        previewFrame = document.createElement('iframe');
        previewFrame.classList.add('preview-iframe'); // For styling
        this.rootElement.appendChild(previewFrame);

        // Initial update in case editor loads first
        if (htmlEditor) {
            updatePreview(htmlEditor.getValue());
        }
    }
}


// Initialize GoldenLayout
document.addEventListener('DOMContentLoaded', () => {
    const layoutContainer = document.getElementById('layoutContainer');
    if (!layoutContainer) {
        console.error('Layout container not found!');
        return;
    }

    const goldenLayoutInstance = new GoldenLayout(layoutContainer);

    goldenLayoutInstance.registerComponentConstructor('editor', EditorComponent);
    goldenLayoutInstance.registerComponentConstructor('preview', PreviewComponent);

    const layoutConfig = {
        root: {
            type: 'row',
            content: [
                {
                    type: 'component',
                    componentType: 'editor',
                    title: 'HTML Editor'
                },
                {
                    type: 'component',
                    componentType: 'preview',
                    title: 'Preview'
                }
            ]
        },
        settings: {
            showPopoutIcon: false,
            showMaximiseIcon: true,
            showCloseIcon: false, // Components can't be closed by default
        },
        dimensions: {
            borderWidth: 5,
            minItemHeight: 10,
            minItemWidth: 10,
            headerHeight: 25,
        }
    };

    goldenLayoutInstance.loadLayout(layoutConfig);

    // Handle window resize for GoldenLayout
    window.addEventListener('resize', () => {
        goldenLayoutInstance.updateSize();
    });
});