import type { GitRef } from "@/runtime/gitTypes";

export function isConventionalMainBranch(ref: GitRef): boolean {
  if (ref.kind === "tag") return false;
  const branchName = ref.kind === "remote"
    ? ref.shortName.slice(ref.shortName.indexOf("/") + 1)
    : ref.shortName;
  return branchName.toLowerCase() === "main" || branchName.toLowerCase() === "master";
}
