import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

import { markdownSourceLineStartOffsets } from "@/renderer/markdownShared/sourceMap";
import {
  createMarkdownSnapshotFromImmutableParts,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
  type MarkdownSnapshotBlockKind,
  type MarkdownSnapshotBlockMetadata,
  type MarkdownSnapshotInlineKind,
  type MarkdownSnapshotInlineSpan,
  type MarkdownSnapshotResource,
  type MarkdownSnapshotSurface,
} from "../document/MarkdownSnapshot";
import {
  createMarkdownResourceIdentity,
  reconcileMarkdownBlockIdentities,
  stableMarkdownIdentityHash,
} from "../document/identity";

export interface MarkdownParserInput {
  readonly surface: MarkdownSnapshotSurface;
  readonly documentId: string;
  readonly revision: string;
  readonly source: string;
  readonly rendererProfile: "file-preview" | "conversation";
}

export interface MarkdownParserDiagnostics {
  readonly parseCalls: 1;
  readonly tokenCount: number;
  readonly blockCount: number;
  readonly resourceCount: number;
  readonly durationMs: number;
  readonly stages: {
    readonly markdownItMs: number;
    readonly draftBuildMs: number;
    readonly identityMs: number;
    readonly blockBuildMs: number;
    readonly snapshotFinalizeMs: number;
  };
}

export interface MarkdownParserOptions {
  readonly markdownIt?: Pick<MarkdownIt, "parse">;
  readonly signal?: AbortSignal;
  readonly shouldCancel?: () => boolean;
  readonly checkpointEveryTokens?: number;
  readonly previousSnapshot?: MarkdownSnapshot | null;
  readonly onDiagnostics?: (diagnostics: MarkdownParserDiagnostics) => void;
  readonly now?: () => number;
}

interface BlockDraft {
  readonly kind: MarkdownSnapshotBlockKind;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly sourceText: string;
  readonly textContent: string;
  readonly metadata: MarkdownSnapshotBlockMetadata;
  readonly tokens: readonly Token[];
}

const defaultMarkdownItByRendererProfile: Record<MarkdownParserInput["rendererProfile"], MarkdownIt> = {
  conversation: new MarkdownIt({
    breaks: true,
    html: false,
    linkify: false,
    typographer: false,
  }),
  "file-preview": new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true,
    typographer: false,
  }),
};

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

