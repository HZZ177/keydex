import { Check, Copy, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";

import { redactForLog } from "@/runtime/httpClient";
import type { GitCommandResult } from "@/runtime/gitTypes";
import { gitErrorPresentation } from "@/renderer/features/git/errorPresentation";

import styles from "./GitOperationLog.module.css";

export function GitOperationLog({
  operations,
  repositoryLabels,
  canRetry,
  onRetry,
  canCancel,
  onCancel,
}: {
  operations: readonly GitCommandResult[];
  repositoryLabels: Readonly<Record<string, string>>;
  canRetry: (operationId: string) => boolean;
  onRetry: (operationId: string) => void;
  canCancel: (operationId: string) => boolean;
  onCancel: (operationId: string) => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (operations.length === 0) {
    return <section className={styles.root} aria-label="Git 操作日志"><div className={styles.empty}>当前项目还没有 Git 操作记录。</div></section>;
  }

  return (
    <section className={styles.root} aria-label="Git 操作日志">
      <header><strong>操作日志</strong><span>{operations.length} 条当前会话记录</span></header>
      <div className={styles.list} role="list">
        {operations.map((operation) => {
          const repository = repositoryLabels[operation.repositoryId] ?? operation.repositoryId;
          const diagnostic = buildGitOperationDiagnostic(operation, repository);
          const errorPresentation = operation.error ? gitErrorPresentation(operation.error.code) : null;
          return (
            <article className={styles.row} data-state={operation.state} key={operation.operationId} role="listitem">
              <div className={styles.summary}>
                <span className={styles.state}>{operationStateLabel(operation.state)}</span>
                <strong>{operation.summary}</strong>
                <code>{operation.command}</code>
              </div>
              <dl className={styles.metadata}>
                <div><dt>仓库</dt><dd>{repository}</dd></div>
                <div><dt>风险</dt><dd>{riskLabel(operation.risk)}</dd></div>
                <div><dt>耗时</dt><dd>{durationLabel(operation.durationMs)}</dd></div>
                <div><dt>操作 ID</dt><dd title={operation.operationId}>{operation.operationId.slice(0, 12)}</dd></div>
              </dl>
              {operation.error ? (
                <div className={styles.error} role="alert">
                  <strong>{errorPresentation?.title} <code>{operation.error.code}</code></strong>
                  <span>{redactDiagnosticText(operation.error.message)}</span>
                  <small>{errorPresentation?.helpAction}</small>
                </div>
              ) : null}
              {Object.keys(operation.result).length > 0 ? (
                <details className={styles.result}>
                  <summary>查看清洗后的结果</summary>
                  <pre>{safeJson(operation.result)}</pre>
                </details>
              ) : null}
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(diagnostic).then(() => {
                      setCopiedId(operation.operationId);
                      window.setTimeout(() => setCopiedId((current) => current === operation.operationId ? null : current), 1500);
                    }).catch(() => setCopiedId(null));
                  }}
                >
                  {copiedId === operation.operationId ? <Check size={13} /> : <Copy size={13} />}
                  {copiedId === operation.operationId ? "已复制" : "复制诊断"}
                </button>
                {operation.retryable ? (
                  <button
                    type="button"
                    disabled={!canRetry(operation.operationId)}
                    onClick={() => onRetry(operation.operationId)}
                  >
                    <RefreshCw size={13} />重试
                  </button>
                ) : null}
                {canCancel(operation.operationId) ? (
                  <button type="button" onClick={() => onCancel(operation.operationId)}>
                    <XCircle size={13} />取消操作
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function buildGitOperationDiagnostic(operation: GitCommandResult, repository: string): string {
  return safeJson({
    operation_id: operation.operationId,
    repository,
    repository_id: operation.repositoryId,
    command: operation.command,
    risk: operation.risk,
    state: operation.state,
    summary: operation.summary,
    created_at: operation.createdAt,
    started_at: operation.startedAt,
    finished_at: operation.finishedAt,
    duration_ms: operation.durationMs,
    retryable: operation.retryable,
    error: operation.error,
    result: operation.result,
  });
}

function safeJson(value: unknown): string {
  return redactDiagnosticText(JSON.stringify(redactForLog(value), null, 2));
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:access_token|auth_token|token|api_key|password)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[REDACTED]");
}

function operationStateLabel(state: GitCommandResult["state"]): string {
  return ({ queued: "排队中", running: "执行中", succeeded: "成功", failed: "失败", cancelled: "已取消" })[state];
}

function riskLabel(risk: GitCommandResult["risk"]): string {
  return ({ safe: "只读", write: "写入", destructive: "破坏性", history_rewrite: "重写历史", remote_destructive: "远程破坏性" })[risk];
}

function durationLabel(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}
