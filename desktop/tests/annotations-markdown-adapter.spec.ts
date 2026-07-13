import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownAnnotationAdapter } from "@/renderer/features/annotations/adapters/MarkdownAnnotationAdapter";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MarkdownAnnotationAdapter", () => {
  it("projects resolved source ranges into single and cross-block view markers", () => {
    const adapter = new MarkdownAnnotationAdapter();
    adapter.attach(binding());
    adapter.render(renderState());

    expect(adapter.rangesForBlock("paragraph")).toMatchObject([
      { annotationId: "single", blockLocalStart: 2, blockLocalEnd: 6, active: true },
      { annotationId: "cross", blockLocalStart: 8, blockLocalEnd: 10 },
    ]);
    expect(adapter.rangesForBlock("code")).toMatchObject([
      { annotationId: "cross", blockLocalStart: 0, blockLocalEnd: 3, flash: true },
    ]);
  });

  it("accepts logical selection and marker activation without reconstructing text from DOM", () => {
    const adapter = new MarkdownAnnotationAdapter();
    const resolvedBinding = binding();
    adapter.attach(resolvedBinding);
    const events = vi.fn();
    adapter.subscribe(events);
    const selection = { coordinateSpace: "logical" as const, range: { start: 2, end: 6 } };

    adapter.updateSelection(selection);
    adapter.activateMarker("single");
    const marker = document.createElement("mark");
    marker.dataset.annotationId = "single";
    resolvedBinding.root.append(marker);
    marker.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    marker.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    adapter.flashMarker("single");

    expect(adapter.selection()).toEqual(selection);
    expect(events).toHaveBeenCalledWith({ type: "selection", selection });
    expect(events).toHaveBeenCalledWith({ type: "marker-activate", annotationId: "single" });
    expect(events).toHaveBeenCalledWith({ type: "marker-hover", annotationId: "single" });
    expect(events).toHaveBeenCalledWith({ type: "marker-hover", annotationId: null });
    expect(marker.getAttribute("data-annotation-navigation-flash")).toBe("true");
  });

  it("reveals exactly the projected block through the virtualized binding", async () => {
    const revealBlock = vi.fn().mockResolvedValue(undefined);
    const adapter = new MarkdownAnnotationAdapter();
    adapter.attach(binding(revealBlock));
    const controller = new AbortController();

    await adapter.reveal({
      annotationId: "single",
      blockRanges: [{ blockKey: "logical-paragraph", range: { start: 2, end: 6 } }],
      logicalRange: { start: 2, end: 6 },
      requestId: 1,
      scroll: true,
      signal: controller.signal,
      sourceRanges: [{ start: 2, end: 6 }],
    });

    expect(revealBlock).toHaveBeenCalledTimes(1);
    expect(revealBlock).toHaveBeenCalledWith("paragraph", controller.signal);
  });

  it("refines a coarse block reveal by centering the mounted annotation marker", async () => {
    const revealBlock = vi.fn().mockResolvedValue(undefined);
    const resolvedBinding = binding(revealBlock);
    const marker = document.createElement("mark");
    marker.dataset.annotationId = "single";
    resolvedBinding.root.append(marker);
    Object.defineProperties(resolvedBinding.scrollElement, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 2_000 },
      scrollTop: { configurable: true, value: 1_200, writable: true },
    });
    vi.spyOn(resolvedBinding.scrollElement, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 200));
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(rect(20, 30, 40, 20));
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      resolvedBinding.scrollElement.scrollTop = top ?? resolvedBinding.scrollElement.scrollTop;
    });
    Object.defineProperty(resolvedBinding.scrollElement, "scrollTo", { configurable: true, value: scrollTo });
    const adapter = new MarkdownAnnotationAdapter();
    adapter.attach(resolvedBinding);

    await adapter.reveal({
      annotationId: "single",
      blockRanges: [{ blockKey: "logical-paragraph", range: { start: 2, end: 6 } }],
      logicalRange: { start: 2, end: 6 },
      requestId: 1,
      scroll: true,
      signal: new AbortController().signal,
      sourceRanges: [{ start: 2, end: 6 }],
    });

    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 1_140 });
    expect(resolvedBinding.scrollElement.scrollTop).toBe(1_140);
  });

  it("uses the runtime range resolver without scanning a full block array", async () => {
    const revealBlock = vi.fn().mockResolvedValue(undefined);
    const blocksForSourceRange = vi.fn(() => [
      { id: "paragraph", sourceStart: 0, sourceEnd: 10 },
    ]);
    const resolvedBinding = binding(revealBlock);
    const adapter = new MarkdownAnnotationAdapter();
    adapter.attach({ ...resolvedBinding, blocks: [], blocksForSourceRange });
    adapter.render(renderState());

    expect(blocksForSourceRange).toHaveBeenCalledWith({ start: 2, end: 6 });
    expect(adapter.rangesForBlock("paragraph")).toMatchObject([
      { annotationId: "single", blockLocalStart: 2, blockLocalEnd: 6 },
      { annotationId: "cross", blockLocalStart: 8, blockLocalEnd: 10 },
    ]);
    await adapter.reveal({
      annotationId: "single",
      blockRanges: [],
      logicalRange: { start: 2, end: 6 },
      requestId: 2,
      scroll: true,
      signal: new AbortController().signal,
      sourceRanges: [{ start: 2, end: 6 }],
    });
    expect(revealBlock).toHaveBeenCalledWith("paragraph", expect.any(AbortSignal));
  });

  it("reports marker fragments in full-document coordinates", () => {
    const state = renderState();
    const resolvedBinding = binding();
    const marker = document.createElement("mark");
    marker.dataset.annotationId = "single";
    vi.spyOn(marker, "getBoundingClientRect").mockReturnValue(rect(20, 30, 40, 10));
    resolvedBinding.root.append(marker);
    Object.defineProperty(resolvedBinding.root, "scrollHeight", { value: 500 });
    Object.defineProperty(resolvedBinding.scrollElement, "clientHeight", { value: 100 });
    Object.defineProperty(resolvedBinding.scrollElement, "clientWidth", { value: 300 });
    Object.defineProperty(resolvedBinding.scrollElement, "scrollTop", { value: 50, writable: true });
    vi.spyOn(resolvedBinding.scrollElement, "getBoundingClientRect").mockReturnValue(rect(0, 10, 300, 100));
    const adapter = new MarkdownAnnotationAdapter();
    adapter.attach(resolvedBinding);
    adapter.render(state);

    const geometry = adapter.geometry();

    expect(geometry).toMatchObject({ documentHeight: 500, scrollOffset: 50 });
    expect(geometry.markers.single[0]).toEqual({ top: 70, bottom: 80, left: 20, right: 60 });
  });

  it("keeps raw scroll off the geometry path and coalesces virtual range changes per frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const adapter = new MarkdownAnnotationAdapter();
    const resolvedBinding = binding();
    const geometry = vi.spyOn(adapter, "geometry");

    adapter.setGeometryEnabled(true);
    const cleanup = adapter.attach(resolvedBinding);
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    geometry.mockClear();

    resolvedBinding.scrollElement.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(0);
    expect(geometry).not.toHaveBeenCalled();

    adapter.notifyMountedBlocksChanged();
    adapter.notifyMountedBlocksChanged();
    expect(frames).toHaveLength(1);
    frames.shift()?.(16);
    expect(geometry).toHaveBeenCalledTimes(1);

    cleanup();
    adapter.dispose();
  });

  it("cleans attachment and ready waiters", async () => {
    const adapter = new MarkdownAnnotationAdapter();
    const ready = adapter.whenReady(new AbortController().signal);
    const cleanup = adapter.attach(binding());
    await expect(ready).resolves.toBeUndefined();
    cleanup();
    expect(adapter.isReady()).toBe(false);
    adapter.dispose();
  });
});

