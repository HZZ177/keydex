export type ToolPresentationSource = "ui_payload" | "model_content" | "legacy_result" | "empty";

export interface ToolProjectionPresentation {
  truncated?: boolean;
  artifactId?: string;
  artifactComplete?: boolean;
  continuation?: Record<string, unknown>;
  reasonCode?: string;
  fullBytes?: number;
  modelBytes?: number;
  budgetBytes?: number;
}

export interface ToolPresentation {
  inputValue: unknown;
  outputValue: unknown;
  inputRawText: string;
  outputRawText: string;
  outputSource: ToolPresentationSource;
  projection: ToolProjectionPresentation | null;
}

interface BuildToolPresentationOptions {
  args: unknown;
  result: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}

const RESULT_TRANSPORT_FIELDS = new Set([
  "model_content",
  "ui_payload",
  "uiPayload",
]);

export function buildToolPresentation({
  args,
  result,
  payload,
}: BuildToolPresentationOptions): ToolPresentation {
  const modelContent = firstNonEmptyString(result?.model_content, payload.model_content, payload.result_text);
  const parsedModelContent = parseJsonValue(modelContent);
  const directUiPayload = firstDefined(
    result?.ui_payload,
    result?.uiPayload,
    payload.ui_payload,
    payload.uiPayload,
  );
  const legacyResult = legacyBusinessResult(result);
  // model_content is the exact value sent to the Agent. Keep it authoritative so
  // a stale or malformed UI payload can never make the human and Agent see
  // different tool results. ui_payload is the structured fallback for legacy
  // events that do not persist model_content.
  const canonicalOutput = parsedModelContent.ok
    ? parsedModelContent.value
    : modelContent
      ? modelContent
      : directUiPayload !== undefined
        ? directUiPayload
        : legacyResult;
  const outputSource: ToolPresentationSource = parsedModelContent.ok || modelContent
    ? "model_content"
    : directUiPayload !== undefined
      ? "ui_payload"
      : legacyResult !== undefined
        ? "legacy_result"
        : "empty";
  const projection = projectionFromValue(canonicalOutput) ?? projectionFromValue(directUiPayload);

  return {
    inputValue: args ?? {},
    outputValue: withoutInternalProjection(canonicalOutput),
    inputRawText: stringifyForDisplay(args ?? {}),
    outputRawText: rawOutputText({
      canonicalOutput,
      directUiPayload,
      modelContent,
      outputSource,
    }),
    outputSource,
    projection,
  };
}

export function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") {
    const parsed = parseJsonValue(value);
    return parsed.ok ? JSON.stringify(parsed.value, null, 2) : value;
  }
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstDefined(...values: unknown[]): unknown | undefined {
  return values.find((value) => value !== undefined && value !== null);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function parseJsonValue(value: string): { ok: true; value: unknown } | { ok: false } {
  if (!value.trim()) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function legacyBusinessResult(result: Record<string, unknown> | null): unknown | undefined {
  if (!result || result.status === "running") {
    return undefined;
  }
  const businessEntries = Object.entries(result).filter(([key, value]) => (
    !RESULT_TRANSPORT_FIELDS.has(key) && value !== undefined
  ));
  if (!businessEntries.length) {
    return undefined;
  }
  return Object.fromEntries(businessEntries);
}

function rawOutputText({
  canonicalOutput,
  directUiPayload,
  modelContent,
  outputSource,
}: {
  canonicalOutput: unknown;
  directUiPayload: unknown;
  modelContent: string;
  outputSource: ToolPresentationSource;
}): string {
  if (outputSource === "ui_payload") {
    return stringifyForDisplay(directUiPayload);
  }
  if (modelContent) {
    return modelContent;
  }
  return canonicalOutput === undefined ? "" : stringifyForDisplay(canonicalOutput);
}

function projectionFromValue(value: unknown): ToolProjectionPresentation | null {
  const record = isRecord(value) ? value : null;
  const source = record && isRecord(record._keydex_projection) ? record._keydex_projection : null;
  if (!source) {
    return null;
  }
  const projection: ToolProjectionPresentation = {};
  if (typeof source.truncated === "boolean") projection.truncated = source.truncated;
  if (typeof source.artifact_id === "string" && source.artifact_id) projection.artifactId = source.artifact_id;
  if (typeof source.artifact_complete === "boolean") projection.artifactComplete = source.artifact_complete;
  if (isRecord(source.continuation)) projection.continuation = source.continuation;
  if (typeof source.reason_code === "string" && source.reason_code) projection.reasonCode = source.reason_code;
  if (typeof source.full_bytes === "number") projection.fullBytes = source.full_bytes;
  if (typeof source.model_bytes === "number") projection.modelBytes = source.model_bytes;
  if (typeof source.budget_bytes === "number") projection.budgetBytes = source.budget_bytes;
  return projection;
}

function withoutInternalProjection(value: unknown): unknown {
  if (!isRecord(value) || !("_keydex_projection" in value)) {
    return value;
  }
  const { _keydex_projection: _projection, ...visible } = value;
  return visible;
}
