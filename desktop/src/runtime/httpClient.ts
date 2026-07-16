import { RuntimeHttpError } from "./errors";
import type { RuntimeErrorEnvelope } from "./errors";

export interface HttpClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  logger?: Pick<Console, "debug" | "error">;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  silentStatuses?: number[];
}

const SENSITIVE_KEY_PATTERN = /api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|credential|password|secret/i;

export class HttpClient {
  private baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly logger?: Pick<Console, "debug" | "error">;

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl === undefined ? "" : normalizeBaseUrl(options.baseUrl);
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.logger = options.logger;
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getBaseUrl() {
    return requireBaseUrl(this.baseUrl);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(path, options);
    return readSuccessBody<T>(response);
  }

  async requestRaw(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? "GET";
    const hasBody = options.body !== undefined;
    const headers = {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    };

    this.logger?.debug("[runtime/http]", method, path, hasBody ? redactForLog(options.body) : "(no body)");

    const init: RequestInit = {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    };
    if (options.signal) {
      init.signal = options.signal;
    }

    const response = await this.fetcher(`${this.getBaseUrl()}${path}`, init);

    if (!response.ok) {
      const { body, rawText } = await readResponseBody(response);
      const envelope = normalizeErrorEnvelope(response.status, body, rawText);
      if (!options.silentStatuses?.includes(response.status)) {
        this.logger?.error("[runtime/http]", method, path, response.status, redactForLog(body));
      }
      throw new RuntimeHttpError({
        ...envelope,
        method,
        path,
        status: response.status,
        body,
        rawText,
      });
    }

    return response;
  }
}

export function createHttpClient(options?: HttpClientOptions) {
  return new HttpClient(options);
}

export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactForLog(entry, depth + 1),
    ]),
  );
}

export function normalizeErrorEnvelope(status: number, body: unknown, rawText = ""): RuntimeErrorEnvelope {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const direct = fromRecord(status, record);
    if (direct) {
      return direct;
    }

    const detail = record.detail;
    if (typeof detail === "string" && detail.trim()) {
      return { code: `http_${status}`, message: detail, status };
    }
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const nested = fromRecord(status, detail as Record<string, unknown>);
      if (nested) {
        return nested;
      }
    }
  }

  const message = typeof body === "string" && body.trim() ? body : rawText.trim();
  return {
    code: `http_${status}`,
    message: message || `模型运行时请求失败：HTTP ${status}`,
    status,
  };
}

function fromRecord(status: number, record: Record<string, unknown>): RuntimeErrorEnvelope | null {
  const code = typeof record.code === "string" && record.code.trim() ? record.code : `http_${status}`;
  const messageSource = record.message ?? record.error;
  const message = typeof messageSource === "string" && messageSource.trim() ? messageSource : null;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? (record.details as Record<string, unknown>)
    : undefined;

  if (!message) {
    return null;
  }

  const retryable = typeof record.retryable === "boolean" ? record.retryable : undefined;
  return { code, message, details, status, retryable };
}

async function readResponseBody(response: Response): Promise<{ body: unknown; rawText: string }> {
  const rawText = await response.text().catch(() => "");
  if (!rawText) {
    return { body: "", rawText };
  }

  try {
    return { body: JSON.parse(rawText) as unknown, rawText };
  } catch {
    return { body: rawText, rawText };
  }
}

async function readSuccessBody<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function normalizeBaseUrl(baseUrl: string) {
  const url = baseUrl.trim().replace(/\/$/, "");
  if (!url) {
    throw new Error("Keydex 后端地址未配置");
  }
  return url;
}

function requireBaseUrl(baseUrl: string) {
  if (!baseUrl) {
    throw new Error("Keydex 后端地址未配置");
  }
  return baseUrl;
}
