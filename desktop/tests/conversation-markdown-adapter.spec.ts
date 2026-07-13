import { describe, expect, it } from "vitest";

import {
  ConversationMarkdownAdapter,
  type ConversationMarkdownInput,
} from "@/renderer/markdownRuntime/adapters";
import { MarkdownRuntimeStore } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import { MarkdownViewStateStore } from "@/renderer/markdownRuntime/view";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type { DocumentWorkerLike } from "@/renderer/markdownRuntime/worker/DocumentWorkerHost";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

describe("ConversationMarkdownAdapter", () => {
  it("projects user and terminal assistant states as settled conversation documents", () => {
    const adapter = new ConversationMarkdownAdapter();
    const user = adapter.project(input("session-a", "user-1", "user", "completed", "Question"));
    const completed = adapter.project(input("session-a", "assistant-1", "assistant", "completed", "Answer"));
    const cancelled = adapter.project(input("session-a", "assistant-2", "assistant", "cancelled", "Partial"));
    const failed = adapter.project(input("session-a", "assistant-3", "assistant", "failed", "Failure"));

    for (const projection of [user, completed, cancelled, failed]) {
      expect(projection.identity.surface).toBe("message");
      expect(projection.rendererProfile).toMatchObject({ id: "conversation", surface: "message" });
      expect(projection.phase).toBe("settled");
      expect(projection.retention).toBe("settled");
      expect(projection.revision).toContain("conversation-settled:");
    }
    expect(user.role).toBe("user");
    expect(completed.role).toBe("assistant");
  });

  it("keeps repeated projections stable and gives every stream mutation a monotonic revision", () => {
    const adapter = new ConversationMarkdownAdapter();
    const pending = adapter.project(input("session-a", "assistant-1", "assistant", "pending", "A"));
    const repeated = adapter.project(input("session-a", "assistant-1", "assistant", "pending", "A"));
    const appended = adapter.project(input("session-a", "assistant-1", "assistant", "running", "AB"));
    const corrected = adapter.project(input("session-a", "assistant-1", "assistant", "running", "A"));

    expect(repeated).toBe(pending);
    expect([pending.sequence, appended.sequence, corrected.sequence]).toEqual([1, 2, 3]);
    expect([pending.revision, appended.revision, corrected.revision]).toEqual([
      expect.stringContaining(":000000000001:"),
      expect.stringContaining(":000000000002:"),
      expect.stringContaining(":000000000003:"),
    ]);
    expect(new Set([pending.revision, appended.revision, corrected.revision]).size).toBe(3);
    expect(corrected).toMatchObject({ phase: "streaming", retention: "transient" });
  });

  it("derives settled hydration revisions deterministically and isolates sessions", () => {
    const firstAdapter = new ConversationMarkdownAdapter();
    const secondAdapter = new ConversationMarkdownAdapter();
    const message = input("session-a", "assistant-1", "assistant", "completed", "Hydrated history");
    const first = firstAdapter.project(message);
    const hydrated = secondAdapter.project(message);
    const otherSession = secondAdapter.project({ ...message, sessionId: "session-b" });
    const corrected = firstAdapter.project({
      ...message,
      message: { ...message.message, content: "Corrected history" },
    });

    expect(hydrated.revision).toBe(first.revision);
    expect(hydrated.documentId).toBe(first.documentId);
    expect(otherSession.documentId).not.toBe(first.documentId);
    expect(otherSession.revision).not.toBe(first.revision);
    expect(corrected.documentId).toBe(first.documentId);
    expect(corrected.revision).not.toBe(first.revision);
    expect(firstAdapter.project(message).revision).toBe(first.revision);
  });

  it("shares a settled Snapshot across hosts while view state remains host-local", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const viewStates = new MarkdownViewStateStore();
    const adapter = new ConversationMarkdownAdapter();
    const source = input("session-a", "assistant-1", "assistant", "completed", "# Shared answer");
    const main = adapter.attach(store, source, "conversation-main");
    const sidebar = adapter.attach(store, source, "conversation-sidebar");
    const mainView = viewStates.attach(adapter.viewDescriptor(main.projection(), "conversation-main"));
    const sidebarView = viewStates.attach(adapter.viewDescriptor(sidebar.projection(), "conversation-sidebar"));

    const [mainSnapshot, sidebarSnapshot] = await Promise.all([main.load(), sidebar.load()]);
    mainView.setSelection({ sourceStart: 0, sourceEnd: 3, direction: "forward" });

    expect(mainSnapshot).toBe(sidebarSnapshot);
    expect(main.runtime.current()).toBe(sidebar.runtime.current());
    expect(harness.parseCount).toBe(1);
    expect(mainView.snapshot().selection).not.toBeNull();
    expect(sidebarView.snapshot().selection).toBeNull();
    expect(store.diagnostics()).toMatchObject({ entryCount: 1, viewCount: 2 });
    expect(viewStates.diagnostics()).toMatchObject({ entries: 1, attachedViews: 2 });

    mainView.detach();
    sidebarView.detach();
    main.detach();
    sidebar.detach();
    expect(store.diagnostics()).toMatchObject({ entryCount: 1, viewCount: 0 });
    store.close();
  });

  it("does not retain streaming revisions after the final host detaches", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const adapter = new ConversationMarkdownAdapter();
    const host = adapter.attach(
      store,
      input("session-a", "assistant-stream", "assistant", "running", "Partial response"),
      "stream-host",
    );

    await host.load();
    expect(store.diagnostics().documents[0]).toMatchObject({ retention: "transient" });
    host.detach();
    expect(store.diagnostics()).toMatchObject({ entryCount: 0, retainedBytes: 0, viewCount: 0 });
    store.close();
  });

  it("updates only the attached message and reaches a deterministic settled revision", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const adapter = new ConversationMarkdownAdapter();
    const host = adapter.attach(
      store,
      input("session-a", "assistant-stream", "assistant", "running", "A"),
      "stream-host",
    );
    await host.load();
    const streamed = await host.update(input("session-a", "assistant-stream", "assistant", "running", "AB"));
    const completed = await host.update(input("session-a", "assistant-stream", "assistant", "completed", "AB"));

    expect(streamed.revision).toContain("conversation-stream:");
    expect(completed.revision).toContain("conversation-settled:");
    expect(host.projection()).toMatchObject({ phase: "settled", retention: "settled", source: "AB" });
    await expect(host.update(input("session-b", "assistant-stream", "assistant", "completed", "AB")))
      .rejects.toThrow(/cannot switch session or message identity/u);
    await expect(host.update(input("session-a", "other-message", "assistant", "completed", "AB")))
      .rejects.toThrow(/cannot switch session or message identity/u);
    host.detach();
    store.close();
  });

  it("rejects non-text timeline units without changing ConversationMessage", () => {
    const adapter = new ConversationMarkdownAdapter();
    expect(() => adapter.project(input("session-a", "tool-1", "tool", "completed", "read_file")))
      .toThrow(/only accepts user or assistant/u);
    expect(() => adapter.project(input(" ", "assistant-1", "assistant", "completed", "Answer")))
      .toThrow(/sessionId is required/u);
  });
});

