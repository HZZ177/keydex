import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCommitEditor, validateCommitMessage } from "@/renderer/features/git/components/GitCommitEditor";
import type { GitRepositoryId, GitRepositoryVersion, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("GitCommitEditor", () => {
  it("validates messages and submits amend/sign options for staged files", () => {
    expect(validateCommitMessage(" ").valid).toBe(false);
    expect(validateCommitMessage("x".repeat(73))).toEqual({ valid: true, message: "标题超过建议的 72 个字符" });
    expect(validateCommitMessage("x".repeat(101)).valid).toBe(false);

    const onDraftChange = vi.fn();
    const onCommit = vi.fn();
    const { rerender } = render(
      <GitCommitEditor status={status()} draft="" onDraftChange={onDraftChange} onCommit={onCommit} />,
    );
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "feat: Git workbench" } });
    expect(onDraftChange).toHaveBeenCalledWith("feat: Git workbench");

    rerender(
      <GitCommitEditor status={status()} draft="feat: Git workbench" onDraftChange={onDraftChange} onCommit={onCommit} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "修订上次提交" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "GPG 签名" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onCommit).toHaveBeenCalledWith({ message: "feat: Git workbench", amend: true, sign: true });
  });

  it("blocks commit until a repository-local identity is configured", () => {
    const onConfigureIdentity = vi.fn();
    render(
      <GitCommitEditor
        status={status()}
        draft="feat: identity"
        identity={null}
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
        onConfigureIdentity={onConfigureIdentity}
      />,
    );
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Git 用户名" }), { target: { value: "Keydex User" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Git 邮箱" }), { target: { value: "keydex@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存到当前仓库" }));
    expect(onConfigureIdentity).toHaveBeenCalledWith({
      name: "Keydex User",
      email: "keydex@example.com",
      signByDefault: false,
    });
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
    expect(screen.getByRole("status", { name: "Commit result" }).textContent).toContain("Created commit");
    expect(screen.getByText("1234567890ab")).not.toBeNull();
  });

  it("previews the amend target and requires explicit confirmation for published history", () => {
    const onCommit = vi.fn();
    render(
      <GitCommitEditor
        status={status()}
        draft="fix: amended"
        amendTarget={{ objectId: "a".repeat(40), subject: "previous subject", published: true }}
        onDraftChange={vi.fn()}
        onCommit={onCommit}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "修订上次提交" }));
    expect(screen.getByRole("status", { name: "Amend rewrite preview" }).textContent).toContain("aaaaaaaaaaaa");
    expect(screen.getByRole("button", { name: "提交" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "确认重写已发布提交" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onCommit).toHaveBeenCalledWith({ message: "fix: amended", amend: true, sign: false });
  });

  it("exposes Commit and Push as an explicit second action", () => {
    const onCommitAndPush = vi.fn();
    render(
      <GitCommitEditor
        status={status()}
        draft="feat: commit and push"
        onDraftChange={vi.fn()}
        onCommit={vi.fn()}
        onCommitAndPush={onCommitAndPush}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Commit and Push" }));
    expect(onCommitAndPush).toHaveBeenCalledWith({
      message: "feat: commit and push",
      amend: false,
      sign: false,
    });
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

    expect(screen.getByText("0 个已暂存文件")).not.toBeNull();
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
