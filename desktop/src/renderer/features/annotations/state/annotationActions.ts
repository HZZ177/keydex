import type {
  AnnotationRecord,
  AnnotationsRuntime,
  TextSelector,
} from "@/runtime/annotations";
import { isRuntimeHttpError } from "@/runtime/errors";

import { AnnotationResolver } from "../anchoring/AnnotationResolver";
import type { AnnotationStore } from "./annotationStore";

export interface AnnotationAsyncActions {
  createDocument(body: string): Promise<AnnotationRecord | null>;
  createText(body: string, selector: TextSelector): Promise<AnnotationRecord | null>;
  delete(annotationId: string): Promise<boolean>;
  dispose(): void;
  load(): Promise<void>;
  retarget(annotationId: string, selector: TextSelector): Promise<AnnotationRecord | null>;
  updateBody(annotationId: string, body: string): Promise<AnnotationRecord | null>;
}

export function createAnnotationActions({
  resolver = new AnnotationResolver(),
  runtime,
  store,
}: {
  resolver?: AnnotationResolver;
  runtime: AnnotationsRuntime;
  store: AnnotationStore;
}): AnnotationAsyncActions {
  let loadController: AbortController | null = null;
  let disposed = false;

  const rebuild = async (records: readonly AnnotationRecord[], identity: string) => {
    const document = store.getState().document;
    if (!document || documentIdentity(document) !== identity || disposed) {
      return false;
    }
    const resolutions = await resolver.resolve({
      workspaceId: document.workspaceId,
      path: document.path,
      model: document.model,
      records,
    });
    const current = store.getState().document;
    if (!current || documentIdentity(current) !== identity || disposed) {
      return false;
    }
    store.getState().setRecords(records, resolutions);
    return true;
  };

  const load = async () => {
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    const document = requireDocument(store);
    const identity = documentIdentity(document);
    store.getState().setLoading(true);
    store.getState().setError(null);
    try {
      const records = await runtime.list(document.workspaceId, document.path, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        await rebuild(records, identity);
      }
    } catch (error) {
      if (!controller.signal.aborted && isCurrentDocument(store, identity)) {
        store.getState().setError(errorMessage(error));
      }
    } finally {
      if (loadController === controller) {
        loadController = null;
        if (isCurrentDocument(store, identity)) {
          store.getState().setLoading(false);
        }
      }
    }
  };

  const mutate = async <T extends AnnotationRecord | null>({
    annotationId,
    kind,
    operation,
    records,
    revisionSensitive = false,
  }: {
    annotationId?: string;
    kind: "create" | "update-body" | "retarget";
    operation: () => Promise<T>;
    records: (result: NonNullable<T>, current: readonly AnnotationRecord[]) => readonly AnnotationRecord[];
    revisionSensitive?: boolean;
  }): Promise<T> => {
    const document = requireDocument(store);
    const identity = documentIdentity(document);
    const token = store.getState().startMutation(kind, annotationId);
    store.getState().setError(null);
    try {
      const result = await operation();
      if (!result || !isCurrentMutation(store, identity, token)) {
        return null as T;
      }
      const nextRecords = records(result, store.getState().records);
      await rebuild(nextRecords, identity);
      if (isCurrentMutation(store, identity, token)) {
        store.getState().cancelInteraction();
      }
      return result;
    } catch (error) {
      if (isCurrentMutation(store, identity, token)) {
        if (revisionSensitive && isRevisionConflict(error)) {
          store.getState().cancelInteraction();
        }
        store.getState().setError(errorMessage(error));
      }
      return null as T;
    } finally {
      store.getState().finishMutation(token);
    }
  };

  return {
    createDocument(body) {
      const document = requireDocument(store);
      return mutate({
        kind: "create",
        revisionSensitive: false,
        operation: () => runtime.create(document.workspaceId, {
          path: document.path,
          body,
          target: { type: "document" },
        }),
        records: (created, current) => [...current, created],
      });
    },
    createText(body, selector) {
      const document = requireDocument(store);
      return mutate({
        kind: "create",
        revisionSensitive: true,
        operation: () => runtime.create(document.workspaceId, {
          path: document.path,
          body,
          target: { type: "text", selector },
        }),
        records: (created, current) => [...current, created],
      });
    },
    async delete(annotationId) {
      const document = requireDocument(store);
      const identity = documentIdentity(document);
      const token = store.getState().startMutation("delete", annotationId);
      store.getState().setError(null);
      try {
        await runtime.delete(document.workspaceId, annotationId);
        if (!isCurrentMutation(store, identity, token)) {
          return false;
        }
        await rebuild(store.getState().records.filter((record) => record.id !== annotationId), identity);
        return true;
      } catch (error) {
        if (isCurrentMutation(store, identity, token)) {
          store.getState().setError(errorMessage(error));
        }
        return false;
      } finally {
        store.getState().finishMutation(token);
      }
    },
    dispose() {
      disposed = true;
      loadController?.abort();
      loadController = null;
      resolver.close();
    },
    load,
    retarget(annotationId, selector) {
      const document = requireDocument(store);
      return mutate({
        annotationId,
        kind: "retarget",
        revisionSensitive: true,
        operation: () => runtime.replaceTarget(document.workspaceId, annotationId, {
          target: { type: "text", selector },
        }),
        records: (updated, current) => replaceRecord(current, updated),
      });
    },
    updateBody(annotationId, body) {
      const document = requireDocument(store);
      return mutate({
        annotationId,
        kind: "update-body",
        operation: () => runtime.updateBody(document.workspaceId, annotationId, { body }),
        records: (updated, current) => replaceRecord(current, updated),
      });
    },
  };
}

function requireDocument(store: AnnotationStore) {
  const document = store.getState().document;
  if (!document) {
    throw new Error("Annotation document is not loaded");
  }
  return document;
}

function replaceRecord(
  records: readonly AnnotationRecord[],
  updated: AnnotationRecord,
): AnnotationRecord[] {
  return records.map((record) => record.id === updated.id ? updated : record);
}

function documentIdentity(document: { workspaceId: string; path: string; model: { revision: { textRevision: string } } }) {
  return `${document.workspaceId}\u0000${document.path}\u0000${document.model.revision.textRevision}`;
}

function isCurrentDocument(store: AnnotationStore, identity: string): boolean {
  const document = store.getState().document;
  return Boolean(document && documentIdentity(document) === identity);
}

function isCurrentMutation(store: AnnotationStore, identity: string, token: number): boolean {
  return isCurrentDocument(store, identity) && store.getState().pendingMutation?.token === token;
}

function isRevisionConflict(error: unknown): boolean {
  return isRuntimeHttpError(error)
    && error.status === 409
    && error.code === "annotation_document_changed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
