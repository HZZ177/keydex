import type { RuntimeBridge } from "@/runtime";

import {
  createWebAnnotationClient,
  type WebAnnotationClient,
} from "../api";
import {
  webAnnotationPanelRegistry,
  type WebAnnotationCoordinatorResolution,
  type WebAnnotationNavigationPanel,
  type WebAnnotationPanelRegistry,
} from "../runtime";
import {
  WebAnnotationContextAssembler,
  type SelectedWebAnnotationReference,
  type WebAnnotationContextAssembly,
  type WebAnnotationContextResolutionSource,
} from "./WebAnnotationContextAssembler";

export interface WebAnnotationSendCoordinatorOptions {
  readonly client: Pick<WebAnnotationClient, "get">;
  readonly panelRegistry?: WebAnnotationPanelRegistry;
  readonly now?: () => string;
  readonly resolutionTimeoutMs?: number;
  readonly prewarmResolutionTimeoutMs?: number;
}

export interface WebAnnotationSendPreparationOptions {
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
}

export interface WebAnnotationSendAttachment {
  readonly id: string;
  readonly attachment_id: string;
  readonly type: "image";
  readonly source: "web_annotation";
  readonly name: string;
  readonly path: string;
  readonly mime_type: string;
  readonly size: number;
  readonly [key: string]: unknown;
}

export interface WebAnnotationSendPreparation extends WebAnnotationContextAssembly {
  readonly attachments: readonly WebAnnotationSendAttachment[];
}

/**
 * Keeps one immutable assembly for a selected-reference set until the caller
 * acknowledges a successful send. A failed transport retry therefore cannot
 * silently reread a newer annotation revision.
 */
export class WebAnnotationSendCoordinator {
  readonly #client: Pick<WebAnnotationClient, "get">;
  readonly #panelRegistry: WebAnnotationPanelRegistry;
  readonly #now?: () => string;
  readonly #resolutionTimeoutMs?: number;
  readonly #prewarmResolutionTimeoutMs: number;
  readonly #preparations = new Map<string, Promise<WebAnnotationSendPreparation>>();

  constructor(options: WebAnnotationSendCoordinatorOptions) {
    this.#client = options.client;
    this.#panelRegistry = options.panelRegistry ?? webAnnotationPanelRegistry;
    this.#now = options.now;
    this.#resolutionTimeoutMs = options.resolutionTimeoutMs;
    this.#prewarmResolutionTimeoutMs = options.prewarmResolutionTimeoutMs ?? 0;
  }

  /**
   * Starts the immutable envelope assembly while the capsule is sitting in the
   * composer. Prewarming never waits for a future page-resolution event: it
   * records the current or last-known observation and leaves the send gesture
   * free of the resolver timeout.
   */
  prewarm(
    references: readonly SelectedWebAnnotationReference[],
  ): Promise<WebAnnotationSendPreparation> {
    return this.#prepare(references, {
      resolutionTimeoutMs: this.#prewarmResolutionTimeoutMs,
    });
  }

  prepare(
    references: readonly SelectedWebAnnotationReference[],
    options: WebAnnotationSendPreparationOptions = {},
  ): Promise<WebAnnotationSendPreparation> {
    return this.#prepare(references, {
      resolutionTimeoutMs: this.#resolutionTimeoutMs,
      signal: options.signal,
    });
  }

  #prepare(
    references: readonly SelectedWebAnnotationReference[],
    options: {
      readonly resolutionTimeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<WebAnnotationSendPreparation> {
    const key = referenceSetKey(references);
    const current = this.#preparations.get(key);
    if (current) return current;
    const resolutions = new PanelRegistryResolutionSource(this.#panelRegistry, references);
    const assembler = new WebAnnotationContextAssembler({
      client: this.#client,
      resolutions,
      ...(this.#now ? { now: this.#now } : {}),
      ...(options.resolutionTimeoutMs === undefined
        ? {}
        : { resolutionTimeoutMs: options.resolutionTimeoutMs }),
    });
    const preparation = assembler.assemble(references, { signal: options.signal })
      .then((assembly) => Object.freeze({ ...assembly, attachments: Object.freeze([]) }))
      .catch((reason: unknown) => {
        if (this.#preparations.get(key) === preparation) this.#preparations.delete(key);
        throw reason;
      });
    this.#preparations.set(key, preparation);
    return preparation;
  }

  acknowledge(references: readonly SelectedWebAnnotationReference[], _sessionId?: string): void {
    this.#deletePreparation(references);
  }

  discard(references: readonly SelectedWebAnnotationReference[], _sessionId?: string): void {
    this.#deletePreparation(references);
  }

  clear(): void {
    this.#preparations.clear();
  }

  #deletePreparation(references: readonly SelectedWebAnnotationReference[]): void {
    this.#preparations.delete(referenceSetKey(references));
  }
}

export function createWebAnnotationSendCoordinator(runtime: RuntimeBridge): WebAnnotationSendCoordinator {
  return new WebAnnotationSendCoordinator({
    client: createWebAnnotationClient(runtime.http),
    resolutionTimeoutMs: 0,
  });
}

class PanelRegistryResolutionSource implements WebAnnotationContextResolutionSource {
  readonly #registry: WebAnnotationPanelRegistry;
  readonly #preferredPanels: Readonly<Record<string, string | undefined>>;

  constructor(
    registry: WebAnnotationPanelRegistry,
    references: readonly SelectedWebAnnotationReference[],
  ) {
    this.#registry = registry;
    this.#preferredPanels = Object.freeze(Object.fromEntries(
      references.map((reference) => [reference.annotationId, reference.sourcePanelId]),
    ));
  }

  get = (annotationId: string): WebAnnotationCoordinatorResolution | undefined => {
    const preferredPanelId = this.#preferredPanels[annotationId];
    return orderedPanels(this.#registry.listAll(), preferredPanelId)
      .map((panel) => panel.getResolution(annotationId))
      .find((resolution) => resolution !== undefined);
  };

  subscribe = (listener: () => void): (() => void) => this.#registry.subscribe(listener);
}

function orderedPanels(
  panels: readonly WebAnnotationNavigationPanel[],
  preferredPanelId?: string,
): readonly WebAnnotationNavigationPanel[] {
  return [...panels].sort((left, right) => {
    const leftSnapshot = left.getSnapshot();
    const rightSnapshot = right.getSnapshot();
    return panelRank(rightSnapshot.panelId, rightSnapshot.active, rightSnapshot.ready, preferredPanelId)
      - panelRank(leftSnapshot.panelId, leftSnapshot.active, leftSnapshot.ready, preferredPanelId);
  });
}

function panelRank(panelId: string, active: boolean, ready: boolean, preferredPanelId?: string): number {
  return (panelId === preferredPanelId ? 8 : 0) + (active ? 4 : 0) + (ready ? 2 : 0);
}

function referenceSetKey(references: readonly SelectedWebAnnotationReference[]): string {
  return JSON.stringify([...references]
    .map((reference) => ({
      annotationId: reference.annotationId,
      selectedRevision: reference.selectedRevision,
      selectedAt: reference.selectedAt,
      sourcePanelId: reference.sourcePanelId ?? null,
    }))
    .sort((left, right) => left.annotationId.localeCompare(right.annotationId)));
}
