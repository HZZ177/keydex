import { MarkdownHeightIndex } from "../layout/HeightIndex";

export interface MarkdownViewportInput {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly overscanPx?: number;
  readonly pinnedIndices?: ReadonlySet<number> | readonly number[];
  /**
   * Optional sorted Snapshot indices which are allowed to participate in the
   * rendered window. Folded sections keep their hidden rows at zero height in
   * HeightIndex, while this projection prevents a range spanning the section
   * from mounting every zero-height child.
   */
  readonly includedIndices?: readonly number[];
  readonly revision?: string;
}

export interface MarkdownViewportRange {
  readonly start: number;
  readonly end: number;
}

export interface MarkdownViewportItem {
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly visible: boolean;
  readonly pinned: boolean;
}

export interface MarkdownViewportResult {
  readonly revision: string;
  readonly requestedScrollTop: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly totalHeight: number;
  readonly direction: "up" | "down" | "none";
  readonly visibleRange: MarkdownViewportRange;
  readonly overscanRange: MarkdownViewportRange;
  readonly renderRanges: readonly MarkdownViewportRange[];
  readonly items: readonly MarkdownViewportItem[];
  readonly mount: readonly number[];
  readonly unmount: readonly number[];
  readonly retained: readonly number[];
  readonly topSpacer: number;
  readonly bottomSpacer: number;
}

export interface MarkdownViewportControllerOptions {
  readonly defaultOverscanPx?: number;
  readonly maxPinnedBlocks?: number;
}

export class MarkdownViewportController {
  private index: MarkdownHeightIndex;
  private readonly defaultOverscanPx: number;
  private readonly maxPinnedBlocks: number;
  private mounted = new Set<number>();
  private previousScrollTop: number | null = null;

  constructor(index: MarkdownHeightIndex, options: MarkdownViewportControllerOptions = {}) {
    this.index = index;
    this.defaultOverscanPx = finiteNonNegative(options.defaultOverscanPx ?? 600, "defaultOverscanPx");
    this.maxPinnedBlocks = positiveInteger(options.maxPinnedBlocks ?? 64, "maxPinnedBlocks");
  }

  update(input: MarkdownViewportInput): MarkdownViewportResult {
    this.assertRevision(input.revision);
    const requestedScrollTop = finite(input.scrollTop, "scrollTop");
    const viewportHeight = finiteNonNegative(input.viewportHeight, "viewportHeight");
    const overscanPx = finiteNonNegative(input.overscanPx ?? this.defaultOverscanPx, "overscanPx");
    const totalHeight = this.index.totalHeight;
    const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
    const scrollTop = Math.max(0, Math.min(requestedScrollTop, maxScrollTop));
    const direction = this.previousScrollTop === null || scrollTop === this.previousScrollTop
      ? "none"
      : scrollTop > this.previousScrollTop
        ? "down"
        : "up";
    this.previousScrollTop = scrollTop;

    const visibleRange = this.rangeForY(scrollTop, Math.min(totalHeight, scrollTop + viewportHeight));
    const overscanRange = this.rangeForY(
      Math.max(0, scrollTop - overscanPx),
      Math.min(totalHeight, scrollTop + viewportHeight + overscanPx),
    );
    const included = this.normalizeIncluded(input.includedIndices);
    const pinned = this.normalizePinned(input.pinnedIndices);
    const renderIndices = new Set<number>();
    if (included) {
      const start = lowerBound(included, overscanRange.start);
      for (let cursor = start; cursor < included.length; cursor += 1) {
        const index = included[cursor]!;
        if (index >= overscanRange.end) break;
        renderIndices.add(index);
      }
    } else {
      for (let index = overscanRange.start; index < overscanRange.end; index += 1) renderIndices.add(index);
    }
    pinned.forEach((index) => {
      if (!included || binaryIncludes(included, index)) renderIndices.add(index);
    });
    const ordered = [...renderIndices].sort((left, right) => left - right);
    const renderRanges = rangesFromIndices(ordered);
    const items: MarkdownViewportItem[] = [];
    for (const index of ordered) {
      const height = this.index.heightAt(index);
      items.push(Object.freeze({
        index,
        top: this.index.offsetOf(index),
        height,
        visible: index >= visibleRange.start && index < visibleRange.end,
        pinned: pinned.has(index),
      }));
    }
    const mount = ordered.filter((index) => !this.mounted.has(index));
    const retained = ordered.filter((index) => this.mounted.has(index));
    const unmount = [...this.mounted].filter((index) => !renderIndices.has(index)).sort((a, b) => a - b);
    this.mounted = renderIndices;
    const first = ordered[0];
    const last = ordered.at(-1);
    return Object.freeze({
      revision: this.index.revision,
      requestedScrollTop,
      scrollTop,
      viewportHeight,
      totalHeight,
      direction,
      visibleRange,
      overscanRange,
      renderRanges,
      items: Object.freeze(items),
      mount: Object.freeze(mount),
      unmount: Object.freeze(unmount),
      retained: Object.freeze(retained),
      topSpacer: first === undefined ? 0 : this.index.offsetOf(first),
      bottomSpacer: last === undefined ? totalHeight : totalHeight - this.index.offsetOf(last + 1),
    });
  }

