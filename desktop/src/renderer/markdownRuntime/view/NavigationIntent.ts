import type {
  MarkdownViewDescriptor,
  MarkdownViewRevealTarget,
  MarkdownViewScrollAnchor,
} from "./types";

export type MarkdownNavigationIntentKind =
  | "initial"
  | "restore"
  | "revision-correction"
  | "reveal"
  | "find"
  | "annotation"
  | "capsule";

export type MarkdownNavigationIntentPayload =
  | {
      readonly type: "scroll-anchor";
      readonly anchor: MarkdownViewScrollAnchor;
    }
  | {
      readonly type: "reveal";
      readonly target: MarkdownViewRevealTarget;
    };

export interface MarkdownNavigationIntent {
  readonly id: number;
  readonly kind: MarkdownNavigationIntentKind;
  readonly priority: number;
  readonly descriptor: MarkdownViewDescriptor;
  readonly documentId: string;
  readonly payload: MarkdownNavigationIntentPayload;
  readonly requestedRevision: string | null;
  readonly requestedAt: number;
  readonly interactionEpoch: number;
}

export interface MarkdownNavigationRuntimeContext {
  readonly revision: string;
  readonly epoch: number;
  execute(intent: MarkdownNavigationIntent, signal: AbortSignal): void | Promise<void>;
}

export interface MarkdownNavigationIntentHandle {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly promise: Promise<void>;
  cancel(reason?: string): void;
}

export interface MarkdownNavigationRequestOptions {
  readonly requestedRevision?: string | null;
  readonly signal?: AbortSignal;
}

export type MarkdownNavigationIntentErrorCode =
  | "superseded"
  | "lower-priority"
  | "cancelled"
  | "user-interrupted"
  | "revision-changed"
  | "runtime-changed"
  | "view-detached"
  | "disposed"
  | "failed";

export class MarkdownNavigationIntentError extends Error {
  constructor(readonly code: MarkdownNavigationIntentErrorCode, message: string) {
    super(message);
    this.name = "MarkdownNavigationIntentError";
  }
}

export interface MarkdownNavigationIntentDiagnostics {
  readonly requested: number;
  readonly completed: number;
  readonly superseded: number;
  readonly rejectedLowerPriority: number;
  readonly userInterrupted: number;
  readonly revisionCancelled: number;
  readonly pending: boolean;
  readonly currentKind: MarkdownNavigationIntentKind | null;
  readonly runtimeEpoch: number | null;
  readonly interactionEpoch: number;
}

interface PendingIntent {
  readonly intent: MarkdownNavigationIntent;
  readonly controller: AbortController;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly externalSignal: AbortSignal | null;
  readonly onExternalAbort: (() => void) | null;
  runningEpoch: number | null;
}

const PRIORITY: Readonly<Record<MarkdownNavigationIntentKind, number>> = Object.freeze({
  initial: 5,
  restore: 10,
  "revision-correction": 20,
  reveal: 100,
  find: 100,
  annotation: 100,
  capsule: 100,
});

export class MarkdownNavigationIntentController {
  private runtime: MarkdownNavigationRuntimeContext | null = null;
  private pending: PendingIntent | null = null;
  private sequence = 0;
  private interactionEpoch = 0;
  private disposed = false;
  private requested = 0;
  private completed = 0;
  private superseded = 0;
  private rejectedLowerPriority = 0;
  private userInterrupted = 0;
  private revisionCancelled = 0;

  constructor(
    readonly descriptor: MarkdownViewDescriptor,
    readonly documentId: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    required(documentId, "documentId");
  }

