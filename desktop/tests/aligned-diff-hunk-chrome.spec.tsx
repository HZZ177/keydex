import * as pierre from "@pierre/diffs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildKeydexAlignedDiffModel } from "@/renderer/components/diff/aligned/alignmentSegments";
import { AlignedDiffVirtualRows } from "@/renderer/components/diff/aligned/AlignedDiffFileView";
import {
  AlignedDiffPaneItemView,
  alignedFileMetadata,
  buildAlignedDiffPaneItems,
} from "@/renderer/components/diff/aligned/AlignedDiffHunkChrome";
import { buildScrollMappingMetrics } from "@/renderer/components/diff/aligned/hunkScrollMapping";
import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";
import {
  preparePierreAlignedFile,
  type PierreAlignedPreparedFile,
  type PierreAlignedPublicApi,
} from "@/renderer/components/diff/engine/pierreAlignedAdapter";

import { alignedDiffFixture, materializeAlignedDiffFile } from "./fixtures/alignedDiffCatalog";

function api(): PierreAlignedPublicApi {
  return {
    parsePatchFiles: pierre.parsePatchFiles,
    parseDiffFromFile: pierre.parseDiffFromFile,
    getFiletypeFromFileName: pierre.getFiletypeFromFileName,
    getSharedHighlighter: vi.fn(async () => ({}) as never),
    renderDiffWithHighlighter: vi.fn((metadata) => ({
      code: {
        deletionLines: metadata.deletionLines.map((value: string) => ({ type: "text", value })),
        additionLines: metadata.additionLines.map((value: string) => ({ type: "text", value })),
      },
      themeStyles: "",
      baseThemeType: "light",
    })) as never,
  };
}

async function prepared(id: string) {
  const fixture = alignedDiffFixture(id);
  return preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
    theme: "light",
    sourceVersion: `fixture:${id}`,
    api: api(),
  });
}

describe("aligned Hunk and metadata chrome", () => {
  it("builds corresponding hunk headers and collapsed gaps on both sides", async () => {
    const current = await prepared("aligned-multi-hunk-collapsed");
    const model = buildKeydexAlignedDiffModel(current);
    const left = buildAlignedDiffPaneItems(model, current, "old");
    const right = buildAlignedDiffPaneItems(model, current, "new");
    expect(left.filter(({ type }) => type === "hunk_header")).toHaveLength(2);
    expect(right.filter(({ type }) => type === "hunk_header")).toHaveLength(2);
    expect(left.filter(({ type }) => type === "collapsed_gap").map((item) => (
      item.type === "collapsed_gap" ? item.hiddenLineCount : 0
    ))).toEqual([1, 15]);
    expect(right.filter(({ type }) => type === "collapsed_gap").map((item) => (
      item.type === "collapsed_gap" ? item.hiddenLineCount : 0
    ))).toEqual([1, 15]);
  });

  it("mounts collapsed unchanged rows at their reserved aligned-canvas offsets", async () => {
    const current = await prepared("aligned-multi-hunk-collapsed");
    const model = buildKeydexAlignedDiffModel(current);
    const metrics = buildScrollMappingMetrics(
      model,
      new DiffRowHeightIndex(model.leftRows.length, 20),
      new DiffRowHeightIndex(model.rightRows.length, 20),
    );
    const { container } = render(
      <AlignedDiffVirtualRows
        rows={model.leftRows}
        rowIndexes={[]}
        rowOffsets={metrics.leftRowOffsets}
        segmentMappings={metrics.segments}
        side="old"
        totalHeight={metrics.leftTotalHeight}
        contentColumns={0}
        wrap={false}
        activeChangeId={null}
        lineNumberDigits={3}
        observeRow={vi.fn()}
        changeKindById={new Map()}
      />,
    );
    const gaps = Array.from(container.querySelectorAll<HTMLElement>("[data-keydex-aligned-gap-overlay]"));
    const expected = metrics.segments.filter(({ segment }) => segment.kind === "collapsed_gap");
    expect(gaps).toHaveLength(2);
    expect(gaps.map(({ textContent }) => textContent)).toEqual([
      "已折叠 1 行未修改内容",
      "已折叠 15 行未修改内容",
    ]);
    expect(gaps.map(({ style }) => [style.top, style.height])).toEqual(expected.map(({ left }) => [
      `${left.start}px`,
      `${left.end - left.start}px`,
    ]));
  });

  it("does not expose expansion for partial patches but enables explicit full-content capability", async () => {
    const partial = await prepared("aligned-partial-context");
    const partialModel = buildKeydexAlignedDiffModel(partial);
    const gap = buildAlignedDiffPaneItems(partialModel, partial, "old")
      .find(({ type }) => type === "collapsed_gap")!;
    expect(gap).toMatchObject({ type: "collapsed_gap", canExpand: false });
    const onExpand = vi.fn();
    render(<AlignedDiffPaneItemView item={gap} wrap={false} onExpandGap={onExpand} />);
    expect(screen.queryByRole("button", { name: /展开/u })).toBeNull();

    const full = { ...partial, partial: false } as PierreAlignedPreparedFile;
    const fullModel = buildKeydexAlignedDiffModel(full);
    const fullGap = buildAlignedDiffPaneItems(fullModel, full, "old")
      .find(({ type }) => type === "collapsed_gap")!;
    render(<AlignedDiffPaneItemView item={fullGap} wrap={false} onExpandGap={onExpand} />);
    fireEvent.click(screen.getByRole("button", { name: /展开49行上下文/u }));
    expect(onExpand).toHaveBeenCalledWith(fullGap.type === "collapsed_gap" ? fullGap.segmentId : "");
  });

  it("renders EOF metadata on the correct sides", async () => {
    const current = await prepared("aligned-no-trailing-newline");
    const model = buildKeydexAlignedDiffModel(current);
    expect(buildAlignedDiffPaneItems(model, current, "old").at(-1)).toMatchObject({ type: "eof", side: "old" });
    expect(buildAlignedDiffPaneItems(model, current, "new").at(-1)).toMatchObject({ type: "eof", side: "new" });
  });

  it("localizes rename and mode metadata without changing alignment", async () => {
    const current = await prepared("aligned-equal-height");
    const renamed = {
      ...current,
      previousName: "src/old.ts",
      name: "src/new.ts",
      oldMode: "100644",
      newMode: "100755",
    } as PierreAlignedPreparedFile;
    expect(alignedFileMetadata(renamed)).toEqual([
      "重命名：src/old.ts → src/new.ts",
      "文件模式：100644 → 100755",
    ]);
    const model = buildKeydexAlignedDiffModel(renamed);
    const items = buildAlignedDiffPaneItems(model, renamed, "new");
    expect(items[0]).toMatchObject({ type: "metadata" });
    expect(model.segments).toHaveLength(buildKeydexAlignedDiffModel(current).segments.length);
  });

  it("uses the public full-content parser when both source texts are available", async () => {
    const current = await prepared("aligned-full-content");
    expect(current.partial).toBe(false);
    expect(current.deletionLines.map((line) => line.replace(/\r?\n$/u, ""))).toEqual([
      "const value = 'old';",
      "export default value;",
    ]);
    expect(current.additionLines.map((line) => line.replace(/\r?\n$/u, ""))).toEqual([
      "const value = 'new';",
      "export default value;",
    ]);
  });
});
