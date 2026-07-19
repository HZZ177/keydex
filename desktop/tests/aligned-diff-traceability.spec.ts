import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALIGNED_DIFF_SEMANTIC_CHAIN,
  ALIGNED_DIFF_TRACEABILITY,
  type AlignedDiffVerificationLayer,
} from "./fixtures/alignedDiffTraceability";

const EXPECTED_ISSUES = Array.from(
  { length: 34 },
  (_, index) => `ASD-${String(index + 3).padStart(3, "0")}`,
);
const VERIFICATION_LAYERS: readonly AlignedDiffVerificationLayer[] = ["unit", "functional", "e2e"];

describe("aligned split Diff test traceability", () => {
  it("covers every implementation issue from ASD-003 through ASD-036 exactly once", () => {
    const issueIds = ALIGNED_DIFF_TRACEABILITY.map((entry) => entry.issueId);
    expect(issueIds).toEqual(EXPECTED_ISSUES);
    expect(new Set(issueIds).size).toBe(issueIds.length);
  });

  it("maps every issue to unit, functional and E2E verification files that exist", () => {
    for (const entry of ALIGNED_DIFF_TRACEABILITY) {
      for (const layer of VERIFICATION_LAYERS) {
        expect(entry.verification[layer], `${entry.issueId} missing ${layer}`).not.toHaveLength(0);
        for (const file of entry.verification[layer]) {
          expect(existsSync(resolve(process.cwd(), file)), `${entry.issueId} -> ${file}`).toBe(true);
        }
      }
    }
  });

  it("closes the fixture to surface semantic chain without relying on snapshots", () => {
    const coveredLayers = new Set(ALIGNED_DIFF_TRACEABILITY.flatMap((entry) => entry.semanticLayers));
    expect([...coveredLayers].sort()).toEqual([...ALIGNED_DIFF_SEMANTIC_CHAIN].sort());

    const allFiles = ALIGNED_DIFF_TRACEABILITY.flatMap((entry) =>
      VERIFICATION_LAYERS.flatMap((layer) => entry.verification[layer]),
    );
    expect(allFiles.some((file) => file.includes("fixture"))).toBe(true);
    expect(allFiles.some((file) => file.includes("model"))).toBe(true);
    expect(allFiles.some((file) => file.includes("scroll"))).toBe(true);
    expect(allFiles.some((file) => file.includes("connector"))).toBe(true);
    expect(allFiles.some((file) => file.includes("profile"))).toBe(true);
    expect(allFiles.some((file) => file.includes("orchestration"))).toBe(true);
    expect(allFiles.some((file) => file.endsWith(".snap"))).toBe(false);
  });
});
