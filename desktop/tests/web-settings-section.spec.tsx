import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { WebSettingsSection } from "@/renderer/pages/settings/extensions/WebSettingsSection";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import type { RuntimeBridge } from "@/runtime";
import type {
  UpdateWebSettingsPayload,
  WebConnectionCheckDraft,
  WebConnectionCheckResponse,
  WebSecretRevealResponse,
  WebSettingsResponse,
} from "@/runtime/settings";

describe("WebSettingsSection", () => {
  it("renders a compact provider-driven group without exposing tool parameters", async () => {
    renderSection(fakeRuntime());

    expect(await screen.findByRole("heading", { name: "网络搜索" })).not.toBeNull();
    expect(screen.getByText("让 Keydex 在需要时查找公开网络信息并读取网页内容")).not.toBeNull();
    expect(screen.getByRole("switch", { name: "启用网络搜索" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: "搜索引擎：Alpha" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    expect(screen.getByRole("button", { name: "搜索引擎：Alpha" })).not.toBeNull();
    expect(screen.getByLabelText("Alpha API Key").getAttribute("placeholder")).toBe("••••1234");
    expect(screen.getByLabelText("Alpha API Key").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Endpoint")).toHaveProperty("value", "https://alpha.example");
    expect(screen.getAllByText("网络搜索")).toHaveLength(2);
    expect(screen.getByText("网页读取")).not.toBeNull();
    expect(screen.getByRole("button", { name: "获取 Alpha 密钥" })).not.toBeNull();
    expect(screen.queryByText(/max_results/i)).toBeNull();
    expect(screen.queryByText(/search_depth/i)).toBeNull();
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "清除Alpha API Key" })).not.toBeNull();
    expect(screen.queryByText("密钥仅保存在当前 Keydex 本地数据库中。")).toBeNull();
    expect(screen.queryByText("不会保存当前草稿")).toBeNull();

    const panel = screen.getByTestId("web-settings-panel");
    const firstRow = panel.firstElementChild;
    expect(firstRow?.contains(screen.getByRole("heading", { name: "网络搜索" }))).toBe(true);
    expect(firstRow?.contains(screen.getByRole("switch", { name: "启用网络搜索" }))).toBe(true);
    expect(screen.getByRole("switch", { name: "启用网络搜索" }).hasAttribute("data-settings-toggle")).toBe(true);

    const secretInput = screen.getByLabelText("Alpha API Key");
    fireEvent.click(screen.getByText("Alpha API Key"));
    expect(document.activeElement).not.toBe(secretInput);
    expect(secretInput.parentElement?.parentElement?.contains(screen.getByRole("button", { name: "测试连接" }))).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "显示Alpha API Key" }));
    await waitFor(() => {
      expect(secretInput.getAttribute("type")).toBe("text");
      expect(secretInput).toHaveProperty("value", "saved-alpha-secret");
    });
    fireEvent.click(screen.getByRole("button", { name: "隐藏Alpha API Key" }));
    expect(secretInput.getAttribute("type")).toBe("password");
    expect(secretInput).toHaveProperty("value", "");
  });

  it("opens the provider-driven credential page and explains the free quota", async () => {
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => window);
    const runtime = fakeRuntime();
    renderSection(runtime);
    await openConfiguration();

    try {
      const setupButton = await screen.findByRole("button", { name: "获取 Alpha 密钥" });
      const infoButton = screen.getByRole("button", { name: "获取 Alpha 密钥额度说明" });
      expect(setupButton.nextElementSibling).toBe(infoButton);

      fireEvent.click(setupButton);
      expect(openWindow).toHaveBeenCalledWith(
        "https://alpha.example/account/keys",
        "_blank",
        "noopener,noreferrer",
      );

      fireEvent.pointerOver(infoButton);
      expect((await screen.findByRole("tooltip")).textContent).toBe(
        "Alpha 免费计划每月提供 1,000 API Credits，基础搜索每次消耗 1 Credit。",
      );

      await chooseProvider("Beta");
      expect(screen.queryByRole("button", { name: "获取 Alpha 密钥" })).toBeNull();
      expect(screen.queryByRole("button", { name: "获取 Alpha 密钥额度说明" })).toBeNull();
      expect(runtime.settings.saveWebSettings).not.toHaveBeenCalled();
    } finally {
      openWindow.mockRestore();
    }
  });

  it("shows a top notification when the credential page cannot be opened", async () => {
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    renderSection(fakeRuntime());
    await openConfiguration();

    try {
      fireEvent.click(await screen.findByRole("button", { name: "获取 Alpha 密钥" }));
      expect(await screen.findByText("浏览器阻止了新窗口，请允许 Keydex 打开外部链接")).not.toBeNull();
    } finally {
      openWindow.mockRestore();
    }
  });

  it("preserves independent provider drafts and saves only the selected provider", async () => {
    const runtime = fakeRuntime();
    renderSection(runtime);
    await openConfiguration();
    await screen.findByLabelText("Endpoint");
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://alpha-draft.example" } });

    await chooseProvider("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Region：Global" }));
    fireEvent.click(await screen.findByRole("option", { name: "Europe" }));
    await chooseProvider("Alpha");

    expect(screen.getByLabelText("Endpoint")).toHaveProperty("value", "https://alpha-draft.example");
    expect(runtime.settings.saveWebSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(runtime.settings.saveWebSettings).toHaveBeenCalledWith({
        enabled: false,
        active_provider_id: "alpha",
        providers: {
          alpha: {
            config: { endpoint: "https://alpha-draft.example" },
            secrets: { api_key: { action: "keep" } },
          },
        },
      });
    });
    expect(runtime.settings.checkWebProvider).not.toHaveBeenCalled();
    await chooseProvider("Beta");
    expect(screen.getByRole("button", { name: "Region：Europe" })).not.toBeNull();
  });

  it("loads a saved secret on demand and keeps it unchanged when saving", async () => {
    const revealWebProviderSecret = vi.fn(
      async (): Promise<WebSecretRevealResponse> => ({
        provider_id: "alpha",
        field_key: "api_key",
        value: "saved-alpha-secret",
      }),
    );
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ revealWebProviderSecret, saveWebSettings }));
    await openConfiguration();
    const input = await screen.findByLabelText("Alpha API Key");

    fireEvent.click(screen.getByRole("button", { name: "显示Alpha API Key" }));
    await waitFor(() => expect(input).toHaveProperty("value", "saved-alpha-secret"));
    expect(revealWebProviderSecret).toHaveBeenCalledWith("alpha", "api_key");

    expect(saveWebSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "隐藏Alpha API Key" }));
    expect(input).toHaveProperty("value", "");
  });

  it("keeps saved secrets by default and clears them only after confirmation", async () => {
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ saveWebSettings }));
    await openConfiguration();
    await screen.findByLabelText("Alpha API Key");

    fireEvent.click(screen.getByRole("button", { name: "清除Alpha API Key" }));
    expect(screen.getByRole("dialog").textContent).toContain("清除Alpha API Key？");
    expect(saveWebSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清除密钥" }));

    await waitFor(() => {
      expect(saveWebSettings).toHaveBeenCalledWith({
        enabled: false,
        active_provider_id: "alpha",
        providers: {
          alpha: {
            config: { endpoint: "https://alpha.example" },
            secrets: { api_key: { action: "clear" } },
          },
        },
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows loading while revealing and reports failures without exposing a value", async () => {
    let rejectReveal!: (reason: unknown) => void;
    const revealWebProviderSecret = vi.fn(
      () =>
        new Promise<WebSecretRevealResponse>((_resolve, reject) => {
          rejectReveal = reject;
        }),
    );
    renderSection(fakeRuntime({ revealWebProviderSecret }));
    await openConfiguration();
    const input = await screen.findByLabelText("Alpha API Key");
    const revealButton = screen.getByRole("button", { name: "显示Alpha API Key" });

    fireEvent.click(revealButton);
    expect(revealButton.getAttribute("aria-busy")).toBe("true");
    expect(revealButton).toHaveProperty("disabled", true);
    expect(revealButton.querySelector('[class*="loadingSpinner"]')).not.toBeNull();

    rejectReveal(new Error("读取已保存密钥失败"));

    expect(await screen.findByText("读取已保存密钥失败")).not.toBeNull();
    await waitFor(() => expect(revealButton.getAttribute("aria-busy")).toBe("false"));
    expect(input.getAttribute("type")).toBe("password");
    expect(input).toHaveProperty("value", "");
  });

  it("ignores a reveal response after a clear request opens confirmation", async () => {
    let resolveReveal!: (response: WebSecretRevealResponse) => void;
    const revealWebProviderSecret = vi.fn(
      () =>
        new Promise<WebSecretRevealResponse>((resolve) => {
          resolveReveal = resolve;
        }),
    );
    renderSection(fakeRuntime({ revealWebProviderSecret }));
    await openConfiguration();
    const input = await screen.findByLabelText("Alpha API Key");

    fireEvent.click(screen.getByRole("button", { name: "显示Alpha API Key" }));
    fireEvent.click(screen.getByRole("button", { name: "清除Alpha API Key" }));
    await act(async () => {
      resolveReveal({
        provider_id: "alpha",
        field_key: "api_key",
        value: "stale-saved-secret",
      });
    });

    expect(screen.getByRole("dialog").textContent).toContain("清除Alpha API Key？");
    expect(input.getAttribute("type")).toBe("password");
    expect(input).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "显示Alpha API Key" })).toHaveProperty("disabled", false);
  });

  it("toggles a newly typed draft locally without requesting the saved secret", async () => {
    const revealWebProviderSecret = vi.fn();
    renderSection(fakeRuntime({ revealWebProviderSecret }));
    await openConfiguration();
    const input = await screen.findByLabelText("Alpha API Key");

    fireEvent.change(input, { target: { value: "new-local-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "显示Alpha API Key" }));

    expect(input.getAttribute("type")).toBe("text");
    expect(input).toHaveProperty("value", "new-local-secret");
    expect(revealWebProviderSecret).not.toHaveBeenCalled();
  });

  it("keeps a newly typed secret local until it is saved", async () => {
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ saveWebSettings }));
    await openConfiguration();
    const input = await screen.findByLabelText("Alpha API Key");

    fireEvent.change(input, { target: { value: "new-secret" } });
    expect(saveWebSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(saveWebSettings).toHaveBeenCalledWith({
        enabled: false,
        active_provider_id: "alpha",
        providers: {
          alpha: {
            config: { endpoint: "https://alpha.example" },
            secrets: { api_key: { action: "set", value: "new-secret" } },
          },
        },
      });
    });
  });

  it("keeps the local draft available when persistence fails", async () => {
    const saveWebSettings = vi.fn().mockRejectedValue(new Error("网络搜索配置保存失败"));
    renderSection(fakeRuntime({ saveWebSettings }));
    await openConfiguration();
    const endpoint = await screen.findByLabelText("Endpoint");

    fireEvent.change(endpoint, { target: { value: "https://broken.example" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("网络搜索配置保存失败")).not.toBeNull();
    expect(endpoint).toHaveProperty("value", "https://broken.example");
  });

  it("turns a first-time enable request into configuration before saving and enabling", async () => {
    const checkWebProvider = vi.fn(async (providerId: string): Promise<WebConnectionCheckResponse> => ({
      provider_id: providerId,
      ok: true,
      duration_ms: 20,
      error: null,
    }));
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ checkWebProvider, saveWebSettings }));
    await openConfiguration();
    await screen.findByLabelText("Alpha API Key");
    await chooseProvider("Beta");

    fireEvent.click(screen.getByRole("switch", { name: "启用网络搜索" }));
    expect(screen.getByTestId("web-settings-section").querySelector('[role="alert"]')).toBeNull();
    expect(await screen.findByText("填写完成后保存配置，随后启用网络搜索。")).not.toBeNull();
    expect(screen.getByRole("switch", { name: "启用网络搜索" }).getAttribute("aria-checked")).toBe("false");
    expect(checkWebProvider).not.toHaveBeenCalled();
    expect(saveWebSettings).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Beta Token"), { target: { value: "beta-secret" } });
    expect(screen.getByTestId("web-settings-section").querySelector('[role="alert"]')).toBeNull();
    expect(saveWebSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    await waitFor(() => {
      expect(saveWebSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: true, active_provider_id: "beta" }),
      );
    });
    expect(checkWebProvider).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "启用网络搜索" }).getAttribute("aria-checked")).toBe("true");
  });

  it("enables an already saved provider without calling the validation API", async () => {
    const checkWebProvider = vi.fn();
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ checkWebProvider, saveWebSettings }));

    const toggle = await screen.findByRole("switch", { name: "启用网络搜索" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(saveWebSettings).toHaveBeenCalledWith({
        enabled: true,
        active_provider_id: "alpha",
        providers: {},
      });
    });
    expect(checkWebProvider).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Alpha API Key")).not.toBeNull();
  });

  it("disables immediately without validating or persisting staged provider drafts", async () => {
    const response = webSettings();
    response.enabled = true;
    const checkWebProvider = vi.fn();
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ checkWebProvider, response, saveWebSettings }));

    const endpoint = await screen.findByLabelText("Endpoint");
    fireEvent.change(endpoint, { target: { value: "https://unsaved.example" } });
    fireEvent.click(screen.getByRole("switch", { name: "启用网络搜索" }));

    await waitFor(() => {
      expect(saveWebSettings).toHaveBeenCalledWith({
        enabled: false,
        active_provider_id: "alpha",
        providers: {},
      });
    });
    expect(checkWebProvider).not.toHaveBeenCalled();
    expect(endpoint).toHaveProperty("value", "https://unsaved.example");
    expect(screen.getByRole("switch", { name: "启用网络搜索" }).getAttribute("aria-checked")).toBe("false");
  });

  it("atomically disables network search when clearing its active required secret", async () => {
    const response = webSettings();
    response.enabled = true;
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ response, saveWebSettings }));

    await screen.findByLabelText("Alpha API Key");
    fireEvent.click(screen.getByRole("button", { name: "清除Alpha API Key" }));
    expect(screen.getByRole("dialog").textContent).toContain("会同时关闭网络搜索");
    fireEvent.click(screen.getByRole("button", { name: "清除密钥" }));

    await waitFor(() => {
      expect(saveWebSettings).toHaveBeenCalledWith({
        enabled: false,
        active_provider_id: "alpha",
        providers: {
          alpha: {
            config: { endpoint: "https://alpha.example" },
            secrets: { api_key: { action: "clear" } },
          },
        },
      });
    });
    expect(screen.getByRole("switch", { name: "启用网络搜索" }).getAttribute("aria-checked")).toBe("false");
  });

  it("tests the current draft without saving it", async () => {
    let resolveCheck!: (response: WebConnectionCheckResponse) => void;
    const checkWebProvider = vi.fn(
      (_providerId: string, _draft?: WebConnectionCheckDraft) =>
        new Promise<WebConnectionCheckResponse>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload));
    renderSection(fakeRuntime({ checkWebProvider, saveWebSettings }));
    await openConfiguration();
    const secret = await screen.findByLabelText("Alpha API Key");
    fireEvent.change(secret, { target: { value: "draft-secret" } });

    const connectionButton = screen.getByRole("button", { name: "测试连接" });
    fireEvent.click(connectionButton);

    expect(connectionButton.getAttribute("aria-busy")).toBe("true");
    expect(connectionButton.querySelector('[class*="loadingSpinner"]')).not.toBeNull();
    expect(screen.queryByText("正在验证当前配置")).toBeNull();
    resolveCheck({ provider_id: "alpha", ok: true, duration_ms: 26, error: null });

    expect(await screen.findByText("连接正常 · 26 ms")).not.toBeNull();
    expect(screen.getByTestId("notification-viewport").textContent).toContain("连接正常 · 26 ms");
    await waitFor(() => expect(connectionButton.getAttribute("aria-busy")).toBe("false"));
    expect(checkWebProvider).toHaveBeenCalledWith("alpha", {
      config: { endpoint: "https://alpha.example" },
      secrets: { api_key: { action: "set", value: "draft-secret" } },
    });
    expect(saveWebSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["authentication_failed", "密钥无效，请检查后重试"],
    ["quota_exhausted", "当前额度已用完"],
    ["rate_limited", "请求过于频繁，可以稍后重试"],
    ["network_unavailable", "当前网络不可用，可以稍后重试"],
    ["request_timeout", "连接超时，可以稍后重试"],
  ])("maps %s connection failures to concise consumer copy", async (code, expected) => {
    const checkWebProvider = vi.fn(async (): Promise<WebConnectionCheckResponse> => ({
      provider_id: "alpha",
      ok: false,
      duration_ms: 10,
      error: {
        code,
        message: "raw provider message",
        retryable: code !== "authentication_failed" && code !== "quota_exhausted",
        provider_id: "alpha",
        retry_after_seconds: null,
      },
    }));
    renderSection(fakeRuntime({ checkWebProvider }));
    await openConfiguration();
    await screen.findByLabelText("Alpha API Key");

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText(expected)).not.toBeNull();
    expect(screen.getByTestId("notification-viewport").textContent).toContain(expected);
    expect(screen.queryByText("raw provider message")).toBeNull();
  });

  it("keeps connection results isolated per provider", async () => {
    const alphaRequest: { resolve?: (response: WebConnectionCheckResponse) => void } = {};
    const checkWebProvider = vi.fn((providerId: string) => {
      if (providerId === "alpha") {
        return new Promise<WebConnectionCheckResponse>((resolve) => {
          alphaRequest.resolve = resolve;
        });
      }
      return Promise.resolve<WebConnectionCheckResponse>({
        provider_id: "beta",
        ok: true,
        duration_ms: 8,
        error: null,
      });
    });
    renderSection(fakeRuntime({ checkWebProvider }));
    await openConfiguration();
    await screen.findByLabelText("Alpha API Key");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await chooseProvider("Beta");
    fireEvent.change(screen.getByLabelText("Beta Token"), { target: { value: "beta-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接正常 · 8 ms")).not.toBeNull();

    alphaRequest.resolve?.({ provider_id: "alpha", ok: true, duration_ms: 99, error: null });
    await waitFor(() => expect(screen.queryByText("连接正常 · 99 ms")).toBeNull());
    expect(screen.getByText("连接正常 · 8 ms")).not.toBeNull();
  });
});

