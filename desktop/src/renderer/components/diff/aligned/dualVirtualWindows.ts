import type { DiffPaneSide } from "./alignedDiffModel";
import type { DiffRowHeightIndex } from "./rowHeightIndex";
import {
  resolveVirtualDiffWindow,
  type VirtualDiffWindow,
} from "./useVirtualDiffRows";

export interface VirtualDiffPaneViewport {
  readonly heights: DiffRowHeightIndex;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}

export interface DualVirtualDiffWindows {
  readonly old: VirtualDiffWindow;
  readonly new: VirtualDiffWindow;
  readonly mountedRowCount: number;
}

export interface DiffVirtualMeasurementCorrection {
  readonly epoch: number;
  readonly targetSide: DiffPaneSide;
  readonly estimatedOffset: number;
  readonly measuredOffset: number;
}

export function resolveDualVirtualDiffWindows(
  oldPane: VirtualDiffPaneViewport,
  newPane: VirtualDiffPaneViewport,
  options: {
    readonly overscanPx?: number;
    readonly maxMountedRows?: number;
  } = {},
): DualVirtualDiffWindows {
  const maxMountedRows = options.maxMountedRows ?? 2_000;
  if (!Number.isInteger(maxMountedRows) || maxMountedRows < 2) {
    throw new TypeError("maxMountedRows must allow both panes");
  }
  const oldBudget = Math.floor(maxMountedRows / 2);
  const newBudget = maxMountedRows - oldBudget;
  const overscanPx = options.overscanPx ?? 360;
  const old = resolveVirtualDiffWindow(
    oldPane.heights,
    oldPane.scrollTop,
    oldPane.viewportHeight,
    overscanPx,
    oldBudget,
  );
  const next = resolveVirtualDiffWindow(
    newPane.heights,
    newPane.scrollTop,
    newPane.viewportHeight,
    overscanPx,
    newBudget,
  );
  return Object.freeze({ old, new: next, mountedRowCount: old.mountedRowCount + next.mountedRowCount });
}

export function shouldApplyVirtualMeasurementCorrection(
  correction: DiffVirtualMeasurementCorrection,
  tolerance = 1,
): boolean {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError("tolerance must be non-negative");
  return Number.isFinite(correction.measuredOffset)
    && Number.isFinite(correction.estimatedOffset)
    && Math.abs(correction.measuredOffset - correction.estimatedOffset) > tolerance;
}
