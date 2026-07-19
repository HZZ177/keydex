import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createKeydexDiffFile,
  type KeydexDiffFile,
  type KeydexDiffStatus,
} from "@/renderer/components/diff/model";

export type AlignedFixtureDisposition = "ready" | "unsupported" | "malformed";
export type AlignedFixtureContentMode = "partial" | "full";
export type AlignedFixtureSegmentKind = "context" | "change" | "collapsed";

export interface AlignedFixtureSegment {
  readonly kind: AlignedFixtureSegmentKind;
  readonly left: number;
  readonly right: number;
}

export interface AlignedFixtureAnchor {
  readonly id: string;
  readonly old_line: number | null;
  readonly new_line: number | null;
}

export interface AlignedDiffFixture {
  readonly id: string;
  readonly source: string;
  readonly file: {
    readonly old_path: string | null;
    readonly new_path: string | null;
    readonly status: KeydexDiffStatus;
    readonly language: string;
    readonly content_mode: AlignedFixtureContentMode;
    readonly old_content?: string;
    readonly new_content?: string;
    readonly binary?: boolean;
    readonly truncated?: boolean;
  };
  readonly patch: string;
  readonly expected: {
    readonly disposition: AlignedFixtureDisposition;
    readonly old_lines: number;
    readonly new_lines: number;
    readonly hunks: number;
    readonly segments: readonly AlignedFixtureSegment[];
    readonly anchors: readonly AlignedFixtureAnchor[];
    readonly stats: {
      readonly additions: number;
      readonly deletions: number;
      readonly changes: number;
      readonly collapsed: number;
    };
    readonly snapshot: string;
  };
}

export interface AlignedDiffFixtureCatalog {
  readonly schema_version: 1;
  readonly model_version: "aligned-v1";
  readonly fixtures: readonly AlignedDiffFixture[];
}

export function loadAlignedDiffFixtureCatalog(): AlignedDiffFixtureCatalog {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "../test-fixtures/diff/aligned-catalog.json"), "utf8"),
  ) as AlignedDiffFixtureCatalog;
}

export function alignedDiffFixture(id: string): AlignedDiffFixture {
  const fixture = loadAlignedDiffFixtureCatalog().fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Unknown aligned Diff fixture: ${id}`);
  return fixture;
}

export function materializeAlignedDiffFile(fixture: AlignedDiffFixture): KeydexDiffFile {
  return createKeydexDiffFile({
    id: `fixture:${fixture.id}`,
    cacheKey: `fixture:${fixture.id}:${fixture.expected.snapshot}`,
    oldPath: fixture.file.old_path,
    newPath: fixture.file.new_path,
    status: fixture.file.status,
    language: fixture.file.language,
    patch: fixture.patch,
    ...(fixture.file.old_content === undefined ? {} : { oldContent: fixture.file.old_content }),
    ...(fixture.file.new_content === undefined ? {} : { newContent: fixture.file.new_content }),
    binary: fixture.file.binary ?? false,
    truncated: fixture.file.truncated ?? false,
    selectableForPatch: !(fixture.file.binary || fixture.file.truncated),
    additions: fixture.expected.stats.additions,
    deletions: fixture.expected.stats.deletions,
  });
}

export function expectedSegmentSnapshot(fixture: AlignedDiffFixture): string {
  return fixture.expected.segments
    .map(({ kind, left, right }) => `${kind}:${left}:${right}`)
    .join("|");
}
