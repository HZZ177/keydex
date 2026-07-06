import { describe, expect, it } from "vitest";

import {
  mcpErrorMessage,
  mcpServerStatusLabel,
  mcpToolEffectiveStateLabel,
  redactVisibleMcpText,
} from "@/renderer/pages/mcp/mcpCopy";

describe("MCP copy helpers", () => {
  it("maps MCP runtime errors to user readable Chinese messages", () => {
    expect(mcpErrorMessage({ code: "server_offline" })).toBe("MCP 服务器当前不可用，请检查连接配置或服务状态。");
    expect(mcpErrorMessage({ code: "auth_required" })).toBe("MCP 服务器需要认证，请完成登录或补充凭据。");
    expect(mcpErrorMessage({ code: "protocol_error" })).toBe("MCP 协议响应异常，请检查服务器实现。");
    expect(mcpErrorMessage({ code: "timeout" })).toBe("MCP 操作超时，请稍后重试或调大超时时间。");
    expect(mcpErrorMessage({ code: "server_disabled" })).toBe("MCP 服务器已停用。");
    expect(mcpErrorMessage({ code: "approval_rejected" })).toBe("MCP 工具调用已被拒绝。");
    expect(mcpErrorMessage({ code: "resource_reserved" })).toBe("MCP Resources 已预留，本期暂不开放读取。");
  });

  it("redacts sensitive values in fallback visible error messages", () => {
    expect(
      redactVisibleMcpText("HTTP 401 Authorization=Bearer sk-secret api_key=sk-key token=abc"),
    ).toBe("HTTP 401 Authorization=***REDACTED*** api_key=***REDACTED*** token=***REDACTED***");
    expect(mcpErrorMessage(new Error("Bearer sk-secret failed"))).toBe("Bearer ***REDACTED*** failed");
  });

  it("maps server status and tool effective state labels", () => {
    expect(mcpServerStatusLabel("online")).toBe("在线");
    expect(mcpServerStatusLabel("auth_required")).toBe("需要认证");
    expect(mcpServerStatusLabel("online", false)).toBe("已停用");
    expect(mcpToolEffectiveStateLabel("schema_changed")).toBe("Schema 已变化");
    expect(mcpToolEffectiveStateLabel("approval_required")).toBe("需要审批");
  });
});
