import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { commitSelectionFromEntries, groupGitChanges } from "@/renderer/features/git/changesTree";
import { changesVirtualWindow, GitChangesView } from "@/renderer/features/git/components/GitChangesView";
import type { GitRepositoryId, GitRepositoryVersion, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git changes tree", () => {
  it("flattens changed files into 更改 and 未跟踪 groups", () => {
    const groups = groupGitChanges(status().files);
    expect(groups.map((group) => [group.id, group.entries.length])).toEqual([
      ["changes", 5],
      ["untracked", 1],
    ]);
    const entries = groups.flatMap((group) => group.entries);
    expect(entries.filter((entry) => entry.path === "src/new.ts")).toHaveLength(1);
    expect(entries.some((entry) => entry.displayPath.includes("old.ts → src/new.ts"))).toBe(true);
    expect(entries.some((entry) => entry.binary)).toBe(true);
    expect(entries.some((entry) => entry.submodule)).toBe(true);
  });

  it("builds a direct commit scope from selected files and excludes conflicts", () => {
    const entries = groupGitChanges(status().files).flatMap((group) => group.entries);
    const selection = commitSelectionFromEntries(entries);

    expect(selection.paths).toContain("src/old.ts");
    expect(selection.paths).toContain("src/new.ts");
    expect(selection.untrackedPaths).toEqual(["new.txt"]);
    expect(selection.paths).not.toContain("both.ts");
    expect(selection.fileCount).toBe(5);
  });

  it("supports flat group selection and renders file name before its ghost path", () => {
    const onSelectionChange = vi.fn();
    render(<GitChangesView status={status()} onSelectionChange={onSelectionChange} />);

    expect(screen.getByRole("group", { name: "更改" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "未跟踪" })).not.toBeNull();
    const groupCheckbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "选择更改" });
    fireEvent.click(groupCheckbox);
    expect(groupCheckbox.checked).toBe(true);
    expect(groupCheckbox.indeterminate).toBe(false);
    expect(groupCheckbox.getAttribute("data-selection-state")).toBe("all");
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      ["asset.bin", "both.ts", "modules/core", "src/edit.ts", "src/new.ts"],
      expect.arrayContaining([expect.objectContaining({ group: "changes" })]),
    );
    const editRow = screen.getByRole("treeitem", { name: /src\/edit\.ts modified/ });
    expect(editRow.querySelector("img")?.getAttribute("data-icon-id")).toBeTruthy();
    expect(editRow.textContent?.indexOf("edit.ts")).toBeLessThan(editRow.textContent?.indexOf("src") ?? -1);
    expect(screen.getByRole("treeitem", { name: /asset.bin modified/ }).textContent).toContain("二进制");
    expect(screen.getByRole("treeitem", { name: /modules\/core added/ }).textContent).toContain("子模块");
    expect(screen.queryByRole("button", { name: "查看逐行历史" })).toBeNull();
  });

  it("renders the file refresh action and exposes its active animation state", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<GitChangesView status={status()} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: "刷新本地改动" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<GitChangesView status={status()} onRefresh={onRefresh} refreshing />);
    const refreshing = screen.getByRole("button", { name: "正在刷新本地改动" });
    expect(refreshing.getAttribute("data-loading")).toBe("true");
    expect(refreshing.hasAttribute("disabled")).toBe(true);
  });

  it("reflects child selection as a mixed group and promotes mixed selection to select all", () => {
    render(<GitChangesView status={status()} />);

    const groupCheckbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "选择更改" });
    const fileCheckbox = screen.getByRole<HTMLInputElement>("checkbox", { name: /src\/edit\.ts modified/ });
    expect(screen.getByText("5 个文件")).not.toBeNull();

    fireEvent.click(fileCheckbox);
    expect(fileCheckbox.checked).toBe(true);
    expect(groupCheckbox.checked).toBe(false);
    expect(groupCheckbox.indeterminate).toBe(true);
    expect(groupCheckbox.getAttribute("aria-checked")).toBe("mixed");
    expect(groupCheckbox.getAttribute("data-selection-state")).toBe("mixed");

    fireEvent.click(groupCheckbox);
    expect(groupCheckbox.checked).toBe(true);
    expect(groupCheckbox.indeterminate).toBe(false);
    expect(groupCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(groupCheckbox.getAttribute("data-selection-state")).toBe("all");

    fireEvent.click(fileCheckbox);
    expect(groupCheckbox.checked).toBe(false);
    expect(groupCheckbox.indeterminate).toBe(true);
  });

  it("previews a row without selecting it and only changes selection from its checkbox", () => {
    const onPreviewChange = vi.fn();
    const onSelectionChange = vi.fn();
    render(
      <GitChangesView
        status={status()}
        onPreviewChange={onPreviewChange}
        onSelectionChange={onSelectionChange}
      />,
    );

    const row = screen.getByRole("treeitem", { name: /src\/edit\.ts modified/ });
    fireEvent.click(row);
    expect(onPreviewChange).toHaveBeenCalledWith(expect.objectContaining({ path: "src/edit.ts" }));
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(row.getAttribute("data-previewed")).toBe("true");

    fireEvent.click(screen.getByRole("checkbox", { name: /src\/edit\.ts modified/ }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      ["src/edit.ts"],
      [expect.objectContaining({ path: "src/edit.ts" })],
    );
    expect(onPreviewChange).toHaveBeenCalledTimes(1);
  });

  it("collapses and expands a change group from the disclosure button", () => {
    render(<GitChangesView status={status()} />);

    const group = screen.getByRole("group", { name: "更改" });
    const collapse = screen.getByRole("button", { name: "折叠更改" });
    fireEvent.click(collapse);
    expect(group.getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "展开更改" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "展开更改" }));
    expect(group.getAttribute("data-collapsed")).toBe("false");
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

    const maximumScrollTop = 5_001 * 31 - 290;
    fireEvent.scroll(scroller!, { target: { scrollTop: maximumScrollTop } });
    expect(screen.getByRole("treeitem", { name: /src\/file-999.ts modified/ })).not.toBeNull();
    expect(changesVirtualWindow(5_001, maximumScrollTop, 290)).toMatchObject({ renderedCount: 18, rowHeight: 31 });
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
    ],
  };
}
