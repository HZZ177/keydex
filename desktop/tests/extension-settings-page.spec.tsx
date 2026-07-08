import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ExtensionSettingsPage } from "@/renderer/pages/settings/extensions";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import type { AgentRuntimeSettings, ModelDefaultsResponse } from "@/types/protocol";

describe("ExtensionSettingsPage", () => {
  it("loads extension settings with Codex-style switches", async () => {
    const runtime = fakeRuntime({
      settings: {
        auto_title: { enabled: true, only_when_default_title: true, max_title_length: 48 },
      },
      fastConfigured: true,
    });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    expect(await screen.findByRole("heading", { name: "扩展功能" })).not.toBeNull();
    expect(screen.getByText("功能模块")).not.toBeNull();
    expect(screen.getByText("标题生成")).not.toBeNull();
    expect(screen.getByRole("switch", { name: "启用标题生成" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: "仅默认标题时生成" })).toBeNull();
    expect(screen.getByText("期望标题最大长度")).not.toBeNull();
    expect(screen.getByLabelText("期望标题最大长度")).toHaveProperty("value", "48");
    expect(screen.getByText("模型上下文窗口")).not.toBeNull();
    expect(screen.getByText("A2UI 交互组件")).not.toBeNull();
    expect(screen.getByText(/确认、选择、表单、图表/)).not.toBeNull();
    expect(screen.getByRole("switch", { name: "启用 A2UI" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/schema/i)).toBeNull();
    expect(screen.queryByText(/render_key/i)).toBeNull();
    expect(screen.queryByText("固定策略")).toBeNull();
    expect(screen.queryByText("保留最近 2 轮")).toBeNull();
    expect(screen.queryByText("紧急压缩 90%")).toBeNull();
    expect(screen.queryByLabelText("紧急阈值")).toBeNull();
    expect(screen.queryByLabelText("保留轮数")).toBeNull();
    expect(screen.getByText("约 96,000 token 时自动压缩上下文")).not.toBeNull();
    expect(screen.queryByText("快速模型未配置，标题生成不可用")).toBeNull();
    expect(screen.getAllByRole("button", { name: "保存" })).toHaveLength(1);
  });

  it("saves the whole extension settings page in one request", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const runtime = fakeRuntime({ saveExtensionSettings, fastConfigured: true });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("标题生成");
    fireEvent.click(screen.getByRole("switch", { name: "启用标题生成" }));
    fireEvent.change(screen.getByLabelText("期望标题最大长度"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("连续重复阈值"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("switch", { name: "启用上下文压缩" }));
    fireEvent.change(screen.getByLabelText("模型上下文窗口"), { target: { value: "64000" } });
    const triggerSlider = screen.getByRole("slider", { name: "触发阈值" });
    fireEvent.keyDown(triggerSlider, { key: "PageDown" });
    for (let index = 0; index < 5; index += 1) {
      fireEvent.keyDown(triggerSlider, { key: "ArrowLeft" });
    }
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveExtensionSettings).toHaveBeenCalledTimes(1);
      expect(saveExtensionSettings).toHaveBeenCalledWith({
        auto_title: {
          enabled: true,
          only_when_default_title: true,
          max_title_length: 50,
        },
        duplicate_tool_call_guard: {
          enabled: true,
          max_repeats: 5,
        },
        context_compression: {
          enabled: true,
          context_window_tokens: 64000,
          trigger_fraction: 0.6,
        },
        a2ui: {
          enabled: true,
        },
      });
    });
    expect(await screen.findByText("扩展功能配置已保存")).not.toBeNull();
  });

  it("saves and restores the built-in A2UI switch without custom configuration fields", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const runtime = fakeRuntime({
      saveExtensionSettings,
      settings: {
        a2ui: { enabled: false },
      },
    });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("A2UI 交互组件");
    expect(screen.getByRole("switch", { name: "启用 A2UI" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/关闭后只影响后续新对话能力/)).not.toBeNull();
    expect(screen.getByText("确认")).not.toBeNull();
    expect(screen.getByText("选择")).not.toBeNull();
    expect(screen.getByText("表单")).not.toBeNull();
    expect(screen.getByText("图表")).not.toBeNull();
    expect(screen.queryByLabelText(/schema/i)).toBeNull();
    expect(screen.queryByLabelText(/render_key/i)).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "启用 A2UI" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveExtensionSettings).toHaveBeenCalledWith({
        ...defaultExtensionSettings(),
        a2ui: { enabled: true },
      });
    });
  });

  it("saves disabled switch states through the page-level save button", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const runtime = fakeRuntime({ saveExtensionSettings, fastConfigured: true });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("重复工具调用保护");
    fireEvent.click(screen.getByRole("switch", { name: "启用重复保护" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveExtensionSettings).toHaveBeenCalledWith({
        ...defaultExtensionSettings(),
        duplicate_tool_call_guard: {
          enabled: false,
          max_repeats: 3,
        },
      });
    });
  });

  it("blocks enabling title generation when fast model is missing", async () => {
    const saveExtensionSettings = vi.fn();
    const onOpenModelConfig = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings, fastConfigured: false });

    renderWithNotifications(
      <ExtensionSettingsPage runtime={runtime} onOpenModelConfig={onOpenModelConfig} />,
    );

    await screen.findByText("标题生成");
    fireEvent.click(screen.getByRole("switch", { name: "启用标题生成" }));

    expect(screen.getByRole("alert").textContent).toContain("快速模型未配置，标题生成不可用");
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "配置模型" }));

    expect(saveExtensionSettings).not.toHaveBeenCalled();
    expect(onOpenModelConfig).toHaveBeenCalledTimes(1);
  });

  it("blocks enabling context compression when the default chat model is missing", async () => {
    const saveExtensionSettings = vi.fn();
    const onOpenModelConfig = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings, defaultChatConfigured: false });

    renderWithNotifications(
      <ExtensionSettingsPage runtime={runtime} onOpenModelConfig={onOpenModelConfig} />,
    );

    await screen.findByText("上下文压缩");
    fireEvent.click(screen.getByRole("switch", { name: "启用上下文压缩" }));

    expect(screen.getByRole("alert").textContent).toContain("默认对话模型未配置，上下文压缩不可用");
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "配置模型" }));

    expect(saveExtensionSettings).not.toHaveBeenCalled();
    expect(onOpenModelConfig).toHaveBeenCalledTimes(1);
  });

  it("disables page save when title length is invalid", async () => {
    const saveExtensionSettings = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("标题生成");
    fireEvent.change(screen.getByLabelText("期望标题最大长度"), { target: { value: "51" } });

    expect(screen.getByText("期望标题最大长度必须在 4 到 50 之间")).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    expect(saveExtensionSettings).not.toHaveBeenCalled();
  });

  it("disables page save when duplicate guard threshold is invalid", async () => {
    const saveExtensionSettings = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("重复工具调用保护");
    fireEvent.change(screen.getByLabelText("连续重复阈值"), { target: { value: "0" } });

    expect(screen.getByText("连续重复阈值必须在 1 到 20 之间")).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    expect(saveExtensionSettings).not.toHaveBeenCalled();
  });

  it("disables page save when a saved context compression trigger exceeds the allowed threshold", async () => {
    const saveExtensionSettings = vi.fn();
    const runtime = fakeRuntime({
      saveExtensionSettings,
      settings: {
        context_compression: {
          enabled: false,
          context_window_tokens: 128000,
          trigger_fraction: 1,
        },
      },
    });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("上下文压缩");

    expect(screen.getByText("触发阈值必须在 10% 到 95% 之间")).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    expect(saveExtensionSettings).not.toHaveBeenCalled();
  });

  it("disables page save when context compression window is invalid", async () => {
    const saveExtensionSettings = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("上下文压缩");
    fireEvent.change(screen.getByLabelText("模型上下文窗口"), { target: { value: "999" } });

    expect(screen.getByText("上下文窗口必须在 1000 到 2000000 token 之间")).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    expect(saveExtensionSettings).not.toHaveBeenCalled();
  });
});

