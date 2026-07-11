import type { AnnotationRecord } from "@/runtime/annotations";

import type {
  BlockRangeProjection,
  DocumentContext,
  LogicalRange,
  SourceRange,
} from "../document/DocumentTextModel";
import type { TextAnchorResolution } from "../anchoring/resolveTextAnchor";

export interface AnnotationProjection {
  readonly blockRanges: readonly BlockRangeProjection[];
  readonly context: DocumentContext;
  readonly logicalRange: LogicalRange;
  readonly sourceRanges: readonly SourceRange[];
}

export interface DocumentAnnotationResolution {
  readonly record: AnnotationRecord;
  readonly status: "document";
}

export interface ResolvedTextAnnotation {
  readonly projection: AnnotationProjection;
  readonly record: AnnotationRecord;
  readonly status: "resolved";
  readonly strategy: Extract<TextAnchorResolution, { status: "resolved" }>["strategy"];
}

export interface AmbiguousTextAnnotation {
  readonly candidates: readonly AnnotationProjection[];
  readonly record: AnnotationRecord;
  readonly status: "ambiguous";
}

export interface ChangedTextAnnotation {
  readonly record: AnnotationRecord;
  readonly status: "changed";
}

export type ResolvedDocumentAnnotation =
  | DocumentAnnotationResolution
  | ResolvedTextAnnotation
  | AmbiguousTextAnnotation
  | ChangedTextAnnotation;

export interface ResolvedAnnotationIndex {
  readonly ambiguous: readonly AmbiguousTextAnnotation[];
  readonly annotationSetRevision: string;
  readonly byId: Readonly<Record<string, ResolvedDocumentAnnotation>>;
  readonly changed: readonly ChangedTextAnnotation[];
  readonly document: readonly DocumentAnnotationResolution[];
  readonly ordered: readonly ResolvedDocumentAnnotation[];
  readonly resolved: readonly ResolvedTextAnnotation[];
  readonly textRevision: string;
}
