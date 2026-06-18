import { describe, expect, it } from "vitest";

import { RuntimeHttpError } from "@/runtime/errors";
import {
  createInitialRuntimeState,
  runtimeReducer,
  selectConnectionSummary,
  selectSourceStatus,
  selectVisibleErrors,
} from "@/renderer/stores/runtimeStore";

describe("runtimeStore", () => {
  it("records real backend messages for health, ws, model and settings errors", () => {
    let state = createInitialRuntimeState();
    state = runtimeReducer(state, {
      type: "error/record",
      source: "health",
      now: "2026-06-17T10:00:00Z",
      id: "err-health",
      error: new Error("后端未启动"),
    });
    state = runtimeReducer(state, {
      type: "error/record",
      source: "ws",
      now: "2026-06-17T10:00:01Z",
      id: "err-ws",
      error: "WebSocket 断开",
    });
    state = runtimeReducer(state, {
      type: "error/record",
      source: "model",
      now: "2026-06-17T10:00:02Z",
      id: "err-model",
      error: new RuntimeHttpError({
        code: "provider_error",
        message: "模型服务返回 400",
        details: { provider: "openai-compatible" },
        status: 502,
        method: "POST",
        path: "/api/models/refresh",
        body: {},
        rawText: "",
      }),
    });
    state = runtimeReducer(state, {
      type: "error/record",
      source: "settings",
      now: "2026-06-17T10:00:03Z",
      id: "err-settings",
      error: { code: "settings_error", message: "保存设置失败", details: { field: "api_key" } },
    });

    expect(selectVisibleErrors(state).map((error) => error.message)).toEqual([
      "保存设置失败",
      "模型服务返回 400",
      "WebSocket 断开",
      "后端未启动",
    ]);
    expect(selectSourceStatus(state, "model")).toBe("error");
    expect(selectConnectionSummary(state)).toMatchObject({
      status: "error",
      label: "设置异常",
      activeError: { id: "err-settings", message: "保存设置失败" },
    });
  });

  it("maps websocket status and clears errors manually", () => {
    let state = createInitialRuntimeState();
    state = runtimeReducer(state, { type: "connection/setWsStatus", status: "connecting" });
    expect(selectConnectionSummary(state).label).toBe("正在连接");

    state = runtimeReducer(state, { type: "connection/setWsStatus", status: "open" });
    expect(selectConnectionSummary(state).status).toBe("connected");

    state = runtimeReducer(state, {
      type: "error/record",
      source: "ws",
      id: "err-ws",
      now: "2026-06-17T10:00:00Z",
      error: "流式连接失败",
    });
    state = runtimeReducer(state, { type: "error/clear", id: "err-ws" });

    expect(selectVisibleErrors(state)).toEqual([]);
  });
});
