import { describe, expect, it } from "vitest";

import {
  gitDialogBelongsToRepository,
  gitDialogScope,
  gitDialogTargetLabel,
  normalizeGitDialogText,
  requiredGitDialogValue,
  splitGitUpstream,
  validateGitBranchName,
  type GitDialogDraft,
} from "@/renderer/features/git/dialogs/gitDialogContracts";

describe("Git dialog contracts", () => {
  it("normalizes required input without changing internal newlines", () => {
    expect(normalizeGitDialogText("  feature/demo\r\nmessage  ")).toBe("feature/demo\nmessage");
    expect(requiredGitDialogValue("   ")).toEqual({ valid: false, value: "" });
    expect(requiredGitDialogValue(" main ")).toEqual({ valid: true, value: "main" });
  });

  it("splits only complete upstream references", () => {
    expect(splitGitUpstream("origin/feature/demo")).toEqual({ remote: "origin", branch: "feature/demo" });
    expect(splitGitUpstream("origin")).toBeNull();
    expect(splitGitUpstream("/main")).toBeNull();
    expect(splitGitUpstream(null)).toBeNull();
  });

  it("validates Git branch-name edge cases with actionable messages", () => {
    expect(validateGitBranchName("feature/dialog")).toEqual({ valid: true, message: "分支名称有效" });
    for (const invalid of ["", "-topic", "/topic", "topic/", "topic.", "a..b", "a@{b", "with space", "a~b", "a^b", "a:b", "a?b", "a*b", "a\\b", "a[b"]) {
      expect(validateGitBranchName(invalid).valid, invalid).toBe(false);
    }
    expect(validateGitBranchName("a".repeat(256))).toEqual({ valid: false, message: "分支名称过长" });
  });

  it("invalidates a transient draft after switching repositories", () => {
    const draft: GitDialogDraft = {
      kind: "create_branch",
      scope: gitDialogScope("repo-a" as never, "version-a" as never),
      target: { kind: "repository", repositoryId: "repo-a" as never },
      branchName: "feature/dialog",
      startPoint: "HEAD",
    };
    expect(gitDialogBelongsToRepository(draft, "repo-a" as never)).toBe(true);
    expect(gitDialogBelongsToRepository(draft, "repo-b" as never)).toBe(false);
    expect(gitDialogBelongsToRepository(null, "repo-a" as never)).toBe(false);
  });

  it("formats every supported target without exposing full object ids", () => {
    expect(gitDialogTargetLabel({ kind: "repository", repositoryId: "repo-a" as never })).toBe("repo-a");
    expect(gitDialogTargetLabel({ kind: "ref", fullName: "refs/heads/main", shortName: "main" })).toBe("main");
    expect(gitDialogTargetLabel({ kind: "remote", name: "origin" })).toBe("origin");
    expect(gitDialogTargetLabel({ kind: "stash", selector: "stash@{0}", objectId: "a".repeat(40) })).toBe("stash@{0} (aaaaaaaa)");
    expect(gitDialogTargetLabel({ kind: "operation", operation: "rebase", objectId: "b".repeat(40) })).toBe(`rebase ${"b".repeat(12)}`);
    expect(gitDialogTargetLabel({ kind: "operation", operation: "merge", objectId: null })).toBe("merge");
    expect(gitDialogTargetLabel({ kind: "worktree", path: "D:/worktree" })).toBe("D:/worktree");
  });
});
