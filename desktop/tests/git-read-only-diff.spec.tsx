import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitReadOnlyDiff } from "@/renderer/features/git/components/GitReadOnlyDiff";
import type { GitFileDiff } from "@/runtime/gitTypes";

let lastProps: Record<string, unknown> | null = null;

vi.mock("@/renderer/components/diff/wrappers/GitDiffView", () => ({
  GitDiffView: (props: Record<string, unknown>) => {
    lastProps = props;
    const document = props.document as { files: Array<{ displayPath: string; binary: boolean; truncated: boolean }> };
    return (
      <section aria-label="只读 Git 差异">
        {document.files.map((file) => (
          <span key={file.displayPath}>{file.displayPath}:{String(file.binary)}:{String(file.truncated)}</span>
        ))}
      </section>
    );
  },
}));

afterEach(() => {
  cleanup();
  lastProps = null;
  vi.unstubAllGlobals();
});

describe("GitReadOnlyDiff", () => {
  it.each(["stash", "commit", "compare"] as const)("creates a read-only %s document", (sourceKind) => {
    render(
      <GitReadOnlyDiff
        repositoryId="repo-1"
        repositoryVersion="v1"
        sourceKind={sourceKind}
        files={[file()]}
        scrollScopeKey={`scope:${sourceKind}`}
      />,
    );

    expect(screen.getByLabelText("只读 Git 差异").textContent).toContain("src/a.ts:false:false");
    expect(lastProps).toMatchObject({ mode: "read_only", scrollScopeKey: `scope:${sourceKind}` });
    expect(lastProps?.toolbarLeading).toBeTruthy();
    expect(lastProps).not.toHaveProperty("applyPatches");
  });

  it("preserves stash binary and truncated safety without write capabilities", () => {
    render(
      <GitReadOnlyDiff
        repositoryId="repo-1"
        repositoryVersion="v2"
        sourceKind="stash"
        files={[file({ binary: true, truncated: true, rawPatch: "", hunks: [] })]}
        scrollScopeKey="stash:binary"
      />,
    );

    expect(screen.getByLabelText("只读 Git 差异").textContent).toContain("src/a.ts:true:true");
    const document = (lastProps as { document: { files: Array<{ selectableForPatch: boolean }> } }).document;
    expect(document.files[0]?.selectableForPatch).toBe(false);
  });

  it("exposes exact patch copying but no Git mutation action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <GitReadOnlyDiff
        repositoryId="repo-1"
        repositoryVersion="v3"
        sourceKind="stash"
        files={[file()]}
        scrollScopeKey="stash:copy"
      />,
    );
    const props = lastProps as {
      copyPatch: (patch: string) => Promise<void>;
      copySelection: (text: string) => Promise<void>;
      copyPath: (path: string) => Promise<void>;
      applyPatches?: unknown;
    };
    await props.copyPatch("normalized renderer patch\n");
    await props.copySelection("selected code");
    await props.copyPath("src/a.ts");
    expect(writeText.mock.calls).toEqual([
      [file().rawPatch],
      ["selected code"],
      ["src/a.ts"],
    ]);
    expect(props.applyPatches).toBeUndefined();
  });

  it("does not expose stash open until the host proves the target exists", () => {
    const onOpenFile = vi.fn();
    const { rerender } = render(
      <GitReadOnlyDiff
        repositoryId="repo-1"
        repositoryVersion="v5"
        sourceKind="stash"
        files={[file()]}
        scrollScopeKey="stash:open"
        onOpenFile={onOpenFile}
      />,
    );
    expect(lastProps).not.toHaveProperty("openFile");
    rerender(
      <GitReadOnlyDiff
        repositoryId="repo-1"
        repositoryVersion="v5"
        sourceKind="stash"
        files={[file()]}
        scrollScopeKey="stash:open"
        onOpenFile={onOpenFile}
        worktreeAvailablePaths={["src/a.ts"]}
      />,
    );
    expect(lastProps).toMatchObject({ openFile: onOpenFile });
  });

  it("renders the caller-provided empty state without mounting the viewer", () => {
    render(
      <GitReadOnlyDiff
        repositoryId="repo-1"
        repositoryVersion="v4"
        sourceKind="stash"
        files={[]}
        emptyMessage="选择储藏文件查看差异"
        scrollScopeKey="stash:empty"
      />,
    );
    expect(screen.getByText("选择储藏文件查看差异")).not.toBeNull();
    expect(lastProps).toBeNull();
  });
});

function file(overrides: Partial<GitFileDiff> = {}): GitFileDiff {
  return {
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    status: "modified",
    binary: false,
    oldMode: "100644",
    newMode: "100644",
    additions: 1,
    deletions: 1,
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-old", "+new"],
    }],
    rawPatch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false,
    ...overrides,
  };
}
