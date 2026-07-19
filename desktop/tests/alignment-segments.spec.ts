import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import {
  buildAlignmentSegments,
  buildKeydexAlignedDiffModel,
  findAlignmentSegmentByRow,
} from "@/renderer/components/diff/aligned/alignmentSegments";
import { buildAlignedPaneRows } from "@/renderer/components/diff/aligned/buildAlignedDiffModel";
import {
  preparePierreAlignedFile,
  type PierreAlignedPublicApi,
} from "@/renderer/components/diff/engine/pierreAlignedAdapter";

import {
  alignedDiffFixture,
  loadAlignedDiffFixtureCatalog,
  materializeAlignedDiffFile,
} from "./fixtures/alignedDiffCatalog";

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

async function prepare(id: string) {
  const fixture = alignedDiffFixture(id);
  return {
    fixture,
    prepared: await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
      theme: "light",
      sourceVersion: `fixture:${id}`,
      api: publicApi(),
    }),
  };
}

describe("ChangeContent alignment segments", () => {
  it("matches every ready fixture golden at ChangeContent granularity", async () => {
    for (const fixture of loadAlignedDiffFixtureCatalog().fixtures.filter(
      ({ expected }) => expected.disposition === "ready",
    )) {
      const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
        theme: "light",
        sourceVersion: `fixture:${fixture.id}`,
        api: publicApi(),
      });
      const { segments, changes } = buildAlignmentSegments(prepared);
      expect(segments.map((segment) => ({
        kind: segment.kind === "collapsed_gap" ? "collapsed" : segment.kind,
        left: segment.kind === "collapsed_gap"
          ? (segment.left.endLine ?? 0) - (segment.left.startLine ?? 1) + 1
          : segment.left.endRow - segment.left.startRow,
        right: segment.kind === "collapsed_gap"
          ? (segment.right.endLine ?? 0) - (segment.right.startLine ?? 1) + 1
          : segment.right.endRow - segment.right.startRow,
      })), fixture.id).toEqual(fixture.expected.segments);
      expect(changes, fixture.id).toHaveLength(fixture.expected.stats.changes);
    }
  });

  it("creates two independent changes inside one hunk", async () => {
    const { prepared } = await prepare("aligned-multi-change-one-hunk");
    const model = buildKeydexAlignedDiffModel(prepared);
    expect(model.changes).toHaveLength(2);
    expect(model.changes.map(({ kind }) => kind)).toEqual(["modified", "modified"]);
    expect(model.changes.map(({ left }) => left.startLine)).toEqual([1, 4]);
    expect(model.changes.map(({ right }) => right.startLine)).toEqual([1, 4]);
    expect(new Set(model.changes.map(({ id }) => id)).size).toBe(2);
  });

  it("represents pure addition/deletion with an explicit empty side", async () => {
    const added = buildKeydexAlignedDiffModel((await prepare("aligned-pure-add")).prepared);
    expect(added.changes[0]).toMatchObject({
      kind: "added",
      left: { startRow: 0, endRow: 0, startLine: null, endLine: null },
      right: { startRow: 0, endRow: 2, startLine: 1, endLine: 2 },
    });
    const deleted = buildKeydexAlignedDiffModel((await prepare("aligned-pure-delete")).prepared);
    expect(deleted.changes[0]).toMatchObject({
      kind: "removed",
      left: { startRow: 0, endRow: 2, startLine: 1, endLine: 2 },
      right: { startRow: 0, endRow: 0, startLine: null, endLine: null },
    });
  });

  it("keeps segment ranges ordered, non-crossing and associated with every row", async () => {
    const { prepared } = await prepare("aligned-multi-hunk-collapsed");
    const rows = buildAlignedPaneRows(prepared);
    const { segments } = buildAlignmentSegments(prepared, rows);
    for (const [side, paneRows] of [["old", rows.leftRows], ["new", rows.rightRows]] as const) {
      let end = 0;
      for (const segment of segments) {
        const range = side === "old" ? segment.left : segment.right;
        expect(range.startRow).toBeGreaterThanOrEqual(end);
        expect(range.endRow).toBeGreaterThanOrEqual(range.startRow);
        end = range.endRow;
      }
      for (let index = 0; index < paneRows.length; index += 1) {
        expect(findAlignmentSegmentByRow(segments, side, index)?.id).toBe(paneRows[index]?.segmentId);
      }
    }
  });

  it("uses binary lookup with deterministic boundary bias and stable rebuilds", async () => {
    const { prepared } = await prepare("aligned-partial-context");
    const first = buildKeydexAlignedDiffModel(prepared);
    const second = buildKeydexAlignedDiffModel(prepared);
    expect(second).toEqual(first);
    expect(first.segments[0]?.kind).toBe("collapsed_gap");
    expect(findAlignmentSegmentByRow(first.segments, "old", 0)?.kind).toBe("context");
    expect(findAlignmentSegmentByRow(first.segments, "old", 3)).toBeNull();
    expect(findAlignmentSegmentByRow(first.segments, "old", 3, "previous")?.kind).toBe("context");
    expect(findAlignmentSegmentByRow(first.segments, "old", -1)).toBeNull();
  });
});