  reset(index: MarkdownHeightIndex): readonly number[] {
    const unmount = Object.freeze([...this.mounted].sort((left, right) => left - right));
    this.index = index;
    this.mounted.clear();
    this.previousScrollTop = null;
    return unmount;
  }

  mountedIndices(): readonly number[] {
    return Object.freeze([...this.mounted].sort((left, right) => left - right));
  }

  dispose(): readonly number[] {
    const unmount = this.mountedIndices();
    this.mounted.clear();
    this.previousScrollTop = null;
    return unmount;
  }

  private rangeForY(startY: number, endY: number): MarkdownViewportRange {
    if (this.index.length === 0) return EMPTY_RANGE;
    const startResult = this.index.queryY(startY);
    if (!startResult) return EMPTY_RANGE;
    let end: number;
    if (endY >= this.index.totalHeight) {
      end = this.index.length;
    } else if (endY <= startY) {
      end = Math.min(this.index.length, startResult.index + 1);
    } else {
      const endResult = this.index.queryY(endY)!;
      end = nearlyEqual(endResult.blockTop, endY) ? endResult.index : endResult.index + 1;
    }
    return Object.freeze({ start: startResult.index, end: Math.max(startResult.index + 1, end) });
  }

  private normalizePinned(input?: ReadonlySet<number> | readonly number[]): ReadonlySet<number> {
    const normalized = new Set<number>(input ?? []);
    if (normalized.size > this.maxPinnedBlocks) {
      throw new Error(`Pinned Markdown blocks exceed limit ${this.maxPinnedBlocks}`);
    }
    for (const index of normalized) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.index.length) {
        throw new RangeError(`Pinned block ${index} is out of range`);
      }
    }
    return normalized;
  }

  private normalizeIncluded(input?: readonly number[]): readonly number[] | null {
    if (input === undefined) return null;
    let previous = -1;
    for (const index of input) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.index.length) {
        throw new RangeError(`Included block ${index} is out of range`);
      }
      if (index <= previous) throw new Error("Included Markdown block indices must be strictly ordered");
      previous = index;
    }
    return input;
  }

  private assertRevision(revision?: string): void {
    if (revision !== undefined && revision !== this.index.revision) {
      throw new Error(`Stale viewport revision ${revision}; current revision is ${this.index.revision}`);
    }
  }
}

function rangesFromIndices(indices: readonly number[]): readonly MarkdownViewportRange[] {
  if (!indices.length) return Object.freeze([]);
  const ranges: MarkdownViewportRange[] = [];
  let start = indices[0];
  let previous = indices[0];
  for (const index of indices.slice(1)) {
    if (index !== previous + 1) {
      ranges.push(Object.freeze({ start, end: previous + 1 }));
      start = index;
    }
    previous = index;
  }
  ranges.push(Object.freeze({ start, end: previous + 1 }));
  return Object.freeze(ranges);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(right)) * 1e-10;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const EMPTY_RANGE = Object.freeze({ start: 0, end: 0 });

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function binaryIncludes(values: readonly number[], target: number): boolean {
  const index = lowerBound(values, target);
  return index < values.length && values[index] === target;
}
