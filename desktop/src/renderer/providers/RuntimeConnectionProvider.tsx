import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PropsWithChildren,
} from "react";

import {
  configureAgentConnection,
  isTauriRuntime,
  runtimeBridge,
  type AgentConnection,
  type HealthResponse,
  type RuntimeBridge,
  type WsConnectionStatus,
} from "@/runtime";
import {
  createInitialRuntimeState,
  runtimeReducer,
  selectVisibleErrors,
  type RuntimeAction,
  type RuntimeErrorRecord,
  type RuntimeState,
} from "@/renderer/stores/runtimeStore";

export type RuntimeConnectionStatus = "idle" | "starting" | "retrying" | "ready" | "error";

export type RuntimeCapabilityId = "shell" | "desktop.local" | "backend.http" | "backend.ws" | "model.config";
export type RuntimeCapabilityState = "ready" | "loading" | "error" | "unavailable";

export interface RuntimeCapability {
  id: RuntimeCapabilityId;
  state: RuntimeCapabilityState;
  ready: boolean;
  error: RuntimeErrorRecord | null;
  retry?: () => void;
}

export type RuntimeConnectionStarter = (runtime: RuntimeBridge) => Promise<AgentConnection>;

export interface RuntimeConnectionContextValue {
  runtime: RuntimeBridge;
  runtimeState: RuntimeState;
  dispatchRuntime: Dispatch<RuntimeAction>;
  status: RuntimeConnectionStatus;
  ready: boolean;
  connection: AgentConnection | null;
  error: RuntimeErrorRecord | null;
  retry: () => void;
  clearError: (id: string) => void;
  clearAllErrors: () => void;
  setWsStatus: (status: WsConnectionStatus) => void;
  getCapability: (id: RuntimeCapabilityId) => RuntimeCapability;
}

export interface RuntimeConnectionProviderProps extends PropsWithChildren {
  runtime?: RuntimeBridge;
  starter?: RuntimeConnectionStarter;
  autoStart?: boolean;
  isDesktopRuntime?: () => boolean;
}

interface LifecycleState {
  status: RuntimeConnectionStatus;
  connection: AgentConnection | null;
}

const RuntimeConnectionContext = createContext<RuntimeConnectionContextValue | null>(null);

export function RuntimeConnectionProvider({
  children,
  runtime = runtimeBridge,
  starter = startRuntimeConnection,
  autoStart = true,
  isDesktopRuntime: detectDesktopRuntime = isTauriRuntime,
}: RuntimeConnectionProviderProps) {
  const [runtimeState, dispatchRuntime] = useReducer(runtimeReducer, createInitialRuntimeState());
  const [lifecycle, setLifecycle] = useState<LifecycleState>({ status: "idle", connection: null });
  const runSeqRef = useRef(0);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const autoStartRequestedRef = useRef(false);

  const visibleErrors = selectVisibleErrors(runtimeState);
  const error = visibleErrors.find((item) => item.source === "health") ?? visibleErrors[0] ?? null;
  const ready = lifecycle.status === "ready";

  const start = useCallback(
    async (status: "starting" | "retrying") => {
      if (runningRef.current) {
        return;
      }
      runningRef.current = true;
      const runSeq = runSeqRef.current + 1;
      runSeqRef.current = runSeq;
      setLifecycle({ status, connection: null });
      dispatchRuntime({ type: "error/clearSource", source: "health" });
      dispatchRuntime({ type: "connection/setStatus", source: "health", status: "checking" });

      try {
        const connection = await starter(runtime);
        if (runSeqRef.current !== runSeq || !mountedRef.current) {
          return;
        }
        setLifecycle({ status: "ready", connection });
        dispatchRuntime({ type: "connection/setStatus", source: "health", status: "connected" });
        void monitorAgentWarmup(runtime, dispatchRuntime, runSeqRef, runSeq);
      } catch (reason) {
        if (runSeqRef.current !== runSeq || !mountedRef.current) {
          return;
        }
        setLifecycle({ status: "error", connection: null });
        dispatchRuntime({
          type: "error/record",
          source: "health",
          error: reason,
          id: `health:${runSeq}`,
        });
      } finally {
        if (runSeqRef.current === runSeq) {
          runningRef.current = false;
        }
      }
    },
    [runtime, starter],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current) {
          return;
        }
        runSeqRef.current += 1;
        runningRef.current = false;
      });
    };
  }, []);

  useEffect(() => {
    if (!autoStart) {
      autoStartRequestedRef.current = false;
      return;
    }
    if (autoStartRequestedRef.current) {
      return;
    }
    autoStartRequestedRef.current = true;
    void start("starting");
  }, [autoStart, start]);

  const retry = useCallback(() => {
    void start("retrying");
  }, [start]);

  const clearError = useCallback((id: string) => {
    dispatchRuntime({ type: "error/clear", id });
  }, []);

  const clearAllErrors = useCallback(() => {
    dispatchRuntime({ type: "error/clearAll" });
  }, []);

  const setWsStatus = useCallback((status: WsConnectionStatus) => {
    dispatchRuntime({ type: "connection/setWsStatus", status });
  }, []);

  const getCapability = useCallback(
    (id: RuntimeCapabilityId): RuntimeCapability => {
      if (id === "shell") {
        return { id, state: "ready", ready: true, error: null };
      }
      if (id === "desktop.local") {
        const available = detectDesktopRuntime();
        return { id, state: available ? "ready" : "unavailable", ready: available, error: null };
      }
      if (id === "backend.http" || id === "model.config") {
        return capabilityFromConnection(id, lifecycle.status, error, retry);
      }
      return capabilityFromWsStatus(id, runtimeState.statusBySource.ws, error, retry);
    },
    [detectDesktopRuntime, error, lifecycle.status, retry, runtimeState.statusBySource.ws],
  );

  const value = useMemo<RuntimeConnectionContextValue>(
    () => ({
      runtime,
      runtimeState,
      dispatchRuntime,
      status: lifecycle.status,
      ready,
      connection: lifecycle.connection,
      error,
      retry,
      clearError,
      clearAllErrors,
      setWsStatus,
      getCapability,
    }),
    [
      clearAllErrors,
      clearError,
      error,
      getCapability,
      lifecycle.connection,
      lifecycle.status,
      ready,
      retry,
      runtime,
      runtimeState,
      setWsStatus,
    ],
  );

  return <RuntimeConnectionContext.Provider value={value}>{children}</RuntimeConnectionContext.Provider>;
}

