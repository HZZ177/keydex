import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHistoryView, historyVirtualWindow, mergeHistoryPages } from "@/renderer/features/git/components/GitHistoryView";

afterEach(cleanup);

describe("GitHistoryView", () => {
  it("virtualizes 10k commits and keeps the rendered DOM bounded", () => {
    const commits = Array.from({ length: 10_000 }, (_, index) => commit(index));
    const started = performance.now();
    render(<GitHistoryView commits={commits} selectedObjectId={commits[500].objectId} loading={false} hasMore onSelect={vi.fn()} onLoadMore={vi.fn()} onRefresh={vi.fn()} viewportHeight={360} />);
    expect(screen.getByRole("listbox", { name: "提交日志" }).getAttribute("data-virtualized")).toBe("true");
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(30);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(historyVirtualWindow(10_000, 36_000, 360)).toMatchObject({ start: 892, renderedCount: 25, rowHeight: 40 });
  });

  it("deduplicates prepend/append pages and preserves selection by oid", () => {
    const first = [commit(1), commit(2), commit(3)];
    expect(mergeHistoryPages(first, [commit(0), commit(1)], "prepend").map((item) => item.subject)).toEqual(["commit 0", "commit 1", "commit 2", "commit 3"]);
    expect(mergeHistoryPages(first, [commit(3), commit(4)], "append").map((item) => item.subject)).toEqual(["commit 1", "commit 2", "commit 3", "commit 4"]);

    const onSelect = vi.fn();
    render(<GitHistoryView commits={first} selectedObjectId={first[1].objectId} loading={false} hasMore={false} onSelect={onSelect} onLoadMore={vi.fn()} onRefresh={vi.fn()} />);
    const selected = screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("commit 2");
    fireEvent.click(screen.getByRole("option", { name: /commit 3/ }));
    expect(onSelect).toHaveBeenCalledWith(first[2]);
  });

  it("renders lane and merge edges from the shared graph model", () => {
    const root = commit(1);
    const side = { ...commit(2), parentIds: [root.objectId] };
    const merge = { ...commit(3), parentIds: [side.objectId, root.objectId] };
    render(<GitHistoryView commits={[merge, side, root]} selectedObjectId={merge.objectId} loading={false} hasMore={false} onSelect={vi.fn()} onLoadMore={vi.fn()} onRefresh={vi.fn()} />);

    const graph = screen.getByRole("img", { name: "包含 2 个父提交的合并图" });
    expect(graph.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
    expect(graph.getAttribute("data-commit-column")).toBe("0");
  });
});

function commit(index: number) {
  return {
    objectId: index.toString(16).padStart(40, "0") as never,
    parentIds: [],
    authorName: "Keydex",
    authorEmail: "keydex@example.invalid",
    authoredAt: "2026-07-16T00:00:00Z",
    committerName: "Keydex",
    committerEmail: "keydex@example.invalid",
    committedAt: "2026-07-16T00:00:00Z",
    subject: `commit ${index}`,
    body: "",
    decorations: [],
    signature: "unsigned" as const,
  };
}
