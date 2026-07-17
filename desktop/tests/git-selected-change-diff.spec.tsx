import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitSelectedChangeDiff } from "@/renderer/features/git/components/GitSelectedChangeDiff";
import type { GitDiffSnapshot, GitFileDiff } from "@/runtime/gitTypes";

let lastProps: Record<string, unknown> | null = null;

vi.mock("@/renderer/components/diff/wrappers/GitDiffView", () => ({
  GitDiffView: (props: Record<string, unknown>) => {
    lastProps = props;
    const document = props.document as { files: Array<{ displayPath: string; status: string }> };
    return (
      <section aria-label="Git 变更差异" data-mode={String(props.mode)}>
        {document.files.map((file) => <span key={file.displayPath}>{file.displayPath}:{file.status}</span>)}
      </section>
    );
  },
}));

afterEach(() => {
  cleanup();
  lastProps = null;
});

describe("GitSelectedChangeDiff", () => {
  it("maps an unstaged snapshot to a writable working-tree document", () => {
    const onApplyPatches = vi.fn();
    render(
      <GitSelectedChangeDiff
        workspaceId="workspace-1"
        snapshot={snapshot("v-worktree", file())}
        action="stage"
        busy
        onApplyPatches={onApplyPatches}
      />,
    );

    expect(screen.getByLabelText("Git 变更差异").textContent).toContain("src/a.ts:modified");
    const props = lastProps as {
      mode: string;
      busy: boolean;
      applyPatches: (patches: readonly string[]) => void;
      applyHunk?: unknown;
      applySelection?: unknown;
      toolbarLeading?: unknown;
      scrollScopeKey: string;
      document: {
        source: string;
        sourceVersion: string;
        files: Array<{ id: string; cacheKey: string; patch: string; hunks: Array<{ id: string }> }>;
      };
    };
    expect(props).toMatchObject({
      mode: "stage",
      busy: true,
      scrollScopeKey: "git-changes:repo-1:working_tree",
    });
    expect(props.toolbarLeading).toBeTruthy();
    expect(typeof props.applyPatches).toBe("function");
    expect(props.applyHunk).toBeUndefined();
    expect(props.applySelection).toBeUndefined();
    expect(props.document.source).toBe("git");
    props.applyPatches([props.document.files[0]!.patch]);
    expect(onApplyPatches).toHaveBeenLastCalledWith([
      expect.stringContaining("@@ -1 +1 @@\n-old\n+new"),
    ], expect.objectContaining({
      workspaceId: "workspace-1",
      repositoryId: "repo-1",
      repositoryVersion: "v-worktree",
      sourceKind: "working_tree",
      sourcePatch: expect.stringContaining("diff --git a/src/a.ts b/src/a.ts"),
      sourcePaths: ["src/a.ts"],
    }));
  });

  it("maps an index snapshot to the isolated unstage action mode", () => {
    const onApplyPatches = vi.fn();
    render(
      <GitSelectedChangeDiff
        workspaceId="workspace-1"
        snapshot={snapshot("v-index", file())}
        action="unstage"
        onApplyPatches={onApplyPatches}
      />,
    );

    expect(screen.getByLabelText("Git 变更差异").getAttribute("data-mode")).toBe("unstage");
    expect(lastProps).toMatchObject({
      mode: "unstage",
      scrollScopeKey: "git-changes:repo-1:index",
    });
    const props = lastProps as {
      document: { files: Array<{ patch: string }> };
      applyPatches: (patches: readonly string[]) => void;
      applyHunk?: unknown;
      applySelection?: unknown;
    };
    expect(props.applyHunk).toBeUndefined();
    expect(props.applySelection).toBeUndefined();
    props.applyPatches([props.document.files[0]!.patch]);
    const patch = (onApplyPatches.mock.calls[0]![0] as string[])[0]!;
    expect(patch).toContain("+new");
    expect(patch).not.toContain(" old");
  });

  it("copies the exact backend patch and routes path/open actions without renderer reconstruction", async () => {
    const onCopyText = vi.fn().mockResolvedValue(undefined);
    const onOpenFile = vi.fn();
    const rawPatch = "diff --git a/src/old.ts b/src/new.ts\r\nrename from src/old.ts\r\nrename to src/new.ts\r\n";
    render(
      <GitSelectedChangeDiff
        workspaceId="workspace-1"
        snapshot={snapshot("v-copy", file({
          status: "renamed",
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
          rawPatch,
          hunks: [],
        }))}
        action="stage"
        onApplyPatches={vi.fn()}
        onCopyText={onCopyText}
        onOpenFile={onOpenFile}
      />,
    );
    const props = lastProps as {
      copyPatch: (normalizedPatch: string) => Promise<void>;
      copySelection: (text: string) => Promise<void>;
      copyPath: (path: string) => Promise<void>;
      openFile: (path: string) => void;
    };
    await props.copyPatch("normalized renderer patch");
    await props.copySelection("selected code");
    await props.copyPath("src/new.ts");
    props.openFile("src/new.ts");
    expect(onCopyText.mock.calls).toEqual([[rawPatch], ["selected code"], ["src/new.ts"]]);
    expect(onOpenFile).toHaveBeenCalledWith("src/new.ts");
  });

  it.each([
    ["binary", { binary: true, rawPatch: "", hunks: [] }, { binary: true, contentKind: "binary", selectableForPatch: false }],
    ["truncated", { truncated: true }, { truncated: true, selectableForPatch: false }],
    ["renamed", { status: "renamed", oldPath: "src/old.ts", newPath: "src/new.ts" }, { status: "renamed", oldPath: "src/old.ts", newPath: "src/new.ts" }],
    ["mode", { oldMode: "100644", newMode: "100755" }, { oldMode: "100644", newMode: "100755" }],
  ] as const)("preserves %s Git file semantics in the canonical document", (_name, overrides, expected) => {
    render(
      <GitSelectedChangeDiff
        workspaceId="workspace-1"
        snapshot={snapshot("v-edge", file(overrides))}
        action="stage"
        onApplyPatches={vi.fn()}
      />,
    );

    const props = lastProps as { document: { files: Array<Record<string, unknown>> } };
    expect(props.document.files[0]).toMatchObject(expected);
  });

  it("keeps an empty snapshot in the explicit selection state", () => {
    render(
      <GitSelectedChangeDiff
        workspaceId="workspace-1"
        snapshot={{ ...snapshot("v-empty", file()), files: [] }}
        action="stage"
        onApplyPatches={vi.fn()}
      />,
    );
    expect(screen.getByText("选择文件查看差异")).not.toBeNull();
    expect(lastProps).toBeNull();
  });
});

function snapshot(version: string, diff: GitFileDiff): GitDiffSnapshot {
  return {
    repositoryId: "repo-1" as GitDiffSnapshot["repositoryId"],
    repositoryVersion: version as GitDiffSnapshot["repositoryVersion"],
    files: [diff],
  };
}

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
