import type { GitFileDiff, GitStatusSnapshot } from "@/runtime/gitTypes";
import type { KeydexDiffDocument, KeydexDiffHunk } from "@/renderer/components/diff/model";
import type { KeydexGitHunkActionTarget } from "@/renderer/components/diff/profiles";
import type {
  KeydexDiffSelectionPoint,
  KeydexDiffSelectionRange,
} from "@/renderer/components/diff/selectionBridge";

export type GitPatchSourceKind = "working_tree" | "index";

export interface GitPatchActionIdentity {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryVersion: string;
  readonly sourceVersion: string;
  readonly sourceKind: GitPatchSourceKind;
  readonly sourcePatch: string;
  readonly sourcePaths: readonly string[];
}

export interface GitPatchActionCurrentIdentity {
  readonly workspaceId: string | null;
  readonly repositoryId: string | null;
  readonly repositoryVersion: string | null;
  readonly sourceVersion: string | null;
  readonly sourceKind: GitPatchSourceKind | null;
}

export type GitPatchActionIdentityResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "workspace" | "repository" | "repository_version" | "source_version" | "source_kind";
      readonly message: string;
    };

export interface GitPatchRefreshTarget {
  readonly path: string;
  readonly action: "stage" | "unstage";
  readonly sourceKind: GitPatchSourceKind;
}

export function resolveGitPatchRefreshTarget(
  status: Pick<GitStatusSnapshot, "files"> | null | undefined,
  selectedPath: string | null | undefined,
  sourcePaths: readonly string[],
): GitPatchRefreshTarget | null {
  const candidates = Array.from(new Set([
    selectedPath,
    ...[...sourcePaths].reverse(),
  ].filter((path): path is string => Boolean(path))));
  for (const candidate of candidates) {
    const file = status?.files.find((entry) =>
      entry.path === candidate || entry.originalPath === candidate,
    );
    if (!file) continue;
    const stagedOnly = Boolean(file.indexStatus && !file.worktreeStatus);
    return Object.freeze({
      path: file.path,
      action: stagedOnly ? "unstage" : "stage",
      sourceKind: stagedOnly ? "index" : "working_tree",
    });
  }
  return null;
}

export function validateGitPatchActionIdentity(
  prepared: GitPatchActionIdentity,
  current: GitPatchActionCurrentIdentity,
): GitPatchActionIdentityResult {
  if (prepared.workspaceId !== current.workspaceId) {
    return staleIdentity("workspace", "Git 项目已切换，已取消旧差异操作");
  }
  if (prepared.repositoryId !== current.repositoryId) {
    return staleIdentity("repository", "Git 仓库已切换，已取消旧差异操作");
  }
  if (prepared.sourceKind !== current.sourceKind) {
    return staleIdentity("source_kind", "暂存区视图已切换，请重新选择变更");
  }
  if (prepared.repositoryVersion !== current.repositoryVersion) {
    return staleIdentity("repository_version", "仓库状态已变化，请刷新后重新选择变更");
  }
  if (prepared.sourceVersion !== current.sourceVersion) {
    return staleIdentity("source_version", "文件差异已变化，请刷新后重新选择变更");
  }
  return { ok: true };
}

function staleIdentity(
  reason: Exclude<GitPatchActionIdentityResult, { readonly ok: true }>["reason"],
  message: string,
): GitPatchActionIdentityResult {
  return { ok: false, reason, message };
}

/**
 * Builds the exact repository-relative patch for one backend-provided Git hunk.
 * This module intentionally has no React or Pierre dependency so patch actions
 * remain testable against git itself.
 */
export function buildGitHunkPatch(diff: GitFileDiff, hunkIndex: number): string {
  assertArrayIndex(hunkIndex, "Git 差异变更块索引");
  const hunk = diff.hunks[hunkIndex];
  if (!hunk) throw new Error("未找到 Git 差异变更块");
  return buildGitPatchEnvelope(diff, `${hunk.header}\n${hunk.lines.join("\n")}\n`);
}

/** Builds a zero-context patch for one exact added or deleted Git line. */
export function buildGitLinePatch(diff: GitFileDiff, hunkIndex: number, lineIndex: number): string {
  assertArrayIndex(hunkIndex, "Git 差异变更块索引");
  assertArrayIndex(lineIndex, "Git 差异行索引");
  const hunk = diff.hunks[hunkIndex];
  const line = hunk?.lines[lineIndex];
  if (!hunk || !line || (line[0] !== "+" && line[0] !== "-")) {
    throw new Error("只能单独暂存 Git 差异中的新增行或删除行");
  }
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (let index = 0; index < lineIndex; index += 1) {
    const sign = hunk.lines[index]?.[0];
    if (sign !== "+") oldLine += 1;
    if (sign !== "-") newLine += 1;
  }
  const header = line[0] === "+"
    ? `@@ -${oldLine},0 +${newLine},1 @@`
    : `@@ -${oldLine},1 +${newLine},0 @@`;
  return buildGitPatchEnvelope(diff, `${header}\n${line}\n`);
}

