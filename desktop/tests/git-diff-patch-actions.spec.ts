import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GitFileDiff } from "@/runtime/gitTypes";
import { gitDocumentFromFiles } from "@/renderer/components/diff/adapters/gitDocument";
import {
  buildGitHunkPatch,
  buildGitHunkPatchFromSelection,
  buildGitLinePatch,
  buildGitPatchEnvelope,
  buildGitSelectionPatches,
  buildGitSelectionPatchBatch,
  resolveGitPatchRefreshTarget,
  validateGitPatchActionIdentity,
  type GitPatchActionIdentity,
} from "@/renderer/features/git/diffPatchActions";

const temporaryRepositories: string[] = [];

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true });
  }
});

describe("Git pure patch actions", () => {
  it("rejects patch actions after workspace, repository, version, source, or mode changes", () => {
    const prepared: GitPatchActionIdentity = {
      workspaceId: "workspace-1",
      repositoryId: "repo-1",
      repositoryVersion: "repository-v1",
      sourceVersion: "source-v1",
      sourceKind: "working_tree",
      sourcePatch: "patch",
      sourcePaths: ["src/a.ts"],
    };
    const current = {
      workspaceId: "workspace-1",
      repositoryId: "repo-1",
      repositoryVersion: "repository-v1",
      sourceVersion: "source-v1",
      sourceKind: "working_tree" as const,
    };
    expect(validateGitPatchActionIdentity(prepared, current)).toEqual({ ok: true });
    expect(validateGitPatchActionIdentity(prepared, { ...current, workspaceId: "workspace-2" }))
      .toMatchObject({ ok: false, reason: "workspace" });
    expect(validateGitPatchActionIdentity(prepared, { ...current, repositoryId: "repo-2" }))
      .toMatchObject({ ok: false, reason: "repository" });
    expect(validateGitPatchActionIdentity(prepared, { ...current, repositoryVersion: "repository-v2" }))
      .toMatchObject({ ok: false, reason: "repository_version" });
    expect(validateGitPatchActionIdentity(prepared, { ...current, sourceVersion: "source-v2" }))
      .toMatchObject({ ok: false, reason: "source_version" });
    expect(validateGitPatchActionIdentity(prepared, { ...current, sourceKind: "index" }))
      .toMatchObject({ ok: false, reason: "source_kind" });
  });

  it("resolves refresh targets without carrying a selection across file or source modes", () => {
    const status = {
      files: [
        {
          path: "src/mixed.ts",
          originalPath: null,
          indexStatus: "modified" as const,
          worktreeStatus: "modified" as const,
          conflicted: false,
          binary: false,
          submodule: false,
        },
        {
          path: "src/renamed.ts",
          originalPath: "src/old.ts",
          indexStatus: "renamed" as const,
          worktreeStatus: null,
          conflicted: false,
          binary: false,
          submodule: false,
        },
      ],
    };
    expect(resolveGitPatchRefreshTarget(status, "src/mixed.ts", []))
      .toEqual({ path: "src/mixed.ts", action: "stage", sourceKind: "working_tree" });
    expect(resolveGitPatchRefreshTarget(status, "src/old.ts", ["src/old.ts", "src/renamed.ts"]))
      .toEqual({ path: "src/renamed.ts", action: "unstage", sourceKind: "index" });
    expect(resolveGitPatchRefreshTarget(status, "src/gone.ts", ["src/missing.ts"]))
      .toBeNull();
  });

  it("preserves the legacy hunk and line patch bytes for valid inputs", () => {
    const value = diff();
    expect(buildGitHunkPatch(value, 0)).toBe([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " context",
      "-before",
      "+after",
      "",
    ].join("\n"));
    expect(buildGitLinePatch(value, 0, 1)).toContain("@@ -2,1 +2,0 @@\n-before\n");
    expect(buildGitLinePatch(value, 0, 2)).toContain("@@ -3,0 +2,1 @@\n+after\n");
  });

  it("rejects invalid indices, context lines and unsafe repository paths", () => {
    expect(() => buildGitHunkPatch(diff(), -1)).toThrow("索引无效");
    expect(() => buildGitLinePatch(diff(), 0, 0)).toThrow("新增行或删除行");
    expect(() => buildGitLinePatch(diff(), 0, Number.NaN)).toThrow("索引无效");
    expect(() => buildGitPatchEnvelope({ ...diff(), oldPath: "../secret", newPath: "../secret" }, "@@ -1 +1 @@\n-a\n+b\n"))
      .toThrow("不能离开仓库");
    expect(() => buildGitPatchEnvelope({ ...diff(), oldPath: "src/a.ts\nmalicious", newPath: "src/a.ts" }, "x"))
      .toThrow("安全的仓库相对路径");
  });

  it("produces hunk and line patches accepted by git apply --check --cached", () => {
    const repository = temporaryRepository();
    const hunkPatch = buildGitHunkPatch(diff(), 0);
    const deleteLinePatch = buildGitLinePatch(diff(), 0, 1);
    expect(() => git(repository, "apply", "--check", "--cached", "-", hunkPatch)).not.toThrow();
    expect(() => git(repository, "apply", "--check", "--cached", "-", deleteLinePatch)).not.toThrow();
  });

  it("maps stable canonical hunk identity to the original Git hunk without reading rendered text", () => {
    const source = duplicateHeaderDiff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    expect(file.hunks.map((hunk) => hunk.id)).toEqual([
      "git-hunk:0:1:1",
      "git-hunk:1:1:1",
    ]);
    const patch = buildGitHunkPatchFromSelection(document, [source], {
      fileId: file.id,
      fileCacheKey: file.cacheKey,
      hunkId: file.hunks[1]!.id,
    });
    expect(patch).toContain("-old-second\n+new-second");
    expect(patch).not.toContain("old-first");
  });

  it("rejects stale canonical hunk targets instead of applying a similarly shaped patch", () => {
    const source = diff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    expect(() => buildGitHunkPatchFromSelection(document, [source], {
      fileId: file.id,
      fileCacheKey: "stale-cache-key",
      hunkId: file.hunks[0]!.id,
    })).toThrow("已变化");
  });

  it.each([
    ["删除行", "old", 2, "context\n"],
    ["新增行", "new", 2, "context\nbefore\nafter\n"],
  ] as const)("builds an applicable minimal patch for a selected %s", (_label, side, line, expectedIndex) => {
    const source = diff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    const patches = buildGitSelectionPatches(document, [source], {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side, line },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side, line },
    });
    const repository = temporaryRepository();
    git(repository, "apply", "--cached", "-", patches[0]!);
    expect(git(repository, "show", ":src/a.ts")).toBe(expectedIndex);
  });

  it("keeps adjacent delete/add selection as one valid replacement patch", () => {
    const source = diff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    const patches = buildGitSelectionPatches(document, [source], {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 2 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 2 },
    });
    const repository = temporaryRepository();
    git(repository, "apply", "--cached", "-", patches[0]!);
    expect(git(repository, "show", ":src/a.ts")).toBe("context\nafter\n");
  });

  it("rejects a context-only selection instead of reporting a false success", () => {
    const source = diff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    expect(() => buildGitSelectionPatches(document, [source], {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 1 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 1 },
    })).toThrow("不包含可操作");
  });

  it("preserves no-final-newline markers for a selected replacement", () => {
    const source = noFinalNewlineDiff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    const patches = buildGitSelectionPatches(document, [source], {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 1 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 1 },
    });
    expect(patches[0]!.match(/\\ No newline at end of file/gu)).toHaveLength(2);
    const repository = temporaryRepository("before");
    git(repository, "apply", "--cached", "-", patches[0]!);
    expect(git(repository, "show", ":src/a.ts")).toBe("after");
  });

  it("builds one ordered atomic patch for a continuous selection across hunks", () => {
    const source = twoHunkDiff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    const patches = buildGitSelectionPatches(document, [source], {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 2 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 6 },
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.match(/^@@/gmu)).toHaveLength(2);
    const repository = temporaryRepository(twoHunkBase());
    git(repository, "apply", "--cached", "-", patches[0]!);
    expect(git(repository, "show", ":src/a.ts")).toBe(twoHunkReplaced());
  });

  it("sorts, groups and de-duplicates disjoint selections before one Git action", () => {
    const source = twoHunkDiff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    const file = document.files[0]!;
    const first = {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new" as const, line: 2 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new" as const, line: 2 },
    };
    const second = {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new" as const, line: 6 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new" as const, line: 6 },
    };
    const patches = buildGitSelectionPatchBatch(document, [source], [second, first, first]);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.indexOf("+new2")).toBeLessThan(patches[0]!.indexOf("+new6"));
    expect(patches[0]!.match(/\+new2/gmu)).toHaveLength(1);
    const repository = temporaryRepository(twoHunkBase());
    git(repository, "apply", "--cached", "-", patches[0]!);
    expect(git(repository, "show", ":src/a.ts")).toBe(
      "line1\nold2\nnew2\nline3\nline4\nline5\nold6\nnew6\nline7\n",
    );
  });

  it.each([
    ["新增", addedFileDiff(), ["new file mode 100644", "--- /dev/null", "+++ b/src/new.txt"]],
    ["删除", deletedFileDiff(), ["deleted file mode 100644", "--- a/src/a.ts", "+++ /dev/null"]],
    ["重命名", renamedFileDiff(), ["rename from src/a.ts", "rename to src/renamed.ts"]],
    ["复制", copiedFileDiff(), ["copy from src/a.ts", "copy to src/copied.ts"]],
  ] as const)("preserves the original %s metadata envelope for partial patches", (_label, source, metadata) => {
    const patch = buildGitHunkPatch(source, 0);
    for (const line of metadata) expect(patch).toContain(line);
  });

  it("applies added, deleted and renamed partial envelopes to a real Git index", () => {
    const addRepository = temporaryRepository();
    git(addRepository, "apply", "--cached", "-", buildGitHunkPatch(addedFileDiff(), 0));
    expect(git(addRepository, "show", ":src/new.txt")).toBe("hello\n");

    const deleteRepository = temporaryRepository();
    git(deleteRepository, "apply", "--cached", "-", buildGitHunkPatch(deletedFileDiff(), 0));
    expect(git(deleteRepository, "ls-files", "src/a.ts")).toBe("");

    const renameRepository = temporaryRepository();
    git(renameRepository, "apply", "--cached", "-", buildGitHunkPatch(renamedFileDiff(), 0));
    expect(git(renameRepository, "show", ":src/renamed.ts")).toBe("context\nafter\n");
    expect(git(renameRepository, "ls-files", "src/a.ts")).toBe("");

    const copyRepository = temporaryRepository();
    git(copyRepository, "apply", "--cached", "-", buildGitHunkPatch(copiedFileDiff(), 0));
    expect(git(copyRepository, "show", ":src/copied.ts")).toBe("context\nafter\n");
    expect(git(copyRepository, "show", ":src/a.ts")).toBe("context\nbefore\n");
  });

  it("keeps mode-only patches as file-level actions and applies the exact raw metadata", () => {
    const source = modeOnlyDiff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v1",
      sourceKind: "working_tree",
      files: [source],
    });
    expect(document.files[0]).toMatchObject({
      oldMode: "100644",
      newMode: "100755",
      hunks: [],
      patch: source.rawPatch,
    });
    const repository = temporaryRepository();
    git(repository, "apply", "--cached", "-", source.rawPatch);
    expect(git(repository, "ls-files", "--stage", "src/a.ts")).toMatch(/^100755 /u);
  });

  it.each([
    ["新增行", "new", 2, "context\n"],
    ["删除行", "old", 2, "context\nbefore\nafter\n"],
  ] as const)("builds reverse-safe unstage patches for a selected %s", (_label, side, line, expectedIndex) => {
    const source = diff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v-index",
      sourceKind: "index",
      files: [source],
    });
    const file = document.files[0]!;
    const patches = buildGitSelectionPatches(document, [source], {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side, line },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side, line },
    }, "unstage");
    const repository = repositoryWithStagedReplacement();
    git(repository, "apply", "--cached", "--reverse", "-", patches[0]!);
    expect(git(repository, "show", ":src/a.ts")).toBe(expectedIndex);
    expect(readFileSync(join(repository, "src", "a.ts"), "utf8")).toBe("context\nlater\n");
  });

  it("unstages a selected replacement without resetting later worktree edits", () => {
    const source = diff();
    const document = gitDocumentFromFiles({
      repositoryId: "repo",
      repositoryVersion: "v-index",
      sourceKind: "index",
      files: [source],
    });
    const file = document.files[0]!;
    const patches = buildGitSelectionPatches(document, [source], {
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 2 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 2 },
    }, "unstage");
    const repository = repositoryWithStagedReplacement();
    git(repository, "apply", "--cached", "--reverse", "-", patches[0]!);
    expect(git(repository, "show", ":src/a.ts")).toBe("context\nbefore\n");
    expect(readFileSync(join(repository, "src", "a.ts"), "utf8")).toBe("context\nlater\n");
  });
});

