import {
  createMarkdownSnapshot,
  type MarkdownSnapshot,
  type MarkdownSnapshotBlock,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { MarkdownMeasurementScheduler } from "@/renderer/markdownRuntime/layout/MeasurementScheduler";
import type { MarkdownHeightUpdate } from "@/renderer/markdownRuntime/layout/HeightIndex";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  SemanticMarkdownRendererRegistry,
  type MarkdownBlockDomInstance,
  type MarkdownBlockRendererContext,
  type MarkdownBlockRendererDefinition,
} from "@/renderer/markdownRuntime/renderers";
import {
  DocumentViewRuntime,
  type DocumentViewPatchResult,
  type DocumentViewportUpdateOptions,
} from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import type { MarkdownViewportResult } from "@/renderer/markdownRuntime/view/ViewportController";

import type { ConversationRenderUnit } from "./ConversationRenderUnit";
import { CONVERSATION_GEOMETRY_COMMIT_EVENT } from "./ConversationGeometryCommit";

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
  readonly reason:
    | "follow-bottom"
    | "follow-bottom-geometry"
    | "preserve-top"
    | "reveal-unit"
    | "restore-anchor";
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
  readonly controlledScrollActive: boolean;
  readonly topLocked: boolean;
  readonly deferredMeasurements: number;
}

export interface ConversationTimelineAnchor {
  readonly unitId: string;
  readonly offsetWithinUnit: number;
  readonly viewportOffset: number;
  readonly capturedRevision: string;
}

const DEFAULT_OVERSCAN_PX = 800;
const DEFAULT_MAX_PINNED_UNITS = 64;
const HEIGHT_EPSILON_PX = 0.5;
const USER_SCROLL_SETTLE_MS = 180;
const MIN_UNIT_HEIGHT_PX = 1;

/**
 * Conversation timeline backed by the same retained document runtime as the
 * large Markdown file preview.
 *
 * The Snapshot is deliberately lightweight: each conversation render unit is
 * one semantic block and its payload stays in the unit map rather than being
 * cloned into the Snapshot. DocumentViewRuntime owns the height index,
 * viewport, scroll anchoring and retained block lifecycle. React/A2UI is only
 * mounted by the custom block renderer for the bounded visible window.
 */
export class ConversationTimelineRuntime {
  readonly canvas: HTMLDivElement;
  private readonly renderer: ConversationTimelineUnitRenderer;
  private readonly maxPinnedUnits: number;
  private readonly onPatch?: (patch: ConversationTimelinePatch) => void;
  private readonly onScrollRequest?: (request: ConversationTimelineScrollRequest) => void;
  private readonly view: DocumentViewRuntime;
  private readonly measurement: MarkdownMeasurementScheduler | null;
  private readonly measuredElements = new Map<string, Element>();
  private readonly pinnedIds = new Set<string>();
  private readonly residentIds = new Set<string>();
  private readonly viewportResizeObserver: ResizeObserver | null;
  private units: readonly ConversationRenderUnit[] = Object.freeze([]);
  private unitsById = new Map<string, ConversationRenderUnit>();
  private indexById = new Map<string, number>();
  private snapshot: MarkdownSnapshot | null = null;
  private revision: string | null = null;
  private sequence = 0;
  private patches = 0;
  private scrollPatches = 0;
  private followBottom: boolean;
  private userScrollActive = false;
  private controlledScrollActive = false;
  private followBottomGestureActive = false;
  private expectedProgrammaticScrollTop: number | null = null;
  private viewportFrame: number | null = null;
  private geometryFrame: number | null = null;
  private readonly dirtyGeometryIds = new Set<string>();
  private readonly earlyRenderedCommits = new Map<string, string>();
  private userScrollSettleTimer: number | null = null;
  private viewMutationActive = false;
  private disposed = false;

