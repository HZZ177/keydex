import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ReviewDiffView,
  isReviewToolbarRowClick,
  resolveReviewFocusedFile,
} from "@/renderer/components/diff/wrappers/ReviewDiffView";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const document = normalizeUnifiedPatch(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+A\n\ndiff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-old\n+new\n",
  { source: "agent", sourceVersion: "review" },
);

let lastProps: Record<string, unknown> | null = null;
vi.mock("@/renderer/components/diff/KeydexDiffView", () => ({
  KeydexDiffView: (props: Record<string, unknown>) => {
    lastProps = props;
    return (
      <div data-testid="review-engine" data-profile={String(props.profile)}>
        <div data-keydex-diff-toolbar="true" data-profile={String(props.profile)}>
          <span data-testid="review-toolbar-empty-area" />
          <button type="button" data-testid="review-toolbar-action">操作</button>
        </div>
      </div>
    );
  },
}));

describe("ReviewDiffView", () => {
  it("resolves display, old and new focused paths", () => {
    expect(resolveReviewFocusedFile(document, "src/a.ts")?.displayPath).toBe("src/a.ts");
    expect(resolveReviewFocusedFile(document, "src/old.ts")?.displayPath).toBe("src/new.ts");
    expect(resolveReviewFocusedFile(document, "src\\new.ts")?.displayPath).toBe("src/new.ts");
  });

  it("uses the review stacked/wrapped contract and independent scope", () => {
    render(<ReviewDiffView document={document} focusedPath="src/new.ts" scrollScopeKey="agent-side" />);
    expect(screen.getByTestId("review-engine").getAttribute("data-profile")).toBe("review");
    const props = lastProps as {
      embedded: boolean;
      state: {
        layout: string;
        wrap: boolean;
        activeFileId: string;
        expandedFileIds: readonly string[];
      };
      scrollScopeKey: string;
    };
    expect(props.embedded).toBe(true);
    expect(props.state.layout).toBe("stacked");
    expect(props.state.wrap).toBe(true);
    expect(props.state.activeFileId).toBe(document.files[1]!.id);
    expect(props.state.expandedFileIds).toEqual(document.files.map((file) => file.id));
    expect(props.scrollScopeKey).toContain("agent-side:");
  });

  it("merges the compact file identity into the toolbar and removes duplicate review chrome", () => {
    render(<ReviewDiffView document={document} focusedPath="src/new.ts" />);
    const props = lastProps as {
      showFileHeader: boolean;
      hiddenToolbarActions: readonly string[];
      toolbarLeading: ReactNode;
      singleFileExpanded: boolean;
    };
    expect(props.showFileHeader).toBe(false);
    expect(props.hiddenToolbarActions).toContain("open_file");
    expect(props.singleFileExpanded).toBe(true);

    render(<>{props.toolbarLeading}</>);
    expect(screen.getByTitle("src/new.ts").textContent).toBe("new.ts+1-1");
    expect(screen.getByLabelText(/新增 \d+ 行，删除 \d+ 行/u)).not.toBeNull();
    act(() => screen.getByRole("button", { name: "收起 src/new.ts" }).click());
    expect((lastProps as { singleFileExpanded: boolean }).singleFileExpanded).toBe(false);
  });

  it("uses the whole review header row as the toggle target without swallowing toolbar actions", () => {
    render(<ReviewDiffView document={document} focusedPath="src/new.ts" />);
    expect((lastProps as { singleFileExpanded: boolean }).singleFileExpanded).toBe(true);

    fireEvent.click(screen.getByTestId("review-toolbar-empty-area"));
    expect((lastProps as { singleFileExpanded: boolean }).singleFileExpanded).toBe(false);

    fireEvent.click(screen.getByTestId("review-toolbar-action"));
    expect((lastProps as { singleFileExpanded: boolean }).singleFileExpanded).toBe(false);
  });

  it("recognizes only non-interactive space inside the review toolbar as a row click", () => {
    const toolbar = globalThis.document.createElement("div");
    toolbar.dataset.keydexDiffToolbar = "true";
    toolbar.dataset.profile = "review";
    const space = globalThis.document.createElement("span");
    const action = globalThis.document.createElement("button");
    toolbar.append(space, action);
    expect(isReviewToolbarRowClick(space)).toBe(true);
    expect(isReviewToolbarRowClick(action)).toBe(false);
    expect(isReviewToolbarRowClick(globalThis.document.body)).toBe(false);
  });

  it("keeps focusedPath and host focus callback synchronized", () => {
    const onFocusPath = vi.fn();
    render(<ReviewDiffView document={document} onFocusPath={onFocusPath} />);
    const props = lastProps as { onActiveFileChange: (fileId: string) => void };
    act(() => props.onActiveFileChange(document.files[1]!.id));
    expect(onFocusPath).toHaveBeenCalledWith("src/new.ts");
    const next = lastProps as { state: { activeFileId: string; expandedFileIds: readonly string[] } };
    expect(next.state.activeFileId).toBe(document.files[1]!.id);
    expect(next.state.expandedFileIds).toContain(document.files[1]!.id);
  });

  it("passes multiple expanded files and wrap changes through one controller", () => {
    render(<ReviewDiffView document={document} />);
    let props = lastProps as {
      onExpandedFilesChange: (ids: readonly string[]) => void;
      onWrapChange: (wrap: boolean) => void;
      state: { expandedFileIds: readonly string[]; wrap: boolean };
    };
    act(() => props.onExpandedFilesChange(document.files.map((file) => file.id)));
    props = lastProps as typeof props;
    expect(props.state.expandedFileIds).toHaveLength(2);
    act(() => props.onWrapChange(false));
    props = lastProps as typeof props;
    expect(props.state.wrap).toBe(false);
  });

  it("supports a host-controlled wrap state across review containers", () => {
    const onWrapChange = vi.fn();
    const { rerender } = render(
      <ReviewDiffView document={document} wrap={false} onWrapChange={onWrapChange} />,
    );
    let props = lastProps as { state: { wrap: boolean }; onWrapChange: (wrap: boolean) => void };
    expect(props.state.wrap).toBe(false);
    act(() => props.onWrapChange(true));
    expect(onWrapChange).toHaveBeenCalledWith(true);

    rerender(<ReviewDiffView document={document} wrap onWrapChange={onWrapChange} />);
    props = lastProps as typeof props;
    expect(props.state.wrap).toBe(true);
  });
});
