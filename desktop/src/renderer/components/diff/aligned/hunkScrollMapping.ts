import type {
  DiffAlignmentSegment,
  DiffChangeBlock,
  DiffPaneSide,
  DiffSemanticAnchor,
  DiffSideRange,
  KeydexAlignedDiffModel,
} from "./alignedDiffModel";
import type { DiffRowHeightIndex } from "./rowHeightIndex";

export interface DiffPanePixelRange {
  readonly start: number;
  readonly end: number;
}

export interface DiffSegmentPixelMapping {
  readonly segment: DiffAlignmentSegment;
  readonly change: DiffChangeBlock | null;
  /** Real, continuous painted content on each side. No alignment slack is inserted. */
  readonly left: DiffPanePixelRange;
  readonly right: DiffPanePixelRange;
}

export interface DiffScrollAlignmentPoint {
  readonly left: number;
  readonly right: number;
}

export interface DiffScrollMappingMetrics {
  readonly segments: readonly DiffSegmentPixelMapping[];
  readonly leftTotalHeight: number;
  readonly rightTotalHeight: number;
  readonly leftRowOffsets?: readonly number[];
  readonly rightRowOffsets?: readonly number[];
  /** Monotonic semantic path used for master-side, piecewise scroll mapping. */
  readonly alignmentPoints?: readonly DiffScrollAlignmentPoint[];
}

export interface DiffScrollMappingAnchor extends DiffSemanticAnchor {
  readonly side: DiffPaneSide;
  readonly segmentOffset: number;
  readonly segmentFraction: number;
  readonly atSegmentEnd: boolean;
}

export interface DiffScrollMappingOptions {
  readonly collapsedGapHeight?: number;
}

export interface DiffViewportScrollMappingOptions {
  readonly sourceBottomScrollSpace?: number;
  readonly targetBottomScrollSpace?: number;
}

export function buildScrollMappingMetrics(
  model: KeydexAlignedDiffModel,
  leftHeights: DiffRowHeightIndex,
  rightHeights: DiffRowHeightIndex,
  options: DiffScrollMappingOptions = {},
): DiffScrollMappingMetrics {
  if (leftHeights.length !== model.leftRows.length || rightHeights.length !== model.rightRows.length) {
    throw new Error("height index row count must match aligned model");
  }
  const collapsedGapHeight = options.collapsedGapHeight ?? 30;
  if (!Number.isFinite(collapsedGapHeight) || collapsedGapHeight < 0) {
    throw new TypeError("collapsedGapHeight must be non-negative");
  }
  const leftRowOffsets = Array.from({ length: model.leftRows.length }, () => Number.NaN);
  const rightRowOffsets = Array.from({ length: model.rightRows.length }, () => Number.NaN);
  let leftCursor = 0;
  let rightCursor = 0;
  let leftRowCursor = 0;
  let rightRowCursor = 0;
  const alignmentPoints: DiffScrollAlignmentPoint[] = [frozenPoint(0, 0)];
  const changeBySegment = new Map(model.changes.map((change) => [change.segmentId, change]));
  const segments: DiffSegmentPixelMapping[] = [];
  for (const segment of model.segments) {
    [leftCursor, rightCursor] = placePairedRows(
      leftRowCursor,
      segment.left.startRow,
      rightRowCursor,
      segment.right.startRow,
      leftCursor,
      rightCursor,
      leftHeights,
      rightHeights,
      leftRowOffsets,
      rightRowOffsets,
      alignmentPoints,
    );
    leftRowCursor = segment.left.startRow;
    rightRowCursor = segment.right.startRow;
    if (segment.kind === "collapsed_gap") {
      const left = frozenRange(leftCursor, leftCursor + collapsedGapHeight);
      const right = frozenRange(rightCursor, rightCursor + collapsedGapHeight);
      leftCursor = left.end;
      rightCursor = right.end;
      appendAlignmentPoint(alignmentPoints, leftCursor, rightCursor);
      segments.push(Object.freeze({ segment, change: null, left, right }));
      continue;
    }

    const leftStart = leftCursor;
    const rightStart = rightCursor;
    if (segment.kind === "context") {
      [leftCursor, rightCursor] = placePairedRows(
        segment.left.startRow,
        segment.left.endRow,
        segment.right.startRow,
        segment.right.endRow,
        leftCursor,
        rightCursor,
        leftHeights,
        rightHeights,
        leftRowOffsets,
        rightRowOffsets,
        alignmentPoints,
      );
      segments.push(Object.freeze({
        segment,
        change: null,
        left: frozenRange(leftStart, leftCursor),
        right: frozenRange(rightStart, rightCursor),
      }));
    } else {
      [leftCursor, rightCursor] = placeChangeRows(
        model,
        segment.left,
        segment.right,
        leftCursor,
        rightCursor,
        leftHeights,
        rightHeights,
        leftRowOffsets,
        rightRowOffsets,
        alignmentPoints,
      );
      segments.push(Object.freeze({
        segment,
        change: changeBySegment.get(segment.id) ?? null,
        left: frozenRange(leftStart, leftCursor),
        right: frozenRange(rightStart, rightCursor),
      }));
    }
    leftRowCursor = segment.left.endRow;
    rightRowCursor = segment.right.endRow;
  }
  [leftCursor, rightCursor] = placePairedRows(
    leftRowCursor,
    model.leftRows.length,
    rightRowCursor,
    model.rightRows.length,
    leftCursor,
    rightCursor,
    leftHeights,
    rightHeights,
    leftRowOffsets,
    rightRowOffsets,
    alignmentPoints,
  );
  return Object.freeze({
    segments: Object.freeze(segments),
    leftTotalHeight: leftCursor,
    rightTotalHeight: rightCursor,
    leftRowOffsets: Object.freeze(leftRowOffsets),
    rightRowOffsets: Object.freeze(rightRowOffsets),
    alignmentPoints: Object.freeze(alignmentPoints),
  });
}

