function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function stringifyDetails(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatErrorText(value: unknown): string {
  if (typeof value === "string") {
    return readableErrorText(value);
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }

  const lines: string[] = [];
  const message = stringValue(record.message);
  const code = stringValue(record.code);
  if (message) {
    lines.push(message);
  }
  if (code) {
    lines.push(`错误码：${code}`);
  }
  if (hasMeaningfulValue(record.details)) {
    lines.push(`详情：${stringifyDetails(record.details)}`);
  }
  if (lines.length) {
    return lines.join("\n");
  }

  return formatErrorText(record.error);
}

export function readableErrorText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed);
    const parsedText = formatErrorText(parsed);
    if (parsedText) {
      return parsedText;
    }
  } catch {
    // Non-JSON errors are already readable.
  }
  return trimmed;
}
