import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from "react";

import type { RuntimeConnectionStatus } from "@/renderer/providers/RuntimeConnectionProvider";

import type { LaunchIntent } from "./launchIntent";
import { LaunchIntentResolvingScreen, StartupScreen, type StartupScreenPhase } from "./StartupScreen";
import { remainingStartupVisibleMs } from "./startupTiming";

type StartupDisplayState = "screen" | "exiting" | "content";

export interface NormalStartupBoundaryProps extends PropsWithChildren {
  launchIntent: LaunchIntent;
  onRetry?: () => void;
  runtimeStatus: RuntimeConnectionStatus;
}

export function NormalStartupBoundary({
  children,
  launchIntent,
  onRetry,
  runtimeStatus,
}: NormalStartupBoundaryProps) {
  const startedAtRef = useRef(Date.now());
  const hasBootedOnceRef = useRef(false);
  const [displayState, setDisplayState] = useState<StartupDisplayState>("screen");

  useEffect(() => {
    if (runtimeStatus === "ready") {
      hasBootedOnceRef.current = true;
    }
    if (
      launchIntent !== "normal" ||
      !hasBootedOnceRef.current ||
      displayState !== "screen"
    ) {
      return;
    }
    const timer = window.setTimeout(
      () => setDisplayState("exiting"),
      remainingStartupVisibleMs(startedAtRef.current, Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [displayState, launchIntent, runtimeStatus]);

  const showContent = useCallback(() => {
    setDisplayState("content");
  }, []);

  if (launchIntent === "external-file" || displayState === "content") {
    return children;
  }

  if (launchIntent === "resolving") {
    return <LaunchIntentResolvingScreen />;
  }

  let phase: StartupScreenPhase = "pending";
  if (displayState === "exiting") {
    phase = "exiting";
  } else if (runtimeStatus === "error") {
    phase = "error";
  }

  return <StartupScreen phase={phase} onExitComplete={showContent} onRetry={onRetry} />;
}
