import type { MarkdownSnapshotBlock } from "../document/MarkdownSnapshot";
import {
  CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  resolveMarkdownCodeHighlightLanguage,
  type MarkdownCodeHighlightResult,
  type MarkdownCodeHighlightService,
  type MarkdownCodeHighlightTask,
  type MarkdownCodeHighlightWorkerMessage,
  type MarkdownCodeHighlightWorkerResponse,
} from "./CodeHighlightProtocol";

export interface MarkdownCodeHighlightWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage: ((event: MessageEvent<MarkdownCodeHighlightWorkerResponse>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: MarkdownCodeHighlightWorkerMessage): void;
  terminate(): void;
}

export interface MarkdownCodeWorkerHighlighterOptions {
  readonly workerFactory?: () => MarkdownCodeHighlightWorkerLike;
  readonly fallback?: MarkdownCodeHighlightService;
  readonly dispatchDelayMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxHighlightCharacters?: number;
  readonly maxTokens?: number;
}

interface PendingHighlight {
  readonly requestId: string;
  readonly blockId: string;
  readonly contentHash: string;
  readonly language: NonNullable<ReturnType<typeof resolveMarkdownCodeHighlightLanguage>>;
  readonly code: string;
  readonly sourceTruncated: boolean;
  readonly controller: AbortController;
  readonly resolve: (result: MarkdownCodeHighlightResult) => void;
  readonly reject: (error: unknown) => void;
  dispatched: boolean;
}

/** Lazily starts a dedicated Worker after a short cancellation window. */
export class MarkdownCodeWorkerHighlighter implements MarkdownCodeHighlightService {
  private readonly workerFactory: () => MarkdownCodeHighlightWorkerLike;
  private readonly fallback?: MarkdownCodeHighlightService;
  private readonly dispatchDelayMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxHighlightCharacters: number;
  private readonly maxTokens: number;
  private readonly workerFactoryInjected: boolean;
  private readonly pending = new Map<string, PendingHighlight>();
  private worker: MarkdownCodeHighlightWorkerLike | null = null;
  private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSequence = 0;
  private disabled = false;