export function captureDiffScrollAnchor(
  model: KeydexAlignedDiffModel,
  metrics: DiffScrollMappingMetrics,
  heights: DiffRowHeightIndex,
  side: DiffPaneSide,
  offset: number,
): DiffScrollMappingAnchor | null {
  if (!Number.isFinite(offset) || metrics.segments.length === 0) return null;
  const total = side === "old" ? metrics.leftTotalHeight : metrics.rightTotalHeight;
  const clampedOffset = Math.min(total, Math.max(0, offset));
  const atPaneEnd = clampedOffset === total;
  const mapping = atPaneEnd
    ? metrics.segments[metrics.segments.length - 1]!
    : findPixelSegment(metrics.segments, side, clampedOffset);
  const pixelRange = pixelRangeForSide(mapping, side);
  const segmentHeight = pixelRange.end - pixelRange.start;
  const segmentOffset = atPaneEnd
    ? segmentHeight
    : Math.min(segmentHeight, Math.max(0, clampedOffset - pixelRange.start));
  const segmentFraction = segmentHeight === 0 ? (atPaneEnd ? 1 : 0) : segmentOffset / segmentHeight;
  const sideRange = rowRangeForSide(mapping.segment, side);
  let rowId: string | null = null;
  let rowFraction = segmentFraction;
  if (sideRange.endRow > sideRange.startRow && mapping.segment.kind !== "collapsed_gap") {
    const rowOffsets = rowOffsetsForSide(metrics, side);
    const rowIndex = findRowAtAlignedOffset(
      rowOffsets,
      heights,
      sideRange.startRow,
      sideRange.endRow,
      clampedOffset,
    );
    const rows = side === "old" ? model.leftRows : model.rightRows;
    if (rowIndex !== null) {
      rowId = rows[rowIndex]?.id ?? null;
      const rowStart = rowOffsets?.[rowIndex] ?? heights.rowToOffset(rowIndex);
      rowFraction = atPaneEnd
        ? 1
        : Math.min(1, Math.max(0, (clampedOffset - rowStart) / heights.heightAt(rowIndex)));
    }
  }
  return Object.freeze({
    segmentId: mapping.segment.id,
    rowId,
    rowFraction,
    viewportFraction: 0,
    side,
    segmentOffset,
    segmentFraction,
    atSegmentEnd: atPaneEnd || segmentOffset === segmentHeight,
  });
}

