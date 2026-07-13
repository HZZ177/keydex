import { describe, expect, it, vi } from "vitest";

import { AnnotationResolver } from "@/renderer/features/annotations/anchoring/AnnotationResolver";
import { createTextSelector } from "@/renderer/features/annotations/anchoring/createTextSelector";
import {
  DocumentWorkerAnnotationResolver,
  type AnnotationDocumentWorkerResolveInput,
  type AnnotationDocumentWorkerResolver,
} from "@/renderer/features/annotations/anchoring/DocumentWorkerAnnotationResolver";
import { resolveAnnotationPayload } from "@/renderer/features/annotations/anchoring/annotationResolverProtocol";
import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import type { DocumentTextModel } from "@/renderer/features/annotations/document/DocumentTextModel";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import type { MarkdownWorkerRequest } from "@/renderer/markdownRuntime/worker/protocol";
import type { AnnotationRecord } from "@/runtime/annotations";
import { annotationMarkdownSnapshot, createMarkdownTextModel } from "./fixtures/annotationMarkdown";

describe("AnnotationResolver shared Document Worker and cache", () => {
  it("keeps Document Worker core output identical to the synchronous pure function", () => {
    const model = createMarkdownTextModel("# Guide\n\nalpha target", "sha256:doc");
    const records = [textRecord("ann", "target", model.logicalText.indexOf("target"))];
    const synchronous = resolveDocumentAnnotations(model, records);
    const workerCore = resolveAnnotationPayload({
      document: {
        kind: "markdown",
        rawSource: model.rawSource,
        documentRevision: "sha256:doc",
        markdownProjection: model.logicalDocument(),
      },
      records,
    });

    expect(workerCore).toEqual(synchronous);
  });

  it("resolves small inputs synchronously without calling the Document Worker", async () => {
    const documentWorker = new FakeDocumentWorkerResolver(true);
    const resolver = new AnnotationResolver({ documentWorker });
    const model = createPlainTextModel("alpha", "sha256:small");

    await expect(resolver.resolve(input(model, []))).resolves.toMatchObject({ ordered: [] });
    expect(documentWorker.calls).toHaveLength(0);
  });

  it("delegates large Snapshot-backed Markdown and caches every revision dimension", async () => {
    const documentWorker = new FakeDocumentWorkerResolver(true);
    const resolver = new AnnotationResolver({ largeDocumentCharacters: 1, documentWorker });
    const model = createMarkdownTextModel("alpha", "sha256:large");
    const request = input(model, [textRecord("ann", "alpha", 0)]);
    const first = await resolver.resolve(request);
    const cached = await resolver.resolve(request);

    expect(first).toEqual(cached);
    expect(documentWorker.calls).toHaveLength(1);

    await resolver.resolve({ ...request, path: "other.md" });
    await resolver.resolve({ ...request, records: [textRecord("ann-2", "alpha", 0)] });
    expect(documentWorker.calls).toHaveLength(3);
  });

  it("does not reuse source/block projections across document revisions with identical logical text", async () => {
    const documentWorker = new FakeDocumentWorkerResolver(true);
    const resolver = new AnnotationResolver({ largeDocumentCharacters: 1, documentWorker });
    const bold = createMarkdownTextModel("Use **target**.", "sha256:bold");
    const italic = createMarkdownTextModel("Use _target_.", "sha256:italic");
    expect(italic.revision.textRevision).toBe(bold.revision.textRevision);
    const record = textRecord("ann", "target", bold.logicalText.indexOf("target"));

    const first = await resolver.resolve(input(bold, [record]));
    const second = await resolver.resolve(input(italic, [record]));

    expect(documentWorker.calls).toHaveLength(2);
    expect(first.resolved[0]?.projection.sourceRanges).not.toEqual(second.resolved[0]?.projection.sourceRanges);
  });

  it("never delegates a legacy/plain model even when it exceeds the large threshold", async () => {
    const documentWorker = new FakeDocumentWorkerResolver(true);
    const resolver = new AnnotationResolver({ largeDocumentCharacters: 1, documentWorker });
    const model = createPlainTextModel("alpha", "sha256:legacy");

    await expect(resolver.resolve(input(model, [textRecord("ann", "alpha", 0)])))
      .resolves.toMatchObject({ resolved: [{ record: { id: "ann" }, status: "resolved" }] });
    expect(documentWorker.calls).toHaveLength(0);
  });

  it.each([
    ["insertion before", "prefix target phrase suffix", "new prefix prefix target phrase suffix"],
    ["deletion before", "prefix target phrase suffix", "target phrase suffix"],
    ["block move", "# H\n\nalpha\n\ntarget phrase\n\nomega", "# H\n\nomega\n\ntarget phrase\n\nalpha"],
    ["block split", "before target phrase after", "before\n\ntarget phrase after"],
    ["block merge", "before\n\ntarget phrase after", "before target phrase after"],
    ["CRLF", "# H\r\n\r\nbefore target phrase after", "# H\r\n\r\ninserted\r\n\r\nbefore target phrase after"],
    ["Chinese and emoji", "前缀 中文🚀目标 后缀", "新增🙂 前缀 中文🚀目标 后缀"],
    ["fenced code", "```ts\nconst target = true\n```", "# Code\n\n```ts\nconst target = true\n```"],
    ["table", "| name | value |\n| --- | --- |\n| target phrase | 1 |", "# Table\n\n| name | value |\n| --- | --- |\n| target phrase | 1 |"],
    ["list", "- alpha\n- target phrase\n- omega", "- omega\n- target phrase\n- alpha"],
    ["link", "Read [target phrase](README.md) now", "Intro\n\nRead [target phrase](other.md) now"],
  ])("preserves exact anchor and block-local projection through %s", async (_label, beforeSource, afterSource) => {
    const before = createMarkdownTextModel(beforeSource, `before:${_label}`);
    const exact = _label === "fenced code" ? "const target = true" : _label === "Chinese and emoji"
      ? "中文🚀目标" : "target phrase";
    const start = before.logicalText.indexOf(exact);
    expect(start).toBeGreaterThanOrEqual(0);
    const record = recordWithSelector("ann", createTextSelector(before, { start, end: start + exact.length }));
    const after = createMarkdownTextModel(afterSource, `after:${_label}`);
    const documentWorker = new FakeDocumentWorkerResolver(true);
    const resolver = new AnnotationResolver({ largeDocumentCharacters: 1, documentWorker });

    const result = await resolver.resolve(input(after, [record]));

    expect(result.byId.ann.status).toBe("resolved");
    const resolved = result.byId.ann;
    if (resolved.status !== "resolved") throw new Error(`Expected resolved, got ${resolved.status}`);
    expect(after.logicalText.slice(resolved.projection.logicalRange.start, resolved.projection.logicalRange.end))
      .toBe(exact);
    expect(resolved.projection.blockRanges.length).toBeGreaterThan(0);
    expect(resolved.projection.blockRanges.every((projection) => projection.blockKey.length > 0)).toBe(true);
    expect(documentWorker.calls).toHaveLength(1);
  });

  it("preserves ambiguous and changed/orphan-compatible outcomes in the shared Worker", async () => {
    const duplicate = createMarkdownTextModel("target phrase / target phrase", "sha256:duplicate");
    const missing = createMarkdownTextModel("the selected content disappeared", "sha256:missing");
    const ambiguousRecord = textRecord("ambiguous", "target phrase", 100);
    const changedRecord = textRecord("changed", "target phrase", 100);
    const documentWorker = new FakeDocumentWorkerResolver(true);
    const resolver = new AnnotationResolver({ largeDocumentCharacters: 1, documentWorker });

    const ambiguous = await resolver.resolve(input(duplicate, [ambiguousRecord]));
    const changed = await resolver.resolve(input(missing, [changedRecord]));

    expect(ambiguous.byId.ambiguous).toMatchObject({ status: "ambiguous" });
    expect(ambiguous.ambiguous[0]?.candidates).toHaveLength(2);
    expect(changed.byId.changed).toMatchObject({ status: "changed" });
    expect(changed.changed).toHaveLength(1);
  });

  it("cancels obsolete shared-Worker work before accepting the next revision", async () => {
    const documentWorker = new FakeDocumentWorkerResolver(false);
    const resolver = new AnnotationResolver({ largeDocumentCharacters: 1, documentWorker });
    const firstModel = createMarkdownTextModel("alpha", "sha256:first");
    const secondModel = createMarkdownTextModel("beta", "sha256:second");
    const first = resolver.resolve(input(firstModel, []));
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    documentWorker.autoRespond = true;
    const second = resolver.resolve(input(secondModel, []));

    await rejected;
    await expect(second).resolves.toMatchObject({ textRevision: secondModel.revision.textRevision });
    expect(documentWorker.aborted).toBe(1);
    expect(documentWorker.calls).toHaveLength(2);
  });

  it("aborts active shared-Worker work and clears cache when the preview closes", async () => {
    const documentWorker = new FakeDocumentWorkerResolver(false);
    const resolver = new AnnotationResolver({ largeDocumentCharacters: 1, documentWorker });
    const pending = resolver.resolve(input(createMarkdownTextModel("alpha", "sha256:close"), []));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    resolver.close();

    await rejected;
    expect(documentWorker.aborted).toBe(1);
  });

  it("bridges Snapshot identity and stable projection into the existing document attachment", async () => {
    const model = createMarkdownTextModel("# Guide\n\nalpha target", "sha256:bridge");
    const snapshot = annotationMarkdownSnapshot(model.rawSource, "sha256:bridge");
    const records = [textRecord("ann", "target", model.logicalText.indexOf("target"))];
    const expected = resolveDocumentAnnotations(model, records);
    const request = vi.fn(async (value: MarkdownWorkerRequest) => ({
      protocol_version: value.protocol_version,
      surface: value.surface,
      document_id: value.document_id,
      revision: value.revision,
      request_id: value.request_id,
      type: "annotations-result" as const,
      payload: { result: expected },
    }));
    const bridge = new DocumentWorkerAnnotationResolver({
      documentId: snapshot.document_id,
      surface: snapshot.surface,
      request,
    }, snapshot);

    await expect(bridge.resolve({
      model,
      path: "README.md",
      records,
      workspaceId: "ws-1",
    })).resolves.toEqual(expected);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      type: "resolve-annotations",
      document_id: snapshot.document_id,
      revision: snapshot.revision,
      payload: {
        path: "README.md",
        workspace_id: "ws-1",
        records,
      },
    });
    const payload = (request.mock.calls[0]?.[0] as Extract<MarkdownWorkerRequest, { type: "resolve-annotations" }>).payload;
    expect(payload).not.toHaveProperty("raw_source");
    expect(payload).not.toHaveProperty("markdown_projection");
  });

  it("rejects stale model revisions and attachment/snapshot identity drift", async () => {
    const snapshot = annotationMarkdownSnapshot("alpha", "sha256:current");
    const request = vi.fn();
    const bridge = new DocumentWorkerAnnotationResolver({
      documentId: snapshot.document_id,
      surface: snapshot.surface,
      request,
    }, snapshot);

    await expect(bridge.resolve({
      model: createMarkdownTextModel("alpha", "sha256:stale"),
      path: "README.md",
      records: [],
      workspaceId: "ws-1",
    })).rejects.toThrow("does not match Markdown Snapshot");
    expect(request).not.toHaveBeenCalled();
    expect(() => new DocumentWorkerAnnotationResolver({
      documentId: "file:other.md",
      surface: snapshot.surface,
      request,
    }, snapshot)).toThrow("does not match Snapshot");
  });
});

