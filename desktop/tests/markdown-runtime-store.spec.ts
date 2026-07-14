import { describe, expect, it, vi } from "vitest";

import {
  MarkdownRuntimeStore,
  type MarkdownRuntimeDiagnostic,
} from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import type { DocumentWorkerLike } from "@/renderer/markdownRuntime/worker/DocumentWorkerHost";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

class ParsingWorker implements DocumentWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  terminated = false;

  constructor(private readonly harness: WorkerHarness) {}

  postMessage(message: MarkdownWorkerRequest): void {
    if (message.type === "cancel") {
      queueMicrotask(() => this.emit({
        ...identity(message),
        type: "cancelled",
        payload: { target_request_id: message.payload.target_request_id },
      }));
      return;
    }
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
      if (this.harness.crashRevisions.delete(message.revision)) {
        this.onerror?.({ message: `synthetic crash ${message.revision}` } as ErrorEvent);
        return;
      }
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
  readonly workers: ParsingWorker[] = [];
  readonly snapshots = new Map<string, MarkdownSnapshot>();
  readonly crashRevisions = new Set<string>();
  parseCount = 0;

  factory = () => {
    const worker = new ParsingWorker(this);
    this.workers.push(worker);
    return worker;
  };
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

const fileIdentity = {
  surface: "file",
  workspaceId: "workspace-a",
  path: "D:/repo/README.md",
} as const;

const messageIdentity = {
  surface: "message",
  sessionId: "session-a",
  messageId: "assistant-turn-1",
} as const;

describe("surface-neutral MarkdownRuntimeStore", () => {
  it("shares one file Snapshot and parse across multiple views", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const preview = store.attach(fileIdentity, "preview-main");
    const split = store.attach(fileIdentity, "preview-split");
    const first = preview.load({ revision: "r1", source: "# Shared" });
    const second = split.load({ revision: "r1", source: "# Shared" });

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(preview.current()).toBe(split.current());
    expect(harness.parseCount).toBe(1);
    expect(store.diagnostics()).toMatchObject({ entryCount: 1, attachedEntryCount: 1, viewCount: 2 });
    preview.detach();
    expect(preview.current()).toBeNull();
    split.detach();
    store.close();
  });

  it("keeps the old source/Snapshot atomically visible until the new revision publishes", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const view = store.attach(fileIdentity, "preview");
    await view.load({ revision: "r1", source: "Old" });
    const pending = view.load({ revision: "r2", source: "New" });

    expect(view.current()).toMatchObject({ revision: "r1", source: "Old", snapshot: { revision: "r1" } });
    await pending;
    expect(view.current()).toMatchObject({ revision: "r2", source: "New", snapshot: { revision: "r2" } });
    view.detach();
    store.close();
  });

  it("isolates workspace, session, path, and surface while sharing one message across hosts", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const messageMain = store.attach(messageIdentity, "conversation-main");
    const messageSidebar = store.attach(messageIdentity, "conversation-sidebar");
    const attachments = [
      messageMain,
      messageSidebar,
      store.attach({ ...messageIdentity, sessionId: "session-b" }, "other-session"),
      store.attach({ ...fileIdentity, workspaceId: "workspace-b" }, "other-workspace"),
      store.attach({ ...fileIdentity, path: "D:/repo/docs/README.md" }, "other-path"),
    ];
    await Promise.all(attachments.map((attachment) => attachment.load({ revision: "same", source: "Same" })));

    expect(messageMain.current()).toBe(messageSidebar.current());
    expect(new Set(attachments.map((attachment) => attachment.documentId)).size).toBe(4);
    expect(store.diagnostics()).toMatchObject({ entryCount: 4, viewCount: 5 });
    expect(harness.parseCount).toBe(4);
    attachments.forEach((attachment) => attachment.detach());
    store.close();
  });

  it("lets one caller abort without cancelling a shared parse", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const first = store.attach(messageIdentity, "host-a");
    const second = store.attach(messageIdentity, "host-b");
    const controller = new AbortController();
    const aborted = first.load({ revision: "r1", source: "Shared message", signal: controller.signal });
    const surviving = second.load({ revision: "r1", source: "Shared message" });
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ code: "cancelled" });
    await expect(surviving).resolves.toMatchObject({ revision: "r1" });
    expect(second.current()?.revision).toBe("r1");
    expect(harness.parseCount).toBe(1);
    first.detach();
    second.detach();
    store.close();
  });

  it("restores detached history from the budgeted cache without reparsing", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory, maxEntries: 8 });
    const first = store.attach(messageIdentity, "history-host");
    const original = await first.load({ revision: "history-r1", source: "Historical answer" });
    first.detach();
    expect(store.diagnostics()).toMatchObject({ entryCount: 1, attachedEntryCount: 0, workerCount: 0 });

    const restored = store.attach(messageIdentity, "history-host-restored");
    const cached = await restored.load({ revision: "history-r1", source: "Historical answer" });
    expect(cached).toBe(original);
    expect(harness.parseCount).toBe(1);
    expect(store.diagnostics().workerCount).toBe(0);
    const findRequest: MarkdownWorkerRequest = {
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: "message",
      document_id: restored.documentId,
      revision: "history-r1",
      request_id: "lazy-hydration-find",
      type: "query-find",
      payload: { query: "answer", case_sensitive: false, whole_word: false, limit: 10 },
    };
    const pendingFind = restored.request(findRequest);
    await vi.waitFor(() => expect([...harness.snapshots.values()]).toContain(cached));
    // The fake Worker intentionally does not implement query-find; reaching
    // this point proves hydration happened only after the first Worker query.
    void pendingFind.catch(() => undefined);
    expect([...harness.snapshots.values()]).toContain(cached);
    restored.detach();
    store.close();
  });

  it("keeps the file Worker attached for post-parse find and annotation queries", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const view = store.attach(fileIdentity, "large-file-preview");
    const snapshot = await view.load({ revision: "large-r1", source: "# Large file" });

    expect(view.current()?.snapshot).toBe(snapshot);
    expect(store.diagnostics().workerCount).toBe(1);
    expect(harness.workers[0]?.terminated).toBe(false);
    expect([...harness.snapshots.values()]).toContain(snapshot);

    const pendingFind = view.request({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: "file",
      document_id: view.documentId,
      revision: "large-r1",
      request_id: "large-file-lazy-find",
      type: "query-find",
      payload: { query: "Large", case_sensitive: false, whole_word: false, limit: 10 },
    });
    void pendingFind.catch(() => undefined);
    view.detach();
    store.close();
  });

  it("hard-evicts a retained file after its last attached view closes", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const view = store.attach(fileIdentity, "large-file-preview");
    await view.load({ revision: "large-r1", source: "Retained file content" });

    expect(store.evictWhenDetached(fileIdentity)).toBe(true);
    expect(store.diagnostics()).toMatchObject({ entryCount: 1, attachedEntryCount: 1 });

    view.detach();
    expect(store.diagnostics()).toMatchObject({
      entryCount: 0,
      attachedEntryCount: 0,
      retainedBytes: 0,
      workerCount: 0,
    });
    expect(harness.workers[0]?.terminated).toBe(true);
    store.close();
  });

  it("evicts only detached LRU entries under entry and byte budgets", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({
      workerFactory: harness.factory,
      maxEntries: 3,
      maxRetainedBytes: 1024 * 1024,
    });
    for (let index = 0; index < 10; index += 1) {
      const attachment = store.attach({ ...fileIdentity, path: `D:/repo/${index}.md` }, `view-${index}`);
      await attachment.load({ revision: `r${index}`, source: `# Document ${index}` });
      attachment.detach();
    }

    const diagnostics = store.diagnostics();
    expect(diagnostics.entryCount).toBe(3);
    expect(diagnostics.attachedEntryCount).toBe(0);
    expect(diagnostics.documents.map((entry) => entry.revision)).toEqual(["r7", "r8", "r9"]);

    const tinyStore = new MarkdownRuntimeStore({
      workerFactory: new WorkerHarness().factory,
      maxEntries: 8,
      maxRetainedBytes: 128,
    });
    const large = tinyStore.attach(fileIdentity, "large");
    await large.load({ revision: "large", source: "x".repeat(1024) });
    expect(tinyStore.diagnostics().overBudget).toBe(true);
    large.detach();
    expect(tinyStore.diagnostics()).toMatchObject({ entryCount: 0, retainedBytes: 0, overBudget: false });
    store.close();
    tinyStore.close();
  });

  it("preserves the current bundle through Worker crash and recovers on the next revision", async () => {
    const harness = new WorkerHarness();
    const diagnostics: MarkdownRuntimeDiagnostic[] = [];
    const store = new MarkdownRuntimeStore({
      workerFactory: harness.factory,
      onDiagnostic: (entry) => diagnostics.push(entry),
    });
    const view = store.attach(fileIdentity, "preview");
    await view.load({ revision: "r1", source: "Stable" });
    harness.crashRevisions.add("r2");

    await expect(view.load({ revision: "r2", source: "Crash" })).rejects.toMatchObject({ code: "worker-failed" });
    expect(view.current()).toMatchObject({ revision: "r1", source: "Stable" });
    await expect(view.load({ revision: "r2", source: "Crash" })).resolves.toMatchObject({ revision: "r2" });
    expect(view.current()).toMatchObject({ revision: "r2", source: "Crash" });
    await expect(view.load({ revision: "r3", source: "Recovered" })).resolves.toMatchObject({ revision: "r3" });
    expect(view.current()).toMatchObject({ revision: "r3", source: "Recovered" });
    expect(harness.workers.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.some((entry) => entry.event === "worker-failed")).toBe(true);
    view.detach();
    store.close();
  });

  it("coalesces concurrent hosts and safely releases after every detach", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const attachments = Array.from({ length: 20 }, (_, index) => store.attach(fileIdentity, `host-${index}`));
    const results = await Promise.all(attachments.map((attachment) => (
      attachment.load({ revision: "concurrent", source: "# Concurrent" })
    )));
    expect(new Set(results).size).toBe(1);
    expect(harness.parseCount).toBe(1);
    attachments.forEach((attachment) => attachment.detach());
    expect(store.diagnostics()).toMatchObject({ attachedEntryCount: 0, viewCount: 0, workerCount: 0 });
    store.close();
  });

  it("cancels pending work when the last view detaches", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const view = store.attach(fileIdentity, "ephemeral");
    const pending = view.load({ revision: "pending", source: "Pending" });
    view.detach();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(store.diagnostics()).toMatchObject({ entryCount: 0, viewCount: 0, workerCount: 0 });
    store.close();
  });

  it("keeps view state out of DocumentState", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({
      workerFactory: harness.factory,
    });
    const view = store.attach(fileIdentity, "preview");
    await view.load({ revision: "runtime-r1", source: "# Runtime" });

    const serialized = JSON.stringify(store.diagnostics()).toLowerCase();
    for (const forbidden of ["scroll", "selection", "find", "fold", "focus", "reveal"]) {
      expect(serialized).not.toContain(forbidden);
    }
    view.detach();
    store.close();
  });

  it("rejects one revision mapped to inconsistent source", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({ workerFactory: harness.factory });
    const view = store.attach(fileIdentity, "preview");
    await view.load({ revision: "r1", source: "First" });

    await expect(view.load({ revision: "r1", source: "Different" })).rejects.toThrow(/different source/u);
    expect(() => store.attach(fileIdentity, "preview")).toThrow(/already attached/u);
    view.detach();
    store.close();
  });

  it("does not let a diagnostic observer break attachment or publication", async () => {
    const harness = new WorkerHarness();
    const store = new MarkdownRuntimeStore({
      workerFactory: harness.factory,
      onDiagnostic: () => { throw new Error("observer failed"); },
    });
    const view = store.attach(fileIdentity, "resilient");

    await expect(view.load({ revision: "r1", source: "Still publishes" }))
      .resolves.toMatchObject({ revision: "r1" });
    expect(view.current()?.source).toBe("Still publishes");
    view.detach();
    store.close();
  });
});
