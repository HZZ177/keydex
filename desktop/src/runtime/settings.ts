import type {
  AppearanceSettings,
  AgentRuntimeSettings,
  CommandApprovalAuditRecord,
  CommandApprovalDecisionPayload,
  CommandApprovalRequest,
  CommandRuntimeProbeResponse,
  CommandSettings,
  CommandShell,
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
  capabilities?: string[];
  file_history_enabled?: boolean;
  checkpoint_status?: string;
  checkpoint_ready?: boolean;
}

export type WebCapability = "search" | "fetch";
export type WebProviderFieldType = "text" | "secret" | "select" | "boolean";
export type WebProviderConfigStatus = "ready" | "incomplete" | "invalid";

export interface WebProviderSelectOption {
  value: string;
  label: string;
}

export interface WebProviderConfigField {
  key: string;
  field_type: WebProviderFieldType;
  label: string;
  required: boolean;
  placeholder: string | null;
  help_text: string | null;
  default: string | boolean | null;
  options: WebProviderSelectOption[];
}

export interface WebSecretState {
  configured: boolean;
  preview: string | null;
}

export interface WebProviderSetupLink {
  label: string;
  url: string;
  help_text: string | null;
}

export interface WebProviderSettings {
  provider_id: string;
  display_name: string;
  description: string;
  capabilities: WebCapability[];
  config_fields: WebProviderConfigField[];
  credential_setup: WebProviderSetupLink | null;
  config: Record<string, string | boolean>;
  secrets: Record<string, WebSecretState>;
  configured: boolean;
  config_status: WebProviderConfigStatus;
  connection_status: "unchecked";
}

export interface WebSettingsResponse {
  enabled: boolean;
  active_provider_id: string;
  active_provider_known: boolean;
  providers: WebProviderSettings[];
}

export type WebSecretUpdate =
  | { action: "keep" | "clear"; value?: never }
  | { action: "set"; value: string };

export interface WebProviderSettingsUpdate {
  config: Record<string, string | boolean>;
  secrets: Record<string, WebSecretUpdate>;
}

export interface UpdateWebSettingsPayload {
  enabled: boolean;
  active_provider_id: string;
  providers: Record<string, WebProviderSettingsUpdate>;
}

export interface WebConnectionCheckDraft {
  config?: Record<string, string | boolean>;
  secrets?: Record<string, WebSecretUpdate>;
}

export interface WebConnectionCheckError {
  code: string;
  message: string;
  retryable: boolean;
  provider_id: string | null;
  retry_after_seconds: number | null;
}

export interface WebConnectionCheckResponse {
  provider_id: string;
  ok: boolean;
  duration_ms: number | null;
  error: WebConnectionCheckError | null;
}

export interface WebSecretRevealResponse {
  provider_id: string;
  field_key: string;
  value: string;
}

export interface SettingsRuntime {
  health(): Promise<HealthResponse>;
  getSettings(): Promise<SettingsResponse>;
  getModelDefaults(): Promise<ModelDefaultsResponse>;
  saveModelDefaults(payload: UpdateModelDefaultsPayload): Promise<ModelDefaultsResponse>;
  getExtensionSettings(): Promise<AgentRuntimeSettings>;
  saveExtensionSettings(payload: AgentRuntimeSettings): Promise<AgentRuntimeSettings>;
  getWebSettings(): Promise<WebSettingsResponse>;
  saveWebSettings(payload: UpdateWebSettingsPayload): Promise<WebSettingsResponse>;
  revealWebProviderSecret(providerId: string, fieldKey: string): Promise<WebSecretRevealResponse>;
  checkWebProvider(providerId: string, draft?: WebConnectionCheckDraft): Promise<WebConnectionCheckResponse>;
  saveSettings(model: ModelSettings): Promise<SettingsResponse>;
  saveGeneralSettings(general: GeneralSettings): Promise<SettingsResponse>;
  saveAppearanceSettings(appearance: AppearanceSettings): Promise<SettingsResponse>;
  saveCommandSettings(command: CommandSettings): Promise<SettingsResponse>;
  discoverCommandRuntime(shell: CommandShell): Promise<CommandRuntimeProbeResponse>;
  validateCommandRuntime(shell: CommandShell, shellPath: string): Promise<CommandRuntimeProbeResponse>;
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
    getWebSettings() {
      return http.request<WebSettingsResponse>("/api/settings/web");
    },
    saveWebSettings(payload) {
      return http.request<WebSettingsResponse>("/api/settings/web", {
        method: "PUT",
        body: payload,
      });
    },
    revealWebProviderSecret(providerId, fieldKey) {
      return http.request<WebSecretRevealResponse>(
        `/api/settings/web/providers/${encodeURIComponent(providerId)}/secrets/${encodeURIComponent(fieldKey)}/reveal`,
        { method: "POST" },
      );
    },
    checkWebProvider(providerId, draft = {}) {
      return http.request<WebConnectionCheckResponse>(
        `/api/settings/web/providers/${encodeURIComponent(providerId)}/check`,
        {
          method: "POST",
          body: draft,
        },
      );
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
    discoverCommandRuntime(shell) {
      return http.request<CommandRuntimeProbeResponse>("/api/settings/command/runtime/discover", {
        method: "POST",
        body: { selected_shell: shell },
      });
    },
    validateCommandRuntime(shell, shellPath) {
      return http.request<CommandRuntimeProbeResponse>("/api/settings/command/runtime/validate", {
        method: "POST",
        body: { selected_shell: shell, shell_path: shellPath },
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