  constructor(options: MarkdownCodeWorkerHighlighterOptions = {}) {
    this.workerFactoryInjected = options.workerFactory !== undefined;
    this.fallback = options.fallback;
    this.dispatchDelayMs = finiteNonNegative(options.dispatchDelayMs ?? 24, "dispatchDelayMs");
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? 60_000, "idleTimeoutMs");
    this.maxHighlightCharacters = positiveInteger(
      options.maxHighlightCharacters ?? 200_000,
      "maxHighlightCharacters",
    );
    this.maxTokens = positiveInteger(options.maxTokens ?? 1_000, "maxTokens");
    this.workerFactory = options.workerFactory ?? (() => {
      if (typeof Worker === "undefined") throw new Error("Markdown code highlight Worker is unavailable");
      return new Worker(new URL("../worker/codeHighlight.worker.ts", import.meta.url), {
        type: "module",
        name: "keydex-markdown-code-highlight-worker",
      }) as unknown as MarkdownCodeHighlightWorkerLike;
    });
  }

  highlight(block: MarkdownSnapshotBlock, code: string): MarkdownCodeHighlightTask {
    const language = resolveMarkdownCodeHighlightLanguage(block.metadata.language);
    if (!language || this.disabled || (typeof Worker === "undefined" && !this.workerFactoryInjected)) {
      return this.fallback?.highlight(block, code) ?? rejectedTask("Markdown code highlight Worker is unavailable");
    }
    this.cancelIdleTermination();
    const controller = new AbortController();
    const requestId = `markdown-code-highlight-${++this.requestSequence}`;
    let pending!: PendingHighlight;
    const promise = new Promise<MarkdownCodeHighlightResult>((resolve, reject) => {
      pending = {
        requestId,
        blockId: block.id,
        contentHash: block.content_hash,
        language,
        code: code.slice(0, this.maxHighlightCharacters),
        sourceTruncated: code.length > this.maxHighlightCharacters,
        controller,
        resolve,
        reject,
        dispatched: false,
      };
    });
    this.pending.set(requestId, pending);
    controller.signal.addEventListener("abort", () => this.abortPending(pending), { once: true });
    this.scheduleDispatch();
    return Object.freeze({
      signal: controller.signal,
      promise,
      cancel: (reason?: string) => {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException(reason ?? "Code highlight cancelled", "AbortError"));
        }
      },
    });
  }

  dispose(): void {
    if (this.dispatchTimer !== null) clearTimeout(this.dispatchTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.dispatchTimer = null;
    this.idleTimer = null;
    const error = new DOMException("Code highlighter disposed", "AbortError");
    for (const pending of this.pending.values()) {
      if (!pending.controller.signal.aborted) pending.controller.abort(error);
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private scheduleDispatch(): void {
    if (this.dispatchTimer !== null) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.dispatchPending();
    }, this.dispatchDelayMs);
  }

  private dispatchPending(): void {
    const queued = [...this.pending.values()].filter((pending) => !pending.dispatched);
    if (!queued.length) {
      this.scheduleIdleTermination();
      return;
    }
    let worker: MarkdownCodeHighlightWorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      this.disabled = true;
      queued.forEach((pending) => this.rejectPending(pending, error));
      return;
    }
    for (const pending of queued) {
      if (pending.controller.signal.aborted || !this.pending.has(pending.requestId)) continue;
      pending.dispatched = true;
      try {
        worker.postMessage({
          protocolVersion: CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
          type: "highlight",
          requestId: pending.requestId,
          language: pending.language,
          code: pending.code,
          maxTokens: this.maxTokens,
          sourceTruncated: pending.sourceTruncated,
        });
      } catch (error) {
        this.failWorker(asError(error, "Markdown code highlight Worker dispatch failed"));
        return;
      }
    }
  }

  private ensureWorker(): MarkdownCodeHighlightWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.onmessage = (event) => this.handleWorkerMessage(event.data);
    worker.onerror = (event) => this.failWorker(new Error(event.message || "Markdown code highlight Worker failed"));
    worker.onmessageerror = () => this.failWorker(new Error("Markdown code highlight Worker message failed"));
    this.worker = worker;
    return worker;
  }

  private handleWorkerMessage(message: MarkdownCodeHighlightWorkerResponse): void {
    if (message.protocolVersion !== CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === "highlight-error") {
      pending.reject(new Error(message.message));
    } else {
      pending.resolve(Object.freeze({
        blockId: pending.blockId,
        contentHash: pending.contentHash,
        language: message.language,
        tokens: Object.freeze(message.tokens.map((token) => Object.freeze({ ...token }))),
        truncated: message.truncated,
      }));
    }
    this.scheduleIdleTermination();
  }

  private abortPending(pending: PendingHighlight): void {
    if (!this.pending.delete(pending.requestId)) return;
    if (pending.dispatched) {
      try {
        this.worker?.postMessage({
          protocolVersion: CODE_HIGHLIGHT_WORKER_PROTOCOL_VERSION,
          type: "cancel",
          requestId: pending.requestId,
        });
      } catch (error) {
        this.failWorker(asError(error, "Markdown code highlight Worker cancellation failed"));
      }
    }
    pending.reject(pending.controller.signal.reason ?? new DOMException("Code highlight cancelled", "AbortError"));
    if (this.pending.size === 0 && this.dispatchTimer !== null) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    this.scheduleIdleTermination();
  }

  private rejectPending(pending: PendingHighlight, error: unknown): void {
    if (!this.pending.delete(pending.requestId)) return;
    pending.reject(error);
    this.scheduleIdleTermination();
  }

  private failWorker(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.disabled = true;
    for (const pending of [...this.pending.values()]) this.rejectPending(pending, error);
  }

  private scheduleIdleTermination(): void {
    if (this.pending.size > 0 || !this.worker || this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0) return;
      this.worker?.terminate();
      this.worker = null;
    }, this.idleTimeoutMs);
  }

  private cancelIdleTermination(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function rejectedTask(message: string): MarkdownCodeHighlightTask {
  const controller = new AbortController();
  return Object.freeze({
    signal: controller.signal,
    promise: Promise.reject(new Error(message)),
    cancel: (reason?: string) => {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException(reason ?? "Code highlight cancelled", "AbortError"));
      }
    },
  });
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function asError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    const errorLike = error as { name?: unknown; message?: unknown };
    const normalized = new Error(
      typeof errorLike.message === "string" && errorLike.message ? errorLike.message : fallbackMessage,
    );
    if (typeof errorLike.name === "string" && errorLike.name) normalized.name = errorLike.name;
    return normalized;
  }
  return new Error(fallbackMessage);
}
