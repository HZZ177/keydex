import type {
  AppearanceSettings,
  ApprovalDecision,
  GeneralSettings,
  ModelInfo,
  ModelSettings,
  PermissionMode,
  SettingsResponse,
  Thread,
  ThreadDetail,
  Turn,
} from "@/types/protocol";
import {
  RuntimeError,
  normalizeRuntimeErrorEnvelope,
  type RuntimeErrorEnvelope,
} from "@/runtime/errors";

export interface ApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export interface CreateThreadPayload {
  cwd: string;
  workspace_roots?: string[];
  model: string;
  permission_mode?: PermissionMode;
  title?: string | null;
}

export class ApiError extends RuntimeError {
  readonly payload: unknown;

  constructor(
    envelope: RuntimeErrorEnvelope,
    payload: unknown,
  ) {
    super(envelope);
    this.name = "ApiError";
    this.payload = payload;
  }
}

export class ApiClient {
  private baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl === undefined ? "" : normalizeBaseUrl(options.baseUrl);
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error("Keydex 后端地址未配置");
    }
    return this.baseUrl;
  }

  async health(): Promise<{ status: string; version: string }> {
    return this.request("/api/health");
  }

  async getSettings(): Promise<SettingsResponse> {
    return this.request("/api/settings");
  }

  async updateSettings(model: ModelSettings): Promise<SettingsResponse> {
    return this.request("/api/settings", {
      method: "PUT",
      body: { model },
    });
  }

  async updateAppearanceSettings(appearance: AppearanceSettings): Promise<SettingsResponse> {
    return this.request("/api/settings", {
      method: "PUT",
      body: { appearance },
    });
  }

  async updateGeneralSettings(general: GeneralSettings): Promise<SettingsResponse> {
    return this.request("/api/settings", {
      method: "PUT",
      body: { general },
    });
  }

  async listModels(): Promise<{ models: ModelInfo[]; cached: boolean }> {
    return this.request("/api/models");
  }

  async refreshModels(model?: Partial<ModelSettings>): Promise<{ models: ModelInfo[]; cached: boolean }> {
    return this.request("/api/models/refresh", {
      method: "POST",
      body: model ? { model } : undefined,
    });
  }

  async listThreads(): Promise<Thread[]> {
    return this.request("/api/sessions");
  }

  async createThread(payload: CreateThreadPayload): Promise<Thread> {
    return this.request("/api/sessions", { method: "POST", body: payload });
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    return this.request(`/api/sessions/${encodeURIComponent(threadId)}`);
  }

  async updateThread(
    threadId: string,
    patch: { title?: string | null; pinned?: boolean | null },
  ): Promise<Thread> {
    return this.request(`/api/sessions/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  async startTurn(threadId: string, input: Array<Record<string, unknown>>): Promise<Turn> {
    return this.request(`/api/sessions/${encodeURIComponent(threadId)}/chat`, {
      method: "POST",
      body: { input },
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<{ interrupted: boolean }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(threadId)}/cancel`,
      { method: "POST" },
    );
  }

  async respondApproval(
    approvalId: string,
    decision: ApprovalDecision,
    comment?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/sessions/approvals/${encodeURIComponent(approvalId)}/respond`, {
      method: "POST",
      body: { decision, comment },
    });
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.fetcher(`${this.getBaseUrl()}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      const { payload, rawText } = await readErrorBody(response);
      const envelope = {
        ...normalizeRuntimeErrorEnvelope(payload, {
          fallbackCode: `http_${response.status}`,
          fallbackMessage: rawText.trim() || `接口请求失败，状态码 ${response.status}`,
          status: response.status,
        }),
        status: response.status,
      };
      throw new ApiError(envelope, payload);
    }
    return (await response.json()) as T;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const url = baseUrl.trim().replace(/\/$/, "");
  if (!url) {
    throw new Error("Keydex 后端地址未配置");
  }
  return url;
}

async function readErrorBody(response: Response): Promise<{ payload: unknown; rawText: string }> {
  const rawText = await response.text().catch(() => "");
  if (!rawText) {
    return { payload: "", rawText };
  }
  try {
    return { payload: JSON.parse(rawText) as unknown, rawText };
  } catch {
    return { payload: rawText, rawText };
  }
}

export const apiClient = new ApiClient();
