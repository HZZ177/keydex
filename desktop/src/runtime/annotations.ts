import type { HttpClient } from "./httpClient";

export interface TextPosition {
  start: number;
  end: number;
}

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextContext {
  containerType: string;
  headingPath: string[];
}

export interface TextSelector {
  position: TextPosition;
  quote: TextQuote;
  context: TextContext;
  textRevision: string;
  documentRevision: string;
}

export interface DocumentAnnotationTarget {
  type: "document";
}

export interface TextAnnotationTarget {
  type: "text";
  selector: TextSelector;
}

export type AnnotationTarget = DocumentAnnotationTarget | TextAnnotationTarget;

export interface AnnotationRecord {
  id: string;
  workspace_id: string;
  document_path: string;
  target: AnnotationTarget;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface AnnotationCreateInput {
  path: string;
  body: string;
  target: AnnotationTarget;
}

export interface AnnotationBodyUpdate {
  body: string;
}

export interface AnnotationRetargetInput {
  target: TextAnnotationTarget;
}

export interface AnnotationListOptions {
  signal?: AbortSignal;
}

export interface AnnotationsRuntime {
  list(
    workspaceId: string,
    path: string,
    options?: AnnotationListOptions,
  ): Promise<AnnotationRecord[]>;
  create(workspaceId: string, payload: AnnotationCreateInput): Promise<AnnotationRecord>;
  updateBody(
    workspaceId: string,
    annotationId: string,
    payload: AnnotationBodyUpdate,
  ): Promise<AnnotationRecord>;
  replaceTarget(
    workspaceId: string,
    annotationId: string,
    payload: AnnotationRetargetInput,
  ): Promise<AnnotationRecord>;
  delete(workspaceId: string, annotationId: string): Promise<void>;
}

export function createAnnotationsRuntime(http: HttpClient): AnnotationsRuntime {
  return {
    list(workspaceId, path, options = {}) {
      return http.request<AnnotationRecord[]>(
        `${annotationsBasePath(workspaceId)}?path=${encodeURIComponent(path)}`,
        { signal: options.signal },
      );
    },
    create(workspaceId, payload) {
      return http.request<AnnotationRecord>(annotationsBasePath(workspaceId), {
        method: "POST",
        body: payload,
      });
    },
    updateBody(workspaceId, annotationId, payload) {
      return http.request<AnnotationRecord>(annotationPath(workspaceId, annotationId), {
        method: "PATCH",
        body: payload,
      });
    },
    replaceTarget(workspaceId, annotationId, payload) {
      return http.request<AnnotationRecord>(`${annotationPath(workspaceId, annotationId)}/target`, {
        method: "PUT",
        body: payload,
      });
    },
    delete(workspaceId, annotationId) {
      return http.request<void>(annotationPath(workspaceId, annotationId), {
        method: "DELETE",
      });
    },
  };
}

function annotationsBasePath(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/annotations`;
}

function annotationPath(workspaceId: string, annotationId: string): string {
  return `${annotationsBasePath(workspaceId)}/${encodeURIComponent(annotationId)}`;
}
