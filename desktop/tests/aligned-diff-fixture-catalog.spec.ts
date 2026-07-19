import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import {
  PierreAlignedAdapterError,
  preparePierreAlignedFile,
  type PierreAlignedPreparedFile,
  type PierreAlignedPublicApi,
} from "@/renderer/components/diff/engine/pierreAlignedAdapter";

import {
  expectedSegmentSnapshot,
  loadAlignedDiffFixtureCatalog,
  materializeAlignedDiffFile,
  type AlignedDiffFixture,
  type AlignedFixtureSegment,
} from "./fixtures/alignedDiffCatalog";

const REQUIRED_SCENARIOS = [
  "aligned-equal-height",
  "aligned-left-long",
  "aligned-right-long",
  "aligned-pure-add",
  "aligned-pure-delete",
  "aligned-multi-change-one-hunk",
  "aligned-multi-hunk-collapsed",
  "aligned-crlf",
  "aligned-unicode",
  "aligned-no-trailing-newline",
  "aligned-long-line",
  "aligned-partial-context",
  "aligned-full-content",
  "aligned-binary",
  "aligned-truncated",
  "aligned-malformed",
] as const;

function publicApi(): PierreAlignedPublicApi {
  return {
    parsePatchFiles: pierre.parsePatchFiles,
    getFiletypeFromFileName: pierre.getFiletypeFromFileName,
    getSharedHighlighter: vi.fn(async () => ({}) as never),
    renderDiffWithHighlighter: vi.fn((metadata) => ({
      code: {
        deletionLines: metadata.deletionLines.map((line: string) => ({ type: "text", value: line })),
        additionLines: metadata.additionLines.map((line: string) => ({ type: "text", value: line })),
      },
      themeStyles: ":root{}",
      baseThemeType: "light",
    })) as never,
  };
}

function actualSegments(prepared: PierreAlignedPreparedFile): AlignedFixtureSegment[] {
  return prepared.hunks.flatMap((hunk) => [
    ...(hunk.collapsedBefore > 0
      ? [{ kind: "collapsed" as const, left: hunk.collapsedBefore, right: hunk.collapsedBefore }]
      : []),
    ...hunk.content.map((content) => ({
      kind: content.type,
      left: content.type === "context" ? content.lines : content.deletions,
      right: content.type === "context" ? content.lines : content.additions,
    })),
  ]);
}

function expectedReady(fixture: AlignedDiffFixture): boolean {
  return fixture.expected.disposition === "ready";
}

describe("aligned split Diff fixture catalog", () => {
  it("covers the complete offline semantic matrix with unique stable ids", () => {
    const catalog = loadAlignedDiffFixtureCatalog();
    const ids = catalog.fixtures.map(({ id }) => id);
    expect(catalog.schema_version).toBe(1);
    expect(catalog.model_version).toBe("aligned-v1");
    expect(ids).toEqual(REQUIRED_SCENARIOS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(catalog.fixtures.map(({ expected }) => expected.snapshot)).size).toBe(ids.length);
  });

  it("keeps every source, expected range, anchor, statistic and snapshot explicit", () => {
    for (const fixture of loadAlignedDiffFixtureCatalog().fixtures) {
      expect(fixture.source).toMatch(/^Keydex curated fixture:/u);
      expect(fixture.patch).not.toBe("");
      expect(fixture.expected.snapshot).not.toBe("");
      expect(fixture.expected.old_lines).toBeGreaterThanOrEqual(0);
      expect(fixture.expected.new_lines).toBeGreaterThanOrEqual(0);
      expect(fixture.expected.hunks).toBeGreaterThanOrEqual(0);
      expect(fixture.expected.stats.additions).toBeGreaterThanOrEqual(0);
      expect(fixture.expected.stats.deletions).toBeGreaterThanOrEqual(0);
      for (const segment of fixture.expected.segments) {
        expect(segment.left).toBeGreaterThanOrEqual(0);
        expect(segment.right).toBeGreaterThanOrEqual(0);
        expect(segment.left + segment.right).toBeGreaterThan(0);
      }
      for (const anchor of fixture.expected.anchors) {
        expect(anchor.id).toMatch(/^h\d+-change\d+$/u);
        expect(anchor.old_line !== null || anchor.new_line !== null).toBe(true);
      }
      expect(() => materializeAlignedDiffFile(fixture)).not.toThrow();
      expect(expectedSegmentSnapshot(fixture)).toMatch(/^(?:|(?:context|change|collapsed):\d+:\d+(?:\|(?:context|change|collapsed):\d+:\d+)*)$/u);
    }
  });

  it("matches Pierre public metadata and ChangeContent boundaries for every ready fixture", async () => {
    for (const fixture of loadAlignedDiffFixtureCatalog().fixtures.filter(expectedReady)) {
      const prepared = await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
        theme: "light",
        sourceVersion: `fixture:${fixture.id}`,
        api: publicApi(),
      });
      expect(prepared.deletionLines, fixture.id).toHaveLength(fixture.expected.old_lines);
      expect(prepared.additionLines, fixture.id).toHaveLength(fixture.expected.new_lines);
      expect(prepared.hunks, fixture.id).toHaveLength(fixture.expected.hunks);
      expect(actualSegments(prepared), fixture.id).toEqual(fixture.expected.segments);
      expect(
        prepared.hunks.flatMap((hunk) => hunk.content).filter((segment) => segment.type === "change"),
        fixture.id,
      ).toHaveLength(fixture.expected.stats.changes);
      expect(
        prepared.hunks.reduce((sum, hunk) => sum + hunk.collapsedBefore, 0),
        fixture.id,
      ).toBe(fixture.expected.stats.collapsed);
    }
  });

  it("classifies unsupported and malformed fixtures without leaking raw exceptions", async () => {
    for (const fixture of loadAlignedDiffFixtureCatalog().fixtures.filter((candidate) => !expectedReady(candidate))) {
      try {
        await preparePierreAlignedFile(materializeAlignedDiffFile(fixture), {
          theme: "light",
          sourceVersion: `fixture:${fixture.id}`,
          api: publicApi(),
        });
        throw new Error(`${fixture.id}: expected adapter failure`);
      } catch (error) {
        expect(error, fixture.id).toBeInstanceOf(PierreAlignedAdapterError);
        const phase = (error as PierreAlignedAdapterError).phase;
        expect(phase, fixture.id).toBe(
          fixture.expected.disposition === "malformed" ? "parse" : "unsupported",
        );
      }
    }
  });

  it("contains no workspace paths, network dependency or credential-shaped data", () => {
    const serialized = JSON.stringify(loadAlignedDiffFixtureCatalog());
    expect(serialized).not.toMatch(/C:\\\\Users|D:\\\\|https?:\/\/|password|api[_-]?key|bearer|token/iu);
  });
});
