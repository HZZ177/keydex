import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import { buildKeydexAlignedDiffModel } from "@/renderer/components/diff/aligned/alignmentSegments";
import { buildScrollMappingMetrics } from "@/renderer/components/diff/aligned/hunkScrollMapping";
import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";
import {
  captureDiffPaneMetricSnapshot,
  DiffPaneAnchorRestoreScheduler,
  restoreDiffPaneMetricSnapshot,
} from "@/renderer/components/diff/aligned/useDiffPaneMetrics";
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

async function setup(sourceVersion = "fixture:v1") {
  const fixture = alignedDiffFixture("aligned-multi-hunk-collapsed");
  const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
    theme: "light",
    sourceVersion,
    api: publicApi(),
  });
  const model = buildKeydexAlignedDiffModel(prepared);
  return { fixture, model };
}

describe("Diff pane semantic anchor restoration", () => {
  it("restores the same semantic row/fraction after wrap changes row heights", async () => {
    const { model } = await setup();
    const before = new DiffRowHeightIndex(model.leftRows.length, [18, 22, 20, 30, 19, 24]);
    const beforeMetrics = buildScrollMappingMetrics(model, before, new DiffRowHeightIndex(model.rightRows.length, 20));
    const snapshot = captureDiffPaneMetricSnapshot({
      model,
      metrics: beforeMetrics,
      heights: before,
      side: "old",
      scrollTop: 32.5,
      viewportHeight: 90,
      viewportFraction: 0.4,
    })!;

    const after = new DiffRowHeightIndex(model.leftRows.length, [28, 44, 31, 52, 29, 38]);
    const afterMetrics = buildScrollMappingMetrics(model, after, new DiffRowHeightIndex(model.rightRows.length, 30));
    const restored = restoreDiffPaneMetricSnapshot({
      snapshot,
      model,
      metrics: afterMetrics,
      heights: after,
      viewportHeight: 90,
    })!;
    expect(restored).not.toBeCloseTo(32.5);
    const recaptured = captureDiffPaneMetricSnapshot({
      model,
      metrics: afterMetrics,
      heights: after,
      side: "old",
      scrollTop: restored,
      viewportHeight: 90,
      viewportFraction: 0.4,
    })!;
    expect(recaptured.anchor.segmentId).toBe(snapshot.anchor.segmentId);
    expect(recaptured.anchor.rowId).toBe(snapshot.anchor.rowId);
    expect(recaptured.anchor.rowFraction).toBeCloseTo(snapshot.anchor.rowFraction, 6);
  });

  it("preserves fractional pixels and clamps to the new scroll boundary", async () => {
    const { model } = await setup();
    const heights = new DiffRowHeightIndex(model.rightRows.length, 20.25);
    const metrics = buildScrollMappingMetrics(model, new DiffRowHeightIndex(model.leftRows.length, 20.25), heights);
    const snapshot = captureDiffPaneMetricSnapshot({
      model,
      metrics,
      heights,
      side: "new",
      scrollTop: 10.125,
      viewportHeight: 80.5,
      viewportFraction: 0.25,
    })!;
    const restored = restoreDiffPaneMetricSnapshot({ snapshot, model, metrics, heights, viewportHeight: 80.5 });
    expect(restored).toBeCloseTo(10.125, 6);

    const endSnapshot = captureDiffPaneMetricSnapshot({
      model,
      metrics,
      heights,
      side: "new",
      scrollTop: metrics.rightTotalHeight,
      viewportHeight: 0,
      viewportFraction: 1,
    })!;
    expect(restoreDiffPaneMetricSnapshot({
      snapshot: endSnapshot,
      model,
      metrics,
      heights,
      viewportHeight: 120,
    })).toBe(Math.max(0, metrics.rightTotalHeight - 120));
  });

  it("rejects stale file, cache and sourceVersion snapshots", async () => {
    const current = await setup("fixture:v1");
    const heights = new DiffRowHeightIndex(current.model.leftRows.length, 20);
    const metrics = buildScrollMappingMetrics(
      current.model,
      heights,
      new DiffRowHeightIndex(current.model.rightRows.length, 20),
    );
    const snapshot = captureDiffPaneMetricSnapshot({
      model: current.model,
      metrics,
      heights,
      side: "old",
      scrollTop: 20,
      viewportHeight: 100,
    })!;
    const changed = await setup("fixture:v2");
    const changedHeights = new DiffRowHeightIndex(changed.model.leftRows.length, 20);
    const changedMetrics = buildScrollMappingMetrics(
      changed.model,
      changedHeights,
      new DiffRowHeightIndex(changed.model.rightRows.length, 20),
    );
    expect(restoreDiffPaneMetricSnapshot({
      snapshot,
      model: changed.model,
      metrics: changedMetrics,
      heights: changedHeights,
      viewportHeight: 100,
    })).toBeNull();
  });

  it("coalesces continuous resize restores and drops stale scheduled work", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    const scheduler = new DiffPaneAnchorRestoreScheduler({
      requestFrame: (callback) => {
        const next = ++id;
        frames.set(next, callback);
        return next;
      },
      cancelFrame: (handle) => { frames.delete(handle); },
    });
    const apply = vi.fn();
    scheduler.schedule(() => 10, apply);
    scheduler.schedule(() => 20.5, apply);
    expect(frames.size).toBe(1);
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(20.5);
    scheduler.schedule(() => 30, apply);
    scheduler.cancel();
    expect(frames.size).toBe(0);
  });
});
