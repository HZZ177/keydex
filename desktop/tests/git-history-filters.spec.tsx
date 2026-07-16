import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHistoryView, type GitHistoryRevisionOption, validateHistoryRevision } from "@/renderer/features/git/components/GitHistoryView";
import { createGitRuntime, type GitHistoryFilters } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";

afterEach(cleanup);

const emptyFilters: GitHistoryFilters = {
  search: "",
  revision: "",
  author: "",
  since: "",
  until: "",
  path: "",
  firstParent: false,
  mergesOnly: false,
};

describe("Git history filters", () => {
  it("combines message, branch, author, date, path, and topology controls and clears them", () => {
    const onApplyFilters = vi.fn();
    const revisions: GitHistoryRevisionOption[] = [{ value: "refs/heads/main", label: "main" }];
    render(
      <GitHistoryView
        commits={[]}
        selectedObjectId={null}
        loading={false}
        hasMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        filters={emptyFilters}
        revisionOptions={revisions}
        onApplyFilters={onApplyFilters}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message or commit hash"), { target: { value: "release note" } });
    fireEvent.change(screen.getByLabelText("Revision"), { target: { value: "refs/heads/main" } });
    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("Since"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Until"), { target: { value: "2026-07-16" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "src/history.ts" } });
    fireEvent.click(screen.getByLabelText("First parent"));
    fireEvent.click(screen.getByLabelText("Merges"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApplyFilters).toHaveBeenLastCalledWith({
      search: "release note",
      revision: "refs/heads/main",
      author: "Alice",
      since: "2026-01-01",
      until: "2026-07-16",
      path: "src/history.ts",
      firstParent: true,
      mergesOnly: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onApplyFilters).toHaveBeenLastCalledWith(emptyFilters);
    expect((screen.getByLabelText("Message or commit hash") as HTMLInputElement).value).toBe("");
  });

  it("accepts arbitrary safe revisions and rejects option-like or malformed ranges", () => {
    const onApplyFilters = vi.fn();
    render(
      <GitHistoryView
        commits={[]}
        selectedObjectId={null}
        loading={false}
        hasMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={vi.fn()}
        onApplyFilters={onApplyFilters}
      />,
    );

    fireEvent.change(screen.getByLabelText("Revision"), { target: { value: "release/1.0~2..HEAD" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApplyFilters).toHaveBeenCalledWith(expect.objectContaining({ revision: "release/1.0~2..HEAD" }));

    fireEvent.change(screen.getByLabelText("Revision"), { target: { value: "main..--all" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert").textContent).toContain("valid Git revision");
    expect(onApplyFilters).toHaveBeenCalledTimes(1);
    expect(validateHistoryRevision("HEAD...feature/topic").valid).toBe(true);
  });

  it("encodes text and hash searches without confusing them with Git revisions", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({
      repository_id: "git-history",
      repository_version: "version-1",
      commits: [],
      next_cursor: null,
    }));
    const runtime = createGitRuntime(new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher }));
    const scope = {
      workspaceId: "workspace-a",
      projectRoot: "C:/project",
      repositoryId: "git-history" as never,
    };

    await runtime.history(scope, {
      search: "release note",
      revision: "refs/heads/main",
      author: "Alice",
      since: "2026-01-01",
      until: "2026-07-16",
      path: "src/history.ts",
      firstParent: true,
      mergesOnly: true,
      cursor: "next page",
      limit: 50,
    });
    await runtime.history(scope, { search: "a1b2c3d4" });

    const firstUrl = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(firstUrl.searchParams)).toMatchObject({
      workspace_id: "workspace-a",
      project_root: "C:/project",
      query: "release note",
      revision: "refs/heads/main",
      author: "Alice",
      since: "2026-01-01",
      until: "2026-07-16",
      path: "src/history.ts",
      first_parent: "true",
      merges_only: "true",
      cursor: "next page",
      limit: "50",
    });
    expect(firstUrl.searchParams.has("hash_prefix")).toBe(false);

    const secondUrl = new URL(String(fetcher.mock.calls[1][0]));
    expect(secondUrl.searchParams.get("hash_prefix")).toBe("a1b2c3d4");
    expect(secondUrl.searchParams.has("query")).toBe(false);
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
