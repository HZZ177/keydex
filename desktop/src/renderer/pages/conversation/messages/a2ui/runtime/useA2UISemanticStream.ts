import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ParsedA2UIMessage } from "../A2UIBlock";
import type { A2UIStreamPlayerRootProps } from "../useA2UIStreamPlayer";

export interface A2UISemanticUnit {
  key: string;
  order: number;
  payload: Record<string, unknown>;
  signature: string;
}

export interface A2UISemanticSnapshot {
  meta: Record<string, unknown>;
  units: A2UISemanticUnit[];
}

export interface A2UISemanticAdapter {
  renderKey: string;
  unitKind: string;
  extract(payload: Record<string, unknown>, parsed: ParsedA2UIMessage): A2UISemanticSnapshot;
  build(snapshot: A2UISemanticSnapshot, visibleUnits: A2UISemanticUnit[]): Record<string, unknown>;
}

export interface A2UISemanticStreamState {
  enabled: boolean;
  phase: "idle" | "previewing" | "waiting_created" | "created" | "failed";
  payload: Record<string, unknown>;
  rootProps: A2UIStreamPlayerRootProps;
  running: boolean;
  totalUnitCount: number;
  visibleUnitCount: number;
}

export interface A2UISemanticStreamOptions {
  scopeKey?: string;
  initialVisibleUnits?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  smallPayloadMaxIntervalMs?: number;
  smallPayloadThreshold?: number;
  drainTargetMs?: number;
  maxUnitsPerTick?: number;
}

interface ResolvedA2UISemanticStreamOptions {
  initialVisibleUnits: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  smallPayloadMaxIntervalMs: number;
  smallPayloadThreshold: number;
  drainTargetMs: number;
  maxUnitsPerTick: number;
}

interface RuntimeState {
  displayPayload: Record<string, unknown>;
  firstChunkTime: number | null;
  inputRevision: string;
  key: string;
  phase: A2UISemanticStreamState["phase"];
  playbackStarted: boolean;
  snapshot: A2UISemanticSnapshot;
  sourceSignature: string;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
  visibleKeys: string[];
}

interface SemanticInputFrame {
  incomingSignature: string;
  incomingSnapshot: A2UISemanticSnapshot;
  inputRevision: string;
  parsed: ParsedA2UIMessage;
  streamKey: string;
}

const DEFAULT_INITIAL_VISIBLE_UNITS = 1;
const DEFAULT_MIN_INTERVAL_MS = 220;
const DEFAULT_MAX_INTERVAL_MS = 380;
const DEFAULT_SMALL_PAYLOAD_MAX_INTERVAL_MS = 520;
const DEFAULT_SMALL_PAYLOAD_THRESHOLD = 8;
const DEFAULT_DRAIN_TARGET_MS = 2_000;
const DEFAULT_MAX_UNITS_PER_TICK = 4;
const STREAMING_STATUSES = new Set(["started", "streaming", "finished"]);
const TERMINAL_STATUSES = new Set(["submitted", "cancelled", "failed", "missing"]);
const settledSemanticStreamKeys = new Set<string>();

export function resetA2UISemanticStreamPlaybackForTests(): void {
  settledSemanticStreamKeys.clear();
}

