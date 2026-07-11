import { buildMarkdownDocumentModel } from "@/renderer/components/workspace/markdownPreviewEngine/parser";
import { markdownPreviewContentHash } from "@/renderer/components/workspace/markdownPreviewEngine/identity";
import type {
  MarkdownBlock,
  MarkdownBlockType,
} from "@/renderer/components/workspace/markdownPreviewEngine/types";

import type { DocumentContext } from "./DocumentTextModel";

export interface MarkdownLogicalSegment {
  readonly blockKey: string;
  readonly blockType: MarkdownBlockType;
  readonly context: DocumentContext;
  readonly logicalEnd: number;
  readonly logicalStart: number;
  readonly sourceEnd: number | null;
  readonly sourceStart: number | null;
  readonly text: string;
}

export interface MarkdownLogicalBlock {
  readonly context: DocumentContext;
  readonly key: string;
  readonly logicalEnd: number;
  readonly logicalStart: number;
  readonly sourceEnd: number;
  readonly sourceStart: number;
  readonly type: MarkdownBlockType;
}

export interface MarkdownLogicalDocument {
  readonly blocks: readonly MarkdownLogicalBlock[];
  readonly logicalText: string;
  readonly segments: readonly MarkdownLogicalSegment[];
  readonly textRevision: string;
}

interface PendingSegment {
  blockKey: string;
  blockType: MarkdownBlockType;
  context: DocumentContext;
  sourceEnd: number | null;
  sourceStart: number | null;
  text: string;
}

interface VisibleSlice {
  sourceStart: number | null;
  text: string;
}

const BLOCK_SEPARATOR = "\n\n";
const LINE_SEPARATOR = "\n";
const TABLE_CELL_SEPARATOR = "\t";

export function serializeMarkdownLogicalText(source: string): MarkdownLogicalDocument {
  const parsed = buildMarkdownDocumentModel(source);
  const pending: PendingSegment[] = [];
  const blocks: MarkdownLogicalBlock[] = [];
  const headings: string[] = [];

  for (const block of parsed.blocks) {
    const slices = visibleSlicesForBlock(block);
    if (!slices.some((slice) => slice.text.length > 0)) {
      continue;
    }
    if (pending.length > 0) {
      pending.push(separatorSegment(block, blockContext(block, headings), BLOCK_SEPARATOR));
    }
    if (block.type === "heading") {
      const title = slices.map((slice) => slice.text).join("").trim();
      updateHeadingPath(headings, block.metadata.headingLevel ?? 1, title);
    }
    const context = blockContext(block, headings);
    const blockLogicalStart = pendingTextLength(pending);
    for (const slice of slices) {
      appendVisibleSlice(pending, block, context, slice);
    }
    const blockLogicalEnd = pendingTextLength(pending);
    blocks.push(Object.freeze({
      context,
      key: block.id,
      logicalEnd: blockLogicalEnd,
      logicalStart: blockLogicalStart,
      sourceEnd: block.sourceEnd,
      sourceStart: block.sourceStart,
      type: block.type,
    }));
  }

  let logicalOffset = 0;
  const segments = pending.map((segment) => {
    const logicalStart = logicalOffset;
    logicalOffset += segment.text.length;
    return Object.freeze({ ...segment, logicalStart, logicalEnd: logicalOffset });
  });
  const logicalText = segments.map((segment) => segment.text).join("");
  return Object.freeze({
    blocks: Object.freeze(blocks),
    logicalText,
    segments: Object.freeze(segments),
    textRevision: `md-logical:${markdownPreviewContentHash(logicalText)}`,
  });
}

function appendVisibleSlice(
  output: PendingSegment[],
  block: MarkdownBlock,
  context: DocumentContext,
  slice: VisibleSlice,
): void {
  if (!slice.text) {
    return;
  }
  if (slice.sourceStart === null) {
    output.push(separatorSegment(block, context, slice.text));
    return;
  }
  output.push(...inlineSegments(slice.text, slice.sourceStart, block, context));
}

function visibleSlicesForBlock(block: MarkdownBlock): VisibleSlice[] {
  switch (block.type) {
    case "heading":
      return headingSlices(block);
    case "blockquote":
      return prefixedLineSlices(block, /^\s*>\s?/, false);
    case "list":
      return prefixedLineSlices(block, /^\s*(?:[-*+]|\d+[.)])\s+/, true);
    case "table":
      return tableSlices(block);
    case "code":
    case "fence":
      return codeSlices(block);
    case "thematic_break":
      return [];
    default:
      return trimmedSourceSlice(block);
  }
}

