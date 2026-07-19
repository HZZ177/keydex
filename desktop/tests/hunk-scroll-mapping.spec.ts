import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import { buildKeydexAlignedDiffModel } from "@/renderer/components/diff/aligned/alignmentSegments";
import {
  buildScrollMappingMetrics,
  captureDiffScrollAnchor,
  mapDiffPaneOffset,
  mapDiffPaneViewportOffset,
  resolveDiffScrollAnchor,
} from "@/renderer/components/diff/aligned/hunkScrollMapping";
import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";
import {
  preparePierreAlignedFile,
  type PierreAlignedPublicApi,
} from "@/renderer/components/diff/engine/pierreAlignedAdapter";

import { alignedDiffFixture, materializeAlignedDiffFile } from "./fixtures/alignedDiffCatalog";

function publicApi(): PierreAlignedPublicApi {
  return {
    parsePatchFiles: pierre.parsePatchFiles,
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

async function setup(id: string, leftHeight: number | readonly number[] = 20, rightHeight: number | readonly number[] = 20) {
  const fixture = alignedDiffFixture(id);
  const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
    theme: "light",
    sourceVersion: `fixture:${id}`,
    api: publicApi(),
  });
  const model = buildKeydexAlignedDiffModel(prepared);
  const left = new DiffRowHeightIndex(model.leftRows.length, leftHeight);
  const right = new DiffRowHeightIndex(model.rightRows.length, rightHeight);
  return { model, left, right, metrics: buildScrollMappingMetrics(model, left, right) };
}