export function resolveDiffScrollAnchor(
  model: KeydexAlignedDiffModel,
  metrics: DiffScrollMappingMetrics,
  targetHeights: DiffRowHeightIndex,
  anchor: DiffScrollMappingAnchor,
  targetSide: DiffPaneSide,
): number | null {
  const mapping = metrics.segments.find(({ segment }) => segment.id === anchor.segmentId);
  if (!mapping) return null;
  const sourcePixelRange = pixelRangeForSide(mapping, anchor.side);
  const sourceOffset = sourcePixelRange.start + Math.min(
    sourcePixelRange.end - sourcePixelRange.start,
    Math.max(0, anchor.segmentOffset),
  );
  if (targetSide !== anchor.side) {
    return mapOffsetAlongPath(metrics, anchor.side, sourceOffset);
  }
  if (anchor.atSegmentEnd) return sourcePixelRange.end;

  const sourceRows = anchor.side === "old" ? model.leftRows : model.rightRows;
  const sourceSideRange = rowRangeForSide(mapping.segment, anchor.side);
  const sourceRowIndex = anchor.rowId
    ? sourceRows.findIndex(({ id }) => id === anchor.rowId)
    : -1;
  if (sourceRowIndex >= sourceSideRange.startRow && sourceRowIndex < sourceSideRange.endRow) {
    const targetOffsets = rowOffsetsForSide(metrics, targetSide);
    return (targetOffsets?.[sourceRowIndex] ?? targetHeights.rowToOffset(sourceRowIndex))
      + targetHeights.heightAt(sourceRowIndex) * anchor.rowFraction;
  }
  return sourcePixelRange.start
    + (sourcePixelRange.end - sourcePixelRange.start) * anchor.segmentFraction;
}

export function mapDiffPaneOffset(
  _model: KeydexAlignedDiffModel,
  metrics: DiffScrollMappingMetrics,
  _leftHeights: DiffRowHeightIndex,
  _rightHeights: DiffRowHeightIndex,
  sourceSide: DiffPaneSide,
  offset: number,
): number | null {
  if (!Number.isFinite(offset)) return null;
  return mapOffsetAlongPath(metrics, sourceSide, offset);
}

/**
 * Maps the semantic position at the viewport centre instead of its top edge.
 * Unequal change runs therefore hold the shorter side in the middle of the
 * screen while the longer side consumes its extra rows. Once the source enters
 * the reserved bottom-scroll space, both panes advance through their respective
 * tail spaces at the same progress instead of clamping the follower to content.
 */
