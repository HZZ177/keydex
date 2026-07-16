import { describe, expect, it } from "vitest";

import {
  GIT_REFERENCE_MANIFEST,
  validateGitReferenceManifest,
} from "@/renderer/features/git/referenceManifest";

describe("Git open-source reference manifest", () => {
  it("pins every LiveAgent reference to an auditable MIT commit", () => {
    expect(validateGitReferenceManifest()).toEqual([]);
    expect(GIT_REFERENCE_MANIFEST).not.toHaveLength(0);
    expect(
      GIT_REFERENCE_MANIFEST.every(
        (entry) =>
          entry.repository === "Stack-Cairn/LiveAgent" &&
          entry.commit === "1616eb5e574274693dc29e18248650dc30911123" &&
          entry.license === "MIT",
      ),
    ).toBe(true);
  });

  it("allows only the pure graph algorithm to be ported", () => {
    const portable = GIT_REFERENCE_MANIFEST.filter(
      (entry) => entry.policy === "pure-algorithm-port",
    );

    expect(portable.map((entry) => entry.sourcePath)).toEqual([
      "crates/agent-gui/src/lib/git/gitGraph.ts",
    ]);
    expect(
      GIT_REFERENCE_MANIFEST.filter((entry) => entry.policy === "analyze-and-rewrite"),
    ).toHaveLength(2);
  });
});