  constructor(readonly root: HTMLElement, options: ConversationTimelineRuntimeOptions) {
    this.renderer = options.renderer;
    this.maxPinnedUnits = positiveInteger(options.maxPinnedUnits ?? DEFAULT_MAX_PINNED_UNITS, "maxPinnedUnits");
    this.followBottom = options.followBottom ?? false;
    this.onPatch = options.onPatch;
    this.onScrollRequest = options.onScrollRequest;
    const registry = new SemanticMarkdownRendererRegistry({
      unknown: this.conversationBlockRenderer(),
    });
    this.view = new DocumentViewRuntime(root, {
      profile: CONVERSATION_MARKDOWN_RENDERER_PROFILE,
      registry,
      protectFocusAndSelection: true,
      viewport: {
        defaultOverscanPx: finiteNonNegative(options.overscanPx ?? DEFAULT_OVERSCAN_PX, "overscanPx"),
        maxPinnedBlocks: this.maxPinnedUnits,
      },
    });
    this.canvas = this.view.canvas;
    // The document renderer normally styles a Markdown canvas. Conversation
    // blocks contain their own Markdown roots plus arbitrary React/A2UI, so
    // the outer retained canvas must not leak Markdown typography into them.
    // Its width is owned by MessageList CSS so the dynamic turn-navigator
    // reservation can narrow the actual runtime units without moving their
    // established left edge.
    this.canvas.classList.remove("keydex-markdown");
    this.canvas.style.removeProperty("width");
    this.canvas.dataset.conversationTimelineCanvas = "true";
    this.canvas.style.overflowX = "visible";
    this.canvas.style.overflowY = "clip";
    root.dataset.conversationTimelineRuntime = "true";
    root.dataset.conversationTimelineEngine = "document-view";
    root.dataset.conversationTimelineLayoutMode = "virtual";
    root.dataset.conversationTimelineFollowBottom = this.followBottom ? "true" : "false";
    root.addEventListener("scroll", this.handleScroll, { passive: true });
    root.addEventListener(CONVERSATION_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    this.measurement = options.observeMeasurements !== false && typeof ResizeObserver !== "undefined"
      ? new MarkdownMeasurementScheduler({
          revision: "conversation-document:initial",
          epoch: 0,
          epsilon: HEIGHT_EPSILON_PX,
          onMeasurements: (batch) => this.applyMeasuredHeightBatch(batch.updates, batch.revision),
        })
      : null;
    this.viewportResizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => this.scheduleViewportUpdate());
    this.viewportResizeObserver?.observe(root);
  }

  publish(
    units: readonly ConversationRenderUnit[],
    residentUnitIds: readonly string[] = [],
  ): ConversationTimelinePatch {
    this.assertActive();
    assertUniqueUnits(units);
    this.units = Object.freeze([...units]);
    this.unitsById = new Map(units.map((unit) => [unit.id, unit]));
    this.indexById = new Map(units.map((unit, index) => [unit.id, index]));
    for (const id of [...this.pinnedIds]) if (!this.indexById.has(id)) this.pinnedIds.delete(id);
    this.residentIds.clear();
    for (const id of residentUnitIds) if (this.indexById.has(id)) this.residentIds.add(id);
    this.assertPinBudget();
    this.revision = `conversation-document:${++this.sequence}`;
    this.snapshot = conversationSnapshot(this.units, this.revision);
    this.measurement?.setContext({ revision: this.revision, epoch: this.sequence });
    this.measuredElements.clear();
    const heights = this.units.map((unit) => Math.max(MIN_UNIT_HEIGHT_PX, unit.estimatedHeight));
    const estimatedTotalHeight = heights.reduce((total, height) => total + height, 0);
    const scrollTop = this.followBottom && !this.userScrollActive
      ? Math.max(0, estimatedTotalHeight - this.root.clientHeight)
      : this.root.scrollTop;
    const result = this.stabilizeMountedGeometry(this.withViewMutation(() => this.view.publish(
      this.snapshot!,
      heights,
      this.viewportInput(scrollTop),
      { preserveRevisionGeometry: true },
    )));
    let patch = this.publishPatch(result);
    if (this.followBottom && !this.userScrollActive) {
      const target = this.bottomScrollTop();
      if (Math.abs(result.viewport.scrollTop - target) > HEIGHT_EPSILON_PX) {
        patch = this.updateViewportWithOrigin(target, this.root.clientHeight, "programmatic");
      }
      if (Math.abs(this.root.scrollTop - target) > HEIGHT_EPSILON_PX) {
        this.requestScroll(target, "follow-bottom");
      }
    }
    return patch;
  }

  updateViewport(
    scrollTop = this.root.scrollTop,
    viewportHeight = this.root.clientHeight,
  ): ConversationTimelinePatch {
    return this.updateViewportWithOrigin(scrollTop, viewportHeight, "user");
  }

  setPinned(unitId: string, pinned: boolean): ConversationTimelinePatch | null {
    this.assertActive();
    if (!this.indexById.has(unitId)) return null;
    if (pinned) this.pinnedIds.add(unitId);
    else this.pinnedIds.delete(unitId);
    try {
      this.assertPinBudget();
    } catch (error) {
      if (pinned) this.pinnedIds.delete(unitId);
      throw error;
    }
    return this.snapshot ? this.updateViewportWithOrigin(this.root.scrollTop, this.root.clientHeight, "automatic") : null;
  }

