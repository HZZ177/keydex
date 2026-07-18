export const RUNTIME_ERROR_SCHEMA_VERSION = 1 as const;

export interface RuntimeErrorEnvelope {
  schema_version: typeof RUNTIME_ERROR_SCHEMA_VERSION;
  code: string;
  message: string;
  details: Record<string, unknown>;
  retryable: boolean;
  status?: number;
}

export interface RuntimeErrorEnvelopeInput {
  schema_version?: number;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  retryable?: boolean;
  status?: number;
}

export interface NormalizeRuntimeErrorOptions {
  fallbackCode?: string;
  fallbackMessage?: string;
  status?: number;
  parseLegacyGateway?: boolean;
}

export type RuntimeErrorContext = Record<string, string | number>;

const CONTEXT_KEYS = [
  "session_id",
  "trace_id",
  "turn_index",
  "action",
  "message_event_id",
  "run_id",
] as const;
const CONTEXT_KEY_ALIASES: Record<string, (typeof CONTEXT_KEYS)[number]> = {
  sessionId: "session_id",
  traceId: "trace_id",
  turnIndex: "turn_index",
  sourceAction: "action",
  messageEventId: "message_event_id",
  runId: "run_id",
};
const LEGACY_PUBLIC_DETAIL_KEYS = [
  "provider_id",
  "provider_request_id",
  "request_id",
  "retry_after_seconds",
  "error_type",
  "param",
] as const;

export class RuntimeError extends Error implements RuntimeErrorEnvelope {
  readonly schema_version = RUNTIME_ERROR_SCHEMA_VERSION;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(envelope: RuntimeErrorEnvelopeInput & { message: string }) {
    const normalized = normalizeRuntimeErrorEnvelope(envelope);
    super(normalized.message);
    this.name = "RuntimeError";
    this.code = normalized.code;
    this.details = normalized.details;
    this.status = normalized.status;
    this.retryable = normalized.retryable;
  }
}

export interface RuntimeHttpErrorParams extends RuntimeErrorEnvelopeInput {
  code: string;
  message: string;
  method: string;
  path: string;
  body: unknown;
  rawText: string;
}

export class RuntimeHttpError extends RuntimeError {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly rawText: string;

  constructor(params: RuntimeHttpErrorParams) {
    super(params);
    this.name = "RuntimeHttpError";
    this.method = params.method;
    this.path = params.path;
    this.body = params.body;
    this.rawText = params.rawText;
  }
}

export function normalizeRuntimeErrorEnvelope(
  value: unknown,
  options: NormalizeRuntimeErrorOptions = {},
): RuntimeErrorEnvelope {
  if (value instanceof Error) {
    const errorRecord = value as Error & Partial<RuntimeErrorEnvelope>;
    return finalizeEnvelope(
      {
        code: errorRecord.code,
        message: value.message,
        details: errorRecord.details,
        retryable: errorRecord.retryable,
        status: errorRecord.status,
      },
      options,
    );
  }
  if (typeof value === "string") {
    return finalizeEnvelope({ message: value }, options);
  }

  const root = asRecord(value);
  if (!root) {
    return finalizeEnvelope({}, options);
  }

  const rootHasErrorFields =
    publicText(root.code) !== undefined ||
    publicText(root.message) !== undefined ||
    typeof root.error === "string";
  const detailRecord = asRecord(root.detail);
  const nestedError = asRecord(root.error);
  const candidate = rootHasErrorFields ? root : detailRecord ?? nestedError ?? root;
  const legacyMcpDetails =
    candidate === root && detailRecord && !looksLikeErrorEnvelope(detailRecord)
      ? detailRecord
      : undefined;

  const details = cloneDetails(
    asRecord(candidate.details) ??
      legacyMcpDetails ??
      (candidate !== root ? asRecord(root.details) : undefined),
  );
  for (const key of LEGACY_PUBLIC_DETAIL_KEYS) {
    const entry = candidate[key] ?? (candidate !== root ? root[key] : undefined);
    if (isPublicScalar(entry) && details[key] === undefined) {
      details[key] = entry;
    }
  }

  const detailText = typeof root.detail === "string" ? publicText(root.detail) : undefined;
  const nestedErrorText = typeof root.error === "string" ? publicText(root.error) : undefined;
  return finalizeEnvelope(
    {
      code: publicText(candidate.code) ?? (candidate !== root ? publicText(root.code) : undefined),
      message:
        publicText(candidate.message) ??
        (typeof candidate.error === "string" ? publicText(candidate.error) : undefined) ??
        (candidate !== root ? publicText(root.message) : undefined) ??
        nestedErrorText ??
        detailText,
      details,
      retryable:
        typeof candidate.retryable === "boolean"
          ? candidate.retryable
          : typeof root.retryable === "boolean"
            ? root.retryable
            : undefined,
      status: httpStatus(candidate.status) ?? httpStatus(root.status),
    },
    options,
  );
}