function input(
  sessionId: string,
  id: string,
  kind: ConversationMarkdownInput["message"]["kind"],
  status: ConversationMarkdownInput["message"]["status"],
  content: string,
): ConversationMarkdownInput {
  return { sessionId, message: { id, kind, status, content } };
}

class ParsingWorker implements DocumentWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  private terminated = false;

  constructor(private readonly harness: WorkerHarness) {}

  postMessage(message: MarkdownWorkerRequest): void {
    if (message.type === "dispose") {
      this.harness.snapshots.delete(documentKey(message));
      return;
    }
    if (message.type === "hydrate-snapshot") {
      this.harness.snapshots.set(documentKey(message), message.payload.snapshot);
      queueMicrotask(() => this.emit({
        ...identity(message),
        type: "hydrated",
        payload: { estimated_bytes: message.payload.snapshot.estimated_bytes },
      }));
      return;
    }
    if (message.type !== "parse-canonical") return;
    this.harness.parseCount += 1;
    queueMicrotask(() => {
      if (this.terminated) return;
      const source = message.payload.source.kind === "text"
        ? message.payload.source.content
        : new TextDecoder().decode(message.payload.source.data);
      const key = documentKey(message);
      const snapshot = parseCanonicalMarkdownSnapshot({
        surface: message.surface,
        documentId: message.document_id,
        revision: message.revision,
        source,
        rendererProfile: message.payload.options.renderer_profile,
      }, { previousSnapshot: this.harness.snapshots.get(key) });
      this.harness.snapshots.set(key, snapshot);
      this.emit({ ...identity(message), type: "snapshot-result", payload: snapshot });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  private emit(response: MarkdownWorkerResponse): void {
    if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

class WorkerHarness {
  readonly snapshots = new Map<string, MarkdownSnapshot>();
  parseCount = 0;
  factory = () => new ParsingWorker(this);
}

function identity(request: MarkdownWorkerRequest) {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: request.surface,
    document_id: request.document_id,
    revision: request.revision,
    request_id: request.request_id,
  } as const;
}

function documentKey(request: MarkdownWorkerRequest): string {
  return `${request.surface}\u0000${request.document_id}`;
}
