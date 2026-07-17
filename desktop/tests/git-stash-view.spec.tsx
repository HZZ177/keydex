import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitStashView, formatStashDate } from "@/renderer/features/git/components/GitStashView";
import type { GitStashEntry } from "@/runtime/git";
import type { GitObjectId } from "@/runtime/gitTypes";

afterEach(cleanup);

const entry: GitStashEntry = {
  selector: "stash@{0}",
  objectId: "a".repeat(40) as GitObjectId,
  baseObjectId: "b".repeat(40) as GitObjectId,
  authorName: "Keydex",
  createdAt: "2026-07-16T02:00:00+08:00",
  message: "On main: work in progress",
};

describe("GitStashView", () => {
  it("renders a stable selector+oid entry and its files", () => {
    const onSelect = vi.fn();
    const onSelectFile = vi.fn();
    renderStash({ onSelect, onSelectFile });
    fireEvent.click(screen.getByRole("option", { name: /stash@\{0\}/ }));
    expect(onSelect).toHaveBeenCalledWith(entry);
    expect(screen.getByText("src/a.ts")).not.toBeNull();
    expect(screen.getByText("+2 −1")).not.toBeNull();
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(onSelectFile).toHaveBeenCalledWith(0);
    expect(screen.getByRole("button", { name: "读取更多" })).not.toBeNull();
  });

  it("creates a stash in a dialog and keeps staged/untracked mutually exclusive", async () => {
    const onCreate = vi.fn();
    renderStash({ onCreate });
    expect(screen.queryByLabelText("储藏说明")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "创建储藏…" }));
    fireEvent.change(screen.getByLabelText("储藏说明"), { target: { value: "save work" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "仅储藏已暂存改动" }));
    expect(screen.getByRole("checkbox", { name: "包含未跟踪文件" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "仅储藏已暂存改动" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "包含未跟踪文件" }));
    expect(screen.getByRole("checkbox", { name: "仅储藏已暂存改动" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "创建储藏" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ message: "save work", staged: false, includeUntracked: true }));
  });

  it("supports direct apply, reinstate options, confirmed pop, and branch validation", async () => {
    const onApply = vi.fn();
    const onPop = vi.fn();
    const onBranch = vi.fn();
    renderStash({ onApply, onPop, onBranch });

    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onApply).toHaveBeenCalledWith(entry, false);

    fireEvent.click(screen.getByRole("button", { name: "应用选项…" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "恢复暂存状态" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "应用 stash@{0}" })).getByRole("button", { name: "应用" }));
    await waitFor(() => expect(onApply).toHaveBeenLastCalledWith(entry, true));

    fireEvent.click(screen.getByRole("button", { name: "应用并删除…" }));
    expect(screen.getByRole("dialog", { name: "应用并删除 stash@{0}" }).textContent).toContain("成功应用后删除");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onPop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "应用并删除…" }));
    fireEvent.click(screen.getByRole("button", { name: "应用并删除" }));
    await waitFor(() => expect(onPop).toHaveBeenCalledWith(entry, false));

    fireEvent.click(screen.getByRole("button", { name: "从储藏创建分支…" }));
    expect(screen.getByRole("button", { name: "创建分支" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("储藏分支名称"), { target: { value: "feature/from-stash" } });
    fireEvent.click(screen.getByRole("button", { name: "创建分支" }));
    await waitFor(() => expect(onBranch).toHaveBeenCalledWith(entry, "feature/from-stash"));
  });

  it("has a visible empty state and preserves invalid date text", () => {
    render(<GitStashView {...baseProps()} entries={[]} selected={null} detail={null} hasMore={false} />);
    expect(screen.getByText("没有储藏记录")).not.toBeNull();
    expect(formatStashDate("unknown-date")).toBe("unknown-date");
  });

  it("confirms drop and clear once with a complete target preview", () => {
    const onDrop = vi.fn();
    const onClear = vi.fn();
    renderStash({ onDrop, onClear });

    fireEvent.click(screen.getByRole("button", { name: "删除储藏…" }));
    expect(screen.getByRole("dialog", { name: "删除储藏" }).textContent).toContain("stash@{0} · aaaaaaaaaaaa");
    expect(onDrop).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDrop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除储藏…" }));
    fireEvent.click(screen.getByRole("button", { name: "删除储藏" }));
    expect(onDrop).toHaveBeenCalledWith(entry);

    fireEvent.click(screen.getByRole("button", { name: "清空全部…" }));
    expect(screen.getByRole("dialog", { name: "清空全部储藏" }).textContent).toContain("1 条储藏记录");
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清空 1 条记录" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

function renderStash(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  return render(<GitStashView {...baseProps(overrides)} />);
}

function baseProps(overrides: Record<string, ReturnType<typeof vi.fn>> = {}): ComponentProps<typeof GitStashView> {
  return {
    repositoryId: "repo-1",
    entries: [entry],
    selected: entry,
    detail: {
      repositoryId: "repo-1" as never,
      repositoryVersion: "v1" as never,
      entry,
      files: [{ oldPath: "src/a.ts", newPath: "src/a.ts", status: "modified", binary: false, oldMode: null, newMode: null, additions: 2, deletions: 1, hunks: [], rawPatch: "diff --git", truncated: false }],
    },
    selectedFileIndex: 0,
    loading: false,
    hasMore: true,
    onSelect: overrides.onSelect ?? vi.fn(),
    onSelectFile: overrides.onSelectFile ?? vi.fn(),
    onLoadMore: overrides.onLoadMore ?? vi.fn(),
    busy: false,
    onCreate: overrides.onCreate ?? vi.fn(),
    onApply: overrides.onApply ?? vi.fn(),
    onPop: overrides.onPop ?? vi.fn(),
    onBranch: overrides.onBranch ?? vi.fn(),
    onDrop: overrides.onDrop ?? vi.fn(),
    onClear: overrides.onClear ?? vi.fn(),
  };
}
