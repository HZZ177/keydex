import {
  createDiffDocumentId,
  createDiffScopeFingerprint,
  createDiffSourceVersion,
  fingerprintDiffContent,
} from "./identity";
import {
  createKeydexDiffDocument,
  type KeydexDiffDiagnostic,
  type KeydexDiffDocument,
  type KeydexDiffSource,
} from "./model";
import {
  normalizeUnifiedPatch,
  type UnifiedPatchNormalizationOptions,
} from "./normalizers/unifiedPatch";

export type DiffInputFailureKind =
  | "empty"
  | "malformed"
  | "unsupported"
  | "partial"
  | "unsafe_size"
  | "adapter_failure"
  | "worker_failure";

export interface DiffDiagnosticPresentation {
  readonly title: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly allowCopyRawSource: boolean;
}

export interface SafeDiffNormalizationResult {
  readonly document: KeydexDiffDocument;
  readonly rawSource: string;
  readonly fallback: "none";
}

export const DIFF_UNSAFE_INPUT_BYTES = 8 * 1024 * 1024;

export function normalizeDiffSafely(
  rawSource: string,
  options: UnifiedPatchNormalizationOptions = {},
): SafeDiffNormalizationResult {
  const classified = classifyDiffInput(rawSource, options.truncated ?? false);
  if (classified) {
    return {
      document: failureDocument(classified, options, rawSource),
      rawSource,
      fallback: "none",
    };
  }
  try {
    return {
      document: normalizeUnifiedPatch(rawSource, options),
      rawSource,
      fallback: "none",
    };
  } catch {
    return {
      document: failureDocument("adapter_failure", options, rawSource),
      rawSource,
      fallback: "none",
    };
  }
}

export function diffRuntimeFailureDocument(
  kind: Extract<DiffInputFailureKind, "adapter_failure" | "worker_failure">,
  options: Pick<UnifiedPatchNormalizationOptions, "source" | "sourceVersion" | "scopeFingerprint"> = {},
): KeydexDiffDocument {
  return failureDocument(kind, options, "");
}

export function diffDiagnosticPresentation(
  diagnostic: Pick<KeydexDiffDiagnostic, "code" | "message">,
): DiffDiagnosticPresentation {
  const kind = diagnostic.code as DiffInputFailureKind;
  const definitions: Record<DiffInputFailureKind, Omit<DiffDiagnosticPresentation, "message">> = {
    empty: { title: "没有差异内容", retryable: false, allowCopyRawSource: true },
    malformed: { title: "无法解析差异", retryable: false, allowCopyRawSource: true },
    unsupported: { title: "暂不支持此差异格式", retryable: false, allowCopyRawSource: true },
    partial: { title: "差异内容尚未完整", retryable: true, allowCopyRawSource: true },
    unsafe_size: { title: "差异内容过大", retryable: true, allowCopyRawSource: true },
    adapter_failure: { title: "差异处理失败", retryable: true, allowCopyRawSource: true },
    worker_failure: { title: "后台解析失败", retryable: true, allowCopyRawSource: true },
  };
  const definition = definitions[kind] ?? definitions.adapter_failure;
  return { ...definition, message: diagnostic.message };
}

function classifyDiffInput(rawSource: string, truncated: boolean): DiffInputFailureKind | null {
  if (!rawSource.trim()) return "empty";
  if (new TextEncoder().encode(rawSource).byteLength > DIFF_UNSAFE_INPUT_BYTES) return "unsafe_size";
  if (truncated || (rawSource.includes("*** Begin Patch") && !rawSource.includes("*** End Patch"))) return "partial";
  if (/^diff --(?:cc|combined) /mu.test(rawSource) || /^@@@ /mu.test(rawSource)) return "unsupported";
  const hasSupportedMarker =
    /^diff --git /mu.test(rawSource) ||
    (/^---\s+/mu.test(rawSource) && /^\+\+\+\s+/mu.test(rawSource)) ||
    /^\*\*\* (?:Add|Update|Delete) File:/mu.test(rawSource);
  return hasSupportedMarker ? null : "malformed";
}

function failureDocument(
  kind: DiffInputFailureKind,
  options: Pick<UnifiedPatchNormalizationOptions, "source" | "sourceVersion" | "scopeFingerprint">,
  rawSource: string,
): KeydexDiffDocument {
  const source: KeydexDiffSource = options.source ?? "preview";
  const sourceVersion = options.sourceVersion ?? createDiffSourceVersion({
    revision: `failure:${kind}`,
    content: rawSource,
  });
  const scopeFingerprint = options.scopeFingerprint ?? createDiffScopeFingerprint({ source });
  const diagnostic = failureDiagnostic(kind, rawSource);
  return createKeydexDiffDocument({
    id: createDiffDocumentId({ source, scopeFingerprint, sourceVersion, fileIds: [] }),
    source,
    sourceVersion,
    files: [],
    diagnostics: [diagnostic],
  });
}

function failureDiagnostic(kind: DiffInputFailureKind, rawSource: string): KeydexDiffDiagnostic {
  const messages: Record<DiffInputFailureKind, string> = {
    empty: "当前内容为空，没有可显示的差异。",
    malformed: "内容不是可识别的 unified diff 或 Apply Patch 格式，可复制原文后检查。",
    unsupported: "当前为合并差异等暂不支持的格式，可复制原文后使用外部工具查看。",
    partial: "差异仍在生成或已经截断，请等待完成或重新加载。",
    unsafe_size: "差异超过安全解析上限，请缩小范围或改为按文件查看。",
    adapter_failure: "Keydex 无法处理该差异，可重试或复制原文。",
    worker_failure: "后台差异解析服务未能完成，请重试。",
  };
  return {
    id: `diff-diagnostic:${kind}:${fingerprintDiffContent(rawSource || kind)}`,
    code: kind,
    severity: kind === "empty" ? "info" : "error",
    message: messages[kind],
    details: {
      sourceBytes: new TextEncoder().encode(rawSource).byteLength,
      retryable: ["partial", "unsafe_size", "adapter_failure", "worker_failure"].includes(kind),
    },
  };
}
