import type { BrowserEventEnvelope, BrowserSurfaceRef } from "../domain";

import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type BrowserBridgeValidationError,
} from "./bridgeProtocol";

export type BrowserBridgeRouteError = BrowserBridgeValidationError
  | "frame_identity_mismatch"
  | "host_bridge_error";

export interface BrowserBridgeRouteFailure {
  readonly code: BrowserBridgeRouteError;
  readonly hostCode?: string;
  readonly payload?: unknown;
}

interface BrowserBridgeFrameCursor {
  readonly navigationId: string;
  readonly lastSequence: number;
}

export class BrowserBridgeRouter {
  readonly #surface: BrowserSurfaceRef;
  readonly #frames = new Map<string, BrowserBridgeFrameCursor>();
  readonly #subscribers = new Set<(envelope: BrowserBridgeEnvelope) => void>();
  readonly #errorSubscribers = new Set<(failure: BrowserBridgeRouteFailure) => void>();
  #lateAttach = true;

  constructor(surface: BrowserSurfaceRef) {
    this.#surface = surface;
  }

  bind(client: { subscribe(subscriber: (event: BrowserEventEnvelope) => void): () => void }): () => void {
    return client.subscribe((event) => this.applyHostEvent(event));
  }

  subscribe(subscriber: (envelope: BrowserBridgeEnvelope) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  subscribeErrors(subscriber: (failure: BrowserBridgeRouteFailure) => void): () => void {
    this.#errorSubscribers.add(subscriber);
    return () => this.#errorSubscribers.delete(subscriber);
  }

  applyHostEvent(event: BrowserEventEnvelope): boolean {
    if (!sameSurface(this.#surface, event)) return false;
    if (event.kind === "navigation.started" || event.kind === "surface.destroyed") {
      this.#frames.clear();
      this.#lateAttach = false;
      return true;
    }
    if (event.kind === "bridge.error") {
      this.#emitError({ code: "host_bridge_error", hostCode: event.payload.code });
      return true;
    }
    if (event.kind !== "bridge.message") return false;
    return this.#accept(event.payload.bridgeEnvelope);
  }

  #accept(input: unknown): boolean {
    const parsed = parseBrowserBridgeEnvelope(input, "page-to-host");
    if (!parsed.ok) {
      this.#emitError({ code: parsed.error, payload: input });
      return false;
    }
    const { envelope } = parsed;
    if (!sameSurface(this.#surface, envelope)) {
      this.#emitError({ code: "stale_surface", payload: input });
      return false;
    }
    if (envelope.kind === "bridge.ready") {
      const ready = envelope as BrowserBridgeEnvelope<"bridge.ready">;
      const top = ready.payload.top;
      if ((top && envelope.frameKey !== "main") || (!top && !envelope.frameKey.startsWith("frame:"))) {
        this.#emitError({ code: "frame_identity_mismatch", payload: input });
        return false;
      }
      const existing = this.#frames.get(envelope.frameKey);
      if (
        existing?.navigationId === envelope.navigationId
        && envelope.sequence <= existing.lastSequence
      ) {
        this.#emitError({ code: "out_of_order", payload: input });
        return false;
      }
      if (top) this.#frames.clear();
      this.#frames.set(envelope.frameKey, {
        navigationId: envelope.navigationId,
        lastSequence: envelope.sequence,
      });
      if (top) this.#lateAttach = false;
      this.#emit(envelope);
      return true;
    }
    const frame = this.#frames.get(envelope.frameKey);
    if (!frame) {
      // Rust's BrowserBridgeBroker has already authenticated the native channel,
      // surface, frame and navigation before it emits bridge.message. React can
      // mount after the page's one-shot bridge.ready event, so seed that already
      // validated cursor only until this router observes a host navigation.
      if (this.#lateAttach) {
        this.#frames.set(envelope.frameKey, {
          navigationId: envelope.navigationId,
          lastSequence: envelope.sequence,
        });
        this.#emit(envelope);
        return true;
      }
      this.#emitError({ code: "stale_frame", payload: input });
      return false;
    }
    if (frame.navigationId !== envelope.navigationId) {
      this.#emitError({ code: "stale_navigation", payload: input });
      return false;
    }
    if (envelope.sequence <= frame.lastSequence) {
      this.#emitError({ code: "out_of_order", payload: input });
      return false;
    }
    this.#frames.set(envelope.frameKey, { ...frame, lastSequence: envelope.sequence });
    this.#emit(envelope);
    return true;
  }

  #emit(envelope: BrowserBridgeEnvelope): void {
    for (const subscriber of this.#subscribers) subscriber(envelope);
  }

  #emitError(failure: BrowserBridgeRouteFailure): void {
    for (const subscriber of this.#errorSubscribers) subscriber(failure);
  }
}

function sameSurface(
  surface: BrowserSurfaceRef,
  candidate: Pick<BrowserSurfaceRef, "panelId" | "surfaceId" | "generation">,
): boolean {
  return surface.panelId === candidate.panelId
    && surface.surfaceId === candidate.surfaceId
    && surface.generation === candidate.generation;
}
