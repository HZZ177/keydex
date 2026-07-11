import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ParsedA2UIMessage } from "./A2UIBlock";

type A2UIStreamPlayerPhase = "idle" | "previewing" | "waiting_created" | "created" | "failed";

interface PlayerRuntime {
  displayPayload: Record<string, unknown>;
  displaySourceSignature: string;
  drainStartedAt: number | null;
  finalPayload: Record<string, unknown> | null;
  firstChunkTime: number | null;
  inputRevision: string;
  key: string;
  latestPayload: Record<string, unknown>;
  phase: A2UIStreamPlayerPhase;
  raf: number | null;
  renderedElementCount: number;
  sourceSignature: string;
  streamPlaybackStarted: boolean;
  timer: number | null;
}

interface InitialPlayerState {
  runtime: PlayerRuntime;
  snapshot: A2UIStreamPlayerState;
}

export interface A2UIStreamPlayerRootProps {
  "data-a2ui-player-enabled": string;
  "data-a2ui-player-phase": string;
  "data-a2ui-player-rendered": number;
  "data-a2ui-player-total": number;
  "data-a2ui-player-running": string;
  "data-a2ui-reveal-enabled": string;
  "data-a2ui-reveal-total": number;
  "data-a2ui-reveal-visible": number;
  "data-a2ui-reveal-backlog": number;
  "data-a2ui-reveal-speed": number;
  "data-a2ui-reveal-running": string;
}

export interface A2UIStreamPlayerState {
  enabled: boolean;
  phase: A2UIStreamPlayerPhase;
  payload: Record<string, unknown>;
  renderedElementCount: number;
  rootProps: A2UIStreamPlayerRootProps;
  running: boolean;
  totalElementCount: number;
}

const MIN_INTERVAL_MS = 220;
const MAX_INTERVAL_MS = 360;
const SMALL_PAYLOAD_MAX_INTERVAL_MS = 520;
const MIN_RENDER_DURATION_MS = 2_200;
const SMALL_PAYLOAD_MIN_RENDER_DURATION_MS = 2_600;
const FAST_STREAM_THRESHOLD_MS = 600;
const CATCH_UP_INTERVAL_MS = 240;
const FINAL_SETTLE_DELAY_MS = 520;
const SMALL_PAYLOAD_SLOW_REVEAL_THRESHOLD = 10;
const BACKLOG_DRAIN_TARGET_MS = 2_000;
const BACKLOG_WARMUP_VISIBLE_THRESHOLD = 20;
const BACKLOG_WARMUP_MAX_UNITS_PER_TICK = 6;
const BACKLOG_MAX_UNITS_PER_TICK = 24;
const STREAMING_STATUSES = new Set(["started", "streaming", "finished"]);

export function resetA2UIStreamPlayerPlaybackForTests(): void {
  // The player no longer keeps process-global playback state.
}

