import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, RuntimeBridge } from "@/runtime";
import { ModelDefaultSettingsPage } from "@/renderer/pages/settings/modelDefaults";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { ModelDefaultsResponse, UpdateModelDefaultsPayload } from "@/types/protocol";

describe("ModelDefaultSettingsPage", () => {
  it("renders empty provider state with provider settings action", async () => {
    const onOpenProviderSettings = vi.fn();
    const runtime = fakeRuntime([]);

    renderWithNotifications(
      <ModelDefaultSettingsPage runtime={runtime} onOpenProviderSettings={onOpenProviderSettings} />,
    );

    expect(await screen.findByRole("heading", { name: "模型配置" })).not.toBeNull();
    expect(screen.getByText("暂无供应商配置")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "配置供应商" }));

    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
  });

  it("renders model default shell when providers exist", async () => {
    const runtime = fakeRuntime([
      provider({
        enabled: true,
        models: ["qwen-coder", "fast-title", "disabled-model"],
        model_enabled: { "disabled-model": false },
      }),
    ]);

    renderWithNotifications(<ModelDefaultSettingsPage runtime={runtime} />);

    expect(await screen.findByText("默认值")).not.toBeNull();
    expect(screen.getByText("1 个供应商 · 2 个可用模型")).not.toBeNull();
    expect(screen.getByText("默认对话模型")).not.toBeNull();
    expect(screen.getByText("快速模型")).not.toBeNull();
    expect(screen.getAllByLabelText("选择模型")[0].textContent).toContain("选择模型");
    expect(screen.getAllByLabelText("选择模型")[1].textContent).toContain("不配置");
  });

  it("keeps model default dropdowns openable when no models are available", async () => {
    const onOpenProviderSettings = vi.fn();
    const runtime = fakeRuntime([provider({ models: [] })]);

    renderWithNotifications(
      <ModelDefaultSettingsPage runtime={runtime} onOpenProviderSettings={onOpenProviderSettings} />,
    );

    expect(await screen.findByText("默认值")).not.toBeNull();
    expect(screen.getByText("1 个供应商 · 0 个可用模型")).not.toBeNull();

    const trigger = screen.getAllByLabelText("选择模型")[0] as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);

    expect(screen.getByRole("listbox", { name: "默认对话模型" })).not.toBeNull();
    expect(screen.getByText("当前无可用模型，请先在")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "供应商配置页面" }));

    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
  });

  it("saves chat and fast model defaults", async () => {
    const saveModelDefaults = vi.fn((payload: UpdateModelDefaultsPayload) =>
      Promise.resolve(modelDefaultsResponse(payload.defaults.default_chat, payload.defaults.fast)),
    );
    const runtime = fakeRuntime(
      [
        provider({
          models: ["qwen-coder", "fast-title"],
        }),
      ],
      { saveModelDefaults },
    );

    renderWithNotifications(<ModelDefaultSettingsPage runtime={runtime} />);

    await screen.findByText("默认值");
    await chooseModel(0, "qwen-coder");
    await chooseModel(1, "fast-title");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveModelDefaults).toHaveBeenCalledWith({
        defaults: {
          default_chat: { provider_id: "provider-1", model: "qwen-coder" },
          fast: { provider_id: "provider-1", model: "fast-title" },
        },
      });
    });
    expect(await screen.findByText("模型配置已保存")).not.toBeNull();
  });

  it("saves an explicit null fast model default when only chat default is configured", async () => {
    const saveModelDefaults = vi.fn((payload: UpdateModelDefaultsPayload) =>
      Promise.resolve(modelDefaultsResponse(payload.defaults.default_chat, payload.defaults.fast)),
    );
    const runtime = fakeRuntime(
      [
        provider({
          models: ["qwen-coder", "fast-title"],
        }),
      ],
      { saveModelDefaults },
    );

    renderWithNotifications(<ModelDefaultSettingsPage runtime={runtime} />);

    await screen.findByText("默认值");
    await chooseModel(0, "qwen-coder");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveModelDefaults).toHaveBeenCalledWith({
        defaults: {
          default_chat: { provider_id: "provider-1", model: "qwen-coder" },
          fast: null,
        },
      });
    });
  });

  it("requires default chat model before saving", async () => {
    const saveModelDefaults = vi.fn();
    const runtime = fakeRuntime([provider()], { saveModelDefaults });

    renderWithNotifications(<ModelDefaultSettingsPage runtime={runtime} />);

    await screen.findByText("默认值");
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveModelDefaults).not.toHaveBeenCalled();
  });

  it("filters model defaults across providers with the same searchable picker as chat", async () => {
    const runtime = fakeRuntime([
      provider({ id: "provider-1", name: "默认模型服务", models: ["qwen-coder"] }),
      provider({ id: "provider-2", name: "火山模型服务", models: ["doubao-fast"] }),
    ]);

    renderWithNotifications(<ModelDefaultSettingsPage runtime={runtime} />);

    await screen.findByText("默认值");
    fireEvent.click(screen.getAllByLabelText("选择模型")[0]);
    expect(screen.getByRole("listbox", { name: "默认对话模型" })).not.toBeNull();
    expect(screen.getByText("默认模型服务")).not.toBeNull();
    expect(screen.getByText("火山模型服务")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("筛选模型"), { target: { value: "doubao" } });

    expect(screen.queryByRole("option", { name: "qwen-coder" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "doubao-fast" }));
    expect(screen.getAllByLabelText("选择模型")[0].textContent).toContain("doubao-fast");
    expect(screen.getAllByLabelText("选择模型")[0].textContent).not.toContain("火山模型服务");
  });

  it("renders provider loading errors", async () => {
    const runtime = {
      settings: {
        getModelDefaults: vi.fn().mockResolvedValue(modelDefaultsResponse()),
        saveModelDefaults: vi.fn(),
      },
      models: {
        listProviders: vi.fn().mockRejectedValue(new Error("供应商读取失败")),
      },
    } as unknown as RuntimeBridge;

    renderWithNotifications(<ModelDefaultSettingsPage runtime={runtime} />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("供应商读取失败");
    });
    expect(screen.queryByText("默认对话模型")).toBeNull();
  });
});

