import type { MarkdownLineMap, MarkdownSourceRange } from "./types";

export interface MarkdownLineColumn {
  column: number;
  line: number;
}

export function createMarkdownLineMap(source: string): MarkdownLineMap {
  const lineStarts = markdownSourceLineStartOffsets(source);
  return {
    lineCount: lineStarts.length,
    lineStarts,
  };
}

export function markdownSourceLineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n" && index + 1 < source.length) {
      starts.push(index + 1);
    }
  }
  return starts;
}

export function markdownLineColumnAtOffset(source: string, offset: number): MarkdownLineColumn {
  const lineMap = createMarkdownLineMap(source);
  return markdownLineColumnAtOffsetWithMap(lineMap, source.length, offset);
}

export function markdownLineColumnAtOffsetWithMap(
  lineMap: MarkdownLineMap,
  sourceLength: number,
  offset: number,
): MarkdownLineColumn {
  const clampedOffset = Math.max(0, Math.min(offset, sourceLength));
  let lineIndex = 0;
  for (let index = 0; index < lineMap.lineStarts.length; index += 1) {
    if (lineMap.lineStarts[index] > clampedOffset) {
      break;
    }
    lineIndex = index;
  }
  return {
    line: lineIndex + 1,
    column: clampedOffset - lineMap.lineStarts[lineIndex] + 1,
  };
}

export function markdownRangeForLineSpan(
  source: string,
  lineMap: MarkdownLineMap,
  startLineIndex: number,
  endLineIndexExclusive: number,
): MarkdownSourceRange {
  const safeStartLine = clampLineIndex(lineMap, startLineIndex);
  const safeEndLineExclusive = clampExclusiveLineIndex(lineMap, endLineIndexExclusive);
  const sourceStart = lineMap.lineStarts[safeStartLine] ?? source.length;
  const sourceEnd = lineMap.lineStarts[safeEndLineExclusive] ?? source.length;
  return {
    sourceStart,
    sourceEnd,
    lineStart: safeStartLine + 1,
    lineEnd: Math.max(safeStartLine + 1, safeEndLineExclusive),
  };
}

function clampLineIndex(lineMap: MarkdownLineMap, value: number): number {
  if (lineMap.lineStarts.length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(value, lineMap.lineStarts.length - 1));
}

function clampExclusiveLineIndex(lineMap: MarkdownLineMap, value: number): number {
  return Math.max(1, Math.min(value, lineMap.lineStarts.length));
}
