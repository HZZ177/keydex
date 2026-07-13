import { describe, expect, it } from "vitest";

import { ConversationMarkdownAdapter } from "@/renderer/markdownRuntime/adapters";
import {
  ConversationHydrationScheduler,
  type ConversationHydrationCandidate,
} from "@/renderer/markdownRuntime/history/ConversationHydrationScheduler";
import { MarkdownRuntimeStore } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type { DocumentWorkerLike } from "@/renderer/markdownRuntime/worker/DocumentWorkerHost";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";

describe("ConversationHydrationScheduler", () => {
  it("hydrates only the visible tail and bounded neighbors from 10,000 cold messages", async () => {
    const harness = createScheduler({ preheatUnits: 6 });
    const candidates = messages(10_000, "session-a");
    harness.scheduler.update({
      sessionId: "session-a",
      candidates,
      mountedUnitIds: ["unit-9998", "unit-9999"],
    });
    await idle(harness.scheduler);

    const diagnostics = harness.scheduler.diagnostics();
    expect(diagnostics.candidates).toBe(10_000);
    expect(diagnostics.selected).toBeLessThanOrEqual(8);
    expect(diagnostics.hydrated).toBe(diagnostics.selected);
    expect(harness.worker.parseCount).toBeLessThanOrEqual(8);
    expect(diagnostics.hydratedMessageIds).toContain("message-9999");
  });

  it("leaves streaming messages to their attached tail runtime and prioritizes explicit navigation", async () => {
    const harness = createScheduler({ maxConcurrent: 1, preheatUnits: 2 });
    const candidates = messages(100, "session-a");
    candidates[0] = candidate(0, "session-a", "running");
    harness.scheduler.update({
      sessionId: "session-a",
      candidates,
      mountedUnitIds: ["unit-50"],
      navigationUnitIds: ["unit-90"],
    });
    await idle(harness.scheduler);

    expect(harness.worker.parsedSources[0]).toBe("content-90");
    expect(harness.worker.parsedSources).not.toContain("content-0");
    expect(harness.scheduler.diagnostics().selected).toBeLessThan(10);
  });

  it("reuses a warm settled Snapshot across scheduler instances without canonical reparse", async () => {
    const worker = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: worker.factory });
    const adapter = new ConversationMarkdownAdapter();
    const first = new ConversationHydrationScheduler({ store, adapter, preheatUnits: 0 });
    const window = { sessionId: "session-a", candidates: [candidate(1, "session-a")], mountedUnitIds: ["unit-1"] };
    first.update(window);
    await idle(first);
    expect(worker.parseCount).toBe(1);

    const second = new ConversationHydrationScheduler({ store, adapter, preheatUnits: 0 });
    second.update(window);
    await idle(second);
    expect(worker.parseCount).toBe(1);
    expect(second.diagnostics().cacheHits).toBe(1);
  });

  it("hydrates a corrected settled revision and never serves the old source", async () => {
    const harness = createScheduler({ preheatUnits: 0 });
    const original = candidate(1, "session-a");
    harness.scheduler.update({ sessionId: "session-a", candidates: [original], mountedUnitIds: ["unit-1"] });
    await idle(harness.scheduler);
    const corrected = { ...original, source: "corrected", message: { ...original.message, content: "corrected" } };
    harness.scheduler.update({ sessionId: "session-a", candidates: [corrected], mountedUnitIds: ["unit-1"] });
    await idle(harness.scheduler);

    expect(harness.worker.parseCount).toBe(2);
    expect(harness.worker.parsedSources).toEqual(["content-1", "corrected"]);
  });

  it("retains only the latest projection and warm entry across many streaming revisions", async () => {
    const harness = createScheduler({ preheatUnits: 0, maxWarmEntries: 64 });
    const base = candidate(1, "session-a");
    for (let revision = 0; revision < 120; revision += 1) {
      const source = `stream-${revision}-${"x".repeat(revision)}`;
      harness.scheduler.update({
        sessionId: "session-a",
        candidates: [{ ...base, source, message: { ...base.message, content: source } }],
        mountedUnitIds: ["unit-1"],
      });
      await idle(harness.scheduler);
    }

    expect(harness.scheduler.diagnostics()).toMatchObject({
      knownProjections: 1,
      selected: 1,
    });
    expect(harness.scheduler.diagnostics().hydratedMessageIds).toHaveLength(1);
  });

  it("releases the previous session and enforces a bounded warm LRU", async () => {
    const harness = createScheduler({ preheatUnits: 20, maxWarmEntries: 3 });
    harness.scheduler.update({
      sessionId: "session-a",
      candidates: messages(20, "session-a"),
      mountedUnitIds: ["unit-10"],
    });
    await idle(harness.scheduler);
    expect(harness.scheduler.diagnostics().hydratedMessageIds).toHaveLength(3);
    harness.scheduler.switchSession("session-b");
    expect(harness.scheduler.diagnostics()).toMatchObject({ sessionId: "session-b", queued: 0, running: 0 });
    expect(harness.store.diagnostics().entryCount).toBe(0);
    expect(harness.scheduler.diagnostics().evicted).toBeGreaterThan(0);
  });

  it("cancels in-flight cold hydration on a rapid session switch", async () => {
    const harness = createScheduler({ maxConcurrent: 2, preheatUnits: 10 });
    harness.scheduler.update({
      sessionId: "session-a",
      candidates: messages(100, "session-a"),
      mountedUnitIds: ["unit-50"],
    });
    expect(harness.scheduler.diagnostics().running).toBe(2);
    harness.scheduler.switchSession("session-b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.scheduler.diagnostics()).toMatchObject({
      sessionId: "session-b",
      running: 0,
      queued: 0,
      hydratedMessageIds: [],
    });
    expect(harness.scheduler.diagnostics().cancelled).toBeGreaterThan(0);
  });

  it("preempts speculative hydration during user scroll and resumes from the latest window", async () => {
    const harness = createScheduler({ maxConcurrent: 2, preheatUnits: 10 });
    const window = {
      sessionId: "session-a",
      candidates: messages(100, "session-a"),
      mountedUnitIds: ["unit-50"],
    };
    harness.scheduler.update(window);
    expect(harness.scheduler.diagnostics().running).toBe(2);
    harness.scheduler.suspend();
    expect(harness.scheduler.diagnostics()).toMatchObject({ suspended: true, running: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsesWhileSuspended = harness.worker.parseCount;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.worker.parseCount).toBe(parsesWhileSuspended);

    harness.scheduler.update({ ...window, mountedUnitIds: ["unit-70"] });
    expect(harness.scheduler.diagnostics().suspended).toBe(false);
    await idle(harness.scheduler);
    expect(harness.scheduler.diagnostics().hydratedMessageIds).toContain("message-70");
  });
});