  publishRuntime(context: MarkdownNavigationRuntimeContext): void {
    this.assertActive();
    validateRuntime(context);
    const previous = this.runtime;
    if (previous && context.epoch < previous.epoch) {
      throw new Error(`Markdown navigation runtime epoch ${context.epoch} is older than ${previous.epoch}`);
    }
    if (this.pending && this.pending.runningEpoch !== null
      && (previous?.epoch !== context.epoch || previous.revision !== context.revision)) {
      if (previous?.revision !== context.revision) this.revisionCancelled += 1;
      this.rejectPending(new MarkdownNavigationIntentError(
        previous?.revision !== context.revision ? "revision-changed" : "runtime-changed",
        "Markdown navigation Runtime changed before the intent completed",
      ));
    }
    this.runtime = context;
    const pending = this.pending;
    if (pending?.intent.requestedRevision
      && pending.intent.requestedRevision !== context.revision) {
      this.revisionCancelled += 1;
      this.rejectPending(new MarkdownNavigationIntentError(
        "revision-changed",
        `Navigation requested ${pending.intent.requestedRevision} but Runtime published ${context.revision}`,
      ));
      return;
    }
    this.startPending();
  }

  requestInitial(
    anchor: MarkdownViewScrollAnchor,
    options?: MarkdownNavigationRequestOptions,
  ): MarkdownNavigationIntentHandle {
    return this.request("initial", { type: "scroll-anchor", anchor: validateAnchor(anchor) }, options);
  }

  requestRestore(
    anchor: MarkdownViewScrollAnchor,
    options?: MarkdownNavigationRequestOptions,
  ): MarkdownNavigationIntentHandle {
    return this.request("restore", { type: "scroll-anchor", anchor: validateAnchor(anchor) }, options);
  }

  requestRevisionCorrection(
    anchor: MarkdownViewScrollAnchor,
    options?: MarkdownNavigationRequestOptions,
  ): MarkdownNavigationIntentHandle {
    return this.request("revision-correction", { type: "scroll-anchor", anchor: validateAnchor(anchor) }, options);
  }

  requestReveal(
    target: MarkdownViewRevealTarget,
    options?: MarkdownNavigationRequestOptions,
  ): MarkdownNavigationIntentHandle {
    return this.request(kindForTarget(target), { type: "reveal", target: Object.freeze({ ...target }) }, options);
  }

  recordUserScroll(): void {
    this.interactionEpoch += 1;
    if (!this.pending) return;
    this.userInterrupted += 1;
    this.rejectPending(new MarkdownNavigationIntentError(
      "user-interrupted",
      "User scrolling cancelled pending automatic Markdown navigation",
    ));
  }

  detach(): void {
    if (this.disposed) return;
    this.rejectPending(new MarkdownNavigationIntentError("view-detached", "Markdown navigation view detached"));
    this.runtime = null;
  }

  cancel(id: number, reason = "Markdown navigation cancelled"): boolean {
    if (this.pending?.intent.id !== id) return false;
    this.rejectPending(new MarkdownNavigationIntentError("cancelled", reason));
    return true;
  }

