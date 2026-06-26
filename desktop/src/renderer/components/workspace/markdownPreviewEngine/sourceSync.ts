import type { MarkdownAnnotationIndexItem } from "./annotationIndex";
import type { MarkdownFindIndex } from "./findIndex";
import type { MarkdownDocumentModel, MarkdownSourceRange } from "./types";

export function sourceRangeForOutlineItem(
  model: MarkdownDocumentModel,
  outlineId: string,
): MarkdownSourceRange | null {
  const item = model.outline.find((entry) => entry.id === outlineId);
  return item
    ? {
      lineEnd: item.lineEnd,
      lineStart: item.lineStart,
      sourceEnd: item.sourceEnd,
      sourceStart: item.sourceStart,
    }
    : null;
}

export function sourceRangeForAnnotation(
  annotationIndex: MarkdownAnnotationIndexItem[],
  annotationId: string,
): MarkdownSourceRange | null {
  const item = annotationIndex.find((entry) => entry.annotation.id === annotationId);
  const firstRange = item?.ranges[0];
  return firstRange && item?.anchor
    ? {
      lineEnd: item.anchor.lineEnd,
      lineStart: item.anchor.lineStart,
      sourceEnd: firstRange.sourceEnd,
      sourceStart: firstRange.sourceStart,
    }
    : null;
}

export function sourceRangeForFindMatch(
  findIndex: MarkdownFindIndex | null,
  matchId: string,
): MarkdownSourceRange | null {
  const match = findIndex?.matches.find((entry) => entry.id === matchId);
  return match
    ? {
      lineEnd: match.lineEnd,
      lineStart: match.lineStart,
      sourceEnd: match.sourceEnd,
      sourceStart: match.sourceStart,
    }
    : null;
}
