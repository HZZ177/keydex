import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitSyncActions } from "@/renderer/features/git/components/GitSyncActions";

afterEach(cleanup);

describe("GitSyncActions", () => {
  it("defaults to one remote without prune and exposes explicit options", () => {
    const onFetch = vi.fn();
    render(<GitSyncActions {...baseProps()} remotes={[remote("origin")]} onFetch={onFetch} />);

    expect((screen.getByRole("checkbox", { name: "Prune deleted refs" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Fetch all tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(onFetch).toHaveBeenCalledWith({ remote: "origin", allRemotes: false, prune: false, tags: true });
  });

  it("fetches all remotes only after an explicit selection and announces progress", () => {
    const onFetch = vi.fn();
    render(<GitSyncActions {...baseProps()} remotes={[remote("origin"), remote("backup")]} progress={["Receiving objects: 100%"]} onFetch={onFetch} />);
    fireEvent.change(screen.getByLabelText("Fetch remote"), { target: { value: "__all__" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Prune deleted refs" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(onFetch).toHaveBeenCalledWith({ remote: null, allRemotes: true, prune: true, tags: false });
    expect(screen.getByText("Receiving objects: 100%")).not.toBeNull();
  });

  it("previews dirty/divergent state and keeps update strategy explicit", () => {
    const onUpdate = vi.fn();
    const onUpdateStrategyChange = vi.fn();
    render(<GitSyncActions
      {...baseProps()}
      status={{
        repositoryId: "repo-1" as never,
        repositoryVersion: "v1" as never,
        branch: { head: "main", detachedAt: null, upstream: "origin/main", ahead: 2, behind: 3, unborn: false },
        files: [{ path: "dirty.ts", originalPath: null, indexStatus: null, worktreeStatus: "modified", conflicted: false, binary: false, submodule: false }],
        operation: null,
      }}
      updateStrategy="rebase"
      updateOutcome="conflict"
      onUpdate={onUpdate}
      onUpdateStrategyChange={onUpdateStrategyChange}
    />);
    expect(screen.getByText(/1 local changes · 2 ahead · 3 behind/)).not.toBeNull();
    expect(screen.getByText(/不会自动 stash/)).not.toBeNull();
    expect(screen.getByText("Update stopped on conflicts")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Update strategy"), { target: { value: "merge" } });
    expect(onUpdateStrategyChange).toHaveBeenCalledWith("merge");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("previews source and target and requires an explicit upstream for first push", () => {
    const onPush = vi.fn();
    render(<GitSyncActions
      {...baseProps()}
      status={{
        repositoryId: "repo-1" as never,
        repositoryVersion: "v1" as never,
        branch: { head: "feature/demo", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
        files: [],
        operation: null,
      }}
      onPush={onPush}
    />);
    expect(screen.getByText("feature/demo → origin/feature/demo")).not.toBeNull();
    expect((screen.getByRole("checkbox", { name: "Set upstream" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Push tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Push" }));
    expect(onPush).toHaveBeenCalledWith({
      remote: "origin",
      source: "feature/demo",
      target: "feature/demo",
      setUpstream: true,
      tags: true,
      forceWithLease: false,
    });
  });

  it("blocks protected targets and exposes only force-with-lease for other branches", () => {
    const onPush = vi.fn();
    const { rerender } = render(<GitSyncActions
      {...baseProps()}
      status={statusWithUpstream("main", "origin/main", 1, 2)}
      onPush={onPush}
    />);
    expect(screen.getByRole("checkbox", { name: "Force with lease" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/protected branch main/)).not.toBeNull();

    rerender(<GitSyncActions
      {...baseProps()}
      status={statusWithUpstream("feature/demo", "origin/feature/demo", 1, 2)}
      outgoingCommits={[commit("local commit", "a")]}
      replacedCommits={[commit("remote one", "b"), commit("remote two", "c")]}
      onPush={onPush}
    />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Force with lease" }));
    expect(screen.getByText(/2 remote commit/)).not.toBeNull();
    expect(screen.getByRole("region", { name: "Outgoing commits" }).textContent).toContain("local commit");
    expect(screen.getByRole("region", { name: "Remote commits that will be replaced" }).textContent).toContain("remote two");
    fireEvent.click(screen.getByRole("button", { name: "Force Push with Lease" }));
    expect(onPush).toHaveBeenCalledWith(expect.objectContaining({ forceWithLease: true }));
  });
});

function remote(name: string) {
  return { name, fetchUrl: `D:/${name}.git`, pushUrl: `D:/${name}.git`, trackingBranches: [] };
}

function baseProps() {
  return {
    remotes: [remote("origin")],
    busy: false,
    progress: [] as readonly string[],
    status: null,
    updateStrategy: "ff_only" as const,
    updateBusy: false,
    updateOutcome: null,
    pushBusy: false,
    pushOutcome: null,
    onFetch: vi.fn(),
    onUpdateStrategyChange: vi.fn(),
    onUpdate: vi.fn(),
    onPush: vi.fn(),
  };
}

function statusWithUpstream(head: string, upstream: string, ahead: number, behind: number) {
  return {
    repositoryId: "repo-1" as never,
    repositoryVersion: "v1" as never,
    branch: { head, detachedAt: null, upstream, ahead, behind, unborn: false },
    files: [],
    operation: null,
  };
}

function commit(subject: string, seed: string) {
  return {
    objectId: seed.repeat(40) as never,
    parentIds: [],
    authorName: "Alice",
    authorEmail: "alice@example.invalid",
    authoredAt: "2026-07-16T00:00:00Z",
    committerName: "Alice",
    committerEmail: "alice@example.invalid",
    committedAt: "2026-07-16T00:00:00Z",
    subject,
    body: "",
    decorations: [],
    signature: "unsigned" as const,
  };
}
