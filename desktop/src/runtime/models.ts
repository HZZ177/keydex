import type { ModelInfo, ModelSettings } from "@/types/protocol";

import type { HttpClient } from "./httpClient";

export interface ModelListResponse {
  models: ModelInfo[];
  cached: boolean;
}

export interface ModelProvider {
  id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  api_key_set: boolean;
  api_key_preview?: string | null;
  models: string[];
  model_enabled: Record<string, boolean>;
  health: Record<string, ModelHealth>;
  default_model: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ModelHealth {
  status: "healthy" | "unhealthy";
  latency_ms: number;
  error: string | null;
  checked_at: string;
}

export interface ModelProviderInput {
  name: string;
  base_url: string;
  api_key?: string | null;
  enabled?: boolean;
  models?: string[];
  model_enabled?: Record<string, boolean>;
  default_model?: string | null;
}

export interface ModelHealthResponse {
  provider: ModelProvider;
  health: ModelHealth;
}

interface ModelProvidersResponse {
  providers: ModelProvider[];
}

interface RefreshProviderResponse {
  provider: ModelProvider;
  models: string[];
}

export interface ModelsRuntime {
  listModels(): Promise<ModelListResponse>;
  refreshModels(model?: Partial<ModelSettings>): Promise<ModelListResponse>;
  listProviders(): Promise<ModelProvider[]>;
  createProvider(input: ModelProviderInput): Promise<ModelProvider>;
  updateProvider(providerId: string, patch: Partial<ModelProviderInput>): Promise<ModelProvider>;
  deleteProvider(providerId: string): Promise<void>;
  refreshProviderModels(providerId: string): Promise<ModelProvider>;
  checkModelHealth(providerId: string, modelId: string): Promise<ModelHealthResponse>;
  setDefaultModel(providerId: string, modelId: string): Promise<ModelProvider>;
}

export function createModelsRuntime(http: HttpClient): ModelsRuntime {
  return {
    listModels() {
      return http.request<ModelListResponse>("/api/models");
    },
    refreshModels(model) {
      return http.request<ModelListResponse>("/api/models/refresh", {
        method: "POST",
        body: model ? { model } : undefined,
      });
    },
    listProviders() {
      return http
        .request<ModelProvidersResponse>("/api/model-providers")
        .then((response) => response.providers);
    },
    createProvider(input) {
      return http.request<ModelProvider>("/api/model-providers", {
        method: "POST",
        body: input,
      });
    },
    updateProvider(providerId, patch) {
      return http.request<ModelProvider>(`/api/model-providers/${encodeURIComponent(providerId)}`, {
        method: "PATCH",
        body: patch,
      });
    },
    deleteProvider(providerId) {
      return http.request<void>(`/api/model-providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      });
    },
    refreshProviderModels(providerId) {
      return http
        .request<RefreshProviderResponse>(`/api/model-providers/${encodeURIComponent(providerId)}/refresh`, {
          method: "POST",
        })
        .then((response) => response.provider);
    },
    checkModelHealth(providerId, modelId) {
      return http.request<ModelHealthResponse>(
        `/api/model-providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/health`,
        { method: "POST" },
      );
    },
    async setDefaultModel(providerId, modelId) {
      const response = await http.request<ModelProvidersResponse>("/api/model-providers/default", {
        method: "PUT",
        body: { provider_id: providerId, model: modelId },
      });
      const provider = response.providers.find((item) => item.id === providerId);
      if (!provider) {
        throw new Error("默认模型已保存，但响应中未返回 Provider");
      }
      return provider;
    },
  };
}
