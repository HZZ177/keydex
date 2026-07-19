import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PreviewDiffView } from "@/renderer/components/diff/wrappers/PreviewDiffView";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const onePatch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+A\n";
const single = normalizeUnifiedPatch(onePatch, { source: "preview", sourceVersion: "one" });
const multi = normalizeUnifiedPatch(`${onePatch}\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-b\n+B\n`, {
  source: "preview",
  sourceVersion: "two",
});

let lastProps: Record<string, unknown> | null = null;
vi.mock("@/renderer/components/diff/KeydexDiffView", () => ({
  KeydexDiffView: (props: Record<string, unknown>) => {
    lastProps = props;
    return <div data-testid="preview-engine" data-files={(props.document as { files: unknown[] }).files.length} />;
  },
}));

describe("PreviewDiffView", () => {
  it.each([[single, "1"], [multi, "2"]] as const)("routes single and multi documents through one preview contract", (document, count) => {
    const { container } = render(<PreviewDiffView document={document} scrollScopeKey={`tab-${count}`} />);
    expect(screen.getByTestId("preview-engine").getAttribute("data-files")).toBe(count);
    expect(container.querySelector('[data-keydex-diff-wrapper="preview"]')?.getAttribute("data-file-count")).toBe(count);
    const props = lastProps as { profile: string; scrollScopeKey: string; state: { layout: string; wrap: boolean } };
    expect(props).toMatchObject({ profile: "preview" });
    expect(props.state).toMatchObject({ layout: "stacked", wrap: true });
    expect(props.scrollScopeKey).toContain(`preview:tab-${count}:`);
  });

  it("restores the requested file and reports file navigation", () => {
    const onActiveFileChange = vi.fn();
    const { rerender } = render(
      <PreviewDiffView
        document={multi}
        scrollScopeKey="tab"
        activeFileId={multi.files[1]!.id}
        onActiveFileChange={onActiveFileChange}
      />,
    );
    let props = lastProps as { state: { activeFileId: string }; onActiveFileChange: (id: string) => void };
    expect(props.state.activeFileId).toBe(multi.files[1]!.id);
    act(() => props.onActiveFileChange(multi.files[0]!.id));
    expect(onActiveFileChange).toHaveBeenCalledWith(multi.files[0]!.id);
    rerender(
      <PreviewDiffView
        document={multi}
        scrollScopeKey="tab"
        activeFileId={multi.files[0]!.id}
        onActiveFileChange={onActiveFileChange}
      />,
    );
    props = lastProps as typeof props;
    expect(props.state.activeFileId).toBe(multi.files[0]!.id);
  });

  it("reports layout and wrap preferences without persisting business state", () => {
    const onDisplayPreferenceChange = vi.fn();
    render(<PreviewDiffView document={single} scrollScopeKey="tab" onDisplayPreferenceChange={onDisplayPreferenceChange} />);
    let props = lastProps as {
      onLayoutChange: (layout: "split") => void;
      onWrapChange: (wrap: boolean) => void;
      onSyncScrollChange: (syncScroll: boolean) => void;
      state: { layout: string; wrap: boolean; syncScroll: boolean };
    };
    act(() => props.onLayoutChange("split"));
    expect(onDisplayPreferenceChange).toHaveBeenCalledWith({ layout: "split", wrap: true, syncScroll: true });
    props = lastProps as typeof props;
    act(() => props.onWrapChange(false));
    expect(onDisplayPreferenceChange).toHaveBeenLastCalledWith({ layout: "split", wrap: false, syncScroll: true });
    props = lastProps as typeof props;
    act(() => props.onSyncScrollChange(false));
    expect(onDisplayPreferenceChange).toHaveBeenLastCalledWith({
      layout: "split",
      wrap: false,
      syncScroll: false,
    });
  });

  it("exposes copy/open capabilities supplied by the preview host", () => {
    const copyPatch = vi.fn();
    const openFile = vi.fn();
    render(<PreviewDiffView document={single} scrollScopeKey="tab" actions={{ copyPatch, openFile }} />);
    expect((lastProps as { actions: object }).actions).toEqual({ copyPatch, openFile });
  });
});
