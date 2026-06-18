import type { ModelSettings, SettingsResponse } from "@/types/protocol";

import type { HttpClient } from "./httpClient";

export interface HealthResponse {
  status: string;
  version: string;
}

export interface SettingsRuntime {
  health(): Promise<HealthResponse>;
  getSettings(): Promise<SettingsResponse>;
  saveSettings(model: ModelSettings): Promise<SettingsResponse>;
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
  };
}
