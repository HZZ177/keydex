import type {
  AppearanceSettings,
  CommandApprovalAuditRecord,
  CommandApprovalDecisionPayload,
  CommandApprovalRequest,
  CommandSettings,
  ModelSettings,
  SettingsResponse,
  TrustedCommandRule,
} from "@/types/protocol";

import type { HttpClient } from "./httpClient";

export interface HealthResponse {
  status: string;
  version: string;
}

export interface SettingsRuntime {
  health(): Promise<HealthResponse>;
  getSettings(): Promise<SettingsResponse>;
  saveSettings(model: ModelSettings): Promise<SettingsResponse>;
  saveAppearanceSettings(appearance: AppearanceSettings): Promise<SettingsResponse>;
  saveCommandSettings(command: CommandSettings): Promise<SettingsResponse>;
  listTrustedCommandRules(): Promise<TrustedCommandRule[]>;
  updateTrustedCommandRule(ruleId: string, enabled: boolean): Promise<TrustedCommandRule>;
  deleteTrustedCommandRule(ruleId: string): Promise<void>;
  listCommandApprovalHistory(options?: { page?: number; pageSize?: number; sessionId?: string }): Promise<{
    list: CommandApprovalAuditRecord[];
    total: number;
    page: number;
    page_size: number;
  }>;
  resolveApproval(approvalId: string, decision: CommandApprovalDecisionPayload): Promise<CommandApprovalRequest>;
}

export function createSettingsRuntime(http: HttpClient): SettingsRuntime {
  return {
    health() {
      return http.request<HealthResponse>("/api/health");
    },
    getSettings() {
      return http.request<SettingsResponse>("/api/settings");
    },
    saveSettings(model) {
      return http.request<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: { model },
      });
    },
    saveAppearanceSettings(appearance) {
      return http.request<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: { appearance },
      });
    },
    saveCommandSettings(command) {
      return http.request<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: { command },
      });
    },
    listTrustedCommandRules() {
      return http
        .request<{ list: TrustedCommandRule[] }>("/api/settings/command/trusted-rules")
        .then((response) => response.list);
    },
    updateTrustedCommandRule(ruleId, enabled) {
      return http.request<TrustedCommandRule>(`/api/settings/command/trusted-rules/${encodeURIComponent(ruleId)}`, {
        method: "PATCH",
        body: { enabled },
      });
    },
    deleteTrustedCommandRule(ruleId) {
      return http
        .request<{ deleted: boolean }>(`/api/settings/command/trusted-rules/${encodeURIComponent(ruleId)}`, {
          method: "DELETE",
        })
        .then(() => undefined);
    },
    listCommandApprovalHistory(options = {}) {
      const params = new URLSearchParams();
      if (options.page) {
        params.set("page", String(options.page));
      }
      if (options.pageSize) {
        params.set("page_size", String(options.pageSize));
      }
      if (options.sessionId) {
        params.set("session_id", options.sessionId);
      }
      const query = params.toString();
      return http.request<{
        list: CommandApprovalAuditRecord[];
        total: number;
        page: number;
        page_size: number;
      }>(`/api/settings/command/approval-history${query ? `?${query}` : ""}`);
    },
    resolveApproval(approvalId, decision) {
      return http.request<CommandApprovalRequest>(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: "POST",
        body: decision,
      });
    },
  };
}
