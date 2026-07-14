import type { MarkdownBlock } from "@/renderer/markdownShared/types";

import type { DocumentSelection, SourceRange } from "../document/DocumentTextModel";
import type {
  AnnotationRenderState,
  AnnotationRevealRequest,
  AnnotationViewAdapter,
  AnnotationViewEvent,
  AnnotationViewGeometrySnapshot,
  DocumentCoordinateRect,
} from "../navigation/types";
import { AnnotationGeometryScheduler } from "./AnnotationGeometryScheduler";
import {
  restartAnnotationNavigationFlash,
  smoothScrollElementTo,
} from "../navigation/AnnotationNavigationEffects";

export interface MarkdownAnnotationMarkerRange {
  readonly active: boolean;
  readonly annotationId: string;
  readonly blockKey: string;
  readonly blockLocalEnd: number;
  readonly blockLocalStart: number;
  readonly flash: boolean;
  readonly logicalEnd: number;
  readonly logicalStart: number;
  readonly sourceEnd: number;
  readonly sourceStart: number;
}

export interface MarkdownAnnotationBinding {
  readonly blocks: readonly Pick<MarkdownBlock, "id" | "sourceEnd" | "sourceStart">[];
  readonly blocksForSourceRange?: (
    range: SourceRange,
  ) => readonly Pick<MarkdownBlock, "id" | "sourceEnd" | "sourceStart">[];
  readonly root: HTMLElement;
  readonly scrollElement: HTMLElement;
  revealBlock(blockKey: string, signal: AbortSignal): Promise<void>;
}

export class MarkdownAnnotationAdapter implements AnnotationViewAdapter {
  readonly id = "markdown" as const;
  private readonly listeners = new Set<(event: AnnotationViewEvent) => void>();
  private readonly readyWaiters = new Set<{ reject(reason: unknown): void; resolve(): void }>();
  private binding: MarkdownAnnotationBinding | null = null;
  private cleanupBinding: (() => void) | null = null;
  private renderState: AnnotationRenderState = EMPTY_RENDER_STATE;
  private markersByBlock = new Map<string, readonly MarkdownAnnotationMarkerRange[]>();
  private currentSelection: DocumentSelection | null = null;
  private geometryRevision = 0;
  private geometryEnabled = false;
  private disposed = false;
  private readonly geometryScheduler = new AnnotationGeometryScheduler(() => this.emitGeometryNow());

  attach(binding: MarkdownAnnotationBinding): () => void {
    if (this.disposed) {
      throw new Error("Markdown annotation adapter is disposed");
    }
    this.cleanupBinding?.();
    this.binding = binding;
    this.rebuildMarkers();
    const handleMarkerHover = (event: MouseEvent) => {
      const annotationId = markerHoverTransition(event);
      if (annotationId !== undefined) {
        this.applyHoveredState(annotationId);
        this.emit({ type: "marker-hover", annotationId });
      }
    };
    binding.root.addEventListener("mouseout", handleMarkerHover);
    binding.root.addEventListener("mouseover", handleMarkerHover);
    this.applyHoveredState(this.renderState.hoveredAnnotationId);
    const requestGeometry = () => this.requestGeometryMeasure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(requestGeometry);
    resizeObserver?.observe(binding.root);
    resizeObserver?.observe(binding.scrollElement);
    for (const waiter of this.readyWaiters) {
      waiter.resolve();
    }
    this.readyWaiters.clear();
    this.requestGeometryMeasure();
    const cleanup = () => {
      binding.root.removeEventListener("mouseout", handleMarkerHover);
      binding.root.removeEventListener("mouseover", handleMarkerHover);
      resizeObserver?.disconnect();
      if (this.binding === binding) {
        this.geometryScheduler.cancel();
        this.binding = null;
        this.markersByBlock.clear();
      }
      if (this.cleanupBinding === cleanup) {
        this.cleanupBinding = null;
      }
    };
    this.cleanupBinding = cleanup;
    return cleanup;
  }

