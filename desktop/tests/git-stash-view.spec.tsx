import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitStashView, formatStashDate } from "@/renderer/features/git/components/GitStashView";

afterEach(cleanup);

const entry = {
  selector: "stash@{0}",
  objectId: "a".repeat(40) as never,
  baseObjectId: "b".repeat(40) as never,
  authorName: "Keydex",
  createdAt: "2026-07-16T02:00:00+08:00",
  message: "On main: work in progress",
};

describe("GitStashView", () => {
  it("renders a stable selector+oid entry and its files", () => {
    const onSelect = vi.fn();
    const onSelectFile = vi.fn();
    render(<GitStashView
      entries={[entry]}
      selected={entry}
      detail={{ repositoryId: "repo-1" as never, repositoryVersion: "v1" as never, entry, files: [{ oldPath: "src/a.ts", newPath: "src/a.ts", status: "modified", binary: false, oldMode: null, newMode: null, additions: 2, deletions: 1, hunks: [], rawPatch: "diff --git", truncated: false }] }}
      selectedFileIndex={0}
      loading={false}
      hasMore
      onSelect={onSelect}
      onSelectFile={onSelectFile}
      onLoadMore={vi.fn()}
      busy={false}
      onCreate={vi.fn()}
      onApply={vi.fn()}
      onPop={vi.fn()}
      onBranch={vi.fn()}
      onDrop={vi.fn()}
      onClear={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("option", { name: /stash@\{0\}/ }));
    expect(onSelect).toHaveBeenCalledWith(entry);
    expect(screen.getByText("src/a.ts")).not.toBeNull();
    expect(screen.getByText("+2 −1")).not.toBeNull();
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(onSelectFile).toHaveBeenCalledWith(0);
    expect(screen.getByRole("button", { name: "Load more" })).not.toBeNull();
  });

  it("has a visible empty state and preserves invalid date text", () => {
    const onCreate = vi.fn();
    render(<GitStashView entries={[]} selected={null} detail={null} selectedFileIndex={0} loading={false} hasMore={false} onSelect={vi.fn()} onSelectFile={vi.fn()} onLoadMore={vi.fn()} busy={false} onCreate={onCreate} onApply={vi.fn()} onPop={vi.fn()} onBranch={vi.fn()} onDrop={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByText("No stashes")).not.toBeNull();
    expect(formatStashDate("unknown-date")).toBe("unknown-date");
    fireEvent.change(screen.getByLabelText("Stash message"), { target: { value: "save work" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include untracked" }));
    fireEvent.click(screen.getByRole("button", { name: "Create stash" }));
    expect(onCreate).toHaveBeenCalledWith({ message: "save work", staged: false, includeUntracked: true });
  });
});
