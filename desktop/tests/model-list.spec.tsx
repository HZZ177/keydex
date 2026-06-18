import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import { ModelList } from "@/renderer/pages/settings/model";

describe("ModelList", () => {
  it("refreshes models through the runtime provider API", async () => {
    const updated = provider({ models: ["qwen3-coder", "deepseek-coder"], default_model: "qwen3-coder" });
    const runtime = fakeRuntime({ refreshProviderModels: vi.fn().mockResolvedValue(updated) });
    const onProviderChange = vi.fn();

    render(<ModelList onProviderChange={onProviderChange} provider={provider({ models: [] })} runtime={runtime} />);

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));

    await waitFor(() => {
      expect(runtime.models.refreshProviderModels).toHaveBeenCalledWith("provider-1");
    });
    expect(onProviderChange).toHaveBeenCalledWith(updated);
  });

  it("filters refreshed model list by search keyword", () => {
    render(
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

    render(
      <ModelList
        onProviderChange={onProviderChange}
        provider={provider({ models: ["qwen3-coder", "deepseek-chat"], default_model: "qwen3-coder" })}
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

  it("blocks disabling the current default model", () => {
    const runtime = fakeRuntime();

    render(
      <ModelList
        onProviderChange={vi.fn()}
        provider={provider({ models: ["qwen3-coder"], default_model: "qwen3-coder" })}
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "停用 qwen3-coder" }));

    expect(screen.getByRole("alert").textContent).toBe("默认模型不能停用，请先切换默认模型");
    expect(runtime.models.updateProvider).not.toHaveBeenCalled();
  });

  it("sets default model only from enabled models", async () => {
    const updated = provider({ default_model: "deepseek-chat" });
    const runtime = fakeRuntime({ setDefaultModel: vi.fn().mockResolvedValue(updated) });
    const onProviderChange = vi.fn();

    render(
      <ModelList
        onProviderChange={onProviderChange}
        provider={provider({
          models: ["qwen3-coder", "deepseek-chat", "disabled-model"],
          model_enabled: { "disabled-model": false },
          default_model: "qwen3-coder",
        })}
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "设为默认 deepseek-chat" }));

    await waitFor(() => {
      expect(runtime.models.setDefaultModel).toHaveBeenCalledWith("provider-1", "deepseek-chat");
    });
    expect((screen.getByRole("button", { name: "设为默认 disabled-model" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onProviderChange).toHaveBeenCalledWith(updated);
  });

  it("shows refresh errors without changing local data", async () => {
    const runtime = fakeRuntime({
      refreshProviderModels: vi.fn().mockRejectedValue(new Error("模型刷新失败：HTTP 401")),
    });

    render(
      <ModelList
        onProviderChange={vi.fn()}
        provider={provider({ models: ["qwen3-coder"], default_model: "qwen3-coder" })}
        runtime={runtime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));

    expect((await screen.findByRole("alert")).textContent).toBe("模型刷新失败：HTTP 401");
    expect(screen.getByText("qwen3-coder")).not.toBeNull();
  });
});

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
    default_model: null,
    ...overrides,
  };
}

function fakeRuntime(overrides: Partial<RuntimeBridge["models"]> = {}): RuntimeBridge {
  return {
    models: {
      refreshProviderModels: vi.fn(),
      updateProvider: vi.fn(),
      setDefaultModel: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
}
