import {
  extractRuntimeErrorContext,
  normalizeRuntimeErrorEnvelope,
  type NormalizeRuntimeErrorOptions,
  type RuntimeErrorContext,
  type RuntimeErrorEnvelope,
} from "@/runtime/errors";

export interface ErrorDiagnostic {
  error: RuntimeErrorEnvelope;
  context: RuntimeErrorContext;
}

export interface ErrorDiagnosticOptions extends NormalizeRuntimeErrorOptions {
  contextSource?: unknown;
  context?: RuntimeErrorContext;
}

export function createErrorDiagnostic(
  value: unknown,
  options: ErrorDiagnosticOptions = {},
): ErrorDiagnostic {
  const { contextSource = value, context: explicitContext = {}, ...normalizeOptions } = options;
  const normalized = normalizeRuntimeErrorEnvelope(value, normalizeOptions);
  return {
    error: foldLegacyStackTrace(normalized),
    context: {
      ...extractRuntimeErrorContext(contextSource),
      ...explicitContext,
    },
  };
}

export function serializeErrorDiagnostic(diagnostic: ErrorDiagnostic): string {
  return JSON.stringify(
    {
      error: diagnostic.error,
      ...(Object.keys(diagnostic.context).length ? { context: diagnostic.context } : {}),
    },
    null,
    2,
  );
}

function foldLegacyStackTrace(error: RuntimeErrorEnvelope): RuntimeErrorEnvelope {
  const lines = error.message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1 && !lines.some(isStackTraceLine)) {
    return error;
  }
  const firstBusinessLine = lines.find((line) => !isStackTraceLine(line));
  return {
    ...error,
    message: firstBusinessLine ?? "运行失败，详细信息已折叠",
    details: { ...error.details, raw_message: error.message },
  };
}

function isStackTraceLine(line: string): boolean {
  return (
    line.startsWith("Traceback ") ||
    /^File ".+", line \d+/i.test(line) ||
    /^\s*at\s+\S+/i.test(line) ||
    /^[A-Za-z_][\w.]*Error:/.test(line)
  );
}
