import type { ResolvedAnnotationIndex } from "@/renderer/features/annotations/domain/resolutions";

import type { MarkdownSnapshot } from "../document/MarkdownSnapshot";
import {
  MarkdownPositionMapper,
  type MarkdownMountedBlockResolver,
} from "../mapping/MarkdownPositionMapper";

export interface MarkdownAnnotationOverlayMarker {
  readonly annotationId: string;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly blockLocalStart: number;
  readonly blockLocalEnd: number;
  readonly logicalStart: number;
  readonly logicalEnd: number;
}

export interface MarkdownAnnotationOverlayState {
  readonly revision: string;
  readonly annotationSetRevision: string;
  readonly activeAnnotationId: string | null;
  readonly hoveredAnnotationId: string | null;
  readonly flashAnnotationId: string | null;
  readonly markers: readonly MarkdownAnnotationOverlayMarker[];
}

export interface MarkdownAnnotationRevealTarget {
  readonly annotationId: string;
  readonly blockId: string;
  readonly blockIndex: number;
}

export interface MarkdownAnnotationOverlayControllerOptions {
  readonly snapshot: MarkdownSnapshot;
  readonly mapper: MarkdownPositionMapper;
  readonly mounted: MarkdownMountedBlockResolver;
  readonly rectProvider?: (range: Range, block: HTMLElement) => readonly DOMRectReadOnly[];
  readonly reveal?: (target: MarkdownAnnotationRevealTarget) => void | Promise<void>;
  readonly onActivate?: (annotationId: string) => void;
  readonly onHover?: (annotationId: string | null) => void;
  /** Reuses the same block-local retained overlay machinery for Find and
   * source reveals without exposing those markers to the annotation adapter. */
  readonly variant?: "annotation" | "find" | "source-reveal";
}

export interface MarkdownAnnotationOverlayPatchStats {
  readonly revision: string;
  readonly changedBlocks: readonly string[];
  readonly renderedBlocks: number;
  readonly mountedBlocks: number;
  readonly markerFragments: number;
  readonly logicalMarkers: number;
  readonly unmountedMarkers: number;
}

export interface MarkdownMountedAnnotationMarker {
  readonly annotationId: string;
  readonly blockId: string;
  readonly element: HTMLElement;
  readonly block: HTMLElement;
}

export interface MarkdownAnnotationOverlayGeometrySource {
  forEachMountedMarker(visitor: (marker: MarkdownMountedAnnotationMarker) => void): void;
  mountedBlockRoots(): readonly HTMLElement[];
  remeasureMountedBlocks?(): void;
}

export interface MarkdownAnnotationOverlayPublishOptions {
  readonly signal?: AbortSignal;
  readonly yieldEvery?: number;
  readonly yieldToMain?: () => Promise<void>;
}

interface MountedOverlay {
  readonly root: HTMLElement;
  readonly layer: HTMLDivElement;
  readonly restoreStaticPosition: boolean;
  readonly handleClick: (event: MouseEvent) => void;
  readonly handleMove: (event: MouseEvent) => void;
  readonly handleLeave: () => void;
  fragmentCount: number;
}

/**
 * Keeps annotation truth in block-local logical coordinates and materializes
 * geometry only for block roots supplied by the viewport. It never queries or
 * measures the document canvas as a whole.
 */
export class MarkdownAnnotationOverlayController implements MarkdownAnnotationOverlayGeometrySource {
  private snapshot: MarkdownSnapshot;
  private mapper: MarkdownPositionMapper;
  private readonly mounted: MarkdownMountedBlockResolver;
  private readonly rectProvider: (range: Range, block: HTMLElement) => readonly DOMRectReadOnly[];
  private readonly reveal?: (target: MarkdownAnnotationRevealTarget) => void | Promise<void>;
  private readonly onActivate?: (annotationId: string) => void;
  private readonly onHover?: (annotationId: string | null) => void;
  private readonly variant: "annotation" | "find" | "source-reveal";
  private state: MarkdownAnnotationOverlayState;
  private markersByBlock = new Map<string, readonly MarkdownAnnotationOverlayMarker[]>();
  private markerByAnnotation = new Map<string, MarkdownAnnotationOverlayMarker>();
  private blockIdsByAnnotation = new Map<string, ReadonlySet<string>>();
  private signatures = new Map<string, string>();
  private markerInputIdentity: readonly MarkdownAnnotationOverlayMarker[] | null = null;
  private readonly mountedRoots = new Map<string, HTMLElement>();
  private readonly overlays = new Map<string, MountedOverlay>();
  private publishEpoch = 0;
  private pointerAnnotationId: string | null = null;
  private disposed = false;

