import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  MarkdownWorkerProtocolError,
  responseMatchesRequest,
  transferableSource,
  validateMarkdownWorkerRequest,
  validateMarkdownWorkerResponse,
  type MarkdownSurface,
  type MarkdownWorkerIdentity,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "./protocol";
import {
  MarkdownRevisionPublicationGate,
  type MarkdownRevisionPublication,
} from "../document/identity";
import { MarkdownSnapshotChunkAssembler } from "../document/MarkdownSnapshot";
import { applyMarkdownStreamTailPatch } from "../streaming/StreamTailPatch";

export interface DocumentWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: MarkdownWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface DocumentWorkerHostOptions {
  workerFactory?: () => DocumentWorkerLike;
  maxRetainedSnapshotBytes?: number;
  onWorkerError?: (error: MarkdownWorkerProtocolError) => void;
}

export interface DocumentWorkerAttachment {
  readonly documentId: string;
  readonly surface: MarkdownSurface;
  request(
    request: MarkdownWorkerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<MarkdownWorkerResponse>;
  currentSnapshot(): Extract<MarkdownWorkerResponse, { type: "snapshot-result" }> | null;
  detach(): void;
}

interface WorkerTask {
  readonly request: MarkdownWorkerRequest;
  readonly resolve: (response: MarkdownWorkerResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  callerSettled: boolean;
  cancelPosted: boolean;
  onAbort?: () => void;
  publication?: MarkdownRevisionPublication;
  chunkedSnapshot?: MarkdownSnapshotChunkAssembler;
}

interface DocumentState {
  readonly key: string;
  readonly surface: MarkdownSurface;
  readonly documentId: string;
  attachments: number;
  activeParse: WorkerTask | null;
  dirtyParse: WorkerTask | null;
  lastSnapshot: Extract<MarkdownWorkerResponse, { type: "snapshot-result" }> | null;
  lastSnapshotBytes: number;
  lastAccess: number;
  readonly publicationGate: MarkdownRevisionPublicationGate<
    Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>
  >;
}

export class DocumentWorkerHost {
  private readonly states = new Map<string, DocumentState>();
  private readonly requests = new Map<string, WorkerTask>();
  private readonly workerFactory: () => DocumentWorkerLike;
  private readonly maxRetainedSnapshotBytes: number;
  private readonly onWorkerError?: (error: MarkdownWorkerProtocolError) => void;
  private worker: DocumentWorkerLike | null = null;
  private attachmentSequence = 0;
  private lifecycleSequence = 0;
  private closed = false;

  constructor(options: DocumentWorkerHostOptions = {}) {
    this.maxRetainedSnapshotBytes = options.maxRetainedSnapshotBytes ?? 64 * 1024 * 1024;
    this.onWorkerError = options.onWorkerError;
    this.workerFactory = options.workerFactory ?? (() => {
      if (typeof Worker === "undefined") {
        throw new MarkdownWorkerProtocolError("worker-failed", "Markdown Worker is unavailable");
      }
      return new Worker(new URL("./document.worker.ts", import.meta.url), {
        type: "module",
        name: "keydex-markdown-document-worker",
      }) as unknown as DocumentWorkerLike;
    });
  }

  attach(surface: MarkdownSurface, documentId: string): DocumentWorkerAttachment {
    this.assertOpen();
    if (!documentId.trim()) throw new MarkdownWorkerProtocolError("invalid-message", "documentId is required");
    const key = documentKey(surface, documentId);
    const state = this.states.get(key) ?? this.createState(surface, documentId);
    state.attachments += 1;
    state.lastAccess = Date.now();
    const attachmentId = ++this.attachmentSequence;
    let detached = false;
    return {
      documentId,
      surface,
      request: (request, options) => {
        if (detached) return Promise.reject(cancelled("Document attachment is detached"));
        if (request.surface !== surface || request.document_id !== documentId) {
          return Promise.reject(new MarkdownWorkerProtocolError(
            "invalid-message",
            `Attachment ${attachmentId} cannot request another document`,
          ));
        }
        return this.request(state, request, options?.signal);
      },
      currentSnapshot: () => state.lastSnapshot,
      detach: () => {
        if (detached) return;
        detached = true;
        this.detachState(state);
      },
    };
  }

  async prewarm(identity: Omit<MarkdownWorkerIdentity, "protocol_version">): Promise<MarkdownWorkerResponse> {
    const attachment = this.attach(identity.surface, identity.document_id);
    try {
      return await attachment.request({
        ...identity,
        protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
        type: "capabilities",
        payload: {
          requested: [
            "canonical-parse",
            "stream-tail-parse",
            "find-index",
            "annotation-resolve",
            "snapshot-hydration",
            "chunked-snapshot",
            "transferable-array-buffer",
          ],
        },
      });
    } finally {
      attachment.detach();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.states.values()) this.cancelDocumentTasks(state, "Markdown Worker Host closed");
    this.states.clear();
    this.requests.clear();
    this.terminateWorker();
  }

