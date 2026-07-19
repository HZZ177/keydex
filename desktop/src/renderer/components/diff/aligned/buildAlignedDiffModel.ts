import type {
  PierreAlignedContentSegment,
  PierreAlignedHunk,
  PierreAlignedPreparedFile,
} from "../engine/pierreAlignedAdapter";
import {
  createAlignedDiffStableId,
  type DiffPaneRow,
  type DiffPaneRowKind,
  type DiffPaneSide,
} from "./alignedDiffModel";
import { sanitizePierreAlignedAst } from "./safeHastRenderer";

export const DEFAULT_ALIGNED_ROW_HEIGHT = 20;

export interface KeydexAlignedPaneRows {
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly sourceVersion: string;
  readonly partial: boolean;
  readonly leftRows: readonly DiffPaneRow[];
  readonly rightRows: readonly DiffPaneRow[];
}

export interface BuildAlignedPaneRowsOptions {
  readonly estimatedRowHeight?: number;
}

export function buildAlignedPaneRows(
  prepared: PierreAlignedPreparedFile,
  options: BuildAlignedPaneRowsOptions = {},
): KeydexAlignedPaneRows {
  const estimatedHeight = options.estimatedRowHeight ?? DEFAULT_ALIGNED_ROW_HEIGHT;
  if (!Number.isFinite(estimatedHeight) || estimatedHeight <= 0) {
    throw new Error("estimatedRowHeight must be positive");
  }

  const leftRows: DiffPaneRow[] = [];
  const rightRows: DiffPaneRow[] = [];
  let segmentOrdinal = 0;
  let changeOrdinal = 0;

  for (const hunk of prepared.hunks) {
    const hunkId = alignedHunkId(prepared.fileCacheKey, hunk);
    hunk.content.forEach((content, contentIndex) => {
      const segmentId = alignedContentSegmentId(
        prepared.fileCacheKey,
        hunk,
        content,
        contentIndex,
        segmentOrdinal,
      );
      segmentOrdinal += 1;
      const changeId = content.type === "change"
        ? alignedChangeId(
          prepared.fileCacheKey,
          hunk,
          content,
          contentIndex,
          changeOrdinal++,
        )
        : null;
      const semanticKinds = contentRowKinds(prepared, content);

      appendContentRows({
        prepared,
        hunk,
        content,
        hunkId,
        segmentId,
        changeId,
        side: "old",
        rows: leftRows,
        estimatedHeight,
        semanticKinds,
      });
      appendContentRows({
        prepared,
        hunk,
        content,
        hunkId,
        segmentId,
        changeId,
        side: "new",
        rows: rightRows,
        estimatedHeight,
        semanticKinds,
      });
    });
  }

  return Object.freeze({
    fileId: prepared.fileId,
    fileCacheKey: prepared.fileCacheKey,
    sourceVersion: prepared.sourceVersion,
    partial: prepared.partial,
    leftRows: Object.freeze(leftRows),
    rightRows: Object.freeze(rightRows),
  });
}

interface AppendContentRowsOptions {
  readonly prepared: PierreAlignedPreparedFile;
  readonly hunk: PierreAlignedHunk;
  readonly content: PierreAlignedContentSegment;
  readonly hunkId: string;
  readonly segmentId: string;
  readonly changeId: string | null;
  readonly side: DiffPaneSide;
  readonly rows: DiffPaneRow[];
  readonly estimatedHeight: number;
  readonly semanticKinds: Readonly<Record<DiffPaneSide, readonly DiffPaneRowKind[]>>;
}

