import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitRefsTree } from "@/renderer/features/git/components/GitRefsTree";
import { adjacentGitToolView } from "@/renderer/features/git/components/GitToolWindow";
import type { GitRef } from "@/runtime/gitTypes";

afterEach(cleanup);

describe("Git keyboard and accessibility contracts", () => {
  it("provides wrapping arrow, Home and End navigation for the tool-window tabs", () => {
    expect(adjacentGitToolView("changes", "ArrowRight")).toBe("history");
    expect(adjacentGitToolView("blame", "ArrowLeft")).toBe("operations");
    expect(adjacentGitToolView("history", "Home")).toBe("blame");
    expect(adjacentGitToolView("history", "End")).toBe("operations");
    expect(adjacentGitToolView("history", "Enter")).toBeNull();
  });

  it("uses roving tree focus and supports collapse, expand and ref action menus", async () => {
    render(
      <GitRefsTree
        refs={refs()}
        selectedRef="refs/heads/main"
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree", { name: "Repository refs" });
    const head = screen.getByRole("treeitem", { name: "HEAD main" });
    expect(head.getAttribute("tabindex")).toBe("0");
    head.focus();
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

    const actions = screen.getByRole("button", { name: "topic actions" });
    fireEvent.click(actions);
    expect(actions.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "topic actions" });
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "topic actions" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(actions));
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
