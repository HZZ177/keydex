import { describe, expect, it, vi } from "vitest";

import { AnnotationResolver } from "@/renderer/features/annotations/anchoring/AnnotationResolver";
import {
  resolveAnnotationPayload,
  type AnnotationResolverRequest,
  type AnnotationResolverResponse,
} from "@/renderer/features/annotations/anchoring/annotationResolverProtocol";
import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import { createMarkdownTextModel } from "@/renderer/features/annotations/document/MarkdownTextModel";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import type { AnnotationRecord } from "@/runtime/annotations";

describe("AnnotationResolver Worker and cache", () => {
  it("keeps worker-core output identical to the synchronous pure function", () => {
    const model = createMarkdownTextModel("# Guide\n\nalpha target", "sha256:doc");
    const records = [textRecord("ann", "target", model.logicalText.indexOf("target"))];
    const synchronous = resolveDocumentAnnotations(model, records);
    const workerCore = resolveAnnotationPayload({
      document: { kind: "markdown", rawSource: model.rawSource, documentRevision: "sha256:doc" },
      records,
    });

    expect(workerCore).toEqual(synchronous);
  });

  it("resolves small inputs synchronously without constructing a Worker", async () => {
    const workerFactory = vi.fn();
    const resolver = new AnnotationResolver({ workerFactory });
    const model = createPlainTextModel("alpha", "sha256:small");

    await expect(resolver.resolve(input(model, []))).resolves.toMatchObject({ ordered: [] });
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("uses a Worker for large input and caches by all revision dimensions", async () => {
    const workers: FakeWorker[] = [];
    const resolver = new AnnotationResolver({
      largeDocumentCharacters: 1,
      workerFactory: () => {
        const worker = new FakeWorker(true);
        workers.push(worker);
        return worker;
      },
    });
    const model = createPlainTextModel("alpha", "sha256:large");
    const request = input(model, [textRecord("ann", "alpha", 0)]);
    const first = await resolver.resolve(request);
    const cached = await resolver.resolve(request);

    expect(first).toEqual(cached);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);

    await resolver.resolve({ ...request, path: "other.md" });
    await resolver.resolve({ ...request, records: [textRecord("ann-2", "alpha", 0)] });
    expect(workers).toHaveLength(3);
  });

  it("cancels an obsolete large resolution before accepting the next revision", async () => {
    const workers: FakeWorker[] = [];
    const resolver = new AnnotationResolver({
      largeDocumentCharacters: 1,
      workerFactory: () => {
        const worker = new FakeWorker(workers.length > 0);
        workers.push(worker);
        return worker;
      },
    });
    const firstModel = createPlainTextModel("alpha", "sha256:first");
    const secondModel = createPlainTextModel("beta", "sha256:second");
    const first = resolver.resolve(input(firstModel, []));
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = resolver.resolve(input(secondModel, []));

    await rejected;
    await expect(second).resolves.toMatchObject({ textRevision: "sha256:second" });
    expect(workers[0].terminated).toBe(true);
  });

  it("terminates active work and clears cache when the preview closes", async () => {
    const worker = new FakeWorker(false);
    const resolver = new AnnotationResolver({
      largeDocumentCharacters: 1,
      workerFactory: () => worker,
    });
    const pending = resolver.resolve(input(createPlainTextModel("alpha", "sha256:close"), []));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

    resolver.close();

    await rejected;
    expect(worker.terminated).toBe(true);
  });
});

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<AnnotationResolverResponse>) => void) | null = null;
  terminated = false;

  constructor(private readonly autoRespond: boolean) {}

  postMessage(message: AnnotationResolverRequest): void {
    if (!this.autoRespond) {
      return;
    }
    queueMicrotask(() => {
      if (!this.terminated) {
        this.onmessage?.({
          data: { id: message.id, ok: true, result: resolveAnnotationPayload(message.payload) },
        } as MessageEvent<AnnotationResolverResponse>);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function input(
  model: ReturnType<typeof createPlainTextModel>,
  records: AnnotationRecord[],
) {
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
