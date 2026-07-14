import { MarkdownRuntimeStore } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import { MarkdownViewStateStore } from "@/renderer/markdownRuntime/view";
import { markdownRuntimeDiagnostics } from "@/renderer/markdownRuntime/diagnostics";

let sharedFileMarkdownRuntimeStore: MarkdownRuntimeStore | null = null;
let sharedFileMarkdownViewStateStore: MarkdownViewStateStore | null = null;

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

export function evictFileMarkdownRuntimeEntry(scopeId: string, entryId: string): number {
  return fileMarkdownViewStateStore().evictEntry(scopeId, entryId);
}

export function resetFileMarkdownRuntimeStoreForTests(): void {
  sharedFileMarkdownRuntimeStore?.close();
  sharedFileMarkdownViewStateStore?.clear();
  sharedFileMarkdownRuntimeStore = null;
  sharedFileMarkdownViewStateStore = null;
}
