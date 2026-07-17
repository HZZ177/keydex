import { describe, expect, it } from "vitest";

import {
  fileReviewDocumentFromChanges,
  fileReviewDocumentFromMessage,
} from "@/renderer/components/diff/adapters/fileReviewDocument";
import type { FileReviewChange } from "@/renderer/utils/fileReview";

const unified = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function change(overrides: Partial<FileReviewChange> = {}): FileReviewChange {
  return {
    path: "src/a.ts",
    additions: 1,
    deletions: 1,
    diff: unified,
    operation: "update",
    source: "final",
    ...overrides,
  };
}

describe("file review document adapter", () => {
  it("maps the legacy wire shape immediately to the shared document", () => {
    const document = fileReviewDocumentFromChanges([change()], { sessionId: "s1" });
    expect(document).toMatchObject({ source: "agent", files: [{ status: "modified", language: "typescript" }] });
    expect(document.files[0]?.hunks).toHaveLength(1);
  });

  it("prefers final data over streaming data and does not duplicate a file", () => {
    const document = fileReviewDocumentFromChanges([
      change({ source: "streaming", diff: unified.replace("+new", "+partial") }),
      change({ source: "final", additions: 2, diff: unified.replace("+new", "+complete\n+second") }),
      change({ source: "streaming", diff: unified.replace("+new", "+stale") }),
    ]);
    expect(document.files).toHaveLength(1);
    expect(document.files[0]?.patch).toContain("+complete");
    expect(document.files[0]?.additions).toBe(2);
  });

  it("preserves move old/new paths and metadata-only semantics", () => {
    const document = fileReviewDocumentFromChanges([
      change({ path: "new.ts", oldPath: "old.ts", newPath: "new.ts", operation: "move", diff: "" }),
    ]);
    expect(document.files[0]).toMatchObject({
      oldPath: "old.ts",
      newPath: "new.ts",
      status: "renamed",
      precision: "approximate",
      selectableForPatch: false,
    });
  });

  it("synthesizes content-only new files without guessing unknown updates are additions", () => {
    const added = fileReviewDocumentFromChanges([
      change({ path: "new.py", newPath: "new.py", operation: "add", diff: "", content: "print('ok')" }),
    ]);
    const updated = fileReviewDocumentFromChanges([
      change({ operation: "update", diff: "", content: "replacement" }),
    ]);
    expect(added.files[0]).toMatchObject({ status: "added", language: "python" });
    expect(added.files[0]?.patch).toContain("--- /dev/null");
    expect(updated.files[0]).toMatchObject({ status: "modified", precision: "approximate" });
  });

  it("keeps Apply Patch streaming input approximate and non-selectable", () => {
    const document = fileReviewDocumentFromChanges([
      change({ diff: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n", source: "streaming" }),
    ]);
    expect(document.files[0]).toMatchObject({ precision: "approximate", selectableForPatch: false });
    expect(document.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "incomplete_apply_patch" })]),
    );
  });

  it("accepts historical message payload fields through the compatibility reader", () => {
    const message = {
      payload: {
        tool: "edit_file",
        status: "completed",
        result: { path: "src/a.ts", diff: unified, additions: 1, deletions: 1 },
      },
    } as never;
    const document = fileReviewDocumentFromMessage(message);
    expect(document.files).toHaveLength(1);
    expect(document.files[0]?.displayPath).toBe("src/a.ts");
  });

  it("preserves canonical final binary and truncation fields from new tool results", () => {
    const binaryMessage = {
      payload: {
        tool: "delete_file",
        status: "completed",
        result: {
          files: [{
            path: "asset.bin",
            operation: "delete",
            status: "deleted",
            binary: true,
            truncated: false,
            raw_patch: null,
            additions: 0,
            deletions: 0,
            patch_precision: "exact",
          }],
        },
      },
    } as never;
    const binary = fileReviewDocumentFromMessage(binaryMessage);
    expect(binary.files[0]).toMatchObject({
      status: "deleted",
      contentKind: "binary",
      binary: true,
      truncated: false,
      selectableForPatch: false,
    });

    const truncated = fileReviewDocumentFromChanges([
      change({ truncated: true, patchPrecision: "exact" }),
    ]);
    expect(truncated.files[0]).toMatchObject({ truncated: true, selectableForPatch: false });
  });
});