export class MarkdownParserCancelledError extends Error {
  constructor(message = "Markdown parse cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export function parseCanonicalMarkdownSnapshot(
  input: MarkdownParserInput,
  options: MarkdownParserOptions = {},
): MarkdownSnapshot {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  checkpoint(options);
  const frontmatter = frontmatterRange(input.source);
  const parserSource = frontmatter ? maskSourceRange(input.source, frontmatter.start, frontmatter.end) : input.source;
  const markdownIt = options.markdownIt ?? defaultMarkdownItByRendererProfile[input.rendererProfile];
  const tokens = markdownIt.parse(parserSource, {}) as Token[];
  const markdownItCompletedAt = now();
  checkpoint(options);
  const lineStarts = markdownSourceLineStartOffsets(input.source);
  const drafts: BlockDraft[] = [];
  if (frontmatter) {
    drafts.push({
      kind: "frontmatter",
      sourceStart: frontmatter.start,
      sourceEnd: frontmatter.end,
      lineStart: 0,
      lineEnd: lineIndexAtOffset(lineStarts, frontmatter.end),
      sourceText: input.source.slice(frontmatter.start, frontmatter.end),
      textContent: input.source.slice(frontmatter.start, frontmatter.end),
      metadata: { frontmatter_language: "yaml" },
      tokens: [],
    });
  }
  const checkpointEvery = options.checkpointEveryTokens ?? 256;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    if (tokenIndex % checkpointEvery === 0) checkpoint(options);
    const token = tokens[tokenIndex];
    if (token.level !== 0 || !token.map || !TOP_LEVEL_BLOCK_TYPES.has(token.type)) continue;
    const closingIndex = closingTokenIndex(tokens, tokenIndex);
    const blockTokens = tokens.slice(tokenIndex, closingIndex + 1);
    const range = sourceRangeForLines(input.source, lineStarts, token.map[0], token.map[1]);
    if (frontmatter && range.sourceStart < frontmatter.end) continue;
    const sourceText = input.source.slice(range.sourceStart, range.sourceEnd);
    drafts.push({
      kind: blockKind(token, sourceText),
      sourceStart: range.sourceStart,
      sourceEnd: range.sourceEnd,
      lineStart: range.lineStart,
      lineEnd: range.lineEnd,
      sourceText,
      textContent: blockTextContent(blockTokens),
      metadata: blockMetadata(token, blockTokens, sourceText),
      tokens: blockTokens,
    });
  }
  drafts.sort((left, right) => left.sourceStart - right.sourceStart);
  const draftsCompletedAt = now();
  const contentHashes = drafts.map((draft) => stableMarkdownIdentityHash(
    `${draft.kind}\n${identitySourceText(draft.sourceText)}`,
  ));
  const identities = reconcileMarkdownBlockIdentities(
    input.documentId,
    drafts.map((draft, index) => ({ kind: draft.kind, contentHash: contentHashes[index] })),
    options.previousSnapshot,
  );
  const identitiesCompletedAt = now();
  const blocks: MarkdownSnapshotBlock[] = [];
  const resources: MarkdownSnapshotResource[] = [];
  const logicalParts: string[] = [];
  let logicalOffset = 0;
  for (const [index, draft] of drafts.entries()) {
    checkpoint(options);
    const contentHash = contentHashes[index];
    const identity = identities[index];
    const blockId = identity.id;
    const textContent = draft.textContent || fallbackTextContent(draft);
    const logicalStart = logicalOffset;
    const logicalEnd = logicalStart + textContent.length;
    const inlineSpans = buildInlineSpans(draft, blockId, logicalStart, textContent);
    const block: MarkdownSnapshotBlock = {
      id: blockId,
      identity_key: identity.identityKey,
      content_hash: contentHash,
      index,
      kind: draft.kind,
      parent_id: null,
      depth: 0,
      source_start: draft.sourceStart,
      source_end: draft.sourceEnd,
      logical_start: logicalStart,
      logical_end: logicalEnd,
      line_start: draft.lineStart,
      line_end: draft.lineEnd,
      inline_spans: inlineSpans,
      metadata: draft.metadata,
    };
    blocks.push(block);
    resources.push(...buildResources(draft, block, logicalStart, textContent));
    logicalParts.push(textContent);
    logicalOffset = logicalEnd + (index === drafts.length - 1 ? 0 : 1);
  }
  const logicalText = logicalParts.join("\n");
  const blocksCompletedAt = now();
  const snapshot = createMarkdownSnapshotFromImmutableParts({
    surface: input.surface,
    document_id: input.documentId,
    revision: input.revision,
    renderer_profile: input.rendererProfile,
    mode: "canonical",
    source_bytes: new TextEncoder().encode(input.source).byteLength,
    source_characters: input.source.length,
    logical_text: logicalText,
    line_count: input.source ? lineStarts.length : 0,
    blocks,
    outline: blocks
      .filter((block) => block.kind === "heading" && block.metadata.heading_level)
      .map((block) => ({
        id: `${block.id}-outline`,
        block_id: block.id,
        level: block.metadata.heading_level as 1 | 2 | 3 | 4 | 5 | 6,
        title: logicalText.slice(block.logical_start, block.logical_end) || `Heading ${block.index + 1}`,
        source_line: block.line_start + 1,
      })),
    resources,
    stream: { kind: "canonical", finalized: true },
    indexes: {
      line_map_revision: `${input.revision}:line-map`,
      logical_projection_revision: `${input.revision}:logical`,
      source_index_revision: `${input.revision}:source`,
      find_index_revision: null,
      annotation_index_revision: null,
    },
  });
  options.onDiagnostics?.(Object.freeze({
    parseCalls: 1,
    tokenCount: tokens.length,
    blockCount: blocks.length,
    resourceCount: resources.length,
    durationMs: Math.max(0, now() - startedAt),
    stages: Object.freeze({
      markdownItMs: Math.max(0, markdownItCompletedAt - startedAt),
      draftBuildMs: Math.max(0, draftsCompletedAt - markdownItCompletedAt),
      identityMs: Math.max(0, identitiesCompletedAt - draftsCompletedAt),
      blockBuildMs: Math.max(0, blocksCompletedAt - identitiesCompletedAt),
      snapshotFinalizeMs: Math.max(0, now() - blocksCompletedAt),
    }),
  }));
  return snapshot;
}