export function useA2UIStreamPlayer(
  parsed: ParsedA2UIMessage,
  scopeKey = "",
): A2UIStreamPlayerState {
  const playerKey = useMemo(() => buildA2UIStreamPlayerKey(parsed, scopeKey), [parsed, scopeKey]);
  const sourceSignature = useMemo(() => safeJsonStringify(parsed.payload), [parsed.payload]);
  const inputRevision = buildA2UIStreamInputRevision(parsed, playerKey, sourceSignature);
  const inputFrameRef = useRef({ inputRevision, parsed, playerKey, sourceSignature });
  inputFrameRef.current = { inputRevision, parsed, playerKey, sourceSignature };
  const [initialState] = useState(() => createInitialPlayerState(playerKey, parsed, sourceSignature));
  const [snapshot, setSnapshot] = useState(() => initialState.snapshot);
  const runtimeRef = useRef<PlayerRuntime>(initialState.runtime);

  const commit = useCallback((enabled: boolean) => {
    const runtime = runtimeRef.current;
    const nextSnapshot = createSnapshot(
      runtime.displayPayload,
      runtime.phase,
      runtime.renderedElementCount,
      enabled,
      getPayloadElementCount(runtime.latestPayload),
    );
    setSnapshot((current) => (isSameSnapshot(current, nextSnapshot) ? current : nextSnapshot));
  }, []);

  const cancelScheduled = useCallback(() => {
    const runtime = runtimeRef.current;
    if (runtime.raf !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(runtime.raf);
      runtime.raf = null;
    }
    if (runtime.timer !== null && typeof window !== "undefined") {
      window.clearTimeout(runtime.timer);
      runtime.timer = null;
    }
  }, []);

  const updateDisplayPayload = useCallback(() => {
    const runtime = runtimeRef.current;
    runtime.displayPayload = slicePayloadByRenderedCount(runtime.latestPayload, runtime.renderedElementCount);
    runtime.displaySourceSignature = runtime.sourceSignature;
  }, []);

  const scheduleFinalize = useCallback((enabled: boolean) => {
    const runtime = runtimeRef.current;
    if (!runtime.finalPayload || runtime.phase === "created") {
      return;
    }
    if (runtime.raf !== null || runtime.timer !== null) {
      return;
    }
    if (typeof window === "undefined") {
      finalizeRuntimePayload(runtime);
      commit(enabled);
      return;
    }
    runtime.timer = window.setTimeout(() => {
      runtime.timer = null;
      finalizeRuntimePayload(runtime);
      commit(enabled);
    }, FINAL_SETTLE_DELAY_MS);
  }, [commit]);

  const scheduleNext = useCallback((enabled: boolean) => {
    const runtime = runtimeRef.current;
    if (!enabled || runtime.phase === "created" || runtime.phase === "failed" || typeof window === "undefined") {
      return;
    }
    if (runtime.raf !== null || runtime.timer !== null) {
      return;
    }
    const total = getTotalElementCount(runtime.latestPayload);
    if (total <= 0) {
      runtime.drainStartedAt = null;
      if (runtime.finalPayload) {
        scheduleFinalize(enabled);
      } else if (runtime.displaySourceSignature !== runtime.sourceSignature) {
        runtime.timer = window.setTimeout(() => {
          runtime.timer = null;
          updateDisplayPayload();
          commit(enabled);
          scheduleNext(enabled);
        }, MIN_INTERVAL_MS);
      }
      return;
    }
    if (runtime.renderedElementCount >= total) {
      runtime.drainStartedAt = null;
      if (runtime.finalPayload) {
        scheduleFinalize(enabled);
      } else if (runtime.displaySourceSignature !== runtime.sourceSignature) {
        runtime.timer = window.setTimeout(() => {
          runtime.timer = null;
          updateDisplayPayload();
          commit(enabled);
          scheduleNext(enabled);
        }, MIN_INTERVAL_MS);
      }
      return;
    }

    if (runtime.drainStartedAt === null) {
      runtime.drainStartedAt = nowMs();
    }
    if (runtime.renderedElementCount === 0) {
      runtime.renderedElementCount = initialRenderedElementCount(runtime.latestPayload);
      updateDisplayPayload();
      commit(enabled);
    }

    const interval = calculateInterval(runtime);
    const step = calculateElementStep(runtime, interval);
    runtime.timer = window.setTimeout(() => {
      runtime.timer = null;
      const latestTotal = getTotalElementCount(runtime.latestPayload);
      runtime.renderedElementCount = Math.min(runtime.renderedElementCount + step, latestTotal);
      if (runtime.renderedElementCount >= latestTotal) {
        runtime.drainStartedAt = null;
      }
      updateDisplayPayload();
      if (runtime.renderedElementCount >= latestTotal && runtime.finalPayload) {
        scheduleFinalize(enabled);
        commit(enabled);
        return;
      }
      commit(enabled);
      scheduleNext(enabled);
    }, interval);
  }, [commit, scheduleFinalize, updateDisplayPayload]);

  useEffect(() => {
    const frame = inputFrameRef.current;
    const currentParsed = frame.parsed;
    const status = normalizeStatus(currentParsed.status);
    let runtime = runtimeRef.current;

    if (runtime.key !== frame.playerKey) {
      cancelScheduled();
      runtime = createRuntime(frame.playerKey, currentParsed.payload, frame.sourceSignature);
      runtimeRef.current = runtime;
    }
    if (runtime.inputRevision === frame.inputRevision) {
      return;
    }
    runtime.inputRevision = frame.inputRevision;

    const liveStreamFrame = isLiveStreamFrame(currentParsed);
    if (liveStreamFrame) {
      runtime.streamPlaybackStarted = true;
    }
    const streamPlaybackStarted = runtime.streamPlaybackStarted;
    const rememberedTotal = getTotalElementCount(runtime.latestPayload);
    const incomingTotal = getTotalElementCount(currentParsed.payload);
    const shouldPlay = shouldUseStreamPlayer(currentParsed, streamPlaybackStarted, Math.max(rememberedTotal, incomingTotal));
    if (
      currentParsed.mode === "render" &&
      runtime.phase === "created" &&
      runtime.finalPayload &&
      runtime.sourceSignature === frame.sourceSignature &&
      status !== "failed" &&
      status !== "missing"
    ) {
      return;
    }

    if (!shouldPlay) {
      cancelScheduled();
      runtime.drainStartedAt = null;
      runtime.latestPayload = currentParsed.payload;
      runtime.finalPayload = currentParsed.payload;
      runtime.displayPayload = currentParsed.payload;
      runtime.displaySourceSignature = frame.sourceSignature;
      runtime.renderedElementCount = getTotalElementCount(currentParsed.payload);
      runtime.phase = status === "failed" || status === "missing" ? "failed" : "created";
      runtime.sourceSignature = frame.sourceSignature;
      commit(false);
      return;
    }

    const sameSource = runtime.sourceSignature === frame.sourceSignature;
    const isFinalPayload = Boolean(currentParsed.a2ui) || (!STREAMING_STATUSES.has(status) && streamPlaybackStarted);
    const shouldKeepRenderedPayload =
      isFinalPayload &&
      !currentParsed.a2ui &&
      rememberedTotal > 0 &&
      incomingTotal === 0;
    if (!sameSource) {
      runtime.latestPayload = shouldKeepRenderedPayload
        ? runtime.latestPayload
        : isFinalPayload
        ? currentParsed.payload
        : mergeStreamingPayload(runtime.latestPayload, currentParsed.payload);
      if (!shouldKeepRenderedPayload) {
        runtime.sourceSignature = frame.sourceSignature;
      }
    }

    if (runtime.firstChunkTime === null) {
      runtime.firstChunkTime = nowMs();
    }

    if (isFinalPayload) {
      const finalPayload = shouldKeepRenderedPayload ? runtime.latestPayload : currentParsed.payload;
      runtime.finalPayload = finalPayload;
      runtime.latestPayload = finalPayload;
      if (runtime.renderedElementCount >= getTotalElementCount(finalPayload)) {
        finalizeRuntimePayload(runtime);
      } else {
        runtime.phase = "waiting_created";
      }
    } else {
      runtime.phase = "previewing";
    }

    if (runtime.finalPayload && runtime.renderedElementCount >= getTotalElementCount(runtime.latestPayload)) {
      scheduleFinalize(true);
    }
    commit(true);
    scheduleNext(true);
  }, [
    cancelScheduled,
    commit,
    inputRevision,
    scheduleFinalize,
    scheduleNext,
    updateDisplayPayload,
  ]);

  useEffect(() => () => cancelScheduled(), [cancelScheduled]);

  return snapshot;
}

