import { describe, expect, it, vi } from "vitest";

import {
  HttpClient,
  normalizeErrorEnvelope,
  redactForLog,
} from "@/runtime/httpClient";
import { RuntimeHttpError, isRuntimeHttpError } from "@/runtime/errors";
import { ApiClient, ApiError } from "@/api/client";

describe("HttpClient", () => {
  it("requires an explicit backend base URL", async () => {
    const client = new HttpClient({ fetcher: vi.fn() as unknown as typeof fetch });

    expect(() => client.getBaseUrl()).toThrow("Keydex 后端地址未配置");
    await expect(client.request("/api/health")).rejects.toThrow("Keydex 后端地址未配置");
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
    const client = new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher });

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
    const client = new HttpClient({ baseUrl: "http://127.0.0.1:8765", fetcher });

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
      schema_version: 1,
      code: "provider_error",
      message: "供应商错误",
      details: {},
      retryable: false,
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

  it("normalizes ApiClient errors through the same envelope contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(429, {
        detail: {
          schema_version: 1,
          code: "rate_limited",
          message: "请求过于频繁",
          details: { retry_after_seconds: 7 },
          retryable: true,
        },
      }),
    );
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:8765", fetcher });

    try {
      await client.health();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        schema_version: 1,
        code: "rate_limited",
        message: "请求过于频繁",
        details: { retry_after_seconds: 7 },
        retryable: true,
        status: 429,
      });
    }
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
