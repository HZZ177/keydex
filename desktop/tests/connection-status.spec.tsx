import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionStatus } from "@/renderer/components/runtime";
import { createInitialRuntimeState, runtimeReducer } from "@/renderer/stores/runtimeStore";

describe("ConnectionStatus", () => {
  it("shows local service startup as an in-app connection status", () => {
    const state = runtimeReducer(createInitialRuntimeState(), {
      type: "connection/setStatus",
      source: "health",
      status: "checking",
    });

    render(<ConnectionStatus state={state} />);

    expect(screen.getByTestId("connection-status").dataset.status).toBe("connecting");
    expect(screen.getByText("正在启动本地服务")).not.toBeNull();
  });

  it("renders the active runtime error and clears it", () => {
    const onClearError = vi.fn();
    const onRetry = vi.fn();
    const state = runtimeReducer(createInitialRuntimeState(), {
      type: "error/record",
      source: "model",
      id: "err-model",
      now: "2026-06-17T10:00:00Z",
      error: { code: "provider_error", message: "模型服务返回 400" },
    });

    render(<ConnectionStatus state={state} onClearError={onClearError} onRetry={onRetry} />);

    expect(screen.getByTestId("connection-status").dataset.status).toBe("error");
    expect(screen.getByText("模型异常")).not.toBeNull();
    expect(screen.getByText("模型服务返回 400")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("清除当前错误"));
    expect(onClearError).toHaveBeenCalledWith("err-model");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders agent warmup failures as a top-level runtime error", () => {
    const state = runtimeReducer(createInitialRuntimeState(), {
      type: "error/record",
      source: "agent",
      id: "agent:warmup",
      now: "2026-06-17T10:00:00Z",
      error: { code: "agent_warmup_failed", message: "智能体初始化失败" },
    });

    render(<ConnectionStatus state={state} />);

    expect(screen.getByTestId("connection-status").dataset.status).toBe("error");
    expect(screen.getByText("智能体异常")).not.toBeNull();
    expect(screen.getByText("智能体初始化失败")).not.toBeNull();
  });
});