export function extractRuntimeErrorContext(value: unknown): RuntimeErrorContext {
  const root = asRecord(value);
  if (!root) {
    return {};
  }
  const context: RuntimeErrorContext = {};
  for (const key of CONTEXT_KEYS) {
    const entry = root[key];
    if (typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry))) {
      context[key] = entry;
    }
  }
  for (const [alias, key] of Object.entries(CONTEXT_KEY_ALIASES)) {
    const entry = root[alias];
    if (
      context[key] === undefined &&
      (typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry)))
    ) {
      context[key] = entry;
    }
  }
  const metadata = asRecord(root.metadata);
  const errorContext = asRecord(metadata?.errorContext);
  if (errorContext) {
    for (const [key, entry] of Object.entries(errorContext)) {
      const normalizedKey = CONTEXT_KEY_ALIASES[key] ?? key;
      if (
        context[normalizedKey] === undefined &&
        (typeof entry === "string" || (typeof entry === "number" && Number.isFinite(entry)))
      ) {
        context[normalizedKey] = entry;
      }
    }
  }
  return context;
}

export function isRuntimeHttpError(error: unknown): error is RuntimeHttpError {
  return (
    error instanceof RuntimeHttpError ||
    (Boolean(error) &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "RuntimeHttpError" &&
      typeof (error as { status?: unknown }).status === "number" &&
      typeof (error as { code?: unknown }).code === "string")
  );
}

export function notImplemented(message = "该能力尚未实现"): RuntimeError {
  return new RuntimeError({ code: "not_implemented", message });
}

function finalizeEnvelope(
  value: RuntimeErrorEnvelopeInput,
  options: NormalizeRuntimeErrorOptions,
): RuntimeErrorEnvelope {
  const fallbackCode = publicText(options.fallbackCode) ?? "runtime_error";
  const fallbackMessage = publicText(options.fallbackMessage) ?? "运行时错误";
  let code = publicText(value.code) ?? fallbackCode;
  let message = publicText(value.message) ?? fallbackMessage;
  let status = httpStatus(value.status) ?? httpStatus(options.status);
  const details = cloneDetails(value.details);

  if (options.parseLegacyGateway !== false) {
    const legacy = parseLegacyGatewayError(message);
    if (legacy) {
      code = code === "runtime_error" && legacy.code ? legacy.code : code;
      message = legacy.message ?? message;
      status = legacy.status ?? status;
      for (const [key, entry] of Object.entries(legacy.details)) {
        if (details[key] === undefined) {
          details[key] = entry;
        }
      }
    }
  }

  return {
    schema_version: RUNTIME_ERROR_SCHEMA_VERSION,
    code,
    message,
    details,
    retryable: value.retryable === true,
    ...(status === undefined ? {} : { status }),
  };
}

function parseLegacyGatewayError(
  value: string,
): { status?: number; code?: string; message?: string; details: Record<string, unknown> } | null {
  const statusMatch = /^Error code:\s*(\d+)/i.exec(value.trim());
  const messageMatch = /['"]message['"]\s*:\s*(['"])(.*?)\1/i.exec(value);
  const codeMatch = /['"]code['"]\s*:\s*(['"])(.*?)\1/i.exec(value);
  if (!statusMatch && !messageMatch && !codeMatch) {
    return null;
  }
  const typeMatch = /['"]type['"]\s*:\s*(['"])(.*?)\1/i.exec(value);
  const requestIdMatch = /['"]request_id['"]\s*:\s*(['"])(.*?)\1/i.exec(value);
  const details: Record<string, unknown> = {};
  if (messageMatch?.[2]) details.provider_message = messageMatch[2];
  if (codeMatch?.[2]) details.provider_code = codeMatch[2];
  if (typeMatch?.[2]) details.provider_type = typeMatch[2];
  if (requestIdMatch?.[2]) details.provider_request_id = requestIdMatch[2];
  return {
    status: statusMatch ? httpStatus(Number(statusMatch[1])) : undefined,
    code: codeMatch?.[2],
    message: messageMatch?.[2],
    details,
  };
}

function looksLikeErrorEnvelope(value: Record<string, unknown>): boolean {
  return publicText(value.code) !== undefined || publicText(value.message) !== undefined;
}

function cloneDetails(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return cloneRecord(record, new WeakSet<object>(), 0);
}

function cloneRecord(
  value: Record<string, unknown>,
  active: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  if (active.has(value)) {
    return { _circular: true };
  }
  if (depth >= 8) {
    return { _truncated: "max_depth" };
  }
  active.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    result[key] = cloneValue(entry, active, depth + 1);
  }
  active.delete(value);
  return result;
}

function cloneValue(value: unknown, active: WeakSet<object>, depth: number): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) return ["[CIRCULAR]"];
    if (depth >= 8) return ["[MAX_DEPTH]"];
    active.add(value);
    const result = value.slice(0, 64).map((entry) => cloneValue(entry, active, depth + 1));
    active.delete(value);
    return result;
  }
  const record = asRecord(value);
  if (record) {
    return cloneRecord(record, active, depth);
  }
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function publicText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function isPublicScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