function isSameSnapshot(current: A2UIStreamPlayerState, next: A2UIStreamPlayerState): boolean {
  return (
    current.enabled === next.enabled &&
    current.phase === next.phase &&
    current.payload === next.payload &&
    current.renderedElementCount === next.renderedElementCount &&
    current.running === next.running &&
    current.totalElementCount === next.totalElementCount
  );
}

function createRuntime(key: string, payload: Record<string, unknown>, sourceSignature: string): PlayerRuntime {
  return {
    displayPayload: payload,
    displaySourceSignature: sourceSignature,
    drainStartedAt: null,
    finalPayload: null,
    firstChunkTime: null,
    inputRevision: "",
    key,
    latestPayload: payload,
    phase: "idle",
    raf: null,
    renderedElementCount: 0,
    sourceSignature,
    streamPlaybackStarted: false,
    timer: null,
  };
}

function createInitialPlayerState(
  key: string,
  parsed: ParsedA2UIMessage,
  sourceSignature: string,
): InitialPlayerState {
  const runtime = createRuntime(key, parsed.payload, sourceSignature);
  const status = normalizeStatus(parsed.status);
  const liveStreamFrame = isLiveStreamFrame(parsed);
  const totalElementCount = getTotalElementCount(parsed.payload);
  const shouldPlay = shouldUseStreamPlayer(parsed, liveStreamFrame, totalElementCount);

  if (!shouldPlay) {
    runtime.finalPayload = parsed.payload;
    runtime.renderedElementCount = totalElementCount;
    runtime.phase = status === "failed" || status === "missing" ? "failed" : "created";
    return {
      runtime,
      snapshot: createSnapshot(runtime.displayPayload, runtime.phase, runtime.renderedElementCount, false),
    };
  }

  const isFinalPayload = Boolean(parsed.a2ui) || (!STREAMING_STATUSES.has(status) && liveStreamFrame);
  runtime.streamPlaybackStarted = true;
  runtime.finalPayload = isFinalPayload ? parsed.payload : null;
  runtime.phase = isFinalPayload ? "waiting_created" : "previewing";
  runtime.renderedElementCount = initialRenderedElementCount(parsed.payload);
  runtime.displayPayload = slicePayloadByRenderedCount(parsed.payload, runtime.renderedElementCount);
  runtime.displaySourceSignature = sourceSignature;

  return {
    runtime,
    snapshot: createSnapshot(runtime.displayPayload, runtime.phase, runtime.renderedElementCount, true, totalElementCount),
  };
}

