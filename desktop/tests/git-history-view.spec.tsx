import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitHistoryView,
  gitGraphColor,
  historyGraphWidth,
  historyVirtualWindow,
  mergeHistoryPages,
  presentGitHistoryDecorations,
} from "@/renderer/features/git/components/GitHistoryView";

afterEach(cleanup);

describe("GitHistoryView", () => {
  it("virtualizes 10k commits and keeps the rendered DOM bounded", () => {
    const commits = Array.from({ length: 10_000 }, (_, index) => commit(index));
    const started = performance.now();
    render(<GitHistoryView commits={commits} selectedObjectId={commits[500].objectId} loading={false} hasMore onSelect={vi.fn()} onLoadMore={vi.fn()} onRefresh={vi.fn()} viewportHeight={360} />);
    expect(screen.getByRole("listbox", { name: "提交日志" }).getAttribute("data-virtualized")).toBe("true");
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(30);
    expect(screen.getByRole("button", { name: "加载更早的提交（已加载 10000 个）" })).not.toBeNull();
    expect(screen.queryByText("已加载 10000 个提交", { exact: true })).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(historyVirtualWindow(10_000, 36_000, 360)).toMatchObject({ start: 892, renderedCount: 25, rowHeight: 40 });
  });

  it("deduplicates prepend/append pages and preserves selection by oid", () => {
    const first = [commit(1), commit(2), commit(3)];
    expect(mergeHistoryPages(first, [commit(0), commit(1)], "prepend").map((item) => item.subject)).toEqual(["commit 0", "commit 1", "commit 2", "commit 3"]);
    expect(mergeHistoryPages(first, [commit(3), commit(4)], "append").map((item) => item.subject)).toEqual(["commit 1", "commit 2", "commit 3", "commit 4"]);

    const onSelect = vi.fn();
    render(<GitHistoryView commits={first} selectedObjectId={first[1].objectId} loading={false} hasMore={false} onSelect={onSelect} onLoadMore={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "提交说明" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "引用" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "作者" })).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "提交时间" })).not.toBeNull();
    const selected = screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("commit 2");
    expect(selected?.textContent).not.toContain(first[1].objectId.slice(0, 8));
    fireEvent.click(screen.getByRole("option", { name: /commit 3/ }));
    expect(onSelect).toHaveBeenCalledWith(first[2]);
    expect(screen.getByRole("button", { name: "已加载全部 3 个提交" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders lane and merge edges from the shared graph model", () => {
    const root = commit(1);
    const side = { ...commit(2), parentIds: [root.objectId] };
    const merge = {
      ...commit(3),
      parentIds: [side.objectId, root.objectId],
      decorations: [
        "HEAD → refs/heads/release-0.7.1",
        "refs/remotes/origin/release-0.7.1",
        "tag: refs/tags/v0.7.1",
      ],
    };
    render(<GitHistoryView commits={[merge, side, root]} selectedObjectId={merge.objectId} loading={false} hasMore={false} onSelect={vi.fn()} onLoadMore={vi.fn()} onRefresh={vi.fn()} />);

    const graph = screen.getByRole("img", { name: "包含 2 个父提交的合并图" });
    expect(graph.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
    expect(graph.getAttribute("data-commit-column")).toBe("0");
    expect(graph.querySelector("circle")?.getAttribute("fill")).toBe("#63a663");
    expect(graph.querySelector("circle")?.getAttribute("r")).toBe("3.75");
    expect(graph.querySelector("circle")?.hasAttribute("stroke")).toBe(false);
    expect(graph.getAttribute("width")).toBe(String(historyGraphWidth(2)));
    expect(screen.getByRole("region", { name: "Git 日志" }).style.getPropertyValue("--git-history-graph-width")).toBe(`${historyGraphWidth(2)}px`);
    const mergeRow = screen.getByRole("option", { name: /commit 3/ });
    expect(mergeRow.getAttribute("data-has-refs")).toBe("true");
    const refSlot = mergeRow.querySelector<HTMLElement>("[data-git-history-ref-slot]");
    expect(refSlot?.textContent).toContain("origin & release-0.7.1");
    expect(refSlot?.textContent).toContain("v0.7.1");
    expect(mergeRow.querySelector("[data-git-history-subject]")?.nextElementSibling).toBe(refSlot);
    expect(screen.getByText("origin & release-0.7.1").parentElement?.getAttribute("data-kind")).toBe("current");
    expect(screen.getByText("v0.7.1").parentElement?.getAttribute("data-kind")).toBe("tag");
    expect(screen.queryByText("HEAD → refs/heads/release-0.7.1")).toBeNull();

    const undecoratedRow = screen.getByRole("option", { name: /commit 1/ });
    expect(undecoratedRow.getAttribute("data-has-refs")).toBe("false");
    expect(undecoratedRow.querySelector("[data-git-history-refs]")).toBeNull();
    expect(undecoratedRow.querySelector("[data-git-history-ref-slot]")?.textContent).toBe("");
  });

  it("normalizes, groups and orders full Git decorations for display", () => {
    expect(presentGitHistoryDecorations([
      "refs/tags/v1.2.0",
      "refs/remotes/origin/feature/demo",
      "refs/heads/feature/demo",
      "HEAD -> refs/heads/main",
      "refs/remotes/origin/main",
    ])).toEqual([
      {
        combined: true,
        fullNames: [
          "HEAD -> refs/heads/main",
          "refs/heads/main",
          "refs/remotes/origin/main",
        ],
        kind: "current",
        label: "origin & main",
      },
      {
        combined: true,
        fullNames: ["refs/heads/feature/demo", "refs/remotes/origin/feature/demo"],
        kind: "local",
        label: "origin & feature/demo",
      },
      {
        combined: false,
        fullNames: ["refs/tags/v1.2.0"],
        kind: "tag",
        label: "v1.2.0",
      },
    ]);
  });

  it("keeps a stable graph column width with a 30 pixel single-lane floor", () => {
    expect(historyGraphWidth(0)).toBe(30);
    expect(historyGraphWidth(1)).toBe(30);
    expect(historyGraphWidth(4)).toBe(54);
  });

  it("uses the JetBrains graph color system in a distinguishable lane order", () => {
    expect(Array.from({ length: 10 }, (_, index) => gitGraphColor(index))).toEqual([
      "#63a663",
      "#8b63a6",
      "#6374a6",
      "#6da663",
      "#6363a6",
      "#63a695",
      "#a68563",
      "#7663a6",
      "#8ba663",
      "#639ba6",
    ]);
    expect(gitGraphColor(10)).toBe("#63a663");
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
