import type { ConversationMessage } from "@/renderer/stores/conversationStore";
import {
  fileReviewChangesFromMessage,
  type FileReviewChange,
} from "@/renderer/utils/fileReview";

import {
  createDiffDocumentId,
  createDiffFileCacheKey,
  createDiffFileId,
  createDiffScopeFingerprint,
  createDiffSourceVersion,
} from "../identity";
import { resolveDiffLanguage } from "../language";
import {
  createKeydexDiffDocument,
  createKeydexDiffFile,
  type KeydexDiffDiagnostic,
  type KeydexDiffDocument,
  type KeydexDiffFile,
  type KeydexDiffStatus,
} from "../model";
import { normalizeApplyPatch } from "../normalizers/applyPatch";
import { normalizeContentOnlyAddedFile } from "../normalizers/contentOnly";
import { normalizeUnifiedPatch } from "../normalizers/unifiedPatch";
import { reconcileDiffStatistics } from "../statistics";

export interface FileReviewDocumentOptions {
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly sourceVersion?: string;
}

export function fileReviewDocumentFromMessage(
  message: ConversationMessage,
  fallbackTarget = "",
  options: FileReviewDocumentOptions = {},
): KeydexDiffDocument {
  return fileReviewDocumentFromChanges(fileReviewChangesFromMessage(message, fallbackTarget), options);
}

export function fileReviewDocumentFromChanges(
  changes: readonly FileReviewChange[],
  options: FileReviewDocumentOptions = {},
): KeydexDiffDocument {
  const merged = mergeWireChanges(changes);
  const version = options.sourceVersion ?? createDiffSourceVersion({
    revision: "file-review",
    content: merged.map((change) => [
      change.path,
      change.oldPath ?? "",
      change.newPath ?? "",
      change.operation,
      change.source ?? "unknown",
      change.diff,
      change.content ?? "",
    ].join("\u0000")).join("\u0001"),
  });
  const scopeFingerprint = createDiffScopeFingerprint({
    source: "agent",
    sessionId: options.sessionId,
    requestId: options.requestId,
  });
  const files: KeydexDiffFile[] = [];
  const diagnostics: KeydexDiffDiagnostic[] = [];

  for (const change of merged) {
    const normalized = normalizeWireChange(change, version, scopeFingerprint);
    diagnostics.push(...normalized.diagnostics);
    const reconciled = reconcileDiffStatistics(normalized, normalized.files.map((file) => ({
      fileId: file.id,
      additions: change.additions,
      deletions: change.deletions,
    })));
    files.push(...reconciled.document.files);
    diagnostics.push(
      ...reconciled.document.diagnostics.filter(
        (item) => !normalized.diagnostics.some((existing) => existing.id === item.id),
      ),
    );
  }

  const uniqueFiles = dedupeFiles(files);
  return createKeydexDiffDocument({
    id: createDiffDocumentId({
      source: "agent",
      scopeFingerprint,
      sourceVersion: version,
      fileIds: uniqueFiles.map((file) => file.id),
    }),
    source: "agent",
    sourceVersion: version,
    files: uniqueFiles,
    diagnostics: dedupeDiagnostics(diagnostics),
  });
}

function normalizeWireChange(
  change: FileReviewChange,
  sourceVersion: string,
  scopeFingerprint: string,
): KeydexDiffDocument {
  if (change.diff.trimStart().startsWith("*** Begin Patch")) {
    return normalizeApplyPatch(change.diff, { source: "agent", sourceVersion, scopeFingerprint });
  }
  if (change.diff.trim()) {
    return normalizeUnifiedPatch(change.diff, {
      source: "agent",
      sourceVersion,
      scopeFingerprint,
      contentKind: change.binary ? "binary" : undefined,
      truncated: change.truncated,
      precision: change.patchPrecision ?? "exact",
      selectableForPatch: false,
    });
  }
  if ((change.operation === "add" || change.operation === "write") && change.content !== undefined) {
    return normalizeContentOnlyAddedFile(
      { path: change.newPath ?? change.path, content: change.content, operation: change.operation },
      { source: "agent", sourceVersion, scopeFingerprint },
    );
  }
  return metadataOnlyDocument(change, sourceVersion, scopeFingerprint);
}

function metadataOnlyDocument(
  change: FileReviewChange,
  sourceVersion: string,
  scopeFingerprint: string,
): KeydexDiffDocument {
  const status = statusFromOperation(change.operation);
  const oldPath = status === "added" ? null : change.oldPath ?? change.path;
  const newPath = status === "deleted" ? null : change.newPath ?? change.path;
  const fileId = createDiffFileId({ scopeFingerprint, status, oldPath, newPath });
  const language = resolveDiffLanguage({ path: newPath ?? oldPath, content: change.content });
  const file = createKeydexDiffFile({
    id: fileId,
    cacheKey: createDiffFileCacheKey({
      fileId,
      sourceVersion,
      language,
      patch: "",
      newContent: change.content,
      binary: change.binary,
      truncated: change.truncated,
    }),
    oldPath,
    newPath,
    status,
    language,
    patch: "",
    ...(change.content === undefined || change.binary ? {} : { newContent: change.content }),
    contentKind: change.binary ? "binary" : "text",
    binaryReason: change.binary ? "tool_result_binary" : null,
    binary: change.binary ?? false,
    truncated: change.truncated ?? false,
    additions: change.additions,
    deletions: change.deletions,
    precision: change.patchPrecision ?? "approximate",
    selectableForPatch: false,
  });
  return createKeydexDiffDocument({
    id: createDiffDocumentId({ source: "agent", scopeFingerprint, sourceVersion, fileIds: [file.id] }),
    source: "agent",
    sourceVersion,
    files: [file],
    diagnostics: [{
      id: `diff-diagnostic:metadata-only:${file.id}`,
      code: "metadata_only_change",
      severity: "info",
      message: "该历史变更仅包含文件元数据，没有可显示的精确差异内容。",
      fileId: file.id,
    }],
  });
}

function mergeWireChanges(changes: readonly FileReviewChange[]): FileReviewChange[] {
  const byPath = new Map<string, FileReviewChange>();
  for (const change of changes) {
    const key = (change.newPath ?? change.path).replaceAll("\\", "/");
    const previous = byPath.get(key);
    if (!previous) {
      byPath.set(key, change);
      continue;
    }
    const nextIsFinal = change.source === "final" || previous.source !== "final";
    const primary = nextIsFinal ? change : previous;
    const fallback = nextIsFinal ? previous : change;
    byPath.set(key, {
      ...fallback,
      ...primary,
      diff: primary.diff || fallback.diff,
      content: primary.content ?? fallback.content,
      oldPath: primary.oldPath ?? fallback.oldPath,
      newPath: primary.newPath ?? fallback.newPath,
      source: primary.source ?? fallback.source,
    });
  }
  return [...byPath.values()];
}

function statusFromOperation(operation: FileReviewChange["operation"]): KeydexDiffStatus {
  if (operation === "add" || operation === "write") return "added";
  if (operation === "delete") return "deleted";
  if (operation === "move") return "renamed";
  return "modified";
}

function dedupeFiles(files: readonly KeydexDiffFile[]): KeydexDiffFile[] {
  const byPath = new Map<string, KeydexDiffFile>();
  for (const file of files) byPath.set(file.newPath ?? file.oldPath ?? file.id, file);
  return [...byPath.values()];
}

function dedupeDiagnostics(diagnostics: readonly KeydexDiffDiagnostic[]): KeydexDiffDiagnostic[] {
  return [...new Map(diagnostics.map((item) => [item.id, item])).values()];
}
