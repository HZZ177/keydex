import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHistoryView, type GitHistoryRevisionOption } from "@/renderer/features/git/components/GitHistoryView";
import { createGitRuntime, type GitHistoryFilters } from "@/runtime/git";
import { HttpClient } from "@/runtime/httpClient";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const emptyFilters: GitHistoryFilters = {
  search: "",
  revision: "",
  author: "",
  since: "",
};

describe("Git history filters", () => {
  it("debounces text searches without requiring an extra apply button", async () => {
    vi.useFakeTimers();
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
        filters={emptyFilters}
        onApplyFilters={onApplyFilters}
      />,
    );

    fireEvent.change(screen.getByLabelText("提交说明或哈希"), { target: { value: "release" } });
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(onApplyFilters).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(onApplyFilters).toHaveBeenCalledWith({ ...emptyFilters, search: "release" });
  });

  it("keeps only search, branch, user, date, and the right-side refresh action", () => {
    const onApplyFilters = vi.fn();
    const onRefresh = vi.fn();
    const revisions: GitHistoryRevisionOption[] = [{ value: "refs/heads/main", label: "main" }];
    const view = render(
      <GitHistoryView
        commits={[]}
        selectedObjectId={null}
        loading={false}
        hasMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={onRefresh}
        filters={emptyFilters}
        revisionOptions={revisions}
        authorOptions={["Alice", "Bob"]}
        onApplyFilters={onApplyFilters}
      />,
    );

    const search = screen.getByLabelText("提交说明或哈希");
    fireEvent.change(search, { target: { value: "release note" } });
    fireEvent.blur(search);
    fireEvent.click(screen.getByRole("button", { name: "分支筛选：全部分支" }));
    const branchOptions = screen.getByRole("listbox", { name: "分支筛选选项" });
    expect(branchOptions.parentElement?.dataset.alignment).toBe("start");
    expect(branchOptions.parentElement?.style.width).toContain("620px");
    expect(branchOptions.parentElement?.style.width).toContain("100vw");
    fireEvent.click(screen.getByRole("option", { name: "main" }));
    fireEvent.click(screen.getByRole("button", { name: "用户筛选：全部用户" }));
    fireEvent.click(screen.getByRole("option", { name: "Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "日期筛选：全部日期" }));
    fireEvent.click(screen.getByRole("option", { name: "过去 7 天" }));

    expect(onApplyFilters).toHaveBeenLastCalledWith({
      search: "release note",
      revision: "refs/heads/main",
      author: "Alice",
      since: "7d",
    });
    expect(screen.queryByLabelText("路径")).toBeNull();
    expect(screen.queryByLabelText("仅第一父提交")).toBeNull();
    expect(screen.queryByLabelText("仅合并提交")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新提交日志" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.rerender(
      <GitHistoryView
        commits={[]}
        selectedObjectId={null}
        loading
        hasMore={false}
        onSelect={vi.fn()}
        onLoadMore={vi.fn()}
        onRefresh={onRefresh}
        filters={emptyFilters}
        revisionOptions={revisions}
        authorOptions={["Alice", "Bob"]}
        onApplyFilters={onApplyFilters}
      />,
    );
    const refreshing = screen.getByRole("button", { name: "刷新提交日志" });
    expect(refreshing.getAttribute("data-loading")).toBe("true");
    expect(refreshing.getAttribute("aria-busy")).toBe("true");
    expect(refreshing.querySelector(".lucide-refresh-cw")).not.toBeNull();
  });

  it("encodes the compact filters and resolves the relative date preset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
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
      since: "7d",
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
      since: "2026-07-10T00:00:00.000Z",
      cursor: "next page",
      limit: "50",
    });
    expect(firstUrl.searchParams.has("until")).toBe(false);
    expect(firstUrl.searchParams.has("path")).toBe(false);
    expect(firstUrl.searchParams.has("first_parent")).toBe(false);
    expect(firstUrl.searchParams.has("merges_only")).toBe(false);
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
