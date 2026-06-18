import { AlertCircle, CheckCircle2, LoaderCircle, X } from "lucide-react";

import {
  selectConnectionSummary,
  selectVisibleErrors,
  sourceLabel,
  type RuntimeState,
} from "@/renderer/stores/runtimeStore";

import styles from "./ConnectionStatus.module.css";

export interface ConnectionStatusProps {
  state: RuntimeState;
  onClearError?: (id: string) => void;
  onClearAll?: () => void;
}

export function ConnectionStatus({ state, onClearError, onClearAll }: ConnectionStatusProps) {
  const summary = selectConnectionSummary(state);
  const errors = selectVisibleErrors(state);
  const Icon = summary.status === "connected" ? CheckCircle2 : summary.status === "error" ? AlertCircle : LoaderCircle;

  return (
    <div className={styles.statusBar} data-status={summary.status} data-testid="connection-status">
      <div className={styles.summary}>
        <Icon className={summary.status === "connecting" || summary.status === "reconnecting" ? styles.spin : undefined} size={15} />
        <span>{summary.label}</span>
      </div>

      {summary.activeError ? (
        <div className={styles.errorLine} title={summary.activeError.message}>
          <span className={styles.source}>{sourceLabel(summary.activeError.source)}</span>
          <span className={styles.message}>{summary.activeError.message}</span>
          {onClearError ? (
            <button
              className={styles.clearButton}
              type="button"
              aria-label="清除当前错误"
              onClick={() => onClearError(summary.activeError!.id)}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      ) : null}

      {errors.length > 1 && onClearAll ? (
        <button className={styles.clearAllButton} type="button" onClick={onClearAll}>
          清除全部
        </button>
      ) : null}
    </div>
  );
}
