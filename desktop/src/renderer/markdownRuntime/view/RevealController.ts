import type { MarkdownSnapshot } from "../document/MarkdownSnapshot";
import type { MarkdownHeightIndex } from "../layout/HeightIndex";
import type {
  MarkdownMappedPosition,
  MarkdownPositionMapper,
} from "../mapping";
import type { MarkdownViewRevealTarget } from "./types";

export type MarkdownRevealAlignment = "start" | "center" | "end" | "nearest";
export type MarkdownRevealBehavior = "auto" | "instant" | "smooth";
export type MarkdownRevealPhase = "coarse" | "fine";

export interface MarkdownRevealViewportGeometry {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly viewportTop: number;
}

export interface MarkdownResolvedRevealTarget {
  readonly blockId?: string;
  readonly sourceOffset?: number;
  readonly logicalOffset?: number;
}

export interface MarkdownRevealContext {
  readonly snapshot: MarkdownSnapshot;
  readonly mapper: MarkdownPositionMapper;
  readonly heightIndex: MarkdownHeightIndex;
  readonly viewport: () => MarkdownRevealViewportGeometry;
  readonly scrollTo: (input: {
    readonly requestId: number;
    readonly phase: MarkdownRevealPhase;
    readonly scrollTop: number;
    readonly behavior: MarkdownRevealBehavior;
  }) => void | Promise<void>;
  readonly mount: (input: {
    readonly requestId: number;
    readonly revision: string;
    readonly scrollTop: number;
    readonly blockId: string;
    readonly blockIndex: number;
    readonly pinnedIndices: ReadonlySet<number>;
  }) => void | Promise<void>;
  readonly highlight?: (input: {
    readonly requestId: number;
    readonly target: MarkdownViewRevealTarget;
    readonly position: MarkdownMappedPosition;
  }) => void | Promise<void>;
  readonly resolveTarget?: (
    target: MarkdownViewRevealTarget,
    snapshot: MarkdownSnapshot,
  ) => MarkdownResolvedRevealTarget | null;
}

export interface MarkdownRevealRequestOptions {
  readonly align?: MarkdownRevealAlignment;
  readonly behavior?: MarkdownRevealBehavior;
  readonly signal?: AbortSignal;
}

export interface MarkdownRevealResult {
  readonly id: number;
  readonly revision: string;
  readonly target: MarkdownViewRevealTarget;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly coarseScrollTop: number;
  readonly fineScrollTop: number;
  readonly fineAdjusted: boolean;
  readonly position: MarkdownMappedPosition;
}

export interface MarkdownRevealHandle {
  readonly id: number;
  readonly signal: AbortSignal;
  readonly promise: Promise<MarkdownRevealResult>;
  cancel(reason?: string): void;
}

export type MarkdownRevealErrorCode =
  | "superseded"
  | "cancelled"
  | "user-interrupted"
  | "revision-changed"
  | "target-not-found"
  | "target-not-mounted"
  | "disposed";

export class MarkdownRevealError extends Error {
  constructor(readonly code: MarkdownRevealErrorCode, message: string) {
    super(message);
    this.name = "MarkdownRevealError";
  }
}

export interface MarkdownRevealDiagnostics {
  readonly requested: number;
  readonly completed: number;
  readonly superseded: number;
  readonly cancelled: number;
  readonly coarseScrolls: number;
  readonly fineScrolls: number;
  readonly pending: boolean;
  readonly latestId: number;
}

interface PendingReveal {
  readonly id: number;
  readonly target: MarkdownViewRevealTarget;
  readonly align: MarkdownRevealAlignment;
  readonly behavior: MarkdownRevealBehavior;
  readonly controller: AbortController;
  readonly interactionEpoch: number;
  readonly resolve: (result: MarkdownRevealResult) => void;
  readonly reject: (error: unknown) => void;
  readonly externalSignal: AbortSignal | null;
  readonly onExternalAbort: (() => void) | null;
  runningRevision: string | null;
}

export class MarkdownRevealController {
  private context: MarkdownRevealContext | null = null;
  private pending: PendingReveal | null = null;
  private sequence = 0;
  private interactionEpoch = 0;
  private disposed = false;
  private requested = 0;
  private completed = 0;
  private superseded = 0;
  private cancelled = 0;
  private coarseScrolls = 0;
  private fineScrolls = 0;

  publish(context: MarkdownRevealContext): void {
    this.assertActive();
    validateContext(context);
    if (this.pending?.runningRevision && this.pending.runningRevision !== context.snapshot.revision) {
      this.rejectPending(new MarkdownRevealError(
        "revision-changed",
        "Markdown reveal revision changed while mounting the target",
      ));
    }
    this.context = context;
    this.startPending();
  }

