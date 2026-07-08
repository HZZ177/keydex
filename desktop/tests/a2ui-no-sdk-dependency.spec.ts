import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const packageFiles = ["package.json", "desktop/package.json"];
const lockFiles = ["pnpm-lock.yaml", "desktop/pnpm-lock.yaml", "desktop/package-lock.json"];
const forbiddenPackages = ["@yongce/a2ui-pc", "@yongce/a2ui-core"];
const forbiddenLockPatterns = [
  ...forbiddenPackages,
  ...forbiddenPackages.map((packageName) => packageName.replace("/", "%2f")),
];

describe("A2UI SDK dependency guard", () => {
  it("does not declare platform SDK packages in package manifests", () => {
    const violations: string[] = [];

    for (const relativePath of packageFiles) {
      const filePath = path.join(repoRoot, relativePath);
      if (!existsSync(filePath)) {
        continue;
      }
      const manifest = JSON.parse(readFileSync(filePath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const dependencyNames = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]);
      for (const packageName of forbiddenPackages) {
        if (dependencyNames.has(packageName)) {
          violations.push(`${relativePath}:${packageName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not lock platform SDK packages transitively", () => {
    const violations: string[] = [];

    for (const relativePath of lockFiles) {
      const filePath = path.join(repoRoot, relativePath);
      if (!existsSync(filePath)) {
        continue;
      }
      const lockContent = readFileSync(filePath, "utf8").toLowerCase();
      for (const packagePattern of forbiddenLockPatterns) {
        if (lockContent.includes(packagePattern.toLowerCase())) {
          violations.push(`${relativePath}:${packagePattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
