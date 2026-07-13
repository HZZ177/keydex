import { describe, expect, it } from "vitest";

import { MarkdownHeightIndex } from "@/renderer/markdownRuntime/layout/HeightIndex";

describe("Fenwick Markdown HeightIndex", () => {
  it("handles empty and single-block indexes", () => {
    const empty = new MarkdownHeightIndex("empty", []);
    expect(empty.length).toBe(0);
    expect(empty.totalHeight).toBe(0);
    expect(empty.queryY(0)).toBeNull();
    expect(empty.offsetOf(0)).toBe(0);

    const single = new MarkdownHeightIndex("single", [42]);
    expect(single.queryY(-10)).toEqual({ index: 0, blockTop: 0, blockHeight: 42, offsetWithinBlock: 0 });
    expect(single.queryY(21)).toEqual({ index: 0, blockTop: 0, blockHeight: 42, offsetWithinBlock: 21 });
    expect(single.queryY(100)).toEqual({ index: 0, blockTop: 0, blockHeight: 42, offsetWithinBlock: 42 });
  });

  it("maps block offsets and Y boundaries with zero and floating heights", () => {
    const index = new MarkdownHeightIndex("r1", [0, 10.5, 0, 20.25, 5]);

    expect(index.totalHeight).toBe(35.75);
    expect([0, 0, 10.5, 10.5, 30.75, 35.75]).toEqual(
      Array.from({ length: 6 }, (_, block) => index.offsetOf(block)),
    );
    expect(index.rangeHeight(1, 4)).toBe(30.75);
    expect(index.queryY(0)?.index).toBe(1);
    expect(index.queryY(10.499)?.index).toBe(1);
    expect(index.queryY(10.5)?.index).toBe(3);
    expect(index.queryY(35.75)?.index).toBe(4);
  });

  it("applies single and batch updates without rebuilding prefixes", () => {
    const index = new MarkdownHeightIndex("r1", [10, 20, 30]);
    expect(index.kindAt(1)).toBe("estimated");
    expect(index.update(1, 25, { kind: "measured", revision: "r1" })).toBe(5);
    expect(index.totalHeight).toBe(65);
    expect(index.offsetOf(2)).toBe(35);
    expect(index.kindAt(1)).toBe("measured");
    expect(index.measuredCount()).toBe(1);

    expect(index.updateBatch([
      { index: 0, height: 5, kind: "measured" },
      { index: 2, height: 35 },
      { index: 2, height: 40, kind: "measured" },
    ], { revision: "r1" })).toBe(5);
    expect(Array.from(index.cloneHeights())).toEqual([5, 25, 40]);
    expect(index.totalHeight).toBe(70);
    expect(index.measuredCount()).toBe(3);
  });

  it("rejects stale revisions and resets atomically to a new revision", () => {
    const index = new MarkdownHeightIndex("r1", [10, 20]);
    expect(() => index.update(0, 11, { revision: "r0" })).toThrow(/Stale/u);
    expect(index.cloneHeights()).toEqual(new Float64Array([10, 20]));

    index.reset("r2", [1.5, 2.5, 3.5], "measured");
    expect(index.revision).toBe("r2");
    expect(index.totalHeight).toBe(7.5);
    expect(index.measuredCount()).toBe(3);
    expect(index.queryY(4)).toMatchObject({ index: 2, blockTop: 4 });
  });

  it("matches a naive prefix model across random updates and queries", () => {
    const random = prng(0x5eed);
    const values = Array.from({ length: 2000 }, () => Math.round(random() * 10000) / 100);
    const index = new MarkdownHeightIndex("random", values);
    for (let iteration = 0; iteration < 5000; iteration += 1) {
      if (random() < 0.35) {
        const target = Math.floor(random() * values.length);
        const height = Math.round(random() * 10000) / 100;
        values[target] = height;
        index.update(target, height);
      } else {
        const y = (random() * 1.2 - 0.1) * values.reduce((sum, value) => sum + value, 0);
        const expected = naiveQuery(values, y);
        const actual = index.queryY(y)!;
        expect(actual.index).toBe(expected.index);
        expect(actual.blockTop).toBeCloseTo(expected.blockTop, 7);
        expect(actual.blockHeight).toBeCloseTo(expected.blockHeight, 7);
        expect(actual.offsetWithinBlock).toBeCloseTo(expected.offsetWithinBlock, 7);
      }
    }
    expect(index.totalHeight).toBeCloseTo(values.reduce((sum, value) => sum + value, 0), 7);
  });

  it("supports very large finite heights", () => {
    const index = new MarkdownHeightIndex("large", [Number.MAX_SAFE_INTEGER / 4, 0.5, 1_000_000_000]);
    expect(Number.isFinite(index.totalHeight)).toBe(true);
    expect(index.queryY(index.offsetOf(2))).toMatchObject({ index: 2 });
  });

  it("keeps million-block queries and point updates within logarithmic budgets", () => {
    const values = new Float64Array(1_000_000);
    values.fill(24);
    const buildStartedAt = performance.now();
    const index = new MarkdownHeightIndex("million", values);
    const buildMs = performance.now() - buildStartedAt;
    const random = prng(12345);
    let checksum = 0;
    const queryStartedAt = performance.now();
    for (let count = 0; count < 100_000; count += 1) {
      const result = index.queryY(random() * index.totalHeight)!;
      checksum += result.index;
    }
    const queryMs = performance.now() - queryStartedAt;
    const updateStartedAt = performance.now();
    for (let count = 0; count < 10_000; count += 1) {
      index.update(Math.floor(random() * index.length), 20 + random() * 20, { kind: "measured" });
    }
    const updateMs = performance.now() - updateStartedAt;

    expect(checksum).toBeGreaterThan(0);
    expect(index.measuredCount()).toBeGreaterThan(9000);
    expect(buildMs).toBeLessThan(2000);
    expect(queryMs).toBeLessThan(3000);
    expect(updateMs).toBeLessThan(1000);
  }, 15_000);

  it("validates heights, indices, ranges, and Y", () => {
    expect(() => new MarkdownHeightIndex("", [])).toThrow(/revision/u);
    expect(() => new MarkdownHeightIndex("r1", [-1])).toThrow(/Height/u);
    const index = new MarkdownHeightIndex("r1", [10]);
    expect(() => index.heightAt(1)).toThrow(RangeError);
    expect(() => index.offsetOf(2)).toThrow(RangeError);
    expect(() => index.rangeHeight(1, 0)).toThrow(RangeError);
    expect(() => index.update(0, Number.NaN)).toThrow(/Height/u);
    expect(() => index.queryY(Number.POSITIVE_INFINITY)).toThrow(/finite/u);
  });
});

function naiveQuery(values: readonly number[], y: number) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const target = Math.max(0, Math.min(y, total));
  let top = 0;
  for (let index = 0; index < values.length; index += 1) {
    const end = top + values[index];
    if (target < end || index === values.length - 1) {
      return {
        index,
        blockTop: top,
        blockHeight: values[index],
        offsetWithinBlock: Math.max(0, Math.min(values[index], target - top)),
      };
    }
    top = end;
  }
  throw new Error("naive model is empty");
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
