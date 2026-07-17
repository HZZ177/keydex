import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCommitPushDialog } from "@/renderer/features/git/dialogs/GitCommitPushDialog";
import type { GitCommitDetail, GitCommitSummary, GitFileDiff } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("GitCommitPushDialog", () => {
  it("shows every outgoing commit and the selected commit's directory tree", () => {
    const commits = [commit("Newest local commit", "a"), commit("Earlier local commit", "b"), commit("Oldest local commit", "c")];
    const onSelectCommit = vi.fn();
    const { rerender } = render(
      <GitCommitPushDialog
        open
        projectName="keydex"
        target={target()}
        commits={commits}
        selectedObjectId={commits[0].objectId}
        detail={detail(commits[0], [file("desktop/src/app.ts"), file("README.md")])}
        onSelectCommit={onSelectCommit}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "将提交推送到 keydex" })).not.toBeNull();
    expect(screen.getByText("main → origin/main")).not.toBeNull();
    expect(screen.getByText("3 个提交")).not.toBeNull();
    expect(within(screen.getByRole("listbox", { name: "待推送提交列表" })).getAllByRole("option")).toHaveLength(3);
    const tree = screen.getByRole("tree", { name: "待推送提交改动文件树" });
    expect(within(tree).getByText("keydex")).not.toBeNull();
    expect(within(tree).getByText("2 个文件")).not.toBeNull();
    const rootNode = within(tree).getByRole("treeitem", { name: /keydex 2 个文件/ });
    expect(rootNode.querySelector(":scope > div > ul[role='group']")).not.toBeNull();
    expect(within(tree).getByText("desktop")).not.toBeNull();
    expect(within(tree).getByText("src")).not.toBeNull();
    expect(within(tree).getByText("app.ts")).not.toBeNull();
    expect(within(tree).getByText("README.md")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Earlier local commit/ }));
    expect(onSelectCommit).toHaveBeenCalledWith(commits[1]);

    rerender(
      <GitCommitPushDialog
        open
        projectName="keydex"
        target={target()}
        commits={commits}
        selectedObjectId={commits[1].objectId}
        detail={detail(commits[1], [file("backend/app/git.py")])}
        onSelectCommit={onSelectCommit}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      within(screen.getByRole("listbox", { name: "待推送提交列表" })).getByRole("option", { selected: true }).textContent,
    ).toContain("Earlier local commit");
    expect(screen.getByRole("tree", { name: "待推送提交改动文件树" }).textContent).toContain("git.py");
  });

  it("uses the styled tag scope selector and forwards current branch as an explicit mode", () => {
    const commits = [commit("Ready to push", "d")];
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <GitCommitPushDialog
        open
        projectName="keydex"
        target={target()}
        commits={commits}
        selectedObjectId={commits[0].objectId}
        detail={detail(commits[0], [file("test.md")])}
        onSelectCommit={vi.fn()}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "推送标签" }));
    fireEvent.click(screen.getByRole("button", { name: "推送标签范围" }));
    fireEvent.click(screen.getByRole("option", { name: "当前分支" }));
    fireEvent.click(screen.getByRole("button", { name: "推送" }));
    expect(onConfirm).toHaveBeenCalledWith({ tagMode: "current_branch" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps push disabled until the outgoing preview finishes loading", () => {
    render(
      <GitCommitPushDialog
        open
        projectName="keydex"
        target={target()}
        commits={[]}
        selectedObjectId={null}
        detail={null}
        loading
        onSelectCommit={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("正在读取待推送提交…")).not.toBeNull();
    expect(screen.getByRole("button", { name: "推送" }).hasAttribute("disabled")).toBe(true);
  });
});

function target() {
  return { remote: "origin", source: "main", target: "main", upstream: "origin/main", setUpstream: false };
}

function commit(subject: string, seed: string): GitCommitSummary {
  return {
    objectId: seed.repeat(40) as never,
    parentIds: [],
    authorName: "Alice",
    authorEmail: "alice@example.invalid",
    authoredAt: "2026-07-17T00:00:00Z",
    committerName: "Alice",
    committerEmail: "alice@example.invalid",
    committedAt: "2026-07-17T00:00:00Z",
    subject,
    body: "",
    decorations: [],
    signature: "unsigned",
  };
}

function detail(summary: GitCommitSummary, files: readonly GitFileDiff[]): GitCommitDetail {
  return {
    repositoryId: "repo-1" as never,
    repositoryVersion: "version-1" as never,
    commit: summary,
    selectedParentId: null,
    files,
  };
}

function file(path: string): GitFileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: "modified",
    binary: false,
    oldMode: null,
    newMode: null,
    additions: 1,
    deletions: 0,
    hunks: [],
    rawPatch: "",
    truncated: false,
  };
}
