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
            
        case 'md':
        case 'markdown':
            // Markdown with KaTeX math support
            // Protect math blocks and code blocks from HTML escaping
            const mathBlocks = [];
            let processed = fileContent;
            // Extract display math $$...$$
            processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
                mathBlocks.push({ display: true, math });
                return `\x00MATH${mathBlocks.length - 1}\x00`;
            });
            // Extract inline math $...$  (not greedy, not matching $$)
            processed = processed.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
                mathBlocks.push({ display: false, math });
                return `\x00MATH${mathBlocks.length - 1}\x00`;
            });
            // Extract code blocks
            const codeBlocks = [];
            processed = processed.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
                codeBlocks.push({ lang, code });
                return `\x00CODE${codeBlocks.length - 1}\x00`;
            });
            processed = processed.replace(/`([^`]+)`/g, (_, code) => {
                codeBlocks.push({ lang: '', code, inline: true });
                return `\x00CODE${codeBlocks.length - 1}\x00`;
            });

            // Now HTML-escape the rest
            const escaped = processed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // Markdown transformations
            const rendered = escaped
                .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
                .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                .replace(/^---$/gm, '<hr>')
                .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
                .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                .replace(/(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)/g, '<em>$1</em>')
                .replace(/~~(.+?)~~/g, '<del>$1</del>')
                .replace(/^\* (.+)$/gm, '<li>$1</li>')
                .replace(/^\- (.+)$/gm, '<li>$1</li>')
                .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
                .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
                .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
                .replace(/^(?!<[hluopbd]|<hr|\x00)(.*\S.*)$/gm, '<p>$1</p>');

            // Restore code blocks
            let final = rendered.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
                const block = codeBlocks[i];
                if (block.inline) return `<code>${block.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`;
                const escapedCode = block.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<pre><code class="language-${block.lang}">${escapedCode}</code></pre>`;
            });

            // Restore math blocks — rendered client-side by KaTeX auto-render
            final = final.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
                const block = mathBlocks[i];
                const escapedMath = block.math.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                if (block.display) return `<span class="math-display">$$${escapedMath}$$</span>`;
                return `<span class="math-inline">$${escapedMath}$</span>`;
            });

            const mdPreviewHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Markdown Preview - ${fileName}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js"></script>
    <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js"
        onload="renderMathInElement(document.body, {delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false});"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; margin: 20px; max-width: 800px; line-height: 1.6; color: #333; }
        h1, h2, h3, h4 { border-bottom: 1px solid #eee; padding-bottom: 4px; }
        code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 90%; }
        pre code { display: block; padding: 12px; overflow-x: auto; background: #f5f5f5; border-radius: 5px; }
        a { color: #0366d6; }
        li { margin: 2px 0; }
        blockquote { border-left: 4px solid #ddd; margin: 0; padding: 4px 16px; color: #666; }
        hr { border: none; border-top: 1px solid #eee; margin: 16px 0; }
        .math-display { display: block; text-align: center; margin: 12px 0; }
    </style>
</head>
<body>
${final}
</body>
</html>`;
            return {
                type: 'html',
                content: mdPreviewHtml
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