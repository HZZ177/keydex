import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitRefsTree,
  buildGitRefTree,
  filterGitRefs,
} from "@/renderer/features/git/components/GitRefsTree";
import { AppContextMenuProvider } from "@/renderer/providers/AppContextMenuProvider";
import type { GitObjectId, GitRef } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("GitRefsTree", () => {
  it("builds stable HEAD/local/remote/tag groups with current branch first", () => {
    const groups = buildGitRefTree(refs());
    expect(groups.map((group) => group.kind)).toEqual(["local", "remote", "tag"]);
    expect(groups[0].refs.map((ref) => ref.shortName)).toEqual(["main", "feature/git-view"]);
  });

  it("supports selection, collapse, ahead/behind and context actions", async () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(
      <AppContextMenuProvider>
        <GitRefsTree refs={refs()} selectedRef={null} onSelect={onSelect} onAction={onAction} />
      </AppContextMenuProvider>,
    );

    const currentBranch = screen.getByRole("treeitem", { name: "当前分支 main" });
    expect(currentBranch.querySelector(".lucide-star")).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: "main" }).querySelector(".lucide-star")).not.toBeNull();
    const divergence = screen.getByLabelText("传入 1 个提交，传出 2 个提交");
    const incomingIcon = divergence.querySelector('[data-direction="incoming"] .lucide-arrow-down-left');
    const outgoingIcon = divergence.querySelector('[data-direction="outgoing"] .lucide-arrow-up-right');
    expect(incomingIcon?.getAttribute("width")).toBe("13");
    expect(outgoingIcon?.getAttribute("width")).toBe("13");
    const tagGroup = screen.getByRole("treeitem", { name: /^标签/ });
    const tagItems = tagGroup.parentElement?.querySelector('[data-ref-items="tag"]');
    expect(tagGroup.getAttribute("aria-expanded")).toBe("false");
    expect(tagGroup.querySelector(".lucide-chevron-right")?.getAttribute("data-expanded")).toBe("false");
    expect(tagItems).not.toBeNull();
    expect(tagItems?.querySelector('[data-tree-key="ref:refs/tags/v1.0.0"]')?.getAttribute("tabindex")).toBe("-1");
    expect(screen.queryByRole("treeitem", { name: /v1\.0\.0/ })).toBeNull();
    fireEvent.click(tagGroup);
    expect(tagGroup.getAttribute("aria-expanded")).toBe("true");
    expect(tagGroup.querySelector(".lucide-chevron-right")?.getAttribute("data-expanded")).toBe("true");
    expect(tagItems?.getAttribute("data-expanded")).toBe("true");
    expect(tagItems?.hasAttribute("aria-hidden")).toBe(false);
    expect(screen.getByRole("treeitem", { name: /v1\.0\.0/ })).not.toBeNull();
    fireEvent.click(tagGroup);
    expect(tagItems?.getAttribute("data-expanded")).toBe("false");
    expect(tagItems?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("treeitem", { name: /^远程/ }));
    expect(screen.queryByRole("treeitem", { name: /origin\/main/ })).toBeNull();
    fireEvent.click(screen.getByRole("treeitem", { name: /^远程/ }));
    const remoteBranch = screen.getByRole("treeitem", { name: "origin/main" });
    expect(screen.queryByRole("button", { name: "origin/main 操作" })).toBeNull();
    expect(remoteBranch.querySelector(".lucide-star")).not.toBeNull();
    fireEvent.contextMenu(remoteBranch, { clientX: 120, clientY: 96 });
    const menu = screen.getByRole("menu", { name: "页面右键菜单" });
    expect(menu.dataset.contextKind).toBe("custom");
    expect(menu.dataset.width).toBe("content");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.queryByRole("menuitem", { name: "刷新" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "签出" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(
      "checkout",
      expect.objectContaining({ fullName: "refs/remotes/origin/main" }),
    ));
    expect(screen.queryByRole("menu", { name: "页面右键菜单" })).toBeNull();

    const featureBranch = screen.getByRole("treeitem", { name: "feature/git-view" });
    fireEvent.contextMenu(featureBranch, { clientX: 150, clientY: 130 });
    expect(screen.getByRole("menuitem", { name: "签出" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "从 'feature/git-view' 新建分支" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "签出并变基到 'main'" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "与 'main' 比较" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "显示与工作树的差异" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "将 'main' 变基到 'feature/git-view'" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "将 'feature/git-view' 合并到 'main' 中" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "更新" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "推送" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "重命名" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "删除" })).not.toBeNull();
  });

  it("filters the independently scrollable branch region by branch name", () => {
    const allRefs = refs();
    expect(filterGitRefs(allRefs, "FEATURE/GIT").map((ref) => ref.shortName)).toEqual(["feature/git-view"]);

    render(<GitRefsTree refs={allRefs} selectedRef={null} onSelect={vi.fn()} />);

    const search = screen.getByRole("searchbox", { name: "筛选分支" });
    fireEvent.change(search, { target: { value: "feature/git" } });
    expect(screen.queryByRole("treeitem", { name: "当前分支 main" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "feature/git-view" })).not.toBeNull();
    expect(screen.queryByRole("treeitem", { name: "origin/main" })).toBeNull();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("没有匹配的分支")).not.toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("treeitem", { name: "当前分支 main" })).not.toBeNull();
  });
});

function refs(): GitRef[] {
  const oid = (value: string) => value.repeat(40) as GitObjectId;
  return [
    { fullName: "refs/heads/feature/git-view", shortName: "feature/git-view", kind: "local", objectId: oid("b"), peeledObjectId: null, upstream: null, ahead: null, behind: null, current: false },
    { fullName: "refs/heads/main", shortName: "main", kind: "local", objectId: oid("a"), peeledObjectId: null, upstream: "origin/main", ahead: 2, behind: 1, current: true },
    { fullName: "refs/remotes/origin/main", shortName: "origin/main", kind: "remote", objectId: oid("a"), peeledObjectId: null, upstream: null, ahead: null, behind: null, current: false },
    { fullName: "refs/tags/v1.0.0", shortName: "v1.0.0", kind: "tag", objectId: oid("c"), peeledObjectId: oid("d"), upstream: null, ahead: null, behind: null, current: false },
  ];
}
