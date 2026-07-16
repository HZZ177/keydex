import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCommitEditor, validateCommitMessage } from "@/renderer/features/git/components/GitCommitEditor";
import type { GitRepositoryId, GitRepositoryVersion, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("GitCommitEditor", () => {
  it("validates messages and submits fixed standard options for selected files", () => {
    expect(validateCommitMessage(" ").valid).toBe(false);
    expect(validateCommitMessage("x".repeat(73))).toEqual({ valid: true, message: "标题超过建议的 72 个字符" });
    expect(validateCommitMessage("x".repeat(101)).valid).toBe(false);

    const onDraftChange = vi.fn();
    const onCommit = vi.fn();
    const { rerender } = render(
      <GitCommitEditor status={status()} selectedFileCount={1} draft="" onDraftChange={onDraftChange} onCommit={onCommit} />,
    );
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "提交说明" }), { target: { value: "feat: Git workbench" } });
    expect(onDraftChange).toHaveBeenCalledWith("feat: Git workbench");

    rerender(
      <GitCommitEditor status={status()} selectedFileCount={1} draft="feat: Git workbench" onDraftChange={onDraftChange} onCommit={onCommit} />,
    );
    expect(screen.queryByRole("checkbox", { name: "修订上次提交" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "提交签名" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onCommit).toHaveBeenCalledWith({ message: "feat: Git workbench", amend: false, sign: false });
  });

  it("shows repository identity as read-only and blocks commit when it is missing", () => {
    render(
      <GitCommitEditor
        status={status()}
        selectedFileCount={1}
        draft="feat: identity"
        identity={null}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("尚未配置 Git 提交身份")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "配置" })).toBeNull();
  });

  it("does not expose a modify action for an existing identity", () => {
    render(
      <GitCommitEditor
        status={status()}
        selectedFileCount={1}
        draft="feat: identity"
        identity={{ repositoryId: "repo-1" as GitRepositoryId, name: "Keydex User", email: "keydex@example.com", signByDefault: true }}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText("Keydex User <keydex@example.com>").closest("header")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "修改" })).toBeNull();
  });

  it("renders the successful commit oid returned by the backend", () => {
    render(
      <GitCommitEditor
        status={status()}
        draft=""
        outcome={{ oid: "1234567890abcdef", summary: "Created commit", status: "committed" }}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByRole("status", { name: "提交结果" }).textContent).toContain("Created commit");
    expect(screen.getByText("1234567890ab")).not.toBeNull();
  });

  it("exposes 提交并推送 as an explicit second action", () => {
    const onCommitAndPush = vi.fn();
    render(
      <GitCommitEditor
        status={status()}
        selectedFileCount={1}
        draft="feat: commit and push"
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={onCommitAndPush}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));
    expect(onCommitAndPush).toHaveBeenCalledWith({
      message: "feat: commit and push",
      amend: false,
      sign: false,
    });
  });

  it("quietly disables both commit actions when no files are selected", () => {
    const unstagedStatus: GitStatusSnapshot = {
      ...status(),
      files: status().files.map((file) => ({ ...file, indexStatus: null })),
    };
    render(
      <GitCommitEditor
        status={unstagedStatus}
        draft="fix: selected files required"
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={vi.fn()}
      />,
    );

    expect(screen.queryByText("请至少选择一个要提交的文件")).toBeNull();
    const commit = screen.getByRole("button", { name: "提交" });
    const commitAndPush = screen.getByRole("button", { name: "提交并推送" });
    expect(commit.hasAttribute("disabled")).toBe(true);
    expect(commitAndPush.hasAttribute("disabled")).toBe(true);
    expect(commit.querySelector("svg")).toBeNull();
    expect(commitAndPush.querySelector("svg")).toBeNull();
  });

  it("allows a merge commit when accepting ours leaves no staged tree delta", () => {
    const onCommit = vi.fn();
    const mergeStatus: GitStatusSnapshot = {
      ...status(),
      files: [],
      operation: {
        kind: "merge",
        state: "continuable",
        currentStep: null,
        totalSteps: null,
        currentObjectId: "a".repeat(40) as never,
      },
    };
    render(
      <GitCommitEditor
        status={mergeStatus}
        draft="merge: keep ours"
        onDraftChange={vi.fn()}
        onCommit={onCommit}
      />,
    );

    const commit = screen.getByRole("button", { name: "提交" });
    expect(commit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(commit);
    expect(onCommit).toHaveBeenCalledWith({ message: "merge: keep ours", amend: false, sign: false });
  });

  it("does not treat an unresolved conflict as a staged merge result", () => {
    const conflicted: GitStatusSnapshot = {
      ...status(),
      files: [{
        path: "conflict.txt",
        originalPath: null,
        indexStatus: "conflicted",
        worktreeStatus: "conflicted",
        conflicted: true,
        binary: null,
        submodule: false,
      }],
      operation: {
        kind: "merge",
        state: "conflicted",
        currentStep: null,
        totalSteps: null,
        currentObjectId: "b".repeat(40) as never,
      },
    };
    render(
      <GitCommitEditor
        status={conflicted}
        draft="merge: unresolved"
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByText("0 个已选择文件")).not.toBeNull();
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
  });
});

function status(): GitStatusSnapshot {
  return {
    repositoryId: "repo-1" as GitRepositoryId,
    repositoryVersion: "v1" as GitRepositoryVersion,
    branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
    operation: null,
    files: [
      { path: "src/a.ts", originalPath: null, indexStatus: "modified", worktreeStatus: null, conflicted: false, binary: false, submodule: false },
    ],
  };
}
