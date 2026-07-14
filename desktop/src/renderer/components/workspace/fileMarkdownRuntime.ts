import { MarkdownRuntimeStore } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import type { MarkdownDocumentIdentityInput } from "@/renderer/markdownRuntime/document/identity";
import { MarkdownViewStateStore } from "@/renderer/markdownRuntime/view";
import type { MarkdownViewDescriptor } from "@/renderer/markdownRuntime/view";
import { markdownRuntimeDiagnostics } from "@/renderer/markdownRuntime/diagnostics";

let sharedFileMarkdownRuntimeStore: MarkdownRuntimeStore | null = null;
let sharedFileMarkdownViewStateStore: MarkdownViewStateStore | null = null;
const retainedFileRuntimeEntries = new Map<string, {
  readonly identity: Extract<MarkdownDocumentIdentityInput, { surface: "file" }>;
  estimatedBytes: number;
}>();
const LARGE_DOCUMENT_RELEASE_BYTES = 32 * 1024 * 1024;
let memoryReleaseScheduled = false;

export function fileMarkdownRuntimeStore(): MarkdownRuntimeStore {
  sharedFileMarkdownRuntimeStore ??= new MarkdownRuntimeStore({
    onDiagnostic: (event) => markdownRuntimeDiagnostics.record({
      stage: diagnosticStage(event.event),
      severity: event.event.endsWith("failed") ? "error" : "info",
      code: event.event,
      documentId: event.documentId,
      revision: event.revision,
      recovery: event.event === "worker-failed"
        ? "restart-worker"
        : event.event === "parse-failed" ? "retain-snapshot" : "none",
      detail: event.detail,
      blockId: null,
      resourceId: null,
    }),
  });
  return sharedFileMarkdownRuntimeStore;
}

function diagnosticStage(event: string): "worker" | "parser" | "snapshot" | "cache" | "host" {
  if (event.startsWith("worker")) return "worker";
  if (event.startsWith("parse")) return "parser";
  if (event.startsWith("snapshot")) return "snapshot";
  if (event === "cache-hit" || event === "evicted") return "cache";
  return "host";
}

export function fileMarkdownViewStateStore(): MarkdownViewStateStore {
  sharedFileMarkdownViewStateStore ??= new MarkdownViewStateStore();
  return sharedFileMarkdownViewStateStore;
}

export function registerFileMarkdownRuntimeEntry(
  descriptor: MarkdownViewDescriptor,
  identity: Extract<MarkdownDocumentIdentityInput, { surface: "file" }>,
): void {
  const key = runtimeEntryKey(descriptor.scopeId, descriptor.entryId);
  const current = retainedFileRuntimeEntries.get(key);
  retainedFileRuntimeEntries.set(key, {
    identity: Object.freeze({ ...identity }),
    estimatedBytes: current?.estimatedBytes ?? 0,
  });
}

export function recordFileMarkdownRuntimeEntrySnapshot(
  descriptor: MarkdownViewDescriptor,
  estimatedBytes: number,
): void {
  const entry = retainedFileRuntimeEntries.get(runtimeEntryKey(descriptor.scopeId, descriptor.entryId));
  if (!entry || !Number.isFinite(estimatedBytes) || estimatedBytes < 0) return;
  entry.estimatedBytes = Math.max(entry.estimatedBytes, estimatedBytes);
}

export function evictFileMarkdownRuntimeEntry(scopeId: string, entryId: string): number {
  const key = runtimeEntryKey(scopeId, entryId);
  const runtimeEntry = retainedFileRuntimeEntries.get(key);
  retainedFileRuntimeEntries.delete(key);
  const evictedViews = fileMarkdownViewStateStore().evictEntry(scopeId, entryId);
  if (runtimeEntry) {
    sharedFileMarkdownRuntimeStore?.evictWhenDetached(runtimeEntry.identity);
    if (runtimeEntry.estimatedBytes >= LARGE_DOCUMENT_RELEASE_BYTES) scheduleMemoryRelease();
  }
  return evictedViews;
}

export function resetFileMarkdownRuntimeStoreForTests(): void {
  sharedFileMarkdownRuntimeStore?.close();
  sharedFileMarkdownViewStateStore?.clear();
  sharedFileMarkdownRuntimeStore = null;
  sharedFileMarkdownViewStateStore = null;
  retainedFileRuntimeEntries.clear();
  memoryReleaseScheduled = false;
}

function runtimeEntryKey(scopeId: string, entryId: string): string {
  return `${scopeId}\u0000${entryId}`;
}

function scheduleMemoryRelease(): void {
  if (memoryReleaseScheduled || typeof window === "undefined") return;
  memoryReleaseScheduled = true;
  const collect = () => {
    memoryReleaseScheduled = false;
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (typeof gc === "function") gc();
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(collect, { timeout: 2_000 });
  } else {
    window.setTimeout(collect, 250);
  }
}