function temporaryRepository(content = "context\nbefore\n"): string {
  const repository = mkdtempSync(join(tmpdir(), "keydex-git-patch-"));
  temporaryRepositories.push(repository);
  mkdirSync(join(repository, "src"), { recursive: true });
  git(repository, "init");
  git(repository, "config", "user.email", "keydex@example.invalid");
  git(repository, "config", "user.name", "Keydex Test");
  writeFileSync(join(repository, "src", "a.ts"), content, "utf8");
  git(repository, "add", "src/a.ts");
  git(repository, "commit", "-m", "base");
  return repository;
}

function repositoryWithStagedReplacement(): string {
  const repository = temporaryRepository();
  writeFileSync(join(repository, "src", "a.ts"), "context\nafter\n", "utf8");
  git(repository, "add", "src/a.ts");
  writeFileSync(join(repository, "src", "a.ts"), "context\nlater\n", "utf8");
  return repository;
}

function git(repository: string, ...args: Array<string>): string;
function git(repository: string, command: string, ...argsAndInput: Array<string>): string {
  let input: string | undefined;
  const args = [command, ...argsAndInput];
  if (args.at(-2) === "-") {
    input = args.pop();
  }
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function diff(): GitFileDiff {
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
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [" context", "-before", "+after"],
    }],
    rawPatch: "@@ -1,2 +1,2 @@\n context\n-before\n+after\n",
    truncated: false,
  };
}

