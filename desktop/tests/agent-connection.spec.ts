import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEV_AGENT_BASE_URL_STORAGE_KEY,
  DEV_AGENT_CONNECTION,
  configureAgentConnection,
  resolveAgentConnection,
  waitForAgentHealth,
  type AgentConnectionRuntime,
  type TauriInvoke,
} from "@/runtime/agentConnection";

describe("agentConnection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses the fixed local backend in dev web mode", async () => {
    const runtime = fakeRuntime();

    const connection = await configureAgentConnection({
      runtime,
      isTauriRuntime: () => false,
      sleep: async () => undefined,
    });

    expect(connection).toEqual(DEV_AGENT_CONNECTION);
    expect(runtime.setBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:8765");
    expect(runtime.health).toHaveBeenCalledTimes(1);
  });

  it("uses the E2E local backend override in dev web mode", async () => {
    localStorage.setItem(DEV_AGENT_BASE_URL_STORAGE_KEY, "http://127.0.0.1:18765/");
    const runtime = fakeRuntime();

    const connection = await configureAgentConnection({
      runtime,
      isTauriRuntime: () => false,
      sleep: async () => undefined,
    });

    expect(connection).toMatchObject({
      host: "127.0.0.1",
      port: 18765,
      base_url: "http://127.0.0.1:18765",
    });
    expect(runtime.setBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:18765");
    expect(runtime.health).toHaveBeenCalledTimes(1);
  });

  it("allocates a port, starts sidecar and waits once via the Tauri health command", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: TauriInvoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      if (command === "allocate_port") {
        return 9234 as T;
      }
      if (command === "start_sidecar") {
        return {
          host: "127.0.0.1",
          port: 9234,
          base_url: "http://127.0.0.1:9234",
          data_dir: "D:/data",
        } as T;
      }
      return undefined as T;
    };
    const runtime = fakeRuntime();

    const connection = await configureAgentConnection({
      runtime,
      invoke,
      isTauriRuntime: () => true,
      sleep: async () => undefined,
    });

    expect(connection.base_url).toBe("http://127.0.0.1:9234");
    expect(calls).toEqual([
      { command: "allocate_port", args: undefined },
      { command: "start_sidecar", args: { port: 9234 } },
      { command: "wait_for_health", args: { host: "127.0.0.1", port: 9234, timeoutMs: 10_000 } },
    ]);
    expect(runtime.setBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:9234");
    expect(runtime.health).not.toHaveBeenCalled();
  });

  it("stops the sidecar when the Tauri health wait fails", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: TauriInvoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      if (command === "allocate_port") {
        return 9234 as T;
      }
      if (command === "start_sidecar") {
        return {
          host: "127.0.0.1",
          port: 9234,
          base_url: "http://127.0.0.1:9234",
          data_dir: "D:/data",
        } as T;
      }
      if (command === "wait_for_health") {
        throw new Error("health timeout");
      }
      return undefined as T;
    };

    await expect(resolveAgentConnection({ invoke, isTauriRuntime: () => true })).rejects.toThrow(
      "启动 Keydex 本地服务失败：health timeout",
    );
    expect(calls).toEqual([
      { command: "allocate_port", args: undefined },
      { command: "start_sidecar", args: { port: 9234 } },
      { command: "wait_for_health", args: { host: "127.0.0.1", port: 9234, timeoutMs: 10_000 } },
      { command: "stop_sidecar", args: undefined },
    ]);
  });

  it("does not fall back to the dev backend when Tauri API is unavailable", async () => {
    await expect(
      resolveAgentConnection({
        isTauriRuntime: () => true,
        loadInvoke: async () => {
          throw new Error("missing tauri api");
        },
      }),
    ).rejects.toThrow("启动 Keydex 本地服务失败：Tauri API 不可用");
  });

  it("throws a Chinese sidecar startup error when Tauri commands fail", async () => {
    const invoke: TauriInvoke = async <T,>(command: string): Promise<T> => {
      if (command === "allocate_port") {
        return 9234 as T;
      }
      throw new Error("sidecar binary missing");
    };

    await expect(resolveAgentConnection({ invoke, isTauriRuntime: () => true })).rejects.toThrow(
      "启动 Keydex 本地服务失败：sidecar binary missing",
    );
  });

  it("waits for runtime health and reports timeout with the real error message", async () => {
    const runtime = fakeRuntime({
      health: vi.fn().mockRejectedValue(new Error("connection refused")),
    });

    await expect(
      waitForAgentHealth(runtime, {
        healthTimeoutMs: 0,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("Keydex 服务健康检查超时：connection refused");
  });
});

type MockAgentConnectionRuntime = AgentConnectionRuntime & {
  setBaseUrl: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
};

function fakeRuntime(overrides: Partial<AgentConnectionRuntime> = {}): MockAgentConnectionRuntime {
  const runtime: MockAgentConnectionRuntime = {
    setBaseUrl: vi.fn(),
    health: vi.fn().mockResolvedValue({ status: "ok" }),
  };
  return Object.assign(runtime, overrides);
}
