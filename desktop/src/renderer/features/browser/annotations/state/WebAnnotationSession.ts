import { useSyncExternalStore } from "react";

import type {
  BrowserEventEnvelope,
  BrowserEventPayloadByKind,
  BrowserSurfaceRef,
} from "../../domain";
import type {
  BrowserBridgeEnvelope,
  CssRect,
  WebAnnotationTarget,
  WebSelectionMode,
} from "../../runtime/bridgeProtocol";

export type WebAnnotationSessionExitReason =
  | "saved"
  | "user"
  | "navigation"
  | "surface_destroyed"
  | "unsupported_frame"
  | "invalid_selection"
  | "bridge_error";

export interface WebAnnotationSelectionRequest {
  readonly requestId: string;
  readonly selectionId: string;
  readonly mode: WebSelectionMode;
  readonly startedAt: string;
}

export interface WebAnnotationCandidate {
  readonly candidateId: string;
  readonly label: string;
  readonly rect: CssRect;
  readonly depth: number;
}

export interface WebAnnotationDraft {
  readonly draftId: string;
  readonly request: WebAnnotationSelectionRequest;
  readonly target: WebAnnotationTarget;
  readonly navigationId: string;
  readonly frameKey: string;
  readonly dirty: true;
  readonly evidence: WebAnnotationRegionEvidence | null;
  readonly createdAt: string;
}

export type WebAnnotationRegionEvidence =
  | { readonly status: "capturing"; readonly captureRequestId: string }
  | {
      readonly status: "ready";
      readonly captureRequestId: string;
      readonly asset: BrowserEventPayloadByKind["capture.completed"]["asset"];
    }
  | { readonly status: "failed"; readonly captureRequestId: string; readonly errorCategory: string };

export type WebAnnotationSessionState =
  | {
      readonly status: "idle";
      readonly lastExitReason: WebAnnotationSessionExitReason | null;
      readonly error: string | null;
    }
  | { readonly status: "starting"; readonly request: WebAnnotationSelectionRequest }
  | { readonly status: "selecting"; readonly request: WebAnnotationSelectionRequest }
  | {
      readonly status: "candidate";
      readonly request: WebAnnotationSelectionRequest;
      readonly candidate: WebAnnotationCandidate;
    }
  | {
      readonly status: "cancelling";
      readonly request: WebAnnotationSelectionRequest;
      readonly reason: "user" | "navigation" | "surface_destroyed";
    }
  | { readonly status: "draft"; readonly draft: WebAnnotationDraft };

export interface WebAnnotationSessionPort {
  startSelection(input: {
    readonly surface: BrowserSurfaceRef;
    readonly selectionRequestId: string;
    readonly mode: WebSelectionMode;
  }): Promise<void>;
  cancelSelection(surface: BrowserSurfaceRef): Promise<void>;
  captureRegion(input: {
    readonly surface: BrowserSurfaceRef;
    readonly captureRequestId: string;
    readonly rect: CssRect;
    readonly viewport: { readonly width: number; readonly height: number };
  }): Promise<void>;
  discardCapture(input: {
    readonly surface: BrowserSurfaceRef;
    readonly captureRequestId: string;
  }): Promise<void>;
  subscribeHostEvents?(subscriber: (event: BrowserEventEnvelope) => void): () => void;
  setProtection(panelId: string, reason: "selection" | "annotation_draft", active: boolean): void;
}

export interface WebAnnotationSessionOptions {
  readonly surface: BrowserSurfaceRef;
  readonly port: WebAnnotationSessionPort;
  readonly requestId?: () => string;
  readonly now?: () => string;
}

export class WebAnnotationDraftActiveError extends Error {
  constructor() {
    super("当前网页批注草稿尚未保存或取消");
    this.name = "WebAnnotationDraftActiveError";
  }
}

const INITIAL_STATE: WebAnnotationSessionState = Object.freeze({
  status: "idle",
  lastExitReason: null,
  error: null,
});

export class WebAnnotationSession {
  readonly #surface: BrowserSurfaceRef;
  readonly #port: WebAnnotationSessionPort;
  readonly #requestId: () => string;
  readonly #now: () => string;
  readonly #listeners = new Set<() => void>();
  #state: WebAnnotationSessionState = INITIAL_STATE;
  #commandQueue: Promise<void> = Promise.resolve();
  #unlistenHostEvents: (() => void) | null;
  #disposed = false;