export function useA2UISemanticStream(
  parsed: ParsedA2UIMessage,
  adapter: A2UISemanticAdapter,
  options: A2UISemanticStreamOptions = {},
): A2UISemanticStreamState {
  const playbackOptions = useMemo(
    () => ({
      drainTargetMs: options.drainTargetMs ?? DEFAULT_DRAIN_TARGET_MS,
      initialVisibleUnits: options.initialVisibleUnits ?? DEFAULT_INITIAL_VISIBLE_UNITS,
      maxIntervalMs: options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS,
      maxUnitsPerTick: options.maxUnitsPerTick ?? DEFAULT_MAX_UNITS_PER_TICK,
      minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      smallPayloadMaxIntervalMs: options.smallPayloadMaxIntervalMs ?? DEFAULT_SMALL_PAYLOAD_MAX_INTERVAL_MS,
      smallPayloadThreshold: options.smallPayloadThreshold ?? DEFAULT_SMALL_PAYLOAD_THRESHOLD,
    }),
    [
      options.drainTargetMs,
      options.initialVisibleUnits,
      options.maxIntervalMs,
      options.maxUnitsPerTick,
      options.minIntervalMs,
      options.smallPayloadMaxIntervalMs,
      options.smallPayloadThreshold,
    ],
  );
  const streamKey = useMemo(
    () => buildSemanticStreamKey(parsed, adapter, options.scopeKey),
    [adapter, options.scopeKey, parsed],
  );
  const incomingSnapshot = useMemo(() => adapter.extract(parsed.payload, parsed), [adapter, parsed]);
  const incomingSignature = useMemo(() => safeJsonStringify(incomingSnapshot), [incomingSnapshot]);
  const inputRevision = buildSemanticInputRevision(parsed, streamKey, incomingSignature);
  const inputFrameRef = useRef<SemanticInputFrame>({
    incomingSignature,
    incomingSnapshot,
    inputRevision,
    parsed,
    streamKey,
  });
  inputFrameRef.current = { incomingSignature, incomingSnapshot, inputRevision, parsed, streamKey };
  const [version, setVersion] = useState(0);
  const runtimeRef = useRef<RuntimeState>(
    createRuntimeState(
      streamKey,
      incomingSnapshot,
      incomingSignature,
      parsed,
      playbackOptions.initialVisibleUnits,
      adapter,
    ),
  );

  const cancelScheduled = useCallback(() => {
    const runtime = runtimeRef.current;
    if (runtime.timer !== null) {
      globalThis.clearTimeout(runtime.timer);
      runtime.timer = null;
    }
  }, []);

  const commit = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  const scheduleNext = useCallback(() => {
    const runtime = runtimeRef.current;
    if (runtime.timer !== null || runtime.phase === "created" || runtime.phase === "failed") {
      return;
    }
    if (prefersReducedMotion()) {
      const nextVisibleKeys = runtime.snapshot.units.map((unit) => unit.key);
      const visibleChanged = replaceVisibleKeys(runtime, nextVisibleKeys);
      const phaseChanged = settleSemanticRuntime(runtime);
      if (visibleChanged || phaseChanged) {
        refreshSemanticDisplayPayload(runtime, adapter);
        commit();
      }
      return;
    }

    const remaining = runtime.snapshot.units.length - runtime.visibleKeys.length;
    if (remaining <= 0) {
      if (runtime.phase === "waiting_created" && settleSemanticRuntime(runtime)) {
        commit();
      }
      return;
    }

    const interval = calculateSemanticInterval(runtime, playbackOptions);
    const step = calculateSemanticStep(runtime, interval, playbackOptions);
    runtime.timer = globalThis.setTimeout(() => {
      runtime.timer = null;
      const revealed = revealNextUnits(runtime, step);
      let changed = revealed;
      if (runtime.visibleKeys.length >= runtime.snapshot.units.length && runtime.phase === "waiting_created") {
        changed = settleSemanticRuntime(runtime) || changed;
      }
      if (revealed) {
        refreshSemanticDisplayPayload(runtime, adapter);
      }
      if (changed) {
        commit();
      }
      scheduleNext();
    }, interval);
  }, [adapter, commit, playbackOptions]);

  useEffect(() => {
    const frame = inputFrameRef.current;
    const currentParsed = frame.parsed;
    const status = normalizeStatus(currentParsed.status);
    const terminal = currentParsed.historyHydrated || TERMINAL_STATUSES.has(status);
    let runtime = runtimeRef.current;
    let changed = false;

    if (runtime.key !== frame.streamKey) {
      cancelScheduled();
      runtime = createRuntimeState(
        frame.streamKey,
        frame.incomingSnapshot,
        frame.incomingSignature,
        currentParsed,
        playbackOptions.initialVisibleUnits,
        adapter,
      );
      runtimeRef.current = runtime;
      changed = true;
    }
    if (runtime.inputRevision === frame.inputRevision) {
      return;
    }
    runtime.inputRevision = frame.inputRevision;

    const liveFrame = isSemanticLiveFrame(currentParsed);
    const replayableCreatedFrame = isReplayableSemanticCreatedFrame(currentParsed);
    if (!settledSemanticStreamKeys.has(frame.streamKey) && (liveFrame || replayableCreatedFrame)) {
      if (!runtime.playbackStarted) {
        runtime.playbackStarted = true;
        changed = true;
      }
    }

    const previousTotal = runtime.snapshot.units.length;
    const shouldPlay =
      !terminal &&
      !prefersReducedMotion() &&
      runtime.playbackStarted &&
      Math.max(previousTotal, frame.incomingSnapshot.units.length) > 0;

    if (runtime.sourceSignature !== frame.incomingSignature) {
      const mergedSnapshot = mergeSemanticSnapshots(runtime.snapshot, frame.incomingSnapshot);
      if (mergedSnapshot !== runtime.snapshot) {
        runtime.snapshot = mergedSnapshot;
        changed = true;
      }
      runtime.sourceSignature = frame.incomingSignature;
    }

    if (!shouldPlay) {
      cancelScheduled();
      changed = replaceVisibleKeys(runtime, runtime.snapshot.units.map((unit) => unit.key)) || changed;
      changed = setRuntimePhase(runtime, status === "failed" || status === "missing" ? "failed" : "created") || changed;
      if (runtime.playbackStarted) {
        settledSemanticStreamKeys.add(runtime.key);
      }
      if (refreshSemanticDisplayPayload(runtime, adapter)) {
        changed = true;
      }
      if (changed) {
        commit();
      }
      return;
    }

    if (runtime.firstChunkTime === null) {
      runtime.firstChunkTime = nowMs();
    }

    if (!runtime.visibleKeys.length && runtime.snapshot.units.length) {
      const initialVisibleKeys = runtime.snapshot.units
        .slice(0, Math.max(0, playbackOptions.initialVisibleUnits))
        .map((unit) => unit.key);
      changed = replaceVisibleKeys(runtime, initialVisibleKeys) || changed;
    }

    const finalPayload = Boolean(currentParsed.a2ui) || (!STREAMING_STATUSES.has(status) && runtime.playbackStarted);
    if (finalPayload && runtime.visibleKeys.length >= runtime.snapshot.units.length) {
      changed = settleSemanticRuntime(runtime) || changed;
    } else {
      changed = setRuntimePhase(runtime, finalPayload ? "waiting_created" : "previewing") || changed;
    }
    if (refreshSemanticDisplayPayload(runtime, adapter)) {
      changed = true;
    }
    if (changed) {
      commit();
    }
    scheduleNext();
  }, [
    adapter,
    cancelScheduled,
    commit,
    inputRevision,
    playbackOptions.initialVisibleUnits,
    scheduleNext,
  ]);

  useEffect(() => () => cancelScheduled(), [cancelScheduled]);

  return useMemo(() => {
    void version;
    const runtime = runtimeRef.current;
    const visibleUnits = visibleSemanticUnits(runtime.snapshot.units, runtime.visibleKeys);
    const total = runtime.snapshot.units.length;
    const visible = visibleUnits.length;
    const enabled = runtime.playbackStarted && !parsed.historyHydrated && runtime.phase !== "failed";
    const running = enabled && (runtime.phase === "previewing" || runtime.phase === "waiting_created") && visible < total;
    return {
      enabled,
      phase: runtime.phase,
      payload: runtime.displayPayload,
      rootProps: semanticRootProps(enabled, runtime.phase, visible, total, running),
      running,
      totalUnitCount: total,
      visibleUnitCount: visible,
    };
  }, [adapter, parsed.historyHydrated, version]);
}

