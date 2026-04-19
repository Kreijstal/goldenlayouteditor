// --- Typst Plugin ---
// Registers the Typst file handler and provides a default .typ file
const { registerPlugin } = require('./plugins');
const { registerHandler } = require('./handlers');
const typstHandler = require('./handlers/typst-handler');

// Register the handler so the handler registry knows about .typ files
registerHandler(typstHandler);

// Default Typst file content for new projects
const defaultTypstFile = {
    id: "typstFile",
    name: "main.typ",
    type: "typst",
    content: `#set page(paper: "a4")
#set text(font: "Libertinus Serif")

= My Typst Document

This document is rendered inside the GoldenLayout editor!
The value of (1 + 2) is #(1 + 2).

== Mathematical Expressions

Here's a simple equation:
$ x = (-b ± sqrt(b^2 - 4a c)) / (2a) $

== Code Blocks

\`\`\`javascript
function hello() {
    console.log("Hello from Typst!");
}
\`\`\`

== Lists

- First item
- Second item
- Third item

1. Numbered list
2. Another item
3. Final item`,
    cursor: { row: 0, column: 0 },
    selection: null
};

registerPlugin({
    id: 'typst',
    name: 'Typst',
    defaultFiles: [defaultTypstFile],
});
