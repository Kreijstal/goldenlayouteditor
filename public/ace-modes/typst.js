// Custom Typst mode for Ace Editor
// This file should be loaded at runtime in the browser

(function() {
    if (typeof ace === 'undefined') {
        console.warn('Ace editor not available');
        return;
    }

    ace.define('ace/mode/typst', ['require', 'exports', 'ace/lib/oop', 'ace/mode/text', 'ace/mode/text_highlight_rules'], function(require, exports, module) {
        const oop = require('ace/lib/oop');
        const TextMode = require('ace/mode/text').Mode;
        const TextHighlightRules = require('ace/mode/text_highlight_rules').TextHighlightRules;

        // Define Typst syntax highlighting rules
        const TypstHighlightRules = function() {
            this.$rules = {
                start: [
                    // Comments
                    {
                        token: 'comment.line.double-slash.typst',
                        regex: '//.*$'
                    },
                    {
                        token: 'comment.block.typst',
                        regex: '/\\*',
                        next: 'comment'
                    },
                    // Headings
                    {
                        token: 'markup.heading.typst',
                        regex: '^\\s*=+\\s.*$'
                    },
                    // Functions and directives starting with #
                    {
                        token: 'keyword.control.typst',
                        regex: '#[a-zA-Z_][a-zA-Z0-9_]*'
                    },
                    // Math expressions
                    {
                        token: 'string.interpolated.typst',
                        regex: '\\$[^$]*\\$'
                    },
                    // Code blocks
                    {
                        token: 'string.quoted.triple.typst',
                        regex: '```[\\s\\S]*?```'
                    },
                    // Inline code
                    {
                        token: 'string.quoted.single.typst',
                        regex: '`[^`]*`'
                    },
                    // Strings
                    {
                        token: 'string.quoted.double.typst',
                        regex: '"[^"]*"'
                    },
                    // Numbers with units
                    {
                        token: 'constant.numeric.typst',
                        regex: '\\b\\d+(?:\\.\\d+)?(?:pt|em|%|cm|mm|in|px)?\\b'
                    },
                    // Built-in functions
                    {
                        token: 'support.function.typst',
                        regex: '\\b(set|show|let|import|include|context|if|else|for|while|break|continue|return)\\b'
                    },
                    // Constants
                    {
                        token: 'constant.language.typst',
                        regex: '\\b(true|false|none|auto)\\b'
                    }
                ],
                comment: [
                    {
                        token: 'comment.block.typst',
                        regex: '\\*/',
                        next: 'start'
                    },
                    {
                        defaultToken: 'comment.block.typst'
                    }
                ]
            };
        };

        oop.inherits(TypstHighlightRules, TextHighlightRules);

        const TypstMode = function() {
            this.HighlightRules = TypstHighlightRules;
            this.$behaviour = this.$defaultBehaviour;
        };

        oop.inherits(TypstMode, TextMode);

        exports.Mode = TypstMode;
    });

    console.log('Custom Typst Ace mode defined successfully');
})();