import { AnnotationGeometryScheduler } from "@/renderer/features/annotations/adapters/AnnotationGeometryScheduler";
import type {
  AnnotationViewGeometrySnapshot,
  DocumentCoordinateRect,
} from "@/renderer/features/annotations/navigation/types";

import type { MarkdownAnnotationOverlayGeometrySource } from "./MarkdownAnnotationOverlayController";

export type MarkdownAnnotationGeometryReason =
  | "panel-open"
  | "tracked-annotations"
  | "mounted-blocks"
  | "scroll"
  | "resize"
  | "zoom"
  | "resource-reflow"
  | "navigation";

export interface MarkdownAnnotationGeometryFrameScheduler {
  request(): void;
  cancel(): void;
}

export interface MarkdownAnnotationGeometryControllerOptions {
  readonly overlay: MarkdownAnnotationOverlayGeometrySource;
  readonly scrollElement: HTMLElement;
  readonly documentElement: HTMLElement;
  readonly onGeometry: (snapshot: AnnotationViewGeometrySnapshot) => void;
  readonly schedulerFactory?: (flush: () => void) => MarkdownAnnotationGeometryFrameScheduler;
  readonly resizeObserverFactory?: ((callback: ResizeObserverCallback) => Pick<ResizeObserver, "observe" | "unobserve" | "disconnect">) | null;
}

export interface MarkdownAnnotationGeometryDiagnostics {
  readonly enabled: boolean;
  readonly flushCount: number;
  readonly markerRectReads: number;
  readonly lastFlushRectReads: number;
  readonly trackedAnnotations: number;
  readonly pendingReasons: readonly MarkdownAnnotationGeometryReason[];
  readonly revision: number;
}

/**
 * Batches geometry reads for mounted, visible annotation fragments. Closing the
 * rail cancels the frame and guarantees zero rect reads until it is opened.
 */
export class MarkdownAnnotationGeometryController {
  private readonly overlay: MarkdownAnnotationOverlayGeometrySource;
  private readonly scrollElement: HTMLElement;
  private readonly documentElement: HTMLElement;
  private readonly onGeometry: (snapshot: AnnotationViewGeometrySnapshot) => void;
  private readonly scheduler: MarkdownAnnotationGeometryFrameScheduler;
  private readonly resizeObserver: Pick<ResizeObserver, "observe" | "unobserve" | "disconnect"> | null;
  private readonly observedBlockRoots = new Set<HTMLElement>();
  private readonly pendingReasons = new Set<MarkdownAnnotationGeometryReason>();
  private trackedAnnotationIds: ReadonlySet<string> = EMPTY_IDS;
  private enabled = false;
  private disposed = false;
  private revision = 0;
  private flushCount = 0;
  private markerRectReads = 0;
  private lastFlushRectReads = 0;
  private lastSnapshot: AnnotationViewGeometrySnapshot | null = null;
  private overlayRemeasurePending = false;

  constructor(options: MarkdownAnnotationGeometryControllerOptions) {
    this.overlay = options.overlay;
    this.scrollElement = options.scrollElement;
    this.documentElement = options.documentElement;
    this.onGeometry = options.onGeometry;
    this.scheduler = options.schedulerFactory?.(() => this.flush())
      ?? new AnnotationGeometryScheduler(() => this.flush());
    const factory = options.resizeObserverFactory === undefined
      ? typeof ResizeObserver === "undefined"
        ? null
        : (callback: ResizeObserverCallback) => new ResizeObserver(callback)
      : options.resizeObserverFactory;
    this.resizeObserver = factory?.(() => this.handleLayoutChange("resize")) ?? null;
    this.resizeObserver?.observe(this.scrollElement);
    if (this.documentElement !== this.scrollElement) this.resizeObserver?.observe(this.documentElement);
    this.syncObservedBlockRoots();
    this.scrollElement.addEventListener("scroll", this.handleScroll, { passive: true });
  }

  setPanelOpen(open: boolean): void {
    this.assertActive();
    if (this.enabled === open) return;
    this.enabled = open;
    if (!open) {
      this.scheduler.cancel();
      this.pendingReasons.clear();
      this.overlayRemeasurePending = false;
      this.lastFlushRectReads = 0;
      return;
    }
    this.request("panel-open");
  }

  setTrackedAnnotationIds(annotationIds: Iterable<string>): void {
    this.assertActive();
    const next = new Set<string>();
    for (const annotationId of annotationIds) {
      const normalized = annotationId.trim();
      if (normalized) next.add(normalized);
    }
    if (sameSet(next, this.trackedAnnotationIds)) return;
    this.trackedAnnotationIds = next;
    this.request("tracked-annotations");
  }

  notifyMountedBlocksChanged(): void {
    this.syncObservedBlockRoots();
    this.request("mounted-blocks");
  }

  notifyZoomChanged(): void {
    this.handleLayoutChange("zoom");
  }

