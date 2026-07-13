import type { AnnotationRecord } from "@/runtime/annotations";

import { createMarkdownTextModelFromProjection } from "../document/MarkdownTextModel";
import type { MarkdownLogicalDocument } from "../document/markdownLogicalText";
import { createPlainTextModel } from "../document/PlainTextModel";
import type { ResolvedAnnotationIndex } from "../domain/resolutions";
import { resolveDocumentAnnotations } from "./resolveDocumentAnnotations";

export interface AnnotationResolverPayload {
  document:
    | {
        documentRevision: string;
        kind: "markdown";
        rawSource: string;
        markdownProjection: MarkdownLogicalDocument;
      }
    | {
        documentRevision: string;
        kind: "plain-text";
        rawSource: string;
      };
  records: AnnotationRecord[];
}

export interface AnnotationResolverRequest {
  id: number;
  payload: AnnotationResolverPayload;
}

export type AnnotationResolverResponse =
  | { id: number; ok: true; result: ResolvedAnnotationIndex }
  | { id: number; ok: false; error: string };

export function resolveAnnotationPayload(
  payload: AnnotationResolverPayload,
): ResolvedAnnotationIndex {
  const model = payload.document.kind === "markdown"
    ? createMarkdownTextModelFromProjection(
        payload.document.rawSource,
        payload.document.documentRevision,
        payload.document.markdownProjection,
      )
    : createPlainTextModel(payload.document.rawSource, payload.document.documentRevision);
  return resolveDocumentAnnotations(model, payload.records);
}
