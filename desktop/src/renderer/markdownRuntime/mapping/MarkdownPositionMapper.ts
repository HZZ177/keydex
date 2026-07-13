import type {
  MarkdownSnapshot,
  MarkdownSnapshotBlock,
  MarkdownSnapshotInlineSpan,
} from "../document/MarkdownSnapshot";
import type { MarkdownHeightIndex } from "../layout/HeightIndex";
import type { MarkdownBlockSourceMap } from "../renderers";

export type MarkdownMappingStatus = "exact" | "estimated" | "unmapped";
export type MarkdownSourceAffinity = "inside" | "next-block" | "previous-block";
export type MarkdownMappingFailure =
  | "source-out-of-range"
  | "logical-out-of-range"
  | "line-out-of-range"
  | "empty-document"
  | "block-not-mounted"
  | "dom-outside-document"
  | "dom-position-not-semantic"
  | "dom-range-unavailable";

export interface MarkdownDomLocalPosition {
  readonly node: Node;
  readonly offset: number;
  readonly range: Range;
  readonly rect: DOMRectReadOnly;
  readonly blockRect: DOMRectReadOnly;
  readonly localX: number;
  readonly localY: number;
  readonly rectPrecision: "caret" | "block-fallback";
}

export interface MarkdownMappedPosition {
  readonly status: MarkdownMappingStatus;
  readonly reason: MarkdownMappingFailure | null;
  readonly revision: string;
  readonly sourceOffset: number | null;
  readonly sourceLine: number | null;
  readonly sourceColumn: number | null;
  readonly logicalOffset: number | null;
  readonly blockId: string | null;
  readonly blockIndex: number | null;
  readonly blockLocalLogicalOffset: number | null;
  readonly affinity: MarkdownSourceAffinity | null;
  readonly estimatedY: number | null;
  readonly dom: MarkdownDomLocalPosition | null;
}

export interface MarkdownMappedRange {
  readonly status: MarkdownMappingStatus;
  readonly reason: MarkdownMappingFailure | null;
  readonly start: MarkdownMappedPosition;
  readonly end: MarkdownMappedPosition;
  readonly range: Range | null;
  readonly rects: readonly DOMRectReadOnly[];
}

export interface MarkdownMountedBlockResolver {
  getBlockElement(blockId: string): HTMLElement | null;
  getBlockSourceMap?(blockId: string): MarkdownBlockSourceMap | null;
  getBlockIndex?(blockId: string): number | null;
}

export interface MarkdownPositionMapperOptions {
  readonly heightIndex?: MarkdownHeightIndex | null;
  readonly mounted?: MarkdownMountedBlockResolver | null;
}

export class MarkdownPositionMapper {
  private lineStarts: readonly number[] | null = null;
  private blockIndexById: ReadonlyMap<string, number> | null = null;
  private readonly heightIndex: MarkdownHeightIndex | null;
  private readonly mounted: MarkdownMountedBlockResolver | null;

  constructor(
    readonly source: string,
    readonly snapshot: MarkdownSnapshot,
    options: MarkdownPositionMapperOptions = {},
  ) {
    if (source.length !== snapshot.source_characters) {
      throw new Error(`Markdown source length ${source.length} does not match Snapshot ${snapshot.source_characters}`);
    }
    if (options.heightIndex && (options.heightIndex.length !== snapshot.blocks.length
      || options.heightIndex.revision !== snapshot.revision)) {
      throw new Error("Markdown mapping HeightIndex does not match the Snapshot");
    }
    this.heightIndex = options.heightIndex ?? null;
    this.mounted = options.mounted ?? null;
  }

  blockIndex(blockId: string): number | null {
    const mountedIndex = this.mounted?.getBlockIndex?.(blockId);
    if (mountedIndex !== undefined) return mountedIndex;
    this.blockIndexById ??= new Map(this.snapshot.blocks.map((block) => [block.id, block.index]));
    return this.blockIndexById.get(blockId) ?? null;
  }

