import { type CSSProperties, useEffect, useRef, useState } from "react";

export function useDeferredUnmount<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  closeDelayMs = 220,
  openDurationMs = 250,
) {
  const ref = useRef<T | null>(null);
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<"opening" | "open" | "closing" | "closed">(open ? "open" : "closed");
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      clearMotionHandles(frameRef.current, timerRef.current);
    };
  }, []);

  useEffect(() => {
    clearMotionHandles(frameRef.current, timerRef.current);
    frameRef.current = null;
    timerRef.current = null;

    if (open) {
      setMounted(true);
      setPhase("opening");
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          setPhase("open");
        });
      });
      return () => clearMotionHandles(frameRef.current, timerRef.current);
    }
    if (!mounted) {
      return undefined;
    }
    setPhase("closing");
    timerRef.current = window.setTimeout(() => {
      setMounted(false);
      setPhase("closed");
    }, closeDelayMs);
    return () => clearMotionHandles(frameRef.current, timerRef.current);
  }, [closeDelayMs, open]);

  return {
    shouldRender: open || mounted,
    phase,
    ref,
    style: {
      "--collapse-open-duration": `${openDurationMs}ms`,
      "--collapse-close-duration": `${closeDelayMs}ms`,
    } as CSSProperties,
  } as const;
}

function clearMotionHandles(frame: number | null, timer: number | null) {
  if (frame !== null) {
    window.cancelAnimationFrame(frame);
  }
  if (timer !== null) {
    window.clearTimeout(timer);
  }
}
