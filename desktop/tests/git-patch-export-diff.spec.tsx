import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitPatchExportDiff } from "@/renderer/features/git/components/GitPatchExportDiff";
import type { GitPatchExport } from "@/runtime/git";

let lastProps: Record<string, unknown> | null = null;

vi.mock("@/renderer/components/diff/wrappers/PreviewDiffView", () => ({
  PreviewDiffView: (props: Record<string, unknown>) => {
    lastProps = props;
    const document = props.document as {
      source: string;
      files: Array<{ displayPath: string }>;
      diagnostics: Array<{ code: string }>;
    };
    return (
      <section aria-label="差异文件预览" data-source={document.source}>
        {document.files.map((file) => <span key={file.displayPath}>{file.displayPath}</span>)}
        {document.diagnostics.map((diagnostic) => <span key={diagnostic.code}>{diagnostic.code}</span>)}
      </section>
    );
  },
}));

afterEach(() => {
  cleanup();
  lastProps = null;
  vi.unstubAllGlobals();
});

describe("GitPatchExportDiff", () => {
  it.each(["working_tree", "index", "commit", "range"] as const)("renders a multi-file %s export", (mode) => {
    render(<GitPatchExportDiff exported={exported(mode, multiPatch)} />);
    const preview = screen.getByLabelText("差异文件预览");
    expect(preview.getAttribute("data-source")).toBe("git");
    expect(preview.textContent).toContain("src/a.ts");
    expect(preview.textContent).toContain("src/b.ts");
    expect(lastProps).toMatchObject({ scrollScopeKey: `git-patch-export:repo-1:keydex-${mode}.patch` });
  });

  it("keeps malformed and empty exports inside the explicit diagnostic surface", () => {
    const { rerender } = render(<GitPatchExportDiff exported={exported("working_tree", "malformed")} />);
    expect(screen.getByLabelText("差异文件预览").textContent).toContain("malformed");
    rerender(<GitPatchExportDiff exported={exported("working_tree", "")} />);
    expect(screen.getByLabelText("差异文件预览").textContent).toContain("empty");
  });

  it("copies the exact exported patch rather than rendered text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<GitPatchExportDiff exported={exported("range", multiPatch)} />);
    const copyPatch = (lastProps as { actions: { copyPatch: (patch: string) => Promise<void> } }).actions.copyPatch;
    await copyPatch(multiPatch);
    expect(writeText).toHaveBeenCalledWith(multiPatch);
  });
});

const multiPatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-oldA",
  "+newA",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-oldB",
  "+newB",
  "",
].join("\n");

function exported(mode: GitPatchExport["mode"], patch: string): GitPatchExport {
  return {
    repositoryId: "repo-1" as GitPatchExport["repositoryId"],
    repositoryVersion: `v-${mode}` as GitPatchExport["repositoryVersion"],
    mode,
    left: mode === "commit" || mode === "range" ? "main" : null,
    right: mode === "range" ? "topic" : null,
    paths: [],
    filename: `keydex-${mode}.patch`,
    patch,
  };
}
