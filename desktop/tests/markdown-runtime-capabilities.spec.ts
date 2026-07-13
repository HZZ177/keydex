import { describe, expect, it } from "vitest";

import {
  MARKDOWN_RUNTIME_CAPABILITY_VERSION,
  evaluateMarkdownRuntimeCapabilities,
  selectMarkdownRuntimeObservationChannels,
  type MarkdownRuntimeCapabilitySnapshot,
} from "@/runtime/markdownRuntimeCapabilities";

function snapshot(overrides: Partial<MarkdownRuntimeCapabilitySnapshot> = {}): MarkdownRuntimeCapabilitySnapshot {
  return {
    schemaVersion: MARKDOWN_RUNTIME_CAPABILITY_VERSION,
    capturedAt: "2026-07-12T03:00:00+08:00",
    runtimeKind: "webview2",
    runtimeVersion: "150.0.0.0",
    userAgent: "Chrome/150 Edg/150",
    mainThread: { structuredClone: true, structuredCloneTransfer: true, textEncoder: true },
    worker: {
      available: true,
      moduleWorker: true,
      structuredClone: true,
      transferableArrayBuffer: true,
      textEncoder: true,
      error: null,
    },
    observers: {
      resizeObserver: true,
      intersectionObserver: true,
      mutationObserver: true,
      performanceObserver: true,
      supportedEntryTypes: ["longtask", "measure", "resource"],
      longTask: true,
    },
    dom: { range: true, selection: true, clipboardApi: true },
    memory: { performanceMemory: true, userAgentSpecificMemory: false },
    optional: {
      requestIdleCallback: true,
      sharedArrayBuffer: false,
      crossOriginIsolated: false,
      offscreenCanvas: true,
    },
    ...overrides,
  };
}

describe("Markdown runtime capability contract", () => {
  it("accepts the complete WebView2 capability set", () => {
    expect(evaluateMarkdownRuntimeCapabilities(snapshot())).toEqual({
      supported: true,
      requiredErrors: [],
      diagnosticWarnings: [],
    });
  });

  it("fails explicitly when one required capability is missing", () => {
    const current = snapshot({
      worker: { ...snapshot().worker, transferableArrayBuffer: false },
    });
    expect(evaluateMarkdownRuntimeCapabilities(current)).toMatchObject({
      supported: false,
      requiredErrors: ["Worker transferable ArrayBuffer is unavailable"],
    });
  });

  it("rejects an insufficient WebView2 version", () => {
    const evaluation = evaluateMarkdownRuntimeCapabilities(snapshot({ runtimeVersion: "119.0.0.0" }));
    expect(evaluation.supported).toBe(false);
    expect(evaluation.requiredErrors).toContain("WebView2 119.0.0.0 is below required major 120");
  });

  it("selects explicit fallback observation channels without changing renderer behavior", () => {
    const withoutDiagnostics = snapshot({
      observers: { ...snapshot().observers, longTask: false, supportedEntryTypes: ["measure"] },
      memory: { performanceMemory: false, userAgentSpecificMemory: false },
    });
    const evaluation = evaluateMarkdownRuntimeCapabilities(withoutDiagnostics);
    expect(evaluation.supported).toBe(true);
    expect(evaluation.diagnosticWarnings).toHaveLength(2);
    expect(selectMarkdownRuntimeObservationChannels(withoutDiagnostics, { cdpAvailable: true })).toEqual({
      timeline: "cdp-tracing",
      memory: "process-rss",
      automation: "playwright-cdp",
    });
    expect(selectMarkdownRuntimeObservationChannels(withoutDiagnostics, { cdpAvailable: false })).toEqual({
      timeline: "unavailable",
      memory: "unavailable",
      automation: "manual-only",
    });
  });

  it("allows Chrome and WebView2 snapshots to differ without treating them as the same runtime", () => {
    const chrome = snapshot({ runtimeKind: "chrome", runtimeVersion: "150.0.0.0", userAgent: "Chrome/150" });
    const webview = snapshot();
    expect(evaluateMarkdownRuntimeCapabilities(chrome).supported).toBe(true);
    expect(evaluateMarkdownRuntimeCapabilities(webview).supported).toBe(true);
    expect(chrome.runtimeKind).not.toBe(webview.runtimeKind);
  });
});
