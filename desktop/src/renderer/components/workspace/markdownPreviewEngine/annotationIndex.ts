import type { MarkdownBlock, MarkdownDocumentModel } from "./types";
import type { ResolvedTextAnnotation } from "@/renderer/features/annotations/domain/resolutions";

export interface MarkdownAnnotationLike {
  id: string;
  updated_at?: string | null;
}

export interface MarkdownAnnotationBlockRange {
  blockId: string;
  blockIndex: number;
  blockLocalEnd: number;
  blockLocalStart: number;
  sourceEnd: number;
  sourceStart: number;
}

export interface MarkdownAnnotationIndexItem<TAnnotation extends MarkdownAnnotationLike = MarkdownAnnotationLike> {
  anchor: { lineEnd: number; lineStart: number } | null;
  annotation: TAnnotation;
  ranges: MarkdownAnnotationBlockRange[];
}

export interface MarkdownAnnotationProjection<TAnnotation extends MarkdownAnnotationLike = MarkdownAnnotationLike> {
  annotation: TAnnotation;
  sourceRanges: readonly { end: number; start: number }[];
}

export function buildMarkdownAnnotationIndex<TAnnotation extends MarkdownAnnotationLike>(
  model: MarkdownDocumentModel,
  projections: readonly MarkdownAnnotationProjection<TAnnotation>[],
): MarkdownAnnotationIndexItem<TAnnotation>[] {
  return projections.map(({ annotation, sourceRanges }) => {
    const ranges = sourceRanges.flatMap((sourceRange) =>
      affectedBlocksForSourceRange(model.blocks, sourceRange.start, sourceRange.end));
    const firstBlock = ranges.length ? model.blocks[ranges[0].blockIndex] : null;
    const lastBlock = ranges.length ? model.blocks[ranges.at(-1)!.blockIndex] : null;
    return {
      anchor: firstBlock && lastBlock ? { lineStart: firstBlock.lineStart, lineEnd: lastBlock.lineEnd } : null,
      annotation,
      ranges,
    };
  });
}

export function buildResolvedMarkdownAnnotationIndex(
  model: MarkdownDocumentModel,
  annotations: readonly ResolvedTextAnnotation[],
): MarkdownAnnotationIndexItem[] {
  return buildMarkdownAnnotationIndex(model, annotations.map((resolution) => ({
    annotation: resolution.record,
    sourceRanges: resolution.projection.sourceRanges,
  })));
}

function affectedBlocksForSourceRange(
  blocks: MarkdownBlock[],
  rangeStart: number,
  rangeEnd: number,
): MarkdownAnnotationBlockRange[] {
  const ranges: MarkdownAnnotationBlockRange[] = [];
  for (const block of blocks) {
    const sourceStart = Math.max(block.sourceStart, rangeStart);
    const sourceEnd = Math.min(block.sourceEnd, rangeEnd);
    if (sourceEnd <= sourceStart) continue;
    ranges.push({
      blockId: block.id,
      blockIndex: block.index,
      blockLocalEnd: sourceEnd - block.sourceStart,
      blockLocalStart: sourceStart - block.sourceStart,
      sourceEnd,
      sourceStart,
    });
  }
  return ranges;
}