function blockKind(token: Token, sourceText: string): MarkdownSnapshotBlockKind {
  const trimmed = sourceText.trim();
  switch (token.type) {
    case "blockquote_open":
      return "blockquote";
    case "bullet_list_open":
    case "ordered_list_open":
      return "list";
    case "code_block":
      return "code";
    case "fence": {
      const language = token.info.trim().split(/\s+/u, 1)[0]?.toLowerCase();
      if (language === "mermaid") return "mermaid";
      if (language === "math" || language === "latex" || language === "tex") return "math";
      return "code";
    }
    case "heading_open":
      return "heading";
    case "hr":
      return "thematic-break";
    case "html_block":
      return "html";
    case "table_open":
      return "table";
    case "paragraph_open":
      if (/^\$\$[\s\S]*\$\$$/u.test(trimmed)) return "math";
      if (/^<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/iu.test(trimmed)) return "html";
      if (/^!\[[^\]]*\]\([^)]+\)\s*$/u.test(trimmed)) return "image";
      return "paragraph";
    default:
      return "unknown";
  }
}

function blockMetadata(
  token: Token,
  blockTokens: readonly Token[],
  sourceText: string,
): MarkdownSnapshotBlockMetadata {
  const metadata: {
    heading_level?: 1 | 2 | 3 | 4 | 5 | 6;
    language?: string;
    fence_markup?: string;
    fence_closed?: boolean;
    list?: MarkdownSnapshotBlockMetadata["list"];
    table?: MarkdownSnapshotBlockMetadata["table"];
    task?: MarkdownSnapshotBlockMetadata["task"];
    html_policy?: "escaped" | "sanitized";
  } = {};
  if (token.type === "heading_open") {
    const level = Number(token.tag.replace(/^h/u, ""));
    if (level >= 1 && level <= 6) metadata.heading_level = level as 1 | 2 | 3 | 4 | 5 | 6;
  }
  if (token.type === "fence" || token.type === "code_block") {
    const language = token.info.trim().split(/\s+/u, 1)[0];
    if (language) metadata.language = language;
    if (token.markup) {
      metadata.fence_markup = token.markup;
      metadata.fence_closed = fenceClosed(sourceText, token.markup);
    }
  }
  if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
    const ordered = token.type === "ordered_list_open";
    const startAttribute = token.attrGet("start");
    const start = startAttribute === null ? null : Number.parseInt(startAttribute, 10);
    metadata.list = {
      ordered,
      start: Number.isSafeInteger(start) ? start : null,
      tight: blockTokens.some((entry) => entry.type === "paragraph_open" && entry.hidden),
      item_count: blockTokens.filter((entry) => entry.type === "list_item_open").length,
      items: listItemMetadata(blockTokens),
    };
    if (/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/mu.test(sourceText)) metadata.task = { checked: null };
  }
  if (token.type === "table_open") {
    const firstRowEnd = blockTokens.findIndex((entry) => entry.type === "tr_close");
    const headerTokens = firstRowEnd < 0 ? blockTokens : blockTokens.slice(0, firstRowEnd + 1);
    const cells = headerTokens.filter((entry) => entry.type === "th_open");
    metadata.table = {
      columns: cells.length,
      alignments: cells.map((cell) => tableAlignment(cell.attrGet("style"))),
    };
  }
  if (token.type === "html_block" || /^\s*</u.test(sourceText)) metadata.html_policy = "escaped";
  return metadata;
}

