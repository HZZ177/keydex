import type {
  ApprovalDecision,
  ModelInfo,
  ModelSettings,
  PermissionMode,
  SettingsResponse,
  Thread,
  ThreadDetail,
  Turn,
} from "@/types/protocol";

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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
  }
}

export class ApiClient {
  private baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8765").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getBaseUrl(): string {
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

  async listModels(): Promise<{ models: ModelInfo[]; cached: boolean }> {
    return this.request("/api/models");
  }

  async refreshModels(model?: Partial<ModelSettings>): Promise<{ models: ModelInfo[]; cached: boolean }> {
    return this.request("/api/models/refresh", {
      method: "POST",
      body: model ? { model } : undefined,
    });
  }

  async listThreads(includeArchived = false): Promise<Thread[]> {
    return this.request(`/api/sessions?include_archived=${includeArchived ? "true" : "false"}`);
  }

  async createThread(payload: CreateThreadPayload): Promise<Thread> {
    return this.request("/api/sessions", { method: "POST", body: payload });
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    return this.request(`/api/sessions/${encodeURIComponent(threadId)}`);
  }

  async updateThread(
    threadId: string,
    patch: { title?: string | null; archived?: boolean },
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
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      const payload = await safeJson(response);
      throw new ApiError(formatApiError(response.status, payload), response.status, payload);
    }
    return (await response.json()) as T;
  }
}

function formatApiError(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object") {
      const message = (detail as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    const message = record.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return `接口请求失败，状态码 ${status}`;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export const apiClient = new ApiClient();