  constructor(options: MarkdownAnnotationOverlayControllerOptions) {
    if (options.mapper.snapshot.revision !== options.snapshot.revision) {
      throw new Error("Annotation overlay mapper does not match Snapshot");
    }
    this.snapshot = options.snapshot;
    this.mapper = options.mapper;
    this.mounted = options.mounted;
    this.rectProvider = options.rectProvider ?? defaultRectProvider;
    this.reveal = options.reveal;
    this.onActivate = options.onActivate;
    this.onHover = options.onHover;
    this.variant = options.variant ?? "annotation";
    this.state = emptyState(options.snapshot.revision);
  }

  publish(state: MarkdownAnnotationOverlayState): MarkdownAnnotationOverlayPatchStats {
    this.assertActive();
    this.publishEpoch += 1;
    if (state.revision !== this.snapshot.revision) {
      throw new Error(`Stale annotation overlay revision ${state.revision}; current revision is ${this.snapshot.revision}`);
    }
    if (state.markers === this.markerInputIdentity
      && state.annotationSetRevision === this.state.annotationSetRevision) {
      return this.applyInteractionState({
        activeAnnotationId: state.activeAnnotationId,
        hoveredAnnotationId: state.hoveredAnnotationId,
        flashAnnotationId: state.flashAnnotationId,
      });
    }
    validateMarkers(this.snapshot, state.markers);
    const nextByBlock = groupMarkers(state.markers);
    const nextMarkerByAnnotation = firstMarkerByAnnotation(state.markers);
    const nextBlockIdsByAnnotation = blockIdsByAnnotation(state.markers);
    const nextSignatures = signaturesForState(nextByBlock, state);
    return this.commitFullState(
      state,
      nextByBlock,
      nextMarkerByAnnotation,
      nextBlockIdsByAnnotation,
      nextSignatures,
    );
  }

  async publishAsync(
    state: MarkdownAnnotationOverlayState,
    options: MarkdownAnnotationOverlayPublishOptions = {},
  ): Promise<MarkdownAnnotationOverlayPatchStats> {
    this.assertActive();
    if (state.revision !== this.snapshot.revision) {
      throw new Error(`Stale annotation overlay revision ${state.revision}; current revision is ${this.snapshot.revision}`);
    }
    if (state.markers === this.markerInputIdentity
      && state.annotationSetRevision === this.state.annotationSetRevision) {
      this.publishEpoch += 1;
      return this.applyInteractionState({
        activeAnnotationId: state.activeAnnotationId,
        hoveredAnnotationId: state.hoveredAnnotationId,
        flashAnnotationId: state.flashAnnotationId,
      });
    }
    const epoch = ++this.publishEpoch;
    const yieldEvery = positiveInteger(options.yieldEvery ?? 4_096, "yieldEvery");
    const yieldToMain = options.yieldToMain ?? defaultYieldToMain;
    const mutableByBlock = new Map<string, MarkdownAnnotationOverlayMarker[]>();
    const nextMarkerByAnnotation = new Map<string, MarkdownAnnotationOverlayMarker>();
    const mutableBlockIdsByAnnotation = new Map<string, Set<string>>();
    for (let index = 0; index < state.markers.length; index += 1) {
      const marker = state.markers[index]!;
      validateMarker(this.snapshot, marker);
      const blockMarkers = mutableByBlock.get(marker.blockId) ?? [];
      blockMarkers.push(marker);
      mutableByBlock.set(marker.blockId, blockMarkers);
      if (!nextMarkerByAnnotation.has(marker.annotationId)) nextMarkerByAnnotation.set(marker.annotationId, marker);
      const blockIds = mutableBlockIdsByAnnotation.get(marker.annotationId) ?? new Set<string>();
      blockIds.add(marker.blockId);
      mutableBlockIdsByAnnotation.set(marker.annotationId, blockIds);
      if ((index + 1) % yieldEvery === 0) {
        await yieldToMain();
        this.assertAsyncPublication(epoch, options.signal);
      }
    }
    const nextByBlock = new Map<string, readonly MarkdownAnnotationOverlayMarker[]>();
    const nextSignatures = new Map<string, string>();
    let blockCounter = 0;
    for (const [blockId, markers] of mutableByBlock) {
      markers.sort((left, right) => left.blockLocalStart - right.blockLocalStart
        || left.blockLocalEnd - right.blockLocalEnd
        || left.annotationId.localeCompare(right.annotationId));
      const frozen = Object.freeze(markers);
      nextByBlock.set(blockId, frozen);
      nextSignatures.set(blockId, signatureForBlock(frozen, state));
      blockCounter += 1;
      if (blockCounter % yieldEvery === 0) {
        await yieldToMain();
        this.assertAsyncPublication(epoch, options.signal);
      }
    }
    this.assertAsyncPublication(epoch, options.signal);
    return this.commitFullState(
      state,
      nextByBlock,
      nextMarkerByAnnotation,
      new Map([...mutableBlockIdsByAnnotation].map(([annotationId, blockIds]) => [annotationId, blockIds])),
      nextSignatures,
    );
  }