describe("semantic hunk scroll mapping", () => {
  it("keeps both panes continuous and maps paired context rows proportionally", async () => {
    const { model, left, right, metrics } = await setup(
      "aligned-equal-height",
      [18, 40, 22],
      [24, 30, 28],
    );
    expect(metrics.leftRowOffsets).toEqual([0, 18, 58]);
    expect(metrics.rightRowOffsets).toEqual([0, 24, 54]);
    expect(metrics.leftTotalHeight).toBe(80);
    expect(metrics.rightTotalHeight).toBe(82);
    expect(mapDiffPaneOffset(model, metrics, left, right, "old", 9)).toBe(12);
    expect(mapDiffPaneOffset(model, metrics, left, right, "old", 69.5)).toBeCloseTo(68.64, 2);
  });

  it("freezes the shorter pane for one-sided runs and jumps them from the shorter master", async () => {
    const leftLong = await setup("aligned-left-long");
    const change = leftLong.metrics.segments.find(({ segment }) => segment.kind === "change")!;
    expect(change.left.end - change.left.start).toBe(60);
    expect(change.right.end - change.right.start).toBe(20);
    expect(leftLong.metrics.leftTotalHeight).toBe(100);
    expect(leftLong.metrics.rightTotalHeight).toBe(60);
    expect(mapDiffPaneOffset(
      leftLong.model,
      leftLong.metrics,
      leftLong.left,
      leftLong.right,
      "old",
      change.left.start + 10,
    )).toBe(change.right.start);
    expect(mapDiffPaneOffset(
      leftLong.model,
      leftLong.metrics,
      leftLong.left,
      leftLong.right,
      "old",
      change.left.start + 40,
    )).toBe(change.right.start);
    expect(mapDiffPaneOffset(
      leftLong.model,
      leftLong.metrics,
      leftLong.left,
      leftLong.right,
      "old",
      change.left.end,
    )).toBe(change.right.end);

    expect(mapDiffPaneOffset(
      leftLong.model,
      leftLong.metrics,
      leftLong.left,
      leftLong.right,
      "new",
      change.right.start,
    )).toBe(change.left.start + 40);

    const following = leftLong.metrics.segments[leftLong.metrics.segments.indexOf(change) + 1];
    if (following) {
      expect(following.left.start).toBe(change.left.end);
      expect(following.right.start).toBe(change.right.end);
    }

    const reverse = await setup("aligned-right-long");
    const reverseChange = reverse.metrics.segments.find(({ segment }) => segment.kind === "change")!;
    expect(mapDiffPaneOffset(
      reverse.model,
      reverse.metrics,
      reverse.left,
      reverse.right,
      "new",
      reverseChange.right.start + 45,
    )).toBe(reverseChange.left.start + 5);
  });

  it("pins the shorter pane at the viewport centre while the longer change run advances", async () => {
    const setupResult = await setup("aligned-left-long");
    const change = setupResult.metrics.segments.find(({ segment }) => segment.kind === "change")!;
    const viewportHeight = 20;
    const sourceScrollTop = change.left.start + 40 - viewportHeight / 2;
    const mappedScrollTop = mapDiffPaneViewportOffset(
      setupResult.model,
      setupResult.metrics,
      setupResult.left,
      setupResult.right,
      "old",
      sourceScrollTop,
      viewportHeight,
      viewportHeight,
    );

    expect(mappedScrollTop).toBe(change.right.start - viewportHeight / 2);
    expect(change.right.start - mappedScrollTop!).toBe(viewportHeight / 2);
  });

  it("keeps both panes at the same progress through reserved bottom scroll space", async () => {
    const setupResult = await setup("aligned-left-long");
    const viewportHeight = 20;
    const bottomScrollSpace = 6;
    const leftContentEnd = setupResult.metrics.leftTotalHeight - viewportHeight;
    const rightContentEnd = setupResult.metrics.rightTotalHeight - viewportHeight;
    const leftHalfTail = mapDiffPaneViewportOffset(
      setupResult.model,
      setupResult.metrics,
      setupResult.left,
      setupResult.right,
      "old",
      leftContentEnd + bottomScrollSpace / 2,
      viewportHeight,
      viewportHeight,
      {
        sourceBottomScrollSpace: bottomScrollSpace,
        targetBottomScrollSpace: bottomScrollSpace,
      },
    );
    expect(leftHalfTail).toBe(rightContentEnd + bottomScrollSpace / 2);

    const rightEnd = mapDiffPaneViewportOffset(
      setupResult.model,
      setupResult.metrics,
      setupResult.left,
      setupResult.right,
      "new",
      rightContentEnd + bottomScrollSpace,
      viewportHeight,
      viewportHeight,
      {
        sourceBottomScrollSpace: bottomScrollSpace,
        targetBottomScrollSpace: bottomScrollSpace,
      },
    );
    expect(rightEnd).toBe(leftContentEnd + bottomScrollSpace);
  });

  it("maps collapsed gaps proportionally and keeps exact pane end reachable", async () => {
    const setupResult = await setup("aligned-partial-context");
    const gap = setupResult.metrics.segments[0]!;
    expect(gap.segment.kind).toBe("collapsed_gap");
    expect(mapDiffPaneOffset(
      setupResult.model,
      setupResult.metrics,
      setupResult.left,
      setupResult.right,
      "old",
      15,
    )).toBe(15);
    expect(mapDiffPaneOffset(
      setupResult.model,
      setupResult.metrics,
      setupResult.left,
      setupResult.right,
      "old",
      setupResult.metrics.leftTotalHeight,
    )).toBe(setupResult.metrics.rightTotalHeight);
  });

  it("handles pure additions/deletions and capture/resolve symmetry", async () => {
    const added = await setup("aligned-pure-add");
    expect(mapDiffPaneOffset(added.model, added.metrics, added.left, added.right, "new", 10)).toBe(0);
    const deleted = await setup("aligned-pure-delete");
    expect(mapDiffPaneOffset(deleted.model, deleted.metrics, deleted.left, deleted.right, "old", 10)).toBe(0);

    const equal = await setup("aligned-equal-height");
    const anchor = captureDiffScrollAnchor(equal.model, equal.metrics, equal.left, "old", 15)!;
    const mapped = resolveDiffScrollAnchor(equal.model, equal.metrics, equal.right, anchor, "new")!;
    const reverseAnchor = captureDiffScrollAnchor(equal.model, equal.metrics, equal.right, "new", mapped)!;
    expect(resolveDiffScrollAnchor(equal.model, equal.metrics, equal.left, reverseAnchor, "old"))
      .toBeCloseTo(15);
  });

  it("is monotonic in both directions with variable heights", async () => {
    const setupResult = await setup(
      "aligned-multi-hunk-collapsed",
      [18, 24, 17, 31, 20, 22],
      [21, 19, 28, 16, 26, 18, 23],
    );
    for (const sourceSide of ["old", "new"] as const) {
      const sourceTotal = sourceSide === "old"
        ? setupResult.metrics.leftTotalHeight
        : setupResult.metrics.rightTotalHeight;
      let previous = -1;
      for (let step = 0; step <= 500; step += 1) {
        const offset = sourceTotal * step / 500;
        const mapped = mapDiffPaneOffset(
          setupResult.model,
          setupResult.metrics,
          setupResult.left,
          setupResult.right,
          sourceSide,
          offset,
        )!;
        expect(mapped).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = mapped;
      }
    }
  });
});
