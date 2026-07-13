export type MarkdownBlockType =
  | "blockquote"
  | "code"
  | "fence"
  | "heading"
  | "html"
  | "list"
  | "paragraph"
  | "table"
  | "thematic_break"
  | "unknown";

export interface MarkdownSourceRange {
  sourceStart: number;
  sourceEnd: number;
  lineStart: number;
  lineEnd: number;
}

export interface MarkdownLineMap {
  lineCount: number;
  lineStarts: number[];
}

export interface MarkdownSerializedToken {
  attrs: Array<[string, string]> | null;
  block: boolean;
  children: MarkdownSerializedToken[];
  content: string;
  hidden: boolean;
  info: string;
  level: number;
  map: [number, number] | null;
  markup: string;
  meta: unknown;
  nesting: -1 | 0 | 1;
  tag: string;
  type: string;
}

export interface MarkdownBlock extends MarkdownSourceRange {
  contentHash: string;
  id: string;
  index: number;
  metadata: MarkdownBlockMetadata;
  sourceText: string;
  textContent: string;
  tokens: MarkdownSerializedToken[];
  type: MarkdownBlockType;
}

export interface MarkdownBlockMetadata {
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  language?: string;
  listOrdered?: boolean;
  listStart?: number;
  markup?: string;
}

export interface MarkdownOutlineEntry extends MarkdownSourceRange {
  blockId: string;
  blockIndex: number;
  id: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
}

export interface MarkdownDocumentModel {
  blocks: MarkdownBlock[];
  lineMap: MarkdownLineMap;
  outline: MarkdownOutlineEntry[];
  source: string;
  tokenCount: number;
  version: 1;
}

export interface BuildMarkdownDocumentModelOptions {
  idPrefix?: string;
}
