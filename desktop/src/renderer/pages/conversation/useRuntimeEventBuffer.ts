import { useCallback, useEffect, useRef } from "react";

import type { RuntimeEvent } from "@/types/protocol";

const FLUSH_INTERVAL_MS = 33;

const IMMEDIATE_FLUSH_TYPES = new Set<RuntimeEvent["type"]>([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "item.completed",
  "approval.requested",
  "approval.resolved",
  "runtime.error",
]);

export function useRuntimeEventBuffer(onFlush: (events: RuntimeEvent[]) => void) {
  const onFlushRef = useRef(onFlush);
  const pendingRef = useRef<RuntimeEvent[]>([]);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  const clearScheduledFlush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const flushEvents = useCallback(() => {
    clearScheduledFlush();
    if (!pendingRef.current.length) {
      return;
    }
    const events = pendingRef.current;
    pendingRef.current = [];
    onFlushRef.current(events);
  }, [clearScheduledFlush]);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null || frameRef.current !== null) {
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        flushEvents();
      });
    }, FLUSH_INTERVAL_MS);
  }, [flushEvents]);

  const enqueueEvent = useCallback(
    (event: RuntimeEvent) => {
      pendingRef.current.push(event);
      if (IMMEDIATE_FLUSH_TYPES.has(event.type)) {
        flushEvents();
        return;
      }
      scheduleFlush();
    },
    [flushEvents, scheduleFlush],
  );

  useEffect(() => flushEvents, [flushEvents]);

  return { enqueueEvent, flushEvents };
}
