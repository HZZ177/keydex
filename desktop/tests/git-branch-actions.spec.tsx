import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitBranchActions,
  branchDeletionRisk,
  validateBranchName,
} from "@/renderer/features/git/components/GitBranchActions";
import type { GitObjectId, GitRef, GitRepositoryId, GitRepositoryVersion, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("GitBranchActions", () => {
  it("validates branch names and creates from the selected revision", () => {
    expect(validateBranchName("feature/git-ui").valid).toBe(true);
    expect(validateBranchName("../bad").valid).toBe(false);
    const onCreate = vi.fn();
    renderBranchActions({ onCreate });
    fireEvent.change(screen.getByLabelText("New branch from feature/base"), { target: { value: "feature/git-ui" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("feature/git-ui", "feature/base");
  });

  it("offers Commit, Stash, and Cancel without automatically checking out a dirty tree", () => {
    const onCheckout = vi.fn();
    const onOpenChanges = vi.fn();
    const onStashAndCheckout = vi.fn();
    renderBranchActions({ onCheckout, onOpenChanges, onStashAndCheckout, dirty: true });

    fireEvent.click(screen.getByRole("button", { name: "Checkout" }));
    expect(onCheckout).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("will not stash automatically");
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Stash and checkout" }));
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
    expect(onStashAndCheckout).toHaveBeenCalledWith(expect.objectContaining({ shortName: "feature/base" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("classifies protected branches and exposes rename/delete commands", () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    renderBranchActions({ onRename, onDelete });
    fireEvent.change(screen.getByLabelText("Rename feature/base"), { target: { value: "feature/renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ shortName: "feature/base" }), "feature/renamed");
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Force delete…" }));
    expect(onDelete).toHaveBeenNthCalledWith(1, expect.objectContaining({ shortName: "feature/base" }), false);
    expect(onDelete).toHaveBeenNthCalledWith(2, expect.objectContaining({ shortName: "feature/base" }), true);
    expect(branchDeletionRisk(refs()[0], status(false))).toBe("current");
    expect(branchDeletionRisk({ ...refs()[1], shortName: "main" }, status(false))).toBe("protected");
  });

  it("creates annotated tags from the selected ref and displays tag target/message", () => {
    const onCreateTag = vi.fn();
    const onPushTag = vi.fn();
    const { rerender } = renderBranchActions({ onCreateTag });
    fireEvent.change(screen.getByLabelText("Tag name"), { target: { value: "v1.0.0" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Annotated" }));
    fireEvent.change(screen.getByLabelText("Tag message"), { target: { value: "Version one" } });
    fireEvent.click(screen.getByRole("button", { name: "Create tag" }));
    expect(onCreateTag).toHaveBeenCalledWith({
      name: "v1.0.0",
      target: "feature/base",
      annotated: true,
      message: "Version one",
      sign: false,
    });

    rerender(
      <GitBranchActions
        refs={[tagRef()]}
        selectedRef="refs/tags/v1.0.0"
        status={status(false)}
        onCreate={vi.fn()}
        onCheckout={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCreateTag={vi.fn()}
        onDeleteTag={vi.fn()}
        onPushTag={onPushTag}
        onSetUpstream={vi.fn()}
        onOpenChanges={vi.fn()}
        onStashAndCheckout={vi.fn()}
      />,
    );
    expect(screen.getByText("Version one")).not.toBeNull();
    expect(screen.getByText(/Target dddddddddddd/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Push tag…" }));
    expect(onPushTag).toHaveBeenCalledWith(expect.objectContaining({ shortName: "v1.0.0" }), "origin");
  });

  it("binds a local branch only to the explicitly selected remote branch", () => {
    const onSetUpstream = vi.fn();
    renderBranchActions({ onSetUpstream });
    fireEvent.change(screen.getByRole("combobox", { name: "Upstream branch" }), { target: { value: "origin/main" } });
    fireEvent.click(screen.getByRole("button", { name: "Set upstream" }));
    expect(onSetUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ shortName: "feature/base" }),
      "origin/main",
    );
  });
});

function renderBranchActions(overrides: {
  onCreate?: ReturnType<typeof vi.fn>;
  onCheckout?: ReturnType<typeof vi.fn>;
  onOpenChanges?: ReturnType<typeof vi.fn>;
  onStashAndCheckout?: ReturnType<typeof vi.fn>;
  onRename?: ReturnType<typeof vi.fn>;
  onDelete?: ReturnType<typeof vi.fn>;
  onCreateTag?: ReturnType<typeof vi.fn>;
  onDeleteTag?: ReturnType<typeof vi.fn>;
  onPushTag?: ReturnType<typeof vi.fn>;
  onSetUpstream?: ReturnType<typeof vi.fn>;
  dirty?: boolean;
}) {
  return render(
    <GitBranchActions
      refs={refs()}
      selectedRef="refs/heads/feature/base"
      status={status(Boolean(overrides.dirty))}
      onCreate={overrides.onCreate ?? vi.fn()}
      onCheckout={overrides.onCheckout ?? vi.fn()}
      onRename={overrides.onRename ?? vi.fn()}
      onDelete={overrides.onDelete ?? vi.fn()}
      onCreateTag={overrides.onCreateTag ?? vi.fn()}
      onDeleteTag={overrides.onDeleteTag ?? vi.fn()}
      onPushTag={overrides.onPushTag ?? vi.fn()}
      onSetUpstream={overrides.onSetUpstream ?? vi.fn()}
      onOpenChanges={overrides.onOpenChanges ?? vi.fn()}
      onStashAndCheckout={overrides.onStashAndCheckout ?? vi.fn()}
    />,
  );
}

function tagRef(): GitRef {
  return {
    fullName: "refs/tags/v1.0.0",
    shortName: "v1.0.0",
    kind: "tag",
    objectId: "c".repeat(40) as GitObjectId,
    peeledObjectId: "d".repeat(40) as GitObjectId,
    upstream: null,
    ahead: null,
    behind: null,
    current: false,
    annotated: true,
    annotation: "Version one",
  };
}

function refs(): GitRef[] {
  return [
    { fullName: "refs/heads/main", shortName: "main", kind: "local", objectId: "a".repeat(40) as GitObjectId, peeledObjectId: null, upstream: null, ahead: null, behind: null, current: true },
    { fullName: "refs/heads/feature/base", shortName: "feature/base", kind: "local", objectId: "b".repeat(40) as GitObjectId, peeledObjectId: null, upstream: null, ahead: null, behind: null, current: false },
    { fullName: "refs/remotes/origin/main", shortName: "origin/main", kind: "remote", objectId: "a".repeat(40) as GitObjectId, peeledObjectId: null, upstream: null, ahead: null, behind: null, current: false },
  ];
}

function status(dirty: boolean): GitStatusSnapshot {
  return {
    repositoryId: "repo-1" as GitRepositoryId,
    repositoryVersion: "v1" as GitRepositoryVersion,
    branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
    operation: null,
    files: dirty ? [{ path: "dirty.txt", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: false, binary: false, submodule: false }] : [],
  };
}
