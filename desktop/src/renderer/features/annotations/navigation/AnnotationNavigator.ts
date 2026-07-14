import type { AnnotationProjection } from "../domain/resolutions";
import type { AnnotationStore } from "../state/annotationStore";
import { AnnotationViewRegistry } from "./AnnotationViewRegistry";
import type { AnnotationViewAdapter, AnnotationViewId } from "./types";

export type AnnotationViewMode = "preview" | "source" | "split";

export interface AnnotationNavigationRequest {
  readonly annotationId: string;
  readonly mode: AnnotationViewMode;
  readonly projection: AnnotationProjection;
}

export type AnnotationNavigationResult =
  | { readonly status: "completed"; readonly connectorViewId: AnnotationViewId }
  | { readonly status: "cancelled" };

export class AnnotationNavigator {
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(
    private readonly registry: AnnotationViewRegistry,
    private readonly store: AnnotationStore,
  ) {}

  async navigate(request: AnnotationNavigationRequest): Promise<AnnotationNavigationResult> {
    if (this.disposed) {
      throw new Error("Annotation navigator is disposed");
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const requestId = this.store.getState().requestNavigation(request.annotationId);
    const viewIds = navigationViewIds(request.mode);
    const scrollingViewId = connectorViewId(request.mode);
    try {
      const adapters = await Promise.all(viewIds.map((viewId) =>
        this.registry.waitUntilReady(viewId, controller.signal)));
      await Promise.all(adapters.map((adapter) => this.revealOnce(
        adapter,
        request,
        requestId,
        adapter.id === scrollingViewId,
        controller.signal,
      )));
      if (controller.signal.aborted) {
        return { status: "cancelled" };
      }
      this.store.getState().finishNavigation(requestId);
      for (const adapter of adapters) {
        adapter.flashMarker(request.annotationId);
      }
      return { status: "completed", connectorViewId: connectorViewId(request.mode) };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return { status: "cancelled" };
      }
      this.store.getState().failNavigation(requestId, errorMessage(error));
      throw error;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  activateFromMarker(annotationId: string): void {
    this.cancel();
    this.store.getState().activate(annotationId, true);
  }

  deactivate(annotationId: string): boolean {
    if (this.store.getState().activeAnnotationId !== annotationId) {
      return false;
    }
    this.cancel();
    this.store.getState().activate(null);
    this.store.getState().hover(null);
    return true;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private revealOnce(
    adapter: AnnotationViewAdapter,
    request: AnnotationNavigationRequest,
    requestId: number,
    scroll: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new DOMException("Annotation navigation aborted", "AbortError"));
    }
    return adapter.reveal({
      annotationId: request.annotationId,
      blockRanges: request.projection.blockRanges,
      logicalRange: request.projection.logicalRange,
      requestId,
      scroll,
      signal,
      sourceRanges: request.projection.sourceRanges,
    });
  }
}

export function connectorViewId(mode: AnnotationViewMode): AnnotationViewId {
  return mode === "source" ? "source" : "markdown";
}

function navigationViewIds(mode: AnnotationViewMode): readonly AnnotationViewId[] {
  if (mode === "split") {
    return ["markdown", "source"];
  }
  return [connectorViewId(mode)];
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