  notifyResourceReflow(): void {
    this.handleLayoutChange("resource-reflow");
  }

  notifyNavigationSettled(): void {
    this.request("navigation");
  }

  request(reason: MarkdownAnnotationGeometryReason): void {
    this.assertActive();
    if (!this.enabled) return;
    this.pendingReasons.add(reason);
    this.scheduler.request();
  }

  current(): AnnotationViewGeometrySnapshot | null {
    return this.lastSnapshot;
  }

  diagnostics(): MarkdownAnnotationGeometryDiagnostics {
    return Object.freeze({
      enabled: this.enabled,
      flushCount: this.flushCount,
      markerRectReads: this.markerRectReads,
      lastFlushRectReads: this.lastFlushRectReads,
      trackedAnnotations: this.trackedAnnotationIds.size,
      pendingReasons: Object.freeze([...this.pendingReasons]),
      revision: this.revision,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.cancel();
    this.pendingReasons.clear();
    this.overlayRemeasurePending = false;
    this.resizeObserver?.disconnect();
    this.observedBlockRoots.clear();
    this.scrollElement.removeEventListener("scroll", this.handleScroll);
    this.trackedAnnotationIds = EMPTY_IDS;
    this.lastSnapshot = null;
  }

  private readonly handleScroll = () => this.request("scroll");

  private handleLayoutChange(reason: "resize" | "zoom" | "resource-reflow"): void {
    this.assertActive();
    if (!this.enabled) return;
    this.overlayRemeasurePending = true;
    this.request(reason);
  }

  private syncObservedBlockRoots(): void {
    if (!this.resizeObserver) return;
    const next = new Set(this.overlay.mountedBlockRoots());
    for (const root of this.observedBlockRoots) {
      if (next.has(root)) continue;
      this.resizeObserver.unobserve(root);
      this.observedBlockRoots.delete(root);
    }
    for (const root of next) {
      if (this.observedBlockRoots.has(root)) continue;
      this.resizeObserver.observe(root);
      this.observedBlockRoots.add(root);
    }
  }

  private flush(): void {
    if (!this.enabled || this.disposed) return;
    this.pendingReasons.clear();
    if (this.overlayRemeasurePending) {
      this.overlayRemeasurePending = false;
      this.overlay.remeasureMountedBlocks?.();
    }
    const scrollRect = this.scrollElement.getBoundingClientRect();
    const documentRect = this.documentElement.getBoundingClientRect();
    const markers: Record<string, DocumentCoordinateRect[]> = {};
    for (const annotationId of this.trackedAnnotationIds) markers[annotationId] = [];
    let reads = 0;
    this.overlay.forEachMountedMarker(({ annotationId, block, element }) => {
      if (!this.trackedAnnotationIds.has(annotationId)) return;
      if (block.dataset.markdownBlockVisible === "false") return;
      const rect = element.getBoundingClientRect();
      reads += 1;
      if (!intersectsViewport(rect, scrollRect)) return;
      markers[annotationId]!.push(Object.freeze({
        top: Math.max(0, rect.top - scrollRect.top + this.scrollElement.scrollTop),
        bottom: Math.max(0, rect.bottom - scrollRect.top + this.scrollElement.scrollTop),
        left: Math.max(0, rect.left - scrollRect.left + this.scrollElement.scrollLeft),
        right: Math.max(0, rect.right - scrollRect.left + this.scrollElement.scrollLeft),
      }));
    });
    this.lastFlushRectReads = reads;
    this.markerRectReads += reads;
    this.flushCount += 1;
    this.revision += 1;
    const frozenMarkers: Record<string, readonly DocumentCoordinateRect[]> = {};
    for (const [annotationId, fragments] of Object.entries(markers)) {
      frozenMarkers[annotationId] = Object.freeze(fragments.sort(compareRects));
    }
    const snapshot: AnnotationViewGeometrySnapshot = Object.freeze({
      documentHeight: Math.max(
        this.documentElement.scrollHeight,
        documentRect.height,
        this.scrollElement.scrollHeight,
      ),
      markers: Object.freeze(frozenMarkers),
      revision: this.revision,
      scrollOffset: this.scrollElement.scrollTop,
      viewportHeight: this.scrollElement.clientHeight || scrollRect.height,
      viewportWidth: this.scrollElement.clientWidth || scrollRect.width,
    });
    this.lastSnapshot = snapshot;
    this.onGeometry(snapshot);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown annotation geometry controller is destroyed");
  }
}

function intersectsViewport(rect: DOMRectReadOnly, viewport: DOMRectReadOnly): boolean {
  return rect.bottom >= viewport.top
    && rect.top <= viewport.bottom
    && rect.right >= viewport.left
    && rect.left <= viewport.right;
}

function compareRects(left: DocumentCoordinateRect, right: DocumentCoordinateRect): number {
  return left.top - right.top || left.left - right.left || left.bottom - right.bottom || left.right - right.right;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
