import { describe, expect, it } from "vitest";

import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import { createMarkdownTextModel } from "./fixtures/annotationMarkdown";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import type { AnnotationRecord, TextSelector } from "@/runtime/annotations";

describe("ResolvedAnnotationIndex", () => {
  it("unifies document, resolved, ambiguous, and changed annotations", () => {
    const model = createPlainTextModel("alpha target beta target", "sha256:document");
    const records = [
      record("doc", { type: "document" }),
      record("resolved", { type: "text", selector: selector("alpha", 0) }),
      record("ambiguous", { type: "text", selector: selector("target", 100) }),
      record("changed", { type: "text", selector: selector("missing", 100) }),
    ];
    const index = resolveDocumentAnnotations(model, records);

    expect(index.document.map((item) => item.record.id)).toEqual(["doc"]);
    expect(index.resolved.map((item) => item.record.id)).toEqual(["resolved"]);
    expect(index.ambiguous.map((item) => item.record.id)).toEqual(["ambiguous"]);
    expect(index.changed.map((item) => item.record.id)).toEqual(["changed"]);
    expect(Object.keys(index.byId).sort()).toEqual(["ambiguous", "changed", "doc", "resolved"]);
    expect(index.ordered.map((item) => item.status)).toEqual([
      "document",
      "resolved",
      "ambiguous",
      "changed",
    ]);
  });

  it("sorts resolved annotations by logical position independently of API order", () => {
    const model = createPlainTextModel("one two three", "sha256:sort");
    const index = resolveDocumentAnnotations(model, [
      record("three", { type: "text", selector: selector("three", 8) }, "2026-01-03"),
      record("one", { type: "text", selector: selector("one", 0) }, "2026-01-02"),
      record("two", { type: "text", selector: selector("two", 4) }, "2026-01-01"),
    ]);

    expect(index.resolved.map((item) => item.record.id)).toEqual(["one", "two", "three"]);
  });

  it("attaches source and block projections from the current document model", () => {
    const source = "# Guide\n\nAlpha **target** omega";
    const model = createMarkdownTextModel(source, "sha256:markdown");
    const start = model.logicalText.indexOf("target");
    const index = resolveDocumentAnnotations(model, [
      record("target", { type: "text", selector: selector("target", start, {
        containerType: "paragraph",
        headingPath: ["Guide"],
      }) }),
    ]);
    const projection = index.resolved[0].projection;

    expect(projection.context.headingPath).toEqual(["Guide"]);
    expect(projection.blockRanges).toHaveLength(1);
    expect(projection.sourceRanges.map((range) => source.slice(range.start, range.end)).join(""))
      .toBe("target");
  });

  it("rebuilds atomically when records are added, removed, or retargeted", () => {
    const model = createPlainTextModel("alpha beta", "sha256:records");
    const alpha = record("ann", { type: "text", selector: selector("alpha", 0) });
    const first = resolveDocumentAnnotations(model, [alpha]);
    const second = resolveDocumentAnnotations(model, [
      { ...alpha, target: { type: "text", selector: selector("beta", 6) }, updated_at: "2026-02-01" },
      record("doc", { type: "document" }),
    ]);
    const third = resolveDocumentAnnotations(model, []);

    expect(first.resolved[0].projection.logicalRange).toEqual({ start: 0, end: 5 });
    expect(second.resolved[0].projection.logicalRange).toEqual({ start: 6, end: 10 });
    expect(second.annotationSetRevision).not.toBe(first.annotationSetRevision);
    expect(third.ordered).toEqual([]);
    expect(Object.keys(third.byId)).toEqual([]);
  });

  it("rejects duplicate ids rather than silently overwriting the index", () => {
    const model = createPlainTextModel("alpha", "sha256:duplicate");
    const duplicate = record("same", { type: "document" });

    expect(() => resolveDocumentAnnotations(model, [duplicate, duplicate]))
      .toThrow("Duplicate annotation id");
  });
});

function record(
  id: string,
  target: AnnotationRecord["target"],
  createdAt = "2026-01-01",
): AnnotationRecord {
  return {
    id,
    workspace_id: "ws-1",
    document_path: "README.md",
    target,
    body: `Body ${id}`,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function selector(
  exact: string,
  start: number,
  context: TextSelector["context"] = { containerType: "source", headingPath: [] },
): TextSelector {
  return {
    position: { start, end: start + exact.length },
    quote: { exact, prefix: "", suffix: "" },
    context,
    textRevision: "old-text",
    documentRevision: "old-document",
  };
}
