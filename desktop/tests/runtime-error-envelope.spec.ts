import { describe, expect, it } from "vitest";

import {
  extractRuntimeErrorContext,
  normalizeRuntimeErrorEnvelope,
} from "@/runtime/errors";

describe("normalizeRuntimeErrorEnvelope", () => {
  it("normalizes direct, HTTP detail, and nested event envelopes", () => {
    const expected = {
      schema_version: 1,
      code: "provider_invalid_request",
      message: "参数无效",
      details: { provider_code: "bad_param" },
      retryable: false,
      status: 400,
    };

    expect(normalizeRuntimeErrorEnvelope(expected)).toEqual(expected);
    expect(normalizeRuntimeErrorEnvelope({ detail: expected })).toEqual(expected);
    expect(normalizeRuntimeErrorEnvelope({ error: expected })).toEqual(expected);
  });

  it("keeps legacy sibling code and details when error is a string", () => {
    expect(
      normalizeRuntimeErrorEnvelope({
        error: "模型请求参数无效",
        code: "llm_bad_request",
        details: { provider_message: "messages must not be empty" },
        retryable: false,
      }),
    ).toEqual({
      schema_version: 1,
      code: "llm_bad_request",
      message: "模型请求参数无效",
      details: { provider_message: "messages must not be empty" },
      retryable: false,
    });
  });

  it("accepts legacy MCP detail and legacy Web retry fields once", () => {
    expect(
      normalizeRuntimeErrorEnvelope({
        code: "rate_limited",
        message: "请求过于频繁",
        detail: { server_id: "srv-1" },
        provider_id: "web-a",
        retry_after_seconds: 12,
        retryable: true,
      }),
    ).toEqual({
      schema_version: 1,
      code: "rate_limited",
      message: "请求过于频繁",
      details: { server_id: "srv-1", provider_id: "web-a", retry_after_seconds: 12 },
      retryable: true,
    });
  });

  it("uses stable defaults for strings, Error instances, and invalid input", () => {
    expect(normalizeRuntimeErrorEnvelope("plain failure")).toEqual({
      schema_version: 1,
      code: "runtime_error",
      message: "plain failure",
      details: {},
      retryable: false,
    });
    expect(normalizeRuntimeErrorEnvelope(new Error("boom"))).toMatchObject({
      code: "runtime_error",
      message: "boom",
      details: {},
      retryable: false,
    });
    expect(normalizeRuntimeErrorEnvelope(null)).toEqual({
      schema_version: 1,
      code: "runtime_error",
      message: "运行时错误",
      details: {},
      retryable: false,
    });
  });

  it("does not retain mutable payload references or merge raw bodies", () => {
    const details = { nested: { value: 1 } };
    const raw = { code: "bad", message: "bad", details, body: { api_key: "secret" } };
    const normalized = normalizeRuntimeErrorEnvelope(raw);
    details.nested.value = 2;

    expect(normalized.details).toEqual({ nested: { value: 1 } });
    expect(normalized.details).not.toHaveProperty("body");
  });

  it("centralizes the temporary legacy gateway parser", () => {
    const normalized = normalizeRuntimeErrorEnvelope(
      "Error code: 429 - {'error': {'code': '429001', 'message': 'rate limit exceeded', 'type': 'gateway_error', 'request_id': 'req-1'}}",
    );

    expect(normalized).toEqual({
      schema_version: 1,
      code: "429001",
      message: "rate limit exceeded",
      details: {
        provider_message: "rate limit exceeded",
        provider_code: "429001",
        provider_type: "gateway_error",
        provider_request_id: "req-1",
      },
      retryable: false,
      status: 429,
    });
  });

  it("extracts routing context without moving it into details", () => {
    const value = {
      trace_id: "trace-1",
      session_id: "session-1",
      turn_index: 3,
      error: { code: "failed", message: "失败" },
      metadata: { errorContext: { messageEventId: "event-1" } },
    };

    expect(extractRuntimeErrorContext(value)).toEqual({
      trace_id: "trace-1",
      session_id: "session-1",
      turn_index: 3,
      message_event_id: "event-1",
    });
    expect(normalizeRuntimeErrorEnvelope(value).details).toEqual({});
    expect(
      extractRuntimeErrorContext({
        sessionId: "session-live",
        traceId: "trace-live",
        turnIndex: 4,
        messageEventId: "event-live",
      }),
    ).toEqual({
      session_id: "session-live",
      trace_id: "trace-live",
      turn_index: 4,
      message_event_id: "event-live",
    });
  });
});
