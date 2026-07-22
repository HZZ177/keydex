import { BROWSER_LIMITS } from "../../config";
import type { BrowserSurfaceRef } from "../../domain";
import type {
  BrowserBridgeEnvelope,
  WebAnnotationPageResolutionEvidence,
  WebAnnotationTarget,
} from "../../runtime";
import type {
  WebAnnotationResolutionIdentity,
  WebAnnotationResolutionReasonCode,
  WebAnnotationSettledStatus,
  WebAnnotationTransientStatus,
  WebAnnotationVisibleStatus,
} from "../domain";

export interface WebAnnotationResolverTarget {
  readonly resourceId: string;
  readonly annotationId: string;
  readonly target: WebAnnotationTarget;
}

export interface WebAnnotationResolverPage {
  readonly resourceId: string;
  readonly hostNavigationId: string;
  readonly annotations: readonly WebAnnotationResolverTarget[];
}

export interface WebAnnotationSettledPageResolution {
  readonly status: WebAnnotationSettledStatus;
  readonly identity: WebAnnotationResolutionIdentity;
  readonly frameKey: string;
  readonly target: WebAnnotationTarget | null;
  readonly candidateIds: readonly string[];
  readonly evidence: WebAnnotationPageResolutionEvidence | null;
  readonly settledAt: string;
}

export interface WebAnnotationCoordinatorResolution {
  readonly status: WebAnnotationSettledStatus | WebAnnotationTransientStatus;
  readonly identity: WebAnnotationResolutionIdentity;
  readonly frameKey: string;
  readonly reason: WebAnnotationResolutionReasonCode;
  readonly requestId?: string;
  readonly lastKnown: WebAnnotationSettledPageResolution | null;
  readonly settled: WebAnnotationSettledPageResolution | null;
}

export interface WebAnnotationResolverSnapshot {
  readonly resolutions: Readonly<Record<string, WebAnnotationCoordinatorResolution | undefined>>;
  readonly visibleStatuses: Readonly<Record<string, WebAnnotationVisibleStatus | undefined>>;
  readonly queued: number;
  readonly suspended: boolean;
  readonly paused: boolean;
}

export interface WebAnnotationResolverPort {
  resolveAnnotations(input: {
    readonly surface: BrowserSurfaceRef;
    readonly resolveRequestId: string;
    readonly targets: readonly {
      readonly annotationId: string;
      readonly target: WebAnnotationTarget;
    }[];
  }): Promise<void>;
}

export interface WebAnnotationResolverScheduler {
  now(): number;
  nowIso(): string;
  scheduleSlice(callback: () => void): unknown;
  cancelSlice(handle: unknown): void;
}

interface ResolverFrameState {
  readonly navigationId: string;
  readonly revision: number;
}

interface CachedResolution {
  readonly frameKey: string;
  readonly targetSignature: string;
  readonly resolution: WebAnnotationSettledPageResolution;
}

const EMPTY_SNAPSHOT: WebAnnotationResolverSnapshot = Object.freeze({
  resolutions: Object.freeze({}),
  visibleStatuses: Object.freeze({}),
  queued: 0,
  suspended: false,
  paused: false,
});

export class WebAnnotationResolverCoordinator {
  readonly #surface: BrowserSurfaceRef;
  readonly #port: WebAnnotationResolverPort;
  readonly #scheduler: WebAnnotationResolverScheduler;
  readonly #listeners = new Set<() => void>();
  readonly #frames = new Map<string, ResolverFrameState>();
  readonly #frameRevisionCounters = new Map<string, number>();
  readonly #targets = new Map<string, WebAnnotationResolverTarget>();
  readonly #targetSignatures = new Map<string, string>();
  readonly #resolutions = new Map<string, WebAnnotationCoordinatorResolution>();
  readonly #cache = new Map<string, CachedResolution>();
  readonly #queue: string[] = [];
  readonly #queued = new Set<string>();
  readonly #requestTargets = new Map<string, string>();
  #page: WebAnnotationResolverPage | null = null;
  #snapshot = EMPTY_SNAPSHOT;
  #sliceHandle: unknown = null;
  #requestSequence = 0;
  #suspended = false;
  #paused = false;
  #disposed = false;

