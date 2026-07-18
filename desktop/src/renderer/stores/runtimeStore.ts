import { normalizeRuntimeErrorEnvelope, type RuntimeErrorEnvelope } from "@/runtime/errors";
import type { WsConnectionStatus } from "@/runtime/wsClient";

export type RuntimeConnectionSource = "health" | "ws" | "model" | "settings" | "agent";

export type RuntimeConnectionStatus =
  | "idle"
  | "checking"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface RuntimeErrorRecord extends RuntimeErrorEnvelope {
  id: string;
  source: RuntimeConnectionSource;
  createdAt: string;
  cleared: boolean;
}

export interface RuntimeState {
  statusBySource: Record<RuntimeConnectionSource, RuntimeConnectionStatus>;
  errorIds: string[];
  errorsById: Record<string, RuntimeErrorRecord>;
}

export type RuntimeAction =
  | { type: "connection/setStatus"; source: RuntimeConnectionSource; status: RuntimeConnectionStatus }
  | { type: "connection/setWsStatus"; status: WsConnectionStatus }
  | { type: "error/record"; source: RuntimeConnectionSource; error: unknown; now?: string; id?: string }
  | { type: "error/clear"; id: string }
  | { type: "error/clearSource"; source: RuntimeConnectionSource }
  | { type: "error/clearAll" };

export interface ConnectionSummary {
  status: RuntimeConnectionStatus;
  label: string;
  hasError: boolean;
  activeError: RuntimeErrorRecord | null;
}

const SOURCE_LABELS: Record<RuntimeConnectionSource, string> = {
  health: "后端",
  ws: "流式连接",
  model: "模型",
  settings: "设置",
  agent: "智能体",
};

export function createInitialRuntimeState(): RuntimeState {
  return {
    statusBySource: {
      health: "idle",
      ws: "idle",
      model: "idle",
      settings: "idle",
      agent: "idle",
    },
    errorIds: [],
    errorsById: {},
  };
}

export function runtimeReducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
  switch (action.type) {
    case "connection/setStatus":
      return setSourceStatus(state, action.source, action.status);
    case "connection/setWsStatus":
      return setSourceStatus(state, "ws", mapWsStatus(action.status));
    case "error/record":
      return recordError(state, action.source, action.error, action.now, action.id);
    case "error/clear":
      return clearError(state, action.id);
    case "error/clearSource":
      return clearSourceErrors(state, action.source);
    case "error/clearAll":
      return clearAllErrors(state);
  }
}

export function selectVisibleErrors(state: RuntimeState): RuntimeErrorRecord[] {
  return state.errorIds
    .map((id) => state.errorsById[id])
    .filter((error): error is RuntimeErrorRecord => Boolean(error) && !error.cleared);
}

export function selectSourceStatus(
  state: RuntimeState,
  source: RuntimeConnectionSource,
): RuntimeConnectionStatus {
  return state.statusBySource[source];
}

export function selectConnectionSummary(state: RuntimeState): ConnectionSummary {
  const activeError = selectVisibleErrors(state)[0] ?? null;
  if (activeError) {
    return {
      status: "error",
      label: `${SOURCE_LABELS[activeError.source]}异常`,
      hasError: true,
      activeError,
    };
  }

  const statuses = Object.values(state.statusBySource);
  if (state.statusBySource.health === "checking" || state.statusBySource.health === "connecting") {
    return { status: "connecting", label: "正在启动本地服务", hasError: false, activeError: null };
  }
  if (statuses.includes("reconnecting")) {
    return { status: "reconnecting", label: "正在重连", hasError: false, activeError: null };
  }
  if (statuses.includes("connecting") || statuses.includes("checking")) {
    return { status: "connecting", label: "正在连接", hasError: false, activeError: null };
  }
  if (statuses.includes("disconnected")) {
    return { status: "disconnected", label: "连接断开", hasError: false, activeError: null };
  }
  if (statuses.includes("connected")) {
    return { status: "connected", label: "已连接", hasError: false, activeError: null };
  }
  return { status: "idle", label: "未连接", hasError: false, activeError: null };
}

export function sourceLabel(source: RuntimeConnectionSource): string {
  return SOURCE_LABELS[source];
}

function setSourceStatus(
  state: RuntimeState,
  source: RuntimeConnectionSource,
  status: RuntimeConnectionStatus,
): RuntimeState {
  return {
    ...state,
    statusBySource: {
      ...state.statusBySource,
      [source]: status,
    },
  };
}

function recordError(
  state: RuntimeState,
  source: RuntimeConnectionSource,
  error: unknown,
  now = new Date().toISOString(),
  id = `${source}:${now}:${state.errorIds.length}`,
): RuntimeState {
  const envelope = normalizeRuntimeError(source, error);
  const record: RuntimeErrorRecord = {
    ...envelope,
    id,
    source,
    createdAt: now,
    cleared: false,
  };
  return {
    ...state,
    statusBySource: {
      ...state.statusBySource,
      [source]: "error",
    },
    errorIds: state.errorIds.includes(id) ? state.errorIds : [id, ...state.errorIds],
    errorsById: {
      ...state.errorsById,
      [id]: record,
    },
  };
}

function clearError(state: RuntimeState, id: string): RuntimeState {
  const existing = state.errorsById[id];
  if (!existing) {
    return state;
  }
  return {
    ...state,
    errorsById: {
      ...state.errorsById,
      [id]: { ...existing, cleared: true },
    },
  };
}

function clearSourceErrors(state: RuntimeState, source: RuntimeConnectionSource): RuntimeState {
  const errorsById = { ...state.errorsById };
  for (const id of state.errorIds) {
    const error = errorsById[id];
    if (error?.source === source) {
      errorsById[id] = { ...error, cleared: true };
    }
  }
  return {
    ...state,
    errorsById,
    statusBySource: {
      ...state.statusBySource,
      [source]: "idle",
    },
  };
}

function clearAllErrors(state: RuntimeState): RuntimeState {
  const errorsById = Object.fromEntries(
    Object.entries(state.errorsById).map(([id, error]) => [id, { ...error, cleared: true }]),
  );
  return {
    ...state,
    errorsById,
  };
}

function normalizeRuntimeError(source: RuntimeConnectionSource, error: unknown): RuntimeErrorEnvelope {
  return normalizeRuntimeErrorEnvelope(error, {
    fallbackCode: `${source}_error`,
    fallbackMessage: `${SOURCE_LABELS[source]}连接失败`,
  });
}

function mapWsStatus(status: WsConnectionStatus): RuntimeConnectionStatus {
  switch (status) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "open":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "closed":
      return "disconnected";
    case "error":
      return "error";
  }
}