function createRuntimeState(
  key: string,
  snapshot: A2UISemanticSnapshot,
  signature: string,
  parsed: ParsedA2UIMessage,
  initialVisibleUnits: number,
  adapter: A2UISemanticAdapter,
): RuntimeState {
  const playbackStarted = !settledSemanticStreamKeys.has(key)
    && (isSemanticLiveFrame(parsed) || isReplayableSemanticCreatedFrame(parsed));
  const visibleKeys = playbackStarted && !parsed.historyHydrated
    ? snapshot.units.slice(0, initialVisibleUnits).map((unit) => unit.key)
    : snapshot.units.map((unit) => unit.key);
  const runtime: RuntimeState = {
    displayPayload: {},
    firstChunkTime: null,
    inputRevision: "",
    key,
    phase: playbackStarted ? "previewing" : "created",
    playbackStarted,
    snapshot,
    sourceSignature: signature,
    timer: null,
    visibleKeys,
  };
  runtime.displayPayload = adapter.build(snapshot, visibleSemanticUnits(snapshot.units, visibleKeys));
  return runtime;
}

function mergeSemanticSnapshots(
  previous: A2UISemanticSnapshot,
  incoming: A2UISemanticSnapshot,
): A2UISemanticSnapshot {
  const byKey = new Map(previous.units.map((unit) => [unit.key, unit]));
  const previousKeys = new Set(previous.units.map((unit) => unit.key));
  const orderedKeys = previous.units.map((unit) => unit.key);
  for (const unit of incoming.units) {
    const previousUnit = byKey.get(unit.key);
    byKey.set(unit.key, previousUnit && previousUnit.signature === unit.signature ? previousUnit : unit);
    if (!previousKeys.has(unit.key)) {
      orderedKeys.push(unit.key);
    }
  }
  const seen = new Set<string>();
  const units: A2UISemanticUnit[] = [];
  for (const key of orderedKeys) {
    if (seen.has(key)) {
      continue;
    }
    const unit = byKey.get(key);
    if (unit) {
      units.push(unit);
      seen.add(key);
    }
  }
  const meta = {
    ...previous.meta,
    ...incoming.meta,
  };
  const sameUnits = units.length === previous.units.length
    && units.every((unit, index) => unit === previous.units[index]);
  const sameMeta = safeJsonStringify(meta) === safeJsonStringify(previous.meta);
  return sameUnits && sameMeta ? previous : { meta, units };
}