  private commitFullState(
    state: MarkdownAnnotationOverlayState,
    nextByBlock: Map<string, readonly MarkdownAnnotationOverlayMarker[]>,
    nextMarkerByAnnotation: Map<string, MarkdownAnnotationOverlayMarker>,
    nextBlockIdsByAnnotation: Map<string, ReadonlySet<string>>,
    nextSignatures: Map<string, string>,
  ): MarkdownAnnotationOverlayPatchStats {
    const changed = changedBlockIds(this.signatures, nextSignatures).sort(this.compareBlockIds);
    this.state = freezeState(state);
    this.markerInputIdentity = state.markers;
    this.markersByBlock = nextByBlock;
    this.markerByAnnotation = nextMarkerByAnnotation;
    this.blockIdsByAnnotation = nextBlockIdsByAnnotation;
    this.signatures = nextSignatures;
    let renderedBlocks = 0;
    for (const blockId of changed) {
      if (!this.mountedRoots.has(blockId)) continue;
      this.renderBlock(blockId);
      renderedBlocks += 1;
    }
    return this.stats(changed, renderedBlocks);
  }

  updateInteractionState(state: {
    readonly activeAnnotationId?: string | null;
    readonly hoveredAnnotationId?: string | null;
    readonly flashAnnotationId?: string | null;
  }): MarkdownAnnotationOverlayPatchStats {
    this.assertActive();
    this.publishEpoch += 1;
    return this.applyInteractionState(state);
  }

  private applyInteractionState(state: {
    readonly activeAnnotationId?: string | null;
    readonly hoveredAnnotationId?: string | null;
    readonly flashAnnotationId?: string | null;
  }): MarkdownAnnotationOverlayPatchStats {
    const next = {
      activeAnnotationId: state.activeAnnotationId === undefined
        ? this.state.activeAnnotationId
        : state.activeAnnotationId,
      hoveredAnnotationId: state.hoveredAnnotationId === undefined
        ? this.state.hoveredAnnotationId
        : state.hoveredAnnotationId,
      flashAnnotationId: state.flashAnnotationId === undefined
        ? this.state.flashAnnotationId
        : state.flashAnnotationId,
    };
    const changedAnnotations = new Set<string>();
    addChangedAnnotation(changedAnnotations, this.state.activeAnnotationId, next.activeAnnotationId);
    addChangedAnnotation(changedAnnotations, this.state.hoveredAnnotationId, next.hoveredAnnotationId);
    addChangedAnnotation(changedAnnotations, this.state.flashAnnotationId, next.flashAnnotationId);
    if (!changedAnnotations.size) return this.stats(EMPTY_BLOCK_IDS, 0);
    const changedBlocks = new Set<string>();
    for (const annotationId of changedAnnotations) {
      for (const blockId of this.blockIdsByAnnotation.get(annotationId) ?? EMPTY_BLOCK_IDS) {
        changedBlocks.add(blockId);
      }
    }
    this.state = freezeState({ ...this.state, ...next });
    for (const blockId of changedBlocks) {
      const markers = this.markersByBlock.get(blockId);
      if (markers) this.signatures.set(blockId, signatureForBlock(markers, this.state));
    }
    const ordered = [...changedBlocks].sort(this.compareBlockIds);
    let renderedBlocks = 0;
    for (const blockId of ordered) {
      if (!this.mountedRoots.has(blockId)) continue;
      this.renderBlock(blockId);
      renderedBlocks += 1;
    }
    return this.stats(ordered, renderedBlocks);
  }

  syncMountedBlocks(blockIds: Iterable<string>): MarkdownAnnotationOverlayPatchStats {
    this.assertActive();
    const next = new Set(blockIds);
    const changed = new Set<string>();
    for (const [blockId] of this.mountedRoots) {
      if (next.has(blockId)) continue;
      this.removeOverlay(blockId);
      this.mountedRoots.delete(blockId);
      changed.add(blockId);
    }
    for (const blockId of next) {
      const root = this.mounted.getBlockElement(blockId);
      if (!root) continue;
      const previous = this.mountedRoots.get(blockId);
      if (previous === root) continue;
      if (previous) this.removeOverlay(blockId);
      this.mountedRoots.set(blockId, root);
      changed.add(blockId);
    }
    let renderedBlocks = 0;
    for (const blockId of changed) {
      if (!this.mountedRoots.has(blockId)) continue;
      this.renderBlock(blockId);
      renderedBlocks += 1;
    }
    return this.stats([...changed].sort(this.compareBlockIds), renderedBlocks);
  }

