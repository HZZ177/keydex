import { describe, expect, it } from "vitest";

import { MarkdownRuntimeStore } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type { DocumentWorkerLike } from "@/renderer/markdownRuntime/worker/DocumentWorkerHost";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";

class ControlledWorker implements DocumentWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly posted: MarkdownWorkerRequest[] = [];
  readonly previousSnapshots = new Map<string, MarkdownSnapshot>();
  terminated = false;

  postMessage(message: MarkdownWorkerRequest): void {
    this.posted.push(message);
  }

  respond(request: Extract<MarkdownWorkerRequest, { type: "parse-canonical" }>): void {
    const source = request.payload.source.kind === "text"
      ? request.payload.source.content
      : new TextDecoder().decode(request.payload.source.data);
    const key = `${request.surface}\u0000${request.document_id}`;
    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: request.surface,
      documentId: request.document_id,
      revision: request.revision,
      source,
      rendererProfile: request.payload.options.renderer_profile,
    }, { previousSnapshot: this.previousSnapshots.get(key) });
    this.previousSnapshots.set(key, snapshot);
    this.emit({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: request.surface,
      document_id: request.document_id,
      revision: request.revision,
      request_id: request.request_id,
      type: "snapshot-result",
      payload: snapshot,
    });
  }

  emit(response: MarkdownWorkerResponse): void {
    if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

class ParsingWorker extends ControlledWorker {
  parseCount = 0;

  override postMessage(message: MarkdownWorkerRequest): void {
    super.postMessage(message);
    if (message.type === "parse-canonical") {
      this.parseCount += 1;
      queueMicrotask(() => this.respond(message));
      return;
    }
    if (message.type === "hydrate-snapshot") {
      queueMicrotask(() => this.emit({
        protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
        surface: message.surface,
        document_id: message.document_id,
        revision: message.revision,
        request_id: message.request_id,
        type: "hydrated",
        payload: { estimated_bytes: message.payload.snapshot.estimated_bytes },
      }));
      return;
    }
    if (message.type === "cancel") {
      queueMicrotask(() => this.emit({
        protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
        surface: message.surface,
        document_id: message.document_id,
        revision: message.revision,
        request_id: message.request_id,
        type: "cancelled",
        payload: { target_request_id: message.payload.target_request_id },
      }));
    }
  }
}

const fileIdentity = {
  surface: "file",
  workspaceId: "lifecycle-workspace",
  path: "D:/repo/README.md",
} as const;

describe("Worker and Runtime lifecycle cross-module gate", () => {
  it("keeps the old Snapshot visible and publishes only revision 100 during a rapid burst", async () => {
    const worker = new ControlledWorker();
    const store = new MarkdownRuntimeStore({ workerFactory: () => worker });
    const view = store.attach(fileIdentity, "preview-main");
    const base = view.load({ revision: "base", source: "# Stable base" });
    worker.respond(parseRequests(worker)[0]);
    await base;

    const observed = Array.from({ length: 100 }, (_, index) => (
      view.load({ revision: `r${index}`, source: `# Revision ${index}` }).then(
        (snapshot) => ({ status: "resolved" as const, snapshot }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      )
    ));
    const burstRequests = parseRequests(worker).filter((request) => request.revision !== "base");

    expect(burstRequests.map((request) => request.revision)).toEqual(["r0"]);
    expect(worker.posted.filter((request) => request.type === "cancel")).toHaveLength(1);
    expect(view.current()).toMatchObject({ revision: "base", source: "# Stable base" });

    worker.respond(burstRequests[0]);
    const latest = parseRequests(worker).at(-1);
    expect(latest?.revision).toBe("r99");
    expect(view.current()).toMatchObject({ revision: "base", source: "# Stable base" });
    worker.respond(latest!);

    const results = await Promise.all(observed);
    expect(results.slice(0, -1).every((result) => result.status === "rejected")).toBe(true);
    expect(results.at(-1)).toMatchObject({ status: "resolved", snapshot: { revision: "r99" } });
    expect(view.current()).toMatchObject({ revision: "r99", source: "# Revision 99" });

    view.detach();
    expect(store.diagnostics()).toMatchObject({ workerCount: 0, viewCount: 0 });
    store.close();
  });

  it("protects nine attached documents, shares a tenth view, then returns to the eight-entry budget", async () => {
    const workers: ParsingWorker[] = [];
    const store = new MarkdownRuntimeStore({
      maxEntries: 8,
      maxRetainedBytes: 32 * 1024 * 1024,
      workerFactory: () => {
        const worker = new ParsingWorker();
        workers.push(worker);
        return worker;
      },
    });
    const documents = Array.from({ length: 9 }, (_, index) => (
      index % 2 === 0
        ? { surface: "file" as const, workspaceId: "lifecycle-workspace", path: `D:/repo/${index}.md` }
        : { surface: "message" as const, sessionId: "lifecycle-session", messageId: `turn-${index}` }
    ));
    const attachments = documents.map((identity, index) => store.attach(identity, `view-${index}`));
    const shared = store.attach(documents[0], "view-0-split");
    const loads = attachments.map((attachment, index) => attachment.load({
      revision: `r${index}`,
      source: `# Document ${index}`,
    }));
    loads.push(shared.load({ revision: "r0", source: "# Document 0" }));
    const snapshots = await Promise.all(loads);

    expect(snapshots[0]).toBe(snapshots.at(-1));
    expect(workers).toHaveLength(1);
    expect(workers[0].parseCount).toBe(9);
    expect(store.diagnostics()).toMatchObject({
      entryCount: 9,
      attachedEntryCount: 9,
      viewCount: 10,
      overBudget: true,
      workerCount: 1,
    });

    attachments.forEach((attachment) => attachment.detach());
    expect(store.diagnostics()).toMatchObject({
      entryCount: 8,
      attachedEntryCount: 1,
      viewCount: 1,
      overBudget: false,
    });
    shared.detach();
    const detached = store.diagnostics();
    expect(detached).toMatchObject({
      entryCount: 8,
      attachedEntryCount: 0,
      viewCount: 0,
      overBudget: false,
      workerCount: 0,
    });
    expect(workers[0].terminated).toBe(true);

    const parseCountBeforeRestore = workers[0].parseCount;
    const restored = store.attach(documents[8], "restored");
    await expect(restored.load({ revision: "r8", source: "# Document 8" }))
      .resolves.toBe(snapshots[8]);
    expect(workers[0].parseCount).toBe(parseCountBeforeRestore);
    restored.detach();
    expect(store.diagnostics().workerCount).toBe(0);
    store.close();
  });
});

function parseRequests(
  worker: ControlledWorker,
): Array<Extract<MarkdownWorkerRequest, { type: "parse-canonical" }>> {
  return worker.posted.filter(
    (request): request is Extract<MarkdownWorkerRequest, { type: "parse-canonical" }> => (
      request.type === "parse-canonical"
    ),
  );
}