  setResidentUnits(unitIds: readonly string[]): ConversationTimelinePatch | null {
    this.assertActive();
    const next = new Set(unitIds.filter((unitId) => this.indexById.has(unitId)));
    const combined = new Set([...this.pinnedIds, ...next]);
    if (combined.size > this.maxPinnedUnits) {
      throw new Error(`Pinned conversation units exceed limit ${this.maxPinnedUnits}`);
    }
    if (setsEqual(this.residentIds, next)) return null;
    this.residentIds.clear();
    next.forEach((unitId) => this.residentIds.add(unitId));
    return this.snapshot ? this.updateViewportWithOrigin(this.root.scrollTop, this.root.clientHeight, "automatic") : null;
  }

  setFollowBottom(enabled: boolean): ConversationTimelinePatch | null {
    this.assertActive();
    const becameEnabled = enabled && !this.followBottom;
    this.followBottom = enabled;
    this.root.dataset.conversationTimelineFollowBottom = enabled ? "true" : "false";
    if (!enabled) {
      this.followBottomGestureActive = false;
      return null;
    }
    if (!this.snapshot) return null;
    // Returning to the bottom can mount the resident tail and settle its exact
    // height in the same gesture. Keep that correction inside the gesture: a
    // delayed commit leaves the newly positioned tail visible at the old
    // scrollTop for USER_SCROLL_SETTLE_MS, which looks like the whole timeline
    // sinks behind the composer before snapping back.
    this.followBottomGestureActive = this.userScrollActive && becameEnabled;
    return this.commitFollowBottom("follow-bottom");
  }

  setUserScrollInteraction(active: boolean): void {
    this.assertActive();
    if (active) {
      this.userScrollActive = true;
      this.root.dataset.conversationTimelineUserScrollActive = "true";
      return;
    }
    this.clearUserScrollSettleTimer();
    this.settleUserScrollInteraction();
  }

  setControlledScrollInteraction(active: boolean): void {
    this.assertActive();
    this.controlledScrollActive = active;
    this.root.dataset.conversationTimelineControlledScrollActive = active ? "true" : "false";
    // Unlike the retired timeline, a controlled thumb never freezes the old
    // render window. Scroll events continue to publish once per animation
    // frame, exactly like FileMarkdownRuntimeHost.
    if (!active) this.settleControlledScrollViewport();
  }

  settleControlledScrollViewport(): ConversationTimelinePatch | null {
    this.assertActive();
    if (!this.snapshot) return null;
    this.cancelViewportFrame();
    return this.updateViewportWithOrigin(this.root.scrollTop, this.root.clientHeight, "user");
  }

  updateMeasuredHeight(unitId: string, height: number): ConversationTimelinePatch | null {
    this.assertActive();
    const index = this.indexById.get(unitId);
    if (index === undefined || !this.snapshot) return null;
    const normalized = finiteNonNegative(height, "height");
    if (normalized < MIN_UNIT_HEIGHT_PX || Math.abs(this.view.baseHeightAt(index) - normalized) <= HEIGHT_EPSILON_PX) {
      return null;
    }
    return this.applyMeasuredHeightBatch([{ index, height: normalized, kind: "measured" }], this.snapshot.revision);
  }

  measureMounted(): ConversationTimelinePatch | null {
    this.assertActive();
    if (!this.snapshot) return null;
    const updates: MarkdownHeightUpdate[] = [];
    for (const blockId of this.view.mountedBlockIds()) {
      const element = this.view.getBlockElement(blockId);
      const index = this.indexById.get(blockId);
      if (!element || index === undefined || element.dataset.conversationUnitMeasurementPending) continue;
      const height = element.getBoundingClientRect().height;
      if (!Number.isFinite(height) || height < MIN_UNIT_HEIGHT_PX) continue;
      this.measurement?.synchronize(element, height);
      if (Math.abs(this.view.baseHeightAt(index) - height) > HEIGHT_EPSILON_PX) {
        updates.push({ index, height, kind: "measured" });
      }
    }
    return updates.length ? this.applyMeasuredHeightBatch(updates, this.snapshot.revision) : null;
  }

  revealUnit(unitId: string, align: "start" | "center" | "end" = "center"): boolean {
    this.assertActive();
    const index = this.indexById.get(unitId);
    const heightIndex = this.view.getHeightIndex();
    if (index === undefined || !heightIndex || !this.snapshot) return false;
    this.followBottom = false;
    this.followBottomGestureActive = false;
    this.root.dataset.conversationTimelineFollowBottom = "false";
    const top = heightIndex.offsetOf(index);
    const height = heightIndex.heightAt(index);
    const viewportHeight = this.root.clientHeight;
    const rawTarget = align === "start"
      ? top
      : align === "end"
        ? top + height - viewportHeight
        : top + height / 2 - viewportHeight / 2;
    const target = clamp(rawTarget, 0, Math.max(0, heightIndex.totalHeight - viewportHeight));
    this.updateViewportWithOrigin(target, viewportHeight, "programmatic");
    this.requestScroll(target, "reveal-unit");
    return true;
  }