class FakeDocumentWorkerResolver implements AnnotationDocumentWorkerResolver {
  readonly calls: AnnotationDocumentWorkerResolveInput[] = [];
  aborted = 0;

  constructor(public autoRespond: boolean) {}

  resolve(inputValue: AnnotationDocumentWorkerResolveInput): Promise<ReturnType<typeof resolveDocumentAnnotations>> {
    this.calls.push(inputValue);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.aborted += 1;
        reject(inputValue.signal?.reason ?? new DOMException("aborted", "AbortError"));
      };
      inputValue.signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.autoRespond) return;
      queueMicrotask(() => {
        inputValue.signal?.removeEventListener("abort", onAbort);
        if (inputValue.signal?.aborted) return onAbort();
        resolve(resolveDocumentAnnotations(inputValue.model, inputValue.records));
      });
    });
  }
}

function input(model: DocumentTextModel, records: AnnotationRecord[]) {
  return { workspaceId: "ws-1", path: "README.md", model, records };
}

function textRecord(id: string, exact: string, start: number): AnnotationRecord {
  return {
    id,
    workspace_id: "ws-1",
    document_path: "README.md",
    target: {
      type: "text",
      selector: {
        position: { start, end: start + exact.length },
        quote: { exact, prefix: "", suffix: "" },
        context: { containerType: "source", headingPath: [] },
        textRevision: "old",
        documentRevision: "old",
      },
    },
    body: id,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

function recordWithSelector(
  id: string,
  selector: Extract<AnnotationRecord["target"], { type: "text" }> ["selector"],
): AnnotationRecord {
  return {
    id,
    workspace_id: "ws-1",
    document_path: "README.md",
    target: { type: "text", selector },
    body: id,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}
