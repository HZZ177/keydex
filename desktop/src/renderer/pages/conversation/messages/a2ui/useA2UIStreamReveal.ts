import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type DynamicStreamStepOptions,
} from "@/renderer/hooks/useDynamicStreamBuffer";

import type { ParsedA2UIMessage } from "./A2UIBlock";

export interface A2UIRevealUnit {
  key: string;
  kind?: string;
  signature?: unknown;
}

export type A2UIStreamUnitPhase = "hidden" | "enter" | "update" | "stable";

export interface A2UIStreamUnitState {
  key: string;
  kind?: string;
  visible: boolean;
  phase: A2UIStreamUnitPhase;
  revision: number;
  signature: string;
}

export interface A2UIStreamRevealOptions {
  parsed: ParsedA2UIMessage;
  units: A2UIRevealUnit[];
  resetKey?: string;
  enabled?: boolean;
  initialVisibleUnits?: number;
  maxUnitsPerFrame?: number;
  stepOptions?: DynamicStreamStepOptions;
}

export interface A2UIStreamRevealRootProps {
  "data-a2ui-reveal-enabled": string;
  "data-a2ui-reveal-total": number;
  "data-a2ui-reveal-visible": number;
  "data-a2ui-reveal-backlog": number;
  "data-a2ui-reveal-speed": number;
  "data-a2ui-reveal-running": string;
}

export interface A2UIStreamRevealState {
  enabled: boolean;
  totalUnits: number;
  visibleUnits: number;
  backlogUnits: number;
  speedUnitsPerSecond: number;
  isRevealing: boolean;
  visibleKeys: Set<string>;
  unitStates: Map<string, A2UIStreamUnitState>;
  isVisible: (key: string) => boolean;
  unitState: (key: string) => A2UIStreamUnitState | null;
  itemProps: (key: string) => Record<string, string | number | undefined>;
  rootProps: A2UIStreamRevealRootProps;
}

export const A2UI_REVEAL_STEP_OPTIONS: Required<DynamicStreamStepOptions> = {
  minCharsPerSecond: 4,
  maxCharsPerSecond: 10,
  comfortableBacklog: 12,
  drainTargetSeconds: 3.2,
};
const DEFAULT_A2UI_REVEAL_MAX_UNITS_PER_FRAME = 1;
const A2UI_PLAYER_ENTER_PHASE_MS = 560;
const A2UI_PLAYER_UPDATE_PHASE_MS = 520;