  captureAnchor(viewportOffset = 0): ConversationTimelineAnchor | null {
    this.assertActive();
    const heightIndex = this.view.getHeightIndex();
    if (!heightIndex || !this.revision || !this.units.length) return null;
    const boundedOffset = clamp(viewportOffset, 0, Math.max(0, this.root.clientHeight));
    const absoluteY = clamp(
      this.root.scrollTop + boundedOffset,
      0,
      Math.max(0, heightIndex.totalHeight - Number.EPSILON),
    );
    const position = heightIndex.queryY(absoluteY);
    const unit = position ? this.units[position.index] : null;
    if (!position || !unit) return null;
    return Object.freeze({
      unitId: unit.id,
      offsetWithinUnit: position.offsetWithinBlock,
      viewportOffset: boundedOffset,
      capturedRevision: this.revision,
    });
  }

  restoreAnchor(anchor: ConversationTimelineAnchor): boolean {
    this.assertActive();
    const index = this.indexById.get(anchor.unitId);
    const heightIndex = this.view.getHeightIndex();
    if (index === undefined || !heightIndex || !this.snapshot) return false;
    this.followBottom = false;
    this.followBottomGestureActive = false;
    this.root.dataset.conversationTimelineFollowBottom = "false";
    const target = clamp(
      heightIndex.offsetOf(index) + anchor.offsetWithinUnit - anchor.viewportOffset,
      0,
      Math.max(0, heightIndex.totalHeight - this.root.clientHeight),
    );
    this.updateViewportWithOrigin(target, this.root.clientHeight, "programmatic");
    this.requestScroll(target, "restore-anchor");
    return true;
  }

  getUnitElement(unitId: string): HTMLElement | null {
    return this.view.getBlockElement(unitId);
  }

  commitRenderedUnit(unit: Pick<ConversationRenderUnit, "id" | "renderVersion">): boolean {
    this.assertActive();
    const current = this.unitsById.get(unit.id);
    const element = this.view.getBlockElement(unit.id);
    if (!current || current.renderVersion !== unit.renderVersion) return false;
    if (!element) {
      // A renderer is allowed to commit before its create() call has returned
      // the DOM instance to DocumentViewRuntime. Record that edge without
      // forcing a React flush; createConversationBlock consumes it below.
      this.earlyRenderedCommits.set(unit.id, unit.renderVersion);
      return true;
    }
    if (element.dataset.conversationUnitMeasurementPending !== conversationTimelineUnitCommitKey(unit)) return false;
    delete element.dataset.conversationUnitMeasurementPending;
    this.dirtyGeometryIds.add(unit.id);
    this.syncMeasurementTargets();
    if (!this.viewMutationActive) {
      const height = element.getBoundingClientRect().height;
      if (Number.isFinite(height) && height >= MIN_UNIT_HEIGHT_PX) {
        this.dirtyGeometryIds.delete(unit.id);
        this.updateMeasuredHeight(unit.id, height);
      }
    }
    return true;
  }

  mountedUnitIds(): readonly string[] {
    return this.view.mountedBlockIds();
  }

