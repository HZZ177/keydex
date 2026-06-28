import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import { ModelSettingsPage } from "@/renderer/pages/settings/model";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";

describe("ModelSettingsPage", () => {
  it("renders provider cards collapsed with model and key state available after expansion", async () => {
    const runtime = fakeRuntime([
      {
        id: "openai-compatible",
        name: "默认模型服务",
        base_url: "https://api.example.com/v1",
        enabled: true,
        api_key_set: true,
        api_key_preview: "sk-***abcd",
        models: ["qwen3-coder", "deepseek-coder", "disabled-model"],
        model_enabled: { "disabled-model": false },
        health: {},
      },
    ]);

    renderWithNotifications(<ModelSettingsPage runtime={runtime} />);

    expect(screen.getByRole("heading", { name: "供应商配置" })).not.toBeNull();
    const providerName = await screen.findByText("默认模型服务");
    expect(screen.getByText("https://api.example.com/v1")).not.toBeNull();
    expect(screen.getByText("3 个模型")).not.toBeNull();
    expect(screen.getByText("2 个启用")).not.toBeNull();
    expect(screen.queryByText("密钥")).toBeNull();
    expect(screen.queryByText("qwen3-coder")).toBeNull();

    fireEvent.click(providerName.closest("button") as HTMLButtonElement);

    expect(screen.getByText("密钥")).not.toBeNull();
    expect(screen.getByText("sk-***abcd")).not.toBeNull();
    expect(screen.getAllByText("qwen3-coder")).not.toHaveLength(0);
    expect(screen.getByText("deepseek-coder")).not.toBeNull();
    expect(screen.getByLabelText("默认模型服务 启用状态")).not.toBeNull();
  });

  it("supports collapsed provider cards", async () => {
    const runtime = fakeRuntime([
      {
        id: "provider-1",
        name: "Provider One",
        base_url: "https://api.example.com/v1",
        enabled: false,
        api_key_set: false,
        api_key_preview: null,
        models: ["model-a"],
        model_enabled: {},
        health: {},
      },
    ]);

    renderWithNotifications(<ModelSettingsPage runtime={runtime} />);

    const providerName = await screen.findByText("Provider One");
    const cardHeader = providerName.closest("button") as HTMLButtonElement;
    expect(cardHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("model-a")).toBeNull();

    fireEvent.click(cardHeader);

    expect(screen.getByText("model-a")).not.toBeNull();
    expect(cardHeader.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(cardHeader);

    expect(screen.queryByText("model-a")).toBeNull();
    expect(cardHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles provider enabled state without expanding the provider card", async () => {
    const updated = provider({ enabled: false });
    const runtime = fakeRuntime([provider()], { updateProvider: vi.fn().mockResolvedValue(updated) });

    renderWithNotifications(<ModelSettingsPage runtime={runtime} />);

    const providerName = await screen.findByText("默认模型服务");
    const cardHeader = providerName.closest("button") as HTMLButtonElement;
    expect(cardHeader.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("switch", { name: "默认模型服务 启用状态" }));

    await waitFor(() => {
      expect(runtime.models.updateProvider).toHaveBeenCalledWith("provider-1", { enabled: false });
    });
    expect(cardHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("密钥")).toBeNull();
    expect(screen.getByRole("switch", { name: "默认模型服务 启用状态" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("renders empty state and create action", async () => {
    const onCreateProvider = vi.fn();
    const runtime = fakeRuntime([]);

    renderWithNotifications(<ModelSettingsPage runtime={runtime} onCreateProvider={onCreateProvider} />);

    expect(await screen.findByText("暂无供应商")).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "新增供应商" })[0]);

    expect(onCreateProvider).toHaveBeenCalledTimes(1);
  });

  it("does not expose manual typewriter speed settings", async () => {
    const runtime = fakeRuntime([]);

    renderWithNotifications(<ModelSettingsPage runtime={runtime} />);

    await screen.findByText("暂无供应商");
    expect(screen.queryByLabelText("打字机速度")).toBeNull();
    expect(screen.queryByText("基础输出速度，积压内容较多时自动加速")).toBeNull();
  });

  it("renders backend errors without fallback provider data", async () => {
    const runtime = {
      models: {
        listProviders: vi.fn().mockRejectedValue(new Error("供应商接口不可用")),
      },
    } as unknown as RuntimeBridge;

    renderWithNotifications(<ModelSettingsPage runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toBe("供应商接口不可用");
    await waitFor(() => {
      expect(screen.queryByTestId("provider-card")).toBeNull();
    });
  });

  it("keeps saved key and local models visible when refresh fails", async () => {
    const runtime = fakeRuntime(
      [
        provider({
          api_key_set: true,
          api_key_preview: "sk-***abcd",
          models: ["qwen3-coder"],
        }),
      ],
      { refreshProviderModels: vi.fn().mockRejectedValue(new Error("模型刷新失败：HTTP 401")) },
    );

    renderWithNotifications(<ModelSettingsPage runtime={runtime} />);

    const providerName = await screen.findByText("默认模型服务");
    fireEvent.click(providerName.closest("button") as HTMLButtonElement);
    expect(await screen.findByText("sk-***abcd")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));

    expect((await screen.findByRole("alert")).textContent).toBe("模型刷新失败：HTTP 401");
    expect(screen.getByText("sk-***abcd")).not.toBeNull();
    expect(screen.getAllByText("qwen3-coder")).not.toHaveLength(0);
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
    ...overrides,
  };
}

function renderWithNotifications(ui: ReactElement) {
  return render(<NotificationProvider>{ui}</NotificationProvider>);
}

function fakeRuntime(
  providers: ModelProvider[],
  overrides: Partial<RuntimeBridge["models"]> = {},
): RuntimeBridge {
  return {
    models: {
      listProviders: vi.fn().mockResolvedValue(providers),
      refreshProviderModels: vi.fn(),
      updateProvider: vi.fn(),
      checkModelHealth: vi.fn(),
      ...overrides,
    },
  } as unknown as RuntimeBridge;
}