function appendContentRows(options: AppendContentRowsOptions): void {
  const {
    prepared,
    hunk,
    content,
    hunkId,
    segmentId,
    changeId,
    side,
    rows,
    estimatedHeight,
    semanticKinds,
  } = options;
  const isOld = side === "old";
  const lineCount = content.type === "context"
    ? content.lines
    : isOld ? content.deletions : content.additions;
  const sourceStart = isOld ? content.deletionLineIndex : content.additionLineIndex;
  const hunkSourceStart = isOld ? hunk.deletionLineIndex : hunk.additionLineIndex;
  const hunkLineStart = isOld ? hunk.deletionStart : hunk.additionStart;
  const sourceLines = isOld ? prepared.deletionLines : prepared.additionLines;
  const highlightedLines = isOld
    ? prepared.highlightedDeletionLines
    : prepared.highlightedAdditionLines;
  const noTrailingNewline = isOld ? hunk.noEofDeletions : hunk.noEofAdditions;
  const hunkLineCount = isOld ? hunk.deletionCount : hunk.additionCount;
  const hunkFinalSourceIndex = hunkSourceStart + hunkLineCount - 1;

  for (let offset = 0; offset < lineCount; offset += 1) {
    const sourceIndex = sourceStart + offset;
    if (sourceIndex < 0 || sourceIndex >= sourceLines.length) {
      throw new Error(`${prepared.fileId}: ${side} source index ${sourceIndex} is out of range`);
    }
    rows.push(Object.freeze({
      id: createAlignedDiffStableId(
        "row",
        prepared.fileCacheKey,
        sourceIndex,
        `${side}:${segmentId}`,
      ),
      fileId: prepared.fileId,
      side,
      kind: semanticKinds[side][offset] ?? rowKind(content, side),
      lineNumber: hunkLineStart + (sourceIndex - hunkSourceStart),
      sourceIndex,
      segmentId,
      changeId,
      hunkId,
      text: stripLineEnding(sourceLines[sourceIndex] ?? ""),
      tokens: sanitizePierreAlignedAst(highlightedLines[sourceIndex]),
      noTrailingNewline: noTrailingNewline && sourceIndex === hunkFinalSourceIndex,
      estimatedHeight,
    }));
  }
}

function rowKind(content: PierreAlignedContentSegment, side: DiffPaneSide): DiffPaneRowKind {
  if (content.type === "context") return "context";
  return side === "old" ? "removed" : "added";
}

interface OrderedLinePair {
  readonly oldOffset: number;
  readonly newOffset: number;
}

function contentRowKinds(
  prepared: PierreAlignedPreparedFile,
  content: PierreAlignedContentSegment,
): Readonly<Record<DiffPaneSide, readonly DiffPaneRowKind[]>> {
  if (content.type === "context") {
    const kinds = Object.freeze(Array.from({ length: content.lines }, () => "context" as const));
    return Object.freeze({ old: kinds, new: kinds });
  }
  if (content.deletions === 0) {
    return Object.freeze({
      old: Object.freeze([]),
      new: Object.freeze(Array.from({ length: content.additions }, () => "added" as const)),
    });
  }
  if (content.additions === 0) {
    return Object.freeze({
      old: Object.freeze(Array.from({ length: content.deletions }, () => "removed" as const)),
      new: Object.freeze([]),
    });
  }

  const oldLines = prepared.deletionLines
    .slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions)
    .map(stripLineEnding);
  const newLines = prepared.additionLines
    .slice(content.additionLineIndex, content.additionLineIndex + content.additions)
    .map(stripLineEnding);
  const pairs = alignModifiedLines(oldLines, newLines);
  const pairedOld = new Set(pairs.map(({ oldOffset }) => oldOffset));
  const pairedNew = new Set(pairs.map(({ newOffset }) => newOffset));
  return Object.freeze({
    old: Object.freeze(oldLines.map((_, offset) => pairedOld.has(offset) ? "modified" : "removed")),
    new: Object.freeze(newLines.map((_, offset) => pairedNew.has(offset) ? "modified" : "added")),
  });
}

const MAX_LINE_ALIGNMENT_CELLS = 40_000;
const LINE_GAP_SCORE = -0.45;

/**
 * Pairs structurally related replacement lines while preserving source order.
 * The unmatched rows keep their true insertion/deletion semantics.
 */
export function alignModifiedLines(
  oldLines: readonly string[],
  newLines: readonly string[],
): readonly OrderedLinePair[] {
  if (oldLines.length === 0 || newLines.length === 0) return Object.freeze([]);
  if (oldLines.length * newLines.length > MAX_LINE_ALIGNMENT_CELLS) {
    return Object.freeze(greedyLinePairs(oldLines, newLines));
  }

  const columns = newLines.length + 1;
  const scores = new Float64Array((oldLines.length + 1) * columns);
  const moves = new Uint8Array(scores.length);
  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    scores[oldIndex * columns] = oldIndex * LINE_GAP_SCORE;
    moves[oldIndex * columns] = 1;
  }
  for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
    scores[newIndex] = newIndex * LINE_GAP_SCORE;
    moves[newIndex] = 2;
  }

  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      const index = oldIndex * columns + newIndex;
      const diagonal = scores[index - columns - 1]
        + lineMatchScore(oldLines[oldIndex - 1] ?? "", newLines[newIndex - 1] ?? "");
      const up = scores[index - columns] + LINE_GAP_SCORE;
      const left = scores[index - 1] + LINE_GAP_SCORE;
      if (diagonal >= up && diagonal >= left) {
        scores[index] = diagonal;
        moves[index] = 3;
      } else if (up >= left) {
        scores[index] = up;
        moves[index] = 1;
      } else {
        scores[index] = left;
        moves[index] = 2;
      }
    }
  }

  const pairs: OrderedLinePair[] = [];
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;
  while (oldIndex > 0 || newIndex > 0) {
    const move = moves[oldIndex * columns + newIndex];
    if (move === 3) {
      pairs.push({ oldOffset: oldIndex - 1, newOffset: newIndex - 1 });
      oldIndex -= 1;
      newIndex -= 1;
    } else if (move === 1) {
      oldIndex -= 1;
    } else {
      newIndex -= 1;
    }
  }
  return Object.freeze(pairs.reverse());
}

