export type MarkdownHeightKind = "estimated" | "measured";

export interface MarkdownHeightUpdate {
  readonly index: number;
  readonly height: number;
  readonly kind?: MarkdownHeightKind;
}

export interface MarkdownHeightQueryResult {
  readonly index: number;
  readonly blockTop: number;
  readonly blockHeight: number;
  readonly offsetWithinBlock: number;
}

export class MarkdownHeightIndex {
  private heights = new Float64Array(0);
  private tree = new Float64Array(1);
  private measured = new Uint8Array(0);
  private currentRevision: string;

  constructor(revision: string, heights: ArrayLike<number> = []) {
    this.currentRevision = requiredRevision(revision);
    this.reset(revision, heights);
  }

  get revision(): string {
    return this.currentRevision;
  }

  get length(): number {
    return this.heights.length;
  }

  get totalHeight(): number {
    return this.prefixSum(this.length);
  }

  reset(revision: string, values: ArrayLike<number>, kind: MarkdownHeightKind = "estimated"): void {
    this.currentRevision = requiredRevision(revision);
    const length = values.length;
    this.heights = new Float64Array(length);
    this.tree = new Float64Array(length + 1);
    this.measured = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      const height = validHeight(values[index]);
      this.heights[index] = height;
      this.tree[index + 1] += height;
      const parent = index + 1 + ((index + 1) & -(index + 1));
      if (parent <= length) this.tree[parent] += this.tree[index + 1];
      this.measured[index] = kind === "measured" ? 1 : 0;
    }
  }

  heightAt(index: number): number {
    return this.heights[this.validIndex(index)];
  }

  kindAt(index: number): MarkdownHeightKind {
    return this.measured[this.validIndex(index)] ? "measured" : "estimated";
  }

  offsetOf(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`Height index offset ${index} is out of range`);
    }
    return this.prefixSum(index);
  }

  rangeHeight(start: number, end: number): number {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > this.length) {
      throw new RangeError(`Height range ${start}..${end} is invalid`);
    }
    return this.prefixSum(end) - this.prefixSum(start);
  }

  update(
    index: number,
    height: number,
    options: { readonly kind?: MarkdownHeightKind; readonly revision?: string } = {},
  ): number {
    this.assertRevision(options.revision);
    const safeIndex = this.validIndex(index);
    const next = validHeight(height);
    const previous = this.heights[safeIndex];
    const delta = next - previous;
    if (delta !== 0) {
      this.heights[safeIndex] = next;
      for (let treeIndex = safeIndex + 1; treeIndex <= this.length; treeIndex += treeIndex & -treeIndex) {
        this.tree[treeIndex] += delta;
      }
    }
    if (options.kind) this.measured[safeIndex] = options.kind === "measured" ? 1 : 0;
    return delta;
  }

  updateBatch(
    updates: readonly MarkdownHeightUpdate[],
    options: { readonly revision?: string } = {},
  ): number {
    this.assertRevision(options.revision);
    let totalDelta = 0;
    for (const update of updates) {
      totalDelta += this.update(update.index, update.height, {
        kind: update.kind,
        revision: options.revision,
      });
    }
    return totalDelta;
  }

  queryY(y: number): MarkdownHeightQueryResult | null {
    if (this.length === 0) return null;
    if (!Number.isFinite(y)) throw new Error("Y must be finite");
    const total = this.totalHeight;
    const target = Math.max(0, Math.min(y, total));
    let index: number;
    if (target >= total) {
      index = this.length - 1;
    } else {
      index = this.lowerBound(target);
    }
    const blockTop = this.prefixSum(index);
    const blockHeight = this.heights[index];
    return Object.freeze({
      index,
      blockTop,
      blockHeight,
      offsetWithinBlock: Math.max(0, Math.min(blockHeight, target - blockTop)),
    });
  }

  cloneHeights(): Float64Array {
    return this.heights.slice();
  }

  measuredCount(): number {
    let count = 0;
    for (let index = 0; index < this.measured.length; index += 1) count += this.measured[index];
    return count;
  }

  private lowerBound(target: number): number {
    let treeIndex = 0;
    let prefix = 0;
    let step = highestPowerOfTwoAtMost(this.length);
    while (step !== 0) {
      const next = treeIndex + step;
      if (next <= this.length && prefix + this.tree[next] <= target) {
        treeIndex = next;
        prefix += this.tree[next];
      }
      step >>>= 1;
    }
    return Math.min(treeIndex, this.length - 1);
  }

  private prefixSum(count: number): number {
    let sum = 0;
    for (let index = count; index > 0; index -= index & -index) sum += this.tree[index];
    return sum;
  }

  private validIndex(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(`Height index ${index} is out of range`);
    }
    return index;
  }

  private assertRevision(revision?: string): void {
    if (revision !== undefined && revision !== this.currentRevision) {
      throw new Error(`Stale height revision ${revision}; current revision is ${this.currentRevision}`);
    }
  }
}

function highestPowerOfTwoAtMost(value: number): number {
  if (value <= 0) return 0;
  return 2 ** Math.floor(Math.log2(value));
}

function validHeight(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Height must be finite and non-negative");
  return value;
}

function requiredRevision(value: string): string {
  if (!value.trim()) throw new Error("Height revision is required");
  return value;
}
