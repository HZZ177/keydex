import { describe, expect, it, vi } from "vitest";

import {
  AGENT_BASE_URL_STORAGE_KEY,
  HttpClient,
  normalizeErrorEnvelope,
  redactForLog,
} from "@/runtime/httpClient";
import { RuntimeHttpError, isRuntimeHttpError } from "@/runtime/errors";

describe("HttpClient", () => {
  it("uses the local E2E base URL override when present", () => {
    window.localStorage.setItem(AGENT_BASE_URL_STORAGE_KEY, "http://127.0.0.1:18765/");

    const client = new HttpClient({ fetcher: vi.fn() as unknown as typeof fetch });

    expect(client.getBaseUrl()).toBe("http://127.0.0.1:18765");
    window.localStorage.removeItem(AGENT_BASE_URL_STORAGE_KEY);
  });

  it("returns JSON for successful responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const client = new HttpClient({ baseUrl: "http://127.0.0.1:8765/", fetcher });

    await expect(client.request("/api/health")).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8765/api/health", {
      method: "GET",
      headers: {},
      body: undefined,
    });
  });

  it("throws RuntimeHttpError for structured backend detail envelopes", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        detail: {
          code: "model_missing",
          message: "请先选择模型",
          details: { field: "model" },
        },
      }),
    );
    const client = new HttpClient({ fetcher });

    await expect(client.request("/api/threads")).rejects.toMatchObject({
      name: "RuntimeHttpError",
      status: 400,
      code: "model_missing",
      message: "请先选择模型",
      details: { field: "model" },
    });
  });

  it("keeps non-json error text", async () => {
    const fetcher = vi.fn().mockResolvedValue(textResponse(500, "upstream exploded"));
    const client = new HttpClient({ fetcher });

    try {
      await client.request("/api/models/refresh", { method: "POST" });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeHttpError);
      expect(isRuntimeHttpError(error)).toBe(true);
      expect((error as RuntimeHttpError).code).toBe("http_500");
      expect((error as RuntimeHttpError).message).toBe("upstream exploded");
      expect((error as RuntimeHttpError).rawText).toBe("upstream exploded");
    }
  });

  it("normalizes direct envelopes and redacts secrets for logs", () => {
    expect(normalizeErrorEnvelope(502, { code: "provider_error", error: "供应商错误" })).toEqual({
      code: "provider_error",
      message: "供应商错误",
      status: 502,
    });

    expect(
      redactForLog({
        api_key: "sk-secret",
        nested: { Authorization: "Bearer token", keep: "visible" },
      }),
    ).toEqual({
      api_key: "[REDACTED]",
      nested: { Authorization: "[REDACTED]", keep: "visible" },
    });
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}
