import type {
  GitFileDiff,
  GitRepositoryId,
  GitRepositoryVersion,
} from "@/runtime/gitTypes";

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
import { normalizeUnifiedPatch } from "../normalizers/unifiedPatch";
import { reconcileDiffStatistics } from "../statistics";

export type GitDiffSourceKind = "working_tree" | "index" | "stash" | "commit" | "compare";

export interface GitDocumentInput {
  readonly repositoryId: GitRepositoryId | string;
  readonly repositoryVersion: GitRepositoryVersion | string;
  readonly sourceKind: GitDiffSourceKind;
  readonly files: readonly GitFileDiff[];
}

export function gitDocumentFromFiles(input: GitDocumentInput): KeydexDiffDocument {
  const sourceVersion = createDiffSourceVersion({
    revision: input.repositoryVersion,
    content: input.files.map((file) => file.rawPatch).join("\u0000"),
  });
  const scopeFingerprint = createDiffScopeFingerprint({
    source: "git",
    repositoryId: String(input.repositoryId),
    requestId: input.sourceKind,
  });
  const files: KeydexDiffFile[] = [];
  const diagnostics: KeydexDiffDiagnostic[] = [];

  input.files.forEach((dto, index) => {
    const status = gitStatus(dto.status);
    const parsed = dto.rawPatch.trim()
      ? normalizeUnifiedPatch(dto.rawPatch, {
          source: "git",
          sourceVersion,
          scopeFingerprint: `${scopeFingerprint}:${index}`,
          contentKind: dto.binary ? "binary" : undefined,
          truncated: dto.truncated,
          precision: "exact",
          selectableForPatch: !dto.binary && !dto.truncated,
        })
      : null;
    const parsedFile = parsed?.files[0];
    const parsedHunksMatchDto = Boolean(parsedFile && sameHunks(parsedFile, dto));
    const file = parsedFile
      ? createKeydexDiffFile({
          ...parsedFile,
          oldPath: dto.oldPath ?? parsedFile.oldPath,
          newPath: dto.newPath ?? parsedFile.newPath,
          oldOperationPath: dto.oldPath ?? parsedFile.oldOperationPath,
          newOperationPath: dto.newPath ?? parsedFile.newOperationPath,
          status,
          oldMode: dto.oldMode ?? parsedFile.oldMode,
          newMode: dto.newMode ?? parsedFile.newMode,
          binary: dto.binary,
          contentKind: dto.binary ? "binary" : parsedFile.contentKind,
          binaryReason: dto.binary ? parsedFile.binaryReason ?? "git_dto_binary" : parsedFile.binaryReason,
          truncated: dto.truncated,
          hunks: parsedHunksMatchDto ? gitHunks(dto) : parsedFile.hunks,
          selectableForPatch: !dto.binary && !dto.truncated,
        })
      : fileFromDto(dto, status, sourceVersion, `${scopeFingerprint}:${index}`);
    files.push(file);
    diagnostics.push(...(parsed?.diagnostics ?? []));
    diagnostics.push(...validateDto(file, dto, index));
  });

  const base = createKeydexDiffDocument({
    id: createDiffDocumentId({
      source: "git",
      scopeFingerprint,
      sourceVersion,
      fileIds: files.map((file) => file.id),
    }),
    source: "git",
    sourceVersion,
    files,
    diagnostics,
  });
  return reconcileDiffStatistics(base, input.files.map((file, index) => ({
    fileId: files[index]?.id,
    additions: file.additions,
    deletions: file.deletions,
  }))).document;
}

function fileFromDto(
  dto: GitFileDiff,
  status: KeydexDiffStatus,
  sourceVersion: string,
  scopeFingerprint: string,
): KeydexDiffFile {
  const oldPath = dto.oldPath;
  const newPath = dto.newPath;
  const fileId = createDiffFileId({ scopeFingerprint, status, oldPath, newPath });
  const language = resolveDiffLanguage({ path: newPath ?? oldPath });
  return createKeydexDiffFile({
    id: fileId,
    cacheKey: createDiffFileCacheKey({
      fileId,
      sourceVersion,
      language,
      patch: dto.rawPatch,
      binary: dto.binary,
      truncated: dto.truncated,
    }),
    oldPath,
    newPath,
    status,
    language,
    contentKind: dto.binary ? "binary" : dto.oldMode === "160000" || dto.newMode === "160000" ? "submodule" : "text",
    binaryReason: dto.binary ? "git_dto_binary" : null,
    binary: dto.binary,
    truncated: dto.truncated,
    patch: dto.rawPatch,
    oldMode: dto.oldMode,
    newMode: dto.newMode,
    additions: dto.additions,
    deletions: dto.deletions,
    hunks: gitHunks(dto),
    selectableForPatch: !dto.binary && !dto.truncated && Boolean(dto.rawPatch),
  });
}

function gitHunks(dto: GitFileDiff): KeydexDiffFile["hunks"] {
  return dto.hunks.map((hunk, index) => ({
    id: `git-hunk:${index}:${hunk.oldStart}:${hunk.newStart}`,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }));
}

function validateDto(file: KeydexDiffFile, dto: GitFileDiff, index: number): KeydexDiffDiagnostic[] {
  const diagnostics: KeydexDiffDiagnostic[] = [];
  const add = (code: string, message: string) => diagnostics.push({
    id: `diff-diagnostic:git:${index}:${code}`,
    code,
    severity: "warning",
    message,
    fileId: file.id,
  });
  if (dto.oldPath !== file.oldPath || dto.newPath !== file.newPath) {
    add("git_path_mismatch", "Git 路径元数据与原始差异不一致，已保留 Git 元数据路径。");
  }
  if (gitStatus(dto.status) !== file.status) {
    add("git_status_mismatch", "Git 状态元数据与原始差异不一致，已保留 Git 状态。");
  }
  if (dto.hunks.length && !sameHunks(file, dto)) {
    add("git_hunk_mismatch", "Git 变更块元数据与原始差异不一致，局部操作将使用原始 Git 变更块。");
  }
  if (!dto.rawPatch && !dto.binary && dto.oldMode === dto.newMode) {
    add("git_patch_missing", "Git 文件缺少可显示的原始差异内容。");
  }
  return diagnostics;
}

function sameHunks(file: KeydexDiffFile, dto: GitFileDiff): boolean {
  return file.hunks.length === dto.hunks.length && file.hunks.every((hunk, index) => {
    const other = dto.hunks[index];
    return Boolean(other) && hunk.header === other.header && hunk.oldStart === other.oldStart &&
      hunk.oldLines === other.oldLines && hunk.newStart === other.newStart &&
      hunk.newLines === other.newLines && hunk.lines.join("\n") === other.lines.join("\n");
  });
}

function gitStatus(status: GitFileDiff["status"]): KeydexDiffStatus {
  if (status === "untracked") return "added";
  if (status === "conflicted") return "modified";
  return status;
}