  reconcileSnapshot(
    snapshot: MarkdownSnapshot,
    mapper: MarkdownPositionMapper,
    state: MarkdownAnnotationOverlayState = emptyState(snapshot.revision),
  ): MarkdownAnnotationOverlayPatchStats {
    this.assertActive();
    if (mapper.snapshot.revision !== snapshot.revision) {
      throw new Error("Annotation overlay mapper does not match the next Snapshot");
    }
    for (const blockId of [...this.overlays.keys()]) this.removeOverlay(blockId);
    this.mountedRoots.clear();
    this.signatures.clear();
    this.markersByBlock.clear();
    this.markerByAnnotation.clear();
    this.blockIdsByAnnotation.clear();
    this.markerInputIdentity = null;
    this.snapshot = snapshot;
    this.mapper = mapper;
    this.state = emptyState(snapshot.revision);
    return this.publish(state);
  }

  async revealAnnotation(annotationId: string): Promise<boolean> {
    this.assertActive();
    const marker = this.markerByAnnotation.get(annotationId);
    if (!marker || !this.reveal) return false;
    await this.reveal({ annotationId, blockId: marker.blockId, blockIndex: marker.blockIndex });
    return true;
  }

  markersForBlock(blockId: string): readonly MarkdownAnnotationOverlayMarker[] {
    return this.markersByBlock.get(blockId) ?? EMPTY_MARKERS;
  }

  mountedBlockIds(): readonly string[] {
    return Object.freeze([...this.mountedRoots.keys()].sort(this.compareBlockIds));
  }

  mountedBlockRoots(): readonly HTMLElement[] {
    this.assertActive();
    return Object.freeze([...this.mountedRoots.values()]);
  }

  forEachMountedMarker(visitor: (marker: MarkdownMountedAnnotationMarker) => void): void {
    this.assertActive();
    for (const [blockId, overlay] of this.overlays) {
      for (const element of overlay.layer.children) {
        if (!(element instanceof HTMLElement)) continue;
        const annotationId = element.dataset.annotationId;
        if (annotationId) visitor({ annotationId, blockId, element, block: overlay.root });
      }
    }
  }