  get workerCount(): number {
    return this.worker ? 1 : 0;
  }

  get attachedDocumentCount(): number {
    return [...this.states.values()].filter((state) => state.attachments > 0).length;
  }

  get retainedSnapshotBytes(): number {
    return [...this.states.values()].reduce((total, state) => total + state.lastSnapshotBytes, 0);
  }

  private request(
    state: DocumentState,
    requestValue: MarkdownWorkerRequest,
    signal?: AbortSignal,
  ): Promise<MarkdownWorkerResponse> {
    this.assertOpen();
    let request: MarkdownWorkerRequest;
    try {
      request = validateMarkdownWorkerRequest(requestValue);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(cancelled("Markdown Worker request aborted"));
    if (this.requests.has(request.request_id)
      || state.activeParse?.request.request_id === request.request_id
      || state.dirtyParse?.request.request_id === request.request_id) {
      return Promise.reject(new MarkdownWorkerProtocolError("invalid-message", `Duplicate request ${request.request_id}`));
    }
    return new Promise<MarkdownWorkerResponse>((resolve, reject) => {
      const task: WorkerTask = {
        request,
        resolve,
        reject,
        signal,
        callerSettled: false,
        cancelPosted: false,
      };
      if (isParseRequest(request)) task.publication = state.publicationGate.issue(request.revision);
      task.onAbort = () => this.abortTask(state, task, "Markdown Worker request aborted");
      signal?.addEventListener("abort", task.onAbort, { once: true });
      if (isParseRequest(request)) this.queueParse(state, task);
      else this.sendTask(task);
    });
  }

  private queueParse(state: DocumentState, task: WorkerTask): void {
    state.lastAccess = Date.now();
    if (!state.activeParse) {
      state.activeParse = task;
      this.sendTask(task);
      return;
    }
    this.settleCaller(state.activeParse, cancelled("Markdown parse superseded by a newer revision"));
    this.postCancel(state.activeParse, "superseded");
    if (state.dirtyParse) {
      this.settleCaller(state.dirtyParse, cancelled("Markdown parse superseded before it started"));
      this.cleanupTask(state.dirtyParse);
    }
    state.dirtyParse = task;
  }

  private sendTask(task: WorkerTask): void {
    let worker: DocumentWorkerLike;
    try {
      worker = this.ensureWorker();
      this.requests.set(task.request.request_id, task);
      worker.postMessage(task.request, transferList(task.request));
    } catch (error) {
      this.requests.delete(task.request.request_id);
      this.settleCaller(task, normalizeWorkerError(error));
      this.cleanupTask(task);
      const state = this.states.get(documentKey(task.request.surface, task.request.document_id));
      if (state?.activeParse === task) {
        state.activeParse = null;
        this.startDirty(state);
      }
    }
  }

  private ensureWorker(): DocumentWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => this.handleCrash(event.message || "Markdown Worker failed");
    worker.onmessageerror = () => this.handleCrash("Markdown Worker returned an unreadable message");
    this.worker = worker;
    return worker;
  }

  private handleMessage(value: unknown): void {
    let response: MarkdownWorkerResponse;
    try {
      response = validateMarkdownWorkerResponse(value);
    } catch (error) {
      this.handleCrash(normalizeWorkerError(error).message);
      return;
    }
    if (response.type === "cancelled") {
      const target = this.requests.get(response.payload.target_request_id);
      if (target) this.finishTask(target, response);
      return;
    }
    const task = this.requests.get(response.request_id);
    if (!task || !responseMatchesRequest(task.request, response)) return;
    if (response.type === "snapshot-start"
      || response.type === "snapshot-chunk"
      || response.type === "snapshot-complete") {
      try {
        this.handleSnapshotChunk(task, response);
      } catch (error) {
        this.handleCrash(normalizeWorkerError(error).message);
      }
      return;
    }
    if (task.chunkedSnapshot && response.type === "snapshot-result") {
      this.handleCrash("Markdown Worker mixed chunked and monolithic Snapshot responses");
      return;
    }
    if (response.type === "stream-tail-patch-result") {
      const state = this.states.get(documentKey(response.surface, response.document_id));
      const base = state?.lastSnapshot?.payload;
      if (!base) {
        this.handleCrash("Streaming Markdown patch arrived without a retained base Snapshot");
        return;
      }
      try {
        const snapshot = applyMarkdownStreamTailPatch(base, response.revision, response.payload);
        this.finishTask(task, {
          protocol_version: response.protocol_version,
          surface: response.surface,
          document_id: response.document_id,
          revision: response.revision,
          request_id: response.request_id,
          type: "snapshot-result",
          payload: snapshot,
        });
      } catch (error) {
        this.handleCrash(normalizeWorkerError(error).message);
      }
      return;
    }
    this.finishTask(task, response);
  }