function renderSection(uiRuntime: RuntimeBridge) {
  return renderWithNotifications(<WebSettingsSection runtime={uiRuntime} />);
}

function renderWithNotifications(ui: ReactElement) {
  return render(<NotificationProvider>{ui}</NotificationProvider>);
}

async function chooseProvider(label: string) {
  fireEvent.click(screen.getByRole("button", { name: /搜索引擎：/ }));
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(label) }));
}

async function openConfiguration() {
  fireEvent.click(await screen.findByRole("button", { name: "配置" }));
}

function fakeRuntime({
  checkWebProvider = vi.fn(async (): Promise<WebConnectionCheckResponse> => ({
    provider_id: "alpha",
    ok: true,
    duration_ms: 20,
    error: null,
  })),
  revealWebProviderSecret = vi.fn(
    async (): Promise<WebSecretRevealResponse> => ({
      provider_id: "alpha",
      field_key: "api_key",
      value: "saved-alpha-secret",
    }),
  ),
  response = webSettings(),
  saveWebSettings = vi.fn(async (payload: UpdateWebSettingsPayload) => webSettingsForPayload(payload)),
}: {
  checkWebProvider?: (providerId: string, draft?: WebConnectionCheckDraft) => Promise<WebConnectionCheckResponse>;
  revealWebProviderSecret?: (providerId: string, fieldKey: string) => Promise<WebSecretRevealResponse>;
  response?: WebSettingsResponse;
  saveWebSettings?: (payload: UpdateWebSettingsPayload) => Promise<WebSettingsResponse>;
} = {}): RuntimeBridge {
  return {
    settings: {
      getWebSettings: vi.fn(async () => response),
      saveWebSettings,
      revealWebProviderSecret,
      checkWebProvider,
    },
  } as unknown as RuntimeBridge;
}

