import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRefsTree } from "@/renderer/features/git/components/GitRefsTree";
import { adjacentGitToolView } from "@/renderer/features/git/components/GitToolWindow";
import { AppContextMenuProvider } from "@/renderer/providers/AppContextMenuProvider";
import type { GitRef } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git keyboard and accessibility contracts", () => {
  it("provides wrapping arrow, Home and End navigation for the tool-window tabs", () => {
    expect(adjacentGitToolView("changes", "ArrowRight")).toBe("history");
    expect(adjacentGitToolView("changes", "ArrowLeft")).toBe("branches");
    expect(adjacentGitToolView("history", "Home")).toBe("changes");
    expect(adjacentGitToolView("history", "End")).toBe("branches");
    expect(adjacentGitToolView("blame", "ArrowLeft")).toBeNull();
    expect(adjacentGitToolView("history", "Enter")).toBeNull();
  });

  it("uses roving tree focus and supports collapse, expand and ref action menus", async () => {
    render(
      <AppContextMenuProvider>
        <GitRefsTree
          refs={refs()}
          selectedRef="refs/heads/main"
          onSelect={vi.fn()}
          onAction={vi.fn()}
        />
      </AppContextMenuProvider>,
    );
    const tree = screen.getByRole("tree", { name: "仓库引用" });
    const head = screen.getByRole("treeitem", { name: "当前分支 main" });
    expect(head.getAttribute("tabindex")).toBe("0");
    act(() => head.focus());
    fireEvent.keyDown(head, { key: "ArrowDown" });
    const localGroup = screen.getByRole("treeitem", { name: /本地|鏈湴/ });
    expect(document.activeElement).toBe(localGroup);
    expect(head.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(localGroup, { key: "ArrowLeft" });
    expect(localGroup.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(localGroup, { key: "ArrowRight" });
    expect(localGroup.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(localGroup, { key: "End" });
    expect(document.activeElement?.getAttribute("role")).toBe("treeitem");

    const topic = screen.getByRole("treeitem", { name: "topic" });
    expect(screen.queryByRole("button", { name: "topic 操作" })).toBeNull();
    act(() => topic.focus());
    fireEvent.keyDown(topic, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "页面右键菜单" });
    expect(menu.dataset.contextKind).toBe("custom");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "页面右键菜单" })).toBeNull();
    expect(document.activeElement).toBe(topic);
    expect(tree.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
  });
});

function refs(): GitRef[] {
  const base = {
    objectId: "a".repeat(40) as never,
    peeledObjectId: null,
    upstream: null,
    ahead: null,
    behind: null,
    annotated: false,
    annotation: null,
    createdAt: null,
  };
  return [
    { ...base, fullName: "refs/heads/main", shortName: "main", kind: "local", current: true },
    { ...base, fullName: "refs/heads/topic", shortName: "topic", kind: "local", current: false },
    { ...base, fullName: "refs/remotes/origin/main", shortName: "origin/main", kind: "remote", current: false },
    { ...base, fullName: "refs/tags/v1", shortName: "v1", kind: "tag", current: false },
  ];
}
