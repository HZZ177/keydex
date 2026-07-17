import { useEffect, useRef, useState } from "react";

import { selectLatestActiveGitCheckoutOperation } from "@/renderer/features/git/store/gitStore";
import { useOptionalGitStoreSelector } from "@/renderer/providers/GitProvider";

export type GitCheckoutIndicatorPhase = "idle" | "busy" | "success";

const SUCCESS_VISIBLE_MS = 720;

export function useGitCheckoutIndicator(localBusy = false): GitCheckoutIndicatorPhase {
  const operation = useOptionalGitStoreSelector(selectLatestActiveGitCheckoutOperation);
  const [phase, setPhase] = useState<GitCheckoutIndicatorPhase>("idle");
  const trackedOperationIdRef = useRef<string | null>(null);
  const operationAtLocalStartRef = useRef<string | null>(null);
  const previousLocalBusyRef = useRef(false);

  useEffect(() => {
    if (localBusy && !previousLocalBusyRef.current) {
      operationAtLocalStartRef.current = operation?.operationId ?? null;
    }
    previousLocalBusyRef.current = localBusy;

    const operationBusy = operation?.state === "queued"
      || operation?.state === "running"
      || operation?.state === "cancelling";
    const isNewLocalOperation = localBusy
      && Boolean(operation)
      && operation?.operationId !== operationAtLocalStartRef.current;

    if (operationBusy || localBusy) {
      if (operationBusy || isNewLocalOperation) {
        trackedOperationIdRef.current = operation?.operationId ?? null;
      }
      setPhase("busy");
      return;
    }

    const completedTrackedOperation = Boolean(
      operation
      && trackedOperationIdRef.current === operation.operationId
      && operation.state === "succeeded",
    );
    if (!completedTrackedOperation) {
      trackedOperationIdRef.current = null;
      setPhase("idle");
      return;
    }

    setPhase("success");
    const timer = window.setTimeout(() => {
      trackedOperationIdRef.current = null;
      setPhase("idle");
    }, SUCCESS_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [localBusy, operation]);

  return phase;
}
