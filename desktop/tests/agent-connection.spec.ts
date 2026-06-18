import { describe, expect, it, vi } from "vitest";

import {
  DEV_AGENT_CONNECTION,
  configureAgentConnection,
  resolveAgentConnection,
  waitForAgentHealth,
  type AgentConnectionRuntime,
  type TauriInvoke,
} from "@/runtime/agentConnection";

describe("agentConnection", () => {
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

  it("allocates a port, starts sidecar and waits for health in Tauri mode", async () => {
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
  });

  it("falls back to dev connection when Tauri API is unavailable", async () => {
    const connection = await resolveAgentConnection({
      isTauriRuntime: () => true,
      loadInvoke: async () => {
        throw new Error("missing tauri api");
      },
    });

    expect(connection).toEqual(DEV_AGENT_CONNECTION);
  });

  it("throws a Chinese sidecar startup error when Tauri commands fail", async () => {
    const invoke: TauriInvoke = async <T,>(command: string): Promise<T> => {
      if (command === "allocate_port") {
        return 9234 as T;
      }
      throw new Error("sidecar binary missing");
    };

    await expect(resolveAgentConnection({ invoke, isTauriRuntime: () => true })).rejects.toThrow(
      "启动本地 Agent 服务失败：sidecar binary missing",
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
    ).rejects.toThrow("Agent 服务健康检查超时：connection refused");
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
