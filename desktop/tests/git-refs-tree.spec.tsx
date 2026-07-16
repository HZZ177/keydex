import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRefsTree, buildGitRefTree } from "@/renderer/features/git/components/GitRefsTree";
import type { GitObjectId, GitRef } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("GitRefsTree", () => {
  it("builds stable HEAD/local/remote/tag groups with current branch first", () => {
    const groups = buildGitRefTree(refs());
    expect(groups.map((group) => group.kind)).toEqual(["local", "remote", "tag"]);
    expect(groups[0].refs.map((ref) => ref.shortName)).toEqual(["main", "feature/git-view"]);
  });

  it("supports selection, collapse, ahead/behind and context actions", () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(<GitRefsTree refs={refs()} selectedRef={null} onSelect={onSelect} onAction={onAction} />);

    expect(screen.getByRole("treeitem", { name: "HEAD main" })).not.toBeNull();
    expect(screen.getByText("↑2↓1")).not.toBeNull();
    fireEvent.click(screen.getByRole("treeitem", { name: /^远程/ }));
    expect(screen.queryByRole("treeitem", { name: /origin\/main/ })).toBeNull();
    fireEvent.click(screen.getByRole("treeitem", { name: /^远程/ }));
    fireEvent.click(screen.getByRole("button", { name: "origin/main actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Checkout" }));
    expect(onAction).toHaveBeenCalledWith("checkout", expect.objectContaining({ fullName: "refs/remotes/origin/main" }));
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
