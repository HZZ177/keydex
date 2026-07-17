import { describe, expect, it } from "vitest";

import {
  diffDocumentRawSource,
  normalizeDiffPreviewRequest,
} from "@/renderer/components/diff/adapters/previewDocument";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("Diff preview request contract", () => {
  it("upgrades explicit diff requests and keeps the original copy source", () => {
    const request = normalizeDiffPreviewRequest({ type: "diff", path: "changes/a.patch", diff: patch });
    expect(request.type).toBe("diff-document");
    if (request.type !== "diff-document") throw new Error("expected diff document");
    expect(request.title).toBe("a.patch");
    expect(request.sourcePath).toBe("changes/a.patch");
    expect(request.document.files).toHaveLength(1);
    expect(diffDocumentRawSource(request)).toBe(patch);
  });

  it("upgrades content and Skill resource diff variants", () => {
    const content = normalizeDiffPreviewRequest({
      type: "content",
      title: "代码差异",
      content: patch,
      contentType: "diff",
      sourcePath: "src/a.ts",
    });
    const skill = normalizeDiffPreviewRequest({
      type: "skill-resource",
      title: "示例补丁",
      content: patch,
      contentType: "diff",
      skillName: "demo",
      skillSource: "workspace",
      resourcePath: "examples/a.patch",
      locator: "demo",
      revision: "v1",
    });
    expect(content.type).toBe("diff-document");
    expect(skill).toMatchObject({
      type: "diff-document",
      sourcePath: "examples/a.patch",
      sourceLabel: "Skill · demo/examples/a.patch",
    });
  });

  it("does not misclassify normal source content or unloaded patch files", () => {
    const source = { type: "content" as const, title: "a.ts", content: "const a = 1", contentType: "code" as const };
    const file = { type: "file" as const, path: "changes.patch" };
    expect(normalizeDiffPreviewRequest(source)).toBe(source);
    expect(normalizeDiffPreviewRequest(file)).toBe(file);
  });

  it("keeps document identity stable and changes its version when content changes", () => {
    const first = normalizeDiffPreviewRequest({ type: "diff", path: "a.patch", diff: patch });
    const same = normalizeDiffPreviewRequest({ type: "diff", path: "a.patch", diff: patch });
    const changed = normalizeDiffPreviewRequest({ type: "diff", path: "a.patch", diff: patch.replace("+b", "+c") });
    if (first.type !== "diff-document" || same.type !== "diff-document" || changed.type !== "diff-document") throw new Error("expected documents");
    expect(first.document.id).toBe(same.document.id);
    expect(first.document.sourceVersion).toBe(same.document.sourceVersion);
    expect(changed.document.sourceVersion).not.toBe(first.document.sourceVersion);
  });
});
