import { describe, expect, it, vi } from "vitest";

import {
  DocumentReadProtocolError,
  createDocumentReadMessages,
  createDocumentReadRequest,
  type DocumentReadResult,
} from "@/runtime";
import {
  DocumentReadCoordinator,
  readDocumentNdjsonResponse,
  type DocumentReadTransportDiagnostics,
} from "@/renderer/components/workspace/fileMarkdownAdapter/transport";

function request(contentPath = "docs/large.md", chunkSize = 16) {
  return createDocumentReadRequest({
    request_id: `request:${contentPath}`,
    document_id: `workspace:${contentPath}`,
    source: "workspace",
    path: contentPath,
    preferred_transport: "chunked",
    chunk_size_bytes: chunkSize,
  });
}

function ndjsonResponse(lines: readonly unknown[], fragmentSize = 7): Response {
  const encoded = new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"));
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + fragmentSize, encoded.byteLength);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 }), {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function result(path: string, revision: string): DocumentReadResult {
  return Object.freeze({
    document_id: `workspace:${path}`,
    source: "workspace",
    path,
    revision,
    encoding: "utf-8",
    total_bytes: path.length,
    content: path,
  });
}

describe("document read streaming transport", () => {
  it("assembles UTF-8 NDJSON fragmented across arbitrary network boundaries", async () => {
    const readRequest = request("中文/批注.md", 5);
    const content = "# 标题\n\n批注 👋\n".repeat(20);
    const messages = createDocumentReadMessages({
      request: readRequest,
      revision: "sha256:unicode",
      content,
    });

    await expect(readDocumentNdjsonResponse(ndjsonResponse(messages, 3), readRequest)).resolves
      .toMatchObject({ content, revision: "sha256:unicode", path: "中文/批注.md" });
  });

  it("accepts out-of-order chunks and idempotent duplicates before atomic complete", async () => {
    const readRequest = request("ordered.md", 6);
    const messages = createDocumentReadMessages({
      request: readRequest,
      revision: "r1",
      content: "alpha beta gamma delta",
    });
    const start = messages[0];
    const complete = messages.at(-1);
    const chunks = messages.slice(1, -1);
    const reordered = [start, ...chunks.toReversed(), chunks[0], complete];

    await expect(readDocumentNdjsonResponse(ndjsonResponse(reordered), readRequest)).resolves
      .toMatchObject({ content: "alpha beta gamma delta", revision: "r1" });
  });

  it("rejects missing, conflicting duplicate, and malformed chunks without a partial result", async () => {
    const readRequest = request("broken.md", 5);
    const messages = createDocumentReadMessages({ request: readRequest, revision: "r1", content: "abcdefghijk" });
    const missing = [messages[0], ...messages.slice(1, -2), messages.at(-1)];
    await expect(readDocumentNdjsonResponse(ndjsonResponse(missing), readRequest)).rejects
      .toMatchObject({ code: "missing_chunks" });

    const chunk = messages[1];
    if (!chunk || chunk.type !== "chunk") throw new Error("expected chunk fixture");
    const conflict = [messages[0], chunk, { ...chunk, content: "xxxxx" }, ...messages.slice(2)];
    await expect(readDocumentNdjsonResponse(ndjsonResponse(conflict), readRequest)).rejects
      .toMatchObject({ code: "invalid_chunk" });

    await expect(readDocumentNdjsonResponse(new Response("{bad-json\n"), readRequest)).rejects
      .toMatchObject({ code: "invalid_chunk" });
  });

  it("cancels the reader and ignores data delivered after abort", async () => {
    const readRequest = request("cancel.md");
    const controller = new AbortController();
    let streamCancelled = false;
    let releasePull!: () => void;
    const waitForAbort = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const response = new Response(new ReadableStream<Uint8Array>({
      async pull(stream) {
        await waitForAbort;
        if (!streamCancelled) stream.enqueue(new TextEncoder().encode("late-data"));
      },
      cancel() {
        streamCancelled = true;
        releasePull();
      },
    }, { highWaterMark: 0 }));

    const pending = readDocumentNdjsonResponse(response, readRequest, { signal: controller.signal });
    controller.abort();
    releasePull();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(streamCancelled).toBe(true);
  });

  it("samples bounded buffering and throttles diagnostics instead of emitting per chunk", async () => {
    const readRequest = request("diagnostics.md", 8);
    const content = "diagnostic line\n".repeat(200);
    const messages = createDocumentReadMessages({ request: readRequest, revision: "r1", content });
    const diagnostics: DocumentReadTransportDiagnostics[] = [];
    let clock = 0;
    Object.defineProperty(performance, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 12_345_678 },
    });

    try {
      const response = ndjsonResponse(messages, 512);
      const expectedNetworkBytes = Number(response.headers.get("Content-Length") ?? 0);
      const readResult = await readDocumentNdjsonResponse(response, readRequest, {
        diagnosticsIntervalMs: 100,
        now: () => (clock += 10),
        onDiagnostics: (sample) => diagnostics.push(sample),
      });

      expect(readResult.content).toBe(content);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.length).toBeLessThan(messages.length);
      expect(diagnostics.at(-1)).toMatchObject({
        acceptedMessages: messages.length,
        complete: true,
        peakHeapBytes: 12_345_678,
      });
      expect(diagnostics.at(-1)?.receivedBytes).toBeGreaterThan(expectedNetworkBytes);
      expect(diagnostics.at(-1)?.peakBufferedTextBytes).toBeLessThan(1024);
    } finally {
      Reflect.deleteProperty(performance, "memory");
    }
  });
});