  request(
    target: MarkdownViewRevealTarget,
    options: MarkdownRevealRequestOptions = {},
  ): MarkdownRevealHandle {
    this.assertActive();
    if (options.signal?.aborted) {
      const controller = new AbortController();
      controller.abort(options.signal.reason);
      const promise = Promise.reject<MarkdownRevealResult>(new MarkdownRevealError("cancelled", "Markdown reveal aborted"));
      void promise.catch(() => undefined);
      return Object.freeze({ id: ++this.sequence, signal: controller.signal, promise, cancel: () => undefined });
    }
    if (this.pending) {
      this.superseded += 1;
      this.rejectPending(new MarkdownRevealError("superseded", "Markdown reveal superseded by a newer request"));
    }
    const id = ++this.sequence;
    const controller = new AbortController();
    let resolve!: (result: MarkdownRevealResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<MarkdownRevealResult>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    void promise.catch(() => undefined);
    const onExternalAbort = options.signal
      ? () => this.cancel(id, options.signal?.reason instanceof Error ? options.signal.reason.message : "Markdown reveal aborted")
      : null;
    this.pending = {
      id,
      target: validateTarget(target),
      align: options.align ?? "nearest",
      behavior: options.behavior ?? "auto",
      controller,
      interactionEpoch: this.interactionEpoch,
      resolve,
      reject,
      externalSignal: options.signal ?? null,
      onExternalAbort,
      runningRevision: null,
    };
    options.signal?.addEventListener("abort", onExternalAbort!, { once: true });
    this.requested += 1;
    this.startPending();
    return Object.freeze({
      id,
      signal: controller.signal,
      promise,
      cancel: (reason?: string) => this.cancel(id, reason),
    });
  }

  recordUserScroll(): void {
    this.interactionEpoch += 1;
    if (this.pending) {
      this.cancelled += 1;
      this.rejectPending(new MarkdownRevealError("user-interrupted", "User scrolling interrupted Markdown reveal"));
    }
  }

  cancel(id: number, reason = "Markdown reveal cancelled"): boolean {
    if (this.pending?.id !== id) return false;
    this.cancelled += 1;
    this.rejectPending(new MarkdownRevealError("cancelled", reason));
    return true;
  }

  diagnostics(): MarkdownRevealDiagnostics {
    return Object.freeze({
      requested: this.requested,
      completed: this.completed,
      superseded: this.superseded,
      cancelled: this.cancelled,
      coarseScrolls: this.coarseScrolls,
      fineScrolls: this.fineScrolls,
      pending: this.pending !== null,
      latestId: this.sequence,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(new MarkdownRevealError("disposed", "Markdown RevealController was destroyed"));
    this.context = null;
  }

  private startPending(): void {
    const pending = this.pending;
    const context = this.context;
    if (!pending || !context || pending.runningRevision) return;
    pending.runningRevision = context.snapshot.revision;
    void this.execute(pending, context).then(
      (result) => {
        if (this.pending?.id !== pending.id) return;
        this.completed += 1;
        this.releasePending();
        pending.resolve(result);
      },
      (error) => {
        if (this.pending?.id !== pending.id) return;
        this.rejectPending(error);
      },
    );
  }

  private async execute(pending: PendingReveal, context: MarkdownRevealContext): Promise<MarkdownRevealResult> {
    this.assertCurrent(pending, context);
    const coarsePosition = resolvePosition(pending.target, context);
    if (!coarsePosition || coarsePosition.status === "unmapped" || coarsePosition.blockIndex === null
      || coarsePosition.blockId === null) {
      throw new MarkdownRevealError("target-not-found", "Markdown reveal target could not be mapped");
    }
    const viewport = validViewport(context.viewport());
    const blockHeight = context.heightIndex.heightAt(coarsePosition.blockIndex);
    const coarseTargetHeight = pending.target.kind === "block" ? Math.max(1, blockHeight) : 1;
    const targetY = coarsePosition.estimatedY ?? context.heightIndex.offsetOf(coarsePosition.blockIndex);
    const coarseScrollTop = alignedScrollTop(
      viewport.scrollTop,
      viewport.viewportHeight,
      context.heightIndex.totalHeight,
      targetY,
      coarseTargetHeight,
      pending.align,
    );
    this.coarseScrolls += 1;
    await context.scrollTo({
      requestId: pending.id,
      phase: "coarse",
      scrollTop: coarseScrollTop,
      behavior: "instant",
    });
    this.assertCurrent(pending, context);
    await context.mount({
      requestId: pending.id,
      revision: context.snapshot.revision,
      scrollTop: coarseScrollTop,
      blockId: coarsePosition.blockId,
      blockIndex: coarsePosition.blockIndex,
      pinnedIndices: new Set([coarsePosition.blockIndex]),
    });
    this.assertCurrent(pending, context);
    const exactPosition = resolvePosition(pending.target, context);
    if (!exactPosition || exactPosition.status !== "exact" || !exactPosition.dom
      || exactPosition.blockId === null || exactPosition.blockIndex === null) {
      throw new MarkdownRevealError("target-not-mounted", "Markdown reveal target was not mounted after coarse scroll");
    }
    const fineViewport = validViewport(context.viewport());
    const targetDocumentY = fineViewport.scrollTop + exactPosition.dom.rect.top - fineViewport.viewportTop;
    const fineScrollTop = alignedScrollTop(
      fineViewport.scrollTop,
      fineViewport.viewportHeight,
      context.heightIndex.totalHeight,
      targetDocumentY,
      Math.max(1, exactPosition.dom.rect.height),
      pending.align,
    );
    const fineAdjusted = Math.abs(fineScrollTop - fineViewport.scrollTop) > 0.5;
    if (fineAdjusted) {
      this.fineScrolls += 1;
      await context.scrollTo({
        requestId: pending.id,
        phase: "fine",
        scrollTop: fineScrollTop,
        behavior: pending.behavior,
      });
      this.assertCurrent(pending, context);
    }
    await context.highlight?.({ requestId: pending.id, target: pending.target, position: exactPosition });
    this.assertCurrent(pending, context);
    return Object.freeze({
      id: pending.id,
      revision: context.snapshot.revision,
      target: pending.target,
      blockId: exactPosition.blockId,
      blockIndex: exactPosition.blockIndex,
      coarseScrollTop,
      fineScrollTop,
      fineAdjusted,
      position: exactPosition,
    });
  }

  private assertCurrent(pending: PendingReveal, context: MarkdownRevealContext): void {
    if (pending.controller.signal.aborted || this.pending?.id !== pending.id) {
      throw pending.controller.signal.reason ?? new MarkdownRevealError("cancelled", "Markdown reveal is no longer current");
    }
    if (pending.interactionEpoch !== this.interactionEpoch) {
      throw new MarkdownRevealError("user-interrupted", "A newer user interaction superseded Markdown reveal");
    }
    if (this.context !== context || context.snapshot.revision !== pending.runningRevision) {
      throw new MarkdownRevealError("revision-changed", "Markdown reveal context changed");
    }
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
    if (this.disposed) throw new MarkdownRevealError("disposed", "Markdown RevealController is destroyed");
  }
}

function resolvePosition(
  target: MarkdownViewRevealTarget,
  context: MarkdownRevealContext,
): MarkdownMappedPosition | null {
  if (target.kind === "block") return context.mapper.blockLocal(target.blockId, 0);
  if (target.kind === "source-offset") return context.mapper.sourceOffset(target.sourceOffset);
  if (target.kind === "source-line") return context.mapper.sourceLine(target.line, target.column ?? 1);
  if (target.kind === "capsule" && target.sourceOffset !== undefined) {
    return context.mapper.sourceOffset(target.sourceOffset);
  }
  const resolved = context.resolveTarget?.(target, context.snapshot);
  if (!resolved) return null;
  if (resolved.sourceOffset !== undefined) return context.mapper.sourceOffset(resolved.sourceOffset);
  if (resolved.logicalOffset !== undefined) return context.mapper.logicalOffset(resolved.logicalOffset);
  if (resolved.blockId) return context.mapper.blockLocal(resolved.blockId, 0);
  return null;
}

function alignedScrollTop(
  current: number,
  viewportHeight: number,
  totalHeight: number,
  targetTop: number,
  targetHeight: number,
  align: MarkdownRevealAlignment,
): number {
  let next = targetTop;
  if (align === "center") next -= (viewportHeight - targetHeight) / 2;
  else if (align === "end") next -= viewportHeight - targetHeight;
  else if (align === "nearest") {
    if (targetTop >= current && targetTop + targetHeight <= current + viewportHeight) return current;
    next = targetTop < current ? targetTop : targetTop - viewportHeight + targetHeight;
  }
  return Math.max(0, Math.min(next, Math.max(0, totalHeight - viewportHeight)));
}

function validViewport(value: MarkdownRevealViewportGeometry): MarkdownRevealViewportGeometry {
  if (!Number.isFinite(value.scrollTop) || !Number.isFinite(value.viewportHeight)
    || value.viewportHeight < 0 || !Number.isFinite(value.viewportTop)) {
    throw new Error("Markdown reveal viewport geometry is invalid");
  }
  return value;
}

function validateContext(context: MarkdownRevealContext): void {
  if (context.snapshot.revision !== context.heightIndex.revision
    || context.snapshot.blocks.length !== context.heightIndex.length
    || context.mapper.snapshot !== context.snapshot) {
    throw new Error("Markdown reveal context revisions do not match");
  }
}

function validateTarget(target: MarkdownViewRevealTarget): MarkdownViewRevealTarget {
  if (!target || typeof target !== "object" || !("kind" in target)) throw new Error("Markdown reveal target is invalid");
  return Object.freeze({ ...target });
}
