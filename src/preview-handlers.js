nne // Preview Handlers for different file types
// This module defines how different file types should be previewed

const previewHandlers = {
    // HTML files - render directly in iframe
    html: {
        canPreview: true,
        handler: (fileContent, fileName) => {
            return {
                type: 'html',
                content: fileContent,
                url: null // Will be served by service worker
            };
        }
    },

    // CSS files - show styled preview with sample content
    css: {
        canPreview: true,
        handler: (fileContent, fileName) => {
            const sampleHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>CSS Preview - ${fileName}</title>
    <style>
${fileContent}
    </style>
</head>
<body>
    <h1>CSS Preview</h1>
    <p>This is a sample paragraph to demonstrate your CSS styles.</p>
    <div class="sample-div">Sample div element</div>
    <button>Sample button</button>
    <ul>
        <li>List item 1</li>
        <li>List item 2</li>
        <li>List item 3</li>
    </ul>
    <table border="1">
        <tr><th>Header 1</th><th>Header 2</th></tr>
        <tr><td>Cell 1</td><td>Cell 2</td></tr>
    </table>
</body>
</html>`;
            return {
                type: 'html',
                content: sampleHtml,
                url: null
            };
        }
    },

    // JavaScript files - show code with syntax highlighting
    javascript: {
        canPreview: true,
        handler: (fileContent, fileName) => {
            const jsPreviewHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>JavaScript Preview - ${fileName}</title>
    <style>
        body { font-family: 'Courier New', monospace; margin: 20px; background: #f5f5f5; }
        .code-container { background: white; padding: 20px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .code { background: #f8f8f8; padding: 15px; border-radius: 3px; border-left: 4px solid #007acc; overflow-x: auto; }
        .filename { color: #666; margin-bottom: 10px; font-weight: bold; }
        .console { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 3px; margin-top: 15px; }
        .console-title { color: #569cd6; margin-bottom: 10px; }
        .run-button { background: #007acc; color: white; border: none; padding: 8px 16px; border-radius: 3px; cursor: pointer; margin-top: 10px; }
        .run-button:hover { background: #005a9e; }
    </style>
</head>
<body>
    <div class="code-container">
        <div class="filename">${fileName}</div>
        <pre class="code">${fileContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        <button class="run-button" onclick="runCode()">Run Code</button>
        <div class="console">
            <div class="console-title">Console Output:</div>
            <div id="console-output">Click "Run Code" to execute the JavaScript</div>
        </div>
    </div>
    <script>
        function runCode() {
            const output = document.getElementById('console-output');
            output.innerHTML = '';
            
            // Override console.log to capture output
            const originalLog = console.log;
            console.log = function(...args) {
                output.innerHTML += args.join(' ') + '\\n';
                originalLog.apply(console, args);
            };
            
            try {
                // Execute the user's code
                eval(\`${fileContent.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`);
                if (output.innerHTML === '') {
                    output.innerHTML = 'Code executed successfully (no console output)';
                }
            } catch (error) {
                output.innerHTML = 'Error: ' + error.message;
                output.style.color = '#ff6b6b';
            }
            
            // Restore original console.log
            console.log = originalLog;
        }
    </script>
</body>
</html>`;
            return {
                type: 'html',
                content: jsPreviewHtml,
                url: null
            };
        }
    },

    // Text files - simple text viewer
    text: {
        canPreview: true,
        handler: (fileContent, fileName) => {
            const textPreviewHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Text Preview - ${fileName}</title>
    <style>
        body { font-family: 'Courier New', monospace; margin: 20px; background: #f5f5f5; }
        .text-container { background: white; padding: 20px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .filename { color: #666; margin-bottom: 10px; font-weight: bold; }
        .content { white-space: pre-wrap; line-height: 1.5; }
    </style>
</head>
<body>
    <div class="text-container">
        <div class="filename">${fileName}</div>
        <div class="content">${fileContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
    </div>
</body>
</html>`;
            return {
                type: 'html',
                content: textPreviewHtml,
                url: null
            };
        }
    },

    // JSON files - formatted JSON viewer
    json: {
        canPreview: true,
        handler: (fileContent, fileName) => {
            let formattedJson;
            try {
                const parsed = JSON.parse(fileContent);
                formattedJson = JSON.stringify(parsed, null, 2);
            } catch (error) {
                formattedJson = fileContent; // Show original if parsing fails
            }

            const jsonPreviewHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>JSON Preview - ${fileName}</title>
    <style>
        body { font-family: 'Courier New', monospace; margin: 20px; background: #f5f5f5; }
        .json-container { background: white; padding: 20px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .filename { color: #666; margin-bottom: 10px; font-weight: bold; }
        .json { background: #f8f8f8; padding: 15px; border-radius: 3px; border-left: 4px solid #28a745; overflow-x: auto; }
        .json-content { white-space: pre; color: #333; }
    </style>
</head>
<body>
    <div class="json-container">
        <div class="filename">${fileName}</div>
        <div class="json">
            <div class="json-content">${formattedJson.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
    </div>
</body>
</html>`;
            return {
                type: 'html',
                content: jsonPreviewHtml,
                url: null
            };
        }
    },

    // Default handler for unknown file types
    default: {
        canPreview: true,
        handler: (fileContent, fileName) => {
            const defaultPreviewHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>File Preview - ${fileName}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; text-align: center; }
        .preview-container { background: white; padding: 40px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .icon { font-size: 64px; margin-bottom: 20px; }
        .filename { color: #333; margin-bottom: 10px; font-weight: bold; font-size: 18px; }
        .message { color: #666; }
    </style>
</head>
<body>
    <div class="preview-container">
        <div class="icon">📄</div>
        <div class="filename">${fileName}</div>
        <div class="message">Preview not available for this file type</div>
    </div>
</body>
</html>`;
            return {
                type: 'html',
                content: defaultPreviewHtml,
                url: null
            };
        }
    }
};

// Get preview handler for a file
function getPreviewHandler(fileName, fileType) {
    // Determine file extension
    const extension = fileName.split('.').pop().toLowerCase();
    
    // Map extensions to handler types
    const extensionMap = {
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'js': 'javascript',
        'javascript': 'javascript',
        'txt': 'text',
        'md': 'text',
        'json': 'json'
    };
    
    const handlerType = extensionMap[extension] || 'default';
    return previewHandlers[handlerType] || previewHandlers.default;
}

// Generate preview content for a file
function generatePreviewContent(fileName, fileContent, fileType) {
    const handler = getPreviewHandler(fileName, fileType);
    return handler.handler(fileContent, fileName);
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { previewHandlers, getPreviewHandler, generatePreviewContent };
} else {
    window.previewHandlers = { previewHandlers, getPreviewHandler, generatePreviewContent };
}