  isReady(): boolean {
    return this.binding !== null;
  }

  flashMarker(annotationId: string): void {
    const root = this.binding?.root;
    if (!root) {
      return;
    }
    for (const marker of root.querySelectorAll<HTMLElement>("[data-annotation-id]")) {
      if (marker.dataset.annotationId === annotationId) {
        restartAnnotationNavigationFlash(marker);
      }
    }
  }

  whenReady(signal: AbortSignal): Promise<void> {
    if (this.binding) {
      return Promise.resolve();
    }
    if (signal.aborted) {
      return Promise.reject(abortError("Markdown annotation view readiness aborted"));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (reason: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      const onAbort = () => {
        this.readyWaiters.delete(waiter);
        reject(abortError("Markdown annotation view readiness aborted"));
      };
      this.readyWaiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  render(state: AnnotationRenderState): void {
    const geometryChanged = this.renderState.revision !== state.revision || this.renderState.markers !== state.markers;
    this.renderState = state;
    this.rebuildMarkers();
    this.applyHoveredState(state.hoveredAnnotationId);
    if (geometryChanged) {
      this.requestGeometryMeasure();
    }
  }

  setGeometryEnabled(enabled: boolean): void {
    if (this.geometryEnabled === enabled) {
      return;
    }
    this.geometryEnabled = enabled;
    if (enabled) {
      this.requestGeometryMeasure();
    } else {
      this.geometryScheduler.cancel();
    }
  }

  notifyMountedBlocksChanged(): void {
    this.applyHoveredState(this.renderState.hoveredAnnotationId);
    this.requestGeometryMeasure();
  }

  rangesForBlock(blockKey: string): readonly MarkdownAnnotationMarkerRange[] {
    return this.markersByBlock.get(blockKey) ?? Object.freeze([]);
  }

  updateSelection(selection: DocumentSelection | null): void {
    this.currentSelection = selection;
    this.emit({ type: "selection", selection });
  }

  activateMarker(annotationId: string): void {
    this.emit({ type: "marker-activate", annotationId });
  }

  selection(): DocumentSelection | null {
    return this.currentSelection;
  }

  async reveal(request: AnnotationRevealRequest): Promise<void> {
    if (request.signal.aborted) {
      throw abortError("Markdown annotation reveal aborted");
    }
    const binding = this.binding;
    const sourceRange = encompassingSourceRange(request.sourceRanges);
    const block = binding && sourceRange
      ? centeredBlockForSourceRange(binding, sourceRange)
      : null;
    if (!binding || !block) {
      throw new Error("Markdown annotation target is unavailable");
    }
    if (!request.scroll) {
      return;
    }
    const mountedTarget = mountedAnnotationCenterScrollTop(binding, request.annotationId);
    if (mountedTarget !== null) {
      await smoothScrollElementTo(binding.scrollElement, mountedTarget, request.signal);
      return;
    }
    await binding.revealBlock(block.id, request.signal);
    if (request.signal.aborted) {
      throw abortError("Markdown annotation reveal aborted");
    }
    const refinedTarget = mountedAnnotationCenterScrollTop(binding, request.annotationId);
    if (refinedTarget !== null) {
      binding.scrollElement.scrollTo({ behavior: "auto", top: refinedTarget });
    }
  }

  geometry(): AnnotationViewGeometrySnapshot {
    const binding = this.binding;
    if (!binding) {
      return emptyGeometry(this.geometryRevision);
    }
    const scrollRect = binding.scrollElement.getBoundingClientRect();
    const rootRect = binding.root.getBoundingClientRect();
    const mutableMarkers: Record<string, DocumentCoordinateRect[]> = {};
    for (const marker of this.renderState.markers) {
      mutableMarkers[marker.annotationId] = [];
    }
    for (const element of binding.root.querySelectorAll<HTMLElement>("[data-annotation-id]")) {
      const annotationId = element.dataset.annotationId;
      const fragments = annotationId ? mutableMarkers[annotationId] : null;
      if (!fragments) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      fragments.push(Object.freeze({
        bottom: rect.bottom - scrollRect.top + binding.scrollElement.scrollTop,
        left: rect.left - scrollRect.left + binding.scrollElement.scrollLeft,
        right: rect.right - scrollRect.left + binding.scrollElement.scrollLeft,
        top: rect.top - scrollRect.top + binding.scrollElement.scrollTop,
      }));
    }
    const markers: Record<string, readonly DocumentCoordinateRect[]> = {};
    for (const [annotationId, fragments] of Object.entries(mutableMarkers)) {
      markers[annotationId] = Object.freeze(fragments);
    }
    return Object.freeze({
      documentHeight: Math.max(binding.root.scrollHeight, rootRect.height),
      markers: Object.freeze(markers),
      revision: this.geometryRevision,
      scrollOffset: binding.scrollElement.scrollTop,
      viewportHeight: binding.scrollElement.clientHeight,
      viewportWidth: binding.scrollElement.clientWidth,
    });
  }

  subscribe(listener: (event: AnnotationViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.geometryScheduler.cancel();
    this.cleanupBinding?.();
    for (const waiter of this.readyWaiters) {
      waiter.reject(abortError("Markdown annotation adapter disposed"));
    }
    this.readyWaiters.clear();
    this.listeners.clear();
  }

  private rebuildMarkers(): void {
    const binding = this.binding;
    const markersByBlock = new Map<string, MarkdownAnnotationMarkerRange[]>();
    if (!binding) {
      this.markersByBlock = markersByBlock;
      return;
    }
    for (const marker of this.renderState.markers) {
      for (const sourceRange of marker.sourceRanges) {
        for (const block of blocksForSourceRange(binding, sourceRange)) {
          const overlap = overlapRange(sourceRange, block);
          if (!overlap) {
            continue;
          }
          const ranges = markersByBlock.get(block.id) ?? [];
          ranges.push(Object.freeze({
            active: marker.annotationId === this.renderState.activeAnnotationId,
            annotationId: marker.annotationId,
            blockKey: block.id,
            blockLocalEnd: overlap.end - block.sourceStart,
            blockLocalStart: overlap.start - block.sourceStart,
            flash: marker.annotationId === this.renderState.flashAnnotationId,
            logicalEnd: marker.logicalRange.end,
            logicalStart: marker.logicalRange.start,
            sourceEnd: overlap.end,
            sourceStart: overlap.start,
          }));
          markersByBlock.set(block.id, ranges);
        }
      }
    }
    for (const [blockKey, ranges] of markersByBlock) {
      markersByBlock.set(blockKey, Object.freeze(ranges.sort((left, right) =>
        left.blockLocalStart - right.blockLocalStart || left.blockLocalEnd - right.blockLocalEnd)) as MarkdownAnnotationMarkerRange[]);
    }
    this.markersByBlock = markersByBlock;
  }

  private requestGeometryMeasure(): void {
    if (!this.binding || !this.geometryEnabled) {
      return;
    }
    this.geometryScheduler.request();
  }

  private applyHoveredState(annotationId: string | null): void {
    const root = this.binding?.root;
    if (!root) {
      return;
    }
    for (const marker of root.querySelectorAll<HTMLElement>("[data-annotation-id]")) {
      marker.dataset.hovered = marker.dataset.annotationId === annotationId ? "true" : "false";
    }
  }

  private emitGeometryNow(): void {
    if (!this.binding || !this.geometryEnabled) {
      return;
    }
    this.geometryRevision += 1;
    this.emit({ type: "geometry", snapshot: this.geometry() });
  }

  private emit(event: AnnotationViewEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function mountedAnnotationCenterScrollTop(
  binding: MarkdownAnnotationBinding,
  annotationId: string,
): number | null {
  const markers = Array.from(
    binding.root.querySelectorAll<HTMLElement>("[data-annotation-id]"),
  ).filter((element) => element.dataset.annotationId === annotationId);
  if (!markers.length) return null;
  const scroll = binding.scrollElement;
  const viewportRect = scroll.getBoundingClientRect();
  const markerRects = markers.map((marker) => marker.getBoundingClientRect())
    .filter((rect) => rect.width > 0 || rect.height > 0);
  if (!markerRects.length) return null;
  const markerDocumentTop = scroll.scrollTop
    + Math.min(...markerRects.map((rect) => rect.top))
    - viewportRect.top;
  const markerDocumentBottom = scroll.scrollTop
    + Math.max(...markerRects.map((rect) => rect.bottom))
    - viewportRect.top;
  const target = (markerDocumentTop + markerDocumentBottom) / 2 - scroll.clientHeight / 2;
  const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  return Math.max(0, Math.min(target, maxScrollTop));
}

function encompassingSourceRange(ranges: readonly SourceRange[]): SourceRange | null {
  if (!ranges.length) return null;
  return ranges.reduce<SourceRange>((result, range) => ({
    start: Math.min(result.start, range.start),
    end: Math.max(result.end, range.end),
  }), ranges[0]!);
}

function centeredBlockForSourceRange(
  binding: MarkdownAnnotationBinding,
  range: SourceRange,
): Pick<MarkdownBlock, "id" | "sourceEnd" | "sourceStart"> | null {
  const center = (range.start + range.end) / 2;
  const candidates = [...blocksForSourceRange(binding, range)];
  candidates.sort((left, right) => {
    const leftContains = center >= left.sourceStart && center < left.sourceEnd;
    const rightContains = center >= right.sourceStart && center < right.sourceEnd;
    return Number(rightContains) - Number(leftContains)
      || distanceToSourceBlockCenter(left, center) - distanceToSourceBlockCenter(right, center)
      || left.sourceStart - right.sourceStart
      || left.id.localeCompare(right.id);
  });
  return candidates[0] ?? null;
}

function distanceToSourceBlockCenter(
  block: Pick<MarkdownBlock, "sourceEnd" | "sourceStart">,
  position: number,
): number {
  return Math.abs((block.sourceStart + block.sourceEnd) / 2 - position);
}

function blocksForSourceRange(
  binding: MarkdownAnnotationBinding,
  range: SourceRange,
): readonly Pick<MarkdownBlock, "id" | "sourceEnd" | "sourceStart">[] {
  return binding.blocksForSourceRange?.(range)
    ?? binding.blocks.filter((block) => overlapRange(range, block));
}

function overlapRange(
  range: SourceRange,
  block: Pick<MarkdownBlock, "sourceEnd" | "sourceStart">,
): SourceRange | null {
  const start = Math.max(range.start, block.sourceStart);
  const end = Math.min(range.end, block.sourceEnd);
  return end > start ? { start, end } : null;
}

function emptyGeometry(revision: number): AnnotationViewGeometrySnapshot {
  return Object.freeze({
    documentHeight: 0,
    markers: Object.freeze({}),
    revision,
    scrollOffset: 0,
    viewportHeight: 0,
    viewportWidth: 0,
  });
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

const EMPTY_RENDER_STATE: AnnotationRenderState = Object.freeze({
  activeAnnotationId: null,
  flashAnnotationId: null,
  flashToken: 0,
  hoveredAnnotationId: null,
  markers: Object.freeze([]),
  revision: "empty",
});

function markerHoverTransition(event: MouseEvent): string | null | undefined {
  const current = annotationIdFromTarget(event.target);
  const related = annotationIdFromTarget(event.relatedTarget);
  return current === related ? undefined : event.type === "mouseover" ? current : related;
}

function annotationIdFromTarget(target: EventTarget | null): string | null {
  const marker = target instanceof Element ? target.closest<HTMLElement>("[data-annotation-id]") : null;
  return marker?.dataset.annotationId ?? null;
}
