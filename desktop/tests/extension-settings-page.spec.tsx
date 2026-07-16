import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ExtensionSettingsPage } from "@/renderer/pages/settings/extensions";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import type { UpdateWebSettingsPayload, WebSettingsResponse } from "@/runtime/settings";
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
    expect(screen.getByText(/图表、选择、表单、可编辑表格/)).not.toBeNull();
    expect(screen.getByRole("switch", { name: "启用 A2UI" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "显示 A2UI 调试入口" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/schema/i)).toBeNull();
    expect(screen.queryByText(/render_key/i)).toBeNull();
    expect(screen.queryByText("固定策略")).toBeNull();
    expect(screen.queryByText("保留最近 2 轮")).toBeNull();
    expect(screen.queryByText("紧急压缩 90%")).toBeNull();
    expect(screen.queryByLabelText("紧急阈值")).toBeNull();
    expect(screen.queryByLabelText("保留轮数")).toBeNull();
    expect(screen.getByText("约 204,800 token 时自动压缩上下文")).not.toBeNull();
    expect(screen.queryByText("快速模型未配置，标题生成不可用")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("automatically coalesces extension setting changes", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const runtime = fakeRuntime({ saveExtensionSettings, fastConfigured: true });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("标题生成");
    fireEvent.click(screen.getByRole("switch", { name: "启用标题生成" }));
    fireEvent.change(screen.getByLabelText("期望标题最大长度"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("连续重复阈值"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("模型上下文窗口"), { target: { value: "64000" } });
    const triggerSlider = screen.getByRole("slider", { name: "触发阈值" });
    fireEvent.keyDown(triggerSlider, { key: "PageDown" });
    for (let index = 0; index < 5; index += 1) {
      fireEvent.keyDown(triggerSlider, { key: "ArrowLeft" });
    }
    await waitFor(() => {
      expect(saveExtensionSettings).toHaveBeenLastCalledWith({
        file_edit_tool_style: "claude_code",
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
          trigger_fraction: 0.65,
        },
        a2ui: {
          enabled: true,
          debug_info_enabled: false,
        },
      });
    });
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("keeps Web credentials staged until they are saved", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const saveWebSettings = vi.fn(async (_payload: UpdateWebSettingsPayload) => webSettingsResponse());
    const runtime = fakeRuntime({
      saveExtensionSettings,
      saveWebSettings,
      webResponse: webSettingsResponse(),
    });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByRole("heading", { name: "网络搜索" });
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "new-secret" } });
    expect(screen.getByRole("button", { name: "保存" })).not.toBeNull();
    expect(saveExtensionSettings).not.toHaveBeenCalled();
    expect(saveWebSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveExtensionSettings).not.toHaveBeenCalled();
      expect(runtime.settings.checkWebProvider).not.toHaveBeenCalled();
      expect(saveWebSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          providers: expect.objectContaining({
            tavily: expect.objectContaining({
              secrets: { api_key: { action: "set", value: "new-secret" } },
            }),
          }),
        }),
      );
    });
  });

  it("opens first-time Web configuration without validating or persisting", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const saveWebSettings = vi.fn(async (_payload: UpdateWebSettingsPayload) => webSettingsResponse());
    const runtime = fakeRuntime({
      saveExtensionSettings,
      saveWebSettings,
      webResponse: webSettingsResponse(),
    });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByRole("heading", { name: "网络搜索" });
    fireEvent.click(screen.getByRole("switch", { name: "启用网络搜索" }));
    expect(screen.getByTestId("web-settings-section").querySelector('[role="alert"]')).toBeNull();
    expect(screen.queryByText("配置会从下一轮对话开始生效，不会中断当前回答。")).toBeNull();
    expect(await screen.findByText("请先填写 API Key，配置完整后即可保存并启用。")).not.toBeNull();
    expect(screen.getByLabelText("API Key")).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存并启用" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("switch", { name: "启用网络搜索" }).getAttribute("aria-checked")).toBe("false");
    expect(runtime.settings.checkWebProvider).not.toHaveBeenCalled();
    expect(saveExtensionSettings).not.toHaveBeenCalled();
    expect(saveWebSettings).not.toHaveBeenCalled();
  });

  it("saves and restores the built-in A2UI switch without custom configuration fields", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const runtime = fakeRuntime({
      saveExtensionSettings,
      settings: {
        a2ui: { enabled: false, debug_info_enabled: false },
      },
    });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("A2UI 交互组件");
    expect(screen.getByRole("switch", { name: "启用 A2UI" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "显示 A2UI 调试入口" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/关闭后只影响后续新对话能力/)).not.toBeNull();
    expect(screen.getByText("图表")).not.toBeNull();
    expect(screen.getByText("选择")).not.toBeNull();
    expect(screen.getByText("表单")).not.toBeNull();
    expect(screen.queryByLabelText(/schema/i)).toBeNull();
    expect(screen.queryByLabelText(/render_key/i)).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "启用 A2UI" }));
    fireEvent.click(screen.getByRole("switch", { name: "显示 A2UI 调试入口" }));

    await waitFor(() => {
      expect(saveExtensionSettings).toHaveBeenLastCalledWith({
        ...defaultExtensionSettings(),
        a2ui: { enabled: true, debug_info_enabled: true },
      });
    });
  });

  it("saves disabled switch states immediately", async () => {
    const saveExtensionSettings = vi.fn((payload: AgentRuntimeSettings) => Promise.resolve(payload));
    const runtime = fakeRuntime({ saveExtensionSettings, fastConfigured: true });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("重复工具调用保护");
    fireEvent.click(screen.getByRole("switch", { name: "启用重复保护" }));

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

  it("rolls back an automatic extension setting change when persistence fails", async () => {
    const saveExtensionSettings = vi.fn().mockRejectedValue(new Error("扩展功能保存失败"));
    const runtime = fakeRuntime({ saveExtensionSettings, fastConfigured: true });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("重复工具调用保护");
    const toggle = screen.getByRole("switch", { name: "启用重复保护" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    expect(await screen.findByText("扩展功能保存失败")).not.toBeNull();
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
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
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
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

    expect(screen.getByRole("alert").textContent).toContain("默认对话模型未配置，上下文压缩不可用");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "配置模型" }));

    expect(saveExtensionSettings).not.toHaveBeenCalled();
    expect(onOpenModelConfig).toHaveBeenCalledTimes(1);
  });

  it("does not apply an invalid title length", async () => {
    const saveExtensionSettings = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("标题生成");
    fireEvent.change(screen.getByLabelText("期望标题最大长度"), { target: { value: "51" } });

    expect(screen.getByText("期望标题最大长度必须在 4 到 50 之间")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(saveExtensionSettings).not.toHaveBeenCalled();
  });

  it("does not apply an invalid duplicate guard threshold", async () => {
    const saveExtensionSettings = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("重复工具调用保护");
    fireEvent.change(screen.getByLabelText("连续重复阈值"), { target: { value: "0" } });

    expect(screen.getByText("连续重复阈值必须在 1 到 20 之间")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(saveExtensionSettings).not.toHaveBeenCalled();
  });

  it("does not rewrite a saved invalid compression trigger until it is corrected", async () => {
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
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(saveExtensionSettings).not.toHaveBeenCalled();
  });

  it("does not apply an invalid context compression window", async () => {
    const saveExtensionSettings = vi.fn();
    const runtime = fakeRuntime({ saveExtensionSettings });

    renderWithNotifications(<ExtensionSettingsPage runtime={runtime} />);

    await screen.findByText("上下文压缩");
    fireEvent.change(screen.getByLabelText("模型上下文窗口"), { target: { value: "999" } });

    expect(screen.getByText("上下文窗口必须在 1000 到 2000000 token 之间")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
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
  saveWebSettings = vi.fn(async (_payload: UpdateWebSettingsPayload) => webSettingsResponse()),
  settings = {},
  webResponse,
}: {
  fastConfigured?: boolean;
  defaultChatConfigured?: boolean;
  saveExtensionSettings?: (payload: AgentRuntimeSettings) => Promise<AgentRuntimeSettings>;
  saveWebSettings?: (payload: UpdateWebSettingsPayload) => Promise<WebSettingsResponse>;
  settings?: Partial<AgentRuntimeSettings>;
  webResponse?: WebSettingsResponse;
} = {}): RuntimeBridge {
  const extensionSettings = mergeSettings(defaultExtensionSettings(), settings);
  return {
    settings: {
      getExtensionSettings: vi.fn().mockResolvedValue(extensionSettings),
      saveExtensionSettings,
      getModelDefaults: vi.fn().mockResolvedValue(modelDefaultsResponse(fastConfigured, defaultChatConfigured)),
      ...(webResponse
        ? {
            checkWebProvider: vi.fn(async (providerId: string) => ({
              provider_id: providerId,
              ok: true,
              duration_ms: 20,
              error: null,
            })),
            getWebSettings: vi.fn().mockResolvedValue(webResponse),
            saveWebSettings,
          }
        : {}),
    },
  } as unknown as RuntimeBridge;
}

function webSettingsResponse(): WebSettingsResponse {
  return {
    enabled: false,
    active_provider_id: "tavily",
    active_provider_known: true,
    providers: [
      {
        provider_id: "tavily",
        display_name: "Tavily",
        description: "网络搜索与网页读取",
        capabilities: ["search", "fetch"],
        config_fields: [
          {
            key: "api_key",
            field_type: "secret",
            label: "API Key",
            required: true,
            placeholder: "请输入 Tavily API Key",
            help_text: "仅保存在当前 Keydex 本地数据库中。",
            default: null,
            options: [],
          },
        ],
        credential_setup: null,
        config: {},
        secrets: { api_key: { configured: false, preview: null } },
        configured: false,
        config_status: "incomplete",
        connection_status: "unchecked",
      },
    ],
  };
}

function mergeSettings(
  base: AgentRuntimeSettings,
  patch: Partial<AgentRuntimeSettings>,
): AgentRuntimeSettings {
  return {
    file_edit_tool_style: patch.file_edit_tool_style ?? base.file_edit_tool_style,
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
    file_edit_tool_style: "claude_code",
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
      enabled: true,
      context_window_tokens: 256000,
      trigger_fraction: 0.8,
    },
    a2ui: {
      enabled: true,
      debug_info_enabled: false,
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
