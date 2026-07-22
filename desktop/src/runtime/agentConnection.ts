import { runtimeBridge, type RuntimeBridge } from "./bridge";

export interface AgentConnection {
  host: string;
  port: number;
  base_url: string;
  data_dir: string;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface AgentConnectionRuntime {
  setBaseUrl(baseUrl: string): void;
  health(): Promise<unknown>;
}

export interface AgentConnectionOptions {
  runtime?: AgentConnectionRuntime;
  invoke?: TauriInvoke;
  loadInvoke?: () => Promise<TauriInvoke>;
  isTauriRuntime?: () => boolean;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEV_AGENT_CONNECTION: AgentConnection = {
  host: "127.0.0.1",
  port: 8765,
  base_url: "http://127.0.0.1:8765",
  data_dir: "",
};
export const DEV_AGENT_BASE_URL_STORAGE_KEY = "keydex:agent-base-url";
const DEFAULT_AGENT_HEALTH_TIMEOUT_MS = 60_000;

export async function configureAgentConnection(
  options: AgentConnectionOptions = {},
): Promise<AgentConnection> {
  const runtime = options.runtime ?? runtimeBridge;
  const isTauri = (options.isTauriRuntime ?? isTauriRuntime)();
  const connection = await resolveAgentConnection({
    ...options,
    isTauriRuntime: () => isTauri,
  });
  runtime.setBaseUrl(connection.base_url);
  if (!isTauri) {
    await waitForAgentHealth(runtime, options);
  }
  return connection;
}

export async function resolveAgentConnection(
  options: AgentConnectionOptions = {},
): Promise<AgentConnection> {
  if (!(options.isTauriRuntime ?? isTauriRuntime)()) {
    return resolveDevAgentConnection();
  }

  let invoke: TauriInvoke | null = null;
  let connection: AgentConnection | null = null;
  let ownsSidecar = false;

  try {
    invoke = await resolveInvoke(options);
    if (!invoke) {
      throw new Error("Tauri API 不可用");
    }
    const externalConnection = await invoke<AgentConnection | null>("resolve_dev_agent_connection");
    if (externalConnection) {
      connection = externalConnection;
      await invoke<void>("wait_for_health", {
        host: connection.host,
        port: connection.port,
        timeoutMs: DEFAULT_AGENT_HEALTH_TIMEOUT_MS,
      });
      return connection;
    }
    const port = await invoke<number>("allocate_port");
    connection = await invoke<AgentConnection>("start_sidecar", { port });
    ownsSidecar = true;
    await invoke<void>("wait_for_health", {
      host: connection.host,
      port: connection.port,
      timeoutMs: DEFAULT_AGENT_HEALTH_TIMEOUT_MS,
    });
    return connection;
  } catch (error) {
    if (ownsSidecar && invoke) {
      await invoke<void>("stop_sidecar").catch(() => undefined);
    }
    throw new Error(`启动 Keydex 本地服务失败：${formatErrorMessage(error)}`);
  }
}

function resolveDevAgentConnection(): AgentConnection {
  const baseUrl = readDevAgentBaseUrl();
  if (!baseUrl) {
    return DEV_AGENT_CONNECTION;
  }
  try {
    const url = new URL(baseUrl);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return {
      host: url.hostname,
      port,
      base_url: url.toString().replace(/\/$/, ""),
      data_dir: "",
    };
  } catch {
    return DEV_AGENT_CONNECTION;
  }
}

function readDevAgentBaseUrl(): string {
  if (typeof window === "undefined" || !window.localStorage) {
    return "";
  }
  return window.localStorage.getItem(DEV_AGENT_BASE_URL_STORAGE_KEY)?.trim() ?? "";
}

export async function waitForAgentHealth(
  runtime: Pick<RuntimeBridge, "health"> | AgentConnectionRuntime,
  options: AgentConnectionOptions = {},
): Promise<void> {
  const timeoutMs = options.healthTimeoutMs ?? DEFAULT_AGENT_HEALTH_TIMEOUT_MS;
  const intervalMs = options.healthIntervalMs ?? 150;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() <= deadline) {
    try {
      await runtime.health();
      return;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw new Error(`Keydex 服务健康检查超时：${formatErrorMessage(lastError)}`);
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function resolveInvoke(options: AgentConnectionOptions): Promise<TauriInvoke | null> {
  if (options.invoke) {
    return options.invoke;
  }
  try {
    return await (options.loadInvoke ?? loadTauriInvoke)();
  } catch {
    return null;
  }
}

async function loadTauriInvoke(): Promise<TauriInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as TauriInvoke;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return "未知错误";
}
