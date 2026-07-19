import type { FileDiffMetadata, RenderDiffOptions, ThemedDiffResult } from "@pierre/diffs";
import type { DiffRendererInstance } from "@pierre/diffs/worker";

import type { KeydexDiffFile } from "../model";
import { KEYDEX_ALIGNED_DIFF_MODEL_VERSION } from "../aligned/alignedDiffModel";
import type { KeydexDiffTheme } from "./pierreOptions";
import {
  KEYDEX_PIERRE_ALIGNED_VERSION,
  finalizePierreAlignedFile,
  parsePierreAlignedFile,
  type PierreAlignedPreparedFile,
  type PierreAlignedPublicApi,
} from "./pierreAlignedAdapter";

export interface PierreAlignedWorkerManager {
  getDiffResultCache(diff: FileDiffMetadata): { result: ThemedDiffResult; options: RenderDiffOptions } | undefined;
  highlightDiffAST(instance: DiffRendererInstance, diff: FileDiffMetadata): void;
  cleanUpTasks(instance: DiffRendererInstance): void;
}

export interface PierreAlignedPrepareRequest {
  readonly file: KeydexDiffFile;
  readonly sourceVersion: string;
  readonly theme: KeydexDiffTheme;
  readonly api: PierreAlignedPublicApi;
  readonly manager: PierreAlignedWorkerManager;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
}

interface PreparationEntry {
  readonly controller: AbortController;
  readonly promise: Promise<PierreAlignedPreparedFile>;
  consumers: number;
  settled: boolean;
}

export class PierreAlignedPreparationError extends Error {
  constructor(readonly code: "aborted" | "stale" | "worker", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PierreAlignedPreparationError";
  }
}

export class PierreAlignedPreparationCache {
  private readonly entries = new Map<string, PreparationEntry>();

  constructor(private readonly maxEntries = 32) {}

  prepare(request: PierreAlignedPrepareRequest): Promise<PierreAlignedPreparedFile> {
    const key = pierreAlignedPreparationCacheKey(request);
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = {
        controller,
        consumers: 0,
        settled: false,
        promise: prepareWithWorker({ ...request, signal: controller.signal })
          .then((result) => {
            entry!.settled = true;
            this.touch(key, entry!);
            return result;
          })
          .catch((error) => {
            this.entries.delete(key);
            throw error;
          }),
      };
      this.entries.set(key, entry);
      this.evictSettledEntries();
    } else {
      this.touch(key, entry);
    }
    return this.attachConsumer(key, entry, request.signal, request.isCurrent);
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private attachConsumer(
    key: string,
    entry: PreparationEntry,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<PierreAlignedPreparedFile> {
    if (signal?.aborted) return Promise.reject(abortedError());
    entry.consumers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        entry.consumers = Math.max(0, entry.consumers - 1);
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        if (!entry.settled && entry.consumers === 0) {
          entry.controller.abort();
          this.entries.delete(key);
        }
        reject(abortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (result) => {
          if (!finish()) return;
          if (isCurrent && !isCurrent()) {
            reject(new PierreAlignedPreparationError("stale", "已丢弃过期的差异准备结果"));
            return;
          }
          resolve(result);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  private touch(key: string, entry: PreparationEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictSettledEntries(): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(key);
      if (this.entries.size <= this.maxEntries) break;
    }
  }
}

export function pierreAlignedPreparationCacheKey(
  request: Pick<PierreAlignedPrepareRequest, "file" | "sourceVersion" | "theme">,
): string {
  return [
    request.file.cacheKey,
    request.sourceVersion,
    KEYDEX_PIERRE_ALIGNED_VERSION,
    KEYDEX_ALIGNED_DIFF_MODEL_VERSION,
    request.file.language,
    request.theme,
    "word-alt",
    request.file.truncation.state,
    request.file.oldContent === undefined && request.file.newContent === undefined ? "partial" : "full",
  ].join(":");
}

async function prepareWithWorker(
  request: PierreAlignedPrepareRequest,
): Promise<PierreAlignedPreparedFile> {
  if (request.signal?.aborted) throw abortedError();
  const metadata = parsePierreAlignedFile(request.api, request.file);
  const cached = request.manager.getDiffResultCache(metadata);
  const rendered = cached?.result ?? await highlightWithWorker(request.manager, metadata, request.signal);
  if (request.signal?.aborted) throw abortedError();
  return finalizePierreAlignedFile(
    request.file,
    metadata,
    rendered,
    request.sourceVersion,
    metadata.lang ?? request.api.getFiletypeFromFileName(metadata.name),
  );
}

function highlightWithWorker(
  manager: PierreAlignedWorkerManager,
  metadata: FileDiffMetadata,
  signal?: AbortSignal,
): Promise<ThemedDiffResult> {
  return new Promise((resolve, reject) => {
    const instance: DiffRendererInstance = {
      __id: `keydex-aligned:${metadata.cacheKey ?? metadata.name}:${nextInstanceId++}`,
      onHighlightSuccess: (_diff, result) => {
        cleanup();
        resolve(result);
      },
      onHighlightError: (cause) => {
        cleanup();
        reject(new PierreAlignedPreparationError("worker", "差异 Worker 高亮失败", cause));
      },
    };
    const onAbort = () => {
      manager.cleanUpTasks(instance);
      cleanup();
      reject(abortedError());
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      manager.highlightDiffAST(instance, metadata);
    } catch (cause) {
      cleanup();
      reject(new PierreAlignedPreparationError("worker", "差异 Worker 请求失败", cause));
    }
  });
}

function abortedError(): PierreAlignedPreparationError {
  return new PierreAlignedPreparationError("aborted", "差异准备已取消");
}

let nextInstanceId = 1;

export const pierreAlignedPreparationCache = new PierreAlignedPreparationCache();