  constructor(input: {
    readonly surface: BrowserSurfaceRef;
    readonly port: WebAnnotationResolverPort;
    readonly scheduler?: WebAnnotationResolverScheduler;
  }) {
    this.#surface = input.surface;
    this.#port = input.port;
    this.#scheduler = input.scheduler ?? defaultResolverScheduler();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSnapshot = (): WebAnnotationResolverSnapshot => this.#snapshot;

  activatePage(page: WebAnnotationResolverPage): void {
    if (this.#disposed) return;
    const pageChanged = this.#page?.resourceId !== page.resourceId
      || this.#page.hostNavigationId !== page.hostNavigationId;
    if (pageChanged) {
      this.#clearWork();
      this.#targets.clear();
      this.#targetSignatures.clear();
      this.#resolutions.clear();
      this.#cache.clear();
    }
    this.#page = Object.freeze({ ...page, annotations: Object.freeze([...page.annotations]) });
    const nextIds = new Set(page.annotations.map((annotation) => annotation.annotationId));
    for (const annotationId of this.#targets.keys()) {
      if (nextIds.has(annotationId)) continue;
      this.#targets.delete(annotationId);
      this.#targetSignatures.delete(annotationId);
      this.#resolutions.delete(annotationId);
      this.#removeCachedAnnotation(annotationId);
      this.#queued.delete(annotationId);
    }
    for (const annotation of page.annotations) {
      const signature = targetSignature(annotation.target);
      const priorSignature = this.#targetSignatures.get(annotation.annotationId);
      this.#targets.set(annotation.annotationId, annotation);
      this.#targetSignatures.set(annotation.annotationId, signature);
      if (priorSignature !== undefined && priorSignature !== signature) {
        this.#removeCachedAnnotation(annotation.annotationId);
      }
      if (pageChanged || priorSignature !== signature || !this.#resolutions.has(annotation.annotationId)) {
        this.#queueAnnotation(annotation.annotationId, "annotation_set_changed");
      }
    }
    this.#publish();
    this.#ensureSlice();
  }

  handleNavigation(hostNavigationId?: string): void {
    if (this.#disposed) return;
    this.#clearWork();
    this.#frames.clear();
    this.#cache.clear();
    this.#resolutions.clear();
    if (this.#page) {
      this.#page = Object.freeze({
        ...this.#page,
        hostNavigationId: hostNavigationId ?? this.#page.hostNavigationId,
      });
    }
    for (const annotationId of this.#targets.keys()) {
      this.#setPending(annotationId, "navigation_changed");
    }
    this.#publish();
  }

  setSuspended(suspended: boolean): void {
    if (this.#disposed || this.#suspended === suspended) return;
    this.#suspended = suspended;
    if (suspended) {
      this.#clearWork();
      for (const annotationId of this.#targets.keys()) {
        this.#setUnavailable(annotationId, "surface_discarded");
      }
    } else {
      for (const annotationId of this.#targets.keys()) this.#queueAnnotation(annotationId, "bridge_ready");
      this.#ensureSlice();
    }
    this.#publish();
  }

  setPaused(paused: boolean): void {
    if (this.#disposed || this.#paused === paused) return;
    this.#paused = paused;
    if (paused) this.#cancelSlice();
    else this.#ensureSlice();
    this.#publish();
  }

  applyBridgeEnvelope(envelope: BrowserBridgeEnvelope): boolean {
    if (this.#disposed || !sameSurface(this.#surface, envelope)) return false;
    if (envelope.kind === "bridge.ready") {
      this.#handleBridgeReady(envelope as BrowserBridgeEnvelope<"bridge.ready">);
      return true;
    }
    const frame = this.#frames.get(envelope.frameKey);
    if (!frame || frame.navigationId !== envelope.navigationId) return false;
    if (envelope.kind === "page.changed") {
      for (const [annotationId, annotation] of this.#targets) {
        if (frameKeyForTarget(annotation.target) === envelope.frameKey) {
          this.#queueAnnotation(annotationId, "dom_changed");
        }
      }
      this.#publish();
      this.#ensureSlice();
      return true;
    }
    if (envelope.kind === "geometry.changed") {
      return true;
    }
    if (envelope.kind === "resolution.result") {
      this.#applyResolution(envelope as BrowserBridgeEnvelope<"resolution.result">, frame);
      return true;
    }
    if (envelope.kind === "bridge.error") {
      const annotationId = this.#requestTargets.get(envelope.requestId);
      if (annotationId) {
        this.#requestTargets.delete(envelope.requestId);
        this.#setUnavailable(annotationId, "resolver_timeout");
        this.#publish();
      }
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearWork();
    this.#frames.clear();
    this.#targets.clear();
    this.#targetSignatures.clear();
    this.#resolutions.clear();
    this.#cache.clear();
    this.#listeners.clear();
    this.#snapshot = EMPTY_SNAPSHOT;
  }

  #handleBridgeReady(envelope: BrowserBridgeEnvelope<"bridge.ready">): void {
    if (envelope.payload.top) {
      this.#clearWork();
      this.#frames.clear();
      this.#cache.clear();
      this.#resolutions.clear();
    } else {
      this.#removeCachedFrame(envelope.frameKey);
      for (const [annotationId, annotation] of this.#targets) {
        if (frameKeyForTarget(annotation.target) === envelope.frameKey) this.#resolutions.delete(annotationId);
      }
    }
    const revision = (this.#frameRevisionCounters.get(envelope.frameKey) ?? 0) + 1;
    this.#frameRevisionCounters.set(envelope.frameKey, revision);
    this.#frames.set(envelope.frameKey, { navigationId: envelope.navigationId, revision });
    for (const [annotationId, annotation] of this.#targets) {
      if (envelope.payload.top || frameKeyForTarget(annotation.target) === envelope.frameKey) {
        this.#queueAnnotation(annotationId, "bridge_ready");
      }
    }
    this.#publish();
    this.#ensureSlice();
  }

  #applyResolution(
    envelope: BrowserBridgeEnvelope<"resolution.result">,
    frame: ResolverFrameState,
  ): void {
    const annotation = this.#targets.get(envelope.payload.annotationId);
    if (!annotation || !this.#page) return;
    this.#requestTargets.delete(envelope.requestId);
    const identity = Object.freeze({
      resourceId: annotation.resourceId,
      annotationId: annotation.annotationId,
      navigationId: envelope.navigationId,
      frameRevision: frame.revision,
    });
    const settled = Object.freeze({
      status: envelope.payload.status,
      identity,
      frameKey: envelope.frameKey,
      target: envelope.payload.target ?? null,
      candidateIds: Object.freeze([...(envelope.payload.candidateIds ?? [])]),
      evidence: envelope.payload.evidence ?? null,
      settledAt: this.#scheduler.nowIso(),
    });
    const resolution: WebAnnotationCoordinatorResolution = Object.freeze({
      status: settled.status,
      identity,
      frameKey: envelope.frameKey,
      reason: settled.status === "resolved"
        ? "exact_match"
        : settled.status === "changed"
          ? "content_changed"
          : settled.status === "ambiguous"
            ? "ambiguous_candidates"
            : envelope.payload.evidence?.strategy === "frame_unavailable"
              ? "frame_unavailable"
              : envelope.payload.evidence?.strategy === "coordinate_only_region"
                ? "coordinate_only_region"
                : "no_candidate",
      lastKnown: settled,
      settled,
    });
    this.#resolutions.set(annotation.annotationId, resolution);
    this.#cache.set(webAnnotationResolutionCacheKey(identity), {
      frameKey: envelope.frameKey,
      targetSignature: this.#targetSignatures.get(annotation.annotationId) ?? "",
      resolution: settled,
    });
    this.#publish();
  }

  #queueAnnotation(annotationId: string, reason: "bridge_ready" | "annotation_set_changed" | "dom_changed"): void {
    const annotation = this.#targets.get(annotationId);
    if (!annotation || !this.#page) return;
    const route = this.#routingFrame(annotation.target);
    if (!route) {
      this.#setPending(annotationId, "bridge_not_ready");
      return;
    }
    const [frameKey, frame] = route;
    const identity = resolutionIdentity(annotation, frame);
    const cacheKey = webAnnotationResolutionCacheKey(identity);
    const cached = this.#cache.get(cacheKey);
    const signature = this.#targetSignatures.get(annotationId) ?? "";
    if (reason !== "dom_changed" && cached?.targetSignature === signature) {
      this.#resolutions.set(annotationId, Object.freeze({
        status: cached.resolution.status,
        identity,
        frameKey,
        reason: cached.resolution.status === "resolved" ? "exact_match" : "content_changed",
        lastKnown: cached.resolution,
        settled: cached.resolution,
      }));
      return;
    }
    if (!this.#queued.has(annotationId)) {
      this.#queued.add(annotationId);
      this.#queue.push(annotationId);
    }
    const prior = this.#resolutions.get(annotationId);
    this.#resolutions.set(annotationId, Object.freeze({
      status: "pending",
      identity,
      frameKey,
      reason,
      lastKnown: prior?.settled ?? prior?.lastKnown ?? null,
      settled: null,
    }));
  }

  #setPending(annotationId: string, reason: "bridge_not_ready" | "navigation_changed"): void {
    const annotation = this.#targets.get(annotationId);
    if (!annotation) return;
    const frameKey = frameKeyForTarget(annotation.target);
    const frame = this.#frames.get(frameKey);
    const prior = this.#resolutions.get(annotationId);
    this.#resolutions.set(annotationId, Object.freeze({
      status: "pending",
      identity: resolutionIdentity(annotation, frame ?? { navigationId: "pending", revision: 0 }),
      frameKey,
      reason,
      lastKnown: prior?.settled ?? prior?.lastKnown ?? null,
      settled: null,
    }));
  }

  #routingFrame(target: WebAnnotationTarget): readonly [string, ResolverFrameState] | null {
    const expected = frameKeyForTarget(target);
    const exact = this.#frames.get(expected);
    if (exact) return [expected, exact] as const;
    const main = this.#frames.get("main");
    return main ? ["main", main] as const : null;
  }

  #setUnavailable(annotationId: string, reason: "surface_discarded" | "resolver_timeout"): void {
    const annotation = this.#targets.get(annotationId);
    if (!annotation) return;
    const frameKey = frameKeyForTarget(annotation.target);
    const frame = this.#frames.get(frameKey) ?? { navigationId: "unavailable", revision: 0 };
    const prior = this.#resolutions.get(annotationId);
    this.#resolutions.set(annotationId, Object.freeze({
      status: "temporarily_unavailable",
      identity: resolutionIdentity(annotation, frame),
      frameKey,
      reason,
      lastKnown: prior?.settled ?? prior?.lastKnown ?? null,
      settled: null,
    }));
  }

  #ensureSlice(): void {
    if (this.#disposed || this.#suspended || this.#paused || this.#sliceHandle !== null || this.#queue.length === 0) return;
    this.#sliceHandle = this.#scheduler.scheduleSlice(() => {
      this.#sliceHandle = null;
      this.#runSlice();
    });
  }

  #runSlice(): void {
    if (this.#disposed || this.#suspended || this.#paused) return;
    const startedAt = this.#scheduler.now();
    const targets: { annotationId: string; target: WebAnnotationTarget }[] = [];
    while (this.#queue.length > 0 && targets.length < BROWSER_LIMITS.resolveBatchSize) {
      if (targets.length > 0 && this.#scheduler.now() - startedAt >= BROWSER_LIMITS.resolveSliceBudgetMs) break;
      const annotationId = this.#queue.shift()!;
      this.#queued.delete(annotationId);
      const annotation = this.#targets.get(annotationId);
      const route = annotation ? this.#routingFrame(annotation.target) : null;
      if (!annotation || !route) continue;
      targets.push({ annotationId, target: annotation.target });
    }
    if (targets.length === 0) {
      this.#publish();
      this.#ensureSlice();
      return;
    }
    const requestId = `resolve-${++this.#requestSequence}`;
    targets.forEach((target, index) => {
      const annotation = this.#targets.get(target.annotationId)!;
      const [frameKey, frame] = this.#routingFrame(annotation.target)!;
      const prior = this.#resolutions.get(target.annotationId);
      this.#resolutions.set(target.annotationId, Object.freeze({
        status: "resolving",
        identity: resolutionIdentity(annotation, frame),
        frameKey,
        reason: prior?.reason === "dom_changed" ? "dom_changed" : "annotation_set_changed",
        requestId,
        lastKnown: prior?.settled ?? prior?.lastKnown ?? null,
        settled: null,
      }));
      this.#requestTargets.set(`${requestId}:${index}`, target.annotationId);
    });
    this.#publish();
    void this.#port.resolveAnnotations({
      surface: this.#surface,
      resolveRequestId: requestId,
      targets,
    }).catch(() => {
      for (let index = 0; index < targets.length; index += 1) {
        this.#requestTargets.delete(`${requestId}:${index}`);
        const current = this.#resolutions.get(targets[index].annotationId);
        if (current?.requestId === requestId) this.#setUnavailable(targets[index].annotationId, "resolver_timeout");
      }
      this.#publish();
    }).finally(() => this.#ensureSlice());
    this.#ensureSlice();
  }

  #clearWork(): void {
    this.#cancelSlice();
    this.#queue.length = 0;
    this.#queued.clear();
    this.#requestTargets.clear();
  }

  #cancelSlice(): void {
    if (this.#sliceHandle === null) return;
    this.#scheduler.cancelSlice(this.#sliceHandle);
    this.#sliceHandle = null;
  }

  #removeCachedAnnotation(annotationId: string): void {
    for (const [key, cached] of this.#cache) {
      if (cached.resolution.identity.annotationId === annotationId) this.#cache.delete(key);
    }
  }

  #removeCachedFrame(frameKey: string): void {
    for (const [key, cached] of this.#cache) {
      if (cached.frameKey === frameKey) this.#cache.delete(key);
    }
  }

  #publish(): void {
    if (this.#disposed) return;
    const resolutions: Record<string, WebAnnotationCoordinatorResolution> = {};
    const visibleStatuses: Record<string, WebAnnotationVisibleStatus> = {};
    for (const [annotationId, resolution] of this.#resolutions) {
      resolutions[annotationId] = resolution;
      visibleStatuses[annotationId] = resolution.settled?.status
        ?? resolution.lastKnown?.status
        ?? resolution.status;
    }
    this.#snapshot = Object.freeze({
      resolutions: Object.freeze(resolutions),
      visibleStatuses: Object.freeze(visibleStatuses),
      queued: this.#queue.length,
      suspended: this.#suspended,
      paused: this.#paused,
    });
    for (const listener of this.#listeners) listener();
  }
}