export function useA2UIStreamReveal({
  parsed,
  units,
  resetKey,
  enabled = true,
  initialVisibleUnits = 1,
  maxUnitsPerFrame = DEFAULT_A2UI_REVEAL_MAX_UNITS_PER_FRAME,
  stepOptions,
}: A2UIStreamRevealOptions): A2UIStreamRevealState {
  const unitFingerprint = buildUnitFingerprint(units);
  const unitKeys = useMemo(() => units.map((unit) => unit.key), [unitFingerprint]);
  const unitSignatureByKey = useMemo(() => {
    const signatures = new Map<string, string>();
    for (const unit of units) {
      signatures.set(unit.key, normalizeUnitSignature(unit.signature));
    }
    return signatures;
  }, [unitFingerprint]);
  const unitKindByKey = useMemo(() => {
    const kinds = new Map<string, string | undefined>();
    for (const unit of units) {
      kinds.set(unit.key, unit.kind);
    }
    return kinds;
  }, [unitFingerprint]);
  const totalUnits = unitKeys.length;
  const revealKey = resetKey || buildA2UIRevealResetKey(parsed);
  const shouldReveal = shouldUseA2UIStreamReveal(parsed, enabled, totalUnits);
  const initialVisible = shouldReveal ? Math.min(totalUnits, Math.max(0, initialVisibleUnits)) : totalUnits;
  const [visibleKeysSnapshot, setVisibleKeysSnapshot] = useState<Set<string>>(
    () => new Set(unitKeys.slice(0, initialVisible)),
  );
  const [speedUnitsPerSecond, setSpeedUnitsPerSecond] = useState(0);
  const [isRevealing, setIsRevealing] = useState(false);
  const visibleKeysRef = useRef<Set<string>>(new Set(unitKeys.slice(0, initialVisible)));
  const targetKeysRef = useRef<string[]>(unitKeys);
  const unitSignatureByKeyRef = useRef<Map<string, string>>(unitSignatureByKey);
  const unitPhaseByKeyRef = useRef<Map<string, { phase: A2UIStreamUnitPhase; revision: number }>>(new Map());
  const keyRef = useRef(revealKey);
  const timerRef = useRef<number | null>(null);
  const phaseTimerByKeyRef = useRef<Map<string, number>>(new Map());
  const stepOptionsRef = useRef(resolveStepOptions(stepOptions));
  const maxUnitsPerFrameRef = useRef(normalizeMaxUnitsPerFrame(maxUnitsPerFrame));
  const speedRef = useRef(0);
  const [phaseVersion, setPhaseVersion] = useState(0);

  useEffect(() => {
    stepOptionsRef.current = resolveStepOptions(stepOptions);
  }, [
    stepOptions?.comfortableBacklog,
    stepOptions?.drainTargetSeconds,
    stepOptions?.maxCharsPerSecond,
    stepOptions?.minCharsPerSecond,
  ]);

  useEffect(() => {
    maxUnitsPerFrameRef.current = normalizeMaxUnitsPerFrame(maxUnitsPerFrame);
  }, [maxUnitsPerFrame]);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearPhaseTimer = useCallback((key: string) => {
    const timer = phaseTimerByKeyRef.current.get(key);
    if (timer !== undefined && typeof window !== "undefined") {
      window.clearTimeout(timer);
    }
    phaseTimerByKeyRef.current.delete(key);
  }, []);

  const clearAllPhaseTimers = useCallback(() => {
    if (typeof window !== "undefined") {
      for (const timer of phaseTimerByKeyRef.current.values()) {
        window.clearTimeout(timer);
      }
    }
    phaseTimerByKeyRef.current.clear();
  }, []);

  const commitVisibleKeys = useCallback((nextVisibleKeys: Set<string>) => {
    const targetKeySet = new Set(targetKeysRef.current);
    const normalized = new Set<string>();
    for (const key of nextVisibleKeys) {
      if (targetKeySet.has(key)) {
        normalized.add(key);
      }
    }
    if (areStringSetsEqual(visibleKeysRef.current, normalized)) {
      return;
    }
    visibleKeysRef.current = normalized;
    setVisibleKeysSnapshot(new Set(normalized));
  }, []);

  const commitSpeed = useCallback((nextSpeed: number) => {
    const normalized = Math.max(0, Math.round(nextSpeed));
    if (speedRef.current === normalized) {
      return;
    }
    speedRef.current = normalized;
    setSpeedUnitsPerSecond(normalized);
  }, []);

  const setUnitPhase = useCallback((key: string, phase: A2UIStreamUnitPhase) => {
    clearPhaseTimer(key);
    const current = unitPhaseByKeyRef.current.get(key);
    const revision = (current?.revision ?? 0) + 1;
    unitPhaseByKeyRef.current.set(key, { phase, revision });
    setPhaseVersion((value) => value + 1);

    if ((phase !== "enter" && phase !== "update") || typeof window === "undefined") {
      return;
    }
    const duration = phase === "enter" ? A2UI_PLAYER_ENTER_PHASE_MS : A2UI_PLAYER_UPDATE_PHASE_MS;
    const timer = window.setTimeout(() => {
      phaseTimerByKeyRef.current.delete(key);
      const latest = unitPhaseByKeyRef.current.get(key);
      if (!latest || latest.revision !== revision || latest.phase !== phase) {
        return;
      }
      unitPhaseByKeyRef.current.set(key, { phase: "stable", revision });
      setPhaseVersion((value) => value + 1);
    }, duration);
    phaseTimerByKeyRef.current.set(key, timer);
  }, [clearPhaseTimer]);

  const resetPlayerState = useCallback((nextKeys: string[], nextInitialVisible: number, revealActive: boolean) => {
    cancelTimer();
    clearAllPhaseTimers();
    const visibleKeys = new Set(revealActive ? nextKeys.slice(0, nextInitialVisible) : nextKeys);
    visibleKeysRef.current = visibleKeys;
    setVisibleKeysSnapshot(new Set(visibleKeys));
    unitPhaseByKeyRef.current = new Map(
      Array.from(visibleKeys, (key) => [key, { phase: revealActive ? "enter" : "stable", revision: 0 }]),
    );
    setPhaseVersion((value) => value + 1);
    speedRef.current = 0;
    setSpeedUnitsPerSecond(0);
    setIsRevealing(false);
  }, [cancelTimer, clearAllPhaseTimers]);

  useEffect(() => {
    targetKeysRef.current = unitKeys;
    if (keyRef.current !== revealKey) {
      keyRef.current = revealKey;
      unitSignatureByKeyRef.current = unitSignatureByKey;
      resetPlayerState(unitKeys, initialVisible, shouldReveal);
      return;
    }

    if (!shouldReveal) {
      unitSignatureByKeyRef.current = unitSignatureByKey;
      resetPlayerState(unitKeys, totalUnits, false);
      return;
    }

    const targetKeySet = new Set(unitKeys);
    const nextVisibleKeys = new Set<string>();
    for (const key of visibleKeysRef.current) {
      if (targetKeySet.has(key)) {
        nextVisibleKeys.add(key);
      }
    }
    for (const key of unitKeys) {
      if (nextVisibleKeys.size >= initialVisible) {
        break;
      }
      nextVisibleKeys.add(key);
    }
    commitVisibleKeys(nextVisibleKeys);

    const previousSignatures = unitSignatureByKeyRef.current;
    for (const key of unitKeys) {
      const previousSignature = previousSignatures.get(key);
      const nextSignature = unitSignatureByKey.get(key) ?? "";
      if (
        previousSignature !== undefined &&
        previousSignature !== nextSignature &&
        visibleKeysRef.current.has(key)
      ) {
        setUnitPhase(key, "update");
      }
    }
    unitSignatureByKeyRef.current = unitSignatureByKey;
  }, [
    commitVisibleKeys,
    initialVisible,
    revealKey,
    resetPlayerState,
    setUnitPhase,
    shouldReveal,
    totalUnits,
    unitFingerprint,
    unitKeys,
    unitSignatureByKey,
  ]);

  useEffect(() => {
    if (!shouldReveal || typeof window === "undefined") {
      return;
    }

    if (countHiddenTargetUnits(targetKeysRef.current, visibleKeysRef.current) <= 0) {
      commitSpeed(0);
      setIsRevealing(false);
      return;
    }

    let disposed = false;
    setIsRevealing(true);

    const scheduleNext = () => {
      const backlog = countHiddenTargetUnits(targetKeysRef.current, visibleKeysRef.current);
      if (backlog <= 0) {
        timerRef.current = null;
        commitSpeed(0);
        setIsRevealing(false);
        return;
      }
      const step = calculateA2UIRevealStep(
        backlog,
        stepOptionsRef.current,
        maxUnitsPerFrameRef.current,
      );
      commitSpeed(step.unitsPerSecond);
      timerRef.current = window.setTimeout(tick, step.intervalMs);
    };

    const tick = () => {
      timerRef.current = null;
      if (disposed || keyRef.current !== revealKey) {
        return;
      }

      const hiddenKeys = hiddenTargetKeys(targetKeysRef.current, visibleKeysRef.current);
      const backlog = hiddenKeys.length;
      if (backlog <= 0) {
        commitSpeed(0);
        setIsRevealing(false);
        return;
      }

      const step = calculateA2UIRevealStep(
        backlog,
        stepOptionsRef.current,
        maxUnitsPerFrameRef.current,
      );
      commitSpeed(step.unitsPerSecond);
      const nextVisibleKeys = new Set(visibleKeysRef.current);
      const enteringKeys = hiddenKeys.slice(0, step.units);
      for (const key of enteringKeys) {
        nextVisibleKeys.add(key);
      }
      commitVisibleKeys(nextVisibleKeys);
      for (const key of enteringKeys) {
        setUnitPhase(key, "enter");
      }

      if (countHiddenTargetUnits(targetKeysRef.current, visibleKeysRef.current) > 0) {
        scheduleNext();
        return;
      }

      commitSpeed(0);
      setIsRevealing(false);
    };

    if (timerRef.current === null) {
      scheduleNext();
    }

    return () => {
      disposed = true;
      cancelTimer();
    };
  }, [cancelTimer, commitSpeed, commitVisibleKeys, revealKey, setUnitPhase, shouldReveal, unitFingerprint]);

  useEffect(() => {
    return () => {
      cancelTimer();
      clearAllPhaseTimers();
    };
  }, [cancelTimer, clearAllPhaseTimers]);

  const visibleCount = shouldReveal
    ? unitKeys.filter((key) => visibleKeysSnapshot.has(key)).length
    : totalUnits;
  const visibleKeys = useMemo(
    () => shouldReveal
      ? new Set(unitKeys.filter((key) => visibleKeysSnapshot.has(key)))
      : new Set(unitKeys),
    [shouldReveal, unitKeys, visibleKeysSnapshot],
  );
  const isVisible = useCallback((key: string) => visibleKeys.has(key), [visibleKeys]);
  const backlogUnits = shouldReveal ? countHiddenTargetUnits(unitKeys, visibleKeys) : 0;
  const unitStates = useMemo(() => {
    const states = new Map<string, A2UIStreamUnitState>();
    for (const key of unitKeys) {
      const visible = visibleKeys.has(key);
      const phaseInfo = unitPhaseByKeyRef.current.get(key);
      states.set(key, {
        key,
        kind: unitKindByKey.get(key),
        visible,
        phase: visible ? phaseInfo?.phase ?? "stable" : "hidden",
        revision: phaseInfo?.revision ?? 0,
        signature: unitSignatureByKey.get(key) ?? "",
      });
    }
    return states;
  }, [phaseVersion, unitFingerprint, unitKeys, unitKindByKey, unitSignatureByKey, visibleKeys]);
  const unitState = useCallback((key: string) => unitStates.get(key) ?? null, [unitStates]);
  const itemProps = useCallback(
    (key: string) => {
      const state = unitStates.get(key);
      return {
        "data-a2ui-player-phase": state?.phase ?? "hidden",
        "data-a2ui-player-revision": state?.revision ?? 0,
        "data-a2ui-player-visible": state?.visible ? "true" : "false",
      };
    },
    [unitStates],
  );

  return {
    enabled: shouldReveal,
    totalUnits,
    visibleUnits: visibleCount,
    backlogUnits,
    speedUnitsPerSecond: shouldReveal ? Math.round(speedUnitsPerSecond) : 0,
    isRevealing: shouldReveal && (isRevealing || backlogUnits > 0),
    visibleKeys,
    unitStates,
    isVisible,
    unitState,
    itemProps,
    rootProps: {
      "data-a2ui-reveal-enabled": shouldReveal ? "true" : "false",
      "data-a2ui-reveal-total": totalUnits,
      "data-a2ui-reveal-visible": visibleCount,
      "data-a2ui-reveal-backlog": backlogUnits,
      "data-a2ui-reveal-speed": shouldReveal ? Math.round(speedUnitsPerSecond) : 0,
      "data-a2ui-reveal-running": shouldReveal && (isRevealing || backlogUnits > 0) ? "true" : "false",
    },
  };
}

