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

export async function configureAgentConnection(
  options: AgentConnectionOptions = {},
): Promise<AgentConnection> {
  const runtime = options.runtime ?? runtimeBridge;
  const connection = await resolveAgentConnection(options);
  runtime.setBaseUrl(connection.base_url);
  await waitForAgentHealth(runtime, options);
  return connection;
}

export async function resolveAgentConnection(
  options: AgentConnectionOptions = {},
): Promise<AgentConnection> {
  if (!(options.isTauriRuntime ?? isTauriRuntime)()) {
    return DEV_AGENT_CONNECTION;
  }

  const invoke = await resolveInvoke(options);
  if (!invoke) {
    return DEV_AGENT_CONNECTION;
  }

  try {
    const port = await invoke<number>("allocate_port");
    const connection = await invoke<AgentConnection>("start_sidecar", { port });
    await invoke<void>("wait_for_health", {
      host: connection.host,
      port: connection.port,
      timeoutMs: 10_000,
    });
    return connection;
  } catch (error) {
    throw new Error(`启动本地 Agent 服务失败：${formatErrorMessage(error)}`);
  }
}

export async function waitForAgentHealth(
  runtime: Pick<RuntimeBridge, "health"> | AgentConnectionRuntime,
  options: AgentConnectionOptions = {},
): Promise<void> {
  const timeoutMs = options.healthTimeoutMs ?? 10_000;
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

  throw new Error(`Agent 服务健康检查超时：${formatErrorMessage(lastError)}`);
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
