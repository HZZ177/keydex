import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownRenderCache } from "@/renderer/markdownRuntime/cache";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import {
  DocumentViewRuntime,
  MarkdownEnvironmentController,
  type DocumentViewPatchResult,
} from "@/renderer/markdownRuntime/view";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const roots: HTMLElement[] = [];
let restoreMatchMedia: (() => void) | null = null;
let originalDpr: PropertyDescriptor | undefined;

afterEach(() => {
  roots.splice(0).forEach((root) => root.remove());
  restoreMatchMedia?.();
  restoreMatchMedia = null;
  if (originalDpr) Object.defineProperty(window, "devicePixelRatio", originalDpr);
  originalDpr = undefined;
  vi.restoreAllMocks();
});

describe("Markdown view environment transaction coordinator", () => {
  it("coalesces theme/font/width/zoom/DPR into one minimal invalidation transaction", () => {
    const harness = environmentHarness();
    const cache = new MarkdownRenderCache();
    const invalidateTheme = vi.spyOn(cache, "invalidateTheme");
    const invalidateFont = vi.spyOn(cache, "invalidateFont");
    const invalidateWidth = vi.spyOn(cache, "invalidateWidth");
    const invalidateScale = vi.spyOn(cache, "invalidateViewScale");
    const mermaid = { refresh: vi.fn() };
    const transactions = vi.fn();
    const remeasure = vi.fn();
    let font = "font-1";
    const controller = new MarkdownEnvironmentController(harness.host, {
      cache,
      mermaidRuntime: mermaid,
      initialZoom: 1,
      fontRevisionFor: () => font,
      onTransaction: transactions,
      onRemeasure: remeasure,
      ...harness.options,
    });
    expect(controller.current()).toMatchObject({
      themeKey: "light", fontRevision: "font-1", viewportWidth: 800, zoom: 1, devicePixelRatio: 1,
    });

    document.documentElement.setAttribute("data-theme", "dark");
    harness.width = 640;
    font = "font-2";
    setDpr(2);
    controller.setZoom(1.25);
    harness.resize();
    harness.mutate();
    expect(harness.frames).toHaveLength(1);
    harness.flushFrame();

    expect(transactions).toHaveBeenCalledTimes(1);
    expect([...transactions.mock.calls[0]![0].changes]).toEqual(["theme", "font", "width", "zoom", "dpr"]);
    expect(remeasure).toHaveBeenCalledTimes(1);
    expect(invalidateTheme).toHaveBeenCalledWith("light");
    expect(invalidateFont).toHaveBeenCalledWith("font-1");
    expect(invalidateWidth).toHaveBeenCalledWith(800);
    expect(invalidateScale).toHaveBeenCalledWith(1, 1);
    expect(mermaid.refresh).toHaveBeenCalledTimes(1);
    expect(harness.host.dataset).toMatchObject({
      markdownTheme: "dark", markdownViewportWidth: "640", markdownZoom: "1.25", markdownDpr: "2",
    });
    controller.destroy();
  });

  it("does not remeasure for reduced-motion alone and makes reveal deterministic", () => {
    const harness = environmentHarness();
    const remeasure = vi.fn();
    const controller = new MarkdownEnvironmentController(harness.host, { onRemeasure: remeasure, ...harness.options });
    expect(controller.behavior("smooth")).toBe("smooth");
    harness.motion.set(true);
    harness.flushFrame();
    expect(controller.current().reducedMotion).toBe(true);
    expect(controller.behavior("smooth")).toBe("auto");
    expect(remeasure).not.toHaveBeenCalled();
    expect(controller.diagnostics()).toMatchObject({ transactions: 1, remeasurements: 0 });
    controller.destroy();
  });

  it("handles 100/125/150 percent zoom and rapid narrow/wide resize without frame storms", () => {
    const harness = environmentHarness();
    const transactions: unknown[] = [];
    const controller = new MarkdownEnvironmentController(harness.host, {
      onTransaction: (transaction) => transactions.push(transaction),
      ...harness.options,
    });
    controller.setZoom(1.25);
    controller.setZoom(1.5);
    harness.width = 320;
    for (let index = 0; index < 100; index += 1) harness.resize();
    expect(harness.frames).toHaveLength(1);
    harness.flushFrame();
    expect(controller.current()).toMatchObject({ zoom: 1.5, viewportWidth: 320 });
    harness.width = 1_440;
    harness.resize();
    harness.flushFrame();
    controller.setZoom(1);
    harness.flushFrame();
    expect(controller.current()).toMatchObject({ zoom: 1, viewportWidth: 1_440 });
    expect(transactions).toHaveLength(3);
    controller.destroy();
  });

  it("keeps the reading point anchored when environment remeasurement changes content above it", () => {
    const harness = environmentHarness();
    const snapshot = parse("First\n\nReading\n\nTail");
    const view = new DocumentViewRuntime(harness.host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 500 },
    });
    const initial = view.publish(snapshot, [100, 100, 100], { scrollTop: 150, viewportHeight: 100 });
    const reading = view.getBlockElement(snapshot.blocks[1]!.id);
    const corrections: DocumentViewPatchResult[] = [];
    const controller = new MarkdownEnvironmentController(harness.host, {
      onRemeasure: () => {
        const result = view.updateMeasuredHeights([{ index: 0, height: 180 }], snapshot.revision);
        if (result) corrections.push(result);
      },
      ...harness.options,
    });
    expect(initial.viewport.scrollTop).toBe(150);
    harness.width = 500;
    harness.resize();
    harness.flushFrame();
    expect(corrections[0]?.viewport.scrollTop).toBe(230);
    expect(view.getBlockElement(snapshot.blocks[1]!.id)).toBe(reading);
    controller.destroy();
    view.destroy();
  });

  it("disconnects all observers/listeners and rejects mutation after destroy", () => {
    const harness = environmentHarness();
    const controller = new MarkdownEnvironmentController(harness.host, harness.options);
    controller.destroy();
    expect(harness.resizeDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.mutationDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.host.dataset.markdownEnvironment).toBeUndefined();
    expect(() => controller.setZoom(1.25)).toThrow(/destroyed/u);
  });
});

