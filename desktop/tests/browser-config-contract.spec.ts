import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_CONFIG_SCHEMA_VERSION,
  BROWSER_FEATURE_FLAGS,
  BROWSER_LIMITS,
  BROWSER_PROTOCOL_VERSIONS,
  parseBrowserContractFixture,
  resolveBrowserFeatureFlags,
} from "../src/renderer/features/browser/config";

const fixturePath = resolve(
  process.cwd(),
  "..",
  "test-fixtures",
  "sidebar-browser",
  "contracts",
  "browser-config-v1.json",
);

function readFixture(): unknown {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describe("browser config contract", () => {
  it("keeps protocol versions, limits, and release defaults aligned with the shared fixture", () => {
    const parsed = parseBrowserContractFixture(readFixture());

    expect(parsed.schemaVersion).toBe(BROWSER_CONFIG_SCHEMA_VERSION);
    expect(parsed.protocols).toEqual(BROWSER_PROTOCOL_VERSIONS);
    expect(parsed.limits).toEqual(BROWSER_LIMITS);
    expect(parsed.releaseFeatureFlags).toEqual({
      browserEnabled: true,
      annotationsEnabled: true,
      internalProbeEnabled: false,
    });
  });

  it("rejects unknown versions and extra fields", () => {
    const fixture = readFixture();
    expect(() => parseBrowserContractFixture({ ...(fixture as object), schemaVersion: 2 })).toThrow(
      "schema version is unsupported",
    );
    expect(() => parseBrowserContractFixture({ ...(fixture as object), agentBrowserEnabled: true })).toThrow(
      "fields are invalid",
    );
  });

  it("enables the finished product by default and keeps the internal probe out of production", () => {
    expect(BROWSER_FEATURE_FLAGS).toEqual({
      browserEnabled: true,
      annotationsEnabled: true,
      internalProbeEnabled: true,
    });
    expect(resolveBrowserFeatureFlags("development")).toEqual({
      browserEnabled: true,
      annotationsEnabled: true,
      internalProbeEnabled: true,
    });
    expect(resolveBrowserFeatureFlags("production")).toEqual({
      browserEnabled: true,
      annotationsEnabled: true,
      internalProbeEnabled: false,
    });
  });

  it("never exposes annotations without the browser product flag", () => {
    expect(resolveBrowserFeatureFlags("production", {
      VITE_KEYDEX_BROWSER_ENABLED: "0",
      VITE_KEYDEX_BROWSER_ANNOTATIONS_ENABLED: "1",
    })).toEqual({
      browserEnabled: false,
      annotationsEnabled: false,
      internalProbeEnabled: false,
    });
  });
});
