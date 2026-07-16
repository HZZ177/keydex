import type { GitChangedFile, GitFileStatusCode } from "@/runtime/gitTypes";

export type GitChangeGroupId = "changes" | "untracked";

export interface GitChangeEntry {
  id: string;
  group: GitChangeGroupId;
  path: string;
  displayPath: string;
  directory: string;
  name: string;
  originalPath: string | null;
  status: GitFileStatusCode;
  indexStatus: GitFileStatusCode | null;
  worktreeStatus: GitFileStatusCode | null;
  binary: boolean;
  submodule: boolean;
}

export interface GitChangeGroup {
  id: GitChangeGroupId;
  label: string;
  entries: readonly GitChangeEntry[];
}

const GROUP_LABELS: Record<GitChangeGroupId, string> = {
  changes: "更改",
  untracked: "未跟踪",
};

export function groupGitChanges(files: readonly GitChangedFile[]): readonly GitChangeGroup[] {
  const grouped = new Map<GitChangeGroupId, GitChangeEntry[]>();
  const append = (group: GitChangeGroupId, file: GitChangedFile, status: GitFileStatusCode) => {
    const segments = file.path.replaceAll("\\", "/").split("/");
    const name = segments.pop() ?? file.path;
    const directory = segments.join("/");
    const entry: GitChangeEntry = {
      id: `${group}:${file.originalPath ?? ""}:${file.path}`,
      group,
      path: file.path,
      displayPath: file.originalPath && file.originalPath !== file.path
        ? `${file.originalPath} → ${file.path}`
        : file.path,
      directory,
      name,
      originalPath: file.originalPath,
      status,
      indexStatus: file.indexStatus,
      worktreeStatus: file.worktreeStatus,
      binary: file.binary === true,
      submodule: file.submodule,
    };
    grouped.set(group, [...(grouped.get(group) ?? []), entry]);
  };

  files.forEach((file) => {
    if (file.worktreeStatus === "ignored") return;
    const group: GitChangeGroupId = file.worktreeStatus === "untracked" ? "untracked" : "changes";
    append(group, file, displayStatus(file));
  });

  return (["changes", "untracked"] as GitChangeGroupId[])
    .map((id) => ({
      id,
      label: GROUP_LABELS[id],
      entries: (grouped.get(id) ?? []).sort((left, right) => left.path.localeCompare(right.path)),
    }))
    .filter((group) => group.entries.length > 0);
}

export function uniqueSelectedChangePaths(groups: readonly GitChangeGroup[], selectedIds: ReadonlySet<string>): string[] {
  return Array.from(new Set(
    groups.flatMap((group) => group.entries.filter((entry) => selectedIds.has(entry.id)).map((entry) => entry.path)),
  )).sort();
}

export interface GitCommitSelection {
  paths: readonly string[];
  untrackedPaths: readonly string[];
  fileCount: number;
}

export function commitSelectionFromEntries(entries: readonly GitChangeEntry[]): GitCommitSelection {
  const committable = entries.filter((entry) => entry.status !== "conflicted");
  const paths = new Set<string>();
  const files = new Set<string>();
  const untrackedPaths = new Set<string>();
  committable.forEach((entry) => {
    files.add(entry.path);
    paths.add(entry.path);
    if (entry.originalPath && entry.originalPath !== entry.path) paths.add(entry.originalPath);
    if (entry.group === "untracked") untrackedPaths.add(entry.path);
  });
  return {
    paths: Array.from(paths).sort(),
    untrackedPaths: Array.from(untrackedPaths).sort(),
    fileCount: files.size,
  };
}

function displayStatus(file: GitChangedFile): GitFileStatusCode {
  if (file.conflicted || file.indexStatus === "conflicted" || file.worktreeStatus === "conflicted") {
    return "conflicted";
  }
  if (file.worktreeStatus === "untracked") return "untracked";
  const statuses: GitFileStatusCode[] = [];
  if (file.worktreeStatus && file.worktreeStatus !== "ignored") statuses.push(file.worktreeStatus);
  if (file.indexStatus && file.indexStatus !== "ignored") statuses.push(file.indexStatus);
  return statuses.find((status) => status === "deleted")
    ?? statuses.find((status) => status === "added")
    ?? statuses[0]
    ?? "modified";
}
