import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PIERRE_DIFFS_INTEGRATION } from "@/renderer/components/diff/pierreIntegrationContract";

describe("Pierre integration ADR contract", () => {
  it("pins an exact audited package and peer contract", () => {
    expect(PIERRE_DIFFS_INTEGRATION.packageName).toBe("@pierre/diffs");
    expect(PIERRE_DIFFS_INTEGRATION.version).toBe("1.2.12");
    expect(PIERRE_DIFFS_INTEGRATION.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PIERRE_DIFFS_INTEGRATION.license).toBe("Apache-2.0");
    expect(PIERRE_DIFFS_INTEGRATION.reactPeer).toContain("^19.0.0");
    expect(PIERRE_DIFFS_INTEGRATION.versionPolicy).toBe("exact");
  });

  it("keeps experimental and structurally fragile APIs outside the boundary", () => {
    expect(PIERRE_DIFFS_INTEGRATION.forbiddenCapabilities).toEqual([
      "UnresolvedFile",
      "unsafeCSS",
    ]);
    expect(PIERRE_DIFFS_INTEGRATION.importBoundary).toBe(
      "src/renderer/components/diff/engine",
    );
    expect(PIERRE_DIFFS_INTEGRATION.approvedImports).toContain("@pierre/diffs");
    expect(PIERRE_DIFFS_INTEGRATION.coreImportPurpose).toContain("parsePatchFiles");
    expect(PIERRE_DIFFS_INTEGRATION.coreImportPurpose).toContain("CSS-variable");
  });

  it("matches package and pnpm lock metadata", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const lock = readFileSync(resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");

    expect(packageJson.dependencies?.[PIERRE_DIFFS_INTEGRATION.packageName]).toBe(
      PIERRE_DIFFS_INTEGRATION.version,
    );
    expect(lock).toContain(`'@pierre/diffs':`);
    expect(lock).toContain(`version: ${PIERRE_DIFFS_INTEGRATION.version}`);
    expect(lock).toContain(`'@pierre/diffs@${PIERRE_DIFFS_INTEGRATION.version}'`);
    expect(existsSync(resolve(process.cwd(), "package-lock.json"))).toBe(false);
  });

  it("imports the audited React entry without installing another React runtime", async () => {
    const pierre = await import("@pierre/diffs/react");
    expect(pierre.PatchDiff).toEqual(expect.any(Function));
    expect(pierre.CodeView).toBeTruthy();
    const lock = readFileSync(resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");
    const reactVersions = new Set(
      [...lock.matchAll(/^\s{2}react@(\d+\.\d+\.\d+):$/gmu)].map((match) => match[1]),
    );
    expect(reactVersions).toEqual(new Set(["19.2.7"]));
  });
});
