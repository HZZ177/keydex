import { MarkdownHeightIndex } from "@/renderer/markdownRuntime/layout/HeightIndex";
import { MarkdownViewportController, type MarkdownViewportResult } from "@/renderer/markdownRuntime/view/ViewportController";
import type { ConversationRenderUnit } from "./ConversationRenderUnit";

export interface ConversationTimelineUnitHandle {
  update(unit: ConversationRenderUnit): void;
  destroy(): void;
}

export interface ConversationTimelineUnitRenderer {
  mount(unit: ConversationRenderUnit, host: HTMLElement): ConversationTimelineUnitHandle;
}

export interface ConversationTimelineRuntimeOptions {
  readonly renderer: ConversationTimelineUnitRenderer;
  readonly overscanPx?: number;
  readonly maxPinnedUnits?: number;
  readonly observeMeasurements?: boolean;
  readonly followBottom?: boolean;
  readonly onPatch?: (patch: ConversationTimelinePatch) => void;
  readonly onScrollRequest?: (request: ConversationTimelineScrollRequest) => void;
}

export interface ConversationTimelineScrollRequest {
  readonly scrollTop: number;
  readonly reason: "follow-bottom" | "preserve-top" | "reveal-unit" | "restore-anchor";
}

export interface ConversationTimelinePatch {
  readonly revision: string;
  readonly viewport: MarkdownViewportResult;
  readonly created: number;
  readonly updated: number;
  readonly reused: number;
  readonly destroyed: number;
  readonly mounted: number;
}

export interface ConversationTimelineDiagnostics {
  readonly revision: string | null;
  readonly units: number;
  readonly mounted: number;
  readonly recycled: number;
  readonly pinned: number;
  readonly measured: number;
  readonly totalHeight: number;
  readonly domNodes: number;
  readonly patches: number;
  readonly scrollPatches: number;
  readonly followBottom: boolean;
  readonly userScrollActive: boolean;
  readonly topLocked: boolean;
  readonly deferredMeasurements: number;
}

export interface ConversationTimelineAnchor {
  readonly unitId: string;
  readonly offsetWithinUnit: number;
  readonly viewportOffset: number;
  readonly capturedRevision: string;
}

interface Slot {
  unit: ConversationRenderUnit;
  readonly element: HTMLDivElement;
  readonly handle: ConversationTimelineUnitHandle;
}

const MAX_RECYCLED_TIMELINE_SLOTS = 64;
const TOP_INTENT_THRESHOLD_PX = 44;
const USER_SCROLL_SETTLE_MS = 180;
const SCROLL_TARGET_EPSILON_PX = 1;