function revealNextUnits(runtime: RuntimeState, step: number): boolean {
  const visible = new Set(runtime.visibleKeys);
  let added = 0;
  for (const unit of runtime.snapshot.units) {
    if (visible.has(unit.key)) {
      continue;
    }
    runtime.visibleKeys.push(unit.key);
    visible.add(unit.key);
    added += 1;
    if (runtime.visibleKeys.length >= runtime.snapshot.units.length || added >= step) {
      break;
    }
  }
  return added > 0;
}

function replaceVisibleKeys(runtime: RuntimeState, next: string[]): boolean {
  if (runtime.visibleKeys.length === next.length && runtime.visibleKeys.every((key, index) => key === next[index])) {
    return false;
  }
  runtime.visibleKeys = next;
  return true;
}

function setRuntimePhase(runtime: RuntimeState, phase: RuntimeState["phase"]): boolean {
  if (runtime.phase === phase) {
    return false;
  }
  runtime.phase = phase;
  return true;
}

function settleSemanticRuntime(runtime: RuntimeState): boolean {
  settledSemanticStreamKeys.add(runtime.key);
  return setRuntimePhase(runtime, "created");
}

function refreshSemanticDisplayPayload(runtime: RuntimeState, adapter: A2UISemanticAdapter): boolean {
  const visibleUnits = visibleSemanticUnits(runtime.snapshot.units, runtime.visibleKeys);
  const nextPayload = adapter.build(runtime.snapshot, visibleUnits);
  if (safeJsonStringify(runtime.displayPayload) === safeJsonStringify(nextPayload)) {
    return false;
  }
  runtime.displayPayload = nextPayload;
  return true;
}

function visibleSemanticUnits(units: A2UISemanticUnit[], visibleKeys: string[]): A2UISemanticUnit[] {
  const visible = new Set(visibleKeys);
  return units.filter((unit) => visible.has(unit.key));
}

function calculateSemanticInterval(
  runtime: RuntimeState,
  options: ResolvedA2UISemanticStreamOptions,
): number {
  const total = runtime.snapshot.units.length;
  const remaining = total - runtime.visibleKeys.length;
  if (remaining <= 0) {
    return 0;
  }
  const maxInterval = total <= options.smallPayloadThreshold ? options.smallPayloadMaxIntervalMs : options.maxIntervalMs;
  const targetDuration = total <= options.smallPayloadThreshold
    ? Math.max(1_600, total * 320)
    : Math.max(1_600, Math.min(2_600, total * 160));
  return Math.max(options.minIntervalMs, Math.min(maxInterval, targetDuration / Math.max(1, remaining)));
}

