import { beforeAll, describe, expect, it } from "vitest";

import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import { applyMarkdownStreamTailPatch } from "@/renderer/markdownRuntime/streaming/StreamTailPatch";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

let receive!: (event: MessageEvent<unknown>) => void;
const responses: MarkdownWorkerResponse[] = [];

beforeAll(async () => {
  const workerScope = {
    addEventListener: (_type: "message", listener: (event: MessageEvent<unknown>) => void) => { receive = listener; },
    postMessage: (message: MarkdownWorkerResponse) => { responses.push(message); },
  };
  Object.defineProperty(globalThis, "self", { configurable: true, value: workerScope });
  await import("@/renderer/markdownRuntime/worker/document.worker");
});

describe("document Worker streaming tail parser", () => {
  it("advertises, publishes, advances, and canonically finalizes stream-tail parsing", async () => {
    send(request("capabilities", "cap", "cap", {
      requested: ["stream-tail-parse"],
    }));
    expect(responses.at(-1)).toMatchObject({
      type: "capabilities-result",
      payload: { supported: expect.arrayContaining(["stream-tail-parse"]) },
    });

    send(request("parse-canonical", "base", "base", {
      source: { kind: "text", encoding: "utf-8", content: "", byte_length: 0 },
      options: parseOptions(),
    }));
    await tick();
    expect(response("base")).toMatchObject({ type: "snapshot-result", payload: { mode: "canonical" } });
    let snapshot = (response("base") as Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>).payload;

    send(request("parse-stream-tail", "r1", "tail-1", {
      base_revision: "base",
      base_source_bytes: 0,
      stream_epoch: 1,
      final: false,
      append: textSource("Alpha\n\nBeta"),
      options: parseOptions(),
    }));
    await tick();
    expect(response("tail-1")).toMatchObject({
      type: "stream-tail-patch-result",
      payload: { mode: "stream-tail", base_revision: "base", stream: { kind: "streaming", prefix_block_count: 1 } },
    });
    snapshot = materialize(snapshot, response("tail-1"));
    expect(snapshot).toMatchObject({ revision: "r1", mode: "stream-tail", logical_text: "Alpha\nBeta" });

    send(request("parse-stream-tail", "r2", "tail-2", {
      base_revision: "r1",
      base_source_bytes: new TextEncoder().encode("Alpha\n\nBeta").byteLength,
      stream_epoch: 1,
      final: false,
      append: textSource("\n\nGamma"),
      options: parseOptions(),
    }));
    await tick();
    expect(response("tail-2")).toMatchObject({
      type: "stream-tail-patch-result",
      payload: { base_revision: "r1", source_characters: 18, stream: { prefix_block_count: 2 } },
    });
    snapshot = materialize(snapshot, response("tail-2"));
    expect(snapshot.logical_text).toBe("Alpha\nBeta\nGamma");

    send(request("parse-stream-tail", "r3", "tail-final", {
      base_revision: "r2",
      base_source_bytes: new TextEncoder().encode("Alpha\n\nBeta\n\nGamma").byteLength,
      stream_epoch: 1,
      final: true,
      append: textSource(""),
      options: parseOptions(),
    }));
    await tick();
    expect(response("tail-final")).toMatchObject({
      type: "snapshot-result",
      payload: { mode: "canonical", stream: { kind: "canonical", finalized: true } },
    });
  });
});

function materialize(base: MarkdownSnapshot, candidate: MarkdownWorkerResponse | undefined): MarkdownSnapshot {
  if (!candidate || candidate.type !== "stream-tail-patch-result") throw new Error("Expected stream tail patch");
  return applyMarkdownStreamTailPatch(base, candidate.revision, candidate.payload);
}

function request<T extends MarkdownWorkerRequest["type"]>(
  type: T,
  revision: string,
  requestId: string,
  payload: Extract<MarkdownWorkerRequest, { type: T }>["payload"],
): Extract<MarkdownWorkerRequest, { type: T }> {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: "message",
    document_id: "message:worker-tail",
    revision,
    request_id: requestId,
    type,
    payload,
  } as Extract<MarkdownWorkerRequest, { type: T }>;
}

function parseOptions() {
  return { renderer_profile: "conversation" as const, enable_html: false, enable_mdx: false };
}

function textSource(content: string) {
  return { kind: "text" as const, encoding: "utf-8" as const, content, byte_length: new TextEncoder().encode(content).byteLength };
}

function send(message: MarkdownWorkerRequest) {
  receive({ data: message } as MessageEvent<unknown>);
}

function response(requestId: string): MarkdownWorkerResponse | undefined {
  return responses.findLast((item) => item.request_id === requestId);
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
