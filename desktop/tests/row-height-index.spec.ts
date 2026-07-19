import { describe, expect, it } from "vitest";

import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";

describe("DiffRowHeightIndex", () => {
  it("supports empty, single-row and exact pane boundaries", () => {
    const empty = new DiffRowHeightIndex(0, 20);
    expect(empty.totalHeight).toBe(0);
    expect(empty.rowToOffset(0)).toBe(0);
    expect(empty.locateOffset(0)).toEqual({ rowIndex: 0, rowOffset: 0, rowFraction: 1 });

    const one = new DiffRowHeightIndex(1, 20);
    expect(one.rowToOffset(0)).toBe(0);
    expect(one.rowToOffset(1)).toBe(20);
    expect(one.locateOffset(10)).toEqual({ rowIndex: 0, rowOffset: 10, rowFraction: 0.5 });
    expect(one.offsetToRow(20)).toBe(1);
  });

  it("uses half-open row boundaries and preserves sub-pixel precision", () => {
    const index = new DiffRowHeightIndex(3, [10.25, 20.5, 30.75]);
    expect(index.totalHeight).toBeCloseTo(61.5);
    expect(index.offsetToRow(0)).toBe(0);
    expect(index.offsetToRow(10.249)).toBe(0);
    expect(index.offsetToRow(10.25)).toBe(1);
    expect(index.locateOffset(20.5)).toMatchObject({ rowIndex: 1, rowOffset: 10.25, rowFraction: 0.5 });
    expect(index.offsetToRow(61.5)).toBe(3);
  });

  it("keeps measured overrides while estimates change and can clear them", () => {
    const index = new DiffRowHeightIndex(3, 20);
    expect(index.setMeasuredHeight(1, 42)).toBe(22);
    expect(index.isMeasured(1)).toBe(true);
    expect(index.totalHeight).toBe(82);
    expect(index.replaceEstimatedHeights(24)).toBe(8);
    expect([0, 1, 2].map((row) => index.heightAt(row))).toEqual([24, 42, 24]);
    expect(index.clearMeasuredHeight(1)).toBe(-18);
    expect(index.totalHeight).toBe(72);
    index.setMeasuredHeights([{ rowIndex: 0, height: 25 }, { rowIndex: 2, height: 27 }]);
    expect(index.clearMeasurements()).toBe(-4);
    expect(index.totalHeight).toBe(72);
  });

  it("matches a naive 100k-row prefix model across deterministic random updates and queries", () => {
    const rowCount = 100_000;
    const heights = Array.from({ length: rowCount }, (_, index) => 18 + (index % 7) * 0.25);
    const index = new DiffRowHeightIndex(rowCount, heights);
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const row = Math.floor(random() * rowCount);
      const next = 12 + random() * 48;
      heights[row] = next;
      index.setMeasuredHeight(row, next);
    }
    const prefix = new Float64Array(rowCount + 1);
    for (let row = 0; row < rowCount; row += 1) prefix[row + 1] = prefix[row]! + heights[row]!;
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const row = Math.floor(random() * (rowCount + 1));
      expect(index.rowToOffset(row)).toBeCloseTo(prefix[row]!, 7);
      const offset = random() * prefix[rowCount]!;
      let low = 0;
      let high = rowCount;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (prefix[middle + 1]! <= offset) low = middle + 1;
        else high = middle;
      }
      expect(index.offsetToRow(offset)).toBe(low);
    }
  });

  it("validates counts, heights, rows and offsets", () => {
    expect(() => new DiffRowHeightIndex(-1, 20)).toThrow(TypeError);
    expect(() => new DiffRowHeightIndex(2, [20])).toThrow(RangeError);
    expect(() => new DiffRowHeightIndex(1, 0)).toThrow(TypeError);
    const index = new DiffRowHeightIndex(2, 20);
    expect(() => index.heightAt(2)).toThrow(RangeError);
    expect(() => index.rowToOffset(3)).toThrow(RangeError);
    expect(() => index.locateOffset(Number.NaN)).toThrow(TypeError);
    expect(() => index.setMeasuredHeight(0, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
