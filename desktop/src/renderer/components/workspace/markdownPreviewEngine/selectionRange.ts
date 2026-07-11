import { markdownLineColumnAtOffset } from "./sourceMap";
import type { MarkdownSourceRange } from "./types";
import type { MarkdownTextModel } from "@/renderer/features/annotations/document/MarkdownTextModel";
import type { LogicalRange } from "@/renderer/features/annotations/document/DocumentTextModel";

export type MarkdownSelectionSourceRangeFailureReason =
  | "empty-selection"
  | "empty-source-range"
  | "missing-source-segment"
  | "outside-boundary"
  | "source-text-mismatch"
  | "unmapped-source-range";

export interface MarkdownSelectionSourceRange extends MarkdownSourceRange {
  selectedText: string;
  sourceText: string;
}

export interface MarkdownSelectionSourceRangeResult {
  range: MarkdownSelectionSourceRange | null;
  reason: MarkdownSelectionSourceRangeFailureReason | null;
}

export interface MarkdownSelectionLogicalRangeResult {
  range: LogicalRange | null;
  reason: MarkdownSelectionSourceRangeFailureReason | null;
}

const MARKDOWN_SOURCE_SEGMENT_SELECTOR = [
  "[data-markdown-source-start][data-markdown-source-end]",
  "[data-preview-source-start][data-preview-source-end]",
].join(", ");

export function markdownSourceRangeFromDomRange(
  source: string,
  selectionRange: Range,
  boundary: HTMLElement,
): MarkdownSelectionSourceRangeResult {
  if (!boundary.contains(selectionRange.commonAncestorContainer)) {
    return { range: null, reason: "outside-boundary" };
  }
  const selectedText = selectionRange.toString();
  if (!selectedText.trim()) {
    return { range: null, reason: "empty-selection" };
  }
  const allSegments = Array.from(boundary.querySelectorAll<HTMLElement>(MARKDOWN_SOURCE_SEGMENT_SELECTOR));
  const startSegment = markdownSourceSegmentForNode(selectionRange.startContainer, boundary);
  const endSegment = markdownSourceSegmentForNode(selectionRange.endContainer, boundary);
  if (!startSegment || !endSegment) {
    return { range: null, reason: "missing-source-segment" };
  }
  const startIndex = allSegments.indexOf(startSegment);
  const endIndex = allSegments.indexOf(endSegment);
  if (startIndex < 0 || endIndex < 0) {
    return { range: null, reason: "missing-source-segment" };
  }

  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);
  const segments = allSegments.slice(firstIndex, lastIndex + 1);
  let sourceStart: number | null = null;
  let sourceEnd: number | null = null;

  for (const segment of segments) {
    const segmentStart = sourceSegmentStart(segment);
    const segmentEnd = sourceSegmentEnd(segment);
    const textLength = segment.textContent?.length ?? 0;
    if (segmentStart === null || segmentEnd === null || segmentEnd <= segmentStart || textLength <= 0) {
      continue;
    }
    const localStart = segment === startSegment
      ? textOffsetWithinElement(segment, selectionRange.startContainer, selectionRange.startOffset)
      : 0;
    const localEnd = segment === endSegment
      ? textOffsetWithinElement(segment, selectionRange.endContainer, selectionRange.endOffset)
      : textLength;
    const start = Math.max(0, Math.min(localStart, textLength));
    const end = Math.max(start, Math.min(localEnd, textLength));
    if (end <= start) {
      continue;
    }
    sourceStart = sourceStart === null ? segmentStart + start : Math.min(sourceStart, segmentStart + start);
    sourceEnd = sourceEnd === null ? segmentStart + end : Math.max(sourceEnd, Math.min(segmentStart + end, segmentEnd));
  }

  if (sourceStart === null || sourceEnd === null || sourceEnd <= sourceStart) {
    return { range: null, reason: "empty-source-range" };
  }

  const startPosition = markdownLineColumnAtOffset(source, sourceStart);
  const endPosition = markdownLineColumnAtOffset(source, sourceEnd);
  return {
    range: {
      lineEnd: endPosition.line,
      lineStart: startPosition.line,
      selectedText,
      sourceEnd,
      sourceStart,
      sourceText: source.slice(sourceStart, sourceEnd),
    },
    reason: null,
  };
}

export function markdownLogicalRangeFromDomRange(
  model: MarkdownTextModel,
  selectionRange: Range,
  boundary: HTMLElement,
): MarkdownSelectionLogicalRangeResult {
  const sourceResult = markdownSourceRangeFromDomRange(model.rawSource, selectionRange, boundary);
  if (!sourceResult.range) {
    return { range: null, reason: sourceResult.reason };
  }
  const range = model.toLogicalRange({
    start: sourceResult.range.sourceStart,
    end: sourceResult.range.sourceEnd,
  });
  return range
    ? { range, reason: null }
    : { range: null, reason: "unmapped-source-range" };
}

function markdownSourceSegmentForNode(node: Node, boundary: HTMLElement): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const segment = element?.closest<HTMLElement>(MARKDOWN_SOURCE_SEGMENT_SELECTOR) ?? null;
  return segment && boundary.contains(segment) ? segment : null;
}

function sourceSegmentStart(element: HTMLElement): number | null {
  return dataInteger(element.dataset.markdownSourceStart ?? element.dataset.previewSourceStart);
}

function sourceSegmentEnd(element: HTMLElement): number | null {
  return dataInteger(element.dataset.markdownSourceEnd ?? element.dataset.previewSourceEnd);
}

function dataInteger(value: string | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function textOffsetWithinElement(element: HTMLElement, container: Node, offset: number): number {
  if (container === element) {
    let total = 0;
    let child: ChildNode | null = element.firstChild;
    let childIndex = 0;
    while (child && childIndex < offset) {
      total += child.textContent?.length ?? 0;
      child = child.nextSibling;
      childIndex += 1;
    }
    return total;
  }
  let total = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = node.textContent?.length ?? 0;
    if (node === container) {
      return total + Math.max(0, Math.min(offset, length));
    }
    total += length;
  }
  return total;
}