  sourceOffset(offset: number): MarkdownMappedPosition {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.source.length) {
      return this.unmapped("source-out-of-range", Number.isFinite(offset) ? offset : null);
    }
    const resolved = blockForSourceOffset(this.snapshot.blocks, offset, this.source.length);
    if (!resolved) return this.unmapped("empty-document", offset);
    const logicalOffset = resolved.affinity === "inside"
      ? sourceToLogical(resolved.block, offset)
      : resolved.affinity === "next-block"
        ? resolved.block.logical_start
        : resolved.block.logical_end;
    return this.mapped(resolved.block, logicalOffset, offset, resolved.affinity);
  }

  sourceLine(line: number, column = 1): MarkdownMappedPosition {
    const lineStarts = this.sourceLineStarts();
    if (!Number.isSafeInteger(line) || line < 1 || line > lineStarts.length
      || !Number.isSafeInteger(column) || column < 1) {
      return this.unmapped("line-out-of-range", null);
    }
    const start = lineStarts[line - 1]!;
    const end = lineStarts[line] ?? this.source.length;
    const contentEnd = end > start && this.source[end - 1] === "\n" ? end - 1 : end;
    const sourceOffset = Math.min(contentEnd, start + column - 1);
    const mapped = this.sourceOffset(sourceOffset);
    return Object.freeze({
      ...mapped,
      sourceLine: line,
      sourceColumn: sourceOffset - start + 1,
    });
  }

  logicalOffset(offset: number): MarkdownMappedPosition {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.snapshot.logical_text.length) {
      return this.unmapped("logical-out-of-range", null);
    }
    const resolved = blockForLogicalOffset(this.snapshot.blocks, offset, this.snapshot.logical_text.length);
    if (!resolved) return this.unmapped("empty-document", null);
    const logical = resolved.affinity === "next-block"
      ? resolved.block.logical_start
      : resolved.affinity === "previous-block"
        ? resolved.block.logical_end
        : offset;
    return this.mapped(resolved.block, logical, logicalToSource(resolved.block, logical), resolved.affinity);
  }

  blockLocal(blockId: string, blockLocalLogicalOffset: number): MarkdownMappedPosition {
    const blockIndex = this.blockIndex(blockId);
    const block = blockIndex === null ? null : this.snapshot.blocks[blockIndex] ?? null;
    if (!block || !Number.isSafeInteger(blockLocalLogicalOffset)
      || blockLocalLogicalOffset < 0
      || blockLocalLogicalOffset > block.logical_end - block.logical_start) {
      return this.unmapped("logical-out-of-range", null);
    }
    const logical = block.logical_start + blockLocalLogicalOffset;
    return this.mapped(block, logical, logicalToSource(block, logical), "inside");
  }

  domPosition(node: Node, offset: number): MarkdownMappedPosition {
    const root = closestBlockElement(node);
    if (!root || !this.mounted) return this.unmapped("dom-outside-document", null);
    const blockId = root.dataset.markdownBlockId ?? "";
    const blockIndex = this.blockIndex(blockId);
    const block = blockIndex === null ? null : this.snapshot.blocks[blockIndex] ?? null;
    if (!block || this.mounted.getBlockElement(blockId) !== root) {
      return this.unmapped("dom-outside-document", null);
    }
    const logical = logicalOffsetForDomPoint(root, block, this.snapshot.logical_text, node, offset);
    if (logical === null) return this.unmapped("dom-position-not-semantic", null);
    return this.mapped(block, logical, logicalToSource(block, logical), "inside");
  }

  sourceRange(sourceStart: number, sourceEnd: number): MarkdownMappedRange {
    if (!Number.isSafeInteger(sourceStart) || !Number.isSafeInteger(sourceEnd)
      || sourceStart < 0 || sourceEnd < sourceStart || sourceEnd > this.source.length) {
      const failed = this.unmapped("source-out-of-range", null);
      return Object.freeze({ status: "unmapped", reason: "source-out-of-range", start: failed, end: failed, range: null, rects: [] });
    }
    const start = this.sourceOffset(sourceStart);
    const end = this.sourceOffset(sourceEnd);
    if (start.status === "unmapped" || end.status === "unmapped") {
      return Object.freeze({ status: "unmapped", reason: start.reason ?? end.reason, start, end, range: null, rects: [] });
    }
    if (!start.dom || !end.dom) {
      return Object.freeze({ status: "estimated", reason: "block-not-mounted", start, end, range: null, rects: [] });
    }
    try {
      const range = start.dom.range.cloneRange();
      range.setEnd(end.dom.node, end.dom.offset);
      const rects = typeof range.getClientRects === "function" ? Object.freeze([...range.getClientRects()]) : [];
      return Object.freeze({ status: "exact", reason: null, start, end, range, rects });
    } catch {
      return Object.freeze({ status: "estimated", reason: "dom-range-unavailable", start, end, range: null, rects: [] });
    }
  }

  private mapped(
    block: MarkdownSnapshotBlock,
    logicalOffset: number,
    sourceOffset: number,
    affinity: MarkdownSourceAffinity,
  ): MarkdownMappedPosition {
    const dom = this.domLocal(block, logicalOffset);
    const lineColumn = lineColumnAtBlockOffset(this.source, block, sourceOffset);
    return Object.freeze({
      status: dom ? "exact" : "estimated",
      reason: dom ? null : "block-not-mounted",
      revision: this.snapshot.revision,
      sourceOffset,
      sourceLine: lineColumn.line,
      sourceColumn: lineColumn.column,
      logicalOffset,
      blockId: block.id,
      blockIndex: block.index,
      blockLocalLogicalOffset: logicalOffset - block.logical_start,
      affinity,
      estimatedY: this.estimatedY(block, logicalOffset),
      dom,
    });
  }

  private domLocal(block: MarkdownSnapshotBlock, logicalOffset: number): MarkdownDomLocalPosition | null {
    const element = this.mounted?.getBlockElement(block.id);
    if (!element) return null;
    const sourceMap = this.mounted?.getBlockSourceMap?.(block.id) ?? null;
    const point = domPointForLogicalOffset(
      element,
      block,
      this.snapshot.logical_text,
      logicalOffset,
      sourceMap,
    );
    if (!point) return null;
    const range = element.ownerDocument.createRange();
    try {
      range.setStart(point.node, point.offset);
      range.collapse(true);
    } catch {
      return null;
    }
    const blockRect = element.getBoundingClientRect();
    const caretRect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    const rect = caretRect ?? blockRect;
    return Object.freeze({
      node: point.node,
      offset: point.offset,
      range,
      rect,
      blockRect,
      localX: rect.left - blockRect.left,
      localY: rect.top - blockRect.top,
      rectPrecision: caretRect ? "caret" : "block-fallback",
    });
  }

  private estimatedY(block: MarkdownSnapshotBlock, logicalOffset: number): number | null {
    if (!this.heightIndex) return null;
    const height = this.heightIndex.heightAt(block.index);
    const logicalLength = Math.max(1, block.logical_end - block.logical_start);
    const ratio = Math.max(0, Math.min(1, (logicalOffset - block.logical_start) / logicalLength));
    return this.heightIndex.offsetOf(block.index) + ratio * height;
  }

  private unmapped(reason: MarkdownMappingFailure, sourceOffset: number | null): MarkdownMappedPosition {
    return Object.freeze({
      status: "unmapped",
      reason,
      revision: this.snapshot.revision,
      sourceOffset,
      sourceLine: null,
      sourceColumn: null,
      logicalOffset: null,
      blockId: null,
      blockIndex: null,
      blockLocalLogicalOffset: null,
      affinity: null,
      estimatedY: null,
      dom: null,
    });
  }

  private sourceLineStarts(): readonly number[] {
    return this.lineStarts ??= sourceLineStarts(this.source);
  }
}