function createSnapshot(
  payload: Record<string, unknown>,
  phase: A2UIStreamPlayerPhase,
  renderedElementCount: number,
  enabled: boolean,
  totalElementCount = getPayloadElementCount(payload),
): A2UIStreamPlayerState {
  const rendered = enabled
    ? Math.min(Math.max(0, renderedElementCount), totalElementCount)
    : totalElementCount;
  const running = enabled && (phase === "previewing" || phase === "waiting_created") && rendered < totalElementCount;
  const backlog = enabled ? Math.max(0, totalElementCount - rendered) : 0;
  return {
    enabled,
    phase,
    payload,
    renderedElementCount: rendered,
    rootProps: {
      "data-a2ui-player-enabled": enabled ? "true" : "false",
      "data-a2ui-player-phase": phase,
      "data-a2ui-player-rendered": rendered,
      "data-a2ui-player-total": totalElementCount,
      "data-a2ui-player-running": running ? "true" : "false",
      "data-a2ui-reveal-enabled": enabled ? "true" : "false",
      "data-a2ui-reveal-total": totalElementCount,
      "data-a2ui-reveal-visible": rendered,
      "data-a2ui-reveal-backlog": backlog,
      "data-a2ui-reveal-speed": running ? Math.round(1000 / CATCH_UP_INTERVAL_MS) : 0,
      "data-a2ui-reveal-running": running ? "true" : "false",
    },
    running,
    totalElementCount,
  };
}

export function buildA2UIStreamPlayerKey(parsed: ParsedA2UIMessage, scopeKey = ""): string {
  const streamIdentity =
    stringIdentity(parsed.a2ui?.stream_id) ||
    stringIdentity(parsed.debug?.streamId) ||
    stringIdentity(scopeKey) ||
    "a2ui-missing-stream-id";
  return [streamIdentity, parsed.renderKey].filter(Boolean).join(":");
}

export function buildA2UIStreamInputRevision(
  parsed: ParsedA2UIMessage,
  playerKey = buildA2UIStreamPlayerKey(parsed),
  sourceSignature = safeJsonStringify(parsed.payload),
): string {
  const rawEvents = parsed.debug?.rawEvents ?? [];
  const lastEvent = rawEvents.at(-1);
  return [
    playerKey,
    sourceSignature,
    normalizeStatus(parsed.status),
    parsed.a2ui ? "final" : "preview",
    parsed.historyHydrated ? "history" : "live",
    positiveInteger(parsed.debug?.chunkCount),
    positiveInteger(parsed.debug?.argsTextLength),
    rawEvents.length,
    stringIdentity(lastEvent?.id),
    stringIdentity(lastEvent?.action),
    stringIdentity(lastEvent?.timestamp),
    stringIdentity(parsed.debug?.updatedAt),
  ].join("|");
}

function shouldUseStreamPlayer(
  parsed: ParsedA2UIMessage,
  streamPlaybackStarted: boolean,
  knownElementCount: number,
): boolean {
  if (parsed.historyHydrated || !streamPlaybackStarted || prefersReducedMotion()) {
    return false;
  }
  return knownElementCount > 0;
}

function isLiveStreamFrame(parsed: ParsedA2UIMessage): boolean {
  if (parsed.historyHydrated) {
    return false;
  }
  return (
    (!parsed.a2ui && STREAMING_STATUSES.has(normalizeStatus(parsed.status))) ||
    isInteractiveWaitingFrameWithStreamEvidence(parsed)
  );
}

