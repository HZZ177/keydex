import type { WorkspaceFileAnnotationAnchorV2 } from "@/runtime";

import {
  type AnnotationAnchorInvalidReason,
  validateSourceRangeAnchor,
} from "../filePreviewAnnotations";
import type { MarkdownBlock, MarkdownDocumentModel } from "./types";

export interface MarkdownAnnotationLike {
  anchor_json?: unknown;
  anchor_type?: string | null;
  content_hash?: string | null;
  id: string;
  selected_text?: string | null;
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
  anchor: WorkspaceFileAnnotationAnchorV2 | null;
  annotation: TAnnotation;
  ranges: MarkdownAnnotationBlockRange[];
  reason: AnnotationAnchorInvalidReason | null;
  status: "valid" | AnnotationAnchorInvalidReason;
}

export function buildMarkdownAnnotationIndex<TAnnotation extends MarkdownAnnotationLike>(
  model: MarkdownDocumentModel,
  annotations: TAnnotation[],
): MarkdownAnnotationIndexItem<TAnnotation>[] {
  return annotations.map((annotation) => {
    if (annotation.anchor_type && annotation.anchor_type !== "selection") {
      return {
        anchor: null,
        annotation,
        ranges: [],
        reason: "unsupported",
        status: "unsupported",
      };
    }
    const validation = validateSourceRangeAnchor(model.source, annotation.anchor_json);
    if (!validation.valid || !validation.anchor) {
      return {
        anchor: validation.anchor,
        annotation,
        ranges: [],
        reason: validation.reason,
        status: validation.reason ?? "unsupported",
      };
    }
    return {
      anchor: validation.anchor,
      annotation,
      ranges: affectedBlocksForAnchor(model.blocks, validation.anchor),
      reason: null,
      status: "valid",
    };
  });
}

function affectedBlocksForAnchor(
  blocks: MarkdownBlock[],
  anchor: WorkspaceFileAnnotationAnchorV2,
): MarkdownAnnotationBlockRange[] {
  const ranges: MarkdownAnnotationBlockRange[] = [];
  for (const block of blocks) {
    const sourceStart = Math.max(block.sourceStart, anchor.sourceStart);
    const sourceEnd = Math.min(block.sourceEnd, anchor.sourceEnd);
    if (sourceEnd <= sourceStart) {
      continue;
    }
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