  constructor(options: WebAnnotationSessionOptions) {
    this.#surface = options.surface;
    this.#port = options.port;
    this.#requestId = options.requestId ?? createSelectionRequestId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#unlistenHostEvents = this.#port.subscribeHostEvents?.((event) => {
      this.applyHostEvent(event);
    }) ?? null;
  }

  getSnapshot = (): WebAnnotationSessionState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  startSelection(mode: WebSelectionMode): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#state.status === "draft") return Promise.reject(new WebAnnotationDraftActiveError());
    const prior = activeRequest(this.#state);
    const requestId = this.#requestId();
    const request: WebAnnotationSelectionRequest = Object.freeze({
      requestId,
      selectionId: requestId,
      mode,
      startedAt: this.#now(),
    });
    this.#transition({ status: "starting", request });
    return this.#enqueue(async () => {
      if (prior) await this.#port.cancelSelection(this.#surface).catch(() => undefined);
      if (!this.#isCurrentRequest(requestId)) return;
      try {
        await this.#port.startSelection({
          surface: this.#surface,
          selectionRequestId: requestId,
          mode,
        });
        if (this.#state.status === "starting" && this.#isCurrentRequest(requestId)) {
          this.#transition({ status: "selecting", request });
        }
      } catch (error) {
        if (this.#isCurrentRequest(requestId)) {
          this.#transition(idleState("bridge_error", errorMessage(error)));
        }
        throw error;
      }
    });
  }

  cancelSelection(
    reason: "user" | "navigation" | "surface_destroyed" = "user",
  ): Promise<void> {
    const request = activeRequest(this.#state);
    if (!request) return Promise.resolve();
    this.#transition({ status: "cancelling", request, reason });
    return this.#enqueue(async () => {
      try {
        await this.#port.cancelSelection(this.#surface);
      } finally {
        if (this.#state.status === "cancelling" && this.#state.request.requestId === request.requestId) {
          this.#transition(idleState(reason, null));
        }
      }
    });
  }

  rejectCandidate(): Promise<void> {
    if (this.#state.status !== "candidate") return Promise.resolve();
    return this.cancelSelection("user");
  }

  applyBridgeEnvelope(envelope: BrowserBridgeEnvelope): boolean {
    if (this.#disposed || !sameSurface(this.#surface, envelope)) return false;
    const request = activeRequest(this.#state);
    switch (envelope.kind) {
      case "selection.candidate": {
        const candidateEnvelope = envelope as BrowserBridgeEnvelope<"selection.candidate">;
        if (!requestMatches(request, candidateEnvelope.requestId, candidateEnvelope.payload.selectionId)) return false;
        this.#transition({
          status: "candidate",
          request,
          candidate: Object.freeze({
            candidateId: candidateEnvelope.payload.candidateId,
            label: candidateEnvelope.payload.label,
            rect: candidateEnvelope.payload.rect,
            depth: candidateEnvelope.payload.depth,
          }),
        });
        return true;
      }
      case "selection.result": {
        const resultEnvelope = envelope as BrowserBridgeEnvelope<"selection.result">;
        if (!requestMatches(request, resultEnvelope.requestId, resultEnvelope.payload.selectionId)) return false;
        const regionTarget = resultEnvelope.payload.target.type === "region"
          ? resultEnvelope.payload.target
          : null;
        const captureGeometry = regionTarget
          ? resultEnvelope.payload.captureGeometry ?? (resultEnvelope.frameKey === "main"
            ? { rect: regionTarget.rect, viewport: regionTarget.viewport }
            : null)
          : null;
        const captureRequestId = regionTarget
          ? `capture:${request.requestId}`
          : null;
        this.#transition({
          status: "draft",
          draft: Object.freeze({
            draftId: `draft:${request.requestId}`,
            request,
            target: resultEnvelope.payload.target,
            navigationId: resultEnvelope.navigationId,
            frameKey: resultEnvelope.frameKey,
            dirty: true,
            evidence: captureRequestId
              ? Object.freeze(captureGeometry
                ? { status: "capturing", captureRequestId } as const
                : { status: "failed", captureRequestId, errorCategory: "unsupported_frame" } as const)
              : null,
            createdAt: this.#now(),
          }),
        });
        void this.#enqueue(async () => {
          if (captureRequestId && captureGeometry) {
            try {
              await this.#port.captureRegion({
                surface: this.#surface,
                captureRequestId,
                rect: captureGeometry.rect,
                viewport: captureGeometry.viewport,
              });
            } catch {
              this.#markCaptureFailed(captureRequestId, "host_command_failed");
            }
          }
        });
        return true;
      }
      case "selection.cancelled": {
        const cancelledEnvelope = envelope as BrowserBridgeEnvelope<"selection.cancelled">;
        if (!requestMatches(request, cancelledEnvelope.requestId, cancelledEnvelope.payload.selectionId)) return false;
        this.#transition(idleState(cancelledEnvelope.payload.reason, null));
        return true;
      }
      case "bridge.error": {
        const errorEnvelope = envelope as BrowserBridgeEnvelope<"bridge.error">;
        if (!request || errorEnvelope.requestId !== request.requestId) return false;
        this.#transition(idleState("bridge_error", errorEnvelope.payload.message));
        return true;
      }
      default:
        return false;
    }
  }

  applyHostEvent(event: BrowserEventEnvelope): boolean {
    if (this.#disposed || !sameSurface(this.#surface, event)) return false;
    const request = activeRequest(this.#state);
    if (event.kind === "selection.result") {
      if (!request
        || request.mode !== "element"
        || event.payload.selectionRequestId !== request.requestId) return false;
      this.#transition({
        status: "draft",
        draft: Object.freeze({
          draftId: `draft:${request.requestId}`,
          request,
          target: event.payload.target,
          navigationId: event.navigationId ?? request.requestId,
          frameKey: event.payload.frameKey,
          dirty: true,
          evidence: null,
          createdAt: this.#now(),
        }),
      });
      return true;
    }
    if (event.kind === "selection.cancelled") {
      if (!request || event.payload.selectionRequestId !== request.requestId) return false;
      this.#transition(idleState(event.payload.reason, null));
      return true;
    }
    if (event.kind === "selection.failed") {
      if (!request || event.payload.selectionRequestId !== request.requestId) return false;
      this.#transition(idleState("bridge_error", event.payload.message));
      return true;
    }
    if (this.#state.status !== "draft") return false;
    const { evidence } = this.#state.draft;
    if (!evidence) return false;
    if (event.kind === "capture.completed") {
      if (event.payload.captureRequestId !== evidence.captureRequestId) return false;
      this.#transition({
        status: "draft",
        draft: Object.freeze({
          ...this.#state.draft,
          target: this.#state.draft.target.type === "region" && this.#state.draft.target.visual
            ? Object.freeze({
                ...this.#state.draft.target,
                visual: Object.freeze({
                  ...this.#state.draft.target.visual,
                  perceptualHash: event.payload.asset.perceptualHash,
                }),
              })
            : this.#state.draft.target,
          evidence: Object.freeze({
            status: "ready",
            captureRequestId: evidence.captureRequestId,
            asset: event.payload.asset,
          }),
        }),
      });
      return true;
    }
    if (event.kind === "capture.failed") {
      if (event.payload.captureRequestId !== evidence.captureRequestId) return false;
      this.#markCaptureFailed(
        evidence.captureRequestId,
        event.payload.errorCategory,
      );
      return true;
    }
    return false;
  }

  handleNavigation(): Promise<void> {
    if (this.#state.status === "draft") {
      const { draft } = this.#state;
      this.#transition(idleState("navigation", null));
      return this.#enqueue(async () => {
        await this.#port.cancelSelection(this.#surface).catch(() => undefined);
        await this.#discardDraftEvidence(draft);
      });
    }
    if (!activeRequest(this.#state)) return Promise.resolve();
    return this.cancelSelection("navigation");
  }

  completeDraftSave(): WebAnnotationDraft | null {
    if (this.#state.status !== "draft") return null;
    if (this.#state.draft.target.type === "region" && this.#state.draft.evidence?.status !== "ready") {
      return null;
    }
    const { draft } = this.#state;
    this.#transition(idleState("saved", null));
    void this.#enqueue(() => this.#port.cancelSelection(this.#surface).catch(() => undefined));
    return draft;
  }

  async completeDraftSaveAndContinue(mode: WebSelectionMode): Promise<WebAnnotationDraft | null> {
    const draft = this.completeDraftSave();
    if (!draft) return null;
    await this.startSelection(mode);
    return draft;
  }

  cancelDraft(): WebAnnotationDraft | null {
    if (this.#state.status !== "draft") return null;
    const { draft } = this.#state;
    this.#transition(idleState("user", null));
    void this.#enqueue(async () => {
      await this.#port.cancelSelection(this.#surface).catch(() => undefined);
      await this.#discardDraftEvidence(draft);
    });
    return draft;
  }

  async cancelDraftAndContinue(mode: WebSelectionMode): Promise<WebAnnotationDraft | null> {
    const draft = this.cancelDraft();
    if (!draft) return null;
    await this.startSelection(mode);
    return draft;
  }

  closePanel(): Promise<void> {
    if (this.#state.status === "draft") {
      const { draft } = this.#state;
      this.#transition(idleState("surface_destroyed", null));
      this.#disposed = true;
      this.#unlistenHostEvents?.();
      this.#unlistenHostEvents = null;
      return this.#enqueue(async () => {
        await this.#port.cancelSelection(this.#surface).catch(() => undefined);
        await this.#discardDraftEvidence(draft);
      });
    }
    const operation = this.cancelSelection("surface_destroyed");
    this.#disposed = true;
    this.#unlistenHostEvents?.();
    this.#unlistenHostEvents = null;
    return operation;
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.#commandQueue.then(task, task);
    this.#commandQueue = operation.catch(() => undefined);
    return operation;
  }

  #isCurrentRequest(requestId: string): boolean {
    return activeRequest(this.#state)?.requestId === requestId;
  }

  #transition(next: WebAnnotationSessionState): void {
    const priorSelectionProtected = isSelectionProtected(this.#state);
    const priorDraftProtected = this.#state.status === "draft";
    this.#state = Object.freeze(next);
    const nextSelectionProtected = isSelectionProtected(next);
    const nextDraftProtected = next.status === "draft";
    if (priorSelectionProtected !== nextSelectionProtected) {
      this.#port.setProtection(this.#surface.panelId, "selection", nextSelectionProtected);
    }
    if (priorDraftProtected !== nextDraftProtected) {
      this.#port.setProtection(this.#surface.panelId, "annotation_draft", nextDraftProtected);
    }
    for (const listener of this.#listeners) listener();
  }

  #markCaptureFailed(captureRequestId: string, errorCategory: string): void {
    if (this.#state.status !== "draft"
      || this.#state.draft.evidence?.captureRequestId !== captureRequestId) return;
    this.#transition({
      status: "draft",
      draft: Object.freeze({
        ...this.#state.draft,
        evidence: Object.freeze({ status: "failed", captureRequestId, errorCategory }),
      }),
    });
  }

  #discardDraftEvidence(draft: WebAnnotationDraft): Promise<void> {
    const captureRequestId = draft.evidence?.captureRequestId;
    if (!captureRequestId) return Promise.resolve();
    return this.#port.discardCapture({
      surface: this.#surface,
      captureRequestId,
    }).catch(() => undefined);
  }
}

