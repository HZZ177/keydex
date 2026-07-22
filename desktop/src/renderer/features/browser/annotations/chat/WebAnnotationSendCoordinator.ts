import type { RuntimeBridge } from "@/runtime";

import {
  createWebAnnotationClient,
  type WebAnnotationClient,
  type WebAnnotationMessageAttachment,
} from "../api";
import {
  webAnnotationPanelRegistry,
  type WebAnnotationCoordinatorResolution,
  type WebAnnotationNavigationPanel,
  type WebAnnotationPanelRegistry,
} from "../runtime";
import {
  WebAnnotationContextAssembler,
  WebAnnotationContextError,
  attachEvidenceToWebAnnotationAssembly,
  type SelectedWebAnnotationReference,
  type WebAnnotationContextAssembly,
  type WebAnnotationContextResolutionSource,
} from "./WebAnnotationContextAssembler";

export interface WebAnnotationSendCoordinatorOptions {
  readonly client: Pick<WebAnnotationClient, "get"> & Partial<Pick<WebAnnotationClient, "cloneEvidence">>;
  readonly panelRegistry?: WebAnnotationPanelRegistry;
  readonly now?: () => string;
  readonly resolutionTimeoutMs?: number;
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
  readonly #client: Pick<WebAnnotationClient, "get"> & Partial<Pick<WebAnnotationClient, "cloneEvidence">>;
  readonly #panelRegistry: WebAnnotationPanelRegistry;
  readonly #now?: () => string;
  readonly #resolutionTimeoutMs?: number;
  readonly #preparations = new Map<string, Promise<WebAnnotationSendPreparation>>();

  constructor(options: WebAnnotationSendCoordinatorOptions) {
    this.#client = options.client;
    this.#panelRegistry = options.panelRegistry ?? webAnnotationPanelRegistry;
    this.#now = options.now;
    this.#resolutionTimeoutMs = options.resolutionTimeoutMs;
  }

  prepare(
    references: readonly SelectedWebAnnotationReference[],
    options: WebAnnotationSendPreparationOptions = {},
  ): Promise<WebAnnotationSendPreparation> {
    const key = preparationKey(references, options.sessionId);
    const current = this.#preparations.get(key);
    if (current) return current;
    const resolutions = new PanelRegistryResolutionSource(this.#panelRegistry, references);
    const assembler = new WebAnnotationContextAssembler({
      client: this.#client,
      resolutions,
      ...(this.#now ? { now: this.#now } : {}),
      ...(this.#resolutionTimeoutMs === undefined ? {} : { resolutionTimeoutMs: this.#resolutionTimeoutMs }),
    });
    const preparation = assembler.assemble(references, { signal: options.signal })
      .then((assembly) => this.#cloneEvidence(assembly, options))
      .catch((reason: unknown) => {
      if (this.#preparations.get(key) === preparation) this.#preparations.delete(key);
      throw reason;
    });
    this.#preparations.set(key, preparation);
    return preparation;
  }

  acknowledge(references: readonly SelectedWebAnnotationReference[], sessionId?: string): void {
    this.#deletePreparation(references, sessionId);
  }

  discard(references: readonly SelectedWebAnnotationReference[], sessionId?: string): void {
    this.#deletePreparation(references, sessionId);
  }

  clear(): void {
    this.#preparations.clear();
  }

  async #cloneEvidence(
    assembly: WebAnnotationContextAssembly,
    options: WebAnnotationSendPreparationOptions,
  ): Promise<WebAnnotationSendPreparation> {
    if (!assembly.evidenceAssets.length) {
      return Object.freeze({ ...assembly, attachments: Object.freeze([]) });
    }
    const sessionId = options.sessionId?.trim();
    if (!sessionId) {
      throw new WebAnnotationContextError(
        "evidence_session_required",
        "区域批注截图必须在任务创建后才能保存到对话历史。",
        assembly.evidenceAssets.map((item) => item.annotationId),
      );
    }
    if (!this.#client.cloneEvidence) {
      throw new WebAnnotationContextError(
        "evidence_clone_unavailable",
        "当前运行环境无法保存区域批注截图，请重启后重试。",
        assembly.evidenceAssets.map((item) => item.annotationId),
      );
    }
    const clones = await Promise.all(assembly.evidenceAssets.map((evidence) => (
      this.#client.cloneEvidence!(evidence.annotationId, evidence.assetId, {
        sessionId,
        contextDigest: assembly.digest,
        signal: options.signal,
      })
    )));
    const attachmentIds: Record<string, string> = {};
    for (const clone of clones) {
      if (
        clone.contextDigest !== assembly.digest
        || clone.attachment.sessionId !== sessionId
        || clone.attachment.source !== "web_annotation"
      ) {
        throw new WebAnnotationContextError(
          "evidence_clone_invalid",
          `网页区域批注 ${clone.annotationId} 返回了无效的历史附件。`,
          [clone.annotationId],
        );
      }
      attachmentIds[clone.annotationId] = clone.attachment.attachmentId;
    }
    const finalized = await attachEvidenceToWebAnnotationAssembly(assembly, attachmentIds);
    return Object.freeze({
      ...finalized,
      attachments: Object.freeze(clones.map(({ attachment }) => toSendAttachment(attachment))),
    });
  }

  #deletePreparation(
    references: readonly SelectedWebAnnotationReference[],
    sessionId?: string,
  ): void {
    if (sessionId !== undefined) {
      this.#preparations.delete(preparationKey(references, sessionId));
      return;
    }
    const prefix = `${referenceSetKey(references)}::`;
    for (const key of this.#preparations.keys()) {
      if (key.startsWith(prefix)) this.#preparations.delete(key);
    }
  }
}

export function createWebAnnotationSendCoordinator(runtime: RuntimeBridge): WebAnnotationSendCoordinator {
  return new WebAnnotationSendCoordinator({ client: createWebAnnotationClient(runtime.http) });
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

function preparationKey(
  references: readonly SelectedWebAnnotationReference[],
  sessionId?: string,
): string {
  return `${referenceSetKey(references)}::${sessionId?.trim() ?? ""}`;
}

function toSendAttachment(attachment: WebAnnotationMessageAttachment): WebAnnotationSendAttachment {
  return Object.freeze({
    id: attachment.id,
    attachment_id: attachment.attachmentId,
    type: "image" as const,
    source: "web_annotation" as const,
    name: attachment.name,
    path: attachment.path,
    mime_type: attachment.mimeType,
    size: attachment.size,
  });
}
