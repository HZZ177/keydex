import { BROWSER_LIMITS } from "../../config";
import type { BrowserSurfaceRef } from "../../domain";
import type {
  BrowserBridgeEnvelope,
  WebAnnotationLiveNodeBinding,
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
import { visibleWebAnnotationStatus } from "../domain";

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
      readonly binding?: WebAnnotationLiveNodeBinding;
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

interface ConfirmedSelectionResolution {
  readonly resourceId: string;
  readonly targetSignature: string;
  readonly target: WebAnnotationTarget;
  readonly binding: WebAnnotationLiveNodeBinding;
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
  readonly #requestTargets = new Map<string, {
    readonly annotationId: string;
    readonly resolveRequestId: string;
  }>();
  readonly #liveBindings = new Map<string, WebAnnotationLiveNodeBinding>();
  readonly #confirmedSelections = new Map<string, ConfirmedSelectionResolution>();
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

  confirmCreatedAnnotation(input: {
    readonly resourceId: string;
    readonly annotationId: string;
    readonly target: WebAnnotationTarget;
    readonly binding: WebAnnotationLiveNodeBinding;
  }): void {
    if (this.#disposed) return;
    const confirmed = Object.freeze({
      resourceId: input.resourceId,
      targetSignature: targetSignature(input.target),
      target: input.target,
      binding: Object.freeze({ ...input.binding }),
    });
    this.#confirmedSelections.set(input.annotationId, confirmed);
    this.#liveBindings.set(input.annotationId, confirmed.binding);
    const annotation = this.#targets.get(input.annotationId);
    if (annotation && this.#applyConfirmedSelection(annotation)) {
      this.#queueAnnotation(input.annotationId, "dom_changed");
      this.#publish();
      this.#ensureSlice();
    }
  }

  activatePage(page: WebAnnotationResolverPage): void {
    if (this.#disposed) return;
    const navigationChanged = this.#page !== null
      && this.#page.hostNavigationId !== page.hostNavigationId;
    const pageChanged = this.#page?.resourceId !== page.resourceId || navigationChanged;
    if (pageChanged) {
      this.#clearWork();
      this.#targets.clear();
      this.#targetSignatures.clear();
      this.#resolutions.clear();
      this.#cache.clear();
      if (navigationChanged) {
        this.#liveBindings.clear();
        this.#confirmedSelections.clear();
      }
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
      this.#liveBindings.delete(annotationId);
      this.#confirmedSelections.delete(annotationId);
    }
    for (const annotation of page.annotations) {
      const signature = targetSignature(annotation.target);
      const priorSignature = this.#targetSignatures.get(annotation.annotationId);
      this.#targets.set(annotation.annotationId, annotation);
      this.#targetSignatures.set(annotation.annotationId, signature);
      if (priorSignature !== undefined && priorSignature !== signature) {
        this.#removeCachedAnnotation(annotation.annotationId);
      }
      if (this.#applyConfirmedSelection(annotation)) {
        // The user selected this exact live node moments ago, so expose that
        // fact immediately. A background resolve still registers the new
        // annotation id inside the page bridge and replaces this baseline with
        // bridge-authenticated evidence when the native surface is available.
        this.#queueAnnotation(annotation.annotationId, "dom_changed");
        continue;
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
    this.#liveBindings.clear();
    this.#confirmedSelections.clear();
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
        const current = this.#resolutions.get(annotationId);
        // Native suspension is a browser-resource lifecycle state (for
        // example while the annotation drawer occludes the WebView), not a
        // statement about whether the saved target can be located. Preserve
        // settled/last-known locator state and leave never-resolved items
        // pending until the surface resumes.
        if (!current || (!current.lastKnown && (
          current.status === "resolving" || current.status === "temporarily_unavailable"
        ))) {
          this.#setPending(annotationId, "bridge_not_ready");
        }
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
      const pageChanged = envelope as BrowserBridgeEnvelope<"page.changed">;
      for (const annotationId of pageChanged.payload.annotationIds) {
        const annotation = this.#targets.get(annotationId);
        if (annotation && frameKeyForTarget(annotation.target) === envelope.frameKey) {
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
      const failure = envelope as BrowserBridgeEnvelope<"bridge.error">;
      const request = this.#requestTargets.get(envelope.requestId);
      if (request) {
        this.#requestTargets.delete(envelope.requestId);
        const current = this.#resolutions.get(request.annotationId);
        if (current?.requestId === request.resolveRequestId) {
          console.warn("[Keydex Browser Annotation] page resolver failed", {
            requestId: envelope.requestId,
            annotationId: request.annotationId,
            code: failure.payload.code,
            message: failure.payload.message,
            retryable: failure.payload.retryable,
          });
          if (failure.payload.retryable) this.#setPending(request.annotationId, "bridge_not_ready");
          else this.#setUnavailable(request.annotationId, "resolver_timeout");
        }
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
    this.#liveBindings.clear();
    this.#confirmedSelections.clear();
    this.#listeners.clear();
    this.#snapshot = EMPTY_SNAPSHOT;
  }

  #handleBridgeReady(envelope: BrowserBridgeEnvelope<"bridge.ready">): void {
    const currentFrame = this.#frames.get(envelope.frameKey);
    if (currentFrame?.navigationId === envelope.navigationId) {
      for (const [annotationId, annotation] of this.#targets) {
        const resolution = this.#resolutions.get(annotationId);
        if ((envelope.payload.top || frameKeyForTarget(annotation.target) === envelope.frameKey)
          && (!resolution || resolution.status === "pending" || resolution.status === "temporarily_unavailable")) {
          this.#queueAnnotation(annotationId, "bridge_ready");
        }
      }
      this.#publish();
      this.#ensureSlice();
      return;
    }
    if (envelope.payload.top) {
      this.#clearWork();
      this.#frames.clear();
      this.#cache.clear();
      this.#resolutions.clear();
      this.#liveBindings.clear();
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
    const request = this.#requestTargets.get(envelope.requestId);
    this.#requestTargets.delete(envelope.requestId);
    const current = this.#resolutions.get(annotation.annotationId);
    if (!request
      || request.annotationId !== annotation.annotationId
      || current?.status !== "resolving"
      || current.requestId !== request.resolveRequestId) return;
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
    const binding = settled.evidence?.binding;
    if (binding && (settled.status === "resolved" || settled.status === "changed")) {
      this.#liveBindings.set(annotation.annotationId, Object.freeze({ ...binding }));
    } else {
      this.#liveBindings.delete(annotation.annotationId);
    }
    this.#publish();
  }

  #queueAnnotation(annotationId: string, reason: "bridge_ready" | "annotation_set_changed" | "dom_changed"): void {
    const annotation = this.#targets.get(annotationId);
    if (!annotation || !this.#page) return;
    this.#invalidateRequests(annotationId);
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

  #applyConfirmedSelection(annotation: WebAnnotationResolverTarget): boolean {
    const confirmed = this.#confirmedSelections.get(annotation.annotationId);
    if (!confirmed) return false;
    if (confirmed.resourceId !== annotation.resourceId
      || confirmed.targetSignature !== targetSignature(annotation.target)) {
      this.#confirmedSelections.delete(annotation.annotationId);
      this.#liveBindings.delete(annotation.annotationId);
      return false;
    }
    const route = this.#routingFrame(annotation.target);
    if (!route) return false;
    const [frameKey, frame] = route;
    const identity = resolutionIdentity(annotation, frame);
    const settled: WebAnnotationSettledPageResolution = Object.freeze({
      status: "resolved",
      identity,
      frameKey,
      target: confirmed.target,
      candidateIds: Object.freeze([]),
      evidence: Object.freeze({
        strategy: "node_handle",
        score: 1,
        rects: Object.freeze(targetRects(confirmed.target)),
        candidateCount: 1,
        truncated: false,
        changedSignals: Object.freeze([]),
        binding: confirmed.binding,
      }),
      settledAt: this.#scheduler.nowIso(),
    });
    this.#resolutions.set(annotation.annotationId, Object.freeze({
      status: "resolved",
      identity,
      frameKey,
      reason: "exact_match",
      lastKnown: settled,
      settled,
    }));
    this.#confirmedSelections.delete(annotation.annotationId);
    return true;
  }

  #routingFrame(target: WebAnnotationTarget): readonly [string, ResolverFrameState] | null {
    const expected = frameKeyForTarget(target);
    const exact = this.#frames.get(expected);
    if (exact) return [expected, exact] as const;
    const main = this.#frames.get("main");
    return main ? ["main", main] as const : null;
  }

  #setUnavailable(annotationId: string, reason: "resolver_timeout"): void {
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
    const targets: {
      annotationId: string;
      target: WebAnnotationTarget;
      binding?: WebAnnotationLiveNodeBinding;
    }[] = [];
    while (this.#queue.length > 0 && targets.length < BROWSER_LIMITS.resolveBatchSize) {
      if (targets.length > 0 && this.#scheduler.now() - startedAt >= BROWSER_LIMITS.resolveSliceBudgetMs) break;
      const annotationId = this.#queue.shift()!;
      this.#queued.delete(annotationId);
      const annotation = this.#targets.get(annotationId);
      const route = annotation ? this.#routingFrame(annotation.target) : null;
      if (!annotation || !route) continue;
      const binding = this.#liveBindings.get(annotationId);
      targets.push({
        annotationId,
        target: annotation.target,
        ...(binding ? { binding } : {}),
      });
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
      this.#requestTargets.set(`${requestId}:${index}`, {
        annotationId: target.annotationId,
        resolveRequestId: requestId,
      });
    });
    this.#publish();
    void this.#port.resolveAnnotations({
      surface: this.#surface,
      resolveRequestId: requestId,
      targets,
    }).catch((error: unknown) => {
      console.warn("[Keydex Browser Annotation] resolver dispatch failed", {
        requestId,
        annotationIds: targets.map((target) => target.annotationId),
        error: error instanceof Error ? error.message : String(error),
      });
      for (let index = 0; index < targets.length; index += 1) {
        this.#requestTargets.delete(`${requestId}:${index}`);
        const current = this.#resolutions.get(targets[index].annotationId);
        if (current?.requestId === requestId) {
          // A rejected host dispatch says nothing about whether the target can
          // be located. Keep the last exact result (if any) and wait for the
          // next bridge-ready/resource-resume signal instead of fabricating a
          // resolver timeout.
          this.#setPending(targets[index].annotationId, "bridge_not_ready");
        }
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

  #invalidateRequests(annotationId: string): void {
    for (const [requestId, request] of this.#requestTargets) {
      if (request.annotationId === annotationId) this.#requestTargets.delete(requestId);
    }
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
      visibleStatuses[annotationId] = visibleWebAnnotationStatus(
        resolution.settled?.status
          ?? resolution.lastKnown?.status
          ?? resolution.status,
      );
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

function targetRects(target: WebAnnotationTarget): WebAnnotationPageResolutionEvidence["rects"] {
  if (target.type === "text") return [...target.rects];
  return [target.rect];
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