async function monitorAgentWarmup(
  runtime: RuntimeBridge,
  dispatchRuntime: Dispatch<RuntimeAction>,
  runSeqRef: MutableRefObject<number>,
  runSeq: number,
) {
  if (typeof runtime.health !== "function") {
    return;
  }
  dispatchRuntime({ type: "error/clearSource", source: "agent" });
  for (let index = 0; index < 20; index += 1) {
    if (runSeqRef.current !== runSeq) {
      return;
    }
    let health: HealthResponse;
    try {
      health = await runtime.health();
    } catch {
      return;
    }

    if (health.agent_status === "failed") {
      dispatchRuntime({
        type: "error/record",
        source: "agent",
        id: "agent:warmup",
        error: {
          code: "agent_warmup_failed",
          message: health.agent_error || "智能体初始化失败",
          details: {
            duration_ms: health.agent_warmup_duration_ms ?? null,
          },
        },
      });
      return;
    }

    if (health.agent_status === "ready") {
      dispatchRuntime({ type: "error/clearSource", source: "agent" });
      dispatchRuntime({ type: "connection/setStatus", source: "agent", status: "connected" });
      return;
    }

    dispatchRuntime({ type: "connection/setStatus", source: "agent", status: "checking" });
    await sleep(1000);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function useRuntimeConnection() {
  const value = useContext(RuntimeConnectionContext);
  if (!value) {
    throw new Error("useRuntimeConnection 必须在 RuntimeConnectionProvider 内使用");
  }
  return value;
}

export function useOptionalRuntimeConnection() {
  return useContext(RuntimeConnectionContext);
}

export function useRuntimeCapability(id: RuntimeCapabilityId): RuntimeCapability {
  const runtimeConnection = useRuntimeConnection();
  return runtimeConnection.getCapability(id);
}

function startRuntimeConnection(runtime: RuntimeBridge) {
  return configureAgentConnection({ runtime });
}

function capabilityFromConnection(
  id: RuntimeCapabilityId,
  status: RuntimeConnectionStatus,
  error: RuntimeErrorRecord | null,
  retry: () => void,
): RuntimeCapability {
  if (status === "ready") {
    return { id, state: "ready", ready: true, error: null };
  }
  if (status === "error") {
    return { id, state: "error", ready: false, error, retry };
  }
  return { id, state: "loading", ready: false, error: null, retry };
}

function capabilityFromWsStatus(
  id: RuntimeCapabilityId,
  status: RuntimeState["statusBySource"]["ws"],
  error: RuntimeErrorRecord | null,
  retry: () => void,
): RuntimeCapability {
  if (status === "connected") {
    return { id, state: "ready", ready: true, error: null };
  }
  if (status === "error") {
    return { id, state: "error", ready: false, error, retry };
  }
  if (status === "disconnected") {
    return { id, state: "unavailable", ready: false, error: null, retry };
  }
  return { id, state: "loading", ready: false, error: null, retry };
}
