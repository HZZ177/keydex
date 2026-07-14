import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StrictMode } from "react";
import type { AgentConnection, RuntimeBridge } from "@/runtime";
import {
  RuntimeConnectionProvider,
  useRuntimeCapability,
  useRuntimeConnection,
} from "@/renderer/providers/RuntimeConnectionProvider";

describe("RuntimeConnectionProvider", () => {
  it("starts the backend once in StrictMode", async () => {
    const starter = vi.fn<() => Promise<AgentConnection>>().mockResolvedValue({
      host: "127.0.0.1",
      port: 9234,
      base_url: "http://127.0.0.1:9234",
      data_dir: "D:/Keydex",
    });

    render(
      <StrictMode>
        <RuntimeConnectionProvider runtime={{} as RuntimeBridge} starter={starter} isDesktopRuntime={() => true}>
          <RuntimeProbe />
        </RuntimeConnectionProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("connection-status-value").textContent).toBe("ready"));
    expect(starter).toHaveBeenCalledTimes(1);
  });

  it("renders shell consumers immediately while the backend is starting", async () => {
    const deferred = createDeferred<AgentConnection>();
    const starter = vi.fn(() => deferred.promise);

    render(
      <RuntimeConnectionProvider
        runtime={{} as RuntimeBridge}
        starter={starter}
        isDesktopRuntime={() => true}
      >
        <RuntimeProbe />
      </RuntimeConnectionProvider>,
    );

    expect(screen.getByText("shell-ready")).not.toBeNull();
    expect(screen.getByTestId("backend-capability").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("connection-status-value").textContent).toBe("starting"));
    expect(starter).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({
        host: "127.0.0.1",
        port: 9234,
        base_url: "http://127.0.0.1:9234",
        data_dir: "D:/Keydex",
      });
      await deferred.promise;
    });

    expect(screen.getByTestId("connection-status-value").textContent).toBe("ready");
    expect(screen.getByTestId("backend-capability").textContent).toBe("ready");
  });

  it("records startup failures and retries through the same connection contract", async () => {
    const starter = vi
      .fn<() => Promise<AgentConnection>>()
      .mockRejectedValueOnce(new Error("health timeout"))
      .mockResolvedValueOnce({
        host: "127.0.0.1",
        port: 9234,
        base_url: "http://127.0.0.1:9234",
        data_dir: "D:/Keydex",
      });

    render(
      <RuntimeConnectionProvider
        runtime={{} as RuntimeBridge}
        starter={starter}
        isDesktopRuntime={() => true}
      >
        <RuntimeProbe />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("connection-status-value").textContent).toBe("error"));
    expect(screen.getByTestId("connection-error").textContent).toBe("health timeout");
    expect(screen.getByTestId("backend-capability").textContent).toBe("error");

    fireEvent.click(screen.getByRole("button", { name: "retry-runtime" }));

    await waitFor(() => expect(screen.getByTestId("connection-status-value").textContent).toBe("ready"));
    expect(starter).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("backend-capability").textContent).toBe("ready");
  });

  it("keeps backend ready and records a top-level agent warmup failure", async () => {
    const starter = vi.fn<() => Promise<AgentConnection>>().mockResolvedValue({
      host: "127.0.0.1",
      port: 9234,
      base_url: "http://127.0.0.1:9234",
      data_dir: "D:/Keydex",
    });
    const runtime = {
      health: vi.fn().mockResolvedValue({
        status: "ok",
        version: "0.1.0",
        agent_status: "failed",
        agent_error: "langchain import failed",
        agent_warmup_duration_ms: 123,
      }),
    } as unknown as RuntimeBridge;

    render(
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={starter}
        isDesktopRuntime={() => true}
      >
        <RuntimeProbe />
      </RuntimeConnectionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("connection-status-value").textContent).toBe("ready"));
    await waitFor(() => expect(screen.getByTestId("connection-error").textContent).toBe("langchain import failed"));
    expect(screen.getByTestId("backend-capability").textContent).toBe("ready");
  });
});

function RuntimeProbe() {
  const connection = useRuntimeConnection();
  const shell = useRuntimeCapability("shell");
  const backend = useRuntimeCapability("backend.http");

  return (
    <div>
      <span>{shell.ready ? "shell-ready" : "shell-blocked"}</span>
      <span data-testid="connection-status-value">{connection.status}</span>
      <span data-testid="backend-capability">{backend.state}</span>
      <span data-testid="connection-error">{connection.error?.message ?? ""}</span>
      <button type="button" onClick={connection.retry}>
        retry-runtime
      </button>
    </div>
  );
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
