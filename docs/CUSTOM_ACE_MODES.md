# Custom Ace Editor Modes for Handlers

This document explains how to implement custom syntax highlighting for file types using the handler system.

## Overview

The handler system supports custom Ace editor modes, allowing handlers to provide their own syntax highlighting for specific file types. This is done through a combination of:

1. **Handler Methods**: `initializeAceMode()` and `getAceMode()`
2. **Runtime Mode Loading**: Dynamic loading of custom mode definitions
3. **Separate Mode Files**: Custom modes are defined in separate JavaScript files

## Implementation Steps

### 1. Create a Custom Mode File

Create a new file in `public/ace-modes/` directory (e.g., `public/ace-modes/myformat.js`):

```javascript
// Custom mode for MyFormat
(function() {
    if (typeof ace === 'undefined') {
        console.warn('Ace editor not available');
        return;
    }

    ace.define('ace/mode/myformat', ['require', 'exports', 'ace/lib/oop', 'ace/mode/text', 'ace/mode/text_highlight_rules'], function(require, exports, module) {
        const oop = require('ace/lib/oop');
        const TextMode = require('ace/mode/text').Mode;
        const TextHighlightRules = require('ace/mode/text_highlight_rules').TextHighlightRules;

        // Define syntax highlighting rules
        const MyFormatHighlightRules = function() {
            this.$rules = {
                start: [
                    // Comments
                    {
                        token: 'comment.line.myformat',
                        regex: '//.*$'
                    },
                    // Keywords
                    {
                        token: 'keyword.control.myformat',
                        regex: '\\b(if|else|while|for)\\b'
                    },
                    // Strings
                    {
                        token: 'string.quoted.double.myformat',
                        regex: '"[^"]*"'
                    },
                    // Numbers
                    {
                        token: 'constant.numeric.myformat',
                        regex: '\\b\\d+\\b'
                    }
                ]
            };
        };

        oop.inherits(MyFormatHighlightRules, TextHighlightRules);

        const MyFormatMode = function() {
            this.HighlightRules = MyFormatHighlightRules;
            this.$behaviour = this.$defaultBehaviour;
        };

        oop.inherits(MyFormatMode, TextMode);

        exports.Mode = MyFormatMode;
    });

    console.log('Custom MyFormat Ace mode defined successfully');
})();
```

### 2. Implement Handler Methods

In your handler file (e.g., `src/handlers/myformat-handler.js`):

```javascript
/**
 * Initializes a custom Ace mode for MyFormat syntax highlighting.
 */
function initializeAceMode() {
    if (typeof window === 'undefined' || typeof window.ace === 'undefined') {
        console.warn('[MyFormatHandler] Ace editor not available, skipping mode initialization');
        return;
    }

    // Dynamically load the custom mode
    const script = document.createElement('script');
    script.src = './ace-modes/myformat.js';
    script.onload = () => {
        console.log('[MyFormatHandler] Custom MyFormat Ace mode loaded successfully');
    };
    script.onerror = () => {
        console.error('[MyFormatHandler] Failed to load custom MyFormat Ace mode');
    };
    document.head.appendChild(script);
}

/**
 * Gets the Ace editor mode for MyFormat files.
 */
function getAceMode(fileName) {
    return 'myformat'; // This should match the mode name defined in your mode file
}

// Export the functions
module.exports = {
    canHandle,
    generatePreview,
    getFileType,
    getAceMode,
    initializeAceMode
    // ... other handler methods
};
```

## Syntax Highlighting Rules

### Token Types

Common token types you can use in your highlighting rules:

- `comment.line` - Single line comments
- `comment.block` - Block comments
- `keyword.control` - Control flow keywords (if, else, while, etc.)
- `keyword.operator` - Operators (+, -, *, etc.)
- `string.quoted.double` - Double-quoted strings
- `string.quoted.single` - Single-quoted strings
- `constant.numeric` - Numbers
- `constant.language` - Language constants (true, false, null, etc.)
- `support.function` - Built-in functions
- `variable.parameter` - Function parameters
- `markup.heading` - Headings (for markup languages)

### Rule Structure

Each rule has:
- `token`: The CSS class that will be applied
- `regex`: Regular expression to match the text
- `next` (optional): Next state to transition to

### Example Complex Rules

```javascript
{
    // Multi-line strings
    token: 'string.quoted.triple',
    regex: '"""',
    next: 'multiline_string'
},
{
    // Function definitions
    token: ['keyword', 'text', 'entity.name.function'],
    regex: '\\b(function)(\\s+)([a-zA-Z_][a-zA-Z0-9_]*)'
},
{
    // Variables with type annotations
    token: ['variable', 'text', 'keyword.operator', 'text', 'storage.type'],
    regex: '([a-zA-Z_][a-zA-Z0-9_]*)(\\s*)(:)(\\s*)([a-zA-Z_][a-zA-Z0-9_]*)'
}
```

## Example: Typst Handler

The Typst handler demonstrates a complete implementation:

1. **Mode File**: `public/ace-modes/typst.js` - Defines syntax highlighting for Typst markup language
2. **Handler Methods**: `src/handlers/typst-handler.js` - Implements `initializeAceMode()` and `getAceMode()`
3. **Features**: Supports comments, headings, functions, math expressions, code blocks, and more

## Benefits

- **Extensible**: Add new file types without modifying the core application
- **Maintainable**: Each handler owns its syntax highlighting definition
- **Dynamic**: Modes are loaded only when needed
- **Build-Safe**: Custom modes don't interfere with the build process

## Best Practices

1. **Test Your Regex**: Use tools like regex101.com to test your regular expressions
2. **Use Specific Tokens**: Use descriptive token names for better CSS styling
3. **Handle Edge Cases**: Consider nested structures, escape sequences, etc.
4. **Performance**: Avoid overly complex regex patterns that could slow down the editor
5. **Fallback**: Always provide a fallback to 'text' mode if your custom mode fails to load

## Troubleshooting

- **Mode Not Loading**: Check browser console for errors, ensure the mode file path is correct
- **No Highlighting**: Verify that your token names match CSS classes in the Ace theme
- **Build Errors**: Ensure you're not importing Ace modules at build time, only at runtime
- **Performance Issues**: Check for inefficient regex patterns in your highlighting rules