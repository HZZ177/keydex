import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserSurfacePlaceholder } from "@/renderer/features/browser/ui";

const surface = { panelId: "panel-1", surfaceId: "surface-1", generation: 1 } as const;

describe("browser surface performance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces resize storms to one bounds measurement per animation frame", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    let resizeCallback: ResizeObserverCallback | null = null;
    const cancelAnimationFrame = vi.fn((handle: number) => frames.delete(handle));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const handle = ++nextFrame;
      frames.set(handle, callback);
      return handle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancelAnimationFrame);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const view = render(
      <BrowserSurfacePlaceholder
        active
        surface={surface}
        onVisibilityChange={vi.fn()}
      />,
    );
    const placeholder = view.container.querySelector<HTMLElement>("[data-browser-native-surface='placeholder']")!;
    let rect = domRect(12, 24, 640, 720);
    vi.spyOn(placeholder, "getBoundingClientRect").mockImplementation(() => rect);

    act(() => {
      for (let index = 0; index < 50; index += 1) {
        resizeCallback?.([], {} as ResizeObserver);
        window.dispatchEvent(new Event("resize"));
        window.dispatchEvent(new Event("scroll"));
      }
    });
    expect(frames).toHaveLength(1);
    runNextFrame(frames);

    rect = domRect(14, 24, 642, 720);
    act(() => {
      for (let index = 0; index < 50; index += 1) resizeCallback?.([], {} as ResizeObserver);
    });
    expect(frames).toHaveLength(1);
    runNextFrame(frames);

    act(() => resizeCallback?.([], {} as ResizeObserver));
    const pendingHandle = [...frames.keys()][0];
    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingHandle);
    expect(frames).toHaveLength(0);
  });

  it("does not resend bounds or visibility when parent callbacks change identity", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const handle = ++nextFrame;
      frames.set(handle, callback);
      return handle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
      frames.delete(handle);
    });
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const onVisibilityChange = vi.fn();
    const callbackSet = (revision: number) => ({
      onVisibilityChange: (input: Parameters<typeof onVisibilityChange>[0]) => onVisibilityChange(revision, input),
    });
    const first = callbackSet(1);
    const view = render(<BrowserSurfacePlaceholder active surface={surface} {...first} />);
    const placeholder = view.container.querySelector<HTMLElement>("[data-browser-native-surface='placeholder']")!;
    vi.spyOn(placeholder, "getBoundingClientRect").mockImplementation(() => domRect(10, 20, 600, 700));

    while (frames.size > 0) runNextFrame(frames);
    expect(onVisibilityChange).toHaveBeenLastCalledWith(1, { visible: true, reason: "active" });
    const visibilityCalls = onVisibilityChange.mock.calls.length;

    view.rerender(<BrowserSurfacePlaceholder active surface={surface} {...callbackSet(2)} />);
    while (frames.size > 0) runNextFrame(frames);

    expect(onVisibilityChange).toHaveBeenCalledTimes(visibilityCalls);
  });
});

function runNextFrame(frames: Map<number, FrameRequestCallback>): void {
  const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (!next) throw new Error("Expected a pending animation frame");
  frames.delete(next[0]);
  act(() => next[1](performance.now()));
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  };
}
