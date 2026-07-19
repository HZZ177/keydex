import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import { buildKeydexAlignedDiffModel } from "@/renderer/components/diff/aligned/alignmentSegments";
import { computeVisibleDiffConnectorGeometry } from "@/renderer/components/diff/aligned/connectorGeometry";
import {
  buildScrollMappingMetrics,
  type DiffScrollMappingMetrics,
} from "@/renderer/components/diff/aligned/hunkScrollMapping";
import type { KeydexAlignedDiffModel } from "@/renderer/components/diff/aligned/alignedDiffModel";
import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";
import { percentilePerformanceSample } from "@/renderer/components/diff/diffRuntimePerformance";
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

async function setup(
  id: string,
  leftHeight: number | readonly number[] = 20,
  rightHeight: number | readonly number[] = 20,
) {
  const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(alignedDiffFixture(id)), {
    theme: "light",
    sourceVersion: `fixture:${id}`,
    api: publicApi(),
  });
  const model = buildKeydexAlignedDiffModel(prepared);
  const left = new DiffRowHeightIndex(model.leftRows.length, leftHeight);
  const right = new DiffRowHeightIndex(model.rightRows.length, rightHeight);
  return { model, metrics: buildScrollMappingMetrics(model, left, right) };
}

describe("visible aligned connector geometry", () => {
  it("preserves decimal coordinates for an equal-height replacement", async () => {
    const { model, metrics } = await setup("aligned-equal-height", 20.25, 21.5);
    const geometry = computeVisibleDiffConnectorGeometry(model, metrics, {
      leftScrollTop: 0.5,
      rightScrollTop: 1.25,
      leftViewportHeight: 100.75,
      rightViewportHeight: 100.75,
    });
    expect(geometry).toHaveLength(1);
    expect(geometry[0]).toMatchObject({ kind: "modified", clippedTop: false, clippedBottom: false });
    expect(geometry[0]!.leftStart).toBeCloseTo(19.75);
    expect(geometry[0]!.rightStart).toBeCloseTo(20.25);
  });

  it("clips an asymmetric change independently at the top and bottom", async () => {
    const { model, metrics } = await setup("aligned-left-long");
    const geometry = computeVisibleDiffConnectorGeometry(model, metrics, {
      leftScrollTop: 25,
      rightScrollTop: 25,
      leftViewportHeight: 20,
      rightViewportHeight: 20,
    });
    expect(geometry[0]).toMatchObject({
      leftStart: 0,
      leftEnd: 20,
      rightStart: 0,
      rightEnd: 15,
      clippedTop: true,
      clippedBottom: true,
    });
  });

  it("converges pure additions and deletions to a zero-height endpoint", async () => {
    const added = await setup("aligned-pure-add");
    const addedGeometry = computeVisibleDiffConnectorGeometry(added.model, added.metrics, {
      leftScrollTop: 0,
      rightScrollTop: 0,
      leftViewportHeight: 80,
      rightViewportHeight: 80,
    });
    expect(addedGeometry[0]).toMatchObject({ kind: "added", leftStart: 0, leftEnd: 0 });

    const removed = await setup("aligned-pure-delete");
    const removedGeometry = computeVisibleDiffConnectorGeometry(removed.model, removed.metrics, {
      leftScrollTop: 0,
      rightScrollTop: 0,
      leftViewportHeight: 80,
      rightViewportHeight: 80,
    });
    expect(removedGeometry[0]).toMatchObject({ kind: "removed", rightStart: 0, rightEnd: 0 });
  });

  it("omits fully offscreen changes but retains a connector crossing the viewport", async () => {
    const setupResult = await setup("aligned-multi-change-one-hunk");
    const hidden = computeVisibleDiffConnectorGeometry(setupResult.model, setupResult.metrics, {
      leftScrollTop: 1_000,
      rightScrollTop: 1_000,
      leftViewportHeight: 100,
      rightViewportHeight: 100,
    });
    expect(hidden).toHaveLength(0);

    const crossing = computeVisibleDiffConnectorGeometry(setupResult.model, setupResult.metrics, {
      leftScrollTop: 0,
      rightScrollTop: 100,
      leftViewportHeight: 30,
      rightViewportHeight: 30,
    });
    expect(crossing.length).toBeGreaterThan(0);
    expect(crossing.some(({ clippedTop, clippedBottom }) => clippedTop || clippedBottom)).toBe(true);
  });

  it("keeps multiple visible connector endpoints ordered and non-crossing", async () => {
    const { model, metrics } = await setup("aligned-multi-change-one-hunk");
    const geometry = computeVisibleDiffConnectorGeometry(model, metrics, {
      leftScrollTop: 0,
      rightScrollTop: 0,
      leftViewportHeight: 500,
      rightViewportHeight: 500,
    });
    expect(geometry).toHaveLength(2);
    for (let index = 1; index < geometry.length; index += 1) {
      expect(geometry[index]!.leftStart).toBeGreaterThanOrEqual(geometry[index - 1]!.leftEnd);
      expect(geometry[index]!.rightStart).toBeGreaterThanOrEqual(geometry[index - 1]!.rightEnd);
    }
  });

  it("validates finite and non-negative viewport metrics", async () => {
    const { model, metrics } = await setup("aligned-equal-height");
    expect(() => computeVisibleDiffConnectorGeometry(model, metrics, {
      leftScrollTop: Number.NaN,
      rightScrollTop: 0,
      leftViewportHeight: 20,
      rightViewportHeight: 20,
    })).toThrow(TypeError);
    expect(() => computeVisibleDiffConnectorGeometry(model, metrics, {
      leftScrollTop: -1,
      rightScrollTop: 0,
      leftViewportHeight: 20,
      rightViewportHeight: 20,
    })).toThrow(RangeError);
  });

  it("keeps visible connector geometry below the four-millisecond P95 budget at 100k segments", () => {
    const segmentCount = 100_000;
    const rowHeight = 20;
    const segments = Array.from({ length: segmentCount }, (_, index) => {
      const start = index * rowHeight;
      const change = {
        id: `change:${index}`,
        segmentId: `segment:${index}`,
        kind: "modified" as const,
        left: { startRow: index, endRow: index + 1, startLine: index + 1, endLine: index + 1 },
        right: { startRow: index, endRow: index + 1, startLine: index + 1, endLine: index + 1 },
      };
      return {
        segment: {
          id: change.segmentId,
          kind: "change" as const,
          left: change.left,
          right: change.right,
          hunkId: "hunk:stress",
          changeId: change.id,
        },
        change,
        left: { start, end: start + rowHeight },
        right: { start, end: start + rowHeight },
      };
    });
    const metrics: DiffScrollMappingMetrics = {
      segments,
      leftTotalHeight: segmentCount * rowHeight,
      rightTotalHeight: segmentCount * rowHeight,
    };
    // Geometry consumes the canonical change already attached to each immutable metric mapping;
    // the model remains in the signature for API compatibility and is not traversed per frame.
    const model = {} as KeydexAlignedDiffModel;
    const samples = Array.from({ length: 60 }, (_, index) => {
      const startedAt = performance.now();
      const geometry = computeVisibleDiffConnectorGeometry(model, metrics, {
        leftScrollTop: index * 30_000,
        rightScrollTop: index * 30_000,
        leftViewportHeight: 900,
        rightViewportHeight: 900,
      });
      expect(geometry.length).toBeLessThanOrEqual(48);
      return performance.now() - startedAt;
    });
    expect(percentilePerformanceSample(samples, 0.95)).toBeLessThanOrEqual(4);
  });
});
