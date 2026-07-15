import type { McpErrorCode, McpServerStatus, McpToolEffectiveState } from "@/types/protocol";

export const MCP_SERVER_STATUS_LABELS: Record<McpServerStatus | "disabled", string> = {
  unknown: "未知",
  online: "在线",
  offline: "离线",
  auth_required: "需要认证",
  error: "异常",
  disabled: "已停用",
};

export const MCP_ERROR_MESSAGES: Record<McpErrorCode, string> = {
  mcp_disabled: "MCP 功能已关闭。",
  server_not_found: "找不到 MCP 服务器。",
  server_disabled: "MCP 服务器已停用。",
  server_offline: "MCP 服务器当前不可用，请检查连接配置或服务状态。",
  auth_required: "MCP 服务器需要认证，请完成登录或补充凭据。",
  tool_not_found: "找不到 MCP 工具。",
  tool_disabled_by_policy: "MCP 工具已停用。",
  tool_disabled_by_session: "MCP 工具已在当前会话停用。",
  approval_required: "MCP 工具调用需要你确认。",
  approval_rejected: "MCP 工具调用已被拒绝。",
  policy_denied: "MCP 权限设置拒绝了本次请求。",
  timeout: "MCP 操作超时，请稍后重试或调大超时时间。",
  cancelled: "MCP 操作已取消。",
  protocol_error: "MCP 协议响应异常，请检查服务器实现。",
  validation_error: "MCP 请求参数校验失败。",
  result_too_large: "MCP 返回结果超过限制。",
  resource_reserved: "MCP 资源读取暂未开放。",
  internal_error: "MCP 内部错误。",
};

export const MCP_TOOL_EFFECTIVE_STATE_LABELS: Record<McpToolEffectiveState, string> = {
  enabled: "已启用",
  disabled_persistently: "已停用",
  disabled_for_session: "当前会话停用",
  disabled_by_server: "服务器停用",
  server_offline: "服务器离线",
  approval_required: "需要确认",
  removed: "已移除",
  schema_changed: "参数已变化",
};

const SENSITIVE_VALUE_PATTERN =
  /(Bearer\s+)[^\s,;]+|((?:api[_-]?key|token|secret|password|authorization)=)(?:Bearer\s+)?[^,\s;]+/giu;

export function mcpServerStatusLabel(status: string, enabled = true): string {
  if (!enabled) {
    return MCP_SERVER_STATUS_LABELS.disabled;
  }
  if (status === "refreshing") {
    return MCP_SERVER_STATUS_LABELS.unknown;
  }
  return MCP_SERVER_STATUS_LABELS[status as McpServerStatus] ?? status;
}

export function mcpToolEffectiveStateLabel(state: string): string {
  return MCP_TOOL_EFFECTIVE_STATE_LABELS[state as McpToolEffectiveState] ?? state;
}

export function mcpErrorMessage(reason: unknown, fallback = "MCP 请求失败"): string {
  const payload = extractMcpErrorPayload(reason);
  if (payload?.code && payload.code in MCP_ERROR_MESSAGES) {
    return MCP_ERROR_MESSAGES[payload.code as McpErrorCode];
  }
  const message = payload?.message || extractMessage(reason);
  if (message) {
    return redactVisibleMcpText(message);
  }
  return fallback;
}

export function redactVisibleMcpText(value: string): string {
  return value.replace(SENSITIVE_VALUE_PATTERN, (match, bearerPrefix, keyPrefix) => {
    if (bearerPrefix) {
      return `${bearerPrefix}***REDACTED***`;
    }
    if (keyPrefix) {
      return `${keyPrefix}***REDACTED***`;
    }
    return match;
  });
}

function extractMcpErrorPayload(reason: unknown): { code?: string; message?: string } | null {
  if (!reason || typeof reason !== "object") {
    return null;
  }
  const record = reason as Record<string, unknown>;
  const nestedError = record.error;
  if (nestedError && typeof nestedError === "object") {
    return extractMcpErrorPayload(nestedError);
  }
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function extractMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object") {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}