  remeasureMountedBlocks(): void {
    this.assertActive();
    for (const [blockId, root] of this.mountedRoots) {
      if (root.dataset.markdownBlockVisible === "false") continue;
      if ((this.markersByBlock.get(blockId)?.length ?? 0) > 0) this.renderBlock(blockId);
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.publishEpoch += 1;
    this.disposed = true;
    for (const blockId of [...this.overlays.keys()]) this.removeOverlay(blockId);
    this.mountedRoots.clear();
    this.markersByBlock.clear();
    this.markerByAnnotation.clear();
    this.blockIdsByAnnotation.clear();
    this.signatures.clear();
    this.markerInputIdentity = null;
  }

  private renderBlock(blockId: string): void {
    const root = this.mountedRoots.get(blockId);
    if (!root) return;
    const markers = this.markersByBlock.get(blockId) ?? EMPTY_MARKERS;
    if (!markers.length) {
      this.removeOverlay(blockId);
      return;
    }
    const mountedOverlay = this.ensureOverlay(blockId, root);
    const fragment = root.ownerDocument.createDocumentFragment();
    const blockRect = root.getBoundingClientRect();
    let fragmentCount = 0;
    for (const marker of markers) {
      if (this.isWholeResourceBlockMarker(root, marker)) {
        if (blockRect.width > 0 && blockRect.height > 0) {
          fragment.append(this.markerElement(root.ownerDocument, marker, 0, blockRect, blockRect, true));
          fragmentCount += 1;
        }
        continue;
      }
      const start = this.mapper.blockLocal(blockId, marker.blockLocalStart);
      const end = this.mapper.blockLocal(blockId, marker.blockLocalEnd);
      if (!start.dom || !end.dom) continue;
      const range = root.ownerDocument.createRange();
      try {
        range.setStart(start.dom.node, start.dom.offset);
        range.setEnd(end.dom.node, end.dom.offset);
      } catch {
        continue;
      }
      const rects = this.rectProvider(range, root);
      rects.forEach((rect, index) => {
        if (rect.width <= 0 || rect.height <= 0) return;
        fragment.append(this.markerElement(root.ownerDocument, marker, index, rect, blockRect));
        fragmentCount += 1;
      });
    }
    mountedOverlay.layer.replaceChildren(fragment);
    mountedOverlay.fragmentCount = fragmentCount;
  }

  private ensureOverlay(blockId: string, root: HTMLElement): MountedOverlay {
    const current = this.overlays.get(blockId);
    if (current?.root === root && current.layer.isConnected) return current;
    if (current) this.removeOverlay(blockId);
    const restoreStaticPosition = root.style.position === "";
    if (restoreStaticPosition) root.style.position = "relative";
    const layer = root.ownerDocument.createElement("div");
    if (this.variant === "annotation") {
      layer.dataset.markdownAnnotationOverlay = "true";
      layer.dataset.markdownAnnotationBlockId = blockId;
    } else if (this.variant === "find") {
      layer.dataset.markdownFindOverlay = "true";
      layer.dataset.markdownFindBlockId = blockId;
    } else {
      layer.dataset.markdownSourceRevealOverlay = "true";
      layer.dataset.markdownSourceRevealBlockId = blockId;
    }
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.overflow = "visible";
    layer.style.pointerEvents = "none";
    layer.style.zIndex = "2";
    const handleClick = (event: MouseEvent) => {
      if (this.variant !== "annotation") return;
      const annotationId = this.annotationAtEvent(blockId, event);
      if (annotationId) this.onActivate?.(annotationId);
    };
    const handleMove = (event: MouseEvent) => {
      if (this.variant !== "annotation") return;
      this.commitPointerAnnotation(this.annotationAtEvent(blockId, event));
    };
    const handleLeave = () => {
      if (this.variant === "annotation") this.commitPointerAnnotation(null);
    };
    root.addEventListener("click", handleClick);
    root.addEventListener("mousemove", handleMove);
    root.addEventListener("mouseleave", handleLeave);
    root.append(layer);
    const overlay = {
      root,
      layer,
      restoreStaticPosition,
      handleClick,
      handleMove,
      handleLeave,
      fragmentCount: 0,
    };
    this.overlays.set(blockId, overlay);
    return overlay;
  }

  private markerElement(
    ownerDocument: Document,
    marker: MarkdownAnnotationOverlayMarker,
    fragmentIndex: number,
    rect: DOMRectReadOnly,
    blockRect: DOMRectReadOnly,
    resourceBlock = false,
  ): HTMLSpanElement {
    const element = ownerDocument.createElement("span");
    const active = marker.annotationId === this.state.activeAnnotationId;
    const hovered = marker.annotationId === this.state.hoveredAnnotationId;
    const flash = marker.annotationId === this.state.flashAnnotationId;
    element.className = this.variant === "annotation"
      ? "keydex-markdown-annotation-overlay-marker"
      : this.variant === "find"
        ? "keydex-markdown-find-overlay-marker"
        : "keydex-markdown-source-reveal-overlay-marker";
    if (this.variant === "annotation") {
      element.dataset.annotationId = marker.annotationId;
      element.dataset.markdownAnnotationOverlayMarker = "true";
      element.dataset.markdownAnnotationBlockId = marker.blockId;
      element.dataset.markdownAnnotationBlockLocalStart = String(marker.blockLocalStart);
      element.dataset.markdownAnnotationBlockLocalEnd = String(marker.blockLocalEnd);
      element.dataset.markdownAnnotationFragment = String(fragmentIndex);
      if (resourceBlock) element.dataset.markdownAnnotationResourceBlock = "true";
    } else if (this.variant === "find") {
      element.classList.add("findMark");
      element.dataset.filePreviewFindMatch = "true";
      element.dataset.findMatchId = marker.annotationId;
      element.dataset.markdownFindMatch = "true";
      element.dataset.markdownFindMatchId = marker.annotationId;
      element.dataset.markdownFindBlockId = marker.blockId;
      element.dataset.markdownFindBlockLocalStart = String(marker.blockLocalStart);
      element.dataset.markdownFindBlockLocalEnd = String(marker.blockLocalEnd);
      element.dataset.markdownFindFragment = String(fragmentIndex);
    } else {
      element.dataset.markdownSourceRevealMarker = "true";
      element.dataset.markdownSourceRevealBlockId = marker.blockId;
      element.dataset.markdownSourceRevealFragment = String(fragmentIndex);
    }
    element.dataset.active = active ? "true" : "false";
    element.dataset.hovered = hovered ? "true" : "false";
    element.dataset.flash = flash ? "true" : "false";
    if (flash) element.dataset.annotationNavigationFlash = "true";
    element.style.position = "absolute";
    element.style.left = `${rect.left - blockRect.left + this.mountedScrollLeft(marker.blockId)}px`;
    element.style.top = `${rect.top - blockRect.top + this.mountedScrollTop(marker.blockId)}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    element.style.borderRadius = resourceBlock ? "6px" : "3px";
    if (this.variant !== "annotation") {
      element.style.background = active
        ? "color-mix(in srgb, var(--warning, #f0a020) 58%, transparent)"
        : "color-mix(in srgb, var(--warning, #f0a020) 28%, transparent)";
      element.style.boxShadow = active
        ? "inset 0 -2px 0 color-mix(in srgb, var(--warning, #f0a020) 95%, transparent)"
        : "inset 0 -1px 0 color-mix(in srgb, var(--warning, #f0a020) 60%, transparent)";
    } else {
      element.style.background = resourceBlock
        ? active
          ? "color-mix(in srgb, var(--annotation-accent, #d4a72c) 12%, transparent)"
          : hovered
            ? "color-mix(in srgb, var(--annotation-accent, #d4a72c) 9%, transparent)"
            : "color-mix(in srgb, var(--annotation-accent, #d4a72c) 5%, transparent)"
        : active
          ? "color-mix(in srgb, var(--annotation-accent, #d4a72c) 42%, transparent)"
          : hovered
            ? "color-mix(in srgb, var(--annotation-accent, #d4a72c) 34%, transparent)"
            : "color-mix(in srgb, var(--annotation-accent, #d4a72c) 20%, transparent)";
      element.style.boxShadow = resourceBlock
        ? `inset 0 0 0 ${active ? 2 : 1}px color-mix(in srgb, var(--annotation-accent, #d4a72c) ${active ? 95 : hovered ? 82 : 68}%, transparent)`
        : active
          ? "inset 0 -2px 0 color-mix(in srgb, var(--annotation-accent, #d4a72c) 95%, transparent)"
          : "inset 0 -1px 0 color-mix(in srgb, var(--annotation-accent, #d4a72c) 68%, transparent)";
    }
    if (this.variant === "annotation" && !resourceBlock) {
      // The highlight is the interaction target. Keeping every fragment
      // pointer-transparent makes the browser show a text caret and forces
      // hit-testing through a stale caret position after a responsive reflow.
      element.style.pointerEvents = "auto";
      element.style.cursor = "pointer";
    } else {
      element.style.pointerEvents = "none";
    }
    element.style.zIndex = String(active ? 3 : hovered ? 2 : 1);
    return element;
  }

  private isWholeResourceBlockMarker(
    root: HTMLElement,
    marker: MarkdownAnnotationOverlayMarker,
  ): boolean {
    if (this.variant !== "annotation" || root.dataset.markdownMermaidBlock !== "true") return false;
    const block = this.snapshot.blocks[marker.blockIndex];
    if (!block) return false;
    return marker.blockLocalStart === 0
      && marker.blockLocalEnd === block.logical_end - block.logical_start;
  }

  private mountedScrollLeft(blockId: string): number {
    return this.mountedRoots.get(blockId)?.scrollLeft ?? 0;
  }

  private mountedScrollTop(blockId: string): number {
    return this.mountedRoots.get(blockId)?.scrollTop ?? 0;
  }

  private removeOverlay(blockId: string): void {
    const overlay = this.overlays.get(blockId);
    if (!overlay) return;
    overlay.root.removeEventListener("click", overlay.handleClick);
    overlay.root.removeEventListener("mousemove", overlay.handleMove);
    overlay.root.removeEventListener("mouseleave", overlay.handleLeave);
    overlay.layer.remove();
    if (overlay.restoreStaticPosition && overlay.root.style.position === "relative") {
      overlay.root.style.position = "";
    }
    this.overlays.delete(blockId);
  }

  private annotationAtEvent(blockId: string, event: MouseEvent): string | null {
    if (eventTargetExcludesBlockAnnotation(event.target)) return null;
    const direct = eventTargetMarker(event.target)?.dataset.annotationId;
    if (direct) return direct;
    const point = caretPointFromClient(event.currentTarget as HTMLElement, event.clientX, event.clientY);
    const mapped = point ? this.mapper.domPosition(point.node, point.offset) : null;
    const candidates = mapped?.blockId === blockId && mapped.blockLocalLogicalOffset !== null
      ? (this.markersByBlock.get(blockId) ?? EMPTY_MARKERS).filter((marker) =>
          mapped.blockLocalLogicalOffset! >= marker.blockLocalStart
          && mapped.blockLocalLogicalOffset! <= marker.blockLocalEnd)
      : (this.markersByBlock.get(blockId) ?? EMPTY_MARKERS).filter((marker) => {
          const root = this.mountedRoots.get(blockId);
          return Boolean(root) && this.isWholeResourceBlockMarker(root!, marker);
        });
    if (!candidates.length) return null;
    return [...candidates].sort((left, right) =>
      Number(right.annotationId === this.state.activeAnnotationId)
      - Number(left.annotationId === this.state.activeAnnotationId)
      || (left.blockLocalEnd - left.blockLocalStart) - (right.blockLocalEnd - right.blockLocalStart)
      || left.annotationId.localeCompare(right.annotationId))[0]!.annotationId;
  }

  private commitPointerAnnotation(annotationId: string | null): void {
    if (annotationId === this.pointerAnnotationId) return;
    this.pointerAnnotationId = annotationId;
    this.onHover?.(annotationId);
  }

  private stats(changedBlocks: readonly string[], renderedBlocks: number): MarkdownAnnotationOverlayPatchStats {
    let markerFragments = 0;
    for (const overlay of this.overlays.values()) markerFragments += overlay.fragmentCount;
    let mountedLogicalMarkers = 0;
    for (const blockId of this.mountedRoots.keys()) {
      mountedLogicalMarkers += this.markersByBlock.get(blockId)?.length ?? 0;
    }
    return Object.freeze({
      revision: this.state.revision,
      changedBlocks: Object.freeze([...changedBlocks]),
      renderedBlocks,
      mountedBlocks: this.mountedRoots.size,
      markerFragments,
      logicalMarkers: this.state.markers.length,
      unmountedMarkers: Math.max(0, this.state.markers.length - mountedLogicalMarkers),
    });
  }

  private readonly compareBlockIds = (left: string, right: string): number =>
    (this.mapper.blockIndex(left) ?? Number.MAX_SAFE_INTEGER)
    - (this.mapper.blockIndex(right) ?? Number.MAX_SAFE_INTEGER)
    || left.localeCompare(right);

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown annotation overlay is destroyed");
  }

  private assertAsyncPublication(epoch: number, signal?: AbortSignal): void {
    this.assertActive();
    if (signal?.aborted || epoch !== this.publishEpoch) {
      throw signal?.reason ?? new DOMException("Annotation overlay publication superseded", "AbortError");
    }
  }
}

export function createMarkdownAnnotationOverlayState(
  snapshot: MarkdownSnapshot,
  index: ResolvedAnnotationIndex,
  options: {
    readonly activeAnnotationId?: string | null;
    readonly hoveredAnnotationId?: string | null;
    readonly flashAnnotationId?: string | null;
  } = {},
): MarkdownAnnotationOverlayState {
  const blockIndexById = new Map(snapshot.blocks.map((block) => [block.id, block.index]));
  const markers: MarkdownAnnotationOverlayMarker[] = [];
  for (const resolution of index.resolved) {
    for (const projection of resolution.projection.blockRanges) {
      const blockIndex = blockIndexById.get(projection.blockKey);
      const block = blockIndex === undefined ? null : snapshot.blocks[blockIndex];
      if (!block) continue;
      markers.push(Object.freeze({
        annotationId: resolution.record.id,
        blockId: block.id,
        blockIndex: block.index,
        blockLocalStart: projection.range.start,
        blockLocalEnd: projection.range.end,
        logicalStart: block.logical_start + projection.range.start,
        logicalEnd: block.logical_start + projection.range.end,
      }));
    }
  }
  return freezeState({
    revision: snapshot.revision,
    annotationSetRevision: index.annotationSetRevision,
    activeAnnotationId: options.activeAnnotationId ?? null,
    hoveredAnnotationId: options.hoveredAnnotationId ?? null,
    flashAnnotationId: options.flashAnnotationId ?? null,
    markers,
  });
}

function validateMarkers(snapshot: MarkdownSnapshot, markers: readonly MarkdownAnnotationOverlayMarker[]): void {
  for (const marker of markers) {
    validateMarker(snapshot, marker);
  }
}

function validateMarker(snapshot: MarkdownSnapshot, marker: MarkdownAnnotationOverlayMarker): void {
  const block = snapshot.blocks[marker.blockIndex];
  const length = block ? block.logical_end - block.logical_start : -1;
  if (!block || block.id !== marker.blockId
    || !Number.isSafeInteger(marker.blockLocalStart)
    || !Number.isSafeInteger(marker.blockLocalEnd)
    || marker.blockLocalStart < 0
    || marker.blockLocalEnd <= marker.blockLocalStart
    || marker.blockLocalEnd > length
    || marker.logicalStart !== block.logical_start + marker.blockLocalStart
    || marker.logicalEnd !== block.logical_start + marker.blockLocalEnd) {
    throw new Error(`Invalid annotation overlay marker ${marker.annotationId} for block ${marker.blockId}`);
  }
}

function groupMarkers(
  markers: readonly MarkdownAnnotationOverlayMarker[],
): Map<string, readonly MarkdownAnnotationOverlayMarker[]> {
  const mutable = new Map<string, MarkdownAnnotationOverlayMarker[]>();
  for (const marker of markers) {
    const values = mutable.get(marker.blockId) ?? [];
    values.push(marker);
    mutable.set(marker.blockId, values);
  }
  return new Map([...mutable].map(([blockId, values]) => [blockId, Object.freeze(values.sort((left, right) =>
    left.blockLocalStart - right.blockLocalStart
    || left.blockLocalEnd - right.blockLocalEnd
    || left.annotationId.localeCompare(right.annotationId)))]));
}

function firstMarkerByAnnotation(
  markers: readonly MarkdownAnnotationOverlayMarker[],
): Map<string, MarkdownAnnotationOverlayMarker> {
  const values = new Map<string, MarkdownAnnotationOverlayMarker>();
  for (const marker of markers) if (!values.has(marker.annotationId)) values.set(marker.annotationId, marker);
  return values;
}

function blockIdsByAnnotation(
  markers: readonly MarkdownAnnotationOverlayMarker[],
): Map<string, ReadonlySet<string>> {
  const mutable = new Map<string, Set<string>>();
  for (const marker of markers) {
    const blockIds = mutable.get(marker.annotationId) ?? new Set<string>();
    blockIds.add(marker.blockId);
    mutable.set(marker.annotationId, blockIds);
  }
  return new Map([...mutable].map(([annotationId, blockIds]) => [annotationId, blockIds]));
}

function signaturesForState(
  markersByBlock: ReadonlyMap<string, readonly MarkdownAnnotationOverlayMarker[]>,
  state: MarkdownAnnotationOverlayState,
): Map<string, string> {
  return new Map([...markersByBlock].map(([blockId, markers]) => [blockId, signatureForBlock(markers, state)]));
}

function signatureForBlock(
  markers: readonly MarkdownAnnotationOverlayMarker[],
  state: MarkdownAnnotationOverlayState,
): string {
  return markers.map((marker) => [
    marker.annotationId,
    marker.blockLocalStart,
    marker.blockLocalEnd,
    marker.annotationId === state.activeAnnotationId ? 1 : 0,
    marker.annotationId === state.hoveredAnnotationId ? 1 : 0,
    marker.annotationId === state.flashAnnotationId ? 1 : 0,
  ].join(":" )).join("|");
}

function changedBlockIds(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
  const changed = new Set<string>();
  for (const [blockId, signature] of previous) if (next.get(blockId) !== signature) changed.add(blockId);
  for (const [blockId, signature] of next) if (previous.get(blockId) !== signature) changed.add(blockId);
  return [...changed];
}

function freezeState(state: MarkdownAnnotationOverlayState): MarkdownAnnotationOverlayState {
  return Object.freeze({
    ...state,
    markers: Object.freeze([...state.markers]),
  });
}

function emptyState(revision: string): MarkdownAnnotationOverlayState {
  return Object.freeze({
    revision,
    annotationSetRevision: "empty",
    activeAnnotationId: null,
    hoveredAnnotationId: null,
    flashAnnotationId: null,
    markers: EMPTY_MARKERS,
  });
}

function defaultRectProvider(range: Range): readonly DOMRectReadOnly[] {
  const rects = typeof range.getClientRects === "function" ? [...range.getClientRects()] : [];
  if (rects.length) return rects;
  const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  return rect && rect.width > 0 && rect.height > 0 ? [rect] : [];
}

function eventTargetMarker(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-markdown-annotation-overlay-marker]")
    : null;
}

function eventTargetExcludesBlockAnnotation(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("[data-markdown-selection-exclude='true']") !== null;
}

function caretPointFromClient(
  root: HTMLElement,
  clientX: number,
  clientY: number,
): { node: Node; offset: number } | null {
  const ownerDocument = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = ownerDocument.caretPositionFromPoint?.(clientX, clientY);
  if (position && root.contains(position.offsetNode)) {
    return { node: position.offsetNode, offset: position.offset };
  }
  const range = ownerDocument.caretRangeFromPoint?.(clientX, clientY);
  return range && root.contains(range.startContainer)
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

function addChangedAnnotation(target: Set<string>, previous: string | null, next: string | null): void {
  if (previous === next) return;
  if (previous) target.add(previous);
  if (next) target.add(next);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function defaultYieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const EMPTY_MARKERS: readonly MarkdownAnnotationOverlayMarker[] = Object.freeze([]);
const EMPTY_BLOCK_IDS: readonly string[] = Object.freeze([]);