function lineColumnAtBlockOffset(
  source: string,
  block: MarkdownSnapshotBlock,
  sourceOffset: number,
): { line: number; column: number } {
  const boundedOffset = Math.max(block.source_start, Math.min(source.length, sourceOffset));
  let line = block.line_start + 1;
  let lineStart = block.source_start;
  for (let index = block.source_start; index < boundedOffset; index += 1) {
    if (source.charCodeAt(index) !== 10) continue;
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: boundedOffset - lineStart + 1 };
}

function sourceToLogical(block: MarkdownSnapshotBlock, sourceOffset: number): number {
  const span = containingSpan(block.inline_spans, "source", sourceOffset);
  if (span) return interpolate(sourceOffset, span.source_start, span.source_end, span.logical_start, span.logical_end);
  const previous = [...block.inline_spans].reverse().find((entry) => entry.source_end <= sourceOffset);
  const next = block.inline_spans.find((entry) => entry.source_start >= sourceOffset);
  if (!previous) return block.logical_start;
  if (!next) return block.logical_end;
  return sourceOffset - previous.source_end < next.source_start - sourceOffset
    ? previous.logical_end
    : next.logical_start;
}

export function markdownSourceOffsetToLogical(
  block: MarkdownSnapshotBlock,
  sourceOffset: number,
): number {
  return sourceToLogical(block, sourceOffset);
}

export type MarkdownBoundaryAffinity = "backward" | "forward";