  diagnostics(): ConversationTimelineDiagnostics {
    const heightIndex = this.view.getHeightIndex();
    return Object.freeze({
      revision: this.revision,
      units: this.units.length,
      mounted: this.view.mountedBlockIds().length,
      recycled: 0,
      pinned: new Set([...this.pinnedIds, ...this.residentIds]).size,
      measured: heightIndex?.measuredCount() ?? 0,
      totalHeight: heightIndex?.totalHeight ?? 0,
      domNodes: this.root.querySelectorAll("*").length,
      patches: this.patches,
      scrollPatches: this.scrollPatches,
      followBottom: this.followBottom,
      userScrollActive: this.userScrollActive,
      controlledScrollActive: this.controlledScrollActive,
      topLocked: false,
      deferredMeasurements: 0,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeEventListener("scroll", this.handleScroll);
    this.root.removeEventListener(CONVERSATION_GEOMETRY_COMMIT_EVENT, this.handleGeometryCommit);
    this.clearUserScrollSettleTimer();
    this.cancelViewportFrame();
    this.cancelGeometryFrame();
    this.viewportResizeObserver?.disconnect();
    this.measurement?.dispose();
    this.measuredElements.clear();
    this.earlyRenderedCommits.clear();
    this.view.destroy();
    this.unitsById.clear();
    this.indexById.clear();
    delete this.root.dataset.conversationTimelineRuntime;
    delete this.root.dataset.conversationTimelineEngine;
    delete this.root.dataset.conversationTimelineLayoutMode;
    delete this.root.dataset.conversationTimelineFollowBottom;
    delete this.root.dataset.conversationTimelineUserScrollActive;
    delete this.root.dataset.conversationTimelineControlledScrollActive;
  }

  private conversationBlockRenderer(): MarkdownBlockRendererDefinition {
    return {
      create: (context) => this.createConversationBlock(context),
    };
  }

  private createConversationBlock(context: MarkdownBlockRendererContext): MarkdownBlockDomInstance {
    let currentContext = context;
    let currentUnit = this.requiredUnit(context.block.id);
    const element = context.ownerDocument.createElement("div");
    applyUnitAttributes(element, currentUnit, context.block.index, this.units);
    element.dataset.conversationUnitMeasurementPending = conversationTimelineUnitCommitKey(currentUnit);
    this.dirtyGeometryIds.add(currentUnit.id);
    const handle = this.renderer.mount(currentUnit, element);
    if (this.earlyRenderedCommits.get(currentUnit.id) === currentUnit.renderVersion) {
      this.earlyRenderedCommits.delete(currentUnit.id);
      delete element.dataset.conversationUnitMeasurementPending;
    }
    return {
      element,
      update: (nextContext) => {
        const nextUnit = this.requiredUnit(nextContext.block.id);
        const changed = nextUnit.renderVersion !== currentUnit.renderVersion;
        currentContext = nextContext;
        currentUnit = nextUnit;
        applyUnitAttributes(element, nextUnit, nextContext.block.index, this.units);
        if (changed) {
          element.dataset.conversationUnitMeasurementPending = conversationTimelineUnitCommitKey(nextUnit);
          this.dirtyGeometryIds.add(nextUnit.id);
          handle.update(nextUnit);
          return "updated";
        }
        return "reused";
      },
      sourceMap: () => Object.freeze({
        blockId: currentContext.block.id,
        sourceStart: 0,
        sourceEnd: 0,
        logicalStart: 0,
        logicalEnd: 0,
        inline: Object.freeze([]),
      }),
      measure: () => {
        const rect = element.getBoundingClientRect();
        return Object.freeze({ width: rect.width, height: rect.height });
      },
      destroy: () => {
        this.measurement?.unobserve(element);
        this.measuredElements.delete(currentUnit.id);
        this.dirtyGeometryIds.delete(currentUnit.id);
        this.earlyRenderedCommits.delete(currentUnit.id);
        handle.destroy();
        element.remove();
      },
    };
  }

  private updateViewportWithOrigin(
    scrollTop: number,
    viewportHeight: number,
    origin: NonNullable<DocumentViewportUpdateOptions["origin"]>,
  ): ConversationTimelinePatch {
    this.assertActive();
    if (!this.snapshot) throw new Error("Conversation timeline has not been published");
    this.scrollPatches += 1;
    const update = () => this.stabilizeMountedGeometry(
      this.withViewMutation(() => this.view.updateViewport(
        this.viewportInput(scrollTop, viewportHeight),
        { origin },
      )),
    );
    const result = update();
    return this.publishPatch(result);
  }

  private publishPatch(result: DocumentViewPatchResult): ConversationTimelinePatch {
    this.patches += 1;
    for (const item of result.viewport.items) {
      const unit = this.units[item.index];
      const element = unit ? this.view.getBlockElement(unit.id) : null;
      if (!unit || !element) continue;
      element.dataset.conversationUnitVisible = item.visible ? "true" : "false";
      element.dataset.conversationUnitPinned = item.pinned ? "true" : "false";
      element.dataset.conversationUnitResident = this.residentIds.has(unit.id) ? "true" : "false";
    }
    this.syncMeasurementTargets();
    const patch: ConversationTimelinePatch = Object.freeze({
      revision: result.revision,
      viewport: result.viewport,
      created: result.render.created,
      updated: result.render.updated,
      reused: result.render.reused,
      destroyed: result.render.destroyed,
      mounted: result.mountedBlockRoots,
    });
    this.root.dataset.conversationTimelineMountedUnits = String(patch.mounted);
    this.canvas.dataset.conversationTimelineTotalHeight = String(result.viewport.totalHeight);
    this.onPatch?.(patch);
    return patch;
  }

  private applyMeasuredHeightBatch(
    updates: readonly MarkdownHeightUpdate[],
    revision: string,
  ): ConversationTimelinePatch | null {
    if (!this.snapshot || this.snapshot.revision !== revision) return null;
    const effective = updates.filter((update) => (
      update.height >= MIN_UNIT_HEIGHT_PX
      && Math.abs(this.view.baseHeightAt(update.index) - update.height) > HEIGHT_EPSILON_PX
    ));
    if (!effective.length) return null;
    // A ResizeObserver/React commit can land between the native scroll event
    // and its coalesced viewport frame. Rebase the document window to the
    // actual thumb position before applying geometry so an old tail window can
    // never be repainted over the user's new location.
    if (this.userScrollActive || this.controlledScrollActive) {
      this.cancelViewportFrame();
      this.publishPatch(this.withViewMutation(() => this.view.updateViewport(
        this.viewportInput(this.root.scrollTop),
        { origin: "user" },
      )));
    }
    const result = this.withViewMutation(() => this.view.updateMeasuredHeights(effective, revision));
    if (!result) return null;
    let patch = this.publishPatch(result);
    if (this.followBottom && (!this.userScrollActive || this.followBottomGestureActive)) {
      patch = this.commitFollowBottom("follow-bottom-geometry");
    } else if (
      !this.userScrollActive
      && !this.controlledScrollActive
      && Math.abs(this.root.scrollTop - result.viewport.scrollTop) > HEIGHT_EPSILON_PX
    ) {
      this.requestScroll(result.viewport.scrollTop, "preserve-top");
    }
    return patch;
  }

  private syncMeasurementTargets(): void {
    const scheduler = this.measurement;
    if (!scheduler || !this.snapshot) return;
    const mountedIds = new Set(this.view.mountedBlockIds());
    for (const [blockId, element] of this.measuredElements) {
      if (mountedIds.has(blockId) && this.view.getBlockElement(blockId) === element) continue;
      scheduler.unobserve(element);
      this.measuredElements.delete(blockId);
    }
    for (const blockId of mountedIds) {
      const element = this.view.getBlockElement(blockId);
      const index = this.indexById.get(blockId);
      if (
        !element
        || index === undefined
        || element.dataset.conversationUnitMeasurementPending
        || this.measuredElements.get(blockId) === element
      ) continue;
      scheduler.observe(element, {
        index,
        blockId,
        initialHeight: this.view.baseHeightAt(index),
      });
      this.measuredElements.set(blockId, element);
    }
  }

  private stabilizeMountedGeometry(initial: DocumentViewPatchResult): DocumentViewPatchResult {
    let result = initial;
    // React/A2UI blocks have much less predictable geometry than Markdown.
    // Only blocks dirtied by a renderer commit are read here; scanning every
    // mounted block on each scroll frame would force avoidable layout work.
    // A second pass covers a block pulled into overscan by the first correction.
    for (let pass = 0; pass < 2; pass += 1) {
      const updates: MarkdownHeightUpdate[] = [];
      const dirtyIds = [...this.dirtyGeometryIds];
      this.dirtyGeometryIds.clear();
      for (const blockId of dirtyIds) {
        const element = this.view.getBlockElement(blockId);
        const index = this.indexById.get(blockId);
        if (!element || index === undefined || element.dataset.conversationUnitMeasurementPending) continue;
        const height = element.getBoundingClientRect().height;
        if (!Number.isFinite(height) || height < MIN_UNIT_HEIGHT_PX) continue;
        this.measurement?.synchronize(element, height);
        if (Math.abs(this.view.baseHeightAt(index) - height) > HEIGHT_EPSILON_PX) {
          updates.push({ index, height, kind: "measured" });
        }
      }
      if (!updates.length || !this.snapshot) break;
      const measured = this.withViewMutation(() => this.view.updateMeasuredHeights(updates, this.snapshot!.revision));
      if (!measured) break;
      result = measured;
    }
    return result;
  }

  private withViewMutation<T>(callback: () => T): T {
    const previous = this.viewMutationActive;
    this.viewMutationActive = true;
    try {
      return callback();
    } finally {
      this.viewMutationActive = previous;
    }
  }

  private scheduleGeometryMeasurement(unitId: string): void {
    if (!this.indexById.has(unitId)) return;
    this.dirtyGeometryIds.add(unitId);
    if (this.geometryFrame !== null) return;
    const view = this.root.ownerDocument.defaultView;
    if (!view) {
      this.flushGeometryMeasurements();
      return;
    }
    this.geometryFrame = view.requestAnimationFrame(() => {
      this.geometryFrame = null;
      this.flushGeometryMeasurements();
    });
  }

  private flushGeometryMeasurements(): void {
    if (this.disposed || !this.snapshot || !this.dirtyGeometryIds.size) return;
    const updates: MarkdownHeightUpdate[] = [];
    for (const unitId of this.dirtyGeometryIds) {
      const index = this.indexById.get(unitId);
      const element = this.view.getBlockElement(unitId);
      if (index === undefined || !element) continue;
      // A pending local React root will schedule its own exact measurement in
      // commitRenderedUnit. Never poll it frame-by-frame: a stale pending flag
      // must not be able to create an infinite requestAnimationFrame loop.
      if (element.dataset.conversationUnitMeasurementPending) continue;
      const height = element.getBoundingClientRect().height;
      if (
        Number.isFinite(height)
        && height >= MIN_UNIT_HEIGHT_PX
        && Math.abs(this.view.baseHeightAt(index) - height) > HEIGHT_EPSILON_PX
      ) updates.push({ index, height, kind: "measured" });
    }
    this.dirtyGeometryIds.clear();
    if (updates.length) this.applyMeasuredHeightBatch(updates, this.snapshot.revision);
  }

  private cancelGeometryFrame(): void {
    if (this.geometryFrame === null) return;
    this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.geometryFrame);
    this.geometryFrame = null;
  }

  private viewportInput(scrollTop: number, viewportHeight = this.root.clientHeight) {
    const pinnedIndices = [...new Set([...this.pinnedIds, ...this.residentIds])]
      .flatMap((id) => {
        const index = this.indexById.get(id);
        return index === undefined ? [] : [index];
      });
    return {
      scrollTop,
      viewportHeight,
      revision: this.snapshot?.revision,
      pinnedIndices,
    };
  }

  private requiredUnit(id: string): ConversationRenderUnit {
    const unit = this.unitsById.get(id);
    if (!unit) throw new Error(`Conversation unit ${id} is not available`);
    return unit;
  }

  private bottomScrollTop(): number {
    return Math.max(0, (this.view.getHeightIndex()?.totalHeight ?? 0) - this.root.clientHeight);
  }

  private requestScroll(scrollTop: number, reason: ConversationTimelineScrollRequest["reason"]): void {
    this.expectedProgrammaticScrollTop = scrollTop;
    this.onScrollRequest?.(Object.freeze({ scrollTop, reason }));
  }

  private scheduleViewportUpdate(): void {
    if (this.disposed || !this.snapshot || this.viewportFrame !== null) return;
    const view = this.root.ownerDocument.defaultView;
    if (!view) {
      this.updateViewportWithOrigin(this.root.scrollTop, this.root.clientHeight, "user");
      return;
    }
    this.viewportFrame = view.requestAnimationFrame(() => {
      this.viewportFrame = null;
      if (this.disposed || !this.snapshot) return;
      const programmatic = this.expectedProgrammaticScrollTop !== null
        && Math.abs(this.root.scrollTop - this.expectedProgrammaticScrollTop) <= 1;
      if (programmatic) this.expectedProgrammaticScrollTop = null;
      this.updateViewportWithOrigin(
        this.root.scrollTop,
        this.root.clientHeight,
        programmatic ? "programmatic" : "user",
      );
    });
  }

  private cancelViewportFrame(): void {
    if (this.viewportFrame === null) return;
    this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.viewportFrame);
    this.viewportFrame = null;
  }

