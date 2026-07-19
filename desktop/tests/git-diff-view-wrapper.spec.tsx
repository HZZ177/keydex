import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  GitDiffView,
  GitDiffViewContractError,
  assertGitDiffViewContract,
} from "@/renderer/components/diff/wrappers/GitDiffView";
import { gitDocumentFromFiles } from "@/renderer/components/diff/adapters/gitDocument";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import type { GitFileDiff } from "@/runtime/gitTypes";

const rawPatch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const gitFile: GitFileDiff = {
  oldPath: "src/a.ts",
  newPath: "src/a.ts",
  status: "modified",
  binary: false,
  oldMode: "100644",
  newMode: "100644",
  additions: 1,
  deletions: 1,
  hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
  rawPatch,
  truncated: false,
};
const document = gitDocumentFromFiles({
  repositoryId: "repo",
  repositoryVersion: "v1",
  sourceKind: "working_tree",
  files: [gitFile],
});
const untrackedDocument = gitDocumentFromFiles({
  repositoryId: "repo",
  repositoryVersion: "v2",
  sourceKind: "working_tree",
  files: [{
    ...gitFile,
    oldPath: null,
    newPath: "src/new.ts",
    status: "untracked",
    oldMode: null,
    additions: 1,
    deletions: 0,
    rawPatch: "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+new\n",
  }],
});

let lastProps: Record<string, unknown> | null = null;
vi.mock("@/renderer/components/diff/KeydexDiffView", () => ({
  KeydexDiffView: (props: Record<string, unknown>) => {
    lastProps = props;
    return <div data-testid="git-engine" data-profile={String(props.profile)} />;
  },
}));

describe("GitDiffView wrapper", () => {
  it.each(["stage", "unstage"] as const)("maps the %s action and busy state to host capabilities", (mode) => {
    const applyPatches = vi.fn();
    const applyHunk = vi.fn();
    const applySelection = vi.fn();
    render(<GitDiffView document={document} mode={mode} busy applyPatches={applyPatches} applyHunk={applyHunk} applySelection={applySelection} />);
    const props = lastProps as { actions: { git: { mode: string; busy: boolean; applyPatches: unknown; applyHunk: unknown; applySelection: unknown } }; state: { layout: string; wrap: boolean } };
    expect(screen.getByTestId("git-engine").getAttribute("data-profile")).toBe("git");
    expect(props.actions.git).toMatchObject({ mode, busy: true, applyPatches, applyHunk, applySelection });
    expect(props.state).toMatchObject({ layout: "split", wrap: false });
    expect(props).toMatchObject({
      embedded: true,
      showFileNavigator: false,
      hiddenToolbarActions: [
        "previous_file",
        "next_file",
        "copy_selection",
        "copy_patch",
        "open_file",
      ],
    });
  });

  it("keeps stash/commit style read-only views free of write actions", () => {
    const toolbarLeading = <span>详情</span>;
    const { container } = render(
      <GitDiffView document={document} mode="read_only" copyPatch={vi.fn()} toolbarLeading={toolbarLeading} />,
    );
    const props = lastProps as { actions: Record<string, unknown>; toolbarLeading: unknown };
    expect(props.actions.git).toBeUndefined();
    expect(props.actions.copyPatch).toBeTypeOf("function");
    expect(props.toolbarLeading).toBe(toolbarLeading);
    expect(container.querySelector('[data-read-only="true"]')).toBeTruthy();
  });

  it("uses a unified layout by default when the whole file is newly added", () => {
    render(<GitDiffView document={untrackedDocument} mode="stage" applyPatches={vi.fn()} />);
    const props = lastProps as { state: { layout: string; wrap: boolean } };
    expect(props.state).toMatchObject({ layout: "stacked", wrap: false });
  });

  it("resets controlled selection through the shared controller", () => {
    const onSelectionChange = vi.fn();
    render(<GitDiffView document={document} mode="stage" applyPatches={vi.fn()} onSelectionChange={onSelectionChange} />);
    const props = lastProps as { onSelectionChange: (selection: null) => void; state: { selection: unknown } };
    act(() => props.onSelectionChange(null));
    expect(onSelectionChange).toHaveBeenCalledWith(null);
    expect((lastProps as typeof props).state.selection).toBeNull();
  });

  it("rejects non-Git and malformed write contracts", () => {
    const preview = normalizeUnifiedPatch(rawPatch, { source: "preview", sourceVersion: "v1" });
    expect(() => assertGitDiffViewContract(preview, "stage", vi.fn())).toThrow(GitDiffViewContractError);
    expect(() => assertGitDiffViewContract(document, "stage")).toThrow(/必须由宿主提供/);
    expect(() => assertGitDiffViewContract(document, "read_only", vi.fn())).toThrow(/只读/);
  });
});