function renderWithNotifications(ui: ReactElement) {
  return render(<NotificationProvider>{ui}</NotificationProvider>);
}

async function chooseModel(triggerIndex: number, model: string) {
  fireEvent.click(screen.getAllByLabelText("选择模型")[triggerIndex]);
  fireEvent.click(await screen.findByRole("option", { name: model }));
}

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "provider-1",
    name: "默认模型服务",
    base_url: "https://api.example.com/v1",
    enabled: true,
    api_key_set: true,
    api_key_preview: "sk-***abcd",
    models: ["qwen-coder"],
    model_enabled: {},
    health: {},
    ...overrides,
  };
}

function fakeRuntime(
  providers: ModelProvider[],
  overrides: Partial<RuntimeBridge["settings"]> = {},
): RuntimeBridge {
  return {
    settings: {
      getModelDefaults: vi.fn().mockResolvedValue(modelDefaultsResponse()),
      saveModelDefaults: vi.fn(),
      ...overrides,
    },
    models: {
      listProviders: vi.fn().mockResolvedValue(providers),
    },
  } as unknown as RuntimeBridge;
}

function modelDefaultsResponse(
  defaultChat?: UpdateModelDefaultsPayload["defaults"]["default_chat"],
  fast?: UpdateModelDefaultsPayload["defaults"]["fast"],
): ModelDefaultsResponse {
  return {
    defaults: {
      default_chat: {
        scope: "default_chat",
        configured: Boolean(defaultChat),
        provider_id: defaultChat?.provider_id ?? null,
        provider_name: defaultChat ? "默认模型服务" : null,
        model: defaultChat?.model ?? null,
        provider_enabled: defaultChat ? true : null,
        model_enabled: defaultChat ? true : null,
        missing_reason: defaultChat ? null : "not_configured",
      },
      fast: {
        scope: "fast",
        configured: Boolean(fast),
        provider_id: fast?.provider_id ?? null,
        provider_name: fast ? "默认模型服务" : null,
        model: fast?.model ?? null,
        provider_enabled: fast ? true : null,
        model_enabled: fast ? true : null,
        missing_reason: fast ? null : "not_configured",
      },
    },
  };
}
