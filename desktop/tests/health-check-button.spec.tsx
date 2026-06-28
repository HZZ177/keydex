import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ModelHealth, ModelProvider, RuntimeBridge } from "@/runtime";
import { HealthCheckButton } from "@/renderer/pages/settings/model";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";

describe("HealthCheckButton", () => {
  it("runs health check and displays healthy latency", async () => {
    const health: ModelHealth = {
      status: "healthy",
      latency_ms: 42,
      error: null,
      checked_at: "2026-06-17T12:00:00Z",
    };
    const updated = provider({ health: { "qwen3-coder": health } });
    const runtime = fakeRuntime({
      checkModelHealth: vi.fn().mockResolvedValue({ provider: updated, health }),
    });
    const onProviderChange = vi.fn();

    renderHealthCheckButton(
      <HealthCheckButton
        model="qwen3-coder"
        onProviderChange={onProviderChange}
        providerId="provider-1"
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "检查 qwen3-coder 健康状态" }));

    await waitFor(() => {
      expect(runtime.models.checkModelHealth).toHaveBeenCalledWith("provider-1", "qwen3-coder");
    });
    expect(screen.getByText("健康 42ms")).not.toBeNull();
    expect(onProviderChange).toHaveBeenCalledWith(updated);
  });

  it("displays unhealthy provider error returned by backend", async () => {
    const health: ModelHealth = {
      status: "unhealthy",
      latency_ms: 12,
      error: "模型健康检查失败：HTTP 401：invalid key",
      checked_at: "2026-06-17T12:00:00Z",
    };
    const runtime = fakeRuntime({
      checkModelHealth: vi.fn().mockResolvedValue({ provider: provider(), health }),
    });

    renderHealthCheckButton(
      <HealthCheckButton
        model="qwen3-coder"
        onProviderChange={vi.fn()}
        providerId="provider-1"
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "检查 qwen3-coder 健康状态" }));

    expect(await screen.findByText("异常 12ms")).not.toBeNull();
    expect(screen.getByText("模型健康检查失败：HTTP 401：invalid key")).not.toBeNull();
  });

  it("shows request errors when backend health endpoint fails", async () => {
    const runtime = fakeRuntime({
      checkModelHealth: vi.fn().mockRejectedValue(new Error("供应商不存在")),
    });

    renderHealthCheckButton(
      <HealthCheckButton
        model="qwen3-coder"
        onProviderChange={vi.fn()}
        providerId="missing-provider"
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "检查 qwen3-coder 健康状态" }));

    expect((await screen.findByRole("alert")).textContent).toBe("供应商不存在");
  });
});

function renderHealthCheckButton(ui: ReactElement) {
  return render(<NotificationProvider>{ui}</NotificationProvider>);
}

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "provider-1",
    name: "默认模型服务",
    base_url: "https://api.example.com/v1",
    enabled: true,
    api_key_set: true,
    api_key_preview: "sk-***abcd",
    models: ["qwen3-coder"],
    model_enabled: {},
    health: {},
    ...overrides,
  };
}

function fakeRuntime(overrides: Partial<RuntimeBridge["models"]> = {}): RuntimeBridge {
  return {
    models: {
      checkModelHealth: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
}
