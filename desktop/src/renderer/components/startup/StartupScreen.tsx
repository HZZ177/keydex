import { useEffect } from "react";
import { RotateCcw } from "lucide-react";

import { Titlebar } from "@/renderer/components/layout/Titlebar";
import { prefersReducedMotion } from "@/renderer/utils/motionPreference";

import styles from "./StartupScreen.module.css";
import { STARTUP_EXIT_MS } from "./startupTiming";

export type StartupScreenPhase = "pending" | "error" | "exiting";

export interface StartupScreenProps {
  phase?: StartupScreenPhase;
  onExitComplete?: () => void;
  onRetry?: () => void;
}

export function StartupScreen({ phase = "pending", onExitComplete, onRetry }: StartupScreenProps) {
  const reducedMotion = prefersReducedMotion();

  useEffect(() => {
    if (phase !== "exiting" || !onExitComplete) {
      return;
    }
    const timer = window.setTimeout(onExitComplete, STARTUP_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [onExitComplete, phase]);

  return (
    <div
      className={styles.screen}
      data-phase={phase}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-testid="startup-screen"
    >
      <div className={styles.titlebarFrame}>
        <Titlebar title="" brandLabel="Keydex" />
      </div>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {phase === "error" ? "本地服务连接失败" : "本地服务正在启动"}
      </span>
      <main className={styles.canvas} data-testid="startup-canvas">
        <div className={styles.constructionLines} aria-hidden="true" />
        <div className={styles.logoStage}>
          <img className={styles.logo} src="/keydex-startup-mark.png" alt="" draggable={false} />
          <span className={styles.signalTrack} aria-hidden="true">
            <span className={styles.signalDot} />
          </span>
          {phase === "error" && onRetry ? (
            <button
              className={styles.retry}
              type="button"
              aria-label="重试启动本地服务"
              title="重试启动本地服务"
              onClick={onRetry}
            >
              <RotateCcw size={16} strokeWidth={1.9} />
            </button>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export function LaunchIntentResolvingScreen() {
  return (
    <div className={styles.screen} data-testid="launch-intent-resolving">
      <div className={styles.titlebarFrame}>
        <Titlebar title="" brandLabel="Keydex" />
      </div>
      <main className={styles.resolvingCanvas} aria-hidden="true" />
    </div>
  );
}