export function mapDiffPaneViewportOffset(
  model: KeydexAlignedDiffModel,
  metrics: DiffScrollMappingMetrics,
  leftHeights: DiffRowHeightIndex,
  rightHeights: DiffRowHeightIndex,
  sourceSide: DiffPaneSide,
  scrollTop: number,
  sourceViewportHeight: number,
  targetViewportHeight: number,
  options: DiffViewportScrollMappingOptions = {},
): number | null {
  if (
    !Number.isFinite(scrollTop)
    || !Number.isFinite(sourceViewportHeight)
    || !Number.isFinite(targetViewportHeight)
  ) return null;
  const safeSourceHeight = Math.max(0, sourceViewportHeight);
  const safeTargetHeight = Math.max(0, targetViewportHeight);
  const sourceTotal = sourceSide === "old" ? metrics.leftTotalHeight : metrics.rightTotalHeight;
  const targetTotal = sourceSide === "old" ? metrics.rightTotalHeight : metrics.leftTotalHeight;
  const sourceContentEndScrollTop = Math.max(0, sourceTotal - safeSourceHeight);
  const targetContentEndScrollTop = Math.max(0, targetTotal - safeTargetHeight);
  const sourceBottomScrollSpace = finiteNonNegative(options.sourceBottomScrollSpace);
  const targetBottomScrollSpace = finiteNonNegative(options.targetBottomScrollSpace);
  const maximumSourceScrollTop = sourceContentEndScrollTop + sourceBottomScrollSpace;
  const clampedScrollTop = Math.min(maximumSourceScrollTop, Math.max(0, scrollTop));
  if (sourceBottomScrollSpace > 0 && clampedScrollTop > sourceContentEndScrollTop) {
    const tailProgress = (clampedScrollTop - sourceContentEndScrollTop) / sourceBottomScrollSpace;
    return targetContentEndScrollTop + targetBottomScrollSpace * tailProgress;
  }
  const mappedCentre = mapDiffPaneOffset(
    model,
    metrics,
    leftHeights,
    rightHeights,
    sourceSide,
    clampedScrollTop + safeSourceHeight / 2,
  );
  if (mappedCentre === null) return null;
  return Math.min(
    targetContentEndScrollTop,
    Math.max(0, mappedCentre - safeTargetHeight / 2),
  );
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function findPixelSegment(
  segments: readonly DiffSegmentPixelMapping[],
  side: DiffPaneSide,
  offset: number,
): DiffSegmentPixelMapping {
  let fallback = segments[segments.length - 1]!;
  for (const mapping of segments) {
    const range = pixelRangeForSide(mapping, side);
    if (range.end > range.start && range.start <= offset && offset < range.end) return mapping;
    if (range.start >= offset) return mapping;
    fallback = mapping;
  }
  return fallback;
}

function pixelRangeForSide(
  mapping: DiffSegmentPixelMapping,
  side: DiffPaneSide,
): DiffPanePixelRange {
  return side === "old" ? mapping.left : mapping.right;
}

function rowOffsetsForSide(
  metrics: DiffScrollMappingMetrics,
  side: DiffPaneSide,
): readonly number[] | undefined {
  return side === "old" ? metrics.leftRowOffsets : metrics.rightRowOffsets;
}

function findRowAtAlignedOffset(
  offsets: readonly number[] | undefined,
  heights: DiffRowHeightIndex,
  startRow: number,
  endRow: number,
  offset: number,
): number | null {
  for (let rowIndex = startRow; rowIndex < endRow; rowIndex += 1) {
    const rowStart = offsets?.[rowIndex] ?? heights.rowToOffset(rowIndex);
    if (rowStart <= offset && offset < rowStart + heights.heightAt(rowIndex)) return rowIndex;
  }
  return null;
}

function placePairedRows(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  leftStartOffset: number,
  rightStartOffset: number,
  leftHeights: DiffRowHeightIndex,
  rightHeights: DiffRowHeightIndex,
  leftOffsets: number[],
  rightOffsets: number[],
  points: DiffScrollAlignmentPoint[],
): readonly [number, number] {
  let leftCursor = leftStartOffset;
  let rightCursor = rightStartOffset;
  const count = Math.max(leftEnd - leftStart, rightEnd - rightStart);
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const leftRow = leftStart + ordinal < leftEnd ? leftStart + ordinal : null;
    const rightRow = rightStart + ordinal < rightEnd ? rightStart + ordinal : null;
    if (leftRow !== null) {
      leftOffsets[leftRow] = leftCursor;
      leftCursor += leftHeights.heightAt(leftRow);
    }
    if (rightRow !== null) {
      rightOffsets[rightRow] = rightCursor;
      rightCursor += rightHeights.heightAt(rightRow);
    }
    appendAlignmentPoint(points, leftCursor, rightCursor);
  }
  return [leftCursor, rightCursor] as const;
}

