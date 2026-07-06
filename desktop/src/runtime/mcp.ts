import type {
  CommandApprovalDecisionPayload,
  CommandApprovalRequest,
  McpAuditListResponse,
  McpConnectionTestResponse,
  McpExportPayload,
  McpExportResponse,
  McpImportPayload,
  McpImportPreviewResponse,
  McpOAuthCallbackPayload,
  McpOAuthStartPayload,
  McpOAuthStartResponse,
  McpOAuthStatusResponse,
  McpPromptListResponse,
  McpPromptMaterializeResponse,
  McpPromptPolicyUpdatePayload,
  McpPromptSummary,
  McpRefreshAllResponse,
  McpRefreshResult,
  McpRuntimeCallCancelResponse,
  McpRuntimeStatusResponse,
  McpServerCreatePayload,
  McpServerDetailResponse,
  McpServerListResponse,
  McpServerSummary,
  McpServerUpdatePayload,
  McpToolBulkPolicyPayload,
  McpToolBulkPolicyResponse,
  McpToolListResponse,
  McpToolPolicyUpdatePayload,
  McpToolSummary,
  McpTransport,
  McpTrustRule,
  McpTrustRulePayload,
} from "@/types/protocol";

import type { HttpClient } from "./httpClient";

export interface McpServerListOptions {
  enabled?: boolean;
  transport?: McpTransport;
  limit?: number;
  offset?: number;
}

export interface McpToolListOptions {
  status?: string;
  risk?: string;
  enabled?: boolean;
  search?: string;
  limit?: number;
}

export interface McpPromptListOptions {
  status?: string;
  enabled?: boolean;
  search?: string;
  limit?: number;
}