function logicalToSource(
  block: MarkdownSnapshotBlock,
  logicalOffset: number,
  affinity: MarkdownBoundaryAffinity = "backward",
): number {
  const interior = block.inline_spans.find((entry) => logicalOffset > entry.logical_start && logicalOffset < entry.logical_end);
  if (interior) {
    return interpolate(logicalOffset, interior.logical_start, interior.logical_end, interior.source_start, interior.source_end);
  }
  if (affinity === "forward") {
    const starting = block.inline_spans.find((entry) => entry.logical_start === logicalOffset);
    if (starting) return starting.source_start;
  } else {
    const ending = [...block.inline_spans].reverse().find((entry) => entry.logical_end === logicalOffset);
    if (ending) return ending.source_end;
  }
  const span = containingSpan(block.inline_spans, "logical", logicalOffset);
  if (span) return interpolate(logicalOffset, span.logical_start, span.logical_end, span.source_start, span.source_end);
  const previous = [...block.inline_spans].reverse().find((entry) => entry.logical_end <= logicalOffset);
  const next = block.inline_spans.find((entry) => entry.logical_start >= logicalOffset);
  if (!previous) return block.source_start;
  if (!next) return block.source_end;
  return logicalOffset - previous.logical_end < next.logical_start - logicalOffset
    ? previous.source_end
    : next.source_start;
}

export function markdownLogicalOffsetToSource(
  block: MarkdownSnapshotBlock,
  logicalOffset: number,
  affinity: MarkdownBoundaryAffinity = "backward",
): number {
  return logicalToSource(block, logicalOffset, affinity);
}

function containingSpan(
  spans: readonly MarkdownSnapshotInlineSpan[],
  domain: "source" | "logical",
  offset: number,
): MarkdownSnapshotInlineSpan | null {
  const start = domain === "source" ? "source_start" : "logical_start";
  const end = domain === "source" ? "source_end" : "logical_end";
  return spans.find((span) => offset >= span[start] && offset <= span[end]) ?? null;
}

function blockForSourceOffset(
  blocks: readonly MarkdownSnapshotBlock[],
  offset: number,
  sourceLength: number,
): { block: MarkdownSnapshotBlock; affinity: MarkdownSourceAffinity } | null {
  if (!blocks.length) return null;
  const insertion = upperBound(blocks, offset, (block) => block.source_start);
  const previous = blocks[Math.max(0, insertion - 1)];
  if (previous && offset >= previous.source_start
    && (offset < previous.source_end || (offset === sourceLength && previous.index === blocks.length - 1))) {
    return { block: previous, affinity: "inside" };
  }
  const next = blocks[insertion];
  return next ? { block: next, affinity: "next-block" } : { block: blocks.at(-1)!, affinity: "previous-block" };
}

function blockForLogicalOffset(
  blocks: readonly MarkdownSnapshotBlock[],
  offset: number,
  logicalLength: number,
): { block: MarkdownSnapshotBlock; affinity: MarkdownSourceAffinity } | null {
  if (!blocks.length) return null;
  const insertion = upperBound(blocks, offset, (block) => block.logical_start);
  const previous = blocks[Math.max(0, insertion - 1)];
  if (previous && offset >= previous.logical_start
    && (offset < previous.logical_end || (offset === logicalLength && previous.index === blocks.length - 1))) {
    return { block: previous, affinity: "inside" };
  }
  const next = blocks[insertion];
  return next ? { block: next, affinity: "next-block" } : { block: blocks.at(-1)!, affinity: "previous-block" };
}

