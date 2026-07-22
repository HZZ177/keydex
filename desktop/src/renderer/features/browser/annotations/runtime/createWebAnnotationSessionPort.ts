import type { BrowserPanelRuntimeController } from "../../runtime/BrowserPanelRuntime";
import { BrowserHostCommandError } from "../../runtime/BrowserHostClient";
import type { WebAnnotationSessionPort } from "../state";
import type { WebAnnotationResolverPort } from "./resolverCoordinator";
import type { WebAnnotationHighlightPort } from "./highlightSynchronizer";

export function createWebAnnotationSessionPort(
  runtime: Pick<BrowserPanelRuntimeController, "client" | "setProtection">,
): WebAnnotationSessionPort {
  return {
    async startSelection({ surface, selectionRequestId, mode }) {
      await startSelectionWhenBridgeReady(runtime.client, { surface, selectionRequestId, mode });
    },
    async cancelSelection(surface) {
      await runtime.client.send("browser_cancel_selection", surface);
    },
    async captureRegion({ surface, captureRequestId, rect, viewport }) {
      await runtime.client.send("browser_capture_region", {
        ...surface,
        captureRequestId,
        rect,
        viewport,
      });
    },
    async discardCapture({ surface, captureRequestId }) {
      await runtime.client.send("browser_discard_capture", {
        ...surface,
        captureRequestId,
      });
    },
    subscribeHostEvents(subscriber) {
      return runtime.client.subscribe(subscriber);
    },
    setProtection(panelId, reason, active) {
      runtime.setProtection(panelId, reason, active);
    },
  };
}

const SELECTION_BRIDGE_RETRY_DELAYS_MS = Object.freeze([40, 80, 160, 320, 640]);

async function startSelectionWhenBridgeReady(
  client: Pick<BrowserPanelRuntimeController, "client">["client"],
  input: Parameters<WebAnnotationSessionPort["startSelection"]>[0],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.send("browser_start_selection", {
        ...input.surface,
        selectionRequestId: input.selectionRequestId,
        mode: input.mode,
      });
      return;
    } catch (error) {
      const delay = SELECTION_BRIDGE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !selectionBridgeIsPreparing(error)) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
}

function selectionBridgeIsPreparing(error: unknown): boolean {
  return error instanceof BrowserHostCommandError
    && error.response.error.retryable
    && error.response.error.message === "Structured page selection bridge is not ready";
}

export function createWebAnnotationResolverPort(
  runtime: Pick<BrowserPanelRuntimeController, "client">,
): WebAnnotationResolverPort {
  return {
    async resolveAnnotations({ surface, resolveRequestId, targets }) {
      await runtime.client.send("browser_resolve_annotations", {
        ...surface,
        resolveRequestId,
        targets,
      });
    },
  };
}

export function createWebAnnotationHighlightPort(
  runtime: Pick<BrowserPanelRuntimeController, "client">,
): WebAnnotationHighlightPort {
  return {
    async renderHighlights({ surface, resolutions }) {
      await runtime.client.send("browser_render_highlights", {
        ...surface,
        resolutions,
      });
    },
    async clearHighlights({ surface, annotationIds }) {
      await runtime.client.send("browser_clear_highlights", {
        ...surface,
        annotationIds,
      });
    },
    async navigateToTarget({ surface, annotationId, target }) {
      await runtime.client.send("browser_navigate_to_annotation_target", {
        ...surface,
        annotationId,
        target,
      });
    },
  };
}
