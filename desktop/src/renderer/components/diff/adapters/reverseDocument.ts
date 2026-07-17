import type { SessionReverseFilePreview } from "@/runtime/conversation";

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
  type KeydexDiffDocument,
  type KeydexDiffStatus,
} from "../model";
import { normalizeUnifiedPatch } from "../normalizers/unifiedPatch";
import { reconcileDiffStatistics } from "../statistics";

export function reverseDocumentFromFiles(
  files: readonly SessionReverseFilePreview[],
  operationId: string,
): KeydexDiffDocument {
  const sourceVersion = createDiffSourceVersion({
    revision: operationId,
    content: files.map((file) => [
      file.resource_id,
      file.current_hash ?? "",
      file.target_hash ?? "",
      file.raw_patch ?? file.diff ?? "",
    ].join(":" )).join("\n"),
  });
  const scopeFingerprint = createDiffScopeFingerprint({ source: "reverse", requestId: operationId });
  const normalizedFiles = files.flatMap((file) => {
    const patch = reverseDisplayPatch(file);
    if (patch && !file.binary && !file.truncated) {
      const normalized = normalizeUnifiedPatch(patch, {
        source: "reverse",
        sourceVersion,
        scopeFingerprint,
        precision: file.patch_precision ?? (file.raw_patch ? "exact" : "approximate"),
        selectableForPatch: false,
      });
      return reconcileDiffStatistics(normalized, normalized.files.map((entry) => ({
        fileId: entry.id,
        additions: file.insertions,
        deletions: file.deletions,
      }))).document.files;
    }
    const status = reverseStatus(file);
    const path = file.display_path || file.path;
    const oldPath = status === "added" ? null : path;
    const newPath = status === "deleted" ? null : path;
    const fileId = createDiffFileId({ scopeFingerprint, status, oldPath, newPath });
    const language = resolveDiffLanguage({ path });
    return [createKeydexDiffFile({
      id: fileId,
      cacheKey: createDiffFileCacheKey({
        fileId,
        sourceVersion,
        language,
        patch: "",
        binary: file.binary,
        truncated: file.truncated,
      }),
      oldPath,
      newPath,
      status,
      language,
      contentKind: file.binary ? "binary" : file.content_kind ?? "text",
      binaryReason: file.binary_reason ?? null,
      binary: file.binary,
      truncated: file.truncated,
      patch: "",
      additions: file.insertions,
      deletions: file.deletions,
      precision: file.patch_precision ?? "exact",
      selectableForPatch: false,
    })];
  });
  return createKeydexDiffDocument({
    id: createDiffDocumentId({
      source: "reverse",
      scopeFingerprint,
      sourceVersion,
      fileIds: normalizedFiles.map((file) => file.id),
    }),
    source: "reverse",
    sourceVersion,
    files: normalizedFiles,
    diagnostics: files.flatMap((file, index) => file.truncated ? [{
      id: `diff-diagnostic:reverse-truncated:${index}`,
      code: "reverse_preview_truncated",
      severity: "warning" as const,
      message: "回退差异内容已截断，无法展示不完整的代码差异。",
      details: { reason: file.truncation_reason ?? "unknown" },
    }] : []),
  });
}

function reverseDisplayPatch(file: SessionReverseFilePreview): string {
  const source = file.raw_patch ?? file.diff ?? "";
  if (!source || file.binary || file.truncated) return "";
  if (/^(?:diff --git |--- |\*\*\* Begin Patch)/m.test(source)) return source;
  const path = (file.display_path || file.path).replaceAll("\\", "/");
  const oldPath = file.current_state === "missing" ? "/dev/null" : `a/${path}`;
  const newPath = file.target_state === "missing" ? "/dev/null" : `b/${path}`;
  const oldLines = Math.max(0, file.deletions);
  const newLines = Math.max(0, file.insertions);
  return [
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -1,${oldLines} +1,${newLines} @@`,
    source,
  ].join("\n");
}

function reverseStatus(file: SessionReverseFilePreview): KeydexDiffStatus {
  if (file.status && file.status !== "unknown") return file.status;
  if (file.current_state === "missing" && file.target_state === "file") return "added";
  if (file.current_state === "file" && file.target_state === "missing") return "deleted";
  return "modified";
}
