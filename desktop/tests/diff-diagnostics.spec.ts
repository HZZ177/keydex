import { describe, expect, it } from "vitest";

import {
  DIFF_UNSAFE_INPUT_BYTES,
  diffDiagnosticPresentation,
  diffRuntimeFailureDocument,
  normalizeDiffSafely,
} from "@/renderer/components/diff/diagnostics";

describe("safe diff diagnostics", () => {
  it.each([
    ["", "empty"],
    ["not a patch", "malformed"],
    ["diff --cc a.ts\n@@@ -1,1 -1,1 +1,1 @@@\n", "unsupported"],
    ["*** Begin Patch\n*** Update File: a.ts\n@@\n-a", "partial"],
  ])("classifies input without throwing or invoking a legacy renderer", (raw, code) => {
    const result = normalizeDiffSafely(raw);
    expect(result.fallback).toBe("none");
    expect(result.document.files).toHaveLength(0);
    expect(result.document.diagnostics[0]?.code).toBe(code);
    expect(result.rawSource).toBe(raw);
  });

  it("rejects unsafe-size input before parsing", () => {
    const raw = `diff --git a/a b/a\n${"x".repeat(DIFF_UNSAFE_INPUT_BYTES + 1)}`;
    const result = normalizeDiffSafely(raw);
    expect(result.document.diagnostics[0]).toMatchObject({ code: "unsafe_size" });
  });

  it.each(["adapter_failure", "worker_failure"] as const)("presents %s as a retryable Chinese error", (kind) => {
    const document = diffRuntimeFailureDocument(kind, { source: "agent" });
    const presentation = diffDiagnosticPresentation(document.diagnostics[0]!);
    expect(presentation).toMatchObject({ retryable: true, allowCopyRawSource: true });
    expect(presentation.title).toMatch(/[\u4e00-\u9fff]/u);
  });

  it("does not embed raw source or third-party exception text in diagnostics", () => {
    const secret = "diff --cc secret-token.ts\n@@@ secret-token @@@";
    const result = normalizeDiffSafely(secret);
    expect(JSON.stringify(result.document)).not.toContain("secret-token");
    expect(result.rawSource).toBe(secret);
  });

  it("still returns a normal document for supported input", () => {
    const raw = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const result = normalizeDiffSafely(raw);
    expect(result.document.files).toHaveLength(1);
    expect(result.document.diagnostics.some((item) => item.code === "malformed")).toBe(false);
  });
});
