import { describe, expect, it, vi } from "vitest";

import {
  DocumentWorkerHost,
  type DocumentWorkerLike,
} from "@/renderer/markdownRuntime/worker/DocumentWorkerHost";
import {
  MARKDOWN_SNAPSHOT_SCHEMA_VERSION,
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownSurface,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import {
  createMarkdownSnapshot,
  createMarkdownSnapshotChunkHeader,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { createMarkdownStreamTailPatch } from "@/renderer/markdownRuntime/streaming/StreamTailPatch";

class FakeWorker implements DocumentWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posted: Array<{ message: MarkdownWorkerRequest; transfer: Transferable[] }> = [];
  terminated = false;

  postMessage(message: MarkdownWorkerRequest, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
  }

  emit(response: MarkdownWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }

  crash(message = "worker crashed"): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function parseRequest(
  revision: string,
  requestId: string,
  documentId = "file:README.md",
  surface: MarkdownSurface = "file",
): MarkdownWorkerRequest {
  const content = `# ${revision}`;
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface,
    document_id: documentId,
    revision,
    request_id: requestId,
    type: "parse-canonical",
    payload: {
      source: {
        kind: "text",
        encoding: "utf-8",
        content,
        byte_length: new TextEncoder().encode(content).byteLength,
      },
      options: {
        renderer_profile: surface === "file" ? "file-preview" : "conversation",
        enable_html: true,
        enable_mdx: false,
      },
    },
  };
}

function snapshotResponse(request: MarkdownWorkerRequest): MarkdownWorkerResponse {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: request.surface,
    document_id: request.document_id,
    revision: request.revision,
    request_id: request.request_id,
    type: "snapshot-result",
    payload: createMarkdownSnapshot({
      surface: request.surface,
      document_id: request.document_id,
      revision: request.revision,
      renderer_profile: request.surface === "file" ? "file-preview" : "conversation",
      mode: request.type === "parse-stream-tail" ? "stream-tail" : "canonical",
      source_bytes: request.revision.length,
      source_characters: request.revision.length,
      logical_text: request.revision,
      line_count: 1,
      blocks: [],
      outline: [],
      resources: [],
      stream: request.type === "parse-stream-tail"
        ? {
            kind: "streaming",
            epoch: request.payload.stream_epoch,
            prefix_revision: request.payload.base_revision,
            prefix_block_count: 0,
            tail_block_start: 0,
            tail_source_start: 0,
            tail_complete: request.payload.final,
          }
        : { kind: "canonical", finalized: true },
      indexes: {
        line_map_revision: request.revision,
        logical_projection_revision: request.revision,
        source_index_revision: request.revision,
        find_index_revision: null,
        annotation_index_revision: null,
      },
    }),
  };
}

function postedParses(worker: FakeWorker): MarkdownWorkerRequest[] {
  return worker.posted.map((entry) => entry.message).filter(
    (message) => message.type === "parse-canonical" || message.type === "parse-stream-tail",
  );
}

function streamRequest(baseRevision: string, revision: string, requestId: string): MarkdownWorkerRequest {
  return {
    ...parseRequest(revision, requestId, "message:turn-1", "message"),
    type: "parse-stream-tail",
    payload: {
      base_revision: baseRevision,
      base_source_bytes: baseRevision.length,
      stream_epoch: 1,
      final: false,
      append: { kind: "text", encoding: "utf-8", content: revision, byte_length: revision.length },
      options: { renderer_profile: "conversation", enable_html: false, enable_mdx: false },
    },
  };
}