function placeChangeRows(
  model: KeydexAlignedDiffModel,
  leftRange: DiffSideRange,
  rightRange: DiffSideRange,
  leftStartOffset: number,
  rightStartOffset: number,
  leftHeights: DiffRowHeightIndex,
  rightHeights: DiffRowHeightIndex,
  leftOffsets: number[],
  rightOffsets: number[],
  points: DiffScrollAlignmentPoint[],
): readonly [number, number] {
  let leftRow = leftRange.startRow;
  let rightRow = rightRange.startRow;
  let leftCursor = leftStartOffset;
  let rightCursor = rightStartOffset;
  while (leftRow < leftRange.endRow || rightRow < rightRange.endRow) {
    if (leftRow >= leftRange.endRow) {
      while (rightRow < rightRange.endRow) {
        rightOffsets[rightRow] = rightCursor;
        rightCursor += rightHeights.heightAt(rightRow);
        rightRow += 1;
      }
      appendAlignmentPoint(points, leftCursor, rightCursor);
      continue;
    }
    if (rightRow >= rightRange.endRow) {
      while (leftRow < leftRange.endRow) {
        leftOffsets[leftRow] = leftCursor;
        leftCursor += leftHeights.heightAt(leftRow);
        leftRow += 1;
      }
      appendAlignmentPoint(points, leftCursor, rightCursor);
      continue;
    }

    const leftModified = model.leftRows[leftRow]?.kind === "modified";
    const rightModified = model.rightRows[rightRow]?.kind === "modified";
    if (leftModified && rightModified) {
      leftOffsets[leftRow] = leftCursor;
      rightOffsets[rightRow] = rightCursor;
      leftCursor += leftHeights.heightAt(leftRow);
      rightCursor += rightHeights.heightAt(rightRow);
      leftRow += 1;
      rightRow += 1;
      appendAlignmentPoint(points, leftCursor, rightCursor);
      continue;
    }
    if (!leftModified) {
      do {
        leftOffsets[leftRow] = leftCursor;
        leftCursor += leftHeights.heightAt(leftRow);
        leftRow += 1;
      } while (
        leftRow < leftRange.endRow
        && model.leftRows[leftRow]?.kind !== "modified"
      );
      appendAlignmentPoint(points, leftCursor, rightCursor);
      continue;
    }
    do {
      rightOffsets[rightRow] = rightCursor;
      rightCursor += rightHeights.heightAt(rightRow);
      rightRow += 1;
    } while (
      rightRow < rightRange.endRow
      && model.rightRows[rightRow]?.kind !== "modified"
    );
    appendAlignmentPoint(points, leftCursor, rightCursor);
  }
  return [leftCursor, rightCursor] as const;
}

function mapOffsetAlongPath(
  metrics: DiffScrollMappingMetrics,
  sourceSide: DiffPaneSide,
  offset: number,
): number | null {
  if (!Number.isFinite(offset)) return null;
  const sourceKey = sourceSide === "old" ? "left" : "right";
  const targetKey = sourceSide === "old" ? "right" : "left";
  const sourceTotal = sourceSide === "old" ? metrics.leftTotalHeight : metrics.rightTotalHeight;
  const targetTotal = sourceSide === "old" ? metrics.rightTotalHeight : metrics.leftTotalHeight;
  const clamped = Math.min(sourceTotal, Math.max(0, offset));
  const points = metrics.alignmentPoints;
  if (!points?.length) {
    if (sourceTotal === 0) return targetTotal;
    return targetTotal * clamped / sourceTotal;
  }
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle]![sourceKey] <= clamped) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return points[0]![targetKey];
  if (low >= points.length) return points[points.length - 1]![targetKey];
  const start = points[low - 1]!;
  const end = points[low]!;
  const sourceSpan = end[sourceKey] - start[sourceKey];
  if (sourceSpan <= 0) return end[targetKey];
  const fraction = (clamped - start[sourceKey]) / sourceSpan;
  return start[targetKey] + (end[targetKey] - start[targetKey]) * fraction;
}

function appendAlignmentPoint(
  points: DiffScrollAlignmentPoint[],
  left: number,
  right: number,
): void {
  const previous = points[points.length - 1];
  if (previous?.left === left && previous.right === right) return;
  if (previous && (left < previous.left || right < previous.right)) {
    throw new Error("diff scroll alignment points must be monotonic");
  }
  points.push(frozenPoint(left, right));
}

function frozenPoint(left: number, right: number): DiffScrollAlignmentPoint {
  return Object.freeze({ left, right });
}

function frozenRange(start: number, end: number): DiffPanePixelRange {
  return Object.freeze({ start, end });
}

function rowRangeForSide(segment: DiffAlignmentSegment, side: DiffPaneSide): DiffSideRange {
  return side === "old" ? segment.left : segment.right;
}