describe("measurement cache scale identity", () => {
  it("separates zoom and DPR keys and invalidates only the old scale", () => {
    const snapshot = parse("Scale cache");
    const block = snapshot.blocks[0]!;
    const cache = new MarkdownRenderCache();
    const environment = {
      profile: "file-preview" as const,
      viewportWidth: 800,
      themeKey: "light",
      fontRevision: "font-1",
      resourceRevision: "resource-1",
      zoom: 1,
      devicePixelRatio: 1,
    };
    cache.setMeasurement(block, environment, 100);
    cache.setMeasurement(block, { ...environment, zoom: 1.25 }, 125);
    cache.setMeasurement(block, { ...environment, devicePixelRatio: 2 }, 101);
    expect(cache.getMeasurement(block, environment)).toBe(100);
    expect(cache.getMeasurement(block, { ...environment, zoom: 1.25 })).toBe(125);
    expect(cache.getMeasurement(block, { ...environment, devicePixelRatio: 2 })).toBe(101);
    expect(cache.invalidateViewScale(1, 1)).toBe(1);
    expect(cache.getMeasurement(block, environment)).toBeUndefined();
    expect(cache.getMeasurement(block, { ...environment, zoom: 1.25 })).toBe(125);
  });
});

function environmentHarness() {
  const host = document.createElement("div");
  document.body.append(host);
  roots.push(host);
  let widthValue = 800;
  host.getBoundingClientRect = () => ({ width: widthValue, height: 600, top: 0, left: 0, right: widthValue, bottom: 600, x: 0, y: 0, toJSON() {} });
  const frames: FrameRequestCallback[] = [];
  let resizeCallback!: ResizeObserverCallback;
  let mutationCallback!: MutationCallback;
  const resizeDisconnect = vi.fn();
  const mutationDisconnect = vi.fn();
  const motion = installMotion(false);
  setDpr(1);
  return {
    host,
    frames,
    motion,
    resizeDisconnect,
    mutationDisconnect,
    get width() { return widthValue; },
    set width(value: number) { widthValue = value; },
    resize: () => resizeCallback([], {} as ResizeObserver),
    mutate: () => mutationCallback([], {} as MutationObserver),
    flushFrame: () => frames.shift()?.(performance.now()),
    options: {
      resizeObserverFactory: (callback: ResizeObserverCallback) => {
        resizeCallback = callback;
        return { observe: vi.fn(), disconnect: resizeDisconnect };
      },
      mutationObserverFactory: (callback: MutationCallback) => {
        mutationCallback = callback;
        return { observe: vi.fn(), disconnect: mutationDisconnect };
      },
      scheduleFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
      cancelFrame: vi.fn(),
    },
  };
}

function installMotion(initial: boolean) {
  const original = window.matchMedia;
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  window.matchMedia = vi.fn(() => ({
    get matches() { return matches; },
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  } as MediaQueryList));
  restoreMatchMedia = () => { window.matchMedia = original; };
  return {
    set(value: boolean) {
      matches = value;
      listeners.forEach((listener) => listener({ matches, media: "(prefers-reduced-motion: reduce)" } as MediaQueryListEvent));
    },
  };
}

function setDpr(value: number): void {
  if (!originalDpr) originalDpr = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
}

function parse(source: string) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:environment.md",
    revision: "environment-r1",
    source,
    rendererProfile: "file-preview",
  });
}
