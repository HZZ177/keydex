import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { annotationDocumentRegistry } from "@/renderer/features/annotations/chat/AnnotationDocumentRegistry";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import { assembleSelectedAnnotationContexts, useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import { fileSelectionReducer, initialFileSelectionState, type SelectedFile } from "@/renderer/components/chat/SendBox/fileSelection";
import { prepareComposerMessage } from "@/renderer/utils/messageInjection";
import type { RuntimeBridge } from "@/runtime";
import type { AnnotationRecord } from "@/runtime/annotations";

describe("annotation chat references", () => {
  it("adds single and batch references as independent chips without sending", () => {
    const openChatChannel = vi.fn();
    const runtime = { conversation: { openChatChannel } } as unknown as RuntimeBridge;
    const { result } = renderHook(() => useAgentSessionController({ runtime, enabled: false }));
    act(() => result.current.startChatFromAnnotation([
      { annotationId: "a", body: "Explain alpha", kind: "text", workspaceId: "ws", path: "doc.txt" },
      { annotationId: "b", body: "Review everything", kind: "document", workspaceId: "ws", path: "doc.txt" },
    ]));
    expect(result.current.fileChipRequest?.files).toHaveLength(2);
    expect(result.current.fileChipRequest?.files?.map((file) => file.id)).toEqual([
      "annotation:ws:a", "annotation:ws:b",
    ]);
    expect(result.current.fileChipRequest?.files?.map((file) => file.annotationReference)).toEqual([
      { annotationId: "a", body: "Explain alpha", kind: "text", path: "doc.txt", workspaceId: "ws" },
      { annotationId: "b", body: "Review everything", kind: "document", path: "doc.txt", workspaceId: "ws" },
    ]);
    expect(openChatChannel).not.toHaveBeenCalled();
  });

  it("keeps same-path references independent in file selection", () => {
    const first = annotationFile("a");
    const second = annotationFile("b");
    const state = fileSelectionReducer(
      fileSelectionReducer(initialFileSelectionState, { type: "add", file: first }),
      { type: "add", file: second },
    );
    expect(state.files).toHaveLength(2);
  });

  it("resolves chips at send time and injects no old snapshot metadata", () => {
    annotationDocumentRegistry.clear();
    const model = createPlainTextModel("alpha beta", "sha256:current");
    const records = [textRecord("a", "alpha", 0), textRecord("b", "beta", 6)];
    const registration = annotationDocumentRegistry.register({
      workspaceId: "ws", path: "doc.txt", model,
      index: resolveDocumentAnnotations(model, records),
    });
    const files = [annotationFile("a"), annotationFile("b")];
    const contexts = assembleSelectedAnnotationContexts(files);
    const prepared = prepareComposerMessage("Review", files, { annotationContexts: contexts });
    expect(contexts.map((context) => context.annotationId)).toEqual(["a", "b"]);
    expect(prepared.contextItems.map((item) => item.type)).toEqual(["annotation", "annotation"]);
    expect(prepared.runtimeParams?.message_injection).toHaveLength(2);
    const metadata = prepared.contextItems[0].metadata ?? {};
    expect(metadata.annotation_id).toBe("a");
    expect(metadata.selected_text).toBeUndefined();
    registration.dispose();
  });

  it("marks HTML document annotations as source annotations in composer payload and history", () => {
    annotationDocumentRegistry.clear();
    const model = createPlainTextModel("<main>alpha</main>", "sha256:html-current");
    const record = textRecord("html-source", "alpha", 6, "index.html");
    const registration = annotationDocumentRegistry.register({
      workspaceId: "ws",
      path: "index.html",
      model,
      index: resolveDocumentAnnotations(model, [record]),
    });
    const file = annotationFile("html-source", "index.html");

    const contexts = assembleSelectedAnnotationContexts([file]);
    const prepared = prepareComposerMessage("Compare", [file], {
      annotationContexts: contexts,
    });

    expect(contexts[0]).toMatchObject({
      annotationId: "html-source",
      sourceKind: "html_source",
      path: "index.html",
    });
    expect(prepared.contextItems[0]).toMatchObject({
      type: "annotation",
      label: "HTML 源码批注 · 选区",
      metadata: {
        annotation_id: "html-source",
        annotation_source_kind: "html_source",
        path: "index.html",
      },
    });
    expect(prepared.runtimeParams?.message_injection?.[0].content).toContain("当前内容：\nalpha");
    registration.dispose();
  });

  it("blocks atomically when any reference is missing or unresolved", () => {
    annotationDocumentRegistry.clear();
    const model = createPlainTextModel("alpha", "sha256:current");
    const registration = annotationDocumentRegistry.register({
      workspaceId: "ws", path: "doc.txt", model,
      index: resolveDocumentAnnotations(model, [textRecord("a", "alpha", 0)]),
    });
    expect(() => assembleSelectedAnnotationContexts([annotationFile("a"), annotationFile("missing")])).toThrow(/no longer exists/);
    registration.dispose();
  });
});

function annotationFile(annotationId: string, path = "doc.txt"): SelectedFile {
  return {
    id: `annotation:ws:${annotationId}`,
    path,
    name: path,
    type: "file",
    source: "workspace",
    annotationReference: { annotationId, workspaceId: "ws", path },
  };
}

function textRecord(id: string, exact: string, start: number, path = "doc.txt"): AnnotationRecord {
  return {
    id, workspace_id: "ws", document_path: path, body: `Body ${id}`,
    created_at: "2026-01-01", updated_at: "2026-01-01",
    target: { type: "text", selector: {
      position: { start, end: start + exact.length }, quote: { exact, prefix: "", suffix: "" },
      context: { containerType: "plain-text", headingPath: [] },
      textRevision: "old", documentRevision: "old",
    } },
  };
}
