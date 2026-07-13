import { describe, expect, it, vi } from "vitest";

import {
  MarkdownAnnotationGeometryController,
  type MarkdownAnnotationGeometryFrameScheduler,
  type MarkdownAnnotationOverlayGeometrySource,
  type MarkdownMountedAnnotationMarker,
} from "@/renderer/markdownRuntime/annotations";
import { connectorGeometry } from "@/renderer/features/annotations/layout/ConnectorGeometry";
import {
  markerAnchorPoint,
  normalizeDocumentGeometry,
} from "@/renderer/features/annotations/layout/DocumentGeometry";
import { layoutAnnotationLane } from "@/renderer/features/annotations/layout/AnnotationLaneLayout";

describe("MarkdownAnnotationGeometryController", () => {
  it("performs zero geometry reads while the annotation panel is closed", () => {
    const harness = setupGeometry([
      marker("ann", "block-1", rect(10, 20, 50, 16)),
    ]);
    harness.controller.setTrackedAnnotationIds(["ann"]);
    harness.scroll.dispatchEvent(new Event("scroll"));
    harness.controller.notifyMountedBlocksChanged();
    harness.controller.notifyZoomChanged();
    harness.controller.notifyResourceReflow();
    harness.controller.notifyNavigationSettled();

    expect(harness.scheduler.requests).toBe(0);
    expect(harness.flush()).toBe(false);
    expect(harness.markers[0].getBoundingClientRect).not.toHaveBeenCalled();
    expect(harness.onGeometry).not.toHaveBeenCalled();
    expect(harness.controller.diagnostics()).toMatchObject({ enabled: false, markerRectReads: 0, flushCount: 0 });
    harness.destroy();
  });

  it("batches panel open, scroll, resize, zoom, resource, and navigation into one frame", () => {
    const harness = setupGeometry([
      marker("visible", "block-visible", rect(10, 20, 50, 16)),
      marker("visible", "block-visible", rect(12, 42, 30, 16)),
      marker("offscreen", "block-offscreen", rect(10, 140, 40, 16)),
      marker("overscan", "block-overscan", rect(10, 30, 40, 16), false),
    ]);
    harness.controller.setTrackedAnnotationIds(["visible", "offscreen", "overscan", "orphan"]);
    harness.controller.setPanelOpen(true);
    harness.scroll.dispatchEvent(new Event("scroll"));
    harness.resize();
    harness.controller.notifyZoomChanged();
    harness.controller.notifyResourceReflow();
    harness.controller.notifyNavigationSettled();

    expect(harness.scheduler.requests).toBe(1);
    expect(harness.controller.diagnostics().pendingReasons).toEqual(expect.arrayContaining([
      "panel-open", "scroll", "resize", "zoom", "resource-reflow", "navigation",
    ]));
    expect(harness.flush()).toBe(true);

    expect(harness.onGeometry).toHaveBeenCalledTimes(1);
    const snapshot = harness.onGeometry.mock.calls[0][0];
    expect(snapshot).toMatchObject({
      revision: 1,
      documentHeight: 1000,
      scrollOffset: 50,
      viewportHeight: 100,
      viewportWidth: 200,
    });
    expect(snapshot.markers.visible).toEqual([
      { left: 10, right: 60, top: 70, bottom: 86 },
      { left: 12, right: 42, top: 92, bottom: 108 },
    ]);
    expect(snapshot.markers.offscreen).toEqual([]);
    expect(snapshot.markers.overscan).toEqual([]);
    expect(snapshot.markers.orphan).toEqual([]);
    expect(harness.markers[3].getBoundingClientRect).not.toHaveBeenCalled();
    expect(harness.controller.diagnostics()).toMatchObject({ flushCount: 1, lastFlushRectReads: 3 });
    harness.destroy();
  });

  it("cancels a pending frame on panel close and stays read-free during later scroll", () => {
    const harness = setupGeometry([marker("ann", "block", rect(10, 20, 50, 16))]);
    harness.controller.setTrackedAnnotationIds(["ann"]);
    harness.controller.setPanelOpen(true);
    expect(harness.scheduler.pending).toBe(true);

    harness.controller.setPanelOpen(false);
    harness.scroll.dispatchEvent(new Event("scroll"));

    expect(harness.scheduler.cancels).toBe(1);
    expect(harness.flush()).toBe(false);
    expect(harness.markers[0].getBoundingClientRect).not.toHaveBeenCalled();
    harness.destroy();
  });

  it("re-measures a resource/Mermaid reflow atomically and replaces stale geometry", () => {
    const item = marker("ann", "resource-block", rect(10, 20, 50, 16));
    const harness = setupGeometry([item]);
    harness.controller.setTrackedAnnotationIds(["ann"]);
    harness.controller.setPanelOpen(true);
    harness.flush();
    item.getBoundingClientRect.mockReturnValue(rect(10, 70, 50, 24));

    harness.controller.notifyResourceReflow();
    harness.controller.notifyMountedBlocksChanged();
    harness.resize();
    harness.flush();

    expect(harness.onGeometry).toHaveBeenCalledTimes(2);
    expect(harness.onGeometry.mock.calls[1][0]).toMatchObject({
      revision: 2,
      markers: { ann: [{ left: 10, right: 60, top: 120, bottom: 144 }] },
    });
    expect(harness.controller.current()?.revision).toBe(2);
    harness.destroy();
  });

  it("drops geometry after a target unmount and preserves orphan entries", () => {
    const source = new MutableGeometrySource([
      marker("ann", "block", rect(10, 20, 50, 16)).entry,
    ]);
    const harness = setupGeometry([], { source });
    harness.controller.setTrackedAnnotationIds(["ann", "orphan"]);
    harness.controller.setPanelOpen(true);
    harness.flush();
    expect(harness.controller.current()?.markers.ann).toHaveLength(1);

    source.entries = [];
    harness.controller.notifyMountedBlocksChanged();
    harness.flush();

    expect(harness.controller.current()?.markers).toEqual({ ann: [], orphan: [] });
    expect(harness.resizeObserver.unobserve).toHaveBeenCalledTimes(1);
    harness.destroy();
  });

  it("coalesces rapid navigation and scroll into the latest single snapshot", () => {
    const harness = setupGeometry([marker("ann", "block", rect(10, 20, 50, 16))]);
    harness.controller.setTrackedAnnotationIds(["ann"]);
    harness.controller.setPanelOpen(true);
    harness.flush();
    harness.onGeometry.mockClear();

    for (let index = 0; index < 100; index += 1) {
      harness.controller.notifyNavigationSettled();
      harness.scroll.dispatchEvent(new Event("scroll"));
    }

    expect(harness.scheduler.requests).toBe(2);
    harness.flush();
    expect(harness.onGeometry).toHaveBeenCalledTimes(1);
    expect(harness.controller.current()?.revision).toBe(2);
    harness.destroy();
  });

  it("feeds existing rail lane and connector geometry with the exact last-line Range", () => {
    const harness = setupGeometry([
      marker("ann", "block", rect(20, 20, 30, 12)),
      marker("ann", "block", rect(10, 42, 70, 12)),
    ]);
    harness.controller.setTrackedAnnotationIds(["ann"]);
    harness.controller.setPanelOpen(true);
    harness.flush();
    const normalized = normalizeDocumentGeometry("markdown", "text-r1", harness.controller.current()!);
    const anchor = markerAnchorPoint(normalized, "ann")!;
    const lane = layoutAnnotationLane({
      documentHeight: normalized.documentHeight,
      reservedTop: 0,
      items: [{ id: "ann", anchorY: anchor.y, height: 100, createdAt: "2026-01-01" }],
    });
    const connector = connectorGeometry({
      open: true,
      resolved: true,
      fragments: normalized.markers.ann,
      documentEdgeX: 200,
      fanOutX: 220,
      cardX: 260,
      cardY: lane.placements[0].connectorY,
    });

    expect(anchor).toEqual({ x: 80, y: 98 });
    expect(connector).toMatchObject({ marker: { x: 45, y: 104 }, card: { x: 260 } });
    expect(connector?.path).toContain("M 45 104");
    harness.destroy();
  });

  it("disconnects observers/listeners and rejects use after destroy", () => {
    const harness = setupGeometry([marker("ann", "block", rect(10, 20, 50, 16))]);
    harness.controller.setPanelOpen(true);
    harness.controller.destroy();

    expect(harness.scheduler.cancels).toBe(1);
    expect(harness.resizeObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(() => harness.controller.notifyZoomChanged()).toThrow("destroyed");
    harness.scroll.dispatchEvent(new Event("scroll"));
    expect(harness.scheduler.requests).toBe(1);
    harness.cleanupDom();
  });
});

class MutableGeometrySource implements MarkdownAnnotationOverlayGeometrySource {
  constructor(public entries: MarkdownMountedAnnotationMarker[]) {}

  forEachMountedMarker(visitor: (marker: MarkdownMountedAnnotationMarker) => void): void {
    this.entries.forEach(visitor);
  }

  mountedBlockRoots(): readonly HTMLElement[] {
    return [...new Set(this.entries.map((entry) => entry.block))];
  }
}

class ManualScheduler implements MarkdownAnnotationGeometryFrameScheduler {
  pending = false;
  requests = 0;
  cancels = 0;

  constructor(private readonly callback: () => void) {}

  request(): void {
    if (this.pending) return;
    this.pending = true;
    this.requests += 1;
  }

  cancel(): void {
    this.pending = false;
    this.cancels += 1;
  }

  flush(): boolean {
    if (!this.pending) return false;
    this.pending = false;
    this.callback();
    return true;
  }
}

function setupGeometry(
  items: ReturnType<typeof marker>[],
  options: { source?: MutableGeometrySource } = {},
) {
  const scroll = document.createElement("div");
  const documentElement = document.createElement("div");
  scroll.append(documentElement);
  document.body.append(scroll);
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 100 },
    clientWidth: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1000 },
    scrollTop: { configurable: true, writable: true, value: 50 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  Object.defineProperty(documentElement, "scrollHeight", { configurable: true, value: 1000 });
  vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 100));
  vi.spyOn(documentElement, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 1000));
  for (const item of items) documentElement.append(item.entry.block);
  const source = options.source ?? new MutableGeometrySource(items.map((item) => item.entry));
  for (const entry of source.entries) if (!entry.block.isConnected) documentElement.append(entry.block);
  const onGeometry = vi.fn();
  let scheduler!: ManualScheduler;
  let resizeCallback: ResizeObserverCallback = () => undefined;
  const resizeObserver = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  const controller = new MarkdownAnnotationGeometryController({
    overlay: source,
    scrollElement: scroll,
    documentElement,
    onGeometry,
    schedulerFactory: (flush) => (scheduler = new ManualScheduler(flush)),
    resizeObserverFactory: (callback) => {
      resizeCallback = callback;
      return resizeObserver;
    },
  });
  return {
    controller,
    scheduler,
    scroll,
    source,
    onGeometry,
    resizeObserver,
    markers: items,
    resize: () => resizeCallback([], resizeObserver as unknown as ResizeObserver),
    flush: () => scheduler.flush(),
    cleanupDom: () => scroll.remove(),
    destroy() {
      controller.destroy();
      scroll.remove();
    },
  };
}

function marker(annotationId: string, blockId: string, value: DOMRectReadOnly, visible = true) {
  const block = document.createElement("p");
  block.dataset.markdownBlockId = blockId;
  block.dataset.markdownBlockVisible = visible ? "true" : "false";
  const element = document.createElement("span");
  element.dataset.annotationId = annotationId;
  block.append(element);
  const getBoundingClientRect = vi.spyOn(element, "getBoundingClientRect").mockReturnValue(value);
  return {
    entry: { annotationId, blockId, element, block },
    getBoundingClientRect,
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
}
