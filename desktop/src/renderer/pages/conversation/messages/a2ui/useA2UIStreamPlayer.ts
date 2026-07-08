import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ParsedA2UIMessage } from "./A2UIBlock";

type A2UIStreamPlayerPhase = "idle" | "previewing" | "waiting_created" | "created" | "failed";

interface PlayerRuntime {
  displayPayload: Record<string, unknown>;
  finalPayload: Record<string, unknown> | null;
  firstChunkTime: number | null;
  key: string;
  latestPayload: Record<string, unknown>;
  phase: A2UIStreamPlayerPhase;
  raf: number | null;
  renderedElementCount: number;
  sourceSignature: string;
  streamBackedSeen: boolean;
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

const MIN_INTERVAL_MS = 160;
const MAX_INTERVAL_MS = 420;
const MIN_RENDER_DURATION_MS = 1_800;
const FAST_STREAM_THRESHOLD_MS = 420;
const CATCH_UP_INTERVAL_MS = 160;
const FINAL_SETTLE_DELAY_MS = 760;
const SMALL_PAYLOAD_SLOW_REVEAL_THRESHOLD = 8;
const STREAMING_STATUSES = new Set(["started", "streaming", "finished"]);
const DISABLED_STATUSES = new Set(["submitted", "cancelled", "failed", "missing"]);

export function useA2UIStreamPlayer(parsed: ParsedA2UIMessage): A2UIStreamPlayerState {
  const playerKey = useMemo(() => buildA2UIStreamPlayerKey(parsed), [parsed]);
  const sourceSignature = useMemo(() => safeJsonStringify(parsed.payload), [parsed.payload]);
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
      runtime.displayPayload = runtime.latestPayload;
      if (runtime.finalPayload) {
        scheduleFinalize(enabled);
      }
      commit(enabled);
      return;
    }
    if (runtime.renderedElementCount >= total) {
      if (runtime.finalPayload) {
        scheduleFinalize(enabled);
      } else {
        runtime.displayPayload = runtime.latestPayload;
      }
      commit(enabled);
      return;
    }

    if (runtime.renderedElementCount === 0) {
      runtime.renderedElementCount = initialRenderedElementCount(runtime.latestPayload);
      updateDisplayPayload();
      commit(enabled);
    }

