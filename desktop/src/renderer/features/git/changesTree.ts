import type { GitChangedFile, GitFileStatusCode } from "@/runtime/gitTypes";

export type GitChangeGroupId = "conflicts" | "staged" | "unstaged" | "untracked" | "ignored";

export interface GitChangeEntry {
  id: string;
  group: GitChangeGroupId;
  path: string;
  displayPath: string;
  directory: string;
  name: string;
  originalPath: string | null;
  status: GitFileStatusCode;
  binary: boolean;
  submodule: boolean;
}

export interface GitChangeGroup {
  id: GitChangeGroupId;
  label: string;
  entries: readonly GitChangeEntry[];
}

const GROUP_LABELS: Record<GitChangeGroupId, string> = {
  conflicts: "冲突",
  staged: "已暂存",
  unstaged: "未暂存",
  untracked: "未跟踪",
  ignored: "已忽略",
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
      binary: file.binary === true,
      submodule: file.submodule,
    };
    grouped.set(group, [...(grouped.get(group) ?? []), entry]);
  };

  files.forEach((file) => {
    if (file.conflicted || file.indexStatus === "conflicted" || file.worktreeStatus === "conflicted") {
      append("conflicts", file, "conflicted");
      return;
    }
    if (file.indexStatus) append("staged", file, file.indexStatus);
    if (file.worktreeStatus === "untracked") append("untracked", file, "untracked");
    else if (file.worktreeStatus === "ignored") append("ignored", file, "ignored");
    else if (file.worktreeStatus) append("unstaged", file, file.worktreeStatus);
  });

  return (["conflicts", "staged", "unstaged", "untracked", "ignored"] as GitChangeGroupId[])
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