function domPointForLogicalOffset(
  root: HTMLElement,
  block: MarkdownSnapshotBlock,
  logicalText: string,
  logicalOffset: number,
  sourceMap: MarkdownBlockSourceMap | null,
): { node: Node; offset: number } | null {
  const inline = sourceMap?.inline.find((entry) => entry.element
    && logicalOffset >= entry.span.logical_start
    && logicalOffset <= entry.span.logical_end);
  if (inline?.element) {
    const local = logicalOffset - inline.span.logical_start;
    const textPoint = textPointAtOffset(inline.element, local);
    if (textPoint) return textPoint;
    const parent = inline.element.parentNode;
    if (parent) {
      const index = [...parent.childNodes].indexOf(inline.element);
      return { node: parent, offset: index + (local > 0 ? 1 : 0) };
    }
  }
  const rangedElement = [...root.querySelectorAll<HTMLElement>(
    "[data-markdown-logical-start][data-markdown-logical-end]",
  )].find((element) => {
    const start = numericDataset(element, "markdownLogicalStart");
    const end = numericDataset(element, "markdownLogicalEnd");
    return start !== null && end !== null && logicalOffset >= start && logicalOffset <= end;
  });
  if (rangedElement) {
    const start = numericDataset(rangedElement, "markdownLogicalStart")!;
    const point = textPointAtOffset(rangedElement, logicalOffset - start);
    if (point) return point;
  }
  const blockText = logicalText.slice(block.logical_start, block.logical_end);
  const local = logicalOffset - block.logical_start;
  const segments = semanticTextSegments(root, blockText);
  for (const segment of segments) {
    if (local >= segment.start && local <= segment.end) {
      return { node: segment.node, offset: Math.min(segment.node.data.length, local - segment.start) };
    }
  }
  if (local <= 0) return { node: root, offset: 0 };
  const last = segments.at(-1);
  return last ? { node: last.node, offset: last.node.data.length } : { node: root, offset: root.childNodes.length };
}

function logicalOffsetForDomPoint(
  root: HTMLElement,
  block: MarkdownSnapshotBlock,
  logicalText: string,
  node: Node,
  offset: number,
): number | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || !root.contains(node)) return null;
  const element = node instanceof Element ? node : node.parentElement;
  if (element?.closest("[data-markdown-selection-exclude]")) return null;
  const blockText = logicalText.slice(block.logical_start, block.logical_end);
  if (node instanceof Text) {
    const rangedElement = node.parentElement?.closest<HTMLElement>(
      "[data-markdown-logical-start][data-markdown-logical-end]",
    );
    if (rangedElement && root.contains(rangedElement)) {
      const start = numericDataset(rangedElement, "markdownLogicalStart");
      const end = numericDataset(rangedElement, "markdownLogicalEnd");
      if (start !== null && end !== null) {
        const local = textOffsetAtPoint(rangedElement, node, offset);
        if (local !== null) return Math.min(end, start + local);
      }
    }
    const segment = semanticTextSegments(root, blockText).find((entry) => entry.node === node);
    if (!segment || offset > node.data.length) return null;
    return block.logical_start + Math.min(segment.end, segment.start + offset);
  }
  if (node instanceof Element && offset <= node.childNodes.length) {
    const next = node.childNodes[offset] as HTMLElement | undefined;
    const previous = node.childNodes[offset - 1] as HTMLElement | undefined;
    const nextStart = numericDataset(next, "markdownLogicalStart");
    if (nextStart !== null) return nextStart;
    const previousEnd = numericDataset(previous, "markdownLogicalEnd");
    if (previousEnd !== null) return previousEnd;
    if (node === root) return offset === 0 ? block.logical_start : block.logical_end;
  }
  return null;
}

function semanticTextSegments(root: HTMLElement, logicalText: string): Array<{ node: Text; start: number; end: number }> {
  const segments: Array<{ node: Text; start: number; end: number }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest("[data-markdown-selection-exclude]")) continue;
    if (!node.data) continue;
    const found = logicalText.indexOf(node.data, cursor);
    if (found < 0) continue;
    segments.push({ node, start: found, end: found + node.data.length });
    cursor = found + node.data.length;
  }
  return segments;
}

function textPointAtOffset(root: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  return null;
}

function textOffsetAtPoint(root: HTMLElement, target: Text, offset: number): number | null {
  if (offset > target.data.length) return null;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest("[data-markdown-selection-exclude]")) continue;
    if (node === target) return total + offset;
    total += node.data.length;
  }
  return null;
}

function closestBlockElement(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-markdown-block-id]") ?? null;
}

function numericDataset(node: HTMLElement | undefined, key: "markdownLogicalStart" | "markdownLogicalEnd"): number | null {
  const value = node?.dataset?.[key];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceLineStarts(source: string): readonly number[] {
  if (!source) return Object.freeze([]);
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n" && index + 1 < source.length) starts.push(index + 1);
  }
  return Object.freeze(starts);
}

function upperBound<T>(values: readonly T[], target: number, select: (value: T) => number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (select(values[middle]!) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function interpolate(value: number, inputStart: number, inputEnd: number, outputStart: number, outputEnd: number): number {
  if (inputEnd <= inputStart) return outputStart;
  const ratio = Math.max(0, Math.min(1, (value - inputStart) / (inputEnd - inputStart)));
  return Math.round(outputStart + ratio * (outputEnd - outputStart));
}
