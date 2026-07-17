import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileReviewCard } from "@/renderer/components/review/FileReviewDiff";
import type { FileReviewChange } from "@/renderer/utils/fileReview";

let compactProps: Record<string, unknown> | null = null;
vi.mock("@/renderer/components/diff/wrappers/CompactDiffView", () => ({
  CompactDiffView: (props: Record<string, unknown>) => {
    compactProps = props;
    return <div data-testid="compact-pierre" />;
  },
}));

describe("FileReviewCard Pierre migration", () => {
  it.each([
    ["update", "modified"],
    ["add", "added"],
    ["delete", "deleted"],
    ["move", "renamed"],
  ] as const)("normalizes %s into the compact %s document", (operation, status) => {
    render(<FileReviewCard file={change(operation)} />);
    const props = compactProps as { document: { files: Array<{ status: string }> }; defaultExpanded: boolean };
    expect(screen.getByTestId("file-review-card").getAttribute("data-diff-engine")).toBe("keydex-pierre");
    expect(props.document.files[0]?.status).toBe(status);
    expect(props.defaultExpanded).toBe(true);
  });

  it("uses content-only added files and preserves the exact copy source", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<FileReviewCard file={{ ...change("add"), diff: "", content: "first\nsecond\n" }} />);
    const props = compactProps as { document: { files: Array<{ newContent?: string }> }; actions: { copyPatch: () => Promise<void> } };
    expect(props.document.files[0]?.newContent).toBe("first\nsecond\n");
    await props.actions.copyPatch();
    expect(writeText).toHaveBeenCalledWith("first\nsecond\n");
  });

  it("renders metadata-only changes as a quiet compact document instead of legacy rows", () => {
    render(<FileReviewCard file={{ ...change("update"), diff: "" }} titlePrefix="工具" />);
    const props = compactProps as { document: { diagnostics: Array<{ code: string }> } };
    expect(props.document.diagnostics.map((item) => item.code)).toContain("metadata_only_change");
    expect(screen.getByText("工具")).toBeTruthy();
    expect(screen.queryByTestId("file-review-diff")).toBeNull();
  });
});

function change(operation: FileReviewChange["operation"]): FileReviewChange {
  const oldPath = operation === "add" ? null : "src/old.ts";
  const newPath = operation === "delete" ? null : operation === "move" ? "src/new.ts" : "src/old.ts";
  return {
    path: newPath ?? oldPath ?? "src/file.ts",
    oldPath,
    newPath,
    operation,
    additions: 1,
    deletions: 1,
    diff: `diff --git a/${oldPath ?? "src/old.ts"} b/${newPath ?? "src/old.ts"}\n--- ${oldPath ? `a/${oldPath}` : "/dev/null"}\n+++ ${newPath ? `b/${newPath}` : "/dev/null"}\n@@ -1 +1 @@\n-old\n+new\n`,
    source: "final",
  };
}