  private readonly handleScroll = () => {
    if (this.disposed || !this.snapshot) return;
    const programmatic = this.expectedProgrammaticScrollTop !== null
      && Math.abs(this.root.scrollTop - this.expectedProgrammaticScrollTop) <= 1;
    if (!programmatic && !this.controlledScrollActive) {
      this.userScrollActive = true;
      this.root.dataset.conversationTimelineUserScrollActive = "true";
      this.clearUserScrollSettleTimer();
      const view = this.root.ownerDocument.defaultView;
      if (view) {
        this.userScrollSettleTimer = view.setTimeout(() => {
          this.userScrollSettleTimer = null;
          this.settleUserScrollInteraction();
        }, USER_SCROLL_SETTLE_MS);
      }
    }
    this.scheduleViewportUpdate();
  };

  private readonly handleGeometryCommit = (event: Event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-conversation-unit-id]")
      : null;
    const unitId = target?.dataset.conversationUnitId;
    if (unitId) this.scheduleGeometryMeasurement(unitId);
  };

  private clearUserScrollSettleTimer(): void {
    if (this.userScrollSettleTimer === null) return;
    this.root.ownerDocument.defaultView?.clearTimeout(this.userScrollSettleTimer);
    this.userScrollSettleTimer = null;
  }

  private settleUserScrollInteraction(): void {
    this.userScrollActive = false;
    this.root.dataset.conversationTimelineUserScrollActive = "false";
    this.followBottomGestureActive = false;
  }

  private commitFollowBottom(
    reason: Extract<ConversationTimelineScrollRequest["reason"], "follow-bottom" | "follow-bottom-geometry">,
  ): ConversationTimelinePatch {
    this.cancelViewportFrame();
    // First settle dirty mounted geometry against the scrollTop the browser is
    // actually displaying. The old implementation calculated the target
    // before this pass, so a late Markdown measurement could make that target
    // stale by exactly the height delta that had just been published.
    let patch = this.updateViewportWithOrigin(
      this.root.scrollTop,
      this.root.clientHeight,
      "programmatic",
    );
    for (let pass = 0; pass < 2; pass += 1) {
      const target = this.bottomScrollTop();
      // The follow controller remains the only physical scroll writer. Issue
      // the scroll before publishing the target viewport so the canvas and the
      // browser thumb reach the same bottom in one synchronous commit.
      this.requestScroll(target, reason);
      patch = this.updateViewportWithOrigin(target, this.root.clientHeight, "programmatic");
      if (Math.abs(this.bottomScrollTop() - target) <= HEIGHT_EPSILON_PX) return patch;
    }
    const settledTarget = this.bottomScrollTop();
    this.requestScroll(settledTarget, reason);
    return this.updateViewportWithOrigin(settledTarget, this.root.clientHeight, "programmatic");
  }

  private assertPinBudget(): void {
    if (new Set([...this.pinnedIds, ...this.residentIds]).size > this.maxPinnedUnits) {
      throw new Error(`Pinned conversation units exceed limit ${this.maxPinnedUnits}`);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Conversation timeline is destroyed");
  }
}

