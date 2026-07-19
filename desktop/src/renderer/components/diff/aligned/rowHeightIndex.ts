export interface DiffRowOffsetLocation {
  /** `rowIndex === length` represents the exact end of the pane. */
  readonly rowIndex: number;
  readonly rowOffset: number;
  readonly rowFraction: number;
}

export interface DiffRowHeightUpdate {
  readonly rowIndex: number;
  readonly height: number;
}

/** Fenwick prefix sums keep lookups and ResizeObserver updates at O(log n). */
export class DiffRowHeightIndex {
  readonly length: number;
  private readonly estimates: number[];
  private readonly heights: number[];
  private readonly measured = new Set<number>();
  private readonly tree: Float64Array;

  constructor(rowCount: number, estimatedHeight: number | readonly number[]) {
    if (!Number.isInteger(rowCount) || rowCount < 0) {
      throw new TypeError("rowCount must be a non-negative integer");
    }
    this.length = rowCount;
    this.estimates = normalizeEstimates(rowCount, estimatedHeight);
    this.heights = [...this.estimates];
    this.tree = new Float64Array(rowCount + 1);
    for (let index = 0; index < rowCount; index += 1) this.add(index, this.heights[index]!);
  }

  get totalHeight(): number {
    return this.prefix(this.length);
  }

  heightAt(rowIndex: number): number {
    this.assertRow(rowIndex);
    return this.heights[rowIndex]!;
  }

  isMeasured(rowIndex: number): boolean {
    this.assertRow(rowIndex);
    return this.measured.has(rowIndex);
  }

  rowToOffset(rowIndex: number): number {
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > this.length) {
      throw new RangeError("rowIndex must be inside the pane boundary");
    }
    return this.prefix(rowIndex);
  }

  offsetToRow(offset: number): number {
    return this.locateOffset(offset).rowIndex;
  }

  locateOffset(offset: number): DiffRowOffsetLocation {
    if (!Number.isFinite(offset)) throw new TypeError("offset must be finite");
    if (this.length === 0 || offset >= this.totalHeight) {
      return Object.freeze({ rowIndex: this.length, rowOffset: 0, rowFraction: 1 });
    }
    if (offset <= 0) return Object.freeze({ rowIndex: 0, rowOffset: 0, rowFraction: 0 });

    let treeIndex = 0;
    let prefix = 0;
    let bit = highestPowerOfTwoAtMost(this.length);
    while (bit !== 0) {
      const candidate = treeIndex + bit;
      if (candidate <= this.length && prefix + this.tree[candidate]! <= offset) {
        treeIndex = candidate;
        prefix += this.tree[candidate]!;
      }
      bit >>>= 1;
    }
    const rowIndex = Math.min(treeIndex, this.length - 1);
    const height = this.heights[rowIndex]!;
    const rowOffset = Math.min(height, Math.max(0, offset - prefix));
    return Object.freeze({ rowIndex, rowOffset, rowFraction: rowOffset / height });
  }

  setMeasuredHeight(rowIndex: number, height: number): number {
    this.assertRow(rowIndex);
    assertHeight(height);
    this.measured.add(rowIndex);
    return this.replaceHeight(rowIndex, height);
  }

  setMeasuredHeights(updates: readonly DiffRowHeightUpdate[]): number {
    let totalDelta = 0;
    for (const { rowIndex, height } of updates) totalDelta += this.setMeasuredHeight(rowIndex, height);
    return totalDelta;
  }

  clearMeasuredHeight(rowIndex: number): number {
    this.assertRow(rowIndex);
    this.measured.delete(rowIndex);
    return this.replaceHeight(rowIndex, this.estimates[rowIndex]!);
  }

  setEstimatedHeight(rowIndex: number, height: number): number {
    this.assertRow(rowIndex);
    assertHeight(height);
    this.estimates[rowIndex] = height;
    return this.measured.has(rowIndex) ? 0 : this.replaceHeight(rowIndex, height);
  }

  replaceEstimatedHeights(estimatedHeight: number | readonly number[]): number {
    const next = normalizeEstimates(this.length, estimatedHeight);
    let totalDelta = 0;
    for (let index = 0; index < this.length; index += 1) {
      this.estimates[index] = next[index]!;
      if (!this.measured.has(index)) totalDelta += this.replaceHeight(index, next[index]!);
    }
    return totalDelta;
  }

  clearMeasurements(): number {
    let totalDelta = 0;
    for (const rowIndex of this.measured) {
      totalDelta += this.replaceHeight(rowIndex, this.estimates[rowIndex]!);
    }
    this.measured.clear();
    return totalDelta;
  }

  private replaceHeight(rowIndex: number, height: number): number {
    const delta = height - this.heights[rowIndex]!;
    if (delta === 0) return 0;
    this.heights[rowIndex] = height;
    this.add(rowIndex, delta);
    return delta;
  }

  private add(rowIndex: number, delta: number): void {
    for (let index = rowIndex + 1; index <= this.length; index += index & -index) {
      this.tree[index] = this.tree[index]! + delta;
    }
  }

  private prefix(rowCount: number): number {
    let total = 0;
    for (let index = rowCount; index > 0; index -= index & -index) total += this.tree[index]!;
    return total;
  }

  private assertRow(rowIndex: number): void {
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= this.length) {
      throw new RangeError("rowIndex must identify an existing row");
    }
  }
}

function normalizeEstimates(rowCount: number, value: number | readonly number[]): number[] {
  if (typeof value === "number") {
    assertHeight(value);
    return Array.from({ length: rowCount }, () => value);
  }
  if (value.length !== rowCount) throw new RangeError("estimated height count must match rowCount");
  return value.map((height) => {
    assertHeight(height);
    return height;
  });
}

function assertHeight(height: number): void {
  if (!Number.isFinite(height) || height <= 0) throw new TypeError("row height must be positive");
}

function highestPowerOfTwoAtMost(value: number): number {
  return value <= 0 ? 0 : 2 ** Math.floor(Math.log2(value));
}