function createScheduler(options: { maxConcurrent?: number; preheatUnits?: number; maxWarmEntries?: number }) {
  const worker = new WorkerHarness();
  const store = new MarkdownRuntimeStore({ workerFactory: worker.factory, maxEntries: 128 });
  const adapter = new ConversationMarkdownAdapter();
  const scheduler = new ConversationHydrationScheduler({ store, adapter, ...options });
  return { worker, store, adapter, scheduler };
}

function messages(count: number, sessionId: string): ConversationHydrationCandidate[] {
  return Array.from({ length: count }, (_, index) => candidate(index, sessionId));
}

function candidate(
  index: number,
  sessionId: string,
  status: ConversationHydrationCandidate["message"]["status"] = "completed",
): ConversationHydrationCandidate {
  return {
    sessionId,
    message: { id: `message-${index}`, kind: "assistant", status, content: `content-${index}` },
    source: `content-${index}`,
    order: index,
    unitId: `unit-${index}`,
  };
}

async function idle(scheduler: ConversationHydrationScheduler): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = scheduler.diagnostics();
    if (state.queued === 0 && state.running === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("scheduler did not become idle");
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
    const source = message.payload.source.kind === "text"
      ? message.payload.source.content
      : new TextDecoder().decode(message.payload.source.data);
    this.harness.parseCount += 1;
    this.harness.parsedSources.push(source);
    queueMicrotask(() => {
      const snapshot = parseCanonicalMarkdownSnapshot({
        surface: message.surface,
        documentId: message.document_id,
        revision: message.revision,
        source,
        rendererProfile: message.payload.options.renderer_profile,
      }, { previousSnapshot: this.harness.snapshots.get(documentKey(message)) });
      this.harness.snapshots.set(documentKey(message), snapshot);
      this.emit({ ...identity(message), type: "snapshot-result", payload: snapshot });
    });
  }

  terminate(): void { this.terminated = true; }

  private emit(response: MarkdownWorkerResponse): void {
    if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

class WorkerHarness {
  readonly snapshots = new Map<string, MarkdownSnapshot>();
  readonly parsedSources: string[] = [];
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
