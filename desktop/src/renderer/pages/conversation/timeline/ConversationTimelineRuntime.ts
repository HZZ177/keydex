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
  readonly onPatch?: (patch: ConversationTimelinePatch) => void;
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

export class ConversationTimelineRuntime {
  readonly canvas: HTMLDivElement;
  private readonly renderer: ConversationTimelineUnitRenderer;
  private readonly overscanPx: number;
  private readonly maxPinnedUnits: number;
  private readonly onPatch?: (patch: ConversationTimelinePatch) => void;
  private readonly slots = new Map<string, Slot>();
  private readonly recycledSlots: Slot[] = [];
  private readonly measuredHeights = new Map<string, number>();
  private readonly pinnedIds = new Set<string>();
  private units: readonly ConversationRenderUnit[] = [];
  private indexById = new Map<string, number>();
  private heightIndex: MarkdownHeightIndex | null = null;
  private viewport: MarkdownViewportController | null = null;
  private revision: string | null = null;
  private sequence = 0;
  private patches = 0;
  private scrollPatches = 0;
  private disposed = false;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(readonly root: HTMLElement, options: ConversationTimelineRuntimeOptions) {
    this.renderer = options.renderer;
    this.overscanPx = finiteNonNegative(options.overscanPx ?? 800, "overscanPx");
    this.maxPinnedUnits = positiveInteger(options.maxPinnedUnits ?? 64, "maxPinnedUnits");
    this.onPatch = options.onPatch;
    this.canvas = root.ownerDocument.createElement("div");
    this.canvas.dataset.conversationTimelineCanvas = "true";
    this.canvas.style.position = "relative";
    this.canvas.style.width = "100%";
    root.replaceChildren(this.canvas);
    root.dataset.conversationTimelineRuntime = "true";
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
    return this.patch(this.root.scrollTop, this.root.clientHeight);
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

  updateMeasuredHeight(unitId: string, height: number): ConversationTimelinePatch | null {
    this.assertActive();
    const index = this.indexById.get(unitId);
    if (index === undefined || !this.heightIndex || !this.revision) return null;
    const anchor = this.captureAnchor();
    const normalized = finiteNonNegative(height, "height");
    this.measuredHeights.set(unitId, normalized);
    const delta = this.heightIndex.update(index, normalized, { kind: "measured", revision: this.revision });
    return delta === 0 ? null : this.updateViewportFromAnchor(anchor);
  }

  measureMounted(): ConversationTimelinePatch | null {
    const anchor = this.captureAnchor();
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
    return changed ? this.updateViewportFromAnchor(anchor) : null;
  }

  revealUnit(unitId: string, align: "start" | "center" | "end" = "center"): boolean {
    this.assertActive();
    const index = this.indexById.get(unitId);
    if (index === undefined || !this.heightIndex) return false;
    const top = this.heightIndex.offsetOf(index);
    const height = this.heightIndex.heightAt(index);
    const viewport = this.root.clientHeight;
    const target = align === "start" ? top : align === "end" ? top + height - viewport : top + height / 2 - viewport / 2;
    this.root.scrollTop = Math.max(0, Math.min(target, Math.max(0, this.heightIndex.totalHeight - viewport)));
    this.updateViewport();
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
    return this.updateViewportFromAnchor(anchor) !== null;
  }

  private updateViewportFromAnchor(anchor: ConversationTimelineAnchor | null): ConversationTimelinePatch | null {
    if (!anchor) return this.viewport ? this.updateViewport() : null;
    const index = this.indexById.get(anchor.unitId);
    if (index === undefined || !this.heightIndex) return null;
    const target = this.heightIndex.offsetOf(index) + anchor.offsetWithinUnit - anchor.viewportOffset;
    this.root.scrollTop = Math.max(0, Math.min(target, Math.max(0, this.heightIndex.totalHeight - this.root.clientHeight)));
    return this.updateViewport();
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
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeEventListener("scroll", this.handleScroll);
    this.resizeObserver?.disconnect();
    for (const slot of this.slots.values()) slot.handle.destroy();
    for (const slot of this.recycledSlots) slot.handle.destroy();
    this.slots.clear();
    this.recycledSlots.length = 0;
    this.canvas.remove();
    delete this.root.dataset.conversationTimelineRuntime;
  }

  private patch(scrollTop: number, viewportHeight: number): ConversationTimelinePatch {
    const patchStartedAt = performance.now();
    const viewport = this.viewport!.update({
      scrollTop,
      viewportHeight,
      revision: this.revision!,
      pinnedIndices: [...this.pinnedIds].map((id) => this.indexById.get(id)!).filter((index) => index !== undefined),
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
      if (unit.turnIndex !== null) {
        setDatasetValue(slot.element, "turnIndex", String(unit.turnIndex));
        setDatasetValue(slot.element, "testid", "message-turn");
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
    if (!this.disposed && this.viewport) this.updateViewport(this.root.scrollTop, this.root.clientHeight);
  };

  private handleMeasurements(entries: readonly ResizeObserverEntry[]): void {
    const anchor = this.captureAnchor();
    let changed = false;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const id = element.dataset.conversationUnitId;
      const index = id ? this.indexById.get(id) : undefined;
      const height = entry.contentRect.height;
      if (!id || index === undefined || !this.heightIndex || !this.revision || height < 0) continue;
      if (this.measuredHeights.get(id) === height) continue;
      this.measuredHeights.set(id, height);
      changed = this.heightIndex.update(index, height, { kind: "measured", revision: this.revision }) !== 0 || changed;
    }
    if (changed) this.updateViewportFromAnchor(anchor);
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
