import { describe, expect, it } from "vitest";

import {
  assertKeydexBaselineCanSign,
  validateKeydexBaselineReport,
  type KeydexBaselineSurface,
} from "./fixtures/keydexBaseline";

function report(surface: KeydexBaselineSurface = "chrome-vite") {
  const metric = { raw: [1, 2, 3], count: 3, min: 1, p50: 2, p95: 3, p99: 3, max: 3 };
  const diagnostics = { documentNodeCount: 100, mountedBlocks: 10, totalBlocks: 1000, jsHeapUsedBytes: 1024 };
  return {
    schemaVersion: "keydex-markdown-baseline/v1",
    surface,
    signingScope: surface === "chrome-vite" ? "trend-only" : "product-baseline",
    sampleCount: 3,
    frameCount: 300,
    environment: {
      os: "Windows",
      cpu: "CPU",
      memoryBytes: 1024,
      productRevision: "revision",
      pythonRuntime: "Python 3.11",
      pythonSidecar: surface === "chrome-vite" ? "e2e-fastapi-sidecar" : "packaged-agent-server",
      browser: {
        userAgent: surface === "chrome-vite" ? "Chrome/150" : "Chrome/150 Edg/150",
      },
    },
    readFailure: { message: "read failed" },
    cases: [{
      status: "passed",
      fixture: { id: "mixed-250k", hash: "fixture-hash" },
      cold: { open: metric, reveal: metric, scroll: metric, diagnostics },
      warm: { open: metric, reveal: metric, scroll: metric, diagnostics },
    }],
  };
}

describe("Keydex Chrome and WebView2 baseline contract", () => {
  it("accepts independent reports with raw samples and p50/p95/p99", () => {
    expect(validateKeydexBaselineReport(report("chrome-vite"))).toEqual({ valid: true, errors: [] });
    expect(validateKeydexBaselineReport(report("tauri-webview2"))).toEqual({ valid: true, errors: [] });
  });

  it("does not let Chrome sign the desktop product baseline", () => {
    expect(() => assertKeydexBaselineCanSign(report("chrome-vite"), "desktop-product")).toThrow(
      "chrome-vite cannot sign desktop-product",
    );
    expect(() => assertKeydexBaselineCanSign(report("tauri-webview2"), "chrome-trend")).toThrow(
      "tauri-webview2 cannot sign chrome-trend",
    );
    expect(() => assertKeydexBaselineCanSign(report("tauri-webview2"), "desktop-product")).not.toThrow();
  });

  it("fails explicitly when environment or WebView2 identity is missing", () => {
    const missingEnvironment = report("tauri-webview2");
    missingEnvironment.environment.pythonRuntime = "";
    missingEnvironment.environment.browser.userAgent = "Chrome/150";
    const validation = validateKeydexBaselineReport(missingEnvironment);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("environment.pythonRuntime is required");
    expect(validation.errors).toContain("desktop product baseline must identify the WebView2/Edge runtime");
  });

  it("rejects a single-number metric without repeated raw samples", () => {
    const single = report();
    single.cases[0].cold.open = { ...single.cases[0].cold.open, raw: [1], count: 1 };
    const validation = validateKeydexBaselineReport(single);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("cases[0].cold.open requires raw samples");
  });

  it("preserves explicit failed cases instead of fabricating percentile results", () => {
    const failed = report();
    (failed as unknown as { cases: unknown[] }).cases = [{
      status: "failed",
      fixture: { id: "mixed-10m", hash: "fixture-hash" },
      error: "tail reveal timed out",
    }];
    expect(validateKeydexBaselineReport(failed)).toEqual({ valid: true, errors: [] });
  });
});