  private handleSnapshotChunk(
    task: WorkerTask,
    response: Extract<MarkdownWorkerResponse, {
      type: "snapshot-start" | "snapshot-chunk" | "snapshot-complete";
    }>,
  ): void {
    if (!isParseRequest(task.request)) {
      throw new MarkdownWorkerProtocolError("invalid-message", "Only parse requests may publish Snapshot chunks");
    }
    if (response.type === "snapshot-start") {
      if (task.chunkedSnapshot) {
        throw new MarkdownWorkerProtocolError("invalid-message", "Markdown Worker started a Snapshot twice");
      }
      task.chunkedSnapshot = new MarkdownSnapshotChunkAssembler(response.payload);
      return;
    }
    const assembler = task.chunkedSnapshot;
    if (!assembler) {
      throw new MarkdownWorkerProtocolError("invalid-message", "Markdown Worker sent a Snapshot chunk before its header");
    }
    if (response.type === "snapshot-chunk") {
      const chunk = response.payload;
      switch (chunk.collection) {
        case "blocks":
          assembler.appendBlocks(chunk.start, chunk.items);
          break;
        case "outline":
          assembler.appendOutline(chunk.start, chunk.items);
          break;
        case "resources":
          assembler.appendResources(chunk.start, chunk.items);
          break;
      }
      return;
    }
    const snapshot = assembler.finalize(response.payload);
    task.chunkedSnapshot = undefined;
    this.finishTask(task, {
      protocol_version: response.protocol_version,
      surface: response.surface,
      document_id: response.document_id,
      revision: response.revision,
      request_id: response.request_id,
      type: "snapshot-result",
      payload: snapshot,
    });
  }

  private finishTask(task: WorkerTask, response: MarkdownWorkerResponse): void {
    this.requests.delete(task.request.request_id);
    const state = this.states.get(documentKey(task.request.surface, task.request.document_id));
    if (response.type === "snapshot-result"
      && task.publication
      && state?.publicationGate.publish(task.publication, response)) {
      state.lastSnapshot = response;
      state.lastSnapshotBytes = estimateSnapshotBytes(response);
      state.lastAccess = Date.now();
      this.enforceSnapshotBudget();
    }
    if (!task.callerSettled) {
      if (response.type === "error") {
        this.settleCaller(task, new MarkdownWorkerProtocolError(response.payload.code, response.payload.message));
      } else {
        task.callerSettled = true;
        task.resolve(response);
      }
    }
    this.cleanupTask(task);
    if (state?.activeParse === task) {
      state.activeParse = null;
      this.startDirty(state);
    }
  }

  private startDirty(state: DocumentState): void {
    const dirty = state.dirtyParse;
    state.dirtyParse = null;
    if (!dirty || dirty.callerSettled || dirty.signal?.aborted || state.attachments === 0) {
      if (dirty && !dirty.callerSettled) this.settleCaller(dirty, cancelled("Markdown parse no longer has a consumer"));
      if (dirty) this.cleanupTask(dirty);
      return;
    }
    state.activeParse = dirty;
    this.sendTask(dirty);
  }

  private abortTask(state: DocumentState, task: WorkerTask, message: string): void {
    if (task.callerSettled) return;
    this.settleCaller(task, cancelled(message));
    if (state.dirtyParse === task) {
      state.dirtyParse = null;
      this.cleanupTask(task);
      return;
    }
    if (state.activeParse === task) this.postCancel(task, "aborted");
    else {
      this.requests.delete(task.request.request_id);
      this.cleanupTask(task);
    }
  }

  private postCancel(task: WorkerTask, reason: string): void {
    if (task.cancelPosted || !this.worker) return;
    task.cancelPosted = true;
    this.worker.postMessage({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: task.request.surface,
      document_id: task.request.document_id,
      revision: task.request.revision,
      request_id: `lifecycle-cancel-${++this.lifecycleSequence}`,
      type: "cancel",
      payload: { target_request_id: task.request.request_id, reason },
    });
  }