  diagnostics(): MarkdownNavigationIntentDiagnostics {
    return Object.freeze({
      requested: this.requested,
      completed: this.completed,
      superseded: this.superseded,
      rejectedLowerPriority: this.rejectedLowerPriority,
      userInterrupted: this.userInterrupted,
      revisionCancelled: this.revisionCancelled,
      pending: this.pending !== null,
      currentKind: this.pending?.intent.kind ?? null,
      runtimeEpoch: this.runtime?.epoch ?? null,
      interactionEpoch: this.interactionEpoch,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(new MarkdownNavigationIntentError("disposed", "Markdown navigation controller destroyed"));
    this.runtime = null;
  }

  private request(
    kind: MarkdownNavigationIntentKind,
    payload: MarkdownNavigationIntentPayload,
    options: MarkdownNavigationRequestOptions = {},
  ): MarkdownNavigationIntentHandle {
    this.assertActive();
    const id = ++this.sequence;
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    void promise.catch(() => undefined);
    const handle = Object.freeze({
      id,
      signal: controller.signal,
      promise,
      cancel: (reason?: string) => this.cancel(id, reason),
    });
    if (options.signal?.aborted) {
      const error = new MarkdownNavigationIntentError("cancelled", "Markdown navigation request was already aborted");
      controller.abort(error);
      reject(error);
      return handle;
    }
    const priority = PRIORITY[kind];
    if (this.pending && priority < this.pending.intent.priority) {
      this.rejectedLowerPriority += 1;
      const error = new MarkdownNavigationIntentError(
        "lower-priority",
        `${kind} cannot replace ${this.pending.intent.kind}`,
      );
      controller.abort(error);
      reject(error);
      return handle;
    }
    if (this.pending) {
      this.superseded += 1;
      this.rejectPending(new MarkdownNavigationIntentError(
        "superseded",
        `${this.pending.intent.kind} was superseded by ${kind}`,
      ));
    }
    const requestedRevision = options.requestedRevision === undefined
      ? this.runtime?.revision ?? null
      : options.requestedRevision;
    const intent: MarkdownNavigationIntent = Object.freeze({
      id,
      kind,
      priority,
      descriptor: this.descriptor,
      documentId: this.documentId,
      payload,
      requestedRevision,
      requestedAt: this.now(),
      interactionEpoch: this.interactionEpoch,
    });
    const onExternalAbort = options.signal
      ? () => this.cancel(id, options.signal?.reason instanceof Error ? options.signal.reason.message : undefined)
      : null;
    this.pending = {
      intent,
      controller,
      resolve,
      reject,
      externalSignal: options.signal ?? null,
      onExternalAbort,
      runningEpoch: null,
    };
    options.signal?.addEventListener("abort", onExternalAbort!, { once: true });
    this.requested += 1;
    this.startPending();
    return handle;
  }

  private startPending(): void {
    const pending = this.pending;
    const runtime = this.runtime;
    if (!pending || !runtime || pending.runningEpoch !== null) return;
    if (pending.intent.requestedRevision && pending.intent.requestedRevision !== runtime.revision) {
      this.revisionCancelled += 1;
      this.rejectPending(new MarkdownNavigationIntentError("revision-changed", "Navigation revision is no longer current"));
      return;
    }
    pending.runningEpoch = runtime.epoch;
    void Promise.resolve(runtime.execute(pending.intent, pending.controller.signal)).then(
      () => {
        if (this.pending?.intent.id !== pending.intent.id) return;
        if (pending.intent.interactionEpoch !== this.interactionEpoch) {
          this.rejectPending(new MarkdownNavigationIntentError("user-interrupted", "Navigation interaction is stale"));
          return;
        }
        this.completed += 1;
        this.releasePending();
        pending.resolve();
      },
      (error) => {
        if (this.pending?.intent.id !== pending.intent.id) return;
        this.rejectPending(error instanceof MarkdownNavigationIntentError
          ? error
          : new MarkdownNavigationIntentError("failed", error instanceof Error ? error.message : String(error)));
      },
    );
  }

  private rejectPending(error: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    this.releasePending();
    pending.controller.abort(error);
    pending.reject(error);
  }

  private releasePending(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.externalSignal?.removeEventListener("abort", pending.onExternalAbort!);
    this.pending = null;
  }

  private assertActive(): void {
    if (this.disposed) throw new MarkdownNavigationIntentError("disposed", "Markdown navigation controller is destroyed");
  }
}

function kindForTarget(target: MarkdownViewRevealTarget): MarkdownNavigationIntentKind {
  if (target.kind === "find") return "find";
  if (target.kind === "annotation") return "annotation";
  if (target.kind === "capsule") return "capsule";
  return "reveal";
}

function validateAnchor(anchor: MarkdownViewScrollAnchor): MarkdownViewScrollAnchor {
  if (!Number.isFinite(anchor.sourceOffset) || anchor.sourceOffset < 0
    || !Number.isFinite(anchor.offsetPx)
    || !(["start", "center", "end", "nearest"] as const).includes(anchor.alignment)) {
    throw new Error("Markdown navigation scroll anchor is invalid");
  }
  return Object.freeze({ ...anchor });
}

function validateRuntime(context: MarkdownNavigationRuntimeContext): void {
  required(context.revision, "revision");
  if (!Number.isSafeInteger(context.epoch) || context.epoch < 1) throw new Error("Runtime epoch must be a positive integer");
}

function required(value: string, name: string): void {
  if (!value?.trim()) throw new Error(`${name} is required`);
}