function fenceClosed(sourceText: string, markup: string): boolean {
  const marker = markup[0];
  const minimum = markup.length;
  const lines = sourceText.trimEnd().split("\n");
  return lines.slice(1).some((line) => {
    const match = new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{${minimum},}\\s*$`, "u").exec(line);
    return Boolean(match);
  });
}

function buildInlineSpans(
  draft: BlockDraft,
  blockId: string,
  logicalStart: number,
  textContent: string,
): MarkdownSnapshotInlineSpan[] {
  if (!textContent) return [];
  const spans: MarkdownSnapshotInlineSpan[] = [];
  const sourceSearch = draft.sourceText;
  let sourceCursor = 0;
  let logicalCursor = 0;
  let sequence = 0;
  const inlineTokens = draft.tokens.flatMap((token) => token.type === "inline" ? token.children ?? [] : []);
  const active: Array<{
    readonly kind: MarkdownSnapshotInlineKind;
    readonly attributes: Record<string, string | number | boolean | null>;
  }> = [];
  for (const token of inlineTokens) {
    const mark = inlineKindForToken(token.type);
    if (token.nesting === 1 && mark) {
      active.push({ kind: mark, attributes: inlineAttributes(token) });
      continue;
    }
    if (token.nesting === -1 && mark) {
      const index = active.findLastIndex((entry) => entry.kind === mark);
      if (index >= 0) active.splice(index, 1);
      continue;
    }
    const content = token.type === "softbreak" || token.type === "hardbreak" ? "\n" : token.content;
    if (!content) continue;
    const sourceFound = sourceSearch.indexOf(content, sourceCursor);
    const logicalFound = textContent.indexOf(content, logicalCursor);
    const sourceLocalStart = sourceFound >= 0 ? sourceFound : sourceCursor;
    const logicalLocalStart = logicalFound >= 0 ? logicalFound : logicalCursor;
    const activeMark = active.at(-1);
    if (token.type === "text" && !activeMark) {
      const segments = inlineMathSegments(content);
      if (segments.some((segment) => segment.kind === "math")) {
        for (const segment of segments) {
          spans.push({
            id: `${blockId}-inline-${++sequence}`,
            kind: segment.kind,
            source_start: draft.sourceStart + Math.min(sourceLocalStart + segment.start, sourceSearch.length),
            source_end: draft.sourceStart + Math.min(sourceLocalStart + segment.end, sourceSearch.length),
            logical_start: logicalStart + Math.min(logicalLocalStart + segment.start, textContent.length),
            logical_end: logicalStart + Math.min(logicalLocalStart + segment.end, textContent.length),
            attributes: {},
          });
        }
        sourceCursor = Math.min(sourceSearch.length, sourceLocalStart + content.length);
        logicalCursor = Math.min(textContent.length, logicalLocalStart + content.length);
        continue;
      }
    }
    const kind = leafInlineKind(token.type) ?? activeMark?.kind ?? "text";
    const attributes = {
      ...(activeMark?.attributes ?? {}),
      ...inlineAttributes(token),
    };
    if (kind === "image" && attributes.alt === undefined) attributes.alt = token.content;
    spans.push({
      id: `${blockId}-inline-${++sequence}`,
      kind,
      source_start: draft.sourceStart + Math.min(sourceLocalStart, sourceSearch.length),
      source_end: draft.sourceStart + Math.min(sourceLocalStart + content.length, sourceSearch.length),
      logical_start: logicalStart + Math.min(logicalLocalStart, textContent.length),
      logical_end: logicalStart + Math.min(logicalLocalStart + content.length, textContent.length),
      attributes,
    });
    sourceCursor = Math.min(sourceSearch.length, sourceLocalStart + content.length);
    logicalCursor = Math.min(textContent.length, logicalLocalStart + content.length);
  }
  if (!spans.length) {
    const localStart = draft.sourceText.indexOf(textContent);
    spans.push({
      id: `${blockId}-inline-1`,
      kind: "text",
      source_start: draft.sourceStart + Math.max(0, localStart),
      source_end: draft.sourceStart + Math.min(
        draft.sourceText.length,
        Math.max(0, localStart) + textContent.length,
      ),
      logical_start: logicalStart,
      logical_end: logicalStart + textContent.length,
      attributes: {},
    });
  }
  return spans;
}

function inlineMathSegments(content: string): Array<{ kind: "text" | "math"; start: number; end: number }> {
  const segments: Array<{ kind: "text" | "math"; start: number; end: number }> = [];
  let cursor = 0;
  for (const match of content.matchAll(/\$(?!\$)[^$\r\n]+\$/gu)) {
    if (match.index > cursor) segments.push({ kind: "text", start: cursor, end: match.index });
    segments.push({ kind: "math", start: match.index, end: match.index + match[0].length });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) segments.push({ kind: "text", start: cursor, end: content.length });
  return segments;
}

function listItemMetadata(blockTokens: readonly Token[]): NonNullable<MarkdownSnapshotBlockMetadata["list"]>["items"] {
  interface Draft {
    readonly depth: number;
    readonly ordered: boolean;
    readonly ordinal: number | null;
    checked: boolean | null;
    logicalStart: number | null;
    logicalEnd: number | null;
  }
  const listStack: Array<{ ordered: boolean; next: number }> = [];
  const itemStack: Draft[] = [];
  const drafts: Draft[] = [];
  const occurrences: Array<{ draft: Draft; text: string }> = [];
  for (const token of blockTokens) {
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const start = Number.parseInt(token.attrGet("start") ?? "1", 10);
      listStack.push({ ordered: token.type === "ordered_list_open", next: Number.isSafeInteger(start) ? start : 1 });
      continue;
    }
    if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
      listStack.pop();
      continue;
    }
    if (token.type === "list_item_open") {
      const list = listStack.at(-1) ?? { ordered: false, next: 1 };
      const draft: Draft = {
        depth: Math.max(0, listStack.length - 1),
        ordered: list.ordered,
        ordinal: list.ordered ? list.next++ : null,
        checked: null,
        logicalStart: null,
        logicalEnd: null,
      };
      drafts.push(draft);
      itemStack.push(draft);
      continue;
    }
    if (token.type === "list_item_close") {
      itemStack.pop();
      continue;
    }
    if (token.type === "inline" && itemStack.length) {
      occurrences.push({ draft: itemStack.at(-1)!, text: tokenTextContent(token) });
    }
  }
  const logicalText = blockTextContent(blockTokens);
  let cursor = 0;
  for (const occurrence of occurrences) {
    const found = logicalText.indexOf(occurrence.text, cursor);
    const start = found >= 0 ? found : cursor;
    cursor = Math.min(logicalText.length, start + occurrence.text.length);
    if (occurrence.draft.logicalStart !== null) continue;
    const task = /^\[([ xX])\]\s+/u.exec(occurrence.text);
    occurrence.draft.checked = task ? task[1].toLowerCase() === "x" : null;
    occurrence.draft.logicalStart = start + (task?.[0].length ?? 0);
    occurrence.draft.logicalEnd = start + occurrence.text.length;
  }
  return Object.freeze(drafts.map((draft) => Object.freeze({
    depth: draft.depth,
    ordered: draft.ordered,
    ordinal: draft.ordinal,
    checked: draft.checked,
    logical_start: draft.logicalStart ?? 0,
    logical_end: draft.logicalEnd ?? draft.logicalStart ?? 0,
  })));
}

function buildResources(
  draft: BlockDraft,
  block: MarkdownSnapshotBlock,
  logicalStart: number,
  textContent: string,
): MarkdownSnapshotResource[] {
  const resources: MarkdownSnapshotResource[] = [];
  const seen = new Set<string>();
  const occurrences = new Map<string, number>();
  const add = (
    kind: MarkdownSnapshotResource["kind"],
    sourceLocalStart: number,
    sourceLocalEnd: number,
    url: string | null,
    alt: string | null,
  ) => {
    const key = `${kind}\u0000${url ?? ""}\u0000${sourceLocalStart}`;
    if (seen.has(key)) return;
    seen.add(key);
    const contentHash = stableMarkdownIdentityHash(draft.sourceText.slice(sourceLocalStart, sourceLocalEnd));
    const signature = `${kind}\u0000${contentHash}\u0000${url ?? ""}\u0000${alt ?? ""}`;
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    resources.push({
      id: createMarkdownResourceIdentity({
        blockId: block.id,
        kind,
        contentHash,
        url,
        alt,
        occurrence,
      }),
      block_id: block.id,
      kind,
      cache_key: `${kind}:${contentHash}:${url ?? ""}`,
      url,
      alt,
      content_hash: contentHash,
      source_start: draft.sourceStart + sourceLocalStart,
      source_end: draft.sourceStart + sourceLocalEnd,
      logical_start: logicalStart,
      logical_end: logicalStart + textContent.length,
    });
  };
  for (const match of draft.sourceText.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    add("image", match.index, match.index + match[0].length, match[2], match[1]);
  }
  for (const match of draft.sourceText.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    add("link", match.index, match.index + match[0].length, match[2], match[1]);
  }
  let linkCursor = 0;
  for (const token of draft.tokens.flatMap((entry) => entry.type === "inline" ? entry.children ?? [] : [])) {
    if (token.type !== "link_open") continue;
    const href = token.attrGet("href");
    if (!href) continue;
    const found = draft.sourceText.indexOf(href, linkCursor);
    if (found < 0) continue;
    linkCursor = found + href.length;
    const covered = resources.some((resource) => resource.kind === "link"
      && resource.url === href
      && draft.sourceStart + found >= resource.source_start
      && draft.sourceStart + found < resource.source_end);
    if (!covered) add("link", found, found + href.length, href, null);
  }
  if (block.kind !== "math") {
    for (const match of draft.sourceText.matchAll(/\$(?!\$)([^$\r\n]+)\$/gu)) {
      add("math", match.index, match.index + match[0].length, null, null);
    }
  }
  if (block.kind === "mermaid") add("mermaid", 0, draft.sourceText.length, null, null);
  if (block.kind === "math") add("math", 0, draft.sourceText.length, null, null);
  if (block.kind === "html") add("html", 0, draft.sourceText.length, null, null);
  return resources;
}

function inlineKindForToken(type: string): MarkdownSnapshotInlineKind | null {
  if (type === "strong_open" || type === "strong_close") return "strong";
  if (type === "em_open" || type === "em_close") return "emphasis";
  if (type === "s_open" || type === "s_close") return "strikethrough";
  if (type === "link_open" || type === "link_close") return "link";
  return null;
}

function leafInlineKind(type: string): MarkdownSnapshotInlineKind | null {
  if (type === "code_inline") return "code";
  if (type === "image") return "image";
  if (type === "softbreak") return "softbreak";
  if (type === "hardbreak") return "hardbreak";
  if (type === "html_inline") return "html";
  return null;
}

function inlineAttributes(token: Token): Record<string, string | number | boolean | null> {
  const attributes: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of token.attrs ?? []) attributes[name] = value;
  return attributes;
}

function blockTextContent(tokens: readonly Token[]): string {
  return tokens
    .map(tokenTextContent)
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function tokenTextContent(token: Token): string {
  if (token.children?.length) return token.children.map(tokenTextContent).filter(Boolean).join("");
  if (token.type === "softbreak" || token.type === "hardbreak") return "\n";
  if (token.type.endsWith("_open") || token.type.endsWith("_close")) return "";
  return token.content;
}

function fallbackTextContent(draft: BlockDraft): string {
  if (draft.kind === "thematic-break") return "";
  return draft.sourceText.trim();
}

function closingTokenIndex(tokens: readonly Token[], openIndex: number): number {
  const openToken = tokens[openIndex];
  if (openToken.nesting !== 1) return openIndex;
  const closeType = openToken.type.replace(/_open$/u, "_close");
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index].type === closeType && tokens[index].level === openToken.level) return index;
  }
  return openIndex;
}

function sourceRangeForLines(
  source: string,
  lineStarts: readonly number[],
  startLine: number,
  endLineExclusive: number,
) {
  const safeStart = Math.max(0, Math.min(startLine, Math.max(0, lineStarts.length - 1)));
  const safeEnd = Math.max(safeStart + 1, Math.min(endLineExclusive, lineStarts.length));
  return {
    sourceStart: lineStarts[safeStart] ?? source.length,
    sourceEnd: lineStarts[safeEnd] ?? source.length,
    lineStart: safeStart,
    lineEnd: safeEnd,
  };
}

function frontmatterRange(source: string): { start: number; end: number } | null {
  const match = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(source);
  return match ? { start: 0, end: match[0].length } : null;
}

function maskSourceRange(source: string, start: number, end: number): string {
  const masked = source.slice(start, end).replace(/[^\r\n]/gu, " ");
  return source.slice(0, start) + masked + source.slice(end);
}

function lineIndexAtOffset(lineStarts: readonly number[], offset: number): number {
  let index = 0;
  while (index < lineStarts.length && lineStarts[index] < offset) index += 1;
  return Math.max(1, index);
}

function tableAlignment(style: string | null): "left" | "center" | "right" | null {
  if (!style) return null;
  if (/text-align\s*:\s*center/iu.test(style)) return "center";
  if (/text-align\s*:\s*right/iu.test(style)) return "right";
  if (/text-align\s*:\s*left/iu.test(style)) return "left";
  return null;
}

function checkpoint(options: MarkdownParserOptions): void {
  if (options.signal?.aborted || options.shouldCancel?.()) throw new MarkdownParserCancelledError();
}

function identitySourceText(value: string): string {
  // markdown-it block maps include the separator line after a non-final block.
  // That separator is layout between blocks, not content owned by either block.
  return value.trimEnd();
}
