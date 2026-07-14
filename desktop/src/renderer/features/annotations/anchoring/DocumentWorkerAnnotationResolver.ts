import type { AnnotationRecord } from "@/runtime/annotations";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type { DocumentWorkerAttachment } from "@/renderer/markdownRuntime/worker/DocumentWorkerHost";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";

import type { DocumentTextModel } from "../document/DocumentTextModel";
import type { ResolvedAnnotationIndex } from "../domain/resolutions";

export interface AnnotationDocumentWorkerResolveInput {
  readonly model: DocumentTextModel;
  readonly path: string;
  readonly records: readonly AnnotationRecord[];
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export interface AnnotationDocumentWorkerResolver {
  resolve(input: AnnotationDocumentWorkerResolveInput): Promise<ResolvedAnnotationIndex>;
  updateSnapshot?(snapshot: MarkdownSnapshot): void;
}

export class DocumentWorkerAnnotationResolver implements AnnotationDocumentWorkerResolver {
  private sequence = 0;

  constructor(
    private readonly attachment: Pick<DocumentWorkerAttachment, "request" | "documentId" | "surface">,
    private snapshot: MarkdownSnapshot,
  ) {
    this.validateSnapshot(snapshot);
  }

  updateSnapshot(snapshot: MarkdownSnapshot): void {
    this.validateSnapshot(snapshot);
    this.snapshot = snapshot;
  }

  async resolve(input: AnnotationDocumentWorkerResolveInput): Promise<ResolvedAnnotationIndex> {
    if (input.model.markdownSnapshotRevision !== this.snapshot.revision) {
      throw new Error("Annotation model revision does not match Markdown Snapshot");
    }
    let response: MarkdownWorkerResponse;
    try {
      response = await this.attachment.request({
        protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
        surface: this.snapshot.surface,
        document_id: this.snapshot.document_id,
        revision: this.snapshot.revision,
        request_id: `annotations-${++this.sequence}`,
        type: "resolve-annotations",
        payload: {
          path: input.path,
          workspace_id: input.workspaceId,
          records: input.records,
        },
      }, { signal: input.signal });
    } catch (error) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new DOMException("Annotation resolution aborted", "AbortError");
      }
      throw error;
    }
    if (response.type !== "annotations-result") {
      throw new Error(`Expected annotations-result, received ${response.type}`);
    }
    return response.payload.result;
  }

  private validateSnapshot(snapshot: MarkdownSnapshot): void {
    if (snapshot.document_id !== this.attachment.documentId || snapshot.surface !== this.attachment.surface) {
      throw new Error("Annotation Document Worker attachment does not match Snapshot");
    }
  }
}