function binding(revealBlock = vi.fn().mockResolvedValue(undefined)) {
  const root = document.createElement("div");
  const scrollElement = document.createElement("div");
  document.body.append(scrollElement);
  scrollElement.append(root);
  return {
    blocks: [
      { id: "paragraph", sourceStart: 0, sourceEnd: 10 },
      { id: "code", sourceStart: 10, sourceEnd: 20 },
      { id: "table", sourceStart: 20, sourceEnd: 30 },
    ],
    root,
    scrollElement,
    revealBlock,
  };
}

function renderState() {
  return {
    activeAnnotationId: "single",
    flashAnnotationId: "cross",
    flashToken: 2,
    hoveredAnnotationId: "cross",
    revision: "r2",
    markers: [
      {
        annotationId: "single",
        logicalRange: { start: 2, end: 6 },
        sourceRanges: [{ start: 2, end: 6 }],
        blockRanges: [{ blockKey: "paragraph", range: { start: 2, end: 6 } }],
      },
      {
        annotationId: "cross",
        logicalRange: { start: 8, end: 13 },
        sourceRanges: [{ start: 8, end: 13 }],
        blockRanges: [
          { blockKey: "paragraph", range: { start: 8, end: 10 } },
          { blockKey: "code", range: { start: 0, end: 3 } },
        ],
      },
    ],
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
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
  } as DOMRect;
}
