import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRepositoryList } from "@/renderer/features/git/components/GitRepositoryList";
import type { GitRepositoryDescriptor, GitRepositoryId, GitStatusSnapshot } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("multi-root Git navigation", () => {
  it("shows selected root, hierarchy, and an aggregate project summary", () => {
    render(<GitRepositoryList items={items()} selectedRepositoryId={"nested" as never} onSelect={vi.fn()} />);
    expect(screen.getByLabelText("All Git repositories summary").textContent).toContain("2 roots · 3 changes · ↑2 ↓1");
    const root = screen.getByRole("option", { name: /project/ });
    const nested = screen.getByRole("option", { name: /packages\/app/ });
    expect(root.getAttribute("aria-selected")).toBe("false");
    expect(nested.getAttribute("aria-selected")).toBe("true");
    expect(Number.parseInt(nested.style.paddingInlineStart)).toBeGreaterThan(Number.parseInt(root.style.paddingInlineStart));
  });

  it("routes a root switch through the exact repository identity", () => {
    const onSelect = vi.fn();
    render(<GitRepositoryList items={items()} selectedRepositoryId={"root" as never} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("option", { name: /packages\/app/ }));
    expect(onSelect).toHaveBeenCalledWith("nested");
  });
});

function items() {
  const root = repository("root", "project", "D:/project", null, "workspace");
  const nested = repository("nested", "packages/app", "D:/project/packages/app", root.id, "nested");
  return [
    { repository: root, status: status("root", "main", 1, 2, 0) },
    { repository: nested, status: status("nested", "feature", 2, 0, 1) },
  ];
}

function repository(id: string, displayPath: string, rootPath: string, parentRepoId: GitRepositoryId | null, kind: GitRepositoryDescriptor["kind"]): GitRepositoryDescriptor {
  return { id: id as never, workspaceId: "workspace", rootPath, displayPath, gitDirPath: `${rootPath}/.git`, kind, parentRepoId, bare: false, ancestorAuthorization: "not_required" };
}

function status(id: string, branch: string, changes: number, ahead: number, behind: number): GitStatusSnapshot {
  return {
    repositoryId: id as never,
    repositoryVersion: `v-${id}` as never,
    branch: { head: branch, detachedAt: null, upstream: `origin/${branch}`, ahead, behind, unborn: false },
    files: Array.from({ length: changes }, (_, index) => ({ path: `${index}.txt`, originalPath: null, indexStatus: null, worktreeStatus: "modified" as const, conflicted: false, binary: false, submodule: false })),
    operation: null,
  };
}
