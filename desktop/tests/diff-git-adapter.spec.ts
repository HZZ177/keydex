import { describe, expect, it } from "vitest";

import { gitDocumentFromFiles } from "@/renderer/components/diff/adapters/gitDocument";
import type { GitFileDiff } from "@/runtime/gitTypes";

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

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
    hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
    rawPatch: patch,
    truncated: false,
    ...overrides,
  };
}

describe("GitFileDiff document adapter", () => {
  it.each(["working_tree", "index", "stash", "commit", "compare"] as const)(
    "normalizes %s DTOs with stable repository identity",
    (sourceKind) => {
      const first = gitDocumentFromFiles({ repositoryId: "repo-1", repositoryVersion: "v1", sourceKind, files: [file()] });
      const second = gitDocumentFromFiles({ repositoryId: "repo-1", repositoryVersion: "v1", sourceKind, files: [file()] });
      expect(first.id).toBe(second.id);
      expect(first.files[0]).toMatchObject({ language: "typescript", status: "modified", selectableForPatch: true });
    },
  );

  it("diagnoses hunk and statistic mismatches without dropping trusted Git metadata", () => {
    const document = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [file({ additions: 9, hunks: [{ header: "@@ bad", oldStart: 3, oldLines: 1, newStart: 4, newLines: 1, lines: ["-x", "+y"] }] })],
    });
    expect(document.files[0]?.additions).toBe(9);
    expect(document.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "git_hunk_mismatch" }),
      expect.objectContaining({ code: "producer_stat_mismatch" }),
    ]));
  });

  it.each([
    ["renamed", false, false],
    ["type_changed", false, false],
    ["modified", true, false],
    ["modified", false, true],
  ] as const)("keeps %s binary=%s truncated=%s safety", (status, binary, truncated) => {
    const document = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "v2",
      sourceKind: "index",
      files: [file({ status, binary, truncated, rawPatch: binary ? "" : patch, hunks: binary ? [] : file().hunks })],
    });
    expect(document.files[0]).toMatchObject({
      status,
      binary,
      truncated,
      selectableForPatch: !binary && !truncated,
    });
  });

  it("maps untracked and conflicted runtime statuses to renderable domain states", () => {
    const document = gitDocumentFromFiles({
      repositoryId: "repo-1",
      repositoryVersion: "v3",
      sourceKind: "working_tree",
      files: [
        file({ oldPath: null, newPath: "new.ts", status: "untracked", rawPatch: "", hunks: [] }),
        file({ oldPath: "conflict.ts", newPath: "conflict.ts", status: "conflicted", rawPatch: "", hunks: [] }),
      ],
    });
    expect(document.files.map((entry) => entry.status)).toEqual(["added", "modified"]);
  });
});
