import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { groupGitChanges } from "@/renderer/features/git/changesTree";
import { changesVirtualWindow, GitChangesView } from "@/renderer/features/git/components/GitChangesView";
import type { GitRepositoryId, GitRepositoryVersion, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git changes tree", () => {
  it("groups index/worktree/conflict state and preserves rename, binary and submodule semantics", () => {
    const groups = groupGitChanges(status().files);
    expect(groups.map((group) => [group.id, group.entries.length])).toEqual([
      ["conflicts", 1],
      ["staged", 2],
      ["unstaged", 2],
      ["untracked", 1],
      ["ignored", 1],
    ]);
    expect(groups.find((group) => group.id === "staged")?.entries.some((entry) => entry.displayPath.includes("old.ts → src/new.ts"))).toBe(true);
    expect(groups.find((group) => group.id === "unstaged")?.entries.some((entry) => entry.binary)).toBe(true);
    expect(groups.find((group) => group.id === "staged")?.entries.some((entry) => entry.submodule)).toBe(true);
  });

  it("supports group and row selection and marks large fixtures for virtualization", () => {
    const onSelectionChange = vi.fn();
    const onStagePaths = vi.fn();
    const onUnstagePaths = vi.fn();
    const onDiscardPaths = vi.fn();
    const onCleanPaths = vi.fn();
    const onIgnorePaths = vi.fn();
    render(
      <GitChangesView
        status={status()}
        onSelectionChange={onSelectionChange}
        onStagePaths={onStagePaths}
        onUnstagePaths={onUnstagePaths}
        onDiscardPaths={onDiscardPaths}
        onCleanPaths={onCleanPaths}
        onIgnorePaths={onIgnorePaths}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "选择已暂存" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      ["modules/core", "src/new.ts"],
      expect.arrayContaining([expect.objectContaining({ group: "staged" })]),
    );
    expect(screen.getByRole("button", { name: "暂存" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消暂存" }));
    expect(onUnstagePaths).toHaveBeenCalledWith(["modules/core", "src/new.ts"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择未暂存" }));
    fireEvent.click(screen.getByRole("button", { name: "暂存" }));
    expect(onStagePaths).toHaveBeenCalledWith(["asset.bin", "src/edit.ts"]);
    fireEvent.click(screen.getByRole("button", { name: "丢弃改动" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onDiscardPaths).toHaveBeenCalledWith(["asset.bin", "src/edit.ts"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择未跟踪" }));
    fireEvent.click(screen.getByRole("button", { name: "删除未跟踪文件" }));
    expect(screen.getByRole("button", { name: "确认" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "输入 DELETE 确认" }), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onCleanPaths).toHaveBeenCalledWith(["new.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "忽略" }));
    expect(onIgnorePaths).toHaveBeenCalledWith(["asset.bin", "new.txt", "src/edit.ts"]);
    expect(screen.getByRole("treeitem", { name: /asset.bin modified/ }).textContent).toContain("binary");
    expect(screen.getByRole("treeitem", { name: /modules\/core added/ }).textContent).toContain("submodule");
  });

  it("keeps ignored files hidden by default and exposes a project-level toggle", () => {
    const onShowIgnoredChange = vi.fn();
    const { rerender } = render(
      <GitChangesView status={status()} showIgnored={false} onShowIgnoredChange={onShowIgnoredChange} />,
    );
    expect(screen.queryByRole("group", { name: "已忽略" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "显示已忽略文件" }));
    expect(onShowIgnoredChange).toHaveBeenCalledWith(true);

    rerender(<GitChangesView status={status()} showIgnored onShowIgnoredChange={onShowIgnoredChange} />);
    expect(screen.getByRole("group", { name: "已忽略" })).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: /ignored\.log ignored/ })).not.toBeNull();
  });

  it("keeps a 5k change tree within its DOM and interaction budget", () => {
    const large = status();
    large.files = Array.from({ length: 5_000 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      originalPath: null,
      indexStatus: null,
      worktreeStatus: "modified" as const,
      conflicted: false,
      binary: false,
      submodule: false,
    }));
    const started = performance.now();
    const { container } = render(<GitChangesView status={large} viewportHeight={290} />);
    const scroller = container.querySelector<HTMLElement>('[data-virtualized="true"][data-rendered-count]');
    expect(scroller).not.toBeNull();
    expect(Number(scroller?.dataset.renderedCount)).toBeLessThanOrEqual(27);
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(27);
    expect(performance.now() - started).toBeLessThan(1_000);

    const maximumScrollTop = 5_001 * 29 - 290;
    fireEvent.scroll(scroller!, { target: { scrollTop: maximumScrollTop } });
    expect(screen.getByRole("treeitem", { name: /src\/file-999.ts modified/ })).not.toBeNull();
    expect(changesVirtualWindow(5_001, maximumScrollTop, 290)).toMatchObject({ renderedCount: 18 });
  });
});

function status(): GitStatusSnapshot {
  return {
    repositoryId: "repo-1" as GitRepositoryId,
    repositoryVersion: "v1" as GitRepositoryVersion,
    branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
    operation: null,
    files: [
      { path: "src/new.ts", originalPath: "src/old.ts", indexStatus: "renamed", worktreeStatus: null, conflicted: false, binary: false, submodule: false },
      { path: "asset.bin", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: false, binary: true, submodule: false },
      { path: "modules/core", originalPath: null, indexStatus: "added", worktreeStatus: null, conflicted: false, binary: false, submodule: true },
      { path: "both.ts", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: true, binary: false, submodule: false },
      { path: "new.txt", originalPath: null, indexStatus: null, worktreeStatus: "untracked", conflicted: false, binary: false, submodule: false },
      { path: "src/edit.ts", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: false, binary: false, submodule: false },
      { path: "ignored.log", originalPath: null, indexStatus: null, worktreeStatus: "ignored", conflicted: false, binary: false, submodule: false },
    ],
  };
}