export function useWebAnnotationSession(session: WebAnnotationSession): WebAnnotationSessionState {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

function activeRequest(state: WebAnnotationSessionState): WebAnnotationSelectionRequest | null {
  return state.status === "starting" || state.status === "selecting"
    || state.status === "candidate" || state.status === "cancelling"
    ? state.request
    : null;
}

function requestMatches(
  request: WebAnnotationSelectionRequest | null,
  requestId: string,
  selectionId: string,
): request is WebAnnotationSelectionRequest {
  return request?.requestId === requestId && request.selectionId === selectionId;
}

function isSelectionProtected(state: WebAnnotationSessionState): boolean {
  return state.status === "starting" || state.status === "selecting"
    || state.status === "candidate" || state.status === "cancelling";
}

function idleState(
  lastExitReason: WebAnnotationSessionExitReason,
  error: string | null,
): WebAnnotationSessionState {
  return Object.freeze({ status: "idle", lastExitReason, error });
}

function sameSurface(
  surface: BrowserSurfaceRef,
  candidate: Pick<BrowserSurfaceRef, "panelId" | "surfaceId" | "generation">,
): boolean {
  return surface.panelId === candidate.panelId
    && surface.surfaceId === candidate.surfaceId
    && surface.generation === candidate.generation;
}

function createSelectionRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `selection-${crypto.randomUUID()}`;
  }
  return `selection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "网页选择启动失败";
}