function duplicateHeaderDiff(): GitFileDiff {
  const value = diff();
  const hunks = [
    { ...value.hunks[0]!, lines: ["-old-first", "+new-first"] },
    { ...value.hunks[0]!, lines: ["-old-second", "+new-second"] },
  ];
  return {
    ...value,
    additions: 2,
    deletions: 2,
    hunks,
    rawPatch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old-first",
      "+new-first",
      "@@ -1,2 +1,2 @@",
      "-old-second",
      "+new-second",
      "",
    ].join("\n"),
  };
}

function noFinalNewlineDiff(): GitFileDiff {
  return {
    ...diff(),
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        "-before",
        "\\ No newline at end of file",
        "+after",
        "\\ No newline at end of file",
      ],
    }],
    rawPatch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-before",
      "\\ No newline at end of file",
      "+after",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  };
}

function twoHunkDiff(): GitFileDiff {
  return {
    ...diff(),
    additions: 2,
    deletions: 2,
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [" line1", "-old2", "+new2", " line3"],
      },
      {
        header: "@@ -5,3 +5,3 @@",
        oldStart: 5,
        oldLines: 3,
        newStart: 5,
        newLines: 3,
        lines: [" line5", "-old6", "+new6", " line7"],
      },
    ],
    rawPatch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old2",
      "+new2",
      " line3",
      "@@ -5,3 +5,3 @@",
      " line5",
      "-old6",
      "+new6",
      " line7",
      "",
    ].join("\n"),
  };
}