export class ConversationTimelineRuntime {
  readonly canvas: HTMLDivElement;
  private readonly renderer: ConversationTimelineUnitRenderer;
  private readonly overscanPx: number;
  private readonly maxPinnedUnits: number;
  private readonly onPatch?: (patch: ConversationTimelinePatch) => void;
  private readonly onScrollRequest?: (request: ConversationTimelineScrollRequest) => void;
  private readonly slots = new Map<string, Slot>();
  private readonly recycledSlots: Slot[] = [];
  private readonly measuredHeights = new Map<string, number>();
  private readonly deferredMeasuredHeights = new Map<string, number>();
  private readonly pinnedIds = new Set<string>();
  private units: readonly ConversationRenderUnit[] = [];
  private indexById = new Map<string, number>();
  private heightIndex: MarkdownHeightIndex | null = null;
  private viewport: MarkdownViewportController | null = null;
  private revision: string | null = null;
  private sequence = 0;
  private patches = 0;
  private scrollPatches = 0;
  private followBottom: boolean;
  private userScrollActive = false;
  private topLocked = false;
  private lastObservedScrollTop = 0;
  private expectedProgrammaticScrollTop: number | null = null;
  private userScrollSettleTimer: number | null = null;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(readonly root: HTMLElement, options: ConversationTimelineRuntimeOptions) {
    this.renderer = options.renderer;
    this.overscanPx = finiteNonNegative(options.overscanPx ?? 800, "overscanPx");
    this.maxPinnedUnits = positiveInteger(options.maxPinnedUnits ?? 64, "maxPinnedUnits");
    this.followBottom = options.followBottom ?? false;
    this.onPatch = options.onPatch;
    this.onScrollRequest = options.onScrollRequest;
    this.canvas = root.ownerDocument.createElement("div");
    this.canvas.dataset.conversationTimelineCanvas = "true";
    this.canvas.style.position = "relative";
    this.canvas.style.width = "100%";
    // Absolutely positioned units may temporarily be taller than their index
    // estimate. They must not expand the browser's native scrollHeight behind
    // the HeightIndex, otherwise the native thumb changes size while dragging.
    this.canvas.style.overflowX = "visible";
    this.canvas.style.overflowY = "clip";
    root.replaceChildren(this.canvas);
    root.dataset.conversationTimelineRuntime = "true";
    this.lastObservedScrollTop = root.scrollTop;
    root.addEventListener("scroll", this.handleScroll, { passive: true });
    this.resizeObserver = options.observeMeasurements !== false && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => this.handleMeasurements(entries))
      : null;
  }

  publish(units: readonly ConversationRenderUnit[]): ConversationTimelinePatch {
    this.assertActive();
    assertUniqueUnits(units);
    this.units = Object.freeze([...units]);
    this.indexById = new Map(units.map((unit, index) => [unit.id, index]));
    for (const id of [...this.pinnedIds]) if (!this.indexById.has(id)) this.pinnedIds.delete(id);
    this.revision = `conversation-timeline:${++this.sequence}`;
    const heights = units.map((unit) => this.measuredHeights.get(unit.id) ?? unit.estimatedHeight);
    this.heightIndex = new MarkdownHeightIndex(this.revision, heights);
    this.viewport = new MarkdownViewportController(this.heightIndex, {
      defaultOverscanPx: this.overscanPx,
      maxPinnedBlocks: this.maxPinnedUnits,
    });
    return this.followBottom
      ? this.updateViewportAtBottom(false)
      : this.patch(this.root.scrollTop, this.root.clientHeight);
  }

  updateViewport(scrollTop = this.root.scrollTop, viewportHeight = this.root.clientHeight): ConversationTimelinePatch {
    this.assertActive();
    if (!this.viewport || !this.heightIndex || !this.revision) throw new Error("Conversation timeline has not been published");
    this.scrollPatches += 1;
    return this.patch(scrollTop, viewportHeight);
  }

  setPinned(unitId: string, pinned: boolean): ConversationTimelinePatch | null {
    this.assertActive();
    if (!this.indexById.has(unitId)) return null;
    if (pinned) {
      if (!this.pinnedIds.has(unitId) && this.pinnedIds.size >= this.maxPinnedUnits) {
        throw new Error(`Pinned conversation units exceed limit ${this.maxPinnedUnits}`);
      }
      this.pinnedIds.add(unitId);
    } else {
      this.pinnedIds.delete(unitId);
    }
    return this.updateViewport();
  }

  setFollowBottom(enabled: boolean): ConversationTimelinePatch | null {
    this.assertActive();
    if (this.followBottom === enabled) {
      if (enabled) this.setTopLocked(false);
      return null;
    }
    this.followBottom = enabled;
    if (enabled) this.setTopLocked(false);
    setDatasetValue(this.root, "conversationTimelineFollowBottom", enabled ? "true" : "false");
    return enabled && this.viewport && this.heightIndex && this.revision
      ? this.updateViewportAtBottom()
      : null;
  }

  setUserScrollInteraction(active: boolean): void {
    this.assertActive();
    if (this.userScrollActive === active) return;
    this.userScrollActive = active;
    this.lastObservedScrollTop = this.root.scrollTop;
    setDatasetValue(this.root, "conversationTimelineUserScrollActive", active ? "true" : "false");
    if (!active) {
      this.flushDeferredMeasurements();
    }
  }

  updateMeasuredHeight(unitId: string, height: number): ConversationTimelinePatch | null {
    this.assertActive();
    const index = this.indexById.get(unitId);
    if (index === undefined || !this.heightIndex || !this.revision) return null;
    const normalized = finiteNonNegative(height, "height");
    if (this.userScrollActive) {
      this.deferMeasuredHeight(unitId, normalized);
      return null;
    }
    const anchor = this.captureMeasurementAnchor();
    this.measuredHeights.set(unitId, normalized);
    const delta = this.heightIndex.update(index, normalized, { kind: "measured", revision: this.revision });
    return delta === 0
      ? null
      : this.updateViewportAfterMeasurement(anchor);
  }

  measureMounted(): ConversationTimelinePatch | null {
    if (this.userScrollActive) {
      for (const [id, slot] of this.slots) {
        const height = slot.element.getBoundingClientRect().height;
        if (!Number.isFinite(height) || height < 0) continue;
        this.deferMeasuredHeight(id, height);
      }
      return null;
    }
    const anchor = this.captureMeasurementAnchor();
    let changed = false;
    for (const [id, slot] of this.slots) {
      const height = slot.element.getBoundingClientRect().height;
      if (!Number.isFinite(height) || height < 0 || this.measuredHeights.get(id) === height) continue;
      this.measuredHeights.set(id, height);
      const index = this.indexById.get(id);
      if (index !== undefined && this.heightIndex && this.revision) {
        changed = this.heightIndex.update(index, height, { kind: "measured", revision: this.revision }) !== 0 || changed;
      }
    }
    return changed ? this.updateViewportAfterMeasurement(anchor) : null;
  }

  revealUnit(unitId: string, align: "start" | "center" | "end" = "center"): boolean {
    this.assertActive();
    const index = this.indexById.get(unitId);
    if (index === undefined || !this.heightIndex) return false;
    this.followBottom = false;
    this.setTopLocked(false);
    setDatasetValue(this.root, "conversationTimelineFollowBottom", "false");
    const top = this.heightIndex.offsetOf(index);
    const height = this.heightIndex.heightAt(index);
    const viewport = this.root.clientHeight;
    const target = align === "start" ? top : align === "end" ? top + height - viewport : top + height / 2 - viewport / 2;
    const scrollTop = Math.max(0, Math.min(target, Math.max(0, this.heightIndex.totalHeight - viewport)));
    this.patch(scrollTop, viewport);
    this.requestScroll(scrollTop, "reveal-unit");
    return true;
  }

  captureAnchor(viewportOffset = 0): ConversationTimelineAnchor | null {
    this.assertActive();
    if (!this.heightIndex || !this.revision || !this.units.length) return null;
    const absoluteY = Math.max(0, Math.min(
      this.root.scrollTop + Math.max(0, viewportOffset),
      Math.max(0, this.heightIndex.totalHeight - Number.EPSILON),
    ));
    const position = this.heightIndex.queryY(absoluteY);
    if (!position) return null;
    const unit = this.units[position.index];
    if (!unit) return null;
    return Object.freeze({
      unitId: unit.id,
      offsetWithinUnit: position.offsetWithinBlock,
      viewportOffset,
      capturedRevision: this.revision,
    });
  }

  restoreAnchor(anchor: ConversationTimelineAnchor): boolean {
    this.assertActive();
    this.followBottom = false;
    this.setTopLocked(false);
    setDatasetValue(this.root, "conversationTimelineFollowBottom", "false");
    return this.updateViewportFromAnchor(anchor) !== null;
  }

  private updateViewportFromAnchor(anchor: ConversationTimelineAnchor | null): ConversationTimelinePatch | null {
    if (!anchor) return this.viewport ? this.updateViewport() : null;
    const index = this.indexById.get(anchor.unitId);
    if (index === undefined || !this.heightIndex) return null;
    const target = this.heightIndex.offsetOf(index) + anchor.offsetWithinUnit - anchor.viewportOffset;
    const scrollTop = Math.max(
      0,
      Math.min(target, Math.max(0, this.heightIndex.totalHeight - this.root.clientHeight)),
    );
    const patch = this.patch(scrollTop, this.root.clientHeight);
    this.requestScroll(scrollTop, "restore-anchor");
    return patch;
  }

  getUnitElement(unitId: string): HTMLElement | null {
    return this.slots.get(unitId)?.element ?? null;
  }

  mountedUnitIds(): readonly string[] {
    return Object.freeze([...this.slots.keys()]);
  }

  diagnostics(): ConversationTimelineDiagnostics {
    return Object.freeze({
      revision: this.revision,
      units: this.units.length,
      mounted: this.slots.size,
      recycled: this.recycledSlots.length,
      pinned: this.pinnedIds.size,
      measured: this.heightIndex?.measuredCount() ?? 0,
      totalHeight: this.heightIndex?.totalHeight ?? 0,
      domNodes: this.root.querySelectorAll("*").length,
      patches: this.patches,
      scrollPatches: this.scrollPatches,
      followBottom: this.followBottom,
      userScrollActive: this.userScrollActive,
      topLocked: this.topLocked,
      deferredMeasurements: this.deferredMeasuredHeights.size,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeEventListener("scroll", this.handleScroll);
    this.clearUserScrollSettleTimer();
    this.resizeObserver?.disconnect();
    for (const slot of this.slots.values()) slot.handle.destroy();
    for (const slot of this.recycledSlots) slot.handle.destroy();
    this.slots.clear();
    this.recycledSlots.length = 0;
    this.deferredMeasuredHeights.clear();
    this.canvas.remove();
    delete this.root.dataset.conversationTimelineRuntime;
    delete this.root.dataset.conversationTimelineUserScrollActive;
    delete this.root.dataset.conversationTimelineTopLocked;
    delete this.root.dataset.conversationTimelineLayoutMode;
  }

  private patch(scrollTop: number, viewportHeight: number): ConversationTimelinePatch {
    const patchStartedAt = performance.now();
    const completeLayout = this.units.length <= this.maxPinnedUnits;
    const pinnedIndices = completeLayout
      ? this.units.map((_unit, index) => index)
      : [...this.pinnedIds].map((id) => this.indexById.get(id)!).filter((index) => index !== undefined);
    const viewport = this.viewport!.update({
      scrollTop,
      viewportHeight,
      revision: this.revision!,
      pinnedIndices,
    });
    const desiredIds = new Set(viewport.items.map((item) => this.units[item.index].id));
    let destroyed = 0;
    for (const [id, slot] of [...this.slots]) {
      if (desiredIds.has(id)) continue;
      this.resizeObserver?.unobserve(slot.element);
      slot.element.remove();
      this.slots.delete(id);
      this.recycledSlots.push(slot);
      destroyed += 1;
    }
    let created = 0;
    let updated = 0;
    let reused = 0;
    for (const item of viewport.items) {
      const unit = this.units[item.index];
      let slot = this.slots.get(unit.id);
      if (!slot) {
        const recycled = this.takeRecycledSlot(unit.kind);
        if (recycled) {
          recycled.handle.update(unit);
          recycled.unit = unit;
          slot = recycled;
        } else {
          const element = this.root.ownerDocument.createElement("div");
          element.style.position = "absolute";
          element.style.insetInline = "0";
          const handle = this.renderer.mount(unit, element);
          slot = { unit, element, handle };
        }
        slot.element.dataset.conversationUnitId = unit.id;
        this.slots.set(unit.id, slot);
        this.canvas.append(slot.element);
        this.resizeObserver?.observe(slot.element);
        created += 1;
      } else if (slot.unit.renderVersion !== unit.renderVersion) {
        slot.handle.update(unit);
        slot.unit = unit;
        updated += 1;
      } else {
        slot.unit = unit;
        reused += 1;
      }
      const top = `${item.top}px`;
      if (slot.element.style.top !== top) slot.element.style.top = top;
      if (slot.element.style.transform) slot.element.style.removeProperty("transform");
      // HeightIndex estimates position siblings; they must never constrain the
      // measured DOM box. A min-height here makes a short 1-line unit report its
      // 120px estimate forever, so ResizeObserver can never correct the index.
      if (slot.element.style.minHeight) slot.element.style.removeProperty("min-height");
      setDatasetValue(slot.element, "conversationUnitIndex", String(item.index));
      setDatasetValue(slot.element, "conversationUnitKind", unit.kind);
      setDatasetValue(slot.element, "conversationUnitVisible", item.visible ? "true" : "false");
      setDatasetValue(slot.element, "conversationUnitPinned", item.pinned ? "true" : "false");
      setDatasetValue(
        slot.element,
        "conversationUnitTailAdjacent",
        this.units[item.index + 1]?.id === "conversation-runtime:bottom" ? "true" : "false",
      );
      if (unit.turnIndex !== null) {
        setDatasetValue(slot.element, "turnIndex", String(unit.turnIndex));
        if (this.units[item.index - 1]?.turnIndex !== unit.turnIndex) {
          setDatasetValue(slot.element, "testid", "message-turn");
        } else {
          delete slot.element.dataset.testid;
        }
      } else {
        delete slot.element.dataset.turnIndex;
        delete slot.element.dataset.testid;
      }
    }
    while (this.recycledSlots.length > MAX_RECYCLED_TIMELINE_SLOTS) {
      this.recycledSlots.shift()?.handle.destroy();
    }
    const canvasHeight = `${viewport.totalHeight}px`;
    if (this.canvas.style.height !== canvasHeight) this.canvas.style.height = canvasHeight;
    setDatasetValue(this.canvas, "conversationTimelineTotalHeight", String(viewport.totalHeight));
    setDatasetValue(this.root, "conversationTimelineMountedUnits", String(this.slots.size));
    setDatasetValue(this.root, "conversationTimelineRevision", this.revision!);
    setDatasetValue(this.root, "conversationTimelineFollowBottom", this.followBottom ? "true" : "false");
    setDatasetValue(this.root, "conversationTimelineLayoutMode", completeLayout ? "complete" : "virtual");
    this.patches += 1;
    const patch = Object.freeze({
      revision: this.revision!,
      viewport,
      created,
      updated,
      reused,
      destroyed,
      mounted: this.slots.size,
    });
    this.onPatch?.(patch);
    const runtimeRoot = this.root as HTMLElement & {
      __conversationTimelineLastPatchMs?: number;
      __conversationTimelineLastPatchCreated?: number;
      __conversationTimelineLastPatchDestroyed?: number;
    };
    runtimeRoot.__conversationTimelineLastPatchMs = performance.now() - patchStartedAt;
    runtimeRoot.__conversationTimelineLastPatchCreated = created;
    runtimeRoot.__conversationTimelineLastPatchDestroyed = destroyed;
    return patch;
  }

  private takeRecycledSlot(kind: ConversationRenderUnit["kind"]): Slot | undefined {
    const family = recycleFamily(kind);
    for (let index = this.recycledSlots.length - 1; index >= 0; index -= 1) {
      if (recycleFamily(this.recycledSlots[index].unit.kind) !== family) continue;
      return this.recycledSlots.splice(index, 1)[0];
    }
    return this.recycledSlots.pop();
  }

  private readonly handleScroll = () => {
    if (this.disposed || !this.viewport) return;
    const scrollTop = this.root.scrollTop;
    const programmatic = this.consumeProgrammaticScroll(scrollTop);
    if (!programmatic) this.markUserScrollActivity();
    if (this.userScrollActive) {
      if (scrollTop < this.lastObservedScrollTop && scrollTop <= TOP_INTENT_THRESHOLD_PX) {
        this.setTopLocked(true);
      } else if (scrollTop > this.lastObservedScrollTop) {
        this.setTopLocked(false);
      }
    }
    this.lastObservedScrollTop = scrollTop;
    this.updateViewport(scrollTop, this.root.clientHeight);
  };

  private handleMeasurements(entries: readonly ResizeObserverEntry[]): void {
    const measurements: Array<{ id: string; index: number; height: number }> = [];
    for (const entry of entries) {
      const measurement = this.validMeasurement(entry);
      if (measurement) measurements.push(measurement);
    }
    if (this.userScrollActive) {
      for (const measurement of measurements) this.deferMeasuredHeight(measurement.id, measurement.height);
      return;
    }
    const anchor = this.captureMeasurementAnchor();
    let changed = false;
    for (const measurement of measurements) {
      if (this.measuredHeights.get(measurement.id) === measurement.height) continue;
      this.measuredHeights.set(measurement.id, measurement.height);
      changed = this.heightIndex!.update(measurement.index, measurement.height, {
        kind: "measured",
        revision: this.revision!,
      }) !== 0 || changed;
    }
    if (changed) this.updateViewportAfterMeasurement(anchor);
  }

  private validMeasurement(entry: ResizeObserverEntry): { id: string; index: number; height: number } | null {
    const element = entry.target as HTMLElement;
    const id = element.dataset.conversationUnitId;
    const index = id ? this.indexById.get(id) : undefined;
    const height = entry.contentRect.height;
    const slot = id ? this.slots.get(id) : undefined;
    if (
      !id
      || index === undefined
      || !slot
      || slot.element !== element
      || slot.unit.id !== id
      || !this.heightIndex
      || !this.revision
      || height < 0
    ) return null;
    const currentHeight = element.getBoundingClientRect().height;
    if (Number.isFinite(currentHeight) && Math.abs(currentHeight - height) > 0.5) return null;
    return { id, index, height };
  }

  private deferMeasuredHeight(unitId: string, height: number): void {
    if (this.measuredHeights.get(unitId) === height) {
      this.deferredMeasuredHeights.delete(unitId);
      return;
    }
    this.deferredMeasuredHeights.set(unitId, height);
  }

  private flushDeferredMeasurements(): ConversationTimelinePatch | null {
    if (!this.deferredMeasuredHeights.size || !this.heightIndex || !this.revision) return null;
    const pending = [...this.deferredMeasuredHeights];
    this.deferredMeasuredHeights.clear();
    const anchor = this.captureMeasurementAnchor();
    let changed = false;
    for (const [id, height] of pending) {
      const index = this.indexById.get(id);
      if (index === undefined || this.measuredHeights.get(id) === height) continue;
      this.measuredHeights.set(id, height);
      changed = this.heightIndex.update(index, height, {
        kind: "measured",
        revision: this.revision,
      }) !== 0 || changed;
    }
    return changed ? this.updateViewportAfterMeasurement(anchor) : null;
  }

  private captureMeasurementAnchor(): ConversationTimelineAnchor | null {
    return this.followBottom || this.userScrollActive || this.topLocked ? null : this.captureAnchor();
  }

  private updateViewportAfterMeasurement(anchor: ConversationTimelineAnchor | null): ConversationTimelinePatch | null {
    if (this.topLocked) {
      const patch = this.patch(0, this.root.clientHeight);
      this.requestScroll(0, "preserve-top");
      return patch;
    }
    if (this.userScrollActive) {
      return this.patch(this.root.scrollTop, this.root.clientHeight);
    }
    if (this.followBottom) return this.updateViewportAtBottom();
    return this.updateViewportFromAnchor(anchor);
  }

  private setTopLocked(locked: boolean): void {
    if (this.topLocked === locked) return;
    this.topLocked = locked;
    setDatasetValue(this.root, "conversationTimelineTopLocked", locked ? "true" : "false");
  }

  private updateViewportAtBottom(countAsScrollPatch = true): ConversationTimelinePatch {
    if (!this.heightIndex || !this.viewport || !this.revision) {
      throw new Error("Conversation timeline has not been published");
    }
    if (countAsScrollPatch) this.scrollPatches += 1;
    const target = Math.max(0, this.heightIndex.totalHeight - this.root.clientHeight);
    const patch = this.patch(target, this.root.clientHeight);
    this.requestScroll(target, "follow-bottom");
    return patch;
  }

  private requestScroll(scrollTop: number, reason: ConversationTimelineScrollRequest["reason"]): void {
    this.expectedProgrammaticScrollTop = scrollTop;
    this.onScrollRequest?.(Object.freeze({ scrollTop, reason }));
  }

  private consumeProgrammaticScroll(scrollTop: number): boolean {
    const expected = this.expectedProgrammaticScrollTop;
    if (expected !== null) {
      this.expectedProgrammaticScrollTop = null;
      if (Math.abs(scrollTop - expected) <= SCROLL_TARGET_EPSILON_PX) return true;
    }
    if (!this.followBottom) return false;
    const nativeBottom = Math.max(0, this.root.scrollHeight - this.root.clientHeight);
    const indexedBottom = Math.max(0, (this.heightIndex?.totalHeight ?? 0) - this.root.clientHeight);
    return Math.abs(scrollTop - nativeBottom) <= SCROLL_TARGET_EPSILON_PX
      || Math.abs(scrollTop - indexedBottom) <= SCROLL_TARGET_EPSILON_PX;
  }

  private markUserScrollActivity(): void {
    if (!this.userScrollActive) {
      const previousScrollTop = this.lastObservedScrollTop;
      this.setUserScrollInteraction(true);
      // The first native scroll event arrives after scrollTop changed. Preserve
      // the previous sample so top-intent detection still sees its direction.
      this.lastObservedScrollTop = previousScrollTop;
    }
    this.clearUserScrollSettleTimer();
    const view = this.root.ownerDocument.defaultView;
    if (!view) return;
    this.userScrollSettleTimer = view.setTimeout(() => {
      this.userScrollSettleTimer = null;
      if (!this.disposed && this.userScrollActive) this.setUserScrollInteraction(false);
    }, USER_SCROLL_SETTLE_MS);
  }

  private clearUserScrollSettleTimer(): void {
    if (this.userScrollSettleTimer === null) return;
    this.root.ownerDocument.defaultView?.clearTimeout(this.userScrollSettleTimer);
    this.userScrollSettleTimer = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ConversationTimelineRuntime is destroyed");
  }
}

function assertUniqueUnits(units: readonly ConversationRenderUnit[]): void {
  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) throw new Error(`Duplicate conversation unit ${unit.id}`);
    ids.add(unit.id);
    if (!Number.isFinite(unit.estimatedHeight) || unit.estimatedHeight < 0) {
      throw new Error(`Conversation unit ${unit.id} has invalid estimated height`);
    }
  }
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function setDatasetValue(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

function recycleFamily(kind: ConversationRenderUnit["kind"]): string {
  if (kind === "user-markdown" || kind === "assistant-markdown") return "markdown";
  return kind;
}
