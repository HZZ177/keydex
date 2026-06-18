import { apiClient } from "@/api/client";

export interface AgentConnection {
  host: string;
  port: number;
  base_url: string;
  data_dir: string;
}

const DEV_CONNECTION: AgentConnection = {
  host: "127.0.0.1",
  port: 8765,
  base_url: "http://127.0.0.1:8765",
  data_dir: "",
};

export function toWebSocketBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

export async function configureAgentConnection(): Promise<AgentConnection> {
  const connection = await resolveAgentConnection();
  apiClient.setBaseUrl(connection.base_url);
  await waitForAgentHealth();
  return connection;
}

async function resolveAgentConnection(): Promise<AgentConnection> {
  if (!isTauriRuntime()) {
    return DEV_CONNECTION;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const port = await invoke<number>("allocate_port");
  const connection = await invoke<AgentConnection>("start_sidecar", { port });
  await invoke("wait_for_health", {
    host: connection.host,
    port: connection.port,
    timeoutMs: 10_000,
  });
  return connection;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function waitForAgentHealth(timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      await apiClient.health();
      return;
    } catch (exc) {
      lastError = exc;
      await sleep(150);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Agent 服务健康检查超时");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
