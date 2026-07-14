import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AgentConnection, RuntimeBridge } from "@/runtime";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import { SettingsRuntimeGate } from "@/renderer/pages/settings/SettingsRuntimeGate";

describe("SettingsRuntimeGate", () => {
  it("keeps backend settings unmounted until the connection is ready", async () => {
    const connection = createDeferred<AgentConnection>();
    const starter = vi.fn(() => connection.promise);
    const onMount = vi.fn();

    render(
      <RuntimeConnectionProvider runtime={{} as RuntimeBridge} starter={starter}>
        <SettingsRuntimeGate>
          <BackendSettingsProbe onMount={onMount} />
        </SettingsRuntimeGate>
      </RuntimeConnectionProvider>,
    );

    expect(await screen.findByTestId("settings-runtime-gate")).not.toBeNull();
    expect(screen.getByText("本地服务正在启动")).not.toBeNull();
    expect(screen.queryByTestId("backend-settings-probe")).toBeNull();
    expect(onMount).not.toHaveBeenCalled();

    await act(async () => {
      connection.resolve(agentConnection());
      await connection.promise;
    });

    expect(await screen.findByTestId("backend-settings-probe")).not.toBeNull();
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it("retries an inline error without mounting duplicate settings content", async () => {
    const starter = vi
      .fn<() => Promise<AgentConnection>>()
      .mockRejectedValueOnce(new Error("health timeout"))
      .mockResolvedValueOnce(agentConnection());
    const onMount = vi.fn();

    render(
      <RuntimeConnectionProvider runtime={{} as RuntimeBridge} starter={starter}>
        <SettingsRuntimeGate>
          <BackendSettingsProbe onMount={onMount} />
        </SettingsRuntimeGate>
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByText("本地服务连接失败")).not.toBeNull());
    expect(screen.getByText("health timeout")).not.toBeNull();
    expect(onMount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByTestId("backend-settings-probe")).not.toBeNull();
    expect(starter).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onMount).toHaveBeenCalledTimes(1));
  });
});

function BackendSettingsProbe({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div data-testid="backend-settings-probe">backend settings</div>;
}

function agentConnection(): AgentConnection {
  return {
    host: "127.0.0.1",
    port: 9234,
    base_url: "http://127.0.0.1:9234",
    data_dir: "D:/Keydex",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
