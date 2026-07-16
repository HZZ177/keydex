import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitDiffViewer,
  buildGitHunkPatch,
  buildGitLinePatch,
  gitDiffDisplayRows,
} from "@/renderer/features/git/components/GitDiffViewer";
import type { GitFileDiff } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("GitDiffViewer", () => {
  it("maps hunk line numbers and switches unified, split and wrap views", () => {
    const rows = gitDiffDisplayRows(diff().hunks);
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
      ["context", 10, 20],
      ["delete", 11, null],
      ["add", null, 21],
    ]);

    const onStagePatches = vi.fn();
    render(<GitDiffViewer diff={diff()} onStagePatches={onStagePatches} />);
    expect(screen.getByRole("table", { name: "统一 Diff 内容" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "暂存 Hunk 1" }));
    expect(onStagePatches).toHaveBeenCalledWith([expect.stringContaining("@@ -10,2 +20,2 @@")]);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 新增行 21" }));
    fireEvent.click(screen.getByRole("button", { name: "暂存所选行 (1)" }));
    expect(onStagePatches).toHaveBeenLastCalledWith([expect.stringContaining("@@ -12,0 +21,1 @@")]);
    fireEvent.click(screen.getByRole("button", { name: "并排 Diff" }));
    expect(screen.getByRole("table", { name: "并排 Diff 内容" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "自动换行" }));
    expect(screen.getByRole("button", { name: "自动换行" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("builds repository-relative hunk and zero-context line patches", () => {
    expect(buildGitHunkPatch(diff(), 0)).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(buildGitLinePatch(diff(), 0, 1)).toContain("@@ -11,1 +21,0 @@\n-before");
    expect(buildGitLinePatch(diff(), 0, 2)).toContain("@@ -12,0 +21,1 @@\n+after");
  });

  it("shows mode-only changes and exposes reverse cached patch actions", () => {
    const modeChange = diff();
    modeChange.oldMode = "100644";
    modeChange.newMode = "100755";
    const onUnstage = vi.fn();
    render(<GitDiffViewer diff={modeChange} patchAction="unstage" onStagePatches={onUnstage} />);

    expect(screen.getByLabelText("Mode change").textContent).toBe("100644 → 100755");
    fireEvent.click(screen.getByRole("button", { name: "取消暂存 Hunk 1" }));
    expect(onUnstage).toHaveBeenCalledWith([expect.stringContaining("@@ -10,2 +20,2 @@")]);
  });

  it("shows safe binary and large/truncated states", () => {
    const binary = diff();
    binary.binary = true;
    const { rerender } = render(<GitDiffViewer diff={binary} />);
    expect(screen.getByText("二进制文件不提供文本 Diff")).not.toBeNull();

    const large = diff();
    large.rawPatch = "x".repeat(100);
    rerender(<GitDiffViewer diff={large} maxBytes={10} />);
    expect(screen.getByText("Diff 过大")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "仍然查看" }));
    expect(screen.getByRole("table", { name: "统一 Diff 内容" })).not.toBeNull();

    const truncated = diff();
    truncated.truncated = true;
    rerender(<GitDiffViewer diff={truncated} key="truncated" />);
    expect(screen.getByText("Diff 过大")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "仍然查看" })).toBeNull();
  });
});

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
    hunks: [
      {
        header: "@@ -10,2 +20,2 @@",
        oldStart: 10,
        oldLines: 2,
        newStart: 20,
        newLines: 2,
        lines: [" context", "-before", "+after"],
      },
    ],
    rawPatch: "@@ -10,2 +20,2 @@\n context\n-before\n+after",
    truncated: false,
  };
}