function conversationSnapshot(
  units: readonly ConversationRenderUnit[],
  revision: string,
): MarkdownSnapshot {
  const blocks: MarkdownSnapshotBlock[] = units.map((unit, index) => ({
    id: unit.id,
    identity_key: unit.id,
    content_hash: unit.renderVersion || unit.id,
    index,
    kind: "unknown",
    parent_id: null,
    depth: 0,
    line_start: 0,
    line_end: 0,
    source_start: 0,
    source_end: 0,
    logical_start: 0,
    logical_end: 0,
    inline_spans: Object.freeze([]),
    metadata: Object.freeze({}),
  }));
  return createMarkdownSnapshot({
    surface: "message",
    document_id: "conversation-timeline",
    revision,
    renderer_profile: "conversation",
    mode: "canonical",
    source_bytes: 0,
    source_characters: 0,
    logical_text: "",
    line_count: 0,
    blocks,
    outline: Object.freeze([]),
    resources: Object.freeze([]),
    stream: Object.freeze({ kind: "canonical", finalized: true }),
    indexes: Object.freeze({
      line_map_revision: revision,
      logical_projection_revision: revision,
      source_index_revision: revision,
      find_index_revision: null,
      annotation_index_revision: null,
    }),
  });
}

function applyUnitAttributes(
  element: HTMLElement,
  unit: ConversationRenderUnit,
  index: number,
  units: readonly ConversationRenderUnit[],
): void {
  element.dataset.conversationUnitId = unit.id;
  element.dataset.markdownBlockId = unit.id;
  element.dataset.markdownBlockKind = "unknown";
  element.dataset.conversationUnitIndex = String(index);
  element.dataset.conversationUnitKind = unit.kind;
  element.dataset.conversationUnitResident = "false";
  element.dataset.conversationUnitTailAdjacent = isTailAdjacent(index, units) ? "true" : "false";
  if (unit.turnIndex === null) {
    delete element.dataset.turnIndex;
    delete element.dataset.testid;
  } else {
    element.dataset.turnIndex = String(unit.turnIndex);
    if (units[index - 1]?.turnIndex !== unit.turnIndex) element.dataset.testid = "message-turn";
    else delete element.dataset.testid;
  }
}

function isTailAdjacent(index: number, units: readonly ConversationRenderUnit[]): boolean {
  const last = units.at(-1);
  const semanticTailIndex = last?.id === "conversation-runtime:bottom" ? units.length - 2 : units.length - 1;
  return index === semanticTailIndex;
}

function conversationTimelineUnitCommitKey(unit: Pick<ConversationRenderUnit, "id" | "renderVersion">): string {
  return `${unit.id}\u0000${unit.renderVersion}`;
}

function assertUniqueUnits(units: readonly ConversationRenderUnit[]): void {
  const ids = new Set<string>();
  for (const unit of units) {
    if (!unit.id.trim()) throw new Error("Conversation unit id is required");
    if (ids.has(unit.id)) throw new Error(`Duplicate conversation unit ${unit.id}`);
    ids.add(unit.id);
    finiteNonNegative(unit.estimatedHeight, `estimatedHeight:${unit.id}`);
  }
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
