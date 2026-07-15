import type {
  WebActivityError,
  WebActivityPayload,
  WebActivitySource,
  WebActivityStatus,
  WebFetchActivityItem,
} from "@/types/protocol";

const WEB_ACTIVITY_STATUSES = new Set<WebActivityStatus>([
  "running",
  "completed",
  "empty",
  "partial_failure",
  "failed",
  "cancelled",
]);
const WEB_SEARCH_MAX_RESULTS = 20;

export function normalizeWebActivityPayload(value: unknown): WebActivityPayload | null {
  const record = asRecord(value);
  if (
    record?.kind !== "web_activity" ||
    record.schema_version !== 1 ||
    (record.activity_type !== "search" && record.activity_type !== "fetch") ||
    typeof record.status !== "string" ||
    !WEB_ACTIVITY_STATUSES.has(record.status as WebActivityStatus)
  ) {
    return null;
  }
  const sources = normalizeSources(record.sources);
  const items = normalizeItems(record.items);
  if (sources === null || items === null) {
    return null;
  }
  if (record.activity_type === "search" && items.length > 0) {
    return null;
  }
  if (record.activity_type === "fetch" && sources.length > 0) {
    return null;
  }
  const error = normalizeError(record.error);
  if (record.error != null && error === null) {
    return null;
  }
  if (record.status === "failed" && error === null) {
    return null;
  }
  return {
    kind: "web_activity",
    schema_version: 1,
    activity_type: record.activity_type,
    status: record.status as WebActivityStatus,
    query: optionalString(record.query),
    requested_urls: stringList(record.requested_urls, 5),
    sources,
    items,
    error,
    started_at_ms: optionalNonNegativeNumber(record.started_at_ms),
    ended_at_ms: optionalNonNegativeNumber(record.ended_at_ms),
    duration_ms: optionalNonNegativeNumber(record.duration_ms),
  };
}

export function isWebActivityPayload(value: unknown): value is WebActivityPayload {
  return normalizeWebActivityPayload(value) !== null;
}

function normalizeSources(value: unknown): WebActivitySource[] | null {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > WEB_SEARCH_MAX_RESULTS) {
    return null;
  }
  const normalized = value.map(normalizeSource);
  return normalized.every((source): source is WebActivitySource => source !== null) ? normalized : null;
}

function normalizeSource(value: unknown): WebActivitySource | null {
  const record = asRecord(value);
  const sourceId = requiredString(record?.source_id);
  const url = requiredString(record?.url);
  const domain = requiredString(record?.domain);
  if (!record || !sourceId || !url || !domain || typeof record.truncated !== "boolean") {
    return null;
  }
  return {
    source_id: sourceId,
    url,
    domain,
    title: optionalString(record.title),
    snippet: optionalString(record.snippet),
    favicon: optionalString(record.favicon),
    published_at: optionalString(record.published_at),
    truncated: record.truncated,
  };
}

function normalizeItems(value: unknown): WebFetchActivityItem[] | null {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 5) {
    return null;
  }
  const normalized = value.map(normalizeItem);
  return normalized.every((item): item is WebFetchActivityItem => item !== null) ? normalized : null;
}

function normalizeItem(value: unknown): WebFetchActivityItem | null {
  const record = asRecord(value);
  const requestedUrl = requiredString(record?.requested_url);
  if (!record || !requestedUrl || (record.status !== "success" && record.status !== "failed")) {
    return null;
  }
  const source = normalizeSource(record.source);
  const error = normalizeError(record.error);
  if (record.status === "success" && source === null) {
    return null;
  }
  if (record.status === "failed" && error === null) {
    return null;
  }
  return {
    requested_url: requestedUrl,
    status: record.status,
    source,
    error,
  };
}

function normalizeError(value: unknown): WebActivityError | null {
  if (value == null) {
    return null;
  }
  const record = asRecord(value);
  const code = requiredString(record?.code);
  const message = requiredString(record?.message);
  if (!record || !code || !message || typeof record.retryable !== "boolean") {
    return null;
  }
  return {
    code,
    message,
    retryable: record.retryable,
    retry_after_seconds: optionalNonNegativeNumber(record.retry_after_seconds),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, limit).flatMap((item) => {
    const text = requiredString(item);
    return text ? [text] : [];
  });
}

function optionalNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
