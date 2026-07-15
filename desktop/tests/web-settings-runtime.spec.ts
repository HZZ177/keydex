import { describe, expect, it, vi } from "vitest";

import { RuntimeHttpError } from "@/runtime/errors";
import { createRuntimeBridge } from "@/runtime/bridge";
import type {
  UpdateWebSettingsPayload,
  WebSecretRevealResponse,
  WebSettingsResponse,
} from "@/runtime/settings";

const webSettings: WebSettingsResponse = {
  enabled: false,
  active_provider_id: "tavily",
  active_provider_known: true,
  providers: [
    {
      provider_id: "tavily",
      display_name: "Tavily",
      description: "Agent web search",
      capabilities: ["fetch", "search"],
      config_fields: [
        {
          key: "api_key",
          field_type: "secret",
          label: "API Key",
          required: true,
          placeholder: null,
          help_text: null,
          default: null,
          options: [],
        },
      ],
      credential_setup: {
        label: "获取 Tavily 密钥",
        url: "https://app.tavily.com/home",
        help_text: "Tavily 免费计划每月提供 1,000 API Credits。",
      },
      config: {},
      secrets: { api_key: { configured: false, preview: null } },
      configured: false,
      config_status: "incomplete",
      connection_status: "unchecked",
    },
  ],
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Web settings runtime", () => {
  it("routes get and save through the native settings API", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init = {}) => {
      if (init.method === "PUT") {
        return jsonResponse(200, { ...webSettings, enabled: true });
      }
      return jsonResponse(200, webSettings);
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });
    const payload: UpdateWebSettingsPayload = {
      enabled: true,
      active_provider_id: "tavily",
      providers: {
        tavily: {
          config: {},
          secrets: { api_key: { action: "set", value: "runtime-secret" } },
        },
      },
    };

    await expect(runtime.settings.getWebSettings()).resolves.toEqual(webSettings);
    await expect(runtime.settings.saveWebSettings(payload)).resolves.toMatchObject({ enabled: true });

    expect(fetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8765/api/settings/web", {
      method: "GET",
      headers: {},
      body: undefined,
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8765/api/settings/web", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  it("routes draft connection checks with an encoded provider id", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        provider_id: "provider/id",
        ok: true,
        duration_ms: 25,
        error: null,
      }),
    );
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });
    const draft = {
      config: { region: "global" },
      secrets: { api_key: { action: "set" as const, value: "draft-secret" } },
    };

    await expect(runtime.settings.checkWebProvider("provider/id", draft)).resolves.toMatchObject({ ok: true });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/settings/web/providers/provider%2Fid/check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      },
    );
  });

  it("reveals one saved secret through a bodyless non-cached API request", async () => {
    const revealed: WebSecretRevealResponse = {
      provider_id: "provider/id",
      field_key: "api/key",
      value: "saved-runtime-secret",
    };
    const logger = { debug: vi.fn(), error: vi.fn() };
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(200, revealed));
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher, logger });

    await expect(runtime.settings.revealWebProviderSecret("provider/id", "api/key")).resolves.toEqual(revealed);

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/api/settings/web/providers/provider%2Fid/secrets/api%2Fkey/reveal",
      {
        method: "POST",
        headers: {},
        body: undefined,
      },
    );
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(revealed.value);
  });

  it("preserves stable backend error codes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(400, {
        detail: {
          code: "provider_not_configured",
          message: "当前搜索引擎尚未完成配置",
          retryable: false,
        },
      }),
    );
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher });

    const error = await runtime.settings.checkWebProvider("tavily").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeHttpError);
    expect(error).toMatchObject({ code: "provider_not_configured", status: 400 });
  });

  it("redacts secret actions in runtime diagnostics", async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(200, webSettings));
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765", fetcher, logger });
    const raw = "runtime-log-secret";

    await runtime.settings.saveWebSettings({
      enabled: false,
      active_provider_id: "tavily",
      providers: {
        tavily: {
          config: {},
          secrets: { api_key: { action: "set", value: raw } },
        },
      },
    });

    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(raw);
  });
});
