import { BROWSER_LIMITS } from "../../config";
import type { BrowserSurfaceRef } from "../../domain";
import type { WebAnnotationTarget } from "../../runtime";
import type { WebAnnotationCoordinatorResolution } from "./resolverCoordinator";

export interface WebAnnotationHighlight {
  readonly annotationId: string;
  readonly target: WebAnnotationTarget;
  readonly state: "resolved" | "changed";
  readonly bodyMarkdown: string;
}

export interface WebAnnotationHighlightContent {
  readonly bodyMarkdown: string;
}

export interface WebAnnotationHighlightPort {
  renderHighlights(input: {
    readonly surface: BrowserSurfaceRef;
    readonly resolutions: readonly WebAnnotationHighlight[];
  }): Promise<void>;
  clearHighlights(input: {
    readonly surface: BrowserSurfaceRef;
    readonly annotationIds: readonly string[];
  }): Promise<void>;
  navigateToTarget(input: {
    readonly surface: BrowserSurfaceRef;
    readonly annotationId: string;
    readonly target: WebAnnotationTarget;
  }): Promise<void>;
}

export class WebAnnotationHighlightSynchronizer {
  readonly #surface: BrowserSurfaceRef;
  readonly #port: WebAnnotationHighlightPort;
  #desired = new Map<string, WebAnnotationHighlight>();
  #applied = new Map<string, WebAnnotationHighlight>();
  #operation = 0;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(input: {
    readonly surface: BrowserSurfaceRef;
    readonly port: WebAnnotationHighlightPort;
  }) {
    this.#surface = input.surface;
    this.#port = input.port;
  }

  sync(
    resolutions: Readonly<Record<string, WebAnnotationCoordinatorResolution | undefined>>,
    content: Readonly<Record<string, WebAnnotationHighlightContent | undefined>> = {},
  ): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#desired = desiredHighlights(resolutions, content);
    const operation = ++this.#operation;
    const task = this.#tail.then(() => this.#flush(operation));
    this.#tail = task.catch(() => undefined);
    return task;
  }

  dispose(): Promise<void> {
    if (this.#disposed) return this.#tail;
    this.#disposed = true;
    this.#desired.clear();
    const annotationIds = [...this.#applied.keys()];
    this.#applied.clear();
    ++this.#operation;
    const task = this.#tail.then(async () => {
      for (const batch of chunks(annotationIds, BROWSER_LIMITS.resolveBatchSize)) {
        await this.#port.clearHighlights({ surface: this.#surface, annotationIds: batch });
      }
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }

  async #flush(operation: number): Promise<void> {
    if (this.#disposed || operation !== this.#operation) return;
    const desired = new Map(this.#desired);
    const clearIds = [...this.#applied.keys()].filter((annotationId) => !desired.has(annotationId));
    const render = [...desired.values()].filter((highlight) => {
      const applied = this.#applied.get(highlight.annotationId);
      return !applied || highlightSignature(applied) !== highlightSignature(highlight);
    });

    for (const batch of chunks(clearIds, BROWSER_LIMITS.resolveBatchSize)) {
      await this.#port.clearHighlights({ surface: this.#surface, annotationIds: batch });
      // The page has already applied this side effect. Record it before
      // observing a newer sync request so the next reconciliation does not
      // mistake a cleared page for an unchanged one.
      for (const annotationId of batch) this.#applied.delete(annotationId);
      if (this.#disposed || operation !== this.#operation) return;
    }
    for (const batch of chunks(render, BROWSER_LIMITS.resolveBatchSize)) {
      await this.#port.renderHighlights({ surface: this.#surface, resolutions: batch });
      // Keep the local acknowledgement aligned with each successfully applied
      // page batch. A newer desired snapshot can then reliably undo or replay
      // this batch instead of inheriting stale optimistic state.
      for (const highlight of batch) this.#applied.set(highlight.annotationId, highlight);
      if (this.#disposed || operation !== this.#operation) return;
    }
  }
}

function desiredHighlights(
  resolutions: Readonly<Record<string, WebAnnotationCoordinatorResolution | undefined>>,
  content: Readonly<Record<string, WebAnnotationHighlightContent | undefined>>,
): Map<string, WebAnnotationHighlight> {
  const desired = new Map<string, WebAnnotationHighlight>();
  for (const [annotationId, resolution] of Object.entries(resolutions)) {
    const settled = resolution?.settled
      ?? (sameResolutionIdentity(resolution?.lastKnown, resolution) ? resolution?.lastKnown : null);
    if (!settled?.target || (settled.status !== "resolved" && settled.status !== "changed")) continue;
    desired.set(annotationId, Object.freeze({
      annotationId,
      target: settled.target,
      state: settled.status,
      bodyMarkdown: content[annotationId]?.bodyMarkdown ?? "",
    }));
  }
  return desired;
}

function sameResolutionIdentity(
  settled: WebAnnotationCoordinatorResolution["lastKnown"] | undefined,
  current: WebAnnotationCoordinatorResolution | undefined,
): boolean {
  if (!settled || !current) return false;
  return settled.identity.resourceId === current.identity.resourceId
    && settled.identity.annotationId === current.identity.annotationId
    && settled.identity.navigationId === current.identity.navigationId
    && settled.identity.frameRevision === current.identity.frameRevision;
}

function highlightSignature(highlight: WebAnnotationHighlight): string {
  return `${highlight.state}:${highlight.bodyMarkdown}:${JSON.stringify(highlight.target)}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
