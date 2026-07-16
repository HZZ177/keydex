import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmWorktreeRemoval, GitWorktreeView } from "@/renderer/features/git/components/GitWorktreeView";
import type { GitWorktreesSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git worktree management", () => {
  it("keeps parent identity and independent external authorization visible", () => {
    renderView();
    const identity = screen.getByText(/Parent repository/, { selector: "p" });
    expect(identity.textContent).toContain("parent-repo");
    expect(identity.textContent).toContain("independent exact-path grant");
    expect(screen.getByText("D:/worktrees/topic")).toBeTruthy();
    expect(screen.getByText(/external · dirty/)).toBeTruthy();
  });

  it("separates authorization from add and submits typed add options", () => {
    const onAuthorize = vi.fn();
    const onAdd = vi.fn();
    renderView({ onAuthorize, onAdd });
    fireEvent.change(screen.getByLabelText("Worktree target path"), { target: { value: "D:/worktrees/new" } });
    fireEvent.change(screen.getByLabelText("Worktree revision"), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText("Worktree new branch"), { target: { value: "feature/new" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize external path" }));
    expect(onAuthorize).toHaveBeenCalledWith("D:/worktrees/new");
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledWith({ path: "D:/worktrees/new", revision: "main", newBranch: "feature/new", detach: false });
  });

  it("requires two confirmations only for dirty removal", () => {
    const confirm = vi.fn().mockReturnValue(true);
    expect(confirmWorktreeRemoval({ path: "D:/clean", dirty: false }, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockClear();
    expect(confirmWorktreeRemoval({ path: "D:/dirty", dirty: true }, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][0]).toContain("uncommitted changes");
    confirm.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(confirmWorktreeRemoval({ path: "D:/dirty", dirty: true }, confirm)).toBe(false);
  });

  it("routes revoke, lock, unlock, remove and prune without exposing primary removal", () => {
    const actions = {
      onRevoke: vi.fn(),
      onRemove: vi.fn(),
      onPrune: vi.fn(),
      onLock: vi.fn(),
      onUnlock: vi.fn(),
    };
    vi.spyOn(window, "prompt").mockReturnValue("maintenance");
    renderView(actions);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Prune stale" }));
    expect(actions.onRevoke).toHaveBeenCalledWith("D:/worktrees/topic");
    expect(actions.onLock).toHaveBeenCalledWith(expect.objectContaining({ path: "D:/worktrees/topic" }), "maintenance");
    expect(actions.onRemove).toHaveBeenCalledWith(expect.objectContaining({ dirty: true }));
    expect(actions.onPrune).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
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
