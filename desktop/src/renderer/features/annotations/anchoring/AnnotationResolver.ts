import type { AnnotationRecord } from "@/runtime/annotations";

import type { DocumentTextModel } from "../document/DocumentTextModel";
import type { ResolvedAnnotationIndex } from "../domain/resolutions";
import type { AnnotationDocumentWorkerResolver } from "./DocumentWorkerAnnotationResolver";
import {
  createAnnotationSetRevision,
  resolveDocumentAnnotations,
} from "./resolveDocumentAnnotations";

export interface AnnotationResolverOptions {
  readonly cacheSize?: number;
  readonly largeDocumentCharacters?: number;
  readonly largeRecordCount?: number;
  readonly documentWorker?: AnnotationDocumentWorkerResolver | null;
}

export interface ResolveAnnotationsInput {
  readonly model: DocumentTextModel;
  readonly path: string;
  readonly records: readonly AnnotationRecord[];
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

interface ActiveResolution {
  readonly controller: AbortController;
  readonly externalSignal: AbortSignal | null;
  readonly onExternalAbort: (() => void) | null;
}

/**
 * Resolves small/legacy inputs synchronously and delegates large Snapshot-backed
 * Markdown inputs to the shared Document Worker. It never creates a second
 * annotation-specific Worker and never reparses raw Markdown.
 */
export class AnnotationResolver {
  private readonly cache = new Map<string, ResolvedAnnotationIndex>();
  private readonly cacheSize: number;
  private readonly largeDocumentCharacters: number;
  private readonly largeRecordCount: number;
  private readonly documentWorker: AnnotationDocumentWorkerResolver | null;
  private active: ActiveResolution | null = null;

  constructor(options: AnnotationResolverOptions = {}) {
    this.cacheSize = options.cacheSize ?? 8;
    this.largeDocumentCharacters = options.largeDocumentCharacters ?? 100_000;
    this.largeRecordCount = options.largeRecordCount ?? 50;
    this.documentWorker = options.documentWorker ?? null;
  }

  resolve(input: ResolveAnnotationsInput): Promise<ResolvedAnnotationIndex> {
    this.cancelActive("Annotation resolution superseded");
    if (input.signal?.aborted) return Promise.reject(abortError("Annotation resolution aborted"));
    const key = cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    const large = input.model.logicalText.length >= this.largeDocumentCharacters
      || input.records.length >= this.largeRecordCount;
    if (large && this.documentWorker && input.model.kind === "markdown") {
      return this.resolveInDocumentWorker(input, key);
    }
    const result = resolveDocumentAnnotations(input.model, input.records);
    this.remember(key, result);
    return Promise.resolve(result);
  }

  close(): void {
    this.cancelActive("Annotation resolver closed");
    this.cache.clear();
  }

  private resolveInDocumentWorker(
    input: ResolveAnnotationsInput,
    key: string,
  ): Promise<ResolvedAnnotationIndex> {
    const controller = new AbortController();
    const onExternalAbort = input.signal
      ? () => controller.abort(abortError("Annotation resolution aborted"))
      : null;
    input.signal?.addEventListener("abort", onExternalAbort!, { once: true });
    const active: ActiveResolution = {
      controller,
      externalSignal: input.signal ?? null,
      onExternalAbort,
    };
    this.active = active;
    return this.documentWorker!.resolve({
      model: input.model,
      path: input.path,
      records: input.records,
      signal: controller.signal,
      workspaceId: input.workspaceId,
    }).then((result) => {
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError("Annotation resolution aborted");
      this.remember(key, result);
      return result;
    }).finally(() => {
      this.releaseActive(active);
    });
  }

  private cancelActive(message: string): void {
    const active = this.active;
    if (!active) return;
    this.releaseActive(active);
    active.controller.abort(abortError(message));
  }

  private releaseActive(active: ActiveResolution): void {
    active.externalSignal?.removeEventListener("abort", active.onExternalAbort!);
    if (this.active === active) this.active = null;
  }

  private remember(key: string, value: ResolvedAnnotationIndex): void {
    this.cache.set(key, value);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function cacheKey(input: ResolveAnnotationsInput): string {
  return [
    input.workspaceId,
    input.path,
    input.model.revision.documentRevision,
    input.model.revision.textRevision,
    createAnnotationSetRevision(input.records),
  ].join("\u0000");
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}