describe("DocumentWorkerHost", () => {
  it("assembles a chunked Snapshot without publishing an incomplete document", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({ workerFactory: () => worker });
    const attachment = host.attach("file", "file:README.md");
    const request = parseRequest("chunked", "chunked-request");
    const snapshot = createMarkdownSnapshot({
      surface: "file",
      document_id: request.document_id,
      revision: request.revision,
      renderer_profile: "file-preview",
      mode: "canonical",
      source_bytes: 7,
      source_characters: 7,
      logical_text: "chunked",
      line_count: 1,
      blocks: [{
        id: "chunked-block",
        identity_key: "paragraph:chunked",
        content_hash: "hash:chunked",
        index: 0,
        kind: "paragraph",
        parent_id: null,
        depth: 0,
        source_start: 0,
        source_end: 7,
        logical_start: 0,
        logical_end: 7,
        line_start: 0,
        line_end: 1,
        inline_spans: [],
        metadata: {},
      }],
      outline: [],
      resources: [],
      stream: { kind: "canonical", finalized: true },
      indexes: {
        line_map_revision: request.revision,
        logical_projection_revision: request.revision,
        source_index_revision: request.revision,
        find_index_revision: null,
        annotation_index_revision: null,
      },
    });
    const pending = attachment.request(request);
    const responseIdentity = {
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: request.surface,
      document_id: request.document_id,
      revision: request.revision,
      request_id: request.request_id,
    } as const;

    worker.emit({
      ...responseIdentity,
      type: "snapshot-start",
      payload: createMarkdownSnapshotChunkHeader(snapshot),
    });
    expect(attachment.currentSnapshot()).toBeNull();
    worker.emit({
      ...responseIdentity,
      type: "snapshot-chunk",
      payload: { collection: "blocks", start: 0, items: snapshot.blocks },
    });
    expect(attachment.currentSnapshot()).toBeNull();
    worker.emit({
      ...responseIdentity,
      type: "snapshot-complete",
      payload: { block_count: 1, outline_count: 0, resource_count: 0 },
    });

    await expect(pending).resolves.toMatchObject({
      type: "snapshot-result",
      payload: { revision: "chunked", logical_text: "chunked" },
    });
    expect(attachment.currentSnapshot()?.payload).toEqual(snapshot);
  });

  it("materializes a bounded stream-tail patch against the published base Snapshot", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({ workerFactory: () => worker });
    const attachment = host.attach("message", "message:turn-1");
    const baseRequest = parseRequest("base", "base-request", "message:turn-1", "message");
    const basePending = attachment.request(baseRequest);
    const baseResponse = snapshotResponse(baseRequest) as Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>;
    worker.emit(baseResponse);
    await basePending;

    const nextRequest = streamRequest("base", "next", "tail-request");
    const nextSnapshot = (snapshotResponse(nextRequest) as Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>).payload;
    const patchPending = attachment.request(nextRequest);
    worker.emit({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: "message",
      document_id: "message:turn-1",
      revision: "next",
      request_id: "tail-request",
      type: "stream-tail-patch-result",
      payload: createMarkdownStreamTailPatch(baseResponse.payload, nextSnapshot),
    });

    await expect(patchPending).resolves.toMatchObject({
      type: "snapshot-result",
      revision: "next",
      payload: { logical_text: "next", mode: "stream-tail" },
    });
    expect(attachment.currentSnapshot()?.payload).toEqual(nextSnapshot);
  });

  it("fails closed when a stream-tail patch names a stale base revision", async () => {
    const worker = new FakeWorker();
    const onWorkerError = vi.fn();
    const host = new DocumentWorkerHost({ workerFactory: () => worker, onWorkerError });
    const attachment = host.attach("message", "message:turn-1");
    const baseRequest = parseRequest("base", "base-request", "message:turn-1", "message");
    const baseResponse = snapshotResponse(baseRequest) as Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>;
    const basePending = attachment.request(baseRequest);
    worker.emit(baseResponse);
    await basePending;

    const nextRequest = streamRequest("base", "next", "tail-request");
    const nextSnapshot = (snapshotResponse(nextRequest) as Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>).payload;
    const patch = createMarkdownStreamTailPatch(baseResponse.payload, nextSnapshot);
    const pending = attachment.request(nextRequest);
    worker.emit({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: "message",
      document_id: "message:turn-1",
      revision: "next",
      request_id: "tail-request",
      type: "stream-tail-patch-result",
      payload: { ...patch, base_revision: "stale" },
    });

    await expect(pending).rejects.toMatchObject({ code: "worker-failed" });
    expect(onWorkerError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("requires base stale"),
    }));
    expect(attachment.currentSnapshot()?.revision).toBe("base");
  });

  it("coalesces 100 rapid revisions into active plus latest dirty parse", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({ workerFactory: () => worker });
    const attachment = host.attach("file", "file:README.md");
    const requests = Array.from({ length: 100 }, (_, index) =>
      parseRequest(`r${index}`, `request-${index}`));
    const promises = requests.map((request) => attachment.request(request));
    const observed = promises.map((promise) => promise.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ));

    expect(postedParses(worker).map((request) => request.revision)).toEqual(["r0"]);
    expect(worker.posted.filter((entry) => entry.message.type === "cancel")).toHaveLength(1);
    worker.emit(snapshotResponse(requests[0]));
    expect(postedParses(worker).map((request) => request.revision)).toEqual(["r0", "r99"]);
    worker.emit(snapshotResponse(requests[99]));

    const results = await Promise.all(observed);
    expect(results.slice(0, -1).every((entry) => entry.status === "rejected")).toBe(true);
    expect(results.at(-1)).toMatchObject({
      status: "resolved",
      value: { revision: "r99", type: "snapshot-result" },
    });
    expect(attachment.currentSnapshot()).toMatchObject({ revision: "r99" });
    expect(host.workerCount).toBe(1);
  });

  it("cancels an active parse and ignores its late response before publishing B", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({ workerFactory: () => worker });
    const attachment = host.attach("message", "message:turn-1");
    const controller = new AbortController();
    const requestA = parseRequest("rA", "request-A", "message:turn-1", "message");
    const requestB = parseRequest("rB", "request-B", "message:turn-1", "message");
    const promiseA = attachment.request(requestA, { signal: controller.signal });
    const rejectedA = expect(promiseA).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    const promiseB = attachment.request(requestB);

    worker.emit(snapshotResponse(requestA));
    expect(attachment.currentSnapshot()).toBeNull();
    expect(postedParses(worker).at(-1)?.revision).toBe("rB");
    worker.emit(snapshotResponse(requestB));

    await rejectedA;
    await expect(promiseB).resolves.toMatchObject({ revision: "rB" });
    expect(attachment.currentSnapshot()).toMatchObject({ revision: "rB" });
  });

  it("preserves the last snapshot across a crash and restarts without main-thread fallback", async () => {
    const workers: FakeWorker[] = [];
    const onWorkerError = vi.fn();
    const host = new DocumentWorkerHost({
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      onWorkerError,
    });
    const attachment = host.attach("file", "file:README.md");
    const firstRequest = parseRequest("r1", "request-1");
    const first = attachment.request(firstRequest);
    workers[0].emit(snapshotResponse(firstRequest));
    await first;
    expect(attachment.currentSnapshot()?.revision).toBe("r1");

    const failedRequest = parseRequest("r2", "request-2");
    const failed = attachment.request(failedRequest);
    const rejected = expect(failed).rejects.toMatchObject({ code: "worker-failed" });
    workers[0].crash("synthetic crash");
    await rejected;
    expect(attachment.currentSnapshot()?.revision).toBe("r1");
    expect(onWorkerError).toHaveBeenCalledWith(expect.objectContaining({ code: "worker-failed" }));

    const recoveryRequest = parseRequest("r3", "request-3");
    const recovered = attachment.request(recoveryRequest);
    expect(workers).toHaveLength(2);
    workers[1].emit(snapshotResponse(recoveryRequest));
    await expect(recovered).resolves.toMatchObject({ revision: "r3" });
    expect(attachment.currentSnapshot()?.revision).toBe("r3");
  });

  it("supports two documents on one budgeted Worker without mixing responses", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({ workerFactory: () => worker });
    const file = host.attach("file", "file:A.md");
    const message = host.attach("message", "message:turn-1");
    const fileRequest = parseRequest("file-r1", "file-request", "file:A.md", "file");
    const messageRequest = parseRequest("message-r1", "message-request", "message:turn-1", "message");
    const fileResult = file.request(fileRequest);
    const messageResult = message.request(messageRequest);

    expect(host.workerCount).toBe(1);
    expect(postedParses(worker)).toHaveLength(2);
    worker.emit(snapshotResponse(messageRequest));
    worker.emit(snapshotResponse(fileRequest));

    await expect(fileResult).resolves.toMatchObject({ document_id: "file:A.md", revision: "file-r1" });
    await expect(messageResult).resolves.toMatchObject({ document_id: "message:turn-1", revision: "message-r1" });
    expect(file.currentSnapshot()?.revision).toBe("file-r1");
    expect(message.currentSnapshot()?.revision).toBe("message-r1");
  });

  it("releases state and terminates the Worker only after the last consumer detaches", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({ workerFactory: () => worker });
    const first = host.attach("file", "file:README.md");
    const second = host.attach("file", "file:README.md");
    const pending = first.request(parseRequest("r1", "request-1"));
    const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });

    first.detach();
    expect(worker.terminated).toBe(false);
    expect(host.attachedDocumentCount).toBe(1);
    second.detach();

    await rejected;
    expect(worker.posted.some((entry) => entry.message.type === "dispose")).toBe(true);
    expect(worker.terminated).toBe(true);
    expect(host.workerCount).toBe(0);
    expect(host.attachedDocumentCount).toBe(0);
  });

  it("passes transferable buffers and enforces the retained snapshot memory budget", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({
      workerFactory: () => worker,
      maxRetainedSnapshotBytes: 5,
    });
    const attachment = host.attach("file", "file:buffer.md");
    const data = new TextEncoder().encode("# buffer").buffer;
    const request: Extract<MarkdownWorkerRequest, { type: "parse-canonical" }> = {
      ...(parseRequest("r1", "buffer-request", "file:buffer.md") as Extract<
        MarkdownWorkerRequest,
        { type: "parse-canonical" }
      >),
      payload: {
        source: { kind: "utf8-buffer", encoding: "utf-8", data, byte_length: data.byteLength },
        options: { renderer_profile: "file-preview", enable_html: true, enable_mdx: false },
      },
    };
    const pending = attachment.request(request);

    expect(worker.posted[0].transfer).toEqual([data]);
    worker.emit(snapshotResponse(request));
    await expect(pending).resolves.toMatchObject({ revision: "r1" });
    expect(host.retainedSnapshotBytes).toBe(0);
    expect(attachment.currentSnapshot()).toBeNull();
  });

  it("prewarms capabilities and fails explicitly when Worker creation is unavailable", async () => {
    const worker = new FakeWorker();
    const host = new DocumentWorkerHost({ workerFactory: () => worker });
    const prewarm = host.prewarm({
      surface: "file",
      document_id: "file:prewarm",
      revision: "prewarm",
      request_id: "prewarm-1",
    });
    const request = worker.posted[0].message;
    worker.emit({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: request.surface,
      document_id: request.document_id,
      revision: request.revision,
      request_id: request.request_id,
      type: "capabilities-result",
      payload: { supported: ["transferable-array-buffer"], max_transfer_bytes: 20 * 1024 * 1024 },
    });
    await expect(prewarm).resolves.toMatchObject({ type: "capabilities-result" });
    expect(worker.terminated).toBe(true);

    const unavailable = new DocumentWorkerHost({
      workerFactory: () => {
        throw new Error("Worker unavailable");
      },
    });
    const attachment = unavailable.attach("file", "file:README.md");
    await expect(attachment.request(parseRequest("r1", "request-1"))).rejects
      .toMatchObject({ code: "worker-failed" });
    expect(attachment.currentSnapshot()).toBeNull();
  });
});
