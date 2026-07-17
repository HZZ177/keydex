import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitWorktreeView } from "@/renderer/features/git/components/GitWorktreeView";
import type { GitWorktreesSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git worktree management", () => {
  it("keeps parent identity and independent external authorization visible", () => {
    renderView();
    const identity = screen.getByText(/父仓库/, { selector: "p" });
    expect(identity.textContent).toContain("parent-repo");
    expect(identity.textContent).toContain("精确路径权限");
    expect(screen.getByText("D:/worktrees/topic")).toBeTruthy();
    expect(screen.getByText(/外部路径 · 有改动/)).toBeTruthy();
  });

  it("separates authorization from add and submits typed add options", () => {
    const onAuthorize = vi.fn();
    const onAdd = vi.fn();
    renderView({ onAuthorize, onAdd });
    fireEvent.click(screen.getByRole("button", { name: "授权路径…" }));
    fireEvent.change(screen.getByLabelText("要授权的工作树路径"), { target: { value: "D:/worktrees/new" } });
    fireEvent.click(screen.getByRole("button", { name: "确认授权" }));
    expect(onAuthorize).toHaveBeenCalledWith("D:/worktrees/new");
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "添加工作树…" }));
    fireEvent.change(screen.getByLabelText("工作树目标路径"), { target: { value: "D:/worktrees/new" } });
    fireEvent.change(screen.getByLabelText("工作树修订"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("工作树新分支"), { target: { value: "feature/new" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(onAdd).toHaveBeenCalledWith({ path: "D:/worktrees/new", revision: "main", newBranch: "feature/new", detach: false });
  });

  it("previews dirty removal and executes only after confirmation", () => {
    const onRemove = vi.fn();
    renderView({ onRemove });
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(screen.getByRole("dialog", { name: "确认移除工作树" }).textContent).toContain("有未提交改动，将强制移除");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ dirty: true }));
  });

  it("routes revoke, lock, unlock, remove and prune without exposing primary removal", () => {
    const actions = {
      onRevoke: vi.fn(),
      onRemove: vi.fn(),
      onPrune: vi.fn(),
      onLock: vi.fn(),
      onUnlock: vi.fn(),
    };
    renderView(actions);
    fireEvent.click(screen.getByRole("button", { name: "撤销授权" }));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
    fireEvent.click(screen.getAllByRole("button", { name: "锁定" }).at(-1)!);
    fireEvent.change(screen.getByLabelText("工作树锁定原因"), { target: { value: "maintenance" } });
    fireEvent.click(screen.getAllByRole("button", { name: "锁定" }).at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    fireEvent.click(screen.getByRole("button", { name: "清理失效登记…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
    expect(actions.onRevoke).toHaveBeenCalledWith("D:/worktrees/topic");
    expect(actions.onLock).toHaveBeenCalledWith(expect.objectContaining({ path: "D:/worktrees/topic" }), "maintenance");
    expect(actions.onRemove).toHaveBeenCalledWith(expect.objectContaining({ dirty: true }));
    expect(actions.onPrune).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { name: "移除" })).toHaveLength(1);
  });
});

function renderView(overrides: Partial<Parameters<typeof GitWorktreeView>[0]> = {}) {
  const props: Parameters<typeof GitWorktreeView>[0] = {
    snapshot: snapshot(),
    parentRepositoryId: "parent-repo" as never,
    loading: false,
    busy: false,
    onAuthorize: vi.fn(),
    onRevoke: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onPrune: vi.fn(),
    onLock: vi.fn(),
    onUnlock: vi.fn(),
    ...overrides,
  };
  return render(<GitWorktreeView {...props} />);
}

function snapshot(): GitWorktreesSnapshot {
  return {
    repositoryId: "parent-repo" as never,
    repositoryVersion: "v1" as never,
    worktrees: [
      { path: "D:/repo", head: "a".repeat(40) as never, branch: "refs/heads/main", bare: false, detached: false, lockedReason: null, prunableReason: null, primary: true, authorized: true, authorizationRequired: false, dirty: false },
      { path: "D:/worktrees/topic", head: "b".repeat(40) as never, branch: "refs/heads/topic", bare: false, detached: false, lockedReason: null, prunableReason: null, primary: false, authorized: true, authorizationRequired: true, dirty: true },
    ],
  };
}
