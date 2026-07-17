import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useCallback,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { useTheme } from "@/renderer/providers/ThemeProvider";
import { useKeydexDiffTheme } from "../diffTheme";
import {
  PierreWorkerPoolLifecycle,
  pierreWorkerPoolLifecycle,
  type PierreWorkerPoolDiagnostics,
} from "./pierreWorkerPoolLifecycle";

const LifecycleContext = createContext<PierreWorkerPoolLifecycle | null>(null);

export interface PierreWorkerPoolHostProps extends PropsWithChildren {
  readonly lifecycle?: PierreWorkerPoolLifecycle;
}

export function PierreWorkerPoolHost({
  children,
  lifecycle = pierreWorkerPoolLifecycle,
}: PierreWorkerPoolHostProps) {
  const { theme } = useTheme();

  useEffect(() => {
    lifecycle.updateTheme(theme);
  }, [lifecycle, theme]);

  useEffect(() => {
    const terminate = () => lifecycle.terminateImmediately();
    window.addEventListener("pagehide", terminate);
    window.addEventListener("beforeunload", terminate);
    return () => {
      window.removeEventListener("pagehide", terminate);
      window.removeEventListener("beforeunload", terminate);
      lifecycle.terminateImmediately();
    };
  }, [lifecycle]);

  return (
    <LifecycleContext.Provider value={lifecycle}>
      {children}
    </LifecycleContext.Provider>
  );
}

/**
 * Keep the asynchronously loaded Pierre provider at the viewer boundary.
 *
 * Mounting it around the whole application after the worker runtime becomes
 * ready would replace the application root and reset transient UI state such
 * as an open review sidebar or reverse dialog.
 */
export function PierreWorkerPoolBoundary({ children }: PropsWithChildren) {
  const lifecycle = usePierreWorkerPoolLifecycle();
  useSyncExternalStore(lifecycle.subscribe, lifecycle.snapshot, lifecycle.snapshot);
  const runtime = lifecycle.runtimeSnapshot();
  return runtime
    ? createElement(runtime.module.WorkerPoolContext.Provider, {
        value: runtime.manager,
        children,
      })
    : children;
}

export function usePierreWorkerPoolLease(): PierreWorkerPoolDiagnostics {
  const lifecycle = usePierreWorkerPoolLifecycle();
  const theme = useKeydexDiffTheme();
  const diagnostics = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.snapshot,
    lifecycle.snapshot,
  );
  useEffect(() => lifecycle.acquire(theme), [lifecycle, theme]);
  return diagnostics;
}

export function usePierreWorkerPoolDiagnostics(): PierreWorkerPoolDiagnostics {
  const lifecycle = usePierreWorkerPoolLifecycle();
  return useSyncExternalStore(lifecycle.subscribe, lifecycle.snapshot, lifecycle.snapshot);
}

export function usePierreWorkerPoolRetry(): () => Promise<void> {
  const lifecycle = usePierreWorkerPoolLifecycle();
  return useCallback(() => lifecycle.retry(), [lifecycle]);
}

function usePierreWorkerPoolLifecycle(): PierreWorkerPoolLifecycle {
  return useContext(LifecycleContext) ?? pierreWorkerPoolLifecycle;
}