function renderWithNotifications(ui: ReactElement) {
  return render(<NotificationProvider>{ui}</NotificationProvider>);
}

function fakeRuntime({
  fastConfigured = true,
  defaultChatConfigured = true,
  saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload)),
  settings = {},
}: {
  fastConfigured?: boolean;
  defaultChatConfigured?: boolean;
  saveExtensionSettings?: (payload: AgentRuntimeSettings) => Promise<AgentRuntimeSettings>;
  settings?: Partial<AgentRuntimeSettings>;
} = {}): RuntimeBridge {
  const extensionSettings = mergeSettings(defaultExtensionSettings(), settings);
  return {
    settings: {
      getExtensionSettings: vi.fn().mockResolvedValue(extensionSettings),
      saveExtensionSettings,
      getModelDefaults: vi.fn().mockResolvedValue(modelDefaultsResponse(fastConfigured, defaultChatConfigured)),
    },
  } as unknown as RuntimeBridge;
}

function mergeSettings(
  base: AgentRuntimeSettings,
  patch: Partial<AgentRuntimeSettings>,
): AgentRuntimeSettings {
  return {
    auto_title: { ...base.auto_title, ...patch.auto_title },
    duplicate_tool_call_guard: {
      ...base.duplicate_tool_call_guard,
      ...patch.duplicate_tool_call_guard,
    },
    context_compression: { ...base.context_compression, ...patch.context_compression },
    a2ui: { ...base.a2ui, ...patch.a2ui },
  };
}

function defaultExtensionSettings(): AgentRuntimeSettings {
  return {
    auto_title: {
      enabled: false,
      only_when_default_title: true,
      max_title_length: 20,
    },
    duplicate_tool_call_guard: {
      enabled: true,
      max_repeats: 3,
    },
    context_compression: {
      enabled: false,
      context_window_tokens: 128000,
      trigger_fraction: 0.75,
    },
    a2ui: {
      enabled: true,
    },
  };
}

function modelDefaultsResponse(fastConfigured: boolean, defaultChatConfigured: boolean): ModelDefaultsResponse {
  return {
    defaults: {
      default_chat: {
        scope: "default_chat",
        configured: defaultChatConfigured,
        provider_id: defaultChatConfigured ? "provider-main" : null,
        provider_name: defaultChatConfigured ? "默认供应商" : null,
        model: defaultChatConfigured ? "qwen-coder" : null,
        provider_enabled: defaultChatConfigured ? true : null,
        model_enabled: defaultChatConfigured ? true : null,
        missing_reason: defaultChatConfigured ? null : "not_configured",
      },
      fast: {
        scope: "fast",
        configured: fastConfigured,
        provider_id: fastConfigured ? "provider-fast" : null,
        provider_name: fastConfigured ? "快速供应商" : null,
        model: fastConfigured ? "fast-title" : null,
        provider_enabled: fastConfigured ? true : null,
        model_enabled: fastConfigured ? true : null,
        missing_reason: fastConfigured ? null : "not_configured",
      },
    },
  };
}
