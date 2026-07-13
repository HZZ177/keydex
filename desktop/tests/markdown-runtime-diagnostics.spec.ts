import { describe, expect, it, vi } from "vitest";

import { MarkdownRuntimeDiagnostics } from "@/renderer/markdownRuntime/diagnostics";

describe("Markdown Runtime diagnostics", () => {
  it("keeps a bounded, immutable, low-overhead event buffer", () => {
    const diagnostics = new MarkdownRuntimeDiagnostics({ maxEvents: 3, sampleInfoEvery: 2, now: () => 42 });
    const subscriber = vi.fn();
    diagnostics.subscribe(subscriber);
    diagnostics.subscribe(() => { throw new Error("observer failure"); });
    for (let index = 0; index < 5; index += 1) {
      diagnostics.record({
        stage: "worker",
        severity: "error",
        code: `worker failed ${index}`,
        documentId: "file:workspace:README.md",
        revision: `r${index}`,
        recovery: "restart-worker",
        detail: `failure ${index}`,
        blockId: null,
        resourceId: null,
      });
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.events.map((event) => event.revision)).toEqual(["r2", "r3", "r4"]);
    expect(snapshot).toMatchObject({ total: 5, dropped: 2, byStage: { worker: 3 }, bySeverity: { error: 3 } });
    expect(subscriber).toHaveBeenCalledTimes(5);
    expect(Object.isFrozen(snapshot.events[0])).toBe(true);
  });

  it("samples info events but never samples errors", () => {
    const diagnostics = new MarkdownRuntimeDiagnostics({ sampleInfoEvery: 3 });
    for (let index = 0; index < 7; index += 1) diagnostics.record(input("info", `scroll-${index}`));
    diagnostics.record(input("error", "fatal-1"));
    diagnostics.record(input("error", "fatal-2"));

    const snapshot = diagnostics.snapshot();
    expect(snapshot.total).toBe(9);
    expect(snapshot.events.filter((event) => event.severity === "info")).toHaveLength(3);
    expect(snapshot.events.filter((event) => event.severity === "error")).toHaveLength(2);
    expect(snapshot.dropped).toBe(4);
  });

  it("normalizes identifiers and bounds diagnostic detail without serializing payload objects", () => {
    const diagnostics = new MarkdownRuntimeDiagnostics({ sampleInfoEvery: 1 });
    diagnostics.record({
      stage: "parser",
      severity: "error",
      code: "parse failed with spaces!",
      documentId: "file\nREADME.md",
      revision: "r1\t",
      recovery: "retain-snapshot",
      detail: { source: "SECRET_MARKDOWN_BODY", nested: { content: "also secret" } },
      blockId: null,
      resourceId: null,
    });
    diagnostics.record({
      stage: "host",
      severity: "fatal",
      code: "long-error",
      documentId: null,
      revision: null,
      recovery: "retry",
      detail: new Error(`boom\n${"x".repeat(500)}`),
      blockId: null,
      resourceId: null,
    });

    const [objectEvent, errorEvent] = diagnostics.snapshot().events;
    expect(objectEvent).toMatchObject({
      code: "parse-failed-with-spaces-",
      documentId: "fileREADME.md",
      revision: "r1",
      detail: "[object Object]",
    });
    expect(JSON.stringify(objectEvent)).not.toContain("SECRET_MARKDOWN_BODY");
    expect(errorEvent.detail?.length).toBeLessThanOrEqual(256);
    expect(errorEvent.detail).not.toContain("\n");
  });
});

function input(severity: "info" | "error", code: string) {
  return {
    stage: "host" as const,
    severity,
    code,
    documentId: "file:test",
    revision: "r1",
    recovery: "none" as const,
    detail: null,
    blockId: null,
    resourceId: null,
  };
}
