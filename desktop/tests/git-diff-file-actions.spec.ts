import { describe, expect, it } from "vitest";

import { gitDocumentFromFiles } from "@/renderer/components/diff/adapters/gitDocument";
import {
  gitDiffOpenCapability,
  gitOriginalPatchForFile,
  gitWorkspacePreviewPath,
} from "@/renderer/features/git/gitDiffFileActions";
import type { GitFileDiff } from "@/runtime/gitTypes";

describe("Git Diff copy and open contracts", () => {
  it("returns the backend raw patch byte-for-byte instead of normalized renderer text", () => {
    const rawPatch = "diff --git a/src/a.ts b/src/a.ts\r\n--- a/src/a.ts\r\n+++ b/src/a.ts\r\n@@ -1 +1 @@\r\n-old  \r\n+new\t\r\n";
    const source = file({ rawPatch });
    const document = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    expect(gitOriginalPatchForFile(document, [source], document.files[0]!.id)).toBe(rawPatch);
    expect(gitOriginalPatchForFile(document, [source], document.files[0]!.id)).not.toBe(document.files[0]!.patch.replaceAll("\r\n", "\n"));
  });

  it("opens a rename target and makes a deleted file explicitly unavailable", () => {
    const renamedSource = file({ status: "renamed", oldPath: "src/old.ts", newPath: "src/new.ts" });
    const renamed = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "v2",
      sourceKind: "working_tree",
      files: [renamedSource],
    }).files[0]!;
    expect(gitDiffOpenCapability(renamed, "working_tree")).toEqual({ path: "src/new.ts", reason: null });

    const deletedSource = file({ status: "deleted", newPath: null });
    const deleted = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "v3",
      sourceKind: "working_tree",
      files: [deletedSource],
    }).files[0]!;
    expect(gitDiffOpenCapability(deleted, "working_tree")).toEqual({
      path: null,
      reason: "文件已删除，工作树中没有可打开的文件",
    });
  });

  it("only exposes a stash path after the host proves that it exists in the worktree", () => {
    const source = file();
    const stashFile = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "stash-v1",
      sourceKind: "stash",
      files: [source],
    }).files[0]!;
    expect(gitDiffOpenCapability(stashFile, "stash")).toEqual({
      path: null,
      reason: "储藏中的文件当前不在工作树中",
    });
    expect(gitDiffOpenCapability(stashFile, "stash", ["src/a.ts"])).toEqual({
      path: "src/a.ts",
      reason: null,
    });
  });

  it("converts nested and ancestor repository paths to safe workspace-relative paths", () => {
    expect(gitWorkspacePreviewPath(
      "D:\\Projects\\keydex",
      "D:\\Projects\\keydex\\packages\\desktop",
      "src/main.ts",
    )).toBe("packages/desktop/src/main.ts");
    expect(gitWorkspacePreviewPath(
      "D:\\Projects\\mono\\keydex",
      "D:\\Projects\\mono",
      "keydex/src/main.ts",
    )).toBe("src/main.ts");
    expect(gitWorkspacePreviewPath(
      "D:\\Projects\\keydex",
      "D:\\Other\\repo",
      "src/main.ts",
    )).toBeNull();
    expect(gitWorkspacePreviewPath(
      "D:\\Projects\\keydex",
      "D:\\Projects\\keydex",
      "../secret.txt",
    )).toBeNull();
  });

  it("rejects a stale canonical file identity", () => {
    const source = file();
    const document = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "v4",
      sourceKind: "index",
      files: [source],
    });
    expect(() => gitOriginalPatchForFile(document, [{ ...source, newPath: "src/other.ts" }], document.files[0]!.id))
      .toThrow("Git 差异已变化");
  });
});

function file(overrides: Partial<GitFileDiff> = {}): GitFileDiff {
  return {
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    status: "modified",
    binary: false,
    oldMode: "100644",
    newMode: "100644",
    additions: 1,
    deletions: 1,
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-old", "+new"],
    }],
    rawPatch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false,
    ...overrides,
  };
}