export interface McpAuditListOptions {
  server_id?: string;
  session_id?: string;
  event_type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface McpTrustRuleListOptions {
  server_id?: string;
  scope?: string;
  session_id?: string;
  limit?: number;
}

export interface McpRuntime {
  listServers(options?: McpServerListOptions): Promise<McpServerListResponse>;
  createServer(payload: McpServerCreatePayload): Promise<McpServerDetailResponse>;
  getServer(serverId: string): Promise<McpServerDetailResponse>;
  updateServer(serverId: string, payload: McpServerUpdatePayload): Promise<McpServerDetailResponse>;
  deleteServer(serverId: string): Promise<{ deleted: boolean; server_id: string }>;
  toggleServer(serverId: string, enabled: boolean): Promise<McpServerSummary>;
  testServer(serverId: string): Promise<McpConnectionTestResponse>;
  refreshServer(serverId: string): Promise<McpRefreshResult>;
  refreshServers(): Promise<McpRefreshAllResponse>;
  listTools(serverId: string, options?: McpToolListOptions): Promise<McpToolListResponse>;
  updateToolPolicy(
    serverId: string,
    toolId: string,
    payload: McpToolPolicyUpdatePayload,
  ): Promise<McpToolSummary>;
  applyToolBulkPolicy(
    serverId: string,
    payload: McpToolBulkPolicyPayload,
  ): Promise<McpToolBulkPolicyResponse>;
  listPrompts(serverId: string, options?: McpPromptListOptions): Promise<McpPromptListResponse>;
  updatePromptPolicy(
    serverId: string,
    promptId: string,
    payload: McpPromptPolicyUpdatePayload,
  ): Promise<McpPromptSummary>;
  getPrompt(
    serverId: string,
    promptId: string,
    argumentsPayload?: Record<string, unknown>,
  ): Promise<McpPromptMaterializeResponse>;
  getRuntimeStatus(sessionId: string): Promise<McpRuntimeStatusResponse>;
  setSessionToolOverride(
    sessionId: string,
    toolId: string,
    payload: { enabled: boolean; server_id?: string | null; reason?: string | null },
  ): Promise<unknown>;
  clearSessionToolOverride(
    sessionId: string,
    toolId: string,
    serverId?: string | null,
  ): Promise<unknown>;
  cancelRuntimeCall(callId: string): Promise<McpRuntimeCallCancelResponse>;
  importConfig(payload: McpImportPayload): Promise<McpImportPreviewResponse>;
  exportConfig(payload?: McpExportPayload): Promise<McpExportResponse>;
  resolveApproval(
    approvalId: string,
    decision: CommandApprovalDecisionPayload & { user_id?: string | null },
  ): Promise<CommandApprovalRequest>;
  startOAuth(
    serverId: string,
    payload?: McpOAuthStartPayload,
  ): Promise<McpOAuthStartResponse>;
  completeOAuth(
    serverId: string,
    payload: McpOAuthCallbackPayload,
  ): Promise<McpOAuthStatusResponse>;
  getOAuthStatus(serverId: string): Promise<McpOAuthStatusResponse>;
  clearOAuth(serverId: string): Promise<McpOAuthStatusResponse>;
  listAudit(options?: McpAuditListOptions): Promise<McpAuditListResponse>;
  listTrustRules(options?: McpTrustRuleListOptions): Promise<{ list: McpTrustRule[] }>;
  createTrustRule(payload: McpTrustRulePayload): Promise<McpTrustRule>;
  deleteTrustRule(ruleId: string): Promise<{ deleted: boolean; rule_id: string }>;
}

export function createMcpRuntime(http: HttpClient): McpRuntime {
  return {
    listServers(options = {}) {
      return http.request<McpServerListResponse>(withQuery("/api/mcp/servers", options));
    },
    createServer(payload) {
      return http.request<McpServerDetailResponse>("/api/mcp/servers", {
        method: "POST",
        body: payload,
      });
    },
    getServer(serverId) {
      return http.request<McpServerDetailResponse>(`/api/mcp/servers/${encodePath(serverId)}`);
    },
    updateServer(serverId, payload) {
      return http.request<McpServerDetailResponse>(`/api/mcp/servers/${encodePath(serverId)}`, {
        method: "PATCH",
        body: payload,
      });
    },
    deleteServer(serverId) {
      return http.request<{ deleted: boolean; server_id: string }>(`/api/mcp/servers/${encodePath(serverId)}`, {
        method: "DELETE",
      });
    },
    toggleServer(serverId, enabled) {
      return http.request<McpServerSummary>(`/api/mcp/servers/${encodePath(serverId)}/toggle`, {
        method: "POST",
        body: { enabled },
      });
    },
    testServer(serverId) {
      return http.request<McpConnectionTestResponse>(`/api/mcp/servers/${encodePath(serverId)}/test`, {
        method: "POST",
      });
    },
    refreshServer(serverId) {
      return http.request<McpRefreshResult>(`/api/mcp/servers/${encodePath(serverId)}/refresh`, {
        method: "POST",
      });
    },
    refreshServers() {
      return http.request<McpRefreshAllResponse>("/api/mcp/servers/refresh", {
        method: "POST",
      });
    },
    listTools(serverId, options = {}) {
      return http.request<McpToolListResponse>(
        withQuery(`/api/mcp/servers/${encodePath(serverId)}/tools`, options),
      );
    },
    updateToolPolicy(serverId, toolId, payload) {
      return http.request<McpToolSummary>(
        `/api/mcp/servers/${encodePath(serverId)}/tools/${encodePath(toolId)}/policy`,
        {
          method: "PATCH",
          body: payload,
        },
      );
    },
    applyToolBulkPolicy(serverId, payload) {
      return http.request<McpToolBulkPolicyResponse>(
        `/api/mcp/servers/${encodePath(serverId)}/tools/bulk-policy`,
        {
          method: "POST",
          body: payload,
        },
      );
    },
    listPrompts(serverId, options = {}) {
      return http.request<McpPromptListResponse>(
        withQuery(`/api/mcp/servers/${encodePath(serverId)}/prompts`, options),
      );
    },
    updatePromptPolicy(serverId, promptId, payload) {
      return http.request<McpPromptSummary>(
        `/api/mcp/servers/${encodePath(serverId)}/prompts/${encodePath(promptId)}/policy`,
        {
          method: "PATCH",
          body: payload,
        },
      );
    },
    getPrompt(serverId, promptId, argumentsPayload = {}) {
      return http.request<McpPromptMaterializeResponse>(
        `/api/mcp/servers/${encodePath(serverId)}/prompts/${encodePath(promptId)}/get`,
        {
          method: "POST",
          body: { arguments: argumentsPayload },
        },
      );
    },
    getRuntimeStatus(sessionId) {
      return http.request<McpRuntimeStatusResponse>(
        withQuery("/api/mcp/runtime/status", { session_id: sessionId }),
      );
    },
    setSessionToolOverride(sessionId, toolId, payload) {
      return http.request<unknown>(
        `/api/mcp/runtime/sessions/${encodePath(sessionId)}/tools/${encodePath(toolId)}/override`,
        {
          method: "PUT",
          body: payload,
        },
      );
    },
    clearSessionToolOverride(sessionId, toolId, serverId = null) {
      return http.request<unknown>(
        withQuery(
          `/api/mcp/runtime/sessions/${encodePath(sessionId)}/tools/${encodePath(toolId)}/override`,
          { server_id: serverId },
        ),
        { method: "DELETE" },
      );
    },
    cancelRuntimeCall(callId) {
      return http.request<McpRuntimeCallCancelResponse>(`/api/mcp/runtime/calls/${encodePath(callId)}/cancel`, {
        method: "POST",
      });
    },
    importConfig(payload) {
      return http.request<McpImportPreviewResponse>("/api/mcp/import", {
        method: "POST",
        body: payload,
      });
    },
    exportConfig(payload = {}) {
      return http.request<McpExportResponse>("/api/mcp/export", {
        method: "POST",
        body: payload,
      });
    },
    resolveApproval(approvalId, decision) {
      return http.request<CommandApprovalRequest>(`/api/mcp/approvals/${encodePath(approvalId)}/decision`, {
        method: "POST",
        body: decision,
      });
    },
    startOAuth(serverId, payload = {}) {
      return http.request<McpOAuthStartResponse>(`/api/mcp/servers/${encodePath(serverId)}/oauth/start`, {
        method: "POST",
        body: payload,
      });
    },
    completeOAuth(serverId, payload) {
      return http.request<McpOAuthStatusResponse>(
        `/api/mcp/servers/${encodePath(serverId)}/oauth/callback`,
        {
          method: "POST",
          body: payload,
        },
      );
    },
    getOAuthStatus(serverId) {
      return http.request<McpOAuthStatusResponse>(`/api/mcp/servers/${encodePath(serverId)}/oauth/status`);
    },
    clearOAuth(serverId) {
      return http.request<McpOAuthStatusResponse>(`/api/mcp/servers/${encodePath(serverId)}/oauth`, {
        method: "DELETE",
      });
    },
    listAudit(options = {}) {
      return http.request<McpAuditListResponse>(withQuery("/api/mcp/audit", options));
    },
    listTrustRules(options = {}) {
      return http.request<{ list: McpTrustRule[] }>(withQuery("/api/mcp/trust-rules", options));
    },
    createTrustRule(payload) {
      return http.request<McpTrustRule>("/api/mcp/trust-rules", {
        method: "POST",
        body: payload,
      });
    },
    deleteTrustRule(ruleId) {
      return http.request<{ deleted: boolean; rule_id: string }>(`/api/mcp/trust-rules/${encodePath(ruleId)}`, {
        method: "DELETE",
      });
    },
  };
}

function withQuery(path: string, params: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}
