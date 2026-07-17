import type { KeydexDiffDocument, KeydexDiffFile } from "@/renderer/components/diff/model";
import { keydexDiffOpenPath } from "@/renderer/components/diff/DiffContextMenu";
import type { GitFileDiff } from "@/runtime/gitTypes";

export function gitOriginalPatchForFile(
  document: KeydexDiffDocument,
  sourceFiles: readonly GitFileDiff[],
  fileId: string | null | undefined,
): string {
  const index = fileId
    ? document.files.findIndex((file) => file.id === fileId)
    : document.files.length === 1 ? 0 : -1;
  const canonical = document.files[index];
  const source = sourceFiles[index];
  if (!canonical || !source || canonical.oldPath !== source.oldPath || canonical.newPath !== source.newPath) {
    throw new Error("Git 差异已变化，请刷新后重试");
  }
  return source.rawPatch;
}

export function gitDiffOpenCapability(
  file: KeydexDiffFile,
  sourceKind: "working_tree" | "index" | "stash" | "commit" | "compare",
  worktreeAvailablePaths: readonly string[] = [],
): { readonly path: string | null; readonly reason: string | null } {
  const path = keydexDiffOpenPath(file);
  if (!path) {
    return {
      path: null,
      reason: file.status === "deleted" ? "文件已删除，工作树中没有可打开的文件" : "此变更没有可打开的工作区路径",
    };
  }
  if (sourceKind === "stash" && !worktreeAvailablePaths.includes(path)) {
    return { path: null, reason: "储藏中的文件当前不在工作树中" };
  }
  return { path, reason: null };
}

/** Converts a repository-relative Git path into a workspace-relative preview path. */
export function gitWorkspacePreviewPath(
  workspaceRoot: string,
  repositoryRoot: string,
  repositoryPath: string,
): string | null {
  if (!repositoryPath || isAbsolutePath(repositoryPath)) return null;
  const workspace = parseAbsolutePath(workspaceRoot);
  const repository = parseAbsolutePath(repositoryRoot);
  if (!workspace || !repository || workspace.rootKey !== repository.rootKey) return null;
  const targetSegments = normalizeSegments([...repository.segments, ...splitPath(repositoryPath)]);
  if (!targetSegments || targetSegments.length < workspace.segments.length) return null;
  const caseInsensitive = workspace.caseInsensitive || repository.caseInsensitive;
  const same = workspace.segments.every((segment, index) =>
    comparePathSegment(segment, targetSegments[index]!, caseInsensitive),
  );
  if (!same) return null;
  const relative = targetSegments.slice(workspace.segments.length).join("/");
  return relative || null;
}

interface ParsedAbsolutePath {
  readonly rootKey: string;
  readonly segments: readonly string[];
  readonly caseInsensitive: boolean;
}

function parseAbsolutePath(value: string): ParsedAbsolutePath | null {
  const normalized = value.trim().replaceAll("\\", "/");
  const drive = /^([A-Za-z]):(?:\/|$)/u.exec(normalized);
  if (drive) {
    const segments = normalizeSegments(splitPath(normalized.slice(drive[0].length)));
    return segments ? { rootKey: `${drive[1]!.toLowerCase()}:`, segments, caseInsensitive: true } : null;
  }
  if (normalized.startsWith("//")) {
    const parts = splitPath(normalized.slice(2));
    if (parts.length < 2) return null;
    const segments = normalizeSegments(parts.slice(2));
    return segments ? {
      rootKey: `//${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`,
      segments,
      caseInsensitive: true,
    } : null;
  }
  if (normalized.startsWith("/")) {
    const segments = normalizeSegments(splitPath(normalized.slice(1)));
    return segments ? { rootKey: "/", segments, caseInsensitive: false } : null;
  }
  return null;
}

function normalizeSegments(input: readonly string[]): string[] | null {
  const result: string[] = [];
  for (const segment of input) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!result.length) return null;
      result.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    result.push(segment);
  }
  return result;
}

function splitPath(value: string): string[] {
  return value.replaceAll("\\", "/").split("/").filter(Boolean);
}

function isAbsolutePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized);
}

function comparePathSegment(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}
