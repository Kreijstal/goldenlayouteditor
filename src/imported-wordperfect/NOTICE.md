The libwpd TypeScript bridge, document type definitions and document renderer
are adapted from flyfish-dev/file-viewer, commit
e03662c883cdd089814d2d21e4c805b9d7320e0f,
packages/renderers/wordperfect, under Apache-2.0.
Copyright notices and license: public/licenses/imported-viewers/Flyfish-Apache-2.0.txt.
Changes replace the application host and parse in a cancellable local worker;
the optional printable-byte fallback is omitted. Native runtime licensing and
corresponding source are described in docs/wordperfect-viewer.md.
