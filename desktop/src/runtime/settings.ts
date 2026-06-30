import type {
  AppearanceSettings,
  AgentRuntimeSettings,
  CommandApprovalAuditRecord,
  CommandApprovalDecisionPayload,
  CommandApprovalRequest,
  CommandSettings,
  GeneralSettings,
  ModelDefaultsResponse,
  UpdateModelDefaultsPayload,
  ModelSettings,
  SettingsResponse,
  TrustedCommandRule,
} from "@/types/protocol";

import type { HttpClient } from "./httpClient";

export interface HealthResponse {
  status: string;
  version: string;
  protocol_version?: string;
  agent_status?: "idle" | "warming" | "ready" | "failed" | "unknown" | string;
  agent_error?: string | null;
  agent_warmup_duration_ms?: number | null;
}

export interface SettingsRuntime {
  health(): Promise<HealthResponse>;
  getSettings(): Promise<SettingsResponse>;
  getModelDefaults(): Promise<ModelDefaultsResponse>;
  saveModelDefaults(payload: UpdateModelDefaultsPayload): Promise<ModelDefaultsResponse>;
  getExtensionSettings(): Promise<AgentRuntimeSettings>;
  saveExtensionSettings(payload: AgentRuntimeSettings): Promise<AgentRuntimeSettings>;
  saveSettings(model: ModelSettings): Promise<SettingsResponse>;
  saveGeneralSettings(general: GeneralSettings): Promise<SettingsResponse>;
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
    getModelDefaults() {
      return http.request<ModelDefaultsResponse>("/api/settings/model-defaults");
    },
    saveModelDefaults(payload) {
      return http.request<ModelDefaultsResponse>("/api/settings/model-defaults", {
        method: "PUT",
        body: payload,
      });
    },
    getExtensionSettings() {
      return http.request<AgentRuntimeSettings>("/api/settings/extensions");
    },
    saveExtensionSettings(payload) {
      return http.request<AgentRuntimeSettings>("/api/settings/extensions", {
        method: "PUT",
        body: payload,
      });
    },
    saveSettings(model) {
      return http.request<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: { model },
      });
    },
    saveGeneralSettings(general) {
      return http.request<SettingsResponse>("/api/settings", {
        method: "PUT",
        body: { general },
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
