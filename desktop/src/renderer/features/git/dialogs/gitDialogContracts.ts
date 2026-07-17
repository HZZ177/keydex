import type { GitRepositoryId, GitRepositoryVersion } from "@/runtime/gitTypes";

export interface GitDialogScope {
  repositoryId: GitRepositoryId;
  repositoryVersion: GitRepositoryVersion | null;
}

export type GitDialogTarget =
  | { kind: "repository"; repositoryId: GitRepositoryId }
  | { kind: "ref"; fullName: string; shortName: string }
  | { kind: "remote"; name: string }
  | { kind: "stash"; selector: string; objectId: string }
  | { kind: "operation"; operation: string; objectId: string | null }
  | { kind: "worktree"; path: string };

export type GitDialogDraft =
  | { kind: "create_branch"; scope: GitDialogScope; target: GitDialogTarget; branchName: string; startPoint: string }
  | { kind: "checkout"; scope: GitDialogScope; target: GitDialogTarget; ref: string; detach: boolean }
  | { kind: "rename_branch"; scope: GitDialogScope; target: GitDialogTarget; oldName: string; newName: string }
  | { kind: "update"; scope: GitDialogScope; target: GitDialogTarget; upstream: string; strategy: "ff_only" | "merge" | "rebase" }
  | { kind: "push"; scope: GitDialogScope; target: GitDialogTarget; remote: string; source: string; branch: string; forceWithLease: boolean }
  | { kind: "manage"; scope: GitDialogScope; target: GitDialogTarget; action: string }
  | { kind: "confirm"; scope: GitDialogScope; target: GitDialogTarget; action: string };

export function gitDialogScope(
  repositoryId: GitRepositoryId,
  repositoryVersion: GitRepositoryVersion | null | undefined,
): GitDialogScope {
  return { repositoryId, repositoryVersion: repositoryVersion ?? null };
}

export function gitDialogBelongsToRepository(
  draft: GitDialogDraft | null,
  repositoryId: GitRepositoryId | null | undefined,
): boolean {
  return Boolean(draft && repositoryId && draft.scope.repositoryId === repositoryId);
}

export function normalizeGitDialogText(value: string): string {
  return value.trim().replaceAll("\r\n", "\n");
}

export function requiredGitDialogValue(value: string): { valid: boolean; value: string } {
  const normalized = normalizeGitDialogText(value);
  return { valid: normalized.length > 0, value: normalized };
}

export function validateGitBranchName(value: string): { valid: boolean; message: string } {
  const branch = value.trim();
  if (!branch) return { valid: false, message: "请输入分支名称" };
  if (branch.length > 255) return { valid: false, message: "分支名称过长" };
  if (
    branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("@{")
    || /[\s~^:?*\\]/u.test(branch)
    || branch.includes("[")
  ) return { valid: false, message: "分支名称不符合 Git 规则" };
  return { valid: true, message: "分支名称有效" };
}

export function splitGitUpstream(upstream: string | null | undefined): { remote: string; branch: string } | null {
  const normalized = normalizeGitDialogText(upstream ?? "");
  const separator = normalized.indexOf("/");
  if (separator <= 0 || separator === normalized.length - 1) return null;
  return { remote: normalized.slice(0, separator), branch: normalized.slice(separator + 1) };
}

export function gitDialogTargetLabel(target: GitDialogTarget): string {
  switch (target.kind) {
    case "repository": return target.repositoryId;
    case "ref": return target.shortName;
    case "remote": return target.name;
    case "stash": return `${target.selector} (${target.objectId.slice(0, 8)})`;
    case "operation": return target.objectId ? `${target.operation} ${target.objectId.slice(0, 12)}` : target.operation;
    case "worktree": return target.path;
    default: return assertNever(target);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Git dialog target: ${JSON.stringify(value)}`);
}
