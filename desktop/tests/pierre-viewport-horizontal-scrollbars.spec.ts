import { describe, expect, it, vi } from "vitest";

import {
  applyPierreViewportHorizontalWheel,
  type PierreHorizontalPane,
} from "@/renderer/components/diff/engine/PierreViewportHorizontalScrollbars";

describe("Pierre viewport blank-area horizontal scrolling", () => {
  it("routes a horizontal wheel gesture from the blank viewport area to the pane under the pointer", () => {
    const left = pane(0, 320, 960);
    const right = pane(320, 320, 960);
    const event = wheel({ clientX: 520, deltaX: 72 });

    expect(applyPierreViewportHorizontalWheel([left, right], event)).toBe(true);
    expect(left.target.scrollLeft).toBe(0);
    expect(right.target.scrollLeft).toBe(72);
  });

  it("supports shift-wheel but preserves ordinary vertical scrolling", () => {
    const target = pane(0, 480, 960);

    expect(applyPierreViewportHorizontalWheel(
      [target],
      wheel({ clientX: 120, deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE, shiftKey: true }),
    )).toBe(true);
    expect(target.target.scrollLeft).toBe(48);

    expect(applyPierreViewportHorizontalWheel(
      [target],
      wheel({ clientX: 120, deltaY: 80 }),
    )).toBe(false);
    expect(target.target.scrollLeft).toBe(48);
  });

  it("does not handle an event already originating from Pierre's native code pane", () => {
    const target = pane(0, 480, 960);
    const event = wheel({ clientX: 120, deltaX: 72, path: [target.target] });

    expect(applyPierreViewportHorizontalWheel([target], event)).toBe(false);
    expect(target.target.scrollLeft).toBe(0);
  });
});

function pane(left: number, width: number, scrollWidth: number): PierreHorizontalPane {
  const target = document.createElement("div");
  Object.defineProperties(target, {
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
  vi.spyOn(target, "dispatchEvent");
  return { target, left, width, proxyContentWidth: scrollWidth };
}

function wheel({
  clientX,
  deltaX = 0,
  deltaY = 0,
  deltaMode = WheelEvent.DOM_DELTA_PIXEL,
  shiftKey = false,
  path = [],
}: {
  readonly clientX: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaMode?: number;
  readonly shiftKey?: boolean;
  readonly path?: readonly EventTarget[];
}) {
  return {
    clientX,
    deltaX,
    deltaY,
    deltaMode,
    shiftKey,
    composedPath: () => [...path],
  };
}