function webSettings(): WebSettingsResponse {
  return {
    enabled: false,
    active_provider_id: "alpha",
    active_provider_known: true,
    providers: [
      {
        provider_id: "alpha",
        display_name: "Alpha",
        description: "Alpha search provider",
        capabilities: ["search", "fetch"],
        config_fields: [
          {
            key: "api_key",
            field_type: "secret",
            label: "Alpha API Key",
            required: true,
            placeholder: "Enter key",
            help_text: "仅保存在当前 Keydex 本地数据库中。",
            default: null,
            options: [],
          },
          {
            key: "endpoint",
            field_type: "text",
            label: "Endpoint",
            required: false,
            placeholder: null,
            help_text: "Custom endpoint",
            default: null,
            options: [],
          },
        ],
        credential_setup: {
          label: "获取 Alpha 密钥",
          url: "https://alpha.example/account/keys",
          help_text: "Alpha 免费计划每月提供 1,000 API Credits，基础搜索每次消耗 1 Credit。",
        },
        config: { endpoint: "https://alpha.example" },
        secrets: { api_key: { configured: true, preview: "••••1234" } },
        configured: true,
        config_status: "ready",
        connection_status: "unchecked",
      },
      {
        provider_id: "beta",
        display_name: "Beta",
        description: "Beta search provider",
        capabilities: ["search"],
        config_fields: [
          {
            key: "token",
            field_type: "secret",
            label: "Beta Token",
            required: true,
            placeholder: "Enter token",
            help_text: null,
            default: null,
            options: [],
          },
          {
            key: "region",
            field_type: "select",
            label: "Region",
            required: true,
            placeholder: null,
            help_text: null,
            default: "global",
            options: [
              { value: "global", label: "Global" },
              { value: "eu", label: "Europe" },
            ],
          },
          {
            key: "safe",
            field_type: "boolean",
            label: "Safe mode",
            required: false,
            placeholder: null,
            help_text: "Filter unsafe content",
            default: true,
            options: [],
          },
        ],
        credential_setup: null,
        config: { region: "global", safe: true },
        secrets: { token: { configured: false, preview: null } },
        configured: false,
        config_status: "incomplete",
        connection_status: "unchecked",
      },
    ],
  };
}

function webSettingsForPayload(payload: UpdateWebSettingsPayload): WebSettingsResponse {
  const response = webSettings();
  response.enabled = payload.enabled;
  response.active_provider_id = payload.active_provider_id;
  response.providers = response.providers.map((provider) => {
    const update = payload.providers[provider.provider_id];
    if (!update) {
      return provider;
    }
    const secrets = { ...provider.secrets };
    for (const [key, secretUpdate] of Object.entries(update.secrets)) {
      if (secretUpdate.action === "set") {
        secrets[key] = { configured: true, preview: "••••saved" };
      } else if (secretUpdate.action === "clear") {
        secrets[key] = { configured: false, preview: null };
      }
    }
    return {
      ...provider,
      config: { ...update.config },
      secrets,
    };
  });
  return response;
}
