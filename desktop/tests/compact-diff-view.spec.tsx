import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompactDiffView } from "@/renderer/components/diff/wrappers/CompactDiffView";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const single = normalizeUnifiedPatch(patch, { source: "agent", sourceVersion: "stream-1" });
const multi = normalizeUnifiedPatch(`${patch}\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n`, {
  source: "agent",
  sourceVersion: "final",
});

vi.mock("@/renderer/components/diff/KeydexDiffView", () => ({
  KeydexDiffView: (props: { profile: string; document: { files: unknown[] }; state: { layout: string; wrap: boolean }; actions: object; showToolbar?: boolean; showFileHeader?: boolean }) => (
    <div
      data-testid="compact-engine"
      data-profile={props.profile}
      data-files={props.document.files.length}
      data-layout={props.state.layout}
      data-wrap={String(props.state.wrap)}
      data-actions={Object.keys(props.actions).join(",")}
      data-toolbar={String(props.showToolbar)}
      data-file-header={String(props.showFileHeader)}
    />
  ),
}));

describe("CompactDiffView", () => {
  it("is a light collapsed inline surface by default", () => {
    const { container } = render(<CompactDiffView document={single} />);
    expect(container.querySelector('[data-keydex-diff-wrapper="compact"]')?.getAttribute("data-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /展开文件差异/ })).toBeTruthy();
    expect(container.querySelector('[data-height-limited="true"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-keydex-diff-file-header="true"]')).toHaveLength(1);
    expect(screen.queryByText("修改")).toBeNull();
  });

  it("toggles from the whole header without treating header actions as collapse controls", () => {
    const copyPatch = vi.fn();
    const { container } = render(<CompactDiffView document={single} defaultExpanded actions={{ copyPatch }} />);
    fireEvent.click(screen.getByRole("button", { name: "复制原始补丁" }));
    expect(copyPatch).toHaveBeenCalledWith(single.files[0]!.patch);
    expect(container.querySelector('[data-keydex-diff-wrapper="compact"]')?.getAttribute("data-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /收起文件差异/ }));
    expect(container.querySelector('[data-keydex-diff-wrapper="compact"]')?.getAttribute("data-expanded")).toBe("false");
  });

  it("labels the file action as reviewing in the sidebar", () => {
    const openFile = vi.fn();
    render(<CompactDiffView document={single} defaultExpanded actions={{ openFile }} />);
    const review = screen.getByRole("button", { name: "在侧边栏审阅" });
    expect(review.getAttribute("data-tooltip-label")).toBe("在侧边栏审阅");
    fireEvent.click(review);
    expect(openFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("uses compact stacked and wrapped defaults without Git capabilities", () => {
    render(<CompactDiffView document={single} defaultExpanded actions={{ copyPatch: vi.fn() }} />);
    const engine = screen.getByTestId("compact-engine");
    expect(engine.getAttribute("data-profile")).toBe("compact");
    expect(engine.getAttribute("data-layout")).toBe("stacked");
    expect(engine.getAttribute("data-wrap")).toBe("true");
    expect(engine.getAttribute("data-actions")).toBe("copyPatch");
    expect(engine.getAttribute("data-toolbar")).toBe("false");
    expect(engine.getAttribute("data-file-header")).toBe("false");
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/收起文件差异/),
      "复制原始补丁",
    ]);
  });

  it("supports controlled expand/collapse without owning the host state", () => {
    const onExpandedChange = vi.fn();
    const { rerender } = render(
      <CompactDiffView document={single} expanded={false} onExpandedChange={onExpandedChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /展开文件差异/ }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: /展开文件差异/ })).toBeTruthy();
    rerender(<CompactDiffView document={single} expanded onExpandedChange={onExpandedChange} />);
    expect(screen.getByRole("button", { name: /收起文件差异/ })).toBeTruthy();
  });

  it("updates streaming single-file content to the final multi-file document", () => {
    const { rerender } = render(<CompactDiffView document={single} defaultExpanded />);
    expect(screen.getByTestId("compact-engine").getAttribute("data-files")).toBe("1");
    rerender(<CompactDiffView document={multi} defaultExpanded />);
    expect(screen.getByTestId("compact-engine").getAttribute("data-files")).toBe("2");
    expect(screen.getByText("2 个文件")).toBeTruthy();
  });
});