export function buildGitPatchEnvelope(diff: GitFileDiff, body: string): string {
  const oldPath = validRepositoryPath(diff.oldPath ?? diff.newPath);
  const newPath = validRepositoryPath(diff.newPath ?? diff.oldPath);
  if (!oldPath || !newPath) throw new Error("Git 差异缺少文件路径");
  if (!body.trim()) throw new Error("Git 差异补丁内容为空");
  return [...gitPatchEnvelopeHeader(diff, oldPath, newPath), body.trimEnd(), ""].join("\n");
}

export function buildGitHunkPatchFromSelection(
  document: KeydexDiffDocument,
  sourceFiles: readonly GitFileDiff[],
  target: KeydexGitHunkActionTarget,
): string {
  if (document.source !== "git") throw new Error("局部 Git 操作只接受 Git 差异文档");
  const fileIndex = document.files.findIndex((file) => file.id === target.fileId);
  const file = document.files[fileIndex];
  const source = sourceFiles[fileIndex];
  if (!file || !source || file.cacheKey !== target.fileCacheKey) {
    throw new Error("Git 差异已变化，请刷新后重试");
  }
  if (!file.selectableForPatch || file.precision !== "exact" || file.truncated || file.binary) {
    throw new Error("当前 Git 差异不支持精确变更块操作");
  }
  const hunk = file.hunks.find((candidate) => candidate.id === target.hunkId);
  if (!hunk) throw new Error("Git 变更块已变化，请刷新后重试");
  const indexed = gitHunkIndex(target.hunkId);
  if (indexed !== null && sameGitHunk(hunk, source.hunks[indexed])) {
    return buildGitHunkPatch(source, indexed);
  }
  const matches = source.hunks
    .map((candidate, index) => sameGitHunk(hunk, candidate) ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new Error(matches.length ? "Git 变更块身份不唯一，请刷新后重试" : "未找到原始 Git 变更块");
  }
  return buildGitHunkPatch(source, matches[0]!);
}

export function buildGitSelectionPatches(
  document: KeydexDiffDocument,
  sourceFiles: readonly GitFileDiff[],
  selection: KeydexDiffSelectionRange,
  mode: "stage" | "unstage" = "stage",
): readonly string[] {
  return buildGitSelectionPatchBatch(document, sourceFiles, [selection], mode);
}

