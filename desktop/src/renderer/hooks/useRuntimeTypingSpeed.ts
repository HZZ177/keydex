import { useEffect, useRef, useState } from "react";

export const RUNTIME_TYPING_SPEED_EVENT = "keydex:runtime-typing-speed-change";

export interface RuntimeTypingSpeedEventDetail {
  sourceId: string;
  speed: number;
  backlog: number;
}

export interface RuntimeTypingMetrics {
  speed: number;
  backlog: number;
}

let sourceIdSeq = 0;

export function createRuntimeTypingSpeedSourceId(): string {
  sourceIdSeq += 1;
  return `typing:${sourceIdSeq}`;
}

export function reportRuntimeTypingSpeed(sourceId: string, speed: number, backlog = 0) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<RuntimeTypingSpeedEventDetail>(RUNTIME_TYPING_SPEED_EVENT, {
      detail: {
        sourceId,
        speed: normalizeNumber(speed),
        backlog: normalizeNumber(backlog),
      },
    }),
  );
}

export function useRuntimeTypingMetrics(): RuntimeTypingMetrics {
  const [metrics, setMetrics] = useState<RuntimeTypingMetrics>({ speed: 0, backlog: 0 });
  const activeMetricsRef = useRef<Map<string, RuntimeTypingMetrics>>(new Map());
  const staleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearStaleTimer = () => {
      if (staleTimerRef.current !== null) {
        window.clearTimeout(staleTimerRef.current);
        staleTimerRef.current = null;
      }
    };

    const setIdle = () => {
      activeMetricsRef.current.clear();
      setMetrics({ speed: 0, backlog: 0 });
      staleTimerRef.current = null;
    };

    const scheduleStaleIdle = () => {
      clearStaleTimer();
      staleTimerRef.current = window.setTimeout(setIdle, 650);
    };

    const handleSpeedChange = (event: Event) => {
      const detail = (event as CustomEvent<RuntimeTypingSpeedEventDetail>).detail;
      if (!detail?.sourceId) {
        return;
      }

      const nextMetrics = {
        speed: normalizeNumber(detail.speed),
        backlog: normalizeNumber(detail.backlog),
      };
      if (nextMetrics.speed > 0 || nextMetrics.backlog > 0) {
        activeMetricsRef.current.set(detail.sourceId, nextMetrics);
      } else {
        activeMetricsRef.current.delete(detail.sourceId);
      }

      const currentMetrics = collectCurrentMetrics(activeMetricsRef.current);
      setMetrics(currentMetrics);
      if (currentMetrics.speed > 0 || currentMetrics.backlog > 0) {
        scheduleStaleIdle();
      } else {
        clearStaleTimer();
      }
    };

    window.addEventListener(RUNTIME_TYPING_SPEED_EVENT, handleSpeedChange);
    return () => {
      window.removeEventListener(RUNTIME_TYPING_SPEED_EVENT, handleSpeedChange);
      clearStaleTimer();
    };
  }, []);

  return metrics;
}

export function useRuntimeTypingSpeed(): number {
  return useRuntimeTypingMetrics().speed;
}

function collectCurrentMetrics(metricsBySource: Map<string, RuntimeTypingMetrics>): RuntimeTypingMetrics {
  let speed = 0;
  let backlog = 0;
  metricsBySource.forEach((metrics) => {
    speed = Math.max(speed, metrics.speed);
    backlog += metrics.backlog;
  });
  return { speed, backlog };
}

function normalizeNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