function twoHunkBase(): string {
  return "line1\nold2\nline3\nline4\nline5\nold6\nline7\n";
}

function twoHunkReplaced(): string {
  return "line1\nnew2\nline3\nline4\nline5\nnew6\nline7\n";
}

function addedFileDiff(): GitFileDiff {
  return {
    ...diff(),
    oldPath: null,
    newPath: "src/new.txt",
    status: "added",
    oldMode: null,
    newMode: "100644",
    additions: 1,
    deletions: 0,
    hunks: [{
      header: "@@ -0,0 +1 @@",
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      lines: ["+hello"],
    }],
    rawPatch: [
      "diff --git a/src/new.txt b/src/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n"),
  };
}

function deletedFileDiff(): GitFileDiff {
  return {
    ...diff(),
    oldPath: "src/a.ts",
    newPath: null,
    status: "deleted",
    oldMode: "100644",
    newMode: null,
    additions: 0,
    deletions: 2,
    hunks: [{
      header: "@@ -1,2 +0,0 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 0,
      newLines: 0,
      lines: ["-context", "-before"],
    }],
    rawPatch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "deleted file mode 100644",
      "--- a/src/a.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-context",
      "-before",
      "",
    ].join("\n"),
  };
}

function renamedFileDiff(): GitFileDiff {
  return {
    ...diff(),
    oldPath: "src/a.ts",
    newPath: "src/renamed.ts",
    status: "renamed",
    hunks: [{
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [" context", "-before", "+after"],
    }],
    rawPatch: [
      "diff --git a/src/a.ts b/src/renamed.ts",
      "similarity index 50%",
      "rename from src/a.ts",
      "rename to src/renamed.ts",
      "--- a/src/a.ts",
      "+++ b/src/renamed.ts",
      "@@ -1,2 +1,2 @@",
      " context",
      "-before",
      "+after",
      "",
    ].join("\n"),
  };
}

function copiedFileDiff(): GitFileDiff {
  return {
    ...renamedFileDiff(),
    newPath: "src/copied.ts",
    status: "copied",
    rawPatch: renamedFileDiff().rawPatch
      .replaceAll("renamed", "copied")
      .replace("rename from", "copy from")
      .replace("rename to", "copy to"),
  };
}

function modeOnlyDiff(): GitFileDiff {
  return {
    ...diff(),
    status: "type_changed",
    oldMode: "100644",
    newMode: "100755",
    additions: 0,
    deletions: 0,
    hunks: [],
    rawPatch: "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n",
  };
}
