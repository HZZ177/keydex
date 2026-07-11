import type { AnnotationRecord } from "@/runtime/annotations";

import type { DocumentTextModel, LogicalRange } from "../document/DocumentTextModel";
import type {
  AmbiguousTextAnnotation,
  AnnotationProjection,
  ChangedTextAnnotation,
  DocumentAnnotationResolution,
  ResolvedAnnotationIndex,
  ResolvedDocumentAnnotation,
  ResolvedTextAnnotation,
} from "../domain/resolutions";
import { resolveTextAnchor } from "./resolveTextAnchor";

export function resolveDocumentAnnotations(
  model: DocumentTextModel,
  records: readonly AnnotationRecord[],
): ResolvedAnnotationIndex {
  const document: DocumentAnnotationResolution[] = [];
  const resolved: ResolvedTextAnnotation[] = [];
  const ambiguous: AmbiguousTextAnnotation[] = [];
  const changed: ChangedTextAnnotation[] = [];
  const byId: Record<string, ResolvedDocumentAnnotation> = {};

  for (const record of records) {
    if (byId[record.id]) {
      throw new Error(`Duplicate annotation id: ${record.id}`);
    }
    let resolution: ResolvedDocumentAnnotation;
    if (record.target.type === "document") {
      resolution = Object.freeze({ record, status: "document" });
      document.push(resolution);
    } else {
      const anchor = resolveTextAnchor(model, record.target.selector);
      if (anchor.status === "resolved") {
        resolution = Object.freeze({
          projection: project(model, anchor.range),
          record,
          status: "resolved",
          strategy: anchor.strategy,
        });
        resolved.push(resolution);
      } else if (anchor.status === "ambiguous") {
        resolution = Object.freeze({
          candidates: Object.freeze(anchor.candidates.map((candidate) => project(model, candidate))),
          record,
          status: "ambiguous",
        });
        ambiguous.push(resolution);
      } else {
        resolution = Object.freeze({ record, status: "changed" });
        changed.push(resolution);
      }
    }
    byId[record.id] = resolution;
  }

  document.sort(compareByRecord);
  resolved.sort((left, right) =>
    left.projection.logicalRange.start - right.projection.logicalRange.start
    || left.projection.logicalRange.end - right.projection.logicalRange.end
    || compareByRecord(left, right));
  ambiguous.sort((left, right) =>
    (left.candidates[0]?.logicalRange.start ?? Number.MAX_SAFE_INTEGER)
    - (right.candidates[0]?.logicalRange.start ?? Number.MAX_SAFE_INTEGER)
    || compareByRecord(left, right));
  changed.sort(compareByRecord);

  return Object.freeze({
    ambiguous: Object.freeze(ambiguous),
    annotationSetRevision: createAnnotationSetRevision(records),
    byId: Object.freeze(byId),
    changed: Object.freeze(changed),
    document: Object.freeze(document),
    ordered: Object.freeze([...document, ...resolved, ...ambiguous, ...changed]),
    resolved: Object.freeze(resolved),
    textRevision: model.revision.textRevision,
  });
}

function project(model: DocumentTextModel, range: LogicalRange): AnnotationProjection {
  const projection = model.projectView(range);
  return Object.freeze({
    blockRanges: projection.blockRanges,
    context: model.contextAt(range),
    logicalRange: projection.logicalRange,
    sourceRanges: projection.sourceRanges,
  });
}

function compareByRecord(
  left: { record: AnnotationRecord },
  right: { record: AnnotationRecord },
): number {
  return left.record.created_at.localeCompare(right.record.created_at)
    || left.record.id.localeCompare(right.record.id);
}

export function createAnnotationSetRevision(records: readonly AnnotationRecord[]): string {
  const value = [...records]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => JSON.stringify({
      body: record.body,
      id: record.id,
      target: record.target,
      updatedAt: record.updated_at,
    }))
    .join("\n");
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `annotations:${Math.abs(hash).toString(36)}`;
}