export function buildA2UIRevealResetKey(parsed: ParsedA2UIMessage): string {
  const streamIdentity =
    stringIdentity(parsed.a2ui?.stream_id) ||
    stringIdentity(parsed.debug?.streamId) ||
    "a2ui-missing-stream-id";
  return [
    streamIdentity,
    parsed.renderKey,
  ]
    .filter(Boolean)
    .join(":");
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

function shouldUseA2UIStreamReveal(
  parsed: ParsedA2UIMessage,
  enabled: boolean,
  totalUnits: number,
): boolean {
  if (!enabled || totalUnits <= 1 || prefersReducedMotion()) {
    return false;
  }
  const status = parsed.status.toLowerCase();
  if (status === "submitted" || status === "cancelled" || status === "failed" || status === "missing") {
    return false;
  }
  return Number(parsed.debug?.chunkCount ?? 0) > 0 || Boolean(parsed.streamText);
}

function resolveStepOptions(options?: DynamicStreamStepOptions): Required<DynamicStreamStepOptions> {
  return {
    ...A2UI_REVEAL_STEP_OPTIONS,
    ...options,
  };
}

function calculateA2UIRevealStep(
  backlog: number,
  options: Required<DynamicStreamStepOptions>,
  maxUnitsPerTick: number,
): { intervalMs: number; units: number; unitsPerSecond: number } {
  const minUnitsPerSecond = positiveNumber(options.minCharsPerSecond, A2UI_REVEAL_STEP_OPTIONS.minCharsPerSecond);
  const maxUnitsPerSecond = Math.max(
    minUnitsPerSecond,
    positiveNumber(options.maxCharsPerSecond, A2UI_REVEAL_STEP_OPTIONS.maxCharsPerSecond),
  );
  const comfortableBacklog = positiveNumber(options.comfortableBacklog, A2UI_REVEAL_STEP_OPTIONS.comfortableBacklog);
  const drainTargetSeconds = positiveNumber(options.drainTargetSeconds, A2UI_REVEAL_STEP_OPTIONS.drainTargetSeconds);
  const targetUnitsPerSecond = backlog > comfortableBacklog
    ? backlog / drainTargetSeconds
    : minUnitsPerSecond;
  const unitsPerSecond = Math.min(
    maxUnitsPerSecond,
    Math.max(minUnitsPerSecond, targetUnitsPerSecond),
  );
  return {
    intervalMs: Math.max(80, Math.min(260, Math.round(1000 / unitsPerSecond))),
    units: Math.max(1, Math.min(backlog, maxUnitsPerTick)),
    unitsPerSecond,
  };
}

function hiddenTargetKeys(targetKeys: string[], visibleKeys: Set<string>): string[] {
  return targetKeys.filter((key) => !visibleKeys.has(key));
}

function countHiddenTargetUnits(targetKeys: string[], visibleKeys: Set<string>): number {
  let count = 0;
  for (const key of targetKeys) {
    if (!visibleKeys.has(key)) {
      count += 1;
    }
  }
  return count;
}

function areStringSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function normalizeUnitSignature(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildUnitFingerprint(units: A2UIRevealUnit[]): string {
  return units
    .map((unit) => [
      escapeFingerprintPart(unit.key),
      escapeFingerprintPart(unit.kind ?? ""),
      escapeFingerprintPart(normalizeUnitSignature(unit.signature)),
    ].join("\u001f"))
    .join("\u001e");
}

function escapeFingerprintPart(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\u001f", "\\u001f").replaceAll("\u001e", "\\u001e");
}

function normalizeMaxUnitsPerFrame(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : DEFAULT_A2UI_REVEAL_MAX_UNITS_PER_FRAME;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
