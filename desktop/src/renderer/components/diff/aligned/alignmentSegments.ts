import type {
  PierreAlignedContentSegment,
  PierreAlignedHunk,
  PierreAlignedPreparedFile,
} from "../engine/pierreAlignedAdapter";
import {
  createAlignedDiffStableId,
  createKeydexAlignedDiffModel,
  type DiffAlignmentSegment,
  type DiffChangeBlock,
  type DiffPaneSide,
  type DiffSideRange,
  type KeydexAlignedDiffModel,
} from "./alignedDiffModel";
import {
  alignedChangeId,
  alignedContentSegmentId,
  alignedHunkId,
  buildAlignedPaneRows,
  type KeydexAlignedPaneRows,
} from "./buildAlignedDiffModel";

export interface KeydexAlignmentSegments {
  readonly segments: readonly DiffAlignmentSegment[];
  readonly changes: readonly DiffChangeBlock[];
}

export function buildAlignmentSegments(
  prepared: PierreAlignedPreparedFile,
  paneRows: KeydexAlignedPaneRows = buildAlignedPaneRows(prepared),
): KeydexAlignmentSegments {
  const segments: DiffAlignmentSegment[] = [];
  const changes: DiffChangeBlock[] = [];
  let leftRow = 0;
  let rightRow = 0;
  let segmentOrdinal = 0;
  let changeOrdinal = 0;

  for (const hunk of prepared.hunks) {
    const hunkId = alignedHunkId(prepared.fileCacheKey, hunk);
    if (hunk.collapsedBefore > 0) {
      segments.push(Object.freeze({
        id: createAlignedDiffStableId(
          "segment",
          prepared.fileCacheKey,
          segmentOrdinal + prepared.hunks.length + hunk.index,
          `hunk:${hunk.index}:collapsed:${hunk.collapsedBefore}`,
        ),
        kind: "collapsed_gap",
        left: collapsedRange(leftRow, hunk.deletionStart, hunk.collapsedBefore),
        right: collapsedRange(rightRow, hunk.additionStart, hunk.collapsedBefore),
        hunkId,
        changeId: null,
      }));
    }

    hunk.content.forEach((content, contentIndex) => {
      const segmentId = alignedContentSegmentId(
        prepared.fileCacheKey,
        hunk,
        content,
        contentIndex,
        segmentOrdinal,
      );
      const leftCount = content.type === "context" ? content.lines : content.deletions;
      const rightCount = content.type === "context" ? content.lines : content.additions;
      const changeId = content.type === "change"
        ? alignedChangeId(
          prepared.fileCacheKey,
          hunk,
          content,
          contentIndex,
          changeOrdinal++,
        )
        : null;
      const left = contentRange(hunk, content, "old", leftRow, leftCount);
      const right = contentRange(hunk, content, "new", rightRow, rightCount);
      const segment: DiffAlignmentSegment = Object.freeze({
        id: segmentId,
        kind: content.type,
        left,
        right,
        hunkId,
        changeId,
      });
      segments.push(segment);
      if (changeId) {
        changes.push(Object.freeze({
          id: changeId,
          segmentId,
          kind: leftCount === 0 ? "added" : rightCount === 0 ? "removed" : "modified",
          left,
          right,
        }));
      }
      leftRow += leftCount;
      rightRow += rightCount;
      segmentOrdinal += 1;
    });
  }

  assertRowsBelongToSegments(paneRows, segments);
  return Object.freeze({
    segments: Object.freeze(segments),
    changes: Object.freeze(changes),
  });
}

export function buildKeydexAlignedDiffModel(
  prepared: PierreAlignedPreparedFile,
): KeydexAlignedDiffModel {
  const paneRows = buildAlignedPaneRows(prepared);
  const alignment = buildAlignmentSegments(prepared, paneRows);
  return createKeydexAlignedDiffModel({
    fileId: prepared.fileId,
    fileCacheKey: prepared.fileCacheKey,
    sourceVersion: prepared.sourceVersion,
    cacheKey: `${prepared.fileCacheKey}:${prepared.sourceVersion}:aligned-v1`,
    partial: prepared.partial,
    leftRows: paneRows.leftRows,
    rightRows: paneRows.rightRows,
    segments: alignment.segments,
    changes: alignment.changes,
  });
}

export type DiffSegmentLookupBias = "containing" | "previous" | "next";

export function findAlignmentSegmentByRow(
  segments: readonly DiffAlignmentSegment[],
  side: DiffPaneSide,
  rowIndex: number,
  bias: DiffSegmentLookupBias = "containing",
): DiffAlignmentSegment | null {
  if (!Number.isInteger(rowIndex) || rowIndex < 0) return null;
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle]![side === "old" ? "left" : "right"].endRow <= rowIndex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const candidate = segments[low];
  if (candidate) {
    const range = candidate[side === "old" ? "left" : "right"];
    if (range.startRow <= rowIndex && rowIndex < range.endRow) return candidate;
  }
  if (bias === "next") {
    for (let index = Math.max(0, low - 1); index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (segment[side === "old" ? "left" : "right"].startRow >= rowIndex) return segment;
    }
  }
  if (bias === "previous") {
    for (let index = Math.min(segments.length - 1, low); index >= 0; index -= 1) {
      const segment = segments[index]!;
      if (segment[side === "old" ? "left" : "right"].endRow <= rowIndex) return segment;
    }
  }
  return null;
}

function contentRange(
  hunk: PierreAlignedHunk,
  content: PierreAlignedContentSegment,
  side: DiffPaneSide,
  startRow: number,
  count: number,
): DiffSideRange {
  if (count === 0) return Object.freeze({ startRow, endRow: startRow, startLine: null, endLine: null });
  const isOld = side === "old";
  const sourceStart = isOld ? content.deletionLineIndex : content.additionLineIndex;
  const hunkSourceStart = isOld ? hunk.deletionLineIndex : hunk.additionLineIndex;
  const hunkLineStart = isOld ? hunk.deletionStart : hunk.additionStart;
  const startLine = hunkLineStart + sourceStart - hunkSourceStart;
  return Object.freeze({
    startRow,
    endRow: startRow + count,
    startLine,
    endLine: startLine + count - 1,
  });
}

function collapsedRange(row: number, hunkStart: number, count: number): DiffSideRange {
  const startLine = Math.max(1, hunkStart - count);
  return Object.freeze({
    startRow: row,
    endRow: row,
    startLine,
    endLine: Math.max(startLine, hunkStart - 1),
  });
}

function assertRowsBelongToSegments(
  rows: KeydexAlignedPaneRows,
  segments: readonly DiffAlignmentSegment[],
): void {
  const segmentIds = new Set(segments.map(({ id }) => id));
  for (const row of [...rows.leftRows, ...rows.rightRows]) {
    if (!segmentIds.has(row.segmentId)) {
      throw new Error(`${row.id}: row refers to an unknown alignment segment`);
    }
  }
}