describe("DocumentReadCoordinator", () => {
  it("cancels stale A/B reads and only commits the latest C result", async () => {
    const coordinator = new DocumentReadCoordinator();
    const resolves = new Map<string, (value: DocumentReadResult) => void>();
    const signals = new Map<string, AbortSignal>();
    const load = (key: string) => (signal: AbortSignal) => new Promise<DocumentReadResult>((resolve) => {
      signals.set(key, signal);
      resolves.set(key, resolve);
    });

    const readA = coordinator.read({ consumerId: "view", documentKey: "A", load: load("A") });
    const readB = coordinator.read({ consumerId: "view", documentKey: "B", load: load("B") });
    const readC = coordinator.read({ consumerId: "view", documentKey: "C", load: load("C") });
    await Promise.resolve();
    resolves.get("B")?.(result("B", "rB"));
    resolves.get("A")?.(result("A", "rA"));
    resolves.get("C")?.(result("C", "rC"));

    await expect(readA).rejects.toMatchObject({ code: "cancelled" });
    await expect(readB).rejects.toMatchObject({ code: "cancelled" });
    await expect(readC).resolves.toMatchObject({ path: "C", revision: "rC" });
    expect(signals.get("A")?.aborted).toBe(true);
    expect(signals.get("B")?.aborted).toBe(true);
    expect(coordinator.latest("view")).toMatchObject({ path: "C", revision: "rC" });
  });

  it("shares one in-flight read across two views and keeps it alive for the remaining view", async () => {
    const coordinator = new DocumentReadCoordinator();
    const load = vi.fn((signal: AbortSignal) => new Promise<DocumentReadResult>((resolve) => {
      setTimeout(() => resolve(result("shared.md", signal.aborted ? "aborted" : "r1")), 0);
    }));
    const firstController = new AbortController();
    const first = coordinator.read({
      consumerId: "view-1",
      documentKey: "shared.md",
      signal: firstController.signal,
      load,
    });
    const second = coordinator.read({
      consumerId: "view-2",
      documentKey: "shared.md",
      load,
    });
    firstController.abort();

    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(second).resolves.toMatchObject({ revision: "r1" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not replace the last good revision when a later read fails", async () => {
    const coordinator = new DocumentReadCoordinator();
    await coordinator.read({
      consumerId: "view",
      documentKey: "doc:r1",
      load: async () => result("doc.md", "r1"),
    });
    expect(coordinator.latest("view")?.revision).toBe("r1");

    await expect(coordinator.read({
      consumerId: "view",
      documentKey: "doc:broken",
      load: async () => {
        throw new DocumentReadProtocolError("io_error", "temporary failure", true);
      },
    })).rejects.toMatchObject({ code: "io_error" });
    expect(coordinator.latest("view")?.revision).toBe("r1");

    await coordinator.read({
      consumerId: "view",
      documentKey: "doc:r2",
      load: async () => result("doc.md", "r2"),
    });
    expect(coordinator.latest("view")?.revision).toBe("r2");
  });
});
