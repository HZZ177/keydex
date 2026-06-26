import MarkdownIt from "markdown-it";

import { markdownPreviewContentHash, markdownPreviewSlug } from "./identity";
import { createMarkdownLineMap, markdownRangeForLineSpan } from "./sourceMap";
import type {
  BuildMarkdownDocumentModelOptions,
  MarkdownBlock,
  MarkdownBlockMetadata,
  MarkdownBlockType,
  MarkdownDocumentModel,
  MarkdownLineMap,
  MarkdownOutlineEntry,
  MarkdownSerializedToken,
} from "./types";

interface MarkdownItTokenLike {
  attrs: Array<[string, string]> | null;
  block: boolean;
  children: MarkdownItTokenLike[] | null;
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

const defaultMarkdownIt = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

const TOP_LEVEL_BLOCK_TYPES = new Set([
  "blockquote_open",
  "bullet_list_open",
  "code_block",
  "fence",
  "heading_open",
  "hr",
  "html_block",
  "ordered_list_open",
  "paragraph_open",
  "table_open",
]);

export function parseMarkdownTokens(source: string, markdownIt = defaultMarkdownIt): MarkdownSerializedToken[] {
  return (markdownIt.parse(source, {}) as MarkdownItTokenLike[]).map(serializeMarkdownToken);
}

export function buildMarkdownDocumentModel(
  source: string,
  options: BuildMarkdownDocumentModelOptions = {},
): MarkdownDocumentModel {
  const lineMap = createMarkdownLineMap(source);
  const tokens = parseMarkdownTokens(source);
  const blocks = segmentMarkdownBlocks(source, lineMap, tokens, options);
  return {
    blocks,
    lineMap,
    outline: buildOutline(blocks),
    source,
    tokenCount: tokens.length,
    version: 1,
  };
}

export function segmentMarkdownBlocks(
  source: string,
  lineMap: MarkdownLineMap,
  tokens: MarkdownSerializedToken[],
  options: BuildMarkdownDocumentModelOptions = {},
): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const hashOccurrences = new Map<string, number>();
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token.level !== 0 || !token.map || !TOP_LEVEL_BLOCK_TYPES.has(token.type)) {
      continue;
    }

    const blockTokens = tokens.slice(tokenIndex, closingTokenIndex(tokens, tokenIndex) + 1);
    const range = markdownRangeForLineSpan(source, lineMap, token.map[0], token.map[1]);
    const type = blockTypeForToken(token);
    const metadata = blockMetadataForToken(token);
    const sourceText = source.slice(range.sourceStart, range.sourceEnd);
    const contentHash = markdownPreviewContentHash(`${type}\n${sourceText}`);
    const hashOccurrence = hashOccurrences.get(contentHash) ?? 0;
    hashOccurrences.set(contentHash, hashOccurrence + 1);
    const block: MarkdownBlock = {
      ...range,
      contentHash,
      id: stableBlockId(options.idPrefix ?? "md", type, contentHash, hashOccurrence),
      index: blocks.length,
      metadata,
      sourceText,
      textContent: blockTextContent(blockTokens),
      tokens: blockTokens,
      type,
    };
    blocks.push(block);
  }
  return blocks;
}

function serializeMarkdownToken(token: MarkdownItTokenLike): MarkdownSerializedToken {
  return {
    attrs: token.attrs,
    block: token.block,
    children: token.children?.map(serializeMarkdownToken) ?? [],
    content: token.content,
    hidden: token.hidden,
    info: token.info,
    level: token.level,
    map: token.map,
    markup: token.markup,
    meta: token.meta,
    nesting: token.nesting,
    tag: token.tag,
    type: token.type,
  };
}

function closingTokenIndex(tokens: MarkdownSerializedToken[], openIndex: number): number {
  const openToken = tokens[openIndex];
  if (openToken.nesting !== 1) {
    return openIndex;
  }
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === openToken.type && token.level === openToken.level) {
      depth += 1;
    }
    if (token.type === closingTokenType(openToken.type) && token.level === openToken.level) {
      depth -= 1;
      if (depth <= 0) {
        return index;
      }
    }
  }
  return openIndex;
}

function closingTokenType(openType: string): string {
  return openType.replace(/_open$/, "_close");
}

function blockTypeForToken(token: MarkdownSerializedToken): MarkdownBlockType {
  switch (token.type) {
    case "blockquote_open":
      return "blockquote";
    case "bullet_list_open":
    case "ordered_list_open":
      return "list";
    case "code_block":
      return "code";
    case "fence":
      return token.info.trim().toLowerCase().startsWith("mermaid") ? "fence" : "fence";
    case "heading_open":
      return "heading";
    case "hr":
      return "thematic_break";
    case "html_block":
      return "html";
    case "paragraph_open":
      return "paragraph";
    case "table_open":
      return "table";
    default:
      return "unknown";
  }
}

function blockMetadataForToken(token: MarkdownSerializedToken): MarkdownBlockMetadata {
  const metadata: MarkdownBlockMetadata = {};
  if (token.type === "heading_open") {
    const level = Number(token.tag.replace(/^h/, ""));
    if (level >= 1 && level <= 6) {
      metadata.headingLevel = level as MarkdownBlockMetadata["headingLevel"];
    }
  }
  if (token.type === "fence") {
    const language = token.info.trim().split(/\s+/, 1)[0] ?? "";
    if (language) {
      metadata.language = language;
    }
  }
  if (token.type === "ordered_list_open") {
    metadata.listOrdered = true;
  }
  if (token.markup) {
    metadata.markup = token.markup;
  }
  return metadata;
}

function blockTextContent(tokens: MarkdownSerializedToken[]): string {
  return tokens
    .map(tokenTextContent)
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tokenTextContent(token: MarkdownSerializedToken): string {
  if (token.children.length > 0) {
    return token.children.map(tokenTextContent).filter(Boolean).join("");
  }
  return token.content;
}

function buildOutline(blocks: MarkdownBlock[]): MarkdownOutlineEntry[] {
  return blocks
    .filter((block) => block.type === "heading" && block.metadata.headingLevel)
    .map((block) => ({
      blockId: block.id,
      blockIndex: block.index,
      id: stableOutlineId(block.textContent, block.index),
      level: block.metadata.headingLevel as MarkdownOutlineEntry["level"],
      lineEnd: block.lineEnd,
      lineStart: block.lineStart,
      sourceEnd: block.sourceEnd,
      sourceStart: block.sourceStart,
      title: block.textContent || `Heading ${block.index + 1}`,
    }));
}

function stableBlockId(
  prefix: string,
  type: MarkdownBlockType,
  contentHash: string,
  occurrence: number,
): string {
  return `${prefix}-block-${type}-${contentHash}-${occurrence + 1}`;
}

function stableOutlineId(title: string, index: number): string {
  const slug = markdownPreviewSlug(title);
  return `heading-${slug || "untitled"}-${index + 1}`;
}
