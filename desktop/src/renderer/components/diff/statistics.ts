import {
  createKeydexDiffDocument,
  createKeydexDiffFile,
  type KeydexDiffDiagnostic,
  type KeydexDiffDocument,
  type KeydexDiffFile,
} from "./model";

export interface TrustedDiffStatistics {
  readonly fileId?: string;
  readonly path?: string;
  readonly additions?: number | null;
  readonly deletions?: number | null;
}

export interface DiffStatisticsSummary {
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly filesWithUnknownStatistics: number;
}

export interface ReconciledDiffStatistics {
  readonly document: KeydexDiffDocument;
  readonly summary: DiffStatisticsSummary;
}

export function reconcileDiffStatistics(
  document: KeydexDiffDocument,
  trustedStatistics: readonly TrustedDiffStatistics[],
): ReconciledDiffStatistics {
  const diagnostics: KeydexDiffDiagnostic[] = [...document.diagnostics];
  const files = document.files.map((file) => {
    const trusted = trustedStatistics.find(
      (candidate) => candidate.fileId === file.id || Boolean(candidate.path && candidate.path === file.displayPath),
    );
    if (!trusted) return file;
    const additions = reconcileValue(file, "additions", trusted.additions, diagnostics);
    const deletions = reconcileValue(file, "deletions", trusted.deletions, diagnostics);
    return createKeydexDiffFile({ ...file, additions, deletions });
  });
  const reconciled = createKeydexDiffDocument({ ...document, files, diagnostics });
  return { document: reconciled, summary: summarizeDiffStatistics(files) };
}

export function summarizeDiffStatistics(files: readonly KeydexDiffFile[]): DiffStatisticsSummary {
  const additions = aggregate(files.map((file) => file.additions));
  const deletions = aggregate(files.map((file) => file.deletions));
  return {
    additions,
    deletions,
    filesWithUnknownStatistics: files.filter(
      (file) => file.additions === null || file.deletions === null,
    ).length,
  };
}

function reconcileValue(
  file: KeydexDiffFile,
  key: "additions" | "deletions",
  trusted: number | null | undefined,
  diagnostics: KeydexDiffDiagnostic[],
): number | null {
  const parsed = file[key];
  if (trusted === undefined) return parsed;
  if (trusted !== null && (!Number.isInteger(trusted) || trusted < 0)) {
    diagnostics.push(statDiagnostic(file, key, "invalid", parsed, trusted));
    return parsed;
  }
  if (trusted !== parsed) {
    diagnostics.push(statDiagnostic(file, key, "mismatch", parsed, trusted));
  }
  return trusted;
}

function statDiagnostic(
  file: KeydexDiffFile,
  key: "additions" | "deletions",
  kind: "invalid" | "mismatch",
  parsed: number | null,
  producer: number | null,
): KeydexDiffDiagnostic {
  const label = key === "additions" ? "新增" : "删除";
  return {
    id: `diff-stat:${kind}:${file.id}:${key}`,
    severity: "warning",
    code: kind === "invalid" ? "invalid_producer_stat" : "producer_stat_mismatch",
    message:
      kind === "invalid"
        ? `${file.displayPath} 的可信来源${label}统计无效，已使用解析结果。`
        : `${file.displayPath} 的${label}统计与差异内容不一致，已保留可信来源统计。`,
    fileId: file.id,
    details: { field: key, parsed, producer },
  };
}

function aggregate(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