    const interval = calculateInterval(runtime);
    runtime.raf = window.requestAnimationFrame(() => {
      runtime.raf = null;
      runtime.timer = window.setTimeout(() => {
        runtime.timer = null;
        const latestTotal = getTotalElementCount(runtime.latestPayload);
        runtime.renderedElementCount = Math.min(runtime.renderedElementCount + 1, latestTotal);
        updateDisplayPayload();
        if (runtime.renderedElementCount >= latestTotal && runtime.finalPayload) {
          scheduleFinalize(enabled);
          commit(enabled);
          return;
        }
        commit(enabled);
        scheduleNext(enabled);
      }, interval);
    });
  }, [commit, scheduleFinalize, updateDisplayPayload]);

  useEffect(() => {
    const status = normalizeStatus(parsed.status);
    const streamBackedInCurrentFrame = hasStreamEvidence(parsed);
    let runtime = runtimeRef.current;

    if (runtime.key !== playerKey) {
      cancelScheduled();
      runtime = createRuntime(playerKey, parsed.payload, sourceSignature);
      runtimeRef.current = runtime;
    }
    if (streamBackedInCurrentFrame) {
      runtime.streamBackedSeen = true;
    }
    const streamBacked = streamBackedInCurrentFrame || runtime.streamBackedSeen;
    const rememberedTotal = getTotalElementCount(runtime.latestPayload);
    const incomingTotal = getTotalElementCount(parsed.payload);
    const shouldPlay = shouldUseStreamPlayer(parsed, streamBacked, Math.max(rememberedTotal, incomingTotal));
    if (
      parsed.mode === "render" &&
      runtime.phase === "created" &&
      runtime.finalPayload &&
      runtime.sourceSignature === sourceSignature &&
      status !== "failed" &&
      status !== "missing"
    ) {
      return;
    }

    if (!shouldPlay) {
      cancelScheduled();
      runtime.latestPayload = parsed.payload;
      runtime.finalPayload = parsed.payload;
      runtime.displayPayload = parsed.payload;
      runtime.renderedElementCount = getTotalElementCount(parsed.payload);
      runtime.phase = status === "failed" || status === "missing" ? "failed" : "created";
      runtime.sourceSignature = sourceSignature;
      commit(false);
      return;
    }

    const sameSource = runtime.sourceSignature === sourceSignature;
    const isFinalPayload = Boolean(parsed.a2ui) || (!STREAMING_STATUSES.has(status) && streamBacked);
    const shouldKeepRenderedPayload =
      isFinalPayload &&
      !parsed.a2ui &&
      rememberedTotal > 0 &&
      incomingTotal === 0;
    if (!sameSource) {
      runtime.latestPayload = shouldKeepRenderedPayload
        ? runtime.latestPayload
        : isFinalPayload
        ? parsed.payload
        : mergeStreamingPayload(runtime.latestPayload, parsed.payload);
      if (!shouldKeepRenderedPayload) {
        runtime.sourceSignature = sourceSignature;
      }
    }

    if (runtime.firstChunkTime === null) {
      runtime.firstChunkTime = nowMs();
    }

    if (isFinalPayload) {
      const finalPayload = shouldKeepRenderedPayload ? runtime.latestPayload : parsed.payload;
      runtime.finalPayload = finalPayload;
      runtime.latestPayload = finalPayload;
      runtime.phase = runtime.renderedElementCount >= getTotalElementCount(finalPayload) ? "created" : "waiting_created";
    } else {
      runtime.phase = "previewing";
    }

    if (runtime.finalPayload && runtime.renderedElementCount >= getTotalElementCount(runtime.latestPayload)) {
      scheduleFinalize(true);
    } else {
      updateDisplayPayload();
    }
    commit(true);
    scheduleNext(true);
  }, [
    cancelScheduled,
    commit,
    parsed,
    playerKey,
    scheduleFinalize,
    scheduleNext,
    sourceSignature,
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
    finalPayload: null,
    firstChunkTime: null,
    key,
    latestPayload: payload,
    phase: "idle",
    raf: null,
    renderedElementCount: 0,
    sourceSignature,
    streamBackedSeen: false,
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
  const streamBacked = hasStreamEvidence(parsed);
  const totalElementCount = getTotalElementCount(parsed.payload);
  const shouldPlay = shouldUseStreamPlayer(parsed, streamBacked, totalElementCount);

  if (!shouldPlay) {
    runtime.finalPayload = parsed.payload;
    runtime.renderedElementCount = totalElementCount;
    runtime.phase = status === "failed" || status === "missing" ? "failed" : "created";
    return {
      runtime,
      snapshot: createSnapshot(runtime.displayPayload, runtime.phase, runtime.renderedElementCount, false),
    };
  }

  const isFinalPayload = Boolean(parsed.a2ui) || (!STREAMING_STATUSES.has(status) && streamBacked);
  runtime.streamBackedSeen = streamBacked;
  runtime.finalPayload = isFinalPayload ? parsed.payload : null;
  runtime.phase = isFinalPayload ? "waiting_created" : "previewing";
  runtime.displayPayload = slicePayloadByRenderedCount(parsed.payload, 0);

  return {
    runtime,
    snapshot: createSnapshot(runtime.displayPayload, runtime.phase, 0, true, totalElementCount),
  };
}

function createSnapshot(
  payload: Record<string, unknown>,
  phase: A2UIStreamPlayerPhase,
  renderedElementCount: number,
  enabled: boolean,
  totalElementCount = getPayloadElementCount(payload),
): A2UIStreamPlayerState {
  const visibleElementCount = getPayloadElementCount(payload);
  const rendered = enabled ? Math.min(visibleElementCount, totalElementCount) : totalElementCount;
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

export function buildA2UIStreamPlayerKey(parsed: ParsedA2UIMessage): string {
  const streamIdentity =
    stringIdentity(parsed.a2ui?.stream_id) ||
    stringIdentity(parsed.debug?.streamId) ||
    stringIdentity(parsed.a2ui?.tool_call_id) ||
    stringIdentity(parsed.debug?.toolCallId) ||
    stringIdentity(parsed.interactionId) ||
    traceTurnIdentity(parsed) ||
    "a2ui";
  return [streamIdentity, parsed.renderKey].filter(Boolean).join(":");
}

function traceTurnIdentity(parsed: ParsedA2UIMessage): string {
  const traceId = stringIdentity(parsed.debug?.traceId);
  const turnIndex = stringIdentity(parsed.debug?.turnIndex);
  if (!traceId && !turnIndex) {
    return "";
  }
  return [traceId, turnIndex].filter(Boolean).join(":");
}

function shouldUseStreamPlayer(parsed: ParsedA2UIMessage, streamBacked: boolean, knownElementCount: number): boolean {
  if (!streamBacked || prefersReducedMotion()) {
    return false;
  }
  const status = normalizeStatus(parsed.status);
  return !DISABLED_STATUSES.has(status) && knownElementCount > 0;
}

function hasStreamEvidence(parsed: ParsedA2UIMessage): boolean {
  if (parsed.historyHydrated) {
    return false;
  }
  return Number(parsed.debug?.chunkCount ?? 0) > 0 || Boolean(parsed.streamText);
}

function calculateInterval(runtime: PlayerRuntime): number {
  const total = getTotalElementCount(runtime.latestPayload);
  const remaining = total - runtime.renderedElementCount;
  if (remaining <= 0) {
    return 0;
  }
  const elapsed = runtime.firstChunkTime === null ? 0 : nowMs() - runtime.firstChunkTime;
  if (runtime.finalPayload) {
    const visibleInterval = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, MIN_RENDER_DURATION_MS / remaining));
    if (elapsed < FAST_STREAM_THRESHOLD_MS || total <= SMALL_PAYLOAD_SLOW_REVEAL_THRESHOLD) {
      return visibleInterval;
    }
    return CATCH_UP_INTERVAL_MS;
  }
  const targetTotal = Math.max(900, Math.min(2600, total * 110));
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, targetTotal / Math.max(1, total)));
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
  if (!arePayloadsEquivalent(runtime.displayPayload, runtime.finalPayload)) {
    runtime.displayPayload = runtime.finalPayload;
  }
  runtime.phase = "created";
}

function arePayloadsEquivalent(current: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return current === next || safeJsonStringify(current) === safeJsonStringify(next);
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
