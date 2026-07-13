import { describe, expect, it, vi } from "vitest";

import {
  MarkdownPerformanceRecorder,
  summarizeMarkdownPerformance,
  type MarkdownPerformanceContext,
} from "@/renderer/markdownRuntime/diagnostics/performanceMetrics";

const context: MarkdownPerformanceContext = Object.freeze({
  runId: "run-fixture-001",
  surface: "file",
  cacheMode: "cold",
  fixture: Object.freeze({
    id: "mixed-250k",
    generatorVersion: "markdown-runtime-fixtures/v1",
    hash: "sha256-fixture",
    bytes: 256_000,
    lines: 2_000,
    blocks: 500,
  }),
  environment: Object.freeze({
    os: "Windows 11",
    appVersion: "test",
    webviewRuntime: "test-webview2",
    pythonRuntime: "3.11-test",
    cpu: "test-cpu",
    logicalCpuCount: 8,
    memoryBytes: 16 * 1024 ** 3,
    gpu: "test-gpu",
    driver: "test-driver",
    windowWidth: 1440,
    windowHeight: 900,
    devicePixelRatio: 1.25,
  }),
});

function clock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe("Markdown performance metrics protocol", () => {
  it("records ordered phase marks and derives phase durations", () => {
    const recorder = new MarkdownPerformanceRecorder(context, {
      enabled: true,
      now: clock(0, 2, 8, 9, 13, 15, 16),
    });
    recorder.mark("request_start");
    recorder.mark("file_read_start");
    recorder.mark("file_read_end");
    recorder.mark("snapshot_published");
    recorder.mark("viewport_patch_end");
    recorder.mark("first_visible_content", { contentKind: "text" });
    recorder.markResourcesSettled(0, 0);

    expect(recorder.duration("file_read_start", "file_read_end")).toBe(6);
    const snapshot = recorder.finalize([
      "request_start",
      "file_read_start",
      "file_read_end",
      "first_visible_content",
      "resource_settled",
    ]);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.context.fixture.hash).toBe("sha256-fixture");
    expect(snapshot.context.cacheMode).toBe("cold");
  });

  it("reports every missing required mark", () => {
    const recorder = new MarkdownPerformanceRecorder(context, { enabled: true, now: () => 1 });
    recorder.mark("request_start");

    const snapshot = recorder.finalize(["request_start", "first_visible_content", "first_paint"]);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues.filter((issue) => issue.code === "missing_mark").map((issue) => issue.entryName)).toEqual([
      "first_visible_content",
      "first_paint",
    ]);
  });

  it("rejects duplicate marks and preserves the first timestamp", () => {
    const recorder = new MarkdownPerformanceRecorder(context, { enabled: true, now: clock(10, 20) });
    expect(recorder.mark("request_start")).toBe(true);
    expect(recorder.mark("request_start")).toBe(false);

    const snapshot = recorder.finalize();
    expect(snapshot.marks).toHaveLength(1);
    expect(snapshot.marks[0].atMs).toBe(10);
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({ code: "duplicate_mark", entryName: "request_start" }),
    );
  });

  it("rejects a reversed clock without publishing the out-of-order entry", () => {
    const recorder = new MarkdownPerformanceRecorder(context, { enabled: true, now: clock(20, 19) });
    recorder.mark("request_start");
    expect(recorder.mark("file_read_start")).toBe(false);

    const snapshot = recorder.finalize();
    expect(snapshot.marks.map((mark) => mark.name)).toEqual(["request_start"]);
    expect(snapshot.issues).toContainEqual(expect.objectContaining({ code: "clock_reversed" }));
  });

  it("does not accept skeleton or empty UI as first visible content", () => {
    const recorder = new MarkdownPerformanceRecorder(context, { enabled: true, now: clock(1, 2) });
    expect(recorder.mark("first_visible_content", { contentKind: "skeleton" })).toBe(false);
    expect(recorder.mark("first_visible_content", { contentKind: "text" })).toBe(true);

    expect(recorder.finalize().issues).toContainEqual(
      expect.objectContaining({ code: "invalid_first_visible_content" }),
    );
  });

  it("settles documents with no resources and documents with failed resources", () => {
    const empty = new MarkdownPerformanceRecorder(context, { enabled: true, now: () => 1 });
    expect(empty.markResourcesSettled(0, 0)).toBe(true);
    expect(empty.finalize(["resource_settled"]).marks[0].details).toMatchObject({ total: 0, failed: 0 });

    const failed = new MarkdownPerformanceRecorder(context, { enabled: true, now: () => 1 });
    expect(failed.markResourcesSettled(3, 2)).toBe(true);
    expect(failed.finalize(["resource_settled"]).valid).toBe(true);

    const invalid = new MarkdownPerformanceRecorder(context, { enabled: true, now: () => 1 });
    expect(invalid.markResourcesSettled(1, 2)).toBe(false);
    expect(invalid.finalize().issues).toContainEqual(expect.objectContaining({ code: "invalid_resource_state" }));
  });

  it("is a clock-free no-op when diagnostics are disabled", () => {
    const now = vi.fn(() => 1);
    const recorder = new MarkdownPerformanceRecorder(context, { now });
    expect(recorder.mark("request_start")).toBe(false);
    expect(recorder.event("reveal_requested")).toBe(false);
    expect(recorder.sample("dom.node_count", 10, "count")).toBe(false);

    const snapshot = recorder.finalize(["request_start"]);
    expect(now).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({ enabled: false, valid: false, marks: [], events: [], samples: [] });
  });

  it("keeps high-cost samples behind full detail and calculates p50/p95/p99", () => {
    const marksOnly = new MarkdownPerformanceRecorder(context, { enabled: true, now: () => 1 });
    expect(marksOnly.sample("dom.node_count", 100, "count")).toBe(false);

    const full = new MarkdownPerformanceRecorder(context, { enabled: true, detailLevel: "full", now: () => 1 });
    expect(full.sample("dom.node_count", 100, "count")).toBe(true);
    expect(full.finalize().samples).toHaveLength(1);

    const summary = summarizeMarkdownPerformance(Array.from({ length: 100 }, (_value, index) => index + 1));
    expect(summary).toEqual({ count: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100 });
  });
});

