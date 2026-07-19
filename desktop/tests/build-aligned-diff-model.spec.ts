import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import {
  buildAlignedPaneRows,
  DEFAULT_ALIGNED_ROW_HEIGHT,
} from "@/renderer/components/diff/aligned/buildAlignedDiffModel";
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
        deletionLines: metadata.deletionLines.map((line: string) => ({
          type: "element",
          tagName: "span",
          properties: { className: ["tok", "old"] },
          children: [{ type: "text", value: line }],
        })),
        additionLines: metadata.additionLines.map((line: string) => ({
          type: "element",
          tagName: "span",
          properties: { className: ["tok", "new"] },
          children: [{ type: "text", value: line }],
        })),
      },
      themeStyles: ":root{}",
      baseThemeType: "light",
    })) as never,
  };
}

async function build(id: string) {
  const fixture = alignedDiffFixture(id);
  const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
    theme: "light",
    sourceVersion: `fixture:${id}`,
    api: publicApi(),
  });
  return { fixture, prepared, rows: buildAlignedPaneRows(prepared) };
}

describe("buildAlignedPaneRows", () => {
  it("builds every ready fixture with one real pane row per Pierre source line", async () => {
    const ready = loadAlignedDiffFixtureCatalog().fixtures.filter(
      ({ expected }) => expected.disposition === "ready",
    );
    for (const fixture of ready) {
      const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
        theme: "light",
        sourceVersion: `fixture:${fixture.id}`,
        api: publicApi(),
      });
      const result = buildAlignedPaneRows(prepared);
      expect(result.leftRows, fixture.id).toHaveLength(prepared.deletionLines.length);
      expect(result.rightRows, fixture.id).toHaveLength(prepared.additionLines.length);
      expect(result.leftRows.map(({ text }) => text), fixture.id).toEqual(
        prepared.deletionLines.map((line) => line.replace(/\r?\n$/u, "")),
      );
      expect(result.rightRows.map(({ text }) => text), fixture.id).toEqual(
        prepared.additionLines.map((line) => line.replace(/\r?\n$/u, "")),
      );
      expect(result.leftRows.every(({ side }) => side === "old"), fixture.id).toBe(true);
      expect(result.rightRows.every(({ side }) => side === "new"), fixture.id).toBe(true);
      expect(new Set([...result.leftRows, ...result.rightRows].map(({ id }) => id)).size, fixture.id)
        .toBe(result.leftRows.length + result.rightRows.length);
    }
  });

  it("keeps asymmetric and pure changes independent without cross-side buffer rows", async () => {
    const leftLong = await build("aligned-left-long");
    expect(leftLong.rows.leftRows).toHaveLength(5);
    expect(leftLong.rows.rightRows).toHaveLength(3);
    expect(leftLong.rows.leftRows.filter(({ changeId }) => changeId).map(({ kind }) => kind))
      .toEqual(["removed", "removed", "modified"]);
    expect(leftLong.rows.rightRows.filter(({ changeId }) => changeId).map(({ kind }) => kind))
      .toEqual(["modified"]);

    const rightLong = await build("aligned-right-long");
    expect(rightLong.rows.leftRows.filter(({ changeId }) => changeId).map(({ kind }) => kind))
      .toEqual(["modified"]);
    expect(rightLong.rows.rightRows.filter(({ changeId }) => changeId).map(({ kind }) => kind))
      .toEqual(["added", "added", "modified"]);

    const equalHeight = await build("aligned-equal-height");
    expect(equalHeight.rows.leftRows.filter(({ changeId }) => changeId).map(({ kind }) => kind))
      .toEqual(["modified"]);
    expect(equalHeight.rows.rightRows.filter(({ changeId }) => changeId).map(({ kind }) => kind))
      .toEqual(["modified"]);

    const pureAdd = await build("aligned-pure-add");
    expect(pureAdd.rows.leftRows).toEqual([]);
    expect(pureAdd.rows.rightRows.map(({ kind }) => kind)).toEqual(["added", "added"]);

    const pureDelete = await build("aligned-pure-delete");
    expect(pureDelete.rows.leftRows.map(({ kind }) => kind)).toEqual(["removed", "removed"]);
    expect(pureDelete.rows.rightRows).toEqual([]);
  });

  it("preserves hunk/change identity, original line numbers and source indexes", async () => {
    const { rows } = await build("aligned-multi-change-one-hunk");
    const leftChanges = rows.leftRows.filter(({ changeId }) => changeId !== null);
    const rightChanges = rows.rightRows.filter(({ changeId }) => changeId !== null);
    expect(leftChanges.map(({ lineNumber }) => lineNumber)).toEqual([1, 4]);
    expect(rightChanges.map(({ lineNumber }) => lineNumber)).toEqual([1, 4]);
    expect(leftChanges.map(({ sourceIndex }) => sourceIndex)).toEqual([0, 3]);
    expect(new Set(leftChanges.map(({ changeId }) => changeId)).size).toBe(2);
    expect(leftChanges.map(({ changeId }) => changeId)).toEqual(rightChanges.map(({ changeId }) => changeId));
    expect(rows.leftRows.every(({ hunkId }) => hunkId === rows.leftRows[0]?.hunkId)).toBe(true);
  });

  it("keeps tokens, CRLF-normalized text and no-trailing-newline metadata", async () => {
    const crlf = await build("aligned-crlf");
    expect(crlf.rows.leftRows[0]?.text).toBe("old");
    expect(crlf.rows.rightRows[0]?.text).toBe("new");
    expect(crlf.rows.rightRows[0]?.tokens).toEqual([
      { type: "span", classNames: ["tok", "new"], children: [{ type: "text", value: "new" }] },
    ]);

    const eof = await build("aligned-no-trailing-newline");
    expect(eof.rows.leftRows[0]?.noTrailingNewline).toBe(true);
    expect(eof.rows.rightRows[0]?.noTrailingNewline).toBe(true);
  });

  it("uses stable IDs and validates estimated height", async () => {
    const { prepared } = await build("aligned-equal-height");
    const first = buildAlignedPaneRows(prepared);
    const second = buildAlignedPaneRows(prepared);
    expect(second).toEqual(first);
    expect(first.leftRows.every(({ estimatedHeight }) => estimatedHeight === DEFAULT_ALIGNED_ROW_HEIGHT)).toBe(true);
    expect(buildAlignedPaneRows(prepared, { estimatedRowHeight: 24 }).leftRows[0]?.estimatedHeight).toBe(24);
    expect(() => buildAlignedPaneRows(prepared, { estimatedRowHeight: 0 })).toThrow(
      "estimatedRowHeight must be positive",
    );
  });
});