export function buildGitSelectionPatchBatch(
  document: KeydexDiffDocument,
  sourceFiles: readonly GitFileDiff[],
  selections: readonly KeydexDiffSelectionRange[],
  mode: "stage" | "unstage" = "stage",
): readonly string[] {
  if (document.source !== "git") throw new Error("局部 Git 操作只接受 Git 差异文档");
  if (!selections.length) throw new Error("请先选择要操作的 Git 变更行");
  const selectedByFile = new Map<number, Map<number, Set<number>>>();

  for (const selection of selections) {
    if (selection.anchor.fileId !== selection.focus.fileId ||
        selection.anchor.fileCacheKey !== selection.focus.fileCacheKey) {
      throw new Error("Git 行选择不能跨越不同文件或文件版本");
    }
    const fileIndex = document.files.findIndex((file) => file.id === selection.anchor.fileId);
    const file = document.files[fileIndex];
    const source = sourceFiles[fileIndex];
    if (!file || !source || file.cacheKey !== selection.anchor.fileCacheKey) {
      throw new Error("Git 差异已变化，请刷新后重试");
    }
    if (!file.selectableForPatch || file.precision !== "exact" || file.truncated || file.binary) {
      throw new Error("当前 Git 差异不支持精确行操作");
    }
    const anchor = locateSelectionPoint(file.hunks, selection.anchor);
    const focus = locateSelectionPoint(file.hunks, selection.focus);
    if (!anchor || !focus) throw new Error("选择的 Git 行已变化，请刷新后重试");
    const [start, end] = compareLocatedPoint(anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
    const selectedByHunk = selectedByFile.get(fileIndex) ?? new Map<number, Set<number>>();
    for (let hunkIndex = start.hunkIndex; hunkIndex <= end.hunkIndex; hunkIndex += 1) {
      const visualLines = visualHunkLines(file.hunks[hunkIndex]!);
      const first = hunkIndex === start.hunkIndex ? start.visualIndex : 0;
      const last = hunkIndex === end.hunkIndex ? end.visualIndex : Number.POSITIVE_INFINITY;
      const selected = selectedByHunk.get(hunkIndex) ?? new Set<number>();
      visualLines
        .filter((line) => line.visualIndex >= first && line.visualIndex <= last)
        .filter((line) => line.sign === "+" || line.sign === "-")
        .forEach((line) => selected.add(line.patchIndex));
      if (selected.size) selectedByHunk.set(hunkIndex, selected);
    }
    selectedByFile.set(fileIndex, selectedByHunk);
  }

  if (![...selectedByFile.values()].some((hunks) => hunks.size > 0)) {
    throw new Error("所选范围不包含可操作的新增行或删除行");
  }
  const patches = [...selectedByFile.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, hunks]) => hunks.size > 0)
    .map(([fileIndex, selectedByHunk]) => {
      const file = document.files[fileIndex]!;
      const source = sourceFiles[fileIndex]!;
      let cumulativeDelta = 0;
      const bodies = [...selectedByHunk.entries()]
        .sort(([left], [right]) => left - right)
        .map(([canonicalHunkIndex, selectedLineIndices]) => {
          const canonicalHunk = file.hunks[canonicalHunkIndex]!;
          const sourceHunk = source.hunks[sourceHunkIndexForCanonical(canonicalHunk, source)]!;
          const body = partialHunkBody(sourceHunk.lines, selectedLineIndices, mode);
          const oldLines = countHunkLines(body, "old");
          const newLines = countHunkLines(body, "new");
          const oldStart = sourceHunk.oldStart;
          const newStart = Math.max(0, oldStart + cumulativeDelta - (newLines === 0 ? 1 : 0));
          cumulativeDelta += newLines - oldLines;
          const suffix = sourceHunk.header.replace(/^@@[^@]*@@/u, "");
          const header = `@@ -${formatHunkRange(oldStart, oldLines)} +${formatHunkRange(newStart, newLines)} @@${suffix}`;
          return `${header}\n${body.join("\n")}`;
        });
      return buildGitPatchEnvelope(source, `${bodies.join("\n")}\n`);
    });
  return Object.freeze(patches);
}

function assertArrayIndex(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label}无效`);
  }
}

function validRepositoryPath(path: string | null | undefined): string | null {
  const value = path?.replace(/\\/gu, "/") ?? "";
  if (!value) return null;
  if (/^[A-Za-z]:\//u.test(value) || value.startsWith("/") || /[\0\r\n]/u.test(value)) {
    throw new Error("Git 差异路径必须是安全的仓库相对路径");
  }
  if (value.split("/").some((segment) => segment === "..")) {
    throw new Error("Git 差异路径不能离开仓库");
  }
  return value.replace(/^\.\//u, "");
}

function gitPatchEnvelopeHeader(diff: GitFileDiff, oldPath: string, newPath: string): string[] {
  const preserved = originalGitHeader(diff.rawPatch);
  if (preserved.length) return preserved;
  const oldToken = gitPathToken(`a/${oldPath}`);
  const newToken = gitPathToken(`b/${newPath}`);
  const header = [`diff --git ${oldToken} ${newToken}`];
  const added = diff.status === "added" || diff.status === "untracked" || !diff.oldPath;
  const deleted = diff.status === "deleted" || !diff.newPath;
  if (added) header.push(`new file mode ${diff.newMode ?? "100644"}`);
  else if (deleted) header.push(`deleted file mode ${diff.oldMode ?? "100644"}`);
  else if (diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode) {
    header.push(`old mode ${diff.oldMode}`, `new mode ${diff.newMode}`);
  }
  if (diff.status === "renamed" && diff.oldPath && diff.newPath) {
    header.push(`rename from ${gitMetadataPath(diff.oldPath)}`, `rename to ${gitMetadataPath(diff.newPath)}`);
  }
  if (diff.status === "copied" && diff.oldPath && diff.newPath) {
    header.push(`copy from ${gitMetadataPath(diff.oldPath)}`, `copy to ${gitMetadataPath(diff.newPath)}`);
  }
  header.push(
    added ? "--- /dev/null" : `--- ${oldToken}`,
    deleted ? "+++ /dev/null" : `+++ ${newToken}`,
  );
  return header;
}

function originalGitHeader(rawPatch: string): string[] {
  const normalized = rawPatch.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("diff --git ")) return [];
  const header: string[] = [];
  for (const line of normalized.split("\n")) {
    if (line.startsWith("@@") || line === "GIT binary patch" || line.startsWith("Binary files ")) break;
    if (line || header.length) header.push(line);
  }
  while (header.at(-1) === "") header.pop();
  return header;
}

function gitPathToken(path: string): string {
  return /^[A-Za-z0-9_./@+-]+$/u.test(path)
    ? path
    : `"${path.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function gitMetadataPath(path: string): string {
  return /^[A-Za-z0-9_./@+ -]+$/u.test(path) && !path.startsWith(" ") && !path.endsWith(" ")
    ? path
    : gitPathToken(path);
}

