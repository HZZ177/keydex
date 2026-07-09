import { useCallback, useEffect, useRef, useState } from "react";

export type CopyFeedbackStatus = "idle" | "copied" | "failed";
export type CopyFeedbackResultStatus = Exclude<CopyFeedbackStatus, "idle">;

export const COPY_FEEDBACK_RESET_MS = 1400;

export function useCopyFeedback(resetDelayMs = COPY_FEEDBACK_RESET_MS) {
  const [copyState, setCopyState] = useState<CopyFeedbackStatus>("idle");
  const timerRef = useRef<number | null>(null);

  const clearCopyFeedbackTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetCopyFeedback = useCallback(() => {
    clearCopyFeedbackTimer();
    setCopyState("idle");
  }, [clearCopyFeedbackTimer]);

  const showCopyFeedback = useCallback(
    (state: CopyFeedbackResultStatus) => {
      clearCopyFeedbackTimer();
      setCopyState(state);
      timerRef.current = window.setTimeout(() => {
        setCopyState("idle");
        timerRef.current = null;
      }, resetDelayMs);
    },
    [clearCopyFeedbackTimer, resetDelayMs],
  );

  useEffect(() => clearCopyFeedbackTimer, [clearCopyFeedbackTimer]);

  return {
    copyState,
    showCopyFeedback,
    resetCopyFeedback,
    clearCopyFeedbackTimer,
  };
}

export interface TargetedCopyFeedback<TTarget extends string> {
  target: TTarget;
  status: CopyFeedbackResultStatus;
}

export function useTargetedCopyFeedback<TTarget extends string>(resetDelayMs = COPY_FEEDBACK_RESET_MS) {
  const [copyFeedback, setCopyFeedback] = useState<TargetedCopyFeedback<TTarget> | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearCopyFeedbackTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetCopyFeedback = useCallback(() => {
    clearCopyFeedbackTimer();
    setCopyFeedback(null);
  }, [clearCopyFeedbackTimer]);

  const showCopyFeedback = useCallback(
    (target: TTarget, status: CopyFeedbackResultStatus) => {
      clearCopyFeedbackTimer();
      setCopyFeedback({ target, status });
      timerRef.current = window.setTimeout(() => {
        setCopyFeedback(null);
        timerRef.current = null;
      }, resetDelayMs);
    },
    [clearCopyFeedbackTimer, resetDelayMs],
  );

  const getCopyStatus = useCallback(
    (target: TTarget): CopyFeedbackStatus => (copyFeedback?.target === target ? copyFeedback.status : "idle"),
    [copyFeedback],
  );

  useEffect(() => clearCopyFeedbackTimer, [clearCopyFeedbackTimer]);

  return {
    copyFeedback,
    getCopyStatus,
    showCopyFeedback,
    resetCopyFeedback,
    clearCopyFeedbackTimer,
  };
}