function isInteractiveWaitingFrameWithStreamEvidence(parsed: ParsedA2UIMessage): boolean {
  return (
    Boolean(parsed.a2ui) &&
    parsed.mode === "interactive" &&
    normalizeStatus(parsed.status) === "waiting_input" &&
    (positiveInteger(parsed.debug?.chunkCount) > 0 || parsed.streamText.length > 0)
  );
}

function calculateInterval(runtime: PlayerRuntime): number {
  const total = getTotalElementCount(runtime.latestPayload);
  const remaining = total - runtime.renderedElementCount;
  if (remaining <= 0) {
    return 0;
  }
  const elapsed = runtime.firstChunkTime === null ? 0 : nowMs() - runtime.firstChunkTime;
  if (runtime.finalPayload) {
    const isSmallPayload = total <= SMALL_PAYLOAD_SLOW_REVEAL_THRESHOLD;
    const renderDuration = isSmallPayload ? SMALL_PAYLOAD_MIN_RENDER_DURATION_MS : MIN_RENDER_DURATION_MS;
    const maxInterval = isSmallPayload ? SMALL_PAYLOAD_MAX_INTERVAL_MS : MAX_INTERVAL_MS;
    const visibleInterval = Math.max(MIN_INTERVAL_MS, Math.min(maxInterval, renderDuration / remaining));
    if (elapsed < FAST_STREAM_THRESHOLD_MS || total <= SMALL_PAYLOAD_SLOW_REVEAL_THRESHOLD) {
      return visibleInterval;
    }
    return CATCH_UP_INTERVAL_MS;
  }
  const targetTotal = Math.max(900, Math.min(2600, total * 110));
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, targetTotal / Math.max(1, total)));
}

function calculateElementStep(runtime: PlayerRuntime, intervalMs: number): number {
  const total = getTotalElementCount(runtime.latestPayload);
  const drainElapsedMs = runtime.drainStartedAt === null
    ? 0
    : Math.max(0, nowMs() - runtime.drainStartedAt);
  return calculateA2UIStreamElementStep(
    total,
    runtime.renderedElementCount,
    intervalMs,
    drainElapsedMs,
  );
}

export function calculateA2UIStreamElementStep(
  totalElementCount: number,
  renderedElementCount: number,
  intervalMs: number,
  drainElapsedMs = 0,
): number {
  const total = Math.max(0, Math.floor(totalElementCount));
  const rendered = Math.max(0, Math.floor(renderedElementCount));
  const remaining = total - rendered;
  if (remaining <= 0) {
    return 0;
  }
  if (total <= SMALL_PAYLOAD_SLOW_REVEAL_THRESHOLD) {
    return 1;
  }
  const remainingDrainMs = Math.max(
    intervalMs,
    BACKLOG_DRAIN_TARGET_MS - Math.max(0, drainElapsedMs),
  );
  const targetTicks = Math.max(1, Math.ceil(remainingDrainMs / Math.max(1, intervalMs)));
  const targetStep = Math.ceil(remaining / targetTicks);
  const maxUnitsPerTick = rendered < BACKLOG_WARMUP_VISIBLE_THRESHOLD
    ? BACKLOG_WARMUP_MAX_UNITS_PER_TICK
    : BACKLOG_MAX_UNITS_PER_TICK;
  return Math.max(1, Math.min(maxUnitsPerTick, targetStep, remaining));
}

function slicePayloadByRenderedCount(payload: Record<string, unknown>, renderedElementCount: number): Record<string, unknown> {
  const arrayPaths = getLeafArrayPaths(payload);
  if (!arrayPaths.length) {
    const keys = Object.keys(payload);
    const result: Record<string, unknown> = {};
    for (let index = 0; index < Math.min(renderedElementCount, keys.length); index += 1) {
      const key = keys[index];
      result[key] = payload[key];
    }
    return result;
  }

  const result = cloneJsonRecord(payload);
  const visibleCounts = distributeVisibleLeafCounts(payload, arrayPaths, renderedElementCount);
  for (const path of arrayPaths) {
    const parent = resolveParent(result, path);
    if (!parent || !Array.isArray(parent.record[parent.key])) {
      continue;
    }
    const list = parent.record[parent.key] as unknown[];
    const showCount = Math.min(visibleCounts.get(path) ?? 0, list.length);
    parent.record[parent.key] = list.slice(0, showCount);
  }
  return result;
}

