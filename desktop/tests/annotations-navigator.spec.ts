import { describe, expect, it, vi } from "vitest";

import { AnnotationNavigator } from "@/renderer/features/annotations/navigation/AnnotationNavigator";
import { AnnotationViewRegistry } from "@/renderer/features/annotations/navigation/AnnotationViewRegistry";
import type { AnnotationViewAdapter, AnnotationViewId } from "@/renderer/features/annotations/navigation/types";
import { createAnnotationStore } from "@/renderer/features/annotations/state/annotationStore";

describe("AnnotationNavigator", () => {
  it.each([
    ["source", ["source"], "source"],
    ["preview", ["markdown"], "markdown"],
    ["split", ["markdown", "source"], "markdown"],
  ] as const)("routes %s mode to explicit adapters", async (mode, expectedViews, connector) => {
    const registry = new AnnotationViewRegistry();
    const source = adapter("source");
    const markdown = adapter("markdown");
    registry.register(source);
    registry.register(markdown);
    const store = createAnnotationStore();
    const navigator = new AnnotationNavigator(registry, store);

    await expect(navigator.navigate({ annotationId: "ann", mode, projection: projection() }))
      .resolves.toEqual({ status: "completed", connectorViewId: connector });

    expect(source.reveal).toHaveBeenCalledTimes(expectedViews.some((view) => view === "source") ? 1 : 0);
    expect(markdown.reveal).toHaveBeenCalledTimes(expectedViews.some((view) => view === "markdown") ? 1 : 0);
    if (expectedViews.some((view) => view === "source")) {
      expect(source.reveal).toHaveBeenCalledWith(expect.objectContaining({ scroll: mode === "source" }));
    }
    if (expectedViews.some((view) => view === "markdown")) {
      expect(markdown.reveal).toHaveBeenCalledWith(expect.objectContaining({ scroll: true }));
    }
    expect(source.flashMarker).toHaveBeenCalledTimes(expectedViews.some((view) => view === "source") ? 1 : 0);
    expect(markdown.flashMarker).toHaveBeenCalledTimes(expectedViews.some((view) => view === "markdown") ? 1 : 0);
    expect(store.getState().activeAnnotationId).toBe("ann");
    expect(store.getState().navigation.status).toBe("ready");
  });

  it("waits for the selected view to mount and become ready, then reveals exactly once", async () => {
    const registry = new AnnotationViewRegistry();
    const store = createAnnotationStore();
    const navigator = new AnnotationNavigator(registry, store);
    let ready!: () => void;
    const markdown = adapter("markdown", new Promise<void>((resolve) => {
      ready = resolve;
    }));
    const navigation = navigator.navigate({ annotationId: "ann", mode: "preview", projection: projection() });

    registry.register(markdown);
    expect(markdown.reveal).not.toHaveBeenCalled();
    ready();

    await expect(navigation).resolves.toMatchObject({ status: "completed" });
    expect(markdown.reveal).toHaveBeenCalledTimes(1);
  });

  it("cancels an older request during rapid consecutive navigation", async () => {
    const registry = new AnnotationViewRegistry();
    const store = createAnnotationStore();
    const source = adapter("source");
    vi.mocked(source.reveal).mockImplementation(({ annotationId, signal }) => {
      if (annotationId !== "first") {
        return Promise.resolve();
      }
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    registry.register(source);
    const navigator = new AnnotationNavigator(registry, store);
    const first = navigator.navigate({ annotationId: "first", mode: "source", projection: projection() });
    await Promise.resolve();
    await Promise.resolve();
    const second = navigator.navigate({ annotationId: "second", mode: "source", projection: projection() });

    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(second).resolves.toMatchObject({ status: "completed" });
    expect(store.getState().activeAnnotationId).toBe("second");
    expect(source.reveal).toHaveBeenCalledWith(expect.objectContaining({ annotationId: "second" }));
  });

  it("surfaces adapter navigation failures in store state", async () => {
    const registry = new AnnotationViewRegistry();
    const failing = adapter("markdown");
    vi.mocked(failing.reveal).mockRejectedValue(new Error("virtual item unavailable"));
    registry.register(failing);
    const store = createAnnotationStore();
    const navigator = new AnnotationNavigator(registry, store);

    await expect(navigator.navigate({ annotationId: "ann", mode: "preview", projection: projection() }))
      .rejects.toThrow("virtual item unavailable");
    expect(store.getState().navigation).toMatchObject({
      annotationId: "ann",
      status: "error",
      error: "virtual item unavailable",
    });
  });

  it("re-activates repeated marker clicks without revealing either view directly", () => {
    const registry = new AnnotationViewRegistry();
    const source = adapter("source");
    registry.register(source);
    const store = createAnnotationStore();
    const navigator = new AnnotationNavigator(registry, store);

    navigator.activateFromMarker("ann-marker");

    expect(store.getState().activeAnnotationId).toBe("ann-marker");
    expect(store.getState().panelOpen).toBe(true);
    expect(source.reveal).not.toHaveBeenCalled();

    navigator.activateFromMarker("ann-marker");

    expect(store.getState().activeAnnotationId).toBe("ann-marker");
    expect(store.getState().panelOpen).toBe(true);
    expect(source.reveal).not.toHaveBeenCalled();
  });
});

function projection() {
  return {
    logicalRange: { start: 1, end: 3 },
    sourceRanges: [{ start: 2, end: 4 }],
    blockRanges: [{ blockKey: "block", range: { start: 1, end: 3 } }],
    context: { containerType: "paragraph", headingPath: [] },
  };
}

function adapter(id: AnnotationViewId, ready: Promise<void> = Promise.resolve()): AnnotationViewAdapter {
  return {
    id,
    flashMarker: vi.fn(),
    geometry: vi.fn().mockReturnValue({
      documentHeight: 100,
      markers: {},
      revision: 1,
      scrollOffset: 0,
      viewportHeight: 100,
      viewportWidth: 100,
    }),
    isReady: vi.fn().mockReturnValue(true),
    render: vi.fn(),
    reveal: vi.fn().mockResolvedValue(undefined),
    selection: vi.fn().mockReturnValue(null),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    whenReady: vi.fn().mockImplementation(() => ready),
  };
}
