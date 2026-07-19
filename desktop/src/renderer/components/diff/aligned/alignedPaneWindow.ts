import type { DiffPaneSide } from "./alignedDiffModel";
import type { DiffScrollMappingMetrics } from "./hunkScrollMapping";
import type { DiffRowHeightIndex } from "./rowHeightIndex";

export interface AlignedPaneVirtualWindow {
  readonly rowIndexes: readonly number[];
  readonly mountedRowCount: number;
  readonly totalHeight: number;
}

export function resolveAlignedPaneVirtualWindow(
  metrics: DiffScrollMappingMetrics,
  heights: DiffRowHeightIndex,
  side: DiffPaneSide,
  scrollTop: number,
  viewportHeight: number,
  enabled: boolean,
  overscanPx: number,
  maxMountedRows: number,
): AlignedPaneVirtualWindow {
  validateInput(scrollTop, viewportHeight, overscanPx, maxMountedRows);
  const totalHeight = side === "old" ? metrics.leftTotalHeight : metrics.rightTotalHeight;
  if (heights.length === 0) return emptyWindow(totalHeight);
  if (!enabled) return windowFromRange(0, heights.length, totalHeight);

  const offsets = side === "old" ? metrics.leftRowOffsets : metrics.rightRowOffsets;
  const startOffset = Math.max(0, scrollTop - overscanPx);
  const endOffset = Math.min(totalHeight, scrollTop + viewportHeight + overscanPx);
  const visibleStartOffset = Math.max(0, scrollTop);
  const visibleEndOffset = Math.min(totalHeight, scrollTop + viewportHeight);
  let startIndex = firstRowEndingAfter(offsets, heights, startOffset);
  let endIndex = firstRowStartingAtOrAfter(offsets, heights, endOffset);
  const visibleStartIndex = firstRowEndingAfter(offsets, heights, visibleStartOffset);
  const visibleEndIndex = firstRowStartingAtOrAfter(offsets, heights, visibleEndOffset);
  const visibleCount = Math.max(0, visibleEndIndex - visibleStartIndex);
  const budget = Math.max(maxMountedRows, visibleCount);
  if (endIndex - startIndex > budget) {
    const spare = Math.max(0, budget - visibleCount);
    const before = Math.min(visibleStartIndex, Math.floor(spare / 2));
    startIndex = visibleStartIndex - before;
    endIndex = Math.min(heights.length, startIndex + budget);
    startIndex = Math.max(0, endIndex - budget);
  }
  return windowFromRange(startIndex, endIndex, totalHeight);
}

function firstRowEndingAfter(
  offsets: readonly number[] | undefined,
  heights: DiffRowHeightIndex,
  target: number,
): number {
  let low = 0;
  let high = heights.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const end = rowOffset(offsets, heights, middle) + heights.heightAt(middle);
    if (end <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstRowStartingAtOrAfter(
  offsets: readonly number[] | undefined,
  heights: DiffRowHeightIndex,
  target: number,
): number {
  let low = 0;
  let high = heights.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (rowOffset(offsets, heights, middle) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rowOffset(
  offsets: readonly number[] | undefined,
  heights: DiffRowHeightIndex,
  rowIndex: number,
): number {
  const aligned = offsets?.[rowIndex];
  return Number.isFinite(aligned) ? aligned! : heights.rowToOffset(rowIndex);
}

function windowFromRange(
  startIndex: number,
  endIndex: number,
  totalHeight: number,
): AlignedPaneVirtualWindow {
  const rowIndexes = Object.freeze(Array.from(
    { length: Math.max(0, endIndex - startIndex) },
    (_, offset) => startIndex + offset,
  ));
  return Object.freeze({ rowIndexes, mountedRowCount: rowIndexes.length, totalHeight });
}

function emptyWindow(totalHeight: number): AlignedPaneVirtualWindow {
  return Object.freeze({ rowIndexes: Object.freeze([]), mountedRowCount: 0, totalHeight });
}

function validateInput(
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  maxMountedRows: number,
): void {
  if (![scrollTop, viewportHeight, overscanPx].every(Number.isFinite)) {
    throw new TypeError("aligned pane window measurements must be finite");
  }
  if (scrollTop < 0 || viewportHeight < 0 || overscanPx < 0) {
    throw new RangeError("aligned pane window measurements must be non-negative");
  }
  if (!Number.isInteger(maxMountedRows) || maxMountedRows <= 0) {
    throw new TypeError("maxMountedRows must be a positive integer");
  }
}
