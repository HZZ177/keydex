import { describe, expect, it } from "vitest";

import { AnnotationContextAssemblyError, assembleAnnotationContexts } from "@/renderer/features/annotations/chat/AnnotationContextAssembler";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import type { AnnotationRecord } from "@/runtime/annotations";

describe("AnnotationContextAssembler", () => {
  it("assembles resolved text only from the current model and projection", () => {
    const model = createPlainTextModel("before target after", "sha256:current");
    const record = textRecord("a", "target", 7);
    const index = resolveDocumentAnnotations(model, [record]);
    const [context] = assembleAnnotationContexts([reference("a")], document(model, index));
    expect(context).toMatchObject({ kind: "text", exact: "target", sourceRanges: [{ start: 7, end: 13 }], textRevision: model.revision.textRevision });
  });

  it("uses the current whole file for document annotations", () => {
    const model = createPlainTextModel("current file", "sha256:current");
    const record: AnnotationRecord = { ...baseRecord("doc"), target: { type: "document" } };
    const [context] = assembleAnnotationContexts([reference("doc")], document(model, resolveDocumentAnnotations(model, [record])));
    expect(context).toMatchObject({ kind: "document", content: "current file", documentRevision: "sha256:current" });
  });

  it("accepts surrounding edits when exact text still resolves", () => {
    const before = createPlainTextModel("target", "sha256:before");
    const record = textRecord("a", "target", 0, before.revision.textRevision);
    const current = createPlainTextModel("prefix target suffix", "sha256:after");
    const [context] = assembleAnnotationContexts([reference("a")], document(current, resolveDocumentAnnotations(current, [record])));
    expect(context).toMatchObject({ kind: "text", exact: "target", documentRevision: "sha256:after" });
  });

  it.each(["ambiguous", "changed"] as const)("blocks %s text explicitly", (status) => {
    const source = status === "ambiguous" ? "target x target" : "replacement";
    const model = createPlainTextModel(source, `sha256:${status}`);
    const record = textRecord("a", "target", 50);
    const index = resolveDocumentAnnotations(model, [record]);
    expect(() => assembleAnnotationContexts([reference("a")], document(model, index))).toThrowError(AnnotationContextAssemblyError);
    try {
      assembleAnnotationContexts([reference("a")], document(model, index));
    } catch (error) {
      expect((error as AnnotationContextAssemblyError).code).toBe(`annotation-${status}`);
    }
  });

  it("fails a mixed batch atomically", () => {
    const model = createPlainTextModel("target", "sha256:current");
    const index = resolveDocumentAnnotations(model, [textRecord("a", "target", 0)]);
    expect(() => assembleAnnotationContexts([reference("a"), reference("missing")], document(model, index))).toThrowError(/no longer exists/);
  });
});

function document(model: ReturnType<typeof createPlainTextModel>, index: ReturnType<typeof resolveDocumentAnnotations>) {
  return { workspaceId: "ws", path: "doc.txt", model, index };
}
function reference(annotationId: string) { return { annotationId, workspaceId: "ws", path: "doc.txt" }; }
function baseRecord(id: string): Omit<AnnotationRecord, "target"> {
  return { id, workspace_id: "ws", document_path: "doc.txt", body: `Body ${id}`, created_at: "2026-01-01", updated_at: "2026-01-01" };
}
function textRecord(id: string, exact: string, start: number, revision = "sha256:old"): AnnotationRecord {
  return { ...baseRecord(id), target: { type: "text", selector: { position: { start, end: start + exact.length }, quote: { exact, prefix: "", suffix: "" }, context: { containerType: "plain-text", headingPath: [] }, textRevision: revision, documentRevision: revision } } };
}
