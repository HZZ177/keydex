import { describe, expect, it } from "vitest";

import { reverseDocumentFromFiles } from "@/renderer/components/diff/adapters/reverseDocument";
import type { SessionReverseFilePreview } from "@/runtime/conversation";

function preview(overrides: Partial<SessionReverseFilePreview> = {}): SessionReverseFilePreview {
  return {
    resource_id: "resource-a",
    scope_kind: "workspace",
    scope_identity: "workspace-current",
    scope_label: "当前项目",
    display_path: "src/a.ts",
    absolute_path: "D:/repo/src/a.ts",
    requires_full_access: false,
    path: "src/a.ts",
    current_state: "file",
    target_state: "file",
    classification: "ready",
    binary: false,
    truncated: false,
    insertions: 1,
    deletions: 1,
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-current\n+target\n",
    raw_patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-current\n+target\n",
    patch_direction: "current_to_target",
    patch_precision: "exact",
    patch_complete: true,
    ...overrides,
  };
}

describe("reverse diff document adapter", () => {
  it("preserves current-to-target colors and trusted statistics", () => {
    const document = reverseDocumentFromFiles([preview()], "operation-1");
    expect(document.files[0]).toMatchObject({
      status: "modified",
      additions: 1,
      deletions: 1,
      precision: "exact",
      selectableForPatch: false,
    });
    expect(document.files[0]?.patch).toContain("-current\n+target");
  });

  it.each([
    ["missing", "file", "added"],
    ["file", "missing", "deleted"],
  ])("maps %s to %s as %s", (currentState, targetState, status) => {
    const document = reverseDocumentFromFiles([
      preview({ current_state: currentState, target_state: targetState, status: undefined, diff: null, raw_patch: null }),
    ], "operation-state");
    expect(document.files[0]?.status).toBe(status);
  });

  it("never constructs a pseudo patch for binary or truncated previews", () => {
    const document = reverseDocumentFromFiles([
      preview({ resource_id: "binary", binary: true, content_kind: "binary", diff: null, raw_patch: null }),
      preview({
        resource_id: "large",
        display_path: "large.ts",
        path: "large.ts",
        truncated: true,
        truncation_state: "unrecoverable",
        truncation_reason: "render_limit",
        patch_complete: false,
        diff: "-partial",
        raw_patch: null,
      }),
    ], "operation-safe");
    expect(document.files.map((file) => file.patch)).toEqual(["", ""]);
    expect(document.files.every((file) => !file.selectableForPatch)).toBe(true);
    expect(document.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "reverse_preview_truncated" })]),
    );
  });

  it("wraps legacy current-to-target line fragments as approximate display-only patches", () => {
    const document = reverseDocumentFromFiles([
      preview({ raw_patch: null, patch_precision: undefined, diff: "-current\n+target" }),
    ], "operation-legacy");
    expect(document.files[0]).toMatchObject({
      precision: "approximate",
      selectableForPatch: false,
    });
    expect(document.files[0]?.patch).toContain("--- a/src/a.ts\n+++ b/src/a.ts");
    expect(document.files[0]?.patch).toContain("-current\n+target");
  });
});
