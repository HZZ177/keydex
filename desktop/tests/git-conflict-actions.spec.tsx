import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitConflictActions,
  conflictActionOptions,
} from "@/renderer/features/git/components/GitConflictActions";
import type { GitConflictFile } from "@/runtime/gitTypes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Git conflict file actions", () => {
  it("derives only actions supported by conflict kind and available stages", () => {
    expect(conflictActionOptions(file("both_modified")).map((item) => item.action)).toEqual([
      "accept_ours",
      "accept_theirs",
      "delete",
    ]);
    expect(conflictActionOptions({
      ...file("delete_modify"),
      stages: file("delete_modify").stages.filter((stage) => stage.stage !== 2),
      allowedActions: ["keep_modified", "accept_delete"],
    }).map((item) => item.action)).toEqual(["keep_modified", "accept_delete"]);
  });

  it("requires an explicit data-loss confirmation for accepting a side", () => {
    const onAction = vi.fn();
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<GitConflictActions file={file("binary")} dirty={false} unresolvedBlocks={0} busy={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept ours" }));
    expect(onAction).not.toHaveBeenCalled();
    confirmation.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Accept ours" }));
    expect(onAction).toHaveBeenCalledWith("accept_ours");
    expect(confirmation.mock.calls[1][0]).toContain("will be lost");
  });

  it("blocks mark-resolved for dirty or marker-bearing results and exposes reopen", () => {
    const onAction = vi.fn();
    const onReopen = vi.fn();
    const { rerender } = render(<GitConflictActions file={file("both_modified")} dirty unresolvedBlocks={0} busy={false} recentlyResolvedPath="old.txt" onAction={onAction} onReopen={onReopen} />);
    expect((screen.getByRole("button", { name: "Mark resolved and stage" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save the worktree result before staging it.")).toBeTruthy();
    rerender(<GitConflictActions file={file("both_modified")} dirty={false} unresolvedBlocks={2} busy={false} recentlyResolvedPath="old.txt" onAction={onAction} onReopen={onReopen} />);
    expect(screen.getByText("2 marker block(s) still unresolved.")).toBeTruthy();
    rerender(<GitConflictActions file={file("both_modified")} dirty={false} unresolvedBlocks={0} busy={false} recentlyResolvedPath="old.txt" onAction={onAction} onReopen={onReopen} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark resolved and stage" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen old.txt" }));
    expect(onAction).toHaveBeenCalledWith("mark_resolved");
    expect(onReopen).toHaveBeenCalledTimes(1);
  });
});

function file(kind: GitConflictFile["kind"]): GitConflictFile {
  return {
    path: "conflict.txt",
    relatedPaths: [],
    kind,
    stages: [stage(1, "base", "a"), stage(2, "ours", "b"), stage(3, "theirs", "c")],
    resultContent: "resolved\n",
    resultBinary: kind === "binary",
    resultEncoding: kind === "binary" ? "binary" : "utf-8",
    resultEol: kind === "binary" ? "none" : "lf",
    resultTooLarge: false,
    resultRevision: "revision-1",
    allowedActions: kind === "delete_modify"
      ? ["keep_modified", "accept_delete"]
      : ["accept_ours", "accept_theirs", "delete"],
    editable: kind !== "binary",
  };
}

function stage(stageNumber: 1 | 2 | 3, label: "base" | "ours" | "theirs", object: string) {
  return {
    stage: stageNumber,
    label,
    objectId: object.repeat(40) as never,
    mode: "100644",
    size: 5,
    content: `${label}\n`,
    binary: false,
    encoding: "utf-8" as const,
    eol: "lf" as const,
    tooLarge: false,
  };
}
