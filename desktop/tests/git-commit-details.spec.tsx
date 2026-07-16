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

  it("renders an independently scrollable file tree and commit information without comparison or diff controls", () => {
    const onSelectFile = vi.fn();
    const detail = normalizedDetail();
    render(
      <GitCommitDetailsView
        detail={detail}
        loading={false}
        selectedFileIndex={0}
        onSelectFile={onSelectFile}
      />,
    );

    expect(screen.getByText("merge topic")).toBeTruthy();
    expect(screen.getByText("Detailed body")).toBeTruthy();
    expect(screen.getByText("有效")).toBeTruthy();
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByTestId("git-commit-files-scroll").classList.contains("keydex-scrollable")).toBe(true);
    expect(screen.getByTestId("git-commit-metadata-scroll").classList.contains("keydex-scrollable")).toBe(true);
    expect(screen.queryByRole("region", { name: "与父提交比较" })).toBeNull();
    expect(screen.queryByText("与父提交比较")).toBeNull();
    expect(screen.queryByText("比较")).toBeNull();
    expect(screen.queryByRole("button", { name: "复制提交哈希" })).toBeNull();

    const tree = screen.getByRole("tree", { name: "变更文件树" });
    expect(within(tree).getByText("src")).toBeTruthy();
    const selectedFileRow = within(tree).getByRole("button", { name: "new.ts" });
    expect(selectedFileRow.dataset.selected).toBe("true");
    expect(selectedFileRow.hasAttribute("title")).toBe(false);
    fireEvent.click(selectedFileRow);
    expect(onSelectFile).toHaveBeenCalledWith(0);
    expect(selectedFileRow.dataset.status).toBe("modified");
    expect(within(tree).getByRole("button", { name: "readme.md" }).dataset.status).toBe("added");
    expect(within(tree).getByRole("button", { name: "legacy.txt" }).dataset.status).toBe("deleted");
    expect(tree.querySelectorAll("[data-icon-id]").length).toBeGreaterThan(0);
  });

  it("keeps commit metadata visible while the file detail is still loading", () => {
    const detail = { ...normalizedDetail(), files: [] };
    render(
      <GitCommitDetailsView
        detail={detail}
        loading
        selectedFileIndex={0}
        onSelectFile={vi.fn()}
      />,
    );

    expect(screen.getByText("merge topic")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("正在加载变更文件…");
  });

  it("resizes the two scroll regions from the horizontal separator", () => {
    render(
      <GitCommitDetailsView
        detail={normalizedDetail()}
        loading={false}
        selectedFileIndex={0}
        onSelectFile={vi.fn()}
      />,
    );

    const separator = screen.getByRole("separator", { name: "调整变更文件与提交信息区域高度" });
    expect(separator.getAttribute("aria-valuenow")).toBe("48");
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator.getAttribute("aria-valuenow")).toBe("52");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("76");
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
    expect(tree[1].status).toBe("modified");
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
    files: [
      file("src/new.ts", { oldPath: "src/old.ts", status: "renamed", additions: 3, deletions: 1 }),
      file("docs/readme.md", { status: "added", additions: 0 }),
      file("legacy.txt", { newPath: null, status: "deleted", additions: 0 }),
    ],
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