function gitHunkIndex(hunkId: string): number | null {
  const match = /^git-hunk:(\d+):/u.exec(hunkId);
  return match ? Number(match[1]) : null;
}

interface VisualHunkLine {
  readonly patchIndex: number;
  readonly visualIndex: number;
  readonly sign: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

function locateSelectionPoint(
  hunks: readonly KeydexDiffHunk[],
  point: KeydexDiffSelectionPoint,
): { hunkIndex: number; visualIndex: number } | null {
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const line = visualHunkLines(hunks[hunkIndex]!).find((candidate) =>
      point.side === "old" ? candidate.oldLine === point.line : candidate.newLine === point.line,
    );
    if (line) return { hunkIndex, visualIndex: line.visualIndex };
  }
  return null;
}

function compareLocatedPoint(
  left: { hunkIndex: number; visualIndex: number },
  right: { hunkIndex: number; visualIndex: number },
): number {
  return left.hunkIndex === right.hunkIndex
    ? left.visualIndex - right.visualIndex
    : left.hunkIndex - right.hunkIndex;
}

function visualHunkLines(hunk: KeydexDiffHunk): readonly VisualHunkLine[] {
  const lines: VisualHunkLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let visualIndex = 0;
  hunk.lines.forEach((value, patchIndex) => {
    if (value.startsWith("\\ No newline")) return;
    const sign = value[0] ?? " ";
    lines.push({
      patchIndex,
      visualIndex,
      sign,
      oldLine: sign === "+" ? null : oldLine,
      newLine: sign === "-" ? null : newLine,
    });
    if (sign !== "+") oldLine += 1;
    if (sign !== "-") newLine += 1;
    visualIndex += 1;
  });
  return lines;
}

function sourceHunkIndexForCanonical(canonical: KeydexDiffHunk, source: GitFileDiff): number {
  const indexed = gitHunkIndex(canonical.id);
  if (indexed !== null && sameGitHunk(canonical, source.hunks[indexed])) return indexed;
  const matches = source.hunks
    .map((candidate, index) => sameGitHunk(canonical, candidate) ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) throw new Error("未找到唯一的原始 Git 变更块");
  return matches[0]!;
}

function partialHunkBody(
  lines: readonly string[],
  selected: ReadonlySet<number>,
  mode: "stage" | "unstage",
): string[] {
  const body: string[] = [];
  let previousWasRetained = false;
  lines.forEach((line, index) => {
    if (line.startsWith("\\ No newline")) {
      if (previousWasRetained) body.push(line);
      return;
    }
    const sign = line[0];
    if (sign === "+") {
      const isSelected = selected.has(index);
      previousWasRetained = mode === "stage" ? isSelected : true;
      if (isSelected) body.push(line);
      else if (mode === "unstage") body.push(` ${line.slice(1)}`);
      return;
    }
    if (sign === "-") {
      const isSelected = selected.has(index);
      previousWasRetained = mode === "stage" ? true : isSelected;
      if (isSelected) body.push(line);
      else if (mode === "stage") body.push(` ${line.slice(1)}`);
      return;
    }
    previousWasRetained = true;
    body.push(line.startsWith(" ") ? line : ` ${line}`);
  });
  return body;
}

function countHunkLines(lines: readonly string[], side: "old" | "new"): number {
  return lines.reduce((count, line) => {
    if (line.startsWith("\\ No newline")) return count;
    if (side === "old" && line.startsWith("+")) return count;
    if (side === "new" && line.startsWith("-")) return count;
    return count + 1;
  }, 0);
}

function formatHunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function sameGitHunk(
  canonical: KeydexDiffHunk,
  source: GitFileDiff["hunks"][number] | undefined,
): boolean {
  return Boolean(source) && canonical.header === source!.header &&
    canonical.oldStart === source!.oldStart && canonical.oldLines === source!.oldLines &&
    canonical.newStart === source!.newStart && canonical.newLines === source!.newLines &&
    canonical.lines.join("\n") === source!.lines.join("\n");
}