function headingSlices(block: MarkdownBlock): VisibleSlice[] {
  const source = block.sourceText;
  const atx = /^\s{0,3}#{1,6}[ \t]+/.exec(source);
  if (atx) {
    const rawEnd = source.search(/[ \t]+#+[ \t]*(?:\r?\n)?$/);
    const end = rawEnd >= atx[0].length ? rawEnd : trimLineEndingEnd(source);
    return [{ sourceStart: block.sourceStart + atx[0].length, text: source.slice(atx[0].length, end) }];
  }
  const firstLineEnd = lineEndOffset(source, 0);
  const line = source.slice(0, firstLineEnd);
  const start = line.length - line.trimStart().length;
  const end = line.trimEnd().length;
  return [{ sourceStart: block.sourceStart + start, text: line.slice(start, end) }];
}

function prefixedLineSlices(
  block: MarkdownBlock,
  prefixPattern: RegExp,
  removeTaskMarker: boolean,
): VisibleSlice[] {
  const output: VisibleSlice[] = [];
  for (const line of sourceLines(block.sourceText, block.sourceStart)) {
    const prefix = prefixPattern.exec(line.text)?.[0];
    if (!prefix) {
      continue;
    }
    let start = prefix.length;
    const remainder = line.text.slice(start);
    if (removeTaskMarker) {
      start += /^\[(?:x|X| )]\s+/.exec(remainder)?.[0].length ?? 0;
    }
    const text = line.text.slice(start).trimEnd();
    if (!text) {
      continue;
    }
    if (output.length > 0) {
      output.push({ sourceStart: null, text: LINE_SEPARATOR });
    }
    output.push({ sourceStart: line.sourceStart + start, text });
  }
  return output;
}

function tableSlices(block: MarkdownBlock): VisibleSlice[] {
  const output: VisibleSlice[] = [];
  let visibleRowCount = 0;
  for (const line of sourceLines(block.sourceText, block.sourceStart)) {
    const cells = tableCells(line.text, line.sourceStart);
    if (cells.length < 2 || cells.every((cell) => /^:?-{3,}:?$/.test(cell.text.trim()))) {
      continue;
    }
    if (visibleRowCount > 0) {
      output.push({ sourceStart: null, text: LINE_SEPARATOR });
    }
    cells.forEach((cell, index) => {
      if (index > 0) {
        output.push({ sourceStart: null, text: TABLE_CELL_SEPARATOR });
      }
      output.push({ sourceStart: cell.sourceStart, text: cell.text });
    });
    visibleRowCount += 1;
  }
  return output;
}

function codeSlices(block: MarkdownBlock): VisibleSlice[] {
  const source = block.sourceText;
  const fence = /^(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(source);
  if (fence) {
    const contentStart = fence[0].length;
    const closingStart = source.search(/(?:\r\n|\n|\r)?\s*(?:`{3,}|~{3,})\s*(?:\r\n|\n|\r)?$/);
    const contentEnd = closingStart >= contentStart ? closingStart : source.length;
    return [{ sourceStart: block.sourceStart + contentStart, text: source.slice(contentStart, contentEnd) }];
  }
  if (block.type === "code") {
    const output: VisibleSlice[] = [];
    for (const line of sourceLines(source, block.sourceStart)) {
      const prefix = /^(?: {4}|\t)/.exec(line.text)?.[0] ?? "";
      if (output.length > 0) {
        output.push({ sourceStart: null, text: LINE_SEPARATOR });
      }
      output.push({ sourceStart: line.sourceStart + prefix.length, text: line.text.slice(prefix.length) });
    }
    return output;
  }
  return [{ sourceStart: block.sourceStart, text: block.textContent }];
}

function trimmedSourceSlice(block: MarkdownBlock): VisibleSlice[] {
  const source = block.sourceText;
  const start = source.length - source.trimStart().length;
  const end = source.trimEnd().length;
  return end > start
    ? [{ sourceStart: block.sourceStart + start, text: source.slice(start, end) }]
    : [];
}

function inlineSegments(
  value: string,
  sourceStart: number,
  block: MarkdownBlock,
  context: DocumentContext,
): PendingSegment[] {
  const output: PendingSegment[] = [];
  const pattern = /(!\[([^\]]*)\]\((?:<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)|(\*\*|__)([\s\S]+?)\3|(\*|_)([^*_\n]+?)\5|~~([^~]+)~~|`([^`\n]+)`|\[([^\]]+)]\((?:<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    appendPlain(output, value.slice(cursor, match.index), sourceStart + cursor, block, context);
    if (match[1]?.startsWith("![")) {
      const alt = match[2] ?? "";
      appendPlain(output, alt, sourceStart + match.index + 2, block, context);
    } else if (match[4] !== undefined) {
      output.push(...inlineSegments(match[4], sourceStart + match.index + match[3].length, block, context));
    } else if (match[6] !== undefined) {
      output.push(...inlineSegments(match[6], sourceStart + match.index + match[5].length, block, context));
    } else if (match[7] !== undefined) {
      output.push(...inlineSegments(match[7], sourceStart + match.index + 2, block, context));
    } else if (match[8] !== undefined) {
      appendPlain(output, match[8], sourceStart + match.index + 1, block, context);
    } else if (match[9] !== undefined) {
      output.push(...inlineSegments(match[9], sourceStart + match.index + 1, block, context));
    } else {
      const math = match[10] ?? match[11] ?? "";
      const delimiterLength = match[10] !== undefined ? 2 : 1;
      appendPlain(output, math, sourceStart + match.index + delimiterLength, block, context);
    }
    cursor = match.index + match[0].length;
  }
  appendPlain(output, value.slice(cursor), sourceStart + cursor, block, context);
  return output;
}

function appendPlain(
  output: PendingSegment[],
  value: string,
  sourceStart: number,
  block: MarkdownBlock,
  context: DocumentContext,
): void {
  let cursor = 0;
  const escaped = /\\([\\`*{}\[\]()#+.!_>~-])/g;
  let match: RegExpExecArray | null;
  while ((match = escaped.exec(value)) !== null) {
    pushMapped(output, value.slice(cursor, match.index), sourceStart + cursor, block, context);
    pushMapped(output, match[1], sourceStart + match.index + 1, block, context);
    cursor = match.index + match[0].length;
  }
  pushMapped(output, value.slice(cursor), sourceStart + cursor, block, context);
}

function pushMapped(
  output: PendingSegment[],
  text: string,
  sourceStart: number,
  block: MarkdownBlock,
  context: DocumentContext,
): void {
  if (!text) {
    return;
  }
  output.push({
    blockKey: block.id,
    blockType: block.type,
    context,
    sourceEnd: sourceStart + text.length,
    sourceStart,
    text,
  });
}

function separatorSegment(
  block: MarkdownBlock,
  context: DocumentContext,
  text: string,
): PendingSegment {
  return {
    blockKey: block.id,
    blockType: block.type,
    context,
    sourceEnd: null,
    sourceStart: null,
    text,
  };
}

function blockContext(block: MarkdownBlock, headings: readonly string[]): DocumentContext {
  return Object.freeze({
    containerType: block.type,
    headingPath: Object.freeze([...headings]),
  });
}

function updateHeadingPath(headings: string[], level: number, title: string): void {
  headings.length = Math.max(0, level - 1);
  headings[level - 1] = title;
}

function pendingTextLength(segments: readonly PendingSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0);
}

function sourceLines(value: string, sourceStart: number): Array<{ sourceStart: number; text: string }> {
  const lines: Array<{ sourceStart: number; text: string }> = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = cursor;
    while (cursor < value.length && value[cursor] !== "\n" && value[cursor] !== "\r") {
      cursor += 1;
    }
    lines.push({ sourceStart: sourceStart + start, text: value.slice(start, cursor) });
    cursor += value[cursor] === "\r" && value[cursor + 1] === "\n" ? 2 : cursor < value.length ? 1 : 0;
  }
  return lines;
}

function tableCells(line: string, lineSourceStart: number): Array<{ sourceStart: number; text: string }> {
  const start = line.search(/\S/);
  const end = line.trimEnd().length;
  if (start < 0 || end <= start) {
    return [];
  }
  const contentStart = line[start] === "|" ? start + 1 : start;
  const contentEnd = line[end - 1] === "|" ? end - 1 : end;
  const cells: Array<{ sourceStart: number; text: string }> = [];
  let cellStart = contentStart;
  for (let index = contentStart; index <= contentEnd; index += 1) {
    if (index !== contentEnd && (line[index] !== "|" || line[index - 1] === "\\")) {
      continue;
    }
    const raw = line.slice(cellStart, index);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    cells.push({ sourceStart: lineSourceStart + cellStart + leading, text });
    cellStart = index + 1;
  }
  return cells;
}

function trimLineEndingEnd(value: string): number {
  return value.replace(/(?:\r\n|\r|\n)$/, "").length;
}

function lineEndOffset(value: string, start: number): number {
  const match = /\r\n|\r|\n/.exec(value.slice(start));
  return match ? start + match.index : value.length;
}
