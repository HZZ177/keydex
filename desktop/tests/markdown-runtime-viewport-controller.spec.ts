import { describe, expect, it } from "vitest";

import { MarkdownHeightIndex } from "@/renderer/markdownRuntime/layout/HeightIndex";
import { MarkdownViewportController } from "@/renderer/markdownRuntime/view/ViewportController";

describe("Markdown ViewportController", () => {
  it("computes top, middle, and tail windows with pixel overscan", () => {
    const heights = new MarkdownHeightIndex("r1", new Array(100).fill(20));
    const controller = new MarkdownViewportController(heights, { defaultOverscanPx: 40 });
    const top = controller.update({ scrollTop: 0, viewportHeight: 100, revision: "r1" });
    expect(top).toMatchObject({
      scrollTop: 0,
      visibleRange: { start: 0, end: 5 },
      overscanRange: { start: 0, end: 7 },
      mount: [0, 1, 2, 3, 4, 5, 6],
      direction: "none",
    });
    expect(top.items.filter((item) => item.visible).map((item) => item.index)).toEqual([0, 1, 2, 3, 4]);

    const middle = controller.update({ scrollTop: 1000, viewportHeight: 100 });
    expect(middle).toMatchObject({
      visibleRange: { start: 50, end: 55 },
      overscanRange: { start: 48, end: 57 },
      direction: "down",
      topSpacer: 960,
      bottomSpacer: 860,
    });
    expect(middle.mount).toEqual([48, 49, 50, 51, 52, 53, 54, 55, 56]);
    expect(middle.unmount).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const tail = controller.update({ scrollTop: 10_000, viewportHeight: 100 });
    expect(tail.scrollTop).toBe(1900);
    expect(tail.visibleRange).toEqual({ start: 95, end: 100 });
    expect(tail.overscanRange).toEqual({ start: 93, end: 100 });
  });

  it("emits a minimal diff during small scrolls and fast round trips", () => {
    const heights = new MarkdownHeightIndex("r1", new Array(1000).fill(25));
    const controller = new MarkdownViewportController(heights, { defaultOverscanPx: 50 });
    const first = controller.update({ scrollTop: 500, viewportHeight: 250 });
    const second = controller.update({ scrollTop: 525, viewportHeight: 250 });
    const back = controller.update({ scrollTop: 500, viewportHeight: 250 });

    expect(second.mount).toHaveLength(1);
    expect(second.unmount).toHaveLength(1);
    expect(second.retained.length).toBe(first.items.length - 1);
    expect(back.mount).toHaveLength(1);
    expect(back.unmount).toHaveLength(1);
    expect(back.direction).toBe("up");
  });

  it("supports scrollbar jumps without mounting intermediate blocks", () => {
    const heights = new MarkdownHeightIndex("r1", new Array(100_000).fill(20));
    const controller = new MarkdownViewportController(heights, { defaultOverscanPx: 100 });
    controller.update({ scrollTop: 0, viewportHeight: 400 });
    const jumped = controller.update({ scrollTop: 1_500_000, viewportHeight: 400 });

    expect(jumped.visibleRange).toEqual({ start: 75_000, end: 75_020 });
    expect(jumped.items.length).toBeLessThanOrEqual(30);
    expect(jumped.mount.every((index) => index >= 74_995 && index < 75_025)).toBe(true);
  });

  it("mounts selection-pinned blocks outside the viewport as disjoint ranges", () => {
    const heights = new MarkdownHeightIndex("r1", new Array(1000).fill(20));
    const controller = new MarkdownViewportController(heights, { defaultOverscanPx: 0 });
    const result = controller.update({
      scrollTop: 1000,
      viewportHeight: 100,
      pinnedIndices: new Set([2, 52, 900]),
    });

    expect(result.visibleRange).toEqual({ start: 50, end: 55 });
    expect(result.renderRanges).toEqual([
      { start: 2, end: 3 },
      { start: 50, end: 55 },
      { start: 900, end: 901 },
    ]);
    expect(result.items.find((item) => item.index === 2)).toMatchObject({ pinned: true, visible: false, top: 40 });
    expect(result.items.find((item) => item.index === 52)).toMatchObject({ pinned: true, visible: true });
    expect(result.items.find((item) => item.index === 900)).toMatchObject({ pinned: true, top: 18_000 });
  });

  it("handles an empty index, zero viewport, huge viewport, and a single giant block", () => {
    const empty = new MarkdownViewportController(new MarkdownHeightIndex("empty", []));
    expect(empty.update({ scrollTop: 0, viewportHeight: 100 })).toMatchObject({
      visibleRange: { start: 0, end: 0 },
      items: [],
      topSpacer: 0,
      bottomSpacer: 0,
    });

    const giantIndex = new MarkdownHeightIndex("giant", [1_000_000, 20, 20]);
    const giant = new MarkdownViewportController(giantIndex, { defaultOverscanPx: 0 });
    expect(giant.update({ scrollTop: 500_000, viewportHeight: 0 }).visibleRange).toEqual({ start: 0, end: 1 });
    expect(giant.update({ scrollTop: 500_000, viewportHeight: 10_000 }).items).toHaveLength(1);
    expect(giant.update({ scrollTop: 0, viewportHeight: 2_000_000 }).visibleRange).toEqual({ start: 0, end: 3 });
  });

  it("resets revision and reports every previously mounted block for unmount", () => {
    const firstIndex = new MarkdownHeightIndex("r1", new Array(20).fill(20));
    const controller = new MarkdownViewportController(firstIndex, { defaultOverscanPx: 0 });
    const first = controller.update({ scrollTop: 0, viewportHeight: 100 });
    const unmount = controller.reset(new MarkdownHeightIndex("r2", new Array(10).fill(30)));

    expect(unmount).toEqual(first.mount);
    expect(controller.mountedIndices()).toEqual([]);
    expect(() => controller.update({ scrollTop: 0, viewportHeight: 100, revision: "r1" })).toThrow(/Stale/u);
    expect(controller.update({ scrollTop: 0, viewportHeight: 100, revision: "r2" }).mount).toEqual([0, 1, 2, 3]);
    expect(controller.dispose()).toEqual([0, 1, 2, 3]);
    expect(controller.mountedIndices()).toEqual([]);
  });

  it("matches a naive visible range across random variable heights", () => {
    const random = prng(9876);
    const values = Array.from({ length: 5000 }, () => 5 + random() * 100);
    const heights = new MarkdownHeightIndex("random", values);
    const controller = new MarkdownViewportController(heights, { defaultOverscanPx: 0 });
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const viewportHeight = random() * 1000;
      const requested = (random() * 1.2 - 0.1) * heights.totalHeight;
      const actual = controller.update({ scrollTop: requested, viewportHeight });
      const expected = naiveRange(values, actual.scrollTop, viewportHeight);
      expect(actual.visibleRange).toEqual(expected);
    }
  });

  it("keeps million-block viewport work proportional to visible items", () => {
    const values = new Float64Array(1_000_000);
    values.fill(24);
    const controller = new MarkdownViewportController(new MarkdownHeightIndex("million", values), {
      defaultOverscanPx: 480,
    });
    const random = prng(123);
    let maxItems = 0;
    const startedAt = performance.now();
    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const result = controller.update({
        scrollTop: random() * 24_000_000,
        viewportHeight: 720,
        pinnedIndices: [10, 999_990],
      });
      maxItems = Math.max(maxItems, result.items.length);
    }
    const duration = performance.now() - startedAt;

    expect(maxItems).toBeLessThanOrEqual(73);
    expect(duration).toBeLessThan(3000);
  }, 10_000);

  it("validates viewport, overscan, pinned, and revision input", () => {
    const controller = new MarkdownViewportController(new MarkdownHeightIndex("r1", [10, 20]), {
      maxPinnedBlocks: 1,
    });
    expect(() => controller.update({ scrollTop: Number.NaN, viewportHeight: 10 })).toThrow(/scrollTop/u);
    expect(() => controller.update({ scrollTop: 0, viewportHeight: -1 })).toThrow(/viewportHeight/u);
    expect(() => controller.update({ scrollTop: 0, viewportHeight: 1, overscanPx: -1 })).toThrow(/overscan/u);
    expect(() => controller.update({ scrollTop: 0, viewportHeight: 1, pinnedIndices: [0, 1] })).toThrow(/limit/u);
    expect(() => controller.update({ scrollTop: 0, viewportHeight: 1, pinnedIndices: [2] })).toThrow(RangeError);
  });
});

function naiveRange(values: readonly number[], scrollTop: number, viewportHeight: number) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const startY = Math.max(0, Math.min(scrollTop, Math.max(0, total - viewportHeight)));
  const endY = Math.min(total, startY + viewportHeight);
  let top = 0;
  let start = values.length ? values.length - 1 : 0;
  let end = values.length;
  for (let index = 0; index < values.length; index += 1) {
    const bottom = top + values[index];
    if (start === values.length - 1 && startY < bottom) start = index;
    if (endY <= top) {
      end = index;
      break;
    }
    top = bottom;
  }
  return { start, end: Math.max(start + 1, end) };
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
