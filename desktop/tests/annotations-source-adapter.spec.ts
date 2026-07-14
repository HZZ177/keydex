import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceAnnotationAdapter } from "@/renderer/features/annotations/adapters/SourceAnnotationAdapter";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.restoreAllMocks();
});

describe("SourceAnnotationAdapter", () => {
  it("maintains all source decorations atomically with active and flash state", () => {
    const adapter = new SourceAnnotationAdapter();
    const view = editor("alpha beta gamma", adapter);
    adapter.render(renderState([
      { annotationId: "alpha", sourceRanges: [{ start: 0, end: 5 }] },
      { annotationId: "multi", sourceRanges: [{ start: 6, end: 10 }, { start: 11, end: 16 }] },
    ], "multi", "alpha"));

    expect(view.dom.querySelectorAll("[data-annotation-id='multi']")).toHaveLength(2);
    expect(view.dom.querySelector("[data-annotation-id='multi']")?.getAttribute("data-active")).toBe("true");
    expect(view.dom.querySelector("[data-annotation-id='alpha']")?.getAttribute("data-flash")).toBe("true");
  });

  it("reports source selections and marker activation through one event protocol", () => {
    const adapter = new SourceAnnotationAdapter();
    const view = editor("alpha beta", adapter);
    const events = vi.fn();
    adapter.subscribe(events);
    adapter.render(renderState([{ annotationId: "alpha", sourceRanges: [{ start: 0, end: 5 }] }]));

    view.dispatch({ selection: { anchor: 0, head: 5 } });
    (view.dom.querySelector("[data-annotation-id='alpha']") as HTMLElement).click();
    const marker = view.dom.querySelector("[data-annotation-id='alpha']") as HTMLElement;
    marker.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    marker.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    adapter.flashMarker("alpha");

    expect(adapter.selection()).toEqual({ coordinateSpace: "source", range: { start: 0, end: 5 } });
    expect(events).toHaveBeenCalledWith({
      type: "selection",
      selection: { coordinateSpace: "source", range: { start: 0, end: 5 } },
    });
    expect(events).toHaveBeenCalledWith({ type: "marker-activate", annotationId: "alpha" });
    expect(events).toHaveBeenCalledWith({ type: "marker-hover", annotationId: "alpha" });
    expect(events).toHaveBeenCalledWith({ type: "marker-hover", annotationId: null });
    expect(marker.getAttribute("data-annotation-navigation-flash")).toBe("true");
  });

  it("performs one reveal transaction and rejects unavailable or aborted targets", async () => {
    const adapter = new SourceAnnotationAdapter();
    const view = editor("alpha\nbeta\ngamma", adapter);
    const viewport = document.createElement("div");
    document.body.append(viewport);
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 0, writable: true });
    Object.defineProperty(viewport, "scrollTo", {
      configurable: true,
      value: vi.fn(({ top }: ScrollToOptions) => {
        viewport.scrollTop = top ?? viewport.scrollTop;
      }),
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 100));
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 10, right: 40, top: 240, bottom: 260 });
    adapter.attach(view, viewport);
    const dispatch = vi.spyOn(view, "dispatch");
    const controller = new AbortController();

    await adapter.reveal({
      annotationId: "beta",
      blockRanges: [],
      logicalRange: { start: 6, end: 10 },
      requestId: 1,
      scroll: true,
      signal: controller.signal,
      sourceRanges: [{ start: 6, end: 10 }],
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(view.state.selection.main).toMatchObject({ from: 6, to: 10 });
    expect(viewport.scrollTop).toBe(200);
    controller.abort();
    await expect(adapter.reveal({
      annotationId: "beta",
      blockRanges: [],
      logicalRange: { start: 6, end: 10 },
      requestId: 2,
      scroll: true,
      signal: controller.signal,
      sourceRanges: [{ start: 6, end: 10 }],
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("centers the complete multi-line source range without drifting on repeated reveals", async () => {
    const adapter = new SourceAnnotationAdapter();
    const view = editor("alpha\nbeta\ngamma", adapter);
    const viewport = document.createElement("div");
    document.body.append(viewport);
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 40, writable: true },
    });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      viewport.scrollTop = top ?? viewport.scrollTop;
    });
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: scrollTo });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 100));
    adapter.attach(view, viewport);
    vi.spyOn(view, "coordsAtPos").mockImplementation((position) => position === 0
      ? { left: 10, right: 40, top: 120 - viewport.scrollTop, bottom: 140 - viewport.scrollTop }
      : { left: 10, right: 60, top: 220 - viewport.scrollTop, bottom: 240 - viewport.scrollTop });
    const request = {
      annotationId: "multi",
      blockRanges: [],
      logicalRange: { start: 0, end: 16 },
      requestId: 1,
      scroll: true,
      signal: new AbortController().signal,
      sourceRanges: [{ start: 0, end: 5 }, { start: 11, end: 16 }],
    };

    await adapter.reveal(request);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 16 });
    expect(viewport.scrollTop).toBe(130);
    scrollTo.mockClear();

    await adapter.reveal({ ...request, requestId: 2 });

    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 130 });
    expect(viewport.scrollTop).toBe(130);
  });

  it("converts marker fragments into complete-document geometry", () => {
    const adapter = new SourceAnnotationAdapter();
    const view = editor("alpha\nbeta", adapter);
    const viewport = document.createElement("div");
    document.body.append(viewport);
    adapter.attach(view, viewport);
    adapter.render(renderState([{ annotationId: "cross", sourceRanges: [{ start: 0, end: 10 }] }]));
    Object.defineProperty(view, "contentHeight", { configurable: true, value: 500 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 40, writable: true });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 300, 100));
    vi.spyOn(view, "coordsAtPos").mockImplementation((position) => ({
      left: position < 6 ? 10 : 20,
      right: position < 6 ? 50 : 60,
      top: position < 6 ? 10 : 30,
      bottom: position < 6 ? 20 : 40,
    }));

    const geometry = adapter.geometry();

    expect(geometry).toMatchObject({ documentHeight: 500, scrollOffset: 40, viewportHeight: 100 });
    expect(geometry.markers.cross).toHaveLength(2);
    expect(geometry.markers.cross[0].top).toBe(50);
    expect(geometry.markers.cross[1].top).toBe(70);
  });

  it("prefers exact rendered annotation fragments for source connector geometry", () => {
    const adapter = new SourceAnnotationAdapter();
    const view = editor("alpha beta", adapter);
    const viewport = document.createElement("div");
    document.body.append(viewport);
    adapter.attach(view, viewport);
    adapter.render(renderState([{ annotationId: "alpha", sourceRanges: [{ start: 0, end: 5 }] }]));
    Object.defineProperty(view, "contentHeight", { configurable: true, value: 600 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 500 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 40, writable: true });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(10, 20, 500, 200));
    const marker = view.dom.querySelector<HTMLElement>(".cm-annotation-mark[data-annotation-id='alpha']")!;
    vi.spyOn(marker, "getClientRects").mockReturnValue([rect(110, 80, 90, 20)] as unknown as DOMRectList);
    const coordsAtPos = vi.spyOn(view, "coordsAtPos").mockImplementation(() => {
      throw new Error("position inference must not run when rendered fragments exist");
    });

    const geometry = adapter.geometry();

    expect(geometry.markers.alpha).toEqual([{ left: 100, right: 190, top: 100, bottom: 120 }]);
    expect(coordsAtPos).not.toHaveBeenCalled();
  });

  it("does not measure source geometry directly from the shared viewport scroll event", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const adapter = new SourceAnnotationAdapter();
    const view = editor("alpha\nbeta", adapter);
    const viewport = document.createElement("div");
    document.body.append(viewport);
    adapter.attach(view, viewport);
    const geometry = vi.spyOn(adapter, "geometry");

    adapter.setGeometryEnabled(true);
    for (const frame of frames.splice(0)) {
      frame(0);
    }
    geometry.mockClear();

    viewport.dispatchEvent(new Event("scroll"));
    expect(geometry).not.toHaveBeenCalled();

    adapter.dispose();
  });

  it("cleans scroll and readiness lifecycles on detach/dispose", async () => {
    const adapter = new SourceAnnotationAdapter();
    const controller = new AbortController();
    const ready = adapter.whenReady(controller.signal);
    const view = editor("alpha", adapter);
    await expect(ready).resolves.toBeUndefined();
    const events = vi.fn();
    adapter.subscribe(events);
    const cleanup = adapter.attach(view);
    cleanup();
    view.scrollDOM.dispatchEvent(new Event("scroll"));

    expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "geometry" }));
    adapter.dispose();
    expect(adapter.isReady()).toBe(false);
  });
});

function editor(source: string, adapter: SourceAnnotationAdapter): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: source, extensions: [adapter.extension] }),
  });
  views.push(view);
  adapter.attach(view);
  return view;
}

function renderState(
  markers: Array<{ annotationId: string; sourceRanges: Array<{ start: number; end: number }> }>,
  activeAnnotationId: string | null = null,
  flashAnnotationId: string | null = null,
) {
  return {
    activeAnnotationId,
    flashAnnotationId,
    flashToken: 1,
    hoveredAnnotationId: null,
    revision: "r1",
    markers: markers.map((marker) => ({
      ...marker,
      logicalRange: marker.sourceRanges[0],
      blockRanges: [],
    })),
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
