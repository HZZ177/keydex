import type { BrowserEventEnvelope } from "../domain";
import type { BrowserSurfaceRef } from "../domain";
import type { BrowserHostClient, BrowserHostUnlisten } from "./BrowserHostClient";

export interface BrowserNavigationFailure {
  readonly category: string;
  readonly url: string;
}

export interface BrowserExternalProtocolRequest {
  readonly scheme: "mailto" | "tel";
  readonly target: string;
}

export interface BrowserPolicyCoordinatorOptions {
  readonly client: Pick<BrowserHostClient, "subscribe">;
  readonly surface?: BrowserSurfaceRef;
  readonly onExternalProtocolRequest: (request: BrowserExternalProtocolRequest) => void;
  readonly onNavigationFailure: (failure: BrowserNavigationFailure) => void;
  readonly onOpenPanel: (url: string) => void;
}

export class BrowserPolicyCoordinator {
  readonly #options: BrowserPolicyCoordinatorOptions;
  #unsubscribe: BrowserHostUnlisten | null = null;

  constructor(options: BrowserPolicyCoordinatorOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#options.client.subscribe((event) => this.#handle(event));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #handle(event: BrowserEventEnvelope): void {
    if (this.#options.surface && !sameSurface(this.#options.surface, event)) return;
    switch (event.kind) {
      case "new_window.requested":
        if (event.payload.userGesture && isAllowedPanelUrl(event.payload.url)) {
          this.#options.onOpenPanel(event.payload.url);
        }
        break;
      case "external_protocol.requested": {
        const request = normalizeExternalProtocolRequest(event.payload);
        if (request) this.#options.onExternalProtocolRequest(request);
        break;
      }
      case "navigation.failed":
        if (event.payload.isMainFrame) {
          this.#options.onNavigationFailure({
            category: event.payload.errorCategory,
            url: event.payload.url,
          });
        }
        break;
      default:
        break;
    }
  }
}

function sameSurface(surface: BrowserSurfaceRef, event: BrowserEventEnvelope): boolean {
  return surface.panelId === event.panelId
    && surface.surfaceId === event.surfaceId
    && surface.generation === event.generation;
}

export function normalizeExternalProtocolRequest(input: {
  readonly scheme: string;
  readonly target: string;
}): BrowserExternalProtocolRequest | null {
  const scheme = input.scheme.toLowerCase();
  if (scheme !== "mailto" && scheme !== "tel") return null;
  try {
    const target = new URL(input.target);
    if (target.protocol !== `${scheme}:`) return null;
    return { scheme, target: target.toString() };
  } catch {
    return null;
  }
}

function isAllowedPanelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