  private handleCrash(message: string): void {
    const error = new MarkdownWorkerProtocolError("worker-failed", message);
    this.onWorkerError?.(error);
    this.terminateWorker();
    for (const task of this.requests.values()) {
      this.settleCaller(task, error);
      this.cleanupTask(task);
    }
    this.requests.clear();
    for (const state of this.states.values()) {
      if (state.dirtyParse) {
        this.settleCaller(state.dirtyParse, error);
        this.cleanupTask(state.dirtyParse);
      }
      state.activeParse = null;
      state.dirtyParse = null;
    }
  }

  private detachState(state: DocumentState): void {
    state.attachments = Math.max(0, state.attachments - 1);
    if (state.attachments > 0) return;
    this.cancelDocumentTasks(state, "Last Markdown document consumer detached");
    if (this.worker) {
      this.worker.postMessage({
        protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
        surface: state.surface,
        document_id: state.documentId,
        revision: state.lastSnapshot?.revision ?? "disposed",
        request_id: `lifecycle-dispose-${++this.lifecycleSequence}`,
        type: "dispose",
        payload: { reason: "last-consumer-detached" },
      });
    }
    this.states.delete(state.key);
    if (this.attachedDocumentCount === 0) this.terminateWorker();
  }

  private cancelDocumentTasks(state: DocumentState, message: string): void {
    if (state.activeParse) {
      this.settleCaller(state.activeParse, cancelled(message));
      this.requests.delete(state.activeParse.request.request_id);
      this.cleanupTask(state.activeParse);
    }
    if (state.dirtyParse) {
      this.settleCaller(state.dirtyParse, cancelled(message));
      this.cleanupTask(state.dirtyParse);
    }
    for (const [requestId, task] of this.requests) {
      if (task.request.surface === state.surface && task.request.document_id === state.documentId) {
        this.settleCaller(task, cancelled(message));
        this.cleanupTask(task);
        this.requests.delete(requestId);
      }
    }
    state.activeParse = null;
    state.dirtyParse = null;
  }

  private settleCaller(task: WorkerTask, error: unknown): void {
    if (task.callerSettled) return;
    task.callerSettled = true;
    task.reject(error);
  }

  private cleanupTask(task: WorkerTask): void {
    if (task.onAbort) task.signal?.removeEventListener("abort", task.onAbort);
  }

  private enforceSnapshotBudget(): void {
    while (this.retainedSnapshotBytes > this.maxRetainedSnapshotBytes) {
      const candidate = [...this.states.values()]
        .filter((state) => state.lastSnapshot)
        .sort((left, right) => left.lastAccess - right.lastAccess)[0];
      if (!candidate) break;
      candidate.lastSnapshot = null;
      candidate.lastSnapshotBytes = 0;
      candidate.publicationGate.evict();
    }
  }

  private createState(surface: MarkdownSurface, documentId: string): DocumentState {
    const state: DocumentState = {
      key: documentKey(surface, documentId),
      surface,
      documentId,
      attachments: 0,
      activeParse: null,
      dirtyParse: null,
      lastSnapshot: null,
      lastSnapshotBytes: 0,
      lastAccess: Date.now(),
      publicationGate: new MarkdownRevisionPublicationGate(),
    };
    this.states.set(state.key, state);
    return state;
  }

  private terminateWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  private assertOpen(): void {
    if (this.closed) throw new MarkdownWorkerProtocolError("worker-failed", "Markdown Worker Host is closed");
  }
}

function isParseRequest(request: MarkdownWorkerRequest): boolean {
  return request.type === "parse-canonical" || request.type === "parse-stream-tail";
}

function transferList(request: MarkdownWorkerRequest): Transferable[] {
  if (request.type === "parse-canonical") return transferableSource(request.payload.source);
  if (request.type === "parse-stream-tail") return transferableSource(request.payload.append);
  return [];
}

function documentKey(surface: MarkdownSurface, documentId: string): string {
  return `${surface}\u0000${documentId}`;
}

function cancelled(message: string): MarkdownWorkerProtocolError {
  return new MarkdownWorkerProtocolError("cancelled", message);
}

function normalizeWorkerError(error: unknown): MarkdownWorkerProtocolError {
  if (error instanceof MarkdownWorkerProtocolError) return error;
  return new MarkdownWorkerProtocolError(
    "worker-failed",
    error instanceof Error ? error.message : String(error),
  );
}

function estimateSnapshotBytes(
  response: Extract<MarkdownWorkerResponse, { type: "snapshot-result" }>,
): number {
  // The raw source is owned by Document Runtime, not retained by the Snapshot.
  // Count only the immutable model that this host actually caches.
  return response.payload.estimated_bytes;
}
