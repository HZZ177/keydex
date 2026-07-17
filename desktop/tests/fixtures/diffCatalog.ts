import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { KeydexDiffStatus } from "@/renderer/components/diff/model";

export type DiffFixtureFormat =
  | "unified_patch"
  | "apply_patch"
  | "content_only"
  | "git_file"
  | "generated_unified_patch";

export interface DiffFixture {
  id: string;
  format: DiffFixtureFormat;
  payload: Record<string, string | number | boolean>;
  expected: {
    file_count: number;
    statuses: KeydexDiffStatus[];
    additions: number;
    deletions: number;
    diagnostics: string[];
  };
}

export interface DiffFixtureCatalog {
  schema_version: 1;
  fixtures: DiffFixture[];
}

export function loadDiffFixtureCatalog(): DiffFixtureCatalog {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "../test-fixtures/diff/catalog.json"), "utf8"),
  ) as DiffFixtureCatalog;
}

export function diffFixture(id: string): DiffFixture {
  const fixture = loadDiffFixtureCatalog().fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Unknown Diff fixture: ${id}`);
  return fixture;
}

export function materializeDiffFixturePatch(fixture: DiffFixture): string {
  if (fixture.format !== "generated_unified_patch") {
    return typeof fixture.payload.patch === "string" ? fixture.payload.patch : "";
  }
  const path = String(fixture.payload.path);
  const rows = Number(fixture.payload.rows);
  const changeEvery = Number(fixture.payload.change_every);
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${rows} +1,${rows} @@`,
  ];
  for (let index = 1; index <= rows; index += 1) {
    if (index % changeEvery === 0) {
      lines.push(`-before ${index}`, `+after ${index}`);
    } else {
      lines.push(` context ${index}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
