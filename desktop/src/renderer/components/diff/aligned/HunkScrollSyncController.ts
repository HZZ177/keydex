import type { DiffPaneSide } from "./alignedDiffModel";

export type DiffScrollIntentSource =
  | "wheel"
  | "touch"
  | "scrollbar"
  | "keyboard"
  | "navigation"
  | "scroll";

export interface DiffScrollablePane {
  scrollTop: number;
  scrollLeft: number;
  readonly scrollWidth?: number;
  readonly clientWidth?: number;
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
}

export interface HunkScrollSyncControllerOptions {
  readonly left: DiffScrollablePane;
  readonly right: DiffScrollablePane;
  readonly mapOffset: (sourceSide: DiffPaneSide, sourceOffset: number) => number | null;
  readonly enabled?: boolean;
  readonly tolerance?: number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly synchronizationMode?: "animation_frame" | "immediate";
  readonly onMasterChange?: (
    side: DiffPaneSide,
    source: DiffScrollIntentSource,
  ) => void;
  readonly onEstimatedTarget?: (transaction: DiffEstimatedScrollTransaction) => void;
}

export interface DiffEstimatedScrollTransaction {
  readonly epoch: number;
  readonly sourceSide: DiffPaneSide;
  readonly targetSide: DiffPaneSide;
  readonly sourceOffset: number;
  readonly estimatedOffset: number;
}

interface PendingSync {
  readonly side: DiffPaneSide;
  readonly offset: number;
  readonly horizontalOffset: number;
  readonly synchronizeVertical: boolean;
}

interface InternalPosition {
  readonly top: number;
  readonly left: number;
}

export class HunkScrollSyncController {
  private readonly panes: Readonly<Record<DiffPaneSide, DiffScrollablePane>>;
  private readonly listeners: Array<{
    readonly pane: DiffScrollablePane;
    readonly type: string;
    readonly listener: EventListener;
    readonly options?: AddEventListenerOptions;
  }> = [];
  private readonly internalPositions = new Map<DiffPaneSide, InternalPosition>();
  private readonly observedPositions = new Map<DiffPaneSide, InternalPosition>();
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly tolerance: number;
  private readonly synchronizationMode: "animation_frame" | "immediate";
  private enabled: boolean;
  private destroyed = false;
  private frame: number | null = null;
  private pending: PendingSync | null = null;
  private correctionEpoch = 0;
  private pendingCorrection: DiffEstimatedScrollTransaction | null = null;
  private master: DiffPaneSide = "old";

