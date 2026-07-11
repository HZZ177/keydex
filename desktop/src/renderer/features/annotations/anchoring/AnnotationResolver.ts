import type { AnnotationRecord } from "@/runtime/annotations";

import type { DocumentTextModel } from "../document/DocumentTextModel";
import type { ResolvedAnnotationIndex } from "../domain/resolutions";
import {
  createAnnotationSetRevision,
  resolveDocumentAnnotations,
} from "./resolveDocumentAnnotations";
import type {
  AnnotationResolverRequest,
  AnnotationResolverResponse,
} from "./annotationResolverProtocol";

interface ResolverWorker {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<AnnotationResolverResponse>) => void) | null;
  postMessage(message: AnnotationResolverRequest): void;
  terminate(): void;
}

export interface AnnotationResolverOptions {
  cacheSize?: number;
  largeDocumentCharacters?: number;
  largeRecordCount?: number;
  workerFactory?: () => ResolverWorker;
}

export interface ResolveAnnotationsInput {
  model: DocumentTextModel;
  path: string;
  records: readonly AnnotationRecord[];
  signal?: AbortSignal;
  workspaceId: string;
}

interface ActiveResolution {
  cancel: (message: string) => void;
  worker: ResolverWorker;
}

export class AnnotationResolver {
  private readonly cache = new Map<string, ResolvedAnnotationIndex>();
  private readonly cacheSize: number;
  private readonly largeDocumentCharacters: number;
  private readonly largeRecordCount: number;
  private readonly workerFactory: () => ResolverWorker;
  private active: ActiveResolution | null = null;
  private requestId = 0;

  constructor(options: AnnotationResolverOptions = {}) {
    this.cacheSize = options.cacheSize ?? 8;
    this.largeDocumentCharacters = options.largeDocumentCharacters ?? 100_000;
    this.largeRecordCount = options.largeRecordCount ?? 50;
    this.workerFactory = options.workerFactory ?? (() => {
      if (typeof Worker === "undefined") {
        throw new Error("Annotation resolver Worker is unavailable");
      }
      return new Worker(new URL("./annotationResolver.worker.ts", import.meta.url), {
        type: "module",
      });
    });
  }

  resolve(input: ResolveAnnotationsInput): Promise<ResolvedAnnotationIndex> {
    this.cancelActive("Annotation resolution superseded");
    if (input.signal?.aborted) {
      return Promise.reject(abortError("Annotation resolution aborted"));
    }
    const key = cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    if (input.model.logicalText.length < this.largeDocumentCharacters
      && input.records.length < this.largeRecordCount) {
      const result = resolveDocumentAnnotations(input.model, input.records);
      this.remember(key, result);
      return Promise.resolve(result);
    }
    return this.resolveInWorker(input, key);
  }

  close(): void {
    this.cancelActive("Annotation resolver closed");
    this.cache.clear();
  }

  private resolveInWorker(
    input: ResolveAnnotationsInput,
    key: string,
  ): Promise<ResolvedAnnotationIndex> {
    const worker = this.workerFactory();
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        input.signal?.removeEventListener("abort", onAbort);
        worker.terminate();
        if (this.active?.worker === worker) {
          this.active = null;
        }
      };
      const cancel = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        reject(abortError(message));
      };
      const onAbort = () => cancel("Annotation resolution aborted");
      worker.onmessage = (event) => {
        if (settled || event.data.id !== id) {
          return;
        }
        settled = true;
        finish();
        if (!event.data.ok) {
          reject(new Error(event.data.error));
          return;
        }
        this.remember(key, event.data.result);
        resolve(event.data.result);
      };
      worker.onerror = (event) => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        reject(new Error(event.message || "Annotation resolver Worker failed"));
      };
      this.active = { worker, cancel };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({
        id,
        payload: {
          document: {
            documentRevision: input.model.revision.documentRevision,
            kind: input.model.kind,
            rawSource: input.model.rawSource,
          },
          records: [...input.records],
        },
      });
    });
  }

  private cancelActive(message: string): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = null;
    active.cancel(message);
  }

  private remember(key: string, value: ResolvedAnnotationIndex): void {
    this.cache.set(key, value);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }
}

function cacheKey(input: ResolveAnnotationsInput): string {
  return [
    input.workspaceId,
    input.path,
    input.model.revision.textRevision,
    createAnnotationSetRevision(input.records),
  ].join("\u0000");
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}
