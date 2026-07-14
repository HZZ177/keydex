import type { DocumentWorkerLike } from "./worker/DocumentWorkerHost";
import {
  DocumentWorkerHost,
  type DocumentWorkerAttachment,
} from "./worker/DocumentWorkerHost";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  MarkdownWorkerProtocolError,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "./worker/protocol";
import type { MarkdownSnapshot } from "./document/MarkdownSnapshot";
import {
  createMarkdownDocumentIdentity,
  type MarkdownDocumentIdentityInput,
} from "./document/identity";

export interface MarkdownRuntimeLoadInput {
  readonly revision: string;
  readonly source: string;
  readonly sourceBytes?: number;
  readonly retention?: MarkdownRuntimeRetention;
  readonly signal?: AbortSignal;
}

export type MarkdownRuntimeRetention = "transient" | "settled";

export interface MarkdownRuntimeDocumentBundle {
  readonly documentId: string;
  readonly revision: string;
  readonly source: string;
  readonly sourceBytes: number;
  readonly retention: MarkdownRuntimeRetention;
  readonly snapshot: MarkdownSnapshot;
}

export interface MarkdownRuntimeAttachment {
  readonly documentId: string;
  readonly surface: "file" | "message";
  readonly viewId: string;
  load(input: MarkdownRuntimeLoadInput): Promise<MarkdownSnapshot>;
  request(
    request: MarkdownWorkerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<MarkdownWorkerResponse>;
  current(): MarkdownRuntimeDocumentBundle | null;
  detach(): void;
}

export type MarkdownRuntimeDiagnosticEvent =
  | "attach"
  | "detach"
  | "cache-hit"
  | "parse-shared"
  | "parse-started"
  | "snapshot-published"
  | "parse-failed"
  | "worker-failed"
  | "evicted";

export interface MarkdownRuntimeDiagnostic {
  readonly event: MarkdownRuntimeDiagnosticEvent;
  readonly documentId: string;
  readonly surface: "file" | "message";
  readonly revision: string | null;
  readonly viewCount: number;
  readonly detail?: string;
}

export interface MarkdownRuntimeStoreSnapshot {
  readonly entryCount: number;
  readonly attachedEntryCount: number;
  readonly viewCount: number;
  readonly retainedBytes: number;
  readonly pendingBytes: number;
  readonly overBudget: boolean;
  readonly workerCount: number;
  readonly documents: readonly {
    readonly documentId: string;
    readonly surface: "file" | "message";
    readonly revision: string | null;
    readonly pendingRevision: string | null;
    readonly viewCount: number;
    readonly retainedBytes: number;
    readonly retention: MarkdownRuntimeRetention | null;
  }[];
}

export interface MarkdownRuntimeStoreOptions {
  readonly maxEntries?: number;
  readonly maxRetainedBytes?: number;
  readonly workerHost?: DocumentWorkerHost;
  readonly workerFactory?: () => DocumentWorkerLike;
  readonly onDiagnostic?: (diagnostic: MarkdownRuntimeDiagnostic) => void;
}

interface PendingDocument {
  readonly epoch: number;
  readonly revision: string;
  readonly source: string;
  readonly sourceBytes: number;
  readonly retention: MarkdownRuntimeRetention;
  readonly promise: Promise<MarkdownSnapshot>;
}

interface DocumentState {
  readonly key: string;
  readonly identity: MarkdownDocumentIdentityInput;
  readonly documentId: string;
  readonly surface: "file" | "message";
  readonly rendererProfile: "file-preview" | "conversation";
  readonly viewIds: Set<string>;
  bundle: MarkdownRuntimeDocumentBundle | null;
  pending: PendingDocument | null;
  workerAttachment: DocumentWorkerAttachment | null;
  evictOnDetach: boolean;
  epoch: number;
  lastAccess: number;
}

export class MarkdownRuntimeStore {
  private readonly states = new Map<string, DocumentState>();
  private readonly maxEntries: number;
  private readonly maxRetainedBytes: number;
  private readonly host: DocumentWorkerHost;
  private readonly onDiagnostic?: (diagnostic: MarkdownRuntimeDiagnostic) => void;
  private requestSequence = 0;
  private closed = false;

  constructor(options: MarkdownRuntimeStoreOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 12, "maxEntries");
    this.maxRetainedBytes = positiveInteger(options.maxRetainedBytes ?? 128 * 1024 * 1024, "maxRetainedBytes");
    this.onDiagnostic = options.onDiagnostic;
    this.host = options.workerHost ?? new DocumentWorkerHost({
      workerFactory: options.workerFactory,
      maxRetainedSnapshotBytes: this.maxRetainedBytes,
      onWorkerError: (error) => this.emitAll("worker-failed", error.message),
    });
  }

  attach(identity: MarkdownDocumentIdentityInput, viewId: string): MarkdownRuntimeAttachment {
    this.assertOpen();
    if (!viewId.trim()) throw new MarkdownWorkerProtocolError("invalid-message", "viewId is required");
    const documentId = createMarkdownDocumentIdentity(identity);
    const key = `${identity.surface}\u0000${documentId}`;
    const state = this.states.get(key) ?? this.createState(key, documentId, identity);
    if (state.viewIds.has(viewId)) {
      throw new MarkdownWorkerProtocolError("invalid-message", `View ${viewId} is already attached to ${documentId}`);
    }
    state.viewIds.add(viewId);
    state.lastAccess = Date.now();
    this.emit(state, "attach", state.bundle?.revision ?? null, viewId);
    let detached = false;
    return Object.freeze({
      documentId,
      surface: identity.surface,
      viewId,
      load: (input: MarkdownRuntimeLoadInput) => {
        if (detached) return Promise.reject(cancelled("Markdown Runtime view is detached"));
        try {
          return this.load(state, input);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      request: (request: MarkdownWorkerRequest, options?: { signal?: AbortSignal }) => {
        if (detached) return Promise.reject(cancelled("Markdown Runtime view is detached"));
        if (request.surface !== state.surface || request.document_id !== state.documentId) {
          return Promise.reject(new MarkdownWorkerProtocolError(
            "invalid-message",
            `View ${viewId} cannot request another Markdown document`,
          ));
        }
        return this.requestDocument(state, request, options);
      },
      current: () => detached ? null : state.bundle,
      detach: () => {
        if (detached) return;
        detached = true;
        this.detach(state, viewId);
      },
    });
  }

  diagnostics(): MarkdownRuntimeStoreSnapshot {
    const documents = [...this.states.values()].map((state) => Object.freeze({
      documentId: state.documentId,
      surface: state.surface,
      revision: state.bundle?.revision ?? null,
      pendingRevision: state.pending?.revision ?? null,
      viewCount: state.viewIds.size,
      retainedBytes: retainedStateBytes(state),
      retention: state.bundle?.retention ?? null,
    }));
    const retainedBytes = documents.reduce((total, entry) => total + entry.retainedBytes, 0);
    const pendingBytes = [...this.states.values()].reduce(
      (total, state) => total + (state.pending ? estimateSourceBytes(state.pending.source) : 0),
      0,
    );
    return Object.freeze({
      entryCount: documents.length,
      attachedEntryCount: documents.filter((entry) => entry.viewCount > 0).length,
      viewCount: documents.reduce((total, entry) => total + entry.viewCount, 0),
      retainedBytes,
      pendingBytes,
      overBudget: retainedBytes + pendingBytes > this.maxRetainedBytes || documents.length > this.maxEntries,
      workerCount: this.host.workerCount,
      documents: Object.freeze(documents),
    });
  }

  evict(identity: MarkdownDocumentIdentityInput): boolean {
    this.assertOpen();
    const documentId = createMarkdownDocumentIdentity(identity);
    const key = `${identity.surface}\u0000${documentId}`;
    const state = this.states.get(key);
    if (!state || state.viewIds.size > 0) return false;
    state.epoch += 1;
    state.pending = null;
    state.workerAttachment?.detach();
    this.states.delete(key);
    this.emit(state, "evicted", state.bundle?.revision ?? null, "explicit-cache-eviction");
    return true;
  }

  evictWhenDetached(identity: MarkdownDocumentIdentityInput): boolean {
    this.assertOpen();
    const documentId = createMarkdownDocumentIdentity(identity);
    const key = `${identity.surface}\u0000${documentId}`;
    const state = this.states.get(key);
    if (!state) return false;
    state.evictOnDetach = true;
    return state.viewIds.size > 0 ? true : this.evict(identity);
  }

  evictDetachedMessageSession(sessionId: string): number {
    this.assertOpen();
    let evicted = 0;
    for (const state of [...this.states.values()]) {
      if (
        state.surface !== "message"
        || state.identity.surface !== "message"
        || state.identity.sessionId !== sessionId
        || state.viewIds.size > 0
      ) continue;
      if (this.evict(state.identity)) evicted += 1;
    }
    return evicted;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.states.values()) state.workerAttachment?.detach();
    this.states.clear();
    this.host.close();
  }

  private load(state: DocumentState, input: MarkdownRuntimeLoadInput): Promise<MarkdownSnapshot> {
    this.assertOpen();
    validateLoad(input);
    state.lastAccess = Date.now();
    if (state.pending?.revision === input.revision) {
      assertSamePendingSource(state.pending, input);
      this.emit(state, "parse-shared", input.revision);
      return raceWithAbort(state.pending.promise, input.signal);
    }
    if (state.bundle?.revision === input.revision) {
      assertSameRevisionSource(state.bundle, input);
      // Visible-first cache restoration must not wait for a full Snapshot to
      // cross the Worker boundary again. Worker-backed Find/annotation calls
      // hydrate lazily in requestDocument when they are actually requested.
      this.emit(state, "cache-hit", input.revision, state.workerAttachment ? undefined : "lazy-worker-hydration");
      return raceWithAbort(Promise.resolve(state.bundle.snapshot), input.signal);
    }

    const encodedSource = new TextEncoder().encode(input.source);
    const sourceBytes = input.sourceBytes ?? encodedSource.byteLength;
    if (sourceBytes !== encodedSource.byteLength) {
      return Promise.reject(new MarkdownWorkerProtocolError("invalid-payload", "sourceBytes does not match UTF-8 source"));
    }
    const epoch = ++state.epoch;
    const attachment = state.workerAttachment ?? this.attachWorker(state);
    const request = parseRequest(state, input.revision, encodedSource.buffer, sourceBytes, ++this.requestSequence);
    this.emit(state, "parse-started", input.revision);
    const parsePromise = attachment.request(request).then((response) => {
      if (response.type !== "snapshot-result") {
        throw new MarkdownWorkerProtocolError("worker-failed", `Expected snapshot-result, received ${response.type}`);
      }
      if (state.pending?.epoch !== epoch || response.revision !== input.revision) {
        throw cancelled("Markdown Snapshot was superseded before publication");
      }
      const bundle = Object.freeze({
        documentId: state.documentId,
        revision: response.revision,
        source: input.source,
        sourceBytes,
        retention: input.retention ?? "settled",
        snapshot: response.payload,
      });
      state.bundle = bundle;
      state.pending = null;
      state.lastAccess = Date.now();
      this.emit(state, "snapshot-published", response.revision);
      this.enforceBudget();
      return response.payload;
    }).catch((error: unknown) => {
      if (state.pending?.epoch === epoch) state.pending = null;
      this.emit(state, "parse-failed", input.revision, error instanceof Error ? error.message : String(error));
      this.enforceBudget();
      throw error;
    });
    state.pending = Object.freeze({
      epoch,
      revision: input.revision,
      source: input.source,
      sourceBytes,
      retention: input.retention ?? "settled",
      promise: parsePromise,
    });
    return raceWithAbort(parsePromise, input.signal);
  }

  private rehydrateWorker(state: DocumentState, input: MarkdownRuntimeLoadInput): Promise<MarkdownSnapshot> {
    const bundle = state.bundle;
    if (!bundle || bundle.revision !== input.revision) {
      return Promise.reject(new MarkdownWorkerProtocolError("invalid-payload", "Markdown Snapshot cache entry is unavailable"));
    }
    const sourceBytes = input.sourceBytes ?? new TextEncoder().encode(input.source).byteLength;
    if (sourceBytes !== bundle.sourceBytes) return Promise.reject(new MarkdownWorkerProtocolError("invalid-payload", "sourceBytes does not match cached source"));
    const epoch = ++state.epoch;
    const attachment = this.attachWorker(state);
    this.emit(state, "cache-hit", input.revision, "worker-rehydrate");
    const parsePromise = attachment.request({
      protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
      surface: state.surface,
      document_id: state.documentId,
      revision: input.revision,
      request_id: `hydrate-${++this.requestSequence}`,
      type: "hydrate-snapshot",
      payload: { source: bundle.source, snapshot: bundle.snapshot },
    }).then((response) => {
      if (response.type !== "hydrated") {
        throw new MarkdownWorkerProtocolError("worker-failed", `Expected hydrated, received ${response.type}`);
      }
      if (state.pending?.epoch !== epoch || response.revision !== input.revision) {
        throw cancelled("Markdown Worker rehydration was superseded before publication");
      }
      state.pending = null;
      state.lastAccess = Date.now();
      this.emit(state, "snapshot-published", response.revision, "worker-rehydrated");
      this.enforceBudget();
      return bundle.snapshot;
    }).catch((error: unknown) => {
      if (state.pending?.epoch === epoch) state.pending = null;
      this.emit(state, "parse-failed", input.revision, error instanceof Error ? error.message : String(error));
      this.enforceBudget();
      throw error;
    });
    state.pending = Object.freeze({
      epoch,
      revision: input.revision,
      source: input.source,
      sourceBytes,
      retention: bundle.retention,
      promise: parsePromise,
    });
    return raceWithAbort(parsePromise, input.signal);
  }

  private requestDocument(
    state: DocumentState,
    request: MarkdownWorkerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<MarkdownWorkerResponse> {
    const bundle = state.bundle;
    if (!state.workerAttachment && bundle && request.revision === bundle.revision && request.type !== "capabilities") {
      return this.rehydrateWorker(state, {
        revision: bundle.revision,
        source: bundle.source,
        sourceBytes: bundle.sourceBytes,
        retention: bundle.retention,
        signal: options?.signal,
      }).then(() => state.workerAttachment!.request(request, options));
    }
    const attachment = state.workerAttachment ?? this.attachWorker(state);
    return attachment.request(request, options);
  }

  private attachWorker(state: DocumentState): DocumentWorkerAttachment {
    const attachment = this.host.attach(state.surface, state.documentId);
    state.workerAttachment = attachment;
    return attachment;
  }

  private detach(state: DocumentState, viewId: string): void {
    state.viewIds.delete(viewId);
    state.lastAccess = Date.now();
    this.emit(state, "detach", state.bundle?.revision ?? state.pending?.revision ?? null, viewId);
    if (state.viewIds.size > 0) return;
    // Invalidate the pending parse/hydration synchronously. A replacement view
    // can attach in the same React commit; it must not inherit the cancellation
    // promise produced by detaching the previous last consumer.
    if (state.pending) {
      state.epoch += 1;
      state.pending = null;
    }
    state.workerAttachment?.detach();
    state.workerAttachment = null;
    if (state.evictOnDetach) {
      this.states.delete(state.key);
      this.emit(state, "evicted", state.bundle?.revision ?? null, "explicit-close");
      return;
    }
    if (!state.bundle) {
      this.states.delete(state.key);
      return;
    }
    if (state.bundle.retention === "transient") {
      this.states.delete(state.key);
      this.emit(state, "evicted", state.bundle.revision, "transient-detach");
      return;
    }
    this.enforceBudget();
  }

  private enforceBudget(): void {
    while (this.states.size > this.maxEntries || this.totalRetainedBytes() > this.maxRetainedBytes) {
      const candidate = [...this.states.values()]
        .filter((state) => state.viewIds.size === 0)
        .sort((left, right) => left.lastAccess - right.lastAccess)[0];
      if (!candidate) return;
      candidate.workerAttachment?.detach();
      this.states.delete(candidate.key);
      this.emit(candidate, "evicted", candidate.bundle?.revision ?? null, "LRU budget");
    }
  }

  private totalRetainedBytes(): number {
    return [...this.states.values()].reduce((total, state) => total + retainedStateBytes(state), 0);
  }

  private createState(
    key: string,
    documentId: string,
    identity: MarkdownDocumentIdentityInput,
  ): DocumentState {
    const state: DocumentState = {
      key,
      identity: Object.freeze({ ...identity }) as MarkdownDocumentIdentityInput,
      documentId,
      surface: identity.surface,
      rendererProfile: identity.surface === "file" ? "file-preview" : "conversation",
      viewIds: new Set(),
      bundle: null,
      pending: null,
      workerAttachment: null,
      evictOnDetach: false,
      epoch: 0,
      lastAccess: Date.now(),
    };
    this.states.set(key, state);
    return state;
  }

  private emit(
    state: DocumentState,
    event: MarkdownRuntimeDiagnosticEvent,
    revision: string | null,
    detail?: string,
  ): void {
    try {
      this.onDiagnostic?.(Object.freeze({
        event,
        documentId: state.documentId,
        surface: state.surface,
        revision,
        viewCount: state.viewIds.size,
        detail,
      }));
    } catch {
      // Diagnostics must never affect publication or Worker lifecycle.
    }
  }

  private emitAll(event: MarkdownRuntimeDiagnosticEvent, detail: string): void {
    for (const state of this.states.values()) {
      this.emit(state, event, state.pending?.revision ?? state.bundle?.revision ?? null, detail);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MarkdownWorkerProtocolError("worker-failed", "Markdown Runtime Store is closed");
  }
}

function parseRequest(
  state: DocumentState,
  revision: string,
  source: ArrayBuffer,
  sourceBytes: number,
  sequence: number,
): Extract<MarkdownWorkerRequest, { type: "parse-canonical" }> {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: state.surface,
    document_id: state.documentId,
    revision,
    request_id: `markdown-runtime-${sequence}`,
    type: "parse-canonical",
    payload: {
      source: { kind: "utf8-buffer", encoding: "utf-8", data: source, byte_length: sourceBytes },
      options: {
        renderer_profile: state.rendererProfile,
        enable_html: false,
        enable_mdx: false,
      },
    },
  };
}

function validateLoad(input: MarkdownRuntimeLoadInput): void {
  if (!input.revision.trim()) throw new MarkdownWorkerProtocolError("invalid-payload", "revision is required");
  if (input.sourceBytes !== undefined && (!Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 0)) {
    throw new MarkdownWorkerProtocolError("invalid-payload", "sourceBytes must be a non-negative integer");
  }
  if (input.retention !== undefined && input.retention !== "transient" && input.retention !== "settled") {
    throw new MarkdownWorkerProtocolError("invalid-payload", "retention must be transient or settled");
  }
  if (input.signal?.aborted) throw cancelled("Markdown Runtime load aborted");
}

function assertSameRevisionSource(
  bundle: MarkdownRuntimeDocumentBundle,
  input: MarkdownRuntimeLoadInput,
): void {
  if (bundle.source !== input.source) {
    throw new MarkdownWorkerProtocolError("invalid-payload", "One revision cannot identify different source text");
  }
  if (input.sourceBytes !== undefined && bundle.sourceBytes !== input.sourceBytes) {
    throw new MarkdownWorkerProtocolError("invalid-payload", "One revision cannot identify different byte length");
  }
  if (input.retention !== undefined && bundle.retention !== input.retention) {
    throw new MarkdownWorkerProtocolError("invalid-payload", "One revision cannot use different retention policies");
  }
}

function assertSamePendingSource(pending: PendingDocument, input: MarkdownRuntimeLoadInput): void {
  if (pending.source !== input.source) {
    throw new MarkdownWorkerProtocolError("invalid-payload", "Pending revision source text is inconsistent");
  }
  if (input.sourceBytes !== undefined && pending.sourceBytes !== input.sourceBytes) {
    throw new MarkdownWorkerProtocolError("invalid-payload", "Pending revision byte length is inconsistent");
  }
  if (input.retention !== undefined && pending.retention !== input.retention) {
    throw new MarkdownWorkerProtocolError("invalid-payload", "Pending revision retention is inconsistent");
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelled("Markdown Runtime load aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled("Markdown Runtime load aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function retainedStateBytes(state: DocumentState): number {
  if (!state.bundle) return 0;
  return estimateSourceBytes(state.bundle.source) + state.bundle.snapshot.estimated_bytes;
}

function estimateSourceBytes(source: string): number {
  return source.length * 2;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function cancelled(message: string): MarkdownWorkerProtocolError {
  return new MarkdownWorkerProtocolError("cancelled", message);
}
