import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCommitFileTree, GitCommitDetailsView } from "@/renderer/features/git/components/GitCommitDetailsView";
import { createGitRuntime } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";
import type { GitCommitDetail, GitFileDiff } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git commit details", () => {
  it("normalizes parent-specific detail responses and sends the selected parent", async () => {
    const response = rawDetail();
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(response));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const parentId = "b".repeat(40) as never;

    const detail = await runtime.commit({
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId: "git-detail" as never,
    }, "a".repeat(40), { parentId });

    expect(detail).toMatchObject({
      repositoryId: "git-detail",
      selectedParentId: parentId,
      commit: { subject: "merge topic", signature: "valid" },
    });
    expect(detail.files[0]).toMatchObject({
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      status: "renamed",
      additions: 3,
      deletions: 1,
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toContain(`/commits/${"a".repeat(40)}`);
    expect(url.searchParams.get("parent")).toBe(parentId);
  });

  it("renders metadata, signature, parent switching, stats, and a selectable file tree", () => {
    const onSelectParent = vi.fn();
    const onSelectFile = vi.fn();
    const onCopyHash = vi.fn();
    const onSelectDecoration = vi.fn();
    const detail = normalizedDetail();
    render(
      <GitCommitDetailsView
        detail={detail}
        loading={false}
        selectedFileIndex={0}
        onSelectFile={onSelectFile}
        onSelectParent={onSelectParent}
        onCopyHash={onCopyHash}
        onSelectDecoration={onSelectDecoration}
      />,
    );

    expect(screen.getByText("merge topic")).toBeTruthy();
    expect(screen.getByText("valid")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy commit hash" }));
    expect(onCopyHash).toHaveBeenCalledWith("a".repeat(40));
    fireEvent.click(screen.getByRole("button", { name: "tag: v1" }));
    expect(onSelectDecoration).toHaveBeenCalledWith("tag: v1");
    fireEvent.click(screen.getByRole("button", { name: `P2 · ${"b".repeat(8)}` }));
    expect(onSelectParent).toHaveBeenCalledWith("b".repeat(40));

    const tree = screen.getByRole("tree", { name: "Commit files" });
    expect(within(tree).getByText("src")).toBeTruthy();
    fireEvent.click(within(tree).getByRole("button", { name: "new.ts" }));
    expect(onSelectFile).toHaveBeenCalledWith(0);
  });

  it("builds deterministic nested paths with directories before root files", () => {
    const files = [
      file("z.txt"),
      file("src/z.ts"),
      file("src/a.ts"),
      file("docs/readme.md"),
    ];
    const tree = buildCommitFileTree(files);

    expect(tree.map((node) => node.name)).toEqual(["docs", "src", "z.txt"]);
    expect(tree[1].children.map((node) => node.name)).toEqual(["a.ts", "z.ts"]);
    expect(tree[1].children.map((node) => node.fileIndex)).toEqual([2, 1]);
  });
});

function normalizedDetail(): GitCommitDetail {
  return {
    repositoryId: "git-detail" as never,
    repositoryVersion: "version-1" as never,
    commit: {
      objectId: "a".repeat(40) as never,
      parentIds: ["c".repeat(40), "b".repeat(40)] as never,
      authorName: "Alice",
      authorEmail: "alice@example.invalid",
      authoredAt: "2026-07-16T00:00:00Z",
      committerName: "Bob",
      committerEmail: "bob@example.invalid",
      committedAt: "2026-07-16T00:01:00Z",
      subject: "merge topic",
      body: "Detailed body",
      decorations: ["HEAD -> main", "tag: v1"],
      signature: "valid",
    },
    selectedParentId: "c".repeat(40) as never,
    files: [file("src/new.ts", { oldPath: "src/old.ts", status: "renamed", additions: 3, deletions: 1 })],
  };
}

function file(path: string, overrides: Partial<GitFileDiff> = {}): GitFileDiff {
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
    rawPatch: "diff --git",
    truncated: false,
    ...overrides,
  };
}

function rawDetail() {
  return {
    repository_id: "git-detail",
    repository_version: "version-1",
    selected_parent_id: "b".repeat(40),
    commit: {
      object_id: "a".repeat(40),
      parent_ids: ["c".repeat(40), "b".repeat(40)],
      author_name: "Alice",
      author_email: "alice@example.invalid",
      authored_at: "2026-07-16T00:00:00Z",
      committer_name: "Bob",
      committer_email: "bob@example.invalid",
      committed_at: "2026-07-16T00:01:00Z",
      subject: "merge topic",
      body: "Detailed body",
      decorations: ["HEAD -> main"],
      signature: "valid",
    },
    files: [{
      old_path: "src/old.ts",
      new_path: "src/new.ts",
      status: "renamed",
      binary: false,
      old_mode: "100644",
      new_mode: "100644",
      additions: 3,
      deletions: 1,
      hunks: [],
      raw_patch: "diff --git a/src/old.ts b/src/new.ts",
      truncated: false,
    }],
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