  constructor(private readonly options: HunkScrollSyncControllerOptions) {
    this.panes = Object.freeze({ old: options.left, new: options.right });
    this.enabled = options.enabled ?? true;
    this.tolerance = options.tolerance ?? 0.5;
    this.synchronizationMode = options.synchronizationMode ?? "animation_frame";
    this.requestFrame = options.requestFrame ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle));
    this.observedPositions.set("old", currentPosition(options.left));
    this.observedPositions.set("new", currentPosition(options.right));
    this.attach("old");
    this.attach("new");
  }

  get masterSide(): DiffPaneSide {
    return this.master;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed || this.enabled === enabled) return;
    this.enabled = enabled;
    this.internalPositions.clear();
    if (!enabled) {
      this.pending = null;
      this.cancelPendingFrame();
      return;
    }
    const master = this.panes[this.master];
    this.queueSync(this.master, master.scrollTop, master.scrollLeft, true);
  }

  notifyIntent(side: DiffPaneSide, source: DiffScrollIntentSource): void {
    if (this.destroyed) return;
    this.pendingCorrection = null;
    this.internalPositions.delete(side);
    if (this.master !== side) this.master = side;
    this.options.onMasterChange?.(side, source);
  }

  synchronizeFrom(side: DiffPaneSide): void {
    if (this.destroyed) return;
    this.notifyIntent(side, "navigation");
    const pane = this.panes[side];
    this.queueSync(side, pane.scrollTop, pane.scrollLeft, true);
  }

  scrollTo(side: DiffPaneSide, top: number, left?: number): void {
    if (this.destroyed || !Number.isFinite(top)) return;
    this.notifyIntent(side, "navigation");
    const pane = this.panes[side];
    pane.scrollTop = Math.max(0, top);
    if (left !== undefined && Number.isFinite(left)) pane.scrollLeft = Math.max(0, left);
    this.queueSync(side, pane.scrollTop, pane.scrollLeft, true);
  }

  /** Applies at most one post-mount measurement correction for the latest estimated sync. */
  correctEstimatedTarget(epoch: number, targetSide: DiffPaneSide, measuredOffset: number): boolean {
    const transaction = this.pendingCorrection;
    if (
      this.destroyed
      || !this.enabled
      || !Number.isFinite(measuredOffset)
      || !transaction
      || transaction.epoch !== epoch
      || transaction.targetSide !== targetSide
    ) return false;
    this.pendingCorrection = null;
    const target = this.panes[targetSide];
    const next = Math.max(0, measuredOffset);
    if (Math.abs(target.scrollTop - next) <= this.tolerance) return false;
    this.internalPositions.set(targetSide, Object.freeze({ top: next, left: target.scrollLeft }));
    target.scrollTop = next;
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelPendingFrame();
    this.pending = null;
    this.pendingCorrection = null;
    this.internalPositions.clear();
    for (const { pane, type, listener, options } of this.listeners) {
      pane.removeEventListener(type, listener, options);
    }
    this.listeners.length = 0;
  }

  private attach(side: DiffPaneSide): void {
    const pane = this.panes[side];
    this.listen(pane, "wheel", () => this.notifyIntent(side, "wheel"), { passive: true });
    this.listen(pane, "touchstart", () => this.notifyIntent(side, "touch"), { passive: true });
    this.listen(pane, "pointerdown", () => this.notifyIntent(side, "scrollbar"), { passive: true });
    this.listen(pane, "keydown", (event) => {
      if (isScrollKey(event as KeyboardEvent)) this.notifyIntent(side, "keyboard");
    });
    this.listen(pane, "scroll", () => this.handleScroll(side), { passive: true });
  }

  private listen(
    pane: DiffScrollablePane,
    type: string,
    callback: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    const listener: EventListener = (event) => callback(event);
    pane.addEventListener(type, listener, options);
    this.listeners.push({ pane, type, listener, options });
  }

  private handleScroll(side: DiffPaneSide): void {
    if (this.destroyed) return;
    const pane = this.panes[side];
    const offset = pane.scrollTop;
    const horizontalOffset = pane.scrollLeft;
    const previous = this.observedPositions.get(side) ?? currentPosition(pane);
    this.observedPositions.set(side, Object.freeze({ top: offset, left: horizontalOffset }));
    const internalPosition = this.internalPositions.get(side);
    if (
      internalPosition
      && Math.abs(internalPosition.top - offset) <= this.tolerance
      && Math.abs(internalPosition.left - horizontalOffset) <= this.tolerance
    ) {
      this.internalPositions.delete(side);
      return;
    }
    this.internalPositions.delete(side);
    const verticalChanged = Math.abs(previous.top - offset) > this.tolerance;
    const horizontalChanged = Math.abs(previous.left - horizontalOffset) > this.tolerance;
    if (!verticalChanged && !horizontalChanged) return;
    this.notifyIntent(side, "scroll");
    this.queueSync(side, offset, horizontalOffset, verticalChanged);
  }

  private queueSync(
    side: DiffPaneSide,
    offset: number,
    horizontalOffset: number,
    synchronizeVertical: boolean,
  ): void {
    if (!this.enabled || this.destroyed) return;
    this.pendingCorrection = null;
    const keepPendingVertical = this.pending?.side === side && this.pending.synchronizeVertical;
    this.pending = {
      side,
      offset,
      horizontalOffset,
      synchronizeVertical: synchronizeVertical || keepPendingVertical,
    };
    if (this.synchronizationMode === "immediate") {
      this.flush();
      return;
    }
    if (this.frame !== null) return;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.enabled || this.destroyed) return;
    const targetSide: DiffPaneSide = pending.side === "old" ? "new" : "old";
    const target = this.panes[targetSide];
    const mapped = pending.synchronizeVertical
      ? this.options.mapOffset(pending.side, pending.offset)
      : target.scrollTop;
    if (mapped === null || !Number.isFinite(mapped)) return;
    const next = Math.max(0, mapped);
    const nextLeft = clampHorizontalOffset(target, pending.horizontalOffset);
    const transaction = pending.synchronizeVertical
      ? Object.freeze({
        epoch: ++this.correctionEpoch,
        sourceSide: pending.side,
        targetSide,
        sourceOffset: pending.offset,
        estimatedOffset: next,
      })
      : null;
    this.pendingCorrection = transaction;
    const topChanged = Math.abs(target.scrollTop - next) > this.tolerance;
    const leftChanged = Math.abs(target.scrollLeft - nextLeft) > this.tolerance;
    if (topChanged || leftChanged) {
      this.internalPositions.set(targetSide, Object.freeze({ top: next, left: nextLeft }));
      if (leftChanged) target.scrollLeft = nextLeft;
      if (topChanged) target.scrollTop = next;
    }
    if (transaction) this.options.onEstimatedTarget?.(transaction);
  }

  private cancelPendingFrame(): void {
    if (this.frame === null) return;
    this.cancelFrame(this.frame);
    this.frame = null;
  }
}

function currentPosition(pane: DiffScrollablePane): InternalPosition {
  return Object.freeze({ top: pane.scrollTop, left: pane.scrollLeft });
}

function clampHorizontalOffset(pane: DiffScrollablePane, offset: number): number {
  if (!Number.isFinite(offset)) return pane.scrollLeft;
  const maximum = Number.isFinite(pane.scrollWidth) && Number.isFinite(pane.clientWidth)
    ? Math.max(0, pane.scrollWidth! - pane.clientWidth!)
    : Number.POSITIVE_INFINITY;
  return Math.min(maximum, Math.max(0, offset));
}

function isScrollKey(event: KeyboardEvent): boolean {
  return ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
}