function calculateSemanticStep(
  runtime: RuntimeState,
  intervalMs: number,
  options: ResolvedA2UISemanticStreamOptions,
): number {
  const total = runtime.snapshot.units.length;
  const remaining = total - runtime.visibleKeys.length;
  if (remaining <= 0 || total <= options.smallPayloadThreshold) {
    return 1;
  }
  const targetTicks = Math.max(1, Math.ceil(options.drainTargetMs / Math.max(1, intervalMs)));
  return Math.max(1, Math.min(options.maxUnitsPerTick, Math.ceil(remaining / targetTicks), remaining));
}

function semanticRootProps(
  enabled: boolean,
  phase: A2UISemanticStreamState["phase"],
  visible: number,
  total: number,
  running: boolean,
): A2UIStreamPlayerRootProps {
  const backlog = enabled ? Math.max(0, total - visible) : 0;
  return {
    "data-a2ui-player-enabled": enabled ? "true" : "false",
    "data-a2ui-player-phase": phase,
    "data-a2ui-player-rendered": visible,
    "data-a2ui-player-total": total,
    "data-a2ui-player-running": running ? "true" : "false",
    "data-a2ui-reveal-enabled": enabled ? "true" : "false",
    "data-a2ui-reveal-total": total,
    "data-a2ui-reveal-visible": visible,
    "data-a2ui-reveal-backlog": backlog,
    "data-a2ui-reveal-speed": running ? 4 : 0,
    "data-a2ui-reveal-running": running ? "true" : "false",
  };
}

function isSemanticLiveFrame(parsed: ParsedA2UIMessage): boolean {
  if (parsed.historyHydrated) {
    return false;
  }
  const status = normalizeStatus(parsed.status);
  return STREAMING_STATUSES.has(status) || isInteractiveWaitingFrameWithStreamEvidence(parsed);
}

function isReplayableSemanticCreatedFrame(parsed: ParsedA2UIMessage): boolean {
  return !parsed.historyHydrated &&
    Boolean(parsed.a2ui) &&
    normalizeStatus(parsed.status) === "created" &&
    hasRawStreamLifecycleEvidence(parsed);
}

function isInteractiveWaitingFrameWithStreamEvidence(parsed: ParsedA2UIMessage): boolean {
  return (
    Boolean(parsed.a2ui) &&
    parsed.mode === "interactive" &&
    normalizeStatus(parsed.status) === "waiting_input" &&
    (positiveInteger(parsed.debug?.chunkCount) > 0 || parsed.streamText.length > 0 || hasRawStreamLifecycleEvidence(parsed))
  );
}

function hasRawStreamLifecycleEvidence(parsed: ParsedA2UIMessage): boolean {
  return Boolean(
    parsed.debug?.rawEvents?.some((event) => {
      const action = typeof event.action === "string" ? event.action : "";
      return action === "a2ui_stream_start" ||
        action === "a2ui_stream_chunk" ||
        action === "a2ui_stream_finish" ||
        action === "a2ui.stream.start" ||
        action === "a2ui.stream.chunk" ||
        action === "a2ui.stream.finish" ||
        action === "a2ui_created" ||
        action === "a2ui.created";
    }),
  );
}

function buildSemanticStreamKey(
  parsed: ParsedA2UIMessage,
  adapter: A2UISemanticAdapter,
  scopeKey = "",
): string {
  const scopedIdentity = stringIdentity(scopeKey);
  const identity =
    scopedIdentity ||
    stringIdentity(parsed.a2ui?.stream_id) ||
    stringIdentity(parsed.debug?.streamId) ||
    stringIdentity(parsed.debug?.streamGroupId) ||
    stringIdentity(parsed.a2ui?.tool_call_id) ||
    stringIdentity(parsed.debug?.toolCallId) ||
    stringIdentity(parsed.interactionId) ||
    traceTurnIdentity(parsed) ||
    adapter.renderKey;
  return [identity, adapter.renderKey].filter(Boolean).join(":");
}

export function buildSemanticInputRevision(
  parsed: ParsedA2UIMessage,
  streamKey: string,
  incomingSignature: string,
): string {
  const rawEvents = parsed.debug?.rawEvents ?? [];
  const lastEvent = rawEvents.at(-1);
  return [
    streamKey,
    incomingSignature,
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

function traceTurnIdentity(parsed: ParsedA2UIMessage): string {
  const traceId = stringIdentity(parsed.debug?.traceId);
  const turnIndex = stringIdentity(parsed.debug?.turnIndex);
  return [traceId, turnIndex].filter(Boolean).join(":");
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
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