function greedyLinePairs(
  oldLines: readonly string[],
  newLines: readonly string[],
): OrderedLinePair[] {
  if (oldLines.length <= newLines.length) {
    return scanSmallerSide(oldLines, newLines).map(({ smaller, larger }) => ({
      oldOffset: smaller,
      newOffset: larger,
    }));
  }
  return scanSmallerSide(newLines, oldLines).map(({ smaller, larger }) => ({
    oldOffset: larger,
    newOffset: smaller,
  }));
}

function scanSmallerSide(
  smallerLines: readonly string[],
  largerLines: readonly string[],
): Array<{ readonly smaller: number; readonly larger: number }> {
  const result: Array<{ readonly smaller: number; readonly larger: number }> = [];
  let cursor = 0;
  smallerLines.forEach((line, smaller) => {
    const remaining = smallerLines.length - smaller;
    const lastCandidate = Math.max(cursor, largerLines.length - remaining);
    let best = cursor;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let candidate = cursor; candidate <= lastCandidate; candidate += 1) {
      const score = lineMatchScore(line, largerLines[candidate] ?? "");
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    result.push({ smaller, larger: best });
    cursor = best + 1;
  });
  return result;
}

function lineMatchScore(oldLine: string, newLine: string): number {
  return lineSimilarity(oldLine, newLine) * 1.4 - 0.2;
}

function lineSimilarity(oldLine: string, newLine: string): number {
  const oldNormalized = oldLine.trim();
  const newNormalized = newLine.trim();
  if (oldNormalized === newNormalized) return 1;
  const oldTokens = lineTokens(oldNormalized);
  const newTokens = lineTokens(newNormalized);
  if (oldTokens.length === 0 || newTokens.length === 0) return 0;
  const counts = new Map<string, number>();
  oldTokens.forEach((token) => counts.set(token, (counts.get(token) ?? 0) + 1));
  let overlap = 0;
  newTokens.forEach((token) => {
    const count = counts.get(token) ?? 0;
    if (count <= 0) return;
    overlap += 1;
    counts.set(token, count - 1);
  });
  return (2 * overlap) / (oldTokens.length + newTokens.length);
}

function lineTokens(line: string): string[] {
  return line.toLowerCase().match(/[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu) ?? [];
}

export function alignedContentSegmentId(
  fileCacheKey: string,
  hunk: PierreAlignedHunk,
  content: PierreAlignedContentSegment,
  contentIndex: number,
  segmentOrdinal: number,
): string {
  return createAlignedDiffStableId(
    "segment",
    fileCacheKey,
    segmentOrdinal,
    `hunk:${hunk.index}:content:${contentIndex}:${content.type}`,
  );
}

export function alignedChangeId(
  fileCacheKey: string,
  hunk: PierreAlignedHunk,
  content: PierreAlignedContentSegment,
  contentIndex: number,
  changeOrdinal: number,
): string {
  if (content.type !== "change") throw new Error("change id requires ChangeContent");
  return createAlignedDiffStableId(
    "change",
    fileCacheKey,
    changeOrdinal,
    `hunk:${hunk.index}:content:${contentIndex}:${content.deletions}:${content.additions}`,
  );
}

export function alignedHunkId(fileCacheKey: string, hunk: PierreAlignedHunk): string {
  return createAlignedDiffStableId(
    "segment",
    fileCacheKey,
    hunk.index,
    `hunk:${hunk.deletionStart}:${hunk.additionStart}:${hunk.deletionCount}:${hunk.additionCount}`,
  ).replace("aligned-segment:", "aligned-hunk:");
}

function stripLineEnding(value: string): string {
  return value.replace(/\r?\n$/u, "");
}
