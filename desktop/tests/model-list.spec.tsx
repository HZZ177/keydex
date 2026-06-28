import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import { ModelList } from "@/renderer/pages/settings/model";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";

describe("ModelList", () => {
  it("refreshes models through the runtime provider API", async () => {
    const updated = provider({ models: ["qwen3-coder", "deepseek-coder"] });
    const runtime = fakeRuntime({ refreshProviderModels: vi.fn().mockResolvedValue(updated) });
    const onProviderChange = vi.fn();

    renderWithNotifications(
      <ModelList onProviderChange={onProviderChange} provider={provider({ models: [] })} runtime={runtime} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));

    await waitFor(() => {
      expect(runtime.models.refreshProviderModels).toHaveBeenCalledWith("provider-1");
    });
    expect(onProviderChange).toHaveBeenCalledWith(updated);
  });

  it("shows model list loading immediately while refreshing models", async () => {
    const updated = provider({ models: ["qwen3-coder", "deepseek-coder"] });
    const deferred = createDeferred<ModelProvider>();
    const runtime = fakeRuntime({ refreshProviderModels: vi.fn(() => deferred.promise) });
    const onProviderChange = vi.fn();

    renderWithNotifications(
      <ModelList
        onProviderChange={onProviderChange}
        provider={provider({ models: ["qwen3-coder"] })}
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));

    expect(screen.getByRole("status", { name: "正在刷新模型列表" })).not.toBeNull();
    expect(screen.queryByText("qwen3-coder")).toBeNull();

    await act(async () => {
      deferred.resolve(updated);
      await deferred.promise;
    });
    await waitFor(() => {
      expect(onProviderChange).toHaveBeenCalledWith(updated);
    });
  });

  it("filters refreshed model list by search keyword", () => {
    renderWithNotifications(
      <ModelList
        onProviderChange={vi.fn()}
        provider={provider({ models: ["qwen3-coder", "deepseek-chat", "gpt-4.1"] })}
        runtime={fakeRuntime()}
      />,
    );

    fireEvent.change(screen.getByLabelText("默认模型服务 搜索模型"), { target: { value: "coder" } });

    expect(screen.getByText("qwen3-coder")).not.toBeNull();
    expect(screen.queryByText("deepseek-chat")).toBeNull();
    expect(screen.queryByText("gpt-4.1")).toBeNull();
  });

  it("updates model enabled state through provider patch", async () => {
    const updated = provider({ model_enabled: { "deepseek-chat": false } });
    const runtime = fakeRuntime({ updateProvider: vi.fn().mockResolvedValue(updated) });
    const onProviderChange = vi.fn();

    renderWithNotifications(
      <ModelList
        onProviderChange={onProviderChange}
        provider={provider({ models: ["qwen3-coder", "deepseek-chat"] })}
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "停用 deepseek-chat" }));

    await waitFor(() => {
      expect(runtime.models.updateProvider).toHaveBeenCalledWith("provider-1", {
        model_enabled: { "deepseek-chat": false },
      });
    });
    expect(onProviderChange).toHaveBeenCalledWith(updated);
  });

  it("shows refresh errors without changing local data", async () => {
    const runtime = fakeRuntime({
      refreshProviderModels: vi.fn().mockRejectedValue(new Error("模型刷新失败：HTTP 401")),
    });

    renderWithNotifications(
      <ModelList
        onProviderChange={vi.fn()}
        provider={provider({ models: ["qwen3-coder"] })}
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));

    expect((await screen.findByRole("alert")).textContent).toBe("模型刷新失败：HTTP 401");
    expect(screen.getByText("qwen3-coder")).not.toBeNull();
  });
});

function renderWithNotifications(ui: ReactElement) {
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
      refreshProviderModels: vi.fn(),
      updateProvider: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
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
