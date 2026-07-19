import type { DiffPaneSide, KeydexAlignedDiffModel } from "./alignedDiffModel";
import {
  captureDiffScrollAnchor,
  resolveDiffScrollAnchor,
  type DiffScrollMappingAnchor,
  type DiffScrollMappingMetrics,
} from "./hunkScrollMapping";
import type { DiffRowHeightIndex } from "./rowHeightIndex";

export interface DiffPaneMetricSnapshot {
  readonly fileId: string;
  readonly fileCacheKey: string;
  readonly sourceVersion: string;
  readonly modelVersion: string;
  readonly side: DiffPaneSide;
  readonly viewportFraction: number;
  readonly anchor: DiffScrollMappingAnchor;
}

export interface CaptureDiffPaneMetricSnapshotOptions {
  readonly model: KeydexAlignedDiffModel;
  readonly metrics: DiffScrollMappingMetrics;
  readonly heights: DiffRowHeightIndex;
  readonly side: DiffPaneSide;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly viewportFraction?: number;
}

export interface RestoreDiffPaneMetricSnapshotOptions {
  readonly snapshot: DiffPaneMetricSnapshot;
  readonly model: KeydexAlignedDiffModel;
  readonly metrics: DiffScrollMappingMetrics;
  readonly heights: DiffRowHeightIndex;
  readonly viewportHeight: number;
}

export function captureDiffPaneMetricSnapshot(
  options: CaptureDiffPaneMetricSnapshotOptions,
): DiffPaneMetricSnapshot | null {
  const viewportFraction = clampFraction(options.viewportFraction ?? 0.35);
  const anchorOffset = Math.max(0, options.scrollTop)
    + Math.max(0, options.viewportHeight) * viewportFraction;
  const anchor = captureDiffScrollAnchor(
    options.model,
    options.metrics,
    options.heights,
    options.side,
    anchorOffset,
  );
  if (!anchor) return null;
  return Object.freeze({
    fileId: options.model.fileId,
    fileCacheKey: options.model.fileCacheKey,
    sourceVersion: options.model.sourceVersion,
    modelVersion: options.model.modelVersion,
    side: options.side,
    viewportFraction,
    anchor: Object.freeze({ ...anchor, viewportFraction }),
  });
}

export function restoreDiffPaneMetricSnapshot(
  options: RestoreDiffPaneMetricSnapshotOptions,
): number | null {
  if (!sameModelIdentity(options.snapshot, options.model)) return null;
  const anchorOffset = resolveSamePaneRowAnchor(options)
    ?? resolveDiffScrollAnchor(
      options.model,
      options.metrics,
      options.heights,
      options.snapshot.anchor,
      options.snapshot.side,
    );
  if (anchorOffset === null) return null;
  const totalHeight = options.snapshot.side === "old"
    ? options.metrics.leftTotalHeight
    : options.metrics.rightTotalHeight;
  const viewportHeight = Math.max(0, options.viewportHeight);
  const desired = anchorOffset - viewportHeight * options.snapshot.viewportFraction;
  return Math.min(Math.max(0, totalHeight - viewportHeight), Math.max(0, desired));
}

function resolveSamePaneRowAnchor(options: RestoreDiffPaneMetricSnapshotOptions): number | null {
  const rowId = options.snapshot.anchor.rowId;
  if (!rowId) return null;
  const rows = options.snapshot.side === "old" ? options.model.leftRows : options.model.rightRows;
  const rowIndex = rows.findIndex(({ id }) => id === rowId);
  if (rowIndex < 0) return null;
  const mapping = options.metrics.segments.find(
    ({ segment }) => segment.id === options.snapshot.anchor.segmentId,
  );
  if (!mapping || mapping.segment.kind === "collapsed_gap") return null;
  const rowRange = options.snapshot.side === "old" ? mapping.segment.left : mapping.segment.right;
  if (rowIndex < rowRange.startRow || rowIndex >= rowRange.endRow) return null;
  const rowOffsets = options.snapshot.side === "old"
    ? options.metrics.leftRowOffsets
    : options.metrics.rightRowOffsets;
  const fallbackRange = options.snapshot.side === "old" ? mapping.left : mapping.right;
  return (rowOffsets?.[rowIndex] ?? (
    fallbackRange.start
    + options.heights.rowToOffset(rowIndex)
    - options.heights.rowToOffset(rowRange.startRow)
  ))
    + options.heights.heightAt(rowIndex) * options.snapshot.anchor.rowFraction;
}

export interface DiffPaneAnchorRestoreSchedulerOptions {
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

/** Coalesces continuous resize/wrap measurements and rejects stale restores. */
export class DiffPaneAnchorRestoreScheduler {
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private frame: number | null = null;
  private epoch = 0;

  constructor(options: DiffPaneAnchorRestoreSchedulerOptions = {}) {
    this.requestFrame = options.requestFrame ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle));
  }

  schedule(
    restore: () => number | null,
    apply: (scrollTop: number) => void,
  ): number {
    const epoch = ++this.epoch;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = this.requestFrame(() => {
      this.frame = null;
      if (epoch !== this.epoch) return;
      const scrollTop = restore();
      if (scrollTop !== null && Number.isFinite(scrollTop)) apply(scrollTop);
    });
    return epoch;
  }

  cancel(): void {
    this.epoch += 1;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
  }
}

function sameModelIdentity(snapshot: DiffPaneMetricSnapshot, model: KeydexAlignedDiffModel): boolean {
  return snapshot.fileId === model.fileId
    && snapshot.fileCacheKey === model.fileCacheKey
    && snapshot.sourceVersion === model.sourceVersion
    && snapshot.modelVersion === model.modelVersion;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0.35;
  return Math.min(1, Math.max(0, value));
}
