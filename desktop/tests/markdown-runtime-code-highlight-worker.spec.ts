import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  type MarkdownCodeHighlightWorkerMessage,
  type MarkdownCodeHighlightWorkerResponse,
} from "@/renderer/markdownRuntime/renderers/CodeHighlightProtocol";
import {
  MarkdownCodeWorkerHighlighter,
  type MarkdownCodeHighlightWorkerLike,
} from "@/renderer/markdownRuntime/renderers/CodeHighlightWorkerService";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

describe("Markdown code highlight Worker service", () => {
  afterEach(() => vi.useRealTimers());

  it("does not start the Worker when a mounted code block is cancelled inside the dispatch window", async () => {
    vi.useFakeTimers();
    const workerFactory = vi.fn(() => new FakeHighlightWorker());
    const service = new MarkdownCodeWorkerHighlighter({ workerFactory, dispatchDelayMs: 24 });
    const task = service.highlight(codeBlock("sql", "SELECT 1"), "SELECT 1");
    const rejected = expect(task.promise).rejects.toMatchObject({ name: "AbortError" });

    task.cancel("Code block left viewport");
    await rejected;
    await vi.advanceTimersByTimeAsync(24);
    expect(workerFactory).not.toHaveBeenCalled();
    service.dispose();
  });

  it("sends bounded work and reconstructs a cache-safe token descriptor", async () => {
    vi.useFakeTimers();
    const worker = new FakeHighlightWorker();
    const service = new MarkdownCodeWorkerHighlighter({
      workerFactory: () => worker,
      dispatchDelayMs: 24,
      idleTimeoutMs: 100,
      maxHighlightCharacters: 8,
      maxTokens: 4,
    });
    const block = codeBlock("sql", "SELECT 123456789");
    const task = service.highlight(block, "SELECT 123456789");

    await vi.advanceTimersByTimeAsync(24);
    expect(worker.messages).toEqual([expect.objectContaining({
      type: "highlight",
      language: "sql",
      code: "SELECT 1",
      maxTokens: 4,
      sourceTruncated: true,
    })]);
    const request = worker.messages[0]!;
    worker.respond({
      protocolVersion: CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      type: "highlight-result",
      requestId: request.requestId,
      language: "sql",
      tokens: [{ start: 0, end: 6, kind: "keyword" }],
      truncated: true,
    });

    await expect(task.promise).resolves.toEqual(expect.objectContaining({
      blockId: block.id,
      contentHash: block.content_hash,
      language: "sql",
      truncated: true,
      tokens: [{ start: 0, end: 6, kind: "keyword" }],
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.terminated).toBe(true);
    service.dispose();
  });

  it("forwards cancellation to an already-dispatched Worker task", async () => {
    vi.useFakeTimers();
    const worker = new FakeHighlightWorker();
    const service = new MarkdownCodeWorkerHighlighter({ workerFactory: () => worker, dispatchDelayMs: 0 });
    const task = service.highlight(codeBlock("rust", "fn main() {}"), "fn main() {}");
    const rejected = expect(task.promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);

    task.cancel("Code block recycled");
    await rejected;
    expect(worker.messages.at(-1)).toMatchObject({ type: "cancel" });
    service.dispose();
  });

  it("rejects pending work and disables a Worker whose message dispatch throws", async () => {
    vi.useFakeTimers();
    const worker = new FakeHighlightWorker();
    worker.postError = new DOMException("Worker payload could not be cloned", "DataCloneError");
    const workerFactory = vi.fn(() => worker);
    const service = new MarkdownCodeWorkerHighlighter({ workerFactory, dispatchDelayMs: 0 });
    const first = service.highlight(codeBlock("sql", "SELECT 1"), "SELECT 1");
    const rejected = expect(first.promise).rejects.toMatchObject({ name: "DataCloneError" });

    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(worker.terminated).toBe(true);

    const second = service.highlight(codeBlock("sql", "SELECT 2"), "SELECT 2");
    await expect(second.promise).rejects.toThrow("unavailable");
    expect(workerFactory).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});

class FakeHighlightWorker implements MarkdownCodeHighlightWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<MarkdownCodeHighlightWorkerResponse>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly messages: MarkdownCodeHighlightWorkerMessage[] = [];
  terminated = false;
  postError: Error | null = null;

  postMessage(message: MarkdownCodeHighlightWorkerMessage): void {
    if (this.postError) throw this.postError;
    this.messages.push(message);
  }

  respond(message: MarkdownCodeHighlightWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<MarkdownCodeHighlightWorkerResponse>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function codeBlock(language: string, code: string) {
  const snapshot = parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: `code-highlight:${language}`,
    revision: "r1",
    source: `\`\`\`${language}\n${code}\n\`\`\``,
    rendererProfile: "file-preview",
  });
  return snapshot.blocks.find((block) => block.kind === "code")!;
}