function getTotalElementCount(payload: Record<string, unknown>): number {
  return getPayloadElementCount(payload);
}

function initialRenderedElementCount(payload: Record<string, unknown>): number {
  return Math.max(1, getLeafArrayPaths(payload).length || 1);
}

function finalizeRuntimePayload(runtime: PlayerRuntime): void {
  if (!runtime.finalPayload) {
    return;
  }
  runtime.renderedElementCount = getTotalElementCount(runtime.latestPayload);
  runtime.displayPayload = runtime.finalPayload;
  runtime.displaySourceSignature = runtime.sourceSignature;
  runtime.drainStartedAt = null;
  runtime.phase = "created";
}

function getPayloadElementCount(payload: Record<string, unknown>): number {
  const arrayPaths = getLeafArrayPaths(payload);
  if (!arrayPaths.length) {
    return Object.keys(payload).length;
  }
  let count = 0;
  for (const path of arrayPaths) {
    const value = resolvePath(payload, path);
    if (Array.isArray(value)) {
      count += value.length;
    }
  }
  return count;
}

function distributeVisibleLeafCounts(
  payload: Record<string, unknown>,
  arrayPaths: string[],
  renderedElementCount: number,
): Map<string, number> {
  const lengths = arrayPaths.map((path) => {
    const value = resolvePath(payload, path);
    return Array.isArray(value) ? value.length : 0;
  });
  const visibleCounts = new Map(arrayPaths.map((path) => [path, 0]));
  let remaining = Math.max(0, renderedElementCount);
  while (remaining > 0 && lengths.some((length, index) => (visibleCounts.get(arrayPaths[index]) ?? 0) < length)) {
    for (let index = 0; index < arrayPaths.length && remaining > 0; index += 1) {
      const path = arrayPaths[index];
      const current = visibleCounts.get(path) ?? 0;
      if (current >= lengths[index]) {
        continue;
      }
      visibleCounts.set(path, current + 1);
      remaining -= 1;
    }
  }
  return visibleCounts;
}

function getLeafArrayPaths(value: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(item)) {
      const isContainer = item.length > 0 && item.every((element) => {
        const record = asRecord(element);
        return record && Object.values(record).some(Array.isArray);
      });
      if (isContainer) {
        item.forEach((element, index) => {
          const record = asRecord(element);
          if (record) {
            paths.push(...getLeafArrayPaths(record, `${path}.${index}`));
          }
        });
      } else {
        paths.push(path);
      }
      continue;
    }
    const record = asRecord(item);
    if (record) {
      paths.push(...getLeafArrayPaths(record, path));
    }
  }
  return paths;
}

function mergeStreamingPayload(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  return mergeValues(previous, incoming) as Record<string, unknown>;
}

function mergeValues(previous: unknown, incoming: unknown): unknown {
  if (Array.isArray(previous) || Array.isArray(incoming)) {
    const previousList = Array.isArray(previous) ? previous : [];
    const incomingList = Array.isArray(incoming) ? incoming : [];
    const length = Math.max(previousList.length, incomingList.length);
    return Array.from({ length }, (_, index) => mergeValues(previousList[index], incomingList[index]));
  }
  const previousRecord = asRecord(previous);
  const incomingRecord = asRecord(incoming);
  if (previousRecord || incomingRecord) {
    return {
      ...(previousRecord ?? {}),
      ...(incomingRecord ?? {}),
      ...Object.fromEntries(
        Array.from(new Set([...Object.keys(previousRecord ?? {}), ...Object.keys(incomingRecord ?? {})]))
          .map((key) => [key, mergeValues(previousRecord?.[key], incomingRecord?.[key])]),
      ),
    };
  }
  return incoming ?? previous;
}

function resolveParent(root: Record<string, unknown>, path: string): { record: Record<string, unknown>; key: string } | null {
  const parts = path.split(".");
  let current: unknown = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else {
      current = asRecord(current)?.[part];
    }
  }
  const record = asRecord(current);
  const key = parts[parts.length - 1];
  return record ? { record, key } : null;
}

function resolvePath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (Array.isArray(current)) {
      return current[Number(part)];
    }
    return asRecord(current)?.[part];
  }, root);
}

function cloneJsonRecord(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  } catch {
    return { ...payload };
  }
}

function normalizeStatus(status: unknown): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function stringIdentity(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
