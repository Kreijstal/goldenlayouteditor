export interface WordPerfectDocument {
  format: 'wordperfect';
  generation: 'wp5' | 'wp6' | 'unknown';
  documentOffset: number;
  encrypted: boolean;
  engine: 'libwpd-wasm' | 'bounded-fallback';
  paragraphs: string[];
  structuredParagraphs: WordPerfectParagraph[];
  tables: WordPerfectTable[];
  headers: WordPerfectParagraph[];
  footers: WordPerfectParagraph[];
  notes: WordPerfectParagraph[];
  metadata: Record<string, string>;
  warnings: string[];
}

export interface WordPerfectRun {
  text: string;
  styles: Array<'bold' | 'italic' | 'underline' | 'strikethrough' | 'superscript' | 'subscript'>;
  href?: string;
}

export interface WordPerfectParagraph {
  kind: 'paragraph' | 'heading';
  level?: number;
  list?: { ordered: boolean; level: number; counter: number };
  runs: WordPerfectRun[];
}

export interface WordPerfectTableCell {
  text: string;
  column: number;
  colSpan: number;
  rowSpan: number;
  covered?: boolean;
}

export interface WordPerfectTable {
  rows: WordPerfectTableCell[][];
}

