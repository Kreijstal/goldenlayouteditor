// --- Web Content Preview Handler ---

/**
 * Determines if this handler can preview a given file.
 * @param {string} fileName - The name of the file.
 * @returns {boolean} - True if the handler can preview the file.
 */
function canHandle(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    const webExtensions = ['html', 'htm', 'css', 'js', 'javascript', 'json'];
    return webExtensions.includes(extension);
}

/**
 * Generates the preview content for a web file.
 * @param {string} fileName - The name of the file.
 * @param {string} fileContent - The content of the file.
 * @returns {object} - An object containing the preview type and content.
 */
function generatePreview(fileName, fileContent) {
    const extension = fileName.split('.').pop().toLowerCase();

    switch (extension) {
        case 'html':
        case 'htm':
            return {
                type: 'html',
                content: fileContent
            };

        case 'css':
            const cssPreviewHtml = `
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
                content: cssPreviewHtml
            };

        case 'js':
        case 'javascript':
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
        <pre class="code">${fileContent.replace(/</g, '<').replace(/>/g, '>')}</pre>
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
            
            const originalLog = console.log;
            console.log = function(...args) {
                output.innerHTML += args.join(' ') + '\\n';
                originalLog.apply(console, args);
            };
            
            try {
                eval(\`${fileContent.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`);
                if (output.innerHTML === '') {
                    output.innerHTML = 'Code executed successfully (no console output)';
                }
            } catch (error) {
                output.innerHTML = 'Error: ' + error.message;
                output.style.color = '#ff6b6b';
            }
            
            console.log = originalLog;
        }
    </script>
</body>
</html>`;
            return {
                type: 'html',
                content: jsPreviewHtml
            };

        case 'json':
            let formattedJson;
            try {
                const parsed = JSON.parse(fileContent);
                formattedJson = JSON.stringify(parsed, null, 2);
            } catch (error) {
                formattedJson = fileContent;
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
            <div class="json-content">${formattedJson.replace(/</g, '<').replace(/>/g, '>')}</div>
        </div>
    </div>
</body>
</html>`;
            return {
                type: 'html',
                content: jsonPreviewHtml
            };
            
        default:
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
                content: defaultPreviewHtml
            };
    }
}

/**
 * Gets the file type for web files (used for editor mode).
 * @param {string} fileName - The name of the file.
 * @returns {string} - The file type for editor configuration.
 */
function getFileType(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    switch (extension) {
        case 'html':
        case 'htm':
            return 'html';
        case 'css':
            return 'css';
        case 'js':
        case 'javascript':
            return 'javascript';
        case 'json':
            return 'json';
        default:
            return 'text';
    }
}

/**
 * Gets the Ace editor mode for web files.
 * @param {string} fileName - The name of the file.
 * @returns {string} - The Ace editor mode.
 */
function getAceMode(fileName) {
    const extension = fileName.split('.').pop().toLowerCase();
    switch (extension) {
        case 'html':
        case 'htm':
            return 'html';
        case 'css':
            return 'css';
        case 'js':
        case 'javascript':
            return 'javascript';
        case 'json':
            return 'json';
        default:
            return 'text';
    }
}

module.exports = {
    canHandle,
    generatePreview,
    getFileType,
    getAceMode,
    // This handler doesn't need special rendering logic beyond the preview
    render: null
}; 