export function webAnnotationResolutionCacheKey(identity: WebAnnotationResolutionIdentity): string {
  return JSON.stringify([
    identity.resourceId,
    identity.annotationId,
    identity.navigationId,
    identity.frameRevision,
  ]);
}

export function frameKeyForTarget(target: WebAnnotationTarget): string {
  return target.frame.indexPath.length === 0 ? "main" : `frame:${target.frame.indexPath.join(".")}`;
}

function resolutionIdentity(
  annotation: WebAnnotationResolverTarget,
  frame: ResolverFrameState,
): WebAnnotationResolutionIdentity {
  return Object.freeze({
    resourceId: annotation.resourceId,
    annotationId: annotation.annotationId,
    navigationId: frame.navigationId,
    frameRevision: frame.revision,
  });
}

function targetSignature(target: WebAnnotationTarget): string {
  return JSON.stringify(target);
}

function sameSurface(
  surface: BrowserSurfaceRef,
  candidate: Pick<BrowserSurfaceRef, "panelId" | "surfaceId" | "generation">,
): boolean {
  return surface.panelId === candidate.panelId
    && surface.surfaceId === candidate.surfaceId
    && surface.generation === candidate.generation;
}

function defaultResolverScheduler(): WebAnnotationResolverScheduler {
  return {
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    nowIso: () => new Date().toISOString(),
    scheduleSlice(callback) {
      const host = globalThis as typeof globalThis & {
        requestIdleCallback?: (handler: () => void, options?: { timeout: number }) => number;
      };
      return typeof host.requestIdleCallback === "function"
        ? { kind: "idle", id: host.requestIdleCallback(callback, { timeout: 50 }) }
        : { kind: "timer", id: globalThis.setTimeout(callback, 0) };
    },
    cancelSlice(handle) {
      const value = handle as { kind?: "idle" | "timer"; id?: number } | null;
      if (!value || typeof value.id !== "number") return;
      if (value.kind === "idle") {
        const host = globalThis as typeof globalThis & { cancelIdleCallback?: (id: number) => void };
        host.cancelIdleCallback?.(value.id);
      } else {
        globalThis.clearTimeout(value.id);
      }
    },
  };
}
