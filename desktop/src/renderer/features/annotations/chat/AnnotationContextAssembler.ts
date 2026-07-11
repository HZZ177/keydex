import type { DocumentTextModel, SourceRange } from "../document/DocumentTextModel";
import type { ResolvedAnnotationIndex } from "../domain/resolutions";

export interface AnnotationReference {
  readonly annotationId: string;
  readonly path: string;
  readonly workspaceId: string;
}

export interface AnnotationAssemblyDocument {
  readonly index: ResolvedAnnotationIndex;
  readonly model: DocumentTextModel;
  readonly path: string;
  readonly workspaceId: string;
}

export type AssembledAnnotationContext =
  | {
      readonly annotationId: string;
      readonly body: string;
      readonly content: string;
      readonly documentRevision: string;
      readonly kind: "document";
      readonly path: string;
      readonly textRevision: string;
      readonly workspaceId: string;
    }
  | {
      readonly annotationId: string;
      readonly body: string;
      readonly documentRevision: string;
      readonly exact: string;
      readonly kind: "text";
      readonly path: string;
      readonly sourceRanges: readonly SourceRange[];
      readonly sourceSegments: readonly string[];
      readonly textRevision: string;
      readonly workspaceId: string;
    };

export type AnnotationAssemblyErrorCode =
  | "document-mismatch"
  | "index-revision-mismatch"
  | "annotation-missing"
  | "annotation-ambiguous"
  | "annotation-changed";

export class AnnotationContextAssemblyError extends Error {
  constructor(
    readonly code: AnnotationAssemblyErrorCode,
    readonly annotationId: string,
    message: string,
  ) {
    super(message);
    this.name = "AnnotationContextAssemblyError";
  }
}

export function assembleAnnotationContexts(
  references: readonly AnnotationReference[],
  document: AnnotationAssemblyDocument,
): readonly AssembledAnnotationContext[] {
  assertCurrentIndex(document);
  const assembled = references.map((reference) => assembleOne(reference, document));
  return Object.freeze(assembled);
}

function assembleOne(
  reference: AnnotationReference,
  document: AnnotationAssemblyDocument,
): AssembledAnnotationContext {
  const annotationId = reference.annotationId.trim();
  if (!annotationId || reference.workspaceId !== document.workspaceId || reference.path !== document.path) {
    throw new AnnotationContextAssemblyError(
      "document-mismatch",
      annotationId,
      `Annotation ${annotationId || "<empty>"} does not belong to the current document`,
    );
  }
  const resolution = document.index.byId[annotationId];
  if (!resolution) {
    throw new AnnotationContextAssemblyError("annotation-missing", annotationId, `Annotation ${annotationId} no longer exists`);
  }
  if (resolution.status === "ambiguous") {
    throw new AnnotationContextAssemblyError("annotation-ambiguous", annotationId, `Annotation ${annotationId} must be retargeted before sending`);
  }
  if (resolution.status === "changed") {
    throw new AnnotationContextAssemblyError("annotation-changed", annotationId, `Annotation ${annotationId} text has changed and must be retargeted`);
  }
  const common = {
    annotationId,
    body: resolution.record.body,
    documentRevision: document.model.revision.documentRevision,
    path: document.path,
    textRevision: document.model.revision.textRevision,
    workspaceId: document.workspaceId,
  } as const;
  if (resolution.status === "document") {
    return Object.freeze({ ...common, content: document.model.rawSource, kind: "document" });
  }
  const { logicalRange, sourceRanges } = resolution.projection;
  const exact = document.model.logicalText.slice(logicalRange.start, logicalRange.end);
  const sourceSegments = sourceRanges.map((range) => document.model.rawSource.slice(range.start, range.end));
  if (resolution.record.target.type !== "text" || exact !== resolution.record.target.selector.quote.exact) {
    throw new AnnotationContextAssemblyError("annotation-changed", annotationId, `Annotation ${annotationId} exact text is no longer current`);
  }
  return Object.freeze({
    ...common,
    exact,
    kind: "text",
    sourceRanges: Object.freeze(sourceRanges.map((range) => Object.freeze({ ...range }))),
    sourceSegments: Object.freeze(sourceSegments),
  });
}

function assertCurrentIndex(document: AnnotationAssemblyDocument): void {
  if (document.index.textRevision !== document.model.revision.textRevision) {
    throw new AnnotationContextAssemblyError(
      "index-revision-mismatch",
      "",
      "Annotation resolution index is not for the current document revision",
    );
  }
